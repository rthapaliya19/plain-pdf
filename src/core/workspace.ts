/**
 * The page list: which file and page each displayed page comes from, and how
 * far it is turned. Opening a file starts with its pages in order; organizing
 * and adding pages from other files change the list. The rest of the app sees
 * the list as one ordinary document.
 */
import type { LinkHandler, Matrix, PageSize, PdfDocument } from "./pdf-engine";

export interface Source {
  name: string;
  /** The file exactly as opened (never changed). */
  bytes: Uint8Array;
  doc: PdfDocument;
}

export interface PageEntry {
  /** Which file (index into the sources). */
  source: number;
  /** Which page of that file (0-based). */
  index: number;
  /** Extra clockwise turn: 0, 90, 180 or 270. */
  rotation: number;
}

export type PagePlan = readonly PageEntry[];

export function firstPlan(doc: PdfDocument): PageEntry[] {
  return doc.pageSizes.map((_, index) => ({ source: 0, index, rotation: 0 }));
}

/** True while the pages are exactly those of the one opened file, unchanged. */
export function isUnchanged(sources: readonly Source[], plan: PagePlan): boolean {
  return (
    sources.length === 1 &&
    plan.length === sources[0].doc.pageCount &&
    plan.every((e, i) => e.source === 0 && e.index === i && e.rotation === 0)
  );
}

const turn = (a: number, b: number) => (((a + b) % 360) + 360) % 360;

/** The page list, as a document the viewer, search, print and tools can use. */
export function workspaceDocument(sources: readonly Source[], plan: PagePlan): PdfDocument {
  const at = (i: number) => ({ e: plan[i], doc: sources[plan[i].source].doc });
  const pageSizes: PageSize[] = plan.map((e) => {
    const s = sources[e.source].doc.pageSizes[e.index];
    return e.rotation % 180 === 90 ? { width: s.height, height: s.width } : s;
  });
  const pageToPdf: Matrix[] = plan.map((e) => sources[e.source].doc.pageToPdfAt(e.index, e.rotation));
  /** Links point at pages of their own file: find where that page now is. */
  const linksFor = (source: number, links: LinkHandler): LinkHandler => ({
    goToPage: (index) => {
      const position = plan.findIndex((e) => e.source === source && e.index === index);
      if (position >= 0) links.goToPage(position);
    },
    openExternal: links.openExternal,
  });
  return {
    pageCount: plan.length,
    pageSizes,
    pageToPdf,
    encrypted: sources.some((s) => s.doc.encrypted),
    renderPage: (i, canvas, ppp, extra = 0) => at(i).doc.renderPage(at(i).e.index, canvas, ppp, turn(at(i).e.rotation, extra)),
    textFragments: (i, extra = 0) => at(i).doc.textFragments(at(i).e.index, turn(at(i).e.rotation, extra)),
    renderInteractive: (i, div, links, extra = 0) =>
      at(i).doc.renderInteractive(at(i).e.index, div, linksFor(at(i).e.source, links), turn(at(i).e.rotation, extra)),
    renderTextLayer: (i, div, extra = 0) => at(i).doc.renderTextLayer(at(i).e.index, div, turn(at(i).e.rotation, extra)),
    renderForPrint: (i, ppp, extra = 0) => at(i).doc.renderForPrint(at(i).e.index, ppp, turn(at(i).e.rotation, extra)),
    pageToPdfAt: (i, extra) => at(i).doc.pageToPdfAt(at(i).e.index, turn(at(i).e.rotation, extra)),
    fileRotation: (i) => at(i).doc.fileRotation(at(i).e.index),
    get formsModified() {
      return sources.some((s) => s.doc.formsModified);
    },
    onFormsChanged: (callback) => sources.forEach((s) => s.doc.onFormsChanged(callback)),
    isXfaForm: sources[0].doc.isXfaForm,
    bytesWithFormValues: () => sources[0].doc.bytesWithFormValues(),
    close: async () => {
      for (const s of sources) await s.doc.close();
    },
  };
}
