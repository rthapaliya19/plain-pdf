// Browser tests for redaction: the Redact tool, and what's removed from saved copies.
// Needs Python with pypdf, and poppler (pdftotext, pdftoppm).
// tests/fixtures/redact-test.pdf (made with pdf-lib) has on page 1: plain text, text with kerning (TJ),
// text with letter/word spacing (the ' operator), a photo (JPEG) with invisible "OCR" text over it,
// a logo with transparency (PNG), a blue rectangle and a long line, text inside a form drawing,
// a hidden ActualText copy of a span, and a web link; on page 2 an inline picture.
// tests/fixtures/redact-leaks.pdf has what earlier versions left in saved copies (a fax-compressed scan and a
// drawing's words on a page saved as a picture, shapes partly under boxes, page thumbnails and app-private data,
// pictures listed in resources shared between pages); those checks search every object in the saved file,
// with streams decoded, not just what the pages still show.
// Run `npm run preview` first, then: node tests/e2e/redact.test.cjs [screenshot-folder]
const { chromium, devices } = require("playwright");
const { execFileSync } = require("node:child_process");
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { PDFDocument, StandardFonts } = require("pdf-lib");

const APP = process.env.APP_URL || "http://127.0.0.1:4173/";
const SHOTS = process.argv[2] || join(tmpdir(), "plain-pdf-screenshots");
mkdirSync(SHOTS, { recursive: true });
const pdf = (name) => join(__dirname, "..", "fixtures", name);
const results = [];
const check = (name, ok, extra = "") => results.push(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  (" + extra + ")" : ""}`);

async function watch(page, label) {
  const problems = [];
  page.on("pageerror", (e) => problems.push(`[${label}] pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") problems.push(`[${label}] console.${m.type()}: ${m.text()}`);
  });
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
    window.__saves = [];
    window.showSaveFilePicker = async (o) => {
      const entry = { name: o.suggestedName, bytes: null };
      window.__saves.push(entry);
      return { name: o.suggestedName, createWritable: async () => ({ write: async (b) => (entry.bytes = Array.from(new Uint8Array(await b.arrayBuffer()))), close: async () => {} }) };
    };
  });
  return problems;
}
const box = (page, sel) => page.$eval(sel, (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; });
const count = (page, sel) => page.locator(sel).count();
async function drag(page, from, to, steps = 8) {
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await page.mouse.move(to[0], to[1], { steps });
  await page.mouse.up();
}
/** Words and their positions (points from the top-left), page by page, as poppler reads them. */
function words(file) {
  const html = execFileSync("pdftotext", ["-bbox", file, "-"]).toString();
  const pages = html.split("<page ").slice(1);
  return pages.map((p) => [...p.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g)].map((m) => ({ x0: +m[1], y0: +m[2], x1: +m[3], y1: +m[4], text: m[5] })));
}
const py = (code, file) => execFileSync("python3", ["-I", "-c", `import sys, json\nfrom pypdf import PdfReader\nr = PdfReader(sys.argv[1])\n${code}`, file]).toString().trim();

(async () => {
  const before = words(pdf("redact-test.pdf"));
  const w = (text) => before[0].find((x) => x.text === text);
  const helv = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
  const width = (text, size) => helv.widthOfTextAtSize(text, size);

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const problems = await watch(page, "desktop");
  await page.goto(APP);
  await page.evaluate(() => localStorage.clear());
  await page.setInputFiles("input[type=file]", pdf("redact-test.pdf"));
  await page.waitForSelector('.page[data-page="1"] .page-canvas');
  // Zoom out so the whole first page is on screen.
  for (let k = 0; k < 3; k++) await page.click('button[title^="Zoom out"]');
  await page.waitForTimeout(400);
  await page.$eval(".viewer", (v) => (v.scrollTop = 0));
  await page.waitForTimeout(200);
  let pg = await box(page, '.page[data-page="1"]');
  let s = pg.w / 612;
  const at = (x, y) => [pg.x + x * s, pg.y + y * s];
  const boxOver = async (x0, y0, x1, y1) => drag(page, at(x0, y0), at(x1, y1));

  await page.click('button[aria-label="More"]');
  check("More menu has Redact", await page.isVisible(".menu-item >> text=Redact"));
  await page.click(".menu-item >> text=Redact");
  check("Redact turns on with its strip and Done", (await page.isVisible(".redact-options")) && (await page.isVisible(".redact-options .done-button")));
  check("first time: explains that what's under the boxes is removed when saving", (await page.textContent(".toast"))?.includes("removed for good"));

  // A tap without dragging adds nothing.
  await page.mouse.click(...at(400, 700));
  check("a tap doesn't add a box", (await count(page, 'rect[data-kind="redact"]')) === 0);

  // The boxes.
  const A = w("12345678");
  await boxOver(A.x0 - 1, A.y0 - 1, A.x1 + 1, A.y1 + 1);
  check("dragging draws a black box", (await count(page, 'rect[data-kind="redact"]')) === 1 && (await page.$eval('rect[data-kind="redact"]', (r) => r.getAttribute("fill"))) === "#000000");
  const AB = w("ALPHABRAVO");
  const alphaEnd = AB.x0 + width("ALPHA", 12);
  await boxOver(AB.x0 - 1, AB.y0 - 1, alphaEnd - 0.5, AB.y1 + 1);
  await boxOver(w("555").x0 - 1, w("555").y0 - 1, w("0100").x1 + 1, w("0100").y1 + 1);
  await boxOver(315, 252, 460, 312); // over the photo, and the invisible words on it
  await boxOver(95, 467, 145, 497); // around the blue rectangle
  await boxOver(w("42").x0 - 1, w("42").y0 - 1, w("42").x1 + 1, w("42").y1 + 1);
  // The span's line is drawn with letter spacing 0.5 and word spacing 2 (set on an earlier line).
  const spanX = 72 + width("Visible ", 12) + 8 * 0.5 + 2;
  await boxOver(spanX - 0.5, 792 - 180 - 11, spanX + width("span", 12) + 4 * 0.5 + 1, 792 - 180 + 4);
  await boxOver(122, 290, 175, 345); // the right half of the logo (it has see-through parts)
  await boxOver(420, 572, 460, 632); // part of the picture stored with row predictors
  check("nine boxes", (await count(page, 'rect[data-kind="redact"]')) === 9);

  // An extra box: select, move, resize, remove, undo.
  await boxOver(400, 640, 460, 660);
  check("ten boxes", (await count(page, 'rect[data-kind="redact"]')) === 10);
  await page.click(".redact-options .done-button");
  check("Done turns Redact off", !(await page.isVisible(".redact-options")));
  const extra = await page.$$eval(".sig-box.redact-box", (bs) => { const r = bs[bs.length - 1].getBoundingClientRect(); return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, x: r.left, y: r.top, w: r.width, h: r.height }; });
  await page.mouse.click(extra.cx, extra.cy);
  check("a box can be selected", (await count(page, ".sig-box.redact-box.selected")) === 1);
  await drag(page, [extra.cx, extra.cy], [extra.cx + 30, extra.cy + 20]);
  const moved = await box(page, ".sig-box.redact-box.selected");
  check("...moved", Math.abs(moved.x - extra.x - 30) < 2 && Math.abs(moved.y - extra.y - 20) < 2);
  const handle = await box(page, ".sig-box.redact-box.selected .sig-handle");
  await drag(page, [handle.cx, handle.cy], [handle.cx + 40, handle.cy + 25]);
  const resized = await box(page, ".sig-box.redact-box.selected");
  check("...resized (any shape)", Math.abs(resized.w - moved.w - 40) < 3 && Math.abs(resized.h - moved.h - 25) < 3, `${Math.round(resized.w - moved.w)}x${Math.round(resized.h - moved.h)}`);
  await page.click(".sig-box.redact-box.selected .sig-delete");
  check("...and removed with ×", (await count(page, 'rect[data-kind="redact"]')) === 9);
  await page.keyboard.press("Control+z");
  check("undo brings it back", (await count(page, 'rect[data-kind="redact"]')) === 10);
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+z");
  check("undo also takes back the resize, the move and the box itself", (await count(page, 'rect[data-kind="redact"]')) === 9);
  await page.screenshot({ path: `${SHOTS}/redact-d1-boxes.png` });

  // Page 2: over the inline picture (that page is then saved as a picture).
  await page.fill(".page-input", "2");
  await page.press(".page-input", "Enter");
  await page.waitForTimeout(400);
  pg = await box(page, '.page[data-page="2"]');
  s = pg.w / 612;
  await page.click('button[aria-label="More"]');
  await page.click(".menu-item >> text=Redact");
  await boxOver(100, 220, 140, 260);
  await page.keyboard.press("Escape");
  check("Esc turns Redact off", !(await page.isVisible(".redact-options")));

  // ----- Save -----
  await page.click("button.save-button");
  await page.waitForFunction(() => window.__saves.length === 1 && window.__saves[0].bytes, null, { timeout: 60000 });
  const file = join(SHOTS, "redacted.pdf");
  writeFileSync(file, Buffer.from(await page.evaluate(() => window.__saves[0].bytes)));
  const toast = await page.textContent(".toast");
  check("saving says page 2 was saved as a picture", toast.includes("Page 2 was saved as a picture"), toast);
  const after = words(file);
  const text1 = after[0].map((x) => x.text).join(" ");
  for (const secret of ["12345678", "ALPHA", "555", "0100", "HIDDEN", "OCR", "WORDS", "42", "SECRETACTUAL", "span"]) {
    check(`"${secret}" is gone from the saved text`, !text1.includes(secret), text1);
  }
  for (const kept of ["Account", "number", "belongs", "Jane", "BRAVO", "Phone", "here", "First", "Inside", "form", "Visible", "Untouched", "closing"]) {
    check(`"${kept}" is still there`, text1.includes(kept));
  }
  const same = (t, o) => { const a = after[0].find((x) => x.text === t); return a && Math.abs(a.x0 - o) < 0.6; };
  check("words after a removed word stay exactly in place (plain text)", same("belongs", w("belongs").x0) && same("Jane", w("Jane").x0));
  check("...(kerned text)", same("BRAVO", alphaEnd - 1.44), `${after[0].find((x) => x.text === "BRAVO")?.x0} vs ${alphaEnd - 1.44}`);
  check("...(letter and word spacing)", same("here", w("here").x0));
  check("page 2 has no readable text left (it's a picture)", after[1].length === 0 && py("print(len(r.pages[1].images))", file) === "1");

  // Nothing recoverable anywhere in the file: every stream, decoded, searched as text and as hex.
  const leftovers = py(`
secrets = [b"12345678", b"ALPHA", b"555 0100", b"OCR WORDS", b"SECRETACTUAL", b"Page two"]
found = []
for num in range(1, int(r.trailer["/Size"])):
    try:
        obj = r.get_object(num)
    except Exception:
        continue
    if hasattr(obj, "get_data"):
        try:
            data = obj.get_data()
        except Exception:
            continue
        for s in secrets:
            if s in data or s.hex().encode() in data.lower():
                found.append(s.decode())
print(json.dumps(sorted(set(found))))`, file);
  check("no removed words hidden anywhere in the file (text or hex)", leftovers === "[]", leftovers);
  const content = py("print(r.pages[0].get_contents().get_data().decode('latin1'))", file);
  check("the blue rectangle under a box is gone", !content.includes("100 300 40 20 re"));
  check("the long line crossing a box is kept", content.includes("72 280 m"));
  check("the web link under a box is removed", py("print(len(r.pages[0].get('/Annots') or []))", file) === "0");

  // The photo: painted black under the box, untouched elsewhere.
  const pix = JSON.parse(py(`
import io
from PIL import Image
imgs = [i for i in r.pages[0].images if i.image.size == (400, 240)]
im = imgs[0].image.convert("RGB")
print(json.dumps({"inside": im.getpixel((200, 120)), "red": im.getpixel((340, 120)), "background": im.getpixel((10, 10)), "n": len(r.pages[0].images)}))`, file));
  check("the photo's pixels under the box are painted black", pix.inside.every((c) => c < 40), JSON.stringify(pix.inside));
  check("...and the rest of the photo is unchanged", pix.red[0] > 180 && pix.red[1] < 70 && pix.background[2] > 200, JSON.stringify(pix));
  check("the page still has its 3 pictures (painted copies replace the originals)", pix.n === 3);
  const more = JSON.parse(py(`
logo = [i for i in r.pages[0].images if i.image.size == (200, 100)][0].image
pred = [i for i in r.pages[0].images if i.image.size == (100, 80)][0].image.convert("RGB")
print(json.dumps({"logoMode": logo.mode, "logoLeft": logo.getpixel((50, 50)), "logoRight": logo.getpixel((150, 50)), "logoCorner": logo.getpixel((195, 5)), "logoClear": logo.getpixel((5, 5)),
  "predWhite": pred.getpixel((10, 40)), "predBlue": pred.getpixel((90, 5)), "predBox": pred.getpixel((40, 40))}))`, file));
  // The box covers the logo's right half (x 100-200 of 200). Left half: green ellipse on see-through.
  check("logo: under the box painted black and made solid", [more.logoRight, more.logoCorner].every((p) => p.length === 4 && p.slice(0, 3).every((c) => c < 40) && p[3] === 255), JSON.stringify(more));
  check("logo: the rest unchanged (green, and see-through around it)", more.logoLeft[1] > 100 && more.logoLeft[0] < 60 && more.logoLeft[3] === 255 && more.logoClear[3] === 0, JSON.stringify(more));
  check("row-predicted picture: painted under the box, the rest unchanged", more.predBox.every((c) => c < 40) && more.predWhite.every((c) => c > 240) && more.predBlue[2] > 100 && more.predBlue[0] < 40, JSON.stringify(more));
  // The original page again, to compare: the copy shows black boxes where the words were.
  execFileSync("pdftoppm", ["-r", "50", "-png", "-f", "1", "-l", "1", "-singlefile", file, join(SHOTS, "redact-d2-saved")]);

  check("desktop: no privacy-lock violations", (await page.evaluate(() => window.__csp)).length === 0);
  check("desktop: no errors or warnings", problems.length === 0, problems.join(" | "));
  await ctx.close();

  // ----- A scanned letter (one big picture): painted under the box, still a scan -----
  const sctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  const sc = await sctx.newPage();
  const scp = await watch(sc, "scan");
  await sc.goto(APP);
  await sc.setInputFiles("input[type=file]", pdf("scanned-letter.pdf"));
  await sc.waitForSelector(".page-canvas");
  const spg = await box(sc, '.page[data-page="1"]');
  const ss = spg.w / 612;
  await sc.click('button[aria-label="More"]');
  await sc.click(".menu-item >> text=Redact");
  await drag(sc, [spg.x + 150 * ss, spg.y + 163 * ss], [spg.x + 260 * ss, spg.y + 180 * ss]);
  await sc.click(".redact-options .done-button");
  await sc.click("button.save-button");
  await sc.waitForFunction(() => window.__saves.length === 1 && window.__saves[0].bytes, null, { timeout: 60000 });
  const sfile = join(SHOTS, "redacted-scan.pdf");
  writeFileSync(sfile, Buffer.from(await sc.evaluate(() => window.__saves[0].bytes)));
  check("scan: saved without turning the page into a new picture", !(await sc.textContent(".toast")).includes("picture"));
  const scan = JSON.parse(py(`
im = r.pages[0].images[0].image.convert("RGB")
k = im.size[0] / 612
print(json.dumps({"n": len(r.pages[0].images), "size": im.size, "inside": im.getpixel((int(205 * k), int(171 * k))), "outside": im.getpixel((int(300 * k), int(171 * k)))}))`, sfile));
  check("scan: the pixels under the box are black, the rest unchanged", scan.n === 1 && scan.size[0] === 1275 && scan.inside.every((c) => c < 40) && scan.outside.some((c) => c > 150), JSON.stringify(scan));
  check("scan: no errors or warnings", scp.length === 0, scp.join(" | "));
  await sctx.close();

  // ----- After reorganizing: the box goes with its page -----
  const octx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  const o = await octx.newPage();
  const op = await watch(o, "organize");
  await o.goto(APP);
  await o.setInputFiles("input[type=file]", pdf("sample-25-pages.pdf"));
  await o.waitForSelector('.page[data-page="2"] .page-canvas');
  await o.fill(".page-input", "2");
  await o.press(".page-input", "Enter");
  await o.waitForTimeout(400);
  const p2 = await box(o, '.page[data-page="2"]');
  const s2 = p2.w / 612;
  await o.click('button[aria-label="More"]');
  await o.click(".menu-item >> text=Redact");
  // Page 2's subtitle "Page 2 of 25": cover it.
  const p2words = words(pdf("sample-25-pages.pdf"))[1];
  const subY = p2words.find((x) => x.text === "Page").y0;
  const sub = p2words.filter((x) => Math.abs(x.y0 - subY) < 1);
  await drag(o, [p2.x + (sub[0].x0 - 2) * s2, p2.y + (sub[0].y0 - 2) * s2], [p2.x + (sub[sub.length - 1].x1 + 2) * s2, p2.y + (sub[0].y1 + 2) * s2]);
  await o.click(".redact-options .done-button");
  await o.click('button[aria-label="More"]');
  await o.click(".menu-item >> text=Organize pages");
  await o.waitForSelector(".organize .tile .thumb canvas");
  await o.click('.organize .tile[data-pos="0"]');
  await o.click(".organize-actions button[data-action='Delete']");
  await o.click(".organize .done-button");
  await o.waitForTimeout(400);
  await o.click("button.save-button");
  await o.waitForFunction(() => window.__saves.length === 1 && window.__saves[0].bytes, null, { timeout: 60000 });
  const ofile = join(SHOTS, "redacted-organized.pdf");
  writeFileSync(ofile, Buffer.from(await o.evaluate(() => window.__saves[0].bytes)));
  const ow = words(ofile);
  check("after deleting page 1, the box is on (old) page 2, now first: its words are gone", ow.length === 24 && !ow[0].some((x) => x.text === "of" || x.text === "25") && ow[0][0].text === "Sample", ow[0].slice(0, 6).map((x) => x.text).join(" "));
  check("...and the next page is untouched", ow[1].some((x) => x.text === "3") && ow[1].some((x) => x.text === "25"));
  check("organize: no errors or warnings", op.length === 0, op.join(" | "));
  await octx.close();

  // ----- Things earlier versions left in the saved file (tests/fixtures/redact-leaks.pdf, see make-redact-test.cjs) -----
  const lctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  const L = await lctx.newPage();
  const lp = await watch(L, "leaks");
  await L.goto(APP);
  await L.setInputFiles("input[type=file]", pdf("redact-leaks.pdf"));
  await L.waitForSelector('.page[data-page="1"] .page-canvas');
  for (let k = 0; k < 3; k++) await L.click('button[title^="Zoom out"]');
  await L.waitForTimeout(400);
  /** A box on page n over x0..x1, y0..y1 in the page's PDF coordinates (points from the bottom-left). */
  const redactAt = async (n, x0, y0, x1, y1) => {
    await L.fill(".page-input", String(n));
    await L.press(".page-input", "Enter");
    await L.waitForTimeout(400);
    const p = await box(L, `.page[data-page="${n}"]`);
    const k = p.w / 612;
    await L.click('button[aria-label="More"]');
    await L.click(".menu-item >> text=Redact");
    await drag(L, [p.x + x0 * k, p.y + (792 - y1) * k], [p.x + x1 * k, p.y + (792 - y0) * k]);
    await L.click(".redact-options .done-button");
  };
  const BOXES = {
    1: [[60, 642, 400, 697], [66, 452, 210, 478]], // the scan's words; the drawing's first line
    2: [[250, 600, 350, 680], [250, 470, 350, 530], [250, 400, 350, 460], [280, 290, 320, 350]],
    3: [[230, 170, 280, 230]],
    4: [[128, 508, 272, 556]],
  };
  for (const [n, list] of Object.entries(BOXES)) for (const b of list) await redactAt(+n, ...b);
  check("leaks: eight boxes", (await count(L, 'rect[data-kind="redact"]')) === 8);
  await L.click("button.save-button");
  await L.waitForFunction(() => window.__saves.length === 1 && window.__saves[0].bytes, null, { timeout: 60000 });
  const lfile = join(SHOTS, "redacted-leaks.pdf");
  writeFileSync(lfile, Buffer.from(await L.evaluate(() => window.__saves[0].bytes)));
  const ltoast = await L.textContent(".toast");
  check("leaks: pages 1 (fax scan) and 3 (curve across a box) saved as pictures, 2 and 4 not", ltoast.includes("Pages 1, 3 were saved as a picture"), ltoast);

  // Every object in the file, streams decoded, plus every stream found directly in the file's bytes.
  const scanAll = JSON.parse(py(`
import re, zlib, logging
logging.disable(logging.CRITICAL)
from pypdf.generic import DictionaryObject, ArrayObject, IndirectObject
raw = open(sys.argv[1], "rb").read()
orig = PdfReader(${JSON.stringify(pdf("redact-leaks.pdf"))})
strip = orig.pages[0]["/Resources"]["/XObject"]["/Scan"].get_object()._data
blobs, keys, filters = [raw], set(), set()
def walk(o):
    if isinstance(o, DictionaryObject):
        for k, v in o.items():
            keys.add(str(k))
            if not isinstance(v, IndirectObject): walk(v)
    elif isinstance(o, ArrayObject):
        for v in o:
            if not isinstance(v, IndirectObject): walk(v)
for num in range(1, int(r.trailer["/Size"])):
    try:
        obj = r.get_object(num)
    except Exception:
        continue
    if obj is None:
        continue
    walk(obj)
    if hasattr(obj, "get_data"):
        f = obj.get("/Filter")
        for x in (f if isinstance(f, list) else [f] if f else []): filters.add(str(x))
        blobs.append(obj._data)
        try:
            blobs.append(obj.get_data())
        except Exception:
            pass
    else:
        blobs.append(repr(obj).encode("latin1", "replace"))
for m in re.finditer(rb"stream\\r?\\n(.*?)endstream", raw, re.S):
    try:
        blobs.append(zlib.decompress(m.group(1)))
    except Exception:
        pass
secrets = ["FORMSECRET", "FORMOUTSIDE", "THUMBSECRET", "PIECEINFOSECRET", "ORIGPIXELSECRET", "KEPTPIXELS",
  # page 2: bars and zig-zag points inside boxes, the shape fully inside a box, the clipped shape's original rectangle
  ${[5, 6, 7, 8, 9, 10, 11].map((k) => `"${(200 + 12 * k + 0.111 * ((k % 9) + 1)).toFixed(3)}"`).join(", ")},
  ${[16, 17, 18, 19, 20, 21, 22, 23, 24].map((i) => `"${(80 + 11 * i + 0.137).toFixed(3)} ${(500 + 18 * Math.sin(i * 0.9) + 0.219).toFixed(3)}"`).join(", ")},
  "280.317", "420.613", "240.25 300.25 120 40 re",
  # page 3: every number of the curve
  "100.731", "200.419", "150.853", "260.947", "200.163", "140.271", "250.577", "200.389", "300.991", "260.507", "350.613", "140.829", "400.241", "200.653"]
found = sorted({s for s in secrets for b in blobs if s.encode() in b})
print(json.dumps({"found": found, "strip": any(strip[:2000] in b or strip[-2000:] in b for b in blobs), "ccitt": "/CCITTFaxDecode" in filters,
  "thumb": "/Thumb" in keys, "pieceinfo": "/PieceInfo" in keys, "objects": len(blobs)}))`, lfile));
  check("leaks: the fax-compressed scan is gone from the file (no CCITT stream, none of its bytes)", !scanAll.strip && !scanAll.ccitt, JSON.stringify(scanAll));
  check("leaks: the drawing's words are gone from the file (both lines; that page is a picture)", !scanAll.found.some((s) => s.startsWith("FORM")), scanAll.found.join(" "));
  check("leaks: no /Thumb or /PieceInfo anywhere, nor their data", !scanAll.thumb && !scanAll.pieceinfo && !scanAll.found.includes("THUMBSECRET") && !scanAll.found.includes("PIECEINFOSECRET"), JSON.stringify(scanAll));
  check("leaks: no coordinates of shapes under the boxes anywhere in the file", !scanAll.found.some((s) => /^\d/.test(s)), scanAll.found.join(" | "));
  check("leaks: the original of a picture listed in resources shared with another page is gone", !scanAll.found.includes("ORIGPIXELSECRET"), scanAll.found.join(" "));
  check("leaks: ...but a picture another page still draws stays (only pictures nothing draws are dropped)", scanAll.found.includes("KEPTPIXELS"), scanAll.found.join(" "));
  check("leaks: the file was scanned object by object", scanAll.objects > 10, String(scanAll.objects));

  const lpages = JSON.parse(py(`
out = []
for p in r.pages:
    xo = p["/Resources"].get("/XObject") or {}
    out.append({"images": [list(i.image.size) for i in p.images], "xobjects": sorted(xo.keys()), "streams": len(p.get_contents().get_data())})
print(json.dumps(out))`, lfile));
  const lwords = words(lfile).map((ws) => ws.map((x) => x.text).join(" "));
  check("leaks: page 1 is just a picture of the page (no words, no scan or drawing left in its resources)", lwords[0] === "" && lpages[0].images.length === 1 && lpages[0].xobjects.length === 1 && lpages[0].images[0][0] > 1000, JSON.stringify(lpages[0]));
  check("leaks: page 3 is just a picture too", lwords[2] === "" && lpages[2].images.length === 1 && lpages[2].xobjects.length === 1, JSON.stringify(lpages[2]));
  check("leaks: pages 2, 4 and 5 keep their words", lwords[1] === "Shapes page heading" && lwords[3] === "Shared resources page" && lwords[4] === "Page five keeps its words", JSON.stringify(lwords));

  // Page 2: no drawn shape has any part inside a box (all of the page's drawing instructions, followed through q/Q/cm).
  const shapes = JSON.parse(py(`
from pypdf.generic import ContentStream
boxes = ${JSON.stringify(BOXES[2].map(([x0, y0, x1, y1]) => [x0 + 2, y0 + 2, x1 - 2, y1 - 2]))}
def mul(a, b):
    return [a[0]*b[0]+a[1]*b[2], a[0]*b[1]+a[1]*b[3], a[2]*b[0]+a[3]*b[2], a[2]*b[1]+a[3]*b[3], a[4]*b[0]+a[5]*b[2]+b[4], a[4]*b[1]+a[5]*b[3]+b[5]]
def ap(m, x, y): return (m[0]*x+m[2]*y+m[4], m[1]*x+m[3]*y+m[5])
def line_in(p, q, b):
    t0, t1 = 0.0, 1.0
    dx, dy = q[0]-p[0], q[1]-p[1]
    for pp, qq in ((-dx, p[0]-b[0]), (dx, b[2]-p[0]), (-dy, p[1]-b[1]), (dy, b[3]-p[1])):
        if pp == 0:
            if qq < 0: return False
        else:
            t = qq / pp
            if pp < 0: t0 = max(t0, t)
            else: t1 = min(t1, t)
    return t1 > t0
page = r.pages[1]
ops = ContentStream(page.get_contents(), r).operations
ctm, stack, segs, cur, start, bad, dashes = [1,0,0,1,0,0], [], [], None, None, [], []
for args, op in ops:
    op = op.decode()
    a = [float(x) for x in args] if op in ("cm","m","l","c","v","y","re") else args
    if op == "q": stack.append(ctm)
    elif op == "Q": ctm = stack.pop()
    elif op == "cm": ctm = mul(a, ctm)
    elif op == "d": dashes.append(float(args[1]))
    elif op == "m": cur = start = ap(ctm, a[0], a[1])
    elif op == "l":
        q = ap(ctm, a[0], a[1]); segs.append(("l", cur, q)); cur = q
    elif op in ("c", "v", "y"):
        pts = [ap(ctm, a[i], a[i+1]) for i in range(0, len(a), 2)]
        segs.append(("c", cur, *pts)); cur = pts[-1]
    elif op == "h":
        if cur and start: segs.append(("l", cur, start)); cur = start
    elif op == "re":
        x, y, w, h = a
        c = [ap(ctm, x, y), ap(ctm, x+w, y), ap(ctm, x+w, y+h), ap(ctm, x, y+h)]
        for i in range(4): segs.append(("l", c[i], c[(i+1) % 4]))
        cur = start = c[0]
    elif op in ("S","s","f","F","f*","B","B*","b","b*","n"):
        for s in segs:
            for b in boxes:
                if s[0] == "l" and line_in(s[1], s[2], b): bad.append([op, s])
                if s[0] == "c":
                    xs = [p[0] for p in s[1:]]; ys = [p[1] for p in s[1:]]
                    if max(xs) > b[0] and min(xs) < b[2] and max(ys) > b[1] and min(ys) < b[3]: bad.append([op, s])
        segs, cur, start = [], None, None
text = page.get_contents().get_data().decode("latin1")
print(json.dumps({"bad": bad[:5], "nbad": len(bad), "dashes": dashes, "text": text}))`, lfile));
  check("leaks: no shape on page 2 has any part inside a box", shapes.nbad === 0, JSON.stringify(shapes.bad));
  const has = (s) => shapes.text.includes(s);
  check("leaks: the page-sized background stays whole", has("0 0 612 792 re"));
  check("leaks: rules crossing a box keep both outer ends", has("72 430.25 m") && has("540 430.25 l") && has("72 415.5 m") && has("540 415.5 l"));
  check("leaks: the zig-zag line and bars outside the boxes are kept", has("80.137 500.219 m") && has("520.137") && has("200.111 620.5") && has("392.888 620.5"));
  check("leaks: the curve away from the boxes is kept as it was", has("72 300 m 100 350 150 350 180 300 c S"));
  check("leaks: the dashed rule continues its dashes after the box", shapes.dashes.some((d) => d > 270 && d < 290), JSON.stringify(shapes.dashes));
  // Rendered, page 2 looks the same as the original everywhere outside the boxes.
  execFileSync("pdftoppm", ["-r", "72", "-png", "-f", "2", "-l", "2", "-singlefile", pdf("redact-leaks.pdf"), join(SHOTS, "leaks-p2-before")]);
  execFileSync("pdftoppm", ["-r", "72", "-png", "-f", "2", "-l", "2", "-singlefile", lfile, join(SHOTS, "leaks-p2-after")]);
  const diff = JSON.parse(execFileSync("python3", ["-I", "-c", `
import sys, json
from PIL import Image
a = Image.open(sys.argv[1]).convert("RGB"); b = Image.open(sys.argv[2]).convert("RGB")
boxes = ${JSON.stringify(BOXES[2])}
n = 0
for y in range(a.height):
    for x in range(a.width):
        if any(b0 - 4 <= x <= b2 + 4 and 792 - b3 - 4 <= y <= 792 - b1 + 4 for b0, b1, b2, b3 in boxes): continue
        if max(abs(p - q) for p, q in zip(a.getpixel((x, y)), b.getpixel((x, y)))) > 64: n += 1
print(json.dumps({"n": n, "size": a.size}))`, join(SHOTS, "leaks-p2-before.png"), join(SHOTS, "leaks-p2-after.png")]).toString());
  check("leaks: page 2 looks unchanged outside the boxes", diff.n <= 10, JSON.stringify(diff));
  // Page 4: the picture is painted under the box, the rest unchanged.
  // Page 4's own resources now list just its two painted copies; page 5 still gets the original from the shared list.
  const p4 = JSON.parse(py(`
four = [i.image.convert("L") for i in r.pages[3].images]
big = [i for i in four if i.size == (64, 16)][0]
small = [i for i in four if i.size == (40, 10)][0]
print(json.dumps({"n": len(four), "box": big.getpixel((30, 8)), "rest": big.getpixel((2, 2)), "right": big.getpixel((60, 8)), "small": max(small.getdata()),
  "five": [i.image.convert("L").tobytes()[:10].decode("latin1") for i in r.pages[4].images]}))`, lfile));
  check("leaks: page 4's pictures are painted under the box, the rest unchanged", p4.n === 2 && p4.box < 40 && p4.rest === 200 && p4.right === 200 && p4.small < 40, JSON.stringify(p4));
  check("leaks: page 5 still draws the original shared picture", JSON.stringify(p4.five) === '["KEPTPIXELS"]', JSON.stringify(p4.five));
  check("leaks: no errors or warnings", lp.length === 0, lp.join(" | "));
  await lctx.close();

  // ----- Phone -----
  const mctx = await browser.newContext({ ...devices["Pixel 7"] });
  const m = await mctx.newPage();
  const mp = await watch(m, "phone");
  await m.goto(APP);
  await m.setInputFiles("input[type=file]", pdf("lease-test.pdf"));
  await m.waitForSelector(".page-canvas");
  await m.tap('button[aria-label="More"]');
  await m.tap(".menu-item >> text=Redact");
  const strip = await box(m, ".redact-options");
  check("phone: the Redact strip fits the screen", strip.x >= 0 && strip.x + strip.w <= 412, `${Math.round(strip.x)}..${Math.round(strip.x + strip.w)}`);
  const mpg = await box(m, '.page[data-page="1"]');
  // One finger drags a box (touch events, like a real finger).
  const cdp = await mctx.newCDPSession(m);
  const touch = async (type, x, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
  await touch("touchStart", mpg.x + mpg.w * 0.2, mpg.y + mpg.h * 0.3);
  for (let k = 1; k <= 6; k++) await touch("touchMove", mpg.x + mpg.w * (0.2 + 0.05 * k), mpg.y + mpg.h * (0.3 + 0.01 * k));
  await touch("touchEnd");
  await m.waitForTimeout(200);
  check("phone: one finger drags a box", (await count(m, 'rect[data-kind="redact"]')) === 1);
  await m.screenshot({ path: `${SHOTS}/redact-m1.png` });
  check("phone: no errors or warnings", mp.length === 0, mp.join(" | "));

  await browser.close();
  console.log(results.join("\n"));
  if (results.some((r) => r.startsWith("FAIL"))) process.exit(1);
})().catch((e) => { console.log(results.join("\n")); console.error(e); process.exit(1); });
