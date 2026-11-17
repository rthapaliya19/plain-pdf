/**
 * Redaction: permanently removes what lies under redaction boxes (and under
 * the patches of edited text) from a page, before the boxes themselves are
 * drawn on top:
 * - text: each letter under a box is taken out of the page's drawing
 *   instructions, and the rest of the line stays exactly where it was;
 * - pictures: the pixels under a box are painted over (in the box's colour);
 * - drawn shapes: those lying inside a box are taken out; rectangles and short
 *   straight lines crossing a box are cut along it (the parts outside stay);
 *   curves and long lines crossing a box can't be cut safely;
 * - links, notes and form fields over a box are removed;
 * - hidden "ActualText" copies of words on the page are dropped, and so are
 *   the page's thumbnail and app-private data.
 * Pictures and drawings that other pages also use are copied first, so the
 * other pages aren't affected. The finished page is then read again to make
 * sure nothing is left under a box. When something can't be handled safely
 * (an unusual font or picture format, a curve crossing a box), or the check
 * finds anything left, the page is reported as needing to be saved as a
 * picture instead, which the caller does (replaceWithPicture).
 * Once every page is done, clearOutLeftovers removes from the file whatever
 * the redacted pages no longer use.
 */
import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFPageLeaf,
  PDFPageTree,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  decodePDFRawStream,
  type PDFDocument,
  type PDFObject,
  type PDFPage,
} from "pdf-lib";
import { Encodings, Font as StandardFont, type IFontNames } from "@pdf-lib/standard-fonts";

/** An area to clear, in the page's own PDF coordinates, with the colour pictures are painted (0..1 RGB). */
export interface Area {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  color: [number, number, number];
}

export type RedactResult = { ok: true } | { ok: false; reason: string };

class Unsupported extends Error {}

type M = [number, number, number, number, number, number];
const IDENTITY: M = [1, 0, 0, 1, 0, 0];
/** m1 × m2 (PDF's row-vector convention: apply m1 first, then m2). */
function mul(m1: M, m2: M): M {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}
function apply(m: M, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}
function invert(m: M): M | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) return null;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}
interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
function bounds(points: [number, number][]): Box {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}
function overlap(a: Box, b: Box): { w: number; h: number } {
  return { w: Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), h: Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) };
}
function touches(a: Box, b: Box, margin = 0.25): boolean {
  const o = overlap(a, b);
  return o.w > margin && o.h > margin;
}
function inside(inner: Box, outer: Box, slack = 1): boolean {
  return inner.x0 >= outer.x0 - slack && inner.y0 >= outer.y0 - slack && inner.x1 <= outer.x1 + slack && inner.y1 <= outer.y1 + slack;
}
/** A box made smaller on every side (by at most a quarter of its size). */
function shrink(b: Box, by: number): Box {
  const m = Math.min(by, (b.x1 - b.x0) / 4, (b.y1 - b.y0) / 4);
  return { x0: b.x0 + m, y0: b.y0 + m, x1: b.x1 - m, y1: b.y1 - m };
}

/** One page's redaction, or the check of a finished page. */
interface Job {
  doc: PDFDocument;
  areas: Area[];
  /**
   * The areas made slightly smaller: shapes crossing a box are cut along
   * these, so a cut edge sits just under the box rather than exactly at its
   * edge (where a hairline of the shape could show beside the box).
   */
  holes: Box[];
  counter: { n: number };
  /** Painted copies of pictures made for this page: where each one is drawn, and the areas painted on it. */
  painted: Map<string, { ctm: M; areas: Area[] }>;
  /** Re-reading a finished page: anything that would still need changing is something left behind. */
  checking: boolean;
}

// ---------------------------------------------------------------------------
// Reading drawing instructions ("content streams")
// ---------------------------------------------------------------------------

type Value = number | boolean | null | { str: Uint8Array } | { name: string } | Value[] | Map<string, Value> | { op: string };
interface Operation {
  op: string;
  args: Value[];
  /** Byte range of the whole operation (operands and operator). */
  start: number;
  end: number;
}

const WHITE = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]);

/** Splits drawing instructions into operations. Inline pictures (BI ... EI) become one "BI" operation. */
function parseContent(data: Uint8Array): Operation[] {
  const ops: Operation[] = [];
  let i = 0;
  const n = data.length;
  let operands: Value[] = [];
  let operandsStart = -1;
  const skipSpace = () => {
    for (;;) {
      while (i < n && WHITE.has(data[i])) i++;
      if (data[i] === 37) {
        while (i < n && data[i] !== 10 && data[i] !== 13) i++;
        continue;
      }
      break;
    }
  };
  const readValue = (): Value => {
    skipSpace();
    const c = data[i];
    if (c === 40) return { str: readLiteral() };
    if (c === 60 && data[i + 1] === 60) {
      i += 2;
      const dict = new Map<string, Value>();
      for (;;) {
        skipSpace();
        if (i >= n) throw new Unsupported("unfinished dictionary");
        if (data[i] === 62 && data[i + 1] === 62) {
          i += 2;
          return dict;
        }
        const key = readValue();
        if (!key || typeof key !== "object" || !("name" in key)) throw new Unsupported("bad dictionary");
        dict.set(key.name, readValue());
      }
    }
    if (c === 60) return { str: readHex() };
    if (c === 91) {
      i++;
      const arr: Value[] = [];
      for (;;) {
        skipSpace();
        if (i >= n) throw new Unsupported("unfinished array");
        if (data[i] === 93) {
          i++;
          return arr;
        }
        arr.push(readValue());
      }
    }
    if (c === 47) {
      i++;
      let s = "";
      while (i < n && !WHITE.has(data[i]) && !DELIM.has(data[i])) {
        if (data[i] === 35 && i + 2 < n) {
          s += String.fromCharCode(parseInt(String.fromCharCode(data[i + 1], data[i + 2]), 16));
          i += 3;
        } else s += String.fromCharCode(data[i++]);
      }
      return { name: s };
    }
    // A number or a keyword.
    const start = i;
    while (i < n && !WHITE.has(data[i]) && !DELIM.has(data[i])) i++;
    if (i === start) {
      i++; // a stray delimiter (like ")" or "}"): skip it
      return { op: "" };
    }
    const word = latin1(data.subarray(start, i));
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) return parseFloat(word);
    if (word === "true") return true;
    if (word === "false") return false;
    if (word === "null") return null;
    return { op: word };
  };
  const readLiteral = (): Uint8Array => {
    i++;
    const out: number[] = [];
    let depth = 1;
    while (i < n) {
      const c = data[i++];
      if (c === 92) {
        const e = data[i++];
        if (e === 110) out.push(10);
        else if (e === 114) out.push(13);
        else if (e === 116) out.push(9);
        else if (e === 98) out.push(8);
        else if (e === 102) out.push(12);
        else if (e === 13) {
          if (data[i] === 10) i++;
        } else if (e === 10) {
          // line continuation
        } else if (e >= 48 && e <= 55) {
          let v = e - 48;
          for (let k = 0; k < 2 && data[i] >= 48 && data[i] <= 55; k++) v = v * 8 + (data[i++] - 48);
          out.push(v & 255);
        } else out.push(e);
      } else if (c === 40) {
        depth++;
        out.push(c);
      } else if (c === 41) {
        if (--depth === 0) break;
        out.push(c);
      } else out.push(c);
    }
    return Uint8Array.from(out);
  };
  const readHex = (): Uint8Array => {
    i++;
    let hex = "";
    while (i < n && data[i] !== 62) {
      if (!WHITE.has(data[i])) hex += String.fromCharCode(data[i]);
      i++;
    }
    i++;
    if (hex.length % 2) hex += "0";
    const out = new Uint8Array(hex.length / 2);
    for (let k = 0; k < out.length; k++) out[k] = parseInt(hex.slice(k * 2, k * 2 + 2), 16) || 0;
    return out;
  };

  for (;;) {
    skipSpace();
    if (i >= n) break;
    const tokenStart = i;
    const v = readValue();
    if (v && typeof v === "object" && "op" in v) {
      if (v.op === "") continue;
      if (v.op === "BI") {
        // Inline picture: key/value pairs, "ID", one space, binary data, then "EI".
        const dict = new Map<string, Value>();
        for (;;) {
          skipSpace();
          if (i >= n) throw new Unsupported("unfinished inline picture");
          if (data[i] === 73 && data[i + 1] === 68 && (i + 2 >= n || WHITE.has(data[i + 2]))) {
            i += 3;
            break;
          }
          const key = readValue();
          if (!key || typeof key !== "object" || !("name" in key)) throw new Unsupported("bad inline picture");
          dict.set(key.name, readValue());
        }
        let end = i;
        while (end < n - 1 && !(data[end] === 69 && data[end + 1] === 73 && WHITE.has(data[end - 1]) && (end + 2 >= n || WHITE.has(data[end + 2])))) end++;
        i = Math.min(n, end + 2);
        ops.push({ op: "BI", args: [dict], start: operandsStart >= 0 ? operandsStart : tokenStart, end: i });
      } else {
        ops.push({ op: v.op, args: operands, start: operandsStart >= 0 ? operandsStart : tokenStart, end: i });
      }
      operands = [];
      operandsStart = -1;
    } else {
      if (operandsStart < 0) operandsStart = tokenStart;
      operands.push(v);
    }
  }
  return ops;
}

function latin1(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}
const num = (v: Value | undefined): number => (typeof v === "number" ? v : 0);
const isStr = (v: Value | undefined): v is { str: Uint8Array } => !!v && typeof v === "object" && "str" in v;
const isName = (v: Value | undefined): v is { name: string } => !!v && typeof v === "object" && "name" in v;
const hex = (bytes: Uint8Array) => `<${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}>`;
const fmt = (x: number) => (Math.abs(x) < 1e-6 ? "0" : String(Math.round(x * 1000) / 1000));

