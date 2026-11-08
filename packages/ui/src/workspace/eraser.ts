/** The brush's radius, a share of the picture's long side (07 §6.4). */
const BRUSH = 0.06;
/** Strokes kept for undo: each keeps the picture's marks as they were before it. */
const DEPTH = 32;

/**
 * The eraser of «Своя иконка» (07 §6.4): the pixels its strokes took, 1
 * each, over a picture `width × height`; a stroke at a time, with undo and
 * redo. The picture itself is not touched: «привести к стилю» takes the
 * marks as background, and «Готово» bakes them into a copy.
 */
export class EraserStrokes {
  readonly erased: Uint8Array;
  private readonly undone: Uint8Array[] = [];
  private readonly redone: Uint8Array[] = [];
  private last: { x: number; y: number } | null = null;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.erased = new Uint8Array(width * height);
  }

  /** The brush's radius in the picture's pixels. */
  get radius(): number {
    return Math.max(2, Math.round(BRUSH * Math.max(this.width, this.height)));
  }

  /** Something is rubbed out. */
  get any(): boolean {
    return this.erased.includes(1);
  }

  get canUndo(): boolean {
    return this.undone.length > 0;
  }

  get canRedo(): boolean {
    return this.redone.length > 0;
  }

  /** A stroke starts at a point of the picture: one step of undo. */
  begin(x: number, y: number): void {
    this.undone.push(this.erased.slice());
    if (this.undone.length > DEPTH) this.undone.shift();
    this.redone.length = 0;
    this.last = { x, y };
    this.dab(x, y);
  }

  /** The stroke goes on to a point: the brush along the way, no gaps. */
  move(x: number, y: number): void {
    const from = this.last;
    if (!from) return;
    const d = Math.hypot(x - from.x, y - from.y);
    const step = Math.max(1, this.radius / 3);
    for (let s = step; s < d; s += step) {
      this.dab(from.x + ((x - from.x) * s) / d, from.y + ((y - from.y) * s) / d);
    }
    this.dab(x, y);
    this.last = { x, y };
  }

  end(): void {
    this.last = null;
  }

  /** The last stroke back; false — none. */
  undo(): boolean {
    const before = this.undone.pop();
    if (!before) return false;
    this.redone.push(this.erased.slice());
    this.erased.set(before);
    return true;
  }

  /** The stroke undone last, again; false — none. */
  redo(): boolean {
    const after = this.redone.pop();
    if (!after) return false;
    this.undone.push(this.erased.slice());
    this.erased.set(after);
    return true;
  }

  private dab(cx: number, cy: number): void {
    const r = this.radius;
    const x0 = Math.max(0, Math.floor(cx - r));
    const x1 = Math.min(this.width - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const y1 = Math.min(this.height - 1, Math.ceil(cy + r));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r) this.erased[y * this.width + x] = 1;
      }
    }
  }
}
