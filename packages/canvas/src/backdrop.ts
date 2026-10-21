import { fog, palette } from '@strata/design-tokens';

/**
 * Background pipeline of 07 §7.1 and the Scene's contrast of 07 §2.2, as pure
 * functions over RGBA pixels: blur, desaturate, normalise the brightness so
 * the 95th percentile of luminance stays ≤ 0.10 (bubbles 6.1:1, wires 3.3:1),
 * bake a vignette. Procedural presets of 07 §7.3 are generated here too:
 * zero bytes in the bundle and no licence questions. The prototype runs it on
 * the main thread (tens of ms at 960 px); the app moves it to a worker.
 */

export interface Pixels {
  width: number;
  height: number;
  /** RGBA, 8 bits per channel. */
  data: Uint8ClampedArray;
}

export interface BackdropParams {
  /** Blur radius at 960 px, 4–16 (07 §7.1). */
  blur: number;
  /** 0..1, share of colour removed; 0.8 by default. */
  desaturate: number;
  /** Ceiling of the 95th percentile of relative luminance; 0.10 (`scene-bg-max-l`). */
  maxL: number;
  /** Edge brightness multiplier of the baked vignette; 0.7. */
  vignette: number;
}

export const DEFAULT_PARAMS: BackdropParams = {
  blur: 8,
  desaturate: 0.8,
  maxL: fog.scene.bgMaxL,
  vignette: 0.7,
};

/** Long side of a processed background (07 §7.1). */
export const BACKDROP_SIDE = 960;

const toLinear = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  toLinear[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function srgbToLinear(v8: number): number {
  return toLinear[Math.max(0, Math.min(255, Math.round(v8)))] ?? 0;
}

export function linearToSrgb(l: number): number {
  const c = l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(c * 255)));
}

/** WCAG relative luminance of an sRGB colour (0..255 channels). */
export function luminance(r: number, g: number, b: number): number {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

export function contrast(l1: number, l2: number): number {
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/** The `p`-quantile of relative luminance, over at most ~150 000 evenly spread pixels. */
export function luminanceQuantile(px: Pixels, p: number): number {
  const { data } = px;
  const total = data.length / 4;
  const step = Math.max(1, Math.ceil(total / 150_000));
  const n = Math.ceil(total / step);
  const values = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const i = k * step * 4;
    values[k] = luminance(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0);
  }
  values.sort();
  return values[Math.min(n - 1, Math.floor(p * n))] ?? 0;
}

/** Three box blurs of radius r approximate a Gaussian (StackBlur's job in 07 §7.1). */
export function blur(px: Pixels, radius: number): void {
  const r = Math.max(0, Math.round(radius));
  if (r === 0) return;
  const { width: w, height: h, data } = px;
  const tmp = new Float32Array(data.length);
  const src = Float32Array.from(data);
  for (let pass = 0; pass < 3; pass++) {
    boxPass(src, tmp, w, h, r, 4, w * 4);
    boxPass(tmp, src, h, w, r, w * 4, 4);
  }
  for (let i = 0; i < data.length; i++) data[i] = src[i] ?? 0;
}

/** One box blur along lines: `n` samples per line `stride` apart, `lines` lines `lineStep` apart. */
function boxPass(
  from: Float32Array,
  to: Float32Array,
  n: number,
  lines: number,
  r: number,
  stride: number,
  lineStep: number,
): void {
  const span = 2 * r + 1;
  for (let line = 0; line < lines; line++) {
    const base = line * lineStep;
    for (let c = 0; c < 4; c++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) {
        const i = Math.max(0, Math.min(n - 1, k));
        sum += from[base + i * stride + c] ?? 0;
      }
      for (let i = 0; i < n; i++) {
        to[base + i * stride + c] = sum / span;
        const out = Math.max(0, i - r);
        const inn = Math.min(n - 1, i + r + 1);
        sum += (from[base + inn * stride + c] ?? 0) - (from[base + out * stride + c] ?? 0);
      }
    }
  }
}

