/**
 * Redaction: permanently removes what lies under redaction boxes (and under
 * the patches of edited text) from a page, before the boxes themselves are
 * drawn on top:
 * - text: each letter under a box is taken out of the page's drawing
 *   instructions, and the rest of the line stays exactly where it was;
 * - pictures: the pixels under a box are painted over (in the box's colour);
 * - drawn shapes: those inside a box are taken out, and straight lines and
 *   rectangles crossing a box are cut where they meet it;
 * - links, notes and form fields over a box are removed;
 * - hidden "ActualText" copies of words on the page are dropped, and so are
 *   stored copies of the page (its thumbnail, and apps' private data).
 * Pictures and drawings that other pages also use are copied first, so the
 * other pages aren't affected. The result is then read back and checked.
 * When something can't be handled safely (an unusual font or picture format,
 * a curve crossing a box), or the check finds anything left under a box, the
 * page is reported as needing to be saved as a picture instead, which the
 * caller does (replaceWithPicture). At the end, finishRedaction clears
 * everything the redacted pages no longer use out of the file.
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
// Following the drawing state through the instructions
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
  dash: number[];
  dashPhase: number;
}

function initialState(): GState {
  return { ctm: IDENTITY, font: null, size: 0, charSpace: 0, wordSpace: 0, scale: 1, leading: 0, rise: 0, render: 0, dash: [], dashPhase: 0 };
}

type P = [number, number];
/** One piece of an outline, in the shape's own coordinates: a straight line to pts[0], or a curve (pts: two control points, then the end). */
interface Seg {
  curve: boolean;
  pts: P[];
}
interface Subpath {
  start: P;
  segs: Seg[];
  closed: boolean;
  /** Set for outlines drawn with "re" (x, y, width, height). */
  rect?: [number, number, number, number];
}
/** A shape being built: its outlines, where its instructions start, its transform, and whether it also clips. */
interface Shape {
  start: number;
  ctm: M;
  subs: Subpath[];
  cur: P;
  clip: "W" | "W*" | null;
}
/** One letter shown on the page. */
interface Glyph {
  bytes: number[];
  box: Box;
  advance: number;
  invisible: boolean;
}

/** Follows the graphics state, the text position and the shape being built through a stream's operations. */
class Tracker {
  gs: GState;
  /** The shape built so far; whoever handles the painting operation takes it (sets this to null). */
  shape: Shape | null = null;
  private stack: GState[] = [];
  private tm: M = IDENTITY;
  private tlm: M = IDENTITY;

  constructor(
    start: GState,
    private fontNamed: (name: string) => FontInfo,
  ) {
    this.gs = { ...start };
  }

  /** Updates the state for an operation (for ' and ", the move to the next line that comes before the words). */
  update(o: Operation): void {
    const a = o.args;
    const gs = this.gs;
    switch (o.op) {
      case "q":
        this.stack.push({ ...gs });
        break;
      case "Q":
        if (this.stack.length) this.gs = this.stack.pop()!;
        break;
      case "cm":
        if (a.length >= 6) gs.ctm = mul(a.slice(0, 6).map(num) as M, gs.ctm);
        break;
      case "d":
        gs.dash = Array.isArray(a[0]) ? a[0].map(num) : [];
        gs.dashPhase = num(a[1]);
        break;
      case "BT":
        this.tm = this.tlm = IDENTITY;
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
        if (isName(a[0])) gs.font = this.fontNamed(a[0].name);
        gs.size = num(a[1]);
        break;
      case "Td":
        this.tlm = mul([1, 0, 0, 1, num(a[0]), num(a[1])], this.tlm);
        this.tm = this.tlm;
        break;
      case "TD":
        gs.leading = -num(a[1]);
        this.tlm = mul([1, 0, 0, 1, num(a[0]), num(a[1])], this.tlm);
        this.tm = this.tlm;
        break;
      case "Tm":
        this.tlm = this.tm = a.slice(0, 6).map(num) as M;
        break;
      case "T*":
      case "'":
        this.nextLine();
        break;
      case '"':
        gs.wordSpace = num(a[0]);
        gs.charSpace = num(a[1]);
        this.nextLine();
        break;
      case "m":
      case "l":
      case "c":
      case "v":
      case "y":
      case "re":
      case "h":
        this.build(o);
        break;
      case "W":
      case "W*":
        if (this.shape) this.shape.clip = o.op;
        break;
      default:
        break;
    }
  }

  private nextLine(): void {
    this.tlm = mul([1, 0, 0, 1, 0, -this.gs.leading], this.tlm);
    this.tm = this.tlm;
  }

  private build(o: Operation): void {
    const n = (k: number) => num(o.args[k]);
    if (!this.shape) this.shape = { start: o.start, ctm: this.gs.ctm, subs: [], cur: [0, 0], clip: null };
    const s = this.shape;
    // A line or curve after a closed outline (or with no "m" first) starts a new outline at the current point.
    const open = (): Subpath => {
      const last = s.subs[s.subs.length - 1];
      if (last && !last.closed) return last;
      const sub: Subpath = { start: s.cur, segs: [], closed: false };
      s.subs.push(sub);
      return sub;
    };
    switch (o.op) {
      case "m":
        s.cur = [n(0), n(1)];
        s.subs.push({ start: s.cur, segs: [], closed: false });
        break;
      case "l":
        open().segs.push({ curve: false, pts: [[n(0), n(1)]] });
        s.cur = [n(0), n(1)];
        break;
      case "c":
        open().segs.push({ curve: true, pts: [[n(0), n(1)], [n(2), n(3)], [n(4), n(5)]] });
        s.cur = [n(4), n(5)];
        break;
      case "v": {
        const from = s.cur;
        open().segs.push({ curve: true, pts: [from, [n(0), n(1)], [n(2), n(3)]] });
        s.cur = [n(2), n(3)];
        break;
      }
      case "y":
        open().segs.push({ curve: true, pts: [[n(0), n(1)], [n(2), n(3)], [n(2), n(3)]] });
        s.cur = [n(2), n(3)];
        break;
      case "re": {
        const [x, y, w, h] = [n(0), n(1), n(2), n(3)];
        const corners: P[] = [[x + w, y], [x + w, y + h], [x, y + h]];
        s.subs.push({ start: [x, y], segs: corners.map((p) => ({ curve: false, pts: [p] })), closed: true, rect: [x, y, w, h] });
        s.cur = [x, y];
        break;
      }
      case "h": {
        const last = s.subs[s.subs.length - 1];
        if (last && !last.closed) {
          last.closed = true;
          s.cur = last.start;
        }
        break;
      }
    }
  }

