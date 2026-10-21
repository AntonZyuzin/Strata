import type { Pixels } from './backdrop';

/**
 * «Привести к стилю» for custom icons (07 §6.4–6.5), pure functions over RGBA:
 * background removal without a neural net (alpha, or a flood from the
 * corners), then one of the modes — «Гравюра» (grey → levels → light unsharp
 * → Otsu, the default, ☑ Q-05-7), «Пиксель» (downscale → Bayer 4×4 →
 * nearest upscale), «Силуэт» (alpha → solid), «Фото» (Floyd–Steinberg),
 * «Как есть» (grey). The result is a square mask: alpha is the ink, so the
 * Scene tints it like any preset (07 §6.6). Spike 9 measures how often
 * «Гравюра» is acceptable with no manual edits (R7 §8 item 3).
 */

export type StyleMode = 'engraving' | 'pixel' | 'silhouette' | 'photo' | 'as-is';
export const STYLE_MODES: StyleMode[] = ['engraving', 'pixel', 'silhouette', 'photo', 'as-is'];

export interface StyleParams {
  mode: StyleMode;
  /** 0..255; null is automatic (Otsu). */
  threshold: number | null;
  invert: boolean;
}

export const DEFAULT_STYLE: StyleParams = { mode: 'engraving', threshold: null, invert: false };

/** Side of the produced mask, the largest of 07 §6.7. */
export const MASK_SIDE = 128;

export interface StyleResult {
  /** MASK_SIDE² alpha values, 255 = full ink. */
  mask: Uint8ClampedArray;
  /** The threshold used, for the slider's starting point. */
  threshold: number;
  /** How the background was found. */
  background: 'alpha' | 'flood' | 'none';
}

const lum8 = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Otsu's threshold over a histogram of 8-bit values, weighted by `weight` (0..1). */
export function otsu(values: Float32Array, weight: Float32Array): number {
  const hist = new Float64Array(256);
  let total = 0;
  for (let i = 0; i < values.length; i++) {
    const w = weight[i] ?? 0;
    const bin = Math.max(0, Math.min(255, Math.round(values[i] ?? 0)));
    hist[bin] = (hist[bin] ?? 0) + w;
    total += w;
  }
  if (total === 0) return 128;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * (hist[t] ?? 0);
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t] ?? 0;
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * (hist[t] ?? 0);
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  return threshold;
}

/**
 * Foreground weight per pixel (0..1). A picture with real transparency uses
 * its alpha; an opaque one is flooded from the four corners through pixels
 * close to the corner colour (07 §6.4, «заливка от углов»).
 */
export function foreground(
  px: Pixels,
  tolerance = 40,
): { weight: Float32Array; kind: StyleResult['background'] } {
  const { width: w, height: h, data } = px;
  const n = w * h;
  const weight = new Float32Array(n);
  let transparent = 0;
  for (let i = 0; i < n; i++) {
    const a = data[i * 4 + 3] ?? 255;
    weight[i] = a / 255;
    if (a < 250) transparent++;
  }
  if (transparent > n * 0.05) return { weight, kind: 'alpha' };
  weight.fill(1);
  const seen = new Uint8Array(n);
  const stack: number[] = [];
  let flooded = 0;
  for (const start of [0, w - 1, (h - 1) * w, n - 1]) {
    const r0 = data[start * 4] ?? 0;
    const g0 = data[start * 4 + 1] ?? 0;
    const b0 = data[start * 4 + 2] ?? 0;
    stack.push(start);
    while (stack.length > 0) {
      const i = stack.pop() as number;
      if (seen[i]) continue;
      const d =
        Math.abs((data[i * 4] ?? 0) - r0) +
        Math.abs((data[i * 4 + 1] ?? 0) - g0) +
        Math.abs((data[i * 4 + 2] ?? 0) - b0);
      if (d > tolerance) continue;
      seen[i] = 1;
      weight[i] = 0;
      flooded++;
      const x = i % w;
      if (x > 0) stack.push(i - 1);
      if (x < w - 1) stack.push(i + 1);
      if (i >= w) stack.push(i - w);
      if (i < n - w) stack.push(i + w);
    }
  }
  // A flood that took almost everything found no figure: keep the picture whole.
  if (flooded > n * 0.97 || flooded === 0) {
    weight.fill(1);
    return { weight, kind: 'none' };
  }
  return { weight, kind: 'flood' };
}

