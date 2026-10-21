import { describe, expect, it } from 'vitest';
import { edgeKey, ids } from './loro-core';

const BASE32 = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;

describe('bench keys', () => {
  it('makes 26-character time-ordered ids', () => {
    const xs = ids(1000, 42);
    for (const x of xs) expect(x).toMatch(BASE32);
    expect([...xs].sort()).toEqual(xs);
    expect(ids(1000, 42)).toEqual(xs);
  });

  it('spreads wire keys like a hash of (from, to), as spike 4 does', () => {
    const xs = ids(2000, 42);
    const keys = xs.slice(1).map((to, i) => edgeKey(xs[i] ?? '', to));
    for (const k of keys) expect(k).toMatch(BASE32);
    expect(edgeKey(xs[0] ?? '', xs[1] ?? '')).toBe(keys[0]);
    expect(new Set(keys).size).toBe(keys.length);
    // Not time-ordered: the first character is spread over the alphabet.
    const first = new Map<string, number>();
    for (const k of keys) first.set(k[0] ?? '', (first.get(k[0] ?? '') ?? 0) + 1);
    expect(first.size).toBe(32);
    expect(Math.max(...first.values())).toBeLessThan(keys.length / 16);
  });
});
