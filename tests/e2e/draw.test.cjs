// Browser tests for the Draw tool (Phase 2).
// Run `npm run preview` first, then: node tests/e2e/draw.test.cjs [screenshot-folder]
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

const count = (page, selector) => page.locator(selector).count();
/** Anything drawn with the highlighter (text highlights and straight lines). */
const HL = ".layer-highlight > [data-kind]";
const pageBox = (page, n) => page.$eval(`.page[data-page="${n}"]`, (el) => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
});

async function drag(page, from, to, steps = 12) {
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await page.mouse.move(to[0], to[1], { steps });
  await page.mouse.up();
}

(async () => {
  const browser = await chromium.launch();

  // ================= Computer =================
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const problems = await watch(page, "desktop");
  const dialogs = [];
  page.on("dialog", async (d) => {
    dialogs.push(d.type());
    await d.accept();
  });
  await page.goto(APP);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.setInputFiles("input[type=file]", pdf("sample-25-pages.pdf"));
  await page.waitForSelector(".page-canvas");

  check("tools appear after opening a file", await page.isVisible('button[aria-label="Draw"]'));
  check("undo starts disabled", await page.isDisabled('button[aria-label="Undo"]'));

  await page.click('button[aria-label="Draw"]');
  check("Draw turns on", (await page.getAttribute('button[aria-label="Draw"]', "aria-pressed")) === "true");
  check("options strip shown", await page.isVisible(".draw-options"));
  check("viewer in drawing mode", await page.$eval(".viewer", (v) => v.classList.contains("drawing")));
  check("black pen selected by default", (await page.getAttribute('button[aria-label="Black pen"]', "aria-pressed")) === "true");
  check("medium size selected by default", (await page.getAttribute('button[aria-label="Medium line"]', "aria-pressed")) === "true");
  await page.screenshot({ path: `${SHOTS}/p2-d1-draw-on.png` });

  let b = await pageBox(page, 1);
  await drag(page, [b.x + 120, b.y + 300], [b.x + 420, b.y + 360]);
  check("pen draws a stroke", (await count(page, '.page[data-page="1"] .layer-ink path')) === 1);
  const black = await page.$eval(".layer-ink path", (p) => [p.getAttribute("stroke"), p.getAttribute("stroke-width")]);
  check("stroke is black, medium", black[0] === "#1a1a1a" && black[1] === "2", black.join(" "));
  check("undo enabled after drawing", !(await page.isDisabled('button[aria-label="Undo"]')));

  await page.click('button[aria-label="Red pen"]');
  await page.click('button[aria-label="Thick line"]');
  await drag(page, [b.x + 120, b.y + 420], [b.x + 300, b.y + 520]);
  const red = await page.$$eval(".layer-ink path", (ps) => ps.map((p) => [p.getAttribute("stroke"), p.getAttribute("stroke-width")]));
  check("red thick stroke", red.length === 2 && red[1][0] === "#dc2626" && red[1][1] === "3.5", JSON.stringify(red));

  await page.click('button[aria-label="Blue pen"]');
  await page.click('button[aria-label="Thin line"]');
  await drag(page, [b.x + 500, b.y + 420], [b.x + 700, b.y + 470]);
  const blue = await page.$$eval(".layer-ink path", (ps) => ps.map((p) => [p.getAttribute("stroke"), p.getAttribute("stroke-width")]));
  check("blue thin stroke", blue.length === 3 && blue[2][0] === "#1d4ed8" && blue[2][1] === "1", JSON.stringify(blue[2]));

  // Highlighter across a line of text (the 3rd text line is ~ 150+44 pt from the top).
  await page.click('button[aria-label="Yellow highlighter"]');
  const scale = b.w / 612;
  const lineY = b.y + (150 + 2 * 22 - 4) * scale;
  await drag(page, [b.x + 48 * scale, lineY], [b.x + 400 * scale, lineY], 20);
  check("highlighter draws in its own layer", (await count(page, HL)) === 1);
  check("highlighter over text snaps to the text", (await count(page, '.layer-highlight > g[data-kind="highlight"] rect')) === 1);
  check("highlighter blends with multiply", (await page.$eval(".layer-highlight", (el) => getComputedStyle(el).mixBlendMode)) === "multiply");
  await page.screenshot({ path: `${SHOTS}/p2-d2-strokes.png` });
  await page.screenshot({ path: `${SHOTS}/p2-d3-highlight-closeup.png`, clip: { x: b.x + 30, y: lineY - 40, width: 560, height: 80 } });
  // The text under the highlight must still be dark: sample the darkest pixel in that strip.
  const darkest = await page.evaluate(async ({ x, y, w }) => {
    const canvas = document.querySelector('.page[data-page="1"] .page-canvas');
    const r = canvas.getBoundingClientRect();
    // Read the composited screen by drawing the canvas + checking the blend mode logic is trusted; here
    // we just confirm the canvas text exists under the highlight.
    const ctx = canvas.getContext("2d");
    const sx = Math.round(((x - r.left) / r.width) * canvas.width);
    const sy = Math.round(((y - r.top) / r.height) * canvas.height);
    const data = ctx.getImageData(sx, sy - 8, Math.round((w / r.width) * canvas.width), 16).data;
    let min = 255;
    for (let i = 0; i < data.length; i += 4) min = Math.min(min, data[i]);
    return min;
  }, { x: b.x + 50 * scale, y: lineY, w: 300 * scale });
  check("text exists under the highlight", darkest < 120, `darkest red channel ${darkest}`);

  // ----- Highlighter follows the text -----
  // Sample text: 11 pt Helvetica lines at x = 50 pt, baselines at 150 + 22 * n pt from the top.
  const baselineOf = (n) => 150 + 22 * n; // n = 0 is the first body line
  const toScreen = (x, y) => [b.x + x * scale, b.y + y * scale];
  const lastRects = () => page.$$eval('.page[data-page="1"] .layer-highlight > g[data-kind="highlight"]', (gs) =>
    [...gs[gs.length - 1].querySelectorAll("rect")].map((r) => ["x", "y", "width", "height"].map((k) => +r.getAttribute(k))));
  // A wobbly, slightly sloped drag along line 6, from inside "quick" to the middle of the line.
  await page.mouse.move(...toScreen(80, baselineOf(5) - 3));
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) await page.mouse.move(...toScreen(80 + i * 12, baselineOf(5) - 3 + Math.sin(i) * 4 + i * 0.25));
  await page.mouse.up();
  let r = await lastRects();
  check("wobbly drag gives one clean, level highlight", r.length === 1, JSON.stringify(r));
  const top = baselineOf(5) - 0.82 * 11;
  check("highlight matches the text line height", Math.abs(r[0][1] - top) < 1.2 && Math.abs(r[0][3] - 1.06 * 11 - 0.08 * 11 * 1.06) < 1.5, `y ${r[0][1].toFixed(1)} h ${r[0][3].toFixed(1)}`);
  check("highlight starts at the start of the word", r[0][0] > 70 && r[0][0] < 74, `x ${r[0][0].toFixed(1)}`);
  await page.screenshot({ path: `${SHOTS}/p2b-d1-snapped.png`, clip: { x: b.x + 30, y: b.y + (baselineOf(4)) * scale, width: 620, height: 60 } });

  // Dragging down across lines highlights like selecting text.
  await drag(page, toScreen(120, baselineOf(8) - 4), toScreen(200, baselineOf(11) - 2), 25);
  r = await lastRects();
  check("dragging across 4 lines highlights 4 lines", r.length === 4, `${r.length} rects`);
  check("first line starts mid-line, middle lines are full", r[0][0] > 100 && Math.abs(r[1][0] - 50) < 1 && Math.abs(r[2][0] - 50) < 1, r.map((q) => q[0].toFixed(0)).join(","));
  check("last line ends near the pointer", r[3][0] + r[3][2] < 230 && r[3][0] + r[3][2] > 190, `ends ${(r[3][0] + r[3][2]).toFixed(0)}`);
  await page.screenshot({ path: `${SHOTS}/p2b-d2-multiline.png`, clip: { x: b.x + 30, y: b.y + baselineOf(7) * scale, width: 620, height: 110 } });

  // Dragging upward works the same.
  await drag(page, toScreen(200, baselineOf(7) - 3), toScreen(120, baselineOf(5) - 3), 15);
  r = await lastRects();
  check("dragging upward also works", r.length === 3, `${r.length} rects`);

  // A tap in the gap between lines (no text) adds nothing.
  const hlBefore = await count(page, HL);
  await drag(page, toScreen(300, baselineOf(6) + 6.5), toScreen(300.5, baselineOf(6) + 6.5), 1);
  check("tapping between lines adds nothing", (await count(page, HL)) === hlBefore);
  // Remove these extra highlights again so the following checks see one highlight.
  for (let i = 0; i < 3; i++) await page.keyboard.press("Control+z");
  check("undo removes text highlights", (await count(page, HL)) === 1);

  // Undo / redo with buttons and keyboard
  await page.click('button[aria-label="Undo"]');
  check("undo removes the highlight", (await count(page, HL)) === 0);
  check("redo enabled", !(await page.isDisabled('button[aria-label="Redo"]')));
  await page.click('button[aria-label="Redo"]');
  check("redo brings it back", (await count(page, HL)) === 1);
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+z");
  check("Ctrl+Z twice undoes two steps", (await count(page, HL)) === 0 && (await count(page, ".layer-ink path")) === 2);
  await page.keyboard.press("Control+Shift+z");
  await page.keyboard.press("Control+y");
  check("Ctrl+Shift+Z and Ctrl+Y redo", (await count(page, HL)) === 1 && (await count(page, ".layer-ink path")) === 3);

  // Eraser: wipe across the first (black) stroke
  await page.click('button[aria-label="Eraser"]');
  check("eraser mode", await page.$eval(".viewer", (v) => v.classList.contains("erasing")));
  // The black line runs from (120,300) to (420,360); wipe across its right end, away from the highlight.
  await drag(page, [b.x + 400, b.y + 345], [b.x + 405, b.y + 378], 15);
  const afterErase = await page.$$eval(".layer-ink path", (ps) => ps.map((p) => p.getAttribute("stroke")));
  check("eraser removes only the stroke it touched", afterErase.length === 2 && !afterErase.includes("#1a1a1a"), afterErase.join(","));
  check("eraser leaves other drawings alone", (await count(page, HL)) === 1);
  await page.keyboard.press("Control+z");
  check("undo brings the erased stroke back", (await count(page, ".layer-ink path")) === 3);
  // The eraser removes highlights too
  await drag(page, [b.x + 300 * scale, lineY - 25], [b.x + 300 * scale - 5, lineY + 25], 10);
  const hlGone = (await count(page, HL)) === 0;
  await page.keyboard.press("Control+z");
  check("eraser removes highlights too, and undo restores", hlGone && (await count(page, HL)) === 1);
  // Erasing on an empty area does nothing and adds no undo step
  await drag(page, [b.x + 600, b.y + 700], [b.x + 650, b.y + 720]);
  check("erasing empty space changes nothing", (await count(page, ".layer-ink path")) === 3 && (await count(page, HL)) === 1);
  await page.keyboard.press("Control+z");
  // If no empty step was recorded, this undoes the last real change: the highlight.
  check("...and adds no undo step", (await count(page, HL)) === 0 && (await count(page, ".layer-ink path")) === 3);
  await page.keyboard.press("Control+y");

  // Zoom keeps strokes in place on the page
  const rel = async () => page.$eval('.page[data-page="1"]', (pg) => {
    const pr = pg.getBoundingClientRect();
    const sr = pg.querySelector(".layer-ink path").getBoundingClientRect();
    return [(sr.left - pr.left) / pr.width, (sr.top - pr.top) / pr.height, sr.width / pr.width];
  });
  const before = await rel();
  await page.keyboard.press("Control+=");
  await page.keyboard.press("Control+=");
  await page.waitForTimeout(400);
  const after = await rel();
  const drift = Math.max(...before.map((v, i) => Math.abs(v - after[i])));
  check("strokes stay put when zooming", drift < 0.003, `drift ${drift.toFixed(4)}`);
  await page.keyboard.press("Control+0");

  // Strokes survive scrolling far away and back
  await page.$eval(".viewer", (v) => (v.scrollTop = v.scrollHeight));
  await page.waitForTimeout(400);
  await page.$eval(".viewer", (v) => (v.scrollTop = 0));
  await page.waitForTimeout(400);
  check("strokes still there after scrolling away", (await count(page, '.page[data-page="1"] .layer-ink path')) === 3);

  // Drawing on page 2
  await page.click('button[aria-label="Black pen"]');
  await page.$eval(".viewer", (v) => (v.scrollTop = 900));
  await page.waitForTimeout(300);
  const b2 = await pageBox(page, 2);
  await drag(page, [b2.x + 100, Math.max(b2.y + 100, 120)], [b2.x + 300, Math.max(b2.y + 140, 160)]);
  check("drawing on page 2 goes on page 2", (await count(page, '.page[data-page="2"] .layer-ink path')) === 1);
  await page.$eval(".viewer", (v) => (v.scrollTop = 0));

  // Escape turns Draw off; dragging no longer draws
  await page.keyboard.press("Escape");
  check("Esc turns Draw off", !(await page.isVisible(".draw-options")) && (await page.getAttribute('button[aria-label="Draw"]', "aria-pressed")) === "false");
  b = await pageBox(page, 1);
  await drag(page, [b.x + 100, b.y + 600], [b.x + 300, b.y + 650]);
  check("no drawing while Draw is off", (await count(page, '.page[data-page="1"] .layer-ink path')) === 3);

  // Opening another file with unsaved drawings asks first
  await page.setInputFiles("input[type=file]", pdf("lease-test.pdf"));
  await page.waitForSelector("dialog[open]");
  check("asks before discarding drawings", (await page.textContent("dialog h2")) === "Discard your changes?");
  await page.screenshot({ path: `${SHOTS}/p2-d4-discard.png` });
  await page.click("dialog >> text=Keep editing");
  await page.waitForTimeout(200);
  check("Keep editing keeps file and drawings", (await page.textContent(".file-name")) === "sample-25-pages.pdf" && (await count(page, ".layer-ink path")) === 4);

  // Remembered settings: the last choice was the black pen; the last thickness picked was thin
  // Reloading with drawings triggers the browser's "leave site?" warning.
  await page.reload();
  check("browser warns before leaving with drawings", dialogs.includes("beforeunload"), dialogs.join(","));
  await page.setInputFiles("input[type=file]", pdf("sample-25-pages.pdf"));
  await page.waitForSelector(".page-canvas");
  await page.click('button[aria-label="Draw"]');
  check("last pen settings remembered", (await page.getAttribute('button[aria-label="Black pen"]', "aria-pressed")) === "true" &&
    (await page.getAttribute('button[aria-label="Thin line"]', "aria-pressed")) === "true");

  b = await pageBox(page, 1);
  await drag(page, [b.x + 100, b.y + 300], [b.x + 300, b.y + 320]);
  await page.setInputFiles("input[type=file]", pdf("lease-test.pdf"));
  await page.waitForSelector("dialog[open]");
  await page.click("dialog >> text=Discard and open");
  await page.waitForFunction(() => document.querySelector(".file-name")?.textContent === "lease-test.pdf");
  await page.waitForSelector(".page-canvas");
  check("Discard opens the new file clean", (await count(page, ".layer path")) === 0 && (await page.isDisabled('button[aria-label="Undo"]')));
  check("Draw is off in the new file", !(await page.isVisible(".draw-options")));

  // A very quick swipe right after choosing the highlighter on a newly opened file still snaps to text.
  await page.click('button[aria-label="Draw"]');
  await page.click('button[aria-label="Yellow highlighter"]');
  b = await pageBox(page, 1);
  const ls = b.w / 612; // lease-test: 20 pt text at x = 60, baseline 92 pt from the top
  await drag(page, [b.x + 70 * ls, b.y + 86 * ls], [b.x + 250 * ls, b.y + 88 * ls], 2);
  await page.waitForTimeout(300);
  check("quick swipe right away still snaps to text", (await count(page, '.layer-highlight > g[data-kind="highlight"]')) === 1);
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Escape");

  // ----- Scanned pages (pictures, no readable text): straight highlighter lines -----
  await page.setInputFiles("input[type=file]", pdf("scanned-letter.pdf"));
  await page.waitForFunction(() => document.querySelector(".file-name")?.textContent === "scanned-letter.pdf");
  await page.waitForSelector(".page-canvas");
  await page.click('button[aria-label="Draw"]');
  await page.click('button[aria-label="Yellow highlighter"]');
  b = await pageBox(page, 1);
  // A wobbly drag, sloping about 5 degrees.
  await page.mouse.move(b.x + 120, b.y + 300);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) await page.mouse.move(b.x + 120 + i * 20, b.y + 300 + i * 1.75 + Math.sin(i) * 3);
  await page.mouse.up();
  const scanPath = await page.$$eval('.layer-highlight > path[data-kind="stroke"]', (ps) => ps.map((p) => p.getAttribute("d")));
  const nums = scanPath[0] ? scanPath[0].match(/-?\d+(\.\d+)?/g).map(Number) : [];
  check("scan: highlighter draws one straight line", scanPath.length === 1 && nums.length === 4, scanPath.join(" | "));
  check("scan: nearly level line snaps level", nums.length === 4 && nums[1] === nums[3], scanPath[0]);
  await drag(page, [b.x + 120, b.y + 500], [b.x + 320, b.y + 620], 10);
  const steep = await page.$$eval('.layer-highlight > path[data-kind="stroke"]', (ps) => ps[1]?.getAttribute("d"));
  const sn = steep ? steep.match(/-?\d+(\.\d+)?/g).map(Number) : [];
  check("scan: a clearly sloped line stays sloped", sn.length === 4 && sn[3] - sn[1] > 30, steep);
  await page.screenshot({ path: `${SHOTS}/p2b-d3-scan.png` });

  check("desktop: no privacy-lock violations", (await page.evaluate(() => window.__csp)).length === 0);
  check("desktop: no errors or warnings", problems.length === 0, problems.join(" | "));
  await ctx.close();

  // ================= Phone (Pixel 7) =================
  const mctx = await browser.newContext({ ...devices["Pixel 7"] });
  const m = await mctx.newPage();
  const mproblems = await watch(m, "phone");
  await m.goto(APP);
  await m.setInputFiles("input[type=file]", pdf("sample-25-pages.pdf"));
  await m.waitForSelector(".page-canvas");
  await m.waitForTimeout(500);
  const vh = await m.evaluate(() => innerHeight);
  const bar = await m.$eval(".tool-group", (el) => el.getBoundingClientRect());
  check("phone: tools bar at the bottom", Math.abs(bar.bottom - vh) < 1 && bar.height > 40, `top ${Math.round(bar.top)} of ${vh}`);
  const viewerBottom = await m.$eval(".viewer", (el) => el.getBoundingClientRect().bottom);
  check("phone: pages don't hide behind the bar", viewerBottom <= bar.top + 1);
  await m.screenshot({ path: `${SHOTS}/p2-m1-open.png` });

  await m.tap('button[aria-label="Draw"]');
  const opts = await m.$eval(".draw-options", (el) => el.getBoundingClientRect());
  check("phone: options above the bar and on screen", opts.bottom <= bar.top && opts.left >= 0 && opts.right <= 412, `${Math.round(opts.left)}..${Math.round(opts.right)}`);

  const cdp = await mctx.newCDPSession(m);
  const touch = (type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i })) });
  const scrollTop = () => m.$eval(".viewer", (v) => v.scrollTop);

  // One finger draws (and doesn't scroll)
  const s0 = await scrollTop();
  await touch("touchStart", [[100, 300]]);
  for (let i = 1; i <= 12; i++) {
    await touch("touchMove", [[100 + i * 15, 300 + i * 6]]);
    await m.waitForTimeout(10);
  }
  await touch("touchEnd", []);
  await m.waitForTimeout(200);
  check("phone: one finger draws", (await count(m, ".layer-ink path")) === 1);
  check("phone: drawing doesn't scroll the page", (await scrollTop()) === s0);
  await m.screenshot({ path: `${SHOTS}/p2-m2-drawn.png` });

  // Two fingers scroll, and leave no mark
  await touch("touchStart", [[150, 500], [250, 500]]);
  for (let i = 1; i <= 10; i++) {
    await touch("touchMove", [[150, 500 - i * 25], [250, 500 - i * 25]]);
    await m.waitForTimeout(16);
  }
  await touch("touchEnd", []);
  await m.waitForTimeout(400);
  check("phone: two fingers scroll", (await scrollTop()) > s0 + 150, `scrolled ${Math.round((await scrollTop()) - s0)}px`);
  check("phone: two-finger scroll leaves no mark", (await count(m, ".layer-ink path")) === 1);

  // One finger lands, then a second right after: the started line is dropped
  await touch("touchStart", [[120, 400]]);
  await touch("touchMove", [[130, 405]]);
  await touch("touchStart", [[130, 405], [230, 405]]);
  for (let i = 1; i <= 6; i++) await touch("touchMove", [[130, 405 - i * 20], [230, 405 - i * 20]]);
  await touch("touchEnd", []);
  await m.waitForTimeout(300);
  check("phone: line dropped when a second finger joins quickly", (await count(m, ".layer path")) === 1);

  // Pinch still zooms while drawing
  const w0 = await m.$eval(".page", (el) => el.getBoundingClientRect().width);
  await touch("touchStart", [[160, 400], [240, 400]]);
  for (let i = 1; i <= 10; i++) await touch("touchMove", [[160 - i * 8, 400], [240 + i * 8, 400]]);
  await touch("touchEnd", []);
  await m.waitForTimeout(500);
  const w1 = await m.$eval(".page", (el) => el.getBoundingClientRect().width);
  check("phone: pinch zooms while drawing", w1 > w0 * 1.5, `${Math.round(w0)} -> ${Math.round(w1)}`);
  check("phone: pinch leaves no mark", (await count(m, ".layer path")) === 1);

  await m.tap('button[aria-label="Undo"]');
  check("phone: undo button works", (await count(m, ".layer path")) === 0);
  await m.tap('button[aria-label="Draw"]');
  check("phone: Draw turns off", !(await m.isVisible(".draw-options")));
  await m.screenshot({ path: `${SHOTS}/p2-m3-after.png` });

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
