import { median, percentile, type Summary, summarize } from './stats';

/** One timed run of a scenario. */
export interface RunReport {
  durationMs: number;
  frames: number;
  fps: number;
  /** p95 of frame time on the vsync grid (see `vsyncGrid`): what the gate judges. */
  p95Ms: number;
  /** p95 of raw rAF intervals, for reference: timer rounding and jitter included. */
  rawP95Ms: number;
  /** Share of 60 Hz slots (or panel slots, if slower) that showed no new frame. */
  missedShare: number;
  /** The window was hidden or a frame took over a second (display sleep): run not counted. */
  stalled: boolean;
}

/** The gate grid: the panel's period, but never finer than 60 Hz (NFR-01/02 are 60 Hz budgets). */
const GATE_HZ = 60;

/**
 * Frame times on the vsync grid. Raw rAF intervals carry timer rounding
 * (WebKit 1 ms, Chromium 0.1 ms) and callback jitter, so a run that hits every
 * vsync can read p95 = 18 ms. Instead every frame's time since the run start is
 * snapped to the nearest slot of the grid and the frame time is counted in whole
 * slots: a steady 60 Hz run with jitter reads 1 slot, WKWebView's uneven
 * 18-22 ms cadence reads 2 slots on about one frame in ten. The period is
 * re-estimated per run from the elapsed time, so it cannot drift. On a panel
 * faster than 60 Hz the grid is 60 Hz: the question is whether it would look
 * smooth at 60.
 */
export function vsyncGrid(
  intervals: readonly number[],
  vsyncMs: number,
): { periodMs: number; p95Ms: number; missedShare: number } {
  const elapsed = intervals.reduce((a, b) => a + b, 0);
  if (intervals.length === 0 || elapsed <= 0) return { periodMs: 0, p95Ms: 0, missedShare: 0 };
  const target = Math.max(vsyncMs, 1000 / GATE_HZ);
  const slots = Math.max(1, Math.round(elapsed / target));
  // Re-estimate only on a ~60 Hz panel; a faster panel keeps the exact 60 Hz grid.
  const period = vsyncMs >= 1000 / GATE_HZ - 1 ? elapsed / slots : 1000 / GATE_HZ;
  const steps: number[] = [];
  let t = 0;
  let k = 0;
  for (const x of intervals) {
    t += x;
    const slot = Math.round(t / period);
    steps.push(slot - k);
    k = slot;
  }
  steps.sort((a, b) => a - b);
  const frames = intervals.length;
  return {
    periodMs: Math.round(period * 1000) / 1000,
    p95Ms: Math.round(percentile(steps, 0.95) * period * 1000) / 1000,
    missedShare: Math.round((Math.max(0, slots - frames) / slots) * 1000) / 1000,
  };
}

/**
 * Frame statistics of one scenario by the method of 14 §1.4: 2 s of warmup,
 * then several runs; the gate reads the median of the runs' p95.
 */
export interface FrameReport {
  warmupMs: number;
  runMs: number;
  /** Display refresh period measured before the scenario. */
  vsyncMs: number;
  runs: RunReport[];
  /** Medians over the counted runs: what the table shows and the gate judges. */
  fps: number;
  p95Ms: number;
  rawP95Ms: number;
  /** Runs voided because the window was hidden or the display slept. */
  stalledRuns: number;
  /** rAF-to-rAF interval over the counted runs, raw. */
  intervalMs: Summary;
  /** Our work per frame (scene update + render submit), CPU only, counted runs. */
  workMs: Summary;
  /** Share of grid slots without a new frame over the counted runs. */
  missedShare: number;
  /** Share of frames slower than one 60 Hz frame and than two. */
  over16ms: number;
  over33ms: number;
  frames: number;
}

export interface FrameOptions {
  warmupMs: number;
  runMs: number;
  runs: number;
  vsyncMs: number;
  /**
   * A frame slower than this voids its run as «the display slept». The
   * `quick` profile of CI turns it off: software WebGL there draws a heavy
   * frame in over a second, and CI judges no frame times (14 §17).
   */
  stallMs?: number | undefined;
}

