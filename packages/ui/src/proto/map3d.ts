import type { Graph, NodeDetails } from '@strata/backend';
import type { CanvasView } from '@strata/canvas';
import { glyphUrl } from '@strata/design-tokens';
import type { MessageKey } from '@strata/i18n';
import type { PinnedBody } from '@strata/layout/worker';
import {
  ACTIVE_LIMIT,
  applyPose,
  arcPose,
  arrivePose,
  BORN_TICKS,
  BRIDGE_MS,
  Bridge,
  bornAt,
  bridgeExtract,
  chooseQuality,
  clusterRadius,
  type DragSample,
  FLAG,
  FULL_LAYOUT,
  flightTime,
  flySpeed,
  flyStep,
  frozenBut,
  idHash,
  initialLayout,
  isCluster,
  LIVE_ALPHA,
  LIVE_COOLING,
  lookPose,
  type MergedExtract,
  mergeGraph,
  nearAhead,
  neighbourhood,
  type Pose,
  p95,
  panPose,
  QUALITY,
  QUALITY_FRAMES,
  type Quality,
  type QualityNote,
  qualityOf,
  REST_SPEED,
  REST_TICKS,
  readQuality,
  type SpaceExtract,
  type SpaceItem,
  type SpaceWire,
  StarMap,
  type StarMapExtract,
  screenAxes,
  shiftPose,
  spaceExtract,
  starLook,
  syntheticExtract,
  throwVelocity,
  type View2D,
  viewRect,
  zoomAt,
} from '@strata/view3d/map';
import { briefCard, type CardItem, type CardWords, fullCard } from './map-cards';
import { MapPhysics } from './map-physics';

/**
 * The star map (08): `M` or the bar's button flies from the canvas into the
 * map over the camera bridge and back. In a workspace the map is the whole
 * space from the core, and the work of S6 goes on in it without 2D (08 §1,
 * 04 S6): fly with the right button and `WASD` / `QE`, orbit, zoom to the
 * cursor and pan; search and fly on an arc; read the cards of near stars;
 * `Enter` opens a note, a board or a picture over the map and bridges into
 * a network — straight into another one; `Tab` makes a node where §6.4 says;
 * `R` / `Q` / `E`, `Delete`, `B` and the quick marks work on stars; a star
 * is grabbed and thrown. The clickable prototype has no core: its network
 * sits among a synthetic workspace of 3 000 nodes (16 §3.2), orbit only.
 * The space and its layout are made ahead of `M` in the physics worker and
 * kept (08 §3.5, §7.2), again only when the space changed, so `M` draws its
 * first 3D frame at once (NFR-15); a change moves nobody but the new stars
 * (§3.4). Outside React: the hot path is the map's own (15 §4).
 */

export type MapState = '2d' | 'to3d' | '3d' | 'to2d';

/** A workspace's node as the map needs it: the tree's item, its name and deadline. */
export interface MapItem extends SpaceItem {
  name: string;
  deadline?: string | undefined;
}

/** A camera of the map without the bridge's offset: a quick mark keeps it (09 §6.2). */
export interface MapCamera {
  position: [number, number, number];
  target: [number, number, number];
}

/** What a workspace gives the map to work in (08 §10, §6). */
export interface MapNav {
  /** The whole space from the core: every live node and wire. */
  space: () => Promise<{ items: MapItem[]; wires: SpaceWire[] }>;
  /** The network on the canvas now. */
  network: () => string;
  /**
   * Network `net` on the canvas under the map, node `node` selected and in
   * view, the canvas at `camera` if given: the bridge then lands on that
   * very frame (08 §6.3, §7.2).
   */
  load: (
    net: string,
    node: string | null,
    camera?: { x: number; y: number; zoom: number },
  ) => Promise<void>;
  /** The selected star or the cluster in focus changed. */
  change?: () => void;
  /**
   * A step of the map that goes somewhere — 2D ↔ 3D, `Enter`, a click on a
   * star, `I`, `U`, a search's flight — before it goes: the screen keeps
   * where it was (09 §6.1).
   */
  leave?: () => void;
  /** The workspace: the device keeps its pins by it (08 §3.5). */
  workspace: string;
  /** How the cards read (08 §6.2). */
  words: () => CardWords;
  person: (id: string) => string | undefined;
  details: (id: string) => Promise<NodeDetails>;
  /**
   * The content of node `id` over the map (08 §6.3) beside its star, at
   * page point `x`, `y`, radius `r`: false when it has none to show there.
   */
  open: (id: string, at: { x: number; y: number; r: number }) => boolean;
  /** `Tab` (08 §6.4): the Tab menu at a page point, for network `net`, wired from `from`. */
  create: (at: { x: number; y: number; net: string; from: string | null }) => void;
  flag: (ids: string[], flag: 'key' | 'pause' | 'template') => void;
  /** `Delete` / `Shift+Delete` (08 §6.7) from the contextual network `net`. */
  remove: (id: string, net: string, everywhere: boolean) => void;
  /** The right button's menu at a page point: of a star, or of the map. */
  menu: (x: number, y: number, id: string | null) => void;
  /** `Ctrl+Z` / `Ctrl+Shift+Z` on the map: the core's history (05 §11). */
  undo: (redo: boolean) => void;
  toast: (key: MessageKey) => void;
  /** The first frames choose the quality (08 §8.4); off for e2e on software WebGL. */
  measure: boolean;
}

const REST = { nodes: 3_000, edges: 4_500, seed: 11 };
/** Radians per CSS px of drag, and zoom per wheel unit (08 §5.1, orbit). */
const ORBIT = 0.006;
const WHEEL = 0.0015;
/** A click, not a drag: moved less than this, CSS px (08 §5.4). */
const CLICK_PX = 4;
/** A right click, not a look: shorter than this, ms (08 §5.4). */
const MENU_MS = 250;
/** A star is under the pointer within this many CSS px of its centre, or within its disc. */
const PICK_PX = 14;
/** A flight ends where its star is this wide on the screen, CSS px: its card shows (08 §6.1). */
const ARRIVE_PX = 120;
/** Brief cards: stars at least this wide on the screen, CSS px; at most so many (08 §6.2). */
const BRIEF_PX = 96;
const BRIEF_MAX = 5;
/** The full card of a star hovered so long, ms; of one held with the middle button (08 §6.2). */
const HOVER_CARD_MS = 600;
const HOLD_CARD_MS = 200;
/** A pin's mark shows on stars at least this wide on the screen, CSS px (08 §4.3). */
const PIN_PX = 12;
/** The look of flying: radians per CSS px; the wheel's step of speed and its range (08 §5.2). */
const LOOK = 0.004;
const SPEED_STEP = 1.25;
/** Flying speeds up over this long, ms (08 §5.3). */
const RAMP_MS = 150;
/** Velocity kept per tick while a star is thrown: the layout's 0.6 stops it at once (08 §3.6). */
const LIVE_DECAY = 0.05;
/** A tick of the live physics: 60 a second (08 §3.6). */
const TICK_MS = 1000 / 60;
/** A new star's flash and a removed one's fade, ms (08 §3.4). */
const FLASH_MS = 300;
const FADE_MS = 200;
const QUALITY_KEY = 'strata.map.quality';

const pinsKey = (workspace: string) => `strata.map.pins.${workspace}`;

function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private windows may refuse storage: it lasts for the session then.
  }
}

/** The device's quality note (08 §8.4): the hand's choice and the measured one. */
export function mapQuality(): QualityNote {
  return readQuality(readLocal(QUALITY_KEY));
}

/** The hand's choice of quality; null gives the choice back to the frames. */
export function setMapQuality(manual: Quality | null): void {
  writeLocal(QUALITY_KEY, JSON.stringify({ ...mapQuality(), manual }));
}

/** A gesture of a pointer on the map. */
type Gesture =
  | { t: 'orbit'; x: number; y: number; moved: number }
  | { t: 'pan'; x: number; y: number; moved: number; button: number }
  | { t: 'press'; b: number; x: number; y: number; moved: number; shift: boolean; mod: boolean }
  | {
      t: 'grab';
      b: number;
      /** The plane it moves in: through its centre, square to the look. */
      plane: [number, number, number];
      samples: DragSample[];
    }
  | { t: 'hold'; b: number | null; x: number; y: number; moved: number; since: number }
  | { t: 'look'; x: number; y: number; moved: number; since: number };

/** A step of the frame loop: false when it is done. */
type Ticker = (now: number) => boolean;

