// Embedded-metadata extraction for scanned ebook files.
//
// EPUB: container.xml → OPF → dc:title/creator/description/identifier(ISBN),
// calibre series meta, and the cover image (EPUB3 properties="cover-image" or
// the EPUB2 <meta name="cover"> indirection). The OPF is a small XML document;
// it's read with targeted tag/attribute regexes instead of a DOM parser — the
// app ships no XML library and the handful of fields here don't justify one.
//
// PDF: Info-dict Title/Author via pdf-lib, which core already depends on
// (src/downloader.js) — reused instead of hand-rolling an Info-dict parser.
// Cover-from-first-page rendering is deliberately NOT done in v1; PDFs
// without a match thumbnail get a client-side placeholder.
import path from 'node:path';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';

// ---- tiny XML helpers (regex-scoped to the OPF's simple structure) --------

const decodeEntities = (s) => String(s)
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** Text content of every <ns:tag ...>text</ns:tag> occurrence (tags without
 *  content, i.e. self-closed, don't match — they carry no text). */
function tagTexts(xml, tag) {
  const re = new RegExp(`<(?:[A-Za-z0-9_-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9_-]+:)?${tag}>`, 'gi');
  const out = [];
  for (const m of xml.matchAll(re)) {
    const text = decodeEntities(m[1].replace(/<[^>]+>/g, '').trim());
    if (text) out.push(text);
  }
  return out;
}
/** Whole opening tags matching <ns:tag ...> (attribute order agnostic). */
function openTags(xml, tag) {
  return [...xml.matchAll(new RegExp(`<(?:[A-Za-z0-9_-]+:)?${tag}(\\s[^>]*)?/?>`, 'gi'))].map((m) => m[0]);
}
const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i'))
    || tag.match(new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`, 'i'));
  return m ? decodeEntities(m[1]) : null;
};

/** Normalize a dc:identifier value to a bare ISBN-10/13, or null. */
export function isbnOf(value) {
  const v = String(value || '').replace(/^urn:isbn:/i, '').replace(/[\s-]/g, '');
  return /^(?:97[89]\d{10}|\d{9}[\dXx])$/.test(v) ? v.toUpperCase() : null;
}

const titleFromFilename = (p) => path.basename(p, path.extname(p)).replace(/[._]+/g, ' ').trim();

// ---- EPUB ------------------------------------------------------------------

/** Parse an EPUB buffer → { title, title_source, authors, series,
 *  series_index, isbn, description, language, cover, cover_type }. Fields the
 *  file doesn't carry come back null; a broken zip/OPF throws. */
export async function extractEpubMeta(buffer, filePath = 'book.epub') {
  const zip = await JSZip.loadAsync(buffer);
  const container = await zip.file('META-INF/container.xml')?.async('string');
  if (!container) throw new Error('not an EPUB: no META-INF/container.xml');
  const rootfileTag = openTags(container, 'rootfile')
    .find((t) => (attr(t, 'media-type') || '').includes('oebps-package')) || openTags(container, 'rootfile')[0];
  const opfPath = rootfileTag && attr(rootfileTag, 'full-path');
  const opf = opfPath && await zip.file(opfPath)?.async('string');
  if (!opf) throw new Error('EPUB has no readable OPF');
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';

  const title = tagTexts(opf, 'title')[0] || null;
  const authors = tagTexts(opf, 'creator');
  const description = tagTexts(opf, 'description')[0] || null;
  const language = tagTexts(opf, 'language')[0] || null;
  let isbn = null;
  // dc:identifier text may match tagTexts; scheme attrs don't matter — any
  // value that LOOKS like an ISBN is one.
  for (const id of tagTexts(opf, 'identifier')) { isbn = isbnOf(id); if (isbn) break; }

  // Series: the calibre convention is the de-facto standard for sideloaded
  // EPUBs (<meta name="calibre:series" content="…"/> + calibre:series_index).
  // (EPUB3 belongs-to-collection exists but is rare in the wild — not parsed.)
  let series = null; let seriesIndex = null;
  for (const t of openTags(opf, 'meta')) {
    const name = attr(t, 'name');
    if (name === 'calibre:series') series = attr(t, 'content');
    if (name === 'calibre:series_index') { const n = parseFloat(attr(t, 'content')); if (Number.isFinite(n)) seriesIndex = n; }
  }

  // Cover: EPUB3 manifest item with properties~="cover-image"; else EPUB2's
  // <meta name="cover" content="<manifest id>"/> indirection.
  let cover = null; let coverType = null;
  const items = openTags(opf, 'item');
  let coverItem = items.find((t) => new RegExp('(^|\\s)cover-image(\\s|$)').test(attr(t, 'properties') || ''));
  if (!coverItem) {
    const coverId = openTags(opf, 'meta').map((t) => (attr(t, 'name') === 'cover' ? attr(t, 'content') : null)).find(Boolean);
    if (coverId) coverItem = items.find((t) => attr(t, 'id') === coverId);
  }
  if (coverItem) {
    const href = attr(coverItem, 'href');
    if (href) {
      // Resolve relative to the OPF dir (posix — zip paths always use '/').
      const full = path.posix.normalize(opfDir + decodeURIComponent(href));
      const file = zip.file(full) || zip.file(decodeURIComponent(href));
      if (file) {
        cover = Buffer.from(await file.async('arraybuffer'));
        coverType = attr(coverItem, 'media-type') || 'image/jpeg';
      }
    }
  }

  return {
    title: title || titleFromFilename(filePath),
    title_source: title ? 'embedded' : 'filename',
    authors, series: series || null, series_index: seriesIndex,
    isbn, description, language,
    cover, cover_type: coverType,
  };
}

// ---- EPUB outline -------------------------------------------------------------

// The reading shells paint "page 142 of 312" and a chapter list before the
// book is opened, so the outline is derived here once and cached on the row.
// A "page" is a fixed slice of the spine's bytes — the same 1500-byte unit
// foliate's progress model uses in both readers, so a page number shown on a
// detail screen is the one the reader will land on.
export const BYTES_PER_PAGE = 1500;
const MAX_CHAPTERS = 500;

const normalizeHref = (opfDir, href) => path.posix.normalize(opfDir + decodeURIComponent(String(href).split('#')[0]));

/** Parse an EPUB buffer → { pages, chapters: [{ label, href, page }] }.
 *  `pages` counts BYTES_PER_PAGE slices across the linear spine; each chapter
 *  carries the page its section starts on. Books without a nav/NCX still get
 *  a page count and an empty chapter list. */
export async function extractEpubOutline(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const container = await zip.file('META-INF/container.xml')?.async('string');
  if (!container) throw new Error('not an EPUB: no META-INF/container.xml');
  const rootfileTag = openTags(container, 'rootfile')
    .find((t) => (attr(t, 'media-type') || '').includes('oebps-package')) || openTags(container, 'rootfile')[0];
  const opfPath = rootfileTag && attr(rootfileTag, 'full-path');
  const opf = opfPath && await zip.file(opfPath)?.async('string');
  if (!opf) throw new Error('EPUB has no readable OPF');
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';

  const items = new Map();
  for (const t of openTags(opf, 'item')) {
    const id = attr(t, 'id'); const href = attr(t, 'href');
    if (id && href) items.set(id, { href: normalizeHref(opfDir, href), type: attr(t, 'media-type') || '', props: attr(t, 'properties') || '' });
  }
  // Linear spine, with each section's uncompressed size (what foliate measures).
  const spine = [];
  for (const t of openTags(opf, 'itemref')) {
    if ((attr(t, 'linear') || 'yes').toLowerCase() === 'no') continue;
    const it = items.get(attr(t, 'idref'));
    if (!it) continue;
    const file = zip.file(it.href);
    const size = file ? (await file.async('uint8array')).length : 0;
    spine.push({ href: it.href, size });
  }
  const starts = []; let total = 0;
  for (const s of spine) { starts.push(total); total += s.size; }
  const pages = Math.max(1, Math.ceil(total / BYTES_PER_PAGE));
  const pageOf = (href) => {
    const i = spine.findIndex((s) => s.href === href);
    return i < 0 ? null : Math.floor(starts[i] / BYTES_PER_PAGE) + 1;
  };

  // Chapters: EPUB3 nav document first, NCX as the fallback.
  const chapters = [];
  const nav = [...items.values()].find((it) => /(^|\s)nav(\s|$)/.test(it.props));
  const navXml = nav && await zip.file(nav.href)?.async('string');
  if (navXml) {
    const navDir = nav.href.includes('/') ? nav.href.slice(0, nav.href.lastIndexOf('/') + 1) : '';
    const tocBlock = navXml.match(/<nav[^>]*epub:type\s*=\s*["'][^"']*\btoc\b[^"']*["'][^>]*>([\s\S]*?)<\/nav>/i)?.[1]
      || navXml.match(/<nav[^>]*>([\s\S]*?)<\/nav>/i)?.[1] || '';
    for (const m of tocBlock.matchAll(/<a\s[^>]*href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      const label = decodeEntities(m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
      if (!label) continue;
      const href = normalizeHref(navDir, m[1]);
      chapters.push({ label, href: m[1], page: pageOf(href) });
      if (chapters.length >= MAX_CHAPTERS) break;
    }
  } else {
    const ncx = [...items.values()].find((it) => /x-dtbncx/i.test(it.type));
    const ncxXml = ncx && await zip.file(ncx.href)?.async('string');
    if (ncxXml) {
      const ncxDir = ncx.href.includes('/') ? ncx.href.slice(0, ncx.href.lastIndexOf('/') + 1) : '';
      for (const m of ncxXml.matchAll(/<navPoint[^>]*>[\s\S]*?<text>([\s\S]*?)<\/text>[\s\S]*?<content[^>]*src\s*=\s*["']([^"']*)["']/gi)) {
        const label = decodeEntities(m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
        if (!label) continue;
        chapters.push({ label, href: m[2], page: pageOf(normalizeHref(ncxDir, m[2])) });
        if (chapters.length >= MAX_CHAPTERS) break;
      }
    }
  }
  return { pages, chapters };
}

// ---- PDF --------------------------------------------------------------------

// Above this, skip the parse and fall back to the filename — pdf-lib reads the
// whole document structure into memory, which isn't worth it for a title.
const PDF_PARSE_CAP = 128 * 1024 * 1024;

/** Parse a PDF buffer → { title, title_source, authors, … } (no cover in v1). */
export async function extractPdfMeta(buffer, filePath = 'book.pdf') {
  let title = null; let author = null;
  if (buffer.length <= PDF_PARSE_CAP) {
    try {
      // updateMetadata:false — the default mutates ModDate/Producer in memory;
      // we never save, but don't touch it anyway. ignoreEncryption: encrypted
      // files still expose their Info dict.
      const doc = await PDFDocument.load(buffer, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
      title = (doc.getTitle() || '').trim() || null;
      author = (doc.getAuthor() || '').trim() || null;
    } catch { /* damaged/exotic PDF — the file still works, filename it is */ }
  }
  return {
    title: title || titleFromFilename(filePath),
    title_source: title ? 'embedded' : 'filename',
    authors: author ? [author] : [],
    series: null, series_index: null, isbn: null, description: null, language: null,
    cover: null, cover_type: null,
  };
}
