import { describe, expect, it } from 'vitest';
import type { Pixels } from './backdrop';
import { cutout, foreground, inkShare, MASK_SIDE, otsu, stylize } from './stylize';

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
      at(
        stylize(pic, { mode: 'engraving', threshold: null, invert: true, background: 'auto' }).mask,
        64,
        64,
      ),
    ).toBe(0);
    const s = stylize(pic, {
      mode: 'silhouette',
      threshold: null,
      invert: false,
      background: 'auto',
    });
    expect(s.background).toBe('alpha');
    expect(at(s.mask, 64, 64)).toBe(255);
  });

  it.each(['pixel', 'photo', 'as-is'] as const)('mode %s leaves ink on the figure', (mode) => {
    const r = stylize(disc(160, 40, [255, 255, 255, 255]), {
      mode,
      threshold: null,
      invert: false,
      background: 'auto',
    });
    expect(inkShare(r.mask)).toBeGreaterThan(0.1);
    expect(at(r.mask, 1, 1)).toBe(0);
  });

  it('keeps an opaque background with no flood («Без заливки»)', () => {
    const fg = foreground(disc(60, 15, [250, 250, 250, 255]), 40, false);
    expect(fg.kind).toBe('none');
    expect(fg.weight[0]).toBe(1);
    const r = stylize(disc(200, 50, [250, 250, 250, 255]), {
      mode: 'silhouette',
      threshold: null,
      invert: false,
      background: 'alpha',
    });
    // The whole picture is the figure: its corner is ink, inside the crop's margin.
    expect(at(r.mask, 12, 12)).toBe(255);
    expect(at(r.mask, 1, 1)).toBe(0);
  });

  it('takes what the eraser took as background, flood or not (07 §6.4)', () => {
    const pic = disc(60, 15, [250, 250, 250, 255]);
    // A spot erased on the figure, too small for the picture to count as transparent:
    // the canvas gives an erased pixel no colour.
    const erased = 30 * 60 + 30;
    pic.data.set([0, 0, 0, 0], erased * 4);
    for (const flood of [true, false]) {
      const fg = foreground(pic, 40, flood);
      expect(fg.weight[erased], `flood ${flood}`).toBe(0);
      expect(fg.weight[30 * 60 + 25], `flood ${flood}`).toBe(1);
    }
    expect(foreground(pic, 40, false).kind).toBe('alpha');
  });

  it("keeps flooding however much the eraser took: its strokes are not the picture's transparency", () => {
    const pic = disc(60, 15, [250, 250, 250, 255]);
    const erased = new Uint8Array(60 * 60);
    // A fifth of the picture rubbed out, the figure's left half among it.
    for (let y = 0; y < 60; y++) for (let x = 18; x < 30; x++) erased[y * 60 + x] = 1;
    const fg = foreground(pic, 40, true, erased);
    expect(fg.kind).toBe('flood');
    expect(fg.weight[30 * 60 + 20]).toBe(0);
    expect(fg.weight[30 * 60 + 35]).toBe(1);
    expect(fg.weight[59 * 60 + 59]).toBe(0);
    // With no flood, the white stays the figure; what was rubbed out goes.
    const kept = foreground(pic, 40, false, erased);
    expect(kept.kind).toBe('alpha');
    expect(kept.weight[59 * 60 + 59]).toBe(1);
    expect(kept.weight[30 * 60 + 20]).toBe(0);
  });

  it('bakes the background into the alpha: «only the transparent» gives the same mask again', () => {
    const pic = disc(200, 50, [250, 250, 250, 255]);
    const erased = new Uint8Array(200 * 200);
    for (let y = 90; y < 110; y++) for (let x = 60; x < 140; x++) erased[y * 200 + x] = 1;
    const style = {
      mode: 'engraving',
      threshold: null,
      invert: false,
      background: 'auto',
    } as const;
    const before = stylize(pic, style, erased);
    const baked = cutout(pic, foreground(pic, 40, true, erased).weight);
    expect(baked.data[(100 * 200 + 100) * 4 + 3]).toBe(0);
    expect(baked.data[(80 * 200 + 100) * 4 + 3]).toBe(255);
    expect(baked.data[3]).toBe(0);
    const after = stylize(baked, { ...style, background: 'alpha' });
    let same = 0;
    for (let i = 0; i < before.mask.length; i++) if (before.mask[i] === after.mask[i]) same++;
    expect(same / before.mask.length).toBeGreaterThan(0.99);
  });

  it('floods from the corners left when one is erased', () => {
    const pic = disc(60, 15, [250, 250, 250, 255]);
    // The top-left corner erased to no colour: black would flood the dark figure.
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) pic.data.set([0, 0, 0, 0], (y * 60 + x) * 4);
    }
    const fg = foreground(pic);
    expect(fg.kind).toBe('flood');
    expect(fg.weight[30 * 60 + 30]).toBe(1);
    expect(fg.weight[59 * 60 + 59]).toBe(0);
    expect(fg.weight[0]).toBe(0);
  });
});
