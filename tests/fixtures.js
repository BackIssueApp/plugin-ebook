// Shared test fixtures: minimal-but-real EPUB/PDF buffers the extractor can
// actually parse (JSZip + pdf-lib, the same libraries the plugin uses).
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';

export async function epubBuffer(title, { author = 'Test Author', series = null, index = null, isbn = null, cover = null } = {}) {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip');
  zip.file('META-INF/container.xml',
    '<container><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  zip.file('content.opf',
    `<package><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
       <dc:title>${title}</dc:title><dc:creator>${author}</dc:creator>
       ${isbn ? `<dc:identifier>urn:isbn:${isbn}</dc:identifier>` : ''}
       ${series ? `<meta name="calibre:series" content="${series}"/><meta name="calibre:series_index" content="${index ?? 1}"/>` : ''}
     </metadata><manifest>
       ${cover ? '<item id="cov" href="cover.jpg" media-type="image/jpeg" properties="cover-image"/>' : ''}
     </manifest></package>`);
  if (cover) zip.file('cover.jpg', cover);
  return zip.generateAsync({ type: 'nodebuffer' });
}

export async function pdfBuffer(title) {
  const doc = await PDFDocument.create();
  doc.addPage([100, 100]);
  if (title) doc.setTitle(title);
  return Buffer.from(await doc.save());
}
