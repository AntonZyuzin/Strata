/**
 * The wire curve of 06 §6.2 on the CPU, the same maths as the vertex shader in
 * wires.ts: hit tests, drop candidates and the knife must test exactly the
 * curve that is drawn (06 §1.3).
 */

/** Cap of the control point distance; a stand-in until spike 9 tunes the curve (S1). */
export const MAX_BEND = 240;
/** The least control point distance: a wire leaves a bubble square to its rim. */
export const MIN_BEND = 16;
/** Control points at half the gap along the flow: an even S (owner, 2026-10-24). */
export const BEND = 0.5;
/** Segments of the polyline, the same as the triangle strip of the shader: no visible kinks. */
export const SEGMENTS = 48;

/**
 * The axis a wire runs along between two bubbles (owner, 2026-10-24): side
 * by side it leaves the side, one above the other — the bottom or the top.
 * A unit vector from the first centre towards the second along that axis.
 */
export function axisOf(dx: number, dy: number): { x: number; y: number } {
  if (Math.abs(dx) >= Math.abs(dy)) return { x: dx >= 0 ? 1 : -1, y: 0 };
  return { x: 0, y: dy >= 0 ? 1 : -1 };
}

export interface WireEnds {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  /** Radii of the source and target bubbles. */
  ra: number;
  rb: number;
  bend?: number;
}

/**
 * Control points: the ends where the axis meets the rims, the tangents along
 * the axis — square to the rim at both ends, an S between them.
 */
export function controls(
  w: WireEnds,
): [number, number, number, number, number, number, number, number] {
  const dx = w.bx - w.ax;
  const dy = w.by - w.ay;
  const u = axisOf(dx, dy);
  const a0 = w.ax + u.x * w.ra;
  const a1 = w.ay + u.y * w.ra;
  const b0 = w.bx - u.x * w.rb;
  const b1 = w.by - u.y * w.rb;
  const along = Math.abs(dx * u.x + dy * u.y) - w.ra - w.rb;
  const h = Math.min(Math.max((w.bend ?? BEND) * Math.max(along, 0), MIN_BEND), MAX_BEND);
  return [a0, a1, a0 + u.x * h, a1 + u.y * h, b0 - u.x * h, b1 - u.y * h, b0, b1];
}

/** Point of the cubic at t, written into `out`. */
export function pointAt(
  c: readonly number[],
  t: number,
  out: { x: number; y: number },
): { x: number; y: number } {
  const u = 1 - t;
  const k0 = u * u * u;
  const k1 = 3 * u * u * t;
  const k2 = 3 * u * t * t;
  const k3 = t * t * t;
  out.x = k0 * (c[0] ?? 0) + k1 * (c[2] ?? 0) + k2 * (c[4] ?? 0) + k3 * (c[6] ?? 0);
  out.y = k0 * (c[1] ?? 0) + k1 * (c[3] ?? 0) + k2 * (c[5] ?? 0) + k3 * (c[7] ?? 0);
  return out;
}

const p = { x: 0, y: 0 };
const q = { x: 0, y: 0 };

/** Closest point of the drawn polyline to (px, py): distance, point and parameter t. */
export function closest(
  w: WireEnds,
  px: number,
  py: number,
): { dist: number; x: number; y: number; t: number } {
  const c = controls(w);
  let best = { dist: Number.POSITIVE_INFINITY, x: 0, y: 0, t: 0 };
  pointAt(c, 0, p);
  for (let i = 1; i <= SEGMENTS; i++) {
    pointAt(c, i / SEGMENTS, q);
    const sx = q.x - p.x;
    const sy = q.y - p.y;
    const l2 = sx * sx + sy * sy;
    const k = l2 > 0 ? Math.max(0, Math.min(1, ((px - p.x) * sx + (py - p.y) * sy) / l2)) : 0;
    const x = p.x + sx * k;
    const y = p.y + sy * k;
    const dist = Math.hypot(px - x, py - y);
    if (dist < best.dist) best = { dist, x, y, t: (i - 1 + k) / SEGMENTS };
    p.x = q.x;
    p.y = q.y;
  }
  return best;
}

/** Bounding box of the curve (control hull), for the spatial index. */
export function bounds(w: WireEnds): { minX: number; minY: number; maxX: number; maxY: number } {
  const c = controls(w);
  return {
    minX: Math.min(c[0], c[2], c[4], c[6]),
    minY: Math.min(c[1], c[3], c[5], c[7]),
    maxX: Math.max(c[0], c[2], c[4], c[6]),
    maxY: Math.max(c[1], c[3], c[5], c[7]),
  };
}
