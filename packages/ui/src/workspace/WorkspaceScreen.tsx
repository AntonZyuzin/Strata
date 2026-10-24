import {
  type AttrKey,
  assetType,
  type ChangeLabel,
  type CoreOp,
  CoreSync,
  followFolds,
  followWires,
  type Graph,
  graphOf,
  type History,
  type HomeBackend,
  isTask,
  type NetworkView,
  type NodeDetails,
  newId,
  newNode,
  type Opened,
  type Person,
  sniffMime,
  type TrashItem,
  type TreeItem,
} from '@strata/backend';
import {
  BACKDROP_SIDE,
  CanvasView,
  Editor,
  type EditorEvents,
  generatePreset,
  type MenuTarget,
  type Pixels,
  processBackdrop,
} from '@strata/canvas';
import { GeckoCompanion, type GeckoHandle } from '@strata/gecko';
import { type Locale, type MessageKey, t } from '@strata/i18n';
import type { LoroDoc } from 'loro-crdt';
import { type MutableRefObject, useCallback, useEffect, useRef, useState } from 'react';
import { ContextMenu, type MenuEntry } from '../ContextMenu';
import { nodeIconFile, nodeIconImages } from '../icons/Icon';
import { type Prefs, reading } from '../prefs';
import { BoardWindow } from '../proto/BoardWindow';
import { Layouter } from '../proto/layouter';
import { Map3D, type MapNav, type MapState } from '../proto/map3d';
import { type MenuItem, type MenuNode, remember } from '../proto/menu';
import { NameInput } from '../proto/NameInput';
import { NoteWindow } from '../proto/NoteWindow';
import { TabMenu } from '../proto/TabMenu';
import { CoreDocs } from './docs';
import { geckoEvents } from './gecko';
import { Inspector, type InspectorActions } from './Inspector';
import { Layers } from './Layers';
import { MapSearch } from './MapSearch';

/**
 * A workspace on the canvas (milestone 1A, 16 §4.7): its networks from the
 * core, every gesture written by the core (15 §3.3), notes and boards in the
 * core's content documents, `Enter` into a network and `U` out of it (06
 * §1.4), the trash (05 §11). The canvas is the prototype's — Pixi outside
 * React (15 §4); React draws the Chrome over it.
 */

interface Toast {
  id: number;
  key: string;
  params?: Record<string, string | number>;
  undo: boolean;
}

interface Camera {
  x: number;
  y: number;
  zoom: number;
}

const RECENT_KEY = 'strata.tabmenu.recent';
const TOAST_MS = 6_000;
const TOAST_UNDO_MS = 10_000;

function loadRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

const pair = (a: string, b: string) => `${a}\u0000${b}`;

let fogPixels: Pixels | null = null;

/** The «Туман» background (07 §7), made once per page: every tab shows it. */
function fog(): Pixels {
  if (!fogPixels) {
    fogPixels = generatePreset('fog', BACKDROP_SIDE / 2, Math.round((BACKDROP_SIDE / 2) * 0.625));
    processBackdrop(fogPixels);
  }
  return fogPixels;
}

/** What the app's tabs ask of an open workspace before they switch away. */
export interface WorkspaceBridge {
  /** Every step and every typed letter written by the core. */
  save(): Promise<void>;
  /**
   * Saved, and the picture for its card taken; `picture` is its write,
   * which goes on in the background.
   */
  leave(): Promise<{ picture: Promise<void> }>;
  /** Undo and redo from the app's bar (owner, 2026-10-24). */
  undo(): void;
  redo(): void;
  /** The star map and back (08 §7), as `M` does. */
  map(): void;
}

/** What the bar shows of the open workspace: undo and redo, the star map. */
export interface UndoState {
  canUndo: boolean;
  canRedo: boolean;
  /** The step undo would take back, for its tooltip. */
  step: string;
  /** The star map is shown, or on its way. */
  map: boolean;
}

