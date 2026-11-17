// Makes tests/fixtures/audit-cases.pdf: the cases found by the November 2026 audit (see tests/e2e/audit.test.cjs).
//  page 1: a fax-style scan (a 1-bit CCITT picture, as office scanners make) reading "My SSN is 123-45-6789",
//          with a stamp ("FORMSECRET 987-65-4321") kept inside a form drawing
//  page 2: "outlined" words: one shape holding three word-sized blocks and two rings, filled in one go
//  page 3: a signature drawn as a zigzag of straight lines
//  page 4: a flourish drawn as one long curve
//  page 5: ordinary text over a tinted background, with an underline and a long rule, plus the extras older
//          PDFs carry: a preview picture of the page ("Thumb") and app-private data ("PieceInfo")
//  page 6: three lines set solid (line spacing = font size) in a font with tall letters
// Run from anywhere: node tests/fixtures/make-audit-cases.cjs
const { PDFDocument, StandardFonts, PDFName, PDFString } = require("pdf-lib");
const fs = require("fs");
const zlib = require("zlib");
const path = require("node:path");

// The scan: 1700 x 2200 dots (200 per inch), fax "Group 4" compressed. Made with Pillow:
//   img = Image.new("1", (1700, 2200), 1); d = ImageDraw.Draw(img)   (DejaVu Sans, 60 px)
//   d.text((200, 300), "Dear Sir or Madam,"); d.text((200, 500), "My SSN is 123-45-6789"); d.text((200, 700), "Kind regards")
//   d.rectangle((1200, 480, 1500, 580), fill=0); img.save("scan.tif", compression="group4", tiffinfo={278: 2200})
// and the single strip of the TIFF file copied out.
const SCAN_W = 1700;
const SCAN_H = 2200;
const SCAN = Buffer.from(
  "JqBkDU///////////////////////////////////////////////////////////////////////////////////////////////////////kDQFGEMkDjM" +
  "gZgskfkMkHGAiMBJDIEmQLz+VAZAYD7X4a//DXtfho0E//OA7QIgvY/+QIpQPa/huhnFnF/DaXa/7+9f7ZDPQhlUINf5Bm8hpTINX/5BihDN/IEUINcyDz/C" +
  "BkM9RAjAXIaWELgKCBkGMBe1yCVAgeQeogRgQYQfthMIPX9Qg9d6wg08IPCYT/Qaev6p69rpp6emn7p3rfqnrvXafemn+jMefFcTg98Tg6NCcTg//PitGYxz" +
  "4ricHR4f7QINzAYwhYfCGEHhD2vMBjCDzAYwm4TfukG4TdQfSTdb1wm0nhN0xT/04vTOoN9U9f4vTi9NP+l9MjAY0k3Xa+v1V/7bew/p/etunb3f+vww//7X" +
  "/6r//oN9Ldb16//+hkFxmDf0//kGBlOQIGf/4LkCcj/+1wXwX//C5Arp/+9YXwv/+uH//tdfX/113//etfX/6nAazQE7f//6NAT6NAT//wX//8fBfwX/69e/" +
  "/7XX9f/9r///6/r/+l1/9r79drX/++v+9fXq/r/6V///////+vrr9r7Xra6/+Em/yGsPXtpeP7//+ErIZx7Xhr//2tra/kLnkHIYYVsLwYS9hhL9sK2rYX/4" +
  "phkT4YXk4n4YX+GFhhYYX/4TGxPLxXsV+xPKxOKxPL/8J6+va/ra6//hNNe17X7W1tf/yMBrBBheDC8ML8MLawwv+sQYIMIRIK6BEGCERDCEGCEMIREVxERE" +
  "R+v/XrH//////////////////////////////////////8gdgZG4J///////////////////5A1eeQMw3IIZRGQPBUOQy0EMgDEyB4bnIZlPIZIPMgXmCIwM" +
  "5GBgzDQcBokDxzIGKyGhOQJ5kFwgI6ghMAuDCD+1CDCD/IH4YIMJrhPTCD/1W/BU4fhcINP7VV/7tddNP/RoJRoJv+aCueCUcXRoLqZi0Zk/9AiC9oEQXvxm" +
  "dgg8uC7+cBYCIOOQa+QQbQQf7Wgege+YFwQbF0vQQ1T0384s4tDQzi48J2/0tJtJ/7XSS78bdL6X6b/ev9v30vWqdf///yBIf/+l+m/7XIvENHft5BowEaw2" +
  "/pf1//vW9f/hP9L0v//tf/2/X//X//eu1u9/X0kv6tf//ervv5mJ0lS8qmSmr13/a9qw2Hv6CIYH9L4g0gQOrX/3reoOD7+h1CpcPT20v//vZ1BQdQL3+tIh" +
  "o1XvQasMJWv9rurIwM5GBn3/9V3p0xT/719MNh7f+lSXOCOJ8qtWv9r2oYYYf/elDXkcMOEG6DCtf3reg2G9v/Sh1iHp8EDbX/+1BsG/9g9Ig10S26bVNhhf" +
  "7XeiCuQQyiNv4PSBtfp6RmK4n1/evyCnQhm039nQGWrZFqrciVdqgg21/2vahw/fsHpPpd9PSCDYa/3renffww9J9d/+na//7Vtvvww9Jvr/1WwYJL+Pev38" +
  "hoI0viUA09+qcf9r9378gXppY+Pr//9r+/g3pf/X/771/fvpf/+l/Xa/t++l6+v//vX//pKQUsptKvX9rvVdv/Sr/W1r8djIaQ9EUet/9JdW1p6X/qGsNePI" +
  "g66RDNHXIOOlaXapf/BhKDCW/BpYShpcMK2qwwpDjhL/ak4mTif4MKQaVcmAh8IufEUMJUwwlOC//iorfivj4pilYqK/3qv6+F01TUL/pprfr66a2q/8GEDC" +
  "/DC8MLDCDCUMJheI0QV0EMtAiJDCBEgugSGg4YQgwRDKn6iIiIiP1/6+l6+QW0R/9fXwvH////////x/////////////////////////////////////////" +
  "//IZIEmEDxcIZIZ8/8hkg+ENH/+l/6X/pf+l/6Q/6X+Ev9L/S/0iCr5DL/IbXkHoQy/INFCDV5BPyDB/SIMYQ+BAwQPINGAoQMEDLwg9RBjAUEDwRrA6hr9B" +
  "eE0/UJp4QeqeE/S9NP1Qaenqnr6Xpp+qafeqevpcTg6MxjicHRmOjMY58VxODozGOZifS4TcIPCFAg2gg8wGMIYQdBEMD+l06T0kG6eE3ST0PFdPT1TpOL1T" +
  "111a9Jf9L/XvT+3Tt9P9//1//3zifWvXpfS/7f9Poe5AgZ07B+3//+C/wft///hf2dAOoKvb///X9g/b///X8MP2//5wGro0BP4Yft///wX+Q0Ee3///X+QL" +
  "09v/+/X/Bv2/7X21r7V/b/f3/Xff2//7tf//b/tf/Xtf2/39ttf3/2/7XshnHtbXtSIOvt/trsMKwwrYXbWDS9v+GF2GRPYnFhheGFgwvt/sTi7G1sTy7E4s" +
  "V7f7Xu117XXt/te01te117f7XhggYLDC9rDCxEREGCEQYIcMIRBghIYRiKQiP65A0DTHS4a8GEuPrawwsGCx////////////////////////////////////" +
  "////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////" +
  "////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////" +
  "////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////" +
  "/////////////////////////////////////////////////////////////////////////////////gAgAg==",
  "base64",
);

