/**
 * Works out the lines and words of text on a page, so the highlighter can
 * snap to them: a rough drag over text becomes a clean highlight of exactly
 * the words covered, like selecting text.
 *
 * All positions are in PDF points from the top-left corner of the page.
 */
import type { TextFragment } from "./pdf-engine";

export interface Word {
  x0: number;
  x1: number;
}

/** One line of text (or one column's part of a line). */
export interface TextLine {
  top: number;
  bottom: number;
  x0: number;
  x1: number;
  words: Word[];
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Fraction of the font size above and below the baseline that letters use. */
const ASCENT = 0.82;
const DESCENT = 0.24;

let measureContext: CanvasRenderingContext2D | null = null;

/** Estimated left/right edge of each character, scaled to the run's real width. */
function characterEdges(text: string, width: number): number[] {
  measureContext ??= document.createElement("canvas").getContext("2d");
  const chars = [...text];
  let widths: number[];
  if (measureContext) {
    measureContext.font = "100px sans-serif";
    widths = chars.map((c) => measureContext!.measureText(c).width || 50);
  } else {
    widths = chars.map(() => 1);
  }
  const total = widths.reduce((a, b) => a + b, 0) || 1;
  const edges = [0];
  for (const w of widths) edges.push(edges[edges.length - 1] + (w / total) * width);
  return edges;
}

interface Piece {
  x0: number;
  x1: number;
  baseline: number;
  size: number;
}

/** Groups text runs into lines and words. */
export function buildTextLines(fragments: TextFragment[]): TextLine[] {
  // 1. Split each run into word pieces.
  const pieces: Piece[] = [];
  for (const f of fragments) {
    const chars = [...f.text];
    const edges = characterEdges(f.text, f.width);
    let start = -1;
    for (let i = 0; i <= chars.length; i++) {
      const isSpace = i === chars.length || /\s/.test(chars[i]);
      if (!isSpace && start < 0) start = i;
      if (isSpace && start >= 0) {
        pieces.push({ x0: f.x + edges[start], x1: f.x + edges[i], baseline: f.baseline, size: f.size });
        start = -1;
      }
    }
  }

  // 2. Group pieces that share a baseline into rows.
  pieces.sort((a, b) => a.baseline - b.baseline || a.x0 - b.x0);
  const rows: Piece[][] = [];
  for (const p of pieces) {
    const row = rows.find((r) => Math.abs(r[0].baseline - p.baseline) < 0.35 * Math.max(r[0].size, p.size));
    if (row) row.push(p);
    else rows.push([p]);
  }

  // 3. Within each row, join touching pieces into words, and split the row
  //    where there's a big gap (separate columns become separate lines).
  const lines: TextLine[] = [];
  for (const row of rows) {
    row.sort((a, b) => a.x0 - b.x0);
    const size = Math.max(...row.map((p) => p.size));
    const baseline = row.reduce((sum, p) => sum + p.baseline, 0) / row.length;
    let words: Word[] = [];
    const flush = () => {
      if (words.length === 0) return;
      lines.push({
        top: baseline - ASCENT * size,
        bottom: baseline + DESCENT * size,
        x0: words[0].x0,
        x1: words[words.length - 1].x1,
        words,
      });
      words = [];
    };
    for (const p of row) {
      const last = words[words.length - 1];
      const gap = last ? p.x0 - last.x1 : 0;
      if (last && gap > 2.5 * size) flush();
      const current = words[words.length - 1];
      if (current && p.x0 - current.x1 < 0.12 * size) current.x1 = Math.max(current.x1, p.x1);
      else words.push({ x0: p.x0, x1: p.x1 });
    }
    flush();
  }
  lines.sort((a, b) => a.top - b.top || a.x0 - b.x0);
  return lines;
}

/** The line under a point, if the point is on (or very close to) text. */
export function lineAt(lines: TextLine[], x: number, y: number): TextLine | null {
  let best: TextLine | null = null;
  let bestDistance = Infinity;
  for (const line of lines) {
    const h = line.bottom - line.top;
    const padY = 0.3 * h;
    const padX = 0.6 * h;
    if (y < line.top - padY || y > line.bottom + padY || x < line.x0 - padX || x > line.x1 + padX) continue;
    const distance = Math.abs(y - (line.top + line.bottom) / 2);
    if (distance < bestDistance) {
      best = line;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * The highlight rectangles for a drag from `start` to `end` that began on
 * `startLine`: whole words only, one rectangle per line, following the
 * column the drag started in.
 */
export function highlightRects(
  lines: TextLine[],
  startLine: TextLine,
  start: { x: number; y: number },
  end: { x: number; y: number },
): Rect[] {
  // Lines in the same column as the starting line, top to bottom.
  const column = lines.filter((l) => l === startLine || (l.x1 > startLine.x0 && l.x0 < startLine.x1));
  const startIndex = column.indexOf(startLine);

  // The line the drag ends on: the one containing the pointer, or the nearest.
  let endIndex = startIndex;
  let bestDistance = Infinity;
  column.forEach((l, i) => {
    const distance = end.y < l.top ? l.top - end.y : end.y > l.bottom ? end.y - l.bottom : 0;
    if (distance < bestDistance - 0.01) {
      bestDistance = distance;
      endIndex = i;
    }
  });

  // Put the two ends in reading order.
  let a = { index: startIndex, x: start.x };
  let b = { index: endIndex, x: end.x };
  if (b.index < a.index || (b.index === a.index && b.x < a.x)) [a, b] = [b, a];

  const rects: Rect[] = [];
  for (let i = a.index; i <= b.index; i++) {
    const line = column[i];
    const from = i === a.index ? a.x : -Infinity;
    const to = i === b.index ? b.x : Infinity;
    const words = line.words.filter((w) => w.x1 >= from && w.x0 <= to);
    if (words.length === 0) continue;
    const h = line.bottom - line.top;
    const padX = 0.06 * h;
    const padY = 0.04 * h;
    const x0 = words[0].x0 - padX;
    const x1 = words[words.length - 1].x1 + padX;
    rects.push({ x: x0, y: line.top - padY, w: x1 - x0, h: h + 2 * padY });
  }
  return rects;
}

/** Remembers each page's text lines once worked out (per open document). */
export class TextLayoutCache {
  private ready = new Map<number, TextLine[]>();
  private loading = new Map<number, Promise<TextLine[]>>();

  constructor(private readonly source: (page: number) => Promise<TextFragment[]>) {}

  /** The lines of page `page` if already known, without waiting. */
  peek(page: number): TextLine[] | undefined {
    return this.ready.get(page);
  }

  load(page: number): Promise<TextLine[]> {
    const known = this.ready.get(page);
    if (known) return Promise.resolve(known);
    let pending = this.loading.get(page);
    if (!pending) {
      pending = this.source(page)
        .then(buildTextLines)
        .catch(() => [] as TextLine[])
        .then((lines) => {
          this.ready.set(page, lines);
          this.loading.delete(page);
          return lines;
        });
      this.loading.set(page, pending);
    }
    return pending;
  }
}
