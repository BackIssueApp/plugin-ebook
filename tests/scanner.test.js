// Scanner: walks a real temp ebook library (seeded through the real core
// schema), extracts metadata from real EPUB/PDF fixtures, catalogs every book
// as core series/issue rows, skips unchanged files on rescan, picks up edits,
// and prunes catalog rows for deleted files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../../src/db.js';
import { openEbooksStore } from '../store.js';
import { scanLibraries, ebookLibraries, walkEbooks } from '../scanner.js';
import { epubBuffer, pdfBuffer } from './fixtures.js';

function tmpdir() {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'ebooks-scan-'));
  // Windows can hold the db file briefly after close — temp dirs the OS reaps.
  return { p, rm: () => { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* reaped later */ } } };
}

test('scan: add (grouping series) → skip unchanged → update changed → remove deleted', async () => {
  const { p, rm } = tmpdir();
  try {
    const booksDir = path.join(p, 'books');
    fs.mkdirSync(path.join(booksDir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(booksDir, 'alpha.epub'), await epubBuffer('Alpha'));
    fs.writeFileSync(path.join(booksDir, 'saga1.epub'), await epubBuffer('Saga One', { series: 'Saga', index: 1 }));
    fs.writeFileSync(path.join(booksDir, 'saga2.epub'), await epubBuffer('Saga Two', { series: 'Saga', index: 2 }));
    fs.writeFileSync(path.join(booksDir, 'sub', 'beta.pdf'), await pdfBuffer('Beta'));
    fs.writeFileSync(path.join(booksDir, 'notes.txt'), 'ignored');
    fs.writeFileSync(path.join(booksDir, '.hidden.epub'), 'ignored dotfile');

    const dbPath = path.join(p, 'cat.db');
    const core = openDb(dbPath); // real schema — an 'ebook' library plus a comic one the scanner must ignore
    core.prepare("INSERT INTO libraries (name, type, root_folder, sort_order) VALUES ('Books', 'ebook', ?, 0)").run(booksDir);
    core.prepare("INSERT INTO libraries (name, type, root_folder, sort_order) VALUES ('Comics', 'comic', '/somewhere/else', 1)").run();
    core.close();
    const store = openEbooksStore(dbPath);
    assert.deepEqual(ebookLibraries(store.db).map((l) => l.id), [1], 'only ebook-type libraries scan');
    assert.equal((await walkEbooks(booksDir)).length, 4, 'txt + dotfile excluded, subdirs walked');

    const s1 = await scanLibraries({ store, log: () => {} });
    assert.equal(s1.added, 4);
    assert.equal(s1.error, null);
    // Catalog shape: standalone books = single-issue series; the calibre
    // series = one series with two issues.
    const titles = store.db.prepare('SELECT title FROM series ORDER BY title').all().map((r) => r.title);
    assert.deepEqual(titles, ['Alpha', 'Beta', 'Saga']);
    const saga = store.db.prepare("SELECT * FROM series WHERE title='Saga'").get();
    assert.equal(saga.type, 'ebook');
    assert.equal(saga.library_id, 1);
    assert.equal(saga.publisher, 'Test Author');
    const sagaIssues = store.db.prepare('SELECT issue_number, title, status FROM issues WHERE series_id=? ORDER BY CAST(issue_number AS REAL)').all(saga.id);
    assert.deepEqual(sagaIssues, [
      { issue_number: '1', title: 'Saga One', status: 'done' },
      { issue_number: '2', title: 'Saga Two', status: 'done' },
    ]);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM library_files WHERE valid=1').get().n, 4);

    // rescan: nothing changed → nothing re-parsed
    const s2 = await scanLibraries({ store, log: () => {} });
    assert.equal(s2.added + s2.updated + s2.removed, 0);

    // touch one file with new content → updated in place; delete another → removed
    fs.writeFileSync(path.join(booksDir, 'alpha.epub'), await epubBuffer('Alpha, Revised Edition'));
    fs.rmSync(path.join(booksDir, 'sub', 'beta.pdf'));
    const s3 = await scanLibraries({ store, log: () => {} });
    assert.equal(s3.updated, 1);
    assert.equal(s3.removed, 1);
    const after = store.db.prepare('SELECT title FROM series ORDER BY title').all().map((r) => r.title);
    assert.deepEqual(after, ['Alpha, Revised Edition', 'Saga'], 'Beta pruned with its file, Alpha updated in place');
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM issues').get().n, 3);
    store.close();
  } finally { rm(); }
});

test('scan survives an unreadable file and a core DB without libraries', async () => {
  const { p, rm } = tmpdir();
  try {
    const booksDir = path.join(p, 'books');
    fs.mkdirSync(booksDir, { recursive: true });
    fs.writeFileSync(path.join(booksDir, 'broken.epub'), 'not a zip at all');
    fs.writeFileSync(path.join(booksDir, 'ok.pdf'), await pdfBuffer('Fine'));

    const dbPath = path.join(p, 'cat.db');
    // No core schema at all — nothing to scan, no throw.
    const bare = openEbooksStore(path.join(p, 'bare.db'));
    assert.deepEqual(ebookLibraries(bare.db), [], 'no libraries table → nothing to scan, no throw');
    bare.close();

    const core = openDb(dbPath);
    core.prepare("INSERT INTO libraries (name, type, root_folder, sort_order) VALUES ('Books', 'ebook', ?, 0)").run(booksDir);
    core.close();
    const store = openEbooksStore(dbPath);
    const logs = [];
    const s = await scanLibraries({ store, log: (m) => logs.push(m) });
    assert.equal(s.added, 1, 'the good file lands');
    assert.equal(s.error, null, 'the broken file is skipped, not fatal');
    assert.ok(logs.some((m) => m.includes('broken.epub')), 'the skip is logged');
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM series').get().n, 1);
    store.close();
  } finally { rm(); }
});
