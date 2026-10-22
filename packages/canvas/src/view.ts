import type { Graph, GraphNode } from '@strata/backend';
import { fog, hex, palette, pixelMetrics, pixelUnit } from '@strata/design-tokens';
import { Application, Container, Graphics, Sprite } from 'pixi.js';
// The CSP has no 'unsafe-eval' (11 §8.7), so Pixi needs its eval-free uniform sync.
import 'pixi.js/unsafe-eval';
import type { Pixels } from './backdrop';
import { BackgroundLayer } from './background';
import { Camera } from './camera';
import { Decor, type DecorNode, type Interaction } from './decor';
import { createIconAtlas, type IconAtlas, iconScale } from './icons';
import { defaultIcon, dotColor, isClosed, levelOf, nodeAlpha, type WireEndStyle } from './looks';
import { BODY_DIAMETER, createBodyTextures, SIZE } from './textures';
import { WireLayer, type WireStyle } from './wires';

/** Structure animations: insert, shifts, autoplace, undo (06 §1.4). */
export const STRUCTURE_MS = 200;

interface NodeView extends DecorNode {
  body: Sprite;
  icon: Sprite;
  halo: Sprite | null;
  inputs: NodeView[];
  outputs: NodeView[];
}

interface Tween {
  id: string;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  start: number;
}

/** Radius of a bubble: networks M, other kinds S, key nodes one step up (07 §4.2). */
export function radiusOf(node: Pick<GraphNode, 'kind' | 'key'>): number {
  const base = node.kind === 'network' ? 'm' : 's';
  const d = node.key ? (base === 'm' ? SIZE.l : SIZE.m) : SIZE[base];
  return d / 2;
}

const PAPER = hex(palette.paper);
const INK = hex(palette.ink850);

/** Device size of the `ui` font as the Chrome has it: one source for both layers. */
function uiFontPx(dpr: number): number {
  const css = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--st-font-ui-size'),
  );
  return Number.isFinite(css) && css > 0
    ? Math.round(css * dpr)
    : pixelMetrics(dpr).font.ui.physical;
}

/**
 * The Pixi scene of one network (15 §4): the world and its layers are render
 * groups, the camera is their transform (15 §4.1 rule 6a). Rendering is on
 * demand: `invalidate()` asks for one frame, idle costs nothing (NFR-04).
 * Pixi's own event system is off: input goes through the editor's hit test
 * (15 §4.1 rule 5). Above the world, the screen-space Decor draws rims,
 * rings, glyphs and labels in pixel units (07 §4).
 */
export class CanvasView {
  readonly camera = new Camera();
  readonly overlay = new Graphics();
  /** Screen-space layer under the world: the background of 07 §7. */
  readonly background = new BackgroundLayer();
  private readonly world = new Container({ isRenderGroup: true });
  private readonly wires = new WireLayer();
  private readonly layer = {
    halos: new Container({ isRenderGroup: true }),
    bodies: new Container({ isRenderGroup: true }),
    icons: new Container({ isRenderGroup: true }),
  };
  private readonly decor: Decor;
  private readonly views = new Map<string, NodeView>();
  private wireList: [string, string][] = [];
  private tweens: Tween[] = [];
  private scheduled = false;
  private graph: Graph | null = null;
  private lastZoom = Number.NaN;
  /** Called every frame before rendering; the editor draws its overlay here. */
  onFrame: ((now: number) => void) | null = null;
  /** Style of a wire, asked every frame; the editor highlights active wires. */
  wireStyle: (from: string, to: string) => WireStyle = () => NORMAL_WIRE;
  /** Hover and selection, asked every frame; set by the editor. */
  interaction: () => Interaction = () => ({ hover: null, selection: new Set(), current: null });
  private motionReduced = false;

