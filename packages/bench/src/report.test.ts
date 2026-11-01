import { describe, expect, it } from 'vitest';
import { headline, type ScenarioOutcome, verdict } from './report';

const base = { spike: 1, ok: true, wallMs: 1 } as const;
const summary = (p95: number) => ({ n: 1, mean: p95, p50: p95, p95, p99: p95, max: p95 });
/** V-10k coming in (NFR-40, NFR-41): 30 s, the first networks at 4 s. */
const imported = (p95Ms: number, mainGapMs: number, firstMs = 4_000): ScenarioOutcome => ({
  ...base,
  id: 'import-v10k',
  spike: 11,
  result: { importMs: 30_000, firstMs, fps: 60, p95Ms, mainGapMs, longTasks: 0 },
});

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
    // An import has frames too: read as an import, not as a canvas.
    expect(headline(imported(16.7, 40))).toEqual({
      kind: 'import',
      importMs: 30_000,
      firstMs: 4_000,
      p95: 16.7,
      mainGap: 40,
    });
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

  it('judges the import by its frame, its longest task and its first networks (NFR-40, NFR-41)', () => {
    expect(verdict(imported(33, 60), 1)).toBe('pass');
    expect(verdict(imported(50, 20), 1)).toBe('fail');
    // A 10 ms timer that waited over 60 ms: a task over 50 ms.
    expect(verdict(imported(16.7, 61), 1)).toBe('fail');
    expect(verdict(imported(16.7, 20, 6_000), 1)).toBe('fail');
  });

  it('fails errors', () => {
    expect(verdict({ ...base, id: 'loro-text-1mb', ok: false, error: 'x' })).toBe('fail');
  });
});
