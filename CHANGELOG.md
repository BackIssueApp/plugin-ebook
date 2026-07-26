# Changelog

Notable, user-facing changes per release. Format follows [Keep a Changelog](https://keepachangelog.com);
versions follow the tags in this repository (`vX.Y.Z` → the release bundle BackIssue's plugin catalog installs).

Contributors: please **don't** edit this file in pull requests — entries are added
by the maintainers when changes merge, so concurrent PRs don't conflict here.

## [Unreleased]

## [0.1.0]

- **On-demand (file-less) libraries.** A registered remote book source can be
  synced into a Books library as browsable, metadata-only
  entries — covers and details, but **no files downloaded**. Each book's EPUB is
  fetched the first time someone opens it to read (cache-on-read) and served
  from disk on every open after that; simultaneous opens of the same book share
  a single download. A first-open "Opening…" delay while it downloads is normal.
  - The catalog sync is metadata-only and fast, resumes from a per-source page
    cursor after an interruption, and can be capped or stopped. One run at a
    time. Curation-gated (`library.manage`): `POST /api/ebooks/remote-sync/start`
    `{ sourceId?, libraryId?, maxBooks? }`, `POST /api/ebooks/remote-sync/stop`,
    `GET /api/ebooks/remote-sync/status`.
  - On-demand entries are best kept in their own dedicated Books library so they
    don't swamp your owned books; the sync honors whichever library you choose.

Initial release (v1):

- **Books library type, fully integrated.** Create libraries of type "Books"
  for EPUB/PDF shelves and they behave like every other library: books appear
  in the normal Library grid (author as the byline, cover art, description),
  each book series has a regular series page, and the sidebar's library
  entries, filters, and stats all just work. No separate Books section.
- **Scanner → catalog.** The scanner walks the library folders for
  `.epub`/`.pdf`, extracts embedded metadata (EPUB OPF: title/authors/
  series/ISBN/description/cover; PDF Info dict: title/author), and catalogs
  every book as a real series + issue: a calibre series becomes one series
  with its books as issues ordered by `series_index`; a standalone book
  becomes a single-issue series named after itself. Incremental
  (path + mtime + size); deleted files prune their catalog rows like comic
  scans do. Runs from the schedulable "Scan book libraries" job.
- **Metadata enrichment** — best-effort matching against the app's metadata
  service (ISBN first, then title + author); embedded fields are never
  replaced with worse data (longer description wins, embedded titles stick),
  and upgrades land directly on the catalog rows (titles, byline, year,
  description, cover, page count). Per-book **Re-match** stays available to
  library managers.
- **A book shelf instead of an issue list.** On cores with plugin-owned
  series views, ebook series pages replace the comic vocabulary (filter
  chips, issue grid, selection) with a shelf: a header with a stat line
  ("3 books · 1 read · 2 EPUB · 1 PDF") and a series read-through bar, then
  either a cover grid (2:3 covers with sequence chips, Read/percent state
  chips, and in-progress bars; books without art get a stable per-title
  gradient tile) or a list view (sequence, cover thumb, title, read state
  with inline progress, per-format EPUB/PDF download badges, a direct
  Read/Continue/Open button, and Re-match for library managers) — the
  shelf/list choice sticks per device. Files of the same book (an EPUB + PDF
  of one title) group into a single entry. Older cores fall back to the
  generic issue rows.
- **Book detail sheet.** Clicking a shelf card opens a detail dialog over the
  page: breadcrumb with prev/next-in-series paging (arrow keys work too),
  cover + title/author hero with reading progress and a primary
  Read/Continue/Open button, Mark finished/unread for EPUBs, description
  (standalone books), per-file rows (format badge, size, read/download), a
  details grid (series position, author, published year, language, ISBN,
  added date), a resume card while mid-book, and Re-match under Manage for
  library managers. Reading from the sheet stacks the reading shell on top
  and returns to an up-to-date sheet on close.
- **Reading, same entry point as comics.** Ebook issues get a Read action on
  the normal series page rows/cards — EPUBs open the in-browser reading shell
  (vendored [foliate-js](https://github.com/johnfactotum/foliate-js), MIT,
  pinned commit) styled like the comic reader's overlay: paginated reading,
  tap zones + arrow keys, TOC drawer, font size / line spacing /
  light-sepia-dark themes, per-user progress saved as a CFI locator with
  resume on open, and read-state icons on the rows. PDFs stream inline to the
  browser's own viewer. A second action downloads the book file. Comic-only
  reader functions (guided view, webtoon, double-page, panel editing) simply
  don't appear.
- **Import tool integration.** Loose ebook files under the scan roots surface
  in the same Import review list as comic folders — identified from embedded
  metadata plus a metadata-service match (ISBN hits auto-ready) — and a
  confirmed book is filed into the Books library as
  `Author/Series/Title.ext` (or `Author/Title.ext`) and cataloged.
- **Permission** — `ebooks.use` (viewer tier) gates reading and book-file
  downloads; scanning/re-matching/import ride core library management.