export class Map3D {
  readonly canvas = document.createElement('canvas');
  /** The name of the selected star, over it, and of the one under the pointer. */
  private readonly label = document.createElement('div');
  private readonly hoverLabel = document.createElement('div');
  /** Pixel corners round the selected star (08 §4.3). */
  private readonly corners = document.createElement('div');
  state: MapState = '2d';
  private map: StarMap | null = null;
  private bridge: Bridge | null = null;
  private merged: MergedExtract | null = null;
  /** Laid-out positions: the bridge draws them moved by its offset. */
  private pos: Float32Array | null = null;
  private space: SpaceExtract | null = null;
  private names: string[] = [];
  private items = new Map<string, MapItem>();
  private signature = '';
  private preparing: Promise<void> | null = null;
  private readonly physics = new MapPhysics();
  private gesture: Gesture | null = null;
  private flight: Ticker | null = null;
  private live: Ticker | null = null;
  private readonly tickers = new Set<Ticker>();
  private frame = 0;
  private lastFrame = 0;
  /**
   * Destroyed: a network loaded under the map makes a new one. A bridge or a
   * layout still under way stops there and tells the screen nothing more.
   */
  private dead = false;
  /** The selected star and the cluster in focus, as bodies (08 §5.1). */
  private selected: number | null = null;
  private focus = 0;
  /** The focus is drawn: the rest dimmed (after `I`, `U`, `H`, a quick mark). */
  private focusShown = false;
  /** The star under the pointer, and where the pointer is on the canvas. */
  private hovered: number | null = null;
  private pointer: { x: number; y: number } | null = null;
  private hoverTimer = 0;
  /** `Ctrl+F`'s matches (08 §6.1): lit over the cluster's dimming while the bar is open. */
  private lit: Uint8Array | null = null;
  /** Screen points of every body: x, y, depth (`StarMap.projectAll`), as of the last frame. */
  private scr = new Float32Array(0);
  /** Brief cards by node, and the full one (08 §6.2). */
  private readonly briefs = new Map<string, HTMLElement>();
  private full: {
    id: string;
    el: HTMLElement;
    /** `Shift+I`: it stays whatever the pointer does. */
    kept: boolean;
    /** Held with the middle button: it goes when the button does. */
    held: boolean;
  } | null = null;
  private readonly details = new Map<string, NodeDetails>();
  /** Pin marks of pinned stars on the screen. */
  private readonly pinMarks = new Map<string, HTMLElement>();
  /** «Закрепить на карте» (08 §3.6): laid-out positions by node, on this device. */
  private pins = new Map<string, [number, number, number]>();
  /** Keys of flying held (08 §5.2), the wheel's speed, when flying began. */
  private readonly flyKeys = new Set<string>();
  private flyScale = 1;
  private flyFrom = 0;
  /** The space bar held: the left button pans (08 §5.2). */
  private spaceHeld = false;
  private quality: Quality;
  private readonly samples: number[] = [];
  private measured = false;
  private readonly resize: ResizeObserver;
  private readonly onKeyUp = (e: KeyboardEvent) => {
    this.flyKeys.delete(e.code);
    if (e.code === 'Space') this.spaceHeld = false;
  };

