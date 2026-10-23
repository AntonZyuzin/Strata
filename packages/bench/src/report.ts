import type { BoardResult } from './board';
import type { BridgeResult } from './bridge';
import type { CanvasResult } from './canvas';
import type { Environment } from './env';
import type { LookResult } from './look';
import type { LoroIndexResult, LoroTextResult } from './loro';
import type { NoteResult } from './note';
import type { MapResult } from './starmap';

/**
 * The report format and its summary, without Pixi or Loro: the UI imports this
 * at startup and loads the runner (`@strata/bench`) only when a run starts.
 */

export type {
  BoardResult,
  BridgeResult,
  CanvasResult,
  Environment,
  LookResult,
  LoroIndexResult,
  LoroTextResult,
  MapResult,
  NoteResult,
};

/**
 * `full` is the run the owner makes on MO-mac and MO-win (15 §8.3); `quick`
 * is a smaller copy for the e2e tests in CI, where WebGL is software (14 §17).
 */
export type Profile = 'full' | 'quick';

/** Canvas ids follow the benches of 14 §17 and the sets of 14 §1.3. */
export const SCENARIO_IDS = [
  'canvas-pan-zoom-n5k',
  'canvas-drag-n5k',
  'canvas-pan-zoom-n10k',
  'canvas-look-n5k',
  'map-orbit-20k',
  'bridge-2d-3d',
  'loro-index-20k',
  'loro-index-100k-k16',
  'loro-text-1mb',
  'board-b2k',
  'note-1mb',
] as const;

export type ScenarioId = (typeof SCENARIO_IDS)[number];

export interface ScenarioOutcome {
  id: ScenarioId;
  /** Spike number from 16 §3.2. */
  spike: number;
  ok: boolean;
  result?: unknown;
  error?: string;
  wallMs: number;
}

export interface AppInfo {
  core: string | null;
  shell: string;
  webview?: string | null;
  /** OS, CPU and RAM as the core sees them (14 §1.2); the WebView cannot tell. */
  machine?: unknown;
}

export interface BenchReport {
  report: 'strata-bench';
  version: 1;
  profile: Profile;
  /** First in the JSON so it reads at a glance: verdict per scenario, Loro workers used. */
  summary: { verdicts: Partial<Record<ScenarioId, Verdict>>; workers: boolean | null };
  /** From the desktop core over IPC; `null` core in a plain browser. */
  app: AppInfo;
  /** The screen wake lock was granted for the run. */
  wakeLock: boolean;
  startedAt: string;
  env: Environment;
  outcomes: ScenarioOutcome[];
}

/** The numbers the results table shows; the UI formats them through i18n. */
export type Headline =
  | { kind: 'canvas'; fps: number; p95: number }
  | { kind: 'bridge'; p95: number; firstFrame: number; diff: number }
  | { kind: 'note'; openMs: number; keyP95: number }
  | { kind: 'board'; fps: number; p95: number; openMs: number }
  | {
      kind: 'index';
      importMs: number;
      /** `null` when measured on the main thread: there it is the build's peak, not the import. */
      memoryMib: number | null;
      editMean: number;
      firstEdit: number;
    }
  | { kind: 'text'; insertMs: number; keyMean: number; keyMax: number }
  | { kind: 'error'; message: string };

export function headline(o: ScenarioOutcome): Headline {
  if (!o.ok) return { kind: 'error', message: firstLine(o.error) };
  const r = o.result as Partial<
    CanvasResult & BridgeResult & BoardResult & LoroIndexResult & LoroTextResult & NoteResult
  >;
  if (r.openMs !== undefined && r.keyWorkMs)
    return { kind: 'note', openMs: r.openMs, keyP95: r.keyWorkMs.p95 };
  if (r.boardOpenMs !== undefined && r.fps !== undefined && r.p95Ms !== undefined)
    return { kind: 'board', fps: r.fps, p95: r.p95Ms, openMs: r.boardOpenMs };
  if (r.frame0Diff !== undefined && r.firstFrameMs && r.p95Ms !== undefined)
    return {
      kind: 'bridge',
      p95: r.p95Ms,
      firstFrame: r.firstFrameMs.p50,
      diff: r.frame0Diff,
    };
  // The gate reads the median of the runs' p95 (14 §1.4).
  if (r.fps !== undefined && r.p95Ms !== undefined)
    return { kind: 'canvas', fps: r.fps, p95: r.p95Ms };
  // Means, not p95: WebKit timers are 1 ms coarse, sub-millisecond p95 reads as 0.
  if (r.importMs !== undefined && r.editMs && r.editMeanMs !== undefined)
    return {
      kind: 'index',
      importMs: r.importMs,
      memoryMib: r.isolated === false ? null : (r.importMemoryMib ?? null),
      editMean: r.editMeanMs,
      firstEdit: r.firstEditMs ?? 0,
    };
  if (r.insert1MbMs !== undefined && r.keystrokeMs && r.keystrokeMeanMs !== undefined)
    return {
      kind: 'text',
      insertMs: r.insert1MbMs,
      keyMean: r.keystrokeMeanMs,
      keyMax: r.keystrokeMs.max,
    };
  return { kind: 'error', message: 'unexpected result' };
}

