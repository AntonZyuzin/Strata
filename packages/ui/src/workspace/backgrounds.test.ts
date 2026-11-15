import { describe, expect, it } from 'vitest';
import {
  backgroundDots,
  backgroundKey,
  DOTS_DEFAULT,
  pictureBackground,
  pictureKey,
  presetBackground,
} from './backgrounds';

describe('a background’s picture and its dots (07 §7.1–7.2)', () => {
  it('keeps one picture whatever its dots: they lie over it, nothing is made again', () => {
    expect(pictureKey(presetBackground('dusk', 0))).toBe(pictureKey(presetBackground('dusk', 0.8)));
    expect(pictureKey(pictureBackground('a'.repeat(64), 0))).toBe(
      pictureKey(pictureBackground('a'.repeat(64))),
    );
    expect(pictureKey(presetBackground('dusk'))).not.toBe(pictureKey(presetBackground('dust')));
    // The readable mode's derivative is another (07 §11.4).
    expect(pictureKey(presetBackground('dusk'), true)).not.toBe(
      pictureKey(presetBackground('dusk')),
    );
  });

  it('takes none for «Туман» with the defaults: the same picture, no crossfade', () => {
    expect(pictureKey(null)).toBe(pictureKey(presetBackground('fog', 0.8)));
    expect(pictureKey(null, true)).toBe(pictureKey(presetBackground('fog'), true));
  });

  it('tells a background with other dots apart: a step that changed them is seen', () => {
    expect(backgroundKey(presetBackground('dusk', 0))).not.toBe(
      backgroundKey(presetBackground('dusk', 0.8)),
    );
  });

  it('shows faint dots where a background names none', () => {
    expect(backgroundDots(null)).toBe(DOTS_DEFAULT);
    expect(backgroundDots(presetBackground('dust', 0))).toBe(0);
    expect(presetBackground('dust').dots).toBe(DOTS_DEFAULT);
  });
});