/** Mixes each pixel toward its luminance grey; `amount` 1 is fully grey. */
export function desaturate(px: Pixels, amount: number): void {
  const { data } = px;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    const grey = linearToSrgb(luminance(r, g, b));
    data[i] = r + (grey - r) * amount;
    data[i + 1] = g + (grey - g) * amount;
    data[i + 2] = b + (grey - b) * amount;
  }
}

/**
 * Brightness normalisation of 07 §7.1: if the 95th percentile of luminance is
 * above `maxL`, every pixel is scaled in linear RGB by maxL / p95.
 */
export function normalize(px: Pixels, maxL: number): number {
  const p95 = luminanceQuantile(px, 0.95);
  if (p95 <= maxL) return p95;
  const k = maxL / p95;
  const { data } = px;
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c++) data[i + c] = linearToSrgb(srgbToLinear(data[i + c] ?? 0) * k);
  }
  return luminanceQuantile(px, 0.95);
}

/** Radial falloff baked in: the centre stays, the corners are multiplied by `edge`. */
export function vignette(px: Pixels, edge: number): void {
  const { width: w, height: h, data } = px;
  const cx = w / 2;
  const cy = h / 2;
  const maxD = Math.hypot(cx, cy);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = Math.hypot(x - cx, y - cy) / maxD;
      const k = 1 - (1 - edge) * t * t;
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) data[i + c] = linearToSrgb(srgbToLinear(data[i + c] ?? 0) * k);
    }
  }
}

/** The pipeline of 07 §7.1 after decoding and downscaling; returns the final p95 luminance. */
export function processBackdrop(px: Pixels, params: BackdropParams = DEFAULT_PARAMS): number {
  blur(px, params.blur);
  desaturate(px, params.desaturate);
  normalize(px, params.maxL);
  vignette(px, params.vignette);
  return luminanceQuantile(px, 0.95);
}

/** Size of a picture scaled so its long side is `side` (never up). */
export function fitSize(w: number, h: number, side = BACKDROP_SIDE): { w: number; h: number } {
  const k = Math.min(1, side / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

// Procedural presets (07 §7.3).

export type PresetId = 'fog' | 'depth' | 'dusk' | 'dust';
export const PRESETS: PresetId[] = ['fog', 'depth', 'dusk', 'dust'];

function rng(seed: number): () => number {
  let x = seed | 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 4294967296;
  };
}

/** Value noise on a lattice, smoothly interpolated. */
function valueNoise(seed: number, size: number): (x: number, y: number) => number {
  const r = rng(seed);
  const grid = Float32Array.from({ length: size * size }, () => r());
  const at = (x: number, y: number) =>
    grid[(((y % size) + size) % size) * size + (((x % size) + size) % size)] ?? 0;
  return (x, y) => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx;
    const bottom = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx;
    return top + (bottom - top) * sy;
  };
}

/** Fractal Brownian motion of `octaves` value noises, 0..1. */
function fbm(seed: number, octaves: number): (x: number, y: number) => number {
  const layers = Array.from({ length: octaves }, (_, i) => valueNoise(seed + i * 101, 64));
  return (x, y) => {
    let sum = 0;
    let amp = 0.5;
    let freq = 1;
    let norm = 0;
    for (const n of layers) {
      sum += n(x * freq, y * freq) * amp;
      norm += amp;
      amp *= 0.5;
      freq *= 2;
    }
    return sum / norm;
  };
}

