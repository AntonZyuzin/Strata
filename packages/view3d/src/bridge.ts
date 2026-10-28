import type { StarMap } from './starmap';

/**
 * The camera bridge between the 2D canvas and the star map (08 §7, spike 3).
 *
 * Frame 0 (08 §7.1): the current network lies in the plane z = 0 in the
 * canvas's own world units, y flipped; a perspective camera looks straight at
 * it from the distance where the plane is drawn at Pixi's zoom, so the plane
 * maps onto the screen exactly. The 2D frame itself is laid on that plane
 * (`StarMap.setSnapshot`), which makes frame 0 the canvas pixel for pixel.
 *
 * Then 600 ms (08 §7.2): the 2D frame fades in 150 ms while the network's
 * straight 3D wires replace its curves; the camera pulls back and tilts by
 * 25°, the field of view opens from 15° to 60°; the network's stars fly from
 * the plane to their 3D places, the ones far from the centre up to 100 ms
 * later; the rest of the space shows in 400–600 ms. The way back plays the
 * same frames in reverse from wherever the user left the 3D camera, and ends
 * on the canvas's frame.
 */

/** The canvas camera as Pixi has it: the world point at the top-left corner and px per unit. */
export interface View2D {
  x: number;
  y: number;
  zoom: number;
  /** Viewport, CSS px. */
  width: number;
  height: number;
}

export interface Pose {
  position: [number, number, number];
  target: [number, number, number];
  /** Vertical field of view, degrees. */
  fov: number;
}

export const BRIDGE_MS = 600;
/** First-frame field of view: narrow, so the tilt does not bend the plane sharply (08 §7.1). */
export const BRIDGE_FOV = 15;
export const MAP_FOV = 60;
const TILT = (25 * Math.PI) / 180;
const SNAPSHOT_MS = 150;
const DELAY_MS = 100;
const OTHERS_FROM_MS = 400;

/** A 2D world point on the plane z = 0. */
export function toPlane(x: number, y: number): [number, number, number] {
  return [x, -y, 0];
}

/**
 * The pose that draws the plane z = 0 as Pixi draws the world (08 §7.1):
 * d = H / (2 · zoom · tan(φ / 2)) in front of the viewport's centre.
 */
export function planePose(v: View2D, fov = BRIDGE_FOV): Pose {
  const cx = v.x + v.width / 2 / v.zoom;
  const cy = v.y + v.height / 2 / v.zoom;
  const d = v.height / (2 * v.zoom * Math.tan((fov * Math.PI) / 360));
  return { position: [cx, -cy, d], target: [cx, -cy, 0], fov };
}

/** The world rectangle the canvas shows, for the snapshot (2D units, y down). */
export function viewRect(v: View2D): { x0: number; y0: number; x1: number; y1: number } {
  return { x0: v.x, y0: v.y, x1: v.x + v.width / v.zoom, y1: v.y + v.height / v.zoom };
}

/** cubic-bezier(.2,.8,.2,1) of 06 §1.4, as an ease-out cubic. */
function ease(k: number): number {
  const c = Math.min(1, Math.max(0, k));
  return 1 - (1 - c) ** 3;
}

function lerp(a: number, b: number, k: number): number {
  return a + (b - a) * k;
}

export function lerpPose(a: Pose, b: Pose, k: number): Pose {
  return {
    position: [0, 1, 2].map((i) => lerp(a.position[i] ?? 0, b.position[i] ?? 0, k)) as [
      number,
      number,
      number,
    ],
    target: [0, 1, 2].map((i) => lerp(a.target[i] ?? 0, b.target[i] ?? 0, k)) as [
      number,
      number,
      number,
    ],
    fov: lerp(a.fov, b.fov, k),
  };
}

export interface BridgeInput {
  view: View2D;
  /** Bodies of the current network. */
  members: Int32Array;
  /** Their 2D world positions, x and y per member, in the order of `members`. */
  flat: Float32Array;
  /**
   * 3D positions of every body (3 floats each). The bridge moves the whole
   * space so that the network's cluster sits on the plane's centre of its
   * bubbles: the stars fly out a short way, not across the map.
   */
  space: Float32Array;
  /** Bodies in the extract. */
  count: number;
}

/**
 * Plays the bridge on a `StarMap` whose data is set. `frame(ms)` draws the
 * state at `ms` (0…600) of the way 2D → 3D; the way back calls it with ms
 * going down. `pose3d` is the end pose; orbit controls may change it.
 */
export class Bridge {
  readonly plane: Pose;
  pose3d: Pose;
  /** 3D positions of all bodies, moved so the network's cluster sits on its plane. */
  readonly space: Float32Array;
  /**
   * How far the space was moved: drawn = laid out + offset. A live star's
   * place from the physics is drawn here; another bridge over the same
   * space moves the camera by the difference, and the screen stays.
   */
  readonly offset: [number, number, number];
  private readonly start: Float32Array;
  private readonly delay: Float32Array;
  private readonly work: Float32Array;
  private readonly members: Int32Array;

