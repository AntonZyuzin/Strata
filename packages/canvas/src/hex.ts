/**
 * The node's hexagon (ADR-0011): a regular hexagon with a point up, its
 * corners at 12 and 6 o'clock, the circumradius the old circle's radius r.
 * One source for every place that once assumed a circle: where wires leave
 * (its corners), the hit test, the rims and rings, the pause hatching, the
 * picture cut, the gecko's walk. Angles here are the canvas's: from 3
 * o'clock, clockwise (y points down).
 */

/** Inradius over circumradius. */
export const HEX_IN = Math.sqrt(3) / 2;

const SIXTH = Math.PI / 3;
/**
 * Directions are turned this much clockwise before choosing a corner: a pair
 * on an exact tie (side by side, say) picks the same way at both ends, so the
 * wire is an S, and the GPU's float32 cannot flip the choice.
 */
const TIE = 1e-4;

/**
 * The hexagonal distance of (dx, dy) from the centre: the inradius of the
 * hexagon through that point. Inside a hexagon of circumradius r when ≤ r·HEX_IN;
 * nested hexagons this far apart are as far apart across their sides.
 */
export function hexDist(dx: number, dy: number): number {
  const a = 0.5 * dx;
  const b = HEX_IN * dy;
  return Math.max(Math.abs(dx), Math.abs(a + b), Math.abs(a - b));
}

/** Corner k (0…5) as a unit vector: k = 0 at 4 o'clock (30°), then clockwise; 4 is the top. */
export function cornerAt(k: number): { x: number; y: number } {
  const a = Math.PI / 6 + k * SIXTH;
  return { x: Math.cos(a), y: Math.sin(a) };
}

/** The corner that faces (dx, dy) (ADR-0011 rule 1), as its index. */
export function cornerIndex(dx: number, dy: number): number {
  const th = (dx === 0 && dy === 0 ? 0 : Math.atan2(dy, dx)) + TIE;
  const k = Math.round((th - Math.PI / 6) / SIXTH);
  return ((k % 6) + 6) % 6;
}

/** The corner that faces (dx, dy), as a unit vector from the centre. */
export function cornerToward(dx: number, dy: number): { x: number; y: number } {
  return cornerAt(cornerIndex(dx, dy));
}

/** Distance from the centre to the outline along `angle`, for circumradius 1. */
export function rimAt(angle: number): number {
  return HEX_IN / hexDist(Math.cos(angle), Math.sin(angle));
}

/**
 * The angle from 12 o'clock, clockwise, at which a share of the perimeter
 * measured from the top corner ends: progress arcs run along the outline,
 * not by angle (07 §4.3).
 */
export function perimeterAngle(share: number): number {
  const f = Math.min(Math.max(share, 0), 1) * 6;
  const k = Math.min(Math.floor(f), 5);
  const u = f - k;
  // Along side k the outline is at Rin / cos(local), local = a − (k + ½)·60°.
  return k * SIXTH + SIXTH / 2 + Math.atan((2 * u - 1) / Math.sqrt(3));
}

/** The corners of the hexagon of circumradius r at (cx, cy), flat: [x0, y0, x1, y1, …]. */
export function hexCorners(cx: number, cy: number, r: number): number[] {
  const out: number[] = [];
  for (let k = 0; k < 6; k++) {
    const c = cornerAt(k);
    out.push(cx + c.x * r, cy + c.y * r);
  }
  return out;
}

/** The outline as a path on a 2D canvas: textures and the picture cut. */
export function hexPath(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
): CanvasRenderingContext2D {
  ctx.beginPath();
  for (let k = 0; k < 6; k++) {
    const c = cornerAt(k);
    if (k === 0) ctx.moveTo(cx + c.x * r, cy + c.y * r);
    else ctx.lineTo(cx + c.x * r, cy + c.y * r);
  }
  ctx.closePath();
  return ctx;
}

/**
 * The part of the line through (px, py) along the unit (ux, uy) inside the
 * hexagon of circumradius r at (cx, cy), as parameters [t0, t1] along it;
 * null when it misses. The pause hatching is cut to the outline so.
 */
export function chordOf(
  cx: number,
  cy: number,
  r: number,
  px: number,
  py: number,
  ux: number,
  uy: number,
): [number, number] | null {
  let t0 = Number.NEGATIVE_INFINITY;
  let t1 = Number.POSITIVE_INFINITY;
  const rin = r * HEX_IN;
  // Three pairs of opposite sides: |(p + t·u − c) · n| ≤ rin.
  for (const [nx, ny] of [
    [1, 0],
    [0.5, HEX_IN],
    [0.5, -HEX_IN],
  ] as const) {
    const o = (px - cx) * nx + (py - cy) * ny;
    const d = ux * nx + uy * ny;
    if (Math.abs(d) < 1e-12) {
      if (Math.abs(o) > rin) return null;
      continue;
    }
    const a = (-rin - o) / d;
    const b = (rin - o) / d;
    t0 = Math.max(t0, Math.min(a, b));
    t1 = Math.min(t1, Math.max(a, b));
  }
  return t0 < t1 ? [t0, t1] : null;
}
