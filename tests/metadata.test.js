// Metadata-service client + match heuristic, against a mocked fetch:
// ISBN hit, title+author fallback, low-confidence rejection, absent
// instance key (no calls at all), and the merge rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBooksClient, chooseMatch, mergeMatch, matchBook, matchNewBooks } from '../metadata.js';

const RESULT = {
  id: 'gb-1', title: 'Dune', subtitle: null, authors: ['Frank Herbert'],
  description: 'A very long description of the desert planet Arrakis and its spice.',
  publisher: 'Ace Books', published_date: '1965-08-01',
  isbn_10: '0441172717', isbn_13: '9780441172719',
  page_count: 412, categories: ['Fiction / Science Fiction'], language: 'en',
  thumbnail: 'https://books.example/dune.jpg',
};
const BOOK = {
  id: 1, title: 'Dune', title_source: 'embedded', authors: ['Frank Herbert'],
  isbn: '9780441172719', description: 'Spice.', language: null,
};

function mockFetch(handler) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url: String(url), opts });
    const body = handler(String(url));
    return { ok: true, json: async () => body };
  };
  fn.calls = calls;
  return fn;
}

test('no instance key yet → unavailable, zero network calls, match is a no-op', async () => {
  const fetchImpl = mockFetch(() => ({ results: [RESULT] }));
  const client = makeBooksClient({ cvBaseUrl: '', metadataInstanceKey: '' }, { fetchImpl });
  assert.equal(client.available(), false);
  assert.equal(await client.search('dune'), null);
  assert.equal(await matchBook(client, BOOK), null);
  assert.equal(fetchImpl.calls.length, 0, 'files still work; matching just waits for the key');
});

test('ISBN hit: searched first, matched by ISBN equality, key + base wired correctly', async () => {
  const fetchImpl = mockFetch(() => ({ results: [{ ...RESULT, title: 'Dune (Some Edition)' }] }));
  // The base comes from the env override (tests/dev) or the built-in service —
  // never from settings (a stale cvBaseUrl was a recurring support case).
  process.env.METADATA_BASE_OVERRIDE = 'https://meta.example/api/';
  try {
    const client = makeBooksClient(
      { cvBaseUrl: 'https://ignored.example/wrong', metadataInstanceKey: 'inst-key-1' }, { fetchImpl });
    const merged = await matchBook(client, BOOK);
    assert.equal(merged.match_id, 'gb-1');
    assert.equal(merged.match_confidence, 'isbn');
    // One SEARCH only — no title fallback. (A separate enrich call may follow
    // for a book with no series of its own; it isn't a second search.)
    const searches = fetchImpl.calls.filter((c) => c.url.includes('/books/search'));
    assert.equal(searches.length, 1, 'ISBN query only — no title fallback needed');
    const call = searches[0];
    assert.ok(call.url.startsWith('https://meta.example/api/books/search?q=9780441172719&'),
      'env override base + /books/… (trailing slash stripped); settings cvBaseUrl ignored');
    assert.equal(call.opts.headers['x-api-key'], 'inst-key-1');
  } finally { delete process.env.METADATA_BASE_OVERRIDE; }
});

test('title+author fallback when there is no ISBN; low-confidence results are rejected', async () => {
  const good = mockFetch(() => ({ results: [RESULT] }));
  const client = makeBooksClient({ metadataInstanceKey: 'k' }, { fetchImpl: good });
  const noIsbn = { ...BOOK, isbn: null };
  const merged = await matchBook(client, noIsbn);
  assert.equal(merged.match_confidence, 'title');
  assert.ok(good.calls[0].url.includes('q=Dune%20Frank%20Herbert'), 'query is title + first author');
  assert.ok(good.calls[0].url.startsWith('https://data.backissue.app/api/books/search'), 'default base');

  // an unrelated result must NOT match, even as the only candidate
  const bad = mockFetch(() => ({ results: [{ ...RESULT, id: 'x', title: 'Cooking With Sand', authors: ['Someone Else'] }] }));
  const client2 = makeBooksClient({ metadataInstanceKey: 'k' }, { fetchImpl: bad });
  assert.equal(await matchBook(client2, noIsbn), null);
});

