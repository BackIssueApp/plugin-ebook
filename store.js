// Ebook catalog plumbing. Books are REAL catalog rows: every scanned file
// becomes a core `issues` row on a core `series` row (a calibre series groups
// its books as issues ordered by series_index; a standalone book is a
// single-issue series named after itself), linked through `library_files`
// exactly like comic files — so the Library grid, series pages, stats, and
// permissions all ride core with no parallel UI.
//
// This module keeps only what core has no home for: the path↔issue mapping
// with format + embedded cover blob + metadata-service match state
// (ebooks_files), and the per-user EPUB reading position (ebooks_progress,
// keyed by core issue id). Same catalog.db file, own connection — and core's
// exported library_files helpers are reused rather than re-implemented.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { upsertLibraryFile, linkLibraryFile, deleteLibraryFile, getLibraryFile } from '../../src/db.js';

// URL keys for the catalog rows this plugin owns (the NOT NULL/UNIQUE url
// columns): series are keyed by library + calibre series (or title~author for
// standalones) so rescans land on the same row; issues are keyed by file path.
const slug = (s) => String(s || '').toLowerCase().normalize('NFKD')
  .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '') || 'untitled';
export const seriesUrlFor = (libraryId, meta) => (meta.series
  ? `ebook:l${libraryId}:s:${slug(meta.series)}`
  : `ebook:l${libraryId}:b:${slug(meta.title)}~${slug((meta.authors || [])[0] || '')}`);
/** A title reduced to what identifies the book: lower-case, bracketed notes
 *  dropped, cut at a subtitle (": A Novel", " - Book One"), punctuation
 *  collapsed — "Theo of Golden: A Novel (English Edition)" → "theo of golden". */