export function WorkspaceScreen(props: {
  locale: Locale;
  home: HomeBackend;
  opened: Opened;
  /** How dates and times read (✅ Q-06-23). */
  prefs: Prefs;
  /** «Настройки» are in front: the canvas leaves the keys alone. */
  covered: boolean;
  bridge: MutableRefObject<WorkspaceBridge | null>;
  onUndoState: (s: UndoState) => void;
}) {
  const { locale, home, opened, covered } = props;
  const core = home.core;
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<CanvasView | null>(null);
  const editor = useRef<Editor | null>(null);
  const graph = useRef<Graph | null>(null);
  const sync = useRef<CoreSync | null>(null);
  const docs = useRef<CoreDocs | null>(null);
  const map3d = useRef<Map3D | null>(null);
  const layouter = useRef<Layouter | null>(null);
  const netRef = useRef(opened.root);
  /** The open workspace; a tab switch changes it under the same canvas. */
  const openedRef = useRef(opened);
  const cameras = useRef(new Map<string, Camera>());
  const textWires = useRef(new Set<string>());
  /** Shows a network (the current one when none is given), after what is queued. */
  const loadRef = useRef<(net?: string) => Promise<void>>(async () => {});
  /** Loads and undo through the core, one after another (they replace the graph). */
  const busy = useRef<Promise<unknown>>(Promise.resolve());
  const leaving = useRef(false);
  const makeDocs = useRef<() => CoreDocs>(
    () =>
      new CoreDocs(
        core,
        () => undefined,
        () => undefined,
      ),
  );
  const toastId = useRef(0);
  const [net, setNet] = useState<NetworkView | null>(null);
  const [menu, setMenu] = useState<{ sx: number; sy: number; query: string } | null>(null);
  const [name, setName] = useState<{ id: string; sx: number; sy: number; name: string } | null>(
    null,
  );
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [note, setNote] = useState<{
    id: string;
    doc: LoroDoc;
    at: { x: number; y: number; side: 'left' | 'right' };
  } | null>(null);
  const [board, setBoard] = useState<{ id: string; doc: LoroDoc } | null>(null);
  /** A list opened: its items are in the panel, the keyboard goes there once. */
  const [listFocus, setListFocus] = useState<string | null>(null);
  const [boardFocus, setBoardFocus] = useState(false);
  const [view3d, setView3d] = useState<MapState>('2d');
  /** The star map's search (08 §10): `within` the cluster in focus for `Ctrl+F`. */
  const [mapSearch, setMapSearch] = useState<{ within: string | null } | null>(null);
  const [trash, setTrash] = useState<TrashItem[] | null>(null);
  /** The core's undo and redo: the session's, across networks (05 §11). */
  const [history, setHistory] = useState<History>({ undo: null, redo: null });
  const [recent, setRecent] = useState<string[]>(loadRecent);
  const [, setVersion] = useState(0);
  /** The selected node, read from the core for the properties panel. */
  const [details, setDetails] = useState<NodeDetails | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const peopleRef = useRef<Person[]>([]);
  const [tree, setTree] = useState<TreeItem[]>([]);
  const [ctx, setCtx] = useState<{ x: number; y: number; at: MenuTarget } | null>(null);
  /** Pictures shown in bubbles: node → asset; and asset → object URL for the panel. */
  const shown = useRef(new Map<string, string>());
  const urls = useRef(new Map<string, string>());
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const refreshRef = useRef<() => void>(() => undefined);
  const eventsRef = useRef<EditorEvents | null>(null);
  const localeRef = useRef(locale);
  localeRef.current = locale;
  /** The companion on the canvas (07 §10.4): it reacts to the user's steps. */
  const gecko = useRef<GeckoHandle>(null);

  const label = (l: ChangeLabel | null) =>
    l ? t(locale, l.key as MessageKey, l.params ?? {}) : t(locale, 'proto.noSteps');

  const toast = useCallback(
    (key: string, params?: Record<string, string | number>, undo = false) => {
      const id = ++toastId.current;
      setToasts((ts) => [...ts.slice(-2), { id, key, undo, ...(params ? { params } : {}) }]);
      setTimeout(
        () => setToasts((ts) => ts.filter((x) => x.id !== id)),
        undo ? TOAST_UNDO_MS : TOAST_MS,
      );
    },
    [],
  );

  const refreshTrash = useCallback(() => {
    void (sync.current?.settled() ?? Promise.resolve())
      .then(() => core.trash())
      .then(setTrash)
      .catch(() => undefined);
  }, [core]);

  // One canvas per opened workspace; its callbacks read refs.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the canvas is set up once
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let cancelled = false;
    let view: CanvasView | null = null;
    let trashTimer: ReturnType<typeof setTimeout> | null = null;
    let detailsTimer: ReturnType<typeof setTimeout> | null = null;

    const refused = (e: unknown) => {
      if (cancelled) return;
      toast('ws.refused', { message: e instanceof Error ? e.message : String(e) });
      void loadRef.current();
    };

    const events: EditorEvents = {
      // The editor speaks in points of the canvas, which sits right of «Слои»:
      // the Tab menu is fixed to the page, the name field lies in this screen.
      tabMenu: (e) => {
        const r = el.getBoundingClientRect();
        setMenu({ ...e, sx: e.sx + r.left, sy: e.sy + r.top });
      },
      nameInput: (e) =>
        setName(e ? { ...e, sx: e.sx + el.offsetLeft, sy: e.sy + el.offsetTop } : null),
      toast: (e) => toast(e.key, e.params, e.key !== 'proto.toast.exists'),
      // No explanatory lines on screen: hints live in tooltips and menus.
      hint: () => undefined,
      change: () => {
        setVersion((v) => v + 1);
        if (trashTimer) clearTimeout(trashTimer);
        trashTimer = setTimeout(refreshTrash, 300);
        if (detailsTimer) clearTimeout(detailsTimer);
        detailsTimer = setTimeout(() => refreshRef.current(), 120);
      },
      contextMenu: (e) => {
        const r = viewRef.current?.canvas.getBoundingClientRect();
        setCtx({ x: e.sx + (r?.left ?? 0), y: e.sy + (r?.top ?? 0), at: e.at });
      },
      map: () => map3d.current?.toggle(),
      up: () => void up(),
      historyEmpty: (which) => {
        // Steps of other networks, or of this one before it was read again:
        // the core reverts them, and the network is read again.
        void queue(async () => {
          await sync.current?.settled();
          const h = which === 'undo' ? await core.undo() : await core.redo();
          setHistory(h);
          await show(netRef.current);
        }).catch(refused);
      },
      layout: (ids) => {
        const g = graph.current;
        const v = viewRef.current;
        if (!g || !v) return;
        const chosen = ids ?? [...g.nodes.keys()];
        layouter.current ??= new Layouter();
        layouter.current
          .layout(g, v, chosen, 'layered', (a, b) => textWires.current.has(pair(a, b)))
          .then((pos) => {
            if (!pos || cancelled || graph.current !== g) return;
            g.transaction({ key: 'proto.change.layout', params: { n: chosen.length } }, (tx) => {
              chosen.forEach((id, i) => {
                tx.move(id, pos[i * 2] ?? 0, pos[i * 2 + 1] ?? 0);
              });
            });
            toast('proto.toast.layout', { n: chosen.length });
          })
          .catch((e: unknown) => console.error('layout', e));
      },
      open: (id) => {
        const v = viewRef.current;
        const n = graph.current?.nodes.get(id);
        const p = v?.nodeAt(id);
        const d = docs.current;
        if (!v || !n || !p || !d) return;
        if (n.kind === 'network' || n.kind === 'project') {
          void loadRef.current(id);
          return;
        }
        if (n.kind === 'board') {
          d.doc(id).then((doc) => setBoard({ id, doc }), refused);
          return;
        }
        // A task and an asset are their panel (ADR-0010): it is already open.
        if (n.kind === 'task' || n.kind === 'asset') return;
        // So is a list (owner, 2026-10-24): the keyboard goes to its new item.
        if (n.kind === 'checklist') {
          setListFocus(id);
          return;
        }
        // Beside the bubble, on the side with more room (06 §13.1): the canvas
        // runs under the properties panel, which takes its right edge.
        const s = v.camera.toScreen(p.x, p.y);
        const r = p.r * v.camera.zoom;
        const panel = el.parentElement?.querySelector<HTMLElement>('.ws-inspector');
        const room = v.width - (panel?.offsetWidth ?? 0);
        const side = s.x < room / 2 ? 'right' : 'left';
        // In this screen's points: the canvas starts right of «Слои».
        const x = el.offsetLeft + (side === 'right' ? s.x + r + 24 : s.x - r - 24);
        const y = el.offsetTop + Math.max(8, Math.min(s.y - 120, v.height - 320));
        const at = { side, x, y } as const;
        d.doc(id).then((doc) => setNote({ id, doc, at }), refused);
      },
    };

    /** The star map navigates the whole space from the core (08 §10). */
    const mapNav: MapNav = {
      space: async () => {
        await sync.current?.settled();
        const [items, wires] = await Promise.all([core.tree(), core.wires()]);
        return {
          items: items.map((i) => ({
            id: i.id,
            kind: i.kind,
            parent: i.parent,
            status: i.status,
            name: i.name,
          })),
          wires,
        };
      },
      network: () => netRef.current,
      go: (net, node) => {
        const show = () => {
          if (node) editor.current?.focusNode(node);
        };
        if (net === netRef.current) show();
        else void loadRef.current(net).then(show);
      },
    };

    const up = async () => {
      const path = await core.view(netRef.current).then((v) => v.path);
      const parent = path.at(-2);
      if (parent) await loadRef.current(parent[0]);
    };

    /** Shows network `id`: a fresh graph from the core, the camera it had. */
    const queue = <T,>(f: () => Promise<T>): Promise<T> => {
      const p = busy.current.then(f);
      busy.current = p.catch(() => undefined);
      return p;
    };

    const show = async (id: string) => {
      const v = viewRef.current;
      if (!v || cancelled) return;
      const was = netRef.current;
      if (graph.current) {
        cameras.current.set(was, { x: v.camera.x, y: v.camera.y, zoom: v.camera.zoom });
      }
      await sync.current?.settled();
      await docs.current?.flush();
      const [nv, h, ppl, items] = await Promise.all([
        core.view(id),
        core.history(),
        core.people(),
        core.tree(),
      ]);
      if (cancelled) return;
      setHistory(h);
      peopleRef.current = ppl;
      setPeople(ppl);
      setTree(items);
      v.clearPictures();
      shown.current.clear();
      // A note or board window belongs to its network's canvas.
      if (id !== was) {
        setNote(null);
        setBoard(null);
        setBoardFocus(false);
      }
      editor.current?.destroy();
      sync.current?.destroy();
      map3d.current?.destroy();
      const g = graphOf(
        nv,
        (k) => v.iconFor(k),
        (pid) => peopleRef.current.find((p) => p.id === pid)?.color ?? 0,
      );
      graph.current = g;
      g.subscribe((e) => {
        for (const event of geckoEvents(e)) gecko.current?.react(event);
      });
      textWires.current = new Set(nv.edges.filter((e) => e.text).map((e) => pair(e.from, e.to)));
      const ed = new Editor(v, g, events);
      // The properties panel covers the canvas's right edge while one node is
      // chosen: framing keeps clear of it (review 2026-10-24).
      ed.coveredRight = () =>
        ed.selection.size === 1
          ? (el.parentElement?.querySelector<HTMLElement>('.ws-panel-probe')?.offsetWidth ?? 0)
          : 0;
      editor.current = ed;
      sync.current = new CoreSync(core, g, id, refused, setHistory);
      map3d.current = new Map3D(el, v, g, setView3d, mapNav);
      netRef.current = id;
      setNet(nv);
      setMenu(null);
      setName(null);
      const cam = cameras.current.get(id);
      if (cam) {
        v.camera.x = cam.x;
        v.camera.y = cam.y;
        v.camera.zoom = cam.zoom;
        v.invalidate();
      } else {
        ed.fitAll();
      }
      v.canvas.focus();
      refreshTrash();
      setDetails(null);
      void pictures();
    };

    /** Pictures of photo assets into their bubbles (owner, 2026-10-24). */
    const pictures = async () => {
      const v = viewRef.current;
      const g = graph.current;
      if (!v || !g) return;
      for (const n of g.nodes.values()) {
        // A picture by its type, as the panel and «Ноды» read it; a file shows its icon.
        const sha = assetType(n.attrs) === 'image' ? n.attrs.asset : undefined;
        if (shown.current.get(n.id) === sha) continue;
        if (!sha) {
          shown.current.delete(n.id);
          v.setPicture(n.id, null);
          continue;
        }
        shown.current.set(n.id, sha);
        try {
          const bytes = await core.asset(sha);
          const bmp = await createImageBitmap(new Blob([new Uint8Array(bytes)]));
          if (graph.current === g) v.setPicture(n.id, bmp);
        } catch {
          // Not a picture the browser can draw: the bubble keeps its icon.
        }
      }
    };

    /** The selected node from the core, for the panel; the pictures follow too. */
    refreshRef.current = () => {
      void pictures();
      void (sync.current?.settled() ?? Promise.resolve())
        .then(() => core.tree())
        .then((items) => {
          if (!cancelled) setTree(items);
        })
        .catch(() => undefined);
      // Progress arcs that a tick, a subtask or a wire changed (05 §6.4).
      const g = graph.current;
      void (sync.current?.settled() ?? Promise.resolve())
        .then(() => core.view(netRef.current))
        .then((nv) => {
          if (!cancelled && graph.current === g && g && nv.net === netRef.current) {
            followFolds(g, nv);
          }
        })
        .catch(() => undefined);
      const ed = editor.current;
      const id = ed && ed.selection.size === 1 ? ed.current : null;
      if (!id) {
        setDetails(null);
        return;
      }
      void (sync.current?.settled() ?? Promise.resolve())
        .then(() => core.node(id))
        .then((d) => {
          if (editor.current?.current === id) setDetails(d);
        })
        .catch(() => setDetails(null));
    };
    const load = (id?: string) => queue(() => show(id ?? netRef.current));
    loadRef.current = load;
    eventsRef.current = events;

    makeDocs.current = () =>
      new CoreDocs(
        core,
        () => {
          // The core rewired a note's links: its wires follow, outside undo.
          void core.view(netRef.current).then((nv) => {
            const g = graph.current;
            if (!g || cancelled || nv.net !== netRef.current) return;
            textWires.current = new Set(
              nv.edges.filter((e) => e.text).map((e) => pair(e.from, e.to)),
            );
            followWires(g, nv);
          });
        },
        refused,
      );
    docs.current = makeDocs.current();

    Promise.all([CanvasView.create(el), nodeIconImages()]).then(([v, icons]) => {
      if (cancelled) {
        v.destroy();
        return;
      }
      view = v;
      viewRef.current = v;
      // The Chrome's icons on the nodes too (owner, 2026-10-24); an asset's by its content.
      v.iconKey = (n) => nodeIconFile(n.kind, n.attrs);
      v.setKindIcons(icons);
      // Circles on both ends (✅ Q-07-20, owner, 2026-10-24).
      v.wireEnds = 'sockets';
      v.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      // `&plain`: no background, for e2e on software WebGL (see Prototype).
      if (new URLSearchParams(window.location.search).has('plain')) {
        v.background.container.visible = false;
      } else {
        v.setBackground(fog());
      }
      // Test hook for e2e: the canvas, the graph and when the core has it all.
      (window as unknown as { __strataWs: unknown }).__strataWs = {
        view: v,
        graph: () => graph.current,
        net: () => netRef.current,
        map: () => map3d.current,
        settled: async () => {
          await busy.current;
          await docs.current?.flush();
          await sync.current?.settled();
        },
      };
      void load(openedRef.current.root);
    });

    const leave = () => void docs.current?.flush();
    window.addEventListener('pagehide', leave);
    return () => {
      cancelled = true;
      if (trashTimer) clearTimeout(trashTimer);
      window.removeEventListener('pagehide', leave);
      void docs.current?.flush().finally(() => docs.current?.destroy());
      map3d.current?.destroy();
      map3d.current = null;
      layouter.current?.destroy();
      layouter.current = null;
      editor.current?.destroy();
      editor.current = null;
      sync.current?.destroy();
      viewRef.current = null;
      view?.destroy();
    };
  }, []);

  useEffect(() => {
    // «Настройки» in front cover the canvas: its keys are off too (✅ Q-06-23).
    editor.current?.setOverlayOpen(
      menu !== null || name !== null || view3d !== '2d' || boardFocus || covered,
    );
  }, [menu, name, view3d, boardFocus, covered]);

  useEffect(() => {
    if (view3d !== '3d') {
      setMapSearch(null);
      return;
    }
    // The search window takes its own keys while it is open.
    if (mapSearch) return;
    const key = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.altKey && (e.code === 'KeyO' || e.code === 'KeyF')) {
        e.preventDefault();
        const within = e.code === 'KeyF' ? (map3d.current?.focusId() ?? null) : null;
        setMapSearch({ within });
        return;
      }
      if (e.code === 'KeyM' && !mod && !e.altKey) {
        map3d.current?.toggle();
        return;
      }
      if (map3d.current?.key(e)) e.preventDefault();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [view3d, mapSearch]);

  const focusCanvas = useCallback(() => host.current?.querySelector('canvas')?.focus(), []);

  const choose = useCallback(
    (item: MenuItem) => {
      setMenu(null);
      editor.current?.setOverlayOpen(false);
      editor.current?.menuChoose(item.choice);
      const next = remember(recent, item);
      setRecent(next);
      try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(next));
      } catch {
        // Recent choices are a convenience; private windows may refuse storage.
      }
      focusCanvas();
    },
    [recent, focusCanvas],
  );

  /** Back to the home screen: everything written, a picture for the card. */
  // The tabs ask this screen to write everything before they switch away.
  useEffect(() => {
    const save = async () => {
      await busy.current;
      await docs.current?.flush();
      await sync.current?.settled();
    };
    props.bridge.current = {
      save,
      undo: () => editor.current?.undo(),
      redo: () => editor.current?.redo(),
      map: () => map3d.current?.toggle(),
      leave: async () => {
        if (leaving.current) return { picture: Promise.resolve() };
        leaving.current = true;
        await save();
        // The picture is read at once; encoding and saving it go on in the
        // background, so the next tab does not wait for them.
        const id = opened.workspace.id;
        const shot = viewRef.current?.snapshot() ?? Promise.resolve(null);
        const picture = shot
          .then((png) => (png ? home.setPreview(id, png) : undefined))
          .catch(() => undefined);
        return { picture };
      },
    };
  }, [home, opened.workspace.id, props.bridge]);

  // Another tab: the same canvas, the other workspace's root network.
  useEffect(() => {
    if (openedRef.current.workspace.id === opened.workspace.id) return;
    openedRef.current = opened;
    leaving.current = false;
    cameras.current.clear();
    docs.current?.destroy();
    docs.current = makeDocs.current();
    setNote(null);
    setBoard(null);
    setTrash(null);
    netRef.current = opened.root;
    void loadRef.current(opened.root);
  }, [opened]);

  const restore = async (item: TrashItem) => {
    try {
      await sync.current?.settled();
      await core.apply([{ op: 'restore', ids: [item.id] }], {
        key: 'ws.change.restore',
        params: { name: item.name },
      });
      await loadRef.current();
    } catch (e) {
      toast('ws.refused', { message: e instanceof Error ? e.message : String(e) });
    }
  };

  /**
   * A step the canvas's graph cannot hold (a node in another network, a
   * person): written by the core; the graph's own undo is cleared, so undo
   * goes to the core's history from here (05 §11).
   */
  const coreStep = async (
    ops: CoreOp[],
    labelKey: string,
    params?: Record<string, string | number>,
  ) => {
    await sync.current?.settled();
    const h = await core.apply(ops, { key: labelKey, ...(params ? { params } : {}) });
    graph.current?.clearHistory();
    setHistory(h);
    refreshRef.current();
    void core.tree().then(setTree);
  };

  const failed = (e: unknown) =>
    toast('ws.refused', { message: e instanceof Error ? e.message : String(e) });

  /**
   * A new subtask of `parent` (05 §4.3, ADR-0010): a task wired from it,
   * beside it on its canvas; in a project, a task inside. One step of undo.
   */
  const addSubtask = (parent: NodeDetails, name: string) => {
    const g = graph.current;
    const v = viewRef.current;
    const id = newId();
    const inside = parent.kind === 'project';
    const net = inside ? parent.id : (parent.parent ?? netRef.current);
    const k = inside ? parent.children.length : parent.outputs.filter((o) => isTask(o.kind)).length;
    if (g && v && net === netRef.current) {
      const at = g.nodes.get(parent.id);
      const x = inside || !at ? 0 : at.x + 180;
      const y = inside || !at ? 140 * k : at.y + 110 * k;
      g.transaction({ key: 'proto.change.create', params: { name } }, (tx) => {
        tx.add(newNode({ id, name, kind: 'task', icon: v.iconFor('task'), x, y }));
        if (!inside) tx.connect(parent.id, id);
      });
      return;
    }
    const ops: CoreOp[] = [
      { op: 'createNode', id, kind: 'task', name, net, x: 0, y: 140 * (k + 1) },
    ];
    if (!inside) ops.push({ op: 'connect', from: parent.id, to: id });
    void coreStep(ops, 'proto.change.create', { name }).catch(failed);
  };

  // Another node in the panel: a list's open request no longer stands.
  useEffect(() => setListFocus((f) => (f === details?.id ? f : null)), [details?.id]);

  // The selected asset's file for the panel, typed so the browser can show it.
  useEffect(() => {
    const sha = details?.kind === 'asset' ? details.asset : undefined;
    const mime = details?.mime ?? '';
    if (!sha) {
      setFileUrl(null);
      return;
    }
    const key = `${sha}|${mime}`;
    const known = urls.current.get(key);
    if (known) {
      setFileUrl(known);
      return;
    }
    // Not the last asset's file while this one loads.
    setFileUrl(null);
    let live = true;
    core
      .asset(sha)
      .then((bytes) => {
        const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mime }));
        urls.current.set(key, url);
        if (live) setFileUrl(url);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [core, details?.kind, details?.asset, details?.mime]);

  /**
   * Files dropped on the canvas become assets (05 §4.4): each keeps its type,
   * a picture shows in its circle; a dropped link becomes a link asset.
   */
  const dropFiles = async (files: File[], links: string[], clientX: number, clientY: number) => {
    const g = graph.current;
    const v = viewRef.current;
    if (!g || !v) return;
    const r = v.canvas.getBoundingClientRect();
    const w = v.camera.toWorld(clientX - r.left, clientY - r.top);
    let i = 0;
    const add = (name: string, attrs: [AttrKey, string][]) => {
      const id = newId();
      const x = w.x + i * 90;
      g.transaction({ key: 'proto.change.create', params: { name } }, (tx) => {
        tx.add(newNode({ id, name, kind: 'asset', icon: v.iconFor('asset'), x, y: w.y }));
        for (const [key, value] of attrs) tx.attr(id, key, value);
      });
      i++;
    };
    for (const f of files) {
      const bytes = new Uint8Array(await f.arrayBuffer());
      const sha = await core.putAsset(bytes);
      const name = f.name.replace(/\.[^.]+$/, '') || t(locale, 'kind.asset');
      const mime = f.type || sniffMime(bytes);
      add(name, [['asset', sha], ...(mime ? ([['mime', mime]] as [AttrKey, string][]) : [])]);
    }
    for (const url of links) {
      let name = url;
      try {
        name = new URL(url).hostname || url;
      } catch {
        // Not a URL the browser parses: the name is the text.
      }
      add(name, [['url', url]]);
    }
  };

  /**
   * A layer chosen (owner, 2026-10-24: like Figma): the node selected on
   * the canvas — in its own network, gone into first; `open` opens it too.
   */
  const selectLayer = async (id: string, open: boolean) => {
    const item = tree.find((x) => x.id === id);
    if (!item) return;
    if (!item.parent) {
      await loadRef.current(id);
      return;
    }
    if (item.parent !== netRef.current) await loadRef.current(item.parent);
    editor.current?.focusNode(id);
    if (open) eventsRef.current?.open?.(id);
  };

  const g = graph.current;
  const ed = editor.current;
  const field = (key: AttrKey) => t(locale, `ins.${key}` as MessageKey);
  const actions: InspectorActions | null =
    details && g
      ? {
          rename: (name) =>
            g.transaction({ key: 'proto.change.rename', params: { name } }, (tx) =>
              tx.rename(details.id, name),
            ),
          attr: (key, value) =>
            g.transaction(
              { key: 'change.attr', params: { name: details.name, field: field(key) } },
              (tx) => tx.attr(details.id, key, value),
            ),
          assign: (person, on) =>
            g.transaction({ key: 'change.assign', params: { name: details.name } }, (tx) =>
              tx.assign(details.id, person, on),
            ),
          addPerson: async (name) => {
            const id = newId();
            await coreStep(
              [{ op: 'addPerson', id, name, color: peopleRef.current.length % 8 }],
              'change.assign',
              { name },
            ).catch(failed);
            const ppl = await core.people();
            peopleRef.current = ppl;
            setPeople(ppl);
            return id;
          },
          content: async () => docs.current?.doc(details.id) ?? null,
          count: ({ done, total }) => g.setFold(details.id, { done, total, burning: null }),
          file: (file) =>
            void file
              .arrayBuffer()
              .then(async (b) => {
                const bytes = new Uint8Array(b);
                const sha = await core.putAsset(bytes);
                const mime = file.type || sniffMime(bytes);
                g.transaction({ key: 'change.file', params: { name: details.name } }, (tx) => {
                  tx.attr(details.id, 'asset', sha);
                  tx.attr(details.id, 'mime', mime);
                  tx.attr(details.id, 'url', null);
                });
              })
              .catch(failed),
          fileUrl,
          open: () => eventsRef.current?.open?.(details.id),
          focus: (id) => {
            if (g.nodes.has(id)) {
              ed?.focusNode(id);
              return;
            }
            void core.node(id).then(async (d) => {
              if (d.parent) await loadRef.current(d.parent);
              editor.current?.focusNode(id);
            });
          },
          link: (from, to) =>
            g.transaction(
              {
                key: 'change.link',
                params: { from: details.name, to: g.nodes.get(to)?.name ?? '' },
              },
              (tx) => tx.connect(from, to),
            ),
          unlink: (from, to) => {
            if (g.hasEdge(from, to)) {
              g.transaction({ key: 'proto.change.disconnect' }, (tx) => tx.disconnect(from, to));
            } else {
              void coreStep([{ op: 'disconnect', from, to }], 'proto.change.disconnect').catch(
                failed,
              );
            }
          },
          candidates: [...g.nodes.values()].map((n) => ({ id: n.id, kind: n.kind, name: n.name })),
          subtask: (name) => addSubtask(details, name),
          done: (id, name, done) => {
            const status = done ? 'done' : 'todo';
            const params = { name, field: t(locale, 'ins.status') };
            if (g.nodes.has(id)) {
              g.transaction({ key: 'change.attr', params }, (tx) => tx.attr(id, 'status', status));
              return;
            }
            void coreStep(
              [{ op: 'setAttr', id, key: 'status', value: status }],
              'change.attr',
              params,
            ).catch(failed);
          },
        }
      : null;

  /** The right button's menu (06 §5): for a node, a wire, or the bare canvas. */
  const ctxItems = (at: MenuTarget): MenuEntry[] => {
    if (!g || !ed) return [];
    if (at.t === 'empty') {
      const r = viewRef.current?.canvas.getBoundingClientRect();
      const sx = (ctx?.x ?? 0) - (r?.left ?? 0);
      const sy = (ctx?.y ?? 0) - (r?.top ?? 0);
      return [
        { label: t(locale, 'ctx.create'), hint: 'Tab', onSelect: () => ed.createAt(sx, sy) },
        { label: t(locale, 'ctx.showAll'), hint: 'H', onSelect: () => ed.fitAll() },
      ];
    }
    if (at.t === 'wire') {
      return [
        { label: t(locale, 'ctx.deleteWire'), hint: 'Del', onSelect: () => ed.deleteSelected() },
      ];
    }
    const n = g.nodes.get(at.id);
    if (!n) return [];
    const done = n.attrs.status === 'done';
    const openable = ['network', 'project', 'note', 'board'].includes(n.kind);
    const items: MenuEntry[] = [];
    if (openable) {
      items.push({
        label: t(locale, 'ctx.open'),
        hint: 'Enter',
        onSelect: () => eventsRef.current?.open?.(n.id),
      });
    }
    items.push({
      label: t(locale, 'ctx.rename'),
      hint: 'F2',
      onSelect: () => ed.rename(n.id),
    });
    // A task's and a project's own entries (ADR-0010).
    if (isTask(n.kind)) {
      items.push(
        {
          label: t(locale, done ? 'ctx.undone' : 'ctx.done'),
          onSelect: () =>
            g.transaction(
              { key: 'change.attr', params: { name: n.name, field: t(locale, 'ins.status') } },
              (tx) => tx.attr(n.id, 'status', done ? 'todo' : 'done'),
            ),
        },
        {
          label: t(locale, 'ctx.addSubtask'),
          onSelect: () =>
            void core
              .node(n.id)
              .then((d) => addSubtask(d, t(locale, 'ins.newSubtask')))
              .catch(failed),
        },
      );
    }
    items.push({
      label: t(locale, 'ctx.delete'),
      hint: 'Del',
      separated: true,
      onSelect: () => ed.deleteSelected(),
    });
    return items;
  };

  const nodes: MenuNode[] = g
    ? [...g.nodes.values()].map((n) => ({ id: n.id, name: n.name, kind: n.kind }))
    : [];
  const canUndo = Boolean(g?.canUndo || history.undo);
  const canRedo = Boolean(g?.canRedo || history.redo);
  const lastStep = canUndo
    ? t(locale, 'proto.lastStep', { label: label(g?.canUndo ? g.undoLabel : history.undo) })
    : label(null);
  const path = net?.path ?? [];
  const { onUndoState } = props;
  useEffect(
    () => onUndoState({ canUndo, canRedo, step: lastStep, map: view3d !== '2d' }),
    [onUndoState, canUndo, canRedo, lastStep, view3d],
  );

  return (
    <div
      className="proto workspace"
      data-net={net?.net ?? ''}
      data-depth={path.length}
      data-nodes={g?.nodes.size ?? 0}
      data-wires={g?.edges().length ?? 0}
      data-view={view3d}
    >
      <div className="ws-panel-probe" aria-hidden="true" />
      <div
        ref={host}
        className="proto-canvas"
        role="application"
        aria-label={net?.name ?? ''}
        onDragOver={(e) => {
          const types = e.dataTransfer.types;
          if (types.includes('Files') || types.includes('text/uri-list')) e.preventDefault();
        }}
        onDrop={(e) => {
          const files = [...e.dataTransfer.files];
          const links =
            files.length > 0
              ? []
              : e.dataTransfer
                  .getData('text/uri-list')
                  .split(/\r?\n/)
                  .map((l) => l.trim())
                  .filter((l) => l && !l.startsWith('#'));
          if (files.length === 0 && links.length === 0) return;
          e.preventDefault();
          void dropFiles(files, links, e.clientX, e.clientY).catch(failed);
        }}
      />
      {net ? (
        <Layers
          locale={locale}
          items={tree}
          current={net.net}
          selected={new Set(ed?.selection ?? [])}
          trash={trash ?? []}
          onSelect={(id) => void selectLayer(id, false)}
          onOpen={(id) => void selectLayer(id, true)}
          onRestore={(item) => void restore(item)}
        />
      ) : null}
      <div className="ws-gecko" data-panel={details ? 'open' : 'closed'}>
        <GeckoCompanion
          ref={gecko}
          scale={1.5}
          paused={covered}
          // A dweller of the canvas: away while the star map is shown.
          hidden={view3d !== '2d'}
          label={t(locale, 'gecko.label')}
          hint={t(locale, 'gecko.hint')}
        />
      </div>
      {details && actions ? (
        <Inspector
          key={details.id}
          locale={locale}
          node={details}
          people={people}
          actions={actions}
          focusList={listFocus === details.id}
          noteOpen={note?.id === details.id}
          when={reading(props.prefs)}
          onListFocused={() => setListFocus(null)}
        />
      ) : null}
      {ctx ? (
        <ContextMenu
          x={ctx.x}
          y={ctx.y}
          label={t(locale, 'ctx.label')}
          items={ctxItems(ctx.at)}
          onClose={() => {
            setCtx(null);
            viewRef.current?.canvas.focus();
          }}
        />
      ) : null}
      <ul className="toasts" aria-live="polite">
        {toasts.map((x) => (
          <li key={x.id} className="toast">
            <span title={t(locale, x.key as MessageKey, x.params ?? {})}>
              {t(locale, x.key as MessageKey, x.params ?? {})}
            </span>
            {x.undo ? (
              <button
                type="button"
                onClick={() => {
                  ed?.undo();
                  setToasts((ts) => ts.filter((y) => y.id !== x.id));
                }}
              >
                {t(locale, 'proto.undo')}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {mapSearch && view3d === '3d' ? (
        <MapSearch
          locale={locale}
          items={tree}
          within={mapSearch.within}
          left={
            (host.current?.getBoundingClientRect().left ?? 0) + (host.current?.clientWidth ?? 0) / 2
          }
          top={(host.current?.getBoundingClientRect().top ?? 0) + 48}
          onChoose={(id) => {
            setMapSearch(null);
            map3d.current?.flyTo(id);
          }}
          onClose={() => setMapSearch(null)}
        />
      ) : null}
      {menu ? (
        <TabMenu
          locale={locale}
          x={menu.sx}
          y={menu.sy}
          bounds={host.current?.getBoundingClientRect()}
          initialQuery={menu.query}
          nodes={nodes}
          recent={recent}
          onChoose={choose}
          onCancel={() => {
            setMenu(null);
            ed?.menuCancel();
            focusCanvas();
          }}
        />
      ) : null}
      {board ? (
        <BoardWindow
          key={board.id}
          locale={locale}
          name={g?.nodes.get(board.id)?.name ?? ''}
          doc={board.doc}
          onChange={() => undefined}
          onFocus={setBoardFocus}
          onClose={() => {
            void docs.current?.flush();
            setBoard(null);
            setBoardFocus(false);
            focusCanvas();
          }}
        />
      ) : null}
      {note ? (
        <NoteWindow
          key={note.id}
          locale={locale}
          name={g?.nodes.get(note.id)?.name ?? ''}
          doc={note.doc}
          at={note.at}
          onChange={() => undefined}
          onEscape={focusCanvas}
          onClose={() => {
            void docs.current?.flush();
            setNote(null);
            focusCanvas();
          }}
        />
      ) : null}
      {name ? (
        <NameInput
          locale={locale}
          x={name.sx}
          y={name.sy}
          initial={name.name}
          onCommit={(text) => {
            setName(null);
            ed?.nameCommit(text);
            focusCanvas();
          }}
          onCancel={() => {
            setName(null);
            ed?.nameCancel();
            focusCanvas();
          }}
          onMenu={(text) => ed?.nameToMenu(text)}
        />
      ) : null}
    </div>
  );
}
