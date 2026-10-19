import { describe, expect, it } from 'vitest';
import { cssVariables, fog, pixelUnit } from './index';

describe('design tokens', () => {
  it('names CSS variables in kebab case', () => {
    const vars = cssVariables(fog);
    expect(vars['--st-color-scene-bg']).toBe('#0b0c0e');
    expect(vars['--st-size-ui-text']).toBe('11');
  });

  it('rounds the pixel unit and never goes below 1', () => {
    expect(pixelUnit(1)).toBe(1);
    expect(pixelUnit(1.25)).toBe(1);
    expect(pixelUnit(1.5)).toBe(2);
    expect(pixelUnit(2)).toBe(2);
    expect(pixelUnit(0.5)).toBe(1);
  });
});
