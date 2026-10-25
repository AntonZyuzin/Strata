import {
  canInsert,
  downstream,
  extract,
  type Graph,
  type GraphNode,
  insertIntoWire,
  type NodeKind,
  newId,
  newNode,
  shake,
  type WireShape,
} from '@strata/backend';
import { fog } from '@strata/design-tokens';
import RBush from 'rbush';
import { closest, controls, crossing, pointAt, type WireEnds, bounds as wireBounds } from './curve';
import { HEX_IN, hexCorners, hexDist, rimAt } from './hex';
import { SHAKE_SWING_PX, ShakeDetector } from './shake';
import { type CanvasView, NORMAL_WIRE, radiusOf } from './view';
import type { WireStyle } from './wires';

/**
 * Input layer and gestures of the canvas (06 §1–§6, 15 §4.1 rule 5): pointer,
 * wheel and keys go through our hit test, not Pixi's event system. Each
 * gesture is one changeset and one undo step (06 §1.2). The Chrome (Tab menu,
 * name input, toasts, hints) is React; the editor asks for it through events.
 */

/** 06 §1.3 */
const DRAG_PX = 4;
const MIN_HIT_PX = 12; // a 24 × 24 target at least (07 §4.10, NFR-99)
const WIRE_HIT_PX = 6;
const DROP_PX = 6;
const DROP_HOLD_MS = 200;
const DOUBLE_CLICK_MS = 400;
const PORT_RING = (rs: number) => Math.max(8, 0.25 * rs);
/** 06 §6.4: neighbours downstream shift by 2·r(X) + 24 along A → B. */
const INSERT_GAP = 24;
/** autoPlace (06 §5.4) for a top-down network. */
const PLACE_DOWN = 110;
const PLACE_GAP = 16;
/** Scissors (06 §6.7): a stroke point every 3 px; dashes of the stroke, px, and of a crossed wire, u (07 §5). */
const CUT_STEP_PX = 3;
const STROKE_DASH = 4;
const CUT_DASH = 4;
/** Mod of the gestures (06 §17): Cmd on macOS, Ctrl elsewhere. */
const MAC = /Mac/.test(navigator.platform);
/** `Shift+S` goes through the styles of 06 §6.2 in the order of its table. */
const WIRE_SHAPES: WireShape[] = ['straight', 'bezier', 'kinetic'];

const PAPER = 0xf2efe6;
const INK = 0x0b0c0e;
const ATTENTION = Number.parseInt(fog.scene.attention.slice(1), 16);
const ACTIVE_WIRE: WireStyle = { color: PAPER, alpha: 1, width: 2, dot: false };
const RUNNING_WIRE: WireStyle = { ...ACTIVE_WIRE, dot: true };
const CANDIDATE_WIRE: WireStyle = { color: ATTENTION, alpha: 1, width: 2.5, dot: false };
/** Crossed by the scissors: dashed, not red — red is only for overdue (06 §6.7). */
const CUT_WIRE: WireStyle = { color: PAPER, alpha: 1, width: 2, dot: false, dash: CUT_DASH };

export type WheelMode = 'mouse' | 'trackpad';

/** What the cursor is over; the status bar shows a hint for it (06 §2.1). */
export type HintKey =
  | 'proto.hint.empty'
  | 'proto.hint.node'
  | 'proto.hint.port'
  | 'proto.hint.wire'
  | 'proto.hint.drag'
  | 'proto.hint.dragInsert'
  | 'proto.hint.wireDrag'
  | 'proto.hint.marquee'
  | 'proto.hint.cut';

export interface EditorEvents {
  /** Open the Tab menu at a screen point; `query` pre-fills it (06 §5.5). */
  tabMenu(e: { sx: number; sy: number; query: string }): void;
  /** Show or hide the inline name input over a node's label slot. */
  nameInput(e: { id: string; sx: number; sy: number; name: string } | null): void;
  toast(e: { key: string; params?: Record<string, string | number> }): void;
  hint(key: HintKey): void;
  /** The graph, the selection or the undo stack changed. */
  change(): void;
  /** `M`: to the star map and back (08 §7, 06 §17). */
  map?(): void;
  /** Double click or `Enter` on a node: open its content (06 §13.1). */
  open?(id: string): void;
  /** `L`: lay out the selection, or the whole network when nothing is selected (06 §9.1). */
  layout?(ids: string[] | null): void;
  /** `U`: out of this network into its parent (06 §1.4). */
  up?(): void;
  /**
   * Undo or redo with nothing left in this graph: a core behind it may
   * still hold steps of other networks (05 §11, the session's undo).
   */
  historyEmpty?(which: 'undo' | 'redo'): void;
  /**
   * The right button (06 §5): a node (selected first), a wire, or the bare
   * canvas at a screen point; the Chrome shows its menu there.
   */
  contextMenu?(e: { sx: number; sy: number; at: MenuTarget }): void;
}

/** What the right button was pressed on. */
export type MenuTarget =
  | { t: 'node'; id: string }
  | { t: 'wire'; from: string; to: string }
  | { t: 'empty' };

export type MenuChoice =
  | {
      t: 'create';
      kind: NodeKind;
      name: string;
      /** Open the name input after creating (the kind's name was used as a placeholder). */
      rename: boolean;
    }
  | { t: 'existing'; id: string };

type Hit =
  | { t: 'node'; id: string }
  | { t: 'port'; id: string; angle: number }
  | { t: 'wire'; from: string; to: string }
  | { t: 'empty' };

interface Candidate {
  from: string;
  to: string;
  since: number;
  /** World point on the curve where the node will land. */
  x: number;
  y: number;
  shifted: Set<string>;
}

type Mode =
  | { t: 'idle' }
  | { t: 'pan'; lastX: number; lastY: number }
  | {
      t: 'press';
      hit: Hit;
      sx: number;
      sy: number;
      button: number;
      alt: boolean;
      shift: boolean;
    }
  | {
      t: 'drag';
      ids: string[];
      grabX: number;
      grabY: number;
      origin: Map<string, { x: number; y: number }>;
      shaker: ShakeDetector | null;
      /** Steps already committed in this gesture: copy, shake. The release amends them. */
      committed: boolean;
      candidate: Candidate | null;
    }
  | {
      t: 'wire';
      sources: string[];
      ex: number;
      ey: number;
      target: string | null;
      twoClick: boolean;
      /**
       * A branch (06 §6.5, «а»): where the wire was grabbed, world units. The
       * new wire comes from the old one's source; the fork shows only now.
       */
      fork: { x: number; y: number } | null;
    }
  | {
      t: 'cut';
      /** The stroke so far, screen px. */
      stroke: { x: number; y: number }[];
      /** Crossed wires by key: their ends. */
      crossed: Map<string, { from: string; to: string }>;
    }
  | {
      t: 'marquee';
      sx0: number;
      sy0: number;
      sx1: number;
      sy1: number;
      mode: 'set' | 'add' | 'sub';
    }
  | {
      t: 'menu';
      ax: number;
      ay: number;
      sources: string[];
      sibling: string | null;
      atAnchor: boolean;
    }
  | { t: 'name'; id: string; created: boolean };

interface NodeBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  id: string;
}
interface WireBox extends NodeBox {
  to: string;
}

