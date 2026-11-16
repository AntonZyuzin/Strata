import { describe, expect, it } from 'vitest';
import { alignTo, distribute, GRID_STEP, inSight, snapToGrid, snapToNodes } from './align';

describe('snapping a dragged bubble (06 §3)', () => {
  it("snaps x and y each to the nearest neighbour's centre within reach", () => {
    const others = [
      { x: 100, y: 0 },
      { x: 0, y: 203 },
      { x: 104, y: 500 },
    ];
    expect(snapToNodes({ x: 103, y: 198 }, others, 6)).toEqual({
      x: 104,
      y: 203,
      gx: 104,
      gy: 203,
    });
  });

  it('leaves an axis with no neighbour in reach as it is', () => {
    expect(snapToNodes({ x: 50, y: 50 }, [{ x: 58, y: 52 }], 6)).toEqual({
      x: 50,
      y: 52,
      gx: null,
      gy: 52,
    });
    expect(snapToNodes({ x: 50, y: 50 }, [], 6)).toEqual({ x: 50, y: 50, gx: null, gy: null });
  });

  it('is pulled by bubbles in sight only, any part of them', () => {
    const seen = { minX: 0, minY: 0, maxX: 100, maxY: 50 };
    expect(inSight({ x: 50, y: 25, r: 5 }, seen)).toBe(true);
    // Its rim in the picture, its centre out of it.
    expect(inSight({ x: 104, y: 25, r: 5 }, seen)).toBe(true);
    expect(inSight({ x: 50, y: -4, r: 5 }, seen)).toBe(true);
    // Wholly off the screen: on a line with the dragged one or not, no pull.
    expect(inSight({ x: 106, y: 25, r: 5 }, seen)).toBe(false);
    expect(inSight({ x: 50, y: 56, r: 5 }, seen)).toBe(false);
  });

  it('snaps to the grid of the nudge and the dot grid', () => {
    expect(snapToGrid({ x: 37, y: -13 })).toEqual({ x: 2 * GRID_STEP, y: -GRID_STEP });
    expect(snapToGrid({ x: 11, y: 13 })).toEqual({ x: 0, y: GRID_STEP });
  });
});

describe('aligning and distributing (06 §9.1)', () => {
  const points = new Map([
    ['a', { x: 0, y: 10 }],
    ['b', { x: 90, y: 40 }],
    ['c', { x: 30, y: -20 }],
  ]);

  it('puts the points in the sample’s row or column', () => {
    expect([...alignTo(points, { x: 7, y: 5 }, 'row').values()]).toEqual([
      { x: 0, y: 5 },
      { x: 90, y: 5 },
      { x: 30, y: 5 },
    ]);
    expect([...alignTo(points, { x: 7, y: 5 }, 'column').values()]).toEqual([
      { x: 7, y: 10 },
      { x: 7, y: 40 },
      { x: 7, y: -20 },
    ]);
  });

  it('spaces them evenly between the first and the last, in their order', () => {
    const d = distribute(points, 'x');
    expect(d.get('a')).toEqual({ x: 0, y: 10 });
    expect(d.get('c')).toEqual({ x: 45, y: -20 });
    expect(d.get('b')).toEqual({ x: 90, y: 40 });
    const two = new Map([...points].slice(0, 2));
    expect(distribute(two, 'y')).toEqual(two);
  });
});
