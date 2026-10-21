import { describe, expect, it } from 'vitest';
import {
  cssVariables,
  fog,
  GLYPHS,
  glyphSvg,
  pixelMetrics,
  pixelUnit,
  pixelVariables,
} from './index';

describe('design tokens', () => {
  it('names CSS variables in kebab case (07 §2.1)', () => {
    const vars = cssVariables(fog);
    expect(vars['--st-color-surface-raised']).toBe('#26262a');
    expect(vars['--st-color-bevel-hi-2']).toBe('#3a3a3f');
    expect(vars['--st-scene-bg-max-l']).toBe('0.1');
    expect(vars['--st-font-ui-prop']).toContain('Tiny5');
  });

  it('rounds the pixel unit and never goes below 1', () => {
    expect(pixelUnit(1)).toBe(1);
    expect(pixelUnit(1.25)).toBe(1);
    expect(pixelUnit(1.5)).toBe(2);
    expect(pixelUnit(2)).toBe(2);
    expect(pixelUnit(0.5)).toBe(1);
  });

  // The table of 07 §2.3: u, U and the 24 px control in physical px.
  it.each([
    [1, 1, 1, 24],
    [1.25, 1, 0.8, 30],
    [1.5, 2, 4 / 3, 36],
    [2, 2, 1, 48],
    [3, 3, 1, 72],
  ])('DPR %s: u %s, U %s px, control %s physical px', (dpr, u, U, controlPhysical) => {
    const m = pixelMetrics(dpr);
    expect(m.u).toBe(u);
    expect(m.U).toBeCloseTo(U, 6);
    expect(m.control * dpr).toBeCloseTo(controlPhysical, 6);
  });

  // The table of 07 §2.4 at scale 100 %: physical px of display-s/m/l, ui, ui-prop.
  it.each([
    [1, [16, 24, 32, 11, 16]],
    [1.25, [24, 32, 40, 22, 24]],
    [1.5, [24, 40, 48, 22, 24]],
    [2, [32, 48, 64, 22, 32]],
    [3, [48, 72, 96, 33, 48]],
  ])('DPR %s: pixel font sizes %j', (dpr, physical) => {
    const f = pixelMetrics(dpr).font;
    expect([f.displayS, f.displayM, f.displayL, f.ui, f.uiProp].map((s) => s.physical)).toEqual(
      physical,
    );
  });

  it('keeps every pixel size on whole physical pixels', () => {
    for (const dpr of [1, 1.25, 1.5, 1.75, 2, 2.5, 3]) {
      for (const scale of [1, 1.25, 1.5, 2]) {
        const m = pixelMetrics(dpr, scale);
        for (const f of Object.values(m.font)) {
          expect(f.css * dpr).toBeCloseTo(Math.round(f.css * dpr), 6);
          expect(f.css).toBeGreaterThan(0);
        }
        expect((m.control / m.U) % 1).toBeCloseTo(0, 6);
      }
    }
  });

  it('offers the smaller step at a fractional DPR for comparison', () => {
    expect(pixelMetrics(1.25, 1, 'down').font.ui.physical).toBe(11);
    expect(pixelMetrics(1.5, 1, 'down').font.displayS.physical).toBe(24);
    expect(pixelMetrics(2, 1, 'down').font.ui.physical).toBe(22);
  });

  it('writes the pixel unit as CSS variables', () => {
    const vars = pixelVariables(pixelMetrics(1.25));
    expect(vars['--u']).toBe('0.8px');
    expect(vars['--st-font-ui-size']).toBe('17.6px');
    expect(vars['--st-font-display-s-size']).toBe('19.2px');
  });
});

describe('glyphs (07 §6.2)', () => {
  it('are square 1-bit bitmaps of 8 or 16 pixels', () => {
    for (const [name, rows] of Object.entries(GLYPHS)) {
      expect([8, 16], name).toContain(rows.length);
      for (const row of rows) expect(row, name).toMatch(new RegExp(`^[.#]{${rows.length}}$`));
    }
  });

  it('become an SVG of whole squares', () => {
    const svg = glyphSvg('bang');
    expect(svg).toContain('viewBox="0 0 8 8"');
    expect(svg.match(/<rect /g)?.length).toBe(7);
  });
});
