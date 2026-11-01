import { hexDist } from './hex';

/**
 * The `J` stroke (06 §6.1): held `J`, the left button strokes through two or
 * more bubbles, and they are chained in the order the stroke reached them;
 * wires that are there already are left as they are. One step of undo.
 */

interface Point {
  x: number;
  y: number;
}

/**
 * Where along the segment `p → q` it comes nearest to the bubble at `c`, as
 * a share 0…1 of the segment, when it passes within `reach` of its centre by
 * the hexagon's measure (ADR-0011); null — it passes by. The measure is
 * convex along the segment, so a ternary search finds its least value.
 */
export function touchAt(p: Point, q: Point, c: Point, reach: number): number | null {
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  const at = (t: number) => hexDist(p.x + dx * t - c.x, p.y + dy * t - c.y);
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i++) {
    const a = lo + (hi - lo) / 3;
    const b = hi - (hi - lo) / 3;
    if (at(a) <= at(b)) hi = b;
    else lo = a;
  }
  const t = (lo + hi) / 2;
  return at(t) <= reach ? t : null;
}

/**
 * The chain's wires: each bubble to the next one the stroke reached; no
 * loop, none twice, none that `has` already (05 §8.2).
 */
export function chainWires(
  order: readonly string[],
  has: (from: string, to: string) => boolean,
): [string, string][] {
  const wires: [string, string][] = [];
  const made = new Set<string>();
  for (let i = 1; i < order.length; i++) {
    const from = order[i - 1];
    const to = order[i];
    if (from === undefined || to === undefined || from === to) continue;
    const key = `${from}\u0000${to}`;
    if (made.has(key) || has(from, to)) continue;
    made.add(key);
    wires.push([from, to]);
  }
  return wires;
}