/** Bounding box of the foreground, squared and padded by 6 %, inside the picture. */
function squareCrop(w: number, h: number, weight: Float32Array) {
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if ((weight[y * w + x] ?? 0) > 0.5) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return { x: 0, y: 0, side: Math.max(w, h) };
  const side = Math.ceil(Math.max(maxX - minX + 1, maxY - minY + 1) * 1.12);
  return {
    x: Math.round((minX + maxX + 1) / 2 - side / 2),
    y: Math.round((minY + maxY + 1) / 2 - side / 2),
    side,
  };
}

/** Samples `px` and `weight` into a `side × side` grid (box filter), outside is background. */
function resample(
  px: Pixels,
  weight: Float32Array,
  crop: { x: number; y: number; side: number },
  side: number,
) {
  const grey = new Float32Array(side * side);
  const fg = new Float32Array(side * side);
  const k = crop.side / side;
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      let g = 0;
      let f = 0;
      let count = 0;
      const sx0 = crop.x + x * k;
      const sy0 = crop.y + y * k;
      const steps = Math.max(1, Math.ceil(k));
      for (let j = 0; j < steps; j++) {
        for (let i = 0; i < steps; i++) {
          const sx = Math.floor(sx0 + ((i + 0.5) * k) / steps);
          const sy = Math.floor(sy0 + ((j + 0.5) * k) / steps);
          count++;
          if (sx < 0 || sy < 0 || sx >= px.width || sy >= px.height) {
            g += 255;
            continue;
          }
          const p = sy * px.width + sx;
          const wgt = weight[p] ?? 0;
          const v = lum8(px.data[p * 4] ?? 0, px.data[p * 4 + 1] ?? 0, px.data[p * 4 + 2] ?? 0);
          // Background reads as paper, so it never becomes ink.
          g += v * wgt + 255 * (1 - wgt);
          f += wgt;
        }
      }
      grey[y * side + x] = g / count;
      fg[y * side + x] = f / count;
    }
  }
  return { grey, fg };
}

/**
 * Stretches the 1st–99th percentile of the foreground to 0..255 («уровни»).
 * Returns the spread of the figure's tones before stretching: a small one is
 * a flat figure (a logo, a clipart), which has no tones to threshold.
 */
function levels(grey: Float32Array, fg: Float32Array): number {
  const vals: number[] = [];
  for (let i = 0; i < grey.length; i++) if ((fg[i] ?? 0) > 0.5) vals.push(grey[i] ?? 0);
  if (vals.length < 16) return 0;
  vals.sort((a, b) => a - b);
  const lo = vals[Math.floor(vals.length * 0.01)] ?? 0;
  const hi = vals[Math.floor(vals.length * 0.99)] ?? 255;
  if (hi - lo < FLAT) return hi - lo;
  for (let i = 0; i < grey.length; i++) {
    grey[i] = Math.max(0, Math.min(255, (((grey[i] ?? 0) - lo) / (hi - lo)) * 255));
  }
  return hi - lo;
}

/** Below this spread of tones a figure is flat and becomes a silhouette. */
const FLAT = 24;

