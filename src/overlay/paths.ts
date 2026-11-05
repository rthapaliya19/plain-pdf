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