  constructor(
    private readonly host: HTMLElement,
    private readonly view: CanvasView,
    private graph: Graph,
    private readonly onState: (s: MapState) => void,
    private readonly nav: MapNav | null = null,
  ) {
    this.quality = qualityOf(mapQuality());
    const c = this.canvas;
    c.className = 'proto-map';
    c.hidden = true;
    c.setAttribute('aria-hidden', 'true');
    host.append(c);
    for (const [el, cls] of [
      [this.label, 'proto-map-label'],
      [this.hoverLabel, 'proto-map-label is-hover'],
      [this.corners, 'proto-map-corners'],
    ] as const) {
      el.className = cls;
      el.hidden = true;
      el.setAttribute('aria-hidden', 'true');
      host.append(el);
    }
    for (let i = 0; i < 4; i++) this.corners.append(document.createElement('span'));
    if (nav) this.pins = readPins(nav.workspace);
    c.addEventListener('pointerdown', (e) => this.pointerDown(e));
    c.addEventListener('pointermove', (e) => this.pointerMove(e));
    c.addEventListener('pointerup', (e) => this.pointerUp(e));
    c.addEventListener('pointercancel', () => this.cancelGesture());
    c.addEventListener('pointerleave', () => {
      if (!this.gesture) this.hover(null);
    });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    window.addEventListener('keyup', this.onKeyUp);
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

  /** 2D → 3D or 3D → 2D; ignored while the bridge plays (08 §6.3: `M`). */
  toggle(): void {
    if (this.state === '2d') {
      // Off by the frames or by hand: the canvas stays, a toast says why (08 §7.4).
      if (this.nav && this.quality === 'off') {
        this.nav.toast('map.off');
        return;
      }
      this.nav?.leave?.();
      void this.to3d();
      return;
    }
    if (this.state !== '3d') return;
    const space = this.space;
    if (!space || !this.nav) {
      this.nav?.leave?.();
      void this.to2d();
      return;
    }
    // `M` with a star selected: into its network, it framed and selected;
    // without: into the cluster in focus (08 §6.3).
    const b = this.selected;
    if (b !== null) {
      const id = space.ids[b] ?? '';
      this.bridgeTo(this.contextNet(b), id);
      return;
    }
    const focus = space.ids[this.focus];
    this.bridgeTo(focus && this.focus !== 0 ? focus : this.nav.network(), null);
  }

  /** Back to 2D in network `net` (the history, a quick mark), at its own camera. */
  leaveTo(net: string, camera?: { x: number; y: number; zoom: number }): void {
    if (this.state !== '3d') return;
    this.bridgeTo(net, null, camera);
  }

  destroy(): void {
    this.dead = true;
    this.stop();
    this.tickers.clear();
    if (this.frame) cancelAnimationFrame(this.frame);
    window.clearTimeout(this.hoverTimer);
    window.removeEventListener('keyup', this.onKeyUp);
    this.stopFlying();
    this.resize.disconnect();
    this.physics.destroy();
    this.map?.dispose();
    this.canvas.remove();
    this.label.remove();
    this.hoverLabel.remove();
    this.corners.remove();
    this.closeCards();
    for (const m of this.pinMarks.values()) m.remove();
  }

  /**
   * The canvas's graph changed under the map: a step on the map read the
   * network again (08 §6.4), or the bridge is about to land in another one.
   */
  adopt(graph: Graph): void {
    this.graph = graph;
  }

  // ── What the screen and the tests read ──────────────────────────────

  /** The selected star's node, if any. */
  selectedId(): string | null {
    return this.selected === null ? null : (this.space?.ids[this.selected] ?? null);
  }

  /** The star under the pointer, if any. */
  hoveredId(): string | null {
    return this.hovered === null ? null : (this.space?.ids[this.hovered] ?? null);
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

  /** Where node `id`'s star is laid out, world units without the bridge's offset; for tests. */
  placeOf(id: string): [number, number, number] | null {
    const b = this.space?.body.get(id);
    const p = this.pos;
    if (b === undefined || !p) return null;
    return [p[b * 3] ?? 0, p[b * 3 + 1] ?? 0, p[b * 3 + 2] ?? 0];
  }

  /** The cards shown (08 §6.2): brief ones by node, and the full one. */
  cards(): { brief: string[]; full: string | null; kept: boolean } {
    return {
      brief: [...this.briefs.keys()],
      full: this.full?.id ?? null,
      kept: this.full?.kept ?? false,
    };
  }

  /** Stars pinned on the map (08 §3.6). */
  pinnedIds(): string[] {
    return [...this.pins.keys()];
  }

  /** A node's flags as the map draws them (08 §4.3). */
  flagsOf(id: string): { key: boolean; pause: boolean; template: boolean } | null {
    const b = this.space?.body.get(id);
    const f = b === undefined ? undefined : this.space?.x.flags[b];
    if (f === undefined) return null;
    return {
      key: (f & FLAG.key) !== 0,
      pause: (f & FLAG.pause) !== 0,
      template: (f & FLAG.template) !== 0,
    };
  }

  /** The quality in force and whether bloom draws now (08 §8.4). */
  qualityNow(): { quality: Quality; bloom: boolean } {
    return { quality: this.quality, bloom: this.map?.bloom ?? false };
  }

  /** Frame times as if drawn, ms: the automatic choice of quality takes them (NFR-19 e2e). */
  feedFrames(ms: readonly number[]): void {
    for (const m of ms) this.sample(m, true);
  }

  /** The camera now, laid-out units: a quick mark keeps it (09 §6.2). */
  cameraNow(): MapCamera | null {
    const b = this.bridge;
    if (!b || this.state !== '3d') return null;
    const o = b.offset;
    const p = b.pose3d;
    return {
      position: [p.position[0] - o[0], p.position[1] - o[1], p.position[2] - o[2]],
      target: [p.target[0] - o[0], p.target[1] - o[1], p.target[2] - o[2]],
    };
  }

  /** Nothing moves: no flight, no physics, no bridge; for tests. */
  get still(): boolean {
    return this.tickers.size === 0 && this.state !== 'to3d' && this.state !== 'to2d';
  }

  // ── Keys ──────────────────────────────────────────────────────────────

  /**
   * The map's own keys while it is shown (08 §5.2): flying with the right
   * button held; `Enter`, `I`, `U`, `H`, `F`; `R` / `Q` / `E`, `B`,
   * `Delete`; `Tab`; `Shift+I` keeps the card; `Esc`; `Ctrl+Z`. True when
   * the key was the map's.
   */
  key(e: KeyboardEvent): boolean {
    if (this.state !== '3d') return false;
    const mod = e.metaKey || e.ctrlKey;
    if (this.gesture?.t === 'look') {
      // Under the right button `Q` and `E` fly, they do not flag (08 §5.2).
      if (!FLY_KEYS.has(e.code)) return false;
      this.flyKeys.add(e.code);
      this.startFlying();
      return true;
    }
    if (e.code === 'Space' && !mod) {
      this.spaceHeld = true;
      return true;
    }
    if (mod && !e.altKey && (e.code === 'KeyZ' || e.code === 'KeyY')) {
      this.nav?.undo(e.code === 'KeyY' || e.shiftKey);
      return true;
    }
    if (mod || e.altKey) return false;
    const space = this.space;
    if (!space || !this.nav) return false;
    const aimed = this.hovered ?? this.selected;
    switch (e.code) {
      case 'Enter':
      case 'NumpadEnter': {
        const b = this.selected ?? this.hovered ?? this.central();
        if (b === null) return false;
        this.enter(b);
        return true;
      }
      case 'KeyI': {
        if (e.shiftKey) {
          this.keepCard();
          return true;
        }
        const b = this.selected;
        if (b === null) return false;
        if (isCluster(space.x.kind[b] ?? 0)) this.into(b);
        else this.enter(b);
        return true;
      }
      case 'KeyU':
        this.up();
        return true;
      case 'KeyH':
        this.overview();
        return true;
      case 'KeyF':
      case 'KeyG': {
        const b = this.selected ?? this.hovered;
        if (b === null) return false;
        this.flyToBody(b);
        return true;
      }
      case 'KeyR':
      case 'KeyQ':
      case 'KeyE': {
        if (aimed === null) return false;
        const flag = e.code === 'KeyR' ? 'key' : e.code === 'KeyQ' ? 'pause' : 'template';
        this.nav.flag([space.ids[aimed] ?? ''], flag);
        return true;
      }
      case 'KeyB':
        if (aimed === null) return false;
        this.pin(aimed);
        return true;
      case 'Delete':
      case 'Backspace': {
        const b = this.selected;
        if (b === null) return false;
        this.nav.remove(space.ids[b] ?? '', this.contextNet(b), e.shiftKey);
        return true;
      }
      case 'Tab':
        this.create();
        return true;
      case 'Escape':
        if (this.full) {
          this.closeFull();
          return true;
        }
        if (this.selected !== null) {
          this.select(null);
          this.draw();
          return true;
        }
        return false;
      default:
        return false;
    }
  }

  /** What the palette and the menu run on the map (09 §3.5): the keys' actions. */
  act(action: MapAction, id?: string): void {
    const space = this.space;
    const nav = this.nav;
    if (!space || !nav || this.state !== '3d') return;
    const given = id === undefined ? undefined : space.body.get(id);
    const b = given ?? this.selected ?? this.hovered;
    if (action === 'create') {
      this.create(given ?? this.selected);
    } else if (action === 'up') {
      this.up();
    } else if (action === 'overview') {
      this.overview();
    } else if (b !== null && b !== undefined) {
      const node = space.ids[b] ?? '';
      if (action === 'open') this.enter(b);
      else if (action === 'into') {
        if (isCluster(space.x.kind[b] ?? 0)) this.into(b);
        else this.enter(b);
      } else if (action === 'frame') this.flyToBody(b);
      else if (action === 'card') {
        this.showFull(b, false);
        this.keepCard();
      } else if (action === 'pin') this.pin(b);
      else if (action === 'delete' || action === 'deleteEverywhere') {
        nav.remove(node, this.contextNet(b), action === 'deleteEverywhere');
      } else {
        nav.flag([node], action.slice(5) as 'key' | 'pause' | 'template');
      }
    }
  }

  // ── Search, lens, selection (08 §6.1) ─────────────────────────────────

  /**
   * `Ctrl+F` on the map (08 §6.1): the matches stay bright and the rest dims
   * as outside the cluster in focus; `null` gives the cluster's dimming back.
   */
  lens(ids: readonly string[] | null): void {
    const space = this.space;
    if (!space) return;
    if (ids) {
      const lit = new Uint8Array(space.x.count);
      for (const id of ids) {
        const b = space.body.get(id);
        if (b !== undefined) lit[b] = 1;
      }
      this.lit = lit;
    } else {
      this.lit = null;
    }
    // Mid-bridge the bridge's own focus stays (08 §7).
    if (this.state !== '3d') return;
    this.showFocus();
    this.draw();
  }

  /** The nodes `Ctrl+F` lights now, or null with no lens; for tests. */
  lensIds(): string[] | null {
    const { lit, space } = this;
    if (!lit || !space) return null;
    return space.ids.filter((_, b) => lit[b] === 1);
  }

  /** Node `id`'s star selected where it is, with no flight; null — none. */
  selectId(id: string | null): void {
    const b = id === null ? null : (this.space?.body.get(id) ?? null);
    if (this.state !== '3d') return;
    this.select(b);
    this.draw();
  }

  /** A search's choice (08 §6.1): fly to node `id`'s star, select it, show its card. */
  flyTo(id: string): void {
    const b = this.space?.body.get(id);
    if (b === undefined || this.state !== '3d') return;
    this.nav?.leave?.();
    this.flyToBody(b);
  }

  /**
   * A place of the history or a quick mark in 3D (09 §6.1–6.2): the cluster
   * `net` in focus, the camera where it was, or the cluster in view.
   */
  goPlace(net: string, camera?: MapCamera): void {
    const space = this.space;
    if (!space || this.state !== '3d') return;
    this.focus = space.body.get(net) ?? 0;
    this.showFocus();
    const bridge = this.bridge;
    if (camera && bridge) {
      const o = bridge.offset;
      const add = (p: readonly number[]): [number, number, number] => [
        (p[0] ?? 0) + o[0],
        (p[1] ?? 0) + o[1],
        (p[2] ?? 0) + o[2],
      ];
      this.flyPose({
        fov: bridge.pose3d.fov,
        position: add(camera.position),
        target: add(camera.target),
      });
    } else {
      this.flyToCluster(this.focus);
    }
    this.nav?.change?.();
  }

  // ── The space and its layout ──────────────────────────────────────────

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

  /**
   * The space read again after a step on the map (08 §3.4): positions stay,
   * a new star is born by its source — `born.from` — or in its network and
   * settles its neighbourhood, a removed one fades; looks follow flags and
   * states.
   */
  refresh(born?: { id: string; from: string | null }): Promise<void> {
    this.preparing = (this.preparing ?? Promise.resolve())
      .then(() => this.buildSpace(born))
      .catch((e: unknown) => console.error('star map', e));
    return this.preparing;
  }

  /** The prototype's space: its network in a synthetic workspace. */
  private async build(): Promise<void> {
    const merged = mergeGraph(syntheticExtract(REST), this.graph);
    const pos = await this.physics.start(
      merged.x,
      initialLayout(merged.x, 1),
      [],
      FULL_LAYOUT.ticks,
    );
    this.map ??= this.makeMap();
    this.map.setData(merged.x, pos);
    this.merged = merged;
    this.pos = pos;
  }

  private makeMap(): StarMap {
    try {
      const map = new StarMap({
        canvas: this.canvas,
        dpr: window.devicePixelRatio,
        bloom: QUALITY[this.quality].bloom,
      });
      map.setHalos(QUALITY[this.quality].halos);
      return map;
    } catch (e) {
      // No WebGL 2: the map is off, the canvas works (08 §7.4, NFR-19).
      this.nav?.toast('map.noWebgl');
      throw e;
    }
  }

  /**
   * A workspace's space from the core (08 §10): laid out in full the first
   * time, then only what changed (§3.4); the bridge's members follow the
   * canvas always.
   */
  private async buildSpace(born?: { id: string; from: string | null }): Promise<void> {
    const nav = this.nav;
    if (!nav) return;
    const { items, wires } = await nav.space();
    if (this.dead) return;
    const signature = signatureOf(items, wires);
    if (this.space && this.pos && signature === this.signature) {
      this.merged = bridgeExtract(this.space, nav.network(), [...this.graph.nodes.keys()]);
      if (this.state !== '3d') this.focus = this.space.body.get(nav.network()) ?? 0;
      return;
    }
    const next = spaceExtract(items, wires);
    const old = this.space;
    const oldPos = this.pos;
    if (!old || !oldPos) {
      const pos = await this.physics.start(
        next.x,
        initialLayout(next.x, 1),
        this.pinned(next),
        FULL_LAYOUT.ticks,
      );
      if (this.dead) return;
      this.install(next, pos, items, signature);
      return;
    }
    // A removed star fades where it is; the hole stays until a new layout (08 §3.4).
    const gone = old.ids.flatMap((id, b) => (next.body.has(id) ? [] : [b]));
    if (gone.length > 0 && this.state === '3d' && !this.view.reducedMotion) {
      await this.animate(FADE_MS, (k) => {
        for (const b of gone) this.map?.setStarLook(b, 1, 1 - k);
      });
      if (this.dead) return;
    }
    const pos = new Float32Array(next.x.count * 3);
    const newcomers: number[] = [];
    next.ids.forEach((id, b) => {
      const was = old.body.get(id);
      if (was === undefined) newcomers.push(b);
      else pos.set(oldPos.subarray(was * 3, was * 3 + 3), b * 3);
    });
    const from = born?.from ? (next.body.get(born.from) ?? null) : null;
    // Parents come before children: a new network's new nodes go round it.
    for (const b of newcomers) {
      const id = next.ids[b] ?? '';
      pos.set(bornAt(next.x, pos, b, idHash(id), id === born?.id ? from : null), b * 3);
    }
    for (const p of this.pinned(next)) pos.set([p.x, p.y, p.z], p.i * 3);
    this.install(next, pos, items, signature);
    if (newcomers.length > 0 && !QUALITY[this.quality].touchOnly) {
      // The new stars and their neighbours settle; the rest stays (08 §3.4).
      await this.physics.start(next.x, pos, this.pinned(next), 0);
      this.physics.freeze(this.frozenMask(next.x, neighbourhood(next.x, newcomers, 2)));
      const relaxed = await this.physics.relax(BORN_TICKS, LIVE_ALPHA);
      if (this.dead || this.space !== next) return;
      const start = pos.slice();
      if (this.state === '3d' && !this.view.reducedMotion) {
        await this.animate(FLASH_MS, (k) => {
          const e = 1 - (1 - k) ** 3;
          for (let i = 0; i < start.length; i++) {
            pos[i] = (start[i] ?? 0) + ((relaxed[i] ?? 0) - (start[i] ?? 0)) * e;
          }
          this.placed(pos);
        });
      }
      if (this.dead || this.space !== next) return;
      this.placed(relaxed);
    }
    const nb = born ? next.body.get(born.id) : undefined;
    if (nb !== undefined && this.state === '3d' && QUALITY[this.quality].halos) {
      if (!this.view.reducedMotion) {
        await this.animate(FLASH_MS, (k) => this.map?.setStarLook(nb, 1 + 1.5 * (1 - k), 1));
      }
      this.map?.setStarLook(nb, 1, 1);
      this.draw();
    }
  }

  /**
   * The space in force: its stars, positions laid out, names; the selection,
   * the focus, the lens and the cards follow their nodes into the new bodies.
   */
  private install(next: SpaceExtract, pos: Float32Array, items: MapItem[], signature: string) {
    const nav = this.nav;
    if (!nav) return;
    const old = this.space;
    const id = (b: number | null) => (b === null ? null : (old?.ids[b] ?? null));
    const body = (i: string | null) => (i === null ? null : (next.body.get(i) ?? null));
    const selected = body(id(this.selected));
    const hovered = body(id(this.hovered));
    const focus = body(id(this.focus)) ?? 0;
    const lit = this.lensIds();
    this.items = new Map(items.map((i) => [i.id, i]));
    this.names = next.ids.map((i) => this.items.get(i)?.name ?? '');
    this.space = next;
    this.pos = pos;
    this.signature = signature;
    this.details.clear();
    this.physics.forget();
    this.map ??= this.makeMap();
    this.map.setData(next.x, pos);
    this.scr = new Float32Array(next.x.count * 3);
    this.selected = selected;
    this.hovered = hovered;
    if (lit) {
      // The lens follows its nodes; drawn below with the new bridge.
      this.lit = new Uint8Array(next.x.count);
      for (const i of lit) {
        const b = next.body.get(i);
        if (b !== undefined) this.lit[b] = 1;
      }
    }
    for (const [i, m] of this.pinMarks) {
      if (!next.body.has(i)) {
        m.remove();
        this.pinMarks.delete(i);
      }
    }
    if (this.state === '3d') {
      this.focus = focus;
      this.rebridge();
      this.restoreFocus();
      // A card of a node gone goes with it; the rest reads its node again.
      for (const [i, el] of this.briefs) {
        el.remove();
        this.briefs.delete(i);
      }
      const was = this.full;
      this.closeFull();
      const b = was ? body(was.id) : null;
      if (was && b !== null) {
        this.showFull(b, false);
        if (was.kept) this.keepCard();
      }
      this.draw();
    } else {
      this.merged = bridgeExtract(next, nav.network(), [...this.graph.nodes.keys()]);
      this.focus = next.body.get(nav.network()) ?? 0;
    }
  }

  /**
   * A new bridge over the same space for the network on the canvas now: the
   * camera moves by as much as the space does, so the screen stays (08 §7).
   */
  private rebridge(): void {
    const { map, space, pos, nav } = this;
    if (!map || !space || !pos || !nav) return;
    const old = this.bridge;
    const merged = bridgeExtract(space, nav.network(), [...this.graph.nodes.keys()]);
    const flat = new Float32Array(merged.ids.length * 2);
    merged.ids.forEach((id, j) => {
      const p = this.view.nodeAt(id);
      flat[j * 2] = p?.x ?? 0;
      flat[j * 2 + 1] = p?.y ?? 0;
    });
    const nb = new Bridge(map, {
      view: this.view2d(),
      members: merged.members,
      flat,
      space: pos,
      count: space.x.count,
    });
    if (old) {
      const d = nb.offset.map((v, i) => v - (old.offset[i] ?? 0)) as [number, number, number];
      nb.pose3d = shiftPose(old.pose3d, d);
    }
    this.bridge = nb;
    this.merged = merged;
    map.updatePositions(nb.space);
    applyPose(map, nb.pose3d);
  }

  /** New laid-out positions (the physics): drawn with the bridge's offset. */
  private placed(pos: Float32Array): void {
    this.pos = pos;
    const b = this.bridge;
    if (!b || !this.map) return;
    const o = b.offset;
    const s = b.space;
    const n = Math.min(s.length, pos.length);
    for (let i = 0; i < n; i += 3) {
      s[i] = (pos[i] ?? 0) + o[0];
      s[i + 1] = (pos[i + 1] ?? 0) + o[1];
      s[i + 2] = (pos[i + 2] ?? 0) + o[2];
    }
    this.map.updatePositions(s);
  }

  /** The pinned stars of `x`'s space, for the worker (08 §3.6). */
  private pinned(next: SpaceExtract): PinnedBody[] {
    const out: PinnedBody[] = [];
    for (const [id, p] of this.pins) {
      const i = next.body.get(id);
      if (i !== undefined) out.push({ i, x: p[0], y: p[1], z: p[2] });
    }
    return out;
  }

  /** Everything stays but `free`, and pinned stars stay always. */
  private frozenMask(x: StarMapExtract, free: readonly number[]): Uint8Array {
    const mask = frozenBut(x.count, free);
    for (const id of this.pins.keys()) {
      const b = this.space?.body.get(id);
      if (b !== undefined) mask[b] = 1;
    }
    return mask;
  }

  // ── 2D ↔ 3D (08 §7) ───────────────────────────────────────────────────

  private set(s: MapState): void {
    if (this.dead) return;
    this.state = s;
    if (s !== '3d') {
      this.label.hidden = true;
      this.hoverLabel.hidden = true;
      this.corners.hidden = true;
      this.closeCards();
      for (const m of this.pinMarks.values()) m.hidden = true;
    }
    this.onState(s);
  }

  private view2d(): View2D {
    const cam = this.view.camera;
    return { x: cam.x, y: cam.y, zoom: cam.zoom, width: this.view.width, height: this.view.height };
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
    if (this.dead || !map || !merged || !pos) return;
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
    if (this.dead) return;
    this.set('3d');
    this.focusShown = false;
    this.select(null);
    this.draw();
    this.nav?.change?.();
  }

  /** The bridge back into the network on the canvas, its frame as it is. */
  private to2d(): Promise<void> {
    const { map, bridge, merged } = this;
    if (!map || !bridge || !merged) return Promise.resolve();
    this.stop();
    this.stopLive();
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
      if (this.dead) return;
      this.canvas.hidden = true;
      map.setSnapshot(null);
      this.view.invalidate();
      this.set('2d');
    });
  }

