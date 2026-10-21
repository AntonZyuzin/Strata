import { applyPixelUnit, type PixelRounding } from '@strata/design-tokens';

/**
 * The interface scale (07 §11.4) and the pixel-font step at a fractional DPR,
 * kept on this device. The design spike lets the owner switch both live.
 */

export const SCALES = [1, 1.25, 1.5, 2] as const;
export type UiScale = (typeof SCALES)[number];

export interface PixelPrefs {
  scale: UiScale;
  rounding: PixelRounding;
}

const KEY = 'strata.pixel';
const DEFAULTS: PixelPrefs = { scale: 1, rounding: 'up' };

export function loadPixelPrefs(): PixelPrefs {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<PixelPrefs> | null;
    return {
      scale: SCALES.find((s) => s === v?.scale) ?? DEFAULTS.scale,
      rounding: v?.rounding === 'down' ? 'down' : 'up',
    };
  } catch {
    return DEFAULTS;
  }
}

let stop: (() => void) | null = null;

/** Applies the prefs to the document and remembers them. */
export function setPixelPrefs(prefs: PixelPrefs): void {
  stop?.();
  stop = applyPixelUnit(document.documentElement, prefs.scale, prefs.rounding);
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Private windows may refuse storage; the prefs still apply to this session.
  }
}
