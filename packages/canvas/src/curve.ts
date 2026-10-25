import { cornerToward } from './hex';

/**
 * The wire curve of 06 §6.2 on the CPU. The wire layer draws these control
 * points as they are (wires.ts), so hit tests, drop candidates, the scissors
 * and the sockets test exactly the curve that is drawn (06 §1.3).
 */

/** Cap of the control point distance; a stand-in until spike 9 tunes the curve (S1). */
export const MAX_BEND = 240;
/** The least control point distance: a wire leaves its corner along it before it bends. */
export const MIN_BEND = 16;
/** Control points at half the gap along the flow: an even S (owner, 2026-10-24). */
export const BEND = 0.5;
/** Segments of the polyline, the same as the triangle strip of the shader: no visible kinks. */
export const SEGMENTS = 48;

export interface WireEnds {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  /** Circumradii of the source and target hexagons (ADR-0011). */
  ra: number;
  rb: number;
  bend?: number;
  /** The network's style is «Прямая» (06 §6.2): a segment from corner to corner. */
  straight?: boolean;
}

/** The control points of a wire: [x0, y0, x1, y1, x2, y2, x3, y3], world units. */
export type Controls = [number, number, number, number, number, number, number, number];

/**
 * Control points (ADR-0011): each end sits on the corner of its hexagon that
 * faces the other node; a Bézier wire leaves and enters along those corners,
 * its control points at half the gap between them — an S. A straight wire
 * is the segment between the corners, its control points at the thirds: the
 * same cubic maths draws, hits and cuts both.
 */
export function controls(w: WireEnds): Controls {
  const dx = w.bx - w.ax;
  const dy = w.by - w.ay;
  const ua = cornerToward(dx, dy);
  const ub = cornerToward(-dx, -dy);
  const a0 = w.ax + ua.x * w.ra;
  const a1 = w.ay + ua.y * w.ra;
  const b0 = w.bx + ub.x * w.rb;
  const b1 = w.by + ub.y * w.rb;
  if (w.straight) {
    const tx = (b0 - a0) / 3;
    const ty = (b1 - a1) / 3;
    return [a0, a1, a0 + tx, a1 + ty, b0 - tx, b1 - ty, b0, b1];
  }
  const gap = Math.hypot(b0 - a0, b1 - a1);
  const h = Math.min(Math.max((w.bend ?? BEND) * gap, MIN_BEND), MAX_BEND);
  return [a0, a1, a0 + ua.x * h, a1 + ua.y * h, b0 + ub.x * h, b1 + ub.y * h, b0, b1];
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

/**
 * Where the segment p → q crosses the drawn polyline of the wire (06 §6.7,
 * scissors): the crossing point, the wire's direction there and its
 * parameter t; null when it does not cross.
 */
export function crossing(
  w: WireEnds,
  px: number,
  py: number,
  qx: number,
  qy: number,
): { x: number; y: number; dx: number; dy: number; t: number } | null {
  const c = controls(w);
  const rx = qx - px;
  const ry = qy - py;
  pointAt(c, 0, p);
  for (let i = 1; i <= SEGMENTS; i++) {
    pointAt(c, i / SEGMENTS, q);
    const sx = q.x - p.x;
    const sy = q.y - p.y;
    const den = rx * sy - ry * sx;
    if (den !== 0) {
      // p + k·r = a + m·s, both k and m in [0, 1].
      const ax = p.x - px;
      const ay = p.y - py;
      const k = (ax * sy - ay * sx) / den;
      const m = (ax * ry - ay * rx) / den;
      if (k >= 0 && k <= 1 && m >= 0 && m <= 1) {
        const len = Math.hypot(sx, sy) || 1;
        return {
          x: p.x + sx * m,
          y: p.y + sy * m,
          dx: sx / len,
          dy: sy / len,
          t: (i - 1 + m) / SEGMENTS,
        };
      }
    }
    p.x = q.x;
    p.y = q.y;
  }
  return null;
}
