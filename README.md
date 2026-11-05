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
| 2 | Pen (black, blue, red), yellow highlighter, eraser, undo/redo | Done, waiting for your testing |
| 3 | Signature: draw once, remembered on the device, place and resize | Next |
| 4 | Save a copy with additions locked into the page | Planned |
| 5 | Installable apps for Windows, Android and macOS, set as the default PDF app | Planned |
| Later | Text editing (fixing typos, rewriting sentences) and new ideas | Planned |

The full plan is in [docs/PLAN.md](docs/PLAN.md).

## Using it

- **Open a PDF:** click **Open** (or press Ctrl+O, Cmd+O on Mac), or drag a PDF into the window.
- **Zoom:** the minus and plus buttons, Ctrl and the mouse wheel, pinching on a trackpad or phone, or Ctrl+= and Ctrl+-. Ctrl+0 or clicking the percentage fits the page to the window.
- **Go to a page:** type the page number in the box at the top right and press Enter.
- **Draw:** click **Draw**, then pick black, blue or red, the yellow highlighter, a thickness, or the eraser. Click **Draw** again (or press Esc) to stop. On a phone, one finger draws and two fingers scroll and zoom.
- **Highlighter:** drag over text and it snaps to the words and lines you cover, like selecting text. On scanned pages (which are pictures, with no text the app can read) it draws a straight line, level when you drag roughly level.
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
    text-layout.ts     finds the lines and words of text on a page, so highlights can snap to them
  overlay/
    overlay-renderer.ts  shows additions on each page (highlight and ink layers)
    paths.ts             smoothing and eraser hit-testing for strokes
  tools/
    draw/              the Draw tool: pen, highlighter, eraser and its options strip
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
  e2e/draw.test.cjs      browser tests for drawing, erasing and undo
  fixtures/              sample PDFs used by the tests
```

Each page in the viewer has an overlay layer on top of the PDF drawing. The pen, highlighter and (later) signature tools draw into that layer, so they never change the original file. Additions are only written into a new copy when saving.

### Privacy lock

Built versions include a Content Security Policy (see `vite.config.ts`) that blocks every connection except loading the app's own files. PDF.js data files (fonts, character maps, image decoders) are bundled with the app.

### Tests

With `npm run preview` running in another terminal:

```bash
node tests/e2e/viewer.test.cjs
node tests/e2e/draw.test.cjs
```

## License

MIT. See [LICENSE](LICENSE). Uses [PDF.js](https://github.com/mozilla/pdf.js) (Apache 2.0).
