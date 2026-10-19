// The cheaper paths keep their answers: "on the shelf?" through its indexes
// (and past a crowd of same-first-word titles), title keys kept for local
// books, file rows without the cover blob, a scan that stats asynchronously,
// a remote sync committed per page, and a cap on downloads at once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, SERIES_TYPES, SELF_DESCRIBED_TYPES } from '../../../src/db.js';
import { openEbooksStore } from '../store.js';
import { batchedStat, scanLibraries } from '../scanner.js';
import { runRemoteSync, materializeOnRead } from '../remotesync.js';
import { pdfBuffer } from './fixtures.js';

if (!SERIES_TYPES.includes('ebook')) SERIES_TYPES.push('ebook');
SELF_DESCRIBED_TYPES.add('ebook');

function setup(folder = 'shelf') {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'ebooks-perf-'));
  const dbPath = path.join(p, 'cat.db');
  const core = openDb(dbPath);
  core.prepare("INSERT INTO libraries (name, type, root_folder, sort_order) VALUES ('Books', 'ebook', ?, 0)")
    .run(path.join(p, folder));
  core.close();
  const store = openEbooksStore(dbPath);
  const rm = () => { store.close(); try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* reaped later */ } };
  return { p, dbPath, store, libId: 1, rm };
}
const book = (title, extra = {}) => ({
  title, title_source: 'embedded', authors: ['Ann Author'], series: null, series_index: null,
  isbn: null, description: null, language: 'en', cover: Buffer.from('IMG'), cover_type: 'image/jpeg', ...extra,
});

test('onShelf finds by match id, by ISBN in any spelling, and by title past 40 look-alikes', () => {
  const { store, libId, rm } = setup();
  try {
    // 60 books whose titles share the first word, the one we want last.
    for (let k = 0; k < 60; k++) {
      store.catalogFile({ libraryId: libId, path: `/b/the-${k}.epub`, format: 'epub', size: 1, mtime: 1, meta: book(`The Aardvark ${k}`) });
    }
    const target = store.catalogFile({ libraryId: libId, path: '/b/the-zebra.epub', format: 'epub', size: 1, mtime: 1,
      meta: book('The Zebra Road', { isbn: '978-0-441-17271-9' }) });
    store.db.prepare("UPDATE ebooks_files SET match_id='hc-42' WHERE issue_id=?").run(target.issueId);

    const want = { issueId: target.issueId, seriesId: target.seriesId };
    assert.deepEqual(store.onShelf({ matchId: 'hc-42' }), want);
    assert.deepEqual(store.onShelf({ isbn: '9780441172719' }), want);
    assert.deepEqual(store.onShelf({ isbn: '978 0441 17271-9' }), want);
    assert.deepEqual(store.onShelf({ title: 'The Zebra Road: A Novel', author: 'Ann Author' }), want);
    assert.equal(store.onShelf({ title: 'The Zebra Road', author: 'Someone Else' }), null, 'a contradicting author');
    assert.equal(store.onShelf({ matchId: 'nope', isbn: '123', title: 'Nothing Like It' }), null);

    // The lookups probe indexes rather than scanning.
    const plan = (sql, ...a) => store.db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...a).map((r) => r.detail).join(' | ');
    assert.match(plan('SELECT issue_id FROM ebooks_files WHERE match_id = ?', 'x'), /idx_ebooks_files_match/);
    assert.match(plan("SELECT issue_id FROM ebooks_files WHERE replace(replace(isbn,'-',''),' ','') = ?", 'x'), /idx_ebooks_files_isbn/);
    assert.match(plan('SELECT issue_id FROM ebooks_files f WHERE f.title_key >= ? AND f.title_key < ?', 'a', 'b'), /idx_ebooks_files_titlekey/);
  } finally { rm(); }
});

test('local books carry a title key that follows match renames; remote keys are left alone', () => {
  const { store, libId, rm } = setup();
  try {
    const { issueId } = store.catalogFile({ libraryId: libId, path: '/b/x.epub', format: 'epub', size: 1, mtime: 1, meta: book('  Some Title ') });
    const key = () => store.db.prepare('SELECT title_key FROM ebooks_files WHERE issue_id=?').get(issueId).title_key;
    assert.equal(key(), 'some title');
    store.applyMatch(issueId, { title: 'Better Title', match_id: 'm1' });
    assert.equal(key(), 'better title');

    const r = store.catalogRemote({ libraryId: libId, source: 'src', remoteId: 'r1', meta: { title: 'Remote Name' } });
    store.applyMatch(r.issueId, { title: 'Matched Name', match_id: 'm2' });
    assert.equal(store.db.prepare('SELECT title_key FROM ebooks_files WHERE issue_id=?').get(r.issueId).title_key, 'remote name');
  } finally { rm(); }
});

