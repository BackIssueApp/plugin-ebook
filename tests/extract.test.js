// Embedded-metadata extraction: an EPUB fixture built in-test (a real zip
// with container.xml + OPF + cover), and a PDF fixture with an Info dict.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import { extractEpubMeta, extractPdfMeta, isbnOf } from '../extract.js';

const OPF = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>The Left Hand of Darkness</dc:title>
    <dc:creator opf:role="aut">Ursula K. Le Guin</dc:creator>
    <dc:creator>Somebody Else</dc:creator>
    <dc:description>Winter &amp; politics on the planet Gethen.</dc:description>
    <dc:language>en</dc:language>
    <dc:identifier id="uid">urn:isbn:978-0-441-47812-5</dc:identifier>
    <meta name="calibre:series" content="Hainish Cycle"/>
    <meta name="calibre:series_index" content="4.0"/>
    <meta name="cover" content="cover-img"/>
  </metadata>
  <manifest>
    <item id="cover-img" href="images/cover.jpg" media-type="image/jpeg"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
</package>`;

async function buildEpub({ opf = OPF, opfPath = 'OEBPS/content.opf' } = {}) {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip');
  zip.file('META-INF/container.xml',
    `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
      <rootfiles><rootfile full-path="${opfPath}" media-type="application/oebps-package+xml"/></rootfiles>
    </container>`);
  zip.file(opfPath, opf);
  zip.file('OEBPS/images/cover.jpg', Buffer.from('JPEGBYTES'));
  zip.file('OEBPS/ch1.xhtml', '<html><body>hi</body></html>');
  return zip.generateAsync({ type: 'nodebuffer' });
}

test('EPUB: title/creators/series/ISBN/description/cover from the OPF', async () => {
  const meta = await extractEpubMeta(await buildEpub(), '/lib/lhod.epub');
  assert.equal(meta.title, 'The Left Hand of Darkness');
  assert.equal(meta.title_source, 'embedded');
  assert.deepEqual(meta.authors, ['Ursula K. Le Guin', 'Somebody Else']);
  assert.equal(meta.series, 'Hainish Cycle');
  assert.equal(meta.series_index, 4);
  assert.equal(meta.isbn, '9780441478125');
  assert.equal(meta.description, 'Winter & politics on the planet Gethen.');
  assert.equal(meta.language, 'en');
  assert.equal(meta.cover.toString(), 'JPEGBYTES', 'EPUB2 meta name="cover" indirection resolved');
  assert.equal(meta.cover_type, 'image/jpeg');
});

test('EPUB3 cover via properties="cover-image"; missing title falls back to filename', async () => {
  const opf = `<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
    <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>A. Nony Mous</dc:creator></metadata>
    <manifest><item id="c" href="images/cover.jpg" media-type="image/jpeg" properties="cover-image"/></manifest>
  </package>`;
  const meta = await extractEpubMeta(await buildEpub({ opf }), '/lib/My.Great_Novel.epub');
  assert.equal(meta.title, 'My Great Novel', 'dots/underscores become spaces');
  assert.equal(meta.title_source, 'filename');
  assert.equal(meta.cover.toString(), 'JPEGBYTES');
});

test('a non-EPUB zip throws (the scanner logs and skips it)', async () => {
  const zip = new JSZip();
  zip.file('whatever.txt', 'not an epub');
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  await assert.rejects(() => extractEpubMeta(buf), /container\.xml/);
});

test('PDF: Info dict title/author; no cover in v1', async () => {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  doc.setTitle('A Brief History of Time');
  doc.setAuthor('Stephen Hawking');
  const meta = await extractPdfMeta(Buffer.from(await doc.save()), '/lib/abhot.pdf');
  assert.equal(meta.title, 'A Brief History of Time');
  assert.equal(meta.title_source, 'embedded');
  assert.deepEqual(meta.authors, ['Stephen Hawking']);
  assert.equal(meta.cover, null);
});

test('PDF without an Info dict (or unparseable) falls back to the filename', async () => {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  const meta = await extractPdfMeta(Buffer.from(await doc.save()), '/lib/some_scan.pdf');
  assert.equal(meta.title, 'some scan');
  assert.equal(meta.title_source, 'filename');
  const junk = await extractPdfMeta(Buffer.from('not a pdf at all'), '/lib/broken_file.pdf');
  assert.equal(junk.title, 'broken file');
  assert.deepEqual(junk.authors, []);
});

test('isbnOf normalizes urn:/hyphens and rejects non-ISBN identifiers', () => {
  assert.equal(isbnOf('urn:isbn:978-0-441-47812-5'), '9780441478125');
  assert.equal(isbnOf('0-441-47812-3'), '0441478123');
  assert.equal(isbnOf('044147812x'), '044147812X');
  assert.equal(isbnOf('uuid:deadbeef'), null);
  assert.equal(isbnOf('12345'), null);
});
