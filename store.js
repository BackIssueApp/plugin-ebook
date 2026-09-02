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
  db.exec('CREATE INDEX IF NOT EXISTS idx_ebooks_files_remote ON ebooks_files (source, remote_id)');

  const seriesByUrl = (url) => db.prepare('SELECT * FROM series WHERE url=?').get(url);
  const isStandalone = (seriesRow) => /^ebook:l\d+:b:/.test(String(seriesRow?.url || ''));
  const authorsOf = (seriesRow) => String(seriesRow?.publisher || '').split(',').map((a) => a.trim()).filter(Boolean);

  /** File row + its catalog identity, for the routes. */
  function fileByIssue(issueId) {
    return db.prepare(`SELECT ef.*, i.title, i.series_id AS core_series_id
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
        db.prepare(`INSERT INTO ebooks_files
            (path, library_id, series_id, issue_id, format, size, mtime, title_source, isbn, language, cover, cover_type, added_at)
          VALUES (@path, @lib, @sid, @iid, @format, @size, @mtime, @title_source, @isbn, @language, @cover, @cover_type, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
          ON CONFLICT(path) DO UPDATE SET
            library_id=excluded.library_id, series_id=excluded.series_id, issue_id=excluded.issue_id,
            format=excluded.format, size=excluded.size, mtime=excluded.mtime,
            title_source=excluded.title_source, isbn=COALESCE(excluded.isbn, ebooks_files.isbn),
            language=COALESCE(excluded.language, ebooks_files.language),
            cover=excluded.cover, cover_type=excluded.cover_type`)
          .run({
            path: p, lib: libraryId, sid: seriesId, iid: issueId, format, size, mtime,
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
              title_source='embedded', isbn=?, language=?, thumbnail=? WHERE rowid=?`)
            .run(libraryId, seriesId, issueId, format, meta.isbn || null, meta.language || null, meta.coverUrl || null, prev.ef_rowid);
        } else {
          db.prepare(`INSERT INTO ebooks_files
              (path, library_id, series_id, issue_id, format, size, mtime, title_source, isbn, language, thumbnail, source, remote_id, added_at)
            VALUES (NULL, @lib, @sid, @iid, @format, NULL, NULL, 'embedded', @isbn, @language, @thumbnail, @source, @remote_id, strftime('%Y-%m-%dT%H:%M:%SZ','now'))`)
            .run({
              lib: libraryId, sid: seriesId, iid: issueId, format,
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
     *  re-sync won't duplicate it and the disk scanner treats it as intact. */
    materializedPath(issueId, p, size, mtime) {
      db.prepare('UPDATE ebooks_files SET path=?, size=?, mtime=? WHERE issue_id=?')
        .run(p, size ?? null, mtime ?? null, Number(issueId));
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
      return db.prepare('SELECT locator, fraction, updated_at FROM ebooks_progress WHERE user_id=? AND issue_id=?')
        .get(userId, issueId) || { locator: null, fraction: 0, updated_at: null };
    },
    saveProgress(userId, issueId, { locator, fraction }) {
      db.prepare(`INSERT INTO ebooks_progress (user_id, issue_id, locator, fraction, updated_at)
        VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
        ON CONFLICT(user_id, issue_id) DO UPDATE SET
          locator = excluded.locator, fraction = excluded.fraction, updated_at = excluded.updated_at`)
        .run(userId, issueId, locator == null ? null : String(locator),
          Math.min(1, Math.max(0, Number(fraction) || 0)));
    },
    /** All of one user's positions — the client paints row icons from this. */
    stateMap(userId) {
      const out = {};
      for (const r of db.prepare('SELECT issue_id, fraction FROM ebooks_progress WHERE user_id=?').all(userId)) {
        out[r.issue_id] = { fraction: r.fraction };
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
      const q = db.prepare(`SELECT issue_id, format, path, source FROM ebooks_files
        WHERE issue_id IN (${ids.map(() => '?').join(',')})`);
      for (const r of q.all(...ids)) out[r.issue_id] = { format: r.format, remote: !!r.source && !r.path };
      return out;
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
          if (standalone) db.prepare('UPDATE series SET title=? WHERE id=?').run(merged.title, series.id);
        }
        if (Array.isArray(merged.authors) && merged.authors.length && !series.publisher) {
          db.prepare('UPDATE series SET publisher=? WHERE id=?').run(merged.authors.join(', '), series.id);
        }
        if (merged.description !== undefined && standalone) {
          db.prepare('UPDATE series SET description=? WHERE id=?').run(merged.description, series.id);
        }
        if (merged.published_date && standalone && !series.year) {
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
            // Carry the cover over when the series shelf has none yet.
            if (!target.cover_url && (series.cover_url || merged.thumbnail)) {
              db.prepare('UPDATE series SET cover_url=? WHERE id=?')
                .run(series.cover_url || `/api/ebooks/issue/${issueId}/cover`, target.id);
            }
            // The standalone row this book left behind is now empty — prune it.
            const left = db.prepare('SELECT COUNT(*) n FROM issues WHERE series_id=?').get(series.id).n;
            if (!left) db.prepare("DELETE FROM series WHERE id=? AND url LIKE 'ebook:%'").run(series.id);
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
