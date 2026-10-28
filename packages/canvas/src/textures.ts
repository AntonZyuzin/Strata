import { fog, GLYPHS, type GlyphName, palette } from '@strata/design-tokens';
import { BitmapFont, CanvasSource, Texture } from 'pixi.js';
import { hexPath } from './hex';

/** Bubble diameters S, M, L, XL in world units (07 §4.2, 06 §4.2). */
export const SIZE = { s: 32, m: 48, l: 72, xl: 108 } as const;

/** Body texture circumradius: drawn once, large, with mips for every zoom. */
const BODY_R = 128;

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2D canvas is not available');
  return [c, ctx];
}

/**
 * A white hexagon with a point up for bubble bodies (ADR-0011; tinted paper
 * or grey by state), its corners on the old circle, and a soft halo.
 */
export function createBodyTextures(): { body: Texture; halo: Texture; destroy(): void } {
  const [bc, b] = canvas(2 * BODY_R + 4, 2 * BODY_R + 4);
  b.fillStyle = '#ffffff';
  hexPath(b, BODY_R + 2, BODY_R + 2, BODY_R).fill();
  const body = new Texture({
    source: new CanvasSource({ resource: bc, autoGenerateMipmaps: true, scaleMode: 'linear' }),
  });
  // «Срок скоро»: a static halo up to 1.5 r (07 §4.3), a sprite, not a filter (07 §10.1).
  const size = 256;
  const [hc, h] = canvas(size, size);
  const grad = h.createRadialGradient(size / 2, size / 2, size / 6, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  h.fillStyle = grad;
  h.fillRect(0, 0, size, size);
  const halo = new Texture({
    source: new CanvasSource({ resource: hc, autoGenerateMipmaps: true, scaleMode: 'linear' }),
  });
  return {
    body,
    halo,
    destroy() {
      body.destroy(true);
      halo.destroy(true);
    },
  };
}

/** Corner to corner of the body texture's hexagon, for sprite scaling. */
export const BODY_DIAMETER = 2 * BODY_R;
export const BODY_TEXTURE = 2 * BODY_R + 4;

export type Plate = 'none' | 'ink' | 'attention' | 'overdue' | 'paper';

/**
 * Pixel glyphs on the Scene (07 §3.4, §4.5): drawn at whole device pixels, one
 * picture pixel = u device px, nearest scaling. With a plate the glyph sits on
 * a 12u square with a 1u frame: ink on yellow or red, paper on ink.
 */
export class GlyphTextures {
  private readonly cache = new Map<string, Texture>();

  constructor(
    readonly u: number,
    readonly dpr: number,
  ) {}

  /**
   * `paper` draws the glyph itself in paper, for the ghost's «?» on the bare
   * Scene; `pad` — the plate's margin around the glyph in pixel units.
   */
  get(
    name: GlyphName,
    plate: Plate = 'none',
    scale = 1,
    paper = plate === 'ink',
    pad = 2,
  ): Texture {
    const key = `${name}:${plate}:${scale}:${paper}:${pad}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const rows = GLYPHS[name];
    const n = rows.length;
    const px = this.u * scale;
    const border = plate === 'none' ? 0 : pad * this.u;
    const side = n * px + 2 * border;
    const [c, ctx] = canvas(side, side);
    if (plate !== 'none') {
      const frame = plate === 'ink' ? palette.paper : palette.ink850;
      const fill =
        plate === 'ink'
          ? palette.ink850
          : plate === 'paper'
            ? palette.paper
            : plate === 'attention'
              ? palette.yellow500
              : palette.red500;
      ctx.fillStyle = frame;
      ctx.fillRect(0, 0, side, side);
      ctx.fillStyle = fill;
      ctx.fillRect(this.u, this.u, side - 2 * this.u, side - 2 * this.u);
    }
    ctx.fillStyle = paper ? palette.paper : palette.ink850;
    rows.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        if (row[x] === '#') ctx.fillRect(border + x * px, border + y * px, px, px);
      }
    });
    const tex = new Texture({
      source: new CanvasSource({ resource: c, resolution: this.dpr, scaleMode: 'nearest' }),
    });
    this.cache.set(key, tex);
    return tex;
  }

  destroy(): void {
    for (const t of this.cache.values()) t.destroy(true);
    this.cache.clear();
  }
}

const LABEL_CHARS: (string | string[])[] = [
  ['a', 'z'],
  ['A', 'Z'],
  ['0', '9'],
  ['а', 'я'],
  ['А', 'Я'],
  ' ёЁ.,:;-—–«»“”‘’№!?()/+#&…↗×%',
];

const installed = new Set<string>();

/**
 * Departure Mono as a bitmap font at an exact device size (07 §3.4): glyphs
 * are rasterised at `devicePx` and sampled nearest, so labels stay on the
 * font's pixel grid. Returns the font name; a size is installed once.
 */
export function labelFont(devicePx: number, dpr: number): string {
  const name = `StrataLabel${devicePx}`;
  if (!installed.has(name)) {
    BitmapFont.install({
      name,
      style: { fontFamily: fog.font.ui, fontSize: devicePx / dpr, fill: palette.paper },
      chars: LABEL_CHARS,
      resolution: dpr,
      textureStyle: { scaleMode: 'nearest' },
    });
    installed.add(name);
  }
  return name;
}
