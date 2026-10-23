import type { LayoutNet, NetLayout } from '@strata/layout';
import type { LayoutAnswer, LayoutRequest } from '@strata/layout/net-worker';
import { rng } from './stats';

/**
 * Spike 10 (16 §3.2, NFR-08): `L` in its worker on synthetic networks of
 * 500 and 5 000 nodes, each shape with its own algorithm — a layered DAG
 * top to bottom, a tree from the centre, a graph of communities by forces.
 * The time is the worker's; `mainGapMs` is the longest the main thread went
 * without running a 10 ms timer meanwhile (NFR-08: no task over 50 ms).
 */
export interface LayoutRun {
  nodes: number;
  kind: NetLayout;
  ms: number;
}

export interface LayoutResult {
  runs: LayoutRun[];
  /** The slowest layout of each size (NFR-08: ≤ 200 ms and ≤ 2 s). */
  smallMs: number;
  largeMs: number;
  sizes: [number, number];
  mainGapMs: number;
}

const SHAPES: [string, NetLayout][] = [
  ['dag', 'layered'],
  ['tree', 'radial'],
  ['communities', 'force'],
];

/** A synthetic network: S, M and L bubbles scattered, 1.2–1.5 wires per node. */
export function syntheticNet(n: number, shape: string, seed: number): LayoutNet {
  const r = rng(seed);
  const side = Math.sqrt(n) * 120;
  const pos = Float32Array.from({ length: n * 2 }, () => r() * side);
  const radius = Float32Array.from({ length: n }, () => [16, 24, 36][Math.floor(r() * 3)] ?? 16);
  const from: number[] = [];
  const to: number[] = [];
  const link = (a: number, b: number) => {
    if (a !== b) {
      from.push(a);
      to.push(b);
    }
  };
  if (shape === 'dag') {
    const levels = Math.max(2, Math.round(Math.sqrt(n) * 0.7));
    const per = Math.ceil(n / levels);
    for (let b = per; b < n; b++) {
      const lv = Math.floor(b / per);
      const above = (k: number) => Math.min(b - 1, (lv - k) * per + Math.floor(r() * per));
      link(above(1), b);
      if (r() < 0.4) link(above(1), b);
      if (lv >= 3 && r() < 0.1) link(above(2 + Math.floor(r() * (lv - 2))), b);
    }
  } else if (shape === 'tree') {
    for (let b = 1; b < n; b++) link(Math.floor(r() * r() * b), b);
  } else {
    for (let b = 0; b < n; b++) {
      const c = Math.floor(b / 20) * 20;
      if (b > c) link(c + Math.floor(r() * (b - c)), b);
      if (r() < 0.3) link(b, c + Math.floor(r() * Math.min(20, n - c)));
      if (r() < 0.03) link(b, Math.floor(r() * n));
    }
  }
  return {
    pos,
    radius,
    pinned: new Uint8Array(n),
    from: Uint32Array.from(from),
    to: Uint32Array.from(to),
    text: new Uint8Array(from.length),
  };
}

export async function runLayoutScenario(sizes: [number, number]): Promise<LayoutResult> {
  const worker = new Worker(new URL('./layout-worker.ts', import.meta.url), { type: 'module' });
  let next = 0;
  const ask = (kind: NetLayout, net: LayoutNet) =>
    new Promise<LayoutAnswer>((resolve, reject) => {
      const id = ++next;
      worker.onmessage = (e: MessageEvent<LayoutAnswer>) => {
        if (e.data.id === id) resolve(e.data);
      };
      worker.onerror = (e) => reject(new Error(e.message || 'layout worker failed'));
      const request: LayoutRequest = { id, kind, net, spacing: { gap: 24, layer: 72 } };
      worker.postMessage(request);
    });
  // The main thread's longest pause while the worker lays out.
  let last = performance.now();
  let mainGapMs = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    mainGapMs = Math.max(mainGapMs, now - last);
    last = now;
  }, 10);
  try {
    // The module's first load is not part of a layout.
    await ask('force', syntheticNet(10, 'tree', 1));
    last = performance.now();
    mainGapMs = 0;
    const runs: LayoutRun[] = [];
    for (const nodes of sizes) {
      for (const [k, [shape, kind]] of SHAPES.entries()) {
        const answer = await ask(kind, syntheticNet(nodes, shape, 17 + k));
        if ('error' in answer) throw new Error(answer.error);
        runs.push({ nodes, kind, ms: Math.round(answer.ms * 10) / 10 });
      }
    }
    const worst = (n: number) => Math.max(...runs.filter((x) => x.nodes === n).map((x) => x.ms));
    return {
      runs,
      smallMs: worst(sizes[0]),
      largeMs: worst(sizes[1]),
      sizes,
      mainGapMs: Math.round(mainGapMs * 10) / 10,
    };
  } finally {
    clearInterval(timer);
    worker.terminate();
  }
}
