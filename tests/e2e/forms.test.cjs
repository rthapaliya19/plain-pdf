// Browser tests for filling forms and following links (Round A). Needs Python with pypdf.
// Run `npm run preview` first, then: node tests/e2e/forms.test.cjs [screenshot-folder]
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

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  await ctx.route("https://example.com/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "ok" }));
  const page = await ctx.newPage();
  const problems = await watch(page, "desktop");
  await page.goto(APP);
  await page.setInputFiles("input[type=file]", pdf("form-and-links.pdf"));
  await page.waitForSelector('.page[data-page="1"] .annotationLayer input');
  await page.waitForTimeout(300);

  const name = '.annotationLayer input[type="text"]';
  check("text fields appear as boxes you can type in", (await page.locator(name).count()) === 1);
  check("checkbox, radio buttons, dropdown and notes box appear",
    (await page.locator('.annotationLayer input[type="checkbox"]').count()) === 1 &&
    (await page.locator('.annotationLayer input[type="radio"]').count()) === 2 &&
    (await page.locator(".annotationLayer select").count()) === 1 &&
    (await page.locator(".annotationLayer textarea").count()) === 1);
  const nb = await box(page, name);
  const pg = await box(page, '.page[data-page="1"]');
  const s = pg.w / 612;
  check("fields line up with the page", Math.abs(nb.x - (pg.x + 140 * s)) < 2 && Math.abs(nb.w - 250 * s) < 2, `x ${Math.round(nb.x - pg.x)} w ${Math.round(nb.w)}`);

  // Drawing mode: fields don't react, and you can draw over them.
  await page.click('button[aria-label="Draw"]');
  await page.mouse.click(nb.cx, nb.cy);
  check("while drawing, tapping a field doesn't start typing", !(await page.evaluate(() => document.activeElement?.tagName === "INPUT")));
  await page.keyboard.press("Control+z");
  await page.click(".draw-options .done-button");

  // Fill everything in.
  await page.click(name);
  await page.keyboard.type("Jane Doe");
  await page.check('.annotationLayer input[type="checkbox"]');
  await page.selectOption(".annotationLayer select", { label: "Texas" });
  await page.locator('.annotationLayer input[type="radio"]').nth(1).check();
  await page.click(".annotationLayer textarea");
  await page.keyboard.type("Call after 5pm");
  await page.mouse.click(pg.x + 500 * s, pg.y + 100 * s); // click away
  check("filling a form enables Save", !(await page.isDisabled("button.save-button")));
  await page.screenshot({ path: `${SHOTS}/f-d1-filled.png` });

  // Typing in a field doesn't trigger the app's shortcuts.
  await page.click(name);
  await page.keyboard.press("End");
  await page.keyboard.press("Backspace");
  check("Backspace in a field edits the field", (await page.inputValue(name)) === "Jane Do");
  await page.keyboard.type("e");

  // Internal link
  const linkSel = '.annotationLayer .linkAnnotation a';
  check("links are clickable", (await page.locator(linkSel).count()) === 2);
  await page.locator(linkSel).first().click();
  await page.waitForTimeout(400);
  check("a link inside the PDF jumps to its page", (await page.inputValue(".page-input")) === "2");
  await page.$eval(".viewer", (v) => (v.scrollTop = 0));
  await page.waitForTimeout(300);

  // External link: asks first.
  let popups = 0;
  ctx.on("page", () => popups++);
  await page.locator(linkSel).nth(1).click();
  await page.waitForSelector("dialog[open]");
  check("a web link asks before opening", (await page.textContent("dialog[open] h2")) === "Open this link in your browser?" && (await page.textContent("dialog[open] p")).includes("https://example.com/"));
  await page.click("dialog[open] >> text=Cancel");
  await page.waitForTimeout(300);
  check("Cancel doesn't open it", popups === 0);
  await page.locator(linkSel).nth(1).click();
  await page.waitForSelector("dialog[open]");
  const [popup] = await Promise.all([ctx.waitForEvent("page"), page.click("dialog[open] >> text=Open link")]);
  check("Open link opens it in a new tab", popup.url().startsWith("https://example.com"), popup.url());
  await popup.close();

  // Unsaved form answers are protected.
  await page.setInputFiles("input[type=file]", pdf("lease-test.pdf"));
  await page.waitForSelector("dialog[open]");
  check("unsaved form answers trigger the warning", (await page.textContent("dialog[open] h2")) === "Discard your changes?");
  await page.click("dialog[open] >> text=Keep editing");

  // Save: answers are locked into the page.
  await page.click("button.save-button");
  await page.waitForFunction(() => window.__saves.length === 1 && window.__saves[0].bytes);
  const file = join(SHOTS, "saved-form-edited.pdf");
  writeFileSync(file, Buffer.from(await page.evaluate(() => window.__saves[0].bytes)));
  check("saved copy: answers are locked (no fillable fields left)", pypdf("f = r.get_fields()\nprint(len(f or {}))", file) === "0");
  const text = pypdf("print(r.pages[0].extract_text())", file);
  const flat = text.replace(/\s+/g, " ");
  check("saved copy: answers are on the page", flat.includes("Jane Doe") && flat.includes("Texas") && flat.includes("Call after 5pm"), flat.slice(0, 200));
  check("saved copy: both pages kept", pypdf("print(len(r.pages))", file) === "2");

  await page.setInputFiles("input[type=file]", file);
  await page.waitForFunction(() => document.querySelector(".file-name")?.textContent === "saved-form-edited.pdf");
  await page.waitForSelector(".page-canvas");
  await page.waitForTimeout(600);
  check("reopened copy has no fillable fields", (await page.locator(".annotationLayer input, .annotationLayer select, .annotationLayer textarea").count()) === 0);
  const inked = await page.evaluate(({ x0, y0, x1, y1 }) => {
    const c = document.querySelector('.page[data-page="1"] .page-canvas'); const ctx = c.getContext("2d");
    const d = ctx.getImageData(Math.floor(x0 * c.width), Math.floor(y0 * c.height), Math.ceil((x1 - x0) * c.width), Math.ceil((y1 - y0) * c.height)).data;
    let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 100) n++; return n;
  }, { x0: 140 / 612, y0: (792 - 674) / 792, x1: 390 / 612, y1: (792 - 652) / 792 });
  check("reopened copy shows the name where it was typed", inked > 30, `${inked} dark pixels`);
  await page.screenshot({ path: `${SHOTS}/f-d2-saved.png` });
  check("desktop: no privacy-lock violations", (await page.evaluate(() => window.__csp)).length === 0);
  check("desktop: no errors or warnings", problems.length === 0, problems.join(" | "));
  await ctx.close();

  // Phone
  const mctx = await browser.newContext({ ...devices["Pixel 7"] });
  const m = await mctx.newPage();
  const mp = await watch(m, "phone");
  await m.goto(APP);
  await m.setInputFiles("input[type=file]", pdf("form-and-links.pdf"));
  await m.waitForSelector('.annotationLayer input[type="text"]');
  await m.tap('.annotationLayer input[type="text"]');
  await m.keyboard.type("Phone name");
  check("phone: tap a field and type", (await m.inputValue('.annotationLayer input[type="text"]')) === "Phone name");
  await m.screenshot({ path: `${SHOTS}/f-m1-filled.png` });
  check("phone: no errors or warnings", mp.length === 0, mp.join(" | "));

  await browser.close();
  console.log(results.join("\n"));
  if (results.some((r) => r.startsWith("FAIL"))) process.exit(1);
})().catch((e) => { console.log(results.join("\n")); console.error(e); process.exit(1); });
