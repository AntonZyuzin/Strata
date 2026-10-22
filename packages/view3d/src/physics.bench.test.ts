import { readFileSync } from 'node:fs';
import { loadLayout } from '@strata/layout';
import { beforeAll, describe, expect, it } from 'vitest';
import { syntheticExtract } from './extract';
import { initialLayout } from './layout';
import { activeZone, PHYSICS_LIBS, simulate } from './physics';

// CPU part of spike 2 (16 §3.2): the full layout of 20 000 bodies with 30 000
// wires, 300 ticks (NFR-16: ≤ 10 s in a worker), and a tick of 5 000 active
// bodies (NFR-17: ≤ 4 ms). Slow, so only with STRATA_BENCH=1:
//   STRATA_BENCH=1 pnpm --filter @strata/view3d exec vitest run physics.bench
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
const on = env?.STRATA_BENCH === '1';

describe.runIf(on)('spike 2, physics on the CPU', () => {
  const x = syntheticExtract({ nodes: 20_000, edges: 30_000, seed: 7 });
  beforeAll(async () => {
    await loadLayout(
      readFileSync(new URL('../../layout/pkg/strata_layout_bg.wasm', import.meta.url)),
    );
  });

  it.each(PHYSICS_LIBS)(
    '%s: full layout and active-zone tick',
    (lib) => {
      const t0 = performance.now();
      const pos = initialLayout(x, 1);
      const initialMs = performance.now() - t0;
      const full = simulate(lib, x, pos, { ticks: 300 });
      const zone = simulate(lib, x, pos, { ticks: 60, bodies: activeZone(x, 5_000) });
      const report = {
        lib,
        initialMs: Number(initialMs.toFixed(1)),
        fullLayoutMs: Math.round(initialMs + full.totalMs),
        fullTickMean: Number(full.tickMeanMs.toFixed(2)),
        zoneTickMean: Number(zone.tickMeanMs.toFixed(2)),
        zoneTickP95: Number(zone.tickP95Ms.toFixed(2)),
      };
      console.log(JSON.stringify(report));
      expect(pos.every(Number.isFinite)).toBe(true);
    },
    120_000,
  );
});
