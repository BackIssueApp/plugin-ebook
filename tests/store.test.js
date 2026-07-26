// Store: books become REAL catalog rows — series/issues/library_files in the
// core schema — with only ebook specifics (path map, covers, match state,
// reading progress) in plugin tables. Exercised against the real core schema
// (openDb) and read back through core's own collection views.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  openDb, collectionSeries, seriesCollectionDetail, seriesMatchesFilter,
  SERIES_TYPES, SELF_DESCRIBED_TYPES,
} from '../../../src/db.js';
import { openEbooksStore } from '../store.js';

// What registerLibraryType({ id: 'ebook', selfDescribed: true }) does at load.
if (!SERIES_TYPES.includes('ebook')) SERIES_TYPES.push('ebook');
SELF_DESCRIBED_TYPES.add('ebook');

function setup() {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'ebooks-store-'));
  const dbPath = path.join(p, 'cat.db');
  const core = openDb(dbPath); // the real core schema + migrations
  core.prepare("INSERT INTO libraries (name, type, root_folder, sort_order) VALUES ('Books', 'ebook', ?, 0)")
    .run(path.join(p, 'shelf'));
  core.close();
  const store = openEbooksStore(dbPath);
  // Windows can hold the db file briefly after close — temp dirs the OS reaps.
  const rm = () => { store.close(); try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* reaped later */ } };
  return { p, store, libId: 1, rm };
}

const DUNE = {
  title: 'Dune', title_source: 'embedded', authors: ['Frank Herbert'],
  series: null, series_index: null, isbn: '9780441172719',
  description: 'Spice.', language: 'en', cover: Buffer.from('IMG'), cover_type: 'image/jpeg',
};
const ME = (title, index) => ({
  title, title_source: 'embedded', authors: ['J. R. R. Tolkien'],
  series: 'Middle Earth', series_index: index, isbn: null,
  description: null, language: 'en', cover: null, cover_type: null,
});
const file = (p, name) => path.join(p, 'shelf', name);

test('catalogFile: standalone book and calibre series become core series/issues', () => {
  const { p, store, libId, rm } = setup();
  try {
    const dune = store.catalogFile({ libraryId: libId, path: file(p, 'dune.epub'), format: 'epub', size: 100, mtime: 1, meta: DUNE });
    // Out of order on purpose — the issue list must still sort by series_index.
    store.catalogFile({ libraryId: libId, path: file(p, 'me2.epub'), format: 'epub', size: 200, mtime: 1, meta: ME('The Two Towers', 2) });
    store.catalogFile({ libraryId: libId, path: file(p, 'me1.epub'), format: 'epub', size: 150, mtime: 1, meta: ME('The Fellowship', 1) });

    // Standalone: a single-issue series named after the book, author in the
    // byline (publisher) slot, description + cover on the series row.
    const sDune = store.db.prepare('SELECT * FROM series WHERE id=?').get(dune.seriesId);
    assert.equal(sDune.title, 'Dune');
    assert.equal(sDune.publisher, 'Frank Herbert');
    assert.equal(sDune.type, 'ebook');
    assert.equal(sDune.library_id, libId);
    assert.equal(sDune.description, 'Spice.');
    assert.equal(sDune.cover_url, `/api/ebooks/issue/${dune.issueId}/cover`);
    assert.equal(sDune.cv_id, null);

    // The collection view (the Library grid's data) renders it matched+local.
    const rows = collectionSeries(store.db, {});
    const rDune = rows.find((r) => r.id === dune.seriesId);
    assert.equal(rDune.source, 'local');
    assert.equal(rDune.matched, true);
    assert.equal(rDune.title, 'Dune');
    assert.equal(rDune.publisher, 'Frank Herbert');
    assert.deepEqual([rDune.total, rDune.owned, rDune.missing], [1, 1, 0]);
    assert.ok(seriesMatchesFilter(rDune, 'ebook'), 'the type lane picks it up');
    assert.ok(!seriesMatchesFilter(rDune, 'unmatched'), 'self-described is never "unmatched"');

    // Calibre series: ONE series row, books as issues ordered by series_index.
    const rME = rows.find((r) => r.title === 'Middle Earth');
    assert.ok(rME, 'series row named after the calibre series');
    assert.deepEqual([rME.total, rME.owned], [2, 2]);
    const det = seriesCollectionDetail(store.db, rME.id);
    assert.equal(det.source, 'local');
    assert.equal(det.matched, true);
    assert.deepEqual(det.issues.map((i) => [i.number, i.title, i.owned, i.downloadable, i.cv_issue_id]), [
      ['1', 'The Fellowship', true, false, null],
      ['2', 'The Two Towers', true, false, null],
    ]);
    assert.equal(det.issues[0].files.length, 1, 'the file rides the issue');
    assert.equal(det.issues[0].files[0].has_metadata, 1, 'books never read as "untagged"');

    // Cover route: embedded blob for Dune; nothing for the cover-less ME books.
    assert.equal(store.cover(dune.issueId).cover.toString(), 'IMG');
    assert.equal(store.cover(det.issues[0].id), null);
  } finally { rm(); }
});

