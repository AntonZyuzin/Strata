import { describe, expect, it } from 'vitest';
import { type Area, nextArea } from './areas';

/** An area whose box holds the given elements, as the DOM's `contains` says. */
const area = (tag: string, ...inside: object[]): Area => {
  const box = {
    tagName: tag,
    contains: (el: unknown) => inside.includes(el as object),
  } as unknown as Element;
  return { box, target: {} as HTMLElement };
};

describe('F6 between the areas of the screen (06 §1.1, §17)', () => {
  const field = {};
  const editor = {};
  const layers = area('ASIDE', field);
  const canvas = area('CANVAS');
  const note = area('SECTION', editor);
  const panel = area('ASIDE');
  const areas = [layers, canvas, note, panel];

  it('goes to the next area in reading order, round to the first', () => {
    expect(nextArea(areas, canvas.box, false)).toBe(note);
    expect(nextArea(areas, editor as Element, false)).toBe(panel);
    expect(nextArea(areas, panel.box, false)).toBe(layers);
  });

  it('goes back with Shift, round to the last', () => {
    expect(nextArea(areas, field as Element, true)).toBe(panel);
    expect(nextArea(areas, editor as Element, true)).toBe(canvas);
  });

  it('counts the focus nowhere in them as on the canvas', () => {
    expect(nextArea(areas, null, false)).toBe(note);
    expect(nextArea(areas, {} as Element, true)).toBe(layers);
    expect(nextArea([], null, false)).toBeNull();
  });
});