  /** Walks the letters of a text-showing operation, moving along the line; TJ's spacing numbers go to onNumber. */
  show(items: Value[], onGlyph: (g: Glyph) => void, onNumber: (n: number) => void = () => {}): void {
    const font = this.gs.font;
    if (!font) throw new Unsupported("text without a font");
    const th = this.gs.scale;
    const fs = this.gs.size;
    for (const item of items) {
      if (typeof item === "number") {
        onNumber(item);
        this.tm = mul([1, 0, 0, 1, (-item / 1000) * fs * th, 0], this.tm);
        continue;
      }
      if (!isStr(item)) continue;
      const bytes = item.str;
      const step = font.twoByte ? 2 : 1;
      for (let k = 0; k + step <= bytes.length; k += step) {
        const code = step === 2 ? (bytes[k] << 8) | bytes[k + 1] : bytes[k];
        const w0 = font.width(code);
        const trm = mul([fs * th, 0, 0, fs, 0, this.gs.rise], mul(this.tm, this.gs.ctm));
        const gw = Math.max(w0, 0.1);
        const box = bounds([apply(trm, 0, font.descent), apply(trm, gw, font.descent), apply(trm, 0, font.ascent), apply(trm, gw, font.ascent)]);
        const space = step === 1 && code === 32 ? this.gs.wordSpace : 0;
        const advance = (w0 * fs + this.gs.charSpace + space) * th;
        onGlyph({ bytes: Array.from(bytes.subarray(k, k + step)), box, advance, invisible: this.gs.render === 3 || this.gs.render === 7 });
        this.tm = mul([1, 0, 0, 1, advance, 0], this.tm);
      }
    }
  }
}

/** The strings (and TJ spacing) a text-showing operation shows. */
function textItems(o: Operation): Value[] {
  if (o.op === "TJ") return Array.isArray(o.args[0]) ? o.args[0] : [];
  if (o.op === "Tj") return [o.args[0]];
  return [o.args[o.args.length - 1]];
}

/** Whether a letter counts as under a box (invisible letters, such as OCR text on scans, at the slightest touch). */
function glyphHit(g: Glyph, areas: Box[]): boolean {
  return areas.some((a) => {
    const o = overlap(g.box, a);
    if (g.invisible) return o.w > 0.2 && o.h > 0.2;
    return o.w >= 0.25 * (g.box.x1 - g.box.x0) && o.h >= 0.25 * (g.box.y1 - g.box.y0) && o.w > 0.1 && o.h > 0.1;
  });
}

/** Reads (once each) the fonts a resource list names. */
function fontLookup(doc: PDFDocument, resources: PDFDict): (name: string) => FontInfo {
  const fonts = new Map<string, FontInfo>();
  const dict = resources.lookup(PDFName.of("Font"));
  return (name) => {
    if (!fonts.has(name)) {
      const fd = dict instanceof PDFDict ? dict.lookup(PDFName.of(name)) : undefined;
      if (!(fd instanceof PDFDict)) throw new Unsupported(`missing font ${name}`);
      fonts.set(name, readFont(doc, fd));
    }
    return fonts.get(name)!;
  };
}

// ---------------------------------------------------------------------------
// Shapes: whatever part lies under a box is cut away
// ---------------------------------------------------------------------------
//
// An outline lying inside a box is dropped. One that only crosses a box is cut, so none of its
// coordinates under the box remain: straight lines are shortened to where they meet the box, and
// filled rectangles are split into the rectangles around it (exactly the same look outside the box).
// Curves crossing a box, and filled shapes that aren't rectangles, can't be cut this simply, so the
// page is then saved as a picture. Shapes whose edges never come under a box (a page-sized
// background, say) stay as they are: under the box they're one plain colour, which tells nothing.

/** How far (in points) an edge must reach into a box to count as under it. Cuts are made this far inside the box. */
const EPS = 0.01;

const PAINT: Record<string, { fill: "f" | "f*" | null; stroke: boolean; close: boolean }> = {
  S: { fill: null, stroke: true, close: false },
  s: { fill: null, stroke: true, close: true },
  f: { fill: "f", stroke: false, close: false },
  F: { fill: "f", stroke: false, close: false },
  "f*": { fill: "f*", stroke: false, close: false },
  B: { fill: "f", stroke: true, close: false },
  "B*": { fill: "f*", stroke: true, close: false },
  b: { fill: "f", stroke: true, close: true },
  "b*": { fill: "f*", stroke: true, close: true },
  n: { fill: null, stroke: false, close: false },
};

/** Whether two boxes meet at all (sharing an edge or a corner counts). */
function touchesAtAll(a: Box, b: Box): boolean {
  const o = overlap(a, b);
  return o.w >= 0 && o.h >= 0;
}

function shrink(a: Box, d: number): Box {
  return { x0: a.x0 + d, y0: a.y0 + d, x1: a.x1 - d, y1: a.y1 - d };
}
const endOf = (s: Seg): P => s.pts[s.pts.length - 1];
const lerp = (p: P, q: P, t: number): P => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];

/** The pieces of an outline, each with where it starts; with `close`, the line back to the start too. */
function edges(sub: Subpath, close: boolean): { from: P; seg: Seg }[] {
  const out: { from: P; seg: Seg }[] = [];
  let from = sub.start;
  for (const seg of sub.segs) {
    out.push({ from, seg });
    from = endOf(seg);
  }
  if (close && (from[0] !== sub.start[0] || from[1] !== sub.start[1])) out.push({ from, seg: { curve: false, pts: [sub.start] } });
  return out;
}

/** The part (from t0 to t1, 0 to 1 along it) of the line p→q inside box a, if any. */
function lineInside(p: P, q: P, a: Box): [number, number] | null {
  let t0 = 0;
  let t1 = 1;
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  const sides: [number, number][] = [[-dx, p[0] - a.x0], [dx, a.x1 - p[0]], [-dy, p[1] - a.y0], [dy, a.y1 - p[1]]];
  for (const [pp, qq] of sides) {
    if (pp === 0) {
      if (qq < 0) return null;
    } else if (pp < 0) t0 = Math.max(t0, qq / pp);
    else t1 = Math.min(t1, qq / pp);
  }
  return t1 > t0 ? [t0, t1] : null;
}

