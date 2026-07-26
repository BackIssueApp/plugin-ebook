// Best-effort book metadata from the hosted metadata service.
//
//   GET <base>/books/search?q=<text>&limit=N → { results: [{ id, title,
//       subtitle, authors[], description, publisher, published_date,
//       isbn_10, isbn_13, page_count, categories[], language, thumbnail }] }
//   GET <base>/books/volume/<id>             → { book: {same shape} }
//
// <base> is the app's metadata endpoint (the cvBaseUrl setting, which already
// ends in /api — default https://data.backissue.app/api). Auth is the app's
// self-provisioned instance key (metadataInstanceKey), sent as x-api-key.
// The key is provisioned by core's first metadata call; until it exists this
// client simply reports unavailable — files work fine unmatched, and the scan
// job retries later.

const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
const tokens = (s) => new Set(norm(s).split(' ').filter(Boolean));
const stripIsbn = (s) => String(s || '').replace(/[\s-]/g, '').toUpperCase();

/** Jaccard-ish overlap of the SHORTER title's tokens ("Dune" vs
 *  "Dune (40th Anniversary Edition)" should score high). */
function titleSimilarity(a, b) {
  const ta = tokens(a); const tb = tokens(b);
  if (!ta.size || !tb.size) return 0;
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit++;
  return hit / Math.min(ta.size, tb.size);
}

function authorsOverlap(a = [], b = []) {
  if (!a.length || !b.length) return null; // unknown — not a signal either way
  const bt = b.map(norm);
  // Surname-level match is enough ("Frank Herbert" vs "Herbert, Frank").
  return a.some((x) => {
    const words = norm(x).split(' ').filter((w) => w.length > 2);
    return words.some((w) => bt.some((y) => y.includes(w)));
  });
}

export function makeBooksClient(config, { fetchImpl } = {}) {
  const doFetch = fetchImpl || fetch;
  // Same rule as core's client: the supplied metadata service is the endpoint;
  // the old cvBaseUrl setting is ignored (env override = tests/dev only).
  const base = () => String(process.env.METADATA_BASE_OVERRIDE || 'https://data.backissue.app/api').trim().replace(/\/+$/, '');
  const key = () => config.metadataInstanceKey || null;

  async function getJson(url) {
    const r = await doFetch(url, { headers: { 'x-api-key': key() } });
    if (!r.ok) throw new Error(`metadata service HTTP ${r.status}`);
    return r.json();
  }
  return {
    /** Is the service usable right now? (No key yet → no.) */
    available: () => !!key(),
    /** Provision the shared instance key if the app hasn't yet — core only
     *  mints it on ITS first metadata call, which a fresh install may not
     *  have made when the first book scan runs. Same single-flight path and
     *  persistence guard as core; best-effort (offline installs stay
     *  unmatched and retry on later scans). */
    async ensureKey() {
      if (key()) return true;
      try {
        const { ensureInstanceKey } = await import('../../src/cv.js');
        await ensureInstanceKey(config, base(), doFetch);
        return !!key();
      } catch { return false; }
    },
    async search(q, limit = 5) {
      if (!key()) return null;
      const u = `${base()}/books/search?q=${encodeURIComponent(q)}&limit=${limit}`;
      return (await getJson(u))?.results || [];
    },
    async volume(id) {
      if (!key()) return null;
      return (await getJson(`${base()}/books/volume/${encodeURIComponent(id)}`))?.book || null;
    },
  };
}

/** Pick the best search result for a scanned book, or null.
 *  ISBN equality is a certain match; otherwise the heuristic is deliberately
 *  simple: the titles must share most of the shorter title's words AND the
 *  authors must not contradict (either side unknown is fine). */
export function chooseMatch(book, results) {
  if (!Array.isArray(results) || !results.length) return null;
  if (book.isbn) {
    const mine = stripIsbn(book.isbn);
    const hit = results.find((r) => stripIsbn(r.isbn_13) === mine || stripIsbn(r.isbn_10) === mine);
    if (hit) return { result: hit, confidence: 'isbn' };
  }
  for (const r of results) {
    if (titleSimilarity(book.title, r.title) >= 0.6 && authorsOverlap(book.authors, r.authors) !== false) {
      return { result: r, confidence: 'title' };
    }
  }
  return null;
}

