# Vendored: foliate-js

- Source: https://github.com/johnfactotum/foliate-js
- Commit: `78914aef4466eb960965702401634c2cb348e9b1` (main, 2026-05-01)
- License: MIT (see `LICENSE` in this directory)

An npm package named `foliate-js` exists but is published by a third party,
not the upstream author — so the source is vendored straight from the
upstream repository at a pinned commit instead.

Only the modules needed to open and paginate EPUBs are vendored (the
`view.js` → `epub.js` path plus their static imports and the zip reader):

| file | why |
| --- | --- |
| `view.js` | the `<foliate-view>` element (entry point) |
| `epub.js` | EPUB parsing/loading |
| `epubcfi.js` | CFI locators (progress/resume) |
| `paginator.js` | reflowable pagination renderer |
| `fixed-layout.js` | fixed-layout (pre-paginated) EPUB renderer |
| `progress.js` | fraction / TOC progress mapping |
| `overlayer.js` | annotation overlay (static import of view.js) |
| `text-walker.js` | text ranges (static import of view.js) |
| `vendor/zip.js` | bundled zip reader (`@zip.js/zip.js`) EPUBs are opened with |

Deliberately NOT vendored (view.js only imports them dynamically, on paths
this plugin never takes): `mobi.js` + `vendor/fflate.js` (MOBI/AZW3 — a
possible later format), `pdf.js` + `vendor/pdfjs` (PDFs stream to the
browser's own viewer), `comic-book.js`, `fb2.js`, `search.js`, `tts.js`,
`dict.js`, `opds.js`, and the demo `ui/`/`reader.js`.

To update: pick a new upstream commit, re-copy the files above unchanged,
and update the commit hash here. No local patches are applied.
