# Handoff notes

For whoever picks this up next (person or AI). Read this first, then `docs/PLAN.md` (the agreed plan and progress) and `README.md` (how the code is organised).

## Where things stand (2026-11-17)

- Released: 1.3.1 (Windows, Mac, Android). The `release` branch builds and publishes the apps; `main` publishes the web preview.
- The audit fixes below were made on `claude/sharp-mendel-r4kgeo` and **merged into `main` on 2026-11-17** (owner asked), so the web preview has them. The owner asked to release them as **1.3.2** (2026-11-17): version bumped and pushed to `release`, which builds the apps (`.github/workflows/apps.yml`). When that finishes, tick the release in `docs/PLAN.md` (a "Plan: 1.3.2 released" commit, as for earlier versions).
- All 14 test files pass: 556 checks (521 old + 35 new in `tests/e2e/audit.test.cjs`).

## What was done on this branch

An audit (all code read, the 521 checks run, plus stress tests: a 3,000-page file, a 65 MB file of scans, heavy handwriting, damaged and odd-sized files) found five problems. All are fixed, each with checks that fail on the old code and pass on the new.

| # | Problem | Fix | Code |
|---|---|---|---|
| 1 | A page saved as a picture for redaction still held its original scan, drawings and fonts in the file (recoverable). | `replaceWithPicture` gives the page a fresh, empty `/Resources`, so `removeUnreachable` deletes the originals. | `src/save/redact.ts` |
| 2 | Shapes only partly under a redaction box stayed whole (outlined words, drawn signatures); `/Thumb` and `/PieceInfo` were kept. | Paths are now split into subpaths: subpaths inside a box are cut out, the rest kept. A *detailed* subpath (curved, or more than 5 straight segments) that crosses a redaction box throws `Unsupported`, so the page becomes a picture. Simple shapes (rules, underlines, backgrounds) never force that. `dropPageLeftovers` removes `/Thumb` and `/PieceInfo`. | `src/save/redact.ts` (`hidesUnder`, `isSimpleShape`, path cases in `redactContent`) |
| 3 | Save and Print failed once one page held about 40,000 pen points (`RangeError` from spreading a huge array into `pushOperators`). | Operators are collected with a loop (`append`) and pushed in chunks of 2,000 (`OPERATORS_PER_PUSH`). 250,000 points save in under 2 s. | `src/save/save-pdf.ts` |
| 4 | Organize showed page previews of a file opened earlier (cache keyed `source:index:rotation`, same across files). | `OrganizeScreen.forgetPreviews()`, called from `App.openFile` only. Not on `document:opened`, because `showPages` emits that after every page operation, where the cache should stay. | `src/tools/organize/organize-screen.ts`, `src/app.ts` |
| 5 | Editing one line of tightly set text removed the line below from the saved copy. | Areas carry `patch: true` for text-edit patches. For patches, a letter is removed only if its middle (`GLYPH_MIDDLE` = 0.3 of the font size above the baseline, half its width across) lies under the patch. Redaction boxes keep the wider 25%-overlap rule. | `src/save/redact.ts`, `src/save/save-pdf.ts` (`clearedRects`, `toArea`) |

New test material: `tests/fixtures/make-audit-cases.cjs` makes `tests/fixtures/audit-cases.pdf` (6 pages: fax-style scan with a stamp, outlined words, zigzag signature, curved flourish, text with background/underline/rule plus `/Thumb` and `/PieceInfo`, tightly set lines in a tall font).

## Next steps, in order

1. Done: fixes merged into `main`; the preview workflow (`.github/workflows/preview.yml`) published them.
2. Done: version 1.3.2 (in `package.json`, `package-lock.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`), pushed to `main` and `release`. Check the "Build apps" run on GitHub; if it failed, read its log, fix, and push to `release` again.
3. Remaining audit findings, not yet agreed with the owner (listed at the end of `docs/PLAN.md`). The most useful next ones:
   - Rotating, deleting or reordering pages drops the chapter list: `saveWorkspace` in `src/save/save-pdf.ts` rebuilds the file with `copyPages`. Better: change page order and rotation inside the loaded original when there's one source.
   - Saved filled forms contain dangling references to removed field objects (poppler prints "Invalid XRef entry"). Comes from `lockFormAnswers` (`form.flatten`) leaving `/Annots` entries pointing at deleted widgets.
   - Typed characters the standard fonts can't show become "?" silently (`encodable` in `src/save/save-pdf.ts`). At least warn when typing them.
   - Search marks every match at once (285,000 elements for "the" in 3,000 pages, 105 s): `src/tools/search/search.ts`.
   - Print renders all pages to JPEG blobs first, no cancel or page range: `src/tools/print/print.ts`.
   - Each new pen stroke re-renders every stroke on the page (`OverlayRenderer.renderPage`), 6 ms per stroke at 200 strokes, 62 ms at 2,000.
   - Redaction doesn't touch the structure tree (`/StructTreeRoot` `Alt`/`ActualText`), only marked content on the page.
   - To check on real devices: closing the window with unsaved changes (Tauri may skip `beforeunload`), web links in the installed apps (no opener plugin), Android `allowBackup` for the saved signature, large Drive files on Android (copied on the UI thread in `android/MainActivity.kt`).
   - No CI runs the tests before a release (`.github/workflows/apps.yml`).

## How to build and test

```bash
npm ci
npm run build
npx vite preview --host 127.0.0.1 --port 4173 --strictPort   # leave running
node tests/e2e/audit.test.cjs                                  # and the other 13 files, see README
```

Tests need Python with `pypdf` and `Pillow`, and poppler (`pdftotext`, `pdftoppm`). Playwright's Chromium must be installed. Each test file prints PASS/FAIL lines and exits non-zero on any FAIL.

## Working with the owner

- The owner is not a developer. `README.md`, `docs/PLAN.md`, commit messages, toasts and dialogs use plain words ("saved as a picture", not "rasterised"). Keep that style.
- Every feature or release goes through the owner: build, owner tries the preview, then release. Don't push to `release` or `main` without being asked.
- Decisions go in the "Decisions" lists of `docs/PLAN.md`; progress as checkboxes there.
