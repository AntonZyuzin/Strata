import { describe, expect, it } from 'vitest';
import {
  blur,
  fitSize,
  generatePreset,
  luminanceQuantile,
  normalize,
  type Pixels,
  PRESETS,
  processBackdrop,
  sceneContrast,
} from './backdrop';

const flat = (w: number, h: number, v: number): Pixels => ({
  width: w,
  height: h,
  data: new Uint8ClampedArray(w * h * 4).fill(v),
});

const ratio = (rows: ReturnType<typeof sceneContrast>, id: string) =>
  Number(rows.find((r) => r.id === id)?.ratio.toFixed(1));

describe('scene contrast (07 §2.2)', () => {
  it('reproduces the table of 07 §2.2 at background L 0.10 and 0.05', () => {
    const at10 = sceneContrast(0.1);
    const at05 = sceneContrast(0.05);
    expect([ratio(at10, 'bubble'), ratio(at05, 'bubble')]).toEqual([6.1, 9.2]);
    expect([ratio(at10, 'wire'), ratio(at05, 'wire')]).toEqual([3.3, 4.5]);
    expect([ratio(at10, 'today'), ratio(at05, 'today')]).toEqual([4.2, 6.3]);
    expect([ratio(at10, 'overdue'), ratio(at05, 'overdue')]).toEqual([1.6, 2.4]);
  });

  it('keeps a label on its plate readable even over white', () => {
    expect(ratio(sceneContrast(1), 'label')).toBe(7.4);
  });
});

describe('background pipeline (07 §7.1)', () => {
  it('normalises a white picture down to p95 L ≤ 0.10', () => {
    const px = flat(64, 40, 255);
    normalize(px, 0.1);
    expect(luminanceQuantile(px, 0.95)).toBeLessThanOrEqual(0.102);
    expect(luminanceQuantile(px, 0.95)).toBeGreaterThan(0.09);
  });

  it('leaves a dark picture alone', () => {
    const px = flat(32, 32, 40);
    const before = luminanceQuantile(px, 0.95);
    normalize(px, 0.1);
    expect(luminanceQuantile(px, 0.95)).toBeCloseTo(before, 6);
  });

  it('blurs without changing the mean of a channel', () => {
    const px = flat(50, 30, 0);
    for (let i = 0; i < px.data.length; i += 4) px.data[i] = (i / 4) % 7 === 0 ? 255 : 0;
    const mean = (p: Pixels) => p.data.reduce((s, v, i) => (i % 4 === 0 ? s + v : s), 0);
    const before = mean(px);
    blur(px, 4);
    expect(Math.abs(mean(px) - before) / before).toBeLessThan(0.02);
  });

  it.each(PRESETS)('preset %s ends dark enough for the Scene', (id) => {
    const px = generatePreset(id, 240, 150);
    const p95 = processBackdrop(px);
    expect(p95).toBeLessThanOrEqual(0.102);
    expect(p95).toBeGreaterThan(0.005);
  });

  it('fits the long side to 960 px and never upscales', () => {
    expect(fitSize(4000, 3000)).toEqual({ w: 960, h: 720 });
    expect(fitSize(300, 200)).toEqual({ w: 300, h: 200 });
  });
});
