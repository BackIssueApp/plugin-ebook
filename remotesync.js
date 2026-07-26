// Remote-catalog sync + cache-on-read for the ebooks plugin.
//
// A registered remote book source (src/plugins.js registerRemoteBookSource)
// exposes an entire remote catalog as file-less metadata: `listPage` paginates
// it, `materialize` downloads one book on demand. This module does two things:
//
//   • SYNC — walk a source's pages and catalog every book as a file-less entry
//     (store.catalogRemote). Metadata + covers only, no downloads: fast, and
//     resumable/cancellable from a per-source page cursor, one run at a time,
//     mirroring the Book Warehouse backfill runner's state-singleton shape.
//
//   • CACHE-ON-READ — the first time a reader opens a remote entry, download it
//     into the library folder (source.materialize), record where it landed
//     (store.materializedPath), and thereafter serve it from disk. A small
//     in-flight map coalesces concurrent opens of the same book so two readers
//     never trigger two downloads.
//
// No source-specific knowledge lives here — everything is driven through the
// generic hook, so the ebooks plugin stays free of Book Warehouse (or any other
// source's) settings. Sources read their own config; callers pass null.
import fs from 'node:fs';
import { ebookLibraries } from './scanner.js';

// ---- Live run state (module singleton; one sync at a time) ------------------
export const remoteSyncState = {
  running: false,
  sourceId: null,   // the requested source id, or null for "every registered source"
  libraryId: null,
  page: 0,
  total: 0,         // entries the source reports across the whole catalog
  created: 0,       // NEW entries this run
  updated: 0,       // existing entries refreshed this run
  done: 0,          // entries processed this run (created + updated)
  current: null,    // { remote_id, title } in flight
  startedAt: null,
  finishedAt: null,
  stoppedAt: null,
  error: null,
};
let stopFlag = false;

export function remoteSyncStatus() { return { ...remoteSyncState }; }
export function isRemoteSyncRunning() { return remoteSyncState.running; }
export function stopRemoteSync() {
  if (remoteSyncState.running) { stopFlag = true; remoteSyncState.stoppedAt = new Date().toISOString(); }
  return { ...remoteSyncState };
}

