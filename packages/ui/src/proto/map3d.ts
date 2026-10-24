import type { Graph } from '@strata/backend';
import type { CanvasView } from '@strata/canvas';
import type { FromWorker, ToWorker } from '@strata/layout/worker';
import {
  applyPose,
  BRIDGE_MS,
  Bridge,
  bridgeExtract,
  clusterRadius,
  FULL_LAYOUT,
  initialLayout,
  isCluster,
  type MergedExtract,
  mergeGraph,
  type Pose,
  relaxInputs,
  type SpaceExtract,
  type SpaceItem,
  type SpaceWire,
  StarMap,
  type StarMapExtract,
  spaceExtract,
  starLook,
  syntheticExtract,
  type View2D,
  viewRect,
} from '@strata/view3d/map';

/**
 * The star map (08): `M` or the bar's button flies from the canvas into the
 * map over the camera bridge and back. In a workspace the map is the whole
 * space from the core and one navigates in it (08 §10): a click on a star
 * goes to it in 2D, a search flies to a star, `Enter` goes into it, `I` and
 * `U` move the cluster in focus. The clickable prototype has no core: its
 * network sits among a synthetic workspace of 3 000 nodes (16 §3.2).
 * The space and its layout are made ahead of `M` in the physics worker and
 * kept (08 §3.5, §7.2), again only when the space changed, so `M` draws its
 * first 3D frame at once (NFR-15). Outside React: the hot path is the
 * map's own (15 §4).
 */

export type MapState = '2d' | 'to3d' | '3d' | 'to2d';

/** A workspace's node as the map needs it: the tree's item and its name. */
export interface MapItem extends SpaceItem {
  name: string;
}

/** What a workspace gives the map to navigate in (08 §10). */
export interface MapNav {
  /** The whole space from the core: every live node and wire. */
  space: () => Promise<{ items: MapItem[]; wires: SpaceWire[] }>;
  /** The network on the canvas now. */
  network: () => string;
  /** Back in 2D: show network `net`, with node `node` selected and in view. */
  go: (net: string, node: string | null) => void;
  /** The selected star or the cluster in focus changed. */
  change?: () => void;
}

const REST = { nodes: 3_000, edges: 4_500, seed: 11 };
/** Radians per CSS px of drag, and zoom per wheel unit (08 §5.1, orbit). */
const ORBIT = 0.006;
const WHEEL = 0.0015;
/** A click, not a drag: moved less than this, CSS px (08 §5.4). */
const CLICK_PX = 4;
/** A star is under the pointer within this many CSS px of its centre. */
const PICK_PX = 14;
/** A flight ends where its star is this wide on the screen, CSS px (08 §6.1). */
const ARRIVE_PX = 64;

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const lerp3 = (a: readonly number[], b: readonly number[], t: number): [number, number, number] => [
  (a[0] ?? 0) + ((b[0] ?? 0) - (a[0] ?? 0)) * t,
  (a[1] ?? 0) + ((b[1] ?? 0) - (a[1] ?? 0)) * t,
  (a[2] ?? 0) + ((b[2] ?? 0) - (a[2] ?? 0)) * t,
];

export class Map3D {
  readonly canvas = document.createElement('canvas');
  /** The name of the selected star, over it. */
  private readonly label = document.createElement('div');
  state: MapState = '2d';
  private map: StarMap | null = null;
  private bridge: Bridge | null = null;
  private merged: MergedExtract | null = null;
  private pos: Float32Array | null = null;
  private space: SpaceExtract | null = null;
  private names: string[] = [];
  private signature = '';
  private preparing: Promise<void> | null = null;
  private worker: Worker | null = null;
  private drag: { x: number; y: number; moved: number } | null = null;
  private flight = 0;
  /** The selected star and the cluster in focus, as bodies (08 §5.1). */
  private selected: number | null = null;
  private focus = 0;
  private readonly resize: ResizeObserver;