test('recatalog is idempotent (same rows) and removeMissing prunes catalog + progress', () => {
  const { p, store, libId, rm } = setup();
  try {
    const a = store.catalogFile({ libraryId: libId, path: file(p, 'me1.epub'), format: 'epub', size: 150, mtime: 1, meta: ME('The Fellowship', 1) });
    const b = store.catalogFile({ libraryId: libId, path: file(p, 'me2.epub'), format: 'epub', size: 200, mtime: 1, meta: ME('The Two Towers', 2) });
    assert.equal(a.seriesId, b.seriesId);

    // Re-parse of the same path lands on the same rows (url-keyed upserts).
    const a2 = store.catalogFile({ libraryId: libId, path: file(p, 'me1.epub'), format: 'epub', size: 151, mtime: 2, meta: ME('The Fellowship of the Ring', 1) });
    assert.deepEqual([a2.seriesId, a2.issueId], [a.seriesId, a.issueId]);
    assert.equal(store.db.prepare('SELECT title FROM issues WHERE id=?').get(a.issueId).title, 'The Fellowship of the Ring');

    // One file vanishes: its issue, file rows, and progress go; the series
    // survives with the remaining book. Then the last file goes → series too.
    store.saveProgress(7, a.issueId, { locator: 'x', fraction: 0.5 });
    assert.equal(store.removeMissing(libId, new Set([file(p, 'me2.epub')])), 1);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM issues WHERE series_id=?').get(a.seriesId).n, 1);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM library_files').get().n, 1);
    assert.equal(store.progress(7, a.issueId).fraction, 0, 'progress went with the book');
    assert.equal(store.removeMissing(libId, new Set()), 1);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM series').get().n, 0, 'empty book series pruned like a dead catalog row');
  } finally { rm(); }
});

test('progress: per-user upsert with clamped fraction; stateMap feeds the row icons', () => {
  const { p, store, libId, rm } = setup();
  try {
    const { issueId } = store.catalogFile({ libraryId: libId, path: file(p, 'dune.epub'), format: 'epub', size: 100, mtime: 1, meta: DUNE });
    assert.deepEqual(store.progress(1, issueId), { locator: null, fraction: 0, updated_at: null });
    store.saveProgress(1, issueId, { locator: 'epubcfi(/6/4!/4/2)', fraction: 0.25 });
    store.saveProgress(1, issueId, { locator: 'epubcfi(/6/8!/4/2)', fraction: 1.7 });
    assert.equal(store.progress(1, issueId).locator, 'epubcfi(/6/8!/4/2)');
    assert.equal(store.progress(1, issueId).fraction, 1, 'fraction clamped to [0,1]');
    assert.equal(store.progress(2, issueId).fraction, 0, 'other users untouched');
    assert.deepEqual(store.stateMap(1), { [issueId]: { fraction: 1 } });
  } finally { rm(); }
});

test('applyMatch folds service data into the catalog; misses are marked checked', () => {
  const { p, store, libId, rm } = setup();
  try {
    // A bare PDF: filename title, no author, no cover — the worst case.
    const { seriesId, issueId } = store.catalogFile({
      libraryId: libId, path: file(p, 'dune 1965 retail.pdf'), format: 'pdf', size: 100, mtime: 1,
      meta: { title: 'dune 1965 retail', title_source: 'filename', authors: [], series: null, series_index: null, isbn: null, description: null, language: null, cover: null, cover_type: null },
    });
    const un = store.unmatched();
    assert.equal(un.length, 1);
    assert.deepEqual([un[0].id, un[0].title, un[0].title_source], [issueId, 'dune 1965 retail', 'filename']);

    store.applyMatch(issueId, {
      match_id: 'gb-1', match_confidence: 'isbn',
      title: 'Dune', authors: ['Frank Herbert'], description: 'A very long description.',
      isbn: '9780441172719', published_date: '1965-08-01', page_count: 412,
      thumbnail: 'https://books.example/dune.jpg',
    });
    const s = store.db.prepare('SELECT * FROM series WHERE id=?').get(seriesId);
    assert.equal(s.title, 'Dune', 'filename-derived standalone title upgraded');
    assert.equal(s.publisher, 'Frank Herbert', 'empty byline filled');
    assert.equal(s.description, 'A very long description.');
    assert.equal(s.year, '1965');
    assert.equal(s.cover_url, `/api/ebooks/issue/${issueId}/cover`, 'thumbnail names the series cover');
    assert.equal(store.db.prepare('SELECT title FROM issues WHERE id=?').get(issueId).title, 'Dune');
    assert.equal(store.db.prepare('SELECT page_count FROM library_files').get().page_count, 412);
    assert.deepEqual(store.cover(issueId), { thumbnail: 'https://books.example/dune.jpg' });
    assert.equal(store.fileByIssue(issueId).match_id, 'gb-1');
    assert.equal(store.unmatched().length, 0);

    // A miss elsewhere is recorded so scans don't re-ask the service forever.
    const other = store.catalogFile({ libraryId: libId, path: file(p, 'obscure.epub'), format: 'epub', size: 5, mtime: 1, meta: { ...DUNE, title: 'Obscure', isbn: null } });
    assert.equal(store.unmatched().length, 1);
    store.setMatchChecked(other.issueId);
    assert.equal(store.unmatched().length, 0);
  } finally { rm(); }
});