test('chooseMatch: ISBN equality beats order; title needs overlap AND non-contradicting authors', () => {
  const decoy = { ...RESULT, id: 'decoy', isbn_13: '9999999999999' };
  assert.equal(chooseMatch(BOOK, [decoy, RESULT]).result.id, 'gb-1');
  const c = chooseMatch({ ...BOOK, isbn: null, title: 'Dune (40th Anniversary Edition)' }, [RESULT]);
  assert.equal(c?.confidence, 'title', 'shorter-title token overlap tolerates edition suffixes');
  assert.equal(chooseMatch({ ...BOOK, isbn: null, authors: ['Somebody Unrelated'] }, [RESULT]), null,
    'author contradiction blocks a title match');
});

test('mergeMatch never downgrades embedded fields', () => {
  const m = mergeMatch(BOOK, { ...RESULT, title: 'Dune: Deluxe' }, 'title');
  assert.equal(m.title, undefined, 'embedded title sticks');
  assert.equal(m.description, RESULT.description, 'longer description wins');
  assert.equal(m.authors, undefined, 'file already had authors');
  assert.equal(m.publisher, 'Ace Books', 'service-only fields always land');
  assert.equal(m.page_count, 412);

  const scanNamed = { ...BOOK, title: 'dune 1965 retail', title_source: 'filename', authors: [], isbn: null,
    description: 'A very long description of the desert planet Arrakis and its spice, plus MORE.' };
  const m2 = mergeMatch(scanNamed, RESULT, 'isbn');
  assert.equal(m2.title, 'Dune', 'filename-derived titles are upgraded');
  assert.deepEqual(m2.authors, ['Frank Herbert'], 'empty authors are filled');
  assert.equal(m2.isbn, '9780441172719');
  assert.equal(m2.description, undefined, 'the file already had the longer description');
});

test('matchNewBooks: hits store matches, misses are marked checked, errors stop the pass', async () => {
  const applied = []; const checked = [];
  const store = {
    unmatched: () => [
      { id: 1, title: 'Dune', title_source: 'embedded', authors: ['Frank Herbert'], isbn: '9780441172719' },
      { id: 2, title: 'Zzz Nothing Matches This', title_source: 'embedded', authors: ['Nobody'], isbn: null },
    ],
    applyMatch: (id, f) => applied.push([id, f.match_id]),
    setMatchChecked: (id) => checked.push(id),
  };
  const fetchImpl = mockFetch((url) => (url.includes('9780441172719') ? { results: [RESULT] } : { results: [] }));
  const client = makeBooksClient({ metadataInstanceKey: 'k' }, { fetchImpl });
  const r = await matchNewBooks(store, client);
  assert.deepEqual(applied, [[1, 'gb-1']]);
  assert.deepEqual(checked, [2], 'the miss is recorded so scans stop retrying it');
  assert.deepEqual(r, { matched: 1, checked: 2 });
});

test('matchBookAcross: preferred source wins; falls back to the next on miss/error', async () => {
  const { matchBookAcross } = await import('../metadata.js');
  const noIsbnBook = { id: 9, title: 'Dune', title_source: 'embedded', authors: ['Frank Herbert'], language: null };
  // A stand-in "source" client: available() + search() returning match-shaped rows.
  const src = (rows, { avail = true, throws = false } = {}) => ({
    available: () => avail,
    async search() { if (throws) throw new Error('boom'); return rows; },
  });
  const bwHit = { ...RESULT, id: 'bw-1', thumbnail: '/api/bookwarehouse/cover/bw-1' };

  // Preferred (first) source has it → its result is used, the fallback isn't consulted.
  let fallbackConsulted = false;
  const fallback = { available: () => true, async search() { fallbackConsulted = true; return [RESULT]; } };
  const m1 = await matchBookAcross([src([bwHit]), fallback], noIsbnBook);
  assert.equal(m1.match_id, 'bw-1');
  assert.equal(m1.thumbnail, '/api/bookwarehouse/cover/bw-1');
  assert.equal(fallbackConsulted, false, 'preferred source satisfied the match');

  // Preferred returns nothing → fall through to the next source.
  const m2 = await matchBookAcross([src([]), src([RESULT])], noIsbnBook);
  assert.equal(m2.match_id, 'gb-1');

  // Preferred THROWS → skipped, next source still matches.
  const m3 = await matchBookAcross([src([], { throws: true }), src([RESULT])], noIsbnBook);
  assert.equal(m3.match_id, 'gb-1');

  // Unavailable sources are skipped entirely.
  const m4 = await matchBookAcross([src([bwHit], { avail: false }), src([RESULT])], noIsbnBook);
  assert.equal(m4.match_id, 'gb-1');
});

