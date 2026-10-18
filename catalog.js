// The Add flow for books: search the metadata catalog, add a book, and keep
// wanting it until a download source has it.
//
//   GET  /api/ebooks/catalog/search?q=   — catalog results, each marked with
//                                          what the shelf already holds
//   POST /api/ebooks/catalog/add { id }  — put the book on the wanted list and
//                                          ask the download sources for it now
//   GET  /api/ebooks/wanted               — the wanted list
//   DELETE /api/ebooks/wanted/:id         — stop wanting one
//
// A wanted book is asked for again by the "Fill wanted books" job, and taken
// off the list when its download is filed (the core's media download tells us
// through onMediaDownload) or when a scan or import brings it in by other
// means (title and author, or ISBN).
import { ebookLibraries } from './scanner.js';

const year4 = (v) => { const m = String(v || '').match(/\d{4}/); return m ? m[0] : null; };

/** One shape for the UI, whatever the service calls the fields. */
export function normalizeBook(r) {
  return {
    id: String(r.id),
    title: r.title || 'Untitled',
    author: (Array.isArray(r.authors) ? r.authors : []).filter(Boolean).join(', ') || null,
    publisher: r.publisher || null,
    year: year4(r.published_date),
    cover: r.thumbnail || null,
    isbn: r.isbn_13 || r.isbn_10 || null,
    pages: Number.isFinite(r.page_count) && r.page_count > 0 ? r.page_count : null,
  };
}

/** What the Add button should say about a download attempt. */
export function addNote(r, item) {
  const t = item.title;
  switch (r?.status) {
    case 'imported': return `${t} is in the library.`;
    case 'grabbed': case 'downloading': return `${t} is downloading from ${r.source}${r.release ? ` (${r.release})` : ''}.`;
    case 'active': return `${t} is already downloading from ${r.source}.`;
    case 'no-match': return `No source has ${t} yet — it stays wanted and is tried again on the Fill wanted books schedule.`;
    case 'no-sources': return `No download source is enabled that carries books (Settings → Downloading) — ${t} stays wanted.`;
    case 'unsupported': return `This version of the app cannot download books — ${t} stays wanted.`;
    case 'error': return `The download could not start: ${r.error}`;
    default: return '';
  }
}

