// Makes tests/fixtures/redact-test.pdf: text in several forms, pictures, shapes, a drawing inside a form, a link;
// and tests/fixtures/redact-leaks.pdf: things an earlier version left in redacted copies (see makeLeaks below).
// Usage: node tests/fixtures/make-redact-test.cjs <folder with photo.jpg and logo.png>
// Needs Python with Pillow (built with libtiff and FreeType) for the fax-compressed scan.
const { PDFDocument, StandardFonts, PDFName, PDFString } = require("pdf-lib");
const fs = require("fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
// photo.jpg and logo.png: a 400x240 photo-like JPEG (blue-grey with a red band at x 40-360, y 80-160) and
// a 200x100 PNG with a green ellipse on a transparent background (made with Pillow).
const FX = process.argv[2] || "./";
(async () => {
  await makeMain();
  await makeLeaks();
  console.log("made");
})();

async function makeMain() {
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
  fs.writeFileSync(path.join(__dirname, "redact-test.pdf"), await doc.save({ useObjectStreams: false }));
}

/** A 1700x2200 one-bit scan with words on it, fax-compressed (CCITT Group 4) as one strip, made with Pillow. */
function faxScan() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plain-pdf-scan-"));
  const out = path.join(dir, "scan.g4");
  execFileSync("python3", ["-I", "-c", `
import sys
from PIL import Image, ImageDraw, ImageFont
im = Image.new("1", (1700, 2200), 1)
d = ImageDraw.Draw(im)
font = ImageFont.load_default(size=90)
d.text((200, 300), "SCAN SECRET 4417", font=font, fill=0)
d.text((200, 1500), "Scan visible line", font=font, fill=0)
tif = sys.argv[1] + ".tif"
im.save(tif, compression="group4", tiffinfo={278: 2200})
t = Image.open(tif)
offset, length = t.tag_v2[273][0], t.tag_v2[279][0]
open(sys.argv[1], "wb").write(open(tif, "rb").read()[offset:offset + length])
`, out]);
  const strip = fs.readFileSync(out);
  fs.rmSync(dir, { recursive: true, force: true });
  return strip;
}

/**
 * tests/fixtures/redact-leaks.pdf (612x792 pages). Each page holds something earlier versions left in the saved copy:
 * 1. A whole-page fax-compressed (CCITT) scan, which can't be painted, so the page is saved as a picture; plus a
 *    drawing (form) with words. The originals stayed listed in the page's resources and so stayed in the file.
 * 2. Shapes crossing boxes: a compound path of rectangles (like text turned into outlines), a long zig-zag line
 *    (like a drawn signature), rules (solid, dashed, a thin filled bar), a frame, a shape under a clip, a shape
 *    fully inside a box, a page-sized background and a curve away from the boxes. Shapes only partly under a box
 *    used to be kept whole.
 * 3. A curved line crossing a box (can't be cut safely, so the page is saved as a picture).
 * 4-5. Resources inherited from the page tree and shared by both pages: a picture drawn on page 4 only (its
 *    original must go), and one drawn under the box on page 4 and also on page 5 (its original must stay).
 * Pages 1 and 2 also have a thumbnail (/Thumb) and app-private data (/PieceInfo), which kept copies of the page.
 */