export class Editor {
  readonly selection = new Set<string>();
  current: string | null = null;
  wheelMode: WheelMode = /Mac/.test(navigator.platform) ? 'trackpad' : 'mouse';
  /** Swing of the shake in screen px; 0 turns the gesture off (05 §8.4). */
  shakePx = SHAKE_SWING_PX;
  /**
   * Screen px along the right edge that the Chrome covers now (the
   * properties panel): framing and zoom keep to the canvas one can see.
   */
  coveredRight: () => number = () => 0;
  /**
   * The wire comes from a `[[link]]` in text (05 §8.2 rule 4): the scissors
   * leave it alone, it lives while its link is in the text (06 §6.7).
   */
  textWire: (from: string, to: string) => boolean = () => false;
  private mode: Mode = { t: 'idle' };
  private hover: Hit = { t: 'empty' };
  private selectedWire: [string, string] | null = null;
  private pointer = { sx: -1, sy: -1, inside: false };
  private readonly held = new Set<string>();
  private lastClick = { time: 0, sx: 0, sy: 0 };
  private gestureZoom: number | null = null;
  private nodeIndex = new RBush<NodeBox>();
  private wireIndex = new RBush<WireBox>();
  private indexDirty = true;
  private readonly detach: (() => void)[] = [];
  private overlayOpen = false;

  constructor(
    private readonly view: CanvasView,
    private readonly graph: Graph,
    private readonly events: EditorEvents,
  ) {
    view.wireStyle = (from, to) => this.styleOf(from, to);
    view.onFrame = (now) => this.drawOverlay(now);
    view.interaction = () => {
      const h = this.hover;
      const hover = this.mode.t === 'idle' && (h.t === 'node' || h.t === 'port') ? h.id : null;
      return { hover, selection: this.selection, current: this.current };
    };
    this.detach.push(
      view.setGraph(graph),
      graph.subscribe((e) => {
        // A look (a roll-up read back) moves nothing and is no step: the view
        // redraws it; asking the Chrome to read the core again would loop.
        if (e.type === 'look') return;
        this.indexDirty = true;
        for (const id of this.selection) if (!graph.nodes.has(id)) this.selection.delete(id);
        if (this.current && !graph.nodes.has(this.current)) this.current = null;
        this.events.change();
      }),
    );
    this.listen();
  }

  destroy(): void {
    for (const f of this.detach) f();
  }

  /** The React Chrome tells the editor when a menu or input owns the keyboard. */
  setOverlayOpen(open: boolean): void {
    this.overlayOpen = open;
  }

  /**
   * Where a paste lands (06 §12.1, 13 §3.9), in world coordinates, or null
   * while a menu or input owns the keyboard: at the cursor over the canvas,
   * else beside the current node, else mid-view.
   */
  pasteSpot(): { x: number; y: number } | null {
    if (this.overlayOpen || this.mode.t !== 'idle') return null;
    const s = this.anchorScreen();
    return this.view.camera.toWorld(s.sx, s.sy);
  }

  fitAll(): void {
    const box = this.boxOf([...this.graph.nodes.keys()]);
    if (box) this.view.camera.fit(box, this.seen(), this.view.height);
    this.view.invalidate();
  }

  /** Width of the canvas one can see: the Chrome on the right taken off. */
  private seen(): number {
    return Math.max(1, this.view.width - this.coveredRight());
  }

  undo(): void {
    this.cancelGesture();
    if (!this.graph.undo()) this.events.historyEmpty?.('undo');
  }

  redo(): void {
    this.cancelGesture();
    if (!this.graph.redo()) this.events.historyEmpty?.('redo');
  }

  /** «Создать…» of the right-button menu: the Tab menu at that screen point (06 §5). */
  createAt(sx: number, sy: number): void {
    if (this.mode.t !== 'idle') return;
    const w = this.view.camera.toWorld(sx, sy);
    this.openMenu(sx, sy, { ax: w.x, ay: w.y, sources: [], sibling: null, atAnchor: true });
  }

  /** The menu's «Переименовать» (F2). */
  rename(id: string): void {
    if (this.graph.nodes.has(id)) this.openName(id, false);
  }

  /** The menu's «Удалить»: the selection, or the selected wire (Delete). */
  deleteSelected(): void {
    this.deleteSelection();
  }

  /** Nothing selected: the panel's × closes it so (06, «P»). */
  deselect(): void {
    this.selection.clear();
    this.selectedWire = null;
    this.events.change();
    this.view.invalidate();
  }

  /** Selects one node and keeps it in view (the «Структура» tree, the panel's links). */
  focusNode(id: string): void {
    if (!this.graph.nodes.has(id)) return;
    this.select([id]);
    this.frameNodes([id]);
  }

  /** The style `Shift+S` turns the network's wires to next (06 §6.2). */
  get nextWireShape(): WireShape {
    const i = WIRE_SHAPES.indexOf(this.graph.wireShape);
    return WIRE_SHAPES[(i + 1) % WIRE_SHAPES.length] ?? 'bezier';
  }

  /** `Shift+S`: the network's wires in the next style, one step of undo (06 §6.2, 05 §9.2). */
  cycleWireShape(): void {
    if (this.mode.t !== 'idle') return;
    const next = this.nextWireShape;
    const label = { key: `proto.change.wires.${next}` };
    this.graph.transaction(label, (tx) => tx.wireShape(next));
    this.events.toast(label);
    this.indexDirty = true;
    this.view.invalidate();
  }

  // ── Tab menu (06 §5) ──────────────────────────────────────────────

  /** A choice in the Tab menu; `alt` and `shift` are the modifiers of Enter (06 §5.3). */
  menuChoose(choice: MenuChoice): void {
    const m = this.mode;
    if (m.t !== 'menu') return;
    this.mode = { t: 'idle' };
    if (choice.t === 'existing') {
      const node = this.graph.nodes.get(choice.id);
      if (!node) return;
      const sources = m.sources.filter((s) => s !== choice.id);
      if (sources.length > 0) {
        this.graph.transaction(
          { key: 'proto.change.connect', params: { name: node.name } },
          (tx) => {
            for (const s of sources) tx.connect(s, choice.id);
          },
        );
      } else {
        this.frameNodes([choice.id]);
      }
      this.select([choice.id]);
      return;
    }
    const r = radiusOf({ kind: choice.kind, key: false });
    const place = this.placeNew(m, r);
    const node = newNode({
      id: newId(),
      name: choice.name,
      kind: choice.kind,
      icon: this.view.iconFor(choice.kind),
      x: place.x,
      y: place.y,
    });
    const inputs = m.sibling ? this.graph.inputs(m.sibling) : m.sources;
    this.graph.transaction({ key: 'proto.change.create', params: { name: node.name } }, (tx) => {
      tx.add(node);
      for (const s of inputs) tx.connect(s, node.id);
    });
    this.select([node.id]);
    this.follow(node.id);
    if (choice.rename) this.openName(node.id, true);
  }

  menuCancel(): void {
    if (this.mode.t === 'menu') this.mode = { t: 'idle' };
    this.view.invalidate();
  }

  // ── Name input (06 §5.5) ──────────────────────────────────────────

  nameCommit(name: string): void {
    const m = this.mode;
    if (m.t !== 'name') return;
    this.mode = { t: 'idle' };
    this.events.nameInput(null);
    const trimmed = name.trim();
    if (trimmed === '') {
      // An empty name cancels a node made by this gesture: no node, no wire, no step.
      if (m.created) this.graph.revertLast();
      return;
    }
    if (m.created) {
      this.graph.amend((tx) => tx.rename(m.id, trimmed), {
        key: 'proto.change.create',
        params: { name: trimmed },
      });
    } else {
      this.graph.transaction({ key: 'proto.change.rename', params: { name: trimmed } }, (tx) =>
        tx.rename(m.id, trimmed),
      );
    }
  }

