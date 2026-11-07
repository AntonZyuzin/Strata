import type { Background } from '@strata/backend';
import {
  BACKDROP_SIDE,
  fitSize,
  generatePreset,
  type Pixels,
  type PresetId,
  processBackdrop,
} from '@strata/canvas';

/** Procedural presets are blurred anyway: half the photo's size looks the same (07 §7.1). */
const PRESET_W = BACKDROP_SIDE / 2;
const PRESET_H = Math.round((BACKDROP_SIDE / 2) * 0.625);

/** Derivatives made this session, by source and parameters: rebuilt, not stored (05 §12). */
const made = new Map<string, Promise<Pixels>>();

/** The key a background's derivative is kept under. */
export function backgroundKey(b: Background | null): string {
  return b ? JSON.stringify(b) : 'preset:fog';
}

/** The pipeline's numbers of a background (07 §7.1). */
function params(b: Background | null) {
  return {
    blur: b?.blur ?? 8,
    desaturate: b?.desaturate ?? 0.8,
    maxL: b?.maxL ?? 0.1,
    vignette: b?.vignette ?? 0.7,
  };
}

/** A picture's bytes decoded and scaled so its long side is 960 px (07 §7.1). */
async function decode(bytes: Uint8Array): Promise<Pixels> {
  const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]), {
    imageOrientation: 'from-image',
  });
  const { w, h } = fitSize(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas is not available');
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  return { width: w, height: h, data: ctx.getImageData(0, 0, w, h).data };
}

/**
 * What the canvas shows for a background (07 §7.1–7.3): a preset generated,
 * or one's own picture from its original; then blurred, desaturated,
 * normalised so the 95th percentile of luminance stays under `maxL`, the
 * vignette baked. None — «Туман». Made once per source and parameters.
 */
export function backgroundPixels(
  b: Background | null,
  asset: (sha: string) => Promise<Uint8Array>,
): Promise<Pixels> {
  const key = backgroundKey(b);
  const known = made.get(key);
  if (known) return known;
  const source = b?.source ?? 'preset:fog';
  const raw = source.startsWith('asset:')
    ? asset(source.slice('asset:'.length)).then(decode)
    : Promise.resolve(
        generatePreset(source.slice('preset:'.length) as PresetId, PRESET_W, PRESET_H),
      );
  const done = raw.then((px) => {
    processBackdrop(px, params(b));
    return px;
  });
  // A picture that would not decode is tried again next time, not kept failed.
  done.catch(() => made.delete(key));
  made.set(key, done);
  return done;
}
