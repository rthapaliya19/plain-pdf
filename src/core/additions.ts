/**
 * Everything the person adds on top of the PDF (pen strokes, highlights,
 * and later signatures). The original PDF is never changed; additions are
 * only written into a new copy when saving.
 *
 * Positions are in PDF points (1/72 inch), measured from the top-left corner
 * of the page as it is shown on screen.
 */
import type { EventHub } from "./events";

export interface Stroke {
  kind: "stroke";
  id: string;
  /** 0-based page index. */
  page: number;
  tool: "pen" | "highlighter";
  /** CSS colour, for example "#1d4ed8". */
  color: string;
  /** Line thickness in points. */
  width: number;
  /** Flat list of coordinates: x0, y0, x1, y1, ... */
  points: number[];
  /** Stacking order: higher numbers are drawn on top. */
  order: number;
}

export type Addition = Stroke;

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

  add(...items: Addition[]): void {
    for (const item of items) this.items.set(item.id, item);
    this.changed(items);
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