  nameCancel(): void {
    const m = this.mode;
    if (m.t !== 'name') return;
    this.mode = { t: 'idle' };
    this.events.nameInput(null);
    if (m.created) this.graph.revertLast();
  }

  /** `Tab` or `/` in the name input turns it into the Tab menu with the text as the query. */
  nameToMenu(text: string): void {
    const m = this.mode;
    if (m.t !== 'name' || !m.created) return;
    const node = this.graph.nodes.get(m.id);
    const sources = this.graph.inputs(m.id);
    this.events.nameInput(null);
    this.graph.revertLast();
    if (!node) return;
    const s = this.view.camera.toScreen(node.x, node.y);
    this.openMenu(
      s.x,
      s.y,
      { ax: node.x, ay: node.y, sources, sibling: null, atAnchor: true },
      text,
    );
  }

  // ── Input ─────────────────────────────────────────────────────────

  private listen() {
    const el = this.view.canvas;
    el.tabIndex = 0;
    const on = <K extends keyof HTMLElementEventMap>(
      target: HTMLElement | Window,
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void,
      opts?: AddEventListenerOptions,
    ) => {
      target.addEventListener(type, fn as EventListener, opts);
      this.detach.push(() => target.removeEventListener(type, fn as EventListener, opts));
    };
    on(el, 'pointerdown', (e) => this.onDown(e));
    on(el, 'pointermove', (e) => this.onMove(e));
    on(el, 'pointerup', (e) => this.onUp(e));
    on(el, 'pointercancel', () => this.cancelGesture());
    on(el, 'pointerleave', () => {
      this.pointer.inside = false;
    });
    on(el, 'contextmenu', (e) => {
      e.preventDefault();
      // Mod + the right button is the scissors' alias (06 §6.7), not the menu.
      if (this.mode.t !== 'idle' || this.overlayOpen || cutMod(e)) return;
      const { sx, sy } = this.local(e);
      const hit = this.hitTest(sx, sy);
      let at: MenuTarget = { t: 'empty' };
      if (hit.t === 'node' || hit.t === 'port') {
        if (!this.selection.has(hit.id)) this.select([hit.id]);
        else this.current = hit.id;
        at = { t: 'node', id: hit.id };
      } else if (hit.t === 'wire') {
        this.select([]);
        this.selectedWire = [hit.from, hit.to];
        at = { t: 'wire', from: hit.from, to: hit.to };
      }
      this.view.invalidate();
      this.events.contextMenu?.({ sx, sy, at });
    });
    on(el, 'wheel', (e) => this.onWheel(e), { passive: false });
    // WebKit delivers trackpad pinch as gesture events (06 §3).
    on(el, 'gesturestart' as keyof HTMLElementEventMap, (e) => {
      e.preventDefault();
      this.gestureZoom = this.view.camera.zoom;
    });
    on(el, 'gesturechange' as keyof HTMLElementEventMap, (e) => {
      e.preventDefault();
      const g = e as unknown as { scale: number; clientX: number; clientY: number };
      if (this.gestureZoom === null) return;
      const rect = el.getBoundingClientRect();
      const target = this.gestureZoom * g.scale;
      this.view.camera.zoomAt(
        g.clientX - rect.left,
        g.clientY - rect.top,
        target / this.view.camera.zoom,
      );
      this.view.invalidate();
    });
    on(el, 'gestureend' as keyof HTMLElementEventMap, (e) => {
      e.preventDefault();
      this.gestureZoom = null;
    });
    on(window, 'keydown', (e) => this.onKey(e), { capture: true });
    on(window, 'keyup', (e) => {
      this.held.delete(e.code);
      if (e.code === 'Digit8') this.view.invalidate();
      if (e.code === 'KeyY') this.scissorsCursor();
    });
    on(window, 'blur', () => {
      this.held.clear();
      this.scissorsCursor();
    });
  }

  private local(e: { clientX: number; clientY: number }) {
    const r = this.view.canvas.getBoundingClientRect();
    return { sx: e.clientX - r.left, sy: e.clientY - r.top };
  }

  private onDown(e: PointerEvent) {
    const { sx, sy } = this.local(e);
    this.view.canvas.focus({ preventScroll: true });
    const m = this.mode;
    if (m.t === 'wire' && m.twoClick && e.button === 0) {
      this.finishWire(sx, sy);
      return;
    }
    if (m.t === 'menu' || m.t === 'name') return;
    this.view.canvas.setPointerCapture(e.pointerId);
    if (e.button === 1 || (e.button === 0 && this.held.has('Space'))) {
      e.preventDefault(); // no autoscroll on Windows
      this.mode = { t: 'pan', lastX: sx, lastY: sy };
      return;
    }
    // Scissors (06 §6.7): hold `Y` and stroke with the left button, or Mod + the right.
    if ((e.button === 0 && this.held.has('KeyY')) || (e.button === 2 && cutMod(e))) {
      e.preventDefault();
      this.mode = { t: 'cut', stroke: [{ x: sx, y: sy }], crossed: new Map() };
      this.events.hint('proto.hint.cut');
      this.view.invalidate();
      return;
    }
    if (e.button !== 0) return;
    this.mode = {
      t: 'press',
      hit: this.hitTest(sx, sy),
      sx,
      sy,
      button: e.button,
      alt: e.altKey,
      shift: e.shiftKey,
    };
  }

  private onMove(e: PointerEvent) {
    const { sx, sy } = this.local(e);
    this.pointer = { sx, sy, inside: true };
    const m = this.mode;
    switch (m.t) {
      case 'idle': {
        const hit = this.hitTest(sx, sy);
        if (!sameHit(hit, this.hover)) {
          this.hover = hit;
          this.events.hint(hintOf(hit));
        }
        this.view.invalidate();
        return;
      }
      case 'pan':
        this.view.camera.panBy(sx - m.lastX, sy - m.lastY);
        m.lastX = sx;
        m.lastY = sy;
        this.view.invalidate();
        return;
      case 'press':
        if (Math.hypot(sx - m.sx, sy - m.sy) >= DRAG_PX) this.startDrag(m, sx, sy, e);
        return;
      case 'drag':
        this.dragTo(m, sx, sy, e);
        return;
      case 'wire': {
        const w = this.view.camera.toWorld(sx, sy);
        m.ex = w.x;
        m.ey = w.y;
        const hit = this.hitTest(sx, sy);
        const id = hit.t === 'node' || hit.t === 'port' ? hit.id : null;
        m.target = id && !m.sources.includes(id) ? id : null;
        this.view.invalidate();
        return;
      }
      case 'marquee':
        m.sx1 = sx;
        m.sy1 = sy;
        this.view.invalidate();
        return;
      case 'cut':
        this.cutTo(m, sx, sy);
        return;
      default:
        return;
    }
  }

  private onUp(e: PointerEvent) {
    const { sx, sy } = this.local(e);
    const m = this.mode;
    switch (m.t) {
      case 'pan':
        this.mode = { t: 'idle' };
        return;
      case 'press':
        this.mode = { t: 'idle' };
        this.click(m.hit, sx, sy, e);
        return;
      case 'drag':
        this.dropDrag(m);
        return;
      case 'wire':
        if (!m.twoClick) this.finishWire(sx, sy);
        return;
      case 'marquee':
        this.finishMarquee(m);
        return;
      case 'cut':
        this.cutTo(m, sx, sy);
        this.finishCut(m);
        return;
      default:
        return;
    }
  }

