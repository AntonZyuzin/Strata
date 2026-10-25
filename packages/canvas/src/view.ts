import type { Graph, GraphNode } from '@strata/backend';
import { fog, hex, palette, pixelMetrics, pixelUnit } from '@strata/design-tokens';
import { Application, Container, Graphics, Sprite, Texture } from 'pixi.js';
// The CSP has no 'unsafe-eval' (11 §8.7), so Pixi needs its eval-free uniform sync.
import 'pixi.js/unsafe-eval';
import type { Pixels } from './backdrop';
import { BackgroundLayer } from './background';
import { Camera } from './camera';
import { controls } from './curve';
import { Decor, type DecorNode, type Interaction } from './decor';
import { hexPath } from './hex';
import {
  createIconAtlas,
  createPixelIcons,
  type IconAtlas,
  type IconImage,
  iconScale,
  pixelIconScale,
} from './icons';
import { Kinetics } from './kinetic';
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
  const base = node.kind === 'network' || node.kind === 'project' ? 'm' : 's';
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
  /** Kinetic wires' lag and jitter (06 §6.8); the ends selected last frame start the jitter. */
  private readonly kinetics = new Kinetics();
  private kinetic = false;
  private jittered = new Set<string>();
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
  private resizer: ResizeObserver | null = null;
  private destroyed = false;
  private pending = 0;

  private constructor(
    private readonly app: Application,
    private readonly textures: ReturnType<typeof createBodyTextures>,
    private readonly icons: IconAtlas,
  ) {
    const dpr = app.renderer.resolution;
    this.decor = new Decor(pixelUnit(dpr), dpr, uiFontPx(dpr));
    this.wires.setUnit(pixelUnit(dpr) / dpr);
    this.decor.curveOf = (a, b) => this.curveOf(a, b);
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
    view.resizer = new ResizeObserver(() => {
      app.resize();
      view.invalidate();
    });
    view.resizer.observe(host);
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

  /**
   * The scene as a small PNG, `width` px wide: the workspace's card on the
   * home screen (✅ Q-16-12). Null when the renderer cannot read it back.
   */
  async snapshot(width = 320): Promise<Uint8Array | null> {
    try {
      this.app.render();
      const scene = this.app.renderer.extract.canvas({
        target: this.app.stage,
        frame: this.app.screen,
      }) as HTMLCanvasElement;
      const out = document.createElement('canvas');
      out.width = width;
      out.height = Math.round((width * this.height) / Math.max(1, this.width));
      out.getContext('2d')?.drawImage(scene, 0, 0, out.width, out.height);
      const blob = await new Promise<Blob | null>((ok) => out.toBlob(ok, 'image/png'));
      return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
    } catch {
      return null;
    }
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

  /** A near or past deadline in words under the label (Q-07-22); see `Decor.dueWord`. */
  set dueWord(word: (n: GraphNode) => string | null) {
    this.decor.dueWord = word;
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

  private readonly pictures = new Map<string, Texture>();
  private kindIcons = new Map<string, Texture>();
  /** The icon a node shows, a key of `setKindIcons`: its kind by default (07 §6.1). */
  iconKey: (n: GraphNode) => string = (n) => n.kind;

  /**
   * Icons by name (owner, 2026-10-24: the Chrome's SerenityOS
   * set on the nodes too). A node with one shows it instead of its preset, and
   * the kind glyph at six o'clock goes: the icon already says the kind.
   */
  setKindIcons(images: Record<string, IconImage>): void {
    const old = this.kindIcons;
    this.kindIcons = createPixelIcons(images);
    this.decor.kindBadge = this.kindIcons.size === 0;
    for (const v of this.views.values()) {
      this.applyPicture(v);
      this.applyLevel(v);
    }
    old.values().next().value?.source.destroy();
    for (const t of old.values()) t.destroy();
    this.invalidate();
  }

  private kindIcon(n: GraphNode): Texture | undefined {
    return this.kindIcons.get(this.iconKey(n));
  }

  /**
   * A media node's picture inside its body (owner, 2026-10-24): cut to the
   * hexagon (ADR-0011) once into a texture and drawn where the icon goes;
   * null takes it away.
   */
  setPicture(
    id: string,
    image: (CanvasImageSource & { width: number; height: number }) | null,
  ): void {
    this.pictures.get(id)?.destroy(true);
    this.pictures.delete(id);
    if (image && image.width > 0 && image.height > 0) {
      const side = 256;
      const c = document.createElement('canvas');
      c.width = side;
      c.height = side;
      const g = c.getContext('2d');
      if (g) {
        hexPath(g, side / 2, side / 2, side / 2).clip();
        const k = Math.max(side / image.width, side / image.height);
        const w = image.width * k;
        const h = image.height * k;
        g.drawImage(image, (side - w) / 2, (side - h) / 2, w, h);
        this.pictures.set(id, Texture.from(c));
      }
    }
    const v = this.views.get(id);
    if (v) {
      this.applyPicture(v);
      this.applyLevel(v);
    }
    this.invalidate();
  }

  /** Forgets every picture: another network or workspace is shown. */
  clearPictures(): void {
    for (const tex of this.pictures.values()) tex.destroy(true);
    this.pictures.clear();
  }

  /** Whether a node shows a picture. */
  hasPicture(id: string): boolean {
    return this.pictures.has(id);
  }

  /** What a node's circle shows: its picture, its kind's icon or a preset. */
  iconOf(id: string): 'picture' | 'kind' | 'preset' | null {
    const v = this.views.get(id);
    if (!v) return null;
    if (this.pictures.has(id)) return 'picture';
    return this.kindIcon(v.node) ? 'kind' : 'preset';
  }

  private applyPicture(v: NodeView) {
    const pic = this.pictures.get(v.id);
    if (pic) {
      v.icon.texture = pic;
      v.icon.scale.set((2 * v.r) / pic.width);
    } else {
      const own = this.kindIcon(v.node);
      if (own) {
        v.icon.texture = own;
        v.icon.scale.set(pixelIconScale(2 * v.r));
        return;
      }
      v.icon.texture =
        this.icons.textures[v.node.icon % this.icons.textures.length] ?? this.textures.body;
      v.icon.scale.set(iconScale(2 * v.r));
    }
  }

  /** Shows `graph` and follows its changes. */
  setGraph(graph: Graph): () => void {
    this.graph = graph;
    this.sync();
    return graph.subscribe(() => this.sync());
  }

  /** Atlas index of the default icon of a new node (07 §6.3, Q-07-21). */
  iconFor(kind: GraphNode['kind']): number {
    return Math.max(0, this.icons.ids.indexOf(defaultIcon(kind)));
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

  /**
   * Draws a frame now, in this task: the camera bridge reads the canvas right
   * after it (08 §7.1), before the browser presents and clears the buffer.
   */
  renderNow(): void {
    if (!this.destroyed) this.frame(performance.now());
  }

  invalidate(): void {
    if (this.scheduled || this.destroyed) return;
    this.scheduled = true;
    this.pending = requestAnimationFrame((now) => this.frame(now));
  }

  destroy(): void {
    // A frame asked for before destroy must not run on a destroyed scene.
    this.destroyed = true;
    cancelAnimationFrame(this.pending);
    this.resizer?.disconnect();
    this.wires.destroy();
    this.decor.destroy();
    this.background.destroy();
    this.textures.destroy();
    this.icons.destroy();
    this.kindIcons.values().next().value?.source.destroy();
    for (const t of this.kindIcons.values()) t.destroy();
    this.app.destroy({ removeView: true }, { children: true, texture: true, textureSource: true });
  }

  private frame(now: number) {
    this.scheduled = false;
    // WebKit runs a frame cancelled from inside the same animation-frame round.
    if (this.destroyed) return;
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
    const swaying = this.writeWires(now);
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
    if (moving || animating || swaying) this.invalidate();
  }

  /** Writes the wires for this frame; true while kinetic wires still move. */
  private writeWires(now: number): boolean {
    const list = this.wireList;
    // Far zoom: wires become texture, 1 px at 40 % (07 §4.9), unless highlighted.
    const far = SIZE.m * this.camera.zoom < 12;
    const shape = this.graph?.wireShape ?? 'bezier';
    const straight = shape === 'straight';
    // «Меньше движения»: a kinetic network draws Bézier wires (06 §6.2).
    const kinetic = shape === 'kinetic' && !this.motionReduced;
    if (kinetic) {
      this.kinetics.frame(now);
      this.jitterSelected();
    } else if (this.kinetic) {
      this.kinetics.reset();
    }
    this.kinetic = kinetic;
    const zoom = this.camera.zoom;
    this.wires.setCount(list.length);
    for (let i = 0; i < list.length; i++) {
      const [from, to] = list[i] as [string, string];
      const a = this.views.get(from);
      const b = this.views.get(to);
      if (!a || !b) continue;
      // Both ends sit on their corners (ADR-0011); the same curve as editor.wireEnds.
      const c = controls({ ax: a.x, ay: a.y, bx: b.x, by: b.y, ra: a.r, rb: b.r, straight });
      const k = kinetic ? this.kinetics.follow(i, c, zoom) : null;
      if (k) {
        c[2] += k[0] ?? 0;
        c[3] += k[1] ?? 0;
        c[4] += k[2] ?? 0;
        c[5] += k[3] ?? 0;
      }
      this.wires.set(i, c);
      const style = this.wireStyle(from, to);
      this.wires.setStyle(i, far && style === NORMAL_WIRE ? FAR_WIRE : style);
    }
    this.wires.upload();
    return kinetic && this.kinetics.moving;
  }

  /** The wires of a node selected since the last frame sway three times (06 §6.8). */
  private jitterSelected() {
    const selection = this.interaction().selection;
    for (const id of selection) {
      if (this.jittered.has(id)) continue;
      const v = this.views.get(id);
      if (!v) continue;
      for (const src of v.inputs) this.kinetics.shake(wireKey(src.id, id));
      for (const dst of v.outputs) this.kinetics.shake(wireKey(id, dst.id));
    }
    this.jittered = new Set(selection);
  }

  /** World control points of a wire as drawn this frame, a kinetic one's lag included. */
  private curveOf(a: DecorNode, b: DecorNode): readonly number[] {
    const straight = this.graph?.wireShape === 'straight';
    const c = controls({ ax: a.x, ay: a.y, bx: b.x, by: b.y, ra: a.r, rb: b.r, straight });
    const k = this.kinetic ? this.kinetics.kickOf(wireKey(a.id, b.id)) : null;
    if (k) {
      c[2] += k[0] ?? 0;
      c[3] += k[1] ?? 0;
      c[4] += k[2] ?? 0;
      c[5] += k[3] ?? 0;
    }
    return c;
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
    const pic = this.pictures.has(v.id);
    v.icon.visible = !n.ghost && (pic ? lv !== 'dot' : lv !== 'dot' && lv !== 'glyph');
    v.icon.tint = pic || this.kindIcon(n) ? 0xffffff : closed ? hex(fog.scene.doneInk) : INK;
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
        // The «soon» halo is made with the view: a deadline change remakes it.
        if (v.node.due !== node.due || v.node.icon !== node.icon) {
          v.body.destroy();
          v.icon.destroy();
          v.halo?.destroy();
          this.views.set(node.id, this.createView(node));
          continue;
        }
        v.node = node;
        // An asset's icon follows its file, link or the one chosen by hand.
        this.applyPicture(v);
        this.applyLevel(v);
      }
      if (v.x !== node.x || v.y !== node.y) moved.push(node.id);
    }
    this.wireList = graph.edges();
    this.kinetics.bind(this.wireList.map(([from, to]) => wireKey(from, to)));
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
    this.applyPicture(v);
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

function wireKey(from: string, to: string): string {
  return `${from}\u0000${to}`;
}

/** cubic-bezier(.2,.8,.2,1) of 06 §1.4, close enough as an ease-out cubic. */
function easeOut(k: number): number {
  return 1 - (1 - k) ** 3;
}
