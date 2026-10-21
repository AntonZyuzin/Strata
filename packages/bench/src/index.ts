import { runCanvasScenario } from './canvas';
import { collectEnvironment, type Environment } from './env';
import { runLoroIndex, runLoroText } from './loro';
import {
  type AppInfo,
  type BenchReport,
  type Profile,
  type ScenarioId,
  type ScenarioOutcome,
  verdict,
} from './report';

export * from './report';

/** One benchmark of step 0.3 (16 §3.2): spikes 1 and 4 on the owner's machines. */
export interface Scenario {
  id: ScenarioId;
  spike: number;
  /** Needs the full-window stage (it draws). */
  draws: boolean;
  run(stage: HTMLElement, env: Environment): Promise<unknown>;
}

/**
 * `name: message` and the stack. JavaScriptCore's `stack` has only the frames,
 * V8's starts with the message, so the message is added when it is missing.
 */
function describeError(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const head = `${e.name}: ${e.message}`;
  return e.stack?.startsWith(head) ? e.stack : `${head}\n${e.stack ?? ''}`;
}

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
      });
  return [
    { id: 'canvas-pan-zoom-n5k', spike: 1, draws: true, run: canvas('pan-zoom', 5_000, 7_500) },
    { id: 'canvas-drag-n5k', spike: 1, draws: true, run: canvas('drag', 5_000, 7_500) },
    { id: 'canvas-pan-zoom-n10k', spike: 1, draws: true, run: canvas('pan-zoom', 10_000, 15_000) },
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
  ];
}

export async function runBench(opts: {
  stage: HTMLElement;
  app: AppInfo;
  profile?: Profile;
  only?: readonly ScenarioId[];
  /** Called before each scenario with its id, and after each with its outcome. */
  onProgress?: (current: Scenario | null, done: readonly ScenarioOutcome[]) => void;
}): Promise<BenchReport> {
  const profile = opts.profile ?? 'full';
  const list = scenarios(profile).filter((s) => !opts.only || opts.only.includes(s.id));
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
  const workers = outcomes
    .filter((o) => o.id.startsWith('loro-index') && o.ok)
    .every((o) => (o.result as { isolated?: boolean }).isolated === true);
  return {
    report: 'strata-bench',
    version: 1,
    profile,
    summary: {
      verdicts: Object.fromEntries(outcomes.map((o) => [o.id, verdict(o, env.timerResolutionMs)])),
      workers,
    },
    app: opts.app,
    startedAt,
    env,
    outcomes,
  };
}
