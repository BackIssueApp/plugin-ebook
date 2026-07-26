// Remote (file-less) catalog: a registered remote source is synced as
// metadata-only series/issue rows (no files), and each book's EPUB is fetched
// on first read (cache-on-read). Exercised against the real core schema
// (openDb) with fully mocked sources — no network, no real download.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  openDb, collectionSeries, seriesCollectionDetail,
  SERIES_TYPES, SELF_DESCRIBED_TYPES,
} from '../../../src/db.js';
import { openEbooksStore } from '../store.js';
import {
  runRemoteSync, remoteSyncStatus, stopRemoteSync, materializeOnRead, inflightCount,
} from '../remotesync.js';

// What registerLibraryType({ id: 'ebook', selfDescribed: true }) does at load.
if (!SERIES_TYPES.includes('ebook')) SERIES_TYPES.push('ebook');
SELF_DESCRIBED_TYPES.add('ebook');

function setup() {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'ebooks-remote-'));
  const dbPath = path.join(p, 'cat.db');
  const core = openDb(dbPath);
  core.prepare("INSERT INTO libraries (name, type, root_folder, sort_order) VALUES ('Books', 'ebook', ?, 0)")
    .run(path.join(p, 'shelf'));
  core.close();
  const store = openEbooksStore(dbPath);
  const rm = () => { store.close(); try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* reaped later */ } };
  return { p, store, libId: 1, rm };
}

// A remote bookMeta as a source's listPage would emit it.
const meta = (remote_id, extra = {}) => ({
  remote_id, title: 'Book ' + remote_id, author: 'Author ' + remote_id,
  series: null, series_index: null, isbn: null, publisher: null, year: null,
  language: 'en', description: null, coverUrl: `/api/bookwarehouse/cover/${remote_id}`, ...extra,
});

// ---- catalogRemote ---------------------------------------------------------
test('catalogRemote creates a file-less series/issue + ebooks_files(path NULL, source, remote_id)', () => {
  const { store, libId, rm } = setup();
  try {
    const { seriesId, issueId, created } = store.catalogRemote({
      libraryId: libId, source: 'bookwarehouse', remoteId: 'r1',
      meta: meta('r1', { title: 'Dune', author: 'Frank Herbert', isbn: '9780441172719', year: '1965', description: 'Spice.' }),
    });
    assert.equal(created, true);

    // Standalone series named after the book; author byline; year; cover route.
    const s = store.db.prepare('SELECT * FROM series WHERE id=?').get(seriesId);
    assert.equal(s.title, 'Dune');
    assert.equal(s.publisher, 'Frank Herbert');
    assert.equal(s.type, 'ebook');
    assert.equal(s.year, '1965');
    assert.equal(s.description, 'Spice.');
    assert.equal(s.cover_url, `/api/ebooks/issue/${issueId}/cover`);
    assert.equal(s.cv_id, null);

    // The ebooks_files row is file-less: no path, no size, but source/remote_id.
    const ef = store.db.prepare('SELECT * FROM ebooks_files WHERE issue_id=?').get(issueId);
    assert.equal(ef.path, null);
    assert.equal(ef.size, null);
    assert.equal(ef.source, 'bookwarehouse');
    assert.equal(ef.remote_id, 'r1');
    assert.equal(ef.thumbnail, '/api/bookwarehouse/cover/r1');

    // No library_files row is written for a file-less entry.
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM library_files').get().n, 0);

    // cover() serves the remote cover URL as a thumbnail (no blob needed).
    assert.deepEqual(store.cover(issueId), { thumbnail: '/api/bookwarehouse/cover/r1' });

    // The issue is keyed by an ebookremote: url and carries no file_path yet.
    const iss = store.db.prepare('SELECT * FROM issues WHERE id=?').get(issueId);
    assert.equal(iss.url, 'ebookremote:bookwarehouse:r1');
    assert.equal(iss.file_path, null);

    // fileByIssue exposes source/remote_id/path so the route can decide.
    const f = store.fileByIssue(issueId);
    assert.deepEqual([f.source, f.remote_id, f.path], ['bookwarehouse', 'r1', null]);
  } finally { rm(); }
});

