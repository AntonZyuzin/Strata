import { FLAG, isCluster, type StarMapExtract } from './extract';

/**
 * Initial layout of the star map (08 §3.3): every body is placed next to the
 * star of its primary network, in a direction given by a hash of its ID and
 * the seed — not by its rank among siblings, so a new neighbour moves no one.
 * Networks sit outside their parent's ball, other kinds inside it. The map is
 * readable at once; the force simulation (physics.ts) refines it later.
 */

/** Cluster radius of network N (08 §3.2): the volume grows with the subtree, density stays. */
export function clusterRadius(subtreeSize: number): number {
  return 40 * Math.cbrt(1 + subtreeSize);
}

/** Mass of a body (08 §3.2): key nodes and well-connected ones push harder. */
export function mass(flags: number, degree: number): number {
  return 1 + 0.5 * ((flags & FLAG.key) !== 0 ? 1 : 0) + 0.25 * Math.log2(1 + degree);
}

/** 32-bit mix of a seed and an index (murmur3 finaliser): stable across engines. */
export function hash32(seed: number, i: number): number {
  let h = (seed ^ Math.imul(i + 0x9e3779b9, 0x85ebca6b)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

const unit = (h: number) => h / 4294967296;

/** A direction on the unit sphere from two hashes, uniform over the sphere. */
export function direction(seed: number, i: number): [number, number, number] {
  const z = 2 * unit(hash32(seed, 2 * i)) - 1;
  const phi = 2 * Math.PI * unit(hash32(seed, 2 * i + 1));
  const s = Math.sqrt(Math.max(0, 1 - z * z));
  return [s * Math.cos(phi), s * Math.sin(phi), z];
}

/** Positions 3·N for the extract (08 §3.3 `layoutFull` before `simulate`). */
export function initialLayout(x: StarMapExtract, seed: number): Float32Array {
  const pos = new Float32Array(x.count * 3);
  for (let i = 1; i < x.count; i++) {
    const p = x.primaryNet[i] ?? -1;
    if (p < 0) continue;
    const rp = clusterRadius(x.subtreeSize[p] ?? 1);
    const [dx, dy, dz] = direction(seed, i);
    const r = isCluster(x.kind[i] ?? 0)
      ? rp + clusterRadius(x.subtreeSize[i] ?? 1)
      : rp * (0.4 + 0.5 * unit(hash32(seed ^ 0x51ed27, i)));
    pos[i * 3] = (pos[p * 3] ?? 0) + dx * r;
    pos[i * 3 + 1] = (pos[p * 3 + 1] ?? 0) + dy * r;
    pos[i * 3 + 2] = (pos[p * 3 + 2] ?? 0) + dz * r;
  }
  return pos;
}

/** Degrees of the wire graph, for masses and for picking the active zone. */
export function degrees(x: StarMapExtract): Uint16Array {
  const d = new Uint16Array(x.count);
  for (let e = 0; e < x.edges.length; e++) {
    const v = x.edges[e] ?? 0;
    d[v] = Math.min(65535, (d[v] ?? 0) + 1);
  }
  return d;
}
