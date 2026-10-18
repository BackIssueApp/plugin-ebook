// Ebook library plugin for BackIssue — a 'Books' library type for EPUB/PDF
// shelves, fully integrated into the normal flow: the scanner catalogs every
// book as a real series/issue (so the Library grid, series pages, filters and
// stats all ride core), embedded metadata is enriched best-effort from the
// hosted metadata service, the Import tool recognizes loose ebook files, and
// reading hangs off the standard per-issue actions — an in-browser EPUB shell
// (vendored foliate-js engine) with per-user progress/resume, PDFs streaming
// inline to the browser's own viewer. Not a download source.
import fs from 'node:fs';
import path from 'node:path';
import config from '../../src/config.js';
import { openEbooksStore } from './store.js';
import { scanLibraries, scanState, ebookLibraries } from './scanner.js';
import { makeBooksClient, matchBookAcross, matchNewBooks } from './metadata.js';
import { makeImportHandler, makeMediaHandler } from './importer.js';
import { registerCatalog } from './catalog.js';
import { extractEpubOutline } from './extract.js';
import {
  runRemoteSync, stopRemoteSync, remoteSyncStatus, isRemoteSyncRunning, materializeOnRead,
} from './remotesync.js';

const CONTENT_TYPES = { epub: 'application/epub+zip', pdf: 'application/pdf' };

// Cards never show a cover wider than ~400 px; a local source proxy that
// understands `?w=` then serves a few kilobytes instead of the full art.
// `?w=0` asks for the original; absolute remote thumbnails are left alone.
export function sizedCoverUrl(thumbnail, w) {
  const t = String(thumbnail || '');
  if (!t.startsWith('/') || /[?&]w=/.test(t)) return t;
  const n = w === undefined ? 400 : (Number(w) | 0);
  return n > 0 ? `${t}${t.includes('?') ? '&' : '?'}w=${n}` : t;
}

