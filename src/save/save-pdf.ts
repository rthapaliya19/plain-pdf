/**
 * Writes the additions (pen strokes, highlights, signatures) permanently
 * into a copy of the PDF, using pdf-lib. The original file is not changed.
 *
 * Additions become part of the page itself ("locked in"), so they look the
 * same in every PDF reader and can't be moved or deleted there.
 *
 * Positions are converted from the app's page coordinates (points, top-left
 * origin, rotation applied) into each page's own PDF coordinates with one
 * transform per page, so everything lands exactly where it was drawn, even
 * on rotated or cropped pages.
 */
import {
  LineCapStyle,
  LineJoinStyle,
  PDFDocument,
  PDFName,
  StandardFonts,
  type PDFFont,
  type PDFOperator,
  type PDFPage,
  appendBezierCurve,
  beginText,
  endText,
  setFontAndSize,
  setTextMatrix,
  showText,
  concatTransformationMatrix,
  fill,
  lineTo,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  setFillingRgbColor,
  setGraphicsState,
  setLineCap,
  setLineJoin,
  setLineWidth,
  setStrokingRgbColor,
  stroke,
} from "pdf-lib";
import {
  TEXT_BASELINE,
  TEXT_LINE_HEIGHT,
  type Addition,
  type PlacedSignature,
  type Stroke,
  type TextBox,
  type TextHighlight,
} from "../core/additions";
import type { Matrix } from "../core/pdf-engine";

export class EncryptedPdfError extends Error {
  constructor() {
    super("This PDF is encrypted (password-protected), so Plain PDF can't save a copy with changes yet.");
    this.name = "EncryptedPdfError";
  }
}

export async function saveWithAdditions(
  original: Uint8Array,
  additions: Addition[],
  pageToPdf: readonly Matrix[],
  options: { lockForms?: boolean } = {},
): Promise<Uint8Array> {
  let doc: PDFDocument;
  try {
    // updateMetadata: false keeps the file's own details (author, dates, etc.)
    // as they were, and adds nothing about this app.
    doc = await PDFDocument.load(original, { updateMetadata: false });
  } catch (error) {
    if (error instanceof Error && error.name === "EncryptedPDFError") throw new EncryptedPdfError();
    throw error;
  }

  if (options.lockForms) {
    // Filled-in form answers become part of the page, like everything else.
    try {
      doc.getForm().flatten({ updateFieldAppearances: false });
    } catch (error) {
      // Some unusual forms can't be locked; their answers are still saved (editable).
      console.info("Form answers saved but not locked:", error);
    }
  }

  const pages = doc.getPages();
  // Typed text uses Helvetica, a font every PDF reader has built in.
  const helvetica = additions.some((a) => a.kind === "text") ? await doc.embedFont(StandardFonts.Helvetica) : null;
  const byPage = new Map<number, Addition[]>();
  for (const item of additions) {
    if (!byPage.has(item.page)) byPage.set(item.page, []);
    byPage.get(item.page)!.push(item);
  }

  for (const [index, items] of byPage) {
    const page = pages[index];
    if (!page) continue;
    items.sort((a, b) => a.order - b.order);
    // Same layering as on screen: highlights underneath, ink on top.
    const highlights = items.filter((a) => a.kind === "highlight" || (a.kind === "stroke" && a.tool === "highlighter"));
    const ink = items.filter((a) => !highlights.includes(a));

    const ops: PDFOperator[] = [pushGraphicsState(), concatTransformationMatrix(...pageToPdf[index])];
    if (highlights.length > 0) {
      ops.push(pushGraphicsState(), setGraphicsState(multiplyBlend(doc, page)));
      for (const item of highlights) ops.push(...drawAddition(item as Exclude<Addition, TextBox>));
      ops.push(popGraphicsState());
    }
    const fontKey = helvetica && ink.some((a) => a.kind === "text") ? page.node.newFontDictionary("PlainPdfHelv", helvetica.ref) : null;
    for (const item of ink) {
      if (item.kind === "text") ops.push(...drawText(item, helvetica!, fontKey!));
      else ops.push(...drawAddition(item));
    }
    ops.push(popGraphicsState());
    page.pushOperators(...ops);
  }

  return doc.save();
}

/** A graphics setting that blends like a real highlighter: text underneath stays dark. */
function multiplyBlend(doc: PDFDocument, page: PDFPage): PDFName {
  const state = doc.context.obj({ Type: "ExtGState", BM: "Multiply" });
  return page.node.newExtGState("PlainPdfHighlight", doc.context.register(state));
}

