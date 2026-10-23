import {
  type AppInfo,
  type BenchReport,
  type Headline,
  headline,
  type Profile,
  SCENARIO_IDS,
  type ScenarioId,
  type ScenarioOutcome,
  verdict,
} from '@strata/bench/report';
import { formatNumber, type Locale, t } from '@strata/i18n';
import { useEffect, useRef, useState } from 'react';
import { copyText } from './clipboard';

type Run =
  | { state: 'idle'; failed?: string }
  | { state: 'running'; current: ScenarioId | null; outcomes: readonly ScenarioOutcome[] }
  | { state: 'done'; report: BenchReport; copy: 'none' | 'copied' | 'failed' };

/**
 * Step 0.3 benchmark screen (16 §3.2, 15 §8.3): runs spikes 1 and 4 inside this
 * WebView and gives the owner a report to copy. Drawing happens on a
 * full-window stage outside React (15 §4); React only shows progress.
 */
export function BenchWindow(props: {
  locale: Locale;
  app: AppInfo;
  profile: Profile;
  /** Run only these scenarios (`?only=a,b`): re-checking one scenario without the full minute. */
  only?: readonly ScenarioId[] | undefined;
  /** Start at once: smoke runs of a desktop build, where nobody clicks (`?autorun`). */
  autorun?: boolean;
  onBack: () => void;
}) {
  const { locale } = props;
  const stage = useRef<HTMLDivElement>(null);
  const [run, setRun] = useState<Run>({ state: 'idle' });
  const [waiting, setWaiting] = useState(false);

  const start = async () => {
    const el = stage.current;
    if (!el) return;
    setRun({ state: 'running', current: null, outcomes: [] });
    try {
      // Pixi and Loro load only here, not at startup.
      const { runBench } = await import('@strata/bench');
      const report = await runBench({
        stage: el,
        app: props.app,
        profile: props.profile,
        ...(props.only ? { only: props.only } : {}),
        onProgress: (current, done) =>
          setRun({ state: 'running', current: current?.id ?? null, outcomes: [...done] }),
        onWait: setWaiting,
      });
      setRun({ state: 'done', report, copy: 'none' });
    } catch (e) {
      // Scenario errors land in the report; this is a failed load or setup.
      setRun({ state: 'idle', failed: String((e as Error)?.message ?? e) });
    }
  };

  const started = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: starts once, when `autorun` turns on
  useEffect(() => {
    if (props.autorun && !started.current) {
      started.current = true;
      void start();
    }
  }, [props.autorun]);

  const copy = async () => {
    if (run.state !== 'done') return;
    const ok = await copyText(JSON.stringify(run.report, null, 2));
    setRun({ ...run, copy: ok ? 'copied' : 'failed' });
  };

  const outcomes =
    run.state === 'idle' ? [] : run.state === 'done' ? run.report.outcomes : run.outcomes;
  const cell = (id: ScenarioId): string => {
    const o = outcomes.find((x) => x.id === id);
    if (o && run.state === 'done') {
      const result = formatHeadline(locale, headline(o));
      const v = verdict(o, run.report.env.timerResolutionMs);
      return t(locale, v === 'pass' ? 'bench.pass' : 'bench.fail', { result });
    }
    if (o) return formatHeadline(locale, headline(o));
    if (run.state === 'running' && run.current === id) return t(locale, 'bench.running');
    return t(locale, 'bench.pending');
  };
  const name = (id: ScenarioId) => t(locale, `bench.s.${id}` as const);
  const statusText =
    run.state === 'idle' && run.failed
      ? t(locale, 'bench.failed', { message: run.failed })
      : run.state === 'done' && run.copy === 'copied'
        ? t(locale, 'bench.copied')
        : run.state === 'done' && run.copy === 'failed'
          ? t(locale, 'bench.copyFailed')
          : '';

  return (
    <>
      <section className="window window-wide" aria-labelledby="bench-title">
        <header className="window-title">
          <h1 id="bench-title">{t(locale, 'bench.title')}</h1>
          <button
            type="button"
            className="window-close"
            aria-label={t(locale, 'bench.back')}
            title={t(locale, 'bench.back')}
            disabled={run.state === 'running'}
            onClick={props.onBack}
          >
            ×
          </button>
        </header>
        <div className="window-body">
          <p className="stage" title={t(locale, 'bench.hint')}>
            {t(locale, 'bench.hint')}
          </p>
          <dl className="bench-table" data-state={run.state}>
            {SCENARIO_IDS.map((id) => (
              <div key={id} className="bench-row" data-id={id}>
                <dt title={name(id)}>{name(id)}</dt>
                <dd title={cell(id)}>{cell(id)}</dd>
              </div>
            ))}
          </dl>
          <div className="window-actions">
            <button type="button" onClick={start} disabled={run.state === 'running'}>
              {t(locale, 'bench.run')}
            </button>
            <button type="button" onClick={copy} disabled={run.state !== 'done'}>
              {t(locale, 'bench.copy')}
            </button>
            <span className="status" role="status" title={statusText}>
              {statusText}
            </span>
          </div>
          {/* Shown when copying failed, and after unattended runs where nobody clicks. */}
          {run.state === 'done' && (run.copy === 'failed' || props.autorun) ? (
            <textarea
              className="report"
              readOnly
              value={JSON.stringify(run.report, null, 2)}
              onFocus={(e) => e.currentTarget.select()}
            />
          ) : null}
        </div>
      </section>
      <div className="bench-stage" hidden={run.state !== 'running'}>
        <div ref={stage} className="bench-canvas" />
        {run.state === 'running' ? (
          <p className="bench-hud">
            {waiting
              ? t(locale, 'bench.waiting')
              : t(locale, 'bench.progress', {
                  done: run.outcomes.length + 1,
                  total: props.only?.length ?? SCENARIO_IDS.length,
                  name: run.current ? name(run.current) : '',
                })}
          </p>
        ) : null}
      </div>
    </>
  );
}

function formatHeadline(locale: Locale, h: Headline): string {
  const n = (x: number, d = 1) => formatNumber(locale, x, d);
  switch (h.kind) {
    case 'canvas':
      return t(locale, 'bench.r.canvas', { fps: n(h.fps), p95: n(h.p95) });
    case 'layout':
      return t(locale, 'bench.r.layout', {
        a: n(h.sizes[0], 0),
        small: n(h.small, 0),
        b: n(h.sizes[1], 0),
        large: n(h.large, 0),
      });
    case 'board':
      return t(locale, 'bench.r.board', { open: n(h.openMs, 0), fps: n(h.fps), p95: n(h.p95) });
    case 'note':
      return t(locale, 'bench.r.note', { open: n(h.openMs, 0), key: n(h.keyP95) });
    case 'bridge':
      return t(locale, 'bench.r.bridge', {
        diff: n(h.diff * 100, 2),
        first: n(h.firstFrame, 0),
        p95: n(h.p95),
      });
    case 'index':
      return t(locale, 'bench.r.index', {
        importMs: n(h.importMs, 0),
        memoryMib: h.memoryMib === null ? t(locale, 'bench.pending') : n(h.memoryMib, 0),
        firstEdit: n(h.firstEdit),
      });
    case 'text':
      return t(locale, 'bench.r.text', {
        insertMs: n(h.insertMs, 0),
        keyMean: n(h.keyMean, 3),
      });
    case 'error':
      return t(locale, 'bench.r.error', { message: h.message });
  }
}