function writeValue(v: Value): string {
  if (typeof v === "number") return fmt(v);
  if (typeof v === "boolean") return String(v);
  if (v === null) return "null";
  if (Array.isArray(v)) return `[${v.map(writeValue).join(" ")}]`;
  if (v instanceof Map) return `<<${[...v].map(([k, x]) => `${writeName(k)} ${writeValue(x)}`).join(" ")}>>`;
  if ("str" in v) return hex(v.str);
  if ("name" in v) return writeName(v.name);
  return v.op;
}
function writeName(s: string): string {
  let out = "/";
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    out += c < 33 || c > 126 || DELIM.has(c) || c === 35 ? `#${c.toString(16).padStart(2, "0")}` : ch;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fonts: how wide each letter is, so its position on the page is known
// ---------------------------------------------------------------------------

interface FontInfo {
  twoByte: boolean;
  /** Advance width of a code, in text space (1 = the font size). */
  width(code: number): number;
  ascent: number;
  descent: number;
}

const STANDARD: Record<string, IFontNames> = {
  Helvetica: "Helvetica", "Helvetica-Bold": "Helvetica-Bold", "Helvetica-Oblique": "Helvetica-Oblique", "Helvetica-BoldOblique": "Helvetica-BoldOblique",
  Arial: "Helvetica", ArialMT: "Helvetica", "Arial,Bold": "Helvetica-Bold", "Arial-BoldMT": "Helvetica-Bold", "Arial,Italic": "Helvetica-Oblique", "Arial-ItalicMT": "Helvetica-Oblique", "Arial,BoldItalic": "Helvetica-BoldOblique", "Arial-BoldItalicMT": "Helvetica-BoldOblique",
  "Times-Roman": "Times-Roman", "Times-Bold": "Times-Bold", "Times-Italic": "Times-Italic", "Times-BoldItalic": "Times-BoldItalic",
  TimesNewRoman: "Times-Roman", TimesNewRomanPSMT: "Times-Roman", "TimesNewRoman,Bold": "Times-Bold", "TimesNewRomanPS-BoldMT": "Times-Bold", "TimesNewRoman,Italic": "Times-Italic", "TimesNewRomanPS-ItalicMT": "Times-Italic", "TimesNewRoman,BoldItalic": "Times-BoldItalic", "TimesNewRomanPS-BoldItalicMT": "Times-BoldItalic",
  Courier: "Courier", "Courier-Bold": "Courier-Bold", "Courier-Oblique": "Courier-Oblique", "Courier-BoldOblique": "Courier-BoldOblique",
  CourierNew: "Courier", CourierNewPSMT: "Courier", "CourierNew,Bold": "Courier-Bold", "CourierNewPS-BoldMT": "Courier-Bold",
  Symbol: "Symbol", ZapfDingbats: "ZapfDingbats",
};

let winAnsiNames: Map<number, string> | null = null;
function encodingNames(which: "WinAnsi" | "Symbol" | "ZapfDingbats"): Map<number, string> {
  if (which === "WinAnsi" && winAnsiNames) return winAnsiNames;
  const enc = Encodings[which];
  const map = new Map<number, string>();
  for (const cp of enc.supportedCodePoints) {
    const { code, name } = enc.encodeUnicodeCodePoint(cp);
    if (!map.has(code)) map.set(code, name);
  }
  if (which === "WinAnsi") winAnsiNames = map;
  return map;
}

function readFont(doc: PDFDocument, fontDict: PDFDict): FontInfo {
  const ctx = doc.context;
  const get = (d: PDFDict, key: string) => d.lookup(PDFName.of(key));
  const nameOf = (o: PDFObject | undefined) => (o instanceof PDFName ? o.decodeText() : "");
  const subtype = nameOf(get(fontDict, "Subtype"));
  const descriptor = (d: PDFDict) => {
    const fd = get(d, "FontDescriptor");
    return fd instanceof PDFDict ? fd : null;
  };
  const vertical = (d: PDFDict | null, scale: number) => {
    const asc = d && get(d, "Ascent") instanceof PDFNumber ? (get(d, "Ascent") as PDFNumber).asNumber() * scale : 0.8;
    const desc = d && get(d, "Descent") instanceof PDFNumber ? (get(d, "Descent") as PDFNumber).asNumber() * scale : -0.2;
    // Generous, so letters are never missed.
    return { ascent: Math.max(asc, 0.75, 0), descent: Math.min(desc, -0.2) };
  };

  if (subtype === "Type0") {
    const encoding = nameOf(get(fontDict, "Encoding"));
    if (encoding !== "Identity-H") throw new Unsupported(`font encoding ${encoding || "(custom)"}`);
    const kids = get(fontDict, "DescendantFonts");
    const cid = kids instanceof PDFArray ? kids.lookup(0) : null;
    if (!(cid instanceof PDFDict)) throw new Unsupported("font without parts");
    const dw = get(cid, "DW") instanceof PDFNumber ? (get(cid, "DW") as PDFNumber).asNumber() : 1000;
    const widths = new Map<number, number>();
    const w = get(cid, "W");
    if (w instanceof PDFArray) {
      const items = w.asArray().map((x) => ctx.lookup(x));
      for (let k = 0; k < items.length; ) {
        const first = items[k];
        const next = items[k + 1];
        if (!(first instanceof PDFNumber)) break;
        if (next instanceof PDFArray) {
          next.asArray().forEach((x, j) => {
            const v = ctx.lookup(x);
            if (v instanceof PDFNumber) widths.set(first.asNumber() + j, v.asNumber());
          });
          k += 2;
        } else {
          const last = next as PDFNumber;
          const v = items[k + 2] as PDFNumber;
          if (!(last instanceof PDFNumber) || !(v instanceof PDFNumber)) break;
          for (let c = first.asNumber(); c <= last.asNumber() && c - first.asNumber() < 65536; c++) widths.set(c, v.asNumber());
          k += 3;
        }
      }
    }
    return { twoByte: true, width: (code) => (widths.get(code) ?? dw) / 1000, ...vertical(descriptor(cid), 0.001) };
  }

  if (subtype !== "Type1" && subtype !== "MMType1" && subtype !== "TrueType" && subtype !== "Type3") {
    throw new Unsupported(`font type ${subtype || "(none)"}`);
  }
  let scale = 0.001;
  let v = vertical(descriptor(fontDict), 0.001);
  if (subtype === "Type3") {
    const fm = get(fontDict, "FontMatrix");
    const m = fm instanceof PDFArray ? fm.asArray().map((x) => (ctx.lookup(x) as PDFNumber)?.asNumber?.() ?? 0) : [0.001, 0, 0, 0.001, 0, 0];
    if (Math.abs(m[1]) > 1e-9 || Math.abs(m[2]) > 1e-9) throw new Unsupported("turned Type3 font");
    scale = m[0];
    const bb = get(fontDict, "FontBBox");
    const b = bb instanceof PDFArray ? bb.asArray().map((x) => (ctx.lookup(x) as PDFNumber)?.asNumber?.() ?? 0) : [0, -200, 1000, 800];
    v = { ascent: Math.max(b[3] * m[3], 0.75), descent: Math.min(b[1] * m[3], -0.2) };
  }
  const widthsArr = get(fontDict, "Widths");
  if (widthsArr instanceof PDFArray) {
    const first = (get(fontDict, "FirstChar") as PDFNumber | undefined)?.asNumber?.() ?? 0;
    const widths = widthsArr.asArray().map((x) => (ctx.lookup(x) as PDFNumber)?.asNumber?.() ?? 0);
    const fd = descriptor(fontDict);
    const missing = fd && get(fd, "MissingWidth") instanceof PDFNumber ? (get(fd, "MissingWidth") as PDFNumber).asNumber() : 0;
    return { twoByte: false, width: (code) => (widths[code - first] ?? missing) * scale, ...v };
  }
  // No widths: one of the 14 standard fonts, measured from its known metrics.
  const base = nameOf(get(fontDict, "BaseFont")).replace(/^[A-Z]{6}\+/, "");
  const std = STANDARD[base];
  if (!std || subtype === "Type3") throw new Unsupported(`font ${base || "(unnamed)"} without widths`);
  const metrics = StandardFont.load(std);
  const names = new Map(encodingNames(std === "Symbol" ? "Symbol" : std === "ZapfDingbats" ? "ZapfDingbats" : "WinAnsi"));
  const enc = get(fontDict, "Encoding");
  if (enc instanceof PDFDict) {
    const diffs = get(enc, "Differences");
    if (diffs instanceof PDFArray) {
      let code = 0;
      for (const x of diffs.asArray().map((y) => ctx.lookup(y))) {
        if (x instanceof PDFNumber) code = x.asNumber();
        else if (x instanceof PDFName) names.set(code++, x.decodeText());
      }
    }
  }
  const missing = metrics.getWidthOfGlyph("space") ?? 250;
  const asc = typeof metrics.Ascender === "number" ? metrics.Ascender / 1000 : 0.8;
  const desc = typeof metrics.Descender === "number" ? metrics.Descender / 1000 : -0.2;
  return {
    twoByte: false,
    width: (code) => (metrics.getWidthOfGlyph(names.get(code) ?? "") ?? missing) / 1000,
    ascent: Math.max(asc, 0.75),
    descent: Math.min(desc, -0.2),
  };
}

// ---------------------------------------------------------------------------
// Pictures: painting over the pixels under a box
// ---------------------------------------------------------------------------

function streamBytes(stream: PDFStream): Uint8Array {
  if (stream instanceof PDFRawStream) return decodePDFRawStream(stream).decode();
  const s = stream as unknown as { getUnencodedContents?: () => Uint8Array };
  if (s.getUnencodedContents) return s.getUnencodedContents();
  throw new Unsupported("unknown stream");
}

function filters(dict: PDFDict): string[] {
  const f = dict.lookup(PDFName.of("Filter"));
  if (f instanceof PDFName) return [f.decodeText()];
  if (f instanceof PDFArray) return f.asArray().map((x) => (x instanceof PDFName ? x.decodeText() : "?"));
  return [];
}

/** Undoes PNG-style (10-15) or TIFF (2) row predictors. */
function unpredict(data: Uint8Array, params: PDFDict | undefined, colors: number, bpc: number, width: number): Uint8Array {
  const predictor = (params?.lookup(PDFName.of("Predictor")) as PDFNumber | undefined)?.asNumber?.() ?? 1;
  if (predictor === 1) return data;
  const cols = (params?.lookup(PDFName.of("Columns")) as PDFNumber | undefined)?.asNumber?.() ?? width;
  const ncolors = (params?.lookup(PDFName.of("Colors")) as PDFNumber | undefined)?.asNumber?.() ?? colors;
  const bits = (params?.lookup(PDFName.of("BitsPerComponent")) as PDFNumber | undefined)?.asNumber?.() ?? bpc;
  const bpp = Math.max(1, Math.ceil((ncolors * bits) / 8));
  const rowLen = Math.ceil((cols * ncolors * bits) / 8);
  if (predictor === 2) {
    if (bits !== 8) throw new Unsupported("TIFF predictor");
    const out = data.slice();
    for (let r = 0; r * rowLen < out.length; r++) {
      for (let k = bpp; k < rowLen; k++) out[r * rowLen + k] = (out[r * rowLen + k] + out[r * rowLen + k - bpp]) & 255;
    }
    return out;
  }
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = new Uint8Array(rows * rowLen);
  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowLen + 1)];
    const src = r * (rowLen + 1) + 1;
    const dst = r * rowLen;
    for (let k = 0; k < rowLen; k++) {
      const raw = data[src + k];
      const left = k >= bpp ? out[dst + k - bpp] : 0;
      const up = r > 0 ? out[dst - rowLen + k] : 0;
      const upLeft = r > 0 && k >= bpp ? out[dst - rowLen + k - bpp] : 0;
      let v: number;
      if (type === 0) v = raw;
      else if (type === 1) v = raw + left;
      else if (type === 2) v = raw + up;
      else if (type === 3) v = raw + ((left + up) >> 1);
      else if (type === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        v = raw + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
      } else throw new Unsupported("unknown row predictor");
      out[dst + k] = v & 255;
    }
  }
  return out;
}

