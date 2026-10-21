import { describe, expect, it } from 'vitest';
import { vsyncGrid } from './frame-loop';
import { rng } from './stats';

/** rAF intervals from presentation times, with callback jitter and timer rounding. */
function intervals(times: number[], step: number, jitterMs: number, seed = 1): number[] {
  const r = rng(seed);
  const stamps = times.map((t) => Math.floor((t + r() * jitterMs) / step) * step);
  return stamps.slice(1).map((s, i) => s - (stamps[i] ?? s));
}

const P60 = 1000 / 60;
const range = (n: number, f: (i: number) => number) => Array.from({ length: n }, (_, i) => f(i));

describe('vsyncGrid', () => {
  it('passes a run that hits every vsync despite WebKit 1 ms rounding and jitter', () => {
    const xs = intervals(
      range(601, (i) => i * P60),
      1,
      0.9,
    );
    expect(Math.max(...xs)).toBeGreaterThanOrEqual(17); // raw p95 would read 17-18
    const g = vsyncGrid(xs, P60);
    expect(g.p95Ms).toBeCloseTo(P60, 1);
    expect(g.missedShare).toBe(0);
  });

  it('passes the same run with Chromium 0.1 ms rounding', () => {
    const g = vsyncGrid(
      intervals(
        range(601, (i) => i * P60),
        0.1,
        0.6,
        7,
      ),
      P60,
    );
    expect(g.p95Ms).toBeCloseTo(P60, 1);
  });

  it('fails the uneven 18-22 ms cadence of MO-mac run 1 (54.7 fps)', () => {
    // 547 frames in 10 s: each frame lands on the next vsync after its 18-22 ms of work.
    const r = rng(3);
    const times: number[] = [0];
    for (let i = 1; i < 548; i++) {
      const ready = (times[i - 1] ?? 0) + 17 + r() * 5;
      times.push(Math.ceil(ready / P60) * P60);
    }
    const g = vsyncGrid(intervals(times, 1, 0.5), P60);
    expect(g.p95Ms).toBeCloseTo(2 * P60, 1);
    expect(g.missedShare).toBeGreaterThan(0.05);
  });

  it('reads a steady 30 fps as two slots', () => {
    const g = vsyncGrid(
      intervals(
        range(301, (i) => i * 2 * P60),
        1,
        0.5,
      ),
      P60,
    );
    expect(g.p95Ms).toBeCloseTo(2 * P60, 1);
    expect(g.missedShare).toBeCloseTo(0.5, 2);
  });

  it('judges a 120 Hz panel on the 60 Hz grid', () => {
    const g = vsyncGrid(
      intervals(
        range(1201, (i) => i * (P60 / 2)),
        1,
        0.5,
      ),
      P60 / 2,
    );
    expect(g.periodMs).toBeCloseTo(P60, 2);
    expect(g.p95Ms).toBeCloseTo(P60, 1);
    expect(g.missedShare).toBe(0);
  });
});
