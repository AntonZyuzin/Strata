import type { Graph, GraphNode } from '@strata/backend';
import { fog } from '@strata/design-tokens';
import { Application, BitmapText, Container, Graphics, Sprite } from 'pixi.js';
// The CSP has no 'unsafe-eval' (11 §8.7), so Pixi needs its eval-free uniform sync.
import 'pixi.js/unsafe-eval';
import { Camera } from './camera';
import {
  createTextures,
  ICON_SCALE,
  installLabelFont,
  LABEL_FONT,
  type SceneTextures,
  SIZE,
} from './textures';
import { WireLayer, type WireStyle } from './wires';

/** Labels once an M bubble is at least 32 px across (07 §4.9). */
const LABEL_ZOOM = 0.67;
/** Structure animations: insert, shifts, autoplace, undo (06 §1.4). */
export const STRUCTURE_MS = 200;

interface NodeView {
  bubble: Sprite;
  icon: Sprite;
  ring: Sprite | null;
  label: BitmapText;
  /** Rendered position: equals the graph's, except while animating or dragging. */
  x: number;
  y: number;
  r: number;
}

interface Tween {
  id: string;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  start: number;
}

/** Radius of a bubble: networks M, other kinds S, key nodes one step up (06 §4.2). */
export function radiusOf(node: GraphNode): number {
  const base = node.kind === 'network' ? 'm' : 's';
  const d = node.key ? (base === 'm' ? SIZE.l : SIZE.m) : SIZE[base];
  return d / 2;
}

/**
 * The Pixi scene of one network (15 §4): the world and its layers are render
 * groups, the camera is their transform (15 §4.1 rule 6a). Rendering is on
 * demand: `invalidate()` asks for one frame, idle costs nothing (NFR-04).
 * Pixi's own event system is off: input goes through the editor's hit test
 * (15 §4.1 rule 5).
 */
export class CanvasView {
  readonly camera = new Camera();
  readonly overlay = new Graphics();
  private readonly world = new Container({ isRenderGroup: true });
  private readonly wires = new WireLayer();
  private readonly layer = {
    bubbles: new Container({ isRenderGroup: true }),
    icons: new Container({ isRenderGroup: true }),
    rings: new Container({ isRenderGroup: true }),
    labels: new Container({ isRenderGroup: true }),
  };
  private readonly views = new Map<string, NodeView>();
  private wireList: [string, string][] = [];
  private tweens: Tween[] = [];
  private scheduled = false;
  private graph: Graph | null = null;
  /** Called every frame before rendering; the editor draws its overlay here. */
  onFrame: ((now: number) => void) | null = null;
  /** Style of a wire, asked every frame; the editor highlights active wires. */
  wireStyle: (from: string, to: string) => WireStyle = () => NORMAL_WIRE;
  reducedMotion = false;

  private constructor(
    private readonly app: Application,
    private readonly textures: SceneTextures,
  ) {
    this.world.addChild(
      this.wires.mesh,
      this.layer.bubbles,
      this.layer.icons,
      this.layer.rings,
      this.layer.labels,
    );
    app.stage.addChild(this.world, this.overlay);
  }

  static async create(host: HTMLElement): Promise<CanvasView> {
    const app = new Application();
    await app.init({
      resizeTo: host,
      background: fog.scene.bg,
      antialias: true,
      autoDensity: true,
      resolution: window.devicePixelRatio,
      preference: 'webgl',
      autoStart: false,
      sharedTicker: false,
      eventMode: 'none',
      eventFeatures: { move: false, globalMove: false, click: false, wheel: false },
    });
    host.replaceChildren(app.canvas);
    app.canvas.style.display = 'block';
    installLabelFont();
    const view = new CanvasView(app, createTextures(app));
    new ResizeObserver(() => {
      app.resize();
      view.invalidate();
    }).observe(host);
    return view;
  }

  get canvas(): HTMLCanvasElement {
    return this.app.canvas;
  }

  get width(): number {
    return this.app.screen.width;
  }

  get height(): number {
    return this.app.screen.height;
  }

  /** Shows `graph` and follows its changes. */
  setGraph(graph: Graph): () => void {
    this.graph = graph;
    this.sync();
    return graph.subscribe(() => this.sync());
  }

  /** Rendered position and radius of a node. */
  nodeAt(id: string): { x: number; y: number; r: number } | null {
    const v = this.views.get(id);
    return v ? { x: v.x, y: v.y, r: v.r } : null;
  }

  *eachNode(): Generator<[string, { x: number; y: number; r: number }]> {
    for (const [id, v] of this.views) yield [id, v];
  }

  /** Moves a node's rendering without touching the graph (a drag in progress). */
  place(id: string, x: number, y: number): void {
    const v = this.views.get(id);
    if (!v) return;
    this.tweens = this.tweens.filter((t) => t.id !== id);
    this.setPosition(v, x, y);
    this.invalidate();
  }

