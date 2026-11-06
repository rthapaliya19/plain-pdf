/**
 * The engine adapter: the only file that talks to the PDF library (PDF.js).
 * Everything else in the app uses the small interface below, so the library
 * can be upgraded or swapped without touching the rest of the code.
 */
import {
  AnnotationLayer,
  AnnotationMode,
  GlobalWorkerOptions,
  PasswordResponses,
  TextLayer,
  Util,
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

/**
 * A run of text on a page, as positioned by the PDF, in PDF points from the
 * top-left corner of the page as shown. Only left-to-right horizontal text is
 * included. Scanned pages usually have none (they are just pictures).
 */
export interface TextFragment {
  text: string;
  /** General look of the font: plain (like Arial), serif (like Times) or typewriter (like Courier). */
  family: "sans" | "serif" | "mono";
  bold: boolean;
  italic: boolean;
  /** Left edge. */
  x: number;
  /** Baseline (the line the letters sit on). */
  baseline: number;
  width: number;
  /** Font size. */
  size: number;
}

export interface RenderJob {
  promise: Promise<void>;
  cancel(): void;
}

/** What happens when a link inside the PDF is clicked. */
export interface LinkHandler {
  /** Jump to page `index` (0-based) of this document. */
  goToPage(index: number): void;
  /** A web or email link: the app asks before opening it. */
  openExternal(url: string): void;
}

/** A 2D transform [a, b, c, d, e, f], as used in PDF files. */
export type Matrix = [number, number, number, number, number, number];

export interface PdfDocument {
  readonly pageCount: number;
  /** Page sizes, in order. Index 0 is page 1. */
  readonly pageSizes: readonly PageSize[];
  /** True if the file is encrypted (for example password-protected). */
  readonly encrypted: boolean;
  /**
   * For each page, the transform from the app's page coordinates (points,
   * top-left origin, rotation applied) to the PDF file's own coordinates.
   * Used when saving, so additions land exactly where they were drawn.
   */
  readonly pageToPdf: readonly Matrix[];
  /**
   * Draws page `index` (0-based) onto `canvas`, `pixelsPerPoint` pixels per PDF point.
   * `rotation` (0, 90, 180, 270) turns the page clockwise on top of its own rotation.
   */
  renderPage(index: number, canvas: HTMLCanvasElement, pixelsPerPoint: number, rotation?: number): RenderJob;
  /** Where the text on page `index` (0-based) sits. Used to make highlights follow the text. */
  textFragments(index: number, rotation?: number): Promise<TextFragment[]>;
  /**
   * Adds the page's fillable form fields and clickable links into `div`
   * (an element covering the page). Sizes follow the CSS variable
   * --total-scale-factor, so zooming needs no redraw.
   */
  renderInteractive(index: number, div: HTMLDivElement, links: LinkHandler, rotation?: number): Promise<void>;
  /** Draws page `index` for printing, including form answers, at `pixelsPerPoint`. */
  renderForPrint(index: number, pixelsPerPoint: number, rotation?: number): Promise<HTMLCanvasElement>;
  /** Adds invisible, selectable text over page `index` (for selecting and copying). */
  renderTextLayer(index: number, div: HTMLDivElement, rotation?: number): Promise<void>;
  /** Like pageToPdf, for the page turned by an extra `rotation`. */
  pageToPdfAt(index: number, rotation: number): Matrix;
  /** The page's own rotation in the file (0, 90, 180, 270). */
  fileRotation(index: number): number;
  /** True once any form field has been filled in or changed. */
  readonly formsModified: boolean;
  onFormsChanged(callback: () => void): void;
  /** Old-style Adobe forms (XFA) that can't be filled here. */
  readonly isXfaForm: boolean;
  /** The file with the current form answers written in (for saving). */
  bytesWithFormValues(): Promise<Uint8Array>;
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
  const pageToPdf: Matrix[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 1 });
    pages.push(page);
    pageSizes.push({ width: viewport.width, height: viewport.height });
    pageToPdf.push(Util.inverseTransform(viewport.transform) as Matrix);
  }
  let fieldObjects: Promise<Map<string, object[]> | null> | undefined;
  // Checkboxes and radio buttons are drawn as small separate pictures during
  // page drawing, then placed into the form layer (one map and layer per page).
  const fieldCanvases = pages.map(() => new Map<string, HTMLCanvasElement>());
  const formLayers: (AnnotationLayer | null)[] = pages.map(() => null);
  let formsModified = false;
  const formListeners: (() => void)[] = [];
  (doc.annotationStorage as unknown as { onSetModified: () => void }).onSetModified = () => {
    formsModified = true;
    formListeners.forEach((f) => f());
  };
  const { info } = await doc.getMetadata().catch(() => ({ info: {} }));
  const encrypted = Boolean((info as { EncryptFilterName?: string | null }).EncryptFilterName);

  return {
    pageCount: doc.numPages,
    pageSizes,
    encrypted,
    pageToPdf,
    renderPage(index, canvas, pixelsPerPoint, rotation = 0) {
      const page = pages[index];
      const viewport = page.getViewport({ scale: pixelsPerPoint, rotation: turned(page, rotation) });
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      // Form fields are drawn as real input boxes on top (see renderInteractive), not on the canvas.
      const task = page.render({
        canvas,
        viewport,
        background: "#ffffff",
        annotationMode: AnnotationMode.ENABLE_FORMS,
        annotationCanvasMap: fieldCanvases[index],
      });
      return {
        promise: task.promise.then(() => formLayers[index]?.refreshCanvases()),
        cancel: () => task.cancel(),
      };
    },
    async textFragments(index, rotation = 0) {
      const page = pages[index];
      const viewport = page.getViewport({ scale: 1, rotation: turned(page, rotation) });
      const content = await page.getTextContent();
      const fragments: TextFragment[] = [];
      for (const item of content.items) {
        if (!("str" in item) || item.str.trim() === "" || item.width <= 0) continue;
        const tx = Util.transform(viewport.transform, item.transform);
        // Keep only text that runs left to right, level with the page.
        if (Math.abs(tx[1]) > 0.01 * Math.abs(tx[0]) || tx[0] <= 0) continue;
        const size = Math.hypot(tx[2], tx[3]);
        if (size <= 0) continue;
        const look = fontLook(page, item.fontName, content.styles[item.fontName]?.fontFamily);
        fragments.push({ text: item.str, x: tx[4], baseline: tx[5], width: item.width * viewport.scale, size, ...look });
      }
      return fragments;
    },
    async renderInteractive(index, div, links, rotation = 0) {
      const page = pages[index];
      const annotations = await page.getAnnotations({ intent: "display" });
      if (annotations.length === 0) return;
      fieldObjects ??= doc.getFieldObjects().catch(() => null);
      const viewport = page.getViewport({ scale: 1, rotation: turned(page, rotation) }).clone({ dontFlip: true });
      const linkService = makeLinkService(doc, links);
      const layer = new AnnotationLayer({
        div,
        accessibilityManager: null,
        annotationCanvasMap: fieldCanvases[index],
        annotationEditorUIManager: null,
        page,
        viewport,
        structTreeLayer: null,
        commentManager: null,
        linkService,
        annotationStorage: doc.annotationStorage,
      });
      await layer.render({
        viewport,
        div,
        annotations,
        page,
        linkService,
        annotationStorage: doc.annotationStorage,
        renderForms: true,
        enableScripting: false,
        hasJSActions: false,
        fieldObjects: await fieldObjects,
        imageResourcesPath: "",
        annotationCanvasMap: fieldCanvases[index],
      } as Parameters<AnnotationLayer["render"]>[0]);
      formLayers[index] = layer;
    },
    async renderForPrint(index, pixelsPerPoint, rotation = 0) {
      const page = pages[index];
      const viewport = page.getViewport({ scale: pixelsPerPoint, rotation: turned(page, rotation) });
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      await page.render({
        canvas,
        viewport,
        intent: "print",
        background: "#ffffff",
        annotationMode: AnnotationMode.ENABLE_STORAGE,
        printAnnotationStorage: doc.annotationStorage.print,
      }).promise;
      return canvas;
    },
    async renderTextLayer(index, div, rotation = 0) {
      const page = pages[index];
      const layer = new TextLayer({
        textContentSource: page.streamTextContent({ includeMarkedContent: true, disableNormalization: true }),
        container: div,
        viewport: page.getViewport({ scale: 1, rotation: turned(page, rotation) }),
      });
      await layer.render();
      // Helps drag-selection behave at the end of the text (as in Firefox's viewer).
      const end = document.createElement("div");
      end.className = "endOfContent";
      div.append(end);
    },
    pageToPdfAt(index, rotation) {
      if (rotation === 0) return pageToPdf[index];
      const page = pages[index];
      return Util.inverseTransform(page.getViewport({ scale: 1, rotation: turned(page, rotation) }).transform) as Matrix;
    },
    fileRotation(index) {
      return pages[index].rotate;
    },
    get formsModified() {
      return formsModified;
    },
    onFormsChanged(callback) {
      formListeners.push(callback);
    },
    isXfaForm: Boolean((doc as unknown as { isPureXfa?: boolean }).isPureXfa),
    async bytesWithFormValues() {
      return doc.saveDocument();
    },
    async close() {
      await task.destroy();
    },
  };
}

