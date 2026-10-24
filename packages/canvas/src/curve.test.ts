import { describe, expect, it } from 'vitest';
import { closest, controls, crossing, pointAt, sideOf } from './curve';

const ends = { ax: 0, ay: 0, bx: 300, by: 100, ra: 20, rb: 10 };

describe('wire geometry (06 §6.2)', () => {
  it('a straight wire runs on the line of centres between the rims', () => {
    const c = controls({ ...ends, straight: true });
    const len = Math.hypot(300, 100);
    expect(c[0]).toBeCloseTo((300 / len) * 20);
    expect(c[1]).toBeCloseTo((100 / len) * 20);
    expect(c[6]).toBeCloseTo(300 - (300 / len) * 10);
    expect(c[7]).toBeCloseTo(100 - (100 / len) * 10);
    // Every point of the cubic is on the segment: the hit test tests the line drawn.
    const q = pointAt(c, 0.37, { x: 0, y: 0 });
    expect(q.y / q.x).toBeCloseTo(100 / 300);
    expect(closest({ ...ends, straight: true }, 150, 50).dist).toBeCloseTo(0);
  });

  it('a Bézier wire leaves along the main axis of the pair', () => {
    const c = controls(ends);
    expect([c[0], c[1]]).toEqual([20, 0]);
    expect(c[3]).toBe(0);
    expect(sideOf(300, 100)).toEqual({ x: 1, y: 0 });
    expect(sideOf(30, 40, true)).toEqual({ x: 0.6, y: 0.8 });
  });
});

describe('scissors cross wires (06 §6.7)', () => {
  it('finds where a stroke crosses a wire, and misses one it does not reach', () => {
    const w = { ...ends, straight: true };
    const hit = crossing(w, 150, -100, 150, 200);
    expect(hit?.x).toBeCloseTo(150);
    expect(hit?.y).toBeCloseTo(50);
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
