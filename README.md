# Plain PDF

A private, offline PDF app for Windows, Android and macOS, with no clutter.

- **Private:** your PDFs are opened and edited only on your device. Nothing is uploaded, and the app is locked so it can't connect anywhere else.
- **Offline:** everything works without internet.
- **Uncluttered:** only the features you actually use.

## Status

| Phase | What | Status |
|---|---|---|
| 0 | Project setup and privacy lock | Done |
| 1 | Viewer: open, scroll, zoom, pinch, page number | Done |
| 2 | Pen (black, blue, red), yellow highlighter that follows the text, eraser, undo/redo | Done |
| 3 | Signature and initials: draw once, remembered on the device, place and resize | Done |
| 4 | Save a copy with additions locked into the page | Done |
| 5 | Installable apps for Windows, Android and macOS, set as the default PDF app | Done |
| 1.1 | Edit the PDF's own text: fix typos, rewrite sentences, cover and retype on scans | Done (version 1.1.0) |
| 1.2 | Printing in the Android app | Built, waiting for your testing |
| Later | New ideas | Planned |

The full plan is in [docs/PLAN.md](docs/PLAN.md).

## Installing the app

Download the file for your device from the [Releases page](https://github.com/rthapaliya19/plain-pdf/releases/latest). These apps don't come from an app store, so each device asks you to confirm once.

### Windows

1. Download **Plain.PDF_…_x64-setup.exe** and open it.
2. If Windows says **"Windows protected your PC"**, click **More info**, then **Run anyway**.
3. Follow the installer (it installs just for you; no administrator needed).
4. Make it your PDF app: open **Settings > Apps > Default apps**, search for **.pdf**, and choose **Plain PDF**. (Or right-click any PDF, **Open with > Choose another app**, pick **Plain PDF**, and click **Always**.)

### Mac

1. Download **Plain.PDF_…_universal.dmg** and open it. Drag **Plain PDF** into **Applications**.
2. Open Plain PDF from Applications. The first time, macOS blocks it. Open **System Settings > Privacy & Security**, scroll down, click **Open Anyway** next to Plain PDF, and confirm with your password.
3. If macOS instead says the app "is damaged", open **Terminal** and run `xattr -cr "/Applications/Plain PDF.app"`, then open it again.
4. Make it your PDF app: right-click any PDF in Finder, choose **Get Info**, set **Open with** to **Plain PDF**, and click **Change All**.

### Android

1. On your phone, open the Releases page in Chrome and download **Plain.PDF_…_android.apk**.
2. Tap the download. If asked, allow Chrome to **install unknown apps**, then tap **Install**. If Play Protect warns about an unknown app, choose **More details > Install anyway**.
3. Make it your PDF app: open any PDF from the **Files** app, choose **Plain PDF**, and tap **Always**. From the Google Drive app, use **⋮ > Open with > Plain PDF**.

Each device keeps its own saved signature and initials, so draw them once in the installed app.

### Updating

When there's a new version, download and install it the same way, over the old one. The app never checks for updates by itself, so it never connects to the internet.

## Using it

- **Open a PDF:** click **Open** (or press Ctrl+O, Cmd+O on Mac), or drag a PDF into the window.
- **Zoom:** the minus and plus buttons, Ctrl and the mouse wheel, pinching on a trackpad or phone, or Ctrl+= and Ctrl+-. Ctrl+0 or clicking the percentage fits the page to the window.
- **Go to a page:** type the page number in the box at the top right and press Enter.
- **Draw:** click **Draw**, then pick black, blue or red (with a thickness), the yellow highlighter, or the eraser. Click **Done** (or press Esc) to go back to scrolling. On a phone, one finger draws and two fingers scroll and zoom.
- **Highlighter:** drag over text and it snaps to the words and lines you cover, like selecting text. On scanned pages (which are pictures, with no text the app can read) it draws a straight line, level when you drag roughly level.
- **Text:** click **Text**, then tap anywhere on a page and type. Pick a size (small, medium, large) and black, blue or red. Tap elsewhere, **Done** or Esc to finish. Tap text to edit it; drag it to move it. Outside the Text tool, click text to select it (× removes it) and double-click (or tap it again) to edit.
- **Edit the PDF's own text:** with **Text** on, tap a line of the PDF's text to change it, or drag down across several lines to rewrite them as one paragraph (it rewraps to the original width). The old words are covered by a patch in the paper's colour and the new words are written in a matching style (plain, serif or typewriter; bold or italic; same size and colour). If the new wording needs more room, an orange outline and **Shrink to fit** appear. On scans (pictures of text), drag a box over the words, then type the replacement. Tap an edit to change it again; outside the Text tool, select it and tap × to undo it. Note: the old words stay in the file underneath, so search or copy in other apps can still find them. In the Text tool on a phone, one finger taps and drags; two fingers scroll and zoom.
- **Forms:** fillable boxes, checkboxes, radio buttons and dropdowns just work: click and type. When you save, the answers are locked into the copy. Old Adobe "XFA" forms can't be filled.
- **Links:** links inside the PDF jump to their page; web links ask before opening in your browser.
- **Select and copy:** drag across text (or long-press on a phone) and copy it. Scanned pages have no text to select.
- **Search:** click the magnifying glass (or Ctrl+F, Cmd+F on Mac). Matches are highlighted; Enter and Shift+Enter go to the next and previous match; Esc closes.
- **Print:** in the **⋯ More** menu (or Ctrl+P, Cmd+P). Prints what a saved copy would contain, including your drawings, text, signatures and form answers. On Android, it opens Android's own print screen: choose your printer (or **Save as PDF**), copies and pages there. Password-protected PDFs print without your changes.
- **Organize pages:** in the **⋯ More** menu. A grid of page previews: tap pages to select them (Shift-click for a range), then **Rotate left/right**, **Delete**, or **Save as new PDF** (just the selected pages). Drag pages to reorder them; on a phone, press and hold a page, then drag. Drawings, text and signatures stay with their page and turn with it. Everything can be undone.
- **Add pages from another PDF:** in the **⋯ More** menu or the Organize screen. Adds all pages of one or more files to the end. Save then makes one combined file. (Fillable form fields are locked into the pages when pages are reorganized or combined.)
- **Sign:** click **Sign** to open the Sign panel with your **signature** and **initials**. The first time, tap "+ Add signature" or "+ Add initials" and draw them (they're saved only on this device). After that, tap one to place it, or use **Draw new** or **Remove**. A placed signature appears in the middle of the page you're viewing: drag it to move, drag the round corner to resize, and tap × (or press Delete) to remove it.
- **Save:** click **Save** (or Ctrl+S, Cmd+S on Mac) to save a copy named "name-edited.pdf" with everything you added locked into the pages. The original file is never changed. In Chrome on a computer you choose where to save it; on phones it goes to Downloads. Encrypted (password-protected) PDFs can't be saved with changes yet.
- **Undo / Redo:** the buttons, or Ctrl+Z and Ctrl+Y (Cmd+Z and Cmd+Shift+Z on Mac).

## For developers

Requires [Node.js](https://nodejs.org/) 22 or newer.

```bash
npm install
npm run dev      # development server with instant reload
npm run build    # type-check and build into dist/
npm run preview  # serve the built app at http://localhost:4173
```

### How the code is organised

```
src/
  main.ts              starts the app
  app.ts               wires everything together: opening files, shortcuts, drag and drop
  core/
    pdf-engine.ts      the only file that uses the PDF library (PDF.js), behind a small interface
    events.ts          a tiny event hub that the parts use to talk to each other
    additions.ts       everything added on top of the PDF (strokes now, signatures later)
    history.ts         undo and redo
    tools.ts           tools plug in here; one is active at a time
    text-layout.ts     finds the lines and words of text on a page (for highlights, search and editing)
    fonts.ts           the three matching font looks (screen fonts with the same widths as the PDF's standard fonts)
    workspace.ts       the page list: which file and page each page comes from, and its rotation
    page-ops.ts        rotate, delete, move, add and pick pages, keeping additions on their pages
  overlay/
    overlay-renderer.ts  shows additions on each page (highlight and ink layers)
    paths.ts             smoothing and eraser hit-testing for strokes
  tools/
    draw/              the Draw tool: pen, highlighter, eraser and its options strip
    sign/              signatures and initials: the pad, saving them on the device, placing, moving and resizing
    text/              the Text tool: typing on pages, editing the PDF's own words (pdf-text-edit.ts), colour matching
    search/            the search bar and the page text index
    print/             printing (pages drawn as pictures, then the print window)
    organize/          the Organize pages screen (select, rotate, delete, drag to reorder)
  ui/menu.ts           the More menu
  vendor/              form-field styles copied from PDF.js (Apache 2.0)
  save/
    save-pdf.ts        writes additions into a copy of the PDF (pdf-lib), exactly where they were drawn
    save-file.ts       the "Save as" window, or Downloads where there isn't one
  ui/toast.ts          short messages near the bottom of the screen
  viewer/
    viewer.ts          page layout, drawing only the pages near the screen, zoom, page number
    gestures.ts        pinch and Ctrl+wheel zoom
    zoom.ts            zoom limits
  ui/
    toolbar.ts         the top bar
    dialog.ts          messages and the password prompt
    icons.ts           inline icons
  styles.css           the light theme
scripts/
  copy-pdfjs-assets.mjs  copies PDF.js data files into public/pdfjs so nothing is fetched from the internet
tests/
  e2e/viewer.test.cjs    browser tests (Playwright) for the viewer
  e2e/draw.test.cjs      browser tests for drawing, highlighting, erasing and undo
  e2e/sign.test.cjs      browser tests for signatures
  e2e/save.test.cjs      browser tests for saving (also checks saved files with Python's pypdf)
  e2e/text.test.cjs      browser tests for typing text
  e2e/forms.test.cjs     browser tests for filling forms and following links
  e2e/roundb.test.cjs    browser tests for selecting and copying text, search and print
  e2e/roundc.test.cjs    browser tests for organizing, merging and splitting
  e2e/edit.test.cjs      browser tests for editing the PDF's own text
  e2e/android-print.test.cjs  browser tests for printing in the Android app (with a stand-in for Android's print screen)
  fixtures/              sample PDFs used by the tests
```

Each page in the viewer has an overlay layer on top of the PDF drawing. The pen, highlighter and (later) signature tools draw into that layer, so they never change the original file. Additions are only written into a new copy when saving.

### Installed apps (Tauri)

The same web app runs inside small native apps built with [Tauri 2](https://tauri.app) (`src-tauri/`). The native part only opens the window and receives PDFs the system asks it to open; `src/platform/native.ts` uses the system's Open and Save windows. Android extras are in `android/MainActivity.kt` and `scripts/android-setup.mjs`. The Android app's screen can't print by itself, so `src/platform/android-print.ts` hands the finished PDF to Android's print screen through `window.PlainPdfPrinter` (added by `MainActivity.kt`).

The Android app is signed with a key kept in the repository's Actions secrets `ANDROID_KEYSTORE_BASE64` (the key file, base64) and `ANDROID_KEYSTORE_PASSWORD`, so updates install over earlier versions. Keep a private backup of both.

Pushing to the `release` branch runs `.github/workflows/apps.yml`, which builds the Windows installer, the Mac app (Apple chips and Intel) and the Android app, and publishes them as a release named after the version in `src-tauri/tauri.conf.json`. Pushing to the `android-test` branch builds only the Android app and publishes it as a pre-release (for example `v1.2.0-test.3`) for trying on the phone first. To build locally: `npx tauri build` (needs Rust).

### Privacy lock

Built versions include a Content Security Policy (see `vite.config.ts`) that blocks every connection except loading the app's own files. PDF.js data files (fonts, character maps, image decoders) are bundled with the app.

### Tests

With `npm run preview` running in another terminal:

```bash
node tests/e2e/viewer.test.cjs
node tests/e2e/draw.test.cjs
node tests/e2e/sign.test.cjs
node tests/e2e/save.test.cjs   # needs: pip install pypdf
node tests/e2e/text.test.cjs
node tests/e2e/forms.test.cjs
node tests/e2e/roundb.test.cjs
node tests/e2e/roundc.test.cjs
node tests/e2e/edit.test.cjs
node tests/e2e/android-print.test.cjs   # needs pypdf and pdftoppm (poppler)
```

## License

MIT. See [LICENSE](LICENSE). Uses [PDF.js](https://github.com/mozilla/pdf.js) (Apache 2.0), [pdf-lib](https://github.com/Hopding/pdf-lib) (MIT) and the [Arimo, Tinos and Cousine](https://github.com/googlefonts/) fonts (SIL Open Font License 1.1).
