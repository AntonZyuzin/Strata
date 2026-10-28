import { isCluster, type StarMapExtract } from './extract';
import { clusterRadius, direction, hash32 } from './layout';
import { MODEL } from './relax';

/**
 * The live physics of the star map (08 §3.4, §3.6): who moves when a star
 * is touched, where a new star is born, how fast a thrown one flies. The
 * worker ticks; these decide what it ticks.
 */

/** Bodies the live physics may move at once (08 §8.2, NFR-17). */
export const ACTIVE_LIMIT = 5000;

/**
 * Bodies within `hops` steps of `start` over wires and the nesting springs
 * (08 §3.6: the neighbours pull by their springs, the rest is frozen), the
 * starting ones first; at most `limit`.
 */
export function neighbourhood(
  x: StarMapExtract,
  start: readonly number[],
  hops = 2,
  limit = ACTIVE_LIMIT,
): number[] {
  const adj: number[][] = Array.from({ length: x.count }, () => []);
  for (let e = 0; e < x.edges.length; e += 2) {
    const a = x.edges[e] ?? 0;
    const b = x.edges[e + 1] ?? 0;
    adj[a]?.push(b);
    adj[b]?.push(a);
  }
  for (let b = 0; b < x.count; b++) {
    const p = x.primaryNet[b] ?? -1;
    if (p < 0) continue;
    adj[b]?.push(p);
    adj[p]?.push(b);
  }
  const depth = new Int32Array(x.count).fill(-1);
  const out: number[] = [];
  for (const s of start) {
    if (s < 0 || s >= x.count || depth[s] !== -1) continue;
    depth[s] = 0;
    out.push(s);
  }
  for (let k = 0; k < out.length && out.length < limit; k++) {
    const b = out[k] as number;
    const d = depth[b] ?? 0;
    if (d >= hops) continue;
    for (const n of adj[b] ?? []) {
      if (depth[n] !== -1) continue;
      depth[n] = d + 1;
      out.push(n);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** A frozen mask (1 — stays) with only `free` moving, for the worker. */
export function frozenBut(count: number, free: readonly number[]): Uint8Array {
  const mask = new Uint8Array(count).fill(1);
  for (const b of free) mask[b] = 0;
  return mask;
}

/** FNV-1a of a node's id: a born star's direction does not depend on its body. */
export function idHash(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Where a star born now goes (08 §3.4): by a hash of its id (`idHash`), near the star
 * of its wire's source `from` at a wire's length, or else inside the ball of
 * its network as the initial layout puts it (§3.3) — and a network outside
 * its parent's ball. `pos` holds the others already.
 */
export function bornAt(
  x: StarMapExtract,
  pos: Float32Array,
  b: number,
  key: number,
  from: number | null = null,
): [number, number, number] {
  const [dx, dy, dz] = direction(key, 0);
  if (from !== null && from >= 0 && from < x.count) {
    const r = MODEL.wireLength;
    return [
      (pos[from * 3] ?? 0) + dx * r,
      (pos[from * 3 + 1] ?? 0) + dy * r,
      (pos[from * 3 + 2] ?? 0) + dz * r,
    ];
  }
  const p = x.primaryNet[b] ?? -1;
  if (p < 0) return [0, 0, 0];
  const rp = clusterRadius(x.subtreeSize[p] ?? 1);
  const r = isCluster(x.kind[b] ?? 0)
    ? rp + clusterRadius(x.subtreeSize[b] ?? 1)
    : rp * (0.4 + 0.5 * (hash32(key ^ 0x51ed27, 1) / 4294967296));
  return [
    (pos[p * 3] ?? 0) + dx * r,
    (pos[p * 3 + 1] ?? 0) + dy * r,
    (pos[p * 3 + 2] ?? 0) + dz * r,
  ];
}

/** A sample of a dragged star: where it was, world units, and when, ms. */
export interface DragSample {
  t: number;
  p: [number, number, number];
}

/** Over how long the throw's speed is averaged, ms (08 §3.6). */
export const THROW_WINDOW_MS = 80;

/**
 * The speed of a throw (08 §3.6): the mean over the last 80 ms of the drag,
 * world units per second, no faster than `limit` (`2 · R(N)` per second).
 */
export function throwVelocity(
  samples: readonly DragSample[],
  limit: number,
): [number, number, number] {
  const last = samples.at(-1);
  if (!last) return [0, 0, 0];
  let first = last;
  for (let i = samples.length - 1; i >= 0; i--) {
    const s = samples[i] as DragSample;
    if (last.t - s.t > THROW_WINDOW_MS) break;
    first = s;
  }
  const dt = (last.t - first.t) / 1000;
  if (dt <= 0) return [0, 0, 0];
  let v: [number, number, number] = [
    (last.p[0] - first.p[0]) / dt,
    (last.p[1] - first.p[1]) / dt,
    (last.p[2] - first.p[2]) / dt,
  ];
  const speed = Math.hypot(...v);
  if (speed > limit) v = [(v[0] / speed) * limit, (v[1] / speed) * limit, (v[2] / speed) * limit];
  return v;
}

/** Cooling of the live physics per tick (08 §3.6, «Затухание»). */
export const LIVE_COOLING = 0.97;
/** It stops once the fastest star is slower than this, world units per tick, … */
export const REST_SPEED = 0.01;
/** … for this many ticks in a row. */
export const REST_TICKS = 30;
/** The live physics's first alpha: a touch, not a new layout. */
export const LIVE_ALPHA = 0.3;
/** Ticks of a local relaxation around a new star (08 §3.4). */
export const BORN_TICKS = 60;