function splitCurve([p0, p1, p2, p3]: P[]): [P[], P[]] {
  const a = lerp(p0, p1, 0.5);
  const b = lerp(p1, p2, 0.5);
  const c = lerp(p2, p3, 0.5);
  const d = lerp(a, b, 0.5);
  const e = lerp(b, c, 0.5);
  const f = lerp(d, e, 0.5);
  return [[p0, a, d, f], [f, e, c, p3]];
}

/** Whether a curve (four points, in page coordinates) reaches inside box a. */
function curveInside(p: P[], a: Box, depth = 0): boolean {
  const b = bounds(p);
  if (b.x1 <= a.x0 || b.x0 >= a.x1 || b.y1 <= a.y0 || b.y0 >= a.y1) return false;
  if (b.x0 > a.x0 && b.x1 < a.x1 && b.y0 > a.y0 && b.y1 < a.y1) return true;
  if (depth >= 16) return [p[0], p[3]].some(([x, y]) => x > a.x0 && x < a.x1 && y > a.y0 && y < a.y1);
  const [l, r] = splitCurve(p);
  return curveInside(l, a, depth + 1) || curveInside(r, a, depth + 1);
}

/** Whether an outline piece reaches inside any of the boxes (in page coordinates). */
function segInside(from: P, seg: Seg, ctm: M, areas: Box[]): boolean {
  const dev = (p: P) => apply(ctm, p[0], p[1]);
  if (seg.curve) {
    const pts = [from, ...seg.pts].map(dev);
    return areas.some((a) => curveInside(pts, a));
  }
  return areas.some((a) => lineInside(dev(from), dev(seg.pts[0]), a) !== null);
}

function segLength(from: P, seg: Seg): number {
  if (!seg.curve) return Math.hypot(seg.pts[0][0] - from[0], seg.pts[0][1] - from[1]);
  const [p0, p1, p2, p3] = [from, ...seg.pts];
  let len = 0;
  let prev = p0;
  for (let k = 1; k <= 16; k++) {
    const t = k / 16;
    const u = 1 - t;
    const pt: P = [0, 1].map((i) => u * u * u * p0[i] + 3 * u * u * t * p1[i] + 3 * u * t * t * p2[i] + t * t * t * p3[i]) as P;
    len += Math.hypot(pt[0] - prev[0], pt[1] - prev[1]);
    prev = pt;
  }
  return len;
}

/** The parts (0 to 1 along it) of the line p→q outside all the boxes. */
function outsideParts(p: P, q: P, areas: Box[]): [number, number][] {
  const cuts = areas.map((a) => lineInside(p, q, a)).filter((c): c is [number, number] => c !== null).sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  let t = 0;
  for (const [c0, c1] of cuts) {
    if (c0 - t > 1e-9) out.push([t, c0]);
    t = Math.max(t, c1);
  }
  if (1 - t > 1e-9) out.push([t, 1]);
  return out;
}

/** A stretch of outline left after cutting, and how far along its outline it starts (for dashed lines). */
interface Piece {
  dist: number;
  start: P;
  segs: Seg[];
}

/**
 * What's left of a stroked outline once the parts under the boxes are cut away. With `joinEnds`, a closed
 * outline cut away from its starting point gets its two ends joined there again, so that corner looks the same.
 */
function strokePieces(sub: Subpath, ctm: M, areas: Box[], joinEnds: boolean): Piece[] {
  const dev = (p: P) => apply(ctm, p[0], p[1]);
  const pieces: Piece[] = [];
  let cur: Piece | null = null;
  let dist = 0;
  let first = true;
  let fromStart = false;
  for (const { from, seg } of edges(sub, sub.closed)) {
    const len = segLength(from, seg);
    if (seg.curve) {
      if (segInside(from, seg, ctm, areas)) throw new Unsupported("a curved line partly under a box");
      if (!cur) {
        cur = { dist, start: from, segs: [] };
        if (first) fromStart = true;
      }
      cur.segs.push(seg);
    } else {
      const to = seg.pts[0];
      const parts = outsideParts(dev(from), dev(to), areas);
      if (parts.length === 0 && cur) {
        pieces.push(cur);
        cur = null;
      }
      for (const [t0, t1] of parts) {
        if (t0 > 0 || !cur) {
          if (cur) pieces.push(cur);
          cur = { dist: dist + t0 * len, start: t0 === 0 ? from : lerp(from, to, t0), segs: [] };
          if (first && t0 === 0) fromStart = true;
        }
        cur.segs.push({ curve: false, pts: [t1 === 1 ? to : lerp(from, to, t1)] });
        if (t1 < 1) {
          pieces.push(cur);
          cur = null;
        }
      }
    }
    first = false;
    dist += len;
  }
  if (cur) pieces.push(cur);
  if (joinEnds && sub.closed && cur && fromStart && pieces.length >= 2) {
    const last = pieces.pop()!;
    pieces[0] = { dist: last.dist, start: last.start, segs: [...last.segs, ...pieces[0].segs] };
  }
  return pieces;
}

/** A rectangular outline as a box (in its own coordinates), and its direction (so filling rules work out the same). */
function rectOf(sub: Subpath): { box: Box; sx: number; sy: number } | null {
  if (sub.rect) {
    const [x, y, w, h] = sub.rect;
    return { box: { x0: Math.min(x, x + w), y0: Math.min(y, y + h), x1: Math.max(x, x + w), y1: Math.max(y, y + h) }, sx: w < 0 ? -1 : 1, sy: h < 0 ? -1 : 1 };
  }
  if (sub.segs.some((s) => s.curve)) return null;
  let pts = [sub.start, ...sub.segs.map(endOf)];
  if (pts.length === 5 && pts[4][0] === pts[0][0] && pts[4][1] === pts[0][1]) pts = pts.slice(0, 4);
  if (pts.length !== 4) return null;
  const level = (i: number) => pts[i][1] === pts[(i + 1) % 4][1];
  const upright = (i: number) => pts[i][0] === pts[(i + 1) % 4][0];
  if (!((level(0) && upright(1) && level(2) && upright(3)) || (upright(0) && level(1) && upright(2) && level(3)))) return null;
  let area = 0;
  for (let i = 0; i < 4; i++) area += pts[i][0] * pts[(i + 1) % 4][1] - pts[(i + 1) % 4][0] * pts[i][1];
  return { box: bounds(pts), sx: 1, sy: area < 0 ? -1 : 1 };
}