export function registerCatalog({ api, store, getClients, uid, CAN_USE, CAN_MANAGE }) {
  const REF = (id) => `ebooks:wanted:${id}`;
  const refId = (ref) => { const m = /^ebooks:wanted:(\d+)$/.exec(String(ref || '')); return m ? Number(m[1]) : null; };
  // The core notifier, remembered from the last request so the job (which
  // has none) can still say a wanted book landed.
  let notifyLater = null;
  const remember = (req) => { notifyLater = req.app?.locals?.notify || notifyLater; };
  const notify = (e) => { try { notifyLater?.(e); } catch { /* best-effort */ } };

  // A plugin's metadata source may only know how to search; the catalog needs
  // one that can also fetch a single record by the id its search handed out.
  async function client() {
    const clients = (await getClients()).filter((c) => c && typeof c.search === 'function' && typeof c.volume === 'function');
    for (const c of clients) { if (!c.available()) await c.ensureKey?.(); }
    return clients.find((c) => c.available()) || null;
  }
  const annotate = (item) => {
    const on = store.onShelf({ matchId: item.id, isbn: item.isbn, title: item.title, author: item.author });
    const w = store.wantedByMatch(item.id);
    return { ...item, inLibrary: !!on, seriesId: on?.seriesId ?? null, issueId: on?.issueId ?? null, wanted: !!w, wantedId: w?.id ?? null };
  };

  /** Ask the sources for one wanted row. → the download status. */
  async function tryWanted(w) {
    const lib = ebookLibraries(store.db)[0];
    if (!lib) return { status: 'no-library' };
    if (typeof api.downloadMedia !== 'function') return { status: 'unsupported' };
    let r;
    try {
      r = await api.downloadMedia({ db: store.db, type: 'ebook', libraryId: lib.id, title: w.title, author: w.author || null, year: w.year || null, isbn: w.isbn || null, ref: REF(w.id) });
    } catch (e) { r = { status: 'error', error: String(e?.message || e) }; }
    store.noteWantedTry(w.id, ['grabbed', 'downloading', 'imported', 'active'].includes(r.status) ? null : (r.error || r.status));
    if (r.status === 'imported') store.removeWanted(w.id);
    return r;
  }

  // The download landed (or did not): the book leaves the wanted list and
  // whoever added it hears about it.
  api.onMediaDownload?.((e) => {
    const id = refId(e?.ref);
    if (!id) return;
    const w = store.wantedById(id);
    if (!w) return;
    if (e.event === 'imported' && e.issueId) {
      store.removeWanted(id);
      notify({ type: 'import.done', category: 'import', level: 'success', title: 'Book added', body: `${w.title}${w.author ? ' by ' + w.author : ''} is in the library.`, seriesId: e.seriesId ?? null, userId: w.added_by || null });
    } else if (e.event === 'failed') {
      store.noteWantedTry(id, e.error || 'download failed');
    }
  });

  // Wanted books nothing has brought in yet: a scan or import may have
  // (title/author or ISBN), else the sources are asked again.
  api.registerJob?.({
    id: 'ebooks-wanted',
    label: 'Fill wanted books',
    scheduleKey: 'ebooksWantedHours',
    run: async () => {
      let asked = 0; let landed = 0;
      for (const w of store.listWanted()) {
        const on = store.onShelf({ matchId: w.match_id, isbn: w.isbn, title: w.title, author: w.author });
        if (on) {
          store.removeWanted(w.id); landed++;
          notify({ type: 'import.done', category: 'import', level: 'success', title: 'Book added', body: `${w.title} is in the library.`, seriesId: on.seriesId ?? null, userId: w.added_by || null });
          continue;
        }
        const r = await tryWanted(w);
        if (['grabbed', 'downloading', 'imported'].includes(r.status)) asked++;
        if (r.status === 'no-sources' || r.status === 'unsupported' || r.status === 'no-library') break; // the same answer for every row
      }
      return { asked, landed };
    },
  });

  // GET /api/ebooks/catalog/search?q= — the metadata catalog, annotated.
  api.registerRoute('get', '/api/ebooks/catalog/search', async (req, res) => {
    remember(req);
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ results: [] });
    const c = await client();
    if (!c) return res.status(503).json({ error: 'the metadata service is not available yet' });
    try {
      const found = (await c.search(q, 15)) || [];
      res.json({ results: found.map(normalizeBook).map(annotate) });
    } catch (e) { res.status(502).json({ error: String(e?.message || e) }); }
  }, { access: CAN_USE });

  // POST /api/ebooks/catalog/add { id } — want it, and ask the sources now.
  api.registerRoute('post', '/api/ebooks/catalog/add', async (req, res) => {
    remember(req);
    const id = String((req.body || {}).id || '').trim();
    if (!id) return res.status(400).json({ error: 'id required' });
    if (!ebookLibraries(store.db).length) return res.status(400).json({ error: 'no Books library to add to — create one under Settings → Library' });
    const c = await client();
    if (!c) return res.status(503).json({ error: 'the metadata service is not available yet' });
    let item;
    try { const v = await c.volume(id); item = v ? normalizeBook(v) : null; }
    catch (e) { return res.status(502).json({ error: String(e?.message || e) }); }
    if (!item) return res.status(404).json({ error: 'no such book in the catalog' });
    const on = store.onShelf({ matchId: item.id, isbn: item.isbn, title: item.title, author: item.author });
    if (on) return res.json({ status: 'on-shelf', seriesId: on.seriesId, issueId: on.issueId, note: `${item.title} is already in the library.` });
    const w = store.addWanted(item, uid(req));
    const r = await tryWanted(w);
    res.json({ ...r, wantedId: w.id, note: addNote(r, item) });
  }, { access: CAN_MANAGE });

  api.registerRoute('get', '/api/ebooks/wanted', (_req, res) => {
    res.json({ wanted: store.listWanted() });
  }, { access: CAN_USE });

  // Search again now for one wanted title instead of waiting for the schedule.
  // A copy that arrived some other way (a scan, an import) just clears it.
  api.registerRoute('post', '/api/ebooks/wanted/:id/retry', async (req, res) => {
    remember(req);
    const w = store.wantedById(Number(req.params.id));
    if (!w) return res.status(404).json({ error: 'not wanted' });
    const on = store.onShelf({ matchId: w.match_id, isbn: w.isbn, title: w.title, author: w.author });
    if (on) { store.removeWanted(w.id); return res.json({ status: 'on-shelf', seriesId: on.seriesId ?? null }); }
    const r = await tryWanted(w);
    res.json({ ...r, note: addNote(r, w) });
  }, { access: CAN_MANAGE });

  api.registerRoute('delete', '/api/ebooks/wanted/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!store.wantedById(id)) return res.status(404).json({ error: 'not wanted' });
    store.removeWanted(id);
    res.json({ ok: true });
  }, { access: CAN_MANAGE });
}
