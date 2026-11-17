// Makes tests/fixtures/tall-font-lines.pdf: three lines set solid (20 pt text, 20 pt apart) in a font with tall
// metrics, as web pages printed to PDF often produce: a TrueType font that isn't embedded, with /Widths, and a
// font descriptor with Ascent 1069 and Descent -293 (Open Sans / Noto Sans values). A link covers line three.
// Editing line two must leave lines one and three (and the link) exactly as they were in the saved copy.
// Run: node tests/fixtures/make-tall-font-test.cjs
const { PDFDocument, PDFName, PDFString } = require("pdf-lib");
const { Font, Encodings } = require("@pdf-lib/standard-fonts");
const fs = require("fs");
(async () => {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const ctx = doc.context;
  // Widths for codes 32-126 (Helvetica's, standing in for the real font's).
  const helv = Font.load("Helvetica");
  const widths = [];
  for (let c = 32; c <= 126; c++) widths.push(helv.getWidthOfGlyph(Encodings.WinAnsi.encodeUnicodeCodePoint(c).name));
  const descriptor = ctx.register(ctx.obj({
    Type: "FontDescriptor", FontName: "OpenSans", Flags: 32, FontBBox: [-550, -271, 1204, 1048],
    ItalicAngle: 0, Ascent: 1069, Descent: -293, CapHeight: 714, StemV: 80,
  }));
  const font = ctx.register(ctx.obj({
    Type: "Font", Subtype: "TrueType", BaseFont: "OpenSans", FirstChar: 32, LastChar: 126,
    Widths: widths, Encoding: "WinAnsiEncoding", FontDescriptor: descriptor,
  }));
  const page = doc.addPage([612, 792]);
  const content = "BT /T1 20 Tf 20 TL 72 700 Td (Heading line one here) Tj T* (Heading line two here) Tj T* (Heading line three here) Tj ET";
  page.node.set(PDFName.of("Contents"), ctx.register(ctx.stream(content)));
  page.node.set(PDFName.of("Resources"), ctx.obj({ Font: { T1: font } }));
  const link = ctx.obj({ Type: "Annot", Subtype: "Link", Rect: [72, 654, 300, 682], Border: [0, 0, 0], A: { S: "URI", URI: PDFString.of("https://example.com/line-three") } });
  page.node.set(PDFName.of("Annots"), ctx.obj([ctx.register(link)]));
  fs.writeFileSync(require("node:path").join(__dirname, "tall-font-lines.pdf"), await doc.save({ useObjectStreams: false }));
  console.log("made");
})();
