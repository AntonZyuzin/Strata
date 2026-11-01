import { describe, expect, it } from 'vitest';
import { chainWires, touchAt } from './chain';
import { HEX_IN } from './hex';

describe('the J stroke (06 §6.1)', () => {
  it('touches a bubble it passes through, where it comes nearest', () => {
    const c = { x: 50, y: 0 };
    const t = touchAt({ x: 0, y: 0 }, { x: 100, y: 0 }, c, 20 * HEX_IN);
    expect(t).not.toBeNull();
    expect(t ?? 0).toBeCloseTo(0.5, 3);
    // Past it, out of reach across the sides.
    expect(touchAt({ x: 0, y: 30 }, { x: 100, y: 30 }, c, 20 * HEX_IN)).toBeNull();
    // A segment that ends short of it.
    expect(touchAt({ x: 0, y: 0 }, { x: 20, y: 0 }, c, 20 * HEX_IN)).toBeNull();
    // A stroke that starts on the bubble: a point is a segment too.
    expect(touchAt(c, c, c, 1)).not.toBeNull();
  });

  it('measures by the hexagon: its upright sides, its corner on top', () => {
    // Circumradius 20, a point up: the sides stand 20·HEX_IN ≈ 17.3 from the
    // centre. A stroke 18 to the right passes by, though a circle of 20
    // would have caught it; 17 to the right, inside the side, it touches.
    const c = { x: 0, y: 0 };
    expect(touchAt({ x: 18, y: -50 }, { x: 18, y: 50 }, c, 20 * HEX_IN)).toBeNull();
    expect(touchAt({ x: 17, y: -50 }, { x: 17, y: 50 }, c, 20 * HEX_IN)).not.toBeNull();
    // The top corner reaches 20: a stroke 19 above still touches it.
    expect(touchAt({ x: -50, y: -19 }, { x: 50, y: -19 }, c, 20 * HEX_IN)).not.toBeNull();
  });

  it('chains each bubble to the next: no loop, none twice, none there already', () => {
    const there = new Set(['B\u0000C']);
    const has = (a: string, b: string) => there.has(`${a}\u0000${b}`);
    expect(chainWires(['A', 'B', 'C', 'D'], has)).toEqual([
      ['A', 'B'],
      ['C', 'D'],
    ]);
    expect(chainWires(['A'], has)).toEqual([]);
    expect(chainWires(['A', 'A', 'B', 'A', 'B'], has)).toEqual([
      ['A', 'B'],
      ['B', 'A'],
    ]);
  });
});
