/**
 * Quality presets of the star map (08 §8.4, NFR-19): chosen by the time of
 * the first 120 frames, a choice by hand above the automatic one; kept on
 * the device. Only the frame time decides — WebKitGTK hides its renderer and
 * may quietly take the slow path (R4 §1.3).
 */

export type Quality = 'high' | 'medium' | 'economy' | 'off';

export const QUALITIES: readonly Quality[] = ['high', 'medium', 'economy', 'off'];

/** What a preset draws (08 §8.4). */
export interface QualityLook {
  /** Bloom at half resolution on the key stars. */
  bloom: boolean;
  /** The static halos of «soon» and the flash of a new star. */
  halos: boolean;
  /** Frames per second at most while something moves. */
  fps: number;
  /** The physics runs only while a star is touched: no settling of new stars. */
  touchOnly: boolean;
}

export const QUALITY: Record<Quality, QualityLook> = {
  high: { bloom: true, halos: true, fps: 60, touchOnly: false },
  medium: { bloom: false, halos: true, fps: 60, touchOnly: false },
  economy: { bloom: false, halos: false, fps: 30, touchOnly: true },
  off: { bloom: false, halos: false, fps: 30, touchOnly: true },
};

/** The preset before any frame is measured (08 §8.4). */
export const DEFAULT_QUALITY: Quality = 'medium';

/** Frames measured before the automatic choice (08 §8.4). */
export const QUALITY_FRAMES = 120;

/** The 95th percentile of frame times, ms. */
export function p95(samples: readonly number[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)] ?? 0;
}

/**
 * The automatic choice by the p95 of the first frames (08 §8.4): ≤ 12 ms —
 * high, ≤ 20 — medium, more — economy; measured in economy at over 50 ms —
 * off, and the canvas stays.
 */
export function chooseQuality(p: number, measuredIn: Quality): Quality {
  if (measuredIn === 'economy' && p > 50) return 'off';
  if (p <= 12) return 'high';
  if (p <= 20) return 'medium';
  return 'economy';
}

/** The device's note: the hand's choice and the automatic one. */
export interface QualityNote {
  manual: Quality | null;
  auto: Quality | null;
}

export function readQuality(text: string | null): QualityNote {
  try {
    const v = text ? (JSON.parse(text) as Partial<QualityNote>) : {};
    const ok = (q: unknown): Quality | null =>
      QUALITIES.includes(q as Quality) ? (q as Quality) : null;
    return { manual: ok(v.manual), auto: ok(v.auto) };
  } catch {
    // A broken note starts afresh: the frames choose again.
    return { manual: null, auto: null };
  }
}

/** The preset in force: the hand's, else the measured one, else the default. */
export function qualityOf(note: QualityNote): Quality {
  return note.manual ?? note.auto ?? DEFAULT_QUALITY;
}
