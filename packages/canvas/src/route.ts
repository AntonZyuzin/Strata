import type { Graph } from '@strata/backend';
import { bounds, closest, crossing, type WireEnds } from './curve';

/**
 * A wire through the dots of its route (05 §9.2, 06 §6.6) as pieces: from
 * its source to the first dot, from dot to dot, from the last dot to its
 * target. A piece is one cubic of `curve.ts`, so drawing, hit tests, drop
 * candidates and the scissors see the same curve (06 §1.3). A dot end has
 * no corner: the curve meets the dot along its chord.
 */

/** A point a wire passes: a bubble — its centre and circumradius — or a dot. */
export interface PathEnd {
  /** The node's id, or the dot's `dotKey`. */
  key: string;
  x: number;
  y: number;
  r: number;
  dot: boolean;
}

/** A dot's key among a wire's points: never a node's id (05 §4.1). */
export function dotKey(id: string): string {
  return `•${id}`;
}

/** Where things are drawn now: a bubble's centre and radius, a dot's centre. */
export interface Places {
  node(id: string): { x: number; y: number; r: number } | null;
  dot(id: string): { x: number; y: number } | null;
}

/** The points of wire `from → to`: its source, its dots here, its target; null when an end is not drawn. */
export function pathOf(graph: Graph, from: string, to: string, at: Places): PathEnd[] | null {
  const a = at.node(from);
  const b = at.node(to);
  if (!a || !b) return null;
  const out: PathEnd[] = [{ key: from, x: a.x, y: a.y, r: a.r, dot: false }];
  for (const id of graph.route(from, to)) {
    const d = at.dot(id);
    if (d) out.push({ key: dotKey(id), x: d.x, y: d.y, r: 0, dot: true });
  }
  out.push({ key: to, x: b.x, y: b.y, r: b.r, dot: false });
  return out;
}

/** The curve of the piece between two neighbouring points of a wire (06 §6.2). */
export function pieceEnds(a: PathEnd, b: PathEnd, straight: boolean): WireEnds {
  return {
    ax: a.x,
    ay: a.y,
    bx: b.x,
    by: b.y,
    ra: a.r,
    rb: b.r,
    straight,
    dotA: a.dot,
    dotB: b.dot,
  };
}

/** Wire `from → to` as the curves of its pieces; none when an end is not drawn. */
export function wirePieces(
  graph: Graph,
  from: string,
  to: string,
  at: Places,
  straight: boolean,
): WireEnds[] {
  const p = pathOf(graph, from, to, at);
  if (!p) return [];
  const out: WireEnds[] = [];
  for (let i = 1; i < p.length; i++) {
    out.push(pieceEnds(p[i - 1] as PathEnd, p[i] as PathEnd, straight));
  }
  return out;
}

/** A piece of the drawing by its ends: a node's id or a dot's `dotKey`, and the wires it carries. */
export interface PieceKeys {
  key: string;
  a: string;
  b: string;
  wires: [string, string][];
}

/**
 * The pieces the wires draw: the way several wires share — from their
 * source to a dot they all go through — is one piece, drawn once, so a
 * branch's trunk is no brighter than a wire. A wire without dots is one
 * piece, keyed as the wire is (`from`, NUL, `to`). Dots `hasDot` does not
 * know are skipped, as the core skips them (05 §9.2).
 */
export function pieceKeys(
  graph: Graph,
  edges: readonly (readonly [string, string])[],
  hasDot: (id: string) => boolean,
): PieceKeys[] {
  const byKey = new Map<string, PieceKeys>();
  for (const [from, to] of edges) {
    const points = [from, ...graph.route(from, to).filter(hasDot).map(dotKey), to];
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1] as string;
      const b = points[i] as string;
      const key = `${a}\u0000${b}`;
      const piece = byKey.get(key);
      if (piece) piece.wires.push([from, to]);
      else byKey.set(key, { key, a, b, wires: [[from, to]] });
    }
  }
  return [...byKey.values()];
}

/** The id of the dot a piece's end key names; null for a node's. */
export function dotOfKey(key: string): string | null {
  return key.startsWith('•') ? key.slice(1) : null;
}

/** The point of a wire's pieces closest to (x, y): its distance, which piece, and t on it. */
export function closestOn(
  pieces: readonly WireEnds[],
  x: number,
  y: number,
): { dist: number; x: number; y: number; piece: number; t: number } {
  let best = { dist: Number.POSITIVE_INFINITY, x: 0, y: 0, piece: 0, t: 0 };
  pieces.forEach((w, piece) => {
    const c = closest(w, x, y);
    if (c.dist < best.dist) best = { ...c, piece };
  });
  return best;
}

/** Where the segment p → q crosses a wire's pieces (06 §6.7); null when it does not. */
export function crossingOn(
  pieces: readonly WireEnds[],
  px: number,
  py: number,
  qx: number,
  qy: number,
): (NonNullable<ReturnType<typeof crossing>> & { piece: number }) | null {
  for (let piece = 0; piece < pieces.length; piece++) {
    const c = crossing(pieces[piece] as WireEnds, px, py, qx, qy);
    if (c) return { ...c, piece };
  }
  return null;
}

/** The bounding box of a wire's pieces, for the spatial index. */
export function boundsOn(pieces: readonly WireEnds[]): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  let box = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  pieces.forEach((w, i) => {
    const b = bounds(w);
    box =
      i === 0
        ? b
        : {
            minX: Math.min(box.minX, b.minX),
            minY: Math.min(box.minY, b.minY),
            maxX: Math.max(box.maxX, b.maxX),
            maxY: Math.max(box.maxY, b.maxY),
          };
  });
  return box;
}
