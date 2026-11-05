/**
 * The searchable text of a page, with a way back from each character to its
 * position on the page (so matches can be highlighted).
 */
import type { TextFragment } from "../../core/pdf-engine";
import { characterEdges, type Rect } from "../../core/text-layout";

export interface PageText {
  /** Lower-case text, with each run of spaces and line breaks reduced to one space. */
  text: string;
  /** For each character of `text`: which fragment and which character in it (-1 for added spaces). */
  fragmentOf: number[];
  charOf: number[];
  fragments: TextFragment[];
  edges: number[][];
}

export function buildPageText(raw: TextFragment[]): PageText {
  // Reading order: top to bottom, then left to right.
  const fragments = [...raw].sort((a, b) => {
    const sameRow = Math.abs(a.baseline - b.baseline) < 0.35 * Math.max(a.size, b.size);
    return sameRow ? a.x - b.x : a.baseline - b.baseline;
  });
  let text = "";
  const fragmentOf: number[] = [];
  const charOf: number[] = [];
  const addSpace = () => {
    if (text.length > 0 && !text.endsWith(" ")) {
      text += " ";
      fragmentOf.push(-1);
      charOf.push(-1);
    }
  };
  fragments.forEach((f, i) => {
    const prev = fragments[i - 1];
    if (prev) {
      const sameRow = Math.abs(prev.baseline - f.baseline) < 0.35 * Math.max(prev.size, f.size);
      if (!sameRow || f.x - (prev.x + prev.width) > 0.15 * f.size) addSpace();
    }
    [...f.text].forEach((ch, c) => {
      if (/\s/.test(ch)) {
        addSpace();
        return;
      }
      text += ch.toLowerCase();
      fragmentOf.push(i);
      charOf.push(c);
    });
  });
  return { text, fragmentOf, charOf, fragments, edges: fragments.map((f) => characterEdges(f.text, f.width)) };
}

export function normaliseQuery(query: string): string {
  return query.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Start positions of every match of `query` (already normalised). */
export function findAll(page: PageText, query: string): number[] {
  const found: number[] = [];
  if (!query) return found;
  for (let i = page.text.indexOf(query); i !== -1; i = page.text.indexOf(query, i + 1)) found.push(i);
  return found;
}

/** Rectangles (page points) covering a match, one per piece of text it spans. */
export function matchRects(page: PageText, start: number, length: number): Rect[] {
  const rects: Rect[] = [];
  let current: { frag: number; first: number; last: number } | null = null;
  const flush = () => {
    if (!current) return;
    const f = page.fragments[current.frag];
    const e = page.edges[current.frag];
    rects.push({ x: f.x + e[current.first], y: f.baseline - 0.82 * f.size, w: e[current.last + 1] - e[current.first], h: 1.06 * f.size });
    current = null;
  };
  for (let i = start; i < start + length; i++) {
    const frag = page.fragmentOf[i];
    if (frag < 0) continue;
    if (current && current.frag === frag) current.last = page.charOf[i];
    else {
      flush();
      current = { frag, first: page.charOf[i], last: page.charOf[i] };
    }
  }
  flush();
  return rects;
}
