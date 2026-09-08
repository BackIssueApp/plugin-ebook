// The duplicate-twin lookups must be index probes: on a 159k-title remote
// catalog the old title join scanned the whole table per lookup (minutes of
// blocked main thread each); the audiobooks twin of this bug took a server down.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, SERIES_TYPES, SELF_DESCRIBED_TYPES } from '../../../src/db.js';
import { openEbooksStore } from '../store.js';

if (!SERIES_TYPES.includes('ebook')) SERIES_TYPES.push('ebook');
SELF_DESCRIBED_TYPES.add('ebook');

function boot() {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-twins-'));
  const dbPath = path.join(p, 'cat.db');
  const core = openDb(dbPath);
  core.prepare("INSERT INTO libraries (name, type, root_folder, sort_order) VALUES ('Books', 'ebook', ?, 0)").run(path.join(p, 'shelf'));
  core.close();
  return openEbooksStore(dbPath);
}
const meta = (remote_id, title) => ({
  remote_id, title, author: 'Author', series: null, series_index: null, isbn: null, publisher: null,
  year: null, language: 'en', description: null, coverUrl: null,
});
const plan = (db, sql, ...args) => db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...args).map((r) => r.detail).join(' | ');

test('same-titled remote entries are found through the title index, not a table scan', () => {
  const store = boot();
  const a = store.catalogRemote({ libraryId: 1, source: 'fake', remoteId: 'r1', meta: meta('r1', 'Dune') });
  const b = store.catalogRemote({ libraryId: 1, source: 'fake', remoteId: 'r2', meta: meta('r2', '  dune ') });
  store.catalogRemote({ libraryId: 1, source: 'fake', remoteId: 'r3', meta: meta('r3', 'Other') });
  store.catalogRemote({ libraryId: 1, source: 'other', remoteId: 'r4', meta: meta('r4', 'Dune') });

  assert.deepEqual(store.duplicateRemoteEntries('fake', 'r1'), [{ issue_id: b.issueId, remote_id: 'r2' }]);
  assert.deepEqual(store.duplicateRemoteEntries('fake', 'r3'), []);
  assert.deepEqual(store.unavailableWithTwin('fake'), []);
  store.markUnavailable(a.issueId, 'gone');
  assert.deepEqual(store.unavailableWithTwin('fake'),
    [{ issue_id: a.issueId, remote_id: 'r1', twin_issue_id: b.issueId, twin_remote_id: 'r2' }]);

  store.catalogRemote({ libraryId: 1, source: 'fake', remoteId: 'r2', meta: meta('r2', 'Dune Messiah') });
  assert.deepEqual(store.duplicateRemoteEntries('fake', 'r1'), []);

  // Rows from before the column existed are keyed on first use.
  store.catalogRemote({ libraryId: 1, source: 'fake', remoteId: 'r2', meta: meta('r2', 'DUNE') });
  store.db.prepare('UPDATE ebooks_files SET title_key = NULL').run();
  assert.deepEqual(store.duplicateRemoteEntries('fake', 'r1'), [{ issue_id: b.issueId, remote_id: 'r2' }]);

  const dup = plan(store.db, `SELECT f2.issue_id FROM ebooks_files f1
    CROSS JOIN ebooks_files f2 ON f2.source = f1.source AND f2.library_id = f1.library_id
      AND f2.title_key = f1.title_key AND f2.issue_id <> f1.issue_id AND +f2.path IS NULL
    WHERE f1.source = ? AND f1.remote_id = ? AND f1.title_key IS NOT NULL`, 'fake', 'r1');
  assert.match(dup, /f1 USING INDEX idx_ebooks_files_remote/);
  assert.match(dup, /f2 USING INDEX idx_ebooks_files_twin/);
  assert.doesNotMatch(dup, /SCAN/);
  const sweep = plan(store.db, `SELECT f1.issue_id FROM ebooks_files f1
    CROSS JOIN ebooks_files f2 ON f2.source = f1.source AND f2.library_id = f1.library_id
      AND f2.title_key = f1.title_key AND f2.issue_id <> f1.issue_id AND +f2.path IS NULL AND +f2.unavailable_at IS NULL
    WHERE f1.source = ? AND +f1.path IS NULL AND f1.unavailable_at IS NOT NULL AND f1.title_key IS NOT NULL`, 'fake');
  assert.match(sweep, /f1 USING INDEX idx_ebooks_files_unavailable/);
  assert.match(sweep, /f2 USING INDEX idx_ebooks_files_twin/);
  assert.doesNotMatch(sweep, /SCAN/);
  store.close();
});
