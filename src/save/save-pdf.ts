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
  PDFTextField,
  StandardFonts,
  degrees,
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
  boxMatrix,
  contentSize,
  type Addition,
  type PlacedSignature,
  type Redaction,
  type Stroke,
  type TextBox,
  type TextEdit,
  type TextHighlight,
} from "../core/additions";
import type { FontStyle } from "../core/fonts";
import type { Matrix } from "../core/pdf-engine";
import { redactPage, removeUnreachable, replaceWithPicture, type Area } from "./redact";

/** A shown-page rectangle (points, top-left origin) and the colour it's painted. */
export interface PaintedRect {
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
}

export interface RedactionOptions {
  /**
   * A picture of page `index` as shown, with `rects` painted in, for pages
   * whose content can't be changed safely when redacting.
   */
  pagePicture?: (index: number, rects: PaintedRect[]) => Promise<{ jpeg: Uint8Array; width: number; height: number }>;
  /** Told about each page that was saved as a picture. */
  onPicture?: (index: number, reason: string) => void;
}

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
  options: { lockForms?: boolean } & RedactionOptions = {},
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

  if (options.lockForms) lockFormAnswers(doc);

  if (await drawAdditions(doc, additions, pageToPdf, options)) removeUnreachable(doc);
  return doc.save();
}

/**
 * Builds a new PDF from pages of one or more files, in a new order and with
 * extra rotation (after organizing pages or adding pages from other files),
 * then draws the additions. Form answers are locked into each file's pages
 * first, since fillable fields don't survive being moved between files.
 */
export async function saveWorkspace(
  sources: { bytes: Uint8Array }[],
  plan: readonly { source: number; index: number; rotation: number }[],
  additions: Addition[],
  pageToPdf: readonly Matrix[],
  options: RedactionOptions = {},
): Promise<Uint8Array> {
  const docs: PDFDocument[] = [];
  for (const source of sources) {
    let src: PDFDocument;
    try {
      src = await PDFDocument.load(source.bytes, { updateMetadata: false });
    } catch (error) {
      if (error instanceof Error && error.name === "EncryptedPDFError") throw new EncryptedPdfError();
      throw error;
    }
    if (src.getForm().getFields().length > 0) lockFormAnswers(src);
    docs.push(src);
  }

  const out = await PDFDocument.create({ updateMetadata: false });
  copyDetails(docs[0], out);
  // Copy each file's pages in one go (shared fonts and images are copied once).
  const copies = new Map<string, PDFPage>();
  for (let s = 0; s < docs.length; s++) {
    const wanted = [...new Set(plan.filter((e) => e.source === s).map((e) => e.index))];
    if (wanted.length === 0) continue;
    const pages = await out.copyPages(docs[s], wanted);
    wanted.forEach((index, i) => copies.set(`${s}:${index}`, pages[i]));
  }
  for (const entry of plan) {
    const page = copies.get(`${entry.source}:${entry.index}`)!;
    page.setRotation(degrees((((page.getRotation().angle + entry.rotation) % 360) + 360) % 360));
    out.addPage(page);
  }
  if (await drawAdditions(out, additions, pageToPdf, options)) removeUnreachable(out);
  return out.save();
}

/** Keeps the original file's details (title, author, dates...) on a rebuilt file. */
function copyDetails(from: PDFDocument, to: PDFDocument): void {
  const title = from.getTitle();
  const author = from.getAuthor();
  const subject = from.getSubject();
  const keywords = from.getKeywords();
  const creator = from.getCreator();
  const producer = from.getProducer();
  const created = from.getCreationDate();
  const modified = from.getModificationDate();
  if (title) to.setTitle(title);
  if (author) to.setAuthor(author);
  if (subject) to.setSubject(subject);
  if (keywords) to.setKeywords([keywords]);
  if (creator) to.setCreator(creator);
  if (producer) to.setProducer(producer);
  if (created) to.setCreationDate(created);
  if (modified) to.setModificationDate(modified);
}

/**
 * The areas to clear on a page, in its PDF coordinates: redaction boxes (black)
 * and the patches over edited words (paper colour).
 */
function clearedRects(items: Addition[]): PaintedRect[] {
  const rects: PaintedRect[] = [];
  for (const a of items) {
    if (a.kind === "redact") rects.push({ x: a.x, y: a.y, w: a.width, h: a.height, color: "#000000" });
    else if (a.kind === "edit") rects.push({ ...a.cover, color: a.coverColor });
  }
  return rects;
}

