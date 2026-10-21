import { describe, expect, it } from 'vitest';
import type { Pixels } from './backdrop';
import { foreground, inkShare, MASK_SIDE, otsu, stylize } from './stylize';

/** A `size²` picture: `bg` everywhere, a dark disc of radius `r` in the middle. */
function disc(size: number, r: number, bg: [number, number, number, number]): Pixels {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const inside = Math.hypot(x - size / 2, y - size / 2) < r;
      const c = inside ? [30, 20, 20, 255] : bg;
      data.set(c, i);
    }
  }
  return { width: size, height: size, data };
}

const at = (mask: Uint8ClampedArray, x: number, y: number) => mask[y * MASK_SIDE + x] ?? 0;

describe('«привести к стилю» (07 §6.4–6.5)', () => {
  it('finds the gap of a two-peak histogram (Otsu)', () => {
    const v = new Float32Array([...Array(50).fill(40), ...Array(50).fill(200)]);
    const t = otsu(v, new Float32Array(100).fill(1));
    expect(t).toBeGreaterThanOrEqual(40);
    expect(t).toBeLessThan(200);
  });

  it('floods a plain background from the corners', () => {
    const fg = foreground(disc(60, 15, [250, 250, 250, 255]));
    expect(fg.kind).toBe('flood');
    expect(fg.weight[0]).toBe(0);
    expect(fg.weight[30 * 60 + 30]).toBe(1);
  });

  it('trusts real transparency over a flood', () => {
    expect(foreground(disc(60, 15, [250, 250, 250, 0])).kind).toBe('alpha');
  });

  it('turns a dark figure on white into ink on the figure only («Гравюра»)', () => {
    const r = stylize(disc(200, 50, [255, 255, 255, 255]));
    expect(at(r.mask, 64, 64)).toBe(255);
    expect(at(r.mask, 2, 2)).toBe(0);
    expect(inkShare(r.mask)).toBeGreaterThan(0.3);
    expect(inkShare(r.mask)).toBeLessThan(0.9);
  });

  it('inverts on request and fills a silhouette', () => {
    const pic = disc(120, 30, [255, 255, 255, 0]);
    expect(
      at(stylize(pic, { mode: 'engraving', threshold: null, invert: true }).mask, 64, 64),
    ).toBe(0);
    const s = stylize(pic, { mode: 'silhouette', threshold: null, invert: false });
    expect(s.background).toBe('alpha');
    expect(at(s.mask, 64, 64)).toBe(255);
  });

  it.each(['pixel', 'photo', 'as-is'] as const)('mode %s leaves ink on the figure', (mode) => {
    const r = stylize(disc(160, 40, [255, 255, 255, 255]), {
      mode,
      threshold: null,
      invert: false,
    });
    expect(inkShare(r.mask)).toBeGreaterThan(0.1);
    expect(at(r.mask, 1, 1)).toBe(0);
  });
});