/** Rectangle r without box a: up to four rectangles (left, right, below, above). */
function subtract(r: Box, a: Box): Box[] {
  if (a.x1 <= r.x0 || a.x0 >= r.x1 || a.y1 <= r.y0 || a.y0 >= r.y1) return [r];
  const mx0 = Math.max(r.x0, a.x0);
  const mx1 = Math.min(r.x1, a.x1);
  const pieces: Box[] = [];
  if (a.x0 > r.x0) pieces.push({ x0: r.x0, y0: r.y0, x1: a.x0, y1: r.y1 });
  if (a.x1 < r.x1) pieces.push({ x0: a.x1, y0: r.y0, x1: r.x1, y1: r.y1 });
  if (a.y0 > r.y0) pieces.push({ x0: mx0, y0: r.y0, x1: mx1, y1: a.y0 });
  if (a.y1 < r.y1) pieces.push({ x0: mx0, y0: a.y1, x1: mx1, y1: r.y1 });
  return pieces.filter((p) => p.x1 >= p.x0 && p.y1 >= p.y0 && (p.x1 > p.x0 || p.y1 > p.y0));
}

/** Whether a transform keeps upright rectangles upright (no turning other than by quarter turns, no slanting). */
function axisAligned(m: M): boolean {
  const s = Math.abs(m[0]) + Math.abs(m[1]) + Math.abs(m[2]) + Math.abs(m[3]);
  return Math.abs(m[1]) + Math.abs(m[2]) <= 1e-9 * s || Math.abs(m[0]) + Math.abs(m[3]) <= 1e-9 * s;
}

/** A coordinate, finer than fmt (shapes may be drawn at any scale). */
const fmtP = (x: number) => {
  const r = Math.round(x * 1e6) / 1e6;
  return Math.abs(r) < 1e-9 ? "0" : String(r);
};
const writePt = (p: P) => `${fmtP(p[0])} ${fmtP(p[1])}`;
function writeSegs(start: P, segs: Seg[]): string {
  return [`${writePt(start)} m`, ...segs.map((s) => (s.curve ? `${s.pts.map(writePt).join(" ")} c` : `${writePt(s.pts[0])} l`))].join(" ");
}
function writeSub(sub: Subpath): string {
  if (sub.rect) return `${sub.rect.map(fmtP).join(" ")} re`;
  return writeSegs(sub.start, sub.segs) + (sub.closed ? " h" : "");
}
function writeRect(b: Box, sx: number, sy: number): string {
  return `${fmtP(sx > 0 ? b.x0 : b.x1)} ${fmtP(sy > 0 ? b.y0 : b.y1)} ${fmtP(sx * (b.x1 - b.x0))} ${fmtP(sy * (b.y1 - b.y0))} re`;
}

/** Painting operators that close the last outline first (s, b, b*) do so before it's looked at. */
function closeForPainting(shape: Shape, op: string): void {
  if (PAINT[op].close && shape.subs.length) shape.subs[shape.subs.length - 1].closed = true;
}

/**
 * The instructions to draw (and paint, as `op` does) what's left of a shape once everything under the
 * boxes is cut away, or null if no part of it is under a box. Throws Unsupported when that can't be done
 * exactly (curves crossing a box, filled shapes other than rectangles crossing a box).
 */
function cutShape(shape: Shape, op: string, areas: Box[], gs: GState): string | null {
  const paint = PAINT[op];
  closeForPainting(shape, op);
  const { subs, ctm } = shape;
  const dev = (p: P) => apply(ctm, p[0], p[1]);
  const pointsOf = (s: Subpath) => [s.start, ...s.segs.flatMap((g) => g.pts)].map(dev);
  const all = subs.flatMap(pointsOf);
  if (all.length === 0) return null;
  const whole = bounds(all);
  if (!areas.some((a) => touchesAtAll(whole, a))) return null;
  // A shape that's built and then thrown away ("n" without clipping) changes nothing: drop it.
  if (!paint.fill && !paint.stroke && !shape.clip) return " ";

  const near = areas.map((a) => shrink(a, EPS));
  const isArea = paint.fill !== null || shape.clip !== null;
  const within = subs.map((s) => areas.some((a) => inside(bounds(pointsOf(s)), a)));
  const enters = (s: Subpath, close: boolean) => edges(s, close).some((e) => segInside(e.from, e.seg, ctm, near));
  const fillState = subs.map((s, i) => (within[i] ? "drop" : isArea && enters(s, true) ? "cut" : "keep"));
  const strokeState = subs.map((s, i) => (within[i] ? "drop" : paint.stroke && enters(s, s.closed) ? "cut" : "keep"));
  if (!subs.some((_, i) => (isArea && fillState[i] !== "keep") || (paint.stroke && strokeState[i] !== "keep"))) return null;

  // The area (for filling and clipping): rectangles crossing a box are split around it.
  const areaParts: string[] = [];
  let lone: { pieces: Box[]; sx: number; sy: number } | null = null;
  if (isArea) {
    let userAreas: Box[] | null = null;
    for (let i = 0; i < subs.length; i++) {
      const s = subs[i];
      if (fillState[i] === "keep") areaParts.push(writeSub(s));
      if (fillState[i] !== "cut") continue;
      const r = rectOf(s);
      const inv = axisAligned(ctm) ? invert(ctm) : null;
      if (!r || !inv) throw new Unsupported("a shape partly under a box");
      userAreas ??= near.map((a) => bounds([apply(inv, a.x0, a.y0), apply(inv, a.x1, a.y0), apply(inv, a.x0, a.y1), apply(inv, a.x1, a.y1)]));
      let pieces = [r.box];
      for (const a of userAreas) pieces = pieces.flatMap((p) => subtract(p, a));
      for (const p of pieces) areaParts.push(writeRect(p, r.sx, r.sy));
      if (subs.length === 1) lone = { pieces, sx: r.sx, sy: r.sy };
    }
  }
  // A lone rectangle (a rule drawn as a thin filled bar, say) cut into pieces that don't touch: each is filled on
  // its own, like the original, since some readers draw a lone rectangle specially (lined up with the pixels).
  if (lone && paint.fill && !paint.stroke && !shape.clip && lone.pieces.every((p, i) => lone.pieces.every((q, j) => i === j || !touchesAtAll(p, q)))) {
    const { pieces, sx, sy } = lone;
    return ` ${pieces.map((p) => `${writeRect(p, sx, sy)} ${paint.fill}`).join(" ")} `;
  }

  // The lines: shortened to where they meet a box. Dashed lines keep their dashes in step after a cut.
  const strokeOps: string[] = [];
  if (paint.stroke) {
    const dashed = gs.dash.some((x) => x > 0);
    const together: string[] = [];
    const apart: Piece[] = [];
    subs.forEach((s, i) => {
      if (strokeState[i] === "keep") together.push(writeSub(s));
      if (strokeState[i] !== "cut") return;
      for (const p of strokePieces(s, ctm, near, !dashed)) {
        if (dashed) apart.push(p);
        else together.push(writeSegs(p.start, p.segs));
      }
    });
    if (together.length) strokeOps.push(`${together.join(" ")} S`);
    if (apart.length) {
      const dash = (phase: number) => `[${gs.dash.map(fmtP).join(" ")}] ${fmtP(phase)} d`;
      for (const p of apart) strokeOps.push(`${dash(gs.dashPhase + p.dist)} ${writeSegs(p.start, p.segs)} S`);
      strokeOps.push(dash(gs.dashPhase));
    }
  }

  const geometry = areaParts.join(" ");
  const out: string[] = [];
  if (paint.fill && geometry) out.push(`${geometry} ${paint.fill}`);
  out.push(...strokeOps);
  // Clipping comes last, so it limits what's drawn afterwards, as before. With nothing left, it clips everything.
  if (shape.clip) out.push(`${geometry || "0 0 0 0 re"} ${shape.clip} n`);
  return ` ${out.join(" ")} `;
}