test('catalogRemote groups a calibre series into one series with issues', () => {
  const { store, libId, rm } = setup();
  try {
    store.catalogRemote({ libraryId: libId, source: 'bw', remoteId: 'a', meta: meta('a', { title: 'Two Towers', series: 'Middle Earth', series_index: 2, author: 'Tolkien' }) });
    const { seriesId } = store.catalogRemote({ libraryId: libId, source: 'bw', remoteId: 'b', meta: meta('b', { title: 'Fellowship', series: 'Middle Earth', series_index: 1, author: 'Tolkien' }) });
    const det = seriesCollectionDetail(store.db, seriesId);
    assert.equal(det.issues.length, 2);
    assert.deepEqual(det.issues.map((i) => [i.number, i.title]), [['1', 'Fellowship'], ['2', 'Two Towers']]);
    assert.equal(store.db.prepare("SELECT COUNT(*) n FROM series WHERE title='Middle Earth'").get().n, 1);
  } finally { rm(); }
});

test('catalogRemote is idempotent by (source, remote_id) — a re-sync updates, never duplicates', () => {
  const { store, libId, rm } = setup();
  try {
    const first = store.catalogRemote({ libraryId: libId, source: 'bw', remoteId: 'r1', meta: meta('r1', { title: 'Old Title' }) });
    const second = store.catalogRemote({ libraryId: libId, source: 'bw', remoteId: 'r1', meta: meta('r1', { title: 'New Title' }) });
    assert.deepEqual([second.seriesId, second.issueId], [first.seriesId, first.issueId]);
    assert.equal(second.created, false);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM ebooks_files').get().n, 1, 'no duplicate plugin row');
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM issues').get().n, 1, 'no duplicate issue');
    assert.equal(store.db.prepare('SELECT title FROM issues WHERE id=?').get(first.issueId).title, 'New Title');
  } finally { rm(); }
});

test('catalogRemote honors meta.restricted: sets it on create, re-affirms on re-sync, and null leaves it', () => {
  const { store, libId, rm } = setup();
  try {
    // Flagged on create → series is restricted (mature/hidden).
    const { seriesId } = store.catalogRemote({ libraryId: libId, source: 'bw', remoteId: 'r1', meta: meta('r1', { restricted: true }) });
    assert.equal(store.db.prepare('SELECT restricted FROM series WHERE id=?').get(seriesId).restricted, 1);

    // A later sync where the source no longer classifies (restricted absent →
    // null) must NOT clear the flag.
    store.catalogRemote({ libraryId: libId, source: 'bw', remoteId: 'r1', meta: meta('r1', { title: 'Same Book' }) });
    assert.equal(store.db.prepare('SELECT restricted FROM series WHERE id=?').get(seriesId).restricted, 1, 'null leaves restricted untouched');

    // An explicit false (policy/rule change cleared it) DOES un-restrict.
    store.catalogRemote({ libraryId: libId, source: 'bw', remoteId: 'r1', meta: meta('r1', { restricted: false }) });
    assert.equal(store.db.prepare('SELECT restricted FROM series WHERE id=?').get(seriesId).restricted, 0);

    // A fresh non-flagged entry defaults to not-restricted.
    const { seriesId: s2 } = store.catalogRemote({ libraryId: libId, source: 'bw', remoteId: 'r2', meta: meta('r2', { title: 'Clean' }) });
    assert.equal(store.db.prepare('SELECT restricted FROM series WHERE id=?').get(s2).restricted, 0);
  } finally { rm(); }
});

test('a re-sync does NOT clobber a path/size a materialize already recorded', () => {
  const { store, libId, rm } = setup();
  try {
    const { issueId } = store.catalogRemote({ libraryId: libId, source: 'bw', remoteId: 'r1', meta: meta('r1') });
    store.materializedPath(issueId, '/tmp/cached.epub', 12345, 999);
    store.catalogRemote({ libraryId: libId, source: 'bw', remoteId: 'r1', meta: meta('r1', { title: 'Refreshed' }) });
    const ef = store.db.prepare('SELECT * FROM ebooks_files WHERE issue_id=?').get(issueId);
    assert.deepEqual([ef.path, ef.size], ['/tmp/cached.epub', 12345], 'cached download survives the re-sync');
  } finally { rm(); }
});

