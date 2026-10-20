import type { CanvasResult } from './canvas';
import type { Environment } from './env';
import type { LoroIndexResult, LoroTextResult } from './loro';

/**
 * The report format and its summary, without Pixi or Loro: the UI imports this
 * at startup and loads the runner (`@strata/bench`) only when a run starts.
 */

export type { CanvasResult, Environment, LoroIndexResult, LoroTextResult };

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
  'loro-index-20k',
  'loro-index-100k',
  'loro-text-1mb',
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
  /** From the desktop core over IPC; `null` core in a plain browser. */
  app: AppInfo;
  startedAt: string;
  env: Environment;
  outcomes: ScenarioOutcome[];
}

/** The numbers the results table shows; the UI formats them through i18n. */
export type Headline =
  | { kind: 'canvas'; fps: number; p95: number }
  | { kind: 'index'; importMs: number; editMean: number; editMax: number }
  | { kind: 'text'; insertMs: number; keyMean: number; keyMax: number }
  | { kind: 'error'; message: string };

export function headline(o: ScenarioOutcome): Headline {
  if (!o.ok) return { kind: 'error', message: firstLine(o.error) };
  const r = o.result as Partial<CanvasResult & LoroIndexResult & LoroTextResult>;
  if (r.fps !== undefined && r.intervalMs)
    return { kind: 'canvas', fps: r.fps, p95: r.intervalMs.p95 };
  // Means, not p95: WebKit timers are 1 ms coarse, sub-millisecond p95 reads as 0.
  if (r.importMs !== undefined && r.editMs && r.editMeanMs !== undefined)
    return {
      kind: 'index',
      importMs: r.importMs,
      editMean: r.editMeanMs,
      editMax: Math.max(r.editMs.max, r.firstEditMs ?? 0),
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
