/**
 * Printing: each page is drawn as a sharp picture (300 dots per inch, like a
 * laser printer's text), then the browser's normal print window opens. Pages keep their own
 * orientation (portrait or landscape).
 *
 * The same pictures also make a "pictures only" PDF, which the Android app
 * prints for password-protected files (see printablePictures).
 */
import type { PdfDocument } from "../../core/pdf-engine";

const DOTS_PER_INCH = 300;
/** Very large pages are drawn a little less sharp, to stay within what browsers can draw (about 12 million dots). */
const MAX_PIXELS = 12_000_000;
const JPEG_QUALITY = 0.94;

let cleanup: (() => void) | null = null;

/** Page `index` as a JPEG picture, or null if it couldn't be drawn. */
async function pagePicture(doc: PdfDocument, index: number): Promise<Blob | null> {
  const { width, height } = doc.pageSizes[index];
  const ppp = Math.min(DOTS_PER_INCH / 72, Math.sqrt(MAX_PIXELS / (width * height)));
  const canvas = await doc.renderForPrint(index, ppp);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
  canvas.width = 0;
  canvas.height = 0;
  return blob;
}

export async function printDocument(doc: PdfDocument, onProgress: (page: number, total: number) => void): Promise<void> {
  cleanup?.();
  const root = document.createElement("div");
  root.id = "print-root";
  const urls: string[] = [];
  for (let i = 0; i < doc.pageCount; i++) {
    onProgress(i + 1, doc.pageCount);
    const { width, height } = doc.pageSizes[i];
    const blob = await pagePicture(doc, i);
    if (!blob) continue;
    const url = URL.createObjectURL(blob);
    urls.push(url);
    const img = new Image();
    img.src = url;
    img.alt = `Page ${i + 1}`;
    await img.decode().catch(() => {});
    const sheet = document.createElement("div");
    sheet.className = width > height ? "print-page landscape" : "print-page";
    sheet.append(img);
    root.append(sheet);
  }
  document.body.append(root);
  cleanup = () => {
    root.remove();
    urls.forEach((u) => URL.revokeObjectURL(u));
    cleanup = null;
  };
  window.addEventListener("afterprint", () => cleanup?.(), { once: true });
  // In the Mac app, print() asks the app to open macOS's print window and
  // reports if it couldn't. (The pictures are cleaned up at the next print.)
  const opened = window.print() as unknown;
  if (opened instanceof Promise) await opened;
}

/** A new PDF with each page as a picture, at the page's own size (for printing files that can't be copied). */
export async function printablePictures(doc: PdfDocument, onProgress: (page: number, total: number) => void): Promise<Uint8Array> {
  const { PDFDocument } = await import("pdf-lib");
  const out = await PDFDocument.create();
  for (let i = 0; i < doc.pageCount; i++) {
    onProgress(i + 1, doc.pageCount);
    const { width, height } = doc.pageSizes[i];
    const page = out.addPage([width, height]);
    const blob = await pagePicture(doc, i);
    if (!blob) continue;
    const image = await out.embedJpg(new Uint8Array(await blob.arrayBuffer()));
    page.drawImage(image, { x: 0, y: 0, width, height });
  }
  return out.save();
}