  /** Animates nodes from where they are drawn to where the graph has them (06 §1.4). */
  settle(ids: Iterable<string>): void {
    const now = performance.now();
    for (const id of ids) {
      const v = this.views.get(id);
      const node = this.graph?.nodes.get(id);
      if (!v || !node || (v.x === node.x && v.y === node.y)) continue;
      this.tweens = this.tweens.filter((t) => t.id !== id);
      if (this.reducedMotion) this.setPosition(v, node.x, node.y);
      else this.tweens.push({ id, fromX: v.x, fromY: v.y, toX: node.x, toY: node.y, start: now });
    }
    this.invalidate();
  }

  invalidate(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    requestAnimationFrame((now) => this.frame(now));
  }

  destroy(): void {
    this.wires.destroy();
    this.textures.destroy();
    this.app.destroy({ removeView: true }, { children: true, texture: true, textureSource: true });
  }

  private frame(now: number) {
    this.scheduled = false;
    let moving = false;
    if (this.tweens.length > 0) {
      this.tweens = this.tweens.filter((t) => {
        const v = this.views.get(t.id);
        if (!v) return false;
        const k = Math.min(1, (now - t.start) / STRUCTURE_MS);
        const e = easeOut(k);
        this.setPosition(v, t.fromX + (t.toX - t.fromX) * e, t.fromY + (t.toY - t.fromY) * e);
        return k < 1;
      });
      moving = this.tweens.length > 0;
    }
    const cam = this.camera;
    this.world.scale.set(cam.zoom);
    this.world.position.set(-cam.x * cam.zoom, -cam.y * cam.zoom);
    this.wires.setZoom(cam.zoom);
    this.wires.setTime(now / 1000);
    this.layer.labels.visible = cam.zoom >= LABEL_ZOOM;
    this.writeWires();
    this.overlay.clear();
    this.onFrame?.(now);
    this.app.render();
    if (moving) this.invalidate();
  }

  private writeWires() {
    const list = this.wireList;
    this.wires.setCount(list.length);
    for (let i = 0; i < list.length; i++) {
      const [from, to] = list[i] as [string, string];
      const a = this.views.get(from);
      const b = this.views.get(to);
      if (!a || !b) continue;
      this.wires.set(i, { ax: a.x, ay: a.y, bx: b.x, by: b.y, ra: a.r + 1, rb: b.r + 1 });
      this.wires.setStyle(i, this.wireStyle(from, to));
    }
    this.wires.upload();
  }

  private setPosition(v: NodeView, x: number, y: number) {
    v.x = x;
    v.y = y;
    v.bubble.position.set(x, y);
    v.icon.position.set(x, y);
    v.ring?.position.set(x, y);
    v.label.position.set(x, y + v.r + 4);
  }

  /** Creates, updates and removes sprites to match the graph. */
  private sync() {
    const graph = this.graph;
    if (!graph) return;
    for (const [id, v] of this.views) {
      if (!graph.nodes.has(id)) {
        v.bubble.destroy();
        v.icon.destroy();
        v.ring?.destroy();
        v.label.destroy();
        this.views.delete(id);
      }
    }
    const moved: string[] = [];
    for (const node of graph.nodes.values()) {
      const v = this.views.get(node.id);
      if (!v) {
        this.views.set(node.id, this.createView(node));
        continue;
      }
      if (v.label.text !== node.name) v.label.text = node.name;
      if (v.x !== node.x || v.y !== node.y) moved.push(node.id);
    }
    this.wireList = graph.edges();
    this.settle(moved);
    this.invalidate();
  }

  private createView(node: GraphNode): NodeView {
    const r = radiusOf(node);
    const t = this.textures;
    const bubble = new Sprite({ texture: t.bubble, anchor: 0.5 });
    bubble.scale.set((2 * r) / SIZE.l);
    const icon = new Sprite({
      texture: t.icons[node.icon % t.icons.length] ?? t.bubble,
      anchor: 0.5,
    });
    icon.scale.set(2 * r * ICON_SCALE);
    const ring = node.deadline
      ? new Sprite({ texture: t.ring, anchor: 0.5, tint: fog.scene.attention })
      : null;
    ring?.scale.set((2 * r) / SIZE.l);
    const label = new BitmapText({
      text: node.name,
      style: { fontFamily: LABEL_FONT, fontSize: 11 },
    });
    label.anchor.set(0.5, 0);
    this.layer.bubbles.addChild(bubble);
    this.layer.icons.addChild(icon);
    if (ring) this.layer.rings.addChild(ring);
    this.layer.labels.addChild(label);
    const v: NodeView = { bubble, icon, ring, label, x: 0, y: 0, r };
    this.setPosition(v, node.x, node.y);
    return v;
  }
}

export const NORMAL_WIRE: WireStyle = { color: 0xf2efe6, alpha: 0.6, width: 1.5, dot: false };

/** cubic-bezier(.2,.8,.2,1) of 06 §1.4, close enough as an ease-out cubic. */
function easeOut(k: number): number {
  return 1 - (1 - k) ** 3;
}
