import type { Background } from '@strata/backend';
import {
  BACKDROP_SIDE,
  type BackgroundLook,
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

/** What a background lays over its picture (07 §7.2): its grain and fog; none — the defaults (07 §7.1). */
export function backgroundLook(b: Background | null): BackgroundLook {
  return { grain: b?.grain ?? 0.67, fog: b?.fog ?? 0 };
}

/** The readable mode's ceiling of one's own picture's 95th percentile of luminance (07 §11.4). */
const READABLE_MAX_L = 0.05;

/** The readable mode's plain ground (07 §11.4): #111111. */
export function plainBackdrop(): Pixels {
  const data = new Uint8ClampedArray(2 * 2 * 4);
  for (let i = 0; i < 4; i++) data.set([0x11, 0x11, 0x11, 255], i * 4);
  return { width: 2, height: 2, data };
}

/** The key a background's derivative is kept under, the readable mode's apart. */
export function backgroundKey(b: Background | null, readable = false): string {
  const key = b ? JSON.stringify(b) : 'preset:fog';
  return readable ? `readable:${key}` : key;
}

/** The pipeline's numbers of a background (07 §7.1); darker in the readable mode (§11.4). */
function params(b: Background | null, readable: boolean) {
  const maxL = b?.maxL ?? 0.1;
  return {
    blur: b?.blur ?? 8,
    desaturate: b?.desaturate ?? 0.8,
    maxL: readable ? Math.min(maxL, READABLE_MAX_L) : maxL,
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
 * vignette baked. None — «Туман». The readable mode (§11.4) shows a preset
 * as the plain #111111 and one's own picture under 0.05. Made once per
 * source and parameters.
 */
export function backgroundPixels(
  b: Background | null,
  asset: (sha: string) => Promise<Uint8Array>,
  readable = false,
): Promise<Pixels> {
  const key = backgroundKey(b, readable);
  const known = made.get(key);
  if (known) return known;
  const source = b?.source ?? 'preset:fog';
  if (readable && !source.startsWith('asset:')) {
    const plain = Promise.resolve(plainBackdrop());
    made.set(key, plain);
    return plain;
  }
  const raw = source.startsWith('asset:')
    ? asset(source.slice('asset:'.length)).then(decode)
    : Promise.resolve(
        generatePreset(source.slice('preset:'.length) as PresetId, PRESET_W, PRESET_H),
      );
  const done = raw.then((px) => {
    processBackdrop(px, params(b, readable));
    return px;
  });
  // A picture that would not decode is tried again next time, not kept failed.
  done.catch(() => made.delete(key));
  made.set(key, done);
  return done;
}
