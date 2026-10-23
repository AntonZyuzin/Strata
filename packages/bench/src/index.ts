import { runBridgeScenario } from './bridge';
import { runCanvasScenario } from './canvas';
import { collectEnvironment, type Environment } from './env';
import { describeError } from './errors';
import { onStallWait } from './frame-loop';
import { runLookScenario } from './look';
import { runLoroIndex, runLoroText } from './loro';
import { runNoteScenario } from './note';
import {
  type AppInfo,
  type BenchReport,
  type Profile,
  type ScenarioId,
  type ScenarioOutcome,
  verdict,
} from './report';
import { runMapScenario } from './starmap';

export * from './report';

/** One benchmark of step 0.3 (16 §3.2): spikes 1 and 4 on the owner's machines. */
export interface Scenario {
  id: ScenarioId;
  spike: number;
  /** Needs the full-window stage (it draws). */
  draws: boolean;
  run(stage: HTMLElement, env: Environment): Promise<unknown>;
}

async function requestWakeLock(): Promise<{ release(): Promise<void> } | null> {
  const nav = navigator as Navigator & {
    wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> };
  };
  try {
    return (await nav.wakeLock?.request('screen')) ?? null;
  } catch {
    return null;
  }
}

/**
 * CI's software WebGL draws a heavy frame in over a second: in the `quick`
 * profile such a frame is not «the display slept» (frame-loop.ts).
 */
const QUICK_STALL_MS = 60_000;

export function scenarios(profile: Profile = 'full'): readonly Scenario[] {
  const q = profile === 'quick';
  // Frame method of 14 §1.4: 2 s warmup, 5 runs of 10 s, median p95.
  // N-5k has 7 500 wires, N-10k 15 000 (14 §1.3).
  const canvas =
    (mode: 'pan-zoom' | 'drag', nodes: number, wires: number) =>
    (s: HTMLElement, env: Environment) =>
      runCanvasScenario(s, {
        mode,
        nodes: q ? nodes / 5 : nodes,
        wires: q ? wires / 5 : wires,
        warmupMs: q ? 300 : 2_000,
        runMs: q ? 1_500 : 10_000,
        runs: q ? 1 : 5,
        vsyncMs: env.vsyncMs,
        stallMs: q ? QUICK_STALL_MS : undefined,
      });
  return [
    { id: 'canvas-pan-zoom-n5k', spike: 1, draws: true, run: canvas('pan-zoom', 5_000, 7_500) },
    { id: 'canvas-drag-n5k', spike: 1, draws: true, run: canvas('drag', 5_000, 7_500) },
    { id: 'canvas-pan-zoom-n10k', spike: 1, draws: true, run: canvas('pan-zoom', 10_000, 15_000) },
    // R7 §8 item 4: the prototype's canvas with the whole look of 07 at N-5k.
    {
      id: 'canvas-look-n5k',
      spike: 9,
      draws: true,
      run: (s, env) =>
        runLookScenario(s, {
          nodes: q ? 1_000 : 5_000,
          warmupMs: q ? 300 : 2_000,
          runMs: q ? 1_500 : 10_000,
          runs: q ? 1 : 5,
          vsyncMs: env.vsyncMs,
          stallMs: q ? QUICK_STALL_MS : undefined,
          gpuFrames: q ? 6 : 120,
        }),
    },
    // NFR-12: 20 000 stars, 30 000 wires, fog, bloom at ½ (08 §8.1).
    {
      id: 'map-orbit-20k',
      spike: 2,
      draws: true,
      run: (s, env) =>
        runMapScenario(s, {
          stars: q ? 2_000 : 20_000,
          wires: q ? 3_000 : 30_000,
          bloom: true,
          warmupMs: q ? 300 : 2_000,
          runMs: q ? 1_500 : 10_000,
          runs: q ? 1 : 5,
          vsyncMs: env.vsyncMs,
          stallMs: q ? QUICK_STALL_MS : undefined,
          gpuFrames: q ? 6 : 120,
        }),
    },
    // Spike 3: frame 0 ≤ 1 % of pixels, NFR-15, the 600 ms flight (08 §7).
    {
      id: 'bridge-2d-3d',
      spike: 3,
      draws: true,
      run: (s, env) =>
        runBridgeScenario(s, {
          rest: q ? 2_000 : 20_000,
          restWires: q ? 3_000 : 30_000,
          warmupMs: q ? 300 : 2_000,
          runMs: q ? 1_200 : 9_600,
          runs: q ? 1 : 5,
          vsyncMs: env.vsyncMs,
          stallMs: q ? QUICK_STALL_MS : undefined,
          tries: q ? 2 : 5,
        }),
    },
    // One shard up to ≈ 20k nodes, 16 above (10 §2.7); one commit per node, as in S4.
    // 100k on one shard (S4's worst case) is not a configuration the app uses; the
    // first Mac run measured it: 60 ms first edit.
    {
      id: 'loro-index-20k',
      spike: 4,
      draws: false,
      run: () => runLoroIndex(q ? 2_000 : 20_000, 1, 1),
    },
    {
      id: 'loro-index-100k-k16',
      spike: 4,
      draws: false,
      run: () => runLoroIndex(q ? 10_000 : 100_000, 1, 16),
    },
    { id: 'loro-text-1mb', spike: 4, draws: false, run: () => runLoroText() },
    // Spike 6: the note editor on T-1M (NFR-29, NFR-33).
    {
      id: 'note-1mb',
      spike: 6,
      draws: true,
      run: (s) => runNoteScenario(s, q ? 200_000 : 1_000_000, q ? 20 : 120),
    },
  ];
}