function toArea(r: PaintedRect, toPdf: Matrix): Area {
  const [a, b, c, d, e, f] = toPdf;
  const corners = [
    [r.x, r.y],
    [r.x + r.w, r.y],
    [r.x, r.y + r.h],
    [r.x + r.w, r.y + r.h],
  ].map(([x, y]) => [a * x + c * y + e, b * x + d * y + f]);
  const xs = corners.map((p) => p[0]);
  const ys = corners.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys), color: rgb(r.color) };
}

/**
 * Draws every addition onto its page. `pageToPdf[i]` places page i's additions.
 * Returns true if anything was redacted (so leftovers can be cleared out).
 */
async function drawAdditions(doc: PDFDocument, additions: Addition[], pageToPdf: readonly Matrix[], options: RedactionOptions = {}): Promise<boolean> {
  let redacted = false;
  const pages = doc.getPages();
  const fonts = fontCache(doc);
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
    // First, remove for good whatever lies under redaction boxes and edit patches.
    const cleared = clearedRects(items);
    if (cleared.length > 0) {
      redacted = true;
      const result = await redactPage(doc, page, cleared.map((r) => toArea(r, pageToPdf[index])));
      if (!result.ok) {
        if (!options.pagePicture) throw new Error(`Page ${index + 1} can't be redacted: ${result.reason}`);
        await replaceWithPicture(doc, page, pageToPdf[index], await options.pagePicture(index, cleared));
        options.onPicture?.(index, result.reason);
      }
    }
    // Same layering as on screen: edited text first, then highlights, then ink on top.
    const edits = items.filter((a): a is TextEdit => a.kind === "edit");
    const highlights = items.filter((a) => a.kind === "highlight" || (a.kind === "stroke" && a.tool === "highlighter"));
    const ink = items.filter((a) => !highlights.includes(a) && a.kind !== "edit");

    const ops: PDFOperator[] = [pushGraphicsState(), concatTransformationMatrix(...pageToPdf[index])];
    for (const e of edits) {
      const font = await fonts.get(e);
      ops.push(...drawEdit(e, font, fonts.keyOn(page, e)));
    }
    if (highlights.length > 0) {
      ops.push(pushGraphicsState(), setGraphicsState(multiplyBlend(doc, page)));
      for (const item of highlights) ops.push(...drawAddition(item as Exclude<Addition, TextBox | TextEdit>));
      ops.push(popGraphicsState());
    }
    const fontKey = helvetica && ink.some((a) => a.kind === "text") ? page.node.newFontDictionary("PlainPdfHelv", helvetica.ref) : null;
    for (const item of ink) {
      if (item.kind === "text") ops.push(...drawText(item, helvetica!, fontKey!));
      else ops.push(...drawAddition(item as Exclude<Addition, TextBox | TextEdit>));
    }
    ops.push(popGraphicsState());
    page.pushOperators(...ops);
  }
  return redacted;
}

/** The standard PDF font matching an edit's look (every PDF reader has these built in). */
function standardFont(style: FontStyle): StandardFonts {
  const { family, bold, italic } = style;
  if (family === "serif") {
    return bold && italic ? StandardFonts.TimesRomanBoldItalic : bold ? StandardFonts.TimesRomanBold : italic ? StandardFonts.TimesRomanItalic : StandardFonts.TimesRoman;
  }
  if (family === "mono") {
    return bold && italic ? StandardFonts.CourierBoldOblique : bold ? StandardFonts.CourierBold : italic ? StandardFonts.CourierOblique : StandardFonts.Courier;
  }
  return bold && italic ? StandardFonts.HelveticaBoldOblique : bold ? StandardFonts.HelveticaBold : italic ? StandardFonts.HelveticaOblique : StandardFonts.Helvetica;
}

/** Embeds each standard font once per saved file and registers it on each page that uses it. */
function fontCache(doc: PDFDocument) {
  const embedded = new Map<StandardFonts, PDFFont>();
  const keys = new Map<string, PDFName>();
  return {
    async get(style: FontStyle): Promise<PDFFont> {
      const name = standardFont(style);
      if (!embedded.has(name)) embedded.set(name, await doc.embedFont(name));
      return embedded.get(name)!;
    },
    /** Call after get() for the same style. */
    keyOn(page: PDFPage, style: FontStyle): PDFName {
      const name = standardFont(style);
      const id = `${page.ref.toString()}:${name}`;
      if (!keys.has(id)) keys.set(id, page.node.newFontDictionary(`PlainPdfEdit${keys.size}`, embedded.get(name)!.ref));
      return keys.get(id)!;
    },
  };
}