/** A light unsharp mask: grey + 0.6 × (grey − blur3×3). */
function unsharp(grey: Float32Array, side: number): void {
  const copy = Float32Array.from(grey);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      let s = 0;
      let c = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= side || yy >= side) continue;
          s += copy[yy * side + xx] ?? 0;
          c++;
        }
      }
      const v = copy[y * side + x] ?? 0;
      grey[y * side + x] = Math.max(0, Math.min(255, v + 0.6 * (v - s / c)));
    }
  }
}

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/** The whole pipeline: picture → square ink mask of MASK_SIDE (07 §6.4–6.5). */
export function stylize(px: Pixels, params: StyleParams = DEFAULT_STYLE): StyleResult {
  const { weight, kind } = foreground(px);
  const crop = squareCrop(px.width, px.height, weight);
  const side = MASK_SIDE;
  const mask = new Uint8ClampedArray(side * side);
  const { mode } = params;
  if (mode === 'pixel') {
    const small = 32;
    const s = resample(px, weight, crop, small);
    levels(s.grey, s.fg);
    const t = params.threshold ?? otsu(s.grey, s.fg);
    for (let y = 0; y < side; y++) {
      for (let x = 0; x < side; x++) {
        const sx = Math.floor((x * small) / side);
        const sy = Math.floor((y * small) / side);
        const v = s.grey[sy * small + sx] ?? 255;
        // Bayer offsets the threshold by up to ±half a step of 64 levels.
        const bias = ((BAYER4[(sy % 4) * 4 + (sx % 4)] ?? 0) / 16 - 0.5) * 64;
        const ink = v < t + bias && (s.fg[sy * small + sx] ?? 0) > 0.5;
        mask[y * side + x] = ink !== params.invert ? 255 : 0;
      }
    }
    return { mask, threshold: t, background: kind };
  }
  const { grey, fg } = resample(px, weight, crop, side);
  if (mode === 'silhouette') {
    for (let i = 0; i < mask.length; i++) {
      const ink = (fg[i] ?? 0) > 0.5;
      mask[i] = ink !== params.invert ? 255 : 0;
    }
    return { mask, threshold: 128, background: kind };
  }
  const spread = levels(grey, fg);
  if (mode === 'as-is') {
    for (let i = 0; i < mask.length; i++) {
      const ink = (255 - (grey[i] ?? 255)) * (fg[i] ?? 0);
      mask[i] = params.invert ? 255 - ink : ink;
    }
    return { mask, threshold: 128, background: kind };
  }
  if (mode === 'photo') {
    // Floyd–Steinberg on the grey, threshold at the middle.
    const err = Float32Array.from(grey);
    for (let y = 0; y < side; y++) {
      for (let x = 0; x < side; x++) {
        const i = y * side + x;
        const v = err[i] ?? 255;
        const out = v < 128 ? 0 : 255;
        const e = v - out;
        if (x + 1 < side) err[i + 1] = (err[i + 1] ?? 0) + (e * 7) / 16;
        if (y + 1 < side) {
          if (x > 0) err[i + side - 1] = (err[i + side - 1] ?? 0) + (e * 3) / 16;
          err[i + side] = (err[i + side] ?? 0) + (e * 5) / 16;
          if (x + 1 < side) err[i + side + 1] = (err[i + side + 1] ?? 0) + e / 16;
        }
        const ink = out === 0 && (fg[i] ?? 0) > 0.5;
        mask[i] = ink !== params.invert ? 255 : 0;
      }
    }
    return { mask, threshold: 128, background: kind };
  }
  if (spread < FLAT && params.threshold === null) {
    // A flat figure has one tone: Otsu would cut its unsharp halo. It is all ink.
    for (let i = 0; i < mask.length; i++) {
      const ink = (fg[i] ?? 0) > 0.5;
      mask[i] = ink !== params.invert ? 255 : 0;
    }
    return { mask, threshold: 128, background: kind };
  }
  unsharp(grey, side);
  const t = params.threshold ?? otsu(grey, fg);
  for (let i = 0; i < mask.length; i++) {
    const ink = (grey[i] ?? 255) < t && (fg[i] ?? 0) > 0.5;
    mask[i] = ink !== params.invert ? 255 : 0;
  }
  return { mask, threshold: t, background: kind };
}

/** Share of ink in a mask, 0..1: the report's hint for empty or flooded results. */
export function inkShare(mask: Uint8ClampedArray): number {
  let s = 0;
  for (let i = 0; i < mask.length; i++) s += mask[i] ?? 0;
  return s / (255 * mask.length);
}
