import { afterEach, describe, expect, it, vi } from 'vitest';
import { onStallWait, runFrames, vsyncGrid } from './frame-loop';
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

/** A fake display: `gap(t)` is the frame interval at time t; `hidden(t)` the visibility. */
function fakeDisplay(gap: (t: number) => number, hidden: (t: number) => boolean = () => false) {
  let now = 0;
  const doc = { visibilityState: 'visible' };
  vi.stubGlobal('document', doc);
  vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => {
    now += gap(now);
    doc.visibilityState = hidden(now) ? 'hidden' : 'visible';
    setTimeout(() => cb(now), 0);
    return 0;
  });
}

describe('runFrames', () => {
  const opts = { warmupMs: 200, runMs: 500, runs: 3, vsyncMs: P60 };
  afterEach(() => {
    vi.unstubAllGlobals();
    onStallWait(null);
  });

  it('voids a run the moment the window hides, waits for it and replays the run', async () => {
    // Hidden from 1.0 s to 9.0 s: frames every 2 s, as in a hidden pane.
    fakeDisplay((t) => (t > 1000 && t < 9000 ? 2000 : P60));
    const heard: boolean[] = [];
    onStallWait((w) => heard.push(w));
    const progress: boolean[] = [];
    const report = await runFrames({ ...opts, runMs: 5000 }, (_, timed) => progress.push(timed));
    expect(report.stalledRuns).toBe(1);
    expect(report.runs.filter((r) => !r.stalled)).toHaveLength(3);
    // The voided run stopped at the first slow frame, not after playing out blind.
    expect(report.runs[0]?.stalled).toBe(true);
    expect(report.runs[0]?.durationMs).toBeLessThan(5000);
    expect(heard).toEqual([true, false]);
    // A second warmup after the window came back.
    const warmups = progress.filter((p, i) => !p && (i === 0 || progress[i - 1])).length;
    expect(warmups).toBe(2);
    expect(report.intervalMs.max).toBeLessThan(20);
  });

  it('counts a hidden window as a stall even at a normal pace', async () => {
    fakeDisplay(
      () => P60,
      (t) => t > 400 && t < 600,
    );
    const report = await runFrames(opts, () => undefined);
    expect(report.stalledRuns).toBe(1);
    expect(report.runs.filter((r) => !r.stalled)).toHaveLength(3);
  });

  it('gives up when the window does not come back', async () => {
    fakeDisplay((t) => (t > 300 ? 2000 : P60));
    const heard: boolean[] = [];
    onStallWait((w) => heard.push(w));
    await expect(runFrames(opts, () => undefined)).rejects.toThrow(/every run stalled/);
    expect(heard).toEqual([true, false]);
  });
});
