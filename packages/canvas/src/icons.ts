import { CanvasSource, Rectangle, Texture } from 'pixi.js';

/**
 * Icon presets of 07 §6.3: 200 game-icons (CC BY 3.0, authors in the JSON, see
 * scripts/game-icons.mjs) rasterised once into one atlas of masks. The figure
 * is drawn white, so a sprite tint makes it ink on paper — the inversion of
 * the original white-on-black that the credits mention. Masks are 128 px with
 * mip levels, so small bubbles sample a clean smaller copy (07 §6.7).
 */

export interface IconAuthor {
  name: string;
  url: string | null;
  license: string;
}

export interface IconCredits {
  source: string;
  commit: string;
  site: string;
  changes: string;
  authors: Record<string, IconAuthor>;
  icons: { id: string }[];
}

interface IconData extends IconCredits {
  icons: { id: string; d: string }[];
}

const MASK = 128;
const PAD = 8;
const CELL = MASK + 2 * PAD;
const COLS = 16;

let data: Promise<IconData> | null = null;

/** The presets with their path data; a separate chunk, loaded on first use. */
export function loadIconData(): Promise<IconData> {
  data ??= import('./assets/game-icons.json').then((m) => m.default as IconData);
  return data;
}

/** Attribution of the presets for the «Благодарности» screen (07 §6.3). */
export async function iconCredits(): Promise<IconCredits> {
  const d = await loadIconData();
  return { ...d, icons: d.icons.map(({ id }) => ({ id })) };
}

export interface IconAtlas {
  textures: Texture[];
  ids: string[];
  destroy(): void;
}

export async function createIconAtlas(): Promise<IconAtlas> {
  const { icons } = await loadIconData();
  const rows = Math.ceil(icons.length / COLS);
  const canvas = document.createElement('canvas');
  canvas.width = COLS * CELL;
  canvas.height = rows * CELL;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas is not available');
  ctx.fillStyle = '#ffffff';
  icons.forEach((icon, k) => {
    const x = (k % COLS) * CELL + PAD;
    const y = Math.floor(k / COLS) * CELL + PAD;
    ctx.setTransform(MASK / 512, 0, 0, MASK / 512, x, y);
    ctx.fill(new Path2D(icon.d));
  });
  const source = new CanvasSource({
    resource: canvas,
    autoGenerateMipmaps: true,
    scaleMode: 'linear',
  });
  const textures = icons.map(
    (_, k) =>
      new Texture({
        source,
        frame: new Rectangle((k % COLS) * CELL, Math.floor(k / COLS) * CELL, CELL, CELL),
      }),
  );
  return {
    textures,
    ids: icons.map((i) => i.id),
    destroy() {
      for (const t of textures) t.destroy();
      source.destroy();
    },
  };
}

/** Scale of an icon sprite for a bubble of diameter `d`: the mask fills 0.55 · d (07 §4.3). */
export function iconScale(d: number): number {
  return (0.55 * d) / MASK;
}
