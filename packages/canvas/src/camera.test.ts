import { describe, expect, it } from 'vitest';
import { between, Camera, FIT_ZOOM_MAX } from './camera';

describe('camera', () => {
  it('frames a big network to fit with a margin', () => {
    const c = new Camera();
    c.fit({ minX: 0, minY: 0, maxX: 4000, maxY: 1000 }, 800, 500);
    expect(c.zoom).toBeCloseTo(0.18);
    const mid = c.toScreen(2000, 500);
    expect(mid.x).toBeCloseTo(400);
    expect(mid.y).toBeCloseTo(250);
  });

  it('does not blow a single node up to the whole screen', () => {
    const c = new Camera();
    c.fit({ minX: -20, minY: -20, maxX: 20, maxY: 20 }, 1280, 800);
    expect(c.zoom).toBe(FIT_ZOOM_MAX);
    expect(c.toScreen(0, 0)).toEqual({ x: 640, y: 400 });
  });
});

describe('a flight (09 §3.4)', () => {
  const from = { x: 0, y: 0, zoom: 1 };
  const to = { x: 900, y: 400, zoom: 4 };
  it('starts and ends where it should, the zoom by equal factors', () => {
    expect(between(from, to, 800, 600, 0)).toEqual(from);
    const end = between(from, to, 800, 600, 1);
    expect(end.x).toBeCloseTo(900);
    expect(end.y).toBeCloseTo(400);
    expect(end.zoom).toBeCloseTo(4);
    // Halfway eased is halfway: the zoom is the geometric mean.
    expect(between(from, to, 800, 600, 0.5).zoom).toBeCloseTo(2);
  });
  it('moves the screen centre on a straight line', () => {
    const centre = (v: { x: number; y: number; zoom: number }) => [
      v.x + 400 / v.zoom,
      v.y + 300 / v.zoom,
    ];
    const [ax = 0, ay = 0] = centre(from);
    const [bx = 0, by = 0] = centre(to);
    for (const k of [0.1, 0.3, 0.7]) {
      const [cx = 0, cy = 0] = centre(between(from, to, 800, 600, k));
      expect((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)).toBeCloseTo(0, 3);
    }
  });
});