interface PixelBox {
  c0: number;
  r0: number;
  c1: number;
  r1: number;
}

/** The pixel rectangles of an image (width × height, drawn with `ctm`) that lie under the areas. */
function pixelBoxes(ctm: M, width: number, height: number, areas: Area[]): { box: PixelBox; color: Area["color"] }[] {
  const inv = invert(ctm);
  if (!inv) return [];
  const out: { box: PixelBox; color: Area["color"] }[] = [];
  for (const a of areas) {
    const b = bounds([apply(inv, a.x0, a.y0), apply(inv, a.x1, a.y0), apply(inv, a.x0, a.y1), apply(inv, a.x1, a.y1)]);
    // Image space: (0,0) is the bottom-left; the first row of pixels is the top.
    const c0 = Math.max(0, Math.floor(b.x0 * width));
    const c1 = Math.min(width, Math.ceil(b.x1 * width));
    const r0 = Math.max(0, Math.floor((1 - b.y1) * height));
    const r1 = Math.min(height, Math.ceil((1 - b.y0) * height));
    if (c1 > c0 && r1 > r0) out.push({ box: { c0, r0, c1, r1 }, color: a.color });
  }
  return out;
}

/**
 * A painted picture's copy doesn't take its original's other versions
 * (Alternates, e.g. a print version), XMP details (which can hold a small
 * picture), links to print versions (OPI) or app-private data: all can show
 * the original, unpainted.
 */
const IMAGE_NOT_COPIED = ["Alternates", "Metadata", "OPI", "PieceInfo"];

/**
 * A copy of an image with the pixels under the areas painted over, as a new
 * object (the original may be used elsewhere). Throws Unsupported for kinds
 * of pictures that can't be changed safely.
 */
async function paintImage(doc: PDFDocument, image: PDFStream, ctm: M, areas: Area[], asMask = false): Promise<PDFRef | null> {
  const dict = image.dict;
  const ctx = doc.context;
  const width = (dict.lookup(PDFName.of("Width")) as PDFNumber | undefined)?.asNumber?.() ?? 0;
  const height = (dict.lookup(PDFName.of("Height")) as PDFNumber | undefined)?.asNumber?.() ?? 0;
  const boxes = pixelBoxes(ctm, width, height, areas);
  if (boxes.length === 0) return null;
  const isMask = asMask || String(dict.lookup(PDFName.of("ImageMask"))) === "true";
  const bpc = isMask ? 1 : ((dict.lookup(PDFName.of("BitsPerComponent")) as PDFNumber | undefined)?.asNumber?.() ?? 8);
  if (dict.lookup(PDFName.of("Mask")) instanceof PDFStream) throw new Unsupported("picture with a separate mask");
  const decodeArr = dict.lookup(PDFName.of("Decode"));
  const inverted = decodeArr instanceof PDFArray && (decodeArr.lookup(0) as PDFNumber)?.asNumber?.() === 1;
  const f = filters(dict);

  // Colour space: how many numbers per pixel, and how to write a colour.
  let comps = 1;
  let toSample = (c: Area["color"]) => [Math.round(255 * (0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]))];
  if (!isMask) {
    let cs: PDFObject | undefined = dict.lookup(PDFName.of("ColorSpace"));
    if (cs instanceof PDFArray && (cs.lookup(0) as PDFName)?.decodeText?.() === "ICCBased") {
      const icc = cs.lookup(1);
      const nComp = icc instanceof PDFStream ? (icc.dict.lookup(PDFName.of("N")) as PDFNumber | undefined)?.asNumber?.() : undefined;
      cs = PDFName.of(nComp === 3 ? "DeviceRGB" : nComp === 4 ? "DeviceCMYK" : "DeviceGray");
    }
    const csName = cs instanceof PDFName ? cs.decodeText() : cs instanceof PDFArray ? (cs.lookup(0) as PDFName)?.decodeText?.() : "";
    if (csName === "DeviceRGB" || csName === "CalRGB") {
      comps = 3;
      toSample = (c) => c.map((x) => Math.round(255 * x));
    } else if (csName === "DeviceCMYK") {
      comps = 4;
      toSample = (c) => {
        const k = 1 - Math.max(...c);
        return k >= 1 ? [0, 0, 0, 255] : [...c.map((x) => Math.round((255 * (1 - x - k)) / (1 - k))), Math.round(255 * k)];
      };
    } else if (csName === "Indexed" && cs instanceof PDFArray) {
      const baseName = cs.lookup(1) instanceof PDFName ? (cs.lookup(1) as PDFName).decodeText() : "";
      const baseComps = baseName === "DeviceRGB" ? 3 : baseName === "DeviceGray" ? 1 : baseName === "DeviceCMYK" ? 4 : 0;
      const lookupObj = cs.lookup(3);
      const table = lookupObj instanceof PDFStream ? streamBytes(lookupObj) : lookupObj instanceof PDFHexString || lookupObj instanceof PDFString ? lookupObj.asBytes() : null;
      if (!baseComps || !table) throw new Unsupported("unusual picture colours");
      toSample = (c) => {
        // The palette entry closest to the colour.
        const target = baseComps === 3 ? c.map((x) => x * 255) : baseComps === 1 ? [255 * (0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2])] : [0, 0, 0, 255 * (1 - Math.max(...c))];
        let best = 0;
        let bestD = Infinity;
        for (let k = 0; k * baseComps < table.length; k++) {
          let d = 0;
          for (let j = 0; j < baseComps; j++) d += (table[k * baseComps + j] - target[j]) ** 2;
          if (d < bestD) [best, bestD] = [k, d];
        }
        return [best];
      };
    } else if (csName !== "DeviceGray" && csName !== "CalGray") {
      throw new Unsupported(`picture colours ${csName}`);
    }
  }

  // Soft mask (transparency): made fully solid under the boxes too, so nothing shows through or hints at shapes.
  const smask = dict.lookup(PDFName.of("SMask"));
  let newSmask: PDFRef | null = null;
  if (smask instanceof PDFStream) {
    newSmask = await paintImage(doc, smask, ctm, areas.map((a) => ({ ...a, color: [1, 1, 1] })));
  }

  const copyDict = (extra: Record<string, PDFObject>, drop: string[]) => {
    const d = ctx.obj({}) as PDFDict;
    for (const [k, v] of dict.entries()) if (!drop.includes(k.decodeText()) && !IMAGE_NOT_COPIED.includes(k.decodeText())) d.set(k, v);
    for (const [k, v] of Object.entries(extra)) d.set(PDFName.of(k), v);
    if (newSmask) d.set(PDFName.of("SMask"), newSmask);
    return d;
  };

  if (f.length === 1 && f[0] === "DCTDecode") {
    if (decodeArr) throw new Unsupported("JPEG with a decode array");
    if (isMask) throw new Unsupported("JPEG mask");
    // Decode the JPEG in the browser, paint, and encode it again.
    const blob = new Blob([(image instanceof PDFRawStream ? image.contents : streamBytes(image)) as BlobPart], { type: "image/jpeg" });
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const g = canvas.getContext("2d")!;
    g.drawImage(bitmap, 0, 0);
    const sx = bitmap.width / width;
    const sy = bitmap.height / height;
    bitmap.close();
    for (const { box, color } of boxes) {
      g.fillStyle = `rgb(${color.map((x) => Math.round(255 * x)).join(",")})`;
      g.fillRect(box.c0 * sx, box.r0 * sy, (box.c1 - box.c0) * sx, (box.r1 - box.r0) * sy);
    }
    const out = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
    canvas.width = canvas.height = 0;
    if (!out) throw new Unsupported("couldn't encode picture");
    const bytes = new Uint8Array(await out.arrayBuffer());
    const d = copyDict({ ColorSpace: PDFName.of("DeviceRGB"), BitsPerComponent: ctx.obj(8), Filter: PDFName.of("DCTDecode") }, ["Length", "DecodeParms", "ColorSpace", "Filter", "Decode", "BitsPerComponent"]);
    return ctx.register(PDFRawStream.of(d, bytes));
  }

  if (f.some((x) => !["FlateDecode", "LZWDecode", "ASCII85Decode", "ASCIIHexDecode", "RunLengthDecode"].includes(x))) {
    throw new Unsupported(`picture format ${f.join("+")}`);
  }
  if (bpc !== 8 && bpc !== 1) throw new Unsupported(`picture with ${bpc}-bit colours`);
  if (bpc === 1 && comps !== 1) throw new Unsupported("1-bit colour picture");
  const params = dict.lookup(PDFName.of("DecodeParms"));
  const paramsDict = params instanceof PDFDict ? params : params instanceof PDFArray ? (params.lookup(params.size() - 1) as PDFDict) : undefined;
  const raw = image instanceof PDFRawStream ? decodePDFRawStream(PDFRawStream.of(image.dict, image.contents)).decode() : streamBytes(image);
  const samples = unpredict(raw, paramsDict instanceof PDFDict ? paramsDict : undefined, comps, bpc, width);
  const rowLen = Math.ceil((width * comps * bpc) / 8);
  if (samples.length < rowLen * height) throw new Unsupported("picture data too short");
  const data = samples.slice(0, rowLen * height);
  for (const { box, color } of boxes) {
    if (bpc === 8) {
      const value = toSample(color);
      for (let r = box.r0; r < box.r1; r++) {
        for (let c = box.c0; c < box.c1; c++) {
          for (let k = 0; k < comps; k++) data[r * rowLen + c * comps + k] = inverted ? 255 - value[k] : value[k];
        }
      }
    } else {
      // 1 bit per pixel. Masks: 1 = not painted (with the usual decode). Others: 0 = black.
      const dark = 0.3 * color[0] + 0.59 * color[1] + 0.11 * color[2] < 0.5;
      let bit = isMask ? 1 : dark ? 0 : 1;
      if (inverted) bit = 1 - bit;
      for (let r = box.r0; r < box.r1; r++) {
        for (let c = box.c0; c < box.c1; c++) {
          const idx = r * rowLen + (c >> 3);
          const mask = 0x80 >> (c & 7);
          data[idx] = bit ? data[idx] | mask : data[idx] & ~mask;
        }
      }
    }
  }
  const d = copyDict({}, ["Length", "Filter", "DecodeParms"]);
  const stream = ctx.flateStream(data);
  for (const [k, v] of d.entries()) stream.dict.set(k, v);
  return ctx.register(stream);
}

