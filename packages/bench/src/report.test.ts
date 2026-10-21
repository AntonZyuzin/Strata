import { describe, expect, it } from 'vitest';
import { headline, type ScenarioOutcome, verdict } from './report';

const base = { spike: 1, ok: true, wallMs: 1 } as const;
const summary = (p95: number) => ({ n: 1, mean: p95, p50: p95, p95, p99: p95, max: p95 });

describe('headline', () => {
  it('summarizes each kind of result', () => {
    const canvas: ScenarioOutcome = {
      ...base,
      id: 'canvas-pan-zoom-n5k',
      result: { fps: 59.8, p95Ms: 16.9 },
    };
    expect(headline(canvas)).toEqual({ kind: 'canvas', fps: 59.8, p95: 16.9 });
    const index: ScenarioOutcome = {
      ...base,
      id: 'loro-index-20k',
      result: {
        importMs: 12,
        importMemoryMib: 48,
        firstEditMs: 4.5,
        editMs: summary(1),
        editMeanMs: 0.02,
      },
    };
    expect(headline(index)).toEqual({
      kind: 'index',
      importMs: 12,
      memoryMib: 48,
      editMean: 0.02,
      firstEdit: 4.5,
    });
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

describe('verdict', () => {
  const canvas = (id: ScenarioOutcome['id'], p95: number): ScenarioOutcome => ({
    ...base,
    id,
    result: { fps: 60, p95Ms: p95 },
  });

  it('judges frames by p95 against NFR-01/02/03 with the timer slack', () => {
    // A perfect 60 Hz run: WebKit reads 17 (1 ms timer), Chromium 16.8–17.1 (0.1 ms, jitter).
    expect(verdict(canvas('canvas-pan-zoom-n5k', 17), 1)).toBe('pass');
    expect(verdict(canvas('canvas-pan-zoom-n5k', 17.1), 0.1)).toBe('pass');
    expect(verdict(canvas('canvas-pan-zoom-n5k', 17.4), 0.1)).toBe('fail');
    // MO-mac, first run: 54.7 fps, p95 22 ms.
    expect(verdict(canvas('canvas-pan-zoom-n5k', 22), 1)).toBe('fail');
    expect(verdict(canvas('canvas-pan-zoom-n10k', 33), 1)).toBe('pass');
    expect(verdict(canvas('canvas-pan-zoom-n10k', 40), 1)).toBe('fail');
  });

  it('judges the index by import time, memory and the mean edit', () => {
    const index = (importMemoryMib: number): ScenarioOutcome => ({
      ...base,
      id: 'loro-index-100k-k16',
      result: {
        importMs: 24,
        importMemoryMib,
        firstEditMs: 5,
        editMs: summary(1),
        editMeanMs: 0.004,
      },
    });
    expect(verdict(index(48))).toBe('pass');
    expect(verdict(index(478))).toBe('fail');
  });

  it('fails errors', () => {
    expect(verdict({ ...base, id: 'loro-text-1mb', ok: false, error: 'x' })).toBe('fail');
  });
});