  private click(hit: Hit, sx: number, sy: number, e: PointerEvent) {
    const mod = e.metaKey || e.ctrlKey;
    // When the click happened, not when it is handled: a busy frame between
    // the two clicks of a double click must not split it.
    const now = e.timeStamp;
    const double =
      now - this.lastClick.time < DOUBLE_CLICK_MS &&
      Math.hypot(sx - this.lastClick.sx, sy - this.lastClick.sy) <= DRAG_PX;
    this.lastClick = { time: now, sx, sy };
    if (hit.t === 'port') {
      // A click on the port without moving: the wire is "in hand" (06 §6.1, two-click mode).
      const w = this.view.camera.toWorld(sx, sy);
      this.mode = {
        t: 'wire',
        sources: this.sourcesFor(hit.id),
        ex: w.x,
        ey: w.y,
        target: null,
        twoClick: true,
        fork: null,
      };
      this.events.hint('proto.hint.wireDrag');
      this.view.invalidate();
      return;
    }
    if (hit.t === 'node') {
      if (double && !e.shiftKey && !mod) {
        this.select([hit.id]);
        this.current = hit.id;
        this.events.change();
        this.view.invalidate();
        this.events.open?.(hit.id);
        return;
      }
      if (e.shiftKey) this.selection.add(hit.id);
      else if (mod) {
        if (this.selection.has(hit.id)) this.selection.delete(hit.id);
        else this.selection.add(hit.id);
      } else this.select([hit.id]);
      this.current = hit.id;
      this.selectedWire = null;
      this.events.change();
      this.view.invalidate();
      return;
    }
    if (hit.t === 'wire') {
      this.selectedWire = [hit.from, hit.to];
      this.selection.clear();
      this.events.change();
      this.view.invalidate();
      return;
    }
    // Empty: the first click clears the selection, the second creates (06 §5.1).
    this.selection.clear();
    this.selectedWire = null;
    this.events.change();
    this.view.invalidate();
    if (double) {
      const w = this.view.camera.toWorld(sx, sy);
      this.openMenu(sx, sy, { ax: w.x, ay: w.y, sources: [], sibling: null, atAnchor: true });
    }
  }

  private startDrag(m: Extract<Mode, { t: 'press' }>, sx: number, sy: number, e: PointerEvent) {
    const hit = m.hit;
    if (hit.t === 'port') {
      const w = this.view.camera.toWorld(sx, sy);
      this.mode = {
        t: 'wire',
        sources: this.sourcesFor(hit.id),
        ex: w.x,
        ey: w.y,
        target: null,
        twoClick: false,
        fork: null,
      };
      this.events.hint('proto.hint.wireDrag');
      return;
    }
    if (hit.t === 'wire' && m.shift) {
      // A branch from the middle of A → B (06 §6.5, «а»): a new wire from A.
      const grab = this.view.camera.toWorld(m.sx, m.sy);
      const at = closest(this.wireEnds(hit.from, hit.to), grab.x, grab.y);
      const w = this.view.camera.toWorld(sx, sy);
      this.selectedWire = null;
      this.mode = {
        t: 'wire',
        sources: [hit.from],
        ex: w.x,
        ey: w.y,
        target: null,
        twoClick: false,
        fork: { x: at.x, y: at.y },
      };
      this.events.hint('proto.hint.wireDrag');
      this.view.invalidate();
      return;
    }
    if (hit.t === 'node') {
      if (!this.selection.has(hit.id)) this.select([hit.id]);
      this.current = hit.id;
      let ids = [...this.selection];
      let committed = false;
      if (m.alt) {
        // Alt-drag: an independent copy of the selection follows the cursor (06 §12.1).
        ids = this.copyNodes(ids);
        committed = ids.length > 0;
        this.select(ids);
      }
      const grab = this.view.camera.toWorld(m.sx, m.sy);
      const origin = new Map<string, { x: number; y: number }>();
      for (const id of ids) {
        const p = this.view.nodeAt(id);
        if (p) origin.set(id, { x: p.x, y: p.y });
      }
      this.mode = {
        t: 'drag',
        ids,
        grabX: grab.x,
        grabY: grab.y,
        origin,
        shaker: ids.length === 1 ? new ShakeDetector(sx, sy, this.shakePx) : null,
        committed,
        candidate: null,
      };
      this.events.hint('proto.hint.drag');
      this.dragTo(this.mode, sx, sy, e);
      return;
    }
    // From empty space: marquee (06 §11).
    const mod = e.metaKey || e.ctrlKey;
    this.mode = {
      t: 'marquee',
      sx0: m.sx,
      sy0: m.sy,
      sx1: sx,
      sy1: sy,
      mode: e.shiftKey ? 'add' : mod ? 'sub' : 'set',
    };
    this.events.hint('proto.hint.marquee');
  }

  private dragTo(m: Extract<Mode, { t: 'drag' }>, sx: number, sy: number, e: PointerEvent) {
    const w = this.view.camera.toWorld(sx, sy);
    const dx = w.x - m.grabX;
    const dy = w.y - m.grabY;
    for (const [id, o] of m.origin) this.view.place(id, o.x + dx, o.y + dy);
    const single = m.ids.length === 1 ? m.ids[0] : undefined;
    if (single === undefined) return;
    // Shake: the node comes out of its chains, still on the cursor (06 §6.7).
    const samples = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    for (const s of samples.length > 0 ? samples : [e]) {
      const p = this.local(s);
      if (m.shaker?.feed(p.sx, p.sy, s.timeStamp)) this.shakeOut(m, single);
    }
    this.updateCandidate(m, single);
  }

  private shakeOut(m: Extract<Mode, { t: 'drag' }>, id: string) {
    const node = this.graph.nodes.get(id);
    if (!node) return;
    let result = { inputs: 0, healed: false };
    const label = { key: 'proto.change.shake', params: { name: node.name } };
    const step = (tx: Parameters<Parameters<Graph['transaction']>[1]>[0]) => {
      result = shake(this.graph, tx, id);
    };
    if (m.committed) this.graph.amend(step, label);
    else m.committed = this.graph.transaction(label, step) !== null;
    if (result.inputs >= 2) {
      this.events.toast({ key: 'proto.toast.notHealed', params: { n: result.inputs } });
    }
    this.events.hint('proto.hint.dragInsert');
  }

  /** Drop candidate: the wire nearest the dragged bubble, held 200 ms (06 §6.4). */
  private updateCandidate(m: Extract<Mode, { t: 'drag' }>, id: string) {
    this.refreshIndex();
    const p = this.view.nodeAt(id);
    if (!p || !canInsert(this.graph, id)) {
      m.candidate = null;
      return;
    }
    const reach = p.r + DROP_PX / this.view.camera.zoom;
    let best: { from: string; to: string; dist: number; x: number; y: number } | null = null;
    for (const b of this.wireIndex.search({
      minX: p.x - reach,
      minY: p.y - reach,
      maxX: p.x + reach,
      maxY: p.y + reach,
    })) {
      if (b.id === id || b.to === id) continue;
      const c = closest(this.wireEnds(b.id, b.to), p.x, p.y);
      if (c.dist <= reach && (!best || c.dist < best.dist)) best = { from: b.id, to: b.to, ...c };
    }
    if (!best) {
      m.candidate = null;
      return;
    }
    if (!m.candidate || m.candidate.from !== best.from || m.candidate.to !== best.to) {
      const shifted = downstream(this.graph, best.to);
      shifted.delete(best.from);
      shifted.delete(id);
      m.candidate = {
        from: best.from,
        to: best.to,
        since: performance.now(),
        x: best.x,
        y: best.y,
        shifted,
      };
    } else {
      m.candidate.x = best.x;
      m.candidate.y = best.y;
    }
    this.view.invalidate();
  }