/** The small "link service" PDF.js needs, wired to the app's own page jumping and link confirmation. */
function makeLinkService(doc: PDFDocumentProxy, links: LinkHandler) {
  const goTo = async (dest: unknown) => {
    try {
      const explicit = typeof dest === "string" ? await doc.getDestination(dest) : (dest as unknown[]);
      if (!Array.isArray(explicit) || explicit.length === 0) return;
      const ref = explicit[0];
      const index =
        typeof ref === "number" ? ref : await doc.getPageIndex(ref as Parameters<PDFDocumentProxy["getPageIndex"]>[0]);
      links.goToPage(index);
    } catch {
      // A broken link: do nothing.
    }
  };
  return {
    externalLinkEnabled: true,
    isInPresentationMode: false,
    get pagesCount() {
      return doc.numPages;
    },
    page: 1,
    rotation: 0,
    addLinkAttributes(link: HTMLAnchorElement, url: string) {
      link.href = url;
      link.rel = "noopener noreferrer nofollow";
      link.target = "_blank";
      link.title = url;
      link.onclick = (event) => {
        event.preventDefault();
        links.openExternal(url);
        return false;
      };
    },
    getDestinationHash: () => "#",
    getAnchorUrl: (hash: string) => `#${hash}`,
    goToDestination: goTo,
    goToPage: (n: number) => links.goToPage(n - 1),
    goToXY: (n: number) => links.goToPage(n - 1),
    executeNamedAction(action: string) {
      if (action === "FirstPage") links.goToPage(0);
      else if (action === "LastPage") links.goToPage(doc.numPages - 1);
    },
    executeSetOCGState() {},
    setHash() {},
    cachePageRef() {},
    isPageVisible: () => true,
    isPageCached: () => true,
  } as unknown as ConstructorParameters<typeof AnnotationLayer>[0]["linkService"];
}

