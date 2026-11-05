// Browser tests for Round C: organize pages (rotate, delete, reorder), merge, split.
// Needs Python with pypdf. Run `npm run preview` first, then:
// node tests/e2e/roundc.test.cjs [screenshot-folder]
const { chromium, devices } = require("playwright");
const { execFileSync } = require("node:child_process");
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

const APP = process.env.APP_URL || "http://127.0.0.1:4173/";
const SHOTS = process.argv[2] || join(tmpdir(), "plain-pdf-screenshots");
mkdirSync(SHOTS, { recursive: true });
const pdf = (name) => join(__dirname, "..", "fixtures", name);
const results = [];
const check = (name, ok, extra = "") => results.push(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  (" + extra + ")" : ""}`);
const pypdf = (code, file) => execFileSync("python3", ["-I", "-c", `import sys\nfrom pypdf import PdfReader\nr = PdfReader(sys.argv[1])\n${code}`, file]).toString().trim();

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
async function drag(page, from, to, steps = 12) {
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await page.mouse.move(to[0], to[1], { steps });
  await page.mouse.up();
}
const tile = (n) => `.organize .tile[data-pos="${n - 1}"]`;
const pageSize = (page, n) => page.$eval(`.page[data-page="${n}"]`, (el) => [el.offsetWidth, el.offsetHeight]);
const pageText = (page, n) => page.$eval(`.page[data-page="${n}"] .textLayer`, (t) => t.textContent);
async function savedFile(page, name) {
  const n = await page.evaluate(() => window.__saves.length);
  await page.waitForFunction((n) => window.__saves[n - 1]?.bytes, n);
  const file = join(SHOTS, name);
  writeFileSync(file, Buffer.from(await page.evaluate((n) => window.__saves[n - 1].bytes, n)));
  return { file, suggested: await page.evaluate((n) => window.__saves[n - 1].name, n) };
}
async function openOrganize(page) {
  await page.click('button[aria-label="More"]');
  await page.click(".menu-item >> text=Organize pages");
  await page.waitForSelector(".organize .tile .thumb canvas");
}
async function closeOrganize(page) {
  await page.click(".organize .done-button");
  await page.waitForTimeout(400);
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const problems = await watch(page, "desktop");
  page.on("dialog", (d) => d.accept());
  await page.goto(APP);
  await page.setInputFiles("input[type=file]", pdf("sample-25-pages.pdf"));
  await page.waitForSelector('.page[data-page="1"] .textLayer span');

  // A red line near the top-left of page 1, and one on page 2.
  const p1 = await box(page, '.page[data-page="1"]');
  await page.click('button[aria-label="Draw"]');
  await page.click('button[aria-label="Red pen"]');
  await page.click('button[aria-label="Thick line"]');
  await drag(page, [p1.x + p1.w * 0.08, p1.y + p1.h * 0.06], [p1.x + p1.w * 0.16, p1.y + p1.h * 0.06]);
  await page.click(".draw-options .done-button");

  // ----- The Organize screen -----
  await page.click('button[aria-label="More"]');
  check("More menu has Organize pages and Add pages", (await page.isVisible(".menu-item >> text=Organize pages")) && (await page.isVisible(".menu-item >> text=Add pages from another PDF")));
  await page.click(".menu-item >> text=Organize pages");
  await page.waitForSelector(".organize .tile .thumb canvas");
  await page.waitForTimeout(600);
  check("Organize shows every page", (await count(page, ".organize .tile")) === 25 && (await page.textContent(".organize-count")) === "25 pages");
  check("page previews are drawn", await page.$eval(`${tile(1)} canvas`, (c) => c.width > 50));
  await page.screenshot({ path: `${SHOTS}/c-d1-organize.png` });
  check("actions wait for a selection", await page.isDisabled(".organize-actions button[data-action='Delete']"));
  await page.click(tile(2));
  await page.click(tile(4), { modifiers: ["Shift"] });
  check("click and Shift-click select pages", (await page.textContent(".organize-count")) === "3 of 25 selected");
  await page.click(tile(3));
  await page.click(tile(4));
  check("clicking again deselects", (await page.textContent(".organize-count")) === "1 of 25 selected");

  // Delete page 2, then undo.
  await page.click(".organize-actions button[data-action='Delete']");
  check("Delete removes the selected page", (await count(page, ".organize .tile")) === 24);
  await page.click('.organize-bar button[data-action="Undo"]');
  check("Undo brings it back", (await count(page, ".organize .tile")) === 25);
  await page.click('.organize-bar button[data-action="Select all"]');
  check("can't delete every page", await page.isDisabled(".organize-actions button[data-action='Delete']"));
  await page.click('.organize-bar button[data-action="Select all"]'); // select none

  // Rotate page 1 right.
  await page.click(tile(1));
  await page.click(".organize-actions button[data-action='Rotate right']");
  await page.click(tile(1)); // deselect
  await closeOrganize(page);
  const [w1, h1] = await pageSize(page, 1);
  check("rotated page turns sideways", w1 > h1, `${w1}x${h1}`);
  const stroke = await page.$eval('.page[data-page="1"] .layer-ink path', (p) => {
    const pg = p.closest(".page").getBoundingClientRect(); const r = p.getBoundingClientRect();
    return [(r.left + r.width / 2 - pg.left) / pg.width, (r.top + r.height / 2 - pg.top) / pg.height];
  });
  // Top-left line (x 0.08-0.16, y 0.06) turns clockwise to the top-right: x ~ 0.94, y ~ 0.12.
  check("drawings turn with their page", Math.abs(stroke[0] - 0.94) < 0.03 && Math.abs(stroke[1] - 0.12) < 0.03, stroke.map((v) => v.toFixed(2)).join(","));
  const span = await page.$eval('.page[data-page="1"]', (pg) => {
    const p = pg.getBoundingClientRect();
    const s = [...pg.querySelectorAll(".textLayer span")].find((x) => x.textContent.includes("Sample document")).getBoundingClientRect();
    return [(s.left - p.left) / p.width, (s.top - p.top) / p.height, s.width / p.width, s.height / p.height];
  });
  // On the turned page the title runs top to bottom near the right edge.
  check("selectable text turns with the page", span[0] > 0.8 && span[3] > span[2], span.map((v) => v.toFixed(2)).join(","));
  await page.screenshot({ path: `${SHOTS}/c-d2-rotated.png` });

  // Move page 25 to the front by dragging.
  await openOrganize(page);
  await page.evaluate(() => (document.querySelector(".organize-grid").scrollTop = 99999));
  await page.waitForTimeout(300);
  const from = await box(page, tile(25));
  await page.evaluate(() => (document.querySelector(".organize-grid").scrollTop = 0));
  await page.waitForTimeout(300);
  // Drag with the grid scrolled to the end, then let the edge auto-scroll carry it to the top.
  await page.evaluate(() => (document.querySelector(".organize-grid").scrollTop = 99999));
  await page.waitForTimeout(300);
  const f2 = await box(page, tile(25));
  await page.mouse.move(f2.cx, f2.cy);
  await page.mouse.down();
  await page.mouse.move(f2.cx + 10, f2.cy + 10, { steps: 3 });
  const gridBox = await box(page, ".organize-grid");
  await page.mouse.move(gridBox.x + 40, gridBox.y + 20, { steps: 10 });
  await page.waitForFunction(() => document.querySelector(".organize-grid").scrollTop === 0, null, { timeout: 10000 });
  const first = await box(page, tile(1));
  await page.mouse.move(first.x + 10, first.cy, { steps: 5 });
  check("dragging shows where the page will go", (await count(page, ".tile.drop-before")) === 1);
  await page.mouse.up();
  await page.waitForTimeout(300);
  check("page 25 moved to the front", (await page.textContent(`${tile(1)} .tile-number`)) === "1" && (await page.textContent(".organize-count")) === "1 of 25 selected");
  void from;
  await closeOrganize(page);
  await page.waitForSelector('.page[data-page="1"] .textLayer span');
  check("the viewer shows the new order", (await pageText(page, 1)).includes("Page 25 of 25"));
  check("drawings stay with their page when it moves", (await count(page, '.page[data-page="2"] .layer-ink path')) === 1 && (await count(page, '.page[data-page="1"] .layer-ink path')) === 0);

  // Undo the move with Ctrl+Z; redo with Ctrl+Y.
  await page.keyboard.press("Control+z");
  await page.waitForSelector('.page[data-page="1"] .textLayer span');
  check("Ctrl+Z undoes the move", (await pageText(page, 1)).includes("Page 1 of 25"));
  await page.keyboard.press("Control+y");
  await page.waitForSelector('.page[data-page="1"] .textLayer span');
  check("Ctrl+Y redoes it", (await pageText(page, 1)).includes("Page 25 of 25"));

  // ----- Merge: add pages from two other files -----
  await openOrganize(page);
  await page.setInputFiles(".organize input[type=file]", [pdf("lease-test.pdf"), pdf("form-and-links.pdf")]);
  await page.waitForFunction(() => document.querySelectorAll(".organize .tile").length === 28, null, { timeout: 10000 });
  check("Add pages adds every page of the chosen files", true);
  check("says what was added", (await page.textContent(".toast")).includes("Added 3 pages"));
  await page.screenshot({ path: `${SHOTS}/c-d3-merged.png` });

  // ----- Split: save selected pages -----
  await page.click(tile(1));
  await page.click(tile(2));
  await page.click(tile(28));
  await page.click(".organize-actions button[data-action='Save as new PDF']");
  const sel = await savedFile(page, "saved-selected.pdf");
  check("Save as new PDF suggests name-selected.pdf", sel.suggested === "sample-25-pages-selected.pdf", sel.suggested);
  check("the new PDF has just the selected pages", pypdf("print(len(r.pages))", sel.file) === "3");
  const selText = pypdf("print('|'.join(p.extract_text()[:60].replace(chr(10),' ') for p in r.pages))", sel.file);
  check("...in order", /Page 25 of 25.*\|.*Page 1 of 25.*\|.*Page 2: you followed/.test(selText), selText);
  check("...with page 1 still turned", pypdf("print(r.pages[1].rotation)", sel.file) === "90");
  await page.click('.organize-bar button[data-action="Select all"]');
  await page.click('.organize-bar button[data-action="Select all"]');
  await closeOrganize(page);

  // ----- Save the whole reorganized, merged document -----
  await page.click("button.save-button");
  const all = await savedFile(page, "saved-organized.pdf");
  check("saved copy has all 28 pages", pypdf("print(len(r.pages))", all.file) === "28");
  check("saved copy keeps the new order and the added pages", /^Sample document Page 25 of 25/.test(pypdf("print(r.pages[0].extract_text().replace(chr(10),' '))", all.file)) && pypdf("print(r.pages[27].extract_text())", all.file).includes("followed the link"));
  check("saved copy keeps the rotation", pypdf("print(r.pages[1].rotation)", all.file) === "90");
  // Reopen and look for the red line on page 2 (the turned page), top-right.
  await page.setInputFiles("input[type=file]", all.file);
  await page.waitForFunction(() => document.querySelector(".file-name")?.textContent === "saved-organized.pdf");
  await page.evaluate(() => document.querySelector('.page[data-page="2"]').scrollIntoView({ block: "center" }));
  await page.waitForSelector('.page[data-page="2"] .page-canvas');
  await page.waitForTimeout(500);
  const red = await page.evaluate(() => {
    const c = document.querySelector('.page[data-page="2"] .page-canvas'); const ctx = c.getContext("2d");
    const d = ctx.getImageData(Math.floor(0.9 * c.width), Math.floor(0.04 * c.height), Math.floor(0.08 * c.width), Math.floor(0.16 * c.height)).data;
    let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 170 && d[i + 1] < 90 && d[i + 2] < 90) n++; return n;
  });
  check("saved drawing turned with its page, in the right place", red > 30, `${red} red pixels`);
  await page.screenshot({ path: `${SHOTS}/c-d4-saved.png` });
  check("desktop: no privacy-lock violations", (await page.evaluate(() => window.__csp)).length === 0);
  check("desktop: no errors or warnings", problems.length === 0, problems.join(" | "));
  await ctx.close();

  // ----- Phone: press and hold to drag -----
  const mctx = await browser.newContext({ ...devices["Pixel 7"] });
  const m = await mctx.newPage();
  const mp = await watch(m, "phone");
  await m.goto(APP);
  await m.setInputFiles("input[type=file]", pdf("sample-25-pages.pdf"));
  await m.waitForSelector(".page-canvas");
  await m.tap('button[aria-label="More"]');
  await m.tap(".menu-item >> text=Organize pages");
  await m.waitForSelector(".organize .tile .thumb canvas");
  await m.waitForTimeout(500);
  const bar = await box(m, ".organize-actions");
  check("phone: Organize fits the screen, 3 pages per row", bar.w <= 412.5 && (await m.$$eval(".organize .tile", (ts) => new Set(ts.slice(0, 6).map((t) => Math.round(t.getBoundingClientRect().top))).size)) === 2);
  await m.screenshot({ path: `${SHOTS}/c-m1-organize.png` });
  const cdp = await mctx.newCDPSession(m);
  const touch = (type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i })) });
  await m.tap(tile(2));
  await m.waitForTimeout(400);
  check("phone: tap selects", (await m.textContent(".organize-count")) === "1 of 25 selected");
  const t3 = await box(m, tile(3));
  const t1 = await box(m, tile(1));
  await touch("touchStart", [[t3.cx, t3.cy]]);
  await m.waitForTimeout(500); // press and hold
  for (let i = 1; i <= 10; i++) await touch("touchMove", [[t3.cx + ((t1.x + 5 - t3.cx) * i) / 10, t3.cy]]);
  await touch("touchEnd", []);
  await m.waitForTimeout(400);
  const order = await m.$$eval(".organize .tile", (ts) => ts.slice(0, 3).map((t) => t.dataset.pos));
  void order;
  await m.tap(".organize .done-button");
  await m.waitForSelector('.page[data-page="1"] .textLayer span');
  check("phone: press, hold and drag moves a page", (await pageText(m, 1)).includes("Page 3 of 25"));
  check("phone: no errors or warnings", mp.length === 0, mp.join(" | "));

  await browser.close();
  console.log(results.join("\n"));
  if (results.some((r) => r.startsWith("FAIL"))) process.exit(1);
})().catch((e) => { console.log(results.join("\n")); console.error(e); process.exit(1); });
