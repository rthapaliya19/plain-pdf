// Browser tests for the chapter list (Contents).
// tests/fixtures/chapters.pdf is sample-25-pages.pdf with a chapter list added (pypdf):
//   Introduction (p1), Part One (p3) > Chapter 1 (p4), Chapter 2 (p8, halfway down),
//   Part Two (p15, bold) > Chapter 3 (p16, italic), Chapter 4 (p20) > Section 4.1 (p21),
//   Appendix (named destination, p25), Project web site (a web link), Broken entry (leads nowhere).
// Run `npm run preview` first, then: node tests/e2e/contents.test.cjs [screenshot-folder]
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
  });
  return problems;
}
const box = (page, sel) => page.$eval(sel, (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; });
const count = (page, sel) => page.locator(sel).count();
/** The chapter list as shown: titles (with page numbers) of the entries that are showing. */
const shown = (page) => page.$$eval(".contents-link", (ls) => ls.filter((l) => l.offsetParent !== null).map((l) => l.querySelector(".contents-title").textContent + (l.querySelector(".contents-page") ? ` ${l.querySelector(".contents-page").textContent}` : "")));
const entry = (title) => `.contents-link:has(.contents-title:text-is("${title}"))`;
const toggle = (title) => `.contents-row:has(.contents-title:text-is("${title}")) .contents-toggle`;
const currentEntry = (page) => page.$$eval(".contents-item.current > .contents-row .contents-title", (ts) => ts.map((t) => t.textContent));
const pageNumber = (page) => page.inputValue(".page-input");
/** Where the window's top edge is on page `n`, in points from that page's top. */
const topOnPage = (page, n, height) => page.evaluate(({ n, height }) => {
  const v = document.querySelector(".viewer"); const p = document.querySelector(`.page[data-page="${n}"]`);
  return (v.scrollTop - p.offsetTop) / (p.offsetHeight / height);
}, { n, height });
async function goToPage(page, n) {
  await page.fill(".page-input", String(n));
  await page.press(".page-input", "Enter");
  await page.waitForTimeout(200);
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const problems = await watch(page, "desktop");
  const dialogs = [];
  page.on("dialog", (d) => d.dismiss());
  await page.goto(APP);

  // A PDF without a chapter list: no button.
  await page.setInputFiles("input[type=file]", pdf("sample-25-pages.pdf"));
  await page.waitForSelector(".page-canvas");
  await page.waitForTimeout(300);
  check("no Contents button when the PDF has no chapter list", !(await page.isVisible('button[aria-label="Contents"]')));

  // A PDF with one.
  await page.setInputFiles("input[type=file]", pdf("chapters.pdf"));
  await page.waitForFunction(() => document.querySelector(".file-name")?.textContent === "chapters.pdf");
  await page.waitForSelector('button[aria-label="Contents"]:visible');
  check("Contents button appears when the PDF has a chapter list", true);
  check("...and the list starts closed", !(await page.isVisible(".contents-panel")));
  await page.click('button[aria-label="Contents"]');
  await page.waitForSelector(".contents-panel:visible");
  check("Contents opens the chapter list", (await page.getAttribute('button[aria-label="Contents"]', "aria-pressed")) === "true");
  const viewer = await box(page, ".viewer");
  const panel = await box(page, ".contents-panel");
  check("on a computer, the pages move over to make room", Math.abs(viewer.x - (panel.x + panel.w)) < 2 && panel.w === 300, `${panel.w}, ${viewer.x}`);
  check(
    "top-level chapters with their page numbers; entries leading nowhere are left out",
    JSON.stringify(await shown(page)) === JSON.stringify(["Introduction 1", "Part One 3", "Part Two 15", "Appendix 25", "Project web site"]),
    JSON.stringify(await shown(page)),
  );
  check("bold chapters show in bold", (await page.$eval(`${entry("Part Two")} .contents-title`, (t) => getComputedStyle(t).fontWeight)) === "600");
  check("chapters with sections can be opened up", (await count(page, toggle("Part One") + ":not([disabled])")) === 1 && (await count(page, toggle("Introduction") + "[disabled]")) === 1);
  await page.screenshot({ path: `${SHOTS}/contents-d1.png` });

  // Opening up a chapter and going to its sections.
  await page.click(toggle("Part One"));
  check("opening a chapter shows its sections", JSON.stringify((await shown(page)).slice(1, 4)) === JSON.stringify(["Part One 3", "Chapter 1 4", "Chapter 2 8"]));
  await page.click(entry("Chapter 1"));
  await page.waitForTimeout(200);
  check("choosing a chapter goes to its page", (await pageNumber(page)) === "4");
  const t1 = await topOnPage(page, 4, 792);
  check("...with the top of the page at the top of the window", t1 > -10 && t1 < 2, t1.toFixed(1));
  check("on a computer, the list stays open while reading", await page.isVisible(".contents-panel"));
  await page.click(entry("Chapter 2"));
  await page.waitForTimeout(200);
  const t2 = await topOnPage(page, 8, 595);
  // Chapter 2 starts at height 396 of a 595-point-tall page (from the bottom), so 199 points from its top.
  check("a chapter starting part-way down a page goes to that spot", (await pageNumber(page)) === "8" && Math.abs(t2 - 199) < 10, `page ${await pageNumber(page)}, ${t2.toFixed(1)} pt`);
  check("the chapter being read is highlighted", JSON.stringify(await currentEntry(page)) === JSON.stringify(["Chapter 2"]));
  await page.click(entry("Appendix"));
  await page.waitForTimeout(200);
  check("chapters pointing to a named spot work too", (await pageNumber(page)) === "25");

  // The highlight follows reading.
  await goToPage(page, 10);
  check("reading on: the highlight stays on the chapter you're in", JSON.stringify(await currentEntry(page)) === JSON.stringify(["Chapter 2"]));
  await goToPage(page, 21);
  check("inside a closed chapter, the chapter itself is highlighted", JSON.stringify(await currentEntry(page)) === JSON.stringify(["Part Two"]));
  await page.click(toggle("Part Two"));
  await page.click(toggle("Chapter 4"));
  check("...and its section once opened up", JSON.stringify(await currentEntry(page)) === JSON.stringify(["Section 4.1"]));
  check("italic chapters show in italic", (await page.$eval(`${entry("Chapter 3")} .contents-title`, (t) => getComputedStyle(t).fontStyle)) === "italic");
  await goToPage(page, 1);
  check("back at the start: Introduction", JSON.stringify(await currentEntry(page)) === JSON.stringify(["Introduction"]));

  // Keyboard: arrows move, Right opens, Left closes.
  await page.focus(entry("Introduction"));
  await page.keyboard.press("ArrowDown");
  check("Down arrow moves to the next chapter", await page.$eval(entry("Part One"), (b) => b === document.activeElement));
  await page.keyboard.press("ArrowLeft");
  check("Left arrow closes a chapter's sections", !(await page.isVisible(entry("Chapter 1"))));
  await page.keyboard.press("ArrowRight");
  check("Right arrow opens them", await page.isVisible(entry("Chapter 1")));
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  check("Enter goes to the chapter", (await pageNumber(page)) === "3");

  // A web link asks first.
  page.removeAllListeners("dialog");
  page.on("dialog", (d) => { dialogs.push(d.message()); d.dismiss(); });
  await page.click(entry("Project web site"));
  await page.waitForSelector("dialog[open] >> text=Open this link in your browser?");
  check("a web link in the list asks before opening", (await page.textContent("dialog[open]")).includes("https://example.com/"));
  await page.click("dialog[open] >> text=Cancel");

  // Deleting a page: its chapter can't be chosen; the rest point to where their pages are now.
  await page.click('button[aria-label="More"]');
  await page.click(".menu-item >> text=Organize pages");
  await page.waitForSelector(".organize .tile .thumb canvas");
  await page.click('.organize .tile[data-pos="3"]');
  await page.click(".organize-actions button[data-action='Delete']");
  await page.click(".organize .done-button");
  await page.waitForTimeout(500);
  check("after deleting page 4, Chapter 1 can't be chosen", await page.isDisabled(entry("Chapter 1")));
  check("...and Chapter 2 now points to page 7", (await shown(page)).includes("Chapter 2 7"), JSON.stringify(await shown(page)));
  check("...and the list stays open, as it was", (await page.isVisible(".contents-panel")) && (await page.isVisible(entry("Chapter 2"))));
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(500);
  check("undo puts Chapter 1 back", !(await page.isDisabled(entry("Chapter 1"))) && (await shown(page)).includes("Chapter 2 8"));

  // Close.
  await page.click(".contents-close");
  check("× closes the list", !(await page.isVisible(".contents-panel")) && (await page.getAttribute('button[aria-label="Contents"]', "aria-pressed")) === "false");
  check("...and the pages use the full width again", (await box(page, ".viewer")).x === 0);
  await page.click('button[aria-label="Contents"]');
  await page.click('button[aria-label="Contents"]');
  check("the Contents button also closes it", !(await page.isVisible(".contents-panel")));

  // Opening a file without a chapter list hides the button (and the list).
  await page.click('button[aria-label="Contents"]');
  await page.setInputFiles("input[type=file]", pdf("lease-test.pdf"));
  await page.waitForTimeout(500);
  if (await page.isVisible("dialog[open] >> text=Discard and open")) await page.click("dialog[open] >> text=Discard and open");
  await page.waitForFunction(() => document.querySelector(".file-name")?.textContent === "lease-test.pdf");
  await page.waitForTimeout(300);
  check("opening a PDF without chapters hides the button and the list", !(await page.isVisible('button[aria-label="Contents"]')) && !(await page.isVisible(".contents-panel")) && (await box(page, ".viewer")).x === 0);
  check("no browser pop-ups", dialogs.length === 0, dialogs.join(" | "));
  check("desktop: no privacy-lock violations", (await page.evaluate(() => window.__csp)).length === 0);
  check("desktop: no errors or warnings", problems.length === 0, problems.join(" | "));
  await ctx.close();

  // ----- Phone -----
  const mctx = await browser.newContext({ ...devices["Pixel 7"] });
  const m = await mctx.newPage();
  const mp = await watch(m, "phone");
  await m.goto(APP);
  await m.setInputFiles("input[type=file]", pdf("chapters.pdf"));
  await m.waitForSelector('button[aria-label="Contents"]:visible');
  const items = await m.$$eval(".toolbar > *:not([hidden]), .doc-controls > *:not([hidden])", (els) => els.map((e) => { const r = e.getBoundingClientRect(); return [r.left, r.right]; }));
  check("phone: the top bar still fits with the Contents button", items.every(([l, r]) => l >= 0 && r <= 412.5), JSON.stringify(items.map(([l, r]) => [Math.round(l), Math.round(r)])));
  await m.tap('button[aria-label="Contents"]');
  await m.waitForSelector(".contents-panel:visible");
  const mpanel = await box(m, ".contents-panel");
  const mviewer = await box(m, ".viewer");
  check("phone: the list slides over the pages", mpanel.x === 0 && mpanel.w <= 412 * 0.86 + 1 && mviewer.x === 0 && (await m.isVisible(".contents-backdrop")), `${mpanel.w}`);
  check("phone: the list ends above the bottom bar", mpanel.y + mpanel.h <= (await box(m, ".tool-group")).y + 1);
  await m.screenshot({ path: `${SHOTS}/contents-m1.png` });
  await m.tap(toggle("Part Two"));
  await m.tap(entry("Chapter 3"));
  await m.waitForTimeout(300);
  check("phone: choosing a chapter goes there and closes the list", (await pageNumber(m)) === "16" && !(await m.isVisible(".contents-panel")) && !(await m.isVisible(".contents-backdrop")));
  await m.tap('button[aria-label="Contents"]');
  check("phone: reopening remembers opened chapters and highlights the one being read", (await m.isVisible(entry("Chapter 3"))) && JSON.stringify(await currentEntry(m)) === JSON.stringify(["Chapter 3"]));
  await m.screenshot({ path: `${SHOTS}/contents-m2.png` });
  await m.tap(".contents-backdrop", { position: { x: 390, y: 300 } });
  check("phone: tapping beside the list closes it", !(await m.isVisible(".contents-panel")));
  check("phone: no errors or warnings", mp.length === 0, mp.join(" | "));

  await browser.close();
  console.log(results.join("\n"));
  if (results.some((r) => r.startsWith("FAIL"))) process.exit(1);
})().catch((e) => { console.log(results.join("\n")); console.error(e); process.exit(1); });
