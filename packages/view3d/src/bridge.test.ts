import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { BRIDGE_FOV, lerpPose, planePose, toPlane, type View2D, viewRect } from './bridge';

/** Where three puts a plane point on screen, CSS px from the top-left. */
function project(v: View2D, x: number, y: number): [number, number] {
  const p = planePose(v);
  const cam = new PerspectiveCamera(p.fov, v.width / v.height, 1, 1e7);
  cam.position.set(...p.position);
  cam.lookAt(...p.target);
  cam.updateMatrixWorld();
  cam.updateProjectionMatrix();
  const q = new Vector3(...toPlane(x, y)).project(cam);
  return [((q.x + 1) / 2) * v.width, ((1 - q.y) / 2) * v.height];
}

describe('camera bridge, frame 0 (08 §7.1)', () => {
  const views: View2D[] = [
    { x: 0, y: 0, zoom: 1, width: 1280, height: 800 },
    { x: -350, y: 120, zoom: 2.5, width: 800, height: 500 },
    { x: 1200, y: -40, zoom: 0.3, width: 1440, height: 900 },
  ];

  it('draws a world point where Pixi draws it', () => {
    for (const v of views) {
      for (const [x, y] of [
        [v.x, v.y],
        [v.x + 100 / v.zoom, v.y + 60 / v.zoom],
        [v.x + v.width / v.zoom, v.y + v.height / v.zoom],
      ] as [number, number][]) {
        const [sx, sy] = project(v, x, y);
        expect(sx).toBeCloseTo((x - v.x) * v.zoom, 3);
        expect(sy).toBeCloseTo((y - v.y) * v.zoom, 3);
      }
    }
  });

  it('stands d = H / (2 · zoom · tan(φ / 2)) from the plane, about 3.8 H / zoom at 15°', () => {
    const v = { x: 0, y: 0, zoom: 2, width: 1000, height: 600 };
    expect(planePose(v).position[2]).toBeCloseTo(600 / (2 * 2 * Math.tan((15 * Math.PI) / 360)));
    expect(planePose(v).position[2] / (600 / 2)).toBeCloseTo(3.8, 1);
    expect(planePose(v).fov).toBe(BRIDGE_FOV);
  });

  it('lays the snapshot over exactly the world the canvas shows', () => {
    const v = views[1] as View2D;
    const r = viewRect(v);
    expect(project(v, r.x0, r.y0)[0]).toBeCloseTo(0, 3);
    expect(project(v, r.x1, r.y1)[1]).toBeCloseTo(v.height, 3);
  });

  it('interpolates poses end to end', () => {
    const a = planePose(views[0] as View2D);
    const b = {
      position: [1, 2, 3] as [number, number, number],
      target: [0, 0, 0] as [number, number, number],
      fov: 60,
    };
    expect(lerpPose(a, b, 0)).toEqual(a);
    expect(lerpPose(a, b, 1)).toEqual(b);
  });
});