/** A ring (like the letter O): an outer circle and an inner one, as curves. */
function ring(cx, cy, r) {
  const k = 0.5523;
  const circle = (q) =>
    `${cx + q} ${cy} m ${cx + q} ${cy + k * q} ${cx + k * q} ${cy + q} ${cx} ${cy + q} c ${cx - k * q} ${cy + q} ${cx - q} ${cy + k * q} ${cx - q} ${cy} c ` +
    `${cx - q} ${cy - k * q} ${cx - k * q} ${cy - q} ${cx} ${cy - q} c ${cx + k * q} ${cy - q} ${cx + q} ${cy - k * q} ${cx + q} ${cy} c h`;
  return `${circle(r)} ${circle(r * 0.55)}`;
}

(async () => {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const ctx = doc.context;
  const page = (content, resources) => {
    const p = doc.addPage([612, 792]);
    p.node.set(PDFName.of("Contents"), ctx.register(ctx.flateStream(content.join("\n"))));
    p.node.set(PDFName.of("Resources"), ctx.obj(resources));
    return p;
  };

  // ---- Page 1: the scan and the stamp.
  const scan = ctx.register(
    ctx.stream(new Uint8Array(SCAN), {
      Type: "XObject", Subtype: "Image", Width: SCAN_W, Height: SCAN_H, ColorSpace: "DeviceGray", BitsPerComponent: 1,
      Filter: "CCITTFaxDecode", DecodeParms: { K: -1, Columns: SCAN_W, Rows: SCAN_H, BlackIs1: true },
    }),
  );
  const stamp = ctx.register(ctx.stream("BT /F1 12 Tf 0 0 Td (FORMSECRET 987-65-4321) Tj ET", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 300, 20], Resources: { Font: { F1: helv.ref } } }));
  page(["q 612 0 0 792 0 0 cm /Scan Do Q", "q 1 0 0 1 72 100 cm /Stamp Do Q"], { Font: { F1: helv.ref }, XObject: { Scan: scan, Stamp: stamp } });

  // ---- Page 2: outlined words. Blocks at x 72-150, 200.123-300.456 (the secret one) and 350-430; a ring inside
  // the secret block's area (centre 250.777, 680.111) and one well away from it (centre 400.555, 680.222).
  page(
    [
      "0 0 0 rg",
      `72 700 78 14 re 200.123 700.456 100.333 14 re 350 700 80 14 re ${ring(250.777, 680.111, 8)} ${ring(400.555, 680.222, 8)}`,
      "f",
      "BT /F1 12 Tf 72 640 Td (Outlined words above) Tj ET",
    ],
    { Font: { F1: helv.ref } },
  );

  // ---- Page 3: a signature: a zigzag of straight lines from x 100 to 500.
  let zigzag = "100 520 m";
  for (let k = 1; k <= 40; k++) zigzag += ` ${100 + k * 10}.777 ${520 + (k % 2 ? 18 : -18)}.321 l`;
  page(["0 0 0.6 RG 1.5 w", zigzag, "S", "BT /F1 12 Tf 72 640 Td (A drawn signature below) Tj ET"], { Font: { F1: helv.ref } });

  // ---- Page 4: a flourish: one curve from (120, 480) to (480, 470); its middle is near (300, 479).
  page(["0 0 0.6 RG 1.5 w", "120 480 m 220.111 440.222 380.333 520.444 480 470 c S", "BT /F1 12 Tf 72 640 Td (A curved flourish below) Tj ET"], { Font: { F1: helv.ref } });

  // ---- Page 5: text, simple shapes that cross the name (a tinted background, an underline, a rule), and the extras.
  const p4 = page(
    [
      "0.96 0.96 0.9 rg 0 0 612 792 re f",
      "0 0 0 rg",
      "BT /F1 14 Tf 72 700 Td (Patient name: JOHN Q SECRETNAME) Tj ET",
      "72 696 400 0.8 re f",
      "0 G 0.5 w 40 707 m 570 707 l S",
      "BT /F1 14 Tf 72 670 Td (Nothing private on this line) Tj ET",
    ],
    { Font: { F1: helv.ref } },
  );
  const tw = 61;
  const th = 79;
  const pixels = Buffer.alloc(tw * th, 255);
  for (let x = 5; x < 55; x++) pixels[9 * tw + x] = 0;
  p4.node.set(PDFName.of("Thumb"), ctx.register(ctx.stream(new Uint8Array(zlib.deflateSync(pixels)), { Width: tw, Height: th, ColorSpace: "DeviceGray", BitsPerComponent: 8, Filter: "FlateDecode" })));
  const artwork = ctx.register(ctx.stream("%AI-private copy of the artwork: Patient name: JOHN Q SECRETNAME", {}));
  p4.node.set(PDFName.of("PieceInfo"), ctx.obj({ Illustrator: { Private: artwork, LastModified: PDFString.of("D:20260101000000Z") } }));

  // ---- Page 6: tightly set lines in a font with tall letters (the height figures of Open Sans and Noto Sans;
  // widths as Helvetica's; not embedded, so readers show a stand-in font).
  const widths = [];
  for (let c = 32; c <= 126; c++) widths.push(helv.widthOfTextAtSize(String.fromCharCode(c), 1000));
  const descriptor = ctx.register(ctx.obj({ Type: "FontDescriptor", FontName: "TallSans", Flags: 32, FontBBox: [-550, -293, 1447, 1069], ItalicAngle: 0, Ascent: 1069, Descent: -293, CapHeight: 714, StemV: 80 }));
  const tall = ctx.register(ctx.obj({ Type: "Font", Subtype: "TrueType", BaseFont: "TallSans", FirstChar: 32, LastChar: 126, Widths: widths, FontDescriptor: descriptor, Encoding: "WinAnsiEncoding" }));
  page(["BT /T1 20 Tf 20 TL 72 700 Td (Heading line one here) Tj T* (Heading line two here) Tj T* (Heading line three here) Tj ET"], { Font: { T1: tall } });

  fs.writeFileSync(path.join(__dirname, "audit-cases.pdf"), await doc.save({ useObjectStreams: false }));
  console.log("made audit-cases.pdf");
})();