// ---- Hardcover enrichment ----------------------------------------------------

test('search and volume ask the service for hardcover enrichment', async () => {
  const fetchImpl = mockFetch(() => ({ results: [], book: null }));
  const c = makeBooksClient({ metadataInstanceKey: 'k' }, { fetchImpl });
  await c.search('Dune', 5);
  await c.volume('gb-1');
  assert.ok(fetchImpl.calls[0].url.includes('enrich=hardcover'), fetchImpl.calls[0].url);
  assert.ok(fetchImpl.calls[1].url.includes('enrich=hardcover'), fetchImpl.calls[1].url);
});

test('mergeMatch takes series (with position) from the enrichment', () => {
  const enriched = {
    ...RESULT,
    hardcover: {
      series: [
        { name: 'Dune Chronicles', position: 1 },
        { name: 'Dune Universe', position: 1 },
      ],
      rating: 4.25,
    },
  };
  const m = mergeMatch({ ...BOOK, series: null }, enriched, 'isbn');
  assert.equal(m.series_name, 'Dune Chronicles', 'first membership wins — the shelf needs one');
  assert.equal(m.series_index, 1);
});

test('mergeMatch never overrides a series the file itself declares', () => {
  const enriched = { ...RESULT, hardcover: { series: [{ name: 'Dune Chronicles', position: 1 }] } };
  const m = mergeMatch({ ...BOOK, series: 'My Own Calibre Series' }, enriched, 'isbn');
  assert.equal(m.series_name, undefined, 'embedded calibre metadata is the user\'s own data');
});

test('mergeMatch survives an unenriched or malformed result', () => {
  assert.equal(mergeMatch(BOOK, RESULT, 'isbn').series_name, undefined);
  assert.equal(mergeMatch(BOOK, { ...RESULT, hardcover: null }, 'isbn').series_name, undefined);
  assert.equal(mergeMatch(BOOK, { ...RESULT, hardcover: { series: [] } }, 'isbn').series_name, undefined);
  assert.equal(mergeMatch(BOOK, { ...RESULT, hardcover: { series: [{ name: '  ' }] } }, 'isbn').series_name, undefined);
});

test('matchBook resolves enrichment for the chosen match (search alone is cache-only)', async () => {
  // The bug this guards: search results carry enrichment only if the service
  // already had it cached, so on a cold cache a match would never gain series.
  const fetchImpl = mockFetch((url) => {
    if (url.includes('/books/enrich')) {
      return { hardcover: { series: [{ name: 'Dune Chronicles', position: 1 }] } };
    }
    return { results: [RESULT] }; // unenriched, as a cold cache returns
  });
  const c = makeBooksClient({ metadataInstanceKey: 'k' }, { fetchImpl });
  const m = await matchBook(c, { ...BOOK, series: null });
  assert.equal(m.series_name, 'Dune Chronicles');
  assert.equal(m.series_index, 1);
  assert.ok(fetchImpl.calls.some((x) => x.url.includes('/books/enrich?isbn=9780441172719')), 'asked by ISBN');
});

test('matchBook skips the enrichment call when it cannot help', async () => {
  const fetchImpl = mockFetch(() => ({ results: [RESULT] }));
  const c = makeBooksClient({ metadataInstanceKey: 'k' }, { fetchImpl });
  // Already grouped by its own calibre metadata → nothing to gain.
  await matchBook(c, { ...BOOK, series: 'Middle Earth' });
  assert.ok(!fetchImpl.calls.some((x) => x.url.includes('/books/enrich')), 'no wasted call');
});

test('matchBook still matches when the service has no enrich route', async () => {
  const fetchImpl = mockFetch((url) => {
    if (url.includes('/books/enrich')) throw new Error('404');
    return { results: [RESULT] };
  });
  const c = makeBooksClient({ metadataInstanceKey: 'k' }, { fetchImpl });
  const m = await matchBook(c, { ...BOOK, series: null });
  assert.equal(m.match_id, 'gb-1', 'the match survives; enrichment is optional');
  assert.equal(m.series_name, undefined);
});