/** Whether any part of a shape (as `op` paints or clips it) lies inside the boxes. */
function shapeUnder(shape: Shape, op: string, areas: Box[]): boolean {
  const paint = PAINT[op];
  closeForPainting(shape, op);
  const isArea = paint.fill !== null || shape.clip !== null || !paint.stroke;
  return shape.subs.some((s) => {
    if (s.segs.length === 0) {
      const [x, y] = apply(shape.ctm, s.start[0], s.start[1]);
      return areas.some((a) => x > a.x0 && x < a.x1 && y > a.y0 && y < a.y1);
    }
    return edges(s, isArea || s.closed).some((e) => segInside(e.from, e.seg, shape.ctm, areas));
  });
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

/** What redacting one copy did so far: for the check after each page, and the clean-up at the end. */
export class RedactionRun {
  /** Painted copies of pictures (by reference), and the transform each one is drawn with. */
  readonly painted = new Map<string, M>();
  /** Pictures and drawings redacted pages no longer draw (replaced by cleaned copies, or by a picture of the page). */
  readonly originals = new Map<string, PDFRef>();
}

/**
 * Removes what lies under `areas` from `page` (see the top of this file), then reads the result back
 * and checks it. Returns ok: false if the page should be saved as a picture instead.
 */
export async function redactPage(doc: PDFDocument, page: PDFPage, areas: Area[], run: RedactionRun = new RedactionRun()): Promise<RedactResult> {
  if (areas.length === 0) return { ok: true };
  const ctx = doc.context;
  page.node.normalize();
  dropPageCopies(page);
  try {
    const content = pageContent(page);
    // This page's own copy of its resource lists (they may be shared with other pages).
    const resources = privateResources(doc, page.node.Resources());
    page.node.set(PDFName.of("Resources"), resources);
    const counter = { n: 0 };
    const { result } = await redactContent(doc, content, resources, initialState(), areas, counter, run, 0);
    // Even unchanged content is rewritten as one stream, so the page's drawing instructions are a fresh copy.
    const ref = ctx.register(ctx.flateStream(result));
    page.node.set(PDFName.of("Contents"), ctx.obj([ref]));
    removeAnnotations(doc, page, areas);
    forgetContentStream(page);
    const found = checkPage(doc, page, areas, run);
    if (found) return { ok: false, reason: `the check afterwards found ${found} under a box` };
    return { ok: true };
  } catch (error) {
    if (error instanceof Unsupported) return { ok: false, reason: error.message };
    throw error;
  }
}

/** All of a page's drawing instructions, decoded, as one. */
function pageContent(page: PDFPage): Uint8Array {
  const ctx = page.doc.context;
  const contents = page.node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray().map((x) => ctx.lookup(x)) : [contents];
  const parts: Uint8Array[] = [];
  for (const s of streams) if (s instanceof PDFStream) parts.push(streamBytes(s), Uint8Array.of(10));
  return concat(parts);
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

const HIDDEN_TEXT = ["ActualText", "Alt", "E"];

async function redactContent(
  doc: PDFDocument,
  content: Uint8Array,
  resources: PDFDict,
  startState: GState,
  areas: Area[],
  counter: { n: number },
  run: RedactionRun,
  depth: number,
): Promise<{ result: Uint8Array; changed: boolean }> {
  if (depth > 12) throw new Unsupported("drawings nested too deeply");
  const ctx = doc.context;
  const ops = parseContent(content);
  // Set when hidden words are taken out of the (private) marked-content list, which the bytes don't show.
  let listChanged = false;
  const replacements: { start: number; end: number; text: string }[] = [];
  // A drawing inside the page starts from the page's state at that point (including text settings).
  const t = new Tracker(startState, fontLookup(doc, resources));
  const replacedNames = new Set<string>();

  /** Shows text; returns the replacement TJ text if any letter was under a box. */
  const show = (items: Value[]): string | null => {
    let any = false;
    const out: (Uint8Array | number)[] = [];
    let kept: number[] = [];
    const flush = () => {
      if (kept.length) out.push(Uint8Array.from(kept));
      kept = [];
    };
    t.show(
      items,
      (g) => {
        if (!glyphHit(g, areas)) {
          kept.push(...g.bytes);
          return;
        }
        any = true;
        const fsth = t.gs.size * t.gs.scale;
        if (Math.abs(fsth) < 1e-9) throw new Unsupported("zero-size text");
        flush();
        out.push(-(g.advance * 1000) / fsth);
      },
      (n) => {
        flush();
        out.push(n);
      },
    );
    flush();
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
    t.update(o);
    switch (o.op) {
      case "Tj":
      case "TJ":
      case "'":
      case '"': {
        // The ' and " operators also move to the next line (and " sets the spacing): written out separately.
        const prefix = o.op === '"' ? `${fmt(t.gs.wordSpace)} Tw ${fmt(t.gs.charSpace)} Tc T* ` : o.op === "'" ? "T* " : "";
        const replaced = show(textItems(o));
        if (replaced) replacements.push({ start: o.start, end: o.end, text: ` ${prefix}${replaced} ` });
        break;
      }
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
        const shape = t.shape;
        t.shape = null;
        if (!shape) break;
        const text = cutShape(shape, o.op, areas, t.gs);
        if (text !== null) replacements.push({ start: shape.start, end: o.end, text });
        break;
      }
      case "Do": {
        if (!isName(a[0]) || !(xobjects instanceof PDFDict)) break;
        const ref = xobjects.get(PDFName.of(a[0].name));
        const x = ctx.lookup(ref);
        if (!(x instanceof PDFStream)) break;
        const gs = t.gs;
        const sub = (x.dict.lookup(PDFName.of("Subtype")) as PDFName | undefined)?.decodeText?.();
        if (sub === "Image") {
          const box = bounds([apply(gs.ctm, 0, 0), apply(gs.ctm, 1, 0), apply(gs.ctm, 0, 1), apply(gs.ctm, 1, 1)]);
          const hits = areas.filter((area) => touches(box, area));
          if (hits.length === 0) break;
          const copy = await paintImage(doc, x, gs.ctm, hits);
          if (!copy) break;
          run.painted.set(copy.toString(), gs.ctm);
          const name = freshName(resources, "XObject", counter, ctx);
          (resources.lookup(PDFName.of("XObject")) as PDFDict).set(PDFName.of(name), copy);
          replacedNames.add(a[0].name);
          if (ref instanceof PDFRef) run.originals.set(ref.toString(), ref);
          replacements.push({ start: o.start, end: o.end, text: ` ${writeName(name)} Do ` });
        } else if (sub === "Form") {
          const ctm = formMatrix(doc, x, gs.ctm);
          if (!formTouches(doc, x, ctm, areas)) break;
          const formRes = x.dict.lookup(PDFName.of("Resources"));
          const inner = privateResources(doc, formRes instanceof PDFDict ? formRes : resources);
          const before = streamBytes(x);
          const { result: after, changed } = await redactContent(doc, before, inner, { ...gs, ctm }, areas, counter, run, depth + 1);
          if (!changed) break;
          const copy = ctx.flateStream(after);
          for (const [k, v] of x.dict.entries()) if (!["Length", "Filter", "DecodeParms", "Resources"].includes(k.decodeText())) copy.dict.set(k, v);
          copy.dict.set(PDFName.of("Resources"), inner);
          const name = freshName(resources, "XObject", counter, ctx);
          (resources.lookup(PDFName.of("XObject")) as PDFDict).set(PDFName.of(name), ctx.register(copy));
          replacedNames.add(a[0].name);
          if (ref instanceof PDFRef) run.originals.set(ref.toString(), ref);
          replacements.push({ start: o.start, end: o.end, text: ` ${writeName(name)} Do ` });
        }
        break;
      }
      case "BI": {
        const ctm = t.gs.ctm;
        const box = bounds([apply(ctm, 0, 0), apply(ctm, 1, 0), apply(ctm, 0, 1), apply(ctm, 1, 1)]);
        if (areas.some((area) => touches(box, area))) throw new Unsupported("inline picture under a box");
        break;
      }
      case "BDC":
      case "DP": {
        // Hidden copies of the words ("ActualText", "Alt", "E") would survive removal: drop them on this page.
        const props = a[1];
        if (props instanceof Map && HIDDEN_TEXT.some((k) => props.has(k))) {
          const clean = new Map([...props].filter(([k]) => !HIDDEN_TEXT.includes(k)));
          replacements.push({ start: o.start, end: o.end, text: ` ${writeValue(a[0])} ${writeValue(clean)} ${o.op} ` });
        } else if (isName(props) && properties instanceof PDFDict) {
          const p = properties.lookup(PDFName.of(props.name));
          if (p instanceof PDFDict && HIDDEN_TEXT.some((k) => p.has(PDFName.of(k)))) {
            for (const k of HIDDEN_TEXT) p.delete(PDFName.of(k));
            listChanged = true;
          }
        }
        break;
      }
      default:
        break;
    }
  }

  if (replacements.length === 0) return { result: content, changed: listChanged };
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
    if (list instanceof PDFDict) for (const name of replacedNames) if (!used.has(name)) list.delete(PDFName.of(name));
  }
  return { result, changed: true };
}

