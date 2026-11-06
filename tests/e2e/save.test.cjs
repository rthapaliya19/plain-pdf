// Browser tests for saving a copy (Phase 4), plus the Done button, pen-only
// thickness and initials. Needs Python with pypdf for checking saved files.
// Run `npm run preview` first, then: node tests/e2e/save.test.cjs [screenshot-folder]
const { chromium, devices } = require("playwright");
const { execFileSync } = require("node:child_process");
const { mkdirSync, writeFileSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

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
  });
  return problems;
}

/** Replaces Chrome's "Save as" window with a fake that keeps the bytes for checking. */
const FAKE_SAVE_PICKER = () => {
  window.__saves = [];
  window.__cancelNextSave = false;
  window.showSaveFilePicker = async (options) => {
    if (window.__cancelNextSave) {
      window.__cancelNextSave = false;
      throw new DOMException("cancelled", "AbortError");
    }
    const entry = { name: options.suggestedName, bytes: null };
    window.__saves.push(entry);
    return {
      name: options.suggestedName,
      createWritable: async () => ({
        write: async (blob) => (entry.bytes = Array.from(new Uint8Array(await blob.arrayBuffer()))),
        close: async () => {},
      }),
    };
  };
};
/** Phones and Safari have no "Save as" window: remove it so the app uses Downloads. */
const NO_SAVE_PICKER = () => {
  delete window.showSaveFilePicker;
  delete Window.prototype.showSaveFilePicker;
};

const box = (page, selector) => page.$eval(selector, (el) => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
});
const count = (page, selector) => page.locator(selector).count();
async function drag(page, from, to, steps = 10) {
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await page.mouse.move(to[0], to[1], { steps });
  await page.mouse.up();
}
async function openFile(page, name) {
  await page.setInputFiles("input[type=file]", name);
  await page.waitForFunction((n) => document.querySelector(".file-name")?.textContent === n, name.split("/").pop());
  await page.waitForSelector('.page[data-page="1"] .page-canvas');
  await page.waitForTimeout(300);
}
async function drawInk(page, kindLabel) {
  await page.waitForSelector("dialog[open] .signature-pad");
  const pad = await box(page, ".signature-pad");
  const y = pad.y + pad.h * 0.6;
  await page.mouse.move(pad.x + 40, y);
  await page.mouse.down();
  for (let i = 0; i <= 30; i++) await page.mouse.move(pad.x + 40 + i * (kindLabel === "initials" ? 4 : 10), y - Math.sin(i / 3) * 30);
  await page.mouse.up();
  await page.click(`dialog >> text=Save ${kindLabel}`);
  await page.waitForTimeout(200);
}
/** Where an element sits on its page, as fractions of the page size. */
const fractionBox = (page, selector) => page.$eval(selector, (el) => {
  const p = el.closest(".page").getBoundingClientRect();
  const r = el.getBoundingClientRect();
  return { x0: (r.left - p.left) / p.width, y0: (r.top - p.top) / p.height, x1: (r.right - p.left) / p.width, y1: (r.bottom - p.top) / p.height };
});
/** Counts canvas pixels in a region of a page (fractions) that match a colour test. */
const pixelStats = (page, pageNumber, frac) => page.evaluate(({ pageNumber, frac }) => {
  const canvas = document.querySelector(`.page[data-page="${pageNumber}"] .page-canvas`);
  const ctx = canvas.getContext("2d");
  const x0 = Math.floor(frac.x0 * canvas.width), y0 = Math.floor(frac.y0 * canvas.height);
  const w = Math.max(1, Math.floor((frac.x1 - frac.x0) * canvas.width)), h = Math.max(1, Math.floor((frac.y1 - frac.y0) * canvas.height));
  const d = ctx.getImageData(x0, y0, w, h).data;
  const s = { dark: 0, yellow: 0, blue: 0, red: 0, total: w * h, minRed: 255 };
  for (let i = 0; i < d.length; i += 4) {
    const [r, g, b] = [d[i], d[i + 1], d[i + 2]];
    if (r < 90 && g < 90 && b < 90) s.dark++;
    if (r > 200 && g > 170 && b < 150) s.yellow++;
    if (b > 120 && b > r + 50 && b > g + 30) s.blue++;
    if (r > 170 && g < 90 && b < 90) s.red++;
    s.minRed = Math.min(s.minRed, r);
  }
  return s;
}, { pageNumber, frac });
const savedBytes = async (page) => Buffer.from(await page.evaluate(() => window.__saves[window.__saves.length - 1].bytes));
function pypdf(code, file) {
  return execFileSync("python3", ["-I", "-c", `import sys, json\nfrom pypdf import PdfReader\nr = PdfReader(sys.argv[1])\n${code}`, file]).toString().trim();
}