// A file-less entry that vanished from the remote must NOT be pruned by the
// disk scanner's removeMissing (its NULL path fails every keep check).
test('removeMissing never deletes file-less remote rows', () => {
  const { store, libId, rm } = setup();
  try {
    store.catalogRemote({ libraryId: libId, source: 'bw', remoteId: 'r1', meta: meta('r1') });
    assert.equal(store.removeMissing(libId, new Set()), 0, 'no local files gone, remote rows untouched');
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM ebooks_files').get().n, 1);
  } finally { rm(); }
});

// ---- runRemoteSync ---------------------------------------------------------
// A mock remote source over an in-memory book list.
function mockSource(id, books, { pageSize = 100 } = {}) {
  const calls = { list: 0 };
  return {
    src: {
      id, label: id,
      async listPage(_config, page) {
        calls.list++;
        const start = (page - 1) * pageSize;
        const slice = books.slice(start, start + pageSize);
        return { books: slice, page, totalPages: Math.max(1, Math.ceil(books.length / pageSize)), total: books.length };
      },
      async materialize() { throw new Error('not used in sync tests'); },
    },
    calls,
  };
}

test('runRemoteSync paginates a source and catalogs every book file-less', async () => {
  const { store, rm } = setup();
  try {
    const books = Array.from({ length: 7 }, (_, i) => meta('m' + i));
    const { src } = mockSource('bw', books, { pageSize: 3 });
    const out = await runRemoteSync({ store, sources: [src] });
    assert.equal(out.created, 7);
    assert.equal(out.done, 7);
    assert.equal(store.db.prepare("SELECT COUNT(*) n FROM ebooks_files WHERE source='bw'").get().n, 7);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM library_files').get().n, 0, 'still file-less');
    assert.equal(remoteSyncStatus().running, false);
  } finally { rm(); }
});

test('runRemoteSync maxBooks caps NEW entries created this run', async () => {
  const { store, rm } = setup();
  try {
    const books = Array.from({ length: 10 }, (_, i) => meta('m' + i));
    const { src } = mockSource('bw', books, { pageSize: 4 });
    const out = await runRemoteSync({ store, sources: [src], maxBooks: 3 });
    assert.equal(out.created, 3);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM ebooks_files').get().n, 3);
  } finally { rm(); }
});

test('runRemoteSync resumes from the saved page cursor', async () => {
  const { store, rm } = setup();
  try {
    const books = Array.from({ length: 150 }, (_, i) => meta('m' + i));
    // Cap at exactly page 1 (100) so page 1 is fully consumed and the cursor advances.
    const out1 = await runRemoteSync({ store, sources: [mockSource('bw', books).src], maxBooks: 100 });
    assert.equal(out1.created, 100);
    assert.equal(store.remoteCursor('bw'), 2, 'cursor advanced past the fully-consumed page 1');

    const { src, calls } = mockSource('bw', books);
    const out2 = await runRemoteSync({ store, sources: [src] });
    assert.equal(out2.created, 50, 'only page 2 catalogued on resume');
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM ebooks_files').get().n, 150);
    // page 1 (100 entries) was never re-listed — resume started at page 2.
    assert.equal(calls.list, 1, 'a single list call: page 2 only');
  } finally { rm(); }
});

test('runRemoteSync stops cooperatively via shouldStop', async () => {
  const { store, rm } = setup();
  try {
    const books = Array.from({ length: 20 }, (_, i) => meta('m' + i));
    let processed = 0;
    const out = await runRemoteSync({
      store, sources: [mockSource('bw', books, { pageSize: 5 }).src],
      onProgress: () => { processed++; }, shouldStop: () => processed >= 3,
    });
    assert.equal(out.stoppedAt != null, true);
    assert.equal(out.created, 3, 'stopped after three entries');
    assert.equal(remoteSyncStatus().running, false);
    // A manual stop of a finished run is a no-op that just returns state.
    assert.equal(stopRemoteSync().running, false);
  } finally { rm(); }
});

test('runRemoteSync errors when no ebook library exists', async () => {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'ebooks-remote-nolib-'));
  const dbPath = path.join(p, 'cat.db');
  const core = openDb(dbPath); core.close();
  const store = openEbooksStore(dbPath);
  try {
    await assert.rejects(() => runRemoteSync({ store, sources: [mockSource('bw', [meta('x')]).src] }), /Create a Books library first/);
  } finally { store.close(); try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* reaped */ } }
});

