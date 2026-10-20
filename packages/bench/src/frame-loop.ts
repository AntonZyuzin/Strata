import { type Summary, summarize } from './stats';

/** Frame statistics of one timed scenario (14 §2, NFR-01/02). */
export interface FrameReport {
  durationMs: number;
  frames: number;
  fps: number;
  /** rAF-to-rAF interval: what the user feels. */
  intervalMs: Summary;
  /** Our work per frame (scene update + render submit), CPU only. */
  workMs: Summary;
  /** Share of frames slower than one 60 Hz frame and than two. */
  over16ms: number;
  over33ms: number;
}

/**
 * Drives `frame(progress)` from requestAnimationFrame for `durationMs` and
 * measures intervals and work time. The first `warmupFrames` are not counted:
 * they include shader compilation and texture upload.
 */
export function runFrames(
  durationMs: number,
  frame: (progress: number) => void,
  warmupFrames = 10,
): Promise<FrameReport> {
  return new Promise((resolve) => {
    const intervals: number[] = [];
    const work: number[] = [];
    let start = 0;
    let last = 0;
    let warm = 0;
    const tick = (now: number) => {
      if (warm < warmupFrames) {
        warm++;
        frame(0);
        last = now;
        start = now;
        requestAnimationFrame(tick);
        return;
      }
      const elapsed = now - start;
      intervals.push(now - last);
      last = now;
      const t0 = performance.now();
      frame(Math.min(1, elapsed / durationMs));
      work.push(performance.now() - t0);
      if (elapsed < durationMs) requestAnimationFrame(tick);
      else {
        const frames = intervals.length;
        resolve({
          durationMs: Math.round(elapsed),
          frames,
          fps: Math.round((frames / elapsed) * 1000 * 10) / 10,
          intervalMs: summarize(intervals),
          workMs: summarize(work),
          over16ms: share(intervals, 1000 / 60 + 1),
          over33ms: share(intervals, 1000 / 30 + 1),
        });
      }
    };
    requestAnimationFrame(tick);
  });
}

function share(xs: readonly number[], limit: number): number {
  if (xs.length === 0) return 0;
  return Math.round((xs.filter((x) => x > limit).length / xs.length) * 1000) / 1000;
}
