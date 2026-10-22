import { readFileSync } from 'node:fs';
import { loadLayout } from '@strata/layout';
import { beforeAll, describe, expect, it } from 'vitest';
import { KIND, syntheticExtract } from './extract';
import { clusterRadius, initialLayout } from './layout';
import { activeZone, PHYSICS_LIBS, simulate } from './physics';

const x = syntheticExtract({ nodes: 2_000, edges: 3_000, seed: 5 });

// The `wasm` candidate needs the module; `pnpm wasm` builds it before the tests.
beforeAll(async () => {
  await loadLayout(
    readFileSync(new URL('../../layout/pkg/strata_layout_bg.wasm', import.meta.url)),
  );
});

const dist = (pos: Float32Array, a: number, b: number) =>
  Math.hypot(
    (pos[a * 3] ?? 0) - (pos[b * 3] ?? 0),
    (pos[a * 3 + 1] ?? 0) - (pos[b * 3 + 1] ?? 0),
    (pos[a * 3 + 2] ?? 0) - (pos[b * 3 + 2] ?? 0),
  );

describe('3D extract (08 §8.3)', () => {
  it('has one root, parents before children and consistent subtree sizes', () => {
    expect(x.primaryNet[0]).toBe(-1);
    for (let i = 1; i < x.count; i++) {
      const p = x.primaryNet[i] ?? -1;
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThan(i);
      expect(x.kind[p]).toBe(KIND.network);
    }
    expect(x.subtreeSize[0]).toBe(x.count);
    expect(x.edges.length / 2).toBe(3_000);
  });
});

describe('initial layout (08 §3.3)', () => {
  it('is deterministic for a seed and changes with it', () => {
    expect(initialLayout(x, 1)).toEqual(initialLayout(x, 1));
    expect(initialLayout(x, 1)).not.toEqual(initialLayout(x, 2));
  });

  it('puts networks outside their parent ball and other kinds inside it', () => {
    const pos = initialLayout(x, 1);
    for (let i = 1; i < x.count; i++) {
      const p = x.primaryNet[i] ?? 0;
      const rp = clusterRadius(x.subtreeSize[p] ?? 1);
      const d = dist(pos, i, p);
      if (x.kind[i] === KIND.network) expect(d).toBeGreaterThanOrEqual(rp - 1e-3);
      else expect(d).toBeLessThanOrEqual(rp * 0.9 + 1e-3);
    }
  });
});

describe('physics (08 §3.2)', () => {
  it.each(PHYSICS_LIBS)('%s moves bodies and keeps them finite', (lib) => {
    const pos = initialLayout(x, 1);
    const before = Float32Array.from(pos);
    const run = simulate(lib, x, pos, { ticks: 10 });
    expect(run.bodies).toBe(x.count);
    expect(run.springs).toBeGreaterThan(x.count);
    expect(pos.every(Number.isFinite)).toBe(true);
    expect(pos).not.toEqual(before);
  });

  it('builds an active zone of the requested size from the largest clusters', () => {
    const zone = activeZone(x, 500);
    expect(zone.length).toBe(500);
    expect(zone[0]).toBe(0);
    expect(new Set(zone).size).toBe(500);
  });
});