// ---------------------------------------------------------------------------
// Drawn shapes: finding the ones that run under a box, and cutting them
// ---------------------------------------------------------------------------

type P = [number, number];

/** One piece of a drawn path (from an "m" or "re" to the next), in the coordinates it was written in. */
interface Subpath {
  start: P;
  /** Straight lines ({ to }) and curves ({ c1, c2, to }). */
  parts: { to: P; c1?: P; c2?: P }[];
  closed: boolean;
  /** Its drawing instructions as written. */
  text: string;
}

/** Splits a path's construction instructions into subpaths. */
function subpaths(ops: Operation[], content: Uint8Array): Subpath[] {
  const subs: Subpath[] = [];
  let cur: Subpath | null = null;
  let at: P = [0, 0];
  const source = (o: Operation) => latin1(content.subarray(o.start, o.end)).trim();
  const begin = (start: P, text: string): Subpath => {
    const s: Subpath = { start, parts: [], closed: false, text };
    subs.push(s);
    return s;
  };
  for (const o of ops) {
    const n = o.args.map(num);
    if (o.op === "m") {
      at = [n[0], n[1]];
      cur = begin(at, source(o));
    } else if (o.op === "re") {
      const [x, y, w, h] = n;
      const s = begin([x, y], source(o));
      s.parts = [{ to: [x + w, y] }, { to: [x + w, y + h] }, { to: [x, y + h] }];
      s.closed = true;
      at = [x, y];
      cur = null;
    } else if (o.op === "h") {
      if (cur) {
        cur.closed = true;
        cur.text += " h";
        at = cur.start;
        cur = null;
      }
    } else {
      // A line or curve without its own "m" starts where the last one ended.
      if (!cur) cur = begin(at, `${fmtExact(at[0])} ${fmtExact(at[1])} m`);
      const part: Subpath["parts"][number] =
        o.op === "l" ? { to: [n[0], n[1]] }
        : o.op === "c" ? { c1: [n[0], n[1]], c2: [n[2], n[3]], to: [n[4], n[5]] }
        : o.op === "v" ? { c1: at, c2: [n[0], n[1]], to: [n[2], n[3]] }
        : { c1: [n[0], n[1]], c2: [n[2], n[3]], to: [n[2], n[3]] };
      cur.parts.push(part);
      cur.text += ` ${source(o)}`;
      at = part.to;
    }
  }
  return subs;
}

/** A number for a drawing instruction, precise enough for cut shapes. */
function fmtExact(x: number): string {
  return Math.abs(x) < 1e-9 ? "0" : String(Math.round(x * 1e6) / 1e6);
}

const strictlyIn = (p: P, b: Box) => p[0] > b.x0 && p[0] < b.x1 && p[1] > b.y0 && p[1] < b.y1;

/** The stretch [t0, t1] of the line a→b that runs inside the box (not just along its edge), or null. */
function lineInside(a: P, b: P, box: Box): [number, number] | null {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  let t0 = 0;
  let t1 = 1;
  for (const [p, q] of [[-dx, a[0] - box.x0], [dx, box.x1 - a[0]], [-dy, a[1] - box.y0], [dy, box.y1 - a[1]]]) {
    if (p === 0) {
      if (q < 0) return null;
    } else if (p < 0) t0 = Math.max(t0, q / p);
    else t1 = Math.min(t1, q / p);
  }
  if (t0 > t1) return null;
  const t = (t0 + t1) / 2;
  return strictlyIn([a[0] + t * dx, a[1] + t * dy], box) ? [t0, t1] : null;
}

/** Whether a curve runs inside the box (halving it until its pieces are clearly in or out; unsure counts as in). */
function curveInside(p0: P, p1: P, p2: P, p3: P, box: Box, depth = 0): boolean {
  const b = bounds([p0, p1, p2, p3]);
  if (b.x1 <= box.x0 || b.x0 >= box.x1 || b.y1 <= box.y0 || b.y0 >= box.y1) return false;
  if (strictlyIn(p0, box) || strictlyIn(p3, box) || depth >= 12) return true;
  const mid = (a: P, c: P): P => [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2];
  const a = mid(p0, p1);
  const m12 = mid(p1, p2);
  const c = mid(p2, p3);
  const d = mid(a, m12);
  const e = mid(m12, c);
  const m = mid(d, e);
  return curveInside(p0, a, d, m, box, depth + 1) || curveInside(m, e, c, p3, box, depth + 1);
}

/** The page area a subpath's points (control points included) span. */
function subpathBounds(s: Subpath, ctm: M): Box {
  const pts: P[] = [s.start];
  for (const p of s.parts) pts.push(p.to, ...(p.c1 && p.c2 ? [p.c1, p.c2] : []));
  return bounds(pts.map((p) => apply(ctm, p[0], p[1])));
}

/**
 * Whether any line or curve of a subpath runs inside one of the boxes.
 * `closing`: count the line back to the start (filled shapes are closed).
 * A filled shape that only surrounds a box (a page background) doesn't run inside it.
 */
function runsInside(s: Subpath, ctm: M, boxes: Box[], closing: boolean): boolean {
  const map = (p: P) => apply(ctm, p[0], p[1]);
  let from = map(s.start);
  if (s.parts.length === 0) return boxes.some((b) => strictlyIn(from, b));
  for (const part of s.parts) {
    const to = map(part.to);
    const hit = part.c1 && part.c2
      ? boxes.some((b) => curveInside(from, map(part.c1!), map(part.c2!), to, b))
      : boxes.some((b) => lineInside(from, to, b));
    if (hit) return true;
    from = to;
  }
  return (closing || s.closed) && boxes.some((b) => lineInside(from, map(s.start), b));
}

/** Whether the matrix keeps rectangles upright (no turning other than by quarter turns). */
function upright(m: M): boolean {
  const tiny = 1e-9 * Math.max(Math.abs(m[0]), Math.abs(m[1]), Math.abs(m[2]), Math.abs(m[3]));
  return (Math.abs(m[1]) <= tiny && Math.abs(m[2]) <= tiny) || (Math.abs(m[0]) <= tiny && Math.abs(m[3]) <= tiny);
}

/** A subpath that is a rectangle with level sides (in its own coordinates): its box and direction (+1/-1, 0 if flat). */
function asRect(s: Subpath): { box: Box; dir: number } | null {
  if (s.parts.some((p) => p.c1)) return null;
  const pts: P[] = [s.start, ...s.parts.map((p) => p.to)];
  if (pts.length === 5 && pts[4][0] === pts[0][0] && pts[4][1] === pts[0][1]) pts.pop();
  if (pts.length !== 4) return null;
  const box = bounds(pts);
  const corner = (p: P) => (p[0] === box.x0 || p[0] === box.x1) && (p[1] === box.y0 || p[1] === box.y1);
  if (!pts.every(corner)) return null;
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const [a, b] = [pts[i], pts[(i + 1) % 4]];
    if (a[0] !== b[0] && a[1] !== b[1]) return null;
    area += a[0] * b[1] - b[0] * a[1];
  }
  const full = (box.x1 - box.x0) * (box.y1 - box.y0);
  if (full === 0) return { box, dir: 0 };
  return Math.abs(Math.abs(area / 2) - full) <= 1e-9 * full ? { box, dir: Math.sign(area) } : null;
}

/** A rectangle with a box cut out: up to four rectangles. */
function minus(r: Box, h: Box): Box[] {
  if (h.x0 >= r.x1 || h.x1 <= r.x0 || h.y0 >= r.y1 || h.y1 <= r.y0) return [r];
  const out: Box[] = [];
  if (h.y0 > r.y0) out.push({ ...r, y1: h.y0 });
  if (h.y1 < r.y1) out.push({ ...r, y0: h.y1 });
  const y0 = Math.max(r.y0, h.y0);
  const y1 = Math.min(r.y1, h.y1);
  if (h.x0 > r.x0) out.push({ x0: r.x0, y0, x1: h.x0, y1 });
  if (h.x1 < r.x1) out.push({ x0: h.x1, y0, x1: r.x1, y1 });
  return out;
}

/**
 * A filled rectangle crossing the boxes, as the rectangles left once the
 * boxes are cut out. They keep the original's direction, so holes in a shape
 * stay holes. Anything else crossing a box can't be cut safely.
 */
function cutRect(s: Subpath, ctm: M, holes: Box[]): string {
  const rect = asRect(s);
  const inv = invert(ctm);
  if (!rect || !inv || !upright(ctm)) throw new Unsupported("a drawn shape partly under a box");
  // Upright, so each box is a rectangle in the shape's own coordinates too.
  const own = holes.map((h) => bounds([apply(inv, h.x0, h.y0), apply(inv, h.x1, h.y0), apply(inv, h.x0, h.y1), apply(inv, h.x1, h.y1)]));
  let pieces = rect.dir === 0 ? [] : [rect.box];
  for (const h of own) pieces = pieces.flatMap((p) => minus(p, h));
  const f = fmtExact;
  return pieces
    .map((p) => (rect.dir > 0 ? `${f(p.x0)} ${f(p.y0)} ${f(p.x1 - p.x0)} ${f(p.y1 - p.y0)} re` : `${f(p.x1)} ${f(p.y0)} ${f(p.x0 - p.x1)} ${f(p.y1 - p.y0)} re`))
    .join(" ");
}

/** Lines crossing a box with more segments than this (a signature, a scribble) aren't cut: the page becomes a picture. */
const MAX_CUT_SEGMENTS = 4;

/**
 * A stroked subpath of straight lines (a rule, an underline, a rectangle's
 * outline) crossing the boxes, with the stretches inside the boxes cut out:
 * the runs left, and how far along the subpath each starts (for dashes).
 */
