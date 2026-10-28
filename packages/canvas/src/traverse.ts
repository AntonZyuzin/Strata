import type { Graph } from '@strata/backend';

/**
 * Walking the network from the keyboard (06 §10.3): the arrows go to the
 * nearest node in their direction, `PgUp` / `PgDn` along the chain to an
 * input or an output, `Shift+PgUp` / `Shift+PgDn` to the neighbours fed by
 * the same input. Ghosts are no nodes (05 §8.5): no key lands on one.
 */

export type Dir = 'left' | 'right' | 'up' | 'down';

interface Point {
  id: string;
  x: number;
  y: number;
}

const UNIT: Record<Dir, readonly [number, number]> = {
  left: [-1, 0],
  right: [1, 0],
  up: [0, -1],
  down: [0, 1],
};

/** Across the direction at most this many times along it: a cone of about 60°. */
const CONE = Math.tan((60 * Math.PI) / 180);

function nodesOf(graph: Graph): Point[] {
  return [...graph.nodes.values()].filter((n) => !n.ghostOf);
}

/**
 * The node nearest to `from` in direction `dir`: ahead of it, within the
 * cone, by the distance along plus twice the distance across — a node
 * straight ahead wins over a nearer one off to the side.
 */
export function nearestInDirection(
  from: { x: number; y: number },
  dir: Dir,
  nodes: Iterable<Point>,
  skip?: string,
): string | null {
  const [ux, uy] = UNIT[dir];
  let best: { id: string; score: number } | null = null;
  for (const n of nodes) {
    if (n.id === skip) continue;
    const dx = n.x - from.x;
    const dy = n.y - from.y;
    const along = dx * ux + dy * uy;
    const across = Math.abs(dx * uy - dy * ux);
    if (along <= 0 || across > along * CONE) continue;
    const score = along + 2 * across;
    if (!best || score < best.score) best = { id: n.id, score };
  }
  return best?.id ?? null;
}

/** The node nearest to a point: the arrows start there with nothing selected. */
export function nearestTo(p: { x: number; y: number }, nodes: Iterable<Point>): string | null {
  let best: { id: string; d: number } | null = null;
  for (const n of nodes) {
    const d = Math.hypot(n.x - p.x, n.y - p.y);
    if (!best || d < best.d) best = { id: n.id, d };
  }
  return best?.id ?? null;
}

/** The arrow's step from `id`, or from the point `centre` with no node chosen. */
export function arrowStep(
  graph: Graph,
  id: string | null,
  dir: Dir,
  centre: { x: number; y: number },
): string | null {
  const nodes = nodesOf(graph);
  const from = id ? graph.nodes.get(id) : undefined;
  if (!from || from.ghostOf) return nearestTo(centre, nodes);
  return nearestInDirection(from, dir, nodes, from.id);
}

/**
 * `PgUp` / `PgDn` (06 §10.3 «По цепочке»): up to an input, down to an output;
 * of several, the one most in that direction, else the nearest.
 */
export function chainStep(graph: Graph, id: string, up: boolean): string | null {
  const from = graph.nodes.get(id);
  if (!from) return null;
  const ends = (up ? graph.inputs(id) : graph.outputs(id))
    .map((e) => graph.nodes.get(e))
    .filter((n): n is NonNullable<typeof n> => !!n && !n.ghostOf);
  if (ends.length === 0) return null;
  return nearestInDirection(from, up ? 'up' : 'down', ends) ?? nearestTo(from, ends);
}

/**
 * `Shift+PgUp` / `Shift+PgDn` (06 §10.3 «По соседям»): the previous or next
 * of the nodes fed by the same inputs, left to right; none past the ends.
 */
export function siblingStep(graph: Graph, id: string, next: boolean): string | null {
  const ids = new Set<string>();
  for (const p of graph.inputs(id)) for (const o of graph.outputs(p)) ids.add(o);
  const row = [...ids]
    .map((s) => graph.nodes.get(s))
    .filter((n): n is NonNullable<typeof n> => !!n && !n.ghostOf)
    .sort((a, b) => a.x - b.x || a.y - b.y || a.id.localeCompare(b.id));
  const at = row.findIndex((n) => n.id === id);
  if (at < 0) return null;
  return row[at + (next ? 1 : -1)]?.id ?? null;
}
