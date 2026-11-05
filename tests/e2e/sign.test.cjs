// Browser tests for signatures (Phase 3).
// Run `npm run preview` first, then: node tests/e2e/sign.test.cjs [screenshot-folder]
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

/** Draws a signature-like squiggle in the signature pad with the mouse. */
async function signWithMouse(page) {
  const pad = await box(page, ".signature-pad");
  const y = pad.y + pad.h * 0.6;
  await page.mouse.move(pad.x + 40, y);
  await page.mouse.down();
  for (let i = 0; i <= 40; i++) await page.mouse.move(pad.x + 40 + i * 9, y - Math.sin(i / 3) * 30 - (i % 7) * 2);
  await page.mouse.up();
  await drag(page, [pad.x + 120, y - 50], [pad.x + 130, y + 10], 6);
}

(async () => {
  const browser = await chromium.launch();

  // ================= Computer =================
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const problems = await watch(page, "desktop");
  page.on("dialog", (d) => d.accept());
  await page.goto(APP);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.setInputFiles("input[type=file]", pdf("sample-25-pages.pdf"));
  await page.waitForSelector(".page-canvas");

  check("Sign button shown", await page.isVisible('button[aria-label="Sign"]'));
  await page.click('button[aria-label="Sign"]');
  await page.waitForSelector("dialog[open] .signature-pad");
  check("first time: signature pad opens", (await page.textContent("dialog[open] h2")) === "Draw your signature");
  check("Save starts disabled", await page.isDisabled("dialog >> text=Save signature"));
  await signWithMouse(page);
  check("drawing enables Save", !(await page.isDisabled("dialog >> text=Save signature")));
  const padInk = await page.$$eval(".signature-pad path", (ps) => ps.map((p) => p.getAttribute("stroke")));
  check("pad ink is blue", padInk.length === 2 && padInk.every((c) => c === "#1e40af"), padInk.join(","));
  await page.screenshot({ path: `${SHOTS}/p3-d1-pad.png` });
  await page.click("dialog >> text=Clear");
  check("Clear empties the pad", (await count(page, ".signature-pad path")) === 0 && (await page.isDisabled("dialog >> text=Save signature")));
  await signWithMouse(page);
  await page.click("dialog >> text=Save signature");
  await page.waitForSelector(".sig-box");

  check("signature placed and selected", (await count(page, ".sig-box.selected")) === 1);
  check("signature drawn in blue on the page", (await page.$$eval('.layer-ink g[data-kind="signature"] path', (ps) => ps.map((p) => p.getAttribute("stroke")))).every((c) => c === "#1e40af"));
  check("hint message shown", (await page.textContent(".toast"))?.includes("Drag to move"));
  const viewerBox = await box(page, ".viewer");
  let sig = await box(page, ".sig-box");
  check("placed in the middle of the view", Math.abs(sig.cx - viewerBox.cx) < 5 && Math.abs(sig.cy - viewerBox.cy) < 5, `${Math.round(sig.cx)},${Math.round(sig.cy)} vs ${Math.round(viewerBox.cx)},${Math.round(viewerBox.cy)}`);
  check("signature remembered on this device", await page.evaluate(() => !!localStorage.getItem("plain-pdf:signature")));
  await page.screenshot({ path: `${SHOTS}/p3-d2-placed.png` });

  // Move
  await drag(page, [sig.cx, sig.cy], [sig.cx + 100, sig.cy + 50]);
  let moved = await box(page, ".sig-box");
  check("drag moves the signature", Math.abs(moved.x - sig.x - 100) < 2 && Math.abs(moved.y - sig.y - 50) < 2, `dx ${Math.round(moved.x - sig.x)} dy ${Math.round(moved.y - sig.y)}`);
  await page.keyboard.press("Control+z");
  let back = await box(page, ".sig-box");
  check("undo moves it back", Math.abs(back.x - sig.x) < 1 && Math.abs(back.y - sig.y) < 1);
  await page.keyboard.press("Control+y");
  moved = await box(page, ".sig-box");
  check("redo moves it again", Math.abs(moved.x - sig.x - 100) < 2);

  // Resize with the corner handle (select first: undo/redo re-draw it)
  await page.mouse.click(moved.cx, moved.cy);
  const handle = await box(page, ".sig-box.selected .sig-handle");
  await drag(page, [handle.cx, handle.cy], [handle.cx + 80, handle.cy + 10]);
  const resized = await box(page, ".sig-box");
  check("corner handle resizes", resized.w > moved.w + 70, `${Math.round(moved.w)} -> ${Math.round(resized.w)}`);
  check("resizing keeps the shape", Math.abs(resized.h / resized.w - moved.h / moved.w) < 0.01);
  await page.screenshot({ path: `${SHOTS}/p3-d3-resized.png` });

  // Selection
  const pg = await box(page, '.page[data-page="1"]');
  await page.mouse.click(pg.x + 60, pg.y + 60);
  check("clicking elsewhere deselects", (await count(page, ".sig-box.selected")) === 0);
  await page.mouse.click(resized.cx, resized.cy);
  check("clicking the signature selects it", (await count(page, ".sig-box.selected")) === 1);

  // Remove with ×, and with the Delete key
  await page.click(".sig-box.selected .sig-delete");
  check("× removes the signature", (await count(page, ".sig-box")) === 0 && (await count(page, 'g[data-kind="signature"]')) === 0);
  await page.keyboard.press("Control+z");
  check("undo brings it back", (await count(page, ".sig-box")) === 1);
  await page.mouse.click(resized.cx, resized.cy);
  await page.keyboard.press("Delete");
  check("Delete key removes the selected signature", (await count(page, ".sig-box")) === 0);
  await page.keyboard.press("Control+z");

  // The eraser leaves signatures alone; drawing over a signature works
  await page.click('button[aria-label="Draw"]');
  check("turning on Draw clears the selection", (await count(page, ".sig-box.selected")) === 0);
  await page.click('button[aria-label="Black pen"]');
  await drag(page, [resized.x - 20, resized.cy], [resized.x + resized.w + 20, resized.cy]);
  check("pen can draw over a signature", (await count(page, ".layer-ink path[data-kind]")) === 1);
  await page.click('button[aria-label="Eraser"]');
  await drag(page, [resized.x + 10, resized.y + 5], [resized.x + resized.w - 10, resized.y + resized.h - 5], 20);
  check("eraser removes the pen line but not the signature", (await count(page, ".layer-ink path[data-kind]")) === 0 && (await count(page, ".sig-box")) === 1);
  await page.click('button[aria-label="Draw"]');

  // Zooming keeps the signature in place on the page
  const rel = () => page.$eval(".sig-box", (b) => {
    const p = b.closest(".page").getBoundingClientRect();
    const r = b.getBoundingClientRect();
    return [(r.left - p.left) / p.width, (r.top - p.top) / p.height, r.width / p.width];
  });
  const r0 = await rel();
  await page.keyboard.press("Control+=");
  await page.waitForTimeout(300);
  const r1 = await rel();
  check("signature stays put when zooming", Math.max(...r0.map((v, i) => Math.abs(v - r1[i]))) < 0.002);
  await page.keyboard.press("Control+0");

  // Second time: the saved signature is offered
  await page.click('button[aria-label="Sign"]');
  await page.waitForSelector("dialog[open] .signature-preview");
  check("next time: shows your saved signature", (await page.textContent("dialog[open] h2")) === "Your signature");
  await page.screenshot({ path: `${SHOTS}/p3-d4-menu.png` });
  await page.click("dialog >> text=Place on page");
  await page.waitForFunction(() => document.querySelectorAll(".sig-box").length === 2, null, { timeout: 2000 }).catch(() => {});
  check("Place on page adds another signature", (await count(page, ".sig-box")) === 2);
  await page.click('button[aria-label="Sign"]');
  await page.click("dialog >> text=Place on page");
  await page.waitForFunction(() => document.querySelectorAll(".sig-box").length === 3, null, { timeout: 2000 }).catch(() => {});
  const spots = await page.$$eval(".sig-box", (bs) => bs.map((b) => b.style.left + "," + b.style.top));
  check("a signature placed in the same view doesn't land exactly on top of another", new Set(spots).size === spots.length, spots.join(" | "));
  await page.keyboard.press("Control+z");

  // Still remembered after reloading
  await page.reload();
  await page.setInputFiles("input[type=file]", pdf("sample-25-pages.pdf"));
  await page.waitForSelector(".page-canvas");
  await page.click('button[aria-label="Sign"]');
  await page.waitForSelector("dialog[open] .signature-preview");
  check("signature remembered after reload", true);
  // Draw a new one
  await page.click("dialog >> text=Draw new");
  await page.waitForSelector("dialog[open] .signature-pad");
  const oldSaved = await page.evaluate(() => localStorage.getItem("plain-pdf:signature"));
  await signWithMouse(page);
  await page.mouse.move(0, 0);
  const pad = await box(page, ".signature-pad");
  await drag(page, [pad.x + 300, pad.y + 30], [pad.x + 320, pad.y + 60], 4);
  await page.click("dialog >> text=Save signature");
  await page.waitForSelector(".sig-box");
  const newSaved = await page.evaluate(() => localStorage.getItem("plain-pdf:signature"));
  check("Draw new replaces the saved signature", newSaved && newSaved !== oldSaved);

  // Remove from this device
  await page.click('button[aria-label="Sign"]');
  await page.waitForSelector("dialog[open] .signature-preview");
  await page.click("dialog >> text=Remove");
  await page.waitForSelector("dialog[open] >> text=Remove your saved signature?");
  await page.click("dialog[open] >> text=Keep it");
  check("Keep it keeps the saved signature", await page.evaluate(() => !!localStorage.getItem("plain-pdf:signature")));
  await page.click('button[aria-label="Sign"]');
  await page.click("dialog >> text=Remove");
  await page.click("dialog[open] >> button:text-is('Remove')");
  await page.waitForTimeout(200);
  check("Remove deletes it from this device", await page.evaluate(() => !localStorage.getItem("plain-pdf:signature")));
  check("placed signatures stay after removing the saved one", (await count(page, ".sig-box")) === 1);
  await page.click('button[aria-label="Sign"]');
  await page.waitForSelector("dialog[open] .signature-pad");
  check("after removing, Sign asks you to draw again", (await page.textContent("dialog[open] h2")) === "Draw your signature");
  await page.click("dialog >> text=Cancel");
  check("Cancel adds nothing", (await count(page, ".sig-box")) === 1);

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
  const cdp = await mctx.newCDPSession(m);
  const touch = (type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i })) });
  const fingerDrag = async (from, to, steps = 10) => {
    await touch("touchStart", [from]);
    for (let i = 1; i <= steps; i++) await touch("touchMove", [[from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps]]);
    await touch("touchEnd", []);
  };
  const scrollTop = () => m.$eval(".viewer", (v) => v.scrollTop);

  await m.tap('button[aria-label="Sign"]');
  await m.waitForSelector("dialog[open] .signature-pad");
  const mpad = await box(m, ".signature-pad");
  const vw = await m.evaluate(() => innerWidth);
  check("phone: pad fits the screen", mpad.x >= 0 && mpad.x + mpad.w <= vw && mpad.h >= 120, `${Math.round(mpad.w)}x${Math.round(mpad.h)}`);
  await touch("touchStart", [[mpad.x + 30, mpad.y + mpad.h * 0.6]]);
  for (let i = 1; i <= 25; i++) await touch("touchMove", [[mpad.x + 30 + i * 11, mpad.y + mpad.h * 0.6 - Math.sin(i / 2) * 25]]);
  await touch("touchEnd", []);
  check("phone: finger draws in the pad", (await count(m, ".signature-pad path")) === 1);
  await m.screenshot({ path: `${SHOTS}/p3-m1-pad.png` });
  // Chrome ignores a tap that comes within ~150 ms of lifting a finger from a drag;
  // a person always takes longer than that, so pause like one.
  await m.waitForTimeout(500);
  await m.tap("dialog >> text=Save signature");
  await m.waitForSelector(".sig-box");
  const msig = await box(m, ".sig-box");
  const mview = await box(m, ".viewer");
  check("phone: placed in the middle of the view", Math.abs(msig.cy - mview.cy) < 5 && msig.x >= 0 && msig.x + msig.w <= vw);
  await m.screenshot({ path: `${SHOTS}/p3-m2-placed.png` });

  const s0 = await scrollTop();
  await fingerDrag([msig.cx, msig.cy], [msig.cx - 40, msig.cy + 80]);
  const mmoved = await box(m, ".sig-box");
  check("phone: finger drag moves the signature", Math.abs(mmoved.y - msig.y - 80) < 3 && Math.abs(mmoved.x - msig.x + 40) < 3);
  check("phone: moving it doesn't scroll the page", (await scrollTop()) === s0);
  await m.waitForTimeout(500);
  await m.tap(".sig-box");
  const mh = await box(m, ".sig-box.selected .sig-handle");
  await fingerDrag([mh.cx, mh.cy], [mh.cx + 40, mh.cy + 10]);
  const mres = await box(m, ".sig-box");
  check("phone: finger resizes with the handle", mres.w > mmoved.w + 30, `${Math.round(mmoved.w)} -> ${Math.round(mres.w)}`);
  await m.screenshot({ path: `${SHOTS}/p3-m3-resized.png` });
  await m.waitForTimeout(500);
  await m.tap(".sig-box.selected .sig-delete");
  check("phone: × removes it", (await count(m, ".sig-box")) === 0);

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
