import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createForce3d, layoutNetwork, loadLayout } from './index';

const bytes = readFileSync(new URL('../pkg/strata_layout_bg.wasm', import.meta.url));
const params = { repulsion: 30, theta: 0.8, centre: 0.001, decay: 0.4, maxStep: 50 };

describe('strata-layout in WASM (08 §3.2)', () => {
  it('pushes two bodies apart and pulls a spring to its length', async () => {
    await loadLayout(bytes);
    const sim = createForce3d(
      Float32Array.of(0, 0, 0, 200, 0, 0),
      Float32Array.of(1, 1),
      {
        a: Uint32Array.of(0),
        b: Uint32Array.of(1),
        length: Float32Array.of(60),
        k: Float32Array.of(0.08),
      },
      { ...params, repulsion: 0, centre: 0 },
    );
    for (let t = 0; t < 500; t++) sim.tick(1);
    const p = sim.positions();
    expect((p[3] ?? 0) - (p[0] ?? 0)).toBeCloseTo(60, 0);
    sim.free();
  });

  it('runs a full layout of a cloud without leaving finite numbers', async () => {
    await loadLayout(bytes);
    const n = 2000;
    const pos = Float32Array.from({ length: n * 3 }, (_, i) => Math.sin(i * 12.9898) * 500);
    const sim = createForce3d(
      pos,
      new Float32Array(n).fill(1),
      {
        a: new Uint32Array(),
        b: new Uint32Array(),
        length: new Float32Array(),
        k: new Float32Array(),
      },
      params,
    );
    sim.run(50, 0.001);
    expect(sim.positions().every(Number.isFinite)).toBe(true);
    sim.free();
  });
});

describe('L in WASM (06 §9.2)', () => {
  const ring = (n: number) => ({
    pos: Float32Array.from({ length: n * 2 }, (_, i) => Math.cos(i * 1.7) * 300),
    radius: new Float32Array(n).fill(18),
    pinned: new Uint8Array(n),
    from: Uint32Array.from({ length: n - 1 }, (_, i) => i),
    to: Uint32Array.from({ length: n - 1 }, (_, i) => i + 1),
    text: new Uint8Array(n - 1),
  });

  it('lays a chain out top to bottom with every kind keeping bubbles apart', async () => {
    await loadLayout(bytes);
    const net = ring(30);
    const layered = layoutNetwork(net, 'layered', { gap: 24, layer: 80 });
    for (let i = 0; i + 1 < 30; i++) {
      expect(layered[(i + 1) * 2 + 1] ?? 0).toBeGreaterThan(layered[i * 2 + 1] ?? 0);
    }
    for (const kind of ['layered', 'radial', 'force'] as const) {
      const p = layoutNetwork(net, kind, { gap: 24, layer: 80 });
      let closest = Number.POSITIVE_INFINITY;
      for (let i = 0; i < 30; i++)
        for (let j = i + 1; j < 30; j++)
          closest = Math.min(
            closest,
            Math.hypot(
              (p[i * 2] ?? 0) - (p[j * 2] ?? 0),
              (p[i * 2 + 1] ?? 0) - (p[j * 2 + 1] ?? 0),
            ),
          );
      expect(closest, kind).toBeGreaterThan(36 + 12);
    }
  });

  it('refuses arrays that do not match instead of aborting the module', async () => {
    await loadLayout(bytes);
    const net = { ...ring(5), to: Uint32Array.of(1, 2, 3, 9) };
    expect(() => layoutNetwork(net, 'force', { gap: 24, layer: 80 })).toThrow(/do not match/);
  });
});
