import { runCanvasScenario } from './canvas';
import { collectEnvironment } from './env';
import { runLoroIndex, runLoroText } from './loro';
import type { AppInfo, BenchReport, Profile, ScenarioId, ScenarioOutcome } from './report';

export * from './report';

/** One benchmark of step 0.3 (16 §3.2): spikes 1 and 4 on the owner's machines. */
export interface Scenario {
  id: ScenarioId;
  spike: number;
  /** Needs the full-window stage (it draws). */
  draws: boolean;
  run(stage: HTMLElement): Promise<unknown>;
}

export function scenarios(profile: Profile = 'full'): readonly Scenario[] {
  const q = profile === 'quick';
  // 10 s per canvas run (NFR-01); N-5k has 7 500 wires, N-10k 15 000 (14 §1.3).
  const canvas = (mode: 'pan-zoom' | 'drag', nodes: number, wires: number) => (s: HTMLElement) =>
    runCanvasScenario(s, {
      mode,
      nodes: q ? nodes / 5 : nodes,
      wires: q ? wires / 5 : wires,
      durationMs: q ? 1_500 : 10_000,
    });
  return [
    { id: 'canvas-pan-zoom-n5k', spike: 1, draws: true, run: canvas('pan-zoom', 5_000, 7_500) },
    { id: 'canvas-drag-n5k', spike: 1, draws: true, run: canvas('drag', 5_000, 7_500) },
    { id: 'canvas-pan-zoom-n10k', spike: 1, draws: true, run: canvas('pan-zoom', 10_000, 15_000) },
    {
      id: 'loro-index-20k',
      spike: 4,
      draws: false,
      run: () => runLoroIndex(q ? 2_000 : 20_000, 1),
    },
    {
      id: 'loro-index-100k',
      spike: 4,
      draws: false,
      run: () => runLoroIndex(q ? 10_000 : 100_000, 25),
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
      const result = await s.run(opts.stage);
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
        error: String((e as Error)?.stack ?? e),
        wallMs: Math.round(performance.now() - t0),
      });
    }
    // Let the GPU and GC settle between scenarios.
    await new Promise((r) => setTimeout(r, 300));
  }
  opts.onProgress?.(null, outcomes);
  return {
    report: 'strata-bench',
    version: 1,
    profile,
    app: opts.app,
    startedAt,
    env,
    outcomes,
  };
}