async function makeLeaks() {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const ctx = doc.context;
  const zlib = require("zlib");
  const page = (content, resources) => {
    const p = doc.addPage([612, 792]);
    p.node.set(PDFName.of("Contents"), ctx.register(ctx.flateStream(content)));
    if (resources) p.node.set(PDFName.of("Resources"), ctx.obj(resources));
    else p.node.delete(PDFName.of("Resources"));
    return p;
  };
  const extras = (p) => {
    const thumb = ctx.flateStream(Buffer.from("THUMBSECRET!".repeat(4), "latin1"), { Width: 4, Height: 4, ColorSpace: "DeviceRGB", BitsPerComponent: 8 });
    p.node.set(PDFName.of("Thumb"), ctx.register(thumb));
    const art = ctx.register(ctx.flateStream("PIECEINFOSECRET artwork copy"));
    p.node.set(PDFName.of("PieceInfo"), ctx.obj({ Illustrator: { LastModified: PDFString.of("D:20261101"), Private: ctx.register(ctx.obj({ AIPrivateData1: art })) } }));
  };

  // Page 1: the scan and a drawing with words.
  const strip = faxScan();
  const scan = ctx.register(ctx.stream(strip, {
    Type: "XObject", Subtype: "Image", Width: 1700, Height: 2200, ColorSpace: "DeviceGray", BitsPerComponent: 1,
    Filter: "CCITTFaxDecode", DecodeParms: { K: -1, Columns: 1700, Rows: 2200, BlackIs1: true },
  }));
  const form = ctx.register(ctx.stream("BT /F1 14 Tf 0 60 Td (FORMSECRET 7731) Tj ET BT /F1 14 Tf 0 0 Td (FORMOUTSIDE words) Tj ET", {
    Type: "XObject", Subtype: "Form", BBox: [0, 0, 300, 80], Resources: { Font: { F1: helv.ref } },
  }));
  extras(page("q 612 0 0 792 0 0 cm /Scan Do Q\nq 1 0 0 1 72 400 cm /Fm1 Do Q", { Font: { F1: helv.ref }, XObject: { Scan: scan, Fm1: form } }));

  // Page 2: shapes. Boxes (PDF coordinates): S1 x 250-350 y 600-680, S2 x 250-350 y 470-530, S3 x 250-350 y 400-460,
  // S4 x 280-320 y 290-350. Odd decimals make coordinates easy to look for in the saved file.
  const bars = [];
  for (let k = 0; k < 17; k++) bars.push(`${(200 + 12 * k + 0.111 * ((k % 9) + 1)).toFixed(3)} 620.5 6.25 40.75 re`);
  const zig = [];
  for (let i = 0; i <= 40; i++) zig.push(`${(80 + 11 * i + 0.137).toFixed(3)} ${(500 + 18 * Math.sin(i * 0.9) + 0.219).toFixed(3)} ${i === 0 ? "m" : "l"}`);
  extras(page([
    "0.95 g 0 0 612 792 re f",
    "0 g BT /F1 12 Tf 72 740 Td (Shapes page heading) Tj ET",
    `0 0 0 rg ${bars.join(" ")} 200.5 640.125 200 3.375 re f`,
    `q 0 0 0.6 RG 1.5 w 1 J 1 j ${zig.join(" ")} S Q`,
    "0 0 0 RG 0.75 w 72 430.25 m 540 430.25 l S",
    "[4 2] 0 d 72 415.5 m 540 415.5 l S [] 0 d",
    "0 g 72 445.2 468 1.1 re f",
    "0.5 w 200 405 200 50 re S",
    "0 0 1 rg 280.317 420.613 30.5 10.25 re f",
    "0 0 0 RG 72 300 m 100 350 150 350 180 300 c S",
    "q 240.25 300.25 120 40 re W n 0.8 0 0 rg 240.25 300.25 120 40 re f Q",
  ].join("\n"), { Font: { F1: helv.ref } }));

  // Page 3: a curved line (like a drawn signature) crossing a box (x 230-280, y 170-230).
  page([
    "BT /F1 12 Tf 72 740 Td (Curve page) Tj ET",
    "q 0 0 0.6 RG 1.2 w 100.731 200.419 m 150.853 260.947 200.163 140.271 250.577 200.389 c 300.991 260.507 350.613 140.829 400.241 200.653 c S Q",
  ].join("\n"), { Font: { F1: helv.ref } });

  // Pages 4 and 5: resources inherited from the page tree. A 64x16 grey picture, uniform except for bytes spelling
  // ORIGPIXELSECRET! in rows 4-11, columns 16-47, drawn on page 4 at 4 points per pixel (the box x 128-272, y 508-556
  // covers those pixels).
  const pixels = Buffer.alloc(64 * 16, 200);
  for (let r = 4; r < 12; r++) pixels.write("ORIGPIXELSECRET!ORIGPIXELSECRET!", r * 64 + 16, "latin1");
  const shared = ctx.register(ctx.stream(zlib.deflateSync(pixels), { Type: "XObject", Subtype: "Image", Width: 64, Height: 16, ColorSpace: "DeviceGray", BitsPerComponent: 8, Filter: "FlateDecode" }));
  // A 40x10 picture spelling KEPTPIXELS in every row, inside the box on page 4 and drawn again on page 5.
  const both = ctx.register(ctx.stream(zlib.deflateSync(Buffer.from("KEPTPIXELS".repeat(40), "latin1")), { Type: "XObject", Subtype: "Image", Width: 40, Height: 10, ColorSpace: "DeviceGray", BitsPerComponent: 8, Filter: "FlateDecode" }));
  page("BT /F1 12 Tf 72 740 Td (Shared resources page) Tj ET\nq 256 0 0 64 72 500 cm /Im9 Do Q\nq 40 0 0 10 160 525 cm /Im8 Do Q");
  page("BT /F1 12 Tf 72 740 Td (Page five keeps its words) Tj ET\nq 80 0 0 20 72 600 cm /Im8 Do Q");
  doc.catalog.Pages().set(PDFName.of("Resources"), ctx.register(ctx.obj({ Font: { F1: helv.ref }, XObject: { Im9: shared, Im8: both } })));

  fs.writeFileSync(path.join(__dirname, "redact-leaks.pdf"), await doc.save({ useObjectStreams: false }));
}
