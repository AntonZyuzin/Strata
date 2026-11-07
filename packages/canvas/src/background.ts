import { fog, palette } from '@strata/design-tokens';
import { CanvasSource, Container, Sprite, Texture, TilingSprite } from 'pixi.js';
import { luminanceQuantile, type Pixels } from './backdrop';
import type { Camera } from './camera';

/**
 * The background of the Scene (07 §7.2): one «cover» sprite of a processed
 * picture with a parallax of 3 % of the camera's movement, and a static grain
 * tile, its opacity the background's `grain` × 6 %. The two or three fog
 * spots move with the same parallax as the picture, so they are baked into
 * it, their alpha the background's `fog` (0 — none): two full-screen layers
 * instead of five, which matters for fill rate on weak GPUs and software
 * WebGL. Nothing is blurred per frame and nothing moves by itself; the layer
 * redraws only with the camera, so idle costs nothing (07 §10.2) — but for
 * the crossfade of 300 ms when the background changes (07 §7.4), instant
 * with «less motion».
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

/** What a background lays over its picture (07 §7.1): `Background.grain`, `Background.fog`. */
export interface BackgroundLook {
  /** 0..1: the grain's opacity is grain × 6 %. */
  grain: number;
  /** 0..1: 0 — no fog, else the spots' strength. */
  fog: number;
}

/** The crossfade between two backgrounds, ms (07 §7.4, §2.8 `bgFade`). */
const FADE_MS = fog.dur.bgFade;

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
  /** The picture going away under the new one while it fades in (07 §7.4). */
  private readonly outgoing = new Sprite();
  private readonly grain: TilingSprite;
  private readonly grainTex = grainTexture();
  private picture: Texture | null = null;
  private leaving: Texture | null = null;
  /** When the crossfade began; −1 — at its first frame; null — none. */
  private fadeStart: number | null = null;
  /** 95th percentile of the shown picture's luminance, fog included (07 §7.1). */
  p95 = 0;
  reducedMotion = false;
  /** The readable mode (07 §11.4): no grain, no fog. */
  private readable = false;
  private look: BackgroundLook;

  /** @param look the grain and the fog until a background gives its own (07 §7.2). */
  constructor(look: BackgroundLook = { grain: fog.scene.grainOpacity / 0.06, fog: 0.5 }) {
    this.look = look;
    this.grain = new TilingSprite({ texture: this.grainTex });
    this.cover.visible = false;
    this.outgoing.visible = false;
    this.container.addChild(this.outgoing, this.cover, this.grain);
    this.applyGrain();
  }

  /**
   * Shows a processed picture (07 §7.1) with the fog baked in, `look` its
   * grain and fog (the last one's by default); the one shown before fades
   * out under it. Returns its p95 luminance.
   */
  setPicture(px: Pixels, look: BackgroundLook = this.look): number {
    this.look = look;
    const old = this.picture;
    const { texture, p95 } = bake(px, this.readable ? 0 : look.fog);
    this.picture = texture;
    this.cover.texture = texture;
    this.cover.visible = true;
    this.p95 = p95;
    this.applyGrain();
    if (old && !this.reducedMotion) {
      this.leaving?.destroy(true);
      this.leaving = old;
      this.outgoing.texture = old;
      this.outgoing.visible = true;
      this.cover.alpha = 0;
      this.fadeStart = -1;
    } else {
      old?.destroy(true);
      this.cover.alpha = 1;
    }
    return p95;
  }

  /** One frame of the crossfade (07 §7.4); true while it still runs. */
  step(now: number): boolean {
    if (this.fadeStart === null) return false;
    if (this.fadeStart < 0) this.fadeStart = now;
    const k = Math.min(1, (now - this.fadeStart) / FADE_MS);
    this.cover.alpha = k;
    if (k < 1) return true;
    this.fadeStart = null;
    this.outgoing.visible = false;
    this.leaving?.destroy(true);
    this.leaving = null;
    return false;
  }

  /** The grain and the fog shown, whether a crossfade runs: for tests. */
  state(): { grain: number; fog: number; fading: boolean } {
    return {
      grain: this.grain.visible ? this.look.grain : 0,
      fog: this.readable ? 0 : this.look.fog,
      fading: this.fadeStart !== null,
    };
  }

  private applyGrain(): void {
    // Specks have 50 % alpha on average, so the tile's alpha is doubled.
    this.grain.alpha = 2 * this.look.grain * 0.06;
    this.grain.visible = !this.readable && this.look.grain > 0;
  }

  /**
   * The readable mode (07 §11.4): the grain goes, and the next picture comes
   * without fog — the Chrome gives a plain one or one's own darker.
   */
  setReadable(on: boolean): void {
    this.readable = on;
    this.applyGrain();
  }

  /** Lays the layer out for a screen of w × h and the camera's position (07 §7.2 parallax). */
  follow(cam: Camera, w: number, h: number): void {
    const k = fog.scene.parallax;
    const mx = w * MARGIN;
    const my = h * MARGIN;
    const px = this.reducedMotion ? 0 : clamp(-cam.x * cam.zoom * k, -mx, mx);
    const py = this.reducedMotion ? 0 : clamp(-cam.y * cam.zoom * k, -my, my);
    for (const [sprite, tex] of [
      [this.cover, this.picture],
      [this.outgoing, this.leaving],
    ] as const) {
      if (!tex) continue;
      const s = Math.max((w + 2 * mx) / tex.width, (h + 2 * my) / tex.height);
      sprite.scale.set(s);
      sprite.position.set((w - tex.width * s) / 2 + px, (h - tex.height * s) / 2 + py);
    }
    this.grain.width = w;
    this.grain.height = h;
  }

  destroy(): void {
    this.picture?.destroy(true);
    this.leaving?.destroy(true);
    this.grainTex.destroy(true);
    this.container.destroy({ children: true });
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
