/** Summary statistics for a list of samples (milliseconds). */
export interface Summary {
  n: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.round((sorted.length - 1) * p);
  return sorted[Math.min(sorted.length - 1, Math.max(0, idx))] ?? 0;
}

export function summarize(samples: readonly number[]): Summary {
  const s = [...samples].sort((a, b) => a - b);
  const mean = s.length ? s.reduce((a, b) => a + b, 0) / s.length : 0;
  return {
    n: s.length,
    mean: round(mean),
    p50: round(percentile(s, 0.5)),
    p95: round(percentile(s, 0.95)),
    p99: round(percentile(s, 0.99)),
    max: round(s.at(-1) ?? 0),
  };
}

export function round(x: number, digits = 3): number {
  const k = 10 ** digits;
  return Math.round(x * k) / k;
}

/** Deterministic xorshift32 so every machine draws the same scene. */
export function rng(seed: number): () => number {
  let x = seed | 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 4294967296;
  };
}
