# Plain PDF: agreed plan

## Goals

- A private, offline PDF app that becomes the default PDF viewer on Windows 11, Android (Pixel) and macOS 27.
- Works for any PDF: files on the computer or phone, downloads, email attachments, and files from Google Drive.
- Only the features that are needed, in a light, uncluttered interface.
- Open source, free libraries only, no app store fees.

## Privacy

- PDFs are opened and edited only on the device. No server, no account, no uploads.
- The app is blocked from making outside connections (Content Security Policy).
- The saved signature stays in that device's private app storage. It is never synced or uploaded.
- The app never checks for updates by itself. New versions are downloaded by hand.

## Version 1 features

| Feature | Details |
|---|---|
| Open and view | Open button, drag and drop on computers, scroll, zoom, pinch to zoom, page number |
| Pen | Black, blue, red, 3 thicknesses |
| Highlighter | Yellow and see-through, so text stays readable. Snaps to the words and lines of text you drag over; straight (level-snapping) lines on scans |
| Eraser | Removes whole strokes. Only erases what was added, never the original PDF |
| Undo / Redo | For everything added |
| Signature | Draw once with finger, mouse or trackpad. Remembered on the device. Tap to place, drag to move, drag a corner to resize. Redraw or delete anytime. No PIN |
| Save | Always saves a copy, named "name-edited.pdf" by default, using a Save dialog where possible. Additions are locked into the page. The original is untouched |

On phones, with the pen active, one finger draws and two fingers scroll and zoom.

## Platforms

| Platform | Preview (Phases 1 to 4) | Installed app (Phase 5) |
|---|---|---|
| Windows 11 | Chrome | Installer built by GitHub Actions. Unsigned, so Windows shows a one-time "More info, Run anyway" warning |
| Android (Pixel) | Chrome | APK installed outside the Play Store. Check Google's developer verification rules for the US before building |
| macOS 27 | Chrome | .dmg built by GitHub Actions, one build for Apple chips and Intel. Unsigned, so a one-time "Open Anyway" approval in System Settings, Privacy & Security |

Technology: TypeScript, Vite, PDF.js (Apache 2.0) for display, pdf-lib (MIT) for saving, Tauri 2 for the installed apps.

## Google Drive

- Computer (Drive in the browser): download the PDF, then open it; it opens in Plain PDF once it's the default app. Upload the edited copy back if wanted. Google Drive for desktop is optional and removes these steps.
- Android: in the Drive app, the menu, then "Open with", then Plain PDF. Files from Downloads, the Files app or email open directly.

## Build phases

Each phase ends with a check-in: the owner tests and approves before the next phase starts.

| Phase | Build | Owner's part |
|---|---|---|
| 0. Setup | Project, privacy lock, preview | Create the repository, approve access |
| 1. Viewer | Open, scroll, zoom, page number | Try the preview on PC, Pixel and Mac |
| 2. Pen | Pen, highlighter, eraser, undo/redo | Draw on all three |
| 3. Signature | Signature pad, remembering it, placing it | Sign test PDFs |
| 4. Save | Save a copy with additions locked in | Check saved copies in another viewer |
| Feedback | | New ideas before packaging |
| 5. Package | Windows, Android and macOS apps, default PDF app setup | Install and set as default |
| Later | Text editing (typos and sentences; scans need cover-and-retype), new ideas | |

## Decisions log

- Name: Plain PDF, repository `plain-pdf`.
- Light theme only.
- No emoji or "smilies" feature (that was a voice-typing mix-up).
- Visual signatures only, no certificate-based signatures.
- Features first in a browser preview, packaging afterwards.
- macOS included from the start.
- "Fit" zoom fits the page being read, capped at 125% on wide screens.
- Highlighter follows the text (owner's first choice); straight lines where there is no readable text.
- Signature: blue ink, one saved signature, appears in the middle of the visible page, drag to move, corner to resize, × to remove, no date. The eraser doesn't remove signatures.