type ProgressFn = (current: Scenario | null, done: readonly ScenarioOutcome[]) => void;

export async function runBench(opts: {
  stage: HTMLElement;
  app: AppInfo;
  profile?: Profile;
  only?: readonly ScenarioId[];
  /** Called before each scenario with its id, and after each with its outcome. */
  onProgress?: ProgressFn;
  /** The runs wait for the window to come back (it was hidden or the display slept). */
  onWait?: (waiting: boolean) => void;
}): Promise<BenchReport> {
  const profile = opts.profile ?? 'full';
  const list = scenarios(profile).filter((s) => !opts.only || opts.only.includes(s.id));
  // Keep the display on: on battery a Mac sleeps it after 2 minutes, the run takes 6.
  // Asked first, while the click on «Запустить» still counts as user activation.
  // Runs that stall anyway are voided by runFrames, which waits for the window.
  const wakeLock = await requestWakeLock();
  onStallWait(opts.onWait ?? null);
  try {
    return await runList(list, opts, profile, wakeLock !== null);
  } finally {
    onStallWait(null);
    await wakeLock?.release().catch(() => undefined);
  }
}

async function runList(
  list: readonly Scenario[],
  opts: { stage: HTMLElement; app: AppInfo; onProgress?: ProgressFn },
  profile: Profile,
  wakeLock: boolean,
): Promise<BenchReport> {
  const env = await collectEnvironment();
  const outcomes: ScenarioOutcome[] = [];
  const startedAt = new Date().toISOString();
  for (const s of list) {
    opts.onProgress?.(s, outcomes);
    const t0 = performance.now();
    try {
      const result = await s.run(opts.stage, env);
      outcomes.push({
        id: s.id,
        spike: s.spike,
        ok: true,
        result,
        wallMs: Math.round(performance.now() - t0),
      });
    } catch (e) {
      outcomes.push({
        id: s.id,
        spike: s.spike,
        ok: false,
        error: describeError(e),
        wallMs: Math.round(performance.now() - t0),
      });
    }
    // Let the GPU and GC settle between scenarios.
    await new Promise((r) => setTimeout(r, 300));
  }
  opts.onProgress?.(null, outcomes);
  // `null` when no index scenario ran; `true` only if every one ran in workers.
  const index = outcomes.filter((o) => o.id.startsWith('loro-index'));
  const workers =
    index.length === 0
      ? null
      : index.every((o) => o.ok && (o.result as { isolated?: boolean }).isolated === true);
  return {
    report: 'strata-bench',
    version: 1,
    profile,
    summary: {
      verdicts: Object.fromEntries(outcomes.map((o) => [o.id, verdict(o, env.timerResolutionMs)])),
      workers,
    },
    app: opts.app,
    wakeLock,
    startedAt,
    env,
    outcomes,
  };
}
