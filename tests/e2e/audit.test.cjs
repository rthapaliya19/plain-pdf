// Browser tests for the problems found by the November 2026 audit (all fixed):
//  1. a page saved as a picture for redaction kept its original scan, drawings and fonts inside the file
//  2. shapes only partly under a redaction box (outlined words, a drawn signature) stayed whole, and so did
//     a page's preview picture ("Thumb") and app-private data ("PieceInfo")
//  3. Save failed once one page held some 40,000 pen points
//  4. Organize showed the page previews of a file opened earlier
//  5. editing one line of tightly set text removed the line below from the saved copy
// tests/fixtures/audit-cases.pdf is made by tests/fixtures/make-audit-cases.cjs.
// Needs Python with pypdf, and poppler (pdftotext, pdftoppm).
// Run `npm run preview` first, then: node tests/e2e/audit.test.cjs [screenshot-folder]
const { chromium } = require("playwright");
const { execFileSync } = require("node:child_process");
const { mkdirSync, writeFileSync } = require("node:fs");
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
    window.__saves = [];
    window.showSaveFilePicker = async (o) => {
      const entry = { name: o.suggestedName, bytes: null };
      window.__saves.push(entry);
      return { name: o.suggestedName, createWritable: async () => ({ write: async (b) => (entry.bytes = Array.from(new Uint8Array(await b.arrayBuffer()))), close: async () => {} }) };
    };
  });
  return problems;
}
const box = (page, sel) => page.$eval(sel, (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
const count = (page, sel) => page.locator(sel).count();
async function drag(page, from, to, steps = 8) {
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await page.mouse.move(to[0], to[1], { steps });
  await page.mouse.up();
}
async function open(page, name) {
  await page.setInputFiles("input[type=file]", pdf(name));
  await page.waitForFunction((n) => document.querySelector(".file-name").textContent === n, name);
  await page.waitForSelector('.page[data-page="1"] .page-canvas');
}
async function goToPage(page, n) {
  await page.fill(".page-input", String(n));
  await page.press(".page-input", "Enter");
  await page.waitForSelector(`.page[data-page="${n}"] .page-canvas`);
  await page.waitForTimeout(300);
}
/** Where page-point (x, y) of page n is on screen (the pages are 612 points wide). */
async function at(page, n, x, y) {
  const pg = await box(page, `.page[data-page="${n}"]`);
  const s = pg.w / 612;
  return [pg.x + x * s, pg.y + y * s];
}
const boxOver = async (page, n, x0, y0, x1, y1) => drag(page, await at(page, n, x0, y0), await at(page, n, x1, y1));
/** Clicks Save and returns the saved copy's path. */
async function save(page, name) {
  const before = await page.evaluate(() => window.__saves.length);
  await page.click("button.save-button");
  await page.waitForFunction((n) => (window.__saves.length > n && window.__saves[window.__saves.length - 1].bytes) || document.querySelector("dialog[open]"), before, { timeout: 120000 });
  if (await count(page, "dialog[open]")) return null;
  const file = join(SHOTS, name);
  writeFileSync(file, Buffer.from(await page.evaluate(() => window.__saves[window.__saves.length - 1].bytes)));
  return file;
}
const py = (code, file, ...args) => execFileSync("python3", ["-I", "-c", `import sys, json, logging\nlogging.disable(logging.CRITICAL)\nfrom pypdf import PdfReader\nr = PdfReader(sys.argv[1])\n${code}`, file, ...args]).toString().trim();
const text = (file, n) => execFileSync("pdftotext", ["-f", String(n), "-l", String(n), "-layout", file, "-"]).toString();
/**
 * Looks through everything in the file, object by object (streams decoded): which of `needles` appear
 * anywhere, and the kinds of pictures present. This reads the file itself, not just what its pages still draw.
 */
function fileContents(file, needles) {
  const out = py(`
needles = json.loads(sys.argv[2])
found = set(); pictures = []
for num in range(1, int(r.trailer["/Size"])):
    try:
        obj = r.get_object(num)
    except Exception:
        continue
    if obj is None:
        continue
    data = b""
    if hasattr(obj, "get_data"):
        if "/Width" in obj:
            pictures.append(str(obj.get("/Filter")))
        try:
            data = obj.get_data()
        except Exception:
            data = obj._data
    data += repr(obj).encode("latin1", "replace")
    for n in needles:
        if n.encode("latin1") in data:
            found.add(n)
print(json.dumps({"found": sorted(found), "pictures": pictures}))`, file, JSON.stringify(needles));
  return JSON.parse(out.split("\n").pop());
}

(async () => {
  const helv = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
  const browser = await chromium.launch();
  const newPage = async (label) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const problems = await watch(page, label);
    await page.goto(APP);
    await page.evaluate(() => localStorage.clear());
    return { page, problems, ctx };
  };

  // ===== 1 and 2: nothing recoverable is left in redacted copies =====
  {
    const { page, problems, ctx } = await newPage("redaction");
    await open(page, "audit-cases.pdf");
    for (let k = 0; k < 5; k++) await page.click('button[title^="Zoom out"]');
    await page.waitForTimeout(400);
    await page.click('button[aria-label="More"]');
    await page.click(".menu-item >> text=Redact");
    await goToPage(page, 1);
    await boxOver(page, 1, 60, 165, 560, 222); // the number on the scan
    await boxOver(page, 1, 65, 676, 300, 700); // the stamp (text inside a form drawing)
    await goToPage(page, 2);
    await boxOver(page, 2, 195, 74, 306, 124); // the middle outlined word and the ring under it
    await goToPage(page, 3);
    await boxOver(page, 3, 250, 248, 350, 296); // the middle of the zigzag signature
    await goToPage(page, 4);
    await boxOver(page, 4, 280, 300, 325, 326); // a short stretch of the curved flourish
    await goToPage(page, 5);
    const nameStart = 72 + helv.widthOfTextAtSize("Patient name: ", 14);
    const nameEnd = 72 + helv.widthOfTextAtSize("Patient name: JOHN Q SECRETNAME", 14);
    await boxOver(page, 5, nameStart - 1, 78, nameEnd + 2, 97); // the name (a rule, an underline and a background cross it)
    check("six redaction boxes drawn", (await count(page, 'rect[data-kind="redact"]')) === 6);
    await page.screenshot({ path: `${SHOTS}/audit-1-boxes.png` });
    const file = await save(page, "audit-redacted.pdf");
    check("the redacted copy saves", file !== null);
    const toast = (await page.textContent(".toast")) ?? "";
    check("pages 1, 3 and 4 are saved as pictures, and the app says so", toast.includes("Pages 1, 3, 4 were saved as a picture"), toast);

    const secrets = ["FORMSECRET", "987-65-4321", "200.123", "250.777", "300.777", "220.111", "SECRETNAME", "AI-private"];
    const kept = ["400.555", "350 700 80 14 re"];
    const found = fileContents(file, [...secrets, ...kept]);
    check("page as a picture: the original scan is no longer anywhere in the file", !found.pictures.some((f) => f.includes("CCITT")), found.pictures.join(" "));
    check("...the only pictures left are the three page pictures", found.pictures.length === 3 && found.pictures.every((f) => f.includes("DCT")), found.pictures.join(" "));
    for (const s of secrets) check(`"${s}" is nowhere in the file`, !found.found.includes(s));
    check("page as a picture: its old list of pictures, drawings and fonts is gone", py(`
res = r.pages[0]["/Resources"]
print(len(res.get("/XObject", {})), len(res.get("/Font", {})))`, file) === "1 0");
    check("the redacted scan shows a black box where the number was", (() => {
      execFileSync("pdftoppm", ["-r", "50", "-f", "1", "-l", "1", "-png", file, join(SHOTS, "audit-p1")]);
      const dark = execFileSync("python3", ["-I", "-c", `
import sys
from PIL import Image
im = Image.open(sys.argv[1]).convert("L"); w, h = im.size
crop = im.crop((int(80 / 612 * w), int(175 / 792 * h), int(540 / 612 * w), int(212 / 792 * h)))
px = list(crop.getdata() if not hasattr(crop, "get_flattened_data") else crop.get_flattened_data())
print(round(sum(1 for p in px if p < 60) / len(px), 3))`, join(SHOTS, "audit-p1-1.png")]).toString().trim();
      return Number(dark) > 0.98;
    })());

    // Outlined words: the pieces under the box are taken out, the rest of the shape stays a drawing.
    check("outlined words: the page stays a real page (not a picture)", py('print(len(r.pages[1].images))', file) === "0" && text(file, 2).includes("Outlined words above"));
    check("...the pieces away from the box are kept", kept.every((k) => found.found.includes(k)), found.found.join(" | "));
    // Simple shapes crossing a box (a rule, an underline, a background) don't turn a page into a picture.
    const page5 = text(file, 5);
    check("text page: stays a real page, with the words outside the box", py('print(len(r.pages[4].images))', file) === "0" && page5.includes("Patient name:") && page5.includes("Nothing private on this line"), page5.trim());
    check("...the name is gone", !page5.includes("JOHN") && !page5.includes("SECRETNAME"));
    check("...its preview picture and app-private data are dropped", py('print("/Thumb" in r.pages[4], "/PieceInfo" in r.pages[4])', file) === "False False");
    check("the untouched page keeps its text", text(file, 6).includes("Heading line three here"));
    check("no errors or warnings", problems.length === 0, problems.join(" | "));
    await ctx.close();
  }

  // ===== 5: editing a line leaves the lines above and below alone =====
  {
    const { page, problems, ctx } = await newPage("edit");
    await open(page, "audit-cases.pdf");
    for (let k = 0; k < 5; k++) await page.click('button[title^="Zoom out"]');
    await goToPage(page, 6);
    await page.click('button[aria-label="Text"]');
    await page.waitForTimeout(500);
    await page.mouse.click(...(await at(page, 6, 150, 106)));
    await page.waitForSelector("textarea.edit-editor");
    check("tapping the middle line opens it for editing", (await page.$eval("textarea.edit-editor", (t) => t.value)) === "Heading line two here");
    await page.keyboard.press("Control+a");
    await page.keyboard.insertText("Heading line TWO here");
    await page.keyboard.press("Escape");
    const file = await save(page, "audit-edited.pdf");
    check("the edited copy saves (as a real page)", file !== null && py('print(len(r.pages[5].images))', file) === "0");
    const lines = text(file, 6).split("\n").map((l) => l.trim()).filter(Boolean);
    check("the edited line has the new words, and the old ones are gone", lines.includes("Heading line TWO here") && !lines.some((l) => l.includes("two")), lines.join(" / "));
    check("the line above is untouched", lines.includes("Heading line one here"), lines.join(" / "));
    check("the line below is untouched", lines.includes("Heading line three here"), lines.join(" / "));
    check("no errors or warnings", problems.length === 0, problems.join(" | "));
    await ctx.close();
  }

  // ===== 3: a page full of handwriting still saves =====
  {
    const { page, problems, ctx } = await newPage("drawing");
    await open(page, "sample-25-pages.pdf");
    await page.click('button[aria-label="Draw"]');
    // 600 wavy lines of 100 points each, sent straight to the page (much faster than moving a real mouse).
    const strokes = await page.evaluate(() => {
      Element.prototype.setPointerCapture = () => {}; // made-up pointers can't be captured
      const v = document.querySelector(".viewer");
      const pg = document.querySelector('.page[data-page="1"]').getBoundingClientRect();
      const send = (type, x, y) => v.dispatchEvent(new PointerEvent(type, { pointerId: 1, pointerType: "mouse", button: 0, buttons: 1, clientX: x, clientY: y, bubbles: true, cancelable: true, isPrimary: true }));
      for (let n = 0; n < 600; n++) {
        const x0 = pg.left + 40;
        const y0 = Math.max(70, pg.top) + 20 + (n % 60) * 12;
        send("pointerdown", x0, y0);
        for (let k = 1; k < 100; k++) send("pointermove", x0 + k * 5, y0 + (k % 2 ? 4 : -4));
        send("pointerup", x0 + 500, y0);
      }
      return document.querySelectorAll(".layer-ink path").length;
    });
    check("600 pen lines (60,000 points) on one page", strokes === 600, String(strokes));
    await page.keyboard.press("Escape");
    const file = await save(page, "audit-heavy-drawing.pdf");
    check("the heavily drawn-on copy saves", file !== null, file === null ? await page.textContent("dialog[open]") : "");
    check("...and is a whole PDF with all its pages", file !== null && py("print(len(r.pages))", file) === "25");
    check("no errors or warnings", problems.length === 0, problems.join(" | "));
    await ctx.close();
  }

  // ===== 4: Organize shows each file's own page previews =====
  {
    const firstTile = (page) => page.evaluate(() => {
      const c = document.querySelector('.organize .tile[data-pos="0"] canvas');
      const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      let h = 0;
      for (let i = 0; i < d.length; i += 4) h = (h * 31 + d[i]) >>> 0;
      return `${c.width}x${c.height}:${h}`;
    });
    const organize = async (page) => {
      await page.click('button[aria-label="More"]');
      await page.click(".menu-item >> text=Organize pages");
      await page.waitForSelector('.organize .tile[data-pos="0"] canvas');
      await page.waitForTimeout(1500);
      const tile = await firstTile(page);
      await page.click(".organize .done-button");
      return tile;
    };
    const alone = await newPage("organize-alone");
    await open(alone.page, "scanned-letter.pdf");
    const expected = await organize(alone.page);
    await alone.ctx.close();
    const { page, problems, ctx } = await newPage("organize");
    await open(page, "chapters.pdf");
    const other = await organize(page);
    await open(page, "scanned-letter.pdf");
    const shown = await organize(page);
    check("Organize shows the second file's own first page", shown === expected, `${shown} vs ${expected}`);
    check("...not the first page of the file opened before", shown !== other);
    check("no errors or warnings", problems.length === 0, problems.join(" | "));
    await ctx.close();
  }

  await browser.close();
  console.log(results.join("\n"));
  if (results.some((r) => r.startsWith("FAIL"))) process.exit(1);
})().catch((e) => { console.log(results.join("\n")); console.error(e); process.exit(1); });
