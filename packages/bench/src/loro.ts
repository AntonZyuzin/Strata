import { type BuiltIndex, buildIndex, type IndexMeasure, measureIndex } from './loro-core';
import type { LoroReply, LoroTask } from './loro-worker';

export { type LoroTextResult, runLoroText } from './loro-core';

export interface LoroIndexResult extends IndexMeasure {
  commitEvery: number;
  buildMs: number;
  snapshotMib: number;
  /** Built and measured in fresh workers; `false` — the fallback on the main thread. */
  isolated: boolean;
  /** Why the workers were not used, if they were not. */
  workerError?: string;
}

/** The worker could not start: fall back to the main thread and say so in the report. */
class WorkerUnavailable extends Error {}

// A commit per node makes the 100k build slow on a weak CPU; the build is not measured.
const WORKER_TIMEOUT_MS = 300_000;

function inWorker<T>(task: LoroTask, transfer: Transferable[] = []): Promise<T> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./loro-worker.ts', import.meta.url), { type: 'module' });
    } catch (e) {
      reject(new WorkerUnavailable(String(e)));
      return;
    }
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error(`loro worker: no answer in ${WORKER_TIMEOUT_MS / 1000} s`));
    }, WORKER_TIMEOUT_MS);
    const done = () => {
      clearTimeout(timer);
      worker.terminate();
    };
    worker.onmessage = (e: MessageEvent<LoroReply>) => {
      done();
      if (e.data.ok) resolve(e.data.value as T);
      else reject(new Error(e.data.error));
    };
    // Errors inside a task come back as messages; `error` means the worker did not load.
    worker.onerror = (e) => {
      done();
      reject(new WorkerUnavailable(e.message || 'worker failed to load'));
    };
    worker.postMessage(task, transfer);
  });
}

/** Index scenario: build in one fresh worker, import and edit in another. */
export async function runLoroIndex(
  nodes: number,
  commitEvery: number,
  shards: number,
): Promise<LoroIndexResult> {
  try {
    const built = await inWorker<BuiltIndex>({ type: 'build', nodes, commitEvery, shards });
    const measured = await inWorker<IndexMeasure>(
      { type: 'measure', snapshots: built.snapshots, nodes, shards },
      built.snapshots.map((s) => s.buffer as ArrayBuffer),
    );
    return {
      ...measured,
      commitEvery,
      buildMs: built.buildMs,
      snapshotMib: built.snapshotMib,
      isolated: true,
    };
  } catch (e) {
    if (!(e instanceof WorkerUnavailable)) throw e;
    const built = await buildIndex(nodes, commitEvery, shards);
    const measured = await measureIndex(built.snapshots, nodes, shards);
    return {
      ...measured,
      commitEvery,
      buildMs: built.buildMs,
      snapshotMib: built.snapshotMib,
      isolated: false,
      workerError: e.message,
    };
  }
}
