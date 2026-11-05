/**
 * Page operations (rotate, delete, move, add, pick) on the page list,
 * keeping every addition on its page: additions follow their page when it
 * moves, turn with it when it rotates, and go when it's deleted.
 */
import type { Addition } from "./additions";
import type { Rect } from "./text-layout";
import type { PageEntry, PagePlan } from "./workspace";
import type { PageSize } from "./pdf-engine";

export interface PagesState {
  plan: PageEntry[];
  additions: Addition[];
}

/** Turns the chosen pages clockwise by `turnBy` (90, 180 or 270). `sizes` are the current page sizes. */
export function rotatePages(state: PagesState, pages: number[], turnBy: number, sizes: readonly PageSize[]): PagesState {
  const chosen = new Set(pages);
  const plan = state.plan.map((e, i) => (chosen.has(i) ? { ...e, rotation: (((e.rotation + turnBy) % 360) + 360) % 360 } : e));
  const additions = state.additions.map((a) => (chosen.has(a.page) ? rotateAddition(a, sizes[a.page], turnBy) : a));
  return { plan, additions };
}

export function deletePages(state: PagesState, pages: number[]): PagesState {
  const gone = new Set(pages);
  const newIndex = new Map<number, number>();
  state.plan.forEach((_, i) => {
    if (!gone.has(i)) newIndex.set(i, newIndex.size);
  });
  return {
    plan: state.plan.filter((_, i) => !gone.has(i)),
    additions: state.additions.filter((a) => !gone.has(a.page)).map((a) => ({ ...a, page: newIndex.get(a.page)! })),
  };
}

/**
 * Moves the chosen pages (keeping their order) so they sit before position
 * `before` of the original list (`before` = page count puts them at the end).
 */
export function movePages(state: PagesState, pages: number[], before: number): PagesState {
  const chosen = [...new Set(pages)].sort((a, b) => a - b);
  const set = new Set(chosen);
  const order: number[] = [];
  for (let i = 0; i <= state.plan.length; i++) {
    if (i === before) order.push(...chosen);
    if (i < state.plan.length && !set.has(i)) order.push(i);
  }
  const newIndex = new Map(order.map((old, i) => [old, i]));
  return {
    plan: order.map((old) => state.plan[old]),
    additions: state.additions.map((a) => ({ ...a, page: newIndex.get(a.page)! })),
  };
}

export function appendPages(state: PagesState, entries: PageEntry[]): PagesState {
  return { plan: [...state.plan, ...entries], additions: state.additions };
}

/** Just the chosen pages (for "Save selected pages as a new PDF"). */
export function pickPages(state: PagesState, pages: number[]): PagesState {
  const chosen = [...new Set(pages)].sort((a, b) => a - b);
  const newIndex = new Map(chosen.map((old, i) => [old, i]));
  return {
    plan: chosen.map((i) => state.plan[i]),
    additions: state.additions.filter((a) => newIndex.has(a.page)).map((a) => ({ ...a, page: newIndex.get(a.page)! })),
  };
}

export function samePlan(a: PagePlan, b: PagePlan): boolean {
  return a.length === b.length && a.every((e, i) => e.source === b[i].source && e.index === b[i].index && e.rotation === b[i].rotation);
}

// ---------- Turning additions with their page ----------

/** Where point (x, y) lands when a page of size w x h turns clockwise by `turnBy`. */
function turnPoint(x: number, y: number, w: number, h: number, turnBy: number): [number, number] {
  switch (((turnBy % 360) + 360) % 360) {
    case 90:
      return [h - y, x];
    case 180:
      return [w - x, h - y];
    case 270:
      return [y, w - x];
    default:
      return [x, y];
  }
}

function turnRect(r: Rect, w: number, h: number, turnBy: number): Rect {
  const [ax, ay] = turnPoint(r.x, r.y, w, h, turnBy);
  const [bx, by] = turnPoint(r.x + r.w, r.y + r.h, w, h, turnBy);
  return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) };
}

export function rotateAddition(a: Addition, size: PageSize, turnBy: number): Addition {
  const { width: w, height: h } = size;
  if (a.kind === "stroke") {
    const points: number[] = [];
    for (let i = 0; i < a.points.length; i += 2) points.push(...turnPoint(a.points[i], a.points[i + 1], w, h, turnBy));
    return { ...a, points };
  }
  if (a.kind === "highlight") return { ...a, rects: a.rects.map((r) => turnRect(r, w, h, turnBy)) };
  const box = turnRect({ x: a.x, y: a.y, w: a.width, h: a.height }, w, h, turnBy);
  return { ...a, x: box.x, y: box.y, width: box.w, height: box.h, turn: (((a.turn ?? 0) + turnBy) % 360 + 360) % 360 };
}
