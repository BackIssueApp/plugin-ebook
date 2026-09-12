# Changelog

Notable, user-facing changes per release. Format follows [Keep a Changelog](https://keepachangelog.com);
versions follow the tags in this repository (`vX.Y.Z` → the release bundle BackIssue's plugin catalog installs).

Contributors: please **don't** edit this file in pull requests — entries are added
by the maintainers when changes merge, so concurrent PRs don't conflict here.

## [Unreleased]

## [0.2.5] — 2026-09-12

### Fixed

- A book the metadata match moved onto a series shelf kept its cover but
  lost its blurb and year: they had been written to the standalone shelf it
  left behind, which was then pruned. They now travel with the book, and a
  series shelf takes the first book's blurb and year until it has its own.
  The file's rows follow the book as well, so it no longer shows as
  "available on demand" — not yet downloaded — when it is on disk.
- An on-demand book that had been fetched to disk still counted as not yet
  downloaded ("available on demand"): the fetch recorded where the file
  landed but never told the file index. It is owned from the moment it lands.

### Added

- **Add a book.** The app's Add button gains a Books tab where a Books
  library exists: search the catalog, see what is already on the shelf, and
  add a book — it goes on a wanted list and the download sources are asked
  for it at once (by ISBN where the catalog has one). What no source has yet
  is tried again by the new **Fill wanted books** job, or leaves the list
  when a scan or import brings it in. `GET /api/ebooks/wanted` lists the
  wanted books; `DELETE /api/ebooks/wanted/<id>` drops one.
- **Downloads are filed.** A book the app's download sources fetched (an
  approved request, for instance) is moved into the library as
  Author/Series/Title.ext and catalogued like a scanned one, named from the
  request's title and author. Needs app 0.8.4 or later; older apps simply
  never hand anything over.
- **Removing an on-demand source's entries.** `DELETE /api/ebooks/remote/<source>`
  (library manage) drops every file-less entry that source put on the shelf,
  with their issues and the series left empty, and forgets its sync cursor —
  for a source plugin you have removed, or a shelf you want reset. A book it
  had already fetched to a file stays, as an ordinary local book.

## [0.2.4] — 2026-09-11

### Added

- **Positions in human terms.** A reading position can now carry the chapter
  name and a page-of-pages alongside the locator, so a resume card can say
  "Chapter 7 · page 142 of 312" instead of a bare percentage. `/state` reports
  these too, with the book's title and series, so a home screen can build a
  "reading now" card from one call.
- **Book outline on demand.** `GET /api/ebooks/issue/:id/details` now includes
  the book's estimated page count and its chapters with the page each starts
  on, derived from the file the first time it is asked for and cached.
- **Highlights.** A bookmark can carry a colour and the passage it marks —
  the shape the mobile readers use for highlights and notes. Older clients
  that only know bookmarks are unaffected.

## [0.2.3] — 2026-09-08

### Fixed

- **A remote catalog sync could stall the whole server.** The lookup that
  spots a re-imported book next to its dead old record compared titles
  across the entire remote catalog for every new book, which on a catalog of
  a few hundred thousand titles blocked the server for minutes per book.
  Titles are now indexed on the row, so the lookup is instant at any size.

## [0.2.2] — 2026-09-07

### Changed

- **Card covers ask for a card-sized image.** The cover redirect now asks a
  local source proxy for a 400 px copy by default (`?w=0` for the original),
  so shelves and the library grid stop downloading full-size art.

## [0.2.1] — 2026-09-06

### Fixed

- **A remote book the source cannot serve says so.** When the source no
  longer has the file behind an on-demand book, opening it now explains that
  in the reader instead of a bare HTTP status, and — when another copy of
  the same title on the shelf still opens — offers that copy right there.
  The book is remembered as unavailable, flagged in the Files list before the
  next tap, and cleared the moment a download succeeds again.
- **Dead duplicates are pruned.** When a re-imported copy of a book arrives
  next to an older record the source can no longer serve, the catalog sync
  removes the dead one (matched by title within the library, across
  shelves), and each sync also sweeps entries an open attempt already
  proved dead whose twin still serves. Needs a source that can probe a file
  cheaply; sources without that keep both copies.

## [0.2.0] — 2026-09-02

### Added

- **Bookmarks.** Save your place in a book and jump back to it later. A
  bookmark stores the exact position (not a page number), so it reopens on the
  same words whatever the font size or window width. The reading shell gains a
  bookmark button and a bookmarks drawer beside the contents drawer.
- **Reading stats.** A new stats endpoint reports how many books you have
  started, how many you have finished, and an approximate page count read.
  Finished uses the same threshold the shelf paints with, so the numbers always
  agree with the icons.
- **Home rails.** Two book rails — **Continue reading** and **New books** —
  now appear on the home screen alongside the comic and audiobook rails. Each
  can be hidden from its ×, or toggled per user on the Profile page; the choice
  is saved server-side so it follows the account rather than the browser.

## [0.1.4] — 2026-09-02

### Fixed

- **Series grouping now actually reaches books.** The match path reads search
  results, which carry only enrichment the service already had cached — so on
  a cold cache no book ever gained a series. A matched book with no series of
  its own now resolves its enrichment directly (one cached lookup by ISBN),
  and books that are already grouped skip the call entirely.

## [0.1.3] — 2026-09-02

### Added

- **Books group into series automatically, even when the file doesn't say so.**
  Ebook files carry series information only when someone (usually calibre) put
  it there; everything else became a shelf of one. The metadata service now
  supplies the series — and the book's position in it — so matched books are
  grouped onto a single series shelf in reading order. A series the file
  declares itself is still authoritative and is never overridden, and the
  learned grouping survives a rescan.

## [0.1.2] — 2026-07-28

### Fixed

- **Book downloads from OPDS readers no longer fail with 401.** The OPDS
  catalog's acquisition and cover links point at this plugin's file/cover
  routes, which answered an unauthenticated request with a bare 401 — no
  `WWW-Authenticate` challenge — so OPDS readers (KyBook and others) that
  wait for the challenge before sending credentials could browse the catalog
  but never download a book. Both routes now advertise the Basic challenge.

## [0.1.1]

### Fixed

- **Cacheable cover redirects.** The per-issue cover route's redirect now carries
  a day of `Cache-Control`, so browsers stop re-resolving every cover's redirect
  hop on each library view — covers appear noticeably faster on revisits.

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
