/**
 * Everything the person adds on top of the PDF: pen strokes, highlights and
 * signatures. The original PDF is never changed; additions are only written
 * into a new copy when saving.
 *
 * Positions are in PDF points (1/72 inch), measured from the top-left corner
 * of the page as it is shown on screen.
 */
import type { EventHub } from "./events";
import type { FontStyle } from "./fonts";
import type { Rect } from "./text-layout";

interface Base {
  id: string;
  /** 0-based page index. */
  page: number;
  /** Stacking order: higher numbers are drawn on top. */
  order: number;
}

/** A freehand pen line, or a straight highlighter line (used where there's no text, e.g. scans). */
export interface Stroke extends Base {
  kind: "stroke";
  tool: "pen" | "highlighter";
  /** CSS colour, for example "#1d4ed8". */
  color: string;
  /** Line thickness in points. */
  width: number;
  /** Flat list of coordinates: x0, y0, x1, y1, ... */
  points: number[];
}

/** A highlight that follows the text: one rectangle per line of text. */
export interface TextHighlight extends Base {
  kind: "highlight";
  color: string;
  rects: Rect[];
}

/** The person's signature drawing, in its own coordinates (0..width, 0..height). */
export interface SignatureInk {
  width: number;
  height: number;
  /** Each stroke is a flat list of coordinates. */
  strokes: number[][];
  /** Line thickness, in the same units as the coordinates. */
  lineWidth: number;
  color: string;
}

/** A signature (or initials) placed on a page. */
export interface PlacedSignature extends Base {
  kind: "signature";
  role: "signature" | "initials";
  /** Clockwise turn of the content in its box (when its page was rotated). */
  turn?: number;
  x: number;
  y: number;
  width: number;
  height: number;
  ink: SignatureInk;
}

/** Typed text. Lines are separated by "\n". (x, y) is the top-left corner. */
export interface TextBox extends Base {
  kind: "text";
  /** Clockwise turn of the text in its box (when its page was rotated). */
  turn?: number;
  x: number;
  y: number;
  /** Size of the text block, in points (worked out when typing finishes). */
  width: number;
  height: number;
  text: string;
  /** Font size in points. */
  size: number;
  color: string;
}

/** Text layout shared by the screen and saved files (Arimo on screen, Helvetica in the PDF: same widths). */
export const TEXT_LINE_HEIGHT = 1.2;
/** Distance from the top of a line to its baseline, as a fraction of the font size. */
export const TEXT_BASELINE = 0.9465;

/**
 * Edited PDF text: a patch in the paper's colour covers the old words, and
 * the new words are written on top in a matching style. (The old words are
 * still in the file underneath, only hidden.)
 */
export interface TextEdit extends Base, FontStyle {
  kind: "edit";
  /** The area hidden by the patch. */
  cover: Rect;
  coverColor: string;
  /** Top-left of the new text block; width is where lines wrap. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Clockwise turn of the text in its box (when its page was rotated). */
  turn?: number;
  /** What was typed, and how it wraps into lines. */
  text: string;
  lines: string[];
  /** The original wording (for reference). */
  original: string;
  size: number;
  color: string;
  /** Distance between baselines, and from the top of the block to the first baseline. */
  lineHeight: number;
  baselineOffset: number;
}

export type Addition = Stroke | TextHighlight | PlacedSignature | TextBox | TextEdit;

/** The transform [a, b, c, d, e, f] that places a box's content, turned clockwise by `turn`. */
export function boxMatrix(x: number, y: number, w: number, h: number, turn = 0): [number, number, number, number, number, number] {
  switch (((turn % 360) + 360) % 360) {
    case 90:
      return [0, 1, -1, 0, x + w, y];
    case 180:
      return [-1, 0, 0, -1, x + w, y + h];
    case 270:
      return [0, -1, 1, 0, x, y + h];
    default:
      return [1, 0, 0, 1, x, y];
  }
}

/** Size of a box's content before turning: width and height swap for quarter turns. */
export function contentSize(w: number, h: number, turn = 0): { width: number; height: number } {
  return ((turn % 180) + 180) % 180 === 90 ? { width: h, height: w } : { width: w, height: h };
}

let nextOrder = 1;
let nextId = 1;

export function newAdditionMeta(): { id: string; order: number } {
  return { id: `a${nextId++}`, order: nextOrder++ };
}

export class Additions {
  private items = new Map<string, Addition>();

  constructor(private readonly hub: EventHub) {}

  get size(): number {
    return this.items.size;
  }

  get(id: string): Addition | undefined {
    return this.items.get(id);
  }

  add(...items: Addition[]): void {
    for (const item of items) this.items.set(item.id, item);
    this.changed(items);
  }

  /** Replaces an addition with a changed copy (same id). */
  update(item: Addition): void {
    const old = this.items.get(item.id);
    this.items.set(item.id, item);
    this.changed(old && old.page !== item.page ? [old, item] : [item]);
  }

  /** Replaces everything (after a page operation, or undoing one). */
  replaceAll(items: Addition[]): void {
    const pages = new Set([...this.items.values()].map((a) => a.page));
    this.items = new Map(items.map((a) => [a.id, a]));
    for (const a of items) pages.add(a.page);
    if (pages.size) this.hub.emit("additions:changed", { pages: [...pages] });
  }

  remove(...items: Addition[]): void {
    for (const item of items) this.items.delete(item.id);
    this.changed(items);
  }

  /** Additions on one page, bottom-most first. */
  onPage(page: number): Addition[] {
    return [...this.items.values()].filter((a) => a.page === page).sort((a, b) => a.order - b.order);
  }

  all(): Addition[] {
    return [...this.items.values()].sort((a, b) => a.order - b.order);
  }

  clear(): void {
    const pages = [...new Set([...this.items.values()].map((a) => a.page))];
    this.items.clear();
    if (pages.length) this.hub.emit("additions:changed", { pages });
  }

  private changed(items: Addition[]): void {
    if (items.length === 0) return;
    this.hub.emit("additions:changed", { pages: [...new Set(items.map((a) => a.page))] });
  }
}
