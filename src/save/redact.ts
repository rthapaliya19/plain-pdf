/**
 * Redaction: permanently removes what lies under redaction boxes (and under
 * the patches of edited text) from a page, before the boxes themselves are
 * drawn on top:
 * - text: each letter under a box is taken out of the page's drawing
 *   instructions, and the rest of the line stays exactly where it was;
 * - pictures: the pixels under a box are painted over (in the box's colour);
 * - drawn shapes lying inside a box are taken out;
 * - links, notes and form fields over a box are removed;
 * - hidden "ActualText" copies of words on the page are dropped.
 * Pictures and drawings that other pages also use are copied first, so the
 * other pages aren't affected. When something can't be handled safely (an
 * unusual font or picture format), the page is reported as needing to be
 * saved as a picture instead, which the caller does.
 */
import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
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
    for (const [k, v] of dict.entries()) if (!drop.includes(k.decodeText())) d.set(k, v);
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
    bitmap.close();
    const sx = bitmap.width / width;
    const sy = bitmap.height / height;
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
}

/**
 * Removes what lies under `areas` from `page` (see the top of this file).
 * Returns ok: false (changing nothing that matters) if the page should be saved as a picture instead.
 */
export async function redactPage(doc: PDFDocument, page: PDFPage, areas: Area[]): Promise<RedactResult> {
  if (areas.length === 0) return { ok: true };
  const ctx = doc.context;
  page.node.normalize();
  try {
    const contents = page.node.Contents();
    const streams = contents instanceof PDFArray ? contents.asArray().map((x) => ctx.lookup(x)) : [contents];
    const parts: Uint8Array[] = [];
    for (const s of streams) if (s instanceof PDFStream) parts.push(streamBytes(s), Uint8Array.of(10));
    const content = concat(parts);
    const resources = page.node.Resources() ?? (ctx.obj({}) as PDFDict);
    const counter = { n: 0 };
    const result = await redactContent(doc, content, resources, IDENTITY, areas, counter, 0);
    // Even unchanged content is rewritten as one stream, so the page's drawing instructions are a fresh copy.
    const ref = ctx.register(ctx.flateStream(result));
    page.node.set(PDFName.of("Contents"), ctx.obj([ref]));
    removeAnnotations(doc, page, areas);
    forgetContentStream(page);
    return { ok: true };
  } catch (error) {
    if (error instanceof Unsupported) return { ok: false, reason: error.message };
    throw error;
  }
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

async function redactContent(
  doc: PDFDocument,
  content: Uint8Array,
  resources: PDFDict,
  startCtm: M,
  areas: Area[],
  counter: { n: number },
  depth: number,
): Promise<Uint8Array> {
  if (depth > 12) throw new Unsupported("drawings nested too deeply");
  const ctx = doc.context;
  const ops = parseContent(content);
  const replacements: { start: number; end: number; text: string }[] = [];
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
  let gs: GState = { ctm: startCtm, font: null, size: 0, charSpace: 0, wordSpace: 0, scale: 1, leading: 0, rise: 0, render: 0 };
  const stack: GState[] = [];
  let tm: M = IDENTITY;
  let tlm: M = IDENTITY;
  let path: { start: number; points: [number, number][]; clip: boolean } | null = null;
  const areaBoxes: Box[] = areas;

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
        if (replaced) replacements.push({ start: o.start, end: o.end, text: ` ${prefix}${replaced} ` });
        break;
      }
      case "m":
      case "l":
      case "c":
      case "v":
      case "y":
      case "re": {
        if (!path) path = { start: o.start, points: [], clip: false };
        const nums = a.map(num);
        if (o.op === "re") {
          const [x, y, w, h] = nums;
          for (const [px, py] of [[x, y], [x + w, y], [x, y + h], [x + w, y + h]]) path.points.push(apply(gs.ctm, px, py));
        } else {
          for (let k = 0; k + 1 < nums.length; k += 2) path.points.push(apply(gs.ctm, nums[k], nums[k + 1]));
        }
        break;
      }
      case "h":
        break;
      case "W":
      case "W*":
        if (path) path.clip = true;
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
        if (path && o.op !== "n" && !path.clip && path.points.length > 0) {
          const box = bounds(path.points);
          if (areaBoxes.some((area) => inside(box, area))) replacements.push({ start: path.start, end: o.end, text: " " });
        }
        path = null;
        break;
      }
      case "Do": {
        if (!isName(a[0]) || !(xobjects instanceof PDFDict)) break;
        const ref = xobjects.get(PDFName.of(a[0].name));
        const x = ctx.lookup(ref);
        if (!(x instanceof PDFStream)) break;
        const sub = (x.dict.lookup(PDFName.of("Subtype")) as PDFName | undefined)?.decodeText?.();
        if (sub === "Image") {
          const box = bounds([apply(gs.ctm, 0, 0), apply(gs.ctm, 1, 0), apply(gs.ctm, 0, 1), apply(gs.ctm, 1, 1)]);
          const hits = areas.filter((area) => touches(box, area));
          if (hits.length === 0) break;
          const copy = await paintImage(doc, x, gs.ctm, hits);
          if (!copy) break;
          const name = freshName(resources, "XObject", counter, ctx);
          (resources.lookup(PDFName.of("XObject")) as PDFDict).set(PDFName.of(name), copy);
          replacements.push({ start: o.start, end: o.end, text: ` ${writeName(name)} Do ` });
        } else if (sub === "Form") {
          const fm = x.dict.lookup(PDFName.of("Matrix"));
          const matrix = fm instanceof PDFArray ? (fm.asArray().map((v) => (ctx.lookup(v) as PDFNumber)?.asNumber?.() ?? 0) as M) : IDENTITY;
          const ctm = mul(matrix, gs.ctm);
          const bb = x.dict.lookup(PDFName.of("BBox"));
          if (bb instanceof PDFArray) {
            const [x0, y0, x1, y1] = bb.asArray().map((v) => (ctx.lookup(v) as PDFNumber)?.asNumber?.() ?? 0);
            const box = bounds([apply(ctm, x0, y0), apply(ctm, x1, y0), apply(ctm, x0, y1), apply(ctm, x1, y1)]);
            if (!areas.some((area) => touches(box, area))) break;
          }
          const formRes = x.dict.lookup(PDFName.of("Resources"));
          const inner = formRes instanceof PDFDict ? formRes : resources;
          const before = streamBytes(x);
          const after = await redactContent(doc, before, inner, ctm, areas, counter, depth + 1);
          if (sameBytes(before, after)) break;
          const d = ctx.obj({}) as PDFDict;
          for (const [k, v] of x.dict.entries()) if (!["Length", "Filter", "DecodeParms"].includes(k.decodeText())) d.set(k, v);
          const copy = ctx.flateStream(after);
          for (const [k, v] of d.entries()) copy.dict.set(k, v);
          const name = freshName(resources, "XObject", counter, ctx);
          (resources.lookup(PDFName.of("XObject")) as PDFDict).set(PDFName.of(name), ctx.register(copy));
          replacements.push({ start: o.start, end: o.end, text: ` ${writeName(name)} Do ` });
        }
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
        if (props instanceof Map && (props.has("ActualText") || props.has("Alt") || props.has("E"))) {
          const clean = new Map([...props].filter(([k]) => k !== "ActualText" && k !== "Alt" && k !== "E"));
          replacements.push({ start: o.start, end: o.end, text: ` ${writeValue(a[0])} ${writeValue(clean)} ${o.op} ` });
        } else if (isName(props) && properties instanceof PDFDict) {
          const p = properties.lookup(PDFName.of(props.name));
          if (p instanceof PDFDict) for (const k of ["ActualText", "Alt", "E"]) p.delete(PDFName.of(k));
        }
        break;
      }
      default:
        break;
    }
  }

  if (replacements.length === 0) return content;
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
  return concat(parts);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return false;
  return true;
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
    const rect = annot.lookup(PDFName.of("Rect"));
    const r = rect instanceof PDFArray ? rect.asArray().map((v) => (ctx.lookup(v) as PDFNumber)?.asNumber?.() ?? 0) : null;
    const box = r ? { x0: Math.min(r[0], r[2]), y0: Math.min(r[1], r[3]), x1: Math.max(r[0], r[2]), y1: Math.max(r[1], r[3]) } : null;
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
 */
export async function replaceWithPicture(doc: PDFDocument, page: PDFPage, toPdf: M, picture: { jpeg: Uint8Array; width: number; height: number }): Promise<void> {
  const ctx = doc.context;
  page.node.normalize();
  const image = await doc.embedJpg(picture.jpeg);
  const name = page.node.newXObject("PlainPdfPagePicture", image.ref);
  const m = mul([picture.width, 0, 0, -picture.height, 0, picture.height], toPdf);
  const content = `q ${m.map(fmt).join(" ")} cm ${writeName(name.decodeText())} Do Q`;
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
  forgetContentStream(page);
}


/**
 * Deletes every object nothing refers to any more. pdf-lib writes all objects
 * it knows into a saved file, so without this the page's old drawing
 * instructions and the original, unpainted pictures would still be inside
 * the file (unseen, but recoverable).
 */
export function removeUnreachable(doc: PDFDocument): void {
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