  /**
   * Into 2D in network `net` with `node` selected and in view (08 §6.3,
   * §7.2): the canvas loads it under the map first, then the bridge plays
   * into that very frame — straight into another network, never through the
   * one the map came from.
   */
  private bridgeTo(
    net: string,
    node: string | null,
    camera?: { x: number; y: number; zoom: number },
  ) {
    const nav = this.nav;
    if (!nav || this.state !== '3d') return;
    nav.leave?.();
    this.stop();
    this.stopLive();
    this.set('to2d');
    void nav
      .load(net, node, camera)
      .then(() => {
        if (this.dead) return;
        this.rebridge();
        return this.to2d();
      })
      .catch((e: unknown) => {
        console.error('star map', e);
        if (!this.dead) this.set('3d');
      });
  }

  /** The network a star's steps work in (08 §2.3): that of its primary placement. */
  private contextNet(b: number): string {
    const space = this.space;
    if (!space) return '';
    const p = space.x.primaryNet[b] ?? -1;
    return space.ids[p >= 0 ? p : 0] ?? '';
  }

  /**
   * `Enter` on a star (08 §6.3): a folder or project — the bridge into it;
   * a note, a board, a picture — its window over the map; anything else
   * (a task, a list, a file) — in 2D in its network, its panel open.
   */
  private enter(b: number): void {
    const space = this.space;
    const nav = this.nav;
    if (!space || !nav) return;
    const id = space.ids[b] ?? '';
    if (isCluster(space.x.kind[b] ?? 0)) {
      this.bridgeTo(id, null);
      return;
    }
    const s = this.screenOfBody(b);
    if (s && nav.open(id, s)) {
      this.select(b);
      this.draw();
      return;
    }
    this.bridgeTo(this.contextNet(b), id);
  }

