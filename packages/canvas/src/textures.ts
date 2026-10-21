import { fog } from '@strata/design-tokens';
import { type Application, BitmapFont, Graphics, Rectangle, Texture } from 'pixi.js';

/** Bubble diameters S, M, L in world units (06 §4.2). */
export const SIZE = { s: 32, m: 48, l: 72 } as const;
export const ICONS = 200;
const ICON_CELL = 32;
export const LABEL_FONT = 'StrataLabel';

let fontInstalled = false;

/**
 * Bitmap font for labels from the system monospace, with Cyrillic. MSDF and
 * the OFL pixel fonts come with spike 9 (07 §3.4); this is the bench's font.
 */
export function installLabelFont(): void {
  if (fontInstalled) return;
  BitmapFont.install({
    name: LABEL_FONT,
    style: { fontFamily: fog.font.ui, fontSize: 24, fill: fog.scene.paper },
    chars: [['a', 'z'], ['A', 'Z'], ['0', '9'], ['а', 'я'], ['А', 'Я'], ' ёЁ.,:;-—«»№!?()/+#&'],
    resolution: 2,
  });
  fontInstalled = true;
}

function texture(app: Application, g: Graphics, frame?: Rectangle): Texture {
  const tex = app.renderer.generateTexture({
    target: g,
    resolution: 2,
    antialias: true,
    ...(frame ? { frame } : {}),
  });
  g.destroy();
  return tex;
}

export interface SceneTextures {
  bubble: Texture;
  ring: Texture;
  icons: Texture[];
  destroy(): void;
}

/** Bubble body (07 §4.1: paper with an ink rim), deadline ring and the icon atlas. */
export function createTextures(app: Application): SceneTextures {
  const bubble = texture(
    app,
    new Graphics()
      .circle(0, 0, SIZE.l / 2)
      .fill(fog.scene.paper)
      .circle(0, 0, SIZE.l / 2 - 1.5)
      .stroke({ color: fog.scene.ink, width: 1.5, alpha: 0.25 }),
  );
  const ring = texture(
    app,
    new Graphics().circle(0, 0, SIZE.l / 2 + 6).stroke({ color: 0xffffff, width: 3 }),
  );
  const icons = iconAtlas(app);
  return {
    bubble,
    ring,
    icons,
    destroy() {
      for (const t of icons) t.destroy();
      bubble.destroy(true);
      ring.destroy(true);
    },
  };
}

function rng(seed: number): () => number {
  let x = seed | 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 4294967296;
  };
}

/**
 * 200 procedural 1-bit glyphs in one atlas, standing in for the game-icons
 * of spike 9; one texture keeps all bubbles in a few batches.
 */
function iconAtlas(app: Application): Texture[] {
  const perRow = 20;
  const rows = Math.ceil(ICONS / perRow);
  const g = new Graphics();
  const px = 3;
  for (let k = 0; k < ICONS; k++) {
    const r = rng(1000 + k);
    const ox = (k % perRow) * ICON_CELL + 1;
    const oy = Math.floor(k / perRow) * ICON_CELL + 1;
    for (let y = 0; y < 10; y++) {
      for (let x = 0; x < 5; x++) {
        if (r() > 0.5) {
          g.rect(ox + x * px, oy + y * px, px, px).rect(ox + (9 - x) * px, oy + y * px, px, px);
        }
      }
    }
  }
  g.fill(fog.scene.ink);
  const atlas = texture(app, g, new Rectangle(0, 0, perRow * ICON_CELL, rows * ICON_CELL));
  return Array.from(
    { length: ICONS },
    (_, k) =>
      new Texture({
        source: atlas.source,
        frame: new Rectangle(
          (k % perRow) * ICON_CELL,
          Math.floor(k / perRow) * ICON_CELL,
          ICON_CELL,
          ICON_CELL,
        ),
      }),
  );
}

export const ICON_SCALE = 0.55 / ICON_CELL; // icon is 0.55 · d (07 §4.1)
