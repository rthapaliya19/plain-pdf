// Makes the redaction test files:
// - tests/fixtures/redact-test.pdf: text in several forms, pictures, shapes, a drawing inside a form, a link.
//   Needs photo.jpg and logo.png in the folder given (skipped without them):
//   a 400x240 photo-like JPEG (blue-grey with a red band at x 40-360, y 80-160) and
//   a 200x100 PNG with a green ellipse on a transparent background (made with Pillow).
// - tests/fixtures/redact-leaks.pdf: what an audit of 1.3.1 found left in redacted copies (see makeLeaks below).
//   Needs Python with Pillow (for the fax-compressed scan).
// Run: node tests/fixtures/make-redact-test.cjs [folder-with-photo-and-logo]
const { PDFDocument, StandardFonts, PDFName, PDFString } = require("pdf-lib");
const fs = require("fs");
const { join } = require("node:path");
const { execFileSync } = require("node:child_process");
const FX = process.argv[2] || "./";
(async () => {
  if (fs.existsSync(FX + "photo.jpg") && fs.existsSync(FX + "logo.png")) await makeRedactTest();
  else console.log("redact-test.pdf skipped (no photo.jpg and logo.png in " + FX + ")");
  await makeLeaks();
})();

async function makeRedactTest() {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const jpg = await doc.embedJpg(new Uint8Array(fs.readFileSync(FX + "photo.jpg")));
  const png = await doc.embedPng(new Uint8Array(fs.readFileSync(FX + "logo.png")));
  const ctx = doc.context;
  // A picture stored with PNG row predictors (Up and Paeth rows), as many PDFs do: white left half, dark blue right half.
  const zlib = require("zlib");
  const W = 100, H = 80;
  const rows = [];
  let prev = Buffer.alloc(W * 3);
  for (let y = 0; y < H; y++) {
    const row = Buffer.alloc(W * 3);
    for (let x = 0; x < W; x++) row.set(x < 50 ? [255, 255, 255] : [20, 40, 120], x * 3);
    const type = y % 2 === 0 ? 2 : 4;
    const out = Buffer.alloc(W * 3 + 1);
    out[0] = type;
    for (let k = 0; k < W * 3; k++) {
      const left = k >= 3 ? row[k - 3] : 0, up = prev[k], upLeft = k >= 3 ? prev[k - 3] : 0;
      let pred = up;
      if (type === 4) { const pp = left + up - upLeft; const pa = Math.abs(pp - left), pb = Math.abs(pp - up), pc = Math.abs(pp - upLeft); pred = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft; }
      out[k + 1] = (row[k] - pred) & 255;
    }
    rows.push(out);
    prev = row;
  }
  const predicted = ctx.register(ctx.stream(new Uint8Array(zlib.deflateSync(Buffer.concat(rows))), {
    Type: "XObject", Subtype: "Image", Width: W, Height: H, ColorSpace: "DeviceRGB", BitsPerComponent: 8,
    Filter: "FlateDecode", DecodeParms: { Predictor: 15, Colors: 3, Columns: W, BitsPerComponent: 8 },
  }));
  const formContent = "BT /F1 12 Tf 0 0 Td (Inside form 42) Tj ET";
  const form = ctx.stream(formContent, { Type: "XObject", Subtype: "Form", BBox: [0, 0, 200, 20], Resources: { Font: { F1: helv.ref } } });
  const formRef = ctx.register(form);

  const page = doc.addPage([612, 792]);
  const content = [
    "BT /F1 14 Tf 72 700 Td (Account number 12345678 belongs to Jane) Tj ET",
    "BT /F1 12 Tf 72 670 Td [(Secret) -250 (code:) -250 (ALPHA) 120 (BRAVO)] TJ ET",
    "BT /F1 12 Tf 14 TL 72 640 Td 2 Tw 0.5 Tc (First line) Tj (Phone 555 0100 here) ' ET",
    "q 200 0 0 120 300 450 cm /Im1 Do Q",
    "q BT 3 Tr /F1 12 Tf 320 500 Td (HIDDEN OCR WORDS) Tj ET Q",
    "q 100 0 0 50 72 450 cm /Im2 Do Q",
    "0 0 1 rg 100 300 40 20 re f",
    "0 G 1 w 72 280 m 540 280 l S",
    "q 1 0 0 1 72 220 cm /Fm1 Do Q",
    "q 100 0 0 80 400 150 cm /Im3 Do Q",
    "/Span <</ActualText (SECRETACTUAL)>> BDC BT /F1 12 Tf 72 180 Td (Visible span) Tj ET EMC",
    "BT /F1 12 Tf 72 150 Td (Untouched closing line) Tj ET",
  ].join("\n");
  page.node.set(PDFName.of("Contents"), ctx.register(ctx.flateStream(content)));
  page.node.set(PDFName.of("Resources"), ctx.obj({ Font: { F1: helv.ref }, XObject: { Im1: jpg.ref, Im2: png.ref, Im3: predicted, Fm1: formRef } }));
  const link = ctx.obj({ Type: "Annot", Subtype: "Link", Rect: [72, 695, 300, 715], Border: [0, 0, 0], A: { S: "URI", URI: PDFString.of("https://example.com/secret") } });
  page.node.set(PDFName.of("Annots"), ctx.obj([ctx.register(link)]));

  // Page 2: an inline picture (can't be changed safely, so redacting over it saves the page as a picture).
  const page2 = doc.addPage([612, 792]);
  const inline = "q 100 0 0 100 72 500 cm BI /W 2 /H 2 /CS /G /BPC 8 ID \x00\xff\xff\x00 EI Q\nBT /F1 12 Tf 72 700 Td (Page two text) Tj ET";
  page2.node.set(PDFName.of("Contents"), ctx.register(ctx.stream(Buffer.from(inline, "latin1"))));
  page2.node.set(PDFName.of("Resources"), ctx.obj({ Font: { F1: helv.ref } }));
  fs.writeFileSync(join(__dirname, "redact-test.pdf"), await doc.save({ useObjectStreams: false }));
  console.log("made redact-test.pdf");
}

