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
 * - `start`: bodies, masses, springs, settings; a full layout of `ticks`
 *   ticks cooling to `alphaMin`, then `done` with the positions;
 * - `tick`: one tick at `alpha` (the live simulation of the active zone),
 *   answered by `positions`;
 * - `move`: a body moved by hand (a drag, a pinned star).
 *
 * Positions travel as transferred `Float32Array`s: 240 KB for 20 000 bodies.
 */

export type ToWorker =
  | {
      type: 'start';
      pos: Float32Array;
      mass: Float32Array;
      springs: ForceSprings;
      params: ForceParams;
      ticks: number;
      alphaMin: number;
    }
  | { type: 'tick'; alpha: number }
  | { type: 'move'; i: number; x: number; y: number; z: number };

export type FromWorker =
  | { type: 'done'; pos: Float32Array; ms: number }
  | { type: 'positions'; pos: Float32Array; ms: number };

declare const self: DedicatedWorkerGlobalScope;

let sim: Physics3d | null = null;

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  await loadLayout();
  if (m.type === 'start') {
    sim?.free();
    sim = createForce3d(m.pos, m.mass, m.springs, m.params);
    const t0 = performance.now();
    sim.run(m.ticks, m.alphaMin);
    const pos = sim.positions();
    post({ type: 'done', pos, ms: performance.now() - t0 });
  } else if (m.type === 'tick' && sim) {
    const t0 = performance.now();
    sim.tick(m.alpha);
    const pos = sim.positions();
    post({ type: 'positions', pos, ms: performance.now() - t0 });
  } else if (m.type === 'move' && sim) {
    sim.setPosition(m.i, m.x, m.y, m.z);
  }
};

function post(msg: FromWorker): void {
  self.postMessage(msg, [msg.pos.buffer]);
}
