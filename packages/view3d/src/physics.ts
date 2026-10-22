import { createForce3d } from '@strata/layout';
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  forceZ,
  type SimNode,
} from 'd3-force-3d';
import createLayout from 'ngraph.forcelayout';
import createGraph from 'ngraph.graph';
import { BarnesHut3D } from './bh';
import type { StarMapExtract } from './extract';
import { clusterRadius, degrees, mass } from './layout';

/**
 * The force model of 08 §3.2 on the two candidates of spike 2 (08 §3.1, 16
 * §3.2): d3-force-3d 3.0.6 (MIT, octree) and ngraph.forcelayout 3.3.1
 * (BSD-3-Clause, Barnes–Hut). Same bodies, springs and settings for both;
 * the spike compares the full layout of 20 000 bodies (NFR-16) and a tick of
 * 5 000 active ones (NFR-17).
 *
 * The third candidate, `typed-bh` (bh.ts), is our own Barnes–Hut on typed
 * arrays: the fallback of ADR-0005 when the libraries miss the budgets. The
 * fourth, `wasm`, is the same model in Rust (`crates/strata-layout`) as WASM,
 * with the walk by groups and SIMD sums; call `loadLayout` first.
 *
 * ngraph builds its integrator with `new Function`: under the desktop CSP
 * (no 'unsafe-eval', 11 §8.7) it cannot start. The bench reports that error
 * as the finding; Node measures its speed for the comparison.
 */

export type PhysicsLib = 'd3-force-3d' | 'ngraph' | 'typed-bh' | 'wasm';
export const PHYSICS_LIBS: PhysicsLib[] = ['d3-force-3d', 'ngraph', 'typed-bh', 'wasm'];

/** 08 §3.2: repulsion, nesting spring, wire springs, collision, centring, damping. */
export const MODEL = {
  repulsion: 30,
  theta: 0.8,
  nestStrength: 0.08,
  nestLength: 0.6,
  wireLength: 60,
  wireInside: 0.02,
  wireBetween: 0.005,
  collide: 18,
  centre: 0.001,
  /** Velocity × 0.6 per tick. */
  velocityDecay: 0.4,
} as const;

export interface PhysicsRun {
  lib: PhysicsLib;
  bodies: number;
  springs: number;
  ticks: number;
  /** Building the simulation: bodies, springs, settings. */
  setupMs: number;
  tickMeanMs: number;
  tickP95Ms: number;
  totalMs: number;
}

interface Spring {
  a: number;
  b: number;
  length: number;
  k: number;
}

/** Bodies (a subset or all) and the springs between them, in subset indices. */
function springsOf(x: StarMapExtract, bodies: Int32Array): Spring[] {
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
  return out;
}

function percentile(values: number[], p: number): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
}

/**
 * Runs `ticks` ticks of the model over `bodies` (all by default) starting from
 * `pos`, and writes the result back into `pos`. Alpha goes 1 → 0.001 over the
 * ticks, as in 08 §3.3.
 */