/** A frame slower than this means the display slept or the window was hidden. */
const STALL_MS = 1_000;

/**
 * Drives `frame(progress, timed)` from requestAnimationFrame. The warmup plays the
 * whole path once, faster, so the timed runs start with compiled shaders,
 * uploaded buffers and warm code; each run then plays the path from 0 to 1.
 * A run during which the window was hidden or the display slept is voided and
 * replayed, up to two extra runs. An exception in `frame` rejects instead of
 * stopping the loop silently.
 */
export function runFrames(
  opts: FrameOptions,
  frame: (progress: number, timed: boolean) => void,
): Promise<FrameReport> {
  return new Promise((resolve, reject) => {
    const intervals: number[] = [];
    const work: number[] = [];
    const runs: RunReport[] = [];
    // Counted runs' samples only: voided runs are cut back out.
    let phaseStart = -1;
    let last = 0;
    let warm = true;
    let runFrom = 0;
    let stalled = false;
    let counted = 0;
    const maxRuns = opts.runs + 2;

    const finishRun = (now: number) => {
      const xs = intervals.slice(runFrom);
      const elapsed = now - phaseStart;
      const grid = vsyncGrid(xs, opts.vsyncMs);
      runs.push({
        durationMs: Math.round(elapsed),
        frames: xs.length,
        fps: Math.round((xs.length / elapsed) * 10_000) / 10,
        p95Ms: grid.p95Ms,
        rawP95Ms: summarize(xs).p95,
        missedShare: grid.missedShare,
        stalled,
      });
      if (stalled) {
        intervals.length = runFrom;
        work.length = runFrom;
      } else {
        counted++;
      }
    };

    const finish = () => {
      const ok = runs.filter((r) => !r.stalled);
      if (ok.length === 0) {
        reject(new Error('every run stalled: the window was hidden or the display slept'));
        return;
      }
      resolve({
        warmupMs: opts.warmupMs,
        runMs: opts.runMs,
        vsyncMs: Math.round(opts.vsyncMs * 1000) / 1000,
        runs,
        fps: median(ok.map((r) => r.fps)),
        p95Ms: median(ok.map((r) => r.p95Ms)),
        rawP95Ms: median(ok.map((r) => r.rawP95Ms)),
        stalledRuns: runs.length - ok.length,
        intervalMs: summarize(intervals),
        workMs: summarize(work),
        missedShare: vsyncGrid(intervals, opts.vsyncMs).missedShare,
        over16ms: share(intervals, 1000 / 60 + 1),
        over33ms: share(intervals, 1000 / 30 + 1),
        frames: intervals.length,
      });
    };

    const tick = (now: number) => {
      try {
        if (phaseStart < 0) {
          phaseStart = now;
          last = now;
        }
        const elapsed = now - phaseStart;
        if (warm) {
          // Warmup: not counted.
          frame(Math.min(1, elapsed / opts.warmupMs), false);
          if (elapsed >= opts.warmupMs) {
            warm = false;
            phaseStart = now;
            runFrom = intervals.length;
            stalled = false;
          }
          last = now;
          requestAnimationFrame(tick);
          return;
        }
        const interval = now - last;
        if (interval > (opts.stallMs ?? STALL_MS) || document.visibilityState !== 'visible') {
          stalled = true;
        }
        intervals.push(interval);
        last = now;
        const t0 = performance.now();
        frame(Math.min(1, elapsed / opts.runMs), true);
        work.push(performance.now() - t0);
        if (elapsed < opts.runMs) {
          requestAnimationFrame(tick);
          return;
        }
        finishRun(now);
        if (counted < opts.runs && runs.length < maxRuns) {
          phaseStart = now;
          runFrom = intervals.length;
          stalled = false;
          requestAnimationFrame(tick);
          return;
        }
        finish();
      } catch (e) {
        reject(e);
      }
    };
    requestAnimationFrame(tick);
  });
}

function share(xs: readonly number[], limit: number): number {
  if (xs.length === 0) return 0;
  return Math.round((xs.filter((x) => x > limit).length / xs.length) * 1000) / 1000;
}
