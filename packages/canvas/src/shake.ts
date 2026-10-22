/**
 * Shake detection (06 §1.3, §6.7): at least 4 reversals on one axis within
 * 600 ms, each swing at least D screen px; D = 0 turns the gesture off (05 §8.4).
 * An extremum is recorded on an axis when the motion turns back after
 * travelling at least D since the previous extremum.
 *
 * ✅ S9 (2026-10-23): the owner detached nodes by accident while moving them.
 * Reversals are counted per axis, not summed over both: a diagonal correction
 * turned both axes at once and counted twice, a loop around a target counted
 * four per turn. D went from 32 to 40 px.
 */
export const SHAKE_REVERSALS = 4;
export const SHAKE_WINDOW_MS = 600;
/** Mouse; a trackpad gets a larger swing (06 §18). */
export const SHAKE_SWING_PX = 40;

interface Axis {
  /** Last extremum. */
  ext: number;
  /** Direction of travel since it: 1, -1 or 0 before the first move. */
  dir: number;
  /** Furthest point in the current direction. */
  peak: number;
  /** Times of the reversals still inside the window. */
  reversals: number[];
}

export class ShakeDetector {
  private readonly axes: [Axis, Axis];
  private fired = false;

  constructor(
    x: number,
    y: number,
    private readonly swing = SHAKE_SWING_PX,
  ) {
    this.axes = [
      { ext: x, dir: 0, peak: x, reversals: [] },
      { ext: y, dir: 0, peak: y, reversals: [] },
    ];
  }

  /** Feeds a pointer position; returns true once, when the shake is recognized. */
  feed(x: number, y: number, timeMs: number): boolean {
    if (this.fired || this.swing <= 0) return false;
    const [ax, ay] = this.axes;
    this.track(ax, x, timeMs);
    this.track(ay, y, timeMs);
    for (const a of this.axes) {
      a.reversals = a.reversals.filter((t) => timeMs - t <= SHAKE_WINDOW_MS);
      if (a.reversals.length >= SHAKE_REVERSALS) {
        this.fired = true;
        return true;
      }
    }
    return false;
  }

  private track(a: Axis, v: number, t: number) {
    if (a.dir === 0) {
      if (Math.abs(v - a.ext) >= this.swing) {
        a.dir = Math.sign(v - a.ext);
        a.peak = v;
      }
      return;
    }
    if ((v - a.peak) * a.dir > 0) {
      a.peak = v; // still going the same way
      return;
    }
    // Turned back: a reversal if the swing since the last extremum was long enough
    // and the motion has come back far enough to be deliberate.
    if (Math.abs(a.peak - a.ext) >= this.swing && Math.abs(v - a.peak) >= this.swing / 2) {
      a.reversals.push(t);
      a.ext = a.peak;
      a.dir = -a.dir;
      a.peak = v;
    }
  }
}