function cutLines(s: Subpath, ctm: M, holes: Box[]): { text: string; offset: number }[] {
  if (s.parts.some((p) => p.c1)) throw new Unsupported("a curved line partly under a box");
  const pts: P[] = [s.start, ...s.parts.map((p) => p.to)];
  const last = pts[pts.length - 1];
  if (s.closed && (last[0] !== s.start[0] || last[1] !== s.start[1])) pts.push(s.start);
  const segments = pts.length - 1;
  if (segments > MAX_CUT_SEGMENTS) throw new Unsupported("a long line partly under a box");
  const dev = pts.map((p) => apply(ctm, p[0], p[1]));
  const pieces: { seg: number; t0: number; t1: number }[] = [];
  for (let i = 0; i < segments; i++) {
    let keep: [number, number][] = [[0, 1]];
    for (const h of holes) {
      const cut = lineInside(dev[i], dev[i + 1], h);
      if (!cut) continue;
      keep = keep.flatMap(([a, b]): [number, number][] => [[a, Math.min(b, cut[0])], [Math.max(a, cut[1]), b]]).filter(([a, b]) => b - a > 1e-9);
    }
    for (const [t0, t1] of keep) pieces.push({ seg: i, t0, t1 });
  }
  if (pieces.length === segments && pieces.every((p) => p.t0 === 0 && p.t1 === 1)) return [{ text: s.text, offset: 0 }];
  const runs: (typeof pieces)[] = [];
  for (const p of pieces) {
    const run = runs[runs.length - 1];
    const prev = run?.[run.length - 1];
    if (prev && prev.seg === p.seg - 1 && prev.t1 === 1 && p.t0 === 0) run.push(p);
    else runs.push([p]);
  }
  // A closed shape: the last run carries on into the first, keeping the corner between them.
  if (s.closed && runs.length > 1) {
    const first = runs[0][0];
    const end = runs[runs.length - 1][runs[runs.length - 1].length - 1];
    if (first.seg === 0 && first.t0 === 0 && end.seg === segments - 1 && end.t1 === 1) runs[0] = [...runs.pop()!, ...runs[0]];
  }
  const at = (seg: number, t: number): P => [pts[seg][0] + t * (pts[seg + 1][0] - pts[seg][0]), pts[seg][1] + t * (pts[seg + 1][1] - pts[seg][1])];
  const length = (seg: number) => Math.hypot(pts[seg + 1][0] - pts[seg][0], pts[seg + 1][1] - pts[seg][1]);
  return runs.map((run) => {
    const points = [at(run[0].seg, run[0].t0), ...run.map((p) => at(p.seg, p.t1))];
    let offset = run[0].t0 * length(run[0].seg);
    for (let i = 0; i < run[0].seg; i++) offset += length(i);
    return { text: points.map((p, i) => `${fmtExact(p[0])} ${fmtExact(p[1])} ${i ? "l" : "m"}`).join(" "), offset };
  });
}

/** A box's outline as a path in the coordinates of `ctm`. */
function boxOutline(b: Box, ctm: M): string {
  const inv = invert(ctm);
  if (!inv) throw new Unsupported("a squashed drawing under a box");
  const pts = [apply(inv, b.x0, b.y0), apply(inv, b.x1, b.y0), apply(inv, b.x1, b.y1), apply(inv, b.x0, b.y1)];
  return `${pts.map((p, i) => `${fmtExact(p[0])} ${fmtExact(p[1])} ${i ? "l" : "m"}`).join(" ")} h`;
}

const FILLS = new Set(["f", "F", "f*", "B", "B*", "b", "b*"]);
const STROKES = new Set(["S", "s", "B", "B*", "b", "b*"]);
const EVEN_ODD = new Set(["f*", "B*", "b*"]);

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

interface GState {
  ctm: M;
  font: FontInfo | null;
  size: number;
  charSpace: number;
  wordSpace: number;
  scale: number;
  leading: number;
  rise: number;
  render: number;
  /** Line dashes ("[3 2]" and where the pattern starts), or null for solid lines. */
  dash: { array: string; phase: number } | null;
}

/**
 * Removes what lies under `areas` from `page` (see the top of this file).
 * Returns ok: false if the page should be saved as a picture instead (the
 * caller then replaces everything on it, so half-done changes don't matter).
 */
export async function redactPage(doc: PDFDocument, page: PDFPage, areas: Area[]): Promise<RedactResult> {
  if (areas.length === 0) return { ok: true };
  const ctx = doc.context;
  page.node.normalize();
  const job: Job = { doc, areas, holes: areas.map((a) => shrink(a, 0.5)), counter: { n: 0 }, painted: new Map(), checking: false };
  try {
    const content = pageContent(doc, page);
    // This page's own copy of its resource lists (they may be shared with other pages).
    const resources = privateResources(doc, page.node.Resources());
    page.node.set(PDFName.of("Resources"), resources);
    const result = (await redactContent(job, content, resources, initialState(), 0)) ?? content;
    // Even unchanged content is rewritten as one stream, so the page's drawing instructions are a fresh copy.
    const ref = ctx.register(ctx.flateStream(result));
    page.node.set(PDFName.of("Contents"), ctx.obj([ref]));
    removeAnnotations(doc, page, areas);
    dropPageLeftovers(page);
    forgetContentStream(page);
  } catch (error) {
    if (error instanceof Unsupported) return { ok: false, reason: error.message };
    throw error;
  }
  try {
    await checkPage(job, page);
  } catch (error) {
    if (error instanceof Unsupported) return { ok: false, reason: `check: ${error.message}` };
    throw error;
  }
  return { ok: true };
}

/** A page's drawing instructions, all its content streams joined. */
function pageContent(doc: PDFDocument, page: PDFPage): Uint8Array {
  const contents = page.node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray().map((x) => doc.context.lookup(x)) : [contents];
  const parts: Uint8Array[] = [];
  for (const s of streams) if (s instanceof PDFStream) parts.push(streamBytes(s), Uint8Array.of(10));
  return concat(parts);
}

/**
 * Defence in depth: reads the finished page again, from the objects that will
 * be saved, and makes sure nothing is left under a box: no letters, no
 * picture that wasn't painted over there, no shape running inside it, no
 * inline picture, no hidden copy of words, no link or note, no thumbnail or
 * app-private data. It also looks inside soft masks (shapes and text that
 * shade what's drawn after them), which the removal step leaves alone, so a
 * page with one over a box becomes a picture. Throws Unsupported on a find.
 */
async function checkPage(job: Job, page: PDFPage): Promise<void> {
  const ctx = job.doc.context;
  // Cut shapes end exactly at the holes' edges; allow for rounding.
  const check: Job = { ...job, holes: job.holes.map((h) => shrink(h, 0.01)), checking: true };
  await redactContent(check, pageContent(job.doc, page), page.node.Resources() ?? (ctx.obj({}) as PDFDict), initialState(), 0);
  for (const item of page.node.Annots()?.asArray() ?? []) {
    const box = annotationBox(job.doc, ctx.lookup(item));
    if (box && job.areas.some((a) => touches(box, a))) throw new Unsupported("a link or note over a box");
  }
  for (const key of PAGE_LEFTOVERS) if (page.node.has(PDFName.of(key))) throw new Unsupported(`the page's ${key}`);
}

/**
 * Page details that can hold an unredacted copy of the page: a small picture
 * of it (Thumb), app-private data such as Illustrator's copy of the artwork
 * (PieceInfo), and the page's own XMP details (Metadata, which can hold a
 * picture too). None is needed to show the page.
 */
const PAGE_LEFTOVERS = ["Thumb", "PieceInfo", "Metadata"];

