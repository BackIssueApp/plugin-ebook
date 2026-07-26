// The client script's contract with core's plugin bridge. The client itself
// runs in a browser, so these are static checks in the same spirit as core's
// frontend tests — they guard the wiring that breaks silently: the series
// view registration (and its placement before the permission gate), the one
// shared open path, and the JS↔CSS class vocabulary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const clientDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'client');
const js = fs.readFileSync(path.join(clientDir, 'ebooks.js'), 'utf8');
const css = fs.readFileSync(path.join(clientDir, 'ebooks.css'), 'utf8');

test('the series view is registered for type ebook, before the permission gate', () => {
  assert.match(js, /registerSeriesView\(\{ type: 'ebook', render: renderBooksView \}\)/);
  // The view must exist for EVERY caller — roles without ebooks.use get an
  // explanation instead of a blank series page — so registration has to
  // happen before the early return that guards the rest of the client.
  const reg = js.indexOf('registerSeriesView');
  const gate = js.indexOf('if (!canUse()) return;');
  assert.ok(reg > -1 && gate > -1 && reg < gate, 'view registration must precede the permission gate');
});

test('every trigger opens books through the one shared path', () => {
  // The row action, the list view's Read button, and every button in the
  // shared detail wiring (sheet AND inline single-book view) route through
  // openBook — no second EPUB-vs-PDF fork to drift out of sync. Shelf CARDS
  // deliberately don't read: they open the detail sheet, whose primary
  // button reads.
  const openBook = js.match(/function openBook\([\s\S]*?\n {4}\}/)?.[0] || '';
  assert.ok(openBook.includes('openReader(issue)'), 'openBook opens EPUBs in the shell');
  assert.ok(js.includes('run: (i) => openBook(i)'), 'the issue-row action routes through openBook');
  assert.ok(js.includes('openBook(books[+btn.dataset.read].primary)'), 'the list Read button routes through openBook');
  assert.ok(js.includes('openSheet(books, +card.dataset.book, ctx)'), 'shelf cards open the detail sheet');
  assert.ok(js.includes('readBtn.onclick = () => openBook(b.primary)'), 'the detail primary button routes through openBook');
  assert.ok(js.includes('openBook(b.entries[+btn.dataset.fileRead])'), 'the detail file rows route through openBook');
});

test('single-book series render the detail inline, from the builders the sheet shares', () => {
  // One book = one click: renderBooksView must branch to the inline detail
  // instead of drawing a one-card shelf that needs a second click.
  const shelf = js.match(/function renderBooksView\([\s\S]*?\n {4}\}/)?.[0] || '';
  assert.ok(shelf.includes('books.length === 1'), 'renderBooksView branches on a lone book');
  assert.ok(shelf.includes('renderSingleBook(container, ctx, books)'), 'the lone-book branch renders the inline detail');

  // Both detail surfaces MUST render and wire through the same shared
  // builders — a fork here is exactly the drift the refactor removes.
  const single = js.match(/function renderSingleBook\([\s\S]*?\n {4}\}/)?.[0] || '';
  const sheetFn = js.match(/function renderSheet\([\s\S]*?\n {4}\}/)?.[0] || '';
  assert.ok(single && sheetFn, 'both detail render functions exist');
  for (const shared of ['progressActionsHtml(b', 'detailSectionsHtml(b, books, ctx,', 'wireBookDetail(', 'ensureDetails(b,']) {
    assert.ok(single.includes(shared), `inline view uses shared builder: ${shared}`);
    assert.ok(sheetFn.includes(shared), `sheet uses shared builder: ${shared}`);
  }

  // The inline view IS the page: core's hero shows cover/title/author and
  // its back button leaves, so no hero/blurb duplication and no sheet head
  // (breadcrumb / prev / next / close) may leak in.
  for (const overlayOnly of ['ebs__head', 'ebs__hero', 'ebs__title', 'ebs__blurb', 'ebs-prev', 'ebs-close']) {
    assert.ok(!single.includes(overlayOnly), `inline view must not render ${overlayOnly}`);
  }
});

test('every ebk__/ebs__ class the shelf and sheet render is styled in ebooks.css', () => {
  const used = new Set(js.match(/eb[ks]__[a-z-]+/g));
  assert.ok(used.size >= 20, 'the shelf + sheet should render a real set of classes');
  for (const cls of used) {
    // Modifier classes (ebk__st--done) style via their base selector too.
    assert.ok(css.includes('.' + cls), `class "${cls}" is rendered but never styled`);
  }
});

test('the detail sheet stacks below the reading shell and matches its Esc rules', () => {
  // Read from the sheet opens the shell ON TOP; the shell must win z-order,
  // and Esc while reading must close the reader, not the sheet under it.
  const sheetZ = Number((css.match(/\.ebs \{[^}]*z-index:\s*(\d+)/) || [])[1]);
  const readerZ = Number((css.match(/\.ebr \{[^}]*z-index:\s*(\d+)/) || [])[1]);
  assert.ok(sheetZ > 0 && readerZ > sheetZ, `reader (${readerZ}) must stack above the sheet (${sheetZ})`);
  assert.ok(js.includes("reader.el.classList.contains('is-open'))) return;"),
    'sheet keydown must yield while the reader is open');
});
