/**
 * RotSprite (Xenowhirl, 2007): pixel art turned by any angle without
 * breaking into specks — the image is enlarged ×8 by Scale2x three times,
 * and each pixel of the result takes the enlarged pixel under its centre.
 * Images are 32-bit RGBA words, as a `Uint32Array` over `ImageData`.
 */

export const ROTSPRITE = 8;

/** Doubles pixel art by Scale2x (EPX): edges stay hard, diagonals stay joined. */
export function scale2x(src: Uint32Array, w: number, h: number): Uint32Array {
  const out = new Uint32Array(w * h * 4),
    W = w * 2;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = src[y * w + x]!;
      const a = y > 0 ? src[(y - 1) * w + x]! : p,
        d = y < h - 1 ? src[(y + 1) * w + x]! : p;
      const c = x > 0 ? src[y * w + x - 1]! : p,
        b = x < w - 1 ? src[y * w + x + 1]! : p;
      const o = y * 2 * W + x * 2;
      out[o] = c === a && c !== d && a !== b ? a : p;
      out[o + 1] = a === b && a !== c && b !== d ? b : p;
      out[o + W] = d === c && d !== b && c !== a ? c : p;
      out[o + W + 1] = b === d && b !== a && d !== c ? d : p;
    }
  return out;
}

/** The image enlarged ×8 by Scale2x. */
export function enlarge(px: Uint32Array, w: number, h: number): Uint32Array {
  return scale2x(scale2x(scale2x(px, w, h), w * 2, h * 2), w * 4, h * 4);
}

/**
 * Fills `out` (w × h) with the enlarged image turned: a source point `s`,
 * mirrored about x = w / 2 first when `mirror`, lands at `to + R(angle)(s − pivot)`.
 */
export function sampleTurn(
  big: Uint32Array,
  w: number,
  h: number,
  out: Uint32Array,
  angle: number,
  pivot: readonly [number, number],
  to: readonly [number, number],
  mirror = false,
  scale = 1,
): void {
  const W = w * ROTSPRITE,
    H = h * ROTSPRITE;
  const cos = Math.cos(-angle),
    sin = Math.sin(-angle);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const dx = (x + 0.5 - to[0]) / scale,
        dy = (y + 0.5 - to[1]) / scale;
      const fx = pivot[0] + dx * cos - dy * sin,
        fy = pivot[1] + dx * sin + dy * cos;
      const sx = Math.floor((mirror ? w - fx : fx) * ROTSPRITE),
        sy = Math.floor(fy * ROTSPRITE);
      out[y * w + x] = sx >= 0 && sy >= 0 && sx < W && sy < H ? big[sy * W + sx]! : 0;
    }
}

/** Keep the complete silhouette inside its native canvas when it turns vertically. */
export function fitTurnScale(
  pixels: Uint32Array,
  width: number,
  height: number,
  angle: number,
  pivot: readonly [number, number],
  to: readonly [number, number],
  mirror = false,
): number {
  const cos = Math.cos(angle),
    sin = Math.sin(angle);
  let scale = 1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      if (!(pixels[y * width + x]! >>> 24)) continue;
      const dx = (mirror ? width - x - 0.5 : x + 0.5) - pivot[0];
      const dy = y + 0.5 - pivot[1];
      const tx = dx * cos - dy * sin,
        ty = dx * sin + dy * cos;
      if (tx < 0) scale = Math.min(scale, (to[0] - 2) / -tx);
      if (tx > 0) scale = Math.min(scale, (width - to[0] - 2) / tx);
      if (ty < 0) scale = Math.min(scale, (to[1] - 2) / -ty);
      if (ty > 0) scale = Math.min(scale, (height - to[1] - 2) / ty);
    }
  return Math.max(0.1, scale);
}