  private candidateReady(m: Extract<Mode, { t: 'drag' }>, now: number): boolean {
    return (
      m.candidate !== null && now - m.candidate.since >= DROP_HOLD_MS && !this.held.has('Digit8')
    );
  }

  private dropDrag(m: Extract<Mode, { t: 'drag' }>) {
    this.mode = { t: 'idle' };
    const single = m.ids.length === 1 ? m.ids[0] : undefined;
    const c = m.candidate;
    const positions = m.ids.map((id) => ({ id, p: this.view.nodeAt(id) }));
    if (single !== undefined && c && this.candidateReady(m, performance.now())) {
      const node = this.graph.nodes.get(single);
      const a = this.view.nodeAt(c.from);
      const b = this.view.nodeAt(c.to);
      if (node && a && b) {
        const len = Math.max(Math.hypot(b.x - a.x, b.y - a.y), 1e-4);
        const shift = 2 * radiusOf(node) + INSERT_GAP;
        const ux = ((b.x - a.x) / len) * shift;
        const uy = ((b.y - a.y) / len) * shift;
        const from = this.graph.nodes.get(c.from)?.name ?? '';
        const to = this.graph.nodes.get(c.to)?.name ?? '';
        const label = { key: 'proto.change.insert', params: { name: node.name, from, to } };
        const step = (tx: Parameters<Parameters<Graph['transaction']>[1]>[0]) => {
          tx.move(single, c.x, c.y);
          for (const id of c.shifted) {
            const n = this.graph.nodes.get(id);
            if (n) tx.move(id, n.x + ux, n.y + uy);
          }
          insertIntoWire(this.graph, tx, single, c.from, c.to);
        };
        if (m.committed) this.graph.amend(step, label);
        else this.graph.transaction(label, step);
        this.afterGesture();
        return;
      }
    }
    const label =
      m.ids.length === 1
        ? {
            key: 'proto.change.move',
            params: { name: this.graph.nodes.get(m.ids[0] ?? '')?.name ?? '' },
          }
        : { key: 'proto.change.moveMany', params: { n: m.ids.length } };
    const step = (tx: Parameters<Parameters<Graph['transaction']>[1]>[0]) => {
      for (const { id, p } of positions) if (p) tx.move(id, p.x, p.y);
    };
    if (m.committed) this.graph.amend(step);
    else this.graph.transaction(label, step);
    this.afterGesture();
  }

  private finishWire(sx: number, sy: number) {
    const m = this.mode;
    if (m.t !== 'wire') return;
    this.mode = { t: 'idle' };
    const hit = this.hitTest(sx, sy);
    const target = hit.t === 'node' || hit.t === 'port' ? hit.id : null;
    if (target && !m.sources.includes(target)) {
      const name = this.graph.nodes.get(target)?.name ?? '';
      const made = this.graph.transaction(
        { key: 'proto.change.connect', params: { name } },
        (tx) => {
          for (const s of m.sources) tx.connect(s, target);
        },
      );
      if (!made) this.events.toast({ key: 'proto.toast.exists' });
      this.afterGesture();
      return;
    }
    if (target) {
      this.afterGesture();
      return;
    }
    // Released on empty space: a note at once, then its name (06 §5.5, ☑ Q-06-2).
    const w = this.view.camera.toWorld(sx, sy);
    const node = newNode({
      id: newId(),
      name: '',
      kind: 'note',
      icon: this.view.iconFor('note'),
      x: w.x,
      y: w.y,
    });
    this.graph.transaction({ key: 'proto.change.create', params: { name: '' } }, (tx) => {
      tx.add(node);
      for (const s of m.sources) tx.connect(s, node.id);
    });
    this.select([node.id]);
    this.openName(node.id, true);
  }

  private finishMarquee(m: Extract<Mode, { t: 'marquee' }>) {
    this.mode = { t: 'idle' };
    const a = this.view.camera.toWorld(Math.min(m.sx0, m.sx1), Math.min(m.sy0, m.sy1));
    const b = this.view.camera.toWorld(Math.max(m.sx0, m.sx1), Math.max(m.sy0, m.sy1));
    this.refreshIndex();
    const hits = this.nodeIndex
      .search({ minX: a.x, minY: a.y, maxX: b.x, maxY: b.y })
      .map((h) => h.id);
    if (m.mode === 'set') this.selection.clear();
    for (const id of hits) {
      if (m.mode === 'sub') this.selection.delete(id);
      else this.selection.add(id);
    }
    this.afterGesture();
  }

  /** The stroke goes on to (sx, sy): wires it crosses on the way are marked (06 §6.7). */
  private cutTo(m: Extract<Mode, { t: 'cut' }>, sx: number, sy: number) {
    const last = m.stroke.at(-1);
    if (!last || Math.hypot(sx - last.x, sy - last.y) < CUT_STEP_PX) return;
    m.stroke.push({ x: sx, y: sy });
    this.refreshIndex();
    const cam = this.view.camera;
    const p = cam.toWorld(last.x, last.y);
    const q = cam.toWorld(sx, sy);
    for (const b of this.wireIndex.search({
      minX: Math.min(p.x, q.x),
      minY: Math.min(p.y, q.y),
      maxX: Math.max(p.x, q.x),
      maxY: Math.max(p.y, q.y),
    })) {
      const key = wireKey(b.id, b.to);
      if (m.crossed.has(key) || this.textWire(b.id, b.to)) continue;
      if (crossing(this.wireEnds(b.id, b.to), p.x, p.y, q.x, q.y)) {
        m.crossed.set(key, { from: b.id, to: b.to });
      }
    }
    this.view.invalidate();
  }

  /** Every wire the stroke crossed goes, one step of undo (05 §8.4 «Разрезать ножом»). */
  private finishCut(m: Extract<Mode, { t: 'cut' }>) {
    this.mode = { t: 'idle' };
    const cut = [...m.crossed.values()];
    if (cut.length > 0) {
      this.graph.transaction({ key: 'proto.change.cut', params: { n: cut.length } }, (tx) => {
        for (const w of cut) tx.disconnect(w.from, w.to);
      });
      if (this.selectedWire && m.crossed.has(wireKey(...this.selectedWire))) {
        this.selectedWire = null;
      }
    }
    this.afterGesture();
  }

  /** A cross-hair while `Y` is held over the canvas: the left button cuts now. */
  private scissorsCursor() {
    this.view.canvas.style.cursor = this.held.has('KeyY') ? 'crosshair' : '';
  }

  private onWheel(e: WheelEvent) {
    e.preventDefault();
    const { sx, sy } = this.local(e);
    const cam = this.view.camera;
    const scale = e.deltaMode === 1 ? 16 : 1;
    if (e.ctrlKey) {
      // Pinch in Chromium and WebView2 arrives as ctrl+wheel (06 §3).
      if (this.gestureZoom === null) cam.zoomAt(sx, sy, Math.exp(-e.deltaY * scale * 0.01));
    } else if (this.wheelMode === 'trackpad') {
      cam.panBy(-e.deltaX * scale, -e.deltaY * scale);
    } else if (e.shiftKey) {
      cam.panBy(-(e.deltaY || e.deltaX) * scale, 0);
    } else {
      cam.zoomAt(sx, sy, Math.exp(-e.deltaY * scale * 0.0015));
    }
    this.view.invalidate();
  }

