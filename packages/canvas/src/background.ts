import { fog, palette } from '@strata/design-tokens';
import { CanvasSource, Container, Sprite, Texture, TilingSprite } from 'pixi.js';
import { luminanceQuantile, type Pixels } from './backdrop';
import type { Camera } from './camera';

/**
 * The background of the Scene (07 §7.2): one «cover» sprite of a processed
 * picture with a parallax of 3 % of the camera's movement, and a static grain
 * tile. The two or three fog spots move with the same parallax as the picture,
 * so they are baked into it: two full-screen layers instead of five, which
 * matters for fill rate on weak GPUs and software WebGL. Nothing is blurred per
 * frame and nothing moves by itself; the layer redraws only with the camera,
 * so idle costs nothing (07 §10.2).
 */

/** Extra size of the cover on each side, so the parallax never shows an edge. */
const MARGIN = 0.08;
const GRAIN = 256;

/** Fog spots in picture fractions: centre and radius (of the long side). */
const FOG_SPOTS = [
  [0.22, 0.3, 0.45],
  [0.78, 0.62, 0.55],
  [0.5, 0.95, 0.4],
] as const;

/** Paper as `r, g, b` for canvas colour strings. */
const PAPER_RGB = [1, 3, 5]
  .map((i) => Number.parseInt(palette.paper.slice(i, i + 2), 16))
  .join(', ');

/** The picture with fog baked in, as a texture, and its 95th percentile of luminance. */
function bake(px: Pixels, fogAmount: number): { texture: Texture; p95: number } {
  const canvas = document.createElement('canvas');
  canvas.width = px.width;
  canvas.height = px.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas is not available');
  const img = ctx.createImageData(px.width, px.height);
  img.data.set(px.data);
  ctx.putImageData(img, 0, 0);
  if (fogAmount > 0) {
    const side = Math.max(px.width, px.height);
    for (const [x, y, r] of FOG_SPOTS) {
      const cx = x * px.width;
      const cy = y * px.height;
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * side);
      const a = 0.12 * fogAmount;
      g.addColorStop(0, `rgba(${PAPER_RGB}, ${a})`);
      g.addColorStop(1, `rgba(${PAPER_RGB}, 0)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, px.width, px.height);
    }
  }
  const baked = ctx.getImageData(0, 0, px.width, px.height);
  const p95 = luminanceQuantile({ width: px.width, height: px.height, data: baked.data }, 0.95);
  const texture = new Texture({
    source: new CanvasSource({ resource: canvas, scaleMode: 'linear' }),
  });
  return { texture, p95 };
}

/** Black and white specks of random alpha: neutral on average, so the grain does not lift the fog. */
function grainTexture(): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = GRAIN;
  canvas.height = GRAIN;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas is not available');
  const img = ctx.createImageData(GRAIN, GRAIN);
  let x = 0x2545f491;
  for (let i = 0; i < GRAIN * GRAIN; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    const v = (x >>> 0) / 4294967296;
    const shade = v > 0.5 ? 255 : 0;
    img.data[i * 4] = shade;
    img.data[i * 4 + 1] = shade;
    img.data[i * 4 + 2] = shade;
    img.data[i * 4 + 3] = Math.round(((v * 2) % 1) * 255);
  }
  ctx.putImageData(img, 0, 0);
  return new Texture({ source: new CanvasSource({ resource: canvas, scaleMode: 'nearest' }) });
}

export class BackgroundLayer {
  readonly container = new Container();
  private readonly cover = new Sprite();
  private readonly grain: TilingSprite;
  private readonly grainTex = grainTexture();
  private picture: Texture | null = null;
  /** 95th percentile of the shown picture's luminance, fog included (07 §7.1). */
  p95 = 0;
  reducedMotion = false;

  /**
   * @param grain 0..1, grain opacity is grain × 6 % (07 §7.2)
   * @param fogAmount 0..1, 0 turns the fog off
   */
  constructor(
    grain = fog.scene.grainOpacity / 0.06,
    private readonly fogAmount = 0.5,
  ) {
    // Specks have 50 % alpha on average, so the tile's alpha is doubled.
    this.grain = new TilingSprite({ texture: this.grainTex, alpha: 2 * grain * 0.06 });
    this.grain.visible = grain > 0;
    this.cover.visible = false;
    this.container.addChild(this.cover, this.grain);
  }

  /** Shows a processed picture (07 §7.1) with the fog baked in; returns its p95 luminance. */
  setPicture(px: Pixels): number {
    const old = this.picture;
    const { texture, p95 } = bake(px, this.fogAmount);
    this.picture = texture;
    this.cover.texture = texture;
    this.cover.visible = true;
    this.p95 = p95;
    old?.destroy(true);
    return p95;
  }

  /** Lays the layer out for a screen of w × h and the camera's position (07 §7.2 parallax). */
  follow(cam: Camera, w: number, h: number): void {
    const k = fog.scene.parallax;
    const mx = w * MARGIN;
    const my = h * MARGIN;
    const px = this.reducedMotion ? 0 : clamp(-cam.x * cam.zoom * k, -mx, mx);
    const py = this.reducedMotion ? 0 : clamp(-cam.y * cam.zoom * k, -my, my);
    if (this.picture) {
      const tw = this.picture.width;
      const th = this.picture.height;
      const s = Math.max((w + 2 * mx) / tw, (h + 2 * my) / th);
      this.cover.scale.set(s);
      this.cover.position.set((w - tw * s) / 2 + px, (h - th * s) / 2 + py);
    }
    this.grain.width = w;
    this.grain.height = h;
  }

  destroy(): void {
    this.picture?.destroy(true);
    this.grainTex.destroy(true);
    this.container.destroy({ children: true });
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