/** The page's own rotation plus an extra clockwise turn, as PDF.js expects it. */
function turned(page: PDFPageProxy, extra: number): number {
  return (((page.rotate + extra) % 360) + 360) % 360;
}

/** The general look of a font, for matching it when text is edited. */
function fontLook(page: PDFPageProxy, fontName: string, cssFamily = ""): Pick<TextFragment, "family" | "bold" | "italic"> {
  let name = "";
  let bold = false;
  let italic = false;
  try {
    // Known once the page has been drawn.
    const objs = page.commonObjs as unknown as { has(id: string): boolean; get(id: string): unknown };
    if (objs.has(fontName)) {
      const font = objs.get(fontName) as { name?: string; bold?: boolean; black?: boolean; italic?: boolean };
      name = font.name ?? "";
      bold = Boolean(font.bold || font.black);
      italic = Boolean(font.italic);
    }
  } catch {
    // Not loaded: fall back to the name hints below.
  }
  const hint = `${name} ${cssFamily}`.toLowerCase();
  if (/bold|black|heavy|semibold|demi/.test(name.toLowerCase())) bold = true;
  if (/italic|oblique/.test(name.toLowerCase())) italic = true;
  const family = /mono|courier|consol|menlo|typewriter/.test(hint)
    ? "mono"
    : /sans/.test(hint)
      ? "sans"
      : /serif|times|georgia|garamond|minion|cambria|book|roman|palatino/.test(hint)
        ? "serif"
        : "sans";
  return { family, bold, italic };
}
