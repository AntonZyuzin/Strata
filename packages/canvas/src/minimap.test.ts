import { describe, expect, it } from 'vitest';
import { fitBox, union } from './minimap';

describe('the minimap fits the network (06 §10.3)', () => {
  it('centres the box and keeps its proportions, an inset around it', () => {
    // A wide network: its width fills 200 − 2 · 8 px.
    const f = fitBox({ minX: 0, minY: 0, maxX: 1840, maxY: 100 }, 200, 150);
    expect(f.scale).toBeCloseTo(0.1);
    const px = (x: number, y: number) => [(x - f.x) * f.scale, (y - f.y) * f.scale];
    expect(px(0, 50)[0]).toBeCloseTo(8);
    expect(px(1840, 50)[0]).toBeCloseTo(192);
    expect(px(920, 50)[1]).toBeCloseTo(75);
    // A tall one: its height fills 150 − 16 px.
    expect(fitBox({ minX: 0, minY: 0, maxX: 10, maxY: 1340 }, 200, 150).scale).toBeCloseTo(0.1);
    // A point is not a division by zero.
    expect(Number.isFinite(fitBox({ minX: 5, minY: 5, maxX: 5, maxY: 5 }, 200, 150).scale)).toBe(
      true,
    );
  });

  it('a view outside the nodes is in the picture too', () => {
    const b = union(
      { minX: 0, minY: 0, maxX: 100, maxY: 100 },
      { minX: 500, minY: -50, maxX: 900, maxY: 250 },
    );
    expect(b).toEqual({ minX: 0, minY: -50, maxX: 900, maxY: 250 });
  });
});