(async () => {
  const browser = await chromium.launch();

  // ================= Computer, with the "Save as" window =================
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, acceptDownloads: true });
  await ctx.addInitScript(FAKE_SAVE_PICKER);
  const page = await ctx.newPage();
  const problems = await watch(page, "desktop");
  page.on("dialog", (d) => d.accept());
  await page.goto(APP);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await openFile(page, pdf("sample-25-pages.pdf"));

  check("Save button shown, disabled until something is added", (await page.isVisible("button.save-button")) && (await page.isDisabled("button.save-button")));
  await page.keyboard.press("Control+s");
  check("Ctrl+S with nothing added explains why", (await page.textContent(".toast"))?.includes("Nothing to save yet"));

  // ----- Draw strip: Done button and pen-only thickness -----
  await page.click('button[aria-label="Draw"]');
  check("Done button in the drawing strip", await page.isVisible(".draw-options .done-button"));
  check("thickness shown for the pen", await page.isVisible('button[aria-label="Thick line"]'));
  await page.click('button[aria-label="Yellow highlighter"]');
  check("no thickness for the highlighter", !(await page.isVisible('button[aria-label="Thick line"]')));
  await page.click('button[aria-label="Eraser"]');
  check("no thickness for the eraser", !(await page.isVisible('button[aria-label="Thick line"]')));
  await page.click('button[aria-label="Black pen"]');
  await page.click('button[aria-label="Thick line"]');
  await page.screenshot({ path: `${SHOTS}/p4-d1-strip.png`, clip: { x: 340, y: 55, width: 600, height: 70 } });

  // A pen line in the empty right margin of page 1 (x = 540 pt, y = 200..400 pt).
  let pg = await box(page, '.page[data-page="1"]');
  const s = pg.w / 612;
  await drag(page, [pg.x + 540 * s, pg.y + 200 * s], [pg.x + 540 * s, pg.y + 400 * s], 15);
  const penFrac = await fractionBox(page, '.page[data-page="1"] .layer-ink path[data-kind="stroke"]');
  // A text highlight on the 3rd body line.
  await page.click('button[aria-label="Yellow highlighter"]');
  await drag(page, [pg.x + 52 * s, pg.y + 190 * s], [pg.x + 300 * s, pg.y + 191 * s], 15);
  const hlFrac = await fractionBox(page, '.page[data-page="1"] .layer-highlight g[data-kind="highlight"] rect');
  await page.click(".draw-options .done-button");
  check("Done turns drawing off", !(await page.isVisible(".draw-options")) && !(await page.$eval(".viewer", (v) => v.classList.contains("drawing"))));
  check("after Done, dragging doesn't draw", await (async () => {
    const before = await count(page, ".layer-ink path");
    await drag(page, [pg.x + 520 * s, pg.y + 500 * s], [pg.x + 560 * s, pg.y + 560 * s]);
    return (await count(page, ".layer-ink path")) === before;
  })());
  check("Save enabled once something is added", !(await page.isDisabled("button.save-button")));

  // ----- Sign panel with signature and initials -----
  await page.click('button[aria-label="Sign"]');
  await page.waitForSelector("dialog[open] .sign-panel, dialog.sign-panel[open]");
  check("Sign panel shows both slots", (await page.isVisible("dialog[open] >> text=+ Add signature")) && (await page.isVisible("dialog[open] >> text=+ Add initials")));
  await page.screenshot({ path: `${SHOTS}/p4-d2-sign-empty.png` });
  await page.click("dialog[open] >> text=+ Add signature");
  check("empty signature slot opens the pad", (await page.textContent("dialog[open] h2")) === "Draw your signature");
  await drawInk(page, "signature");
  check("signature placed", (await count(page, ".sig-box")) === 1);
  const sigBox = await box(page, ".sig-box");
  await page.click('button[aria-label="Sign"]');
  await page.waitForSelector("dialog.sign-panel[open]");
  check("panel now shows the saved signature", (await count(page, "dialog[open] .sign-slot-signature svg")) === 1);
  await page.click("dialog[open] >> text=+ Add initials");
  check("empty initials slot opens the pad", (await page.textContent("dialog[open] h2")) === "Draw your initials");
  await drawInk(page, "initials");
  check("initials placed", (await count(page, ".sig-box")) === 2);
  const initialsBox = await box(page, '.sig-box[aria-label^="Initials"]');
  check("initials start smaller than the signature", initialsBox.w < sigBox.w * 0.5, `${Math.round(initialsBox.w)} vs ${Math.round(sigBox.w)}`);
  // Move the initials away from the signature.
  await drag(page, [initialsBox.cx, initialsBox.cy], [initialsBox.cx - 250, initialsBox.cy + 150]);
  check("initials remembered on this device", await page.evaluate(() => !!localStorage.getItem("plain-pdf:initials")));
  await page.click('button[aria-label="Sign"]');
  await page.waitForSelector("dialog.sign-panel[open]");
  await page.screenshot({ path: `${SHOTS}/p4-d3-sign-panel.png` });
  check("panel shows both saved", (await count(page, "dialog[open] .sign-slot svg")) === 2);
  await page.click('dialog[open] [aria-label="Place your initials on the page"]');
  await page.waitForFunction(() => document.querySelectorAll(".sig-box").length === 3);
  check("tapping saved initials places them", true);
  await page.keyboard.press("Control+z");
  const sigFrac = await fractionBox(page, '.sig-box[aria-label^="Signature"]');
  const iniFrac = await fractionBox(page, '.sig-box[aria-label^="Initials"]');
  await page.mouse.click(pg.x + 30, pg.y + 30); // deselect
  await page.screenshot({ path: `${SHOTS}/p4-d4-before-save.png` });

  // ----- Save -----
  await page.click("button.save-button");
  await page.waitForFunction(() => window.__saves.length === 1 && window.__saves[0].bytes);
  const saved1 = await page.evaluate(() => window.__saves[0].name);
  check("Save suggests name-edited.pdf", saved1 === "sample-25-pages-edited.pdf", saved1);
  await page.waitForSelector(".toast >> text=Saved a copy");
  check("confirms the save", (await page.textContent(".toast")).includes("sample-25-pages-edited.pdf"));
  const bytes1 = await savedBytes(page);
  const file1 = join(SHOTS, "saved-sample-edited.pdf");
  writeFileSync(file1, bytes1);
  check("saved copy is a PDF", bytes1.subarray(0, 5).toString() === "%PDF-");
  check("original file untouched", readFileSync(pdf("sample-25-pages.pdf")).length === 23748);
  check("saved copy keeps all 25 pages", pypdf("print(len(r.pages))", file1) === "25");
  check("saved copy keeps the original text", pypdf("print(r.pages[0].extract_text()[:40])", file1).includes("Sample document"));
  const details = (f) => pypdf("print(json.dumps({k: str(v) for k, v in (r.metadata or {}).items()}, sort_keys=True))", f);
  check("saved copy keeps the file details exactly as they were", details(file1) === details(pdf("sample-25-pages.pdf")), details(file1));
  check("highlights use multiply blending in the file", pypdf("gs = r.pages[0]['/Resources']['/ExtGState'].get_object()\nprint([str(v.get_object().get('/BM')) for v in gs.values()])", file1).includes("/Multiply"));

  // After saving, opening another file doesn't warn.
  await openFile(page, pdf("lease-test.pdf"));
  check("no unsaved-changes warning after saving", (await count(page, "dialog[open]")) === 0);

  // ----- Reopen the saved copy: everything is now part of the page -----
  await page.setInputFiles("input[type=file]", file1);
  await page.waitForFunction(() => document.querySelector(".file-name")?.textContent === "saved-sample-edited.pdf");
  await page.waitForSelector('.page[data-page="1"] .page-canvas');
  await page.waitForTimeout(500);
  check("reopened copy has no separate additions (they're locked in)", (await count(page, ".layer > *")) === 0 && (await count(page, ".sig-box")) === 0);
  const pen = await pixelStats(page, 1, penFrac);
  check("saved pen line is in the right place", pen.dark > pen.total * 0.3, `${pen.dark}/${pen.total} dark`);
  const hl = await pixelStats(page, 1, { x0: hlFrac.x0, y0: hlFrac.y0, x1: hlFrac.x1, y1: hlFrac.y1 });
  check("saved highlight is yellow, in the right place", hl.yellow > hl.total * 0.5, `${hl.yellow}/${hl.total} yellow`);
  check("text under the saved highlight stays dark", hl.minRed < 110, `darkest ${hl.minRed}`);
  const sg = await pixelStats(page, 1, sigFrac);
  check("saved signature is blue, in the right place", sg.blue > 50, `${sg.blue} blue pixels`);
  const ini = await pixelStats(page, 1, iniFrac);
  check("saved initials are blue, in the right place", ini.blue > 20, `${ini.blue} blue pixels`);
  await page.screenshot({ path: `${SHOTS}/p4-d5-reopened.png` });

  // ----- Rotated, shifted and cropped pages -----
  await openFile(page, pdf("geometry-rotated-cropped.pdf"));
  await page.click('button[aria-label="Draw"]');
  await page.click('button[aria-label="Red pen"]');
  await page.click('button[aria-label="Thick line"]');
  const marks = [];
  for (let n = 1; n <= 4; n++) {
    await page.evaluate((n) => document.querySelector(`.page[data-page="${n}"]`).scrollIntoView({ block: "center" }), n);
    await page.waitForTimeout(250);
    const b = await box(page, `.page[data-page="${n}"]`);
    // An L shape near the top-left, which shows up any rotation or flip.
    await drag(page, [b.x + b.w * 0.2, b.y + b.h * 0.2], [b.x + b.w * 0.2, b.y + b.h * 0.35], 8);
    await drag(page, [b.x + b.w * 0.2, b.y + b.h * 0.35], [b.x + b.w * 0.4, b.y + b.h * 0.35], 8);
    marks.push(n);
  }
  await page.click(".draw-options .done-button");
  await page.click("button.save-button");
  await page.waitForFunction(() => window.__saves.length === 2 && window.__saves[1].bytes);
  const file2 = join(SHOTS, "saved-geometry-edited.pdf");
  writeFileSync(file2, await savedBytes(page));
  await page.setInputFiles("input[type=file]", file2);
  await page.waitForFunction(() => document.querySelector(".file-name")?.textContent === "saved-geometry-edited.pdf");
  for (const n of marks) {
    await page.evaluate((n) => document.querySelector(`.page[data-page="${n}"]`).scrollIntoView({ block: "center" }), n);
    await page.waitForSelector(`.page[data-page="${n}"] .page-canvas`);
    await page.waitForTimeout(400);
    const vertical = await pixelStats(page, n, { x0: 0.18, y0: 0.24, x1: 0.22, y1: 0.31 });
    const horizontal = await pixelStats(page, n, { x0: 0.26, y0: 0.33, x1: 0.34, y1: 0.37 });
    const elsewhere = await pixelStats(page, n, { x0: 0.6, y0: 0.6, x1: 0.8, y1: 0.8 });
    check(`page ${n}: saved mark lands exactly where drawn`, vertical.red > 20 && horizontal.red > 20 && elsewhere.red === 0, `v ${vertical.red} h ${horizontal.red} other ${elsewhere.red}`);
  }
  await page.screenshot({ path: `${SHOTS}/p4-d6-geometry.png` });

  // ----- Cancelling the Save window -----
  await openFile(page, pdf("lease-test.pdf"));
  await page.click('button[aria-label="Draw"]');
  pg = await box(page, '.page[data-page="1"]');
  await drag(page, [pg.x + 100, pg.y + 300], [pg.x + 300, pg.y + 320]);
  await page.click(".draw-options .done-button");
  await page.evaluate(() => (window.__cancelNextSave = true));
  await page.click("button.save-button");
  await page.waitForTimeout(400);
  check("cancelling Save saves nothing", (await page.evaluate(() => window.__saves.length)) === 2);
  await page.setInputFiles("input[type=file]", pdf("sample-25-pages.pdf"));
  await page.waitForSelector("dialog[open]");
  check("after cancelling, changes still count as unsaved", (await page.textContent("dialog[open] h2")) === "Discard your changes?");
  await page.click("dialog[open] >> text=Keep editing");

  // ----- Encrypted files -----
  await page.click('button[aria-label="Undo"]');
  await page.setInputFiles("input[type=file]", pdf("locked-password-secret123.pdf"));
  await page.waitForSelector("dialog[open] input[type=password]");
  await page.fill("dialog input[type=password]", "secret123");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector(".file-name")?.textContent === "locked-password-secret123.pdf");
  await page.waitForSelector(".page-canvas");
  await page.click('button[aria-label="Draw"]');
  pg = await box(page, '.page[data-page="1"]');
  await drag(page, [pg.x + 100, pg.y + 300], [pg.x + 300, pg.y + 320]);
  await page.click("button.save-button");
  await page.waitForSelector("dialog[open]");
  check("encrypted file: asks whether the copy keeps the password", (await page.textContent("dialog[open] h2")) === "Keep the password?");
  await page.click("dialog[open] >> text=Cancel");
  check("encrypted file: Cancel keeps the drawing (more in protected.test.cjs)", (await count(page, ".layer-ink path")) === 1);

  check("desktop: no privacy-lock violations", (await page.evaluate(() => window.__csp)).length === 0);
  check("desktop: no errors or warnings", problems.filter((p) => !p.includes("Couldn't")).length === 0, problems.join(" | "));
  await ctx.close();

  // ================= Browser without a "Save as" window: Downloads =================
  const dctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
  await dctx.addInitScript(NO_SAVE_PICKER);
  const d = await dctx.newPage();
  const dproblems = await watch(d, "downloads");
  await d.goto(APP);
  await openFile(d, pdf("lease-test.pdf"));
  await d.click('button[aria-label="Draw"]');
  pg = await box(d, '.page[data-page="1"]');
  await drag(d, [pg.x + 100, pg.y + 300], [pg.x + 300, pg.y + 320]);
  const [download] = await Promise.all([d.waitForEvent("download"), d.keyboard.press("Control+s")]);
  check("without a Save window, the copy downloads", download.suggestedFilename() === "lease-test-edited.pdf", download.suggestedFilename());
  const dfile = join(SHOTS, "downloaded-lease-edited.pdf");
  await download.saveAs(dfile);
  check("downloaded copy is a valid PDF", pypdf("print(len(r.pages))", dfile) === "1");
  await d.waitForSelector(".toast >> text=Downloads");
  check("says it went to Downloads", true);
  check("downloads: no errors or warnings", dproblems.length === 0, dproblems.join(" | "));
  await dctx.close();

  // ================= Phone (Pixel 7) =================
  const mctx = await browser.newContext({ ...devices["Pixel 7"], acceptDownloads: true });
  await mctx.addInitScript(NO_SAVE_PICKER);
  const m = await mctx.newPage();
  const mproblems = await watch(m, "phone");
  await m.goto(APP);
  await openFile(m, pdf("sample-25-pages.pdf"));
  const vw = await m.evaluate(() => innerWidth);
  const saveBtn = await box(m, "button.save-button");
  check("phone: Save button in the top bar, on screen", saveBtn.x + saveBtn.w <= vw && saveBtn.y < 60 && (await m.textContent("button.save-button")).includes("Save"));
  await m.tap('button[aria-label="Draw"]');
  await m.tap('button[aria-label="Black pen"]');
  const strip = await box(m, ".draw-options");
  check("phone: drawing strip with Done fits the screen", strip.x >= 0 && strip.x + strip.w <= vw, `${Math.round(strip.x)}..${Math.round(strip.x + strip.w)} of ${vw}`);
  await m.screenshot({ path: `${SHOTS}/p4-m1-strip.png` });
  const cdp = await mctx.newCDPSession(m);
  const touch = (type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i })) });
  await touch("touchStart", [[100, 300]]);
  for (let i = 1; i <= 10; i++) await touch("touchMove", [[100 + i * 15, 300 + i * 5]]);
  await touch("touchEnd", []);
  await m.waitForTimeout(500);
  await m.tap(".draw-options .done-button");
  check("phone: Done turns drawing off", !(await m.isVisible(".draw-options")));
  await m.waitForTimeout(500);
  const [mdl] = await Promise.all([m.waitForEvent("download"), m.tap("button.save-button")]);
  check("phone: Save downloads the copy", mdl.suggestedFilename() === "sample-25-pages-edited.pdf", mdl.suggestedFilename());
  await m.waitForSelector(".toast");
  await m.screenshot({ path: `${SHOTS}/p4-m2-saved.png` });
  await m.tap('button[aria-label="Sign"]');
  await m.waitForSelector("dialog.sign-panel[open]");
  const panel = await box(m, "dialog.sign-panel[open]");
  check("phone: Sign panel fits the screen", panel.x >= 0 && panel.x + panel.w <= vw);
  await m.screenshot({ path: `${SHOTS}/p4-m3-sign-panel.png` });
  check("phone: no privacy-lock violations", (await m.evaluate(() => window.__csp)).length === 0);
  check("phone: no errors or warnings", mproblems.length === 0, mproblems.join(" | "));

  await browser.close();
  console.log(results.join("\n"));
  if (results.some((r) => r.startsWith("FAIL"))) process.exit(1);
})().catch((e) => {
  console.log(results.join("\n"));
  console.error(e);
  process.exit(1);
});
