// Browser tests for the Text tool (Round A). Needs Python with pypdf.
// Run `npm run preview` first, then: node tests/e2e/text.test.cjs [screenshot-folder]
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
const texts = (page) => page.$$eval('g[data-kind="text"] text', (ts) => ts.map((t) => [...t.querySelectorAll("tspan")].map((s) => s.textContent).join("\n")));
async function drag(page, from, to, steps = 10) {
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await page.mouse.move(to[0], to[1], { steps });
  await page.mouse.up();
}
const pypdf = (code, file) => execFileSync("python3", ["-I", "-c", `import sys\nfrom pypdf import PdfReader\nr = PdfReader(sys.argv[1])\n${code}`, file]).toString().trim();

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const problems = await watch(page, "desktop");
  page.on("dialog", (d) => d.accept());
  await page.goto(APP);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.setInputFiles("input[type=file]", pdf("sample-25-pages.pdf"));
  await page.waitForSelector(".page-canvas");
  const pg = await box(page, '.page[data-page="1"]');
  const s = pg.w / 612;
  const at = (x, y) => [pg.x + x * s, pg.y + y * s];

  await page.click('button[aria-label="Text"]');
  check("Text tool turns on with its options", (await page.isVisible(".text-options")) && (await page.getAttribute('button[aria-label="Text"]', "aria-pressed")) === "true");
  check("medium black text by default", (await page.getAttribute('button[aria-label="Medium text"]', "aria-pressed")) === "true" && (await page.getAttribute('button[aria-label="Black text"]', "aria-pressed")) === "true");

  // Tap an empty spot (the page's right margin is empty) and type.
  await page.mouse.click(...at(80, 120));
  await page.waitForSelector(".text-editor");
  check("tapping the page opens a text box, ready to type", await page.evaluate(() => document.activeElement?.classList.contains("text-editor")));
  await page.keyboard.type("Hello world");
  await page.screenshot({ path: `${SHOTS}/a-d1-typing.png` });
  await page.keyboard.press("Escape");
  check("Esc finishes typing and adds the text", JSON.stringify(await texts(page)) === JSON.stringify(["Hello world"]));
  const t1 = await box(page, 'g[data-kind="text"]');
  check("text appears where tapped", Math.abs(t1.y + t1.h / 2 - at(80, 120)[1]) < 8 && Math.abs(t1.x - at(80, 120)[0]) < 3, `${Math.round(t1.x)},${Math.round(t1.y + t1.h / 2)}`);
  check("Undo becomes available", !(await page.isDisabled('button[aria-label="Undo"]')));

  // Tap the text to edit it.
  await page.mouse.click(t1.x + 10, t1.cy);
  await page.waitForSelector(".text-editor");
  check("tapping text opens it for editing", (await page.inputValue(".text-editor")) === "Hello world");
  await page.keyboard.press("End");
  await page.keyboard.type("!");
  await page.mouse.click(...at(540, 300)); // tap elsewhere (the empty right margin) to finish
  check("tapping elsewhere finishes editing", JSON.stringify(await texts(page)) === JSON.stringify(["Hello world!"]) && (await count(page, ".text-editor")) === 0);
  await page.keyboard.press("Control+z");
  check("undo restores the earlier wording", JSON.stringify(await texts(page)) === JSON.stringify(["Hello world"]));
  await page.keyboard.press("Control+y");

  // Large, blue, two lines.
  await page.click('button[aria-label="Large text"]');
  await page.click('button[aria-label="Blue text"]');
  await page.mouse.click(...at(70, 390));
  await page.waitForSelector(".text-editor");
  await page.keyboard.type("Line one");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Line two");
  await page.click(".text-options .done-button");
  const all = await texts(page);
  check("multi-line text keeps its lines", all.includes("Line one\nLine two"), JSON.stringify(all));
  const big = await page.$eval('g[data-kind="text"]:last-of-type text', (t) => [t.getAttribute("font-size"), t.getAttribute("fill")]);
  check("size and colour apply", big[0] === "18" && big[1] === "#1d4ed8", big.join(" "));
  check("Done turns the Text tool off", !(await page.isVisible(".text-options")));

  // Outside the Text tool: select, move, remove, re-edit.
  const t2 = await box(page, '.sig-box.text-box');
  await page.mouse.click(t2.cx, t2.cy);
  check("clicking text selects it", (await count(page, ".sig-box.text-box.selected")) === 1);
  await drag(page, [t2.cx, t2.cy], [t2.cx + 60, t2.cy + 30]);
  const t2b = await box(page, '.sig-box.text-box');
  check("dragging moves text", Math.abs(t2b.x - t2.x - 60) < 2 && Math.abs(t2b.y - t2.y - 30) < 2);
  await page.mouse.dblclick(t2b.cx, t2b.cy);
  await page.waitForSelector(".text-editor");
  check("double-click edits text", (await page.inputValue(".text-editor")) === "Hello world!" && (await page.isVisible(".text-options")));
  await page.keyboard.press("Escape");
  await page.click('button[aria-label="Text"]'); // off
  await page.mouse.click(t2b.cx, t2b.cy);
  await page.click(".sig-box.text-box.selected .sig-delete");
  check("× removes text", (await texts(page)).length === 1);
  await page.keyboard.press("Control+z");
  check("undo brings it back", (await texts(page)).length === 2);

  // Emptying a text box removes it.
  await page.click('button[aria-label="Text"]');
  const t3 = await box(page, '.sig-box.text-box');
  await page.mouse.click(t3.x + 5, t3.cy);
  await page.waitForSelector(".text-editor");
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Delete");
  await page.keyboard.press("Escape");
  check("emptying text removes it", (await texts(page)).length === 1);
  await page.keyboard.press("Control+z");
  check("...and undo restores it", (await texts(page)).length === 2);
  await page.click(".text-options .done-button");
  const fracs = await page.$$eval('g[data-kind="text"]', (gs) => gs.map((g) => {
    const p = g.closest(".page").getBoundingClientRect(); const r = g.getBoundingClientRect();
    return { x0: (r.left - p.left) / p.width, y0: (r.top - p.top) / p.height, x1: (r.right - p.left) / p.width, y1: (r.bottom - p.top) / p.height };
  }));
  await page.screenshot({ path: `${SHOTS}/a-d2-text.png` });

  // Save: real, selectable text in the right place.
  await page.click("button.save-button");
  await page.waitForFunction(() => window.__saves.length === 1 && window.__saves[0].bytes);
  const file = join(SHOTS, "saved-text-edited.pdf");
  writeFileSync(file, Buffer.from(await page.evaluate(() => window.__saves[0].bytes)));
  const extracted = pypdf("print(r.pages[0].extract_text())", file);
  check("saved text is real, searchable text", extracted.includes("Hello world!") && extracted.includes("Line one") && extracted.includes("Line two"));
  await page.setInputFiles("input[type=file]", file);
  await page.waitForFunction(() => document.querySelector(".file-name")?.textContent === "saved-text-edited.pdf");
  await page.waitForSelector(".page-canvas");
  await page.waitForTimeout(500);
  const ink = await page.evaluate((fracs) => {
    const c = document.querySelector('.page[data-page="1"] .page-canvas'); const ctx = c.getContext("2d");
    return fracs.map((f) => {
      const d = ctx.getImageData(Math.floor(f.x0 * c.width), Math.floor(f.y0 * c.height), Math.ceil((f.x1 - f.x0) * c.width), Math.ceil((f.y1 - f.y0) * c.height)).data;
      let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 120 || d[i + 2] - d[i] > 60) n++; return n;
    });
  }, fracs);
  check("saved text lands where it was typed", ink.every((n) => n > 40), ink.join(","));
  await page.screenshot({ path: `${SHOTS}/a-d3-saved-text.png` });
  check("desktop: no privacy-lock violations", (await page.evaluate(() => window.__csp)).length === 0);
  check("desktop: no errors or warnings", problems.length === 0, problems.join(" | "));
  await ctx.close();

  // Phone
  const mctx = await browser.newContext({ ...devices["Pixel 7"] });
  const m = await mctx.newPage();
  const mp = await watch(m, "phone");
  await m.goto(APP);
  await m.setInputFiles("input[type=file]", pdf("lease-test.pdf"));
  await m.waitForSelector(".page-canvas");
  const bar = await box(m, ".tool-group");
  check("phone: bottom bar has Draw, Text, Sign, Undo, Redo and fits", (await m.isVisible('.tool-group button[aria-label="Text"]')) && bar.w <= 412);
  await m.tap('button[aria-label="Text"]');
  const strip = await box(m, ".text-options");
  check("phone: text options fit the screen", strip.x >= 0 && strip.x + strip.w <= 412);
  const mpg = await box(m, '.page[data-page="1"]');
  await m.waitForTimeout(400);
  await m.tap('.page[data-page="1"]', { position: { x: mpg.w * 0.2, y: mpg.h * 0.4 } });
  await m.waitForSelector(".text-editor");
  await m.keyboard.type("Phone text");
  await m.screenshot({ path: `${SHOTS}/a-m1-typing.png` });
  await m.waitForTimeout(400);
  await m.tap(".text-options .done-button");
  check("phone: tap and type adds text", JSON.stringify(await texts(m)) === JSON.stringify(["Phone text"]));
  check("phone: no errors or warnings", mp.length === 0, mp.join(" | "));

  await browser.close();
  console.log(results.join("\n"));
  if (results.some((r) => r.startsWith("FAIL"))) process.exit(1);
})().catch((e) => { console.log(results.join("\n")); console.error(e); process.exit(1); });