export default function register(api) {
  // The library type this plugin owns. selfDescribed: book series carry their
  // own metadata on the series row and list local issues — core renders them
  // like any matched series and keeps the ComicVine machinery off them.
  api.registerLibraryType?.({ id: 'ebook', label: 'Books', selfDescribed: true });

  api.registerClientAsset?.({ js: 'client/ebooks.js', css: 'client/ebooks.css' });

  // Reading + downloading book files ride one grantable permission (viewer
  // tier — reading your own shelf is the baseline). Curation (scan, re-match)
  // rides core's library.manage, like every other library-shaping action.
  const CAN_USE = api.registerPermission ? 'ebooks.use' : 'viewer';
  api.registerPermission?.({
    key: 'ebooks.use',
    label: 'Books library',
    description: 'Read EPUBs in the browser and download book files',
    tier: 'viewer',
  });
  const CAN_MANAGE = 'library.manage'; // core permission — curation tier

  const store = openEbooksStore(config.dbPath);
  const hosted = makeBooksClient(config);
  // Metadata sources, preferred first: any plugin-registered source (e.g. a
  // Book Warehouse instance) is tried before the hosted fallback. Rebuilt per
  // use so a source registered by a later-loading plugin is picked up.
  async function matchClients() {
    let sources = [];
    try {
      const { registeredBookMetadataSources } = await import('../../src/plugins.js');
      sources = registeredBookMetadataSources().map((s) => { try { return s.makeClient(config); } catch { return null; } }).filter(Boolean);
    } catch { /* core without the hook → hosted only */ }
    return [...sources, hosted];
  }

  // Registered file-less remote book catalogs (Book Warehouse etc.). Resolved
  // per use so a source registered by a later-loading plugin is picked up; an
  // empty list on cores without the hook simply means no on-demand sync.
  async function remoteSources() {
    try {
      const { registeredRemoteBookSources } = await import('../../src/plugins.js');
      return registeredRemoteBookSources();
    } catch { return []; }
  }

  // Scheduled scan (Jobs page). register() runs before loadSettings(), so
  // these defaults seed the schedule while saved values still win.
  api.registerSettings?.({
    ebooksScanCron: { type: 'string', allowEmpty: true },
    ebooksScanEnabled: { type: 'bool' },
  });
  config.ebooksScanCron ??= '0 */12 * * *';
  config.ebooksScanEnabled ??= true;

  // One scan at a time; matching runs after, best-effort — a missing instance
  // key or a service hiccup never blocks the shelf (files work unmatched).
  async function runScan() {
    await scanLibraries({ store, log: console.log });
    try { await matchNewBooks(store, await matchClients(), { log: console.warn }); }
    catch (e) { console.warn('ebooks: metadata matching skipped:', e?.message || e); }
  }
  api.registerJob?.({
    id: 'ebooks-scan',
    label: 'Scan book libraries',
    scheduleKey: 'ebooksScanHours',
    run: () => runScan(),
  });
  // Creating/editing a Books library indexes it right away (same UX as comic
  // libraries) instead of waiting out the scheduled scan.
  api.registerLibraryScanner?.({ type: 'ebook', scan: () => runScan() });

  // A status-only Library filter ({"status":"reading"} — the home page's
  // Continue reading rail) answered here, so it works without the Shelves plugin.
  // Anything richer (authors, decades, formats) is left to Shelves. Only for
  // ebook libraries; elsewhere it answers nothing and another resolver runs.
  api.registerCollectionFilter?.({
    id: 'ebooks-status',
    resolve(selection, ctx) {
      const s = selection || {};
      const status = s.status;
      if (!['reading', 'finished', 'unread'].includes(status)) return null;
      if (Object.keys(s).some((k) => k !== 'status' && (Array.isArray(s[k]) ? s[k].length : s[k] != null))) return null;
      const db = ctx?.db; const libraryId = Number(ctx?.library);
      if (!db || !libraryId) return null;
      const lib = db.prepare('SELECT type FROM libraries WHERE id=?').get(libraryId);
      if (lib?.type !== 'ebook') return null;
      const st = `CASE WHEN p.fraction >= 0.99 THEN 'finished' WHEN p.fraction > 0 THEN 'reading' ELSE 'unread' END`;
      const started = db.prepare(`SELECT i.series_id id, MAX(${st} = 'finished') fin, MAX(${st} = 'reading') rd
        FROM ebooks_progress p JOIN issues i ON i.id = p.issue_id JOIN series s ON s.id = i.series_id
        WHERE p.user_id = ? AND s.library_id = ? GROUP BY i.series_id`).all(ctx.userId || 0, libraryId);
      if (status === 'reading') return started.filter((r) => r.rd && !r.fin).map((r) => r.id);
      if (status === 'finished') return started.filter((r) => r.fin).map((r) => r.id);
      const begun = new Set(started.filter((r) => r.rd || r.fin).map((r) => r.id));
      return db.prepare('SELECT id FROM series WHERE library_id = ?').all(libraryId).map((r) => r.id).filter((id) => !begun.has(id));
    },
  });
  // Boot catch-up: a Books library with files on disk but nothing indexed
  // (created before this scanner existed, or before a restart beat the first
  // scheduled run) scans shortly after startup. Also fires when indexed books
  // have never had a metadata-match attempt — e.g. they were scanned before
  // the instance key existed or before the service's books support was live.
  setTimeout(() => {
    try {
      const libs = ebookLibraries(store.db);
      if (!libs.some((l) => l.folders.length)) return;
      const indexed = store.db.prepare('SELECT COUNT(*) c FROM ebooks_files').get().c;
      // On-demand (remote) books carry their source's metadata already, so
      // they're never match candidates — exclude them or the catch-up would
      // re-run over the whole synced catalog on every boot.
      const unattempted = store.db.prepare(
        'SELECT COUNT(*) c FROM ebooks_files WHERE match_id IS NULL AND match_checked_at IS NULL AND source IS NULL').get().c;
      if (indexed === 0 || unattempted > 0) runScan().catch(() => {});
    } catch { /* fresh install without libraries yet */ }
  }, 15_000).unref?.();

  // Loose ebook files in the Import tool: identified from embedded metadata +
  // service match, filed into the Books library on import (Author/Series/
  // Title.ext), cataloged like any scanned book.
  api.registerImportHandler?.(makeImportHandler({ store, getClients: matchClients }));
  // A book the download sources fetched (usenet, torrent, a site source that
  // serves ebooks — e.g. for an approved request) is filed the same way.
  api.registerMediaHandler?.(makeMediaHandler({ store, getClients: matchClients }));

  const uid = (req) => req.user?.id ?? 0;
  // The Add flow: search the catalog, want a book, ask the download sources.
  // Wanted books are asked for again every few hours unless the Jobs page
  // says otherwise (core carries no defaults for plugin jobs).
  config.ebooksWantedCron ??= '0 */4 * * *';
  config.ebooksWantedEnabled ??= true;
  registerCatalog({ api, store, getClients: matchClients, uid, CAN_USE, CAN_MANAGE });
  const fileOr404 = (req, res) => {
    const f = store.fileByIssue(Number(req.params.id));
    if (!f) res.status(404).json({ error: 'not an ebook issue' });
    return f;
  };

  // GET /api/ebooks/state — the caller's reading positions keyed by issue id
  // (the client paints the per-row Read icons from this, like the reader does).
  api.registerRoute('get', '/api/ebooks/state', (req, res) => {
    res.json({ states: store.stateMap(uid(req)) });
  }, { access: CAN_USE });

  // GET /api/ebooks/books?issues=1,2,3 — book-info for a SPECIFIC set of issues
  // (a series' issues), so the shelf can detect readable books (local OR
  // file-less on-demand) without shipping the whole catalog's worth of rows.
  api.registerRoute('get', '/api/ebooks/books', (req, res) => {
    const ids = String(req.query.issues || '').split(',').map((s) => Number(s.trim())).filter(Number.isFinite);
    res.json({ books: store.bookInfoMap(ids) });
  }, { access: CAN_USE });

  // GET /api/ebooks/issue/:id/cover — embedded cover bytes, else a redirect to
  // the metadata-service thumbnail (404 = neither; the UI shows a placeholder).
  api.registerRoute('get', '/api/ebooks/issue/:id/cover', (req, res) => {
    const c = store.cover(Number(req.params.id));
    if (!c) return res.status(404).end();
    // Cacheable redirect — spares each card the extra round-trip on revisits.
    if (c.thumbnail) { res.set('Cache-Control', 'private, max-age=86400'); return res.redirect(302, sizedCoverUrl(c.thumbnail, req.query.w)); }
    res.set('Content-Type', c.cover_type);
    res.set('Cache-Control', 'private, max-age=86400');
    res.send(c.cover);
  }, { access: CAN_USE, basicAuth: true }); // basicAuth: OPDS feeds link covers here — external readers need the 401 challenge

  // Stream a book file inline (browser PDF/EPUB viewer) or, with ?dl=1, as an
  // attachment. res.sendFile handles Range/ETag for us.
  const serveBookFile = (req, res, format, filePath) => {
    const kind = req.query.dl === '1' ? 'attachment' : 'inline';
    res.sendFile(path.resolve(filePath), {
      headers: {
        'Content-Type': CONTENT_TYPES[format] || 'application/octet-stream',
        'Content-Disposition': `${kind}; filename*=UTF-8''${encodeURIComponent(path.basename(filePath))}`,
        'Cache-Control': 'private, max-age=0',
      },
    }, (err) => { if (err && !res.headersSent) res.status(500).json({ error: String(err.message || err) }); });
  };

  // GET /api/ebooks/issue/:id/file[?dl=1] — the book file itself.
  //   basicAuth (here + cover): OPDS acquisition/image links point at these
  //   routes. An OPDS reader's download manager waits for a WWW-Authenticate
  //   challenge before attaching Basic credentials — without it, book
  //   downloads die on a bare 401 (KyBook et al.) even though the /api/opds
  //   catalog itself authenticates fine.
  //   • a local file already on disk → served straight away;
  //   • a file-less REMOTE entry → materialized on demand (download the EPUB/PDF
  //     into the library folder via its registered source, record the path, then
  //     serve it). Concurrent opens of the same book share one download. A first-
  //     open delay is expected — the reading shell shows "Opening…". If the
  //     source is gone or the download fails, 502 and leave the row remote so the
  //     next open retries.
  api.registerRoute('get', '/api/ebooks/issue/:id/file', async (req, res) => {
    const f = fileOr404(req, res);
    if (!f) return;
    if (f.path && fs.existsSync(f.path)) return serveBookFile(req, res, f.format, f.path);
    if (f.source && f.remote_id != null) {
      let result;
      try {
        result = await materializeOnRead({
          store, sources: await remoteSources(), issueId: f.issue_id,
          source: f.source, remoteId: f.remote_id, libraryId: f.library_id, dbPath: config.dbPath,
        });
      } catch (e) {
        const msg = String(e?.message || e);
        // The source no longer has the file (its record outlived the bytes):
        // say so in words the reader can show, and remember it so the book
        // reads as unavailable before the next tap.
        if (/HTTP 404|HTTP 410|not found/i.test(msg)) {
          const reason = 'the source no longer has this file';
          store.markUnavailable?.(f.issue_id, reason);
          return res.status(404).json({ error: reason, unavailable: true });
        }
        return res.status(502).json({ error: `Could not open this book: ${msg}` });
      }
      store.markAvailable?.(f.issue_id);
      return serveBookFile(req, res, f.format, result.path);
    }
    return res.status(404).json({ error: 'file missing on disk' });
  }, { access: CAN_USE, basicAuth: true });

  // Reading progress: locator is the foliate CFI (opaque to the server),
  // fraction the 0..1 position. The client debounces; the server just upserts.
  api.registerRoute('get', '/api/ebooks/issue/:id/progress', (req, res) => {
    res.json({ progress: store.progress(uid(req), Number(req.params.id)) });
  }, { access: CAN_USE });
  api.registerRoute('post', '/api/ebooks/issue/:id/progress', (req, res) => {
    const f = fileOr404(req, res);
    if (!f) return;
    store.saveProgress(uid(req), f.issue_id, req.body || {});
    res.json({ ok: true });
  }, { access: CAN_USE });

  // ---- Bookmarks -------------------------------------------------------------
  // A place in a book, kept per user. The position is the foliate CFI locator
  // (opaque here, same as progress), so a bookmark reopens exactly where it was
  // made regardless of font size or window width.
  api.registerRoute('get', '/api/ebooks/issue/:id/bookmarks', (req, res) => {
    res.json({ bookmarks: store.listBookmarks(uid(req), Number(req.params.id)) });
  }, { access: CAN_USE });
  api.registerRoute('post', '/api/ebooks/issue/:id/bookmarks', (req, res) => {
    const f = fileOr404(req, res);
    if (!f) return;
    try { res.json(store.addBookmark(uid(req), f.issue_id, req.body || {})); }
    catch (e) { res.status(400).json({ error: String(e?.message || e) }); }
  }, { access: CAN_USE });
  api.registerRoute('delete', '/api/ebooks/bookmarks/:bid', (req, res) => {
    store.deleteBookmark(uid(req), Number(req.params.bid));
    res.json({ ok: true });
  }, { access: CAN_USE });

  // ---- Reading stats ----------------------------------------------------------
  api.registerRoute('get', '/api/ebooks/stats', (req, res) => res.json(store.stats(uid(req))), { access: CAN_USE });

  // ---- Per-user home rail visibility (synced across devices) ------------------
  api.registerRoute('get', '/api/ebooks/home-prefs', (req, res) => {
    res.json(store.homePrefs(uid(req)));
  }, { access: CAN_USE });
  api.registerRoute('post', '/api/ebooks/home-prefs', (req, res) => {
    res.json(store.setHomePrefs(uid(req), req.body || {}));
  }, { access: CAN_USE });

  // GET /api/ebooks/issue/:id/details — the detail sheet's Details grid needs
  // the plugin-private ebooks_files columns (language/ISBN/added date) that
  // core's issue payload has no home for. One row per file/issue, tiny.
  // The outline (page count + chapters with start pages) is derived from the
  // file the first time anyone asks and cached on the row; a book that only
  // exists remotely reports none until it has been opened once.
  api.registerRoute('get', '/api/ebooks/issue/:id/details', async (req, res) => {
    const f = fileOr404(req, res);
    if (!f) return;
    let outline = store.outline(f.issue_id);
    if (!outline && f.format === 'epub' && f.path && fs.existsSync(f.path)) {
      try {
        outline = await extractEpubOutline(fs.readFileSync(f.path));
        store.saveOutline(f.issue_id, outline);
      } catch { outline = null; }
    }
    res.json({ details: {
      language: f.language, isbn: f.isbn, added: f.added_at, format: f.format, size: f.size,
      pages: outline?.pages ?? null, chapters: outline?.chapters ?? null,
    } });
  }, { access: CAN_USE });

  // POST /api/ebooks/scan — kick a scan now (fire-and-forget; poll status).
  api.registerRoute('post', '/api/ebooks/scan', (req, res) => {
    if (!scanState.running) runScan().catch((e) => console.warn('ebooks scan:', e?.message || e));
    res.json({ started: true });
  }, { access: CAN_MANAGE });
  api.registerRoute('get', '/api/ebooks/scan/status', (req, res) => {
    res.json(scanState);
  }, { access: CAN_USE });

  // ---- On-demand remote-catalog sync ---------------------------------------
  // Populate a Books library from registered remote sources (e.g. Book
  // Warehouse) as FILE-LESS entries — metadata + covers only, no downloads;
  // each book's file is fetched later, the first time someone opens it. One run
  // at a time, resumable from a per-source page cursor, curation-gated.

  // POST /api/ebooks/remote-sync/start { sourceId?, libraryId?, maxBooks? } —
  // fire-and-forget; poll /status. sourceId omitted = every registered source.
  api.registerRoute('post', '/api/ebooks/remote-sync/start', async (req, res) => {
    if (isRemoteSyncRunning()) return res.status(409).json({ error: 'A remote sync is already running.', state: remoteSyncStatus() });
    const sources = await remoteSources();
    if (!sources.length) return res.status(400).json({ error: 'No remote book source is available. Enable a source plugin first.' });
    if (!ebookLibraries(store.db).length) return res.status(400).json({ error: 'Create a Books library first — there is no ebook library to sync into.' });
    const { sourceId, libraryId, maxBooks, resetCursor } = req.body || {};
    if (sourceId && !sources.some((s) => s.id === sourceId)) return res.status(400).json({ error: `No remote book source "${sourceId}" is registered.` });
    // Fire-and-forget: the run streams progress to /status; a rejection is
    // logged and captured in state.error, never left unhandled. resetCursor
    // re-walks the whole catalog from page 1 — used to re-apply metadata/policy
    // (e.g. the content filter) to already-synced entries; catalogRemote is
    // idempotent, so the re-walk only updates rows.
    runRemoteSync({
      store, sources,
      sourceId: sourceId || null,
      libraryId: libraryId != null ? Number(libraryId) : null,
      maxBooks: Number(maxBooks) || 0,
      resetCursor: !!resetCursor,
    }).catch((e) => { console.warn('[ebooks] remote sync failed:', e?.message || e); });
    res.json({ started: true, state: remoteSyncStatus() });
  }, { access: CAN_MANAGE });

  // DELETE /api/ebooks/remote/:source — drop every on-demand entry that
  // source put on the shelf (its plugin was removed, or the shelf is being
  // reset). Materialised files stay. Curation-tier, like the sync itself.
  api.registerRoute('delete', '/api/ebooks/remote/:source', (req, res) => {
    const source = String(req.params.source || '').trim();
    if (!source) return res.status(400).json({ error: 'source required' });
    const removed = store.removeRemoteSource(source);
    console.log(`ebooks: removed ${removed.entries} on-demand entr${removed.entries === 1 ? 'y' : 'ies'} from ${source} (${removed.series} empty series dropped, ${removed.adopted} already-fetched file(s) kept as local books)`);
    res.json({ source, removed });
  }, { access: CAN_MANAGE });

  // POST /api/ebooks/remote-sync/stop — cooperative cancel.
  api.registerRoute('post', '/api/ebooks/remote-sync/stop', (req, res) => {
    res.json(stopRemoteSync());
  }, { access: CAN_MANAGE });

  // GET /api/ebooks/remote-sync/status — live run state + the gating flags the UI
  // needs (a source registered + a shelf to sync into).
  api.registerRoute('get', '/api/ebooks/remote-sync/status', async (req, res) => {
    const sources = await remoteSources();
    res.json({
      ...remoteSyncStatus(),
      sources: sources.map((s) => ({ id: s.id, label: s.label || s.id })),
      hasLibrary: ebookLibraries(store.db).length > 0,
    });
  }, { access: CAN_MANAGE });

  // POST /api/ebooks/issue/:id/rematch — force a fresh metadata-service match
  // for one book (also the retry path after a miss).
  api.registerRoute('post', '/api/ebooks/issue/:id/rematch', async (req, res) => {
    const f = fileOr404(req, res);
    if (!f) return;
    try {
      const clients = await matchClients();
      for (const c of clients) { if (c && !c.available()) await c.ensureKey?.(); }
      if (!clients.some((c) => c && c.available())) return res.status(503).json({ error: 'no metadata source available yet' });
      const merged = await matchBookAcross(clients, store.bookForMatch(f.issue_id));
      if (merged) store.applyMatch(f.issue_id, merged);
      else store.setMatchChecked(f.issue_id);
      res.json({ matched: !!merged });
    } catch (e) { res.status(502).json({ error: String(e?.message || e) }); }
  }, { access: CAN_MANAGE });
}