test('opening the store fills title keys for older local rows once', () => {
  const { dbPath, store, libId, rm } = setup();
  try {
    const { issueId } = store.catalogFile({ libraryId: libId, path: '/b/old.epub', format: 'epub', size: 1, mtime: 1, meta: book('Old Book') });
    store.db.exec('DROP INDEX idx_ebooks_files_titlekey; UPDATE ebooks_files SET title_key = NULL');
    const again = openEbooksStore(dbPath);
    assert.equal(again.db.prepare('SELECT title_key FROM ebooks_files WHERE issue_id=?').get(issueId).title_key, 'old book');
    again.close();
  } finally { rm(); }
});

test('fileByIssue leaves out the cover bytes and the outline', () => {
  const { store, libId, rm } = setup();
  try {
    const { issueId } = store.catalogFile({ libraryId: libId, path: '/b/c.epub', format: 'epub', size: 9, mtime: 1, meta: book('Covered') });
    store.saveOutline(issueId, { pages: 3, chapters: [] });
    const f = store.fileByIssue(issueId);
    assert.equal(f.path, '/b/c.epub');
    assert.equal(f.format, 'epub');
    assert.equal(f.title, 'Covered');
    assert.ok(!('cover' in f) && !('outline_json' in f));
    assert.equal(f.cover_type, 'image/jpeg');
    assert.equal(store.cover(issueId).cover.toString(), 'IMG');
  } finally { rm(); }
});

test('batchedStat stats a few files at a time, in order, and reports a missing one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ebooks-stat-'));
  try {
    const files = Array.from({ length: 19 }, (_, k) => path.join(dir, `f${k}.pdf`));
    files.forEach((f, k) => fs.writeFileSync(f, 'x'.repeat(k + 1)));
    files[7] = path.join(dir, 'gone.pdf');
    const statOf = batchedStat(files, 8);
    for (let k = 0; k < files.length; k++) {
      if (k === 7) { await assert.rejects(() => statOf(k), /ENOENT/); continue; }
      assert.equal((await statOf(k)).size, k + 1);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a rescan of unchanged books yields to other work', async () => {
  const { p, store, rm } = setup('books');
  try {
    const dir = path.join(p, 'books');
    fs.mkdirSync(dir, { recursive: true });
    const pdf = await pdfBuffer('Same');
    for (let k = 0; k < 40; k++) fs.writeFileSync(path.join(dir, `b${k}.pdf`), pdf);
    const first = await scanLibraries({ store, log: () => {} });
    assert.equal(first.added, 40);
    // Count event-loop turns while the rescan runs: the stats are awaited a
    // batch at a time, so other work gets a turn every few files.
    let turns = 0, on = true;
    const spin = () => { if (on) { turns++; setImmediate(spin); } };
    setImmediate(spin);
    const again = await scanLibraries({ store, log: () => {} });
    on = false;
    assert.equal(again.added + again.updated, 0, 'nothing reopened');
    // (A scan that stats synchronously turns ~5 times — all in the walk.)
    assert.ok(turns >= 15, `the loop turned ${turns} times`);
  } finally { rm(); }
});

test('remote sync commits a page at a time and lets other work run between pages', async () => {
  const { store, rm } = setup();
  try {
    const src = { id: 's', async listPage(_c, page) {
      if (page > 3) return { books: [], totalPages: 3 };
      return { totalPages: 3, total: 30, books: Array.from({ length: 10 }, (_, k) => ({ remote_id: `r${page}-${k}`, title: `Book ${page}-${k}` })) };
    } };
    let ticks = 0;
    const t = setInterval(() => { ticks++; }, 0);
    const commits = [];
    const orig = store.db.transaction.bind(store.db);
    store.db.transaction = (fn) => { const tx = orig(fn); return (...a) => { const out = tx(...a); if (!store.db.inTransaction) commits.push(1); return out; }; };
    const r = await runRemoteSync({ store, sources: [src], resetCursor: true });
    store.db.transaction = orig;
    clearInterval(t);
    assert.equal(r.created, 30);
    assert.equal(commits.length, 3, 'one commit per page');
    assert.ok(ticks > 0);
    const again = await runRemoteSync({ store, sources: [src], resetCursor: true });
    assert.equal(again.updated, 30, 'idempotent');
    assert.equal(store.db.prepare("SELECT COUNT(*) n FROM ebooks_files WHERE source='s'").get().n, 30);
  } finally { rm(); }
});

test('on-demand downloads run at most three at a time', async () => {
  const { p, store, libId, rm } = setup();
  try {
    let live = 0, peak = 0;
    const src = { id: 'dl', async materialize(_c, remoteId) {
      live++; peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 15));
      live--;
      const f = path.join(p, `${remoteId}.epub`);
      fs.writeFileSync(f, 'x');
      return { path: f };
    } };
    const ids = [];
    for (let k = 0; k < 7; k++) ids.push(store.catalogRemote({ libraryId: libId, source: 'dl', remoteId: `m${k}`, meta: { title: `M${k}` } }).issueId);
    const out = await Promise.all(ids.map((issueId, k) => materializeOnRead({ store, sources: [src], issueId, source: 'dl', remoteId: `m${k}`, libraryId: libId })));
    assert.equal(out.length, 7);
    assert.equal(peak, 3);
    assert.ok(out.every((o) => o.size === 1));
  } finally { rm(); }
});
