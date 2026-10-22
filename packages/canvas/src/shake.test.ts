import { describe, expect, it } from 'vitest';
import { ShakeDetector } from './shake';

/**
 * Feeds a zigzag along (dx, dy): `swings` legs of `amp` px, each `legMs` long,
 * sampled every 8 ms.
 */
function zigzag(
  d: ShakeDetector,
  swings: number,
  amp: number,
  legMs: number,
  dx = 1,
  dy = 0,
): boolean {
  let t = 0;
  let p = 0;
  for (let s = 0; s < swings; s++) {
    const dir = s % 2 === 0 ? 1 : -1;
    const steps = Math.max(1, Math.round(legMs / 8));
    for (let k = 1; k <= steps; k++) {
      t += 8;
      const q = p + (dir * amp * k) / steps;
      if (d.feed(q * dx, q * dy, t)) return true;
    }
    p += dir * amp;
  }
  return false;
}

describe('ShakeDetector (06 §1.3)', () => {
  it('recognizes four quick reversals of 48 px', () => {
    expect(zigzag(new ShakeDetector(0, 0), 6, 48, 80)).toBe(true);
  });

  it('recognizes a diagonal shake', () => {
    expect(zigzag(new ShakeDetector(0, 0), 6, 60, 80, Math.SQRT1_2, Math.SQRT1_2)).toBe(true);
  });

  it('ignores small swings, below 40 px', () => {
    expect(zigzag(new ShakeDetector(0, 0), 10, 20, 60)).toBe(false);
    expect(zigzag(new ShakeDetector(0, 0), 10, 36, 60)).toBe(false);
  });

  it('ignores slow back and forth', () => {
    expect(zigzag(new ShakeDetector(0, 0), 6, 60, 300)).toBe(false);
  });

  it('ignores a plain drag', () => {
    const d = new ShakeDetector(0, 0);
    let fired = false;
    for (let t = 0; t < 1000; t += 8) fired ||= d.feed(t, t / 2, t);
    expect(fired).toBe(false);
  });

  // ✅ S9 (2026-10-23): moves that used to detach a node by accident.
  it('ignores a diagonal correction: overshoot, back, forward again', () => {
    expect(zigzag(new ShakeDetector(0, 0), 3, 80, 100, 0.8, 0.6)).toBe(false);
  });

  it('ignores circling around a target', () => {
    const d = new ShakeDetector(60, 0);
    let fired = false;
    // One and a half turns of radius 60 px in 600 ms.
    for (let t = 0; t <= 600; t += 8) {
      const a = (t / 600) * 3 * Math.PI;
      fired ||= d.feed(60 * Math.cos(a), 60 * Math.sin(a), t);
    }
    expect(fired).toBe(false);
  });

  it('is off with D = 0 and fires only once', () => {
    expect(zigzag(new ShakeDetector(0, 0, 0), 8, 60, 60)).toBe(false);
    const d = new ShakeDetector(0, 0);
    expect(zigzag(d, 6, 48, 80)).toBe(true);
    expect(zigzag(d, 6, 48, 80)).toBe(false);
  });
});
