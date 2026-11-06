// Makes tests/fixtures/redact-test.pdf: text in several forms, pictures, shapes, a drawing inside a form, a link.
const { PDFDocument, StandardFonts, PDFName, PDFString } = require("pdf-lib");
const fs = require("fs");
// photo.jpg and logo.png: a 400x240 photo-like JPEG (blue-grey with a red band at x 40-360, y 80-160) and
// a 200x100 PNG with a green ellipse on a transparent background (made with Pillow).
const FX = process.argv[2] || "./";
(async () => {
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
  fs.writeFileSync(require("node:path").join(__dirname, "redact-test.pdf"), await doc.save({ useObjectStreams: false }));
  console.log("made");
})();
