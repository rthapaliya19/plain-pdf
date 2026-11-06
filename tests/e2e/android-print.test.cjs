// Browser tests for printing in the Android app. The app's Android screen adds
// `window.PlainPdfPrinter` (android/MainActivity.kt); here a stand-in records
// the file it would hand to Android's print screen. Needs Python with pypdf, and pdftoppm.
// Run `npm run preview` first, then: node tests/e2e/android-print.test.cjs [screenshot-folder]
const { chromium, devices } = require("playwright");
const { execFileSync } = require("node:child_process");
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

const APP = process.env.APP_URL || "http://127.0.0.1:4173/";
const SHOTS = process.argv[2] || join(tmpdir(), "plain-pdf-screenshots");
mkdirSync(SHOTS, { recursive: true });
const pdf = (name) => join(__dirname, "..", "fixtures", name);
const results = [];
const check = (name, ok, extra = "") => results.push(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  (" + extra + ")" : ""}`);

async function watch(page, label, { refuse = false, allowed = [] } = {}) {
  const problems = [];
  page.on("pageerror", (e) => problems.push(`[${label}] pageerror: ${e.message}`));
  page.on("console", (m) => {
    // The app reports a refused printout on purpose in the "refuses" test.
    const expected = (refuse && /Couldn't start printing/.test(m.text())) || allowed.some((a) => a.test(m.text()));
    if ((m.type() === "error" || m.type() === "warning") && !expected) problems.push(`[${label}] console.${m.type()}: ${m.text()}`);
  });
  await page.addInitScript((refuse) => {
    window.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
    window.__browserPrints = 0;
    window.print = () => window.__browserPrints++;
    // Stand-in for the Android app's printer bridge.
    window.__jobs = [];
    let pieces = null;
    window.PlainPdfPrinter = {
      begin: () => { if (refuse) return false; pieces = []; return true; },
      add: (b64) => { if (pieces === null) return false; pieces.push(b64); return true; },
      print: (name) => {
        if (pieces === null) return false;
        const bin = pieces.map((p) => atob(p)).join("");
        window.__jobs.push({ name, pieces: pieces.length, bytes: Array.from(bin, (c) => c.charCodeAt(0)) });
        pieces = null;
        return true;
      },
    };
  }, refuse);
  return problems;
}
const box = (page, sel) => page.$eval(sel, (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; });
async function drag(page, from, to, steps = 10) {
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await page.mouse.move(to[0], to[1], { steps });
  await page.mouse.up();
}
const pypdf = (code, file) => execFileSync("python3", ["-I", "-c", `import sys\nfrom pypdf import PdfReader\nr = PdfReader(sys.argv[1])\n${code}`, file]).toString().trim();
async function printFromMenu(page, n) {
  await page.click('button[aria-label="More"]');
  await page.click(".menu-item >> text=Print");
  await page.waitForFunction((n) => window.__jobs.length === n, n, { timeout: 60000 });
  const job = await page.evaluate((n) => window.__jobs[n - 1], n);
  const file = join(SHOTS, `android-print-${n}.pdf`);
  writeFileSync(file, Buffer.from(job.bytes));
  return { ...job, file };
}
/** Red pixels in part of page 1 of a PDF, drawn with poppler (a different PDF reader). */
function redPixels(file, frac) {
  const out = join(SHOTS, "android-print-page");
  execFileSync("pdftoppm", ["-f", "1", "-l", "1", "-r", "72", "-singlefile", file, out]);
  const ppm = readFileSync(`${out}.ppm`);
  const head = ppm.toString("latin1", 0, 50).match(/^P6\s+(\d+)\s+(\d+)\s+255\s/);
  const [w, h] = [Number(head[1]), Number(head[2])];
  const start = head[0].length;
  let red = 0;
  for (let y = Math.floor(frac.y0 * h); y < frac.y1 * h; y++) {
    for (let x = Math.floor(frac.x0 * w); x < frac.x1 * w; x++) {
      const i = start + (y * w + x) * 3;
      if (ppm[i] > 170 && ppm[i + 1] < 90 && ppm[i + 2] < 90) red++;
    }
  }
  return red;
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const problems = await watch(page, "desktop");
  await page.goto(APP);
  await page.setInputFiles("input[type=file]", pdf("sample-25-pages.pdf"));
  await page.waitForSelector(".page-canvas");
  const original = readFileSync(pdf("sample-25-pages.pdf"));

  // 1. Nothing changed: the original file is handed over as it is.
  let job = await printFromMenu(page, 1);
  check("Print hands the file to Android's print screen (not the browser's)", (await page.evaluate(() => window.__browserPrints)) === 0);
  check("unchanged file prints as it is", Buffer.from(job.bytes).equals(original), `${job.bytes.length} of ${original.length} bytes`);
  check("...under its own name", job.name === "sample-25-pages.pdf", job.name);
  await page.waitForTimeout(200);
  check("the busy message goes away", await page.isHidden(".busy"));

  // 2. A red line and some text: the printout is the saved copy, with real text.
  const pg = await box(page, '.page[data-page="1"]');
  const s = pg.w / 612;
  const at = (x, y) => [pg.x + x * s, pg.y + y * s];
  await page.click('button[aria-label="Draw"]');
  await page.click('button[aria-label="Red pen"]');
  await page.click('button[aria-label="Thick line"]');
  await drag(page, at(540, 200), at(540, 400));
  await page.click(".draw-options .done-button");
  await page.click('button[aria-label="Text"]');
  await page.mouse.click(...at(400, 110)); // empty space between the subtitle and the body text
  await page.waitForSelector(".text-editor");
  await page.keyboard.type("Printed note");
  await page.click(".text-options .done-button");
  job = await printFromMenu(page, 2);
  check("with changes, the printout is named like the saved copy", job.name === "sample-25-pages-edited.pdf", job.name);
  check("the printout has every page", pypdf("print(len(r.pages))", job.file) === "25");
  check("added text prints as real, sharp text", pypdf("print(r.pages[0].extract_text())", job.file).includes("Printed note"));
  check("the original text is still real text", pypdf("print(r.pages[0].extract_text())", job.file).includes("Page 1"));
  const red = redPixels(job.file, { x0: 530 / 612, y0: 200 / 792, x1: 550 / 612, y1: 400 / 792 });
  check("your drawing is in the printout, in the right place", red > 100, `${red} red pixels`);
  check("no page pictures are made (sharp text)", pypdf("print(sum(len(p.images) for p in r.pages))", job.file) === "0");

  // 3. Pages reorganized (page 2 deleted): printed as shown.
  await page.click('button[aria-label="More"]');
  await page.click(".menu-item >> text=Organize pages");
  await page.waitForSelector(".organize .tile .thumb canvas");
  await page.click('.organize .tile[data-pos="1"]');
  await page.click(".organize-actions button[data-action='Delete']");
  await page.click(".organize .done-button");
  await page.waitForTimeout(400);
  job = await printFromMenu(page, 3);
  check("deleted pages aren't printed", pypdf("print(len(r.pages))", job.file) === "24");
  check("...and the rest are in order", pypdf("print(r.pages[1].extract_text())", job.file).includes("Page 3"));

  // 4. Forms: printed with their answers.
  await page.setInputFiles("input[type=file]", pdf("form-and-links.pdf"));
  await page.waitForSelector("dialog[open]");
  await page.click("dialog[open] >> text=Discard and open");
  await page.waitForSelector('.annotationLayer input[type="text"]');
  await page.fill('.annotationLayer input[type="text"]', "Printed Name");
  await page.waitForTimeout(300);
  job = await printFromMenu(page, 4);
  check("filled forms print with their answers", pypdf("print(r.pages[0].extract_text())", job.file).includes("Printed Name"));

  // 5. A bigger file (4 MB) goes over in several pieces and arrives whole.
  const scan = readFileSync(pdf("scanned-letter.pdf"));
  const big = Buffer.concat([scan, Buffer.alloc(4 * 1024 * 1024 - scan.length, 0x20)]);
  const bigFile = join(SHOTS, "big-scan.pdf");
  writeFileSync(bigFile, big);
  await page.setInputFiles("input[type=file]", bigFile);
  await page.waitForSelector("dialog[open]");
  await page.click("dialog[open] >> text=Discard and open");
  await page.waitForFunction(() => document.querySelector(".file-name")?.textContent === "big-scan.pdf");
  await page.waitForSelector(".page-canvas");
  job = await printFromMenu(page, 5);
  check("a large file arrives whole, in pieces", Buffer.from(job.bytes).equals(big) && job.pieces === 6, `${job.pieces} pieces, ${job.bytes.length} bytes`);

  // 6. Password-protected: handed over unlocked (Android's print screen can't open locked files), with the changes.
  await page.setInputFiles("input[type=file]", pdf("locked-password-secret123.pdf"));
  await page.waitForSelector("dialog[open] input[type=password]");
  await page.fill("dialog input[type=password]", "secret123");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector(".file-name")?.textContent === "locked-password-secret123.pdf");
  await page.waitForSelector(".page-canvas");
  job = await printFromMenu(page, 6);
  check("password-protected file: handed over unlocked, as real text", pypdf("print(r.is_encrypted, 'lease agreement' in r.pages[0].extract_text())", job.file) === "False True");
  check("...under its own name when nothing was changed", job.name === "locked-password-secret123.pdf", job.name);
  const lpg = await box(page, '.page[data-page="1"]');
  await page.click('button[aria-label="Draw"]');
  await page.click('button[aria-label="Red pen"]');
  await page.click('button[aria-label="Thick line"]');
  await drag(page, [lpg.x + 100, lpg.y + 300], [lpg.x + 300, lpg.y + 320]);
  await page.click(".draw-options .done-button");
  job = await printFromMenu(page, 7);
  check("...and with your changes, without asking", (await page.locator("dialog[open]").count()) === 0 && pypdf("print(r.is_encrypted)", job.file) === "False" && redPixels(job.file, { x0: 0, y0: 0, x1: 1, y1: 1 }) > 100);
  check("...named like the saved copy", job.name === "locked-password-secret123-edited.pdf", job.name);
  check("no browser print window at any point", (await page.evaluate(() => window.__browserPrints)) === 0);
  check("desktop: no privacy-lock violations", (await page.evaluate(() => window.__csp)).length === 0);
  check("desktop: no errors or warnings", problems.length === 0, problems.join(" | "));
  await ctx.close();

  // 7. If Android refuses, say so.
  const rctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const r = await rctx.newPage();
  const rp = await watch(r, "refuses", { refuse: true });
  await r.goto(APP);
  await r.setInputFiles("input[type=file]", pdf("lease-test.pdf"));
  await r.waitForSelector(".page-canvas");
  await r.click('button[aria-label="More"]');
  await r.click(".menu-item >> text=Print");
  await r.waitForSelector("dialog[open] >> text=Couldn't print");
  check("if the print screen can't open, the app says so", true);
  await r.click("dialog[open] button");
  await r.waitForTimeout(300);
  check("...and nothing is left on screen", (await r.isHidden(".busy")) && (await r.locator("dialog[open]").count()) === 0);
  check("refuses: no other errors", rp.length === 0, rp.join(" | "));
  await rctx.close();

  // 7b. If unlocking can't load: page pictures, without the changes, after asking.
  const bctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  await bctx.route(/qpdf.*\.wasm/, (route) => route.abort());
  const bl = await bctx.newPage();
  const bp = await watch(bl, "blocked", { allowed: [/Failed to load resource/, /falling back to ArrayBuffer instantiation/, /ProtectionError|qpdf|wasm|both async and sync fetching/i] });
  await bl.goto(APP);
  await bl.setInputFiles("input[type=file]", pdf("locked-password-secret123.pdf"));
  await bl.waitForSelector("dialog[open] input[type=password]");
  await bl.fill("dialog input[type=password]", "secret123");
  await bl.keyboard.press("Enter");
  await bl.waitForSelector(".page-canvas");
  const bpg = await box(bl, '.page[data-page="1"]');
  await bl.click('button[aria-label="Draw"]');
  await drag(bl, [bpg.x + 100, bpg.y + 300], [bpg.x + 300, bpg.y + 320]);
  await bl.click(".draw-options .done-button");
  await bl.click('button[aria-label="More"]');
  await bl.click(".menu-item >> text=Print");
  await bl.waitForSelector("dialog[open] >> text=Print without your changes?", { timeout: 30000 });
  check("if unlocking fails: asks before printing without the changes", true);
  await bl.click("dialog[open] >> text=Cancel");
  await bl.waitForTimeout(300);
  check("...Cancel prints nothing", (await bl.evaluate(() => window.__jobs.length)) === 0 && (await bl.isHidden(".busy")));
  await bl.click('button[aria-label="More"]');
  await bl.click(".menu-item >> text=Print");
  await bl.click("dialog[open] >> text=Print without changes");
  await bl.waitForFunction(() => window.__jobs.length === 1, null, { timeout: 60000 });
  const pjob = await bl.evaluate(() => window.__jobs[0]);
  const lockedFile = join(SHOTS, "android-print-locked.pdf");
  writeFileSync(lockedFile, Buffer.from(pjob.bytes));
  const info = JSON.parse(pypdf("import json\np = r.pages[0]\nprint(json.dumps({'enc': r.is_encrypted, 'n': len(r.pages), 'imgs': len(p.images), 'w': float(p.mediabox.width), 'h': float(p.mediabox.height), 'iw': p.images[0].image.width if p.images else 0}))", lockedFile));
  check("...then prints page pictures, unlocked so Android can read them", !info.enc && info.imgs === 1 && info.n === 1, JSON.stringify(info));
  check("...at the page's own size", Math.abs(info.w - 612) < 1 && Math.abs(info.h - 792) < 1, `${info.w}x${info.h}`);
  check("...sharp (300 dots per inch)", Math.abs(info.iw - (612 * 300) / 72) < 3, `${info.iw} pixels wide`);
  check("...named after the file", pjob.name === "locked-password-secret123.pdf", pjob.name);
  check("blocked: no other errors", bp.length === 0, bp.join(" | "));
  await bctx.close();

  // 8. Phone (Pixel size): Print is in the More menu, without a keyboard shortcut.
  const mctx = await browser.newContext({ ...devices["Pixel 7"] });
  const m = await mctx.newPage();
  const mp = await watch(m, "phone");
  await m.goto(APP);
  await m.setInputFiles("input[type=file]", pdf("lease-test.pdf"));
  await m.waitForSelector(".page-canvas");
  await m.tap('button[aria-label="More"]');
  await m.waitForSelector(".menu-item >> text=Print");
  await m.screenshot({ path: `${SHOTS}/android-print-menu.png` });
  check("phone: More menu has Print", await m.isVisible(".menu-item >> text=Print"));
  await m.tap(".menu-item >> text=Print");
  await m.waitForFunction(() => window.__jobs.length === 1, null, { timeout: 60000 });
  check("phone: tapping Print hands the file over", Buffer.from(await m.evaluate(() => window.__jobs[0].bytes)).equals(readFileSync(pdf("lease-test.pdf"))));
  check("phone: no errors or warnings", mp.length === 0, mp.join(" | "));

  await browser.close();
  console.log(results.join("\n"));
  if (results.some((r) => r.startsWith("FAIL"))) process.exit(1);
})().catch((e) => { console.log(results.join("\n")); console.error(e); process.exit(1); });