// ---- materializeOnRead (cache-on-read) -------------------------------------
test('materializeOnRead downloads on first open and records the path; concurrent opens share ONE download', async () => {
  const { p, store, libId, rm } = setup();
  try {
    const { issueId } = store.catalogRemote({ libraryId: libId, source: 'bw', remoteId: 'r1', meta: meta('r1') });
    let downloads = 0;
    const source = {
      id: 'bw', label: 'bw',
      async listPage() { return { books: [] }; },
      async materialize(_cfg, remoteId, opts) {
        downloads++;
        assert.equal(remoteId, 'r1');
        assert.equal(opts.libraryId, libId);
        const dest = path.join(p, 'shelf', `${remoteId}.epub`);
        await fs.promises.mkdir(path.dirname(dest), { recursive: true });
        await fs.promises.writeFile(dest, 'EPUB-BYTES');
        return { path: dest };
      },
    };
    // Two simultaneous opens of the same book → a single materialize.
    const [a, b] = await Promise.all([
      materializeOnRead({ store, sources: [source], issueId, source: 'bw', remoteId: 'r1', libraryId: libId, dbPath: path.join(p, 'cat.db') }),
      materializeOnRead({ store, sources: [source], issueId, source: 'bw', remoteId: 'r1', libraryId: libId, dbPath: path.join(p, 'cat.db') }),
    ]);
    assert.equal(downloads, 1, 'concurrency guard coalesced the two opens');
    assert.equal(a.path, b.path);
    assert.equal(fs.readFileSync(a.path, 'utf8'), 'EPUB-BYTES');
    assert.equal(inflightCount(), 0, 'the in-flight slot is cleared after completion');

    // The row now has a real path → a later open serves from disk (the route's
    // path-exists branch), never re-materializing.
    const f = store.fileByIssue(issueId);
    assert.equal(f.path, a.path);
    assert.ok(fs.existsSync(f.path));
    assert.equal(f.source, 'bw', 'origin is still recorded after materialize');
  } finally { rm(); }
});

test('materializeOnRead rejects (and stays remote) when the source is gone', async () => {
  const { p, store, libId, rm } = setup();
  try {
    const { issueId } = store.catalogRemote({ libraryId: libId, source: 'ghost', remoteId: 'r1', meta: meta('r1') });
    await assert.rejects(
      () => materializeOnRead({ store, sources: [], issueId, source: 'ghost', remoteId: 'r1', libraryId: libId, dbPath: path.join(p, 'cat.db') }),
      /not available/,
    );
    assert.equal(store.fileByIssue(issueId).path, null, 'row left remote for a retry');
    assert.equal(inflightCount(), 0);
  } finally { rm(); }
});

// A file-less series carries no owned file, so core's collection grid (which
// requires a valid library_file or a follow) does not surface it — documented
// behavior the sync UI notes by recommending a dedicated library.
test('a file-less remote series IS in the collection grid, marked available (on-demand), not missing', () => {
  const { store, libId, rm } = setup();
  try {
    const { seriesId } = store.catalogRemote({ libraryId: libId, source: 'bw', remoteId: 'r1', meta: meta('r1') });
    const row = collectionSeries(store.db, {}).find((r) => r.id === seriesId);
    assert.ok(row, 'file-less on-demand series is visible in the grid');
    assert.equal(row.owned, 0);
    assert.equal(row.available, 1);
    assert.equal(row.on_demand, true);
    assert.equal(row.missing, 0, 'on-demand is available, never "missing"');
  } finally { rm(); }
});

test('bookInfoMap marks a file-less entry remote and a materialized one local', () => {
  const { store, libId, rm } = setup();
  try {
    const { issueId } = store.catalogRemote({ libraryId: libId, source: 'bw', remoteId: 'r1', meta: meta('r1') });
    assert.deepEqual(store.bookInfoMap([issueId])[issueId], { format: 'epub', remote: true });
    store.materializedPath(issueId, '/tmp/r1.epub', 123, 1);
    assert.deepEqual(store.bookInfoMap([issueId])[issueId], { format: 'epub', remote: false });
  } finally { rm(); }
});
