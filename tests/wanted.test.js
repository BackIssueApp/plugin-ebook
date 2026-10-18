// Search now on the Wanted page: a wanted book that already reached the shelf
// is cleared, one no source has stays wanted with the attempt recorded, and an
// unknown id is a 404.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('wanted retry: clears a book already on the shelf, records a miss, 404s an unknown id', async () => {
  process.env.PLUGINS_DIR = 'nonexistent-' + Date.now(); // keep other plugins out
  process.env.METADATA_BASE_OVERRIDE = 'http://127.0.0.1:9/api';
  const { openDb } = await import('../../../src/db.js');
  const { pluginApi, registeredRoutes } = await import('../../../src/plugins.js');
  const config = (await import('../../../src/config.js')).default;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ebooks-wanted-'));
  config.dbPath = path.join(dir, 'cat.db');
  config.metadataInstanceKey = '';
  const db = openDb(config.dbPath);
  const lib = Number(db.prepare("INSERT INTO libraries (name, type, root_folder, sort_order) VALUES ('Books', 'ebook', ?, 0)").run(dir).lastInsertRowid);
  (await import('../index.js')).default(pluginApi);
  const { openEbooksStore } = await import('../store.js');
  const store = openEbooksStore(config.dbPath);

  // One book already on the shelf (matched to catalog id M-1), one nobody has.
  const sid = Number(db.prepare("INSERT INTO series (title, url, type, library_id) VALUES ('Dune', 'local:dune', 'ebook', ?)").run(lib).lastInsertRowid);
  const iid = Number(db.prepare("INSERT INTO issues (series_id, title, url) VALUES (?, 'Dune', 'local:i:dune')").run(sid).lastInsertRowid);
  db.prepare("INSERT INTO ebooks_files (library_id, format, issue_id, match_id) VALUES (?, 'epub', ?, 'M-1')").run(lib, iid);
  const arrived = store.addWanted({ id: 'M-1', title: 'Dune', author: 'Frank Herbert' });
  const missing = store.addWanted({ id: 'M-2', title: 'A Book Nobody Has', author: 'Nobody' });

  const retry = registeredRoutes().find((r) => r.method === 'post' && r.path === '/api/ebooks/wanted/:id/retry').handler;
  const call = (id) => new Promise((resolve) => {
    const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { resolve({ code: this.code, body: b }); } };
    retry({ params: { id: String(id) }, body: {}, app: { locals: {} } }, res);
  });

  const a = await call(arrived.id);
  assert.equal(a.body.status, 'on-shelf');
  assert.equal(store.wantedById(arrived.id), null, 'already on the shelf: no longer wanted');

  const m = await call(missing.id);
  assert.notEqual(m.body.status, 'imported');
  const row = store.wantedById(missing.id);
  assert.ok(row, 'still wanted');
  assert.ok(row.tried_at, 'the attempt is recorded');

  assert.equal((await call(99999)).code, 404);
});
