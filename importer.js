// Import-tool handler: ebook files sitting OUTSIDE the ebook libraries (a
// downloads folder, a comic root) surface in the same Import review list as
// comic folders. Scan identifies each loose .epub/.pdf from its embedded
// metadata plus a best-effort metadata-service match; a confirmed candidate is
// FILED into the first Books library (Author/Series/Title.ext or
// Author/Title.ext) and cataloged like any scanned book.
//
// Candidate key = the file's absolute path (unique + stable, and what the
// review card shows as the location). Files under an ebook library's own
// folders are never candidates — the shelf scanner already owns those.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ebookLibraries, allLibraryFolders, walkEbooks, formatOf, extractMeta } from './scanner.js';
import { matchBookAcross } from './metadata.js';

// Windows-safe path segment: strip reserved characters, keep it readable.
export const sanitizeSegment = (s) => String(s || '').replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ')
  .replace(/\s+/g, ' ').replace(/[. ]+$/, '').trim() || 'Unknown';

const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const year4 = (s) => (String(s || '').match(/^(\d{4})/) || [])[1] || null;

/** Where a book files to: <library root>/<Author>[/<Series>]/<Title>.<ext>. */
export function destinationFor(lib, meta, merged, srcPath) {
  const authors = (merged?.authors?.length ? merged.authors : meta.authors) || [];
  const title = (merged?.title && meta.title_source !== 'embedded' ? merged.title : meta.title) || path.basename(srcPath);
  const parts = [sanitizeSegment(authors[0] || 'Unknown Author')];
  if (meta.series) parts.push(sanitizeSegment(meta.series));
  return path.join(lib.folders[0], ...parts, sanitizeSegment(title) + path.extname(srcPath).toLowerCase());
}

// Move across devices too (rename first, copy+unlink on EXDEV).
async function moveFile(src, dest) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  try { await fsp.rename(src, dest); }
  catch (e) {
    if (e?.code !== 'EXDEV') throw e;
    await fsp.copyFile(src, dest);
    await fsp.unlink(src);
  }
}

/** Read + identify one file: embedded metadata, then a best-effort service
 *  match (never fatal — an unmatched book still imports fine). */
async function identify(getClients, filePath) {
  const meta = await extractMeta(await fsp.readFile(filePath), filePath);
  let merged = null;
  try {
    const clients = typeof getClients === 'function' ? await getClients() : [getClients];
    for (const c of clients) { if (c && !c.available()) await c.ensureKey?.(); }
    merged = await matchBookAcross(clients, {
      title: meta.title, title_source: meta.title_source, authors: meta.authors,
      isbn: meta.isbn, description: meta.description, language: meta.language,
    });
  } catch { /* service trouble — identify from the file alone */ }
  return { meta, merged };
}

/** The registerImportHandler implementation. `store` is the plugin store,
 *  `getClients` an async () → ordered metadata clients (preferred first). */
export function makeImportHandler({ store, getClients }) {
  return {
    id: 'ebooks',
    label: 'Books',

    // Propose candidates: every ebook file under the scan roots that is not
    // inside an ebook library, not already cataloged, and not carrying review
    // state core wants kept (skip set).
    async scan({ roots = [], skip, log = () => {} } = {}) {
      const libs = ebookLibraries(store.db);
      if (!libs.length || !libs[0].folders.length) return []; // no Books library → nowhere to file
      const target = libs[0];
      // Exclude EVERY library's folders, not just Books: files inside a Books
      // library belong to the ebook scanner, and a .pdf inside a comic/manga
      // library is a comic, not a stray book candidate.
      const managed = allLibraryFolders(store.db).map(norm);
      const underManaged = (p) => { const n = norm(p); return managed.some((m) => n === m || n.startsWith(m + '/')); };
      const out = [];
      const seen = new Set();
      for (const root of [...new Set(roots.map(String))]) {
        for (const file of await walkEbooks(root)) {
          if (seen.has(file) || underManaged(file) || skip?.has(file) || store.known(file)) continue;
          seen.add(file);
          try {
            const { meta, merged } = await identify(getClients, file);
            out.push({
              key: file,
              name: (merged?.title && meta.title_source !== 'embedded' ? merged.title : meta.title) || path.basename(file),
              year: year4(merged?.published_date),
              publisher: ((merged?.authors?.length ? merged.authors : meta.authors) || []).join(', ') || null,
              fileCount: 1,
              matchName: merged ? (merged.title || meta.title) : null,
              matchYear: year4(merged?.published_date),
              matchImage: merged?.thumbnail || null,
              confidence: merged ? (merged.match_confidence === 'isbn' ? 'high' : 'medium') : 'none',
              seriesType: 'ebook',
              libraryId: target.id,
            });
          } catch (e) { log(`ebooks import: skipped unreadable file ${file}: ${e?.message || e}`); }
        }
      }
      if (out.length) log(`ebooks import: found ${out.length} book file(s) to review`);
      return out;
    },

    // File a confirmed candidate into its Books library and catalog it.
    async import(candidate, { log = () => {} } = {}) {
      const src = candidate.folder; // handler candidates key by file path
      if (!fs.existsSync(src)) throw new Error(`file is gone: ${src}`);
      const libs = ebookLibraries(store.db);
      const lib = libs.find((l) => l.id === candidate.library_id) || libs[0];
      if (!lib || !lib.folders.length) throw new Error('no Books library to file into');
      const { meta, merged } = await identify(getClients, src);
      let dest = destinationFor(lib, meta, merged, src);
      // Collision with a DIFFERENT file → a numbered sibling; same path = already filed.
      if (norm(dest) !== norm(src)) {
        for (let n = 2; fs.existsSync(dest); n++) {
          const ext = path.extname(dest);
          dest = path.join(path.dirname(dest), path.basename(destinationFor(lib, meta, merged, src), ext) + ` (${n})` + ext);
        }
        await moveFile(src, dest);
      }
      const st = await fsp.stat(dest);
      const { issueId } = store.catalogFile({
        libraryId: lib.id, path: dest, format: formatOf(dest),
        size: st.size, mtime: Math.round(st.mtimeMs), meta,
      });
      if (merged) store.applyMatch(issueId, merged);
      else store.setMatchChecked(issueId);
      log(`ebooks import: filed "${meta.title}" into ${lib.name}`);
      return { issueId };
    },
  };
}
