/**
 * Reads colours from the drawn page, so an edit's patch matches the paper
 * (white, or the cream of a scan) and the new words match the ink.
 */
import type { Rect } from "../../core/text-layout";

const hex = (r: number, g: number, b: number) =>
  `#${[r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("")}`;

export function sampleColors(
  canvas: HTMLCanvasElement | null,
  page: { width: number; height: number },
  rect: Rect,
): { paper: string; ink: string } {
  const fallback = { paper: "#ffffff", ink: "#1a1a1a" };
  const ctx = canvas?.getContext("2d", { willReadFrequently: true });
  if (!canvas || !ctx || canvas.width === 0) return fallback;
  const sx = canvas.width / page.width;
  const sy = canvas.height / page.height;
  const margin = 3; // points around the area, for the paper colour
  const x0 = Math.max(0, Math.floor((rect.x - margin) * sx));
  const y0 = Math.max(0, Math.floor((rect.y - margin) * sy));
  const x1 = Math.min(canvas.width, Math.ceil((rect.x + rect.w + margin) * sx));
  const y1 = Math.min(canvas.height, Math.ceil((rect.y + rect.h + margin) * sy));
  if (x1 <= x0 || y1 <= y0) return fallback;
  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
  } catch {
    return fallback;
  }
  const w = x1 - x0;
  const inX0 = rect.x * sx - x0;
  const inX1 = (rect.x + rect.w) * sx - x0;
  const inY0 = rect.y * sy - y0;
  const inY1 = (rect.y + rect.h) * sy - y0;
  const ring: number[][] = [[], [], []];
  const inside: [number, number, number, number][] = [];
  for (let i = 0; i < data.length; i += 4) {
    const px = (i / 4) % w;
    const py = Math.floor(i / 4 / w);
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const isInside = px >= inX0 && px < inX1 && py >= inY0 && py < inY1;
    if (isInside) inside.push([r, g, b, 0.299 * r + 0.587 * g + 0.114 * b]);
    else {
      ring[0].push(r);
      ring[1].push(g);
      ring[2].push(b);
    }
  }
  // Paper: the most typical colour just around the area (the median ignores stray marks).
  const median = (v: number[]) => (v.length ? [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)] : 255);
  const paper = ring[0].length ? [median(ring[0]), median(ring[1]), median(ring[2])] : [255, 255, 255];
  const paperLum = 0.299 * paper[0] + 0.587 * paper[1] + 0.114 * paper[2];
  // Ink: the darkest pixels inside (letter edges are blended with the paper, so skip those).
  for (const cut of [0.45, 0.7]) {
    const dark = inside.filter((p) => p[3] < paperLum * cut);
    if (dark.length >= 4) {
      const avg = [0, 1, 2].map((c) => dark.reduce((sum, p) => sum + p[c], 0) / dark.length);
      return { paper: hex(paper[0], paper[1], paper[2]), ink: hex(avg[0], avg[1], avg[2]) };
    }
  }
  return { paper: hex(paper[0], paper[1], paper[2]), ink: fallback.ink };
}