  private onKey(e: KeyboardEvent) {
    if (e.isComposing || this.overlayOpen) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const mod = e.metaKey || e.ctrlKey;
    if (!e.repeat) this.held.add(e.code);
    const cam = this.view.camera;
    switch (e.code) {
      case 'Tab': {
        e.preventDefault();
        this.tabKey(e.shiftKey);
        return;
      }
      case 'Escape':
        if (this.mode.t !== 'idle') this.cancelGesture();
        else {
          this.selection.clear();
          this.selectedWire = null;
          this.events.change();
        }
        this.view.invalidate();
        return;
      case 'KeyZ':
        if (!mod) return;
        e.preventDefault();
        if (e.shiftKey) this.redo();
        else this.undo();
        return;
      case 'KeyX':
        if (!(mod && e.shiftKey)) return;
        e.preventDefault();
        this.extractSelection();
        return;
      case 'KeyA':
        if (!mod) return;
        e.preventDefault();
        this.select([...this.graph.nodes.keys()]);
        return;
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        this.deleteSelection();
        return;
      case 'F2':
        if (this.current) this.openName(this.current, false);
        return;
      case 'KeyH':
        if (mod) return;
        this.fitAll();
        return;
      case 'KeyM':
        if (mod) return;
        this.events.map?.();
        return;
      case 'KeyS':
        if (mod || !e.shiftKey) return;
        e.preventDefault();
        this.cycleWireShape();
        return;
      case 'KeyY':
        if (mod) return;
        this.scissorsCursor();
        return;
      case 'KeyL':
        if (mod) return;
        this.events.layout?.(this.selection.size > 0 ? [...this.selection] : null);
        return;
      case 'KeyU':
        if (mod) return;
        this.events.up?.();
        return;
      case 'Enter':
      case 'NumpadEnter':
        if (mod || !this.current) return;
        e.preventDefault();
        this.events.open?.(this.current);
        return;
      case 'KeyG':
      case 'KeyF':
        if (mod) return;
        if (this.selection.size > 0) this.frameNodes([...this.selection]);
        else this.fitAll();
        return;
      case 'Equal':
      case 'NumpadAdd':
        cam.zoomAt(this.seen() / 2, this.view.height / 2, 1.25);
        break;
      case 'Minus':
      case 'NumpadSubtract':
        cam.zoomAt(this.seen() / 2, this.view.height / 2, 1 / 1.25);
        break;
      case 'Digit0':
        cam.zoomAt(this.seen() / 2, this.view.height / 2, 1 / cam.zoom);
        break;
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'ArrowUp':
      case 'ArrowDown': {
        if (!e.shiftKey) return;
        e.preventDefault();
        const step =
          (e.code === 'ArrowLeft' || e.code === 'ArrowRight' ? this.view.width : this.view.height) /
          8;
        const dx = e.code === 'ArrowLeft' ? step : e.code === 'ArrowRight' ? -step : 0;
        const dy = e.code === 'ArrowUp' ? step : e.code === 'ArrowDown' ? -step : 0;
        cam.panBy(dx, dy);
        break;
      }
      default:
        return;
    }
    this.view.invalidate();
  }

  /** `Tab` (06 §5.1): at the free end of a wire being drawn, else at the cursor; `Shift+Tab` — a sibling. */
  private tabKey(shift: boolean) {
    const m = this.mode;
    if (m.t === 'wire') {
      const s = this.view.camera.toScreen(m.ex, m.ey);
      this.openMenu(s.x, s.y, {
        ax: m.ex,
        ay: m.ey,
        sources: m.sources,
        sibling: null,
        atAnchor: true,
      });
      return;
    }
    if (m.t !== 'idle') return;
    const { sx, sy } = this.anchorScreen();
    const w = this.view.camera.toWorld(sx, sy);
    if (shift && this.current && this.selection.size === 1) {
      this.openMenu(sx, sy, {
        ax: w.x,
        ay: w.y,
        sources: [],
        sibling: this.current,
        atAnchor: false,
      });
      return;
    }
    this.openMenu(sx, sy, {
      ax: w.x,
      ay: w.y,
      sources: [...this.selection],
      sibling: null,
      // At the cursor only when it is over the canvas; from the panel or the
      // bar a new node finds a free place beside (review 2026-10-24).
      atAnchor: this.selection.size === 0 && this.pointer.inside,
    });
  }

  private anchorScreen(): { sx: number; sy: number } {
    if (this.pointer.inside) return { sx: this.pointer.sx, sy: this.pointer.sy };
    const p = this.current ? this.view.nodeAt(this.current) : null;
    if (p) {
      const s = this.view.camera.toScreen(p.x, p.y);
      return { sx: s.x, sy: s.y };
    }
    return { sx: this.seen() / 2, sy: this.view.height / 2 };
  }

  private openMenu(sx: number, sy: number, m: Omit<Extract<Mode, { t: 'menu' }>, 't'>, query = '') {
    this.mode = { t: 'menu', ...m };
    this.events.tabMenu({ sx, sy, query });
    this.view.invalidate();
  }

  private openName(id: string, created: boolean) {
    const p = this.view.nodeAt(id);
    const node = this.graph.nodes.get(id);
    if (!p || !node) return;
    this.mode = { t: 'name', id, created };
    const s = this.view.camera.toScreen(p.x, p.y + p.r + 4);
    this.events.nameInput({ id, sx: s.x, sy: s.y, name: node.name });
  }

  private cancelGesture() {
    const m = this.mode;
    this.mode = { t: 'idle' };
    if (m.t === 'drag') {
      // Esc during a drag: positions back, steps of this gesture reverted (06 §1.2).
      if (m.committed) this.graph.revertLast();
      this.view.settle(m.origin.keys());
    }
    if (m.t === 'name') {
      this.events.nameInput(null);
      if (m.created) this.graph.revertLast();
    }
    this.view.invalidate();
  }

  private afterGesture() {
    this.events.change();
    this.events.hint(hintOf(this.hover));
    this.view.invalidate();
  }

  // ── Commands ──────────────────────────────────────────────────────

  private extractSelection() {
    const ids = [...this.selection];
    if (ids.length === 0) return;
    let result = { inputs: 0, healed: false };
    this.graph.transaction({ key: 'proto.change.extract', params: { n: ids.length } }, (tx) => {
      result = extract(this.graph, tx, ids);
    });
    if (result.inputs >= 2)
      this.events.toast({ key: 'proto.toast.notHealed', params: { n: result.inputs } });
  }

  /** `Delete` with healing (06 §6.7, §12.3): extract, then remove; undo brings it back. */
  private deleteSelection() {
    const ids = [...this.selection];
    if (ids.length === 0) {
      const w = this.selectedWire;
      if (!w) return;
      this.graph.transaction({ key: 'proto.change.disconnect' }, (tx) => tx.disconnect(w[0], w[1]));
      this.selectedWire = null;
      return;
    }
    this.graph.transaction({ key: 'proto.change.delete', params: { n: ids.length } }, (tx) => {
      extract(this.graph, tx, ids);
      for (const id of ids) tx.remove(id);
    });
    this.events.toast({ key: 'proto.toast.deleted', params: { n: ids.length } });
  }

  private copyNodes(ids: string[]): string[] {
    const copies: GraphNode[] = [];
    const map = new Map<string, string>();
    for (const id of ids) {
      const n = this.graph.nodes.get(id);
      if (!n) continue;
      const copy = { ...n, id: newId() };
      map.set(id, copy.id);
      copies.push(copy);
    }
    this.graph.transaction({ key: 'proto.change.copy', params: { n: copies.length } }, (tx) => {
      for (const c of copies) tx.add(c);
      // Wires between copied nodes are copied too (06 §12.1).
      for (const [a, b] of this.graph.edges()) {
        const ca = map.get(a);
        const cb = map.get(b);
        if (ca && cb) tx.connect(ca, cb);
      }
    });
    return copies.map((c) => c.id);
  }