export function titleKey(t) {
  return String(t || '').toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .split(/\s*[:–—]\s*|\s+-\s+/)[0]
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

const issueUrlFor = (p) => 'ebookfile:' + p;

// series_index → issue number string ('1', '2.5'); standalone books are '1'.
const indexNumber = (n) => (Number.isFinite(n) ? String(n) : '1');
const year4 = (s) => (String(s || '').match(/^(\d{4})/) || [])[1] || null;

export function openEbooksStore(dbPath) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL'); // per-connection; match the main handle
  // The v1 (never released) model kept books in plugin-private ebooks_books
  // rows with progress keyed on those ids — superseded by catalog rows. Drop
  // the old tables outright; the next scan rebuilds everything in place.
  db.exec('DROP TABLE IF EXISTS ebooks_books; DROP TABLE IF EXISTS ebooks_meta;');
  const oldProgress = db.prepare("SELECT 1 x FROM pragma_table_info('ebooks_progress') WHERE name='book_id'").get();
  if (oldProgress) db.exec('DROP TABLE ebooks_progress');
  db.exec(`
    CREATE TABLE IF NOT EXISTS ebooks_files (
      path             TEXT PRIMARY KEY,        -- NULL for a remote entry until it is materialized (SQLite keeps NULL PKs distinct)
      library_id       INTEGER NOT NULL,
      series_id        INTEGER,                 -- core series row
      issue_id         INTEGER,                 -- core issue row (route key)
      format           TEXT NOT NULL,           -- 'epub' | 'pdf'
      size             INTEGER,
      mtime            INTEGER,                 -- ms, rounded — with size, the rescan skip key
      title_source     TEXT,                    -- 'embedded' | 'filename' (drives match merging)
      isbn             TEXT,
      language         TEXT,
      cover            BLOB,                    -- embedded cover bytes (EPUB), or null
      cover_type       TEXT,
      thumbnail        TEXT,                    -- metadata-service cover URL fallback / remote cover URL
      match_id         TEXT,
      match_confidence TEXT,                    -- 'isbn' | 'title'
      match_checked_at TEXT,                    -- last attempt (hit or miss) — misses aren't retried every scan
      source           TEXT,                    -- NULL = a normal local file; else the registered remote source id
      remote_id        TEXT,                    -- the id in that remote source's catalog (with source, the sync identity)
      added_at         TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ebooks_files_library ON ebooks_files (library_id);
    CREATE INDEX IF NOT EXISTS idx_ebooks_files_issue ON ebooks_files (issue_id);
    -- NB: the (source, remote_id) index is created AFTER the ALTERs below, not
    -- here — on a pre-remote DB those columns don't exist until the migration.
    -- Per-user EPUB position: locator is the foliate CFI (opaque here),
    -- fraction the 0..1 whole-book progress. Keyed by CORE issue id.
    CREATE TABLE IF NOT EXISTS ebooks_progress (
      user_id    INTEGER NOT NULL DEFAULT 0,
      issue_id   INTEGER NOT NULL,
      locator    TEXT,
      fraction   REAL NOT NULL DEFAULT 0,
      updated_at TEXT,
      PRIMARY KEY (user_id, issue_id)
    );
    -- Resumable cursor for the remote-catalog sync: one row per remote source,
    -- the next list page to fetch (the sync re-catalogs idempotently, so a redo
    -- of a partly-done page is harmless).
    CREATE TABLE IF NOT EXISTS ebooks_remote_sync (
      source      TEXT PRIMARY KEY,
      cursor_page INTEGER NOT NULL DEFAULT 1,
      total       INTEGER,
      updated_at  TEXT
    );
    -- Per-user bookmarks. An ebook position is a foliate CFI locator (opaque to
    -- the server, exactly like reading progress); the fraction rides along so the
    -- list can be ordered and shown as a percentage without parsing the CFI.
    CREATE TABLE IF NOT EXISTS ebooks_bookmarks (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL DEFAULT 0,
      issue_id   INTEGER NOT NULL,
      locator    TEXT NOT NULL,
      fraction   REAL NOT NULL DEFAULT 0,
      note       TEXT,
      created_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ebbookmarks ON ebooks_bookmarks (user_id, issue_id);
    -- Per-user visibility of each ebook home rail (both default on).
    CREATE TABLE IF NOT EXISTS ebooks_home_prefs (
      user_id       INTEGER PRIMARY KEY,
      show_continue INTEGER NOT NULL DEFAULT 1,
      show_new      INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS ebooks_wanted (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id   TEXT NOT NULL UNIQUE,   -- the catalog's id for the book
      title      TEXT NOT NULL,
      author     TEXT,
      year       TEXT,
      isbn       TEXT,
      cover      TEXT,
      added_by   INTEGER NOT NULL DEFAULT 0,
      added_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      tried_at   TEXT,
      last_error TEXT
    );
  `);
  // Migrate a pre-remote ebooks_files table in place — the CREATE above only
  // shapes fresh DBs, so add the file-less-entry columns to existing ones.
  const efCols = db.prepare("SELECT name FROM pragma_table_info('ebooks_files')").all().map((r) => r.name);
  if (!efCols.includes('source')) db.exec('ALTER TABLE ebooks_files ADD COLUMN source TEXT');
  if (!efCols.includes('remote_id')) db.exec('ALTER TABLE ebooks_files ADD COLUMN remote_id TEXT');
  // Series learned from a metadata match (Hardcover enrichment) rather than
  // from the file's own calibre metadata. Persisted so a rescan — which sees
  // no embedded series — regroups the book the same way instead of scattering
  // it back into standalones.
  if (!efCols.includes('match_series')) db.exec('ALTER TABLE ebooks_files ADD COLUMN match_series TEXT');
  if (!efCols.includes('match_series_index')) db.exec('ALTER TABLE ebooks_files ADD COLUMN match_series_index REAL');
  // A remote book the source could not serve (its file is gone): when, and
  // what it said. Cleared the moment a download succeeds again.
  if (!efCols.includes('unavailable_at')) db.exec('ALTER TABLE ebooks_files ADD COLUMN unavailable_at TEXT');
  if (!efCols.includes('unavailable_reason')) db.exec('ALTER TABLE ebooks_files ADD COLUMN unavailable_reason TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_ebooks_files_remote ON ebooks_files (source, remote_id)');
  // lower(trim(issue title)) — see the twin indexes below.
  if (!efCols.includes('title_key')) db.exec('ALTER TABLE ebooks_files ADD COLUMN title_key TEXT');
  // A bookmark grew into an annotation: a highlight carries the passage it
  // marks and a colour, a plain bookmark carries neither. Both are optional so
  // every existing row, and every client that only knows bookmarks, still fits.
  const ebCols = db.prepare("SELECT name FROM pragma_table_info('ebooks_bookmarks')").all().map((r) => r.name);
  if (!ebCols.includes('color')) db.exec('ALTER TABLE ebooks_bookmarks ADD COLUMN color TEXT');
  if (!ebCols.includes('text')) db.exec('ALTER TABLE ebooks_bookmarks ADD COLUMN text TEXT');
  // The book's outline (page count + chapter start pages), derived from the
  // file once and kept here so the detail screens can show "page 142 of 312"
  // and a chapter list without opening the book.
  if (!efCols.includes('outline_json')) db.exec('ALTER TABLE ebooks_files ADD COLUMN outline_json TEXT');
  // Where a position is in human terms — the chapter name and the page in the
  // outline's units — so a resume card can say more than a percentage.
  const epCols = db.prepare("SELECT name FROM pragma_table_info('ebooks_progress')").all().map((r) => r.name);
  if (!epCols.includes('chapter')) db.exec('ALTER TABLE ebooks_progress ADD COLUMN chapter TEXT');
  if (!epCols.includes('page')) db.exec('ALTER TABLE ebooks_progress ADD COLUMN page INTEGER');
  if (!epCols.includes('pages')) db.exec('ALTER TABLE ebooks_progress ADD COLUMN pages INTEGER');
  // The duplicate-twin lookups (remotesync) match remote entries by title.
  // Comparing issue titles across a join was a whole-table scan per lookup:
  // on a 159k-title remote catalog one lookup took minutes of blocked main
  // thread, and a sync that found a few new books took the server down. The
  // normalised title now lives on the row (filled lazily for rows from before
  // this column existed), under an index the lookups probe instead.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_ebooks_files_twin ON ebooks_files (source, library_id, title_key);
    CREATE INDEX IF NOT EXISTS idx_ebooks_files_unavailable ON ebooks_files (source, unavailable_at);
  `);
  // "Already on the shelf?" runs for every result of a catalog search. It was
  // three scans per result (match id, a normalised ISBN, an issue-title LIKE),
  // about a second per search on a big shelf. Each now probes an index: the
  // ISBN one is on the very expression the lookup compares, and the title one
  // on title_key — which local books now carry too (remote rows always did;
  // the twin lookups only ever compare rows of one source, so local keys
  // never meet them). The first time through, local rows get theirs.
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_ebooks_files_titlekey'").get()) {
    try {
      db.prepare(`UPDATE ebooks_files
        SET title_key = (SELECT lower(trim(i.title)) FROM issues i WHERE i.id = ebooks_files.issue_id)
        WHERE title_key IS NULL AND issue_id IS NOT NULL`).run();
    } catch { /* no core issues table yet — so no rows to fill */ }
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_ebooks_files_titlekey ON ebooks_files (title_key);
    CREATE INDEX IF NOT EXISTS idx_ebooks_files_match ON ebooks_files (match_id);
    CREATE INDEX IF NOT EXISTS idx_ebooks_files_isbn ON ebooks_files (replace(replace(isbn,'-',''),' ',''));
    -- Newest-first book lists (OPDS Recently added) walk this instead of sorting.
    CREATE INDEX IF NOT EXISTS idx_ebooks_files_added ON ebooks_files (added_at, issue_id);
  `);
  /** Fill title_key for a source's rows that predate the column (or lost it). */
  const ensureTitleKeys = (source) => {
    db.prepare(`UPDATE ebooks_files
      SET title_key = (SELECT lower(trim(i.title)) FROM issues i WHERE i.id = ebooks_files.issue_id)
      WHERE source = ? AND title_key IS NULL`).run(source);
  };

  const seriesByUrl = (url) => db.prepare('SELECT * FROM series WHERE url=?').get(url);
  const isStandalone = (seriesRow) => /^ebook:l\d+:b:/.test(String(seriesRow?.url || ''));
  const authorsOf = (seriesRow) => String(seriesRow?.publisher || '').split(',').map((a) => a.trim()).filter(Boolean);

  /** File row + its catalog identity, for the routes. Every column but the
   *  embedded cover bytes and the outline JSON, which have their own getters —
   *  this runs on each progress save and bookmark. */
  const FILE_COLS = db.prepare("SELECT name FROM pragma_table_info('ebooks_files')").all()
    .map((r) => r.name).filter((c) => c !== 'cover' && c !== 'outline_json')
    .map((c) => `ef.${c}`).join(', ');
  function fileByIssue(issueId) {
    return db.prepare(`SELECT ${FILE_COLS}, i.title, i.series_id AS core_series_id
      FROM ebooks_files ef JOIN issues i ON i.id = ef.issue_id WHERE ef.issue_id = ?`).get(Number(issueId)) || null;
  }

  /** The book shape the metadata matcher works on (title/authors/isbn/…). */
  function bookShape(row) {
    if (!row) return null;
    const s = db.prepare('SELECT * FROM series WHERE id=?').get(row.core_series_id ?? row.series_id);
    return {
      id: row.issue_id, path: row.path,
      title: row.title ?? db.prepare('SELECT title FROM issues WHERE id=?').get(row.issue_id)?.title,
      title_source: row.title_source,
      authors: authorsOf(s), isbn: row.isbn,
      description: isStandalone(s) ? (s?.description || null) : null,
      language: row.language,
      // The series this book already belongs to (null when it stands alone) —
      // a match must never override a grouping the file itself declared.
      series: isStandalone(s) ? null : (s?.title || null),
    };
  }

  // A file on disk that belongs to an issue: the shared file index row plus
  // its link to the shelf, the same way catalogFile records a scanned book.
  function ownFile(issueId, p, size, mtime) {
    const iss = db.prepare('SELECT series_id FROM issues WHERE id=?').get(issueId);
    if (!iss) return;
    let st = { size: size ?? null, mtime: mtime ?? null };
    if (st.size == null || st.mtime == null) {
      try { const f = fs.statSync(p); st = { size: f.size, mtime: Math.round(f.mtimeMs) }; } catch { /* keep what we were told */ }
    }
    upsertLibraryFile(db, {
      path: p, dir: path.dirname(p), name: path.basename(p), size: st.size, mtime: st.mtime,
      page_count: null, has_metadata: 1, valid: 1, error: null, verified: 0,
    });
    linkLibraryFile(db, p, iss.series_id, issueId);
  }

  const store = {
    /** Catalog one scanned file: series + issue + library_files + plugin row,
     *  in one transaction. Returns { seriesId, issueId }.
     *
     *  Identity is STICKY per path: a file already cataloged keeps its series
     *  row (a title change — embedded edit or a match upgrade — renames the
     *  row instead of spawning a duplicate). Only a real regroup (the calibre
     *  series meta appearing/changing/disappearing) moves the book, and a
     *  series left empty by the move is pruned. */
    catalogFile({ libraryId, path: p, format, size, mtime, meta }) {
      const authors = (meta.authors || []).filter(Boolean);
      const byline = authors.join(', ') || null;
      // A series the file itself declares always wins. Failing that, reuse the
      // series a previous match assigned — otherwise every rescan would undo
      // the grouping (the EPUB still has no series of its own).
      if (!meta.series) {
        const learned = db.prepare('SELECT match_series, match_series_index FROM ebooks_files WHERE path=?').get(p);
        if (learned?.match_series) {
          meta = { ...meta, series: learned.match_series, series_index: learned.match_series_index ?? undefined };
        }
      }
      const standalone = !meta.series;
      const url = seriesUrlFor(libraryId, meta);
      const tx = db.transaction(() => {
        const prev = db.prepare(`SELECT ef.issue_id, ef.match_id, i.series_id AS prev_series_id, i.title AS prev_title
          FROM ebooks_files ef LEFT JOIN issues i ON i.id = ef.issue_id WHERE ef.path=?`).get(p);
        const prevSeries = prev?.prev_series_id
          ? db.prepare('SELECT * FROM series WHERE id=?').get(prev.prev_series_id) : null;
        // A match-upgraded title must survive a re-parse that still has no
        // embedded title of its own (the filename is strictly worse data).
        const keepTitle = !!(prev?.match_id && meta.title_source === 'filename' && prev.prev_title);
        const issueTitle = keepTitle ? prev.prev_title : meta.title;
        // The series row is the display metadata for the Library grid: title,
        // byline (publisher slot = authors), description (standalone books).
        // COALESCE(excluded, current): a re-parse refreshes embedded fields but
        // never blanks match-filled ones.
        let seriesId;
        if (prevSeries && standalone && isStandalone(prevSeries) && String(prevSeries.url).startsWith(`ebook:l${libraryId}:`)) {
          // Sticky standalone identity — rename in place, never a duplicate row.
          db.prepare(`UPDATE series SET title=?, publisher=COALESCE(?, publisher), type='ebook',
              library_id=?, description=COALESCE(?, description) WHERE id=?`)
            .run(issueTitle, byline, libraryId, meta.description || null, prevSeries.id);
          seriesId = prevSeries.id;
        } else {
          db.prepare(`INSERT INTO series (title, url, publisher, type, library_id, description)
            VALUES (@title, @url, @publisher, 'ebook', @lib, @description)
            ON CONFLICT(url) DO UPDATE SET
              title=excluded.title,
              publisher=COALESCE(excluded.publisher, series.publisher),
              type='ebook', library_id=excluded.library_id,
              description=COALESCE(excluded.description, series.description)`)
            .run({
              title: standalone ? issueTitle : meta.series, url,
              publisher: byline, lib: libraryId,
              description: standalone ? (meta.description || null) : null,
            });
          seriesId = seriesByUrl(url).id;
        }
        db.prepare(`INSERT INTO issues (series_id, title, issue_number, url, status, file_path)
          VALUES (?, ?, ?, ?, 'done', ?)
          ON CONFLICT(url) DO UPDATE SET series_id=excluded.series_id, title=excluded.title,
            issue_number=excluded.issue_number, status='done', file_path=excluded.file_path`)
          .run(seriesId, issueTitle, standalone ? '1' : indexNumber(meta.series_index), issueUrlFor(p), p);
        const issueId = db.prepare('SELECT id FROM issues WHERE url=?').get(issueUrlFor(p)).id;
        // A regroup left the old series behind — prune it if now empty.
        if (prevSeries && prevSeries.id !== seriesId) {
          const left = db.prepare('SELECT COUNT(*) n FROM issues WHERE series_id=?').get(prevSeries.id).n;
          if (!left) db.prepare("DELETE FROM series WHERE id=? AND url LIKE 'ebook:%'").run(prevSeries.id);
        }
        // The shared file index — what makes the series a collection member and
        // powers owned/size/health rollups. has_metadata=1: ComicInfo tagging
        // doesn't apply to books, so they must never look "untagged".
        upsertLibraryFile(db, {
          path: p, dir: path.dirname(p), name: path.basename(p), size, mtime,
          page_count: null, has_metadata: 1, valid: 1, error: null, verified: 0,
        });
        linkLibraryFile(db, p, seriesId, issueId);
        // title_key follows the title for local rows; a materialized remote
        // row keeps the source's title (its twin lookups compare that).
        db.prepare(`INSERT INTO ebooks_files
            (path, library_id, series_id, issue_id, format, size, mtime, title_source, isbn, language, cover, cover_type, added_at, title_key)
          VALUES (@path, @lib, @sid, @iid, @format, @size, @mtime, @title_source, @isbn, @language, @cover, @cover_type, strftime('%Y-%m-%dT%H:%M:%SZ','now'), lower(trim(@title)))
          ON CONFLICT(path) DO UPDATE SET
            library_id=excluded.library_id, series_id=excluded.series_id, issue_id=excluded.issue_id,
            format=excluded.format, size=excluded.size, mtime=excluded.mtime,
            title_source=excluded.title_source, isbn=COALESCE(excluded.isbn, ebooks_files.isbn),
            language=COALESCE(excluded.language, ebooks_files.language),
            cover=excluded.cover, cover_type=excluded.cover_type,
            title_key=CASE WHEN ebooks_files.source IS NULL THEN excluded.title_key ELSE ebooks_files.title_key END`)
          .run({
            path: p, lib: libraryId, sid: seriesId, iid: issueId, format, size, mtime, title: issueTitle,
            title_source: meta.title_source || null, isbn: meta.isbn || null, language: meta.language || null,
            cover: meta.cover || null, cover_type: meta.cover_type || null,
          });
        // Series cover: the first book with art names the grid cover — the
        // plugin's cover route (embedded blob, else match thumbnail).
        if (meta.cover && !seriesByUrl(url).cover_url) {
          db.prepare('UPDATE series SET cover_url=? WHERE id=?').run(`/api/ebooks/issue/${issueId}/cover`, seriesId);
        }
        return { seriesId, issueId };
      });
      return tx();
    },

    /** Catalog ONE file-less remote book: the same core series + issue rows as
     *  catalogFile (calibre series → one series with issues; standalone → a
     *  single-issue series named after the book), but the ebooks_files row
     *  carries no path (NULL until materialized), size, or embedded cover — a
     *  remote source IS the metadata, so title/isbn/language/thumbnail come
     *  straight from `meta` with no separate match pass, and the cover rides
     *  meta.coverUrl through the plugin's cover route. NO library_files row is
     *  written (there is no file yet). Idempotent by (source, remote_id): the
     *  issue is keyed by an ebookremote: url and the plugin row by
     *  (source, remote_id), so a re-sync updates in place and never duplicates —
     *  and never clobbers a path/size a later materialize wrote. Returns
     *  { seriesId, issueId, created }. */
    catalogRemote({ libraryId, source, remoteId, meta = {} }) {
      const authors = (meta.author ? [meta.author] : (meta.authors || [])).filter(Boolean);
      const byline = authors.join(', ') || null;
      const standalone = !meta.series;
      const title = meta.title || 'Untitled';
      const url = seriesUrlFor(libraryId, { series: meta.series, title, authors });
      const issueUrl = `ebookremote:${source}:${remoteId}`;
      const format = String(meta.format || 'epub').toLowerCase();
      const year = year4(meta.year);
      // A source may flag an entry as restricted (mature) — e.g. Book Warehouse's
      // erotica filter. Authoritative for source-managed rows: applied on insert
      // AND re-affirmed on re-sync (so a policy/rule change re-applies). null when
      // the source doesn't classify, so it never clobbers an existing value.
      const restricted = meta.restricted == null ? null : (meta.restricted ? 1 : 0);
      const tx = db.transaction(() => {
        // Identity is sticky per (source, remote_id): find any prior entry so a
        // re-sync renames in place and a regroup prunes the vacated series.
        const prev = db.prepare(`SELECT ef.rowid AS ef_rowid, ef.issue_id, i.series_id AS prev_series_id
          FROM ebooks_files ef LEFT JOIN issues i ON i.id = ef.issue_id
          WHERE ef.source=? AND ef.remote_id=?`).get(source, remoteId);
        const created = !prev;
        const prevSeries = prev?.prev_series_id
          ? db.prepare('SELECT * FROM series WHERE id=?').get(prev.prev_series_id) : null;
        let seriesId;
        if (prevSeries && standalone && isStandalone(prevSeries) && String(prevSeries.url).startsWith(`ebook:l${libraryId}:`)) {
          db.prepare(`UPDATE series SET title=?, publisher=COALESCE(?, publisher), type='ebook',
              library_id=?, description=COALESCE(?, description), year=COALESCE(?, year),
              restricted=COALESCE(?, restricted) WHERE id=?`)
            .run(title, byline, libraryId, meta.description || null, year, restricted, prevSeries.id);
          seriesId = prevSeries.id;
        } else {
          db.prepare(`INSERT INTO series (title, url, publisher, type, library_id, description, year, restricted)
            VALUES (@title, @url, @publisher, 'ebook', @lib, @description, @year, COALESCE(@restricted, 0))
            ON CONFLICT(url) DO UPDATE SET
              title=excluded.title,
              publisher=COALESCE(excluded.publisher, series.publisher),
              type='ebook', library_id=excluded.library_id,
              description=COALESCE(excluded.description, series.description),
              year=COALESCE(excluded.year, series.year),
              restricted=COALESCE(@restricted, series.restricted)`)
            .run({
              title: standalone ? title : meta.series, url,
              publisher: byline, lib: libraryId,
              description: standalone ? (meta.description || null) : null,
              year: standalone ? year : null,
              restricted,
            });
          seriesId = seriesByUrl(url).id;
        }
        // A file-less issue: no file_path (NULL) — it fills in on materialize.
        db.prepare(`INSERT INTO issues (series_id, title, issue_number, url, status, file_path)
          VALUES (?, ?, ?, ?, 'done', NULL)
          ON CONFLICT(url) DO UPDATE SET series_id=excluded.series_id, title=excluded.title,
            issue_number=excluded.issue_number, status='done'`)
          .run(seriesId, title, standalone ? '1' : indexNumber(meta.series_index), issueUrl);
        const issueId = db.prepare('SELECT id FROM issues WHERE url=?').get(issueUrl).id;
        if (prevSeries && prevSeries.id !== seriesId) {
          const left = db.prepare('SELECT COUNT(*) n FROM issues WHERE series_id=?').get(prevSeries.id).n;
          if (!left) db.prepare("DELETE FROM series WHERE id=? AND url LIKE 'ebook:%'").run(prevSeries.id);
        }
        // The plugin row — keyed by (source, remote_id). A re-sync updates only
        // the metadata; path/size/mtime/cover (a materialize may have set them)
        // are left untouched so a cached download survives a re-sync.
        if (prev) {
          db.prepare(`UPDATE ebooks_files SET library_id=?, series_id=?, issue_id=?, format=?,
              title_source='embedded', isbn=?, language=?, thumbnail=?, title_key=lower(trim(?)) WHERE rowid=?`)
            .run(libraryId, seriesId, issueId, format, meta.isbn || null, meta.language || null, meta.coverUrl || null, title, prev.ef_rowid);
        } else {
          db.prepare(`INSERT INTO ebooks_files
              (path, library_id, series_id, issue_id, format, size, mtime, title_source, isbn, language, thumbnail, source, remote_id, added_at, title_key)
            VALUES (NULL, @lib, @sid, @iid, @format, NULL, NULL, 'embedded', @isbn, @language, @thumbnail, @source, @remote_id, strftime('%Y-%m-%dT%H:%M:%SZ','now'), lower(trim(@title)))`)
            .run({
              lib: libraryId, sid: seriesId, iid: issueId, format, title,
              isbn: meta.isbn || null, language: meta.language || null,
              thumbnail: meta.coverUrl || null, source, remote_id: String(remoteId),
            });
        }
        // Series cover: the remote cover URL names the grid cover (via the
        // plugin's cover route → 302 to the proxy), same as an embedded blob.
        const scover = db.prepare('SELECT cover_url FROM series WHERE id=?').get(seriesId)?.cover_url;
        if (meta.coverUrl && !scover) {
          db.prepare('UPDATE series SET cover_url=? WHERE id=?').run(`/api/ebooks/issue/${issueId}/cover`, seriesId);
        }
        return { seriesId, issueId, created };
      });
      return tx();
    },

    /** After a remote entry's file is downloaded on read, record where it
     *  landed. source/remote_id stay set (we still know its origin), so a later
     *  re-sync won't duplicate it and the disk scanner treats it as intact.
     *  The book is on the server now, so it is owned like any other: the
     *  issue gets its file path and the file index a row — without that the
     *  shelf keeps counting it as "available on demand". */
    materializedPath(issueId, p, size, mtime) {
      const iid = Number(issueId);
      db.transaction(() => {
        db.prepare('UPDATE ebooks_files SET path=?, size=?, mtime=? WHERE issue_id=?').run(p, size ?? null, mtime ?? null, iid);
        db.prepare('UPDATE issues SET file_path=? WHERE id=?').run(p, iid);
        ownFile(iid, p, size, mtime);
      })();
    },

    /** Resumable remote-sync cursor: the next list page to fetch for a source. */
    remoteCursor(source) {
      const r = db.prepare('SELECT cursor_page FROM ebooks_remote_sync WHERE source=?').get(source);
      return r ? r.cursor_page : 1;
    },
    setRemoteCursor(source, page, total) {
      db.prepare(`INSERT INTO ebooks_remote_sync (source, cursor_page, total, updated_at)
        VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
        ON CONFLICT(source) DO UPDATE SET cursor_page=excluded.cursor_page,
          total=COALESCE(excluded.total, ebooks_remote_sync.total), updated_at=excluded.updated_at`)
        .run(source, page, total ?? null);
    },

    /** path → { path, mtime, size, issue_id, source } for one library — the
     *  incremental-scan skip index. Remote entries not yet materialized have
     *  path=NULL; they key to `null` here and never collide with a real path. */
    pathIndex(libraryId) {
      const rows = db.prepare('SELECT path, mtime, size, issue_id, source FROM ebooks_files WHERE library_id=?').all(libraryId);
      return new Map(rows.map((r) => [r.path, r]));
    },
    known(p) {
      return db.prepare('SELECT path, mtime, size, issue_id, source FROM ebooks_files WHERE path=?').get(p);
    },
    /** Are this file's catalog rows still in place? (Something may have
     *  untracked the series since — then the file must be re-cataloged even
     *  though its bytes are unchanged.) A materialized remote entry owns no
     *  library_files row (it was cataloged file-less, then cached), so it is
     *  "intact" as long as its issue survives — this keeps the disk scanner
     *  from re-cataloging a cached remote file as a fresh local duplicate. */
    issueIntact(row) {
      if (!row?.issue_id) return false;
      if (!db.prepare('SELECT 1 x FROM issues WHERE id=?').get(row.issue_id)) return false;
      if (row.source) return true;
      return !!getLibraryFile(db, row.path);
    },

    /** Prune a library's rows whose file vanished: library_files + issue +
     *  progress + plugin row go together, and a series with no issues left is
     *  removed like any dead catalog row. keep = Set of live paths. */
    removeMissing(libraryId, keep) {
      // Remote entries (source set) aren't disk files — the disk scanner never
      // "sees" them, so they must never be pruned as missing (a NULL path would
      // otherwise fail every keep check and delete the whole file-less catalog).
      const gone = db.prepare('SELECT path, issue_id, series_id, source FROM ebooks_files WHERE library_id=?').all(libraryId)
        .filter((r) => !r.source && !keep.has(r.path));
      const seriesTouched = new Set();
      const tx = db.transaction(() => {
        for (const r of gone) {
          deleteLibraryFile(db, r.path);
          if (r.issue_id != null) {
            db.prepare('DELETE FROM ebooks_progress WHERE issue_id=?').run(r.issue_id);
            db.prepare('DELETE FROM issues WHERE id=?').run(r.issue_id);
          }
          db.prepare('DELETE FROM ebooks_files WHERE path=?').run(r.path);
          if (r.series_id != null) seriesTouched.add(r.series_id);
        }
        for (const sid of seriesTouched) {
          const left = db.prepare('SELECT COUNT(*) n FROM issues WHERE series_id=?').get(sid).n;
          if (!left) db.prepare("DELETE FROM series WHERE id=? AND url LIKE 'ebook:%'").run(sid);
        }
      });
      tx();
      return gone.length;
    },

    fileByIssue,
    /** Cover for an issue: embedded blob, else the match thumbnail URL. */
    cover(issueId) {
      const r = db.prepare('SELECT cover, cover_type, thumbnail FROM ebooks_files WHERE issue_id=?').get(Number(issueId));
      if (!r) return null;
      if (r.cover) return { cover: r.cover, cover_type: r.cover_type || 'image/jpeg' };
      return r.thumbnail ? { thumbnail: r.thumbnail } : null;
    },

    progress(userId, issueId) {
      return db.prepare('SELECT locator, fraction, updated_at, chapter, page, pages FROM ebooks_progress WHERE user_id=? AND issue_id=?')
        .get(userId, issueId) || { locator: null, fraction: 0, updated_at: null, chapter: null, page: null, pages: null };
    },
    // chapter/page/pages are optional: a client that only knows the locator
    // still saves, and a client that knows more makes the resume card richer.
    saveProgress(userId, issueId, { locator, fraction, chapter, page, pages }) {
      const int = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : null);
      db.prepare(`INSERT INTO ebooks_progress (user_id, issue_id, locator, fraction, updated_at, chapter, page, pages)
        VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'), ?, ?, ?)
        ON CONFLICT(user_id, issue_id) DO UPDATE SET
          locator = excluded.locator, fraction = excluded.fraction, updated_at = excluded.updated_at,
          chapter = excluded.chapter, page = excluded.page, pages = excluded.pages`)
        .run(userId, issueId, locator == null ? null : String(locator),
          Math.min(1, Math.max(0, Number(fraction) || 0)),
          chapter ? String(chapter).slice(0, 200) : null, int(page), int(pages));
    },
    /** The cached outline for a book, or null when it hasn't been derived yet. */
    outline(issueId) {
      const r = db.prepare('SELECT outline_json FROM ebooks_files WHERE issue_id=?').get(Number(issueId));
      if (!r?.outline_json) return null;
      try { return JSON.parse(r.outline_json); } catch { return null; }
    },
    saveOutline(issueId, outline) {
      db.prepare('UPDATE ebooks_files SET outline_json=? WHERE issue_id=?').run(JSON.stringify(outline), Number(issueId));
    },
    // ---- bookmarks (per user, per book) ----
    listBookmarks(userId, issueId) {
      return db.prepare(`SELECT id, locator, fraction, note, color, text, created_at
        FROM ebooks_bookmarks WHERE user_id=? AND issue_id=? ORDER BY fraction, id`)
        .all(userId || 0, Number(issueId));
    },
    addBookmark(userId, issueId, { locator, fraction, note, color, text } = {}) {
      const loc = String(locator || '').trim();
      if (!loc) throw new Error('a bookmark needs a position');
      // The colour is a short client token (e.g. "yellow"), not a hex the
      // server would have to keep in step with two apps' palettes.
      const info = db.prepare(`INSERT INTO ebooks_bookmarks (user_id, issue_id, locator, fraction, note, color, text, created_at)
        VALUES (?,?,?,?,?,?,?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))`)
        .run(userId || 0, Number(issueId), loc,
          Math.min(1, Math.max(0, Number(fraction) || 0)),
          note ? String(note).slice(0, 500) : null,
          color ? String(color).trim().slice(0, 16) : null,
          text ? String(text).slice(0, 2000) : null);
      return { id: info.lastInsertRowid };
    },
    deleteBookmark(userId, id) {
      db.prepare('DELETE FROM ebooks_bookmarks WHERE id=? AND user_id=?').run(Number(id), userId || 0);
    },

    // ---- per-user reading stats ----
    // `finished` uses the same 0.98 threshold the reading shell paints with, so
    // this always agrees with the icons on the shelf. Pages are an ESTIMATE
    // (fraction x the file's page count) — an EPUB has no fixed page count, so
    // it is reported as approximate rather than pretending otherwise.
    stats(userId) {
      const r = db.prepare(`SELECT COUNT(*) started,
          SUM(CASE WHEN fraction >= 0.98 THEN 1 ELSE 0 END) finished
        FROM ebooks_progress WHERE user_id=? AND fraction > 0`).get(userId || 0);
      const pages = db.prepare(`SELECT COALESCE(SUM(p.fraction * COALESCE(lf.page_count, 0)), 0) n
        FROM ebooks_progress p
        JOIN ebooks_files ef ON ef.issue_id = p.issue_id
        JOIN library_files lf ON lf.path = ef.path
       WHERE p.user_id=? AND p.fraction > 0`).get(userId || 0);
      return { started: r.started || 0, finished: r.finished || 0, pages_estimate: Math.round(pages.n || 0) };
    },

    // ---- per-user home rail visibility (mirrors the audiobooks plugin) ----
    homePrefs(userId) {
      const r = db.prepare('SELECT * FROM ebooks_home_prefs WHERE user_id=?').get(userId || 0);
      return { showContinue: r ? !!r.show_continue : true, showNew: r ? !!r.show_new : true };
    },
    setHomePrefs(userId, partial) {
      const m = { ...this.homePrefs(userId), ...(partial || {}) };
      db.prepare(`INSERT INTO ebooks_home_prefs (user_id, show_continue, show_new) VALUES (?,?,?)
        ON CONFLICT(user_id) DO UPDATE SET
          show_continue = excluded.show_continue, show_new = excluded.show_new`)
        .run(userId || 0, m.showContinue ? 1 : 0, m.showNew ? 1 : 0);
      return this.homePrefs(userId);
    },

    /** All of one user's positions — the client paints row icons from this. */
    stateMap(userId) {
      const out = {};
      // Enough for a "reading now" card without another round trip: the
      // series the book files under, its title, and where the reader left off.
      for (const r of db.prepare(`SELECT p.issue_id, p.fraction, p.updated_at, p.chapter, p.page, p.pages,
          i.series_id, i.title
        FROM ebooks_progress p LEFT JOIN issues i ON i.id = p.issue_id WHERE p.user_id=?`).all(userId)) {
        out[r.issue_id] = {
          fraction: r.fraction, updated_at: r.updated_at,
          chapter: r.chapter, page: r.page, pages: r.pages,
          series_id: r.series_id, title: r.title,
        };
      }
      return out;
    },

    /** Per-issue book info the client uses to detect books INDEPENDENTLY of
     *  core's on-disk `files` array — so a file-less remote (on-demand) book
     *  is still recognized as readable. `remote` = catalogued from a remote
     *  source with no local file yet (opening it downloads on demand).
     *  SCOPED to the given issue ids (a series' issues) — never the whole
     *  catalog, which at on-demand scale is 100k+ rows / megabytes. */
    bookInfoMap(issueIds) {
      const out = {};
      const ids = (Array.isArray(issueIds) ? issueIds : []).map(Number).filter(Number.isFinite);
      if (!ids.length) return out;
      const q = db.prepare(`SELECT issue_id, format, path, source, unavailable_at, unavailable_reason FROM ebooks_files
        WHERE issue_id IN (${ids.map(() => '?').join(',')})`);
      for (const r of q.all(...ids)) out[r.issue_id] = { format: r.format, remote: !!r.source && !r.path, unavailable: !!r.unavailable_at, unavailableReason: r.unavailable_reason || null };
      return out;
    },
    /** The source could not serve this book (file gone upstream). */
    markUnavailable(issueId, reason = null) {
      db.prepare('UPDATE ebooks_files SET unavailable_at=?, unavailable_reason=? WHERE issue_id=?').run(new Date().toISOString(), reason ? String(reason).slice(0, 200) : null, issueId);
    },
    markAvailable(issueId) {
      db.prepare('UPDATE ebooks_files SET unavailable_at=NULL, unavailable_reason=NULL WHERE issue_id=? AND unavailable_at IS NOT NULL').run(issueId);
    },
    /** Other remote entries from the same source and library that are the
     *  same book (same title) — a re-import next to a record whose file has
     *  since gone. Matched across shelves on purpose: the old record often sat
     *  alone (no series info at the time) while the new one joined a series. */
    duplicateRemoteEntries(source, remoteId) {
      ensureTitleKeys(source);
      // CROSS JOIN pins f1 (one row, by its remote identity) as the outer
      // loop, and `+f2.path` keeps the planner off the path primary key —
      // every remote row has a NULL path, so that "unique" index is the
      // whole table. f2 is then a probe of idx_ebooks_files_twin.
      return db.prepare(`SELECT f2.issue_id, f2.remote_id
        FROM ebooks_files f1
        CROSS JOIN ebooks_files f2 ON f2.source = f1.source AND f2.library_id = f1.library_id
          AND f2.title_key = f1.title_key AND f2.issue_id <> f1.issue_id AND +f2.path IS NULL
        WHERE f1.source = ? AND f1.remote_id = ? AND f1.title_key IS NOT NULL`).all(source, String(remoteId));
    },
    /** Entries already proven unavailable that have a same-titled twin which
     *  is not — candidates for the end-of-sync sweep. */
    unavailableWithTwin(source) {
      ensureTitleKeys(source);
      return db.prepare(`SELECT DISTINCT f1.issue_id, f1.remote_id, f2.issue_id AS twin_issue_id, f2.remote_id AS twin_remote_id
        FROM ebooks_files f1
        CROSS JOIN ebooks_files f2 ON f2.source = f1.source AND f2.library_id = f1.library_id
          AND f2.title_key = f1.title_key AND f2.issue_id <> f1.issue_id AND +f2.path IS NULL AND +f2.unavailable_at IS NULL
        WHERE f1.source = ? AND +f1.path IS NULL AND f1.unavailable_at IS NOT NULL AND f1.title_key IS NOT NULL`).all(source);
    },
    /** Drop a file-less remote entry: its plugin row, its issue, and the shelf
     *  if it was the only book on it. */
    /** Drop every file-less entry a remote source put on the shelf — the
     *  source was removed, or the shelf is being reset — with their issues,
     *  the series left empty, and the source's sync cursor, so a later
     *  re-enable starts from scratch. An entry the source had already fetched
     *  to a file in the library becomes an ordinary local book (the file is
     *  the user's now); one whose file has since gone is dropped with the
     *  rest. → { entries, series, adopted } */
    removeRemoteSource(source) {
      const src = String(source || '');
      if (!src) return { entries: 0, series: 0, adopted: 0 };
      return db.transaction(() => {
        let adopted = 0;
        for (const r of db.prepare('SELECT issue_id, path, size, mtime FROM ebooks_files WHERE source=? AND path IS NOT NULL AND issue_id IS NOT NULL').all(src)) {
          if (!fs.existsSync(r.path)) { db.prepare('UPDATE ebooks_files SET path=NULL WHERE issue_id=?').run(r.issue_id); continue; }
          db.prepare('UPDATE ebooks_files SET source=NULL, remote_id=NULL, unavailable_at=NULL, unavailable_reason=NULL WHERE issue_id=?').run(r.issue_id);
          db.prepare('UPDATE issues SET url=?, file_path=? WHERE id=?').run(issueUrlFor(r.path), r.path, r.issue_id);
          ownFile(r.issue_id, r.path, r.size, r.mtime);
          adopted++;
        }
        db.exec('CREATE TEMP TABLE IF NOT EXISTS gone_issues (id INTEGER PRIMARY KEY); CREATE TEMP TABLE IF NOT EXISTS gone_series (id INTEGER PRIMARY KEY); DELETE FROM gone_issues; DELETE FROM gone_series');
        db.prepare('INSERT OR IGNORE INTO gone_issues SELECT issue_id FROM ebooks_files WHERE source=? AND path IS NULL AND issue_id IS NOT NULL').run(src);
        db.prepare("INSERT OR IGNORE INTO gone_series SELECT series_id FROM issues WHERE id IN (SELECT id FROM gone_issues) AND url LIKE 'ebookremote:%'").run();
        const entries = db.prepare('DELETE FROM ebooks_files WHERE source=? AND path IS NULL').run(src).changes;
        db.prepare("DELETE FROM issues WHERE id IN (SELECT id FROM gone_issues) AND url LIKE 'ebookremote:%'").run();
        const series = db.prepare("DELETE FROM series WHERE id IN (SELECT id FROM gone_series) AND url LIKE 'ebook:%' AND NOT EXISTS (SELECT 1 FROM issues WHERE issues.series_id = series.id)").run().changes;
        try { db.prepare('DELETE FROM ebooks_remote_sync WHERE source=?').run(src); } catch { /* no cursor kept */ }
        db.exec('DROP TABLE gone_issues; DROP TABLE gone_series');
        return { entries, series, adopted };
      })();
    },


    /** Is this catalog book on the shelf already? By its catalog id, its ISBN,
     *  or the same title with an author that does not contradict. → { issueId,
     *  seriesId } or null. */
    onShelf({ matchId = null, isbn = null, title = null, author = null } = {}) {
      const found = (issueId) => {
        const i = db.prepare('SELECT id, series_id FROM issues WHERE id=?').get(issueId);
        return i ? { issueId: i.id, seriesId: i.series_id } : null;
      };
      const cleanIsbn = String(isbn || '').replace(/[\s-]/g, '') || null;
      // Two probes rather than one OR — an OR of optional terms defeats both indexes.
      const byKey = (matchId != null && db.prepare('SELECT issue_id FROM ebooks_files WHERE match_id = ? AND issue_id IS NOT NULL LIMIT 1').get(String(matchId)))
        || (cleanIsbn && db.prepare(`SELECT issue_id FROM ebooks_files WHERE replace(replace(isbn,'-',''),' ','') = ? AND issue_id IS NOT NULL LIMIT 1`).get(cleanIsbn));
      if (byKey) { const f = found(byKey.issue_id); if (f) return f; }
      if (!title) return null;
      const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      // The same book is titled many ways — "Theo of Golden", "Theo of Golden:
      // A Novel", "Theo of Golden (English Edition)" — so titles are compared
      // by their key: the part before a subtitle, with bracketed notes dropped.
      const key = titleKey(title);
      if (!key) return null;
      // Candidates: books whose title starts with the key's first word — a
      // range on idx_ebooks_files_titlekey, walked until a real match (not
      // just the first 40 sharing a common first word, which could miss it).
      const first = key.split(' ')[0];
      const a = norm(author);
      const last = a.split(' ').pop();
      const candidates = db.prepare(`SELECT f.issue_id, i.title, s.publisher FROM ebooks_files f
          JOIN issues i ON i.id = f.issue_id JOIN series s ON s.id = i.series_id
         WHERE f.title_key >= ? AND f.title_key < ? LIMIT 5000`).iterate(first, first + String.fromCodePoint(0x10ffff));
      for (const r of candidates) {
        if (titleKey(r.title) === key
          && (!a || !r.publisher || norm(r.publisher).includes(a) || a.includes(norm(r.publisher)) || (last && norm(r.publisher).includes(last)))) {
          candidates.return();
          return found(r.issue_id);
        }
      }
      return null;
    },

    /** Want a catalog book: one row per catalog id (asking again refreshes it). */
    addWanted(item, userId = 0) {
      const r = db.prepare(`INSERT INTO ebooks_wanted (match_id, title, author, year, isbn, cover, added_by)
          VALUES (@match_id, @title, @author, @year, @isbn, @cover, @added_by)
          ON CONFLICT(match_id) DO UPDATE SET title=excluded.title, author=excluded.author, year=excluded.year, isbn=excluded.isbn, cover=excluded.cover`)
        .run({ match_id: String(item.id), title: item.title || 'Untitled', author: item.author || null, year: item.year || null, isbn: item.isbn || null, cover: item.cover || null, added_by: userId || 0 });
      return this.wantedByMatch(String(item.id)) || this.wantedById(r.lastInsertRowid);
    },
    wantedById(id) { return db.prepare('SELECT * FROM ebooks_wanted WHERE id=?').get(Number(id)) || null; },
    wantedByMatch(matchId) { return db.prepare('SELECT * FROM ebooks_wanted WHERE match_id=?').get(String(matchId)) || null; },
    listWanted() { return db.prepare('SELECT * FROM ebooks_wanted ORDER BY id').all(); },
    removeWanted(id) { return db.prepare('DELETE FROM ebooks_wanted WHERE id=?').run(Number(id)).changes; },
    noteWantedTry(id, error = null) {
      db.prepare(`UPDATE ebooks_wanted SET tried_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'), last_error=? WHERE id=?`).run(error, Number(id));
    },

    removeRemoteEntry(issueId) {
      const row = db.prepare('SELECT issue_id, path FROM ebooks_files WHERE issue_id=?').get(issueId);
      if (!row || row.path) return false;
      const issue = db.prepare("SELECT series_id FROM issues WHERE id=? AND url LIKE 'ebookremote:%'").get(issueId);
      db.prepare('DELETE FROM ebooks_files WHERE issue_id=?').run(issueId);
      if (issue) {
        db.prepare('DELETE FROM issues WHERE id=?').run(issueId);
        db.prepare(`DELETE FROM series WHERE id=? AND url LIKE 'ebook:%' AND NOT EXISTS (SELECT 1 FROM issues WHERE series_id=?)`).run(issue.series_id, issue.series_id);
      }
      return true;
    },

    /** Books never attempted against the metadata service, in matcher shape.
     *  Remote/on-demand entries (source set) are excluded — they arrive with
     *  their source's metadata already applied, so re-matching them is wasteful
     *  and would hammer the service across the whole synced catalog. */
    unmatched(limit = 200) {
      return db.prepare(`SELECT ef.* , i.title, i.series_id AS core_series_id FROM ebooks_files ef
        JOIN issues i ON i.id = ef.issue_id
        WHERE ef.match_id IS NULL AND ef.match_checked_at IS NULL AND ef.source IS NULL
        ORDER BY ef.issue_id LIMIT ?`)
        .all(limit).map(bookShape);
    },
    bookForMatch(issueId) { return bookShape(fileByIssue(issueId)); },

    /** Fold an accepted metadata-service match into the catalog:
     *  filename-derived titles upgrade (issue + standalone series title),
     *  missing authors/covers/years fill in, page count lands on the file
     *  index, description (standalone) takes the longer text — and the match
     *  identity is recorded so scans don't re-ask. */
    applyMatch(issueId, merged) {
      const row = fileByIssue(issueId);
      if (!row) return;
      const series = db.prepare('SELECT * FROM series WHERE id=?').get(row.core_series_id);
      const standalone = isStandalone(series);
      const tx = db.transaction(() => {
        if (merged.title) {
          db.prepare('UPDATE issues SET title=? WHERE id=?').run(merged.title, issueId);
          db.prepare('UPDATE ebooks_files SET title_key=lower(trim(?)) WHERE issue_id=? AND source IS NULL').run(merged.title, issueId);
          if (standalone) db.prepare('UPDATE series SET title=? WHERE id=?').run(merged.title, series.id);
        }
        if (Array.isArray(merged.authors) && merged.authors.length && !series.publisher) {
          db.prepare('UPDATE series SET publisher=? WHERE id=?').run(merged.authors.join(', '), series.id);
        }
        // A standalone shelf is the book, so its blurb and year are the
        // book's. A series shelf keeps the first book's until it has its own —
        // a shelf with nothing on it says less than the first book's blurb.
        if (merged.description !== undefined && (standalone || !series.description)) {
          db.prepare('UPDATE series SET description=? WHERE id=?').run(merged.description, series.id);
        }
        if (merged.published_date && !series.year) {
          const y = year4(merged.published_date);
          if (y) db.prepare('UPDATE series SET year=? WHERE id=?').run(y, series.id);
        }
        if (Number.isFinite(merged.page_count)) {
          db.prepare('UPDATE library_files SET page_count=? WHERE path=?').run(merged.page_count, row.path);
        }
        db.prepare(`UPDATE ebooks_files SET
            match_id=@match_id, match_confidence=@match_confidence,
            isbn=COALESCE(@isbn, isbn), thumbnail=COALESCE(@thumbnail, thumbnail),
            match_checked_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')
          WHERE issue_id=@iid`)
          .run({
            iid: issueId, match_id: merged.match_id ?? null, match_confidence: merged.match_confidence ?? null,
            isbn: merged.isbn ?? null, thumbnail: merged.thumbnail ?? null,
          });
        // A cover-less book (typical PDF) adopts the service thumbnail via the
        // cover route; the series cover fills in from it when still blank.
        if (merged.thumbnail && !series.cover_url) {
          db.prepare('UPDATE series SET cover_url=? WHERE id=?').run(`/api/ebooks/issue/${issueId}/cover`, series.id);
        }
        // Series learned from the match (Hardcover knows series; the file's
        // own metadata often doesn't). Only for books that are currently
        // STANDALONE — a series the file declares itself is authoritative and
        // is never overridden. Runs last so the field updates above still
        // apply to the row this may replace.
        if (merged.series_name && standalone) {
          db.prepare(`UPDATE ebooks_files SET match_series=?, match_series_index=? WHERE issue_id=?`)
            .run(merged.series_name, Number.isFinite(merged.series_index) ? merged.series_index : null, issueId);
          const targetUrl = seriesUrlFor(series.library_id, { series: merged.series_name });
          db.prepare(`INSERT INTO series (title, url, publisher, type, library_id)
              VALUES (?,?,?,'ebook',?)
              ON CONFLICT(url) DO UPDATE SET type='ebook', library_id=excluded.library_id`)
            .run(merged.series_name, targetUrl, series.publisher || null, series.library_id);
          const target = seriesByUrl(targetUrl);
          if (target && target.id !== series.id) {
            db.prepare('UPDATE issues SET series_id=?, issue_number=? WHERE id=?')
              .run(target.id, indexNumber(merged.series_index), issueId);
            // The file's own rows follow the book — the shelf counts what it
            // owns from library_files, so a file left pointing at the pruned
            // shelf would make the book look not-yet-downloaded ("on demand").
            db.prepare('UPDATE library_files SET series_id=? WHERE issue_id=?').run(target.id, issueId);
            db.prepare('UPDATE ebooks_files SET series_id=? WHERE issue_id=?').run(target.id, issueId);
            // Carry what the standalone shelf learned — cover, blurb, year —
            // to the series shelf where it has none yet. The standalone row
            // is about to be pruned, and this is the only copy.
            const left = db.prepare('SELECT cover_url, description, year FROM series WHERE id=?').get(series.id) || {};
            const carry = {
              cover_url: !target.cover_url && (left.cover_url || merged.thumbnail) ? (left.cover_url || `/api/ebooks/issue/${issueId}/cover`) : null,
              description: !target.description && left.description ? left.description : null,
              year: !target.year && left.year ? left.year : null,
            };
            db.prepare('UPDATE series SET cover_url=COALESCE(@cover_url, cover_url), description=COALESCE(@description, description), year=COALESCE(@year, year) WHERE id=@id')
              .run({ ...carry, id: target.id });
            // The standalone row this book left behind is now empty — prune it.
            const remaining = db.prepare('SELECT COUNT(*) n FROM issues WHERE series_id=?').get(series.id).n;
            if (!remaining) db.prepare("DELETE FROM series WHERE id=? AND url LIKE 'ebook:%'").run(series.id);
          }
        }
      });
      tx();
    },
    setMatchChecked(issueId) {
      db.prepare("UPDATE ebooks_files SET match_checked_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE issue_id=?").run(issueId);
    },

    /** Raw handle for callers that also need core tables on the same file
     *  (the scanner reads `libraries`). */
    db,
    close() { db.close(); },
  };
  return store;
}
