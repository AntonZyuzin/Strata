/**
 * Camera of the 2D canvas (06 §3): world units equal CSS px at 100 %, zoom
 * 5–800 %, zoom to the cursor keeps the world point under it fixed.
 */
export const ZOOM_MIN = 0.05;
export const ZOOM_MAX = 8;
/**
 * Framing never magnifies past this: a network of one or two nodes shows them
 * at a readable size, not filling the screen.
 */
export const FIT_ZOOM_MAX = 1.5;

export class Camera {
  /** World point at the screen's top-left corner. */
  x = 0;
  y = 0;
  zoom = 1;

  toScreen(wx: number, wy: number): { x: number; y: number } {
    return { x: (wx - this.x) * this.zoom, y: (wy - this.y) * this.zoom };
  }

  toWorld(sx: number, sy: number): { x: number; y: number } {
    return { x: sx / this.zoom + this.x, y: sy / this.zoom + this.y };
  }

  panBy(dxScreen: number, dyScreen: number): void {
    this.x -= dxScreen / this.zoom;
    this.y -= dyScreen / this.zoom;
  }

  /** Multiplies the zoom by `factor`, keeping the world point under (sx, sy) in place. */
  zoomAt(sx: number, sy: number, factor: number): void {
    const before = this.toWorld(sx, sy);
    this.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, this.zoom * factor));
    this.x = before.x - sx / this.zoom;
    this.y = before.y - sy / this.zoom;
  }

  /** Frames a world box in a screen of w × h with a 10 % margin (`H`, `G`, 06 §3). */
  fit(box: { minX: number; minY: number; maxX: number; maxY: number }, w: number, h: number): void {
    const bw = Math.max(box.maxX - box.minX, 1);
    const bh = Math.max(box.maxY - box.minY, 1);
    this.zoom = Math.min(FIT_ZOOM_MAX, Math.max(ZOOM_MIN, Math.min(w / bw, h / bh) * 0.9));
    this.x = (box.minX + box.maxX) / 2 - w / 2 / this.zoom;
    this.y = (box.minY + box.maxY) / 2 - h / 2 / this.zoom;
  }
}
