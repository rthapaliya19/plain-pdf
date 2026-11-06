// Browser tests for saving and printing password-protected PDFs, and PDFs
// marked "no changes allowed". Needs Python with pypdf, and pdftoppm.
// Sample files (made with qpdf):
//   locked-password-secret123.pdf      password "secret123" (AES-128)
//   locked-aes256-user1-owner1.pdf     password "user1", owner password "owner1" (AES-256), 25 pages
//   locked-rc4-oldpass.pdf             password "oldpass" (an old, weak RC4 lock)
//   restricted-no-changes.pdf          opens without a password; marked "no changes allowed" (owner "maker")
//   locked-form-formpw.pdf             a fillable form, password "formpw"
// Run `npm run preview` first, then: node tests/e2e/protected.test.cjs [screenshot-folder]
const { chromium } = require("playwright");
const { execFileSync } = require("node:child_process");
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

const APP = process.env.APP_URL || "http://127.0.0.1:4173/";
const SHOTS = process.argv[2] || join(tmpdir(), "plain-pdf-screenshots");
mkdirSync(SHOTS, { recursive: true });
const pdf = (name) => join(__dirname, "..", "fixtures", name);
const results = [];
const check = (name, ok, extra = "") => results.push(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  (" + extra + ")" : ""}`);

async function watch(page, label, allowed = []) {
  const problems = [];
  page.on("pageerror", (e) => problems.push(`[${label}] pageerror: ${e.message}`));
  page.on("console", (m) => {
    if ((m.type() === "error" || m.type() === "warning") && !allowed.some((a) => a.test(m.text()))) problems.push(`[${label}] console.${m.type()}: ${m.text()}`);
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
    window.__prints = [];
    window.print = () => {
      window.__prints.push([...document.querySelectorAll("#print-root img")].map((img) => img.src));
      setTimeout(() => window.dispatchEvent(new Event("afterprint")), 50);
    };
  });
  return problems;
}
const box = (page, sel) => page.$eval(sel, (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
async function drag(page, from, to, steps = 10) {
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await page.mouse.move(to[0], to[1], { steps });
  await page.mouse.up();
}
/** Runs Python with pypdf on `file`; `code` sees the reader as r. */
const py = (code, file) => execFileSync("python3", ["-I", "-c", `import sys, json\nfrom pypdf import PdfReader\nr = PdfReader(sys.argv[1])\n${code}`, file]).toString().trim();
/** Facts about a saved file: locked or not, which passwords open it, its marks, pages and text. */
function facts(file, passwords) {
  return JSON.parse(py(`
out = {"locked": r.is_encrypted}
if r.is_encrypted:
    out["opens"] = {}
    for pw in ${JSON.stringify(passwords)}:
        out["opens"][pw] = int(PdfReader(sys.argv[1]).decrypt(pw))
    e = r.trailer["/Encrypt"].get_object()
    out["V"] = int(e.get("/V", 0)); out["P"] = int(e["/P"])
    ok = [pw for pw, how in out["opens"].items() if how]
    if ok: r.decrypt(ok[0])
if not r.is_encrypted or out["opens"] and any(out["opens"].values()):
    out["pages"] = len(r.pages)
    out["text"] = r.pages[0].extract_text()
print(json.dumps(out))`, file));
}
/** Red pixels on page 1 (drawn by poppler, a different PDF reader). */
function redPixels(file, password) {
  const out = join(SHOTS, "protected-page");
  execFileSync("pdftoppm", ["-f", "1", "-l", "1", "-r", "36", "-singlefile", ...(password ? ["-upw", password] : []), file, out]);
  const ppm = readFileSync(`${out}.ppm`);
  const head = ppm.toString("latin1", 0, 50).match(/^P6\s+(\d+)\s+(\d+)\s+255\s/);
  let red = 0;
  for (let i = head[0].length; i < ppm.length; i += 3) if (ppm[i] > 170 && ppm[i + 1] < 90 && ppm[i + 2] < 90) red++;
  return red;
}
async function open(page, name, password) {
  await page.setInputFiles("input[type=file]", pdf(name));
  await page.waitForTimeout(300);
  if (await page.isVisible("dialog[open] >> text=Discard and open")) await page.click("dialog[open] >> text=Discard and open");
  if (password !== null) {
    await page.waitForSelector("dialog[open] input[type=password]");
    await page.fill("dialog input[type=password]", password);
    await page.keyboard.press("Enter");
  }
  await page.waitForFunction((n) => document.querySelector(".file-name")?.textContent === n, name);
  await page.waitForSelector(".page-canvas");
}
async function redLine(page) {
  const pg = await box(page, '.page[data-page="1"]');
  await page.click('button[aria-label="Draw"]');
  await page.click('button[aria-label="Red pen"]');
  await page.click('button[aria-label="Thick line"]');
  await drag(page, [pg.x + pg.w * 0.2, pg.y + pg.h * 0.35], [pg.x + pg.w * 0.8, pg.y + pg.h * 0.35]);
  await page.click(".draw-options .done-button");
}
let saved = 0;
async function save(page, answer) {
  await page.click("button.save-button");
  if (answer) {
    await page.waitForSelector("dialog[open] >> text=Keep the password?");
    await page.click(`dialog[open] >> text=${answer}`);
  }
  saved++;
  await page.waitForFunction((n) => window.__saves.length === n && window.__saves[n - 1].bytes, saved, { timeout: 60000 });
  const entry = await page.evaluate((n) => window.__saves[n - 1], saved);
  const file = join(SHOTS, `protected-${saved}-${entry.name}`);
  writeFileSync(file, Buffer.from(entry.bytes));
  return { name: entry.name, file };
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const problems = await watch(page, "desktop");
  await page.goto(APP);

  // ----- A file that needs a password -----
  await open(page, "locked-password-secret123.pdf", "secret123");
  await redLine(page);
  await page.click("button.save-button");
  await page.waitForSelector("dialog[open] >> text=Keep the password?");
  check("saving a password-protected file asks whether to keep the password", (await page.textContent("dialog[open]")).includes("Should the copy need the same password?"));
  await page.screenshot({ path: `${SHOTS}/protected-d1-question.png` });
  await page.click("dialog[open] >> text=Cancel");
  await page.waitForTimeout(300);
  check("...Cancel saves nothing", (await page.evaluate(() => window.__saves.length)) === 0);

  let s = await save(page, "Keep password");
  let f = facts(s.file, ["secret123"]);
  check("Keep password: the copy is locked with the same password", f.locked && f.opens.secret123 > 0 && s.name === "locked-password-secret123-edited.pdf", JSON.stringify({ ...f, text: undefined }));
  check("...with the original text", f.text.includes("One page lease agreement"));
  check("...and your drawing locked into the page", redPixels(s.file, "secret123") > 30);
  check("...and the message says it kept the password", (await page.textContent(".toast")).includes("same password"));
  check("...and a wrong password doesn't open it", facts(s.file, ["wrong"]).opens.wrong === 0);

  s = await save(page, "Save without password");
  f = facts(s.file, []);
  check("Save without password: the copy opens without one", !f.locked && f.text.includes("One page lease agreement"));
  check("...with your drawing", redPixels(s.file) > 30);
  check("the password isn't stored anywhere", !(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).includes("secret123"));

  // Reopen the locked copy in the app: it asks for the same password.
  const relocked = join(SHOTS, "protected-1-locked-password-secret123-edited.pdf");
  await page.setInputFiles("input[type=file]", relocked);
  await page.waitForTimeout(300);
  if (await page.isVisible("dialog[open] >> text=Discard and open")) await page.click("dialog[open] >> text=Discard and open");
  await page.waitForSelector("dialog[open] input[type=password]");
  await page.fill("dialog input[type=password]", "secret123");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector(".file-name")?.textContent === "protected-1-locked-password-secret123-edited.pdf");
  check("the locked copy opens in Plain PDF with the same password", true);

  // ----- Separate owner password, modern AES-256 lock -----
  await open(page, "locked-aes256-user1-owner1.pdf", "user1");
  await redLine(page);
  s = await save(page, "Keep password");
  f = facts(s.file, ["user1", "owner1"]);
  check("AES-256 file: the copy opens with the same password", f.locked && f.opens.user1 === 1, JSON.stringify(f.opens));
  check("...and the owner password still works on the copy", f.opens.owner1 === 2);
  check("...with the same lock and marks", f.V === 5 && f.P === -4, `V${f.V} P${f.P}`);
  check("...and all 25 pages", f.pages === 25);

  // Organize pages (delete page 2), then save: still locked.
  await page.click('button[aria-label="More"]');
  await page.click(".menu-item >> text=Organize pages");
  await page.waitForSelector(".organize .tile .thumb canvas");
  await page.click('.organize .tile[data-pos="1"]');
  await page.click(".organize-actions button[data-action='Delete']");
  // Save selected pages (pages 1 and 2 of the 24 left) as a new, locked file.
  await page.click('.organize .tile[data-pos="0"]');
  await page.click('.organize .tile[data-pos="1"]', { modifiers: ["Shift"] });
  await page.click(".organize-actions button[data-action='Save as new PDF']");
  await page.waitForSelector("dialog[open] >> text=Keep the password?");
  await page.click("dialog[open] >> text=Keep password");
  saved++;
  await page.waitForFunction((n) => window.__saves.length === n && window.__saves[n - 1].bytes, saved, { timeout: 60000 });
  const sel = await page.evaluate((n) => window.__saves[n - 1], saved);
  writeFileSync(join(SHOTS, "protected-selected.pdf"), Buffer.from(sel.bytes));
  f = facts(join(SHOTS, "protected-selected.pdf"), ["user1"]);
  check("Save selected pages from a locked file: locked, just those pages", f.locked && f.opens.user1 === 1 && f.pages === 2 && sel.name.endsWith("-selected.pdf"), JSON.stringify({ ...f, text: undefined }));
  await page.click(".organize .done-button");
  await page.waitForTimeout(400);
  s = await save(page, "Keep password");
  f = facts(s.file, ["user1"]);
  check("reorganized pages from a locked file save locked, with the page gone", f.locked && f.opens.user1 === 1 && f.pages === 24);

  // ----- An old, weak lock -----
  await open(page, "locked-rc4-oldpass.pdf", "oldpass");
  await redLine(page);
  s = await save(page, "Keep password");
  f = facts(s.file, ["oldpass"]);
  check("old-style (RC4) lock: the copy keeps the same kind of lock and password", f.locked && f.opens.oldpass > 0 && f.V === 1, `V${f.V}`);
  check("...with your drawing", redPixels(s.file, "oldpass") > 30);

  // ----- Marked "no changes allowed", no password -----
  await open(page, "restricted-no-changes.pdf", null);
  await redLine(page);
  s = await save(page, null);
  check("a file marked 'no changes allowed' saves without any question", (await page.locator("dialog[open]").count()) === 0);
  f = facts(s.file, [""]);
  check("...and the copy keeps the same marks", f.locked && f.opens[""] > 0 && f.P === -1340, JSON.stringify({ ...f, text: undefined }));
  check("...opens without a password, with your drawing", redPixels(s.file) > 30);

  // ----- A locked fillable form -----
  await open(page, "locked-form-formpw.pdf", "formpw");
  await page.waitForSelector('.annotationLayer input[type="text"]');
  await page.fill('.annotationLayer input[type="text"]', "Printed Name");
  await page.waitForTimeout(300);
  s = await save(page, "Keep password");
  f = facts(s.file, ["formpw"]);
  check("a locked form saves with its answers, still locked", f.locked && f.opens.formpw > 0 && f.text.includes("Printed Name"), JSON.stringify({ ...f, text: f.text.slice(0, 60) }));

  // ----- Printing (computer): the printout includes your changes -----
  await open(page, "locked-password-secret123.pdf", "secret123");
  await redLine(page);
  await page.click('button[aria-label="More"]');
  await page.click(".menu-item >> text=Print");
  await page.waitForFunction(() => window.__prints.length === 1, null, { timeout: 60000 });
  check("printing a locked file doesn't ask to leave out your changes", (await page.locator("dialog[open]").count()) === 0);
  const red = await page.evaluate(async (src) => {
    const img = new Image(); img.src = src; await img.decode();
    const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext("2d"); ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 170 && d[i + 1] < 90 && d[i + 2] < 90) n++; return n;
  }, (await page.evaluate(() => window.__prints[0]))[0]);
  check("...and the printout has your drawing", red > 1000, `${red} red pixels`);
  check("desktop: no privacy-lock violations", (await page.evaluate(() => window.__csp)).length === 0);
  check("desktop: no errors or warnings", problems.length === 0, problems.join(" | "));
  await ctx.close();

  // ----- Android printing: handed over unlocked, with the changes -----
  const actx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  await actx.addInitScript(() => {
    window.__jobs = [];
    let pieces = null;
    window.PlainPdfPrinter = {
      begin: () => ((pieces = []), true),
      add: (b64) => (pieces.push(b64), true),
      print: (name) => {
        const bin = pieces.map((p) => atob(p)).join("");
        window.__jobs.push({ name, bytes: Array.from(bin, (c) => c.charCodeAt(0)) });
        return true;
      },
    };
  });
  const a = await actx.newPage();
  const ap = await watch(a, "android");
  await a.goto(APP);
  await open(a, "locked-password-secret123.pdf", "secret123");
  await redLine(a);
  await a.click('button[aria-label="More"]');
  await a.click(".menu-item >> text=Print");
  await a.waitForFunction(() => window.__jobs.length === 1, null, { timeout: 60000 });
  const job = await a.evaluate(() => window.__jobs[0]);
  const jobFile = join(SHOTS, "protected-android-print.pdf");
  writeFileSync(jobFile, Buffer.from(job.bytes));
  f = facts(jobFile, []);
  check("Android: a locked file prints with your changes, unlocked so Android's print screen can read it", !f.locked && f.text.includes("One page lease agreement") && redPixels(jobFile) > 30 && job.name === "locked-password-secret123-edited.pdf", job.name);
  check("android: no errors or warnings", ap.length === 0, ap.join(" | "));
  await actx.close();

  // ----- If the unlocking part can't load: say so, and keep the changes -----
  const bctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  await bctx.route(/qpdf.*\.wasm/, (r) => r.abort());
  const b = await bctx.newPage();
  const bp = await watch(b, "blocked", [/Failed to load resource/, /falling back to ArrayBuffer instantiation/, /ProtectionError|qpdf|wasm|both async and sync fetching/i]);
  await b.goto(APP);
  await open(b, "locked-password-secret123.pdf", "secret123");
  await redLine(b);
  await b.click("button.save-button");
  await b.click("dialog[open] >> text=Keep password");
  await b.waitForSelector("dialog[open] >> text=Couldn't save", { timeout: 30000 });
  check("if unlocking fails, Save explains and changes are kept", (await b.textContent("dialog[open]")).includes("couldn't unlock this protected PDF"));
  await b.click("dialog[open] >> text=OK");
  check("...drawing still there", (await b.locator(".layer-ink path").count()) === 1);
  await b.click('button[aria-label="More"]');
  await b.click(".menu-item >> text=Print");
  await b.waitForSelector("dialog[open] >> text=Print without your changes?", { timeout: 30000 });
  check("...and Print offers to print without the changes", true);
  await b.click("dialog[open] >> text=Print without changes");
  await b.waitForFunction(() => window.__prints.length === 1, null, { timeout: 60000 });
  check("...which then prints", true);
  check("blocked: no other errors", bp.length === 0, bp.join(" | "));
  await bctx.close();

  await browser.close();
  console.log(results.join("\n"));
  if (results.some((r) => r.startsWith("FAIL"))) process.exit(1);
})().catch((e) => { console.log(results.join("\n")); console.error(e); process.exit(1); });
