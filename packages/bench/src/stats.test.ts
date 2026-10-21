import { describe, expect, it } from 'vitest';
import { median, percentile, rng, summarize } from './stats';

describe('stats', () => {
  it('summarizes samples', () => {
    const s = summarize([5, 1, 3, 2, 4]);
    expect(s).toMatchObject({ n: 5, mean: 3, p50: 3, max: 5 });
    expect(percentile([], 0.5)).toBe(0);
  });

  it('takes the median of runs', () => {
    expect(median([22, 17, 18, 40, 17])).toBe(18);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBe(0);
  });

  it('rng is deterministic and in [0, 1)', () => {
    const a = rng(42);
    const b = rng(42);
    const xs = Array.from({ length: 1000 }, a);
    expect(xs).toEqual(Array.from({ length: 1000 }, b));
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThan(1);
  });
});
