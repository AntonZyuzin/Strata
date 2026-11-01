import { vsyncGrid } from './frame-loop';
import { round, type Summary, summarize } from './stats';

/**
 * The `import` scenario (14 §6; NFR-40, NFR-41): V-10k, made by the core,
 * comes into a new workspace as a vault does — its batches land in the
 * background while the app's own workspace screen shows them («Ноды», the
 * canvas, «Импорт: N из M»). Meanwhile the camera flies the path of
 * `canvas-pan-zoom` over what has landed, and two clocks run: the frames
 * (NFR-41: p95 ≤ 33 ms) and a 10 ms timer whose longest wait is the longest
 * task of the main thread (NFR-41: none over 50 ms; the layout scenario's
 * method). NFR-40's times come with them: the first networks on the canvas
 * (≤ 5 s) and the whole import (≤ 60 s on M1).
 */
export interface ImportScenario {
  notes: number;
  vsyncMs: number;
  /** One flight of the camera, out and in. */
  cycleMs: number;
}

/** What the app gives the scenario: its workspace screen with an import under way. */
export interface ImportHost {
  /** Starts V-10k of `notes` notes into a new workspace, its screen on `stage`. */
  start(stage: HTMLElement, notes: number): Promise<ImportSession>;
}

/** The workspace an import comes into, on screen. */
export interface ImportSession {
  /** The canvas's camera, world units; null until the screen has its canvas. */
  camera(): { x: number; y: number; zoom: number } | null;
  /** Asks the canvas to draw: the camera moved. */
  invalidate(): void;
  /** The canvas's size, CSS px. */
  size(): { width: number; height: number };
  /** Where the canvas's nodes lie, world units; null while there are none. */
  bounds(): { minX: number; minY: number; maxX: number; maxY: number } | null;
  /** The batches as they land. */
  onBatch(listener: (done: number, total: number) => void): void;
  /** The import's end: the nodes it made, or its failure. */
  readonly done: Promise<{ nodes: number }>;
  /** The screen goes, and the workspace with it. */
  close(): Promise<void>;
}

export interface ImportResult {
  notes: number;
  /** Notes, tasks and lists the import made. */
  nodes: number;
  batches: number;
  /** From the start to the report (NFR-40: ≤ 60 s on M1). */
  importMs: number;
  /** From the start to the first nodes on the canvas (NFR-40: ≤ 5 s). */
  firstMs: number;
  frames: number;
  fps: number;
  /** p95 of frame time on the vsync grid (NFR-41: ≤ 33 ms). */
  p95Ms: number;
  rawP95Ms: number;
  intervalMs: Summary;
  vsyncMs: number;
  /** The 10 ms timer's longest wait: the longest task, plus up to 10 ms (NFR-41: 50 ms). */
  mainGapMs: number;
  /** Waits of the timer over 60 ms: tasks over 50 ms. */
  longTasks: number;
}

/** A wait of the 10 ms timer longer than this held a task over 50 ms. */
const LONG_TASK_GAP_MS = 60;

export async function runImportScenario(
  stage: HTMLElement,
  host: ImportHost | undefined,
  sc: ImportScenario,
): Promise<ImportResult> {
  if (!host) throw new Error('the import scenario runs in the app: it needs its workspace screen');
  const t0 = performance.now();
  // The main thread's longest pause from the start to the report.
  let last = t0;
  let mainGapMs = 0;
  let longTasks = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    const gap = now - last;
    mainGapMs = Math.max(mainGapMs, gap);
    if (gap > LONG_TASK_GAP_MS) longTasks++;
    last = now;
  }, 10);
  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;inset:0';
  stage.replaceChildren(container);
  let session: ImportSession | null = null;
  // The flight stops with the import, or with the scenario if it fails.
  let ended = false;
  try {
    session = await host.start(container, sc.notes);
    const s = session;
    let batches = 0;
    s.onBatch(() => {
      batches++;
    });
    let firstMs = Number.NaN;
    const intervals: number[] = [];
    const flight = new Promise<void>((resolve) => {
      let prev = 0;
      const frame = (now: number) => {
        if (ended) {
          resolve();
          return;
        }
        if (prev > 0) intervals.push(now - prev);
        prev = now;
        fly(s, (now - t0) / sc.cycleMs);
        if (Number.isNaN(firstMs) && s.bounds()) firstMs = now - t0;
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
    const { nodes } = await s.done;
    const importMs = performance.now() - t0;
    ended = true;
    await flight;
    clearInterval(timer);
    const grid = vsyncGrid(intervals, sc.vsyncMs);
    const elapsed = intervals.reduce((a, b) => a + b, 0);
    const raw = summarize(intervals);
    return {
      notes: sc.notes,
      nodes,
      batches,
      importMs: Math.round(importMs),
      firstMs: Math.round(Number.isNaN(firstMs) ? importMs : firstMs),
      frames: intervals.length,
      fps: elapsed > 0 ? round((intervals.length * 1000) / elapsed, 1) : 0,
      p95Ms: grid.p95Ms,
      rawP95Ms: raw.p95,
      intervalMs: raw,
      vsyncMs: sc.vsyncMs,
      mainGapMs: round(mainGapMs, 1),
      longTasks,
    };
  } finally {
    ended = true;
    clearInterval(timer);
    await session?.close();
    container.remove();
  }
}

/**
 * The camera of `canvas-pan-zoom` over what has landed so far: the whole of
 * it at the start of each cycle, a close-up at 1.6 in its middle.
 */
function fly(s: ImportSession, phase: number) {
  const cam = s.camera();
  const b = s.bounds();
  if (!cam || !b) return;
  const { width: w, height: h } = s.size();
  const all = Math.min(w / (b.maxX - b.minX + 200), h / (b.maxY - b.minY + 200), 1.6);
  const k = 0.5 - 0.5 * Math.cos(2 * Math.PI * phase);
  const zoom = Math.exp(Math.log(all) + (Math.log(1.6) - Math.log(all)) * k);
  const cx = b.minX + (b.maxX - b.minX) * (0.5 + 0.35 * Math.sin(2 * Math.PI * phase));
  const cy = b.minY + (b.maxY - b.minY) * (0.5 + 0.35 * Math.sin(4 * Math.PI * phase));
  cam.zoom = zoom;
  cam.x = cx - w / 2 / zoom;
  cam.y = cy - h / 2 / zoom;
  s.invalidate();
}