  constructor(
    private readonly map: StarMap,
    input: BridgeInput,
  ) {
    const { view, members, flat, count } = input;
    this.members = members;
    this.plane = planePose(view);
    // Centres of the network on the plane and in space.
    let px = 0;
    let py = 0;
    let sx = 0;
    let sy = 0;
    let sz = 0;
    const m = Math.max(1, members.length);
    members.forEach((b, j) => {
      px += flat[j * 2] ?? 0;
      py += flat[j * 2 + 1] ?? 0;
      sx += input.space[b * 3] ?? 0;
      sy += input.space[b * 3 + 1] ?? 0;
      sz += input.space[b * 3 + 2] ?? 0;
    });
    const [cx, cy] = toPlane(px / m, py / m);
    const dx = cx - sx / m;
    const dy = cy - sy / m;
    const dz = -sz / m;
    this.offset = [dx, dy, dz];
    this.space = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      this.space[i * 3] = (input.space[i * 3] ?? 0) + dx;
      this.space[i * 3 + 1] = (input.space[i * 3 + 1] ?? 0) + dy;
      this.space[i * 3 + 2] = (input.space[i * 3 + 2] ?? 0) + dz;
    }
    // Start: every member on the plane; delay grows with the distance from the centre.
    this.start = new Float32Array(members.length * 3);
    this.delay = new Float32Array(members.length);
    let far = 1;
    members.forEach((_, j) => {
      const [x, y] = toPlane(flat[j * 2] ?? 0, flat[j * 2 + 1] ?? 0);
      this.start.set([x, y, 0], j * 3);
      far = Math.max(far, Math.hypot(x - cx, y - cy));
    });
    members.forEach((_, j) => {
      const d = Math.hypot((this.start[j * 3] ?? 0) - cx, (this.start[j * 3 + 1] ?? 0) - cy);
      this.delay[j] = (DELAY_MS * d) / far;
    });
    // End: orbit around the cluster, tilted by 25°, at a distance that shows it whole.
    let r = 1;
    for (const b of members) {
      r = Math.max(
        r,
        Math.hypot(
          (this.space[b * 3] ?? 0) - cx,
          (this.space[b * 3 + 1] ?? 0) - cy,
          this.space[b * 3 + 2] ?? 0,
        ),
      );
    }
    const dist = Math.max(r * 2.8, this.plane.position[2] * 0.6);
    this.pose3d = {
      position: [cx, cy - dist * Math.sin(TILT), dist * Math.cos(TILT)],
      target: [cx, cy, 0],
      fov: MAP_FOV,
    };
    this.work = new Float32Array(count * 3);
    const focus = new Uint8Array(count);
    for (const b of members) focus[b] = 1;
    map.setFocus(focus);
  }

  /** Draws the bridge at `ms` from the 2D end; returns the draw calls. */
  frame(ms: number): number {
    const t = Math.min(BRIDGE_MS, Math.max(0, ms));
    const map = this.map;
    const pose = lerpPose(this.plane, this.pose3d, ease(t / BRIDGE_MS));
    applyPose(map, pose);
    this.work.set(this.space);
    const span = BRIDGE_MS - DELAY_MS;
    this.members.forEach((b, j) => {
      const k = ease((t - (this.delay[j] ?? 0)) / span);
      for (let a = 0; a < 3; a++) {
        this.work[b * 3 + a] = lerp(this.start[j * 3 + a] ?? 0, this.space[b * 3 + a] ?? 0, k);
      }
    });
    map.updatePositions(this.work);
    const snapshot = 1 - Math.min(1, t / SNAPSHOT_MS);
    const others = Math.min(1, Math.max(0, (t - OTHERS_FROM_MS) / (BRIDGE_MS - OTHERS_FROM_MS)));
    map.setSnapshotAlpha(snapshot);
    map.setFade(others, others, 1 - snapshot);
    return map.render();
  }
}

/** The pose moved by `d`: with the whole space moved by as much, the frame stays. */
export function shiftPose(p: Pose, d: readonly [number, number, number]): Pose {
  return {
    ...p,
    position: [p.position[0] + d[0], p.position[1] + d[1], p.position[2] + d[2]],
    target: [p.target[0] + d[0], p.target[1] + d[1], p.target[2] + d[2]],
  };
}

/** Points the map's camera by a pose. */
export function applyPose(map: StarMap, p: Pose): void {
  const cam = map.camera;
  cam.position.set(...p.position);
  cam.up.set(0, 1, 0);
  cam.lookAt(...p.target);
  cam.fov = p.fov;
  cam.updateProjectionMatrix();
}