const firstLine = (s = '') => s.split('\n')[0] ?? '';

/**
 * Thresholds of the gate: frames from 14 §2 (NFR-01, NFR-02, NFR-03),
 * Loro from the spike 4 criterion (16 §3.2).
 */
export const THRESHOLDS = {
  frameP95Ms: {
    'canvas-pan-zoom-n5k': 1000 / 60,
    'canvas-drag-n5k': 1000 / 60,
    'canvas-pan-zoom-n10k': 1000 / 30,
    'canvas-look-n5k': 1000 / 60,
    'map-orbit-20k': 1000 / 60,
    'bridge-2d-3d': 1000 / 60,
    'board-b2k': 1000 / 60,
  },
  /** NFR-30: a B-2k board's first frame. */
  boardOpenMs: 1000,
  /** NFR-15: `M` → first 3D frame with the layout cached. */
  firstFrameMs: 100,
  /** NFR-29: a 1 MB note opens in ≤ 1 s; NFR-33: a character shows in ≤ 16 ms p95. */
  noteOpenMs: 1000,
  noteKeyMs: 16,
  /** Spike 3: frame 0 of the map against the canvas (08 §7.1). */
  frame0Diff: 0.01,
  indexImportMs: 500,
  indexMemoryMib: 200,
  editMs: 5,
  /** The first write after the lazy import must fit in a frame (S4: the reason to shard). */
  firstEditMs: 1000 / 60,
  textInsertMs: 200,
  keystrokeMs: 16,
} as const;

export type Verdict = 'pass' | 'fail';

/**
 * Pass or fail of one scenario. Frame limits get the timer's slack, at least
 * 0.5 ms: WebKit floors timestamps to 1 ms (a perfect 60 Hz run reads p95 = 17)
 * and Chromium clamps them to 0.1 ms with jitter (16.8–17.1). Counting in
 * vsync periods instead would pass WKWebView's uneven 18–22 ms frames.
 */
export function verdict(o: ScenarioOutcome, timerResolutionMs = 0): Verdict {
  const h = headline(o);
  const slack = Math.max(timerResolutionMs, 0.5);
  switch (h.kind) {
    case 'canvas': {
      const limit = THRESHOLDS.frameP95Ms[o.id as keyof typeof THRESHOLDS.frameP95Ms];
      return limit !== undefined && h.p95 <= limit + slack ? 'pass' : 'fail';
    }
    case 'bridge':
      return h.p95 <= THRESHOLDS.frameP95Ms['bridge-2d-3d'] + slack &&
        h.firstFrame <= THRESHOLDS.firstFrameMs &&
        h.diff <= THRESHOLDS.frame0Diff
        ? 'pass'
        : 'fail';
    case 'board':
      return h.p95 <= THRESHOLDS.frameP95Ms['board-b2k'] + slack &&
        h.openMs <= THRESHOLDS.boardOpenMs
        ? 'pass'
        : 'fail';
    case 'note':
      return h.openMs <= THRESHOLDS.noteOpenMs && h.keyP95 <= THRESHOLDS.noteKeyMs + slack
        ? 'pass'
        : 'fail';
    case 'index':
      return h.importMs < THRESHOLDS.indexImportMs &&
        (h.memoryMib === null || h.memoryMib < THRESHOLDS.indexMemoryMib) &&
        h.editMean < THRESHOLDS.editMs &&
        h.firstEdit <= THRESHOLDS.firstEditMs + slack
        ? 'pass'
        : 'fail';
    case 'text':
      return h.insertMs <= THRESHOLDS.textInsertMs && h.keyMean <= THRESHOLDS.keystrokeMs
        ? 'pass'
        : 'fail';
    case 'error':
      return 'fail';
  }
}
