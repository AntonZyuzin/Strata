import type { Graph } from '@strata/backend';
import { fog, palette } from '@strata/design-tokens';
import type { CanvasView } from './view';

/** The overview's size, CSS px (06 §10.3). */
export const MINIMAP_W = 200;
export const MINIMAP_H = 150;
/** CSS px between the picture and the overview's edge. */
const INSET = 8;
/** World units around the nodes, so the outermost are not on the edge. */
const MARGIN = 80;

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** How world units fall on the overview: `px = (world - origin) · scale + inset`. */
export interface Fit {
  scale: number;
  x: number;
  y: number;
}

/** The box `b` fitted into w × h, centred, with `inset` px around it. */
export function fitBox(b: Box, w: number, h: number, inset = INSET): Fit {
  const bw = Math.max(1, b.maxX - b.minX);
  const bh = Math.max(1, b.maxY - b.minY);
  const scale = Math.min((w - 2 * inset) / bw, (h - 2 * inset) / bh);
  // The world point at the overview's top-left corner.
  return {
    scale,
    x: (b.minX + b.maxX) / 2 - w / 2 / scale,
    y: (b.minY + b.maxY) / 2 - h / 2 / scale,
  };
}

export function union(a: Box, b: Box): Box {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

const PAPER = palette.paper;
const ACCENT = fog.scene.accent;

/**
 * The minimap (06 §10.3, `O`): the whole network at the canvas's bottom right,
 * the nodes as dots, what the canvas shows as a frame; a click or a drag puts
 * the camera there. A 2D canvas of its own outside the scene, drawn when the
 * camera or the graph changed; the dots stay a picture until the graph or the
 * fit changes. Ghosts are no nodes (05 §8.5) and have no dot.
 */
export class Minimap {
  readonly element: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private dots: HTMLCanvasElement | null = null;
  private dotsKey = '';
  private drawnKey = '';
  private fit: Fit = { scale: 1, x: 0, y: 0 };
  private dragging = false;
  private readonly detach: (() => void)[] = [];

  constructor(
    private readonly view: CanvasView,
    private readonly graph: () => Graph,
    /** CSS px of the canvas one sees: the properties panel covers its right. */
    private readonly seen: () => number,
  ) {
    const el = document.createElement('canvas');
    el.className = 'canvas-minimap';
    el.hidden = true;
    this.element = el;
    this.ctx = el.getContext('2d');
    const on = <K extends keyof HTMLElementEventMap>(
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void,
    ) => {
      el.addEventListener(type, fn as EventListener);
      this.detach.push(() => el.removeEventListener(type, fn as EventListener));
    };
    on('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.setPointerCapture(e.pointerId);
      this.dragging = true;
      this.centreAt(e);
    });
    on('pointermove', (e) => {
      if (this.dragging) this.centreAt(e);
    });
    on('pointerup', () => {
      this.dragging = false;
    });
    on('pointercancel', () => {
      this.dragging = false;
    });
    on('wheel', (e) => e.preventDefault());
    on('contextmenu', (e) => e.preventDefault());
    view.canvas.parentElement?.append(el);
  }

  get open(): boolean {
    return !this.element.hidden;
  }

  set open(on: boolean) {
    this.element.hidden = !on;
    this.drawnKey = '';
    if (on) this.view.invalidate();
  }

  destroy(): void {
    for (const off of this.detach) off();
    this.element.remove();
  }

  /** The world box of what the canvas shows now. */
  private shown(): Box {
    const cam = this.view.camera;
    const a = cam.toWorld(0, 0);
    const b = cam.toWorld(this.seen(), this.view.height);
    return { minX: a.x, minY: a.y, maxX: b.x, maxY: b.y };
  }

  /** Every frame of the canvas: drawn again when something it shows has changed. */
  draw(): void {
    const ctx = this.ctx;
    if (!this.open || !ctx) return;
    const g = this.graph();
    const dpr = window.devicePixelRatio || 1;
    const shown = this.shown();
    let nodes: Box | null = null;
    for (const n of g.nodes.values()) {
      if (n.ghostOf) continue;
      const b = { minX: n.x, minY: n.y, maxX: n.x, maxY: n.y };
      nodes = nodes ? union(nodes, b) : b;
    }
    const around = nodes
      ? {
          minX: nodes.minX - MARGIN,
          minY: nodes.minY - MARGIN,
          maxX: nodes.maxX + MARGIN,
          maxY: nodes.maxY + MARGIN,
        }
      : shown;
    const fit = fitBox(union(around, shown), MINIMAP_W, MINIMAP_H);
    const fitKey = `${fit.scale.toFixed(6)}:${fit.x.toFixed(2)}:${fit.y.toFixed(2)}`;
    const dotsKey = `${g.version}:${g.nodes.size}:${dpr}:${fitKey}`;
    const key = `${dotsKey}:${shown.minX.toFixed(2)}:${shown.minY.toFixed(2)}:${shown.maxX.toFixed(2)}:${shown.maxY.toFixed(2)}`;
    if (key === this.drawnKey) return;
    this.drawnKey = key;
    this.fit = fit;
    const el = this.element;
    const w = Math.round(MINIMAP_W * dpr);
    const h = Math.round(MINIMAP_H * dpr);
    if (el.width !== w || el.height !== h) {
      el.width = w;
      el.height = h;
    }
    if (dotsKey !== this.dotsKey || !this.dots) {
      this.dotsKey = dotsKey;
      this.dots = this.paintDots(g, fit, dpr, w, h);
    }
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(this.dots, 0, 0);
    // What the canvas shows: a frame one device pixel inside its edge.
    const px = (v: number, o: number) => (v - o) * fit.scale * dpr;
    const x0 = Math.round(px(shown.minX, fit.x)) + 0.5;
    const y0 = Math.round(px(shown.minY, fit.y)) + 0.5;
    const x1 = Math.round(px(shown.maxX, fit.x)) - 0.5;
    const y1 = Math.round(px(shown.maxY, fit.y)) - 0.5;
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = Math.max(1, Math.round(dpr));
    ctx.strokeRect(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0));
  }

  private paintDots(g: Graph, fit: Fit, dpr: number, w: number, h: number): HTMLCanvasElement {
    const layer = document.createElement('canvas');
    layer.width = w;
    layer.height = h;
    const c = layer.getContext('2d');
    if (!c) return layer;
    // A dot is 3 px, a whole number of device pixels at every DPR.
    const size = Math.max(3, Math.round(3 * dpr));
    c.fillStyle = PAPER;
    c.globalAlpha = 0.8;
    for (const n of g.nodes.values()) {
      if (n.ghostOf) continue;
      const x = Math.round((n.x - fit.x) * fit.scale * dpr - size / 2);
      const y = Math.round((n.y - fit.y) * fit.scale * dpr - size / 2);
      c.fillRect(x, y, size, size);
    }
    return layer;
  }

  /** The camera centred on the world point under the pointer. */
  private centreAt(e: PointerEvent): void {
    const r = this.element.getBoundingClientRect();
    const fit = this.fit;
    const wx = (e.clientX - r.left) / fit.scale + fit.x;
    const wy = (e.clientY - r.top) / fit.scale + fit.y;
    const cam = this.view.camera;
    this.view.stopFlight();
    cam.x = wx - this.seen() / 2 / cam.zoom;
    cam.y = wy - this.view.height / 2 / cam.zoom;
    this.view.invalidate();
  }
}