/**
 * redact-leaks.pdf, five pages; each gets a box in the test:
 * 1. A whole-page fax-compressed scan (CCITT G4, which can't be painted, so the page becomes a picture)
 *    with "SCANNED SECRET 4417", and a drawing (form) with the text "FORM SECRET 9081".
 *    Its resource list is on the page tree and shared with page 2 (as some apps do).
 * 2. Stays real text: a light page-sized background, a small picture (Stamp), a heading, text turned into
 *    outlines (rectangles filled with one "f", including an O with a hole), a solid and a dashed rule,
 *    and a clipping rectangle, crossing the box.
 * 3. A vector signature (curves) crossing the box.
 * 4. A scribble (a line of 30 straight segments) crossing the box.
 * 5. "MASKSECRET 5521" drawn only inside a soft mask, under the box.
 * Pages 1 and 2 also have a thumbnail (/Thumb) and app-private data (/PieceInfo), and the file's
 * XMP details hold a thumbnail. Every leftover carries a marker word the test searches the saved file for.
 */
async function makeLeaks() {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const ctx = doc.context;
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const raw = (text, dict = {}) => ctx.register(ctx.stream(Buffer.from(text, "latin1"), dict));

  // The scan: 1700x2200 (200 dpi), 1 bit, fax-compressed in one strip.
  const strip = execFileSync("python3", ["-I", "-c", `
import io, sys
from PIL import Image, ImageDraw, ImageFont
im = Image.new("1", (1700, 2200), 1)
d = ImageDraw.Draw(im)
d.text((200, 380), "SCANNED SECRET 4417", font=ImageFont.load_default(size=80), fill=0)
d.text((200, 1200), "Dear customer, this line is not under a box.", font=ImageFont.load_default(size=50), fill=0)
buf = io.BytesIO()
im.save(buf, "TIFF", compression="group4", tiffinfo={278: 2200})
t = Image.open(io.BytesIO(buf.getvalue()))
off, n = t.tag_v2[273], t.tag_v2[279]
off = off[0] if isinstance(off, tuple) else off
n = n[0] if isinstance(n, tuple) else n
sys.stdout.buffer.write(buf.getvalue()[off:off + n])`]);
  const scan = ctx.register(ctx.stream(strip, {
    Type: "XObject", Subtype: "Image", Width: 1700, Height: 2200, ColorSpace: "DeviceGray", BitsPerComponent: 1,
    Filter: "CCITTFaxDecode", DecodeParms: { K: -1, Columns: 1700, Rows: 2200, BlackIs1: true },
  }));
  const form = raw("BT /F1 14 Tf 0 0 Td (FORM SECRET 9081) Tj ET", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 300, 30], Resources: { Font: { F1: helv.ref } } });
  const stamp = ctx.register(ctx.flateStream(new Uint8Array(16).fill(90), { Type: "XObject", Subtype: "Image", Width: 4, Height: 4, ColorSpace: "DeviceGray", BitsPerComponent: 8 }));
  // One list for pages 1 and 2, inherited from the page tree.
  doc.catalog.Pages().set(PDFName.of("Resources"), ctx.register(ctx.obj({ Font: { F1: helv.ref }, XObject: { Scan: scan, Fm1: form, Stamp: stamp } })));

  // A tiny uncompressed picture (8x8 RGB) whose bytes spell the marker.
  const thumb = (marker) => raw(marker.repeat(20).slice(0, 192), { Width: 8, Height: 8, ColorSpace: "DeviceRGB", BitsPerComponent: 8 });
  const pieceInfo = (marker) => ctx.obj({ Illustrator: { LastModified: PDFString.of("D:20261117000000Z"), Private: raw(`${marker}: the original artwork, FORM SECRET 9081, SCANNED SECRET 4417`) } });
  const addPage = (lines, resources, extra = {}) => {
    const page = doc.addPage([612, 792]);
    page.node.set(PDFName.of("Contents"), ctx.register(ctx.flateStream(lines.join("\n"))));
    if (resources) page.node.set(PDFName.of("Resources"), ctx.obj(resources));
    else page.node.delete(PDFName.of("Resources"));
    for (const [k, v] of Object.entries(extra)) page.node.set(PDFName.of(k), v);
  };

  addPage(["q 612 0 0 792 0 0 cm /Scan Do Q", "q 1 0 0 1 72 600 cm /Fm1 Do Q"], null, { Thumb: thumb("THUMB-OF-PAGE-ONE "), PieceInfo: pieceInfo("AIPRIVATE-PAGE-ONE") });
  addPage([
    "0.9 0.95 1 rg 0 0 612 792 re f",
    "q 40 0 0 40 400 600 cm /Stamp Do Q",
    "0 g BT /F1 14 Tf 72 700 Td (Kept heading on page two) Tj ET",
    "0 0 0 rg 100 400 8 40 re 120 400 8 40 re 140 400 8 40 re 160 400 8 40 re 180 400 8 40 re 200 400 8 40 re 220 400 8 40 re 240 400 8 40 re 100 445 150 10 re 300 400 30 40 re 325 405 -20 30 re f",
    "0 0 0.6 RG 2 w 72 395 m 540 395 l S",
    "[6 4] 0 d 72 385 m 540 385 l S [] 0 d",
    "q 110 455 40 -50 re W n 0 0.5 0 rg 0 0 612 792 re f Q",
  ], null, { Thumb: thumb("THUMB-OF-PAGE-TWO "), PieceInfo: pieceInfo("AIPRIVATE-PAGE-TWO") });
  addPage([
    "BT /F1 12 Tf 72 300 Td (Signed:) Tj ET",
    "0 0 0 RG 1.5 w 1 J 1 j 130 300 m 150 340 170 260 190 300 c 210 340 230 260 250 300 c 270 340 290 260 310 300 c 330 340 350 260 370 300 c S",
  ], { Font: { F1: helv.ref } });
  const zigzag = Array.from({ length: 30 }, (_, k) => `${140 + 10 * k} ${k % 2 ? 500 : 520} l`).join(" ");
  addPage(["BT /F1 12 Tf 72 540 Td (Scribble:) Tj ET", `0 0 0 RG 1 w 130 500 m ${zigzag} S`], { Font: { F1: helv.ref } });
  const group = raw("1 g 0 0 612 792 re f 0 g BT /F1 28 Tf 100 500 Td (MASKSECRET 5521) Tj ET", {
    Type: "XObject", Subtype: "Form", BBox: [0, 0, 612, 792], Group: { S: "Transparency", CS: "DeviceGray" }, Resources: { Font: { F1: helv.ref } },
  });
  addPage(["q /GS1 gs 0 0 1 rg 0 0 612 792 re f Q", "BT /F1 12 Tf 72 700 Td (Visible text on page five) Tj ET"], {
    Font: { F1: helv.ref }, ExtGState: { GS1: { Type: "ExtGState", SMask: { Type: "Mask", S: "Luminosity", G: group } } },
  });

  const xmp = '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
    '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:xmpGImg="http://ns.adobe.com/xap/1.0/g/img/">' +
    '<dc:title><rdf:Alt><rdf:li xml:lang="x-default">Leak test title</rdf:li></rdf:Alt></dc:title>' +
    '<xmp:Thumbnails><rdf:Alt><rdf:li rdf:parseType="Resource"><xmpGImg:width>8</xmpGImg:width><xmpGImg:height>8</xmpGImg:height><xmpGImg:format>JPEG</xmpGImg:format>' +
    '<xmpGImg:image>XMPTHUMBSECRET/9j/4AAQSkZJRg==</xmpGImg:image></rdf:li></rdf:Alt></xmp:Thumbnails></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
  doc.catalog.set(PDFName.of("Metadata"), raw(xmp, { Type: "Metadata", Subtype: "XML" }));
  fs.writeFileSync(join(__dirname, "redact-leaks.pdf"), await doc.save({ useObjectStreams: false }));
  console.log("made redact-leaks.pdf");
}
