// The integrated flow through the real core server: a scan catalogs books into
// the normal collection (visible via /api/collection like any series), the
// issue-keyed routes serve files/covers/progress under the ebooks.use
// permission, and curation (scan, re-match) stays library.manage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { epubBuffer } from './fixtures.js';

function tmpdir() {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'ebooks-routes-'));
  return { p, rm: () => fs.rmSync(p, { recursive: true, force: true }) };
}

test('routes: books ride the normal collection; viewer reads + own progress; curation is manage-only', async () => {
  process.env.PLUGINS_DIR = 'nonexistent-' + Date.now(); // keep other plugins out
  const { openDb } = await import('../../../src/db.js');
  const { createApp } = await import('../../../src/server.js');
  const { pluginApi, registeredRoutes } = await import('../../../src/plugins.js');
  const config = (await import('../../../src/config.js')).default;

  const { p: dir, rm } = tmpdir();
  const oldDbPath = config.dbPath;
  const oldKey = config.metadataInstanceKey;
  try {
    config.dbPath = path.join(dir, 'cat.db');
    // The dev machine's live settings may carry a real instance key — blank it
    // so the post-scan matching pass never leaves this test. And since the
    // client now self-PROVISIONS a missing key (ensureKey), point the service
    // base at a dead local port too: provisioning must fail fast and offline,
    // never register real throwaway keys from a test run.
    config.metadataInstanceKey = '';
    process.env.METADATA_BASE_OVERRIDE = 'http://127.0.0.1:9/api';
    const db = openDb(config.dbPath);

    // A Books library with one real EPUB (embedded cover included).
    const booksDir = path.join(dir, 'books');
    fs.mkdirSync(booksDir);
    fs.writeFileSync(path.join(booksDir, 'route-test.epub'),
      await epubBuffer('Route Test Book', { author: 'Rita Writer', cover: Buffer.from('JPEGBYTES') }));
    db.prepare("INSERT INTO libraries (name, type, root_folder, sort_order) VALUES ('Books', 'ebook', ?, 0)").run(booksDir);

    // Register the plugin (it opens its store on config.dbPath) and boot core.
    const registerEbooks = (await import('../index.js')).default;
    registerEbooks(pluginApi);
    const app = createApp({
      db, state: { queue: {} },
      getSettings: () => ({}), saveSettings: (b) => b,
      prepareRedownload: async () => {}, runDownloads: async () => {},
      pluginRoutes: registeredRoutes(),
    });
    const s = await new Promise((res) => { const x = app.listen(0, () => res(x)); });
    const base = `http://localhost:${s.address().port}`;
    const cookieOf = (r) => (r.headers.get('set-cookie') || '').split(';')[0];
    try {
      // accounts: first register = admin; a plain viewer beside it
      const reg = await fetch(`${base}/api/auth/register`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'adminpass1' }),
      });
      const A = { cookie: cookieOf(reg), 'content-type': 'application/json' };
      await fetch(`${base}/api/users`, {
        method: 'POST', headers: A,
        body: JSON.stringify({ username: 'casual', password: 'viewerpass1', role: 'viewer' }),
      });
      const login = await fetch(`${base}/api/auth/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'casual', password: 'viewerpass1' }),
      });
      const V = { cookie: cookieOf(login), 'content-type': 'application/json' };

      // unauthenticated: nothing
      assert.equal((await fetch(`${base}/api/ebooks/state`)).status, 401);

      // viewer can't scan; admin can, and the scan finds the fixture
      assert.equal((await fetch(`${base}/api/ebooks/scan`, { method: 'POST', headers: V, body: '{}' })).status, 403);
      assert.equal((await fetch(`${base}/api/ebooks/scan`, { method: 'POST', headers: A, body: '{}' })).status, 200);
      for (let i = 0; i < 100; i++) {
        const st = await (await fetch(`${base}/api/ebooks/scan/status`, { headers: V })).json();
        if (!st.running && st.finishedAt) break;
        await new Promise((r) => setTimeout(r, 50));
      }

      // The book is a NORMAL collection row — the same Library grid data as
      // comics, self-described (matched, source 'local', author as byline). Uses
      // the paginated shape the web grid uses: the bare no-params array is the
      // legacy mobile path, which deliberately omits self-described types.
      const coll = await (await fetch(`${base}/api/collection?limit=500&counts=1`, { headers: V })).json();
      const rows = coll.rows || coll;
      const book = rows.find((r) => r.type === 'ebook');
      assert.ok(book, 'book series in the collection');
      assert.equal(book.title, 'Route Test Book');
      assert.equal(book.publisher, 'Rita Writer');
      assert.equal(book.matched, true);
      assert.equal(book.source, 'local');
      assert.deepEqual([book.total, book.owned], [1, 1]);

      // …and its series page lists the book as an issue with its file.
      const det = await (await fetch(`${base}/api/collection/${book.id}`, { headers: V })).json();
      assert.equal(det.source, 'local');
      assert.equal(det.issues.length, 1);
      const issue = det.issues[0];
      assert.equal(issue.owned, true);
      assert.equal(issue.downloadable, false);
      assert.equal(issue.cv_issue_id, null);
      assert.match(issue.files[0].name, /route-test\.epub$/);

      // file streams inline; ?dl=1 is an attachment; cover serves the embedded art
      const f = await fetch(`${base}/api/ebooks/issue/${issue.id}/file`, { headers: V });
      assert.equal(f.status, 200);
      assert.equal(f.headers.get('content-type'), 'application/epub+zip');
      assert.match(f.headers.get('content-disposition'), /^inline/);
      const d = await fetch(`${base}/api/ebooks/issue/${issue.id}/file?dl=1`, { headers: V });
      assert.match(d.headers.get('content-disposition'), /^attachment/);
      const c = await fetch(`${base}/api/ebooks/issue/${issue.id}/cover`, { headers: V });
      assert.equal(c.status, 200);
      assert.equal(await c.text(), 'JPEGBYTES');

      // progress: per-user, echoed by /progress and the /state icon map
      const post = await fetch(`${base}/api/ebooks/issue/${issue.id}/progress`, {
        method: 'POST', headers: V, body: JSON.stringify({ locator: 'epubcfi(/6/4!/4/2)', fraction: 0.42 }),
      });
      assert.equal(post.status, 200);
      const progV = await (await fetch(`${base}/api/ebooks/issue/${issue.id}/progress`, { headers: V })).json();
      assert.equal(progV.progress.fraction, 0.42);
      assert.equal(progV.progress.locator, 'epubcfi(/6/4!/4/2)');
      const stV = await (await fetch(`${base}/api/ebooks/state`, { headers: V })).json();
      assert.equal(stV.states[issue.id].fraction, 0.42);
      const stA = await (await fetch(`${base}/api/ebooks/state`, { headers: A })).json();
      assert.equal(stA.states[issue.id], undefined, 'admin has their own (empty) progress');

      // fraction-only writes (the sheet's Mark finished/unread): locator null
      // must be accepted and clear the saved position.
      const markPost = await fetch(`${base}/api/ebooks/issue/${issue.id}/progress`, {
        method: 'POST', headers: V, body: JSON.stringify({ locator: null, fraction: 1 }),
      });
      assert.equal(markPost.status, 200);
      const marked = await (await fetch(`${base}/api/ebooks/issue/${issue.id}/progress`, { headers: V })).json();
      assert.equal(marked.progress.fraction, 1);
      assert.equal(marked.progress.locator, null);

      // details: the sheet's grid fields (plugin-private columns) ride a
      // viewer-accessible route keyed by issue id
      const info = await (await fetch(`${base}/api/ebooks/issue/${issue.id}/details`, { headers: V })).json();
      assert.equal(info.details.format, 'epub');
      assert.ok(Number.isFinite(info.details.size) && info.details.size > 0, 'file size rides along');
      assert.ok(info.details.added, 'added timestamp rides along');
      assert.equal((await fetch(`${base}/api/ebooks/issue/999999/details`, { headers: V })).status, 404);

      // re-match is curation-only; without a provisioned instance key it's 503
      assert.equal((await fetch(`${base}/api/ebooks/issue/${issue.id}/rematch`, { method: 'POST', headers: V, body: '{}' })).status, 403);
      assert.equal((await fetch(`${base}/api/ebooks/issue/${issue.id}/rematch`, { method: 'POST', headers: A, body: '{}' })).status, 503);

      // unknown issue
      assert.equal((await fetch(`${base}/api/ebooks/issue/999999/file`, { headers: V })).status, 404);
    } finally { s.close(); }
  } finally {
    config.dbPath = oldDbPath;
    config.metadataInstanceKey = oldKey;
    delete process.env.METADATA_BASE_OVERRIDE;
    try { rm(); } catch { /* Windows file locks — temp dir reaped by OS */ }
  }
});