/** The patch over the old words, then the new words. */
function drawEdit(e: TextEdit, font: PDFFont, fontKey: PDFName): PDFOperator[] {
  const ops: PDFOperator[] = [
    pushGraphicsState(),
    setFillingRgbColor(...rgb(e.coverColor)),
    rectangle(e.cover.x, e.cover.y, e.cover.w, e.cover.h),
    fill(),
    concatTransformationMatrix(...boxMatrix(e.x, e.y, e.width, e.height, e.turn)),
    setFillingRgbColor(...rgb(e.color)),
    beginText(),
    setFontAndSize(fontKey, e.size),
  ];
  e.lines.forEach((line, i) => {
    const text = encodable(line, font);
    if (!text) return;
    ops.push(setTextMatrix(1, 0, 0, -1, 0, e.baselineOffset + i * e.lineHeight), showText(font.encodeText(text)));
  });
  ops.push(endText(), popGraphicsState());
  return ops;
}

/**
 * Filled-in form answers become part of the page, like everything else.
 * Each text answer is redrawn fresh (Helvetica), so it looks right in every
 * reader; boxes set to "automatic size" with several lines use 12 pt and wrap,
 * like Adobe's apps do.
 */
function lockFormAnswers(doc: PDFDocument): void {
  const form = doc.getForm();
  try {
    for (const field of form.getFields()) {
      if (!(field instanceof PDFTextField)) continue;
      const appearance = field.acroField.getDefaultAppearance() ?? "";
      const size = parseFloat(/([\d.]+)\s+Tf/.exec(appearance)?.[1] ?? "0");
      if (size === 0 && field.isMultiline()) field.setFontSize(12);
      field.setText(field.getText() ?? "");
    }
    form.flatten();
    return;
  } catch (error) {
    console.info("Couldn't redraw form answers; locking them as they are:", error);
  }
  try {
    form.flatten({ updateFieldAppearances: false });
  } catch (error) {
    // Some unusual forms can't be locked; their answers are still saved (editable).
    console.info("Form answers saved but not locked:", error);
  }
}

/** A graphics setting that blends like a real highlighter: text underneath stays dark. */
function multiplyBlend(doc: PDFDocument, page: PDFPage): PDFName {
  const state = doc.context.obj({ Type: "ExtGState", BM: "Multiply" });
  return page.node.newExtGState("PlainPdfHighlight", doc.context.register(state));
}

function drawAddition(item: Exclude<Addition, TextBox | TextEdit>): PDFOperator[] {
  if (item.kind === "stroke") return drawStroke(item);
  if (item.kind === "highlight") return drawHighlight(item);
  if (item.kind === "redact") return drawRedaction(item);
  return drawSignature(item);
}

/** A solid black box. */
function drawRedaction(r: Redaction): PDFOperator[] {
  return [pushGraphicsState(), setFillingRgbColor(0, 0, 0), rectangle(r.x, r.y, r.width, r.height), fill(), popGraphicsState()];
}

/**
 * Real, selectable text. The page transform turns everything upside down
 * (PDF measures from the bottom), so the text matrix flips each line back.
 */
function drawText(t: TextBox, font: PDFFont, fontKey: PDFName): PDFOperator[] {
  const ops: PDFOperator[] = [
    pushGraphicsState(),
    concatTransformationMatrix(...boxMatrix(t.x, t.y, t.width, t.height, t.turn)),
    setFillingRgbColor(...rgb(t.color)),
    beginText(),
    setFontAndSize(fontKey, t.size),
  ];
  t.text.split("\n").forEach((line, i) => {
    const text = encodable(line, font);
    if (!text) return;
    const baseline = (TEXT_BASELINE + i * TEXT_LINE_HEIGHT) * t.size;
    ops.push(setTextMatrix(1, 0, 0, -1, 0, baseline), showText(font.encodeText(text)));
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
  const c = contentSize(sig.width, sig.height, sig.turn);
  const sx = c.width / sig.ink.width;
  const sy = c.height / sig.ink.height;
  const ops: PDFOperator[] = [
    pushGraphicsState(),
    concatTransformationMatrix(...boxMatrix(sig.x, sig.y, sig.width, sig.height, sig.turn)),
    concatTransformationMatrix(sx, 0, 0, sy, 0, 0),
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
