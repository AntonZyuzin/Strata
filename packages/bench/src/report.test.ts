import { describe, expect, it } from 'vitest';
import { headline, type ScenarioOutcome } from './report';

const base = { spike: 1, ok: true, wallMs: 1 } as const;
const summary = (p95: number) => ({ n: 1, mean: p95, p50: p95, p95, p99: p95, max: p95 });

describe('headline', () => {
  it('summarizes each kind of result', () => {
    const canvas: ScenarioOutcome = {
      ...base,
      id: 'canvas-pan-zoom-n5k',
      result: { fps: 59.8, intervalMs: summary(16.9) },
    };
    expect(headline(canvas)).toEqual({ kind: 'canvas', fps: 59.8, p95: 16.9 });
    const index: ScenarioOutcome = {
      ...base,
      id: 'loro-index-20k',
      result: { importMs: 12, firstEditMs: 4.5, editMs: summary(1), editMeanMs: 0.02 },
    };
    expect(headline(index)).toEqual({ kind: 'index', importMs: 12, editMean: 0.02, editMax: 4.5 });
    const text: ScenarioOutcome = {
      ...base,
      id: 'loro-text-1mb',
      result: { insert1MbMs: 19, keystrokeMs: summary(1), keystrokeMeanMs: 0.03 },
    };
    expect(headline(text)).toEqual({ kind: 'text', insertMs: 19, keyMean: 0.03, keyMax: 1 });
  });

  it('keeps the first line of an error', () => {
    const failed: ScenarioOutcome = {
      ...base,
      id: 'canvas-pan-zoom-n10k',
      ok: false,
      error: 'Error: WebGL lost\n    at render',
    };
    expect(headline(failed)).toEqual({ kind: 'error', message: 'Error: WebGL lost' });
  });
});