function dropPageLeftovers(page: PDFPage): void {
  for (const key of PAGE_LEFTOVERS) page.node.delete(PDFName.of(key));
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A name not yet used in a resource category (for copies of pictures and drawings). */
function freshName(resources: PDFDict, category: string, counter: { n: number }, ctx: PDFDocument["context"]): string {
  let sub = resources.lookup(PDFName.of(category));
  if (!(sub instanceof PDFDict)) {
    sub = ctx.obj({});
    resources.set(PDFName.of(category), sub as PDFDict);
  }
  let name: string;
  do name = `PlainPdfRedacted${++counter.n}`;
  while ((sub as PDFDict).has(PDFName.of(name)));
  return name;
}

function initialState(): GState {
  return { ctm: IDENTITY, font: null, size: 0, charSpace: 0, wordSpace: 0, scale: 1, leading: 0, rise: 0, render: 0, dash: null };
}

/**
 * A copy of a resources dictionary whose picture/drawing list (XObject) and
 * marked-content list (Properties) are copies too, so they can be changed
 * without affecting anything else that shares them.
 */
function privateResources(doc: PDFDocument, resources: PDFDict | undefined): PDFDict {
  const ctx = doc.context;
  const copy = ctx.obj({}) as PDFDict;
  if (!resources) return copy;
  for (const [k, v] of resources.entries()) copy.set(k, v);
  for (const key of ["XObject", "Properties"]) {
    const sub = resources.lookup(PDFName.of(key));
    if (sub instanceof PDFDict) {
      const subCopy = ctx.obj({}) as PDFDict;
      for (const [k, v] of sub.entries()) subCopy.set(k, v);
      copy.set(PDFName.of(key), subCopy);
    }
  }
  const props = copy.lookup(PDFName.of("Properties"));
  if (props instanceof PDFDict) {
    // Marked-content details are edited (hidden text dropped), so copy each one too.
    for (const [k, v] of props.entries()) {
      const d = ctx.lookup(v);
      if (d instanceof PDFDict) {
        const dc = ctx.obj({}) as PDFDict;
        for (const [kk, vv] of d.entries()) dc.set(kk, vv);
        props.set(k, dc);
      }
    }
  }
  return copy;
}

/** Names of pictures and drawings that some "Do" in the content uses. */
function usedXObjects(content: Uint8Array): Set<string> {
  const used = new Set<string>();
  for (const o of parseContent(content)) if (o.op === "Do" && isName(o.args[0])) used.add(o.args[0].name);
  return used;
}

/**
 * A redacted drawing's copy doesn't take its original's app-private data
 * (PieceInfo), XMP details or links to print versions (OPI): they can hold
 * the original artwork.
 */
const FORM_NOT_COPIED = ["Length", "Filter", "DecodeParms", "Resources", "PieceInfo", "Metadata", "OPI"];

/**
 * Removes what lies under the job's areas from some drawing instructions (a
 * page's, or a drawing's inside it). Returns the new instructions, or null if
 * nothing changed. When checking, changes nothing and throws Unsupported at
 * anything it would change.
 */
async function redactContent(job: Job, content: Uint8Array, resources: PDFDict, startState: GState, depth: number): Promise<Uint8Array | null> {
  if (depth > 12) throw new Unsupported("drawings nested too deeply");
  const { doc, areas } = job;
  const ctx = doc.context;
  const ops = parseContent(content);
  const replacements: { start: number; end: number; text: string }[] = [];
  /** Replaces the instructions from `start` to `end`; when checking, that's a find (`found` says what). */
  const change = (start: number, end: number, text: string, found: string) => {
    if (job.checking) throw new Unsupported(found);
    replacements.push({ start, end, text });
  };
  const fonts = new Map<string, FontInfo>();
  const fontsDict = resources.lookup(PDFName.of("Font"));
  const fontNamed = (name: string): FontInfo => {
    if (!fonts.has(name)) {
      const fd = fontsDict instanceof PDFDict ? fontsDict.lookup(PDFName.of(name)) : undefined;
      if (!(fd instanceof PDFDict)) throw new Unsupported(`missing font ${name}`);
      fonts.set(name, readFont(doc, fd));
    }
    return fonts.get(name)!;
  };
  // A drawing inside the page starts from the page's state at that point (including text settings).
  let gs: GState = { ...startState };
  const replacedNames = new Set<string>();
  const stack: GState[] = [];
  let tm: M = IDENTITY;
  let tlm: M = IDENTITY;
  /** The path being built: its instructions, the page points they touch, and "W"/"W*" if it's to clip. */
  let path: { start: number; ops: Operation[]; points: P[]; clip: string | null } | null = null;
  const areaBoxes: Box[] = areas;

  /**
   * A path is painted (or used to clip): subpaths inside a box are taken out,
   * and those running inside a box are cut along it, or the page can't be
   * done. Subpaths that don't run inside any box stay exactly as written.
   */
  const paintPath = (p: NonNullable<typeof path>, o: Operation) => {
    const box = bounds(p.points);
    if (!areaBoxes.some((a) => box.x1 > a.x0 && box.x0 < a.x1 && box.y1 > a.y0 && box.y0 < a.y1)) return;
    const subs = subpaths(p.ops, content);
    if (subs.length === 0) return;
    const fill = FILLS.has(o.op);
    const stroke = STROKES.has(o.op);
    const area = fill || p.clip !== null;
    // "s", "b" and "b*" close the last subpath first.
    const lastSub = subs[subs.length - 1];
    if ((o.op === "s" || o.op === "b" || o.op === "b*") && !lastSub.closed) {
      lastSub.closed = true;
      lastSub.text += " h";
    }
    if (job.checking) {
      if (subs.some((s) => runsInside(s, gs.ctm, job.holes, area))) throw new Unsupported("a drawn shape left under a box");
      return;
    }
    const verdicts = subs.map((s) => {
      const b = subpathBounds(s, gs.ctm);
      if (areaBoxes.some((a) => inside(b, a))) return "drop";
      return runsInside(s, gs.ctm, job.holes, area) ? "cut" : "keep";
    });
    if (verdicts.every((v) => v === "keep")) return;
    const shapes: string[] = [];
    const lines: string[] = [];
    const dashed: { text: string; offset: number }[] = [];
    subs.forEach((s, i) => {
      if (verdicts[i] === "keep") {
        shapes.push(s.text);
        lines.push(s.text);
      } else if (verdicts[i] === "cut") {
        if (area) shapes.push(cutRect(s, gs.ctm, job.holes));
        if (stroke) {
          for (const run of cutLines(s, gs.ctm, job.holes)) {
            if (gs.dash) dashed.push(run);
            else lines.push(run.text);
          }
        }
      }
    });
    // Filling and stroking separately does the same as B/b (fill, then stroke on top).
    const out: string[] = [];
    const shape = shapes.filter(Boolean).join(" ");
    if (fill && shape) out.push(`${shape} ${EVEN_ODD.has(o.op) ? "f*" : "f"}`);
    if (stroke && lines.length) out.push(`${lines.join(" ")} S`);
    // Dashes start afresh at each cut, so each run continues the pattern from where it was.
    for (const run of dashed) out.push(`q ${gs.dash!.array} ${fmtExact(gs.dash!.phase + run.offset)} d ${run.text} S Q`);
    if (p.clip) {
      // Clipping to nothing but what was under the boxes: clip to the boxes instead (their contents are cleared too).
      const clipTo = shape || job.holes.filter((h) => box.x1 > h.x0 && box.x0 < h.x1 && box.y1 > h.y0 && box.y0 < h.y1).map((h) => boxOutline(h, gs.ctm)).join(" ");
      out.push(`${clipTo || boxOutline(job.holes[0], gs.ctm)} ${p.clip} n`);
    }
    change(p.start, o.end, ` ${out.join(" ")} `, "a drawn shape left under a box");
  };

  /** Shows text; returns the replacement TJ text if any letter was under a box. */
  const show = (items: Value[]): string | null => {
    const font = gs.font;
    if (!font) throw new Unsupported("text without a font");
    const th = gs.scale;
    const fs = gs.size;
    let any = false;
    const out: (Uint8Array | number)[] = [];
    let kept: number[] = [];
    const flush = () => {
      if (kept.length) out.push(Uint8Array.from(kept));
      kept = [];
    };
    for (const item of items) {
      if (typeof item === "number") {
        flush();
        out.push(item);
        tm = mul([1, 0, 0, 1, (-item / 1000) * fs * th, 0], tm);
        continue;
      }
      if (!isStr(item)) continue;
      const bytes = item.str;
      const step = font.twoByte ? 2 : 1;
      for (let k = 0; k + step <= bytes.length; k += step) {
        const code = step === 2 ? (bytes[k] << 8) | bytes[k + 1] : bytes[k];
        const w0 = font.width(code);
        const trm = mul([fs * th, 0, 0, fs, 0, gs.rise], mul(tm, gs.ctm));
        const gw = Math.max(w0, 0.1);
        const glyph = bounds([apply(trm, 0, font.descent), apply(trm, gw, font.descent), apply(trm, 0, font.ascent), apply(trm, gw, font.ascent)]);
        const invisible = gs.render === 3 || gs.render === 7;
        const hit = areaBoxes.some((a) => {
          const o = overlap(glyph, a);
          if (invisible) return o.w > 0.2 && o.h > 0.2;
          return o.w >= 0.25 * (glyph.x1 - glyph.x0) && o.h >= 0.25 * (glyph.y1 - glyph.y0) && o.w > 0.1 && o.h > 0.1;
        });
        const space = step === 1 && code === 32 ? gs.wordSpace : 0;
        const advance = (w0 * fs + gs.charSpace + space) * th;
        if (hit) {
          any = true;
          if (Math.abs(fs * th) < 1e-9) throw new Unsupported("zero-size text");
          flush();
          out.push(-(advance * 1000) / (fs * th));
        } else {
          for (let j = 0; j < step; j++) kept.push(bytes[k + j]);
        }
        tm = mul([1, 0, 0, 1, advance, 0], tm);
      }
      flush();
    }
    if (!any) return null;
    // Join neighbouring numbers.
    const merged: (Uint8Array | number)[] = [];
    for (const x of out) {
      const last = merged[merged.length - 1];
      if (typeof x === "number" && typeof last === "number") merged[merged.length - 1] = last + x;
      else merged.push(x);
    }
    return `[${merged.map((x) => (typeof x === "number" ? fmt(x) : hex(x))).join(" ")}] TJ`;
  };

  const xobjects = resources.lookup(PDFName.of("XObject"));
  const properties = resources.lookup(PDFName.of("Properties"));
  /** Set when only the resource lists changed (hidden copies of words dropped from them). */
  let edited = false;

  /**
   * A drawing (form) placed with graphics state `state`: a redacted copy, or
   * null if it's not near a box or nothing in it changes. When checking, it's
   * read through (throwing at anything left) and null is returned.
   */
  const redactForm = async (x: PDFStream, state: GState): Promise<PDFRef | null> => {
    const fm = x.dict.lookup(PDFName.of("Matrix"));
    const matrix = fm instanceof PDFArray ? (fm.asArray().map((v) => (ctx.lookup(v) as PDFNumber)?.asNumber?.() ?? 0) as M) : IDENTITY;
    const ctm = mul(matrix, state.ctm);
    const bb = x.dict.lookup(PDFName.of("BBox"));
    if (bb instanceof PDFArray) {
      const [x0, y0, x1, y1] = bb.asArray().map((v) => (ctx.lookup(v) as PDFNumber)?.asNumber?.() ?? 0);
      const box = bounds([apply(ctm, x0, y0), apply(ctm, x1, y0), apply(ctm, x0, y1), apply(ctm, x1, y1)]);
      if (!areas.some((area) => touches(box, area))) return null;
    }
    const formRes = x.dict.lookup(PDFName.of("Resources"));
    const own = formRes instanceof PDFDict ? formRes : resources;
    const before = streamBytes(x);
    if (job.checking) {
      await redactContent(job, before, own, { ...state, ctm }, depth + 1);
      return null;
    }
    const inner = privateResources(doc, own);
    const after = await redactContent(job, before, inner, { ...state, ctm }, depth + 1);
    if (!after) return null;
    const copy = ctx.flateStream(after);
    for (const [k, v] of x.dict.entries()) if (!FORM_NOT_COPIED.includes(k.decodeText())) copy.dict.set(k, v);
    copy.dict.set(PDFName.of("Resources"), inner);
    return ctx.register(copy);
  };

  for (const o of ops) {
    const a = o.args;
    switch (o.op) {
      case "q":
        stack.push({ ...gs });
        break;
      case "Q":
        if (stack.length) gs = stack.pop()!;
        break;
      case "cm":
        if (a.length >= 6) gs.ctm = mul(a.slice(0, 6).map(num) as M, gs.ctm);
        break;
      case "BT":
        tm = tlm = IDENTITY;
        break;
      case "Tc":
        gs.charSpace = num(a[0]);
        break;
      case "Tw":
        gs.wordSpace = num(a[0]);
        break;
      case "Tz":
        gs.scale = num(a[0]) / 100;
        break;
      case "TL":
        gs.leading = num(a[0]);
        break;
      case "Ts":
        gs.rise = num(a[0]);
        break;
      case "Tr":
        gs.render = num(a[0]);
        break;
      case "Tf":
        if (isName(a[0])) gs.font = fontNamed(a[0].name);
        gs.size = num(a[1]);
        break;
      case "Td":
        tlm = mul([1, 0, 0, 1, num(a[0]), num(a[1])], tlm);
        tm = tlm;
        break;
      case "TD":
        gs.leading = -num(a[1]);
        tlm = mul([1, 0, 0, 1, num(a[0]), num(a[1])], tlm);
        tm = tlm;
        break;
      case "Tm":
        tlm = tm = a.slice(0, 6).map(num) as M;
        break;
      case "T*":
        tlm = mul([1, 0, 0, 1, 0, -gs.leading], tlm);
        tm = tlm;
        break;
      case "Tj":
      case "TJ":
      case "'":
      case '"': {
        let prefix = "";
        let items: Value[];
        if (o.op === "'" || o.op === '"') {
          if (o.op === '"') {
            gs.wordSpace = num(a[0]);
            gs.charSpace = num(a[1]);
            prefix = `${fmt(gs.wordSpace)} Tw ${fmt(gs.charSpace)} Tc `;
          }
          tlm = mul([1, 0, 0, 1, 0, -gs.leading], tlm);
          tm = tlm;
          prefix += "T* ";
          items = [a[a.length - 1]];
        } else if (o.op === "TJ") {
          items = Array.isArray(a[0]) ? a[0] : [];
        } else {
          items = [a[0]];
        }
        const replaced = show(items);
        if (replaced) change(o.start, o.end, ` ${prefix}${replaced} `, "letters left under a box");
        break;
      }
      case "m":
      case "l":
      case "c":
      case "v":
      case "y":
      case "re":
      case "h": {
        if (!path) path = { start: o.start, ops: [], points: [], clip: null };
        path.ops.push(o);
        const nums = a.map(num);
        if (o.op === "re") {
          const [x, y, w, h] = nums;
          for (const [px, py] of [[x, y], [x + w, y], [x, y + h], [x + w, y + h]]) path.points.push(apply(gs.ctm, px, py));
        } else {
          for (let k = 0; k + 1 < nums.length; k += 2) path.points.push(apply(gs.ctm, nums[k], nums[k + 1]));
        }
        break;
      }
      case "W":
      case "W*":
        if (path) path.clip = o.op;
        break;
      case "S":
      case "s":
      case "f":
      case "F":
      case "f*":
      case "B":
      case "B*":
      case "b":
      case "b*":
      case "n": {
        if (path && path.points.length > 0) paintPath(path, o);
        path = null;
        break;
      }
      case "d":
        gs.dash = Array.isArray(a[0]) && a[0].length > 0 ? { array: writeValue(a[0]), phase: num(a[1]) } : null;
        break;
      case "gs": {
        // Only read when checking: a soft mask (a drawing that shades what comes after it) with
        // anything under a box isn't changed by the removal step, so the page becomes a picture.
        if (!job.checking || !isName(a[0])) break;
        const states = resources.lookup(PDFName.of("ExtGState"));
        const state = states instanceof PDFDict ? states.lookup(PDFName.of(a[0].name)) : undefined;
        const mask = state instanceof PDFDict ? state.lookup(PDFName.of("SMask")) : undefined;
        const group = mask instanceof PDFDict ? mask.lookup(PDFName.of("G")) : undefined;
        if (group instanceof PDFStream) await redactForm(group, { ...initialState(), ctm: gs.ctm });
        break;
      }
      case "Do": {
        if (!isName(a[0]) || !(xobjects instanceof PDFDict)) break;
        const ref = xobjects.get(PDFName.of(a[0].name));
        const x = ctx.lookup(ref);
        if (!(x instanceof PDFStream)) break;
        const sub = (x.dict.lookup(PDFName.of("Subtype")) as PDFName | undefined)?.decodeText?.();
        let copy: PDFRef | null = null;
        if (sub === "Image") {
          const box = bounds([apply(gs.ctm, 0, 0), apply(gs.ctm, 1, 0), apply(gs.ctm, 0, 1), apply(gs.ctm, 1, 1)]);
          const hits = areas.filter((area) => touches(box, area));
          if (hits.length === 0) break;
          if (job.checking) {
            // Fine if none of its pixels are under a box, or it's the copy painted for exactly this place.
            const size = (key: string) => (x.dict.lookup(PDFName.of(key)) as PDFNumber | undefined)?.asNumber?.() ?? 0;
            if (pixelBoxes(gs.ctm, size("Width"), size("Height"), hits).length === 0) break;
            const made = ref instanceof PDFRef ? job.painted.get(ref.toString()) : undefined;
            if (!made || !sameMatrix(made.ctm, gs.ctm) || hits.some((h) => !made.areas.includes(h))) throw new Unsupported("a picture left under a box");
            break;
          }
          copy = await paintImage(doc, x, gs.ctm, hits);
          if (copy) job.painted.set(copy.toString(), { ctm: gs.ctm, areas: hits });
        } else if (sub === "Form") {
          copy = await redactForm(x, gs);
        }
        if (!copy) break;
        const name = freshName(resources, "XObject", job.counter, ctx);
        (resources.lookup(PDFName.of("XObject")) as PDFDict).set(PDFName.of(name), copy);
        replacedNames.add(a[0].name);
        change(o.start, o.end, ` ${writeName(name)} Do `, "a drawing left under a box");
        break;
      }
      case "BI": {
        const box = bounds([apply(gs.ctm, 0, 0), apply(gs.ctm, 1, 0), apply(gs.ctm, 0, 1), apply(gs.ctm, 1, 1)]);
        if (areas.some((area) => touches(box, area))) throw new Unsupported("inline picture under a box");
        break;
      }
      case "BDC":
      case "DP": {
        // Hidden copies of the words ("ActualText", "Alt", "E") would survive removal: drop them on this page.
        const props = a[1];
        if (props instanceof Map && HIDDEN_WORDS.some((k) => props.has(k))) {
          const clean = new Map([...props].filter(([k]) => !HIDDEN_WORDS.includes(k)));
          change(o.start, o.end, ` ${writeValue(a[0])} ${writeValue(clean)} ${o.op} `, "a hidden copy of words left on the page");
        } else if (isName(props) && properties instanceof PDFDict) {
          const p = properties.lookup(PDFName.of(props.name));
          if (p instanceof PDFDict && HIDDEN_WORDS.some((k) => p.has(PDFName.of(k)))) {
            if (job.checking) throw new Unsupported("a hidden copy of words left on the page");
            for (const k of HIDDEN_WORDS) p.delete(PDFName.of(k));
            edited = true;
          }
        }
        break;
      }
      default:
        break;
    }
  }

  if (replacements.length === 0) return edited ? content : null;
  replacements.sort((x, y) => x.start - y.start);
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  let at = 0;
  for (const r of replacements) {
    if (r.start < at) continue; // overlaps an earlier change (already removed)
    parts.push(content.subarray(at, r.start), enc.encode(r.text));
    at = r.end;
  }
  parts.push(content.subarray(at));
  const result = concat(parts);
  // Originals that were replaced by painted or cleaned copies are dropped from this
  // (private) list, so they're no longer part of the page and get cleared out of the file.
  if (replacedNames.size > 0) {
    const used = usedXObjects(result);
    const list = resources.lookup(PDFName.of("XObject"));
    if (list instanceof PDFDict) {
      for (const name of replacedNames) {
        if (used.has(name)) continue;
        noteReplaced(doc, list.get(PDFName.of(name)));
        list.delete(PDFName.of(name));
      }
    }
  }
  return result;
}

const HIDDEN_WORDS = ["ActualText", "Alt", "E"];

function sameMatrix(m1: M, m2: M): boolean {
  const scale = Math.max(1, ...m1.map(Math.abs));
  return m1.every((v, k) => Math.abs(v - m2[k]) <= 1e-9 * scale);
}

/** Where a link, note or form field is on the page. */
function annotationBox(doc: PDFDocument, annot: PDFObject | undefined): Box | null {
  const rect = annot instanceof PDFDict ? annot.lookup(PDFName.of("Rect")) : undefined;
  if (!(rect instanceof PDFArray)) return null;
  const r = rect.asArray().map((v) => (doc.context.lookup(v) as PDFNumber)?.asNumber?.() ?? 0);
  return { x0: Math.min(r[0], r[2]), y0: Math.min(r[1], r[3]), x1: Math.max(r[0], r[2]), y1: Math.max(r[1], r[3]) };
}

/** Removes links, notes and form fields that overlap the areas. */
function removeAnnotations(doc: PDFDocument, page: PDFPage, areas: Area[]): void {
  const ctx = doc.context;
  const annots = page.node.Annots();
  if (!annots) return;
  const removed = new Set<PDFDict>();
  const keep: PDFObject[] = [];
  for (const item of annots.asArray()) {
    const annot = ctx.lookup(item);
    if (!(annot instanceof PDFDict)) {
      keep.push(item);
      continue;
    }
    const box = annotationBox(doc, annot);
    if (box && areas.some((a) => touches(box, a))) removed.add(annot);
    else keep.push(item);
  }
  // Pop-up notes of removed annotations go too.
  for (let k = keep.length - 1; k >= 0; k--) {
    const annot = ctx.lookup(keep[k]);
    if (annot instanceof PDFDict && removed.has(annot.lookup(PDFName.of("Parent")) as PDFDict)) {
      removed.add(annot);
      keep.splice(k, 1);
    }
  }
  if (removed.size === 0) return;
  // Form fields: remove the whole field (its answer lives in the field, not just on the page).
  const widgets = [...removed].filter((a) => (a.lookup(PDFName.of("Subtype")) as PDFName | undefined)?.decodeText?.() === "Widget");
  if (widgets.length > 0) {
    const form = doc.getForm();
    for (const field of form.getFields()) {
      if (field.acroField.getWidgets().some((w) => widgets.includes(w.dict))) {
        try {
          form.removeField(field);
        } catch {
          throw new Unsupported("form field under a box couldn't be removed");
        }
      }
    }
  }
  page.node.set(PDFName.of("Annots"), ctx.obj(keep.filter((x) => !removed.has(ctx.lookup(x) as PDFDict))));
}

/**
 * pdf-lib remembers the content stream it last drew into for each page (for
 * example when form answers were locked in). After the page's instructions are
 * replaced, that stream isn't part of the page any more, so it's forgotten and
 * the next drawing starts a new one.
 */
export function forgetContentStream(page: PDFPage): void {
  const p = page as unknown as { contentStream?: unknown; contentStreamRef?: unknown };
  p.contentStream = undefined;
  p.contentStreamRef = undefined;
}

/**
 * Replaces everything on a page with a picture of it (for pages whose content
 * can't be changed safely). `toPdf` maps the page as shown (width × height
 * points, top-left origin) to its PDF coordinates. Links, notes and form
 * fields on the page are removed (the picture shows them as they looked).
 * The page gets a new resource list holding only the picture, so its old
 * pictures, drawings and fonts are no longer part of it and are cleared out
 * of the file (unless another page draws them).
 */
export async function replaceWithPicture(doc: PDFDocument, page: PDFPage, toPdf: M, picture: { jpeg: Uint8Array; width: number; height: number }): Promise<void> {
  const ctx = doc.context;
  page.node.normalize();
  const old = page.node.Resources();
  if (old) noteListed(doc, old, new Set());
  const image = await doc.embedJpg(picture.jpeg);
  // Font and ExtGState stay as (empty) lists: pdf-lib adds the additions' fonts and highlighter setting to them.
  page.node.set(PDFName.of("Resources"), ctx.obj({ XObject: { PlainPdfPagePicture: image.ref }, Font: {}, ExtGState: {} }));
  const m = mul([picture.width, 0, 0, -picture.height, 0, picture.height], toPdf);
  const content = `q ${m.map(fmt).join(" ")} cm /PlainPdfPagePicture Do Q`;
  page.node.set(PDFName.of("Contents"), ctx.obj([ctx.register(ctx.flateStream(content))]));
  const annots = page.node.Annots();
  if (annots) {
    const all = annots.asArray().map((a) => ctx.lookup(a)).filter((a): a is PDFDict => a instanceof PDFDict);
    const widgets = all.filter((a) => (a.lookup(PDFName.of("Subtype")) as PDFName | undefined)?.decodeText?.() === "Widget");
    if (widgets.length > 0) {
      const form = doc.getForm();
      for (const field of form.getFields()) {
        if (field.acroField.getWidgets().some((w) => widgets.includes(w.dict))) form.removeField(field);
      }
    }
    page.node.set(PDFName.of("Annots"), ctx.obj([]));
  }
  dropPageLeftovers(page);
  forgetContentStream(page);
}

// ---------------------------------------------------------------------------
// The file: clearing out what redacted pages no longer use
// ---------------------------------------------------------------------------

/** Per file: pictures and drawings (object numbers) that redacted pages stopped using. */
const replacedOriginals = new WeakMap<PDFDocument, Set<string>>();

function noteReplaced(doc: PDFDocument, ref: PDFObject | undefined): void {
  if (!(ref instanceof PDFRef)) return;
  let set = replacedOriginals.get(doc);
  if (!set) replacedOriginals.set(doc, (set = new Set()));
  set.add(ref.toString());
}

/** Notes every picture and drawing a resource list names, and those inside the drawings. */
function noteListed(doc: PDFDocument, resources: PDFDict, seen: Set<string>): void {
  const list = resources.lookup(PDFName.of("XObject"));
  if (!(list instanceof PDFDict)) return;
  for (const [, ref] of list.entries()) {
    if (!(ref instanceof PDFRef) || seen.has(ref.toString())) continue;
    seen.add(ref.toString());
    noteReplaced(doc, ref);
    const x = doc.context.lookup(ref);
    const inner = x instanceof PDFStream ? x.dict.lookup(PDFName.of("Resources")) : undefined;
    if (inner instanceof PDFDict) noteListed(doc, inner, seen);
  }
}

/**
 * After redacting: removes from the file whatever the redacted pages no
 * longer use, so it can't be recovered from the saved copy.
 */
export function clearOutLeftovers(doc: PDFDocument): void {
  pinInheritedResources(doc);
  dropReplacedFromLists(doc);
  dropXmpThumbnails(doc);
  removeUnreachable(doc);
}

/**
 * Resource lists can be set once for many pages, on the page tree. Each page
 * is given its own reference to the list it inherits, and the tree's copy is
 * removed, so a list only a redacted page used isn't kept alive by the tree.
 */
function pinInheritedResources(doc: PDFDocument): void {
  const key = PDFName.of("Resources");
  const root = doc.catalog.Pages();
  const inner: PDFPageTree[] = [root];
  let understood = true;
  root.traverse((node) => {
    if (node instanceof PDFPageTree) inner.push(node);
    else if (node instanceof PDFPageLeaf) {
      const inherited = node.get(key) ? undefined : node.getInheritableAttribute(key);
      if (inherited) node.set(key, inherited);
    } else understood = false;
  });
  // A node that's neither a page nor a group of pages (a damaged file) might still inherit: leave the tree as it is.
  if (understood) for (const node of inner) node.delete(key);
}

/**
 * Some apps put every picture in the file on every page's resource list.
 * A picture or drawing a redacted page replaced would then stay in the file
 * through other pages' lists, so it's taken off the lists of pages that
 * don't draw it themselves.
 */
function dropReplacedFromLists(doc: PDFDocument): void {
  const replaced = replacedOriginals.get(doc);
  if (!replaced?.size) return;
  const ctx = doc.context;
  for (const page of doc.getPages()) {
    const resources = page.node.Resources();
    const list = resources?.lookup(PDFName.of("XObject"));
    if (!resources || !(list instanceof PDFDict)) continue;
    const listed = list.entries().filter(([, v]) => v instanceof PDFRef && replaced.has(v.toString())).map(([k]) => k);
    if (listed.length === 0) continue;
    const drawn = drawnXObjects(doc, page, resources);
    // Instructions that can't be read: leave the page as it is rather than risk breaking it.
    if (!drawn) continue;
    const unused = listed.filter((k) => !drawn.has(k.decodeText()));
    if (unused.length === 0) continue;
    const listCopy = ctx.obj({}) as PDFDict;
    for (const [k, v] of list.entries()) if (!unused.includes(k)) listCopy.set(k, v);
    const copy = ctx.obj({}) as PDFDict;
    for (const [k, v] of resources.entries()) copy.set(k, v);
    copy.set(PDFName.of("XObject"), listCopy);
    page.node.set(PDFName.of("Resources"), copy);
  }
}

/**
 * The names of pictures and drawings a page draws, including through
 * drawings (and soft masks) that use the page's own lists, or null if its
 * instructions can't be read.
 */
function drawnXObjects(doc: PDFDocument, page: PDFPage, resources: PDFDict): Set<string> | null {
  const names = new Set<string>();
  const seen = new Set<PDFObject>();
  const list = resources.lookup(PDFName.of("XObject"));
  const states = resources.lookup(PDFName.of("ExtGState"));
  const fonts = resources.lookup(PDFName.of("Font"));
  const walk = (content: Uint8Array, depth: number): void => {
    if (depth > 12) throw new Unsupported("drawings nested too deeply");
    for (const o of parseContent(content)) {
      let inner: PDFObject | undefined;
      if (o.op === "Tf" && isName(o.args[0]) && fonts instanceof PDFDict) {
        // A Type 3 font without its own lists draws its letters with the page's: can't tell what those use.
        const font = fonts.lookup(PDFName.of(o.args[0].name));
        const type3 = font instanceof PDFDict && (font.lookup(PDFName.of("Subtype")) as PDFName | undefined)?.decodeText?.() === "Type3";
        if (type3 && !(font.lookup(PDFName.of("Resources")) instanceof PDFDict)) throw new Unsupported("Type 3 font using the page's lists");
      } else if (o.op === "Do" && isName(o.args[0])) {
        names.add(o.args[0].name);
        inner = list instanceof PDFDict ? list.lookup(PDFName.of(o.args[0].name)) : undefined;
      } else if (o.op === "gs" && isName(o.args[0]) && states instanceof PDFDict) {
        const state = states.lookup(PDFName.of(o.args[0].name));
        const mask = state instanceof PDFDict ? state.lookup(PDFName.of("SMask")) : undefined;
        inner = mask instanceof PDFDict ? mask.lookup(PDFName.of("G")) : undefined;
      }
      if (!(inner instanceof PDFStream) || seen.has(inner) || inner.dict.lookup(PDFName.of("Resources")) instanceof PDFDict) continue;
      if ((inner.dict.lookup(PDFName.of("Subtype")) as PDFName | undefined)?.decodeText?.() !== "Form") continue;
      seen.add(inner);
      walk(streamBytes(inner), depth + 1);
    }
  };
  try {
    walk(pageContent(doc, page), 0);
    return names;
  } catch {
    return null;
  }
}

/**
 * Illustrator, InDesign and other apps keep a small picture of the first
 * page in the file's XMP details. It's removed (or, if that can't be done
 * cleanly, the XMP details are).
 */
function dropXmpThumbnails(doc: PDFDocument): void {
  const key = PDFName.of("Metadata");
  const xmp = doc.catalog.lookup(key);
  if (!(xmp instanceof PDFStream)) return;
  let text: string;
  try {
    text = latin1(streamBytes(xmp));
  } catch {
    doc.catalog.delete(key);
    return;
  }
  if (!/:Thumbnails\b|GImg:image/.test(text)) return;
  const cleaned = text.replace(/<(\w+):Thumbnails\b[\s\S]*?<\/\1:Thumbnails>/g, "").replace(/<\w+:Thumbnails\b[^>]*\/>/g, "");
  if (/:Thumbnails\b|GImg:image/.test(cleaned)) {
    doc.catalog.delete(key);
    return;
  }
  const bytes = Uint8Array.from(cleaned, (c) => c.charCodeAt(0));
  doc.catalog.set(key, doc.context.register(doc.context.stream(bytes, { Type: "Metadata", Subtype: "XML" })));
}

/**
 * Deletes every object nothing refers to any more. pdf-lib writes all objects
 * it knows into a saved file, so without this the page's old drawing
 * instructions and the original, unpainted pictures would still be inside
 * the file (unseen, but recoverable).
 */
function removeUnreachable(doc: PDFDocument): void {
  const ctx = doc.context;
  const seen = new Set<string>();
  const visit = (obj: PDFObject | undefined): void => {
    if (!obj) return;
    if (obj instanceof PDFRef) {
      const key = obj.toString();
      if (seen.has(key)) return;
      seen.add(key);
      visit(ctx.lookup(obj));
    } else if (obj instanceof PDFDict) {
      for (const [, v] of obj.entries()) visit(v);
    } else if (obj instanceof PDFArray) {
      for (const v of obj.asArray()) visit(v);
    } else if (obj instanceof PDFStream) {
      visit(obj.dict);
    }
  };
  const { Root, Info, Encrypt } = ctx.trailerInfo;
  visit(Root);
  visit(Info);
  visit(Encrypt);
  for (const [ref] of ctx.enumerateIndirectObjects()) {
    if (!seen.has(ref.toString())) ctx.delete(ref);
  }
}