  /** A click on a star (owner, 2026-10-24; 08 §10): the node in 2D — a network is entered. */
  private go(b: number): void {
    const space = this.space;
    if (!space) return;
    const id = space.ids[b] ?? '';
    if (isCluster(space.x.kind[b] ?? 0)) this.bridgeTo(id, null);
    else this.bridgeTo(this.contextNet(b), id);
  }

  /** `I` (08 §6.3): fly into a cluster; it is in focus, the rest dimmed. */
  private into(b: number): void {
    this.nav?.leave?.();
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
    this.nav?.leave?.();
    this.focus = parent >= 0 ? parent : 0;
    this.showFocus();
    this.flyToCluster(this.focus);
    this.nav?.change?.();
  }

  /** `H` (08 §5.2): the whole space in view, nothing in focus. */
  private overview(): void {
    const map = this.map;
    const b = this.bridge;
    if (!map || !b) return;
    this.focus = 0;
    this.showFocus();
    const fov = (b.pose3d.fov * Math.PI) / 360;
    const c = map.centre;
    this.fly([c.x, c.y, c.z], (1.1 * map.radius) / Math.tan(fov), map.radius);
    this.nav?.change?.();
  }

  /** `Tab` (08 §6.4): the selected star's network with a wire from it, else the cluster in focus. */
  private create(from: number | null = this.selected): void {
    const space = this.space;
    const nav = this.nav;
    if (!space || !nav) return;
    const net = from !== null ? this.contextNet(from) : (space.ids[this.focus] ?? space.ids[0]);
    const r = this.canvas.getBoundingClientRect();
    const s = from !== null ? this.screenOfBody(from) : null;
    const p = s ?? this.pointerPage() ?? { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    nav.create({
      x: p.x,
      y: p.y,
      net: net ?? '',
      from: from !== null ? (space.ids[from] ?? null) : null,
    });
  }

  /** `B` (08 §3.6): pinned where it is, or free again; on this device. */
  private pin(b: number): void {
    const space = this.space;
    const pos = this.pos;
    const nav = this.nav;
    if (!space || !pos || !nav) return;
    const id = space.ids[b] ?? '';
    if (this.pins.has(id)) {
      this.pins.delete(id);
      this.pinMarks.get(id)?.remove();
      this.pinMarks.delete(id);
      if (this.physics.holding(space.x, LIVE_DECAY)) this.physics.fix(b, false);
    } else {
      this.pins.set(id, [pos[b * 3] ?? 0, pos[b * 3 + 1] ?? 0, pos[b * 3 + 2] ?? 0]);
      if (this.physics.holding(space.x, LIVE_DECAY)) this.physics.fix(b, true);
    }
    writePins(nav.workspace, this.pins);
    this.draw();
  }

  // ── Focus and flights ─────────────────────────────────────────────────

  /** The cluster in focus bright, the rest at 30 % (08 §6.3); the root shows all. */
  private showFocus(): void {
    const { map, space } = this;
    if (!map || !space) return;
    this.focusShown = true;
    if (this.lit) {
      map.setFocus(this.lit);
      map.setFade(0.3, 0.15, 1);
      return;
    }
    if (this.focus === 0) {
      map.setFocus(null);
      map.setFade(1, 1, 1);
      return;
    }
    const inside = this.subtree(this.focus);
    map.setFocus(inside);
    map.setFade(0.3, 0.15, 1);
  }

  /**
   * The dimming as it was after a new bridge: the focus if `I`, `U`, `H`
   * or a lens showed it, else every star as the bridge left them.
   */
  private restoreFocus(): void {
    if (this.focusShown || this.lit) {
      this.showFocus();
      return;
    }
    this.map?.setFocus(null);
    this.map?.setFade(1, 1, 1);
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
    const r = clusterRadius(x.subtreeSize[b] ?? 1);
    this.fly(c, 2.6 * r, r);
  }

  /** To a star: selected, framed at the size of its card, its full card shown (08 §6.1). */
  private flyToBody(b: number): void {
    const p = this.at(b);
    const x = this.space?.x;
    if (!p || !x) return;
    this.select(b);
    const net = x.primaryNet[b] ?? -1;
    const r = clusterRadius(x.subtreeSize[net >= 0 ? net : 0] ?? 1);
    this.fly(p, (this.starSize(b) * this.pxPerUnit()) / ARRIVE_PX, r, () =>
      this.showFull(b, false),
    );
  }

  /** A star's size in world units, as the map draws it (08 §4.2). */
  private starSize(b: number): number {
    const x = this.space?.x;
    return x ? starLook(x.kind[b] ?? 0, x.flags[b] ?? 0, x.state[b] ?? 0).size : 32;
  }

  /** CSS px a world unit spans at distance 1 from the camera. */
  private pxPerUnit(): number {
    return this.map?.pxPerUnit() ?? 1;
  }

  /**
   * A flight to `target`, ending `distance` away from it on the side the
   * camera looks from (08 §6.1): an arc over the straight way, its time by
   * the way and the target's cluster `radius`; any input stops it; at once
   * with reduced motion.
   */
  private fly(
    target: [number, number, number],
    distance: number,
    radius: number,
    arrived?: () => void,
  ): void {
    const bridge = this.bridge;
    if (!bridge) return;
    this.flyPose(arrivePose(bridge.pose3d, target, distance), radius, arrived);
  }

  private flyPose(end: Pose, radius = 100, arrived?: () => void): void {
    const { map, bridge } = this;
    if (!map || !bridge) return;
    this.stop();
    const from: Pose = bridge.pose3d;
    const way = Math.hypot(
      end.position[0] - from.position[0],
      end.position[1] - from.position[1],
      end.position[2] - from.position[2],
    );
    const ms = this.view.reducedMotion ? 0 : 1000 * flightTime(way, radius);
    const t0 = performance.now();
    const step: Ticker = (now) => {
      const k = ms === 0 ? 1 : Math.min(1, (now - t0) / ms);
      bridge.pose3d = k < 1 ? arcPose(from, end, k) : end;
      applyPose(map, bridge.pose3d);
      if (k < 1) return true;
      if (this.flight === step) this.flight = null;
      arrived?.();
      return false;
    };
    this.flight = step;
    this.run(step);
  }

  /** Stops a flight where it is. */
  private stop(): void {
    if (this.flight) this.tickers.delete(this.flight);
    this.flight = null;
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
        // Never done once destroyed: what was to follow the bridge does not.
        if (this.dead) return;
        const k = Math.min(1, (now - t0) / BRIDGE_MS);
        const ms = from + (to - from) * k;
        bridge.frame(ms);
        this.sample(now - this.lastFrame);
        this.lastFrame = now;
        if (k < 1) requestAnimationFrame(step);
        else done();
      };
      this.lastFrame = performance.now();
      requestAnimationFrame(step);
    });
  }

  // ── The frame loop ────────────────────────────────────────────────────

  /** `t` runs every frame until it says it is done; the map draws after each frame. */
  private run(t: Ticker): void {
    this.tickers.add(t);
    this.kick();
  }

  private kick(): void {
    if (!this.frame && !this.dead) this.frame = requestAnimationFrame(this.loop);
  }

  private readonly loop = (now: number) => {
    this.frame = 0;
    if (this.dead) return;
    // «Экономия»: at most 30 frames a second (08 §8.4).
    const fps = QUALITY[this.quality].fps;
    if (fps < 60 && now - this.lastFrame < 1000 / fps - 2) {
      this.kick();
      return;
    }
    const gap = now - this.lastFrame;
    this.lastFrame = now;
    for (const t of [...this.tickers]) if (!t(now)) this.tickers.delete(t);
    this.draw();
    if (this.tickers.size > 0) {
      this.sample(gap);
      this.kick();
    }
  };

  /** A promise of `ms` of frames, `each(k)` with k going 0 → 1. */
  private animate(ms: number, each: (k: number) => void): Promise<void> {
    return new Promise((done) => {
      const t0 = performance.now();
      this.run((now) => {
        const k = Math.min(1, (now - t0) / ms);
        each(k);
        if (k >= 1) done();
        return k < 1;
      });
    });
  }

  /**
   * A frame's time for the automatic quality (08 §8.4): the first 120 frames
   * of motion choose it, unless chosen by hand; the choice is kept on the
   * device and comes in force at once — «off» only at the next `M`.
   */
  private sample(ms: number, fed = false): void {
    if (this.measured || !this.nav || ms <= 0 || ms > 250) return;
    if (!fed && !this.nav.measure) return;
    const note = mapQuality();
    if (note.manual) {
      this.measured = true;
      return;
    }
    this.samples.push(ms);
    if (this.samples.length < QUALITY_FRAMES) return;
    this.measured = true;
    const auto = chooseQuality(p95(this.samples), this.quality);
    writeLocal(QUALITY_KEY, JSON.stringify({ ...note, auto }));
    this.applyQuality(auto);
  }

  /** A preset in force (08 §8.4): bloom, halos, the frame rate. */
  applyQuality(q: Quality): void {
    this.quality = q;
    const look = QUALITY[q];
    if (this.map) {
      this.map.bloom = look.bloom;
      this.map.setHalos(look.halos);
      if (this.state === '3d') this.draw();
    }
  }

  /** One frame and what lies over it: labels, corners, pins, cards. */
  private draw(): void {
    const { map, bridge, space } = this;
    if (!map) return;
    map.render();
    if (this.state !== '3d' || !bridge || !space) return;
    map.projectAll(bridge.space, space.x.count, this.scr);
    this.placeLabels();
    this.placePins();
    this.placeCards();
  }

  // ── Pointer ───────────────────────────────────────────────────────────

  private local(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private pointerPage(): { x: number; y: number } | null {
    const p = this.pointer;
    if (!p) return null;
    const r = this.canvas.getBoundingClientRect();
    return { x: r.left + p.x, y: r.top + p.y };
  }

  private pointerDown(e: PointerEvent): void {
    if (this.state !== '3d') return;
    this.stop();
    this.canvas.setPointerCapture(e.pointerId);
    const p = this.local(e);
    this.pointer = p;
    if (e.button === 2) {
      this.gesture = { t: 'look', x: e.clientX, y: e.clientY, moved: 0, since: performance.now() };
      return;
    }
    if (e.button === 1) {
      e.preventDefault();
      const b = this.pick(p.x, p.y);
      this.gesture = {
        t: 'hold',
        b,
        x: e.clientX,
        y: e.clientY,
        moved: 0,
        since: performance.now(),
      };
      window.setTimeout(() => {
        const g = this.gesture;
        if (g?.t === 'hold' && g.moved < CLICK_PX && g.b !== null) {
          this.showFull(g.b, true);
          this.draw();
        }
      }, HOLD_CARD_MS);
      return;
    }
    if (e.button !== 0) return;
    if (this.spaceHeld) {
      this.gesture = { t: 'pan', x: e.clientX, y: e.clientY, moved: 0, button: 0 };
      return;
    }
    const b = this.space ? this.pick(p.x, p.y) : null;
    if (b !== null) {
      this.gesture = {
        t: 'press',
        b,
        x: e.clientX,
        y: e.clientY,
        moved: 0,
        shift: e.shiftKey,
        mod: e.ctrlKey || e.metaKey,
      };
      return;
    }
    this.gesture = { t: 'orbit', x: e.clientX, y: e.clientY, moved: 0 };
  }

  private pointerMove(e: PointerEvent): void {
    if (this.state !== '3d') return;
    const p = this.local(e);
    this.pointer = p;
    const g = this.gesture;
    if (!g) {
      this.hover(this.space ? this.pick(p.x, p.y) : null);
      return;
    }
    if (g.t === 'grab') {
      this.drag(g, p);
      return;
    }
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    g.moved += Math.abs(dx) + Math.abs(dy);
    g.x = e.clientX;
    g.y = e.clientY;
    switch (g.t) {
      case 'orbit':
        this.orbit(dx, dy, 1);
        return;
      case 'pan':
        this.pan(dx, dy);
        return;
      case 'hold':
        if (g.moved >= CLICK_PX) this.pan(dx, dy);
        return;
      case 'look':
        this.look(dx, dy);
        return;
      case 'press':
        if (g.moved >= CLICK_PX) this.grab(g.b, p);
        return;
    }
  }

  private pointerUp(e: PointerEvent): void {
    const g = this.gesture;
    this.gesture = null;
    if (!g || this.state !== '3d') return;
    switch (g.t) {
      case 'press': {
        // A click on a star: with Shift or Ctrl it is selected, else the node in 2D (owner, 2026-10-24).
        if (g.shift || g.mod) {
          this.select(g.mod && this.selected === g.b ? null : g.b);
          this.draw();
        } else {
          this.go(g.b);
        }
        return;
      }
      case 'grab':
        this.release(g, e.shiftKey);
        return;
      case 'hold':
        if (this.full?.held) this.closeFull();
        return;
      case 'look': {
        this.stopFlying();
        // A short right click without moving — the menu, of the star under it (08 §5.4).
        if (g.moved < CLICK_PX && performance.now() - g.since < MENU_MS) {
          const p = this.local(e);
          const b = this.space ? this.pick(p.x, p.y) : null;
          const id = b === null ? null : (this.space?.ids[b] ?? null);
          this.nav?.menu(e.clientX, e.clientY, id);
        }
        return;
      }
      default:
        return;
    }
  }

  private cancelGesture(): void {
    const g = this.gesture;
    this.gesture = null;
    if (g?.t === 'grab') this.release(g, false);
    if (g?.t === 'look') this.stopFlying();
  }

  private wheel(e: WheelEvent): void {
    if (this.state !== '3d') return;
    e.preventDefault();
    // Under the right button the wheel sets the speed of flying (08 §5.2).
    if (this.gesture?.t === 'look') {
      const k = e.deltaY < 0 ? SPEED_STEP : 1 / SPEED_STEP;
      this.flyScale = Math.min(10, Math.max(0.1, this.flyScale * k));
      return;
    }
    this.stop();
    const { map, bridge } = this;
    if (!map || !bridge) return;
    const p = this.local(e);
    bridge.pose3d = zoomAt(bridge.pose3d, map.rayAt(p.x, p.y), Math.exp(e.deltaY * WHEEL));
    applyPose(map, bridge.pose3d);
    this.draw();
  }

  /** Under the pointer now: its label, and its full card after 600 ms (08 §6.2). */
  private hover(b: number | null): void {
    if (b === this.hovered) return;
    this.hovered = b;
    window.clearTimeout(this.hoverTimer);
    if (b !== null && this.nav) {
      this.hoverTimer = window.setTimeout(() => {
        if (this.hovered === b && !this.gesture && this.state === '3d') {
          this.showFull(b, false);
          this.draw();
        }
      }, HOVER_CARD_MS);
    }
    this.placeLabels();
  }

  /** The star under a canvas point: within its disc or `PICK_PX`, the nearest; null if none. */
  private pick(x: number, y: number): number | null {
    const space = this.space;
    if (!space) return null;
    const s = this.scr;
    const ppu = this.pxPerUnit();
    let best: number | null = null;
    let bestScore = 1;
    for (let b = 0; b < space.x.count; b++) {
      const depth = s[b * 3 + 2] ?? 0;
      if (depth <= 0) continue;
      const d = Math.hypot((s[b * 3] ?? 0) - x, (s[b * 3 + 1] ?? 0) - y);
      const reach = Math.max(PICK_PX, (this.starSize(b) * ppu) / depth / 2);
      const score = d / reach;
      if (score < bestScore) {
        bestScore = score;
        best = b;
      }
    }
    return best;
  }

  /** The star nearest the screen's centre within its card's reach (S6 step 8). */
  private central(): number | null {
    const r = this.canvas.getBoundingClientRect();
    return this.pick(r.width / 2, r.height / 2);
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

  /** Panning (08 §5.2): the world under the pointer follows it at the target's depth. */
  private pan(dx: number, dy: number): void {
    const { map, bridge } = this;
    if (!map || !bridge) return;
    const p = bridge.pose3d;
    const depth = Math.hypot(
      p.target[0] - p.position[0],
      p.target[1] - p.position[1],
      p.target[2] - p.position[2],
    );
    const unit = depth / this.pxPerUnit();
    bridge.pose3d = panPose(p, dx * unit, dy * unit);
    applyPose(map, bridge.pose3d);
    this.draw();
  }

  /** The look of flying (08 §5.2): the camera turns in place. */
  private look(dx: number, dy: number): void {
    const { map, bridge } = this;
    if (!map || !bridge) return;
    bridge.pose3d = lookPose(bridge.pose3d, dx * LOOK, dy * LOOK);
    applyPose(map, bridge.pose3d);
    this.draw();
  }

  /** `WASD` / `QE` held under the right button (08 §5.2–5.3): a frame's step each frame. */
  private startFlying(): void {
    if (this.tickers.has(this.flying)) return;
    this.flyFrom = performance.now();
    this.lastFly = this.flyFrom;
    this.run(this.flying);
  }

  private lastFly = 0;
  private readonly flying: Ticker = (now) => {
    const { map, bridge, space } = this;
    if (!map || !bridge || this.gesture?.t !== 'look' || this.flyKeys.size === 0) return false;
    const dt = Math.min(0.1, (now - this.lastFly) / 1000);
    this.lastFly = now;
    const k = this.flyKeys;
    const f = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);
    const r = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
    const u = (k.has('KeyE') ? 1 : 0) - (k.has('KeyQ') ? 1 : 0);
    const fast = k.has('ShiftLeft') || k.has('ShiftRight');
    const near = space ? nearAhead(bridge.pose3d, bridge.space, space.x.count) : map.radius;
    const vMax = 4 * map.radius;
    const ramp = Math.min(1, (now - this.flyFrom) / RAMP_MS);
    const v = flySpeed(Number.isFinite(near) ? near : vMax, this.flyScale, fast, vMax) * ramp;
    bridge.pose3d = flyStep(bridge.pose3d, f, r, u, v * dt);
    applyPose(map, bridge.pose3d);
    return true;
  };

  private stopFlying(): void {
    this.flyKeys.clear();
    this.tickers.delete(this.flying);
  }

  // ── Grab and throw (08 §3.6) ──────────────────────────────────────────

  /** A star grabbed: it follows the pointer in its plane, its neighbours by their springs. */
  private grab(b: number, p: { x: number; y: number }): void {
    const { space, pos, bridge, map } = this;
    if (!space || !pos || !bridge || !map) return;
    this.stopLive();
    const at = this.at(b);
    if (!at) return;
    const { look } = screenAxes(bridge.pose3d);
    this.gesture = { t: 'grab', b, plane: at, samples: [] };
    this.hover(b);
    // The worker takes the space in with the live decay; the rest is frozen.
    const x = space.x;
    if (!this.physics.holding(x, LIVE_DECAY)) {
      void this.physics.start(x, pos, this.pinned(space), 0, LIVE_DECAY);
    }
    const free = neighbourhood(x, [b], 2, ACTIVE_LIMIT);
    this.physics.freeze(this.frozenMask(x, free));
    this.physics.fix(b, true);
    this.livePlane = look;
    this.drag(this.gesture, p);
    this.startLive(b, false);
  }

  private livePlane: [number, number, number] = [0, 0, -1];

  /** The grabbed star where the pointer's ray meets its plane. */
  private drag(g: Extract<Gesture, { t: 'grab' }>, p: { x: number; y: number }): void {
    const { map, bridge, pos } = this;
    if (!map || !bridge || !pos) return;
    const cam = bridge.pose3d.position;
    const ray = map.rayAt(p.x, p.y);
    const n = this.livePlane;
    const denom = ray[0] * n[0] + ray[1] * n[1] + ray[2] * n[2];
    if (Math.abs(denom) < 1e-6) return;
    const t =
      ((g.plane[0] - cam[0]) * n[0] + (g.plane[1] - cam[1]) * n[1] + (g.plane[2] - cam[2]) * n[2]) /
      denom;
    if (t <= 0) return;
    const o = bridge.offset;
    const world: [number, number, number] = [
      cam[0] + ray[0] * t - o[0],
      cam[1] + ray[1] * t - o[1],
      cam[2] + ray[2] * t - o[2],
    ];
    pos.set(world, g.b * 3);
    this.physics.move(g.b, world);
    g.samples.push({ t: performance.now(), p: world });
    if (g.samples.length > 32) g.samples.shift();
    this.placed(pos);
    this.draw();
  }

  /**
   * Let go (08 §3.6): with Shift the star is pinned where it is; else it
   * flies on at the drag's speed, no faster than 2·R(N) a second, and the
   * springs bring it back; with reduced motion it stands in its new
   * equilibrium at once.
   */
  private release(g: Extract<Gesture, { t: 'grab' }>, shift: boolean): void {
    const space = this.space;
    if (!space) return;
    const id = space.ids[g.b] ?? '';
    if (shift && !this.pins.has(id)) this.pin(g.b);
    if (this.pins.has(id)) {
      // A pinned star moved by hand stays pinned where it was let go.
      const p = this.placeOf(id);
      if (p) this.pins.set(id, p);
      if (this.nav) writePins(this.nav.workspace, this.pins);
      this.physics.fix(g.b, true);
    } else {
      this.physics.fix(g.b, false);
      const net = space.x.primaryNet[g.b] ?? -1;
      const limit = 2 * clusterRadius(space.x.subtreeSize[net >= 0 ? net : 0] ?? 1);
      const v = this.view.reducedMotion ? [0, 0, 0] : throwVelocity(g.samples, limit);
      this.physics.velocity(
        g.b,
        v.map((c) => c / 60),
      );
    }
    if (this.view.reducedMotion) {
      this.stopLive();
      void this.physics.relax(BORN_TICKS, LIVE_ALPHA).then((pos) => {
        if (this.dead || this.space !== space) return;
        this.placed(pos);
        this.draw();
      });
      return;
    }
    this.startLive(g.b, true);
  }

  /**
   * The live physics (08 §3.6): ticks as many as the frame's time holds —
   * 60 a second whatever the frame rate, at most 8 a frame — while the star
   * is held, then cooling × 0.97 a tick until the fastest star stays slower
   * than 0.01 world units a tick for 30 ticks; the frames stop with it.
   */
  private startLive(b: number, cooling: boolean): void {
    this.stopLive();
    const space = this.space;
    if (!space) return;
    let alpha = LIVE_ALPHA;
    let quiet = 0;
    let waiting = false;
    let done = false;
    let last = performance.now();
    const step: Ticker = (now) => {
      if (done || this.space !== space) return false;
      if (waiting) return true;
      const held = this.gesture?.t === 'grab' && this.gesture.b === b;
      const n = Math.max(1, Math.min(8, Math.round((now - last) / TICK_MS)));
      last = now;
      const cool = held || !cooling ? 1 : LIVE_COOLING;
      waiting = true;
      void this.physics
        .tick(alpha, n, cool, REST_SPEED)
        .then((r) => {
          waiting = false;
          if (this.dead || this.space !== space || this.live !== step) return;
          // The held star is where the pointer put it, not where the tick did.
          const g = this.gesture;
          if (g?.t === 'grab' && this.pos) {
            r.pos.set(this.pos.subarray(g.b * 3, g.b * 3 + 3), g.b * 3);
          }
          this.placed(r.pos);
          if (cool === 1) return;
          alpha = r.alpha;
          quiet = r.quiet === n ? quiet + n : r.quiet;
          if (quiet >= REST_TICKS) done = true;
        })
        .catch(() => {
          done = true;
        });
      return true;
    };
    this.live = step;
    this.run(step);
  }

  private stopLive(): void {
    if (this.live) this.tickers.delete(this.live);
    this.live = null;
  }

  // ── Selection, labels, cards ──────────────────────────────────────────

  private select(b: number | null): void {
    this.selected = b;
    this.label.textContent = b === null ? '' : (this.names[b] ?? '');
    this.placeLabels();
    this.nav?.change?.();
  }

  /** Body `b`'s place in the map as drawn (the bridge's space). */
  private at(b: number): [number, number, number] | null {
    const s = this.bridge?.space;
    if (!s || b * 3 + 2 >= s.length) return null;
    return [s[b * 3] ?? 0, s[b * 3 + 1] ?? 0, s[b * 3 + 2] ?? 0];
  }

  /** Body `b` on the page: its centre and radius in CSS px; null behind the camera. */
  private screenOfBody(b: number): { x: number; y: number; r: number } | null {
    const s = this.local3(b);
    if (!s) return null;
    const r = this.canvas.getBoundingClientRect();
    return { x: r.left + s.x, y: r.top + s.y, r: s.r };
  }

  /** Body `b` on the canvas, as of the last frame: centre and radius, CSS px. */
  private local3(b: number): { x: number; y: number; r: number } | null {
    const depth = this.scr[b * 3 + 2] ?? 0;
    if (depth <= 0) return null;
    return {
      x: this.scr[b * 3] ?? 0,
      y: this.scr[b * 3 + 1] ?? 0,
      r: (this.starSize(b) * this.pxPerUnit()) / depth / 2,
    };
  }

  /** On the canvas one sees. */
  private onScreen(s: { x: number; y: number }): boolean {
    return (
      s.x >= 0 && s.y >= 0 && s.x <= this.canvas.clientWidth && s.y <= this.canvas.clientHeight
    );
  }

  /**
   * The names over the selected star and the one under the pointer, unless
   * a card says it already (one fact once); corners round the selected one.
   */
  private placeLabels(): void {
    const carded = (b: number) => {
      const id = this.space?.ids[b];
      return id !== undefined && (this.full?.id === id || this.briefs.has(id));
    };
    const put = (el: HTMLElement, b: number | null) => {
      const s = b === null || carded(b) ? null : this.local3(b);
      el.hidden = this.state !== '3d' || !s || !this.onScreen(s);
      if (!s || el.hidden || b === null) return;
      el.textContent = this.names[b] ?? '';
      el.style.left = `${this.canvas.offsetLeft + s.x}px`;
      el.style.top = `${this.canvas.offsetTop + s.y - s.r}px`;
    };
    put(this.label, this.selected);
    put(this.hoverLabel, this.hovered !== this.selected ? this.hovered : null);
    const s = this.selected === null ? null : this.local3(this.selected);
    this.corners.hidden = this.state !== '3d' || !s || !this.onScreen(s);
    if (s && !this.corners.hidden) {
      const half = Math.max(8, s.r + 4);
      this.corners.style.left = `${this.canvas.offsetLeft + s.x - half}px`;
      this.corners.style.top = `${this.canvas.offsetTop + s.y - half}px`;
      this.corners.style.width = `${2 * half}px`;
      this.corners.style.height = `${2 * half}px`;
    }
  }

  /** The pin's mark by each pinned star near enough (08 §4.3). */
  private placePins(): void {
    const space = this.space;
    if (!space) return;
    for (const id of this.pins.keys()) {
      const b = space.body.get(id);
      const s = b === undefined ? null : this.local3(b);
      let mark = this.pinMarks.get(id);
      if (!s || 2 * s.r < PIN_PX || !this.onScreen(s)) {
        if (mark) mark.hidden = true;
        continue;
      }
      if (!mark) {
        mark = document.createElement('span');
        mark.className = 'proto-map-pin';
        mark.setAttribute('aria-hidden', 'true');
        mark.style.setProperty('--glyph', glyphUrl('orbitPin'));
        mark.dataset.id = id;
        this.host.append(mark);
        this.pinMarks.set(id, mark);
      }
      mark.hidden = false;
      mark.style.left = `${this.canvas.offsetLeft + s.x + s.r * 0.7}px`;
      mark.style.top = `${this.canvas.offsetTop + s.y - s.r * 0.7}px`;
    }
  }

  /** What a card says of a star without the core: its item (08 §6.2). */
  private cardItem(b: number): CardItem | null {
    const space = this.space;
    const id = space?.ids[b];
    const item = id === undefined ? undefined : this.items.get(id);
    if (!space || !item || id === undefined) return null;
    const kind = item.kind;
    return {
      id,
      name: item.name,
      kind,
      status: item.status,
      deadline: item.deadline,
      inside: isCluster(space.x.kind[b] ?? 0) ? (space.x.subtreeSize[b] ?? 1) - 1 : undefined,
    };
  }

  /** The full card of star `b` (08 §6.2); `held` — while the middle button holds it. */
  private showFull(b: number, held: boolean): void {
    const nav = this.nav;
    const item = this.cardItem(b);
    if (!nav || !item) return;
    if (this.full?.id === item.id) {
      this.full.held = held;
      return;
    }
    if (this.full?.kept) return;
    this.closeFull();
    const make = (d: NodeDetails | null) =>
      fullCard(item, d, nav.words(), {
        person: nav.person,
        keys: (d?.children ?? [])
          .filter((c) => (this.space?.x.flags[this.space.body.get(c.id) ?? -1] ?? 0) & FLAG.key)
          .slice(0, 5)
          .map((c) => c.name),
        onClose: () => this.closeFull(),
      });
    const known = this.details.get(item.id) ?? null;
    const el = make(known);
    this.host.append(el);
    this.full = { id: item.id, el, kept: false, held };
    this.briefs.get(item.id)?.remove();
    this.briefs.delete(item.id);
    if (known) return;
    // The fields from the core, by id (08 §6.2: ≤ 50 ms after the threshold).
    void nav
      .details(item.id)
      .then((d) => {
        if (this.details.size > 500) this.details.clear();
        this.details.set(item.id, d);
        if (this.full?.id !== item.id) return;
        const now = make(d);
        this.full.el.replaceWith(now);
        this.full.el = now;
        this.placeCards();
      })
      .catch(() => undefined);
  }

  /** `Shift+I` (08 §5.2): the full card stays, or goes back to following. */
  private keepCard(): void {
    if (!this.full) {
      const b = this.hovered ?? this.selected;
      if (b === null) return;
      this.showFull(b, false);
    }
    if (!this.full) return;
    this.full.kept = !this.full.kept;
    this.full.el.classList.toggle('is-kept', this.full.kept);
    this.draw();
  }

  private closeFull(): void {
    this.full?.el.remove();
    this.full = null;
    this.placeLabels();
  }

  private closeCards(): void {
    this.closeFull();
    for (const el of this.briefs.values()) el.remove();
    this.briefs.clear();
  }

  /**
   * The cards by their stars (08 §6.2): brief ones by the five stars wider
   * than 96 px nearest the screen's centre, the full one by its star; each
   * right of its star, or left when there is no room, clear of the others.
   */
  private placeCards(): void {
    const { space, nav } = this;
    if (!space || !nav || this.state !== '3d') return;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const ppu = this.pxPerUnit();
    const near: { b: number; d: number }[] = [];
    for (let b = 0; b < space.x.count; b++) {
      const depth = this.scr[b * 3 + 2] ?? 0;
      if (depth <= 0) continue;
      if ((this.starSize(b) * ppu) / depth < BRIEF_PX) continue;
      const x = this.scr[b * 3] ?? 0;
      const y = this.scr[b * 3 + 1] ?? 0;
      if (x < 0 || y < 0 || x > w || y > h) continue;
      near.push({ b, d: Math.hypot(x - w / 2, y - h / 2) });
    }
    near.sort((a, c) => a.d - c.d);
    const want = new Set<string>();
    for (const { b } of near) {
      const id = space.ids[b] ?? '';
      if (id === this.full?.id) continue;
      want.add(id);
      if (want.size >= BRIEF_MAX) break;
    }
    for (const [id, el] of this.briefs) {
      if (want.has(id)) continue;
      el.remove();
      this.briefs.delete(id);
    }
    const words = nav.words();
    for (const id of want) {
      if (this.briefs.has(id)) continue;
      const b = space.body.get(id);
      const item = b === undefined ? null : this.cardItem(b);
      if (!item) continue;
      const el = briefCard(item, words);
      this.host.append(el);
      this.briefs.set(id, el);
    }
    // The full card's star off the screen: the card goes, unless kept.
    const full = this.full;
    if (full) {
      const b = space.body.get(full.id);
      const s = b === undefined ? null : this.local3(b);
      if (!s || !this.onScreen(s)) {
        if (!full.kept) this.closeFull();
        else full.el.hidden = true;
      } else {
        full.el.hidden = false;
      }
    }
    const taken: { x: number; y: number; w: number; h: number }[] = [];
    const place = (el: HTMLElement, id: string) => {
      const b = space.body.get(id);
      const s = b === undefined ? null : this.local3(b);
      if (!s || el.hidden) return;
      const cw = el.offsetWidth;
      const ch = el.offsetHeight;
      const gap = 12;
      let x = s.x + s.r + gap;
      if (x + cw > w - 8) x = s.x - s.r - gap - cw;
      x = Math.max(8, Math.min(x, w - cw - 8));
      let y = Math.max(8, Math.min(s.y - 12, h - ch - 8));
      // Clear of the cards already placed: below the one it would cover.
      for (let moved = true, guard = 0; moved && guard < 12; guard++) {
        moved = false;
        for (const t of taken) {
          if (x < t.x + t.w && x + cw > t.x && y < t.y + t.h && y + ch > t.y) {
            y = t.y + t.h + 4;
            moved = true;
          }
        }
      }
      taken.push({ x, y, w: cw, h: ch });
      el.style.left = `${this.canvas.offsetLeft + x}px`;
      el.style.top = `${this.canvas.offsetTop + y}px`;
    };
    if (this.full && !this.full.el.hidden) place(this.full.el, this.full.id);
    for (const [id, el] of this.briefs) place(el, id);
    this.placeLabels();
  }
}