  private constructor(
    private readonly app: Application,
    private readonly textures: ReturnType<typeof createBodyTextures>,
    private readonly icons: IconAtlas,
  ) {
    const dpr = app.renderer.resolution;
    this.decor = new Decor(pixelUnit(dpr), dpr, uiFontPx(dpr));
    this.world.addChild(this.wires.mesh, this.layer.halos, this.layer.bodies, this.layer.icons);
    app.stage.addChild(this.background.container, this.world, this.decor.container, this.overlay);
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
    // Labels are Departure Mono rasterised at their device size (07 §3.4).
    await document.fonts.load(`11px ${fog.font.ui}`, 'AaЖж');
    const view = new CanvasView(app, createBodyTextures(), await createIconAtlas());
    new ResizeObserver(() => {
      app.resize();
      view.invalidate();
    }).observe(host);
    return view;
  }

  get canvas(): HTMLCanvasElement {
    return this.app.canvas;
  }

  get renderer(): Application['renderer'] {
    return this.app.renderer;
  }

  get width(): number {
    return this.app.screen.width;
  }

  get height(): number {
    return this.app.screen.height;
  }

  /** How the ends of wires look (07 §5, Q-07-20). */
  get wireEnds(): WireEndStyle {
    return this.decor.ends;
  }

  set wireEnds(style: WireEndStyle) {
    this.decor.ends = style;
    this.invalidate();
  }

  get reducedMotion(): boolean {
    return this.motionReduced;
  }

  set reducedMotion(on: boolean) {
    this.motionReduced = on;
    this.decor.reducedMotion = on;
    this.background.reducedMotion = on;
  }

  /** Shows a processed background picture (07 §7) and redraws; returns its p95 luminance. */
  setBackground(px: Pixels): number {
    const p95 = this.background.setPicture(px);
    this.invalidate();
    return p95;
  }

  /** Shows `graph` and follows its changes. */
  setGraph(graph: Graph): () => void {
    this.graph = graph;
    this.sync();
    return graph.subscribe(() => this.sync());
  }

  /** Atlas index of the default icon of a new node (07 §6.3, Q-07-21). */
  iconFor(kind: GraphNode['kind'], cls: GraphNode['cls']): number {
    return Math.max(0, this.icons.ids.indexOf(defaultIcon(kind, cls)));
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
    this.decor.destroy();
    this.background.destroy();
    this.textures.destroy();
    this.icons.destroy();
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
    if (cam.zoom !== this.lastZoom) {
      this.lastZoom = cam.zoom;
      for (const v of this.views.values()) this.applyLevel(v);
    }
    this.background.follow(cam, this.width, this.height);
    this.wires.setZoom(cam.zoom);
    this.wires.setTime(now / 1000);
    this.writeWires();
    this.overlay.clear();
    this.onFrame?.(now);
    const animating = this.decor.draw(
      this.views.values(),
      cam,
      this.width,
      this.height,
      this.interaction(),
      now,
    );
    this.app.render();
    if (moving || animating) this.invalidate();
  }

  private writeWires() {
    const list = this.wireList;
    // Far zoom: wires become texture, 1 px at 40 % (07 §4.9), unless highlighted.
    const far = SIZE.m * this.camera.zoom < 12;
    this.wires.setCount(list.length);
    for (let i = 0; i < list.length; i++) {
      const [from, to] = list[i] as [string, string];
      const a = this.views.get(from);
      const b = this.views.get(to);
      if (!a || !b) continue;
      // Both ends run into their sockets on the rim (07 §5); same as editor.wireEnds.
      this.wires.set(i, { ax: a.x, ay: a.y, bx: b.x, by: b.y, ra: a.r, rb: b.r });
      const style = this.wireStyle(from, to);
      this.wires.setStyle(i, far && style === NORMAL_WIRE ? FAR_WIRE : style);
    }
    this.wires.upload();
  }

  private setPosition(v: NodeView, x: number, y: number) {
    v.x = x;
    v.y = y;
    v.body.position.set(x, y);
    v.icon.position.set(x, y);
    v.halo?.position.set(x, y);
  }