  private sourcesFor(id: string): string[] {
    // From a selected node's port: every selected node is a source (06 §6.1).
    return this.selection.has(id) ? [...this.selection] : [id];
  }

  private select(ids: string[]) {
    this.selection.clear();
    for (const id of ids) this.selection.add(id);
    this.current = ids.at(-1) ?? null;
    this.selectedWire = null;
    this.events.change();
    this.view.invalidate();
  }

  // ── Placement and camera ──────────────────────────────────────────

  /** Where a node made from the Tab menu goes (06 §5.4). */
  private placeNew(m: Extract<Mode, { t: 'menu' }>, r: number): { x: number; y: number } {
    if (m.atAnchor) return { x: m.ax, y: m.ay };
    if (m.sibling) {
      const s = this.graph.nodes.get(m.sibling);
      if (s) return this.freeSpot(s.x + 2 * radiusOf(s) + r + PLACE_GAP * 2, s.y, r);
    }
    const parents = m.sources
      .map((id) => this.graph.nodes.get(id))
      .filter((n): n is GraphNode => !!n);
    if (parents.length === 1) {
      const p = parents[0] as GraphNode;
      // Under P, to the right of its last child.
      let x = p.x;
      for (const c of this.graph.outputs(p.id)) {
        const n = this.graph.nodes.get(c);
        if (n && n.y > p.y && n.x + radiusOf(n) + r + PLACE_GAP >= x)
          x = n.x + radiusOf(n) + r + PLACE_GAP * 3;
      }
      return this.freeSpot(x, p.y + PLACE_DOWN, r);
    }
    if (parents.length > 1) {
      const cx = parents.reduce((a, n) => a + n.x, 0) / parents.length;
      const cy = Math.max(...parents.map((n) => n.y));
      return this.freeSpot(cx, cy + PLACE_DOWN, r);
    }
    // No cursor on the canvas and nothing selected: the middle of the canvas
    // one sees, but never on top of a node there.
    return this.freeSpot(m.ax, m.ay, r);
  }

  /** Spiral search with a step of r(M) until nothing is closer than the gap (06 §5.4). */
  private freeSpot(x: number, y: number, r: number): { x: number; y: number } {
    const free = (px: number, py: number) => {
      for (const n of this.graph.nodes.values()) {
        const need = radiusOf(n) + r + PLACE_GAP + 20; // + room for the label below
        if (Math.hypot(n.x - px, n.y - py) < need) return false;
      }
      return true;
    };
    if (free(x, y)) return { x, y };
    for (let ring = 1; ring < 40; ring++) {
      const steps = ring * 8;
      for (let k = 0; k < steps; k++) {
        const a = (k / steps) * Math.PI * 2;
        const px = x + Math.cos(a) * ring * 24;
        const py = y + Math.sin(a) * ring * 24;
        if (free(px, py)) return { x: px, y: py };
      }
    }
    return { x, y };
  }

  /** Moves the camera only if the node left the screen, with a 48 px margin (06 §3). */
  private follow(id: string) {
    const n = this.graph.nodes.get(id);
    if (!n) return;
    const s = this.view.camera.toScreen(n.x, n.y);
    const margin = 48;
    if (
      s.x < margin ||
      s.y < margin ||
      s.x > this.seen() - margin ||
      s.y > this.view.height - margin
    ) {
      this.view.camera.panBy(this.seen() / 2 - s.x, this.view.height / 2 - s.y);
      this.view.invalidate();
    }
  }

  private frameNodes(ids: string[]) {
    const box = this.boxOf(ids);
    if (!box) return;
    const pad = 120;
    this.view.camera.fit(
      { minX: box.minX - pad, minY: box.minY - pad, maxX: box.maxX + pad, maxY: box.maxY + pad },
      this.seen(),
      this.view.height,
    );
    this.view.invalidate();
  }

  private boxOf(ids: string[]) {
    let box: { minX: number; minY: number; maxX: number; maxY: number } | null = null;
    for (const id of ids) {
      const n = this.graph.nodes.get(id);
      if (!n) continue;
      const r = radiusOf(n);
      box = box
        ? {
            minX: Math.min(box.minX, n.x - r),
            minY: Math.min(box.minY, n.y - r),
            maxX: Math.max(box.maxX, n.x + r),
            maxY: Math.max(box.maxY, n.y + r + 20),
          }
        : { minX: n.x - r, minY: n.y - r, maxX: n.x + r, maxY: n.y + r + 20 };
    }
    return box;
  }

  // ── Hit test (15 §4.1 rule 5) ─────────────────────────────────────

  private refreshIndex() {
    if (!this.indexDirty && this.mode.t !== 'drag') return;
    this.indexDirty = false;
    const nodes: NodeBox[] = [];
    for (const [id, p] of this.view.eachNode()) {
      nodes.push({ id, minX: p.x - p.r, minY: p.y - p.r, maxX: p.x + p.r, maxY: p.y + p.r });
    }
    this.nodeIndex = new RBush<NodeBox>().load(nodes);
    const wires: WireBox[] = [];
    for (const [from, to] of this.graph.edges()) {
      const b = wireBounds(this.wireEnds(from, to));
      wires.push({ ...b, id: from, to });
    }
    this.wireIndex = new RBush<WireBox>().load(wires);
  }

  private wireEnds(from: string, to: string): WireEnds {
    const a = this.view.nodeAt(from);
    const b = this.view.nodeAt(to);
    return {
      ax: a?.x ?? 0,
      ay: a?.y ?? 0,
      bx: b?.x ?? 0,
      by: b?.y ?? 0,
      // Both ends run into their sockets on the rim (07 §5).
      ra: a?.r ?? 0,
      rb: b?.r ?? 0,
      straight: this.graph.wireShape === 'straight',
    };
  }

  /**
   * Bubble body over port ring over wire over empty (06 §1.3). Body and port
   * are hexagons (ADR-0011): the hexagonal distance against the inradius.
   */
  private hitTest(sx: number, sy: number): Hit {
    this.refreshIndex();
    const zoom = this.view.camera.zoom;
    const w = this.view.camera.toWorld(sx, sy);
    const reach = (Math.max(MIN_HIT_PX, 36 * zoom) + PORT_RING(36 * zoom)) / zoom;
    let best: { id: string; d: number; r: number } | null = null;
    for (const b of this.nodeIndex.search({
      minX: w.x - reach,
      minY: w.y - reach,
      maxX: w.x + reach,
      maxY: w.y + reach,
    })) {
      const p = this.view.nodeAt(b.id);
      if (!p) continue;
      const d = hexDist(w.x - p.x, w.y - p.y) * zoom;
      if (!best || d < best.d) best = { id: b.id, d, r: p.r };
    }
    if (best) {
      const rs = best.r * zoom;
      const hitR = Math.max(rs * HEX_IN, MIN_HIT_PX);
      if (best.d <= hitR) return { t: 'node', id: best.id };
      if (best.d <= hitR + PORT_RING(rs)) {
        const p = this.view.nodeAt(best.id);
        return { t: 'port', id: best.id, angle: Math.atan2(w.y - (p?.y ?? 0), w.x - (p?.x ?? 0)) };
      }
    }
    const wr = WIRE_HIT_PX / zoom;
    let wire: { from: string; to: string; dist: number } | null = null;
    for (const b of this.wireIndex.search({
      minX: w.x - wr,
      minY: w.y - wr,
      maxX: w.x + wr,
      maxY: w.y + wr,
    })) {
      const c = closest(this.wireEnds(b.id, b.to), w.x, w.y);
      if (c.dist <= wr && (!wire || c.dist < wire.dist))
        wire = { from: b.id, to: b.to, dist: c.dist };
    }
    return wire ? { t: 'wire', from: wire.from, to: wire.to } : { t: 'empty' };
  }

