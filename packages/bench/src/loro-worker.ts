import { buildIndex, measureIndex } from './loro-core';

/**
 * Bench worker: each task runs in a fresh worker, so it has its own WASM
 * instance and its memory reading is not inflated by earlier tasks (WASM
 * memory never shrinks). Workers with WASM are what search and layout use
 * too (15 §4.2), so this also checks them in WKWebView and WebView2.
 */

export type LoroTask =
  | { type: 'build'; nodes: number; commitEvery: number; shards: number }
  | { type: 'measure'; snapshots: Uint8Array[]; nodes: number; shards: number };

export type LoroReply = { ok: true; value: unknown } | { ok: false; error: string };

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<LoroTask>) => void) | null;
  postMessage(message: LoroReply, transfer?: Transferable[]): void;
};

scope.onmessage = async (e) => {
  try {
    const task = e.data;
    if (task.type === 'build') {
      const built = await buildIndex(task.nodes, task.commitEvery, task.shards);
      scope.postMessage(
        { ok: true, value: built },
        built.snapshots.map((s) => s.buffer as ArrayBuffer),
      );
    } else {
      scope.postMessage({
        ok: true,
        value: await measureIndex(task.snapshots, task.nodes, task.shards),
      });
    }
  } catch (err) {
    scope.postMessage({ ok: false, error: String((err as Error)?.stack ?? err) });
  }
};
