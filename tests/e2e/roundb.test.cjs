// Browser tests for Round B: select and copy text, search, print.
// Run `npm run preview` first, then: node tests/e2e/roundb.test.cjs [screenshot-folder]
const { chromium, devices } = require("playwright");
const { mkdirSync } = require("node:fs");
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
    // Instead of the real print window, record what would be printed.
    window.__prints = [];
    window.print = () => {
      const imgs = [...document.querySelectorAll("#print-root img")];
      window.__prints.push(imgs.map((img) => ({ w: img.naturalWidth, h: img.naturalHeight, landscape: img.parentElement.classList.contains("landscape"), src: img.src })));
      setTimeout(() => window.dispatchEvent(new Event("afterprint")), 50);
    };
  });
  return problems;
}
const box = (page, sel) => page.$eval(sel, (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; });
async function drag(page, from, to, steps = 10) {
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await page.mouse.move(to[0], to[1], { steps });
  await page.mouse.up();
}
/** Counts pixels of a colour in a printed page image. */
const imagePixels = (page, src, frac) => page.evaluate(async ({ src, frac }) => {
  const img = new Image(); img.src = src; await img.decode();
  const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight;
  const ctx = c.getContext("2d"); ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(Math.floor(frac.x0 * c.width), Math.floor(frac.y0 * c.height), Math.ceil((frac.x1 - frac.x0) * c.width), Math.ceil((frac.y1 - frac.y0) * c.height)).data;
  let red = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 170 && d[i + 1] < 90 && d[i + 2] < 90) red++; return red;
}, { src, frac });

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await ctx.newPage();
  const problems = await watch(page, "desktop");
  page.on("dialog", (d) => d.accept());
  await page.goto(APP);
  await page.setInputFiles("input[type=file]", pdf("sample-25-pages.pdf"));
  await page.waitForSelector('.page[data-page="1"] .textLayer span');
  const pg = await box(page, '.page[data-page="1"]');
  const s = pg.w / 612;
  const at = (x, y) => [pg.x + x * s, pg.y + y * s];

  // ----- Select and copy -----
  check("pages have selectable text", (await page.locator('.page[data-page="1"] .textLayer span').count()) > 10);
  await drag(page, at(50, 150 + 22 * 2 - 4), at(200, 150 + 22 * 2 - 4), 10);
  const selected = await page.evaluate(() => window.getSelection().toString());
  check("dragging across text selects it", selected.startsWith("The quick brown"), JSON.stringify(selected));
  await page.keyboard.press("Control+c");
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  check("Ctrl+C copies the selected text", copied.includes("quick brown"), JSON.stringify(copied));
  await page.mouse.click(...at(560, 120));
  await page.click('button[aria-label="Draw"]');
  await drag(page, at(60, 260), at(200, 262), 8);
  check("while drawing, dragging draws instead of selecting", (await page.evaluate(() => window.getSelection().toString())) === "" && (await page.locator(".layer-ink path").count()) === 1);
  await page.keyboard.press("Control+z");
  await page.click(".draw-options .done-button");

  // ----- Search -----
  await page.keyboard.press("Control+f");
  check("Ctrl+F opens search, ready to type", (await page.isVisible(".search-bar")) && (await page.evaluate(() => document.activeElement?.classList.contains("search-input"))));
  await page.keyboard.type("page 7 of 25");
  await page.waitForFunction(() => /of 1$/.test(document.querySelector(".search-status")?.textContent ?? ""), null, { timeout: 15000 });
  check("finds a phrase, ignoring upper/lower case", (await page.textContent(".search-status")) === "1 of 1");
  await page.waitForTimeout(300);
  check("jumps to the page with the match", (await page.inputValue(".page-input")) === "7");
  check("the match is highlighted", (await page.locator('.page[data-page="7"] .search-hit.current').count()) >= 1);
  const hit = await box(page, '.page[data-page="7"] .search-hit.current');
  const vbox = await box(page, ".viewer");
  check("the match is in view", hit.y > vbox.y && hit.y < vbox.y + vbox.h);
  await page.screenshot({ path: `${SHOTS}/b-d1-search.png` });

  await page.fill(".search-input", "lazy dog");
  await page.waitForFunction(() => /^1 of 545$/.test(document.querySelector(".search-status")?.textContent ?? ""), null, { timeout: 20000 });
  // 22 lines x 25 pages, minus one line that falls below the edge of each of the 5 landscape pages.
  check("counts every match in the document", (await page.textContent(".search-status")) === "1 of 545");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  check("Enter goes to the next match", (await page.textContent(".search-status")) === "3 of 545");
  await page.keyboard.press("Shift+Enter");
  check("Shift+Enter goes back", (await page.textContent(".search-status")) === "2 of 545");
  await page.click('.search-bar button[aria-label^="Previous"]');
  await page.click('.search-bar button[aria-label^="Previous"]');
  check("going back from the first match wraps to the last", (await page.textContent(".search-status")) === "545 of 545");
  await page.waitForTimeout(300);
  check("...on the last page", (await page.inputValue(".page-input")) === "25");
  await page.fill(".search-input", "zzzz");
  await page.waitForFunction(() => document.querySelector(".search-status")?.textContent === "No matches", null, { timeout: 15000 });
  check("says when nothing matches", true);
  await page.keyboard.press("Escape");
  check("Esc closes search and removes the highlights", !(await page.isVisible(".search-bar")) && (await page.locator(".search-hit").count()) === 0);

  // ----- Print -----
  await page.$eval(".viewer", (v) => (v.scrollTop = 0));
  await page.waitForTimeout(300);
  await page.click('button[aria-label="Draw"]');
  await page.click('button[aria-label="Red pen"]');
  await page.click('button[aria-label="Thick line"]');
  await drag(page, at(540, 200), at(540, 400), 10); // red line in the right margin of page 1
  await page.click(".draw-options .done-button");
  await page.click('button[aria-label="More"]');
  check("More menu shows Print", await page.isVisible(".menu-item >> text=Print"));
  await page.screenshot({ path: `${SHOTS}/b-d2-menu.png` });
  await page.click(".menu-item >> text=Print");
  await page.waitForFunction(() => window.__prints.length === 1, null, { timeout: 60000 });
  const printed = await page.evaluate(() => window.__prints[0]);
  check("print prepares every page", printed.length === 25, `${printed.length} pages`);
  check("printed pages are sharp (300 dots per inch)", printed[0].w === 2550 && printed[0].h === 3300, `${printed[0].w}x${printed[0].h}`);
  check("landscape pages print landscape", printed[2].landscape && !printed[0].landscape);
  const red = await imagePixels(page, printed[0].src, { x0: 530 / 612, y0: 200 / 792, x1: 550 / 612, y1: 400 / 792 });
  check("your drawing is in the printout, in the right place", red > 200, `${red} red pixels`);
  await page.waitForTimeout(200);
  check("print pictures are cleaned up afterwards", (await page.locator("#print-root").count()) === 0);
  await page.keyboard.press("Control+p");
  await page.waitForFunction(() => window.__prints.length === 2, null, { timeout: 60000 });
  check("Ctrl+P prints too", true);

  // Forms: printed with their answers
  await page.setInputFiles("input[type=file]", pdf("form-and-links.pdf"));
  await page.waitForSelector("dialog[open]");
  await page.click("dialog[open] >> text=Discard and open");
  await page.waitForSelector('.annotationLayer input[type="text"]');
  await page.fill('.annotationLayer input[type="text"]', "Printed Name");
  await page.keyboard.press("Control+p");
  await page.waitForFunction(() => window.__prints.length === 3, null, { timeout: 60000 });
  const formPrint = await page.evaluate(() => window.__prints[2]);
  check("filled forms print (2 pages)", formPrint.length === 2);
  check("desktop: no privacy-lock violations", (await page.evaluate(() => window.__csp)).length === 0);
  check("desktop: no errors or warnings", problems.length === 0, problems.join(" | "));
  await ctx.close();

  // ----- Phone -----
  const mctx = await browser.newContext({ ...devices["Pixel 7"] });
  const m = await mctx.newPage();
  const mp = await watch(m, "phone");
  await m.goto(APP);
  await m.setInputFiles("input[type=file]", pdf("sample-25-pages.pdf"));
  await m.waitForSelector(".page-canvas");
  const top = await box(m, ".toolbar");
  const items = await m.$$eval(".toolbar > *:not([hidden]), .doc-controls > *", (els) => els.map((e) => { const r = e.getBoundingClientRect(); return [r.left, r.right]; }));
  check("phone: top bar fits (Open, name, search, page, More, Save)", items.every(([l, r]) => l >= 0 && r <= 412.5), JSON.stringify(items.map(([l, r]) => [Math.round(l), Math.round(r)])));
  await m.tap('button[aria-label="Search"]');
  await m.keyboard.type("page 3 of");
  await m.waitForFunction(() => /^1 of 1$/.test(document.querySelector(".search-status")?.textContent ?? ""), null, { timeout: 15000 });
  const bar = await box(m, ".search-bar");
  check("phone: search bar fits and finds", bar.x >= 0 && bar.x + bar.w <= 412.5);
  await m.screenshot({ path: `${SHOTS}/b-m1-search.png` });
  check("phone: no errors or warnings", mp.length === 0, mp.join(" | "));
  void top;

  await browser.close();
  console.log(results.join("\n"));
  if (results.some((r) => r.startsWith("FAIL"))) process.exit(1);
})().catch((e) => { console.log(results.join("\n")); console.error(e); process.exit(1); });