// Metadata-only sync of registered remote sources into a Books library. `sources`
// is the registered list (registeredRemoteBookSources()); `sourceId` narrows it
// to one, else every source is synced. `maxBooks` (0 = all) hard-caps NEW entries
// created THIS run — a test/preview knob. Resumes each source from its saved page
// cursor and advances it only when a page is fully consumed, so a stop/cap mid-
// page redoes that page next run (catalogRemote is idempotent, so that is safe).
export async function runRemoteSync({
  store,
  sources = [],
  sourceId = null,
  libraryId = null,
  maxBooks = 0,
  resetCursor = false,
  onProgress = null,
  shouldStop = null,
} = {}) {
  if (remoteSyncState.running) throw new Error('A remote sync is already running.');
  const libs = ebookLibraries(store.db);
  if (!libs.length) throw new Error('Create a Books library first — there is no ebook library to sync into.');
  // NOTE: on-demand entries can swamp a shelf of owned books, so it is worth
  // pointing a sync at its OWN dedicated Books library (libraryId) — but that is
  // the operator's choice; the requested library (or the first) is honored.
  const lib = (libraryId != null && libs.find((l) => l.id === Number(libraryId))) || libs[0];
  const chosen = sourceId ? sources.filter((s) => s.id === sourceId) : [...sources];
  if (!chosen.length) {
    throw new Error(sourceId ? `No remote book source "${sourceId}" is registered.` : 'No remote book source is registered.');
  }
  const cap = Math.max(0, Number(maxBooks) || 0);

  stopFlag = false;
  Object.assign(remoteSyncState, {
    running: true, sourceId: sourceId || null, libraryId: lib.id, page: 0, total: 0,
    created: 0, updated: 0, done: 0, current: null,
    startedAt: new Date().toISOString(), finishedAt: null, stoppedAt: null, error: null,
  });
  const stopRequested = () => stopFlag || (typeof shouldStop === 'function' && shouldStop());
  const emit = () => { if (typeof onProgress === 'function') onProgress(remoteSyncStatus()); };

  let claimed = 0; // NEW entries created this run (counts against `cap`)
  try {
    for (const src of chosen) {
      if (stopRequested()) break;
      let page = resetCursor ? 1 : Math.max(1, Number(store.remoteCursor(src.id)) || 1);
      let totalPages = Infinity;
      while (page <= totalPages && !stopRequested()) {
        remoteSyncState.page = page;
        const res = await src.listPage(null, page); // the source reads its own config
        const books = Array.isArray(res?.books) ? res.books : [];
        if (res?.total) remoteSyncState.total = res.total;
        if (res?.totalPages) totalPages = res.totalPages;
        if (!books.length) break; // ran off the end

        let interrupted = false;
        for (const b of books) {
          if (stopRequested()) { interrupted = true; break; }
          if (!b || b.remote_id == null) continue;
          // Claim a slot against the cap BEFORE cataloging, counting only new
          // entries — a re-sync that only updates existing rows is uncapped.
          const wasNew = !store.db.prepare('SELECT 1 x FROM ebooks_files WHERE source=? AND remote_id=?')
            .get(src.id, String(b.remote_id));
          if (wasNew && cap > 0 && claimed >= cap) { interrupted = true; break; }
          remoteSyncState.current = { remote_id: b.remote_id, title: b.title || String(b.remote_id) };
          try {
            const { created } = store.catalogRemote({ libraryId: lib.id, source: src.id, remoteId: b.remote_id, meta: b });
            if (created) { remoteSyncState.created++; claimed++; } else remoteSyncState.updated++;
            remoteSyncState.done++;
          } catch (e) {
            remoteSyncState.error = String(e?.message || e); // one bad entry never aborts the run
          }
          emit();
        }
        // Advance the cursor only on a fully-consumed page (same rule as the
        // backfill runner): a mid-page stop/cap leaves it so the next run redoes
        // the page and the idempotent catalog absorbs the overlap.
        if (!interrupted) { store.setRemoteCursor(src.id, page + 1, remoteSyncState.total); page += 1; }
        else break;
      }
    }
    if (stopRequested() && !remoteSyncState.stoppedAt) remoteSyncState.stoppedAt = new Date().toISOString();
    return remoteSyncStatus();
  } finally {
    // Record the stop time for any cancel — the stopFlag path already set it,
    // but a shouldStop() callback (tests, external cancel) needs it stamped too.
    if (stopRequested() && !remoteSyncState.stoppedAt) remoteSyncState.stoppedAt = new Date().toISOString();
    remoteSyncState.running = false;
    remoteSyncState.finishedAt = new Date().toISOString();
    remoteSyncState.current = null;
    emit();
  }
}

// ---- Cache-on-read ----------------------------------------------------------
// One in-flight materialization per issue id, so simultaneous opens of the same
// remote book share a single download instead of racing two into the folder.
const inflight = new Map();

// Download a file-less remote entry on demand and record where it landed.
// `sources` is the registered list; the entry's `source`/`remoteId` pick the one
// to call. Concurrent calls for the same issueId await the same promise. Resolves
// to { path } for the route to serve; rejects (source gone / download failed) so
// the caller can 502 and leave the row remote for a later retry.
export function materializeOnRead({ store, sources = [], issueId, source, remoteId, libraryId, dbPath }) {
  const key = Number(issueId);
  if (inflight.has(key)) return inflight.get(key);
  const job = (async () => {
    const src = sources.find((s) => s.id === source);
    if (!src) throw new Error(`the "${source}" book source is not available`);
    const result = await src.materialize(null, remoteId, { libraryId, dbPath });
    const p = result?.path;
    if (!p) throw new Error('the book source returned no file');
    let size = null; let mtime = null;
    try { const st = fs.statSync(p); size = st.size; mtime = Math.round(st.mtimeMs); } catch { /* stat best-effort */ }
    store.materializedPath(key, p, size, mtime);
    return { path: p, size, mtime };
  })();
  inflight.set(key, job);
  // Clear the slot whether it resolved or rejected — a failed download must be
  // retryable on the next open, not stuck behind a dead promise.
  return job.finally(() => { inflight.delete(key); });
}

// Test/diagnostic peek at how many materializations are in flight.
export function inflightCount() { return inflight.size; }
