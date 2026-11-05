// Browser tests for the viewer (Phase 1).
// Run `npm run preview` first, then: node tests/e2e/viewer.test.cjs [screenshot-folder]
const { chromium, devices } = require("playwright");
const { mkdirSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

const APP = process.env.APP_URL || "http://127.0.0.1:4173/";
const SHOTS = process.argv[2] || join(tmpdir(), "plain-pdf-screenshots");
mkdirSync(SHOTS, { recursive: true });
const pdf = (name) => join(__dirname, "..", "fixtures", name);
const results = [];
const check = (name, ok, extra = "") => { results.push(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  (" + extra + ")" : ""}`); };

async function watch(page, label) {
  const problems = [];
  const requests = new Set();
  page.on("pageerror", (e) => problems.push(`[${label}] pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") problems.push(`[${label}] console.${m.type()}: ${m.text()}`); });
  page.on("request", (r) => requests.add(new URL(r.url()).origin));
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  return { problems, requests };
}

(async () => {
  const browser = await chromium.launch();

  // ---------- Desktop ----------
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const w = await watch(page, "desktop");
  await page.goto(APP);
  await page.waitForSelector(".start-card");
  await page.screenshot({ path: `${SHOTS}/d1-start.png` });
  check("start screen shows", await page.isVisible("text=Open a PDF"));

  await page.setInputFiles("input[type=file]", pdf("sample-25-pages.pdf"));
  await page.waitForSelector(".page-canvas");
  await page.waitForTimeout(800);
  check("file name shown", (await page.textContent(".file-name")) === "sample-25-pages.pdf");
  check("page total shown", (await page.textContent(".page-total")) === "/ 25");
  check("page input = 1", (await page.inputValue(".page-input")) === "1");
  const zoom0 = await page.textContent(".zoom-label");
  check("fit zoom label", /%$/.test(zoom0), zoom0);
  const canvases = await page.locator(".page-canvas").count();
  check("only nearby pages drawn", canvases > 0 && canvases < 12, `${canvases} canvases`);
  await page.screenshot({ path: `${SHOTS}/d2-open.png` });
  check("title updated", (await page.title()) === "sample-25-pages.pdf - Plain PDF");

  // Zoom in via button
  const w0 = await page.$eval(".page", (el) => el.getBoundingClientRect().width);
  await page.click('button[title^="Zoom in"]');
  await page.waitForTimeout(600);
  const w1 = await page.$eval(".page", (el) => el.getBoundingClientRect().width);
  check("zoom in button grows page", w1 > w0, `${Math.round(w0)} -> ${Math.round(w1)}, label ${await page.textContent(".zoom-label")}`);
  const cw = await page.$eval(".page-canvas", (c) => c.width);
  check("page redrawn sharper after zoom", cw >= Math.round(w1) - 2, `canvas ${cw}px for ${Math.round(w1)}px page`);

  // Keyboard zoom out and fit
  await page.keyboard.press("Control+-");
  await page.keyboard.press("Control+-");
  await page.waitForTimeout(300);
  const zoomAfterMinus = await page.textContent(".zoom-label");
  await page.keyboard.press("Control+0");
  await page.waitForTimeout(300);
  check("Ctrl+- and Ctrl+0 work", zoomAfterMinus !== zoom0 && (await page.textContent(".zoom-label")) === zoom0, `${zoomAfterMinus} then ${await page.textContent(".zoom-label")}`);

  // Ctrl + wheel over the viewer
  await page.mouse.move(640, 400);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -100);
  await page.keyboard.up("Control");
  await page.waitForTimeout(300);
  check("Ctrl+wheel zooms", (await page.textContent(".zoom-label")) !== zoom0, await page.textContent(".zoom-label"));
  await page.keyboard.press("Control+0");

  // Jump to page 10
  await page.click(".page-input");
  await page.keyboard.type("10");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(700);
  check("jump to page 10", (await page.inputValue(".page-input")) === "10");
  const p10top = await page.$eval('.page[data-page="10"]', (el) => el.getBoundingClientRect().top);
  check("page 10 at top of view", p10top > 40 && p10top < 120, `top=${Math.round(p10top)}`);
  check("page 10 drawn", (await page.locator('.page[data-page="10"] .page-canvas').count()) === 1);
  await page.screenshot({ path: `${SHOTS}/d3-page10.png` });

  // Scroll to the end
  await page.$eval(".viewer", (v) => (v.scrollTop = v.scrollHeight));
  await page.waitForTimeout(500);
  check("scrolling to the end shows page 25", (await page.inputValue(".page-input")) === "25");
  const far = await page.locator('.page[data-page="1"] .page-canvas').count();
  check("far-away page 1 released from memory", far === 0);

  // Not a PDF
  await page.setInputFiles("input[type=file]", pdf("not-a-pdf.pdf"));
  await page.waitForSelector("dialog[open]");
  check("not-a-pdf message", (await page.textContent("dialog h2")) === "Can't open this file");
  await page.screenshot({ path: `${SHOTS}/d4-notpdf.png` });
  await page.click("dialog >> text=OK");
  check("previous document still open after error", (await page.textContent(".file-name")) === "sample-25-pages.pdf");

  // Password: cancel, wrong, right
  await page.setInputFiles("input[type=file]", pdf("locked-password-secret123.pdf"));
  await page.waitForSelector("dialog[open] input[type=password]");
  await page.click("dialog >> text=Cancel");
  await page.waitForTimeout(300);
  check("password cancel keeps old document", (await page.textContent(".file-name")) === "sample-25-pages.pdf");
  await page.setInputFiles("input[type=file]", pdf("locked-password-secret123.pdf"));
  await page.waitForSelector("dialog[open] input[type=password]");
  await page.fill("dialog input[type=password]", "wrong");
  await page.keyboard.press("Enter");
  await page.waitForSelector("dialog[open] >> text=didn't work");
  await page.screenshot({ path: `${SHOTS}/d5-wrongpw.png` });
  check("wrong password message", true);
  await page.fill("dialog input[type=password]", "secret123");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector(".page-total")?.textContent === "/ 1");
  await page.waitForSelector(".page-canvas");
  check("correct password opens file", (await page.textContent(".file-name")) === "locked-password-secret123.pdf");
  await page.screenshot({ path: `${SHOTS}/d6-unlocked.png` });

  const csp = await page.evaluate(() => window.__csp);
  check("no privacy-lock violations", csp.length === 0, csp.join(" | "));
  check("only the app's own address contacted", [...w.requests].every((o) => o === new URL(APP).origin), [...w.requests].join(", "));
  check("no errors or warnings", w.problems.length === 0, w.problems.join(" | "));
  await ctx.close();

  // ---------- Phone (Pixel 7) ----------
  const mctx = await browser.newContext({ ...devices["Pixel 7"] });
  const m = await mctx.newPage();
  const mw = await watch(m, "phone");
  await m.goto(APP);
  await m.waitForSelector(".start-card");
  check("phone: drag hint hidden", !(await m.isVisible(".drag-only")));
  await m.screenshot({ path: `${SHOTS}/m1-start.png` });
  await m.setInputFiles("input[type=file]", pdf("sample-25-pages.pdf"));
  await m.waitForSelector(".page-canvas");
  await m.waitForTimeout(800);
  const vw = await m.evaluate(() => innerWidth);
  const pw = await m.$eval(".page", (el) => el.getBoundingClientRect().width);
  check("phone: page fits screen width", pw <= vw && pw > vw - 30, `page ${Math.round(pw)} / screen ${vw}`);
  const box = await m.$eval(".page", (el) => { const r = el.getBoundingClientRect(); return { l: r.left, r: r.right }; });
  check("phone: first page fully on screen", box.l >= 0 && box.r <= vw, `left ${Math.round(box.l)}, right ${Math.round(box.r)}`);
  const p3 = await m.$eval('.page[data-page="3"]', (el) => el.getBoundingClientRect().left);
  check("phone: wide landscape page starts at left edge too", Math.abs(p3 - box.l) < 1, `left ${Math.round(p3)}`);
  check("phone: zoom buttons hidden", !(await m.isVisible(".zoom-group")));
  await m.screenshot({ path: `${SHOTS}/m2-open.png` });

  // Two-finger pinch via Chrome DevTools touch events
  const cdp = await mctx.newCDPSession(m);
  const touch = (type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
  await touch("touchStart", [[150, 400], [250, 400]]);
  for (let i = 1; i <= 10; i++) {
    await touch("touchMove", [[150 - i * 8, 400], [250 + i * 8, 400]]);
    await m.waitForTimeout(16);
  }
  await m.screenshot({ path: `${SHOTS}/m3-mid-pinch.png` });
  await touch("touchEnd", []);
  await m.waitForTimeout(800);
  const pw2 = await m.$eval(".page", (el) => el.getBoundingClientRect().width);
  check("phone: pinch zooms in", pw2 > pw * 1.5, `page ${Math.round(pw)} -> ${Math.round(pw2)}`);
  const transform = await m.$eval(".pages", (el) => el.style.transform);
  check("phone: pinch preview cleared", transform === "");
  await m.screenshot({ path: `${SHOTS}/m4-pinched.png` });
  check("phone: no errors", mw.problems.length === 0, mw.problems.join(" | "));
  const mcsp = await m.evaluate(() => window.__csp);
  check("phone: no privacy-lock violations", mcsp.length === 0, mcsp.join(" | "));

  await browser.close();
  console.log(results.join("\n"));
  if (results.some((r) => r.startsWith("FAIL"))) process.exit(1);
})().catch((e) => { console.log(results.join("\n")); console.error(e); process.exit(1); });