function drawAddition(item: Exclude<Addition, TextBox>): PDFOperator[] {
  if (item.kind === "stroke") return drawStroke(item);
  if (item.kind === "highlight") return drawHighlight(item);
  return drawSignature(item);
}

/**
 * Real, selectable text. The page transform turns everything upside down
 * (PDF measures from the bottom), so the text matrix flips each line back.
 */
function drawText(t: TextBox, font: PDFFont, fontKey: PDFName): PDFOperator[] {
  const ops: PDFOperator[] = [pushGraphicsState(), setFillingRgbColor(...rgb(t.color)), beginText(), setFontAndSize(fontKey, t.size)];
  t.text.split("\n").forEach((line, i) => {
    const text = encodable(line, font);
    if (!text) return;
    const baseline = t.y + (TEXT_BASELINE + i * TEXT_LINE_HEIGHT) * t.size;
    ops.push(setTextMatrix(1, 0, 0, -1, t.x, baseline), showText(font.encodeText(text)));
  });
  ops.push(endText(), popGraphicsState());
  return ops;
}

/** Replaces any character the built-in font can't show (rare in English) with "?". */
function encodable(text: string, font: PDFFont): string {
  let out = "";
  for (const ch of text) {
    try {
      font.encodeText(ch);
      out += ch;
    } catch {
      out += "?";
    }
  }
  return out;
}

function drawStroke(s: Stroke): PDFOperator[] {
  return [
    pushGraphicsState(),
    setStrokingRgbColor(...rgb(s.color)),
    setLineWidth(s.width),
    setLineCap(LineCapStyle.Round),
    setLineJoin(LineJoinStyle.Round),
    ...smoothPathOps(s.points),
    stroke(),
    popGraphicsState(),
  ];
}

function drawHighlight(h: TextHighlight): PDFOperator[] {
  return [
    pushGraphicsState(),
    setFillingRgbColor(...rgb(h.color)),
    ...h.rects.map((r) => rectangle(r.x, r.y, r.w, r.h)),
    fill(),
    popGraphicsState(),
  ];
}

function drawSignature(sig: PlacedSignature): PDFOperator[] {
  const sx = sig.width / sig.ink.width;
  const sy = sig.height / sig.ink.height;
  const ops: PDFOperator[] = [
    pushGraphicsState(),
    concatTransformationMatrix(sx, 0, 0, sy, sig.x, sig.y),
    setStrokingRgbColor(...rgb(sig.ink.color)),
    setLineWidth(sig.ink.lineWidth),
    setLineCap(LineCapStyle.Round),
    setLineJoin(LineJoinStyle.Round),
  ];
  for (const points of sig.ink.strokes) ops.push(...smoothPathOps(points), stroke());
  ops.push(popGraphicsState());
  return ops;
}

/**
 * The same smooth curve the screen shows (see overlay/paths.ts), written as
 * PDF drawing commands. PDF only has cubic curves, so each quadratic curve
 * is converted to its exact cubic equivalent.
 */
function smoothPathOps(points: number[]): PDFOperator[] {
  const n = points.length / 2;
  if (n === 0) return [];
  const x = (i: number) => points[i * 2];
  const y = (i: number) => points[i * 2 + 1];
  if (n === 1) return [moveTo(x(0), y(0)), lineTo(x(0) + 0.01, y(0))];
  if (n === 2) return [moveTo(x(0), y(0)), lineTo(x(1), y(1))];
  const ops: PDFOperator[] = [moveTo(x(0), y(0))];
  let cx = x(0);
  let cy = y(0);
  for (let i = 1; i < n - 1; i++) {
    const qx = x(i);
    const qy = y(i);
    const ex = (qx + x(i + 1)) / 2;
    const ey = (qy + y(i + 1)) / 2;
    ops.push(
      appendBezierCurve(
        cx + (2 / 3) * (qx - cx),
        cy + (2 / 3) * (qy - cy),
        ex + (2 / 3) * (qx - ex),
        ey + (2 / 3) * (qy - ey),
        ex,
        ey,
      ),
    );
    cx = ex;
    cy = ey;
  }
  ops.push(lineTo(x(n - 1), y(n - 1)));
  return ops;
}

/** "#1d4ed8" -> [0.11, 0.31, 0.85] */
function rgb(hex: string): [number, number, number] {
  const v = hex.replace("#", "");
  const full = v.length === 3 ? [...v].map((c) => c + c).join("") : v;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255) as [number, number, number];
}