/** Merge an accepted match into store fields. The rule: NEVER replace an
 *  embedded (user-visible) field with worse data —
 *   • title: an embedded title always wins; a filename-derived title is
 *     replaced by the service's (that's strictly better);
 *   • description: the longer one wins;
 *   • authors/isbn: fill only when the file had none;
 *   • service-only fields (publisher, dates, categories, thumbnail, …) are
 *     always taken — the file has no opinion on them. */
export function mergeMatch(book, result, confidence) {
  const out = {
    match_id: String(result.id),
    match_confidence: confidence,
    subtitle: result.subtitle ?? null,
    publisher: result.publisher ?? null,
    published_date: result.published_date ?? null,
    page_count: Number.isFinite(result.page_count) ? result.page_count : null,
    categories: Array.isArray(result.categories) ? result.categories : [],
    language: result.language ?? book.language ?? null,
    thumbnail: result.thumbnail ?? null,
  };
  if (result.title && book.title_source !== 'embedded') out.title = result.title;
  if (String(result.description || '').length > String(book.description || '').length) {
    out.description = result.description;
  }
  if (!book.authors?.length && Array.isArray(result.authors) && result.authors.length) out.authors = result.authors;
  if (!book.isbn && (result.isbn_13 || result.isbn_10)) out.isbn = result.isbn_13 || result.isbn_10;
  return out;
}

/** One book, end to end: search (ISBN first, else title+author), choose,
 *  merge. Returns the merged fields or null (no key / no confident match). */
export async function matchBook(client, book) {
  if (!client.available()) return null;
  let results = null;
  if (book.isbn) results = await client.search(book.isbn, 5);
  const choice1 = chooseMatch(book, results || []);
  if (choice1) return mergeMatch(book, choice1.result, choice1.confidence);
  const q = [book.title, book.authors?.[0]].filter(Boolean).join(' ');
  if (!q) return null;
  results = await client.search(q, 5);
  const choice = chooseMatch(book, results || []);
  return choice ? mergeMatch(book, choice.result, choice.confidence) : null;
}

/** Try each source in order (plugin sources first, hosted fallback last) and
 *  return the first confident match. A source that isn't usable, or that
 *  throws, is skipped so a flaky source never blocks a working one. */
export async function matchBookAcross(clients, book) {
  for (const c of clients) {
    if (!c || !c.available()) continue;
    try {
      const m = await matchBook(c, book);
      if (m) return m;
    } catch { /* source trouble → try the next source */ }
  }
  return null;
}

/** Best-effort pass over never-attempted books. `clients` is one client or an
 *  ordered array (preferred first). Every book gets its attempt recorded (hit
 *  or miss) so scans don't re-hammer sources; if EVERY source errors on a book
 *  the pass stops (transient trouble — retried next scan). */
export async function matchNewBooks(store, clients, { log = () => {} } = {}) {
  const list = Array.isArray(clients) ? clients : [clients];
  // Provision the hosted key where a source offers it (BW-style sources don't).
  for (const c of list) { if (c && !c.available()) await c.ensureKey?.(); }
  if (!list.some((c) => c && c.available())) return { matched: 0, checked: 0 };
  let matched = 0; let checked = 0;
  for (const book of store.unmatched()) {
    let errored = 0; let merged = null;
    for (const c of list) {
      if (!c || !c.available()) continue;
      try { merged = await matchBook(c, book); if (merged) break; }
      catch { errored++; }
    }
    if (!merged && errored && errored === list.filter((c) => c && c.available()).length) {
      log('ebooks: metadata match stopped (all sources erroring)');
      break; // every source is unhappy — don't burn the rest of the queue
    }
    if (merged) { store.applyMatch(book.id, merged); matched++; }
    else store.setMatchChecked(book.id);
    checked++;
  }
  return { matched, checked };
}
