import { convertToExcalidrawElements, FONT_FAMILY } from '@excalidraw/excalidraw';
import type { FileId } from '@excalidraw/excalidraw/element/types';
import { palette } from '@strata/design-tokens';
import type { BoardElement, BoardFile } from './binding';

/**
 * B-2k (14 §1.3): a board of `elements` elements, `images` of them images
 * with their own files, on a grid of cells 200 units wide. Shapes, text and
 * arrows in turn, in the strict look; each image is its own JPEG, so none is
 * shared from Excalidraw's cache. Excalidraw's own skeleton API builds the
 * elements: versions, seeds and fractional indices as a real board has them.
 * The widgets of B-2k come with the widgets (spike 5, part 2).
 */
export interface SynthBoard {
  elements: BoardElement[];
  files: BoardFile[];
  /** Scene size, units. */
  width: number;
  height: number;
}

export const CELL = 200;

function jpeg(k: number): string {
  const c = document.createElement('canvas');
  c.width = 320;
  c.height = 240;
  const g = c.getContext('2d');
  if (!g) throw new Error('no 2D canvas');
  g.fillStyle = `hsl(${(k * 47) % 360} 45% 40%)`;
  g.fillRect(0, 0, 320, 240);
  g.fillStyle = `hsl(${(k * 47 + 180) % 360} 50% 70%)`;
  for (let i = 0; i < 12; i++) {
    g.beginPath();
    g.arc(((k * 31 + i * 53) % 300) + 10, ((k * 17 + i * 37) % 220) + 10, 8 + ((k + i) % 24), 0, 7);
    g.fill();
  }
  g.fillStyle = '#fff';
  g.font = '40px sans-serif';
  g.fillText(String(k), 16, 56);
  return c.toDataURL('image/jpeg', 0.8);
}

export function synthBoard(opts: { elements: number; images: number }): SynthBoard {
  const cols = Math.ceil(Math.sqrt(opts.elements * 1.25));
  const every = opts.images > 0 ? Math.floor(opts.elements / opts.images) : 0;
  const skeleton: Parameters<typeof convertToExcalidrawElements>[0] = [];
  const files: BoardFile[] = [];
  const stroke = { strokeColor: palette.paper, roughness: 0 };
  for (let i = 0; i < opts.elements; i++) {
    const x = (i % cols) * CELL;
    const y = Math.floor(i / cols) * CELL;
    if (every > 0 && i % every === every - 1 && files.length < opts.images) {
      const id = `b2k-image-${files.length}`;
      files.push({ id, mimeType: 'image/jpeg', dataURL: jpeg(files.length), created: 1 });
      skeleton.push({ type: 'image', x, y, width: 160, height: 120, fileId: id as FileId });
      continue;
    }
    switch (i % 5) {
      case 0:
        skeleton.push({ type: 'rectangle', x, y, width: 150, height: 100, ...stroke });
        break;
      case 1:
        skeleton.push({ type: 'ellipse', x, y, width: 140, height: 110, ...stroke });
        break;
      case 2:
        skeleton.push({ type: 'diamond', x, y, width: 120, height: 120, ...stroke });
        break;
      case 3:
        skeleton.push({
          type: 'text',
          x,
          y: y + 40,
          text: `Идея ${i}`,
          fontSize: 20,
          fontFamily: FONT_FAMILY.Nunito,
          ...stroke,
        });
        break;
      default:
        skeleton.push({ type: 'arrow', x, y: y + 50, width: 160, height: 0, ...stroke });
    }
  }
  const rows = Math.ceil(opts.elements / cols);
  return {
    elements: convertToExcalidrawElements(skeleton) as unknown as BoardElement[],
    files,
    width: cols * CELL,
    height: rows * CELL,
  };
}
