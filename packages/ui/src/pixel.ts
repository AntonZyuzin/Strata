import { applyPixelUnit } from '@strata/design-tokens';

/**
 * The interface scale (07 §11.4), kept on this device; «Шрифты и окна»
 * switches it live. At a fractional DPR pixel fonts take the larger step
 * (07 §2.4, ☑ Q-07-18).
 */

export const SCALES = [1, 1.25, 1.5, 2] as const;
export type UiScale = (typeof SCALES)[number];

export interface PixelPrefs {
  scale: UiScale;
}

const KEY = 'strata.pixel';
const DEFAULTS: PixelPrefs = { scale: 1 };

export function loadPixelPrefs(): PixelPrefs {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<PixelPrefs> | null;
    return {
      scale: SCALES.find((s) => s === v?.scale) ?? DEFAULTS.scale,
    };
  } catch {
    return DEFAULTS;
  }
}

let stop: (() => void) | null = null;

/** Applies the prefs to the document and remembers them. */
export function setPixelPrefs(prefs: PixelPrefs): void {
  stop?.();
  stop = applyPixelUnit(document.documentElement, prefs.scale);
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Private windows may refuse storage; the prefs still apply to this session.
  }
}
