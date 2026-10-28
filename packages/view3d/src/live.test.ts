import { describe, expect, it } from 'vitest';
import { bornAt, frozenBut, idHash, neighbourhood, throwVelocity } from './live';
import { chooseQuality, p95, qualityOf, readQuality } from './quality';
import { spaceExtract } from './space-extract';

describe('the live physics (08 §3.4, §3.6)', () => {
  // root ─ a ─ b (wire a→b) ; root ─ net ─ c ; c → d (wire), d in root.
  const s = spaceExtract(
    [
      { id: '01', kind: 'network' },
      { id: '02', kind: 'note', parent: '01' },
      { id: '03', kind: 'note', parent: '01' },
      { id: '04', kind: 'network', parent: '01' },
      { id: '05', kind: 'note', parent: '04' },
      { id: '06', kind: 'note', parent: '01' },
    ],
    [
      { from: '02', to: '03' },
      { from: '05', to: '06' },
    ],
  );
  const at = (id: string) => s.body.get(id) ?? -1;

  it('moves the touched star and what is within two steps of it', () => {
    const near = neighbourhood(s.x, [at('05')], 2);
    expect(near[0]).toBe(at('05'));
    expect(new Set(near)).toEqual(new Set([at('05'), at('04'), at('06'), at('01')]));
    expect(neighbourhood(s.x, [at('05')], 1, 2)).toHaveLength(2);
  });

  it('freezes everything else', () => {
    expect([...frozenBut(4, [1, 3])]).toEqual([1, 0, 1, 0]);
  });

  it('puts a new star by its id near its source, or in its network', () => {
    const pos = new Float32Array(s.x.count * 3);
    pos.set([500, 0, 0], at('04') * 3);
    const key = idHash('05');
    expect(idHash('05')).toBe(key);
    expect(idHash('06')).not.toBe(key);
    const inside = bornAt(s.x, pos, at('05'), key);
    expect(Math.hypot(inside[0] - 500, inside[1], inside[2])).toBeGreaterThan(1);
    const wired = bornAt(s.x, pos, at('05'), key, at('04'));
    expect(Math.hypot(wired[0] - 500, wired[1], wired[2])).toBeCloseTo(60, 3);
    expect(bornAt(s.x, pos, at('05'), key)).toEqual(inside);
  });

  it('throws at the mean speed of the last 80 ms, no faster than the limit', () => {
    const samples = [
      { t: 0, p: [0, 0, 0] as [number, number, number] },
      { t: 100, p: [100, 0, 0] as [number, number, number] },
      { t: 150, p: [150, 0, 0] as [number, number, number] },
      { t: 180, p: [180, 0, 0] as [number, number, number] },
    ];
    expect(throwVelocity(samples, 1e6)).toEqual([1000, 0, 0]);
    const v = throwVelocity(samples, 200);
    expect(Math.hypot(...v)).toBeCloseTo(200, 6);
    expect(throwVelocity([], 100)).toEqual([0, 0, 0]);
  });
});

describe('quality presets (08 §8.4, NFR-19)', () => {
  it('chooses by the p95 of the first frames', () => {
    expect(p95([...Array(100).keys()].map((i) => i + 1))).toBe(95);
    expect(chooseQuality(10, 'medium')).toBe('high');
    expect(chooseQuality(16, 'medium')).toBe('medium');
    expect(chooseQuality(30, 'medium')).toBe('economy');
    expect(chooseQuality(60, 'medium')).toBe('economy');
    expect(chooseQuality(60, 'economy')).toBe('off');
  });

  it('keeps the hand above the frames, medium before any', () => {
    expect(qualityOf(readQuality(null))).toBe('medium');
    expect(qualityOf(readQuality('{"auto":"high"}'))).toBe('high');
    expect(qualityOf(readQuality('{"auto":"high","manual":"economy"}'))).toBe('economy');
    expect(qualityOf(readQuality('{"manual":"best"}'))).toBe('medium');
    expect(qualityOf(readQuality('not json'))).toBe('medium');
  });
});
