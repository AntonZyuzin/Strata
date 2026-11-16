import { describe, expect, it } from 'vitest';
import { DOT_STEP, dotLevel, MIN_PX } from './dotgrid';

describe('the dots that move with the canvas (07 §7.2)', () => {
  it('stand on the nudge grid, all of them while it is roomy', () => {
    expect(dotLevel(1)).toEqual({ step: DOT_STEP, fine: 1 });
    expect(dotLevel(4)).toEqual({ step: DOT_STEP * 4, fine: 1 });
  });

  it('never grow denser than MIN_PX: the step doubles as the view zooms out', () => {
    for (let zoom = 0.02; zoom < 3; zoom *= 1.1) {
      const { step, fine } = dotLevel(zoom);
      expect(step).toBeGreaterThanOrEqual(MIN_PX);
      // On the world's grid: a power of two of the nudge's step.
      const k = Math.log2(step / (DOT_STEP * zoom));
      expect(Math.abs(k - Math.round(k))).toBeLessThan(1e-9);
      expect(fine).toBeGreaterThanOrEqual(0);
      expect(fine).toBeLessThanOrEqual(1);
    }
  });

  it('let the dots between the coarser points fade, so a level comes without a jump', () => {
    // Just above the densest step the in-between dots are nearly gone; at
    // twice it they are all in, and the next level down starts there.
    expect(dotLevel(MIN_PX / DOT_STEP).fine).toBeCloseTo(0, 5);
    expect(dotLevel((1.5 * MIN_PX) / DOT_STEP).fine).toBeCloseTo(0.5, 5);
    expect(dotLevel((2 * MIN_PX) / DOT_STEP).fine).toBeCloseTo(1, 5);
    const below = dotLevel((MIN_PX / DOT_STEP) * 0.999);
    expect(below.step).toBeCloseTo(2 * MIN_PX * 0.999, 5);
    expect(below.fine).toBeCloseTo(1, 2);
  });
});
