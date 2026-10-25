import { describe, expect, it } from 'vitest';
import { closest, controls, crossing, pointAt } from './curve';
import { cornerToward } from './hex';

const ends = { ax: 0, ay: 0, bx: 300, by: 100, ra: 20, rb: 10 };

describe('wire geometry (06 §6.2, ADR-0011)', () => {
  it('a straight wire runs between the corners that face each other', () => {
    const c = controls({ ...ends, straight: true });
    const ua = cornerToward(300, 100);
    const ub = cornerToward(-300, -100);
    expect(c[0]).toBeCloseTo(ua.x * 20);
    expect(c[1]).toBeCloseTo(ua.y * 20);
    expect(c[6]).toBeCloseTo(300 + ub.x * 10);
    expect(c[7]).toBeCloseTo(100 + ub.y * 10);
    // Every point of the cubic is on the segment: the hit test tests the line drawn.
    const q = pointAt(c, 0.37, { x: 0, y: 0 });
    const r = pointAt(c, 0.81, { x: 0, y: 0 });
    const cross = (q.x - c[0]) * (r.y - c[1]) - (q.y - c[1]) * (r.x - c[0]);
    expect(cross).toBeCloseTo(0);
    expect(
      closest({ ...ends, straight: true }, (c[0] + c[6]) / 2, (c[1] + c[7]) / 2).dist,
    ).toBeCloseTo(0);
  });

  it('a Bézier wire leaves and enters along its corners: top-down, the bottom and the top', () => {
    const c = controls({ ax: 0, ay: 0, bx: 0, by: 200, ra: 20, rb: 20 });
    expect([c[0], c[1]]).toEqual([expect.closeTo(0), expect.closeTo(20)]);
    expect([c[6], c[7]]).toEqual([expect.closeTo(0), expect.closeTo(180)]);
    // Control points at half the gap between the corners.
    expect(c[3]).toBeCloseTo(20 + 80);
    expect(c[5]).toBeCloseTo(180 - 80);
    // Side by side: out of the lower right corner, into the upper left — an S.
    const s = controls({ ax: 0, ay: 0, bx: 300, by: 0, ra: 20, rb: 20 });
    expect(s[1]).toBeGreaterThan(0);
    expect(s[7]).toBeLessThan(0);
  });
});

describe('scissors cross wires (06 §6.7)', () => {
  it('finds where a stroke crosses a wire, and misses one it does not reach', () => {
    const w = { ...ends, straight: true };
    const hit = crossing(w, 150, -100, 150, 200);
    const c = controls(w);
    expect(hit?.x).toBeCloseTo(150);
    expect(hit?.y).toBeCloseTo(c[1] + ((150 - c[0]) * (c[7] - c[1])) / (c[6] - c[0]));
    expect(hit?.t).toBeGreaterThan(0.4);
    expect(hit?.t).toBeLessThan(0.6);
    expect(Math.hypot(hit?.dx ?? 0, hit?.dy ?? 0)).toBeCloseTo(1);
    expect(crossing(w, 150, -100, 150, 0)).toBeNull();
    // A stroke along the wire, beside it, crosses nothing.
    expect(crossing(w, 0, 20, 300, 120)).toBeNull();
  });

  it('cuts a curved wire where it is drawn, not on its chord', () => {
    const w = { ax: 0, ay: 0, bx: 400, by: 200, ra: 20, rb: 20 };
    const mid = pointAt(controls(w), 0.5, { x: 0, y: 0 });
    const hit = crossing(w, mid.x - 30, mid.y + 30, mid.x + 30, mid.y - 30);
    expect(hit?.x).toBeCloseTo(mid.x, 0);
    expect(hit?.y).toBeCloseTo(mid.y, 0);
  });
});
