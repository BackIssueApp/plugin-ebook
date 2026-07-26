// Ebook library scanner: walk every 'ebook'-type library's folders, parse
// embedded metadata out of new/changed files, and catalog each book as a core
// series/issue (via the store) — pruning catalog rows whose file is gone, the
// same way comic scans prune. Incremental: a file whose path+mtime+size
// already matches its row (and whose catalog rows are still intact) is
// skipped without opening it, so rescans of a big shelf are cheap.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { libraryFolders } from '../../src/db.js';
import { extractEpubMeta, extractPdfMeta } from './extract.js';

// Formats scanned. The reading engine can grow MOBI/AZW3 later (its vendored
// upstream supports them) — extend this whitelist when it does.
export const EBOOK_EXTS = ['.epub', '.pdf'];

export const formatOf = (p) => (path.extname(p).toLowerCase() === '.epub' ? 'epub' : 'pdf');
export const extractMeta = (buf, p) => (formatOf(p) === 'epub' ? extractEpubMeta(buf, p) : extractPdfMeta(buf, p));

/** The 'ebook'-type libraries from the core catalog, with their scan folders.
 *  (root_folder is one folder per line — libraryFolders is core's splitter.) */
export function ebookLibraries(db) {
  try {
    return db.prepare("SELECT id, name, root_folder FROM libraries WHERE type = 'ebook' ORDER BY sort_order, id")
      .all()
      .map((l) => ({ id: l.id, name: l.name, folders: libraryFolders(l.root_folder) }));
  } catch {
    return []; // core predates explicit libraries — nothing to scan
  }
}

/** Every library's folders regardless of type — the importer must not claim
 *  files that live inside ANY library (a comic library's PDFs are comics). */
export function allLibraryFolders(db) {
  try {
    return db.prepare('SELECT root_folder FROM libraries').all().flatMap((l) => libraryFolders(l.root_folder));
  } catch {
    return [];
  }
}

/** Recursively list ebook files under a folder (absolute paths). Dot-entries
 *  and unreadable subtrees are skipped, never fatal. */
export async function walkEbooks(folder) {
  const out = [];
  let entries = [];
  try { entries = await fsp.readdir(folder, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(folder, e.name);
    if (e.isDirectory()) out.push(...await walkEbooks(full));
    else if (EBOOK_EXTS.includes(path.extname(e.name).toLowerCase())) out.push(full);
  }
  return out;
}

// Shared scan state for the status endpoint (one scan at a time).
export const scanState = {
  running: false, done: 0, total: 0, added: 0, updated: 0, removed: 0,
  startedAt: null, finishedAt: null, error: null,
};

/** Full incremental scan of every ebook library. Returns the tallies. */
export async function scanLibraries({ store, log = console.log }) {
  if (scanState.running) return scanState;
  Object.assign(scanState, {
    running: true, done: 0, total: 0, added: 0, updated: 0, removed: 0,
    startedAt: new Date().toISOString(), finishedAt: null, error: null,
  });
  try {
    const libs = ebookLibraries(store.db);
    // Gather first so done/total is meaningful to the UI.
    const work = [];
    for (const lib of libs) {
      const files = (await Promise.all(lib.folders.map(walkEbooks))).flat();
      work.push({ lib, files });
      scanState.total += files.length;
    }
    for (const { lib, files } of work) {
      const known = store.pathIndex(lib.id);
      const seen = new Set();
      for (const file of files) {
        seen.add(file);
        try {
          const st = fs.statSync(file);
          const mtime = Math.round(st.mtimeMs);
          const prev = known.get(file);
          // Unchanged AND still cataloged → skip without opening the file. A
          // removed/untracked book (rows gone, file still here) re-catalogs.
          if (prev && prev.mtime === mtime && prev.size === st.size && store.issueIntact(prev)) {
            scanState.done++;
            continue;
          }
          const buf = await fsp.readFile(file);
          const meta = await extractMeta(buf, file);
          store.catalogFile({ libraryId: lib.id, path: file, format: formatOf(file), size: st.size, mtime, meta });
          if (prev) scanState.updated++; else scanState.added++;
        } catch (e) {
          log(`ebooks: skipped unreadable file ${file}: ${e?.message || e}`);
        }
        scanState.done++;
      }
      scanState.removed += store.removeMissing(lib.id, seen);
    }
    if (scanState.added || scanState.updated || scanState.removed) {
      log(`ebooks: scan finished — ${scanState.added} added, ${scanState.updated} updated, ${scanState.removed} removed`);
    }
  } catch (e) {
    scanState.error = String(e?.message || e);
    log(`ebooks: scan failed: ${scanState.error}`);
  } finally {
    scanState.running = false;
    scanState.finishedAt = new Date().toISOString();
  }
  return scanState;
}
