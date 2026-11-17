/** Geometry helpers for freehand strokes. Points are a flat list: x0, y0, x1, y1, ... */

/** Builds a smooth SVG path through the points. */
export function smoothPath(points: number[]): string {
  const n = points.length / 2;
  if (n === 0) return "";
  const f = (v: number) => Math.round(v * 100) / 100;
  if (n === 1) {
    // A single tap: a tiny segment, which the round line ends turn into a dot.
    return `M${f(points[0])} ${f(points[1])}L${f(points[0] + 0.01)} ${f(points[1])}`;
  }
  if (n === 2) return `M${f(points[0])} ${f(points[1])}L${f(points[2])} ${f(points[3])}`;
  // Curves through the midpoints between points, using each point as the
  // control point. This smooths out the small jitters of a hand or mouse.
  let d = `M${f(points[0])} ${f(points[1])}`;
  for (let i = 1; i < n - 1; i++) {
    const x = points[i * 2];
    const y = points[i * 2 + 1];
    const mx = (x + points[i * 2 + 2]) / 2;
    const my = (y + points[i * 2 + 3]) / 2;
    d += `Q${f(x)} ${f(y)} ${f(mx)} ${f(my)}`;
  }
  d += `L${f(points[(n - 1) * 2])} ${f(points[(n - 1) * 2 + 1])}`;
  return d;
}

/** Points looked at together when thinning (keeps the time taken in proportion to the stroke's length). */
const THIN_WINDOW = 1000;

/** Most rounds of corner checks when thinning (each can only add points; one round is usually enough). */
const CORNER_PASSES = 8;

/**
 * Drops points that make no visible difference to a stroke: fewer points
 * make smaller saved files and faster drawing on screen. Points within
 * `tolerance` of the straight line between the points kept around them are
 * dropped (Ramer-Douglas-Peucker). smoothPath curves through the midpoints
 * between points, which would round off a sharp corner (the tip of a tick)
 * once the points beside it are gone, so where the curve would move more
 * than `tolerance`, the points either side of the corner are kept too.
 */
export function thinPoints(points: number[], tolerance: number): number[] {
  const n = points.length / 2;
  if (n <= 3 || !(tolerance > 0)) return points;
  const keep = new Uint8Array(n);
  const limit = tolerance * tolerance;
  for (let first = 0; first < n - 1; first += THIN_WINDOW) {
    const last = Math.min(first + THIN_WINDOW, n - 1);
    keep[first] = keep[last] = 1;
    keepFarthest(points, first, last, limit, keep);
  }
  for (let pass = 0; pass < CORNER_PASSES && keepCorners(points, keep, limit); pass++);
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i * 2], points[i * 2 + 1]);
  return out;
}

/**
 * Where the curve through just the kept points would pass farther than the
 * tolerance (squared: `limit`) from where it passed before, near a kept
 * point, keeps the points either side of it too. True if any were added.
 */
function keepCorners(points: number[], keep: Uint8Array, limit: number): boolean {
  const kept: number[] = [];
  for (let i = 0; i < keep.length; i++) if (keep[i]) kept.push(i);
  const px = (i: number) => points[i * 2];
  const py = (i: number) => points[i * 2 + 1];
  let added = false;
  for (let j = 1; j < kept.length - 1; j++) {
    const v = kept[j];
    const before = kept[j - 1];
    const after = kept[j + 1];
    if (before === v - 1 && after === v + 1) continue; // Nothing dropped here: drawn exactly as before.
    // The middle of the curve around point v, as drawn before...
    const ox = curveMiddle(px(v - 1), px(v), px(v + 1), v === 1);
    const oy = curveMiddle(py(v - 1), py(v), py(v + 1), v === 1);
    // ...and the curve around it now.
    const [sx, sy] = j === 1 ? [px(before), py(before)] : [(px(before) + px(v)) / 2, (py(before) + py(v)) / 2];
    const ex = (px(v) + px(after)) / 2;
    const ey = (py(v) + py(after)) / 2;
    if (curveDist2(ox, oy, sx, sy, px(v), py(v), ex, ey) > limit) {
      keep[v - 1] = keep[v + 1] = 1;
      added = true;
    }
  }
  return added;
}

/**
 * One coordinate of the middle of the curve smoothPath draws around a point,
 * given that coordinate of the point before it, the point and the point after.
 * (`first`: the point before is the stroke's start, which the curve starts
 * from, rather than a midpoint.)
 */
function curveMiddle(before: number, at: number, after: number, first: boolean): number {
  const start = first ? before : (before + at) / 2;
  return (start + 2 * at + (at + after) / 2) / 4;
}

/** Squared distance from (px, py) to the curve from s to e bent towards c (sampled finely enough for this). */
function curveDist2(px: number, py: number, sx: number, sy: number, cx: number, cy: number, ex: number, ey: number): number {
  const STEPS = 16;
  let best = Infinity;
  let ax = sx;
  let ay = sy;
  for (let k = 1; k <= STEPS; k++) {
    const t = k / STEPS;
    const u = 1 - t;
    const bx = u * u * sx + 2 * u * t * cx + t * t * ex;
    const by = u * u * sy + 2 * u * t * cy + t * t * ey;
    best = Math.min(best, segmentDist2(px, py, ax, ay, bx, by));
    ax = bx;
    ay = by;
  }
  return best;
}

/** Ramer-Douglas-Peucker between points `first` and `last`, marking the points to keep. A loop, so long strokes can't overflow the stack. */
function keepFarthest(points: number[], first: number, last: number, limit: number, keep: Uint8Array): void {
  const spans = [first, last];
  while (spans.length > 0) {
    const b = spans.pop()!;
    const a = spans.pop()!;
    let farthest = -1;
    let most = limit;
    for (let i = a + 1; i < b; i++) {
      const d = segmentDist2(points[i * 2], points[i * 2 + 1], points[a * 2], points[a * 2 + 1], points[b * 2], points[b * 2 + 1]);
      if (d > most) {
        most = d;
        farthest = i;
      }
    }
    if (farthest < 0) continue;
    keep[farthest] = 1;
    spans.push(a, farthest, farthest, b);
  }
}

/** Is point (px, py) within `radius` of the line through the points? */
export function hitsStroke(points: number[], px: number, py: number, radius: number): boolean {
  const n = points.length / 2;
  const r2 = radius * radius;
  if (n === 1) return dist2(px, py, points[0], points[1]) <= r2;
  for (let i = 0; i < n - 1; i++) {
    if (segmentDist2(px, py, points[i * 2], points[i * 2 + 1], points[i * 2 + 2], points[i * 2 + 3]) <= r2) {
      return true;
    }
  }
  return false;
}

function dist2(ax: number, ay: number, bx: number, by: number): number {
  return (ax - bx) ** 2 + (ay - by) ** 2;
}

function segmentDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const length2 = dx * dx + dy * dy;
  if (length2 === 0) return dist2(px, py, ax, ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length2));
  return dist2(px, py, ax + t * dx, ay + t * dy);
}