/** The transform a drawing (form) is drawn with. */
function formMatrix(doc: PDFDocument, form: PDFStream, ctm: M): M {
  const fm = form.dict.lookup(PDFName.of("Matrix"));
  const matrix = fm instanceof PDFArray ? (fm.asArray().map((v) => (doc.context.lookup(v) as PDFNumber)?.asNumber?.() ?? 0) as M) : IDENTITY;
  return mul(matrix, ctm);
}

/** Whether a drawing's frame (BBox; it shows nothing outside it) touches any of the areas. */
function formTouches(doc: PDFDocument, form: PDFStream, ctm: M, areas: Box[]): boolean {
  const bb = form.dict.lookup(PDFName.of("BBox"));
  if (!(bb instanceof PDFArray)) return true;
  const [x0, y0, x1, y1] = bb.asArray().map((v) => (doc.context.lookup(v) as PDFNumber)?.asNumber?.() ?? 0);
  const box = bounds([apply(ctm, x0, y0), apply(ctm, x1, y0), apply(ctm, x0, y1), apply(ctm, x1, y1)]);
  return areas.some((area) => touches(box, area));
}

// ---------------------------------------------------------------------------
// The check afterwards
// ---------------------------------------------------------------------------

/**
 * Reads a redacted page back (its drawing instructions decoded again from the stored stream) and follows
 * them on its own, looking for anything still under a box: letters, pictures not painted over there,
 * shapes, inline pictures, hidden copies of words, links and notes, stored copies of the page. Returns
 * what it found, or null. A page that fails is saved as a picture instead.
 */
