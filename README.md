# Books (ebook library)

An ebook library for BackIssue: adds a **Books** library type for your EPUB
and PDF shelves, fully integrated into the normal flow. Scanned books become
regular entries in the Library grid (author as the byline, covers,
descriptions) — a calibre series shows as one series with its books as
issues, a standalone book as a single-book series. A book series page is a
shelf, not a comic issue list: one row per book with cover, read state and
progress, per-format EPUB/PDF download badges, and a Read button that opens
the in-browser EPUB reader (per-user progress and resume, table of contents,
font/theme/spacing settings); PDFs open inline in the browser's own viewer.
Embedded metadata is enriched best-effort from the app's metadata service,
and loose ebook files show up in the Import tool, filing into the Books
library on confirm.

## Install

One click from **Sidebar → Plugins** in BackIssue, or drop this folder into
the app's `plugins/` directory and restart.

## Setup

1. Create a library with type **Books** under **Settings → Libraries** and
   point it at the folder(s) holding your `.epub` / `.pdf` files.
2. Run **Scan book libraries** from the Jobs page (it also runs on a
   schedule). Your books appear in the Library like any other series.

Metadata matching is automatic and best-effort: ISBN first, then
title + author, and it never overwrites a file's own embedded fields with
worse data.

Access rides the `ebooks.use` permission (granted to viewers by default);
scanning and importing require library management rights.

## Reading engine

The EPUB engine is [foliate-js](https://github.com/johnfactotum/foliate-js)
(MIT), vendored at a pinned commit — see
`client/vendor/foliate-js/VENDOR.md`.