/** The palette's and the menu's actions on the map (09 §3.5). */
export type MapAction =
  | 'create'
  | 'open'
  | 'into'
  | 'up'
  | 'overview'
  | 'frame'
  | 'card'
  | 'pin'
  | 'flag:key'
  | 'flag:pause'
  | 'flag:template'
  | 'delete'
  | 'deleteEverywhere';

const FLY_KEYS = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'KeyQ',
  'KeyE',
  'ShiftLeft',
  'ShiftRight',
]);

/** The space as the map last laid it out: nodes, their parents, wires and looks. */
function signatureOf(items: readonly MapItem[], wires: readonly SpaceWire[]): string {
  const nodes = items
    .map((i) => `${i.id}${i.parent ?? ''}${i.kind}${i.flags ?? 0}${i.due ?? ''}${i.status ?? ''}`)
    .join();
  return `${nodes}|${wires.map((w) => w.from + w.to).join()}`;
}

function readPins(workspace: string): Map<string, [number, number, number]> {
  const out = new Map<string, [number, number, number]>();
  try {
    const v = JSON.parse(readLocal(pinsKey(workspace)) ?? '{}') as Record<string, unknown>;
    for (const [id, p] of Object.entries(v)) {
      if (Array.isArray(p) && p.length === 3 && p.every((c) => Number.isFinite(c))) {
        out.set(id, [p[0], p[1], p[2]]);
      }
    }
  } catch {
    // A broken note of the device: no pins.
  }
  return out;
}

function writePins(workspace: string, pins: Map<string, [number, number, number]>): void {
  writeLocal(pinsKey(workspace), JSON.stringify(Object.fromEntries(pins)));
}
