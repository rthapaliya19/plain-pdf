// Browser tests for redaction: the Redact tool, and what's removed from saved copies.
// Needs Python with pypdf, and poppler (pdftotext, pdftoppm).
// tests/fixtures/redact-test.pdf (made with pdf-lib) has on page 1: plain text, text with kerning (TJ),
// text with letter/word spacing (the ' operator), a photo (JPEG) with invisible "OCR" text over it,
// a logo with transparency (PNG), a blue rectangle and a long line, text inside a form drawing,
// a hidden ActualText copy of a span, and a web link; on page 2 an inline picture.
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