  constructor(
    private readonly host: HTMLElement,
    private readonly view: CanvasView,
    private readonly graph: Graph,
    private readonly onState: (s: MapState) => void,
    private readonly nav: MapNav | null = null,
  ) {
    const c = this.canvas;
    c.className = 'proto-map';
    c.hidden = true;
    c.setAttribute('aria-hidden', 'true');
    host.append(c);
    this.label.className = 'proto-map-label';
    this.label.hidden = true;
    this.label.setAttribute('aria-hidden', 'true');
    host.append(this.label);
    c.addEventListener('pointerdown', (e) => {
      if (this.state !== '3d') return;
      this.stop();
      c.setPointerCapture(e.pointerId);
      this.drag = { x: e.clientX, y: e.clientY, moved: 0 };
    });
    c.addEventListener('pointermove', (e) => {
      const d = this.drag;
      if (!d || this.state !== '3d') return;
      d.moved += Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y);
      this.orbit(e.clientX - d.x, e.clientY - d.y, 1);
      d.x = e.clientX;
      d.y = e.clientY;
    });
    c.addEventListener('pointerup', (e) => {
      const d = this.drag;
      this.drag = null;
      if (!d || this.state !== '3d' || d.moved >= CLICK_PX) return;
      // A click on a star goes to it in 2D (owner, 2026-10-24; 08 §10).
      const hit = this.pick(e.clientX, e.clientY);
      if (hit !== null) this.go(hit);
    });
    c.addEventListener('pointercancel', () => {
      this.drag = null;
    });
    c.addEventListener(
      'wheel',
      (e) => {
        if (this.state !== '3d') return;
        e.preventDefault();
        this.stop();
        this.orbit(0, 0, Math.exp(e.deltaY * WHEEL));
      },
      { passive: false },
    );
    this.resize = new ResizeObserver(() => {
      if (!this.map || this.state === '2d') return;
      this.map.setSize(this.host.clientWidth, this.host.clientHeight);
      if (this.state === '3d' && this.bridge) {
        applyPose(this.map, this.bridge.pose3d);
        this.draw();
      }
    });
    this.resize.observe(host);
  }

  /** 2D → 3D or 3D → 2D; ignored while the bridge plays. */
  toggle(): void {
    if (this.state === '2d') void this.to3d();
    else if (this.state === '3d') this.to2d();
  }

  destroy(): void {
    this.stop();
    this.resize.disconnect();
    this.worker?.terminate();
    this.map?.dispose();
    this.canvas.remove();
    this.label.remove();
  }

  /** The selected star's node, if any. */
  selectedId(): string | null {
    return this.selected === null ? null : (this.space?.ids[this.selected] ?? null);
  }

  /** The node of the first star named `name`; for tests. */
  idNamed(name: string): string | null {
    const b = this.names.indexOf(name);
    return b < 0 ? null : (this.space?.ids[b] ?? null);
  }

  /** The cluster in focus: a folder's or project's node (08 §5.1). */
  focusId(): string | null {
    return this.space?.ids[this.focus] ?? null;
  }

  /** Where node `id`'s star is on the screen, CSS px of the page; null when not drawn. */
  screenOf(id: string): { x: number; y: number } | null {
    const b = this.space?.body.get(id);
    if (b === undefined) return null;
    const p = this.at(b);
    const s = p && this.map?.screenOf(p[0], p[1], p[2]);
    if (!s) return null;
    const r = this.canvas.getBoundingClientRect();
    return { x: r.left + s.x, y: r.top + s.y };
  }

  /**
   * The map's own keys while it is shown (08 §5.2, §10): `Enter` goes into
   * the selected star, `I` into its cluster, `U` to the cluster above, `Esc`
   * drops the selection. True when the key was the map's.
   */
  key(e: KeyboardEvent): boolean {
    if (this.state !== '3d' || e.metaKey || e.ctrlKey || e.altKey) return false;
    if (e.code === 'Enter' || e.code === 'NumpadEnter') {
      if (this.selected === null) return false;
      this.go(this.selected);
      return true;
    }
    if (e.code === 'KeyI') {
      const b = this.selected;
      if (b === null || !this.space || !isCluster(this.space.x.kind[b] ?? 0)) return false;
      this.into(b);
      return true;
    }
    if (e.code === 'KeyU') {
      this.up();
      return true;
    }
    if (e.code === 'Escape' && this.selected !== null) {
      this.select(null);
      return true;
    }
    return false;
  }

  /** A search's choice (08 §6.1): fly to node `id`'s star and select it. */
  flyTo(id: string): void {
    const b = this.space?.body.get(id);
    if (b === undefined || this.state !== '3d') return;
    this.select(b);
    const p = this.at(b);
    if (p) this.fly(p, (this.starSize(b) * this.pxPerUnit()) / ARRIVE_PX);
  }

  /** A star's size in world units, as the map draws it (08 §4.2). */
  private starSize(b: number): number {
    const x = this.space?.x;
    return x ? starLook(x.kind[b] ?? 0, x.flags[b] ?? 0, x.state[b] ?? 0).size : 32;
  }

  /** CSS px a world unit spans at distance 1 from the camera. */
  private pxPerUnit(): number {
    const fov = this.map?.camera.fov ?? 60;
    return this.canvas.clientHeight / (2 * Math.tan((fov * Math.PI) / 360));
  }

  private set(s: MapState): void {
    this.state = s;
    this.label.hidden = s !== '3d' || this.selected === null;
    this.onState(s);
  }

  private view2d(): View2D {
    const cam = this.view.camera;
    return { x: cam.x, y: cam.y, zoom: cam.zoom, width: this.view.width, height: this.view.height };
  }

  /** Makes the space and its layout if it changed since; idle work, ahead of `M`. */
  prepare(): Promise<void> {
    if (this.nav) {
      this.preparing = (this.preparing ?? Promise.resolve()).then(() => this.buildSpace());
      return this.preparing;
    }
    const g = this.graph;
    const signature = `${g.nodes.size}:${g.edges().length}`;
    if (!this.preparing || signature !== this.signature) {
      this.signature = signature;
      this.preparing = this.build();
    }
    return this.preparing;
  }

  /** The prototype's space: its network in a synthetic workspace. */
  private async build(): Promise<void> {
    const merged = mergeGraph(syntheticExtract(REST), this.graph);
    const pos = await this.layout(merged.x, initialLayout(merged.x, 1));
    this.map ??= new StarMap({ canvas: this.canvas, dpr: window.devicePixelRatio, bloom: true });
    this.map.setData(merged.x, pos);
    this.merged = merged;
    this.pos = pos;
  }

  /**
   * A workspace's space from the core (08 §10): laid out again only when its
   * nodes or wires changed; the bridge's members follow the canvas always.
   */
  private async buildSpace(): Promise<void> {
    const nav = this.nav;
    if (!nav) return;
    const { items, wires } = await nav.space();
    const signature = `${items.map((i) => `${i.id}${i.parent ?? ''}`).join()}|${wires.map((w) => w.from + w.to).join()}`;
    if (!this.space || !this.pos || signature !== this.signature) {
      const space = spaceExtract(items, wires);
      const pos = await this.layout(space.x, initialLayout(space.x, 1));
      this.map ??= new StarMap({ canvas: this.canvas, dpr: window.devicePixelRatio, bloom: true });
      this.map.setData(space.x, pos);
      const name = new Map(items.map((i) => [i.id, i.name]));
      this.names = space.ids.map((id) => name.get(id) ?? '');
      this.space = space;
      this.pos = pos;
      this.signature = signature;
      if (this.selected !== null && this.selected >= space.x.count) this.selected = null;
    }
    const network = nav.network();
    this.merged = bridgeExtract(this.space, network, [...this.graph.nodes.keys()]);
    this.focus = this.space.body.get(network) ?? 0;
  }

  /** A full layout in the physics worker (08 §3.1): the canvas stays responsive. */
  private layout(x: StarMapExtract, pos: Float32Array): Promise<Float32Array> {
    this.worker ??= new Worker(new URL('./layout.worker.ts', import.meta.url), { type: 'module' });
    const w = this.worker;
    const input = relaxInputs(x);
    return new Promise((resolve, reject) => {
      w.onmessage = (e: MessageEvent<FromWorker>) => {
        if (e.data.type === 'done') resolve(e.data.pos);
      };
      w.onerror = (e) => reject(new Error(e.message || 'layout worker failed'));
      const msg: ToWorker = { type: 'start', pos, ...input, ...FULL_LAYOUT };
      w.postMessage(msg, [pos.buffer]);
    });
  }

  private async to3d(): Promise<void> {
    const t0 = performance.now();
    this.set('to3d');
    try {
      await this.prepare();
    } catch (e) {
      // No map without its space: the canvas stays, nothing hangs half-way.
      console.error('star map', e);
      this.preparing = null;
      this.set('2d');
      return;
    }
    const { map, merged, pos } = this;
    if (!map || !merged || !pos) return;
    map.setSize(this.host.clientWidth, this.host.clientHeight);
    const v = this.view2d();
    const flat = new Float32Array(merged.ids.length * 2);
    merged.ids.forEach((id, j) => {
      const p = this.view.nodeAt(id);
      flat[j * 2] = p?.x ?? 0;
      flat[j * 2 + 1] = p?.y ?? 0;
    });
    this.bridge = new Bridge(map, {
      view: v,
      members: merged.members,
      flat,
      space: pos,
      count: merged.x.count,
    });
    // Frame 0 in the same task as the 2D render: the snapshot reads Pixi's buffer.
    this.view.renderNow();
    map.setSnapshot(this.view.canvas, viewRect(v));
    this.bridge.frame(0);
    this.canvas.hidden = false;
    // `M` → the first 3D frame submitted (NFR-15: ≤ 100 ms with the cache ready).
    this.host.dataset.firstFrame = (performance.now() - t0).toFixed(1);
    await this.play(0, BRIDGE_MS);
    this.set('3d');
    this.select(null);
    this.nav?.change?.();
  }

  private to2d(): Promise<void> {
    const { map, bridge, merged } = this;
    if (!map || !bridge || !merged) return Promise.resolve();
    this.stop();
    this.set('to2d');
    // The bridge's own focus again: the network on the canvas.
    const members = new Uint8Array(merged.x.count);
    for (const b of merged.members) members[b] = 1;
    map.setFocus(members);
    const v = this.view2d();
    this.view.renderNow();
    map.setSnapshot(this.view.canvas, viewRect(v));
    bridge.frame(BRIDGE_MS);
    return this.play(BRIDGE_MS, 0).then(() => {
      this.canvas.hidden = true;
      map.setSnapshot(null);
      this.view.invalidate();
      this.set('2d');
    });
  }

  /**
   * Into a star from 3D (08 §6.3, §10): a folder or project is entered, any
   * other node is shown in its network, selected and in view.
   */
  private go(b: number): void {
    const space = this.space;
    const nav = this.nav;
    if (!space || !nav) return;
    const id = space.ids[b];
    if (id === undefined) return;
    const cluster = isCluster(space.x.kind[b] ?? 0);
    const parent = space.ids[space.x.primaryNet[b] ?? -1] ?? space.ids[0] ?? id;
    void this.to2d().then(() => nav.go(cluster ? id : parent, cluster ? null : id));
  }

  /** `I` (08 §6.3): fly into a cluster; it is in focus, the rest dimmed. */
  private into(b: number): void {
    this.focus = b;
    this.showFocus();
    this.flyToCluster(b);
    this.nav?.change?.();
  }

  /** `U` (08 §6.3): to the cluster above; from the root, the whole space. */
  private up(): void {
    const space = this.space;
    if (!space) return;
    const parent = space.x.primaryNet[this.focus] ?? -1;
    this.focus = parent >= 0 ? parent : 0;
    this.showFocus();
    this.flyToCluster(this.focus);
    this.nav?.change?.();
  }

  /** The cluster in focus bright, the rest at 30 % (08 §6.3); the root shows all. */
  private showFocus(): void {
    const { map, space } = this;
    if (!map || !space) return;
    if (this.focus === 0) {
      map.setFocus(null);
      map.setFade(1, 1, 1);
      return;
    }
    const inside = this.subtree(this.focus);
    map.setFocus(inside);
    map.setFade(0.3, 0.15, 1);
  }

  /** Bodies under `root` in the tree of primary placements, `root` included. */
  private subtree(root: number): Uint8Array {
    const x = this.space?.x;
    const inside = new Uint8Array(x?.count ?? 0);
    if (!x) return inside;
    inside[root] = 1;
    // Parents precede children (spaceExtract), so one pass marks the subtree.
    for (let b = root + 1; b < x.count; b++) {
      const p = x.primaryNet[b] ?? -1;
      if (p >= 0 && inside[p]) inside[b] = 1;
    }
    return inside;
  }

  private flyToCluster(b: number): void {
    const x = this.space?.x;
    if (!x) return;
    const inside = this.subtree(b);
    let n = 0;
    const c: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < x.count; i++) {
      const p = inside[i] ? this.at(i) : null;
      if (!p) continue;
      c[0] += p[0];
      c[1] += p[1];
      c[2] += p[2];
      n++;
    }
    if (!n) return;
    c[0] /= n;
    c[1] /= n;
    c[2] /= n;
    this.fly(c, 2.6 * clusterRadius(x.subtreeSize[b] ?? 1));
  }

  /** Body `b`'s place in the map as drawn (the bridge's space). */
  private at(b: number): [number, number, number] | null {
    const s = this.bridge?.space;
    if (!s || b * 3 + 2 >= s.length) return null;
    return [s[b * 3] ?? 0, s[b * 3 + 1] ?? 0, s[b * 3 + 2] ?? 0];
  }

  /** The star under a page point, the nearest within `PICK_PX`; null if none. */
  private pick(clientX: number, clientY: number): number | null {
    const { map, space } = this;
    if (!map || !space) return null;
    const r = this.canvas.getBoundingClientRect();
    const px = clientX - r.left;
    const py = clientY - r.top;
    let best: number | null = null;
    let bestD = PICK_PX;
    for (let b = 0; b < space.x.count; b++) {
      const p = this.at(b);
      const s = p && map.screenOf(p[0], p[1], p[2]);
      if (!s) continue;
      const d = Math.hypot(s.x - px, s.y - py);
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    return best;
  }

  private select(b: number | null): void {
    this.selected = b;
    this.label.textContent = b === null ? '' : (this.names[b] ?? '');
    this.placeLabel();
    this.nav?.change?.();
  }

  /** The selected star's name just above its top edge, wherever the camera is. */
  private placeLabel(): void {
    const b = this.selected;
    const p = b === null ? null : this.at(b);
    const s = p && this.map?.screenOf(p[0], p[1], p[2]);
    this.label.hidden = this.state !== '3d' || !s;
    if (!s || !p || b === null || !this.map) return;
    const c = this.map.camera.position;
    const depth = Math.max(1, Math.hypot(c.x - p[0], c.y - p[1], c.z - p[2]));
    const radius = (this.starSize(b) * this.pxPerUnit()) / depth / 2;
    this.label.style.left = `${this.canvas.offsetLeft + s.x}px`;
    this.label.style.top = `${this.canvas.offsetTop + s.y - radius}px`;
  }

  private draw(): void {
    this.map?.render();
    this.placeLabel();
  }

  /**
   * A flight to `target`, ending `distance` away from it on the side the
   * camera looks from (08 §6.1): its time grows with the way, 0.5–1.2 s,
   * eased in and out; any input stops it; at once with reduced motion.
   */
  private fly(target: [number, number, number], distance: number): void {
    const { map, bridge } = this;
    if (!map || !bridge) return;
    this.stop();
    const from: Pose = bridge.pose3d;
    const dx = from.position[0] - from.target[0];
    const dy = from.position[1] - from.target[1];
    const dz = from.position[2] - from.target[2];
    const len = Math.hypot(dx, dy, dz) || 1;
    const end: Pose = {
      fov: from.fov,
      target,
      position: [
        target[0] + (dx / len) * distance,
        target[1] + (dy / len) * distance,
        target[2] + (dz / len) * distance,
      ],
    };
    const way = Math.hypot(
      end.position[0] - from.position[0],
      end.position[1] - from.position[1],
      end.position[2] - from.position[2],
    );
    const ms = this.view.reducedMotion
      ? 0
      : 1000 * Math.min(1.2, Math.max(0.5, 0.4 + 0.25 * Math.log2(1 + way / 60)));
    const t0 = performance.now();
    const step = (now: number) => {
      const k = ms === 0 ? 1 : easeInOut(Math.min(1, (now - t0) / ms));
      bridge.pose3d = {
        fov: from.fov,
        position: lerp3(from.position, end.position, k),
        target: lerp3(from.target, end.target, k),
      };
      applyPose(map, bridge.pose3d);
      this.draw();
      this.flight = k < 1 ? requestAnimationFrame(step) : 0;
    };
    this.flight = requestAnimationFrame(step);
  }

  /** Stops a flight where it is. */
  private stop(): void {
    if (this.flight) cancelAnimationFrame(this.flight);
    this.flight = 0;
  }

  /** Plays the bridge from `from` to `to` ms; at once with reduced motion (08 §7.4). */
  private play(from: number, to: number): Promise<void> {
    const bridge = this.bridge;
    if (!bridge) return Promise.resolve();
    if (this.view.reducedMotion) {
      bridge.frame(to);
      return Promise.resolve();
    }
    return new Promise((done) => {
      const t0 = performance.now();
      const step = (now: number) => {
        const k = Math.min(1, (now - t0) / BRIDGE_MS);
        bridge.frame(from + (to - from) * k);
        if (k < 1) requestAnimationFrame(step);
        else done();
      };
      requestAnimationFrame(step);
    });
  }

  /** Orbit around the target: drag turns, the wheel moves closer or farther (08 §5.1). */
  private orbit(dx: number, dy: number, scale: number): void {
    const { map, bridge } = this;
    if (!map || !bridge) return;
    const p = bridge.pose3d;
    const [tx, ty, tz] = p.target;
    let ox = p.position[0] - tx;
    let oy = p.position[1] - ty;
    let oz = p.position[2] - tz;
    const r = Math.hypot(ox, oy, oz) * scale;
    let theta = Math.atan2(ox, oz) - dx * ORBIT;
    let phi = Math.acos(Math.min(1, Math.max(-1, oy / Math.max(1e-6, Math.hypot(ox, oy, oz)))));
    phi = Math.min(Math.PI - 0.05, Math.max(0.05, phi - dy * ORBIT));
    theta = Number.isFinite(theta) ? theta : 0;
    ox = r * Math.sin(phi) * Math.sin(theta);
    oy = r * Math.cos(phi);
    oz = r * Math.sin(phi) * Math.cos(theta);
    bridge.pose3d = { ...p, position: [tx + ox, ty + oy, tz + oz] };
    applyPose(map, bridge.pose3d);
    this.draw();
  }
}
