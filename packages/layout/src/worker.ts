/// <reference lib="webworker" />
import {
  createForce3d,
  type ForceParams,
  type ForceSprings,
  loadLayout,
  type Physics3d,
} from './index';

/**
 * The star map's physics in a worker (08 §3.1): the main thread never waits
 * for a tick. Messages:
 *
 * - `start`: bodies, masses, springs, settings, pinned bodies; a full layout
 *   of `ticks` ticks cooling to `alphaMin` (none: the bodies are only taken
 *   in), then `done` with the positions;
 * - `freeze`: which bodies stay where they are — the live physics moves only
 *   those near a touched star (08 §3.1 p. 4), pinned ones never (08 §3.6);
 * - `relax`: `ticks` ticks at alpha `alpha`, answered by `done`: a new star
 *   or a removed wire settles its neighbourhood (08 §3.4);
 * - `tick`: `n` ticks from `alpha`, cooling by `cooling` each (a thrown
 *   star's flight, as many as the frame's time holds), answered by
 *   `positions` with the fastest free body's speed after them, how many of
 *   the last ticks were quieter than `rest`, and the alpha reached;
 * - `move`, `fix`, `velocity`: a body moved, fixed or thrown by hand.
 *
 * Positions travel as transferred `Float32Array`s: 240 KB for 20 000 bodies.
 */

/** A body kept in place: «Закрепить на карте» (08 §3.6). */
export interface PinnedBody {
  i: number;
  x: number;
  y: number;
  z: number;
}

export type ToWorker =
  | {
      type: 'start';
      pos: Float32Array;
      mass: Float32Array;
      springs: ForceSprings;
      params: ForceParams;
      ticks: number;
      alphaMin: number;
      pinned?: PinnedBody[];
    }
  | { type: 'freeze'; mask: Uint8Array }
  | { type: 'relax'; ticks: number; alpha: number }
  | { type: 'tick'; alpha: number; n?: number; cooling?: number; rest?: number }
  | { type: 'move'; i: number; x: number; y: number; z: number }
  | { type: 'fix'; i: number; on: boolean }
  | { type: 'velocity'; i: number; x: number; y: number; z: number };

export type FromWorker =
  | { type: 'done'; pos: Float32Array; ms: number }
  | {
      type: 'positions';
      pos: Float32Array;
      ms: number;
      speed: number;
      /** Ticks at the end in a row whose fastest body was slower than `rest`. */
      quiet: number;
      alpha: number;
    };

declare const self: DedicatedWorkerGlobalScope;

let sim: Physics3d | null = null;

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  await loadLayout();
  if (m.type === 'start') {
    sim?.free();
    sim = createForce3d(m.pos, m.mass, m.springs, m.params);
    for (const p of m.pinned ?? []) {
      sim.setPosition(p.i, p.x, p.y, p.z);
      sim.setFixed(p.i, true);
    }
    const t0 = performance.now();
    if (m.ticks > 0) sim.run(m.ticks, m.alphaMin);
    post({ type: 'done', pos: sim.positions(), ms: performance.now() - t0 });
    return;
  }
  if (!sim) return;
  if (m.type === 'freeze') {
    sim.setFrozen(m.mask);
  } else if (m.type === 'relax') {
    const t0 = performance.now();
    for (let k = 0; k < m.ticks; k++) sim.tick(m.alpha);
    post({ type: 'done', pos: sim.positions(), ms: performance.now() - t0 });
  } else if (m.type === 'tick') {
    const t0 = performance.now();
    let alpha = m.alpha;
    let speed = 0;
    let quiet = 0;
    for (let k = 0; k < (m.n ?? 1); k++) {
      sim.tick(alpha);
      alpha *= m.cooling ?? 1;
      speed = sim.maxSpeed();
      quiet = speed < (m.rest ?? 0) ? quiet + 1 : 0;
    }
    const pos = sim.positions();
    post({ type: 'positions', pos, ms: performance.now() - t0, speed, quiet, alpha });
  } else if (m.type === 'move') {
    sim.setPosition(m.i, m.x, m.y, m.z);
  } else if (m.type === 'fix') {
    sim.setFixed(m.i, m.on);
  } else if (m.type === 'velocity') {
    sim.setVelocity(m.i, m.x, m.y, m.z);
  }
};

function post(msg: FromWorker): void {
  self.postMessage(msg, [msg.pos.buffer]);
}
