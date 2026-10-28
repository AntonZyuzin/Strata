import type { CoreOp, NetworkView, NodeKind, TreeItem } from '@strata/backend';
import { radiusOf } from '@strata/canvas';
import { FLAG } from '@strata/view3d/map';
import type { MapItem } from '../proto/map3d';
import { nearDue } from './due';

/**
 * The star map's steps written by the core (08 §6.4, §6.7): where a node
 * made on the map lies in its network's 2D layout, what removing a star
 * does to its wires, the path of a cluster, the map's items from the tree.
 */

/** 06 §5.4: under the parent, a row down; clear of the others by the gap. */
const PLACE_DOWN = 110;
const PLACE_GAP = 16;

interface Placed {
  id: string;
  kind: NodeKind;
  x: number;
  y: number;
  flags?: readonly string[] | undefined;
}

const radius = (n: Placed) => radiusOf({ kind: n.kind, key: n.flags?.includes('key') ?? false });

/**
 * autoPlace (06 §5.4) on a network not on the canvas: under the parent `from`
 * right of its last child below it; with no parent, right of what is there;
 * then a spiral by r(M) to a spot nothing is nearer to than the gap.
 */
export function placeIn(
  nodes: readonly Placed[],
  edges: readonly { from: string; to: string }[],
  from: string | null,
  kind: NodeKind,
): { x: number; y: number } {
  const r = radiusOf({ kind, key: false });
  const free = (px: number, py: number) =>
    nodes.every((n) => Math.hypot(n.x - px, n.y - py) >= radius(n) + r + PLACE_GAP + 20);
  const spot = (x: number, y: number) => {
    if (free(x, y)) return { x, y };
    for (let ring = 1; ring < 40; ring++) {
      const steps = ring * 8;
      for (let k = 0; k < steps; k++) {
        const a = (k / steps) * Math.PI * 2;
        const px = x + Math.cos(a) * ring * 24;
        const py = y + Math.sin(a) * ring * 24;
        if (free(px, py)) return { x: px, y: py };
      }
    }
    return { x, y };
  };
  const p = from ? nodes.find((n) => n.id === from) : undefined;
  if (p) {
    let x = p.x;
    for (const e of edges) {
      if (e.from !== p.id) continue;
      const c = nodes.find((n) => n.id === e.to);
      if (c && c.y > p.y && c.x + radius(c) + r + PLACE_GAP >= x) {
        x = c.x + radius(c) + r + PLACE_GAP * 3;
      }
    }
    return spot(x, p.y + PLACE_DOWN);
  }
  if (nodes.length === 0) return { x: 0, y: 0 };
  const maxX = Math.max(...nodes.map((n) => n.x + radius(n)));
  const cy = nodes.reduce((a, n) => a + n.y, 0) / nodes.length;
  return spot(maxX + 3 * r, cy);
}

/**
 * `Delete` on a star (08 §6.7, 05 §8.4): its wires seen in network `net` are
 * cut, and with one input there the chain heals — that input to every
 * output; then «Убрать отсюда», or «Удалить везде» to the trash.
 */
export function removeOps(id: string, view: NetworkView, everywhere: boolean): CoreOp[] {
  const here = new Set(view.nodes.map((n) => n.id));
  const ins = view.edges.filter((e) => e.to === id && e.from !== id && here.has(e.from));
  const outs = view.edges.filter((e) => e.from === id && e.to !== id && here.has(e.to));
  const ops: CoreOp[] = [];
  for (const e of [...ins, ...outs]) ops.push({ op: 'disconnect', from: e.from, to: e.to });
  const sources = [...new Set(ins.map((e) => e.from))];
  const [p] = sources.length === 1 ? sources : [];
  if (p !== undefined) {
    for (const e of outs) if (e.to !== p) ops.push({ op: 'connect', from: p, to: e.to });
  }
  ops.push(everywhere ? { op: 'trash', ids: [id] } : { op: 'unplace', id, net: view.net });
  return ops;
}

/** From the root to `id` by primary networks: `[id, name]`, as a network's path is. */
export function pathTo(tree: readonly TreeItem[], id: string): [string, string][] {
  const by = new Map(tree.map((i) => [i.id, i]));
  const out: [string, string][] = [];
  const seen = new Set<string>();
  for (
    let at = by.get(id);
    at && !seen.has(at.id);
    at = at.parent ? by.get(at.parent) : undefined
  ) {
    seen.add(at.id);
    out.unshift([at.id, at.name]);
  }
  return out;
}

/** The tree's items as the map draws them: flags as bits, a near deadline's state (08 §4.3). */
export function mapItems(tree: readonly TreeItem[], day?: string): MapItem[] {
  return tree.map((i) => {
    let flags = 0;
    if (i.flags?.includes('key')) flags |= FLAG.key;
    if (i.flags?.includes('pause')) flags |= FLAG.pause;
    if (i.flags?.includes('template')) flags |= FLAG.template;
    // The same near or past deadline the canvas marks (07 §4.6, Q-07-22).
    const due = i.deadline ? (day ? nearDue(i.deadline, day) : nearDue(i.deadline)) : null;
    return {
      id: i.id,
      kind: i.kind,
      parent: i.parent,
      status: i.status,
      name: i.name,
      deadline: i.deadline,
      flags,
      ...(due ? { due } : {}),
    };
  });
}
