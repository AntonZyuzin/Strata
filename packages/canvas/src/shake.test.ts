import { describe, expect, it } from 'vitest';
import { ShakeDetector } from './shake';

/** Feeds a zigzag along x: `swings` legs of `amp` px, each `legMs` long, sampled every 8 ms. */
function zigzag(d: ShakeDetector, swings: number, amp: number, legMs: number): boolean {
  let t = 0;
  let x = 0;
  for (let s = 0; s < swings; s++) {
    const dir = s % 2 === 0 ? 1 : -1;
    const steps = Math.max(1, Math.round(legMs / 8));
    for (let k = 1; k <= steps; k++) {
      t += 8;
      if (d.feed(x + (dir * amp * k) / steps, 0, t)) return true;
    }
    x += dir * amp;
  }
  return false;
}

describe('ShakeDetector (06 §1.3)', () => {
  it('recognizes four quick reversals of 40 px', () => {
    expect(zigzag(new ShakeDetector(0, 0), 6, 40, 80)).toBe(true);
  });

  it('ignores small swings', () => {
    expect(zigzag(new ShakeDetector(0, 0), 10, 20, 60)).toBe(false);
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

  it('is off with D = 0 and fires only once', () => {
    expect(zigzag(new ShakeDetector(0, 0, 0), 8, 60, 60)).toBe(false);
    const d = new ShakeDetector(0, 0);
    expect(zigzag(d, 6, 40, 80)).toBe(true);
    expect(zigzag(d, 6, 40, 80)).toBe(false);
  });
});
