import { createForce3d, type ForceParams, type ForceSprings } from '@strata/layout';
import type { StarMapExtract } from './extract';
import { clusterRadius, degrees, mass, NEST_LENGTH } from './layout';

/**
 * The star map's physics as the app runs it (08 §3.2, ADR-0005): the force
 * model, its springs, and a full layout on `strata-layout` in WASM. The
 * comparison of candidates of spike 2 lives in physics.ts; this module is
 * what the map and the benchmark use. Call `loadLayout` (`@strata/layout`)
 * first; in the app the layout runs in its worker (`@strata/layout/worker`).
 */

/** 08 §3.2: repulsion, nesting spring, wire springs, collision, centring, damping. */
export const MODEL = {
  repulsion: 30,
  theta: 0.8,
  nestStrength: 0.08,
  nestLength: NEST_LENGTH,
  wireLength: 60,
  wireInside: 0.02,
  wireBetween: 0.005,
  collide: 18,
  centre: 0.001,
  /** A weak pull towards each cluster a node also appears in: 0.3 of nesting's (08 §2.3, §3.2). */
  appearStrength: 0.3 * 0.08,
  /** Velocity × 0.6 per tick. */
  velocityDecay: 0.4,
} as const;

export interface Spring {
  a: number;
  b: number;
  length: number;
  k: number;
}

/** Bodies (a subset or all) and the springs between them, in subset indices. */
export function springsOf(x: StarMapExtract, bodies: Int32Array): Spring[] {
  const local = new Int32Array(x.count).fill(-1);
  bodies.forEach((b, i) => {
    local[b] = i;
  });
  const out: Spring[] = [];
  for (let k = 0; k < bodies.length; k++) {
    const b = bodies[k] ?? 0;
    const p = x.primaryNet[b] ?? -1;
    const lp = p >= 0 ? (local[p] ?? -1) : -1;
    if (lp >= 0) {
      out.push({
        a: k,
        b: lp,
        length: MODEL.nestLength * clusterRadius(x.subtreeSize[p] ?? 1),
        k: MODEL.nestStrength,
      });
    }
  }
  for (let e = 0; e < x.edges.length; e += 2) {
    const ga = x.edges[e] ?? 0;
    const gb = x.edges[e + 1] ?? 0;
    const a = local[ga] ?? -1;
    const b = local[gb] ?? -1;
    if (a < 0 || b < 0) continue;
    const inside = x.primaryNet[ga] === x.primaryNet[gb];
    out.push({
      a,
      b,
      length: MODEL.wireLength,
      k: inside ? MODEL.wireInside : MODEL.wireBetween,
    });
  }
  // Shared nodes drift to the clusters' borders: «bridges» between projects (08 §2.3).
  const appear = x.appear ?? new Uint32Array(0);
  for (let e = 0; e < appear.length; e += 2) {
    const node = appear[e] ?? 0;
    const net = appear[e + 1] ?? 0;
    const a = local[node] ?? -1;
    const b = local[net] ?? -1;
    if (a < 0 || b < 0) continue;
    // At the cluster's radius R(N'): on its border (08 §3.2).
    out.push({
      a,
      b,
      length: clusterRadius(x.subtreeSize[net] ?? 1),
      k: MODEL.appearStrength,
    });
  }
  return out;
}

/** What the force layout needs besides positions: masses, springs, settings (08 §3.2). */
export function relaxInputs(x: StarMapExtract): {
  mass: Float32Array;
  springs: ForceSprings;
  params: ForceParams;
} {
  const all = Int32Array.from({ length: x.count }, (_, i) => i);
  const springs = springsOf(x, all);
  const deg = degrees(x);
  return {
    mass: Float32Array.from(all, (b) => mass(x.flags[b] ?? 0, deg[b] ?? 0)),
    springs: {
      a: Uint32Array.from(springs, (s) => s.a),
      b: Uint32Array.from(springs, (s) => s.b),
      length: Float32Array.from(springs, (s) => s.length),
      k: Float32Array.from(springs, (s) => s.k),
    },
    params: {
      repulsion: MODEL.repulsion,
      theta: MODEL.theta,
      centre: MODEL.centre,
      decay: MODEL.velocityDecay,
      maxStep: 50,
    },
  };
}

/** Ticks of a full layout and where alpha cools to (08 §3.3). */
export const FULL_LAYOUT = { ticks: 300, alphaMin: 0.001 } as const;

/**
 * The layout's version (08 §3.5): positions a device kept from another —
 * another model of forces, another start — are laid out anew. One more
 * whenever `MODEL`, `FULL_LAYOUT` or the start of `initialLayout` change.
 */
export const LAYOUT_VERSION = 1;

/**
 * Runs `ticks` ticks of the model over all bodies, cooling 1 → 0.001, and
 * writes the result into `pos`, on this thread. Returns the time it took, ms.
 * The app runs the same in its worker (`@strata/layout/worker`).
 */
export function relax(
  x: StarMapExtract,
  pos: Float32Array,
  ticks: number = FULL_LAYOUT.ticks,
): number {
  const t0 = performance.now();
  const input = relaxInputs(x);
  const sim = createForce3d(pos, input.mass, input.springs, input.params);
  sim.run(ticks, FULL_LAYOUT.alphaMin);
  pos.set(sim.positions());
  sim.free();
  return performance.now() - t0;
}