function checkPage(doc: PDFDocument, page: PDFPage, areas: Area[], run: RedactionRun): string | null {
  const ctx = doc.context;
  const resources = page.node.Resources() ?? (ctx.obj({}) as PDFDict);
  const found = leftoverIn(doc, pageContent(page), resources, initialState(), areas, run, 0);
  if (found) return found;
  for (const item of page.node.Annots()?.asArray() ?? []) {
    const rect = (ctx.lookup(item) as PDFDict | undefined)?.lookup?.(PDFName.of("Rect"));
    const r = rect instanceof PDFArray ? rect.asArray().map((v) => (ctx.lookup(v) as PDFNumber)?.asNumber?.() ?? 0) : null;
    if (r && areas.some((a) => touches({ x0: Math.min(r[0], r[2]), y0: Math.min(r[1], r[3]), x1: Math.max(r[0], r[2]), y1: Math.max(r[1], r[3]) }, a))) return "a link or note";
  }
  if (page.node.has(PDFName.of("Thumb")) || page.node.has(PDFName.of("PieceInfo"))) return "a stored copy of the page";
  return null;
}

function leftoverIn(doc: PDFDocument, content: Uint8Array, resources: PDFDict, start: GState, areas: Area[], run: RedactionRun, depth: number): string | null {
  if (depth > 12) return "drawings nested too deeply";
  const ctx = doc.context;
  const t = new Tracker(start, fontLookup(doc, resources));
  const near = areas.map((a) => shrink(a, 2 * EPS));
  const xobjects = resources.lookup(PDFName.of("XObject"));
  const properties = resources.lookup(PDFName.of("Properties"));
  for (const o of parseContent(content)) {
    const a = o.args;
    t.update(o);
    switch (o.op) {
      case "Tj":
      case "TJ":
      case "'":
      case '"': {
        let hit = false;
        t.show(textItems(o), (g) => (hit ||= glyphHit(g, areas)));
        if (hit) return "words";
        break;
      }
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
        const shape = t.shape;
        t.shape = null;
        if (shape && shapeUnder(shape, o.op, near)) return "part of a shape";
        break;
      }
      case "Do": {
        if (!isName(a[0]) || !(xobjects instanceof PDFDict)) break;
        const ref = xobjects.get(PDFName.of(a[0].name));
        const x = ctx.lookup(ref);
        if (!(x instanceof PDFStream)) break;
        const ctm = t.gs.ctm;
        const sub = (x.dict.lookup(PDFName.of("Subtype")) as PDFName | undefined)?.decodeText?.();
        if (sub === "Image") {
          const box = bounds([apply(ctm, 0, 0), apply(ctm, 1, 0), apply(ctm, 0, 1), apply(ctm, 1, 1)]);
          const hits = areas.filter((area) => touches(box, area));
          if (hits.length === 0) break;
          // Fine if it's a copy painted for exactly this place, or if no pixel of it is under a box.
          const painted = ref instanceof PDFRef ? run.painted.get(ref.toString()) : undefined;
          if (painted && painted.every((v, k) => Math.abs(v - ctm[k]) <= 1e-6 * (1 + Math.abs(v)))) break;
          const width = (x.dict.lookup(PDFName.of("Width")) as PDFNumber | undefined)?.asNumber?.() ?? 0;
          const height = (x.dict.lookup(PDFName.of("Height")) as PDFNumber | undefined)?.asNumber?.() ?? 0;
          if (pixelBoxes(ctm, width, height, hits).length > 0) return "a picture";
        } else if (sub === "Form") {
          const fctm = formMatrix(doc, x, ctm);
          if (!formTouches(doc, x, fctm, areas)) break;
          const formRes = x.dict.lookup(PDFName.of("Resources"));
          const found = leftoverIn(doc, streamBytes(x), formRes instanceof PDFDict ? formRes : resources, { ...t.gs, ctm: fctm }, areas, run, depth + 1);
          if (found) return found;
        }
        break;
      }
      case "BI": {
        const ctm = t.gs.ctm;
        const box = bounds([apply(ctm, 0, 0), apply(ctm, 1, 0), apply(ctm, 0, 1), apply(ctm, 1, 1)]);
        if (areas.some((area) => touches(box, area))) return "an inline picture";
        break;
      }
      case "BDC":
      case "DP": {
        const props = a[1];
        if (props instanceof Map && HIDDEN_TEXT.some((k) => props.has(k))) return "hidden words";
        if (isName(props) && properties instanceof PDFDict) {
          const p = properties.lookup(PDFName.of(props.name));
          if (p instanceof PDFDict && HIDDEN_TEXT.some((k) => p.has(PDFName.of(k)))) return "hidden words";
        }
        break;
      }
      default:
        break;
    }
  }
  return null;
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
 * Stored copies of what a page showed, which redaction would leave behind: a small picture of the
 * page (Thumb) and apps' private data (PieceInfo; Illustrator, for one, keeps its own copy of the
 * artwork there).
 */
function dropPageCopies(page: PDFPage): void {
  page.node.delete(PDFName.of("Thumb"));
  page.node.delete(PDFName.of("PieceInfo"));
}

/**
 * Replaces everything on a page with a picture of it (for pages whose content
 * can't be changed safely). `toPdf` maps the page as shown (width × height
 * points, top-left origin) to its PDF coordinates. The page gets new resource
 * lists holding only the picture, so its original pictures, drawings and fonts
 * are no longer part of it (and are cleared out of the file). Links, notes and
 * form fields on the page are removed (the picture shows them as they looked).
 */
