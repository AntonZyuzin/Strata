import type { Pose } from './bridge';

/**
 * The map's camera without three.js (08 §5–6): a flight's arc and time,
 * zoom to the cursor, panning, the look and the steps of flying. A pose is
 * where the camera stands and the point it looks at; the up of the world is
 * +y, as `applyPose` has it.
 */

export type Vec3 = [number, number, number];

const sub = (a: readonly number[], b: readonly number[]): Vec3 => [
  (a[0] ?? 0) - (b[0] ?? 0),
  (a[1] ?? 0) - (b[1] ?? 0),
  (a[2] ?? 0) - (b[2] ?? 0),
];
const add = (a: readonly number[], b: readonly number[], k = 1): Vec3 => [
  (a[0] ?? 0) + (b[0] ?? 0) * k,
  (a[1] ?? 0) + (b[1] ?? 0) * k,
  (a[2] ?? 0) + (b[2] ?? 0) * k,
];
const dot = (a: readonly number[], b: readonly number[]) =>
  (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0);
const cross = (a: readonly number[], b: readonly number[]): Vec3 => [
  (a[1] ?? 0) * (b[2] ?? 0) - (a[2] ?? 0) * (b[1] ?? 0),
  (a[2] ?? 0) * (b[0] ?? 0) - (a[0] ?? 0) * (b[2] ?? 0),
  (a[0] ?? 0) * (b[1] ?? 0) - (a[1] ?? 0) * (b[0] ?? 0),
];
const length = (a: readonly number[]) => Math.sqrt(dot(a, a));
const unit = (a: readonly number[]): Vec3 => {
  const l = length(a) || 1;
  return [(a[0] ?? 0) / l, (a[1] ?? 0) / l, (a[2] ?? 0) / l];
};
const lerp3 = (a: readonly number[], b: readonly number[], k: number): Vec3 => add(a, sub(b, a), k);

/** The world's up (08 §5). */
const UP: Vec3 = [0, 1, 0];

/** Ease in and out, cubic: a flight starts and stops softly (08 §6.1). */
export function easeInOut(t: number): number {
  const k = Math.min(1, Math.max(0, t));
  return k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2;
}

/**
 * A flight's time, seconds (08 §6.1): `clamp(0.4 + 0.25 · log2(1 + D / R), 0.5, 1.2)`,
 * `D` the way, `R` the radius of the target's cluster.
 */
export function flightTime(way: number, radius: number): number {
  const t = 0.4 + 0.25 * Math.log2(1 + way / Math.max(1, radius));
  return Math.min(1.2, Math.max(0.5, t));
}

/** The rise of a flight's arc over the straight way, a share of the way (08 §6.1). */
export const ARC_RISE = 0.15;

/**
 * A pose of a flight at `t` of its time (08 §6.1): eased in and out, the
 * camera on an arc that rises over the straight way by 15 % of it at the
 * middle — up on the screen, so it passes over the clusters between, not
 * through them; the point it looks at moves straight.
 */
export function arcPose(from: Pose, to: Pose, t: number): Pose {
  const k = easeInOut(t);
  const way = sub(to.position, from.position);
  const d = length(way);
  const dir = unit(way);
  // The screen's up at the start, made square to the way.
  const look = unit(sub(from.target, from.position));
  const right = cross(look, UP);
  let up = length(right) > 1e-6 ? cross(unit(right), look) : UP;
  up = sub(up, [dir[0] * dot(up, dir), dir[1] * dot(up, dir), dir[2] * dot(up, dir)]);
  // A way along the screen's up rises sideways instead.
  if (length(up) < 1e-3) up = length(right) > 1e-6 ? right : [1, 0, 0];
  const rise = Math.sin(Math.PI * k) * ARC_RISE * d;
  return {
    position: add(lerp3(from.position, to.position, k), unit(up), rise),
    target: lerp3(from.target, to.target, k),
    fov: from.fov + (to.fov - from.fov) * k,
  };
}

/**
 * The end of a flight to `target` (08 §6.1): `distance` away from it, on
 * the side the camera looks from now.
 */
export function arrivePose(from: Pose, target: Vec3, distance: number): Pose {
  const back = unit(sub(from.position, from.target));
  return { fov: from.fov, target, position: add(target, back, distance) };
}

