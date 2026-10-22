import type { Graph } from '@strata/backend';
import type { CanvasView } from '@strata/canvas';
import type { FromWorker, ToWorker } from '@strata/layout/worker';
import {
  applyPose,
  BRIDGE_MS,
  Bridge,
  FULL_LAYOUT,
  initialLayout,
  type MergedExtract,
  mergeGraph,
  relaxInputs,
  StarMap,
  type StarMapExtract,
  syntheticExtract,
  type View2D,
  viewRect,
} from '@strata/view3d/map';

/**
 * The star map in the clickable prototype (08, spike 3): `M` or «2D | 3D»
 * flies from the canvas into the map over the camera bridge and back. The
 * current network is the prototype's own; the rest of the space is a
 * synthetic workspace of 3 000 nodes, as the prototype has no core (16 §3.2).
 * The space and its layout are made ahead of `M` in the physics worker and
 * kept (08 §3.5, §7.2 «заранее»), again only when the graph changed, so `M`
 * draws its first 3D frame at once (NFR-15). Outside React: the hot path is
 * the map's own (15 §4).
 */

export type MapState = '2d' | 'to3d' | '3d' | 'to2d';

const REST = { nodes: 3_000, edges: 4_500, seed: 11 };
/** Radians per CSS px of drag, and zoom per wheel unit (08 §5.1, orbit). */
const ORBIT = 0.006;
const WHEEL = 0.0015;

export class Map3D {
  readonly canvas = document.createElement('canvas');
  state: MapState = '2d';
  private map: StarMap | null = null;
  private bridge: Bridge | null = null;
  private merged: MergedExtract | null = null;
  private pos: Float32Array | null = null;
  private signature = '';
  private preparing: Promise<void> | null = null;
  private worker: Worker | null = null;
  private drag: { x: number; y: number } | null = null;
  private readonly resize: ResizeObserver;

  constructor(
    private readonly host: HTMLElement,
    private readonly view: CanvasView,
    private readonly graph: Graph,
    private readonly onState: (s: MapState) => void,
  ) {
    const c = this.canvas;
    c.className = 'proto-map';
    c.hidden = true;
    c.setAttribute('aria-hidden', 'true');
    host.append(c);
    c.addEventListener('pointerdown', (e) => {
      if (this.state !== '3d') return;
      c.setPointerCapture(e.pointerId);
      this.drag = { x: e.clientX, y: e.clientY };
    });
    c.addEventListener('pointermove', (e) => {
      if (!this.drag || this.state !== '3d') return;
      this.orbit(e.clientX - this.drag.x, e.clientY - this.drag.y, 1);
      this.drag = { x: e.clientX, y: e.clientY };
    });
    const end = () => {
      this.drag = null;
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener(
      'wheel',
      (e) => {
        if (this.state !== '3d') return;
        e.preventDefault();
        this.orbit(0, 0, Math.exp(e.deltaY * WHEEL));
      },
      { passive: false },
    );
    this.resize = new ResizeObserver(() => {
      if (!this.map || this.state === '2d') return;
      this.map.setSize(this.host.clientWidth, this.host.clientHeight);
      if (this.state === '3d' && this.bridge) {
        applyPose(this.map, this.bridge.pose3d);
        this.map.render();
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
    this.resize.disconnect();
    this.worker?.terminate();
    this.map?.dispose();
    this.canvas.remove();
  }

  private set(s: MapState): void {
    this.state = s;
    this.onState(s);
  }

  private view2d(): View2D {
    const cam = this.view.camera;
    return { x: cam.x, y: cam.y, zoom: cam.zoom, width: this.view.width, height: this.view.height };
  }

  /** Makes the space and its layout if the graph changed since; idle work, ahead of `M`. */
  prepare(): Promise<void> {
    const g = this.graph;
    const signature = `${g.nodes.size}:${g.edges().length}`;
    if (!this.preparing || signature !== this.signature) {
      this.signature = signature;
      this.preparing = this.build();
    }
    return this.preparing;
  }

  private async build(): Promise<void> {
    const merged = mergeGraph(syntheticExtract(REST), this.graph);
    const pos = await this.layout(merged.x, initialLayout(merged.x, 1));
    this.map ??= new StarMap({ canvas: this.canvas, dpr: window.devicePixelRatio, bloom: true });
    this.map.setData(merged.x, pos);
    this.merged = merged;
    this.pos = pos;
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
    await this.prepare();
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
  }

  private to2d(): void {
    const { map, bridge } = this;
    if (!map || !bridge) return;
    this.set('to2d');
    const v = this.view2d();
    this.view.renderNow();
    map.setSnapshot(this.view.canvas, viewRect(v));
    bridge.frame(BRIDGE_MS);
    void this.play(BRIDGE_MS, 0).then(() => {
      this.canvas.hidden = true;
      map.setSnapshot(null);
      this.view.invalidate();
      this.set('2d');
    });
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

  /** Orbit around the network: drag turns, the wheel moves closer or farther (08 §5.1). */
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
    map.render();
  }
}