  // ── Drawing (07 §4.5, §5) ─────────────────────────────────────────

  private styleOf(from: string, to: string): WireStyle {
    const m = this.mode;
    if (m.t === 'cut') return m.crossed.has(wireKey(from, to)) ? CUT_WIRE : NORMAL_WIRE;
    if (m.t === 'drag' && m.candidate && m.candidate.from === from && m.candidate.to === to) {
      return this.candidateReady(m, performance.now()) ? CANDIDATE_WIRE : ACTIVE_WIRE;
    }
    const sw = this.selectedWire;
    if (sw && sw[0] === from && sw[1] === to) return RUNNING_WIRE;
    const h = this.hover;
    if (h.t === 'wire' && h.from === from && h.to === to) return RUNNING_WIRE;
    if (this.selection.has(from) || this.selection.has(to)) return RUNNING_WIRE;
    if ((h.t === 'node' || h.t === 'port') && (h.id === from || h.id === to)) return ACTIVE_WIRE;
    return NORMAL_WIRE;
  }

  private drawOverlay(now: number) {
    const g = this.view.overlay;
    const cam = this.view.camera;
    const zoom = cam.zoom;
    const screen = (id: string) => {
      const p = this.view.nodeAt(id);
      if (!p) return null;
      const s = cam.toScreen(p.x, p.y);
      return { x: s.x, y: s.y, r: p.r * zoom };
    };
    // Hover and selection rings are the Decor's (07 §4.5); the port is a gesture (07 §4.8).
    const h = this.hover;
    if (this.mode.t === 'idle' && h.t === 'port') {
      const s = screen(h.id);
      if (s) {
        const out = s.r * rimAt(h.angle) + 1;
        const px = s.x + Math.cos(h.angle) * out;
        const py = s.y + Math.sin(h.angle) * out;
        g.circle(px, py, 4).fill(PAPER).stroke({ color: INK, width: 1 });
      }
    }
    const m = this.mode;
    const straight = this.graph.wireShape === 'straight';
    if (m.t === 'wire') {
      const end = cam.toScreen(m.ex, m.ey);
      for (const src of m.sources) {
        const p = this.view.nodeAt(src);
        if (!p) continue;
        const tgt = m.target ? this.view.nodeAt(m.target) : null;
        // A branch grows out of the fork on the old wire (06 §6.5).
        const from = m.fork ? { x: m.fork.x, y: m.fork.y, r: -1 } : p;
        const c = controls({
          ax: from.x,
          ay: from.y,
          bx: tgt ? tgt.x : m.ex,
          by: tgt ? tgt.y : m.ey,
          ra: from.r + 1,
          rb: tgt ? tgt.r + 1 : 0,
          straight,
        });
        const q = { x: 0, y: 0 };
        for (let i = 0; i <= 16; i++) {
          pointAt(c, i / 16, q);
          const s = cam.toScreen(q.x, q.y);
          if (i === 0) g.moveTo(s.x, s.y);
          else g.lineTo(s.x, s.y);
        }
        g.stroke({ color: PAPER, width: 2 });
      }
      if (m.fork) {
        const f = cam.toScreen(m.fork.x, m.fork.y);
        g.circle(f.x, f.y, 4).fill(PAPER).stroke({ color: INK, width: 1 });
      }
      if (m.target) {
        const s = screen(m.target);
        // 10 px out across the sides, as the selection's ring (ADR-0011).
        if (s) g.poly(hexCorners(s.x, s.y, s.r + 10 / HEX_IN)).stroke({ color: PAPER, width: 2 });
      } else {
        g.circle(end.x, end.y, 3).fill(PAPER);
      }
    }
    if (m.t === 'cut') {
      // The stroke dashed (06 §6.7); the wires it crossed are dashed with serifs (CUT_WIRE).
      dashed(g, m.stroke, STROKE_DASH);
      g.stroke({ color: PAPER, width: 1, alpha: 0.9 });
    }
    if (m.t === 'marquee') {
      const x = Math.min(m.sx0, m.sx1);
      const y = Math.min(m.sy0, m.sy1);
      g.rect(x, y, Math.abs(m.sx1 - m.sx0), Math.abs(m.sy1 - m.sy0))
        .fill({ color: PAPER, alpha: 0.06 })
        .stroke({ color: PAPER, width: 1, alpha: 0.8 });
    }
    if (m.t === 'drag' && m.candidate) {
      if (this.candidateReady(m, now)) {
        // Where the neighbours will move: dashed outlines at 40 % (06 §6.4).
        const node = this.graph.nodes.get(m.ids[0] ?? '');
        const a = this.view.nodeAt(m.candidate.from);
        const b = this.view.nodeAt(m.candidate.to);
        if (node && a && b) {
          const len = Math.max(Math.hypot(b.x - a.x, b.y - a.y), 1e-4);
          const shift = 2 * radiusOf(node) + INSERT_GAP;
          for (const id of m.candidate.shifted) {
            const p = this.view.nodeAt(id);
            if (!p) continue;
            const s = cam.toScreen(
              p.x + ((b.x - a.x) / len) * shift,
              p.y + ((b.y - a.y) / len) * shift,
            );
            g.poly(hexCorners(s.x, s.y, p.r * zoom)).stroke({
              color: ATTENTION,
              width: 1,
              alpha: 0.4,
            });
          }
        }
      } else {
        // Keep drawing until the 200 ms hold turns the candidate yellow.
        this.view.invalidate();
      }
    }
  }
}

/** Mod + the right button cuts (06 §6.7, §17): Cmd on macOS, where Ctrl + click is the right click. */
function cutMod(e: MouseEvent): boolean {
  return MAC ? e.metaKey : e.ctrlKey;
}

function wireKey(from: string, to: string): string {
  return `${from}\u0000${to}`;
}

/** A polyline as dashes and gaps of `dash` px each, added to the path of `g`. */
function dashed(g: CanvasView['overlay'], pts: readonly { x: number; y: number }[], dash: number) {
  let on = true;
  let left = dash;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1] as { x: number; y: number };
    const b = pts[i] as { x: number; y: number };
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    let at = 0;
    while (at < len) {
      const step = Math.min(left, len - at);
      if (on) {
        const k0 = at / len;
        const k1 = (at + step) / len;
        g.moveTo(a.x + (b.x - a.x) * k0, a.y + (b.y - a.y) * k0).lineTo(
          a.x + (b.x - a.x) * k1,
          a.y + (b.y - a.y) * k1,
        );
      }
      at += step;
      left -= step;
      if (left <= 0) {
        on = !on;
        left = dash;
      }
    }
  }
}

function sameHit(a: Hit, b: Hit): boolean {
  if (a.t !== b.t) return false;
  if (a.t === 'node' && b.t === 'node') return a.id === b.id;
  if (a.t === 'port' && b.t === 'port') return a.id === b.id && Math.abs(a.angle - b.angle) < 0.05;
  if (a.t === 'wire' && b.t === 'wire') return a.from === b.from && a.to === b.to;
  return true;
}

function hintOf(hit: Hit): HintKey {
  switch (hit.t) {
    case 'node':
      return 'proto.hint.node';
    case 'port':
      return 'proto.hint.port';
    case 'wire':
      return 'proto.hint.wire';
    default:
      return 'proto.hint.empty';
  }
}