/**
 * Closer or farther towards the point under the cursor (08 §5.2): `ray` is
 * the way from the camera through it; the point at the target's depth stays
 * under the cursor, the camera and its target go `scale` of their way to it.
 */
export function zoomAt(p: Pose, ray: readonly number[], scale: number): Pose {
  const look = unit(sub(p.target, p.position));
  const depth = length(sub(p.target, p.position));
  const r = unit(ray);
  const along = dot(r, look);
  const at = add(p.position, r, depth / Math.max(0.05, along));
  return {
    fov: p.fov,
    position: add(at, sub(p.position, at), scale),
    target: add(at, sub(p.target, at), scale),
  };
}

/** The camera's right and up, as the screen's x and y (y up). */
export function screenAxes(p: Pose): { right: Vec3; up: Vec3; look: Vec3 } {
  const look = unit(sub(p.target, p.position));
  let right = cross(look, UP);
  right = length(right) > 1e-6 ? unit(right) : [1, 0, 0];
  return { right, up: unit(cross(right, look)), look };
}

/** Panning (08 §5.2): the camera and its target move by `dx`, `dy` world units of the screen. */
export function panPose(p: Pose, dx: number, dy: number): Pose {
  const { right, up } = screenAxes(p);
  const d = add([right[0] * -dx, right[1] * -dx, right[2] * -dx], up, dy);
  return { fov: p.fov, position: add(p.position, d), target: add(p.target, d) };
}

/** Nearer than this to straight up or down the look stops: the world's up stays up. */
const PITCH_LIMIT = (85 * Math.PI) / 180;

/**
 * The look of flying (08 §5.2, the right button held): the camera turns in
 * place by `yaw` about the world's up and `pitch` about its right, radians;
 * the target stays as far ahead.
 */
export function lookPose(p: Pose, yaw: number, pitch: number): Pose {
  const v = sub(p.target, p.position);
  const dist = length(v) || 1;
  const look = unit(v);
  let az = Math.atan2(look[0], look[2]);
  let el = Math.asin(Math.max(-1, Math.min(1, look[1])));
  az -= yaw;
  el = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, el - pitch));
  const dir: Vec3 = [Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)];
  return { fov: p.fov, position: p.position, target: add(p.position, dir, dist) };
}

/**
 * A step of flying (08 §5.2): `forward`, `right`, `up` in −1…1 from the
 * keys held, `dist` world units; the camera and its target move together.
 */
export function flyStep(p: Pose, forward: number, right: number, up: number, dist: number): Pose {
  const a = screenAxes(p);
  let d: Vec3 = [0, 0, 0];
  d = add(d, a.look, forward);
  d = add(d, a.right, right);
  d = add(d, UP, up);
  const l = length(d);
  if (l < 1e-9) return p;
  d = [(d[0] / l) * dist, (d[1] / l) * dist, (d[2] / l) * dist];
  return { fov: p.fov, position: add(p.position, d), target: add(p.target, d) };
}

/**
 * Speed of flying, world units per second (08 §5.3):
 * `clamp(s · k · d_near, v_min, v_max)` with `k = 1.5 /s`, ×4 with Shift.
 */
export function flySpeed(near: number, scale: number, fast: boolean, vMax: number): number {
  const v = scale * 1.5 * near * (fast ? 4 : 1);
  return Math.min(Math.max(5, vMax), Math.max(5, v));
}

/**
 * The nearest star ahead (08 §5.3): within a cone of 30° around the look,
 * from `pos` (3 floats per body); `Infinity` when there is none.
 */
export function nearAhead(p: Pose, pos: Float32Array, count: number): number {
  const { look } = screenAxes(p);
  const cos = Math.cos((15 * Math.PI) / 180);
  const [cx, cy, cz] = p.position;
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < count; i++) {
    const dx = (pos[i * 3] ?? 0) - cx;
    const dy = (pos[i * 3 + 1] ?? 0) - cy;
    const dz = (pos[i * 3 + 2] ?? 0) - cz;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d < 1 || d >= best) continue;
    if ((dx * look[0] + dy * look[1] + dz * look[2]) / d >= cos) best = d;
  }
  return best;
}
