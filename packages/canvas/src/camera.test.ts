import { describe, expect, it } from 'vitest';
import { Camera, FIT_ZOOM_MAX } from './camera';

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
