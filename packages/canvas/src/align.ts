/**
 * Snapping and alignment on the canvas (06 §3 «Сетка и привязка», §9.1):
 * pure geometry, world units. The editor asks it on every move of a drag.
 */

/** What a dragged bubble snaps to (06 §3): its neighbours' centres, the grid, nothing. */
export type SnapMode = 'nodes' | 'grid' | 'off';

/** The grid's step, world units: the nudge's and the dot grid's (06 §17, 07 §7.2). */
export const GRID_STEP = 24;

/** Screen px within which a centre snaps to a neighbour's line (06 §3). */
export const SNAP_PX = 6;

/**
 * The point `p` snapped to the neighbours' centres: x and y each to the
 * nearest neighbour within `reach`, on their own. `gx`, `gy` — the lines it
 * snapped to, for the guides; null — none.
 */
export function snapToNodes(
  p: { x: number; y: number },
  others: Iterable<{ x: number; y: number }>,
  reach: number,
): { x: number; y: number; gx: number | null; gy: number | null } {
  let gx: number | null = null;
  let gy: number | null = null;
  let bx = reach;
  let by = reach;
  for (const o of others) {
    const dx = Math.abs(o.x - p.x);
    const dy = Math.abs(o.y - p.y);
    if (dx <= bx) {
      bx = dx;
      gx = o.x;
    }
    if (dy <= by) {
      by = dy;
      gy = o.y;
    }
  }
  return { x: gx ?? p.x, y: gy ?? p.y, gx, gy };
}

/** The point `p` snapped to the grid of `step`. */
export function snapToGrid(
  p: { x: number; y: number },
  step = GRID_STEP,
): { x: number; y: number } {
  return { x: Math.round(p.x / step) * step, y: Math.round(p.y / step) * step };
}

/**
 * «Выровнять» (06 §9.1): the points in one row through the sample — its y —
 * or in one column — its x. The other coordinate stays.
 */
export function alignTo(
  points: ReadonlyMap<string, { x: number; y: number }>,
  sample: { x: number; y: number },
  line: 'row' | 'column',
): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  for (const [id, p] of points) {
    out.set(id, line === 'row' ? { x: p.x, y: sample.y } : { x: sample.x, y: p.y });
  }
  return out;
}

/**
 * «Распределить» (06 §9.1): the points evenly along an axis between the
 * first and the last of them, in their order along it; the other
 * coordinate stays. Fewer than three: as they are.
 */
export function distribute(
  points: ReadonlyMap<string, { x: number; y: number }>,
  axis: 'x' | 'y',
): Map<string, { x: number; y: number }> {
  const out = new Map([...points].map(([id, p]) => [id, { ...p }]));
  if (points.size < 3) return out;
  const order = [...points].sort((a, b) => a[1][axis] - b[1][axis] || (a[0] < b[0] ? -1 : 1));
  const first = (order[0] as [string, { x: number; y: number }])[1][axis];
  const last = (order.at(-1) as [string, { x: number; y: number }])[1][axis];
  const step = (last - first) / (order.length - 1);
  order.forEach(([id], i) => {
    const p = out.get(id);
    if (p) p[axis] = first + step * i;
  });
  return out;
}
