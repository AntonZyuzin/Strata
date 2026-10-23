/// <reference lib="webworker" />
import {
  type LayoutNet,
  type LayoutSpacing,
  layoutNetwork,
  loadLayout,
  type NetLayout,
} from './index';

/**
 * `L` in a worker (06 §9.2, NFR-08): the main thread never waits for a
 * layout. A request carries its id; the answer has the positions, or the
 * error, and the time spent.
 */

export interface LayoutRequest {
  id: number;
  kind: NetLayout;
  net: LayoutNet;
  spacing: LayoutSpacing;
}

export type LayoutAnswer =
  | { id: number; pos: Float32Array; ms: number }
  | { id: number; error: string };

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = async (e: MessageEvent<LayoutRequest>) => {
  const { id, kind, net, spacing } = e.data;
  try {
    await loadLayout();
    const t0 = performance.now();
    const pos = layoutNetwork(net, kind, spacing);
    const answer: LayoutAnswer = { id, pos, ms: performance.now() - t0 };
    self.postMessage(answer, [pos.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String(err) } satisfies LayoutAnswer);
  }
};
