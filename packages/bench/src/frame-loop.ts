import { median, type Summary, summarize } from './stats';

/** One timed run of a scenario. */
export interface RunReport {
  durationMs: number;
  frames: number;
  fps: number;
  p95Ms: number;
  droppedShare: number;
}

/**
 * Frame statistics of one scenario by the method of 14 §1.4: 2 s of warmup,
 * then several runs; the gate reads the median of the runs' p95.
 */
export interface FrameReport {
  warmupMs: number;
  runMs: number;
  /** Display refresh period the dropped frames are counted against. */
  vsyncMs: number;
  runs: RunReport[];
  /** Median over runs: what the table shows and the gate judges. */
  fps: number;
  p95Ms: number;
  /** rAF-to-rAF interval over all runs: what the user feels. */
  intervalMs: Summary;
  /** Our work per frame (scene update + render submit), CPU only, all runs. */
  workMs: Summary;
  /** Share of frames that took two refresh periods or more (a missed vsync). */
  droppedShare: number;
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
}

/**
 * Drives `frame(progress, timed)` from requestAnimationFrame. The warmup plays the
 * whole path once, faster, so the timed runs start with compiled shaders,
 * uploaded buffers and warm code; each run then plays the path from 0 to 1.
 * An exception in `frame` rejects instead of stopping the loop silently.
 */
export function runFrames(
  opts: FrameOptions,
  frame: (progress: number, timed: boolean) => void,
): Promise<FrameReport> {
  return new Promise((resolve, reject) => {
    const intervals: number[] = [];
    const work: number[] = [];
    const runs: RunReport[] = [];
    let phaseStart = -1;
    let last = 0;
    let run = -1; // -1: warmup
    let runFrom = 0; // index into `intervals` where the current run starts

    const finishRun = (now: number) => {
      const xs = intervals.slice(runFrom);
      const elapsed = now - phaseStart;
      runs.push({
        durationMs: Math.round(elapsed),
        frames: xs.length,
        fps: Math.round((xs.length / elapsed) * 10_000) / 10,
        p95Ms: summarize(xs).p95,
        droppedShare: dropped(xs, opts.vsyncMs),
      });
    };

    const tick = (now: number) => {
      try {
        if (phaseStart < 0) {
          phaseStart = now;
          last = now;
        }
        const elapsed = now - phaseStart;
        if (run < 0) {
          // Warmup: not counted.
          frame(Math.min(1, elapsed / opts.warmupMs), false);
          if (elapsed >= opts.warmupMs) {
            run = 0;
            phaseStart = now;
            runFrom = 0;
          }
          last = now;
          requestAnimationFrame(tick);
          return;
        }
        intervals.push(now - last);
        last = now;
        const t0 = performance.now();
        frame(Math.min(1, elapsed / opts.runMs), true);
        work.push(performance.now() - t0);
        if (elapsed < opts.runMs) {
          requestAnimationFrame(tick);
          return;
        }
        finishRun(now);
        run++;
        if (run < opts.runs) {
          phaseStart = now;
          runFrom = intervals.length;
          requestAnimationFrame(tick);
          return;
        }
        resolve({
          warmupMs: opts.warmupMs,
          runMs: opts.runMs,
          vsyncMs: Math.round(opts.vsyncMs * 1000) / 1000,
          runs,
          fps: median(runs.map((r) => r.fps)),
          p95Ms: median(runs.map((r) => r.p95Ms)),
          intervalMs: summarize(intervals),
          workMs: summarize(work),
          droppedShare: dropped(intervals, opts.vsyncMs),
          over16ms: share(intervals, 1000 / 60 + 1),
          over33ms: share(intervals, 1000 / 30 + 1),
          frames: intervals.length,
        });
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

/** Frames of two vsync periods or more; robust to the 1 ms rounding of WebKit timestamps. */
function dropped(xs: readonly number[], vsyncMs: number): number {
  if (xs.length === 0 || vsyncMs <= 0) return 0;
  return (
    Math.round((xs.filter((x) => Math.round(x / vsyncMs) >= 2).length / xs.length) * 1000) / 1000
  );
}