  /**
   * Body, icon and halo for the zoom level (07 §4.9) and the node's states
   * (07 §4.5): dots below 12 px, kind glyphs (drawn by Decor) to 32 px, icons above.
   */
  private applyLevel(v: NodeView) {
    const n = v.node;
    const lv = levelOf(2 * v.r * this.camera.zoom);
    const a = nodeAlpha(n);
    const closed = isClosed(n);
    v.body.visible = !n.ghost || lv === 'dot';
    v.body.tint = lv === 'dot' ? dotColor(n) : closed ? hex(fog.scene.doneFill) : PAPER;
    v.body.alpha = lv === 'dot' ? Math.max(a, 0.6) : a;
    v.icon.visible = lv !== 'dot' && lv !== 'glyph' && !n.ghost;
    v.icon.tint = closed ? hex(fog.scene.doneInk) : INK;
    v.icon.alpha = a;
    if (v.halo) v.halo.visible = lv !== 'dot';
  }

  /** Creates, updates and removes sprites to match the graph. */
  private sync() {
    const graph = this.graph;
    if (!graph) return;
    for (const [id, v] of this.views) {
      if (!graph.nodes.has(id)) {
        v.body.destroy();
        v.icon.destroy();
        v.halo?.destroy();
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
      if (v.node !== node) {
        v.node = node;
        this.applyLevel(v);
      }
      if (v.x !== node.x || v.y !== node.y) moved.push(node.id);
    }
    this.wireList = graph.edges();
    for (const v of this.views.values()) {
      v.inputs.length = 0;
      v.outputs.length = 0;
    }
    for (const [from, to] of this.wireList) {
      const a = this.views.get(from);
      const b = this.views.get(to);
      if (!a || !b) continue;
      a.outputs.push(b);
      b.inputs.push(a);
    }
    this.settle(moved);
    this.invalidate();
  }

  private createView(node: GraphNode): NodeView {
    const r = radiusOf(node);
    const t = this.textures;
    const body = new Sprite({ texture: t.body, anchor: 0.5 });
    body.scale.set((2 * r) / BODY_DIAMETER);
    const icon = new Sprite({
      texture: this.icons.textures[node.icon % this.icons.textures.length] ?? t.body,
      anchor: 0.5,
    });
    icon.scale.set(iconScale(2 * r));
    // «Срок скоро»: a static yellow halo up to 1.5 r (07 §4.5), not on paused or closed nodes.
    const soon = node.due === 'soon' && !node.pause && !isClosed(node);
    const halo = soon
      ? new Sprite({
          texture: t.halo,
          anchor: 0.5,
          tint: hex(fog.scene.attention),
          alpha: fog.scene.haloAlpha,
        })
      : null;
    halo?.scale.set((3 * r) / t.halo.width);
    this.layer.bodies.addChild(body);
    this.layer.icons.addChild(icon);
    if (halo) this.layer.halos.addChild(halo);
    const v: NodeView = {
      id: node.id,
      node,
      body,
      icon,
      halo,
      inputs: [],
      outputs: [],
      x: 0,
      y: 0,
      r,
    };
    this.setPosition(v, node.x, node.y);
    this.applyLevel(v);
    return v;
  }
}

export const NORMAL_WIRE: WireStyle = {
  color: PAPER,
  alpha: fog.scene.edgeAlpha,
  width: fog.scene.edgeWidth,
  dot: false,
};
const FAR_WIRE: WireStyle = {
  color: PAPER,
  alpha: fog.scene.edgeAlphaFar,
  width: fog.scene.edgeWidthFar,
  dot: false,
};

/** cubic-bezier(.2,.8,.2,1) of 06 §1.4, close enough as an ease-out cubic. */
function easeOut(k: number): number {
  return 1 - (1 - k) ** 3;
}
