/**
 * Kinetic wires (06 §6.2, §6.8), without drawing: the control points of a
 * wire whose ends moved lag behind on a critically damped spring and settle
 * in 200–300 ms without overshoot; the wires of a node just selected jitter
 * for three cycles of 0.8 s, then stand. Only active wires move — at most
 * MAX_ACTIVE at once (06 §6.8, the rule of performance); the rest draw still.
 *
 * The view calls `frame` once per rendered frame, then `follow` for every
 * wire with the control points it would draw now; `kick` is the offset of
 * both control points to add, world units. Wires are kept by key across
 * `bind`, so a step that rebuilds the wire list does not stop them.
 */

/** ω of the spring, 1/s: from rest it is within 1 % of its target after ≈ 0.24 s. */
export const SPRING = 28;
/** The jitter: amplitude in screen px, period, cycles (06 §6.8). */
export const JITTER_PX = 6;
export const JITTER_MS = 800;
export const JITTER_CYCLES = 3;
/** Wires that move at once (06 §6.8). */
export const MAX_ACTIVE = 256;
/** A frame longer than this is a pause, not a step: the spring does not jump. */
const MAX_DT = 0.05;
/** At rest below a quarter of a unit and four units a second: no visible step left. */
const REST = 0.25;
const REST_SPEED = 4;

export class Kinetics {
  private keys: string[] = [];
  private index = new Map<string, number>();
  private target = new Float64Array(0);
  private known = new Uint8Array(0);
  private disp = new Float64Array(0);
  private vel = new Float64Array(0);
  private out = new Float64Array(0);
  private readonly active = new Set<number>();
  private readonly shaken = new Map<number, number>();
  private now = 0;
  private dt = 0;

  /** The wires drawn now, by key; the state of the ones that stay moves with them. */
  bind(keys: readonly string[]): void {
    const old = {
      index: this.index,
      target: this.target,
      known: this.known,
      disp: this.disp,
      vel: this.vel,
    };
    const active = [...this.active].map((i) => this.keys[i]);
    const shaken = [...this.shaken].map(([i, t]) => [this.keys[i], t] as const);
    const n = keys.length;
    this.keys = [...keys];
    this.index = new Map(keys.map((k, i) => [k, i]));
    this.target = new Float64Array(n * 4);
    this.known = new Uint8Array(n);
    this.disp = new Float64Array(n * 4);
    this.vel = new Float64Array(n * 4);
    this.out = new Float64Array(n * 4);
    for (const [k, i] of this.index) {
      const j = old.index.get(k);
      if (j === undefined) continue;
      this.known[i] = old.known[j] ?? 0;
      for (let c = 0; c < 4; c++) {
        this.target[i * 4 + c] = old.target[j * 4 + c] ?? 0;
        this.disp[i * 4 + c] = old.disp[j * 4 + c] ?? 0;
        this.vel[i * 4 + c] = old.vel[j * 4 + c] ?? 0;
      }
    }
    this.active.clear();
    for (const k of active) {
      const i = k === undefined ? undefined : this.index.get(k);
      if (i !== undefined) this.active.add(i);
    }
    this.shaken.clear();
    for (const [k, t] of shaken) {
      const i = k === undefined ? undefined : this.index.get(k);
      if (i !== undefined) this.shaken.set(i, t);
    }
  }

  /** Forgets every motion: the style is no longer kinetic, or motion is reduced. */
  reset(): void {
    this.known.fill(0);
    this.disp.fill(0);
    this.vel.fill(0);
    this.out.fill(0);
    this.active.clear();
    this.shaken.clear();
  }

  /** Starts a frame at `now`, ms. */
  frame(now: number): void {
    this.dt = this.now === 0 ? 0 : Math.min(Math.max((now - this.now) / 1000, 0), MAX_DT);
    this.now = now;
  }

  /** The wire `key` starts its jitter: a node at one of its ends was just selected. */
  shake(key: string): void {
    const i = this.index.get(key);
    if (i !== undefined && !this.shaken.has(i)) this.shaken.set(i, this.now);
  }

  /**
   * The control points the wire `i` would draw now, `c` = [x0, y0, x1, y1,
   * x2, y2, x3, y3] in world units; returns the offsets of its two inner
   * control points, or null when it stands. `zoom` turns the jitter's screen
   * px into world units.
   */
  follow(i: number, c: readonly number[], zoom: number): Float64Array | null {
    const t = this.target;
    const d = this.disp;
    const v = this.vel;
    const o = i * 4;
    const next = [c[2] ?? 0, c[3] ?? 0, c[4] ?? 0, c[5] ?? 0];
    if (this.known[i]) {
      let moved = false;
      for (let k = 0; k < 4; k++) if (next[k] !== t[o + k]) moved = true;
      // Where the curve was drawn stays for a moment: the lag is the jump.
      if (moved && (this.active.has(i) || this.active.size < MAX_ACTIVE)) {
        for (let k = 0; k < 4; k++) d[o + k] = (d[o + k] ?? 0) + (t[o + k] ?? 0) - (next[k] ?? 0);
        this.active.add(i);
      }
    }
    this.known[i] = 1;
    for (let k = 0; k < 4; k++) t[o + k] = next[k] ?? 0;
    let still = true;
    if (this.active.has(i)) {
      // The exact step of a critically damped spring: no overshoot at any dt.
      const w = SPRING;
      const dt = this.dt;
      const e = Math.exp(-w * dt);
      for (let k = 0; k < 4; k++) {
        const x = d[o + k] ?? 0;
        const u = v[o + k] ?? 0;
        const b = u + w * x;
        d[o + k] = (x + b * dt) * e;
        v[o + k] = (u - w * b * dt) * e;
        if (Math.abs(d[o + k] ?? 0) > REST || Math.abs(v[o + k] ?? 0) > REST_SPEED) still = false;
      }
      if (still) {
        for (let k = 0; k < 4; k++) {
          d[o + k] = 0;
          v[o + k] = 0;
        }
        this.active.delete(i);
      }
    }
    const out = this.out;
    for (let k = 0; k < 4; k++) out[o + k] = d[o + k] ?? 0;
    const since = this.shaken.get(i);
    if (since !== undefined) {
      const phase = (this.now - since) / JITTER_MS;
      if (phase >= JITTER_CYCLES) this.shaken.delete(i);
      else {
        // Across the chord, the two control points in opposite directions: an S that sways.
        const dx = (c[6] ?? 0) - (c[0] ?? 0);
        const dy = (c[7] ?? 0) - (c[1] ?? 0);
        const len = Math.hypot(dx, dy) || 1;
        const a = (Math.sin(phase * 2 * Math.PI) * JITTER_PX) / zoom;
        const nx = (-dy / len) * a;
        const ny = (dx / len) * a;
        out[o] = (out[o] ?? 0) + nx;
        out[o + 1] = (out[o + 1] ?? 0) + ny;
        out[o + 2] = (out[o + 2] ?? 0) - nx;
        out[o + 3] = (out[o + 3] ?? 0) - ny;
        still = false;
      }
    }
    return still && !this.active.has(i) ? null : out.subarray(o, o + 4);
  }

  /** The offsets `follow` gave the wire `key` this frame, or null. */
  kickOf(key: string): Float64Array | null {
    const i = this.index.get(key);
    if (i === undefined) return null;
    const o = i * 4;
    const out = this.out.subarray(o, o + 4);
    return out.some((x) => x !== 0) ? out : null;
  }

  /** Something still moves: one more frame is needed. */
  get moving(): boolean {
    return this.active.size > 0 || this.shaken.size > 0;
  }
}
