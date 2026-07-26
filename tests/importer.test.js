// Import handler: loose ebook files outside the Books library become Import
// candidates (identified via embedded metadata + a mocked metadata service),
// and a confirmed candidate is FILED into the library (Author/Series/Title.ext)
// and cataloged as core series/issue rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../../src/db.js';
import { openEbooksStore } from '../store.js';
import { makeImportHandler, destinationFor, sanitizeSegment } from '../importer.js';
import { makeBooksClient } from '../metadata.js';
import { epubBuffer, pdfBuffer } from './fixtures.js';

const RESULT = {
  id: 'gb-1', title: 'Dune', authors: ['Frank Herbert'],
  description: 'A very long description of the desert planet.',
  publisher: 'Ace Books', published_date: '1965-08-01',
  isbn_10: '0441172717', isbn_13: '9780441172719',
  page_count: 412, categories: [], language: 'en',
  thumbnail: 'https://books.example/dune.jpg',
};

function mockFetch(handler) {
  return async (url) => ({ ok: true, json: async () => handler(String(url)) });
}

async function setup() {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'ebooks-import-'));
  const shelf = path.join(p, 'shelf');
  const loose = path.join(p, 'downloads');
  fs.mkdirSync(shelf, { recursive: true });
  fs.mkdirSync(loose, { recursive: true });
  const dbPath = path.join(p, 'cat.db');
  const core = openDb(dbPath);
  core.prepare("INSERT INTO libraries (name, type, root_folder, sort_order) VALUES ('Books', 'ebook', ?, 0)").run(shelf);
  core.close();
  const store = openEbooksStore(dbPath);
  const books = makeBooksClient({ metadataInstanceKey: 'k' }, {
    fetchImpl: mockFetch((url) => (url.includes('9780441172719') ? { results: [RESULT] } : { results: [] })),
  });
  const rm = () => { store.close(); try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* reaped later */ } };
  return { p, shelf, loose, store, books, rm };
}

test('scan: loose files become candidates; library files, known files, and skip keys do not', async () => {
  const { p, shelf, loose, store, books, rm } = await setup();
  try {
    const dunePath = path.join(loose, 'dune-1965.epub');
    fs.writeFileSync(dunePath, await epubBuffer('Dune', { author: 'Frank Herbert', isbn: '9780441172719' }));
    fs.writeFileSync(path.join(loose, 'mystery.pdf'), await pdfBuffer('Mystery Novel'));
    fs.writeFileSync(path.join(shelf, 'already.epub'), await epubBuffer('Already Shelved'));
    fs.writeFileSync(path.join(loose, 'known.epub'), await epubBuffer('Known'));
    store.catalogFile({
      libraryId: 1, path: path.join(loose, 'known.epub'), format: 'epub', size: 1, mtime: 1,
      meta: { title: 'Known', title_source: 'embedded', authors: [], series: null, series_index: null, isbn: null, description: null, language: null, cover: null, cover_type: null },
    });

    const handler = makeImportHandler({ store, getClients: async () => [books] });
    const cands = await handler.scan({ roots: [p], skip: new Set() });
    const keys = cands.map((c) => c.key).sort();
    assert.deepEqual(keys, [dunePath, path.join(loose, 'mystery.pdf')].sort(),
      'library-managed and already-cataloged files are not candidates');

    const dune = cands.find((c) => c.key === dunePath);
    assert.equal(dune.confidence, 'high', 'ISBN match');
    assert.equal(dune.matchName, 'Dune');
    assert.equal(dune.matchImage, 'https://books.example/dune.jpg');
    assert.equal(dune.publisher, 'Frank Herbert');
    assert.equal(dune.seriesType, 'ebook');
    assert.equal(dune.libraryId, 1);
    const mystery = cands.find((c) => c.key !== dunePath);
    assert.equal(mystery.confidence, 'none', 'no service hit → review, imports with the file\'s own info');

    // skip = keys whose review state core keeps — not re-proposed.
    const again = await handler.scan({ roots: [p], skip: new Set([dunePath]) });
    assert.deepEqual(again.map((c) => c.key), [path.join(loose, 'mystery.pdf')]);
  } finally { rm(); }
});

test('import: files the book into Author/[Series/]Title.ext and catalogs it', async () => {
  const { p, shelf, loose, store, books, rm } = await setup();
  try {
    const src = path.join(loose, 'dune-1965.epub');
    fs.writeFileSync(src, await epubBuffer('Dune', { author: 'Frank Herbert', isbn: '9780441172719' }));
    const handler = makeImportHandler({ store, getClients: async () => [books] });
    await handler.import({ folder: src, library_id: 1 });

    const dest = path.join(shelf, 'Frank Herbert', 'Dune.epub');
    assert.ok(fs.existsSync(dest), 'moved into the library under Author/Title');
    assert.ok(!fs.existsSync(src), 'source is gone');
    const s = store.db.prepare("SELECT * FROM series WHERE type='ebook'").get();
    assert.equal(s.title, 'Dune');
    assert.equal(s.publisher, 'Frank Herbert');
    assert.equal(s.year, '1965', 'match applied on import');
    const i = store.db.prepare('SELECT * FROM issues WHERE series_id=?').get(s.id);
    assert.equal(i.file_path, dest);
    assert.equal(store.fileByIssue(i.id).match_id, 'gb-1');

    // A series book files under Author/Series/; a dest collision numbers itself.
    const src2 = path.join(loose, 'saga1.epub');
    fs.writeFileSync(src2, await epubBuffer('Saga One', { author: 'Someone', series: 'Saga', index: 1 }));
    await handler.import({ folder: src2, library_id: 1 });
    assert.ok(fs.existsSync(path.join(shelf, 'Someone', 'Saga', 'Saga One.epub')));
    const src3 = path.join(loose, 'saga1-copy.epub');
    fs.writeFileSync(src3, await epubBuffer('Saga One', { author: 'Someone', series: 'Saga', index: 1 }));
    await handler.import({ folder: src3, library_id: 1 });
    assert.ok(fs.existsSync(path.join(shelf, 'Someone', 'Saga', 'Saga One (2).epub')), 'collision gets a numbered sibling');

    // A vanished source is a clean failure.
    await assert.rejects(() => handler.import({ folder: path.join(loose, 'gone.epub') }), /gone/);
  } finally { rm(); }
});

test('destinationFor + sanitizeSegment: reserved characters and match upgrades', async () => {
  const lib = { folders: ['/shelf'] };
  assert.equal(sanitizeSegment('What: A "Story"?'), 'What A Story');
  assert.equal(sanitizeSegment('...'), 'Unknown');
  const meta = { title: 'raw file name', title_source: 'filename', authors: [], series: null };
  const merged = { title: 'Real Title', authors: ['A. Uthor'] };
  assert.equal(
    destinationFor(lib, meta, merged, '/tmp/x.epub').split(path.sep).slice(-2).join('/'),
    'A. Uthor/Real Title.epub',
    'match upgrades both author folder and filename when the file had none');
});
