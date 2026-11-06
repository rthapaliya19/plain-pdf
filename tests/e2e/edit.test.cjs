// Browser tests for editing the PDF's own text (version 1.1). Needs Python with pypdf.
// Run `npm run preview` first, then: node tests/e2e/edit.test.cjs [screenshot-folder]
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
const editTexts = (page) => page.$$eval('g[data-kind="edit"] text', (ts) => ts.map((t) => [...t.querySelectorAll("tspan")].map((s) => s.textContent).join("\n")));
const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const problems = await watch(page, "desktop");
  page.on("dialog", (d) => d.accept());
  await page.goto(APP);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.setInputFiles("input[type=file]", pdf("sample-25-pages.pdf"));
  await page.waitForSelector('.page[data-page="1"] .page-canvas');
  const pg = await box(page, '.page[data-page="1"]');
  const s = pg.w / 612;
  const at = (x, y) => [pg.x + x * s, pg.y + y * s];
  const baselineOf = (n) => 150 + 22 * n; // body text: 11 pt Helvetica, x = 50

  // ----- Tap a line to edit it -----
  await page.click('button[aria-label="Text"]');
  await page.waitForTimeout(400);
  await page.mouse.click(...at(200, baselineOf(2) - 3));
  await page.waitForSelector(".edit-editor");
  const original = "The quick brown fox jumps over the lazy dog. Lorem ipsum dolor sit amet, consectetur.";
  check("tapping a line opens it for editing", (await page.inputValue(".edit-editor")) === original, await page.inputValue(".edit-editor"));
  const style = await page.$eval(".edit-editor", (t) => [getComputedStyle(t).fontFamily, getComputedStyle(t).fontWeight, getComputedStyle(t).backgroundColor]);
  check("editor matches the text's look (plain font, regular)", style[0].startsWith("Arimo") && style[1] === "400", style.join(" | "));
  check("first time: explains the old words are removed when saving", (await page.textContent(".toast"))?.includes("removed from it for good"));
  await page.screenshot({ path: `${SHOTS}/e-d1-editing.png`, clip: { x: pg.x, y: at(0, baselineOf(1))[1], width: 820, height: 90 } });
  await page.keyboard.press("Control+a");
  await page.keyboard.type(original.replace("lazy", "sleepy"));
  await page.keyboard.press("Escape");
  check("Esc finishes the edit", JSON.stringify(await editTexts(page)) === JSON.stringify([original.replace("lazy", "sleepy")]));
  const edit = await page.$eval('g[data-kind="edit"]', (g) => {
    const rect = g.querySelector("rect");
    const span = g.querySelector("tspan");
    const m = g.querySelector("g").getAttribute("transform").match(/-?[\d.]+/g).map(Number);
    return { fill: rect.getAttribute("fill"), baseline: m[5] + Number(span.getAttribute("y")), x: m[4], size: Number(g.querySelector("text").getAttribute("font-size")), color: g.querySelector("text").getAttribute("fill") };
  });
  check("new words sit exactly on the old line", Math.abs(edit.baseline - baselineOf(2)) < 0.6 && Math.abs(edit.x - 50) < 1, `baseline ${edit.baseline.toFixed(1)}, x ${edit.x.toFixed(1)}`);
  check("same size as the original (11 pt)", Math.abs(edit.size - 11) < 0.2, String(edit.size));
  check("patch matches the white paper", edit.fill === "#ffffff", edit.fill);
  const ink = hexToRgb(edit.color);
  check("ink colour picked up from the page (dark grey)", ink.every((v) => v < 90), edit.color);
  await page.screenshot({ path: `${SHOTS}/e-d2-edited.png`, clip: { x: pg.x, y: at(0, baselineOf(1))[1], width: 820, height: 90 } });

  // Re-edit by tapping it, undo and redo.
  await page.mouse.click(...at(120, baselineOf(2) - 3));
  await page.waitForSelector(".edit-editor");
  check("tapping an edit reopens it", (await page.inputValue(".edit-editor")).includes("sleepy"));
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+z");
  check("undo removes the edit (original shows again)", (await count(page, 'g[data-kind="edit"]')) === 0);
  await page.keyboard.press("Control+y");
  check("redo brings it back", (await count(page, 'g[data-kind="edit"]')) === 1);

  // ----- Drag down across lines to edit a paragraph -----
  await drag(page, at(100, baselineOf(5) - 3), at(140, baselineOf(7) - 3));
  await page.waitForSelector(".edit-editor");
  const para = await page.inputValue(".edit-editor");
  check("dragging across 3 lines edits them as one paragraph", para === [original, original, original].join(" "), para.slice(0, 60));
  await page.keyboard.press("End");
  await page.keyboard.type(" And this sentence is new, which makes the paragraph quite a lot longer than it was before, so it needs more room.");
  await page.waitForTimeout(150);
  check("longer text shows the warning", await page.isVisible(".edit-warning"));
  await page.screenshot({ path: `${SHOTS}/e-d3-overflow.png`, clip: { x: pg.x, y: at(0, baselineOf(4))[1], width: 820, height: 150 } });
  await page.click(".edit-warning button");
  await page.waitForTimeout(150);
  check("Shrink to fit makes it fit", !(await page.isVisible(".edit-warning")));
  await page.keyboard.press("Escape");
  const p2 = await page.$$eval('g[data-kind="edit"] text', (ts) => ts.map((t) => [Number(t.getAttribute("font-size")), t.querySelectorAll("tspan").length]));
  check("the paragraph rewraps, a little smaller", p2.length === 2 && p2[1][0] < 11 && p2[1][1] >= 3, JSON.stringify(p2));

  // ----- Outside the Text tool: select an edit, × undoes it -----
  await page.click(".text-options .done-button");
  const eb = await box(page, ".sig-box.edit-box");
  await page.mouse.click(eb.cx, eb.cy);
  check("an edit can be selected", (await count(page, ".sig-box.edit-box.selected")) === 1);
  await page.click(".sig-box.edit-box.selected .sig-delete");
  check("× undoes that edit", (await count(page, 'g[data-kind="edit"]')) === 1);
  await page.keyboard.press("Control+z");

  // ----- Save -----
  await page.click("button.save-button");
  await page.waitForFunction(() => window.__saves.length === 1 && window.__saves[0].bytes);
  const file = join(SHOTS, "saved-edits.pdf");
  writeFileSync(file, Buffer.from(await page.evaluate(() => window.__saves[0].bytes)));
  const text = pypdf("print(r.pages[0].extract_text().replace(chr(10), ' '))", file);
  check("saved copy contains the new words as real text", text.includes("sleepy dog") && text.includes("this sentence is new"));
  // The old words are gone from the copy: the edited line reads only the new wording, at the same height.
  const lineWords = (f) => {
    const html = execFileSync("pdftotext", ["-f", "1", "-l", "1", "-bbox", f, "-"]).toString();
    return [...html.matchAll(/<word xMin="[\d.]+" yMin="([\d.]+)" xMax="[\d.]+" yMax="([\d.]+)">([^<]*)<\/word>/g)].map((m) => ({ y: (+m[1] + +m[2]) / 2, text: m[3] }));
  };
  // (The first edit was on the third body line, baseline 194.)
  const line1 = lineWords(file).filter((x) => Math.abs(x.y - (baselineOf(2) - 3)) < 3).map((x) => x.text).join(" ");
  check("the edited line's old words are removed from the saved file", line1.includes("sleepy") && !line1.includes("lazy"), line1);
  await page.setInputFiles("input[type=file]", file);
  await page.waitForFunction(() => document.querySelector(".file-name")?.textContent === "saved-edits.pdf");
  await page.waitForSelector(".page-canvas");
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}/e-d4-saved.png`, clip: { x: pg.x, y: at(0, baselineOf(1))[1], width: 820, height: 200 } });

  // ----- Scans: drag a box, type the replacement -----
  await page.setInputFiles("input[type=file]", pdf("scanned-letter.pdf"));
  await page.waitForFunction(() => document.querySelector(".file-name")?.textContent === "scanned-letter.pdf");
  await page.waitForSelector(".page-canvas");
  await page.waitForTimeout(500);
  const sp = await box(page, '.page[data-page="1"]');
  const ss = sp.w / 612;
  await page.click('button[aria-label="Text"]');
  // The 3rd line of the scan sits around 165-180 pt from the top; cover "a picture of text".
  await drag(page, [sp.x + 150 * ss, sp.y + 163 * ss], [sp.x + 260 * ss, sp.y + 180 * ss], 10);
  await page.waitForSelector(".edit-editor");
  check("dragging a box on a scan opens an empty editor", (await page.inputValue(".edit-editor")) === "");
  await page.keyboard.type("a scan, edited");
  await page.keyboard.press("Escape");
  const scanEdit = await page.$eval('g[data-kind="edit"] rect', (r) => r.getAttribute("fill"));
  const paper = hexToRgb(scanEdit);
  check("the patch matches the scan's cream paper", Math.abs(paper[0] - 247) < 6 && Math.abs(paper[1] - 245) < 6 && Math.abs(paper[2] - 239) < 6, scanEdit);
  await page.screenshot({ path: `${SHOTS}/e-d5-scan.png`, clip: { x: sp.x, y: sp.y + 130 * ss, width: 700, height: 100 } });
  check("desktop: no privacy-lock violations", (await page.evaluate(() => window.__csp)).length === 0);
  check("desktop: no errors or warnings", problems.length === 0, problems.join(" | "));
  await ctx.close();

  // ----- Phone -----
  const mctx = await browser.newContext({ ...devices["Pixel 7"] });
  const m = await mctx.newPage();
  const mp = await watch(m, "phone");
  await m.goto(APP);
  await m.setInputFiles("input[type=file]", pdf("sample-25-pages.pdf"));
  await m.waitForSelector('.page[data-page="1"] .page-canvas');
  await m.tap('button[aria-label="Text"]');
  await m.waitForTimeout(600);
  const mpg = await box(m, '.page[data-page="1"]');
  const ms = mpg.w / 612;
  await m.tap('.page[data-page="1"]', { position: { x: 200 * ms, y: (baselineOf(3) - 3) * ms } });
  await m.waitForSelector(".edit-editor");
  check("phone: tapping a line opens it for editing", (await m.inputValue(".edit-editor")).startsWith("The quick brown"));
  await m.screenshot({ path: `${SHOTS}/e-m1-editing.png` });
  await m.keyboard.press("Escape");
  const cdp = await mctx.newCDPSession(m);
  const touch = (type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i })) });
  const scroll0 = await m.$eval(".viewer", (v) => v.scrollTop);
  await touch("touchStart", [[150, 500], [250, 500]]);
  for (let i = 1; i <= 8; i++) await touch("touchMove", [[150, 500 - i * 25], [250, 500 - i * 25]]);
  await touch("touchEnd", []);
  await m.waitForTimeout(400);
  check("phone: two fingers still scroll in the Text tool", (await m.$eval(".viewer", (v) => v.scrollTop)) > scroll0 + 100);
  check("phone: no errors or warnings", mp.length === 0, mp.join(" | "));

  await browser.close();
  console.log(results.join("\n"));
  if (results.some((r) => r.startsWith("FAIL"))) process.exit(1);
})().catch((e) => { console.log(results.join("\n")); console.error(e); process.exit(1); });
