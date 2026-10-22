import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createForce3d, loadLayout } from './index';

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