export function simulate(
  lib: PhysicsLib,
  x: StarMapExtract,
  pos: Float32Array,
  opts: { ticks: number; bodies?: Int32Array },
): PhysicsRun {
  const bodies = opts.bodies ?? Int32Array.from({ length: x.count }, (_, i) => i);
  const deg = degrees(x);
  const masses = Array.from(bodies, (b) => mass(x.flags[b] ?? 0, deg[b] ?? 0));
  const t0 = performance.now();
  const springs = springsOf(x, bodies);
  const times: number[] = [];
  let setupMs = 0;
  if (lib === 'd3-force-3d') {
    interface N extends SimNode {
      m: number;
    }
    const nodes: N[] = Array.from(bodies, (b, i) => ({
      x: pos[b * 3] ?? 0,
      y: pos[b * 3 + 1] ?? 0,
      z: pos[b * 3 + 2] ?? 0,
      m: masses[i] ?? 1,
    }));
    const links = springs.map((s) => ({ source: s.a, target: s.b, length: s.length, k: s.k }));
    const sim = forceSimulation(nodes, 3)
      .stop()
      .alpha(1)
      .alphaMin(0.001)
      .alphaDecay(1 - 0.001 ** (1 / Math.max(1, opts.ticks)))
      .velocityDecay(MODEL.velocityDecay)
      .force(
        'charge',
        forceManyBody<N>()
          .strength((n) => -MODEL.repulsion * n.m)
          .theta(MODEL.theta),
      )
      .force(
        'link',
        forceLink<N, (typeof links)[number]>(links)
          .id((_, i) => i)
          .distance((l) => l.length)
          .strength((l) => l.k),
      )
      .force('collide', forceCollide<N>(MODEL.collide))
      .force('x', forceX<N>(0).strength(MODEL.centre))
      .force('y', forceY<N>(0).strength(MODEL.centre))
      .force('z', forceZ<N>(0).strength(MODEL.centre));
    setupMs = performance.now() - t0;
    for (let t = 0; t < opts.ticks; t++) {
      const s = performance.now();
      sim.tick(1);
      times.push(performance.now() - s);
    }
    nodes.forEach((n, i) => {
      const b = bodies[i] ?? 0;
      pos[b * 3] = n.x ?? 0;
      pos[b * 3 + 1] = n.y ?? 0;
      pos[b * 3 + 2] = n.z ?? 0;
    });
  } else if (lib === 'wasm') {
    const sub = new Float32Array(bodies.length * 3);
    bodies.forEach((b, i) => {
      sub[i * 3] = pos[b * 3] ?? 0;
      sub[i * 3 + 1] = pos[b * 3 + 1] ?? 0;
      sub[i * 3 + 2] = pos[b * 3 + 2] ?? 0;
    });
    const sim = createForce3d(
      sub,
      Float32Array.from(masses),
      {
        a: Uint32Array.from(springs, (s) => s.a),
        b: Uint32Array.from(springs, (s) => s.b),
        length: Float32Array.from(springs, (s) => s.length),
        k: Float32Array.from(springs, (s) => s.k),
      },
      {
        repulsion: MODEL.repulsion,
        theta: MODEL.theta,
        centre: MODEL.centre,
        decay: MODEL.velocityDecay,
        maxStep: 50,
      },
    );
    setupMs = performance.now() - t0;
    const decay = 0.001 ** (1 / Math.max(1, opts.ticks));
    let alpha = 1;
    for (let t = 0; t < opts.ticks; t++) {
      const s = performance.now();
      sim.tick(alpha);
      times.push(performance.now() - s);
      alpha *= decay;
    }
    const out = sim.positions();
    sim.free();
    bodies.forEach((b, i) => {
      pos[b * 3] = out[i * 3] ?? 0;
      pos[b * 3 + 1] = out[i * 3 + 1] ?? 0;
      pos[b * 3 + 2] = out[i * 3 + 2] ?? 0;
    });
  } else if (lib === 'typed-bh') {
    const sub = new Float32Array(bodies.length * 3);
    bodies.forEach((b, i) => {
      sub[i * 3] = pos[b * 3] ?? 0;
      sub[i * 3 + 1] = pos[b * 3 + 1] ?? 0;
      sub[i * 3 + 2] = pos[b * 3 + 2] ?? 0;
    });
    const sim = new BarnesHut3D(
      sub,
      Float32Array.from(masses),
      {
        a: Int32Array.from(springs, (s) => s.a),
        b: Int32Array.from(springs, (s) => s.b),
        length: Float32Array.from(springs, (s) => s.length),
        k: Float32Array.from(springs, (s) => s.k),
      },
      {
        repulsion: MODEL.repulsion,
        theta: MODEL.theta,
        centre: MODEL.centre,
        decay: MODEL.velocityDecay,
        maxStep: 50,
      },
    );
    setupMs = performance.now() - t0;
    const decay = 0.001 ** (1 / Math.max(1, opts.ticks));
    let alpha = 1;
    for (let t = 0; t < opts.ticks; t++) {
      const s = performance.now();
      sim.tick(alpha);
      times.push(performance.now() - s);
      alpha *= decay;
    }
    bodies.forEach((b, i) => {
      pos[b * 3] = sub[i * 3] ?? 0;
      pos[b * 3 + 1] = sub[i * 3 + 1] ?? 0;
      pos[b * 3 + 2] = sub[i * 3 + 2] ?? 0;
    });
  } else {
    const graph = createGraph();
    for (let i = 0; i < bodies.length; i++) graph.addNode(i);
    for (const s of springs) graph.addLink(s.a, s.b, s);
    // nodeMass and springTransform exist in 3.3.1 but not in its typings.
    const settings = {
      dimensions: 3,
      timeStep: 0.5,
      gravity: -MODEL.repulsion,
      theta: MODEL.theta,
      springLength: MODEL.wireLength,
      springCoefficient: MODEL.wireInside,
      dragCoefficient: MODEL.velocityDecay,
      nodeMass: (id: number | string) => masses[Number(id)] ?? 1,
      springTransform: (
        link: { data: Spring },
        spring: { length: number; coefficient: number },
      ) => {
        spring.length = link.data.length;
        spring.coefficient = link.data.k;
      },
    };
    const layout = createLayout(graph, settings as Parameters<typeof createLayout>[1]);
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i] ?? 0;
      layout.setNodePosition(i, pos[b * 3] ?? 0, pos[b * 3 + 1] ?? 0, pos[b * 3 + 2] ?? 0);
    }
    setupMs = performance.now() - t0;
    for (let t = 0; t < opts.ticks; t++) {
      const s = performance.now();
      layout.step();
      times.push(performance.now() - s);
    }
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i] ?? 0;
      const p = layout.getNodePosition(i);
      pos[b * 3] = p.x;
      pos[b * 3 + 1] = p.y;
      pos[b * 3 + 2] = p.z ?? 0;
    }
    layout.dispose();
  }
  const mean = times.reduce((a, b) => a + b, 0) / Math.max(1, times.length);
  return {
    lib,
    bodies: bodies.length,
    springs: springs.length,
    ticks: opts.ticks,
    setupMs,
    tickMeanMs: mean,
    tickP95Ms: percentile(times, 0.95),
    totalMs: performance.now() - t0,
  };
}

/**
 * The active zone of NFR-17: about `n` bodies of the largest clusters with
 * their networks, as when the camera sits among them (08 §3.1 rule 4).
 */
export function activeZone(x: StarMapExtract, n: number): Int32Array {
  const take = new Uint8Array(x.count);
  const out: number[] = [];
  // Breadth-first from the root over the primary tree, biggest subtrees first.
  const children: number[][] = Array.from({ length: x.count }, () => []);
  for (let i = 1; i < x.count; i++) {
    const p = x.primaryNet[i] ?? -1;
    if (p >= 0) children[p]?.push(i);
  }
  const queue = [0];
  while (queue.length > 0 && out.length < n) {
    const b = queue.shift() as number;
    if (take[b]) continue;
    take[b] = 1;
    out.push(b);
    const kids = (children[b] ?? []).sort(
      (a, c) => (x.subtreeSize[c] ?? 0) - (x.subtreeSize[a] ?? 0),
    );
    queue.push(...kids);
  }
  return Int32Array.from(out);
}
