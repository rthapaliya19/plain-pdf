/**
 * The engine adapter: the only file that talks to the PDF library (PDF.js).
 * Everything else in the app uses the small interface below, so the library
 * can be upgraded or swapped without touching the rest of the code.
 */
import {
  GlobalWorkerOptions,
  PasswordResponses,
  getDocument,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
  type PDFPageProxy,
} from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = workerUrl;

/** Folder holding PDF.js data files, copied in by scripts/copy-pdfjs-assets.mjs. */
const ASSETS = new URL("pdfjs/", document.baseURI).href;

/** Size of a page in PDF points (1 point = 1/72 inch), with rotation applied. */
export interface PageSize {
  width: number;
  height: number;
}

export interface RenderJob {
  promise: Promise<void>;
  cancel(): void;
}

export interface PdfDocument {
  readonly pageCount: number;
  /** Page sizes, in order. Index 0 is page 1. */
  readonly pageSizes: readonly PageSize[];
  /** Draws page `index` (0-based) onto `canvas`, `pixelsPerPoint` pixels per PDF point. */
  renderPage(index: number, canvas: HTMLCanvasElement, pixelsPerPoint: number): RenderJob;
  close(): Promise<void>;
}

/** Asks the person for a password. Resolves to null if they cancel. */
export type PasswordPrompt = (wasWrong: boolean) => Promise<string | null>;

export class PasswordCancelledError extends Error {
  constructor() {
    super("Opening was cancelled.");
    this.name = "PasswordCancelledError";
  }
}

export class NotAPdfError extends Error {
  constructor() {
    super("This file couldn't be opened as a PDF. It may be damaged or not a PDF.");
    this.name = "NotAPdfError";
  }
}

/** Quick check of the file's first bytes, which are "%PDF" for every PDF. */
export function looksLikePdf(bytes: Uint8Array): boolean {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  return head.includes("%PDF");
}

export async function openPdf(bytes: Uint8Array, askPassword: PasswordPrompt): Promise<PdfDocument> {
  if (!looksLikePdf(bytes)) throw new NotAPdfError();

  // PDF.js takes ownership of the buffer it is given, so hand it a copy and
  // keep the original intact for saving later.
  const task: PDFDocumentLoadingTask = getDocument({
    data: bytes.slice(),
    cMapUrl: `${ASSETS}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${ASSETS}standard_fonts/`,
    wasmUrl: `${ASSETS}wasm/`,
    iccUrl: `${ASSETS}iccs/`,
    // Never look for fonts or files outside the app.
    useSystemFonts: false,
    enableXfa: false,
    stopAtErrors: false,
  });

  let cancelled = false;
  task.onPassword = (updatePassword: (password: string) => void, reason: number) => {
    askPassword(reason === PasswordResponses.INCORRECT_PASSWORD).then((password) => {
      if (password === null) {
        cancelled = true;
        void task.destroy();
      } else {
        updatePassword(password);
      }
    });
  };

  let doc: PDFDocumentProxy;
  try {
    doc = await task.promise;
  } catch (error) {
    if (cancelled) throw new PasswordCancelledError();
    if (error instanceof Error && error.name === "InvalidPDFException") throw new NotAPdfError();
    throw error;
  }

  const pages: PDFPageProxy[] = [];
  const pageSizes: PageSize[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 1 });
    pages.push(page);
    pageSizes.push({ width: viewport.width, height: viewport.height });
  }

  return {
    pageCount: doc.numPages,
    pageSizes,
    renderPage(index, canvas, pixelsPerPoint) {
      const page = pages[index];
      const viewport = page.getViewport({ scale: pixelsPerPoint });
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      const task = page.render({ canvas, viewport, background: "#ffffff" });
      return {
        promise: task.promise,
        cancel: () => task.cancel(),
      };
    },
    async close() {
      await task.destroy();
    },
  };
}