export async function replaceWithPicture(
  doc: PDFDocument,
  page: PDFPage,
  toPdf: M,
  picture: { jpeg: Uint8Array; width: number; height: number },
  run: RedactionRun = new RedactionRun(),
): Promise<void> {
  const ctx = doc.context;
  page.node.normalize();
  const old = page.node.Resources()?.lookup(PDFName.of("XObject"));
  if (old instanceof PDFDict) for (const [, v] of old.entries()) if (v instanceof PDFRef) run.originals.set(v.toString(), v);
  const image = await doc.embedJpg(picture.jpeg);
  // Empty font and graphics-state lists too: edits and highlights drawn afterwards add theirs there.
  page.node.set(PDFName.of("Resources"), ctx.obj({ Font: {}, XObject: { PlainPdfPagePicture: image.ref }, ExtGState: {} }));
  const m = mul([picture.width, 0, 0, -picture.height, 0, picture.height], toPdf);
  const content = `q ${m.map(fmt).join(" ")} cm /PlainPdfPagePicture Do Q`;
  page.node.set(PDFName.of("Contents"), ctx.obj([ctx.register(ctx.flateStream(content))]));
  dropPageCopies(page);
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

// ---------------------------------------------------------------------------
// Clearing out the file
// ---------------------------------------------------------------------------

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

/**
 * The last step of a save with redaction: deletes everything nothing refers to any more. Then, if some
 * of the pictures and drawings redacted pages stopped drawing are still in the file, because they're
 * listed in resources shared with other pages (or inherited from the page tree), and no page draws them,
 * they're taken off those lists and deleted too.
 */
export function finishRedaction(doc: PDFDocument, run: RedactionRun): void {
  removeUnreachable(doc);
  const ctx = doc.context;
  const left = [...run.originals.values()].filter((ref) => ctx.lookup(ref) !== undefined);
  if (left.length === 0) return;
  const drawn = drawnXObjects(doc);
  if (!drawn) {
    console.info("Couldn't read every page's drawing instructions, so pictures listed but not drawn were kept.");
    return;
  }
  const unused = new Set(left.map(String).filter((key) => !drawn.has(key)));
  if (unused.size === 0) return;
  const done = new Set<PDFObject>();
  const clean = (o: PDFObject | undefined): void => {
    if (!o || o instanceof PDFRef || done.has(o)) return;
    done.add(o);
    if (o instanceof PDFStream) clean(o.dict);
    else if (o instanceof PDFArray) for (const v of o.asArray()) clean(v);
    else if (o instanceof PDFDict) {
      const list = o.lookup(PDFName.of("XObject"));
      if (list instanceof PDFDict) for (const [k, v] of [...list.entries()]) if (v instanceof PDFRef && unused.has(v.toString())) list.delete(k);
      for (const [, v] of o.entries()) clean(v);
    }
  };
  for (const [, obj] of ctx.enumerateIndirectObjects()) clean(obj);
  removeUnreachable(doc);
}

/**
 * Every picture and drawing (by reference) that something in the file still draws: the pages, the
 * drawings inside them, patterns, soft masks, Type 3 letters and the looks of links, notes and form
 * fields. Null if some drawing instructions couldn't be read (so nothing can be ruled out).
 */
function drawnXObjects(doc: PDFDocument): Set<string> | null {
  const ctx = doc.context;
  const drawn = new Set<string>();
  const done = new Set<string>();
  const ids = new Map<PDFDict, number>();
  const idOf = (d: PDFDict | undefined) => {
    if (!d) return 0;
    if (!ids.has(d)) ids.set(d, ids.size + 1);
    return ids.get(d)!;
  };
  const entry = (res: PDFDict | undefined, category: string, name: string): PDFObject | undefined => {
    const list = res?.lookup(PDFName.of(category));
    return list instanceof PDFDict ? list.get(PDFName.of(name)) : undefined;
  };
  const visit = (obj: PDFObject | undefined, res: PDFDict | undefined, depth: number): void => {
    if (obj instanceof PDFRef) drawn.add(obj.toString());
    const x = obj instanceof PDFRef ? ctx.lookup(obj) : obj;
    if (!(x instanceof PDFStream)) return;
    if ((x.dict.lookup(PDFName.of("Subtype")) as PDFName | undefined)?.decodeText?.() === "Image") return;
    const own = x.dict.lookup(PDFName.of("Resources"));
    const key = `${obj instanceof PDFRef ? obj.toString() : `direct${idOf(x.dict)}`}@${own instanceof PDFDict ? 0 : idOf(res)}`;
    if (done.has(key)) return;
    done.add(key);
    walk(streamBytes(x), own instanceof PDFDict ? own : res, depth + 1);
  };
  const walk = (content: Uint8Array, res: PDFDict | undefined, depth: number): void => {
    if (depth > 30) throw new Unsupported("drawings nested too deeply");
    for (const o of parseContent(content)) {
      const first = o.args[0];
      const last = o.args[o.args.length - 1];
      if (o.op === "Do" && isName(first)) visit(entry(res, "XObject", first.name), res, depth);
      else if ((o.op === "scn" || o.op === "SCN") && isName(last)) visit(entry(res, "Pattern", last.name), res, depth);
      else if (o.op === "gs" && isName(first)) {
        const g = ctx.lookup(entry(res, "ExtGState", first.name));
        const mask = g instanceof PDFDict ? g.lookup(PDFName.of("SMask")) : undefined;
        if (mask instanceof PDFDict) visit(mask.get(PDFName.of("G")), res, depth);
      } else if (o.op === "Tf" && isName(first)) {
        const font = ctx.lookup(entry(res, "Font", first.name));
        const procs = font instanceof PDFDict ? font.lookup(PDFName.of("CharProcs")) : undefined;
        if (font instanceof PDFDict && procs instanceof PDFDict) {
          const fontRes = font.lookup(PDFName.of("Resources"));
          for (const [, v] of procs.entries()) visit(v, fontRes instanceof PDFDict ? fontRes : res, depth);
        }
      }
    }
  };
  try {
    for (const page of doc.getPages()) {
      walk(pageContent(page), page.node.Resources(), 0);
      for (const item of page.node.Annots()?.asArray() ?? []) {
        const ap = (ctx.lookup(item) as PDFDict | undefined)?.lookup?.(PDFName.of("AP"));
        if (!(ap instanceof PDFDict)) continue;
        for (const [, look] of ap.entries()) {
          const v = ctx.lookup(look);
          if (v instanceof PDFDict && !(v instanceof PDFStream)) for (const [, state] of v.entries()) visit(state, undefined, 0);
          else visit(look, undefined, 0);
        }
      }
    }
  } catch (error) {
    console.info("Couldn't follow every drawing:", error);
    return null;
  }
  return drawn;
}
