import { describe, expect, it } from 'vitest';
import type { Pose } from './bridge';
import {
  ARC_RISE,
  arcPose,
  arrivePose,
  flightTime,
  flySpeed,
  flyStep,
  lookPose,
  nearAhead,
  panPose,
  zoomAt,
} from './navigate';

const pose = (position: [number, number, number], target: [number, number, number]): Pose => ({
  position,
  target,
  fov: 60,
});
const dist = (a: readonly number[], b: readonly number[]) =>
  Math.hypot((a[0] ?? 0) - (b[0] ?? 0), (a[1] ?? 0) - (b[1] ?? 0), (a[2] ?? 0) - (b[2] ?? 0));

describe('the flight (08 §6.1)', () => {
  it('takes 0.5–1.2 s, longer for a longer way', () => {
    expect(flightTime(0, 100)).toBe(0.5);
    expect(flightTime(1e9, 100)).toBe(1.2);
    expect(flightTime(800, 100)).toBeGreaterThan(flightTime(200, 100));
  });

  it('starts and ends where it should, rising 15 % of the way at the middle', () => {
    const from = pose([0, 0, 1000], [0, 0, 0]);
    const to = pose([1000, 0, 1000], [1000, 0, 0]);
    expect(arcPose(from, to, 0).position).toEqual(from.position);
    const end = arcPose(from, to, 1);
    expect(dist(end.position, to.position)).toBeLessThan(1e-6);
    const mid = arcPose(from, to, 0.5);
    // Up on the screen: the camera looks along −z, its up is +y.
    expect(mid.position[1]).toBeCloseTo(ARC_RISE * 1000, 6);
    expect(mid.target).toEqual([500, 0, 0]);
  });

  it('rises sideways when the way goes along the screen up', () => {
    const from = pose([0, 0, 1000], [0, 0, 0]);
    const to = pose([0, 1000, 1000], [0, 1000, 0]);
    const mid = arcPose(from, to, 0.5);
    expect(Math.abs(mid.position[0])).toBeCloseTo(ARC_RISE * 1000, 6);
  });

  it('arrives on the side the camera looks from, at the distance asked', () => {
    const from = pose([0, 0, 1000], [0, 0, 0]);
    const end = arrivePose(from, [500, 200, -300], 120);
    expect(end.target).toEqual([500, 200, -300]);
    expect(end.position[2]).toBeCloseTo(-180, 6);
  });
});

describe('the camera by hand (08 §5.2)', () => {
  it('zooms to the cursor: the point under it stays, distances scale', () => {
    const p = pose([0, 0, 1000], [0, 0, 0]);
    // A ray to (200, 0, 0) on the target's plane.
    const ray = [200, 0, -1000];
    const q = zoomAt(p, ray, 0.5);
    expect(dist(q.position, [100, 0, 500])).toBeLessThan(1e-6);
    expect(dist(q.target, [100, 0, 0])).toBeLessThan(1e-6);
  });

  it('pans the camera and its target together', () => {
    const p = pose([0, 0, 1000], [0, 0, 0]);
    const q = panPose(p, 10, 20);
    expect(dist(q.position, [-10, 20, 1000])).toBeLessThan(1e-9);
    expect(dist(q.target, [-10, 20, 0])).toBeLessThan(1e-9);
  });

  it('looks around in place and keeps the world up', () => {
    const p = pose([0, 0, 1000], [0, 0, 0]);
    const q = lookPose(p, Math.PI / 2, 0);
    expect(q.position).toEqual(p.position);
    expect(dist(q.target, [1000, 0, 1000])).toBeLessThan(1e-6);
    const up = lookPose(p, 0, -Math.PI);
    // No further than 85° up.
    expect(up.target[1]).toBeLessThan(1000);
    expect(up.target[1]).toBeGreaterThan(990);
  });

  it('flies along the look, sideways and up', () => {
    const p = pose([0, 0, 1000], [0, 0, 0]);
    expect(dist(flyStep(p, 1, 0, 0, 10).position, [0, 0, 990])).toBeLessThan(1e-9);
    expect(dist(flyStep(p, 0, 1, 0, 10).position, [10, 0, 1000])).toBeLessThan(1e-9);
    expect(dist(flyStep(p, 0, 0, 1, 10).position, [0, 10, 1000])).toBeLessThan(1e-9);
    expect(flyStep(p, 0, 0, 0, 10)).toBe(p);
  });

  it('slows near a star ahead, four times faster with Shift (08 §5.3)', () => {
    const pos = Float32Array.from([0, 0, 0, 500, 0, 500]);
    const p = pose([0, 0, 1000], [0, 0, 0]);
    expect(nearAhead(p, pos, 2)).toBeCloseTo(1000, 3);
    expect(flySpeed(100, 1, false, 1e6)).toBe(150);
    expect(flySpeed(100, 1, true, 1e6)).toBe(600);
    expect(flySpeed(0, 1, false, 1e6)).toBe(5);
    expect(flySpeed(1e9, 1, false, 4000)).toBe(4000);
  });
});