/** A procedural preset at `w × h`, before the pipeline; dark, grey or bluish-grey. */
export function generatePreset(id: PresetId, w: number, h: number): Pixels {
  const data = new Uint8ClampedArray(w * h * 4);
  const put = (i: number, r: number, g: number, b: number) => {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = 255;
  };
  const scale = 4 / Math.max(w, h);
  if (id === 'fog') {
    const n = fbm(7, 5);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = 18 + n(x * scale * 1.6, y * scale * 1.6) ** 1.6 * 120;
        put((y * w + x) * 4, v, v, v * 1.02);
      }
    }
  } else if (id === 'depth') {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const d = Math.hypot((x - w * 0.5) / w, (y - h * 0.42) / h) * 1.6;
        const v = Math.max(0, 1 - d) ** 1.8 * 110 + 12;
        put((y * w + x) * 4, v * 0.94, v * 0.97, v * 1.05);
      }
    }
  } else if (id === 'dusk') {
    // A mesh gradient of four soft points, desaturated by the pipeline.
    const points = [
      [0.15, 0.2, 120, 96, 110],
      [0.85, 0.25, 70, 90, 120],
      [0.3, 0.85, 60, 70, 80],
      [0.8, 0.8, 110, 100, 90],
    ] as const;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let r = 0;
        let g = 0;
        let b = 0;
        let wsum = 0;
        for (const [px, py, pr, pg, pb] of points) {
          const d = (x / w - px) ** 2 + (y / h - py) ** 2;
          const k = 1 / (d * 40 + 0.05) ** 2;
          r += pr * k;
          g += pg * k;
          b += pb * k;
          wsum += k;
        }
        put((y * w + x) * 4, r / wsum, g / wsum, b / wsum);
      }
    }
  } else {
    const n = fbm(23, 3);
    const r = rng(99);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = 14 + n(x * scale * 3, y * scale * 3) * 40;
        put((y * w + x) * 4, v, v, v);
      }
    }
    // Rare specks of dust, a few pixels wide; the blur softens them.
    for (let k = 0; k < (w * h) / 900; k++) {
      const x = Math.floor(r() * w);
      const y = Math.floor(r() * h);
      const v = 60 + r() * 120;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const i = (Math.min(h - 1, y + dy) * w + Math.min(w - 1, x + dx)) * 4;
          put(i, v, v, v);
        }
      }
    }
  }
  return { width: w, height: h, data };
}

// Contrast of the Scene over a background (07 §2.2, §11.1).

function hexRgb(c: string): [number, number, number] {
  const n = Number.parseInt(c.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** A grey of luminance `l`, as 8-bit sRGB. */
function greyOf(l: number): [number, number, number] {
  const v = linearToSrgb(l);
  return [v, v, v];
}

/** Alpha blending in sRGB, as 07 §2.2 computes it (and browsers do). */
function over(top: [number, number, number], a: number, bottom: [number, number, number]) {
  return top.map((c, i) => c * a + (bottom[i] ?? 0) * (1 - a)) as [number, number, number];
}

const lum = (c: [number, number, number]) => luminance(c[0], c[1], c[2]);

export interface ContrastRow {
  id: 'bubble' | 'wire' | 'today' | 'overdue' | 'overdueContour' | 'label';
  ratio: number;
  /** Threshold of 07 §11.1: 3:1 for graphics, 4.5:1 for text. */
  min: number;
}

/**
 * The pairs of the table in 07 §2.2 against a background whose bright parts
 * (95th percentile) have luminance `bgL`.
 */
export function sceneContrast(backgroundL: number): ContrastRow[] {
  // The background as the 8-bit grey a screen shows, as 07 §2.2 computes it.
  const bg = greyOf(backgroundL);
  const bgL = lum(bg);
  const paper = hexRgb(palette.paper);
  const wire = over(paper, fog.scene.edgeAlpha, bg);
  const plate = over([0, 0, 0], 0.7, bg);
  return [
    { id: 'bubble', ratio: contrast(lum(paper), bgL), min: 3 },
    { id: 'wire', ratio: contrast(lum(wire), bgL), min: 3 },
    { id: 'today', ratio: contrast(lum(hexRgb(palette.yellow500)), bgL), min: 3 },
    // Red alone fails (1.6:1); the paper contour carries the ring (07 §2.2).
    { id: 'overdue', ratio: contrast(lum(hexRgb(palette.red500)), bgL), min: 3 },
    { id: 'overdueContour', ratio: contrast(lum(paper), bgL), min: 3 },
    { id: 'label', ratio: contrast(lum(paper), lum(plate)), min: 4.5 },
  ];
}
