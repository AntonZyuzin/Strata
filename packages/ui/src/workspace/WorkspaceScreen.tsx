import {
  type AttrKey,
  assetType,
  type ChangeLabel,
  type CoreOp,
  CoreSync,
  type Flag,
  flagsOf,
  followFolds,
  followGhosts,
  followPreviews,
  followWires,
  type Graph,
  graphOf,
  type History,
  type HomeBackend,
  hasCanvas,
  isTask,
  linkOf,
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
import { noteText } from '@strata/editor';
import { GeckoCompanion, type GeckoHandle, type GeckoNode } from '@strata/gecko';
import { type Locale, type MessageKey, t } from '@strata/i18n';
import type { Scope } from '@strata/search';
import type { LoroDoc } from 'loro-crdt';
import { type MutableRefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { linkPreview } from '../backend';
import { ContextMenu, type MenuEntry } from '../ContextMenu';
import { nodeIconFile, nodeIconImages } from '../icons/Icon';
import { type Prefs, reading } from '../prefs';
import { BoardWindow } from '../proto/BoardWindow';
import { Layouter } from '../proto/layouter';
import { Map3D, type MapNav, type MapState } from '../proto/map3d';
import { type MenuGhost, type MenuItem, type MenuNode, remember } from '../proto/menu';
import { NameInput } from '../proto/NameInput';
import { NoteWindow } from '../proto/NoteWindow';
import { TabMenu } from '../proto/TabMenu';
import { netItems, searchClient, visited, visits } from '../search';
import { AssetWindow, type Viewable, viewable } from './AssetWindow';
import { CoreDocs } from './docs';
import { dueWord } from './due';
import { FindBar } from './FindBar';
import { geckoEvents } from './gecko';
import { Inspector, type InspectorActions } from './Inspector';
import { Layers } from './Layers';
import { NodeSearch } from './NodeSearch';
import { PathBar } from './PathBar';

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
  /** When the flag ring shows (06 §8): «Настройки» set it, every new canvas takes it. */
  const ringModeRef = useRef(props.prefs.ring);
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
  const [menu, setMenu] = useState<{
    sx: number;
    sy: number;
    query: string;
    named?: string;
  } | null>(null);
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
  /** An asset in its viewer (06 §13.4): its file's URL once loaded. */
  const [viewer, setViewer] = useState<{
    id: string;
    type: Viewable;
    url: string | null;
    at: { x: number; y: number; side: 'left' | 'right' };
  } | null>(null);
  /** A list opened: its items are in the panel, the keyboard goes there once. */
  const [listFocus, setListFocus] = useState<string | null>(null);
  const [boardFocus, setBoardFocus] = useState(false);
  const [viewerFocus, setViewerFocus] = useState(false);
  const [view3d, setView3d] = useState<MapState>('2d');
  /**
   * «Перейти к ноде» (09 §3.4): `Ctrl+O` on the canvas; on the star map
   * `Ctrl+O` and `Ctrl+F`, `within` the cluster in focus (08 §10).
   */
  const [finder, setFinder] = useState<{ map: boolean; within: string | null } | null>(null);
  /** `Ctrl+F` on the canvas (09 §3.3). */
  const [finding, setFinding] = useState(false);
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
  /** Fetches the previews of these link assets (✅ Q-13-16); set with the canvas. */
  const previewRef = useRef<(ids: string[]) => Promise<void>>(async () => {});
  /** Link assets already asked for a preview this session. */
  const previewed = useRef(new Set<string>());
  const eventsRef = useRef<EditorEvents | null>(null);
  const localeRef = useRef(locale);
  localeRef.current = locale;
  /** The companion on the canvas (07 §10.4): it reacts to the user's steps. */
  const gecko = useRef<GeckoHandle>(null);
  const geckoHost = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Screen-space node surfaces follow the camera and in-progress node drags (07 §10.4).
    const update = () => {
      if (covered || document.hidden || view3d !== '2d') return;
      const view = viewRef.current;
      const host = geckoHost.current;
      if (!view || !host || !view.width || !view.height) return;
      const bounds = host.getBoundingClientRect();
      const canvas = view.canvas.getBoundingClientRect();
      const surfaces: GeckoNode[] = [];
      for (const [id, node] of view.eachNode()) {
        const point = view.camera.toScreen(node.x, node.y);
        const x = canvas.left - bounds.left + point.x * (canvas.width / view.width);
        const y = canvas.top - bounds.top + point.y * (canvas.height / view.height);
        const radius = node.r * view.camera.zoom * (canvas.width / view.width);
        if (
          x + radius < 0 ||
          y + radius < 0 ||
          x - radius > bounds.width ||
          y - radius > bounds.height
        )
          continue;
        // Nodes are hexagons (ADR-0011): the gecko walks their sides.
        surfaces.push({ id, x, y, radius, hexagon: true });
      }
      gecko.current?.setNodes(surfaces);
    };
    update();
    const timer = window.setInterval(update, 100);
    return () => window.clearInterval(timer);
  }, [covered, view3d]);

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
        // The menu ranks the canvas's nodes as they are now (09 §2.7).
        const g = graph.current;
        if (g) searchClient().set('net', netItems(g.nodes.values(), netRef.current));
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
      // A template's copy is the core's (05 §7): everything inside comes too,
      // one step of undo; the network is read again with it.
      template: (e) => {
        void queue(async () => {
          await sync.current?.settled();
          const label = { key: 'proto.change.template', params: { name: e.name } };
          const at = { net: netRef.current, x: e.x, y: e.y };
          const { id } = await core.copyNode(e.id, at, e.inputs, label);
          await show(netRef.current);
          editor.current?.reveal(id);
        }).catch(refused);
      },
      layout: (ids) => {
        const g = graph.current;
        const v = viewRef.current;
        if (!g || !v) return;
        // Ghosts stand by their notes (06 §14): `L` moves the notes.
        const chosen = ids ?? [...g.nodes.values()].filter((n) => !n.ghostOf).map((n) => n.id);
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
        // A task is its panel (ADR-0010): it is already open; so is an
        // asset with nothing to view large (a file, a link).
        const type = n.kind === 'asset' ? assetType(n.attrs) : null;
        if (n.kind === 'task' || (type !== null && !viewable(type))) return;
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
        if (type !== null && viewable(type)) {
          const sha = n.attrs.asset;
          setViewer({ id, type, url: null, at });
          if (!sha) return;
          urlOf(sha, n.attrs.mime ?? '')
            .then((url) => setViewer((w) => (w?.id === id ? { ...w, url } : w)))
            .catch(refused);
          return;
        }
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

    /** The graph's text wires and ghosts as the core has them, outside undo (05 §8.2, §8.5). */
    const followLinks = (g: Graph, nv: NetworkView) => {
      textWires.current = new Set(nv.edges.filter((e) => e.text).map((e) => pair(e.from, e.to)));
      followWires(g, nv);
      followGhosts(g, nv, viewRef.current?.iconFor('note') ?? 0);
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
        setViewer(null);
        setViewerFocus(false);
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
        // A link given by the user: its preview follows (✅ Q-13-16).
        if ((e.type === 'apply' || e.type === 'redo') && e.changeset.source === 'user') {
          const links = e.changeset.ops.flatMap((op) =>
            op.t === 'attr' && op.key === 'url' && op.value ? [op.id] : [],
          );
          if (links.length > 0) void previewRef.current(links);
        }
      });
      textWires.current = new Set(nv.edges.filter((e) => e.text).map((e) => pair(e.from, e.to)));
      const ed = new Editor(v, g, events);
      // Scissors leave wires from text alone (06 §6.7).
      ed.textWire = (a, b) => textWires.current.has(pair(a, b));
      // The properties panel covers the canvas's right edge while one node is
      // chosen: framing keeps clear of it (review 2026-10-24).
      ed.coveredRight = () =>
        ed.selection.size === 1
          ? (el.parentElement?.querySelector<HTMLElement>('.ws-panel-probe')?.offsetWidth ?? 0)
          : 0;
      ed.ringMode = ringModeRef.current;
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

    /**
     * Previews of links (05 §4.4, ✅ Q-13-16, ADR-0012): the core fetches each
     * page on desktop, then the canvas, the pictures and the panel read the
     * node again. A link with no preview to be had stays as it is: best effort,
     * no toast; each node is asked once a session.
     */
    previewRef.current = async (ids: string[]) => {
      await sync.current?.settled();
      const g = graph.current;
      const asked = previewed.current;
      for (const id of ids) {
        asked.add(id);
        const changed = await linkPreview(id).catch(() => false);
        if (!changed || cancelled || graph.current !== g || !g) continue;
        const nv = await core.view(netRef.current);
        if (cancelled || graph.current !== g || nv.net !== netRef.current) return;
        followPreviews(g, nv);
        void pictures();
        refreshRef.current();
      }
    };

    /** Pictures of photo assets and link previews into their bubbles (owner, 2026-10-24). */
    const pictures = async () => {
      const v = viewRef.current;
      const g = graph.current;
      if (!v || !g) return;
      for (const n of g.nodes.values()) {
        // A picture by its type, as the panel and «Ноды» read it; a file shows its icon.
        const type = assetType(n.attrs);
        const sha = type === 'image' ? n.attrs.asset : type === 'url' ? n.attrs.preview : undefined;
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

    /**
     * The last panel request: an answer to an older one, or one for a node no
     * longer the only one selected, is dropped. In the desktop a large file
     * read over IPC could hold an answer back until after a click elsewhere,
     * and the panel came back with nothing selected (owner, 2026-10-24).
     */
    let asked = 0;
    /** The selected node from the core, for the panel; the pictures follow too. */
    refreshRef.current = () => {
      void pictures();
      void (sync.current?.settled() ?? Promise.resolve())
        .then(() => core.tree())
        .then((items) => {
          if (!cancelled) setTree(items);
        })
        .catch(() => undefined);
      // Progress arcs that a tick, a subtask or a wire changed (05 §6.4);
      // the text wires and ghosts that a name changed (05 §8.5): a new node
      // with the name resolves its ghosts, a renamed one may leave one.
      const g = graph.current;
      const at = g?.version;
      void (sync.current?.settled() ?? Promise.resolve())
        .then(() => core.view(netRef.current))
        .then((nv) => {
          if (cancelled || graph.current !== g || !g || nv.net !== netRef.current) return;
          followFolds(g, nv);
          // A step made since the question is not in the answer yet.
          if (g.version === at) followLinks(g, nv);
        })
        .catch(() => undefined);
      const ed = editor.current;
      const id = ed && ed.selection.size === 1 ? ed.current : null;
      const ticket = ++asked;
      if (!id) {
        setDetails(null);
        return;
      }
      const still = () => {
        const now = editor.current;
        return ticket === asked && now?.selection.size === 1 && now.selection.has(id);
      };
      void (sync.current?.settled() ?? Promise.resolve())
        .then(() => core.node(id))
        .then((d) => {
          if (still()) setDetails(d);
        })
        .catch(() => {
          if (still()) setDetails(null);
        });
    };
    const load = (id?: string) => queue(() => show(id ?? netRef.current));
    loadRef.current = load;
    eventsRef.current = events;

    makeDocs.current = () =>
      new CoreDocs(
        core,
        () => {
          // The core rewired a note's links: its wires and ghosts follow, outside undo.
          void core.view(netRef.current).then((nv) => {
            const g = graph.current;
            if (!g || cancelled || nv.net !== netRef.current) return;
            followLinks(g, nv);
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
      // A near or past deadline in a word under the label (Q-07-22).
      v.dueWord = (n) => dueWord(n.attrs.deadline, localeRef.current);
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
        editor: () => editor.current,
        core,
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

  // The canvas's words follow the language: deadlines under labels (Q-07-22).
  useEffect(() => {
    if (locale) viewRef.current?.invalidate();
  }, [locale]);

  useEffect(() => {
    // «Настройки» in front cover the canvas: its keys are off too (✅ Q-06-23).
    editor.current?.setOverlayOpen(
      menu !== null ||
        name !== null ||
        finder !== null ||
        view3d !== '2d' ||
        boardFocus ||
        viewerFocus ||
        covered,
    );
  }, [menu, name, finder, view3d, boardFocus, viewerFocus, covered]);

  useEffect(() => {
    ringModeRef.current = props.prefs.ring;
    if (editor.current) editor.current.ringMode = props.prefs.ring;
  }, [props.prefs.ring]);

  // The search knows the workspace's names (09 §2.7): the core's tree, as it changes.
  useEffect(() => searchClient().set('space', tree), [tree]);

  useEffect(() => {
    // Mid-bridge (08 §7) neither view takes keys.
    if (view3d === 'to3d' || view3d === 'to2d') return;
    // A search window takes its own keys while it is open.
    if (finder || covered) return;
    const key = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const search = mod && !e.altKey && !e.shiftKey && (e.code === 'KeyO' || e.code === 'KeyF');
      if (view3d === '2d') {
        // A note's or a list's own search keeps its keys; so does any field.
        const t = e.target as HTMLElement | null;
        const typing =
          t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
        if (!search || typing || menu || name) return;
        e.preventDefault();
        if (e.code === 'KeyO') {
          setFinding(false);
          setFinder({ map: false, within: null });
        } else {
          setFinding(true);
        }
        return;
      }
      if (search) {
        e.preventDefault();
        const within = e.code === 'KeyF' ? (map3d.current?.focusId() ?? null) : null;
        setFinder({ map: true, within });
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
  }, [view3d, finder, covered, menu, name]);

  // A search of one view closes with it (2D ↔ 3D).
  useEffect(() => {
    setFinder((f) => (f && f.map !== (view3d === '3d') ? null : f));
    if (view3d !== '2d') setFinding(false);
  }, [view3d]);

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
    setViewer(null);
    setViewerFocus(false);
    setTrash(null);
    netRef.current = opened.root;
    void loadRef.current(opened.root);
  }, [opened]);

  /**
   * Goes to a node (09 §3.4): the network of its primary placement on the
   * canvas, a flight to it, the node selected (06 §10.3); `open` — into a
   * folder or project, or its content beside it.
   */
  const goNode = (id: string, open: boolean) => {
    void core
      .node(id)
      .then(async (d) => {
        if (!d.parent || (open && hasCanvas(d.kind))) {
          await loadRef.current(id);
          return;
        }
        if (d.parent !== netRef.current) await loadRef.current(d.parent);
        editor.current?.flyTo([id]);
        if (open) eventsRef.current?.open?.(id);
      })
      .catch(failed);
  };

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

  /** An asset's file as an object URL, typed so the browser can show it; made once. */
  const urlOf = async (sha: string, mime: string) => {
    const key = `${sha}|${mime}`;
    const known = urls.current.get(key);
    if (known) return known;
    const bytes = await core.asset(sha);
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mime }));
    urls.current.set(key, url);
    return url;
  };
  const urlRef = useRef(urlOf);
  urlRef.current = urlOf;

  // The selected asset's file for the panel; a link's preview picture.
  useEffect(() => {
    // A link asset is a link whatever file it holds (assetType).
    const link = Boolean(details?.url);
    const sha = details?.kind !== 'asset' ? undefined : link ? details.preview : details.asset;
    const mime = details?.mime ?? '';
    if (!sha) {
      setFileUrl(null);
      return;
    }
    const known = urls.current.get(`${sha}|${mime}`);
    if (known) {
      setFileUrl(known);
      return;
    }
    // Not the last asset's file while this one loads.
    setFileUrl(null);
    let live = true;
    urlRef
      .current(sha, mime)
      .then((url) => {
        if (live) setFileUrl(url);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [details?.kind, details?.asset, details?.mime, details?.preview, details?.url]);

  // A link without a preview shown in the panel asks for it once (made before
  // previews, or offline then).
  useEffect(() => {
    const id = details?.kind === 'asset' && details.url && !details.preview ? details.id : null;
    if (id && !previewed.current.has(id)) void previewRef.current([id]);
  }, [details?.id, details?.kind, details?.url, details?.preview]);

  /**
   * Files dropped or pasted on the canvas become assets (05 §4.4): each keeps
   * its type, a picture shows in its body; a link becomes a link asset.
   * In a row from `w`, world coordinates; the last one is selected.
   */
  const addAssets = async (files: File[], links: string[], w: { x: number; y: number }) => {
    const g = graph.current;
    const v = viewRef.current;
    if (!g || !v) return;
    let i = 0;
    let last: string | null = null;
    const add = (name: string, attrs: [AttrKey, string][]) => {
      const id = newId();
      const x = w.x + i * 90;
      g.transaction({ key: 'proto.change.create', params: { name } }, (tx) => {
        tx.add(newNode({ id, name, kind: 'asset', icon: v.iconFor('asset'), x, y: w.y }));
        for (const [key, value] of attrs) tx.attr(id, key, value);
      });
      last = id;
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
    if (last) editor.current?.focusNode(last);
  };

  const dropFiles = (files: File[], links: string[], clientX: number, clientY: number) => {
    const v = viewRef.current;
    if (!v) return Promise.resolve();
    const r = v.canvas.getBoundingClientRect();
    return addAssets(files, links, v.camera.toWorld(clientX - r.left, clientY - r.top));
  };

  /**
   * The clipboard on the canvas (06 §12.1, 13 §3.9): pictures and files are
   * assets, a link is a link asset, other text a note — its first line the
   * name, the rest the body, where `[[links]]` become wires as in any note.
   */
  const paste = async (files: File[], text: string, w: { x: number; y: number }) => {
    const link = files.length === 0 && /^(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+$/i.test(text);
    if (files.length > 0 || link) {
      await addAssets(files, link ? [linkOf(text)] : [], w);
      return;
    }
    const g = graph.current;
    const v = viewRef.current;
    if (!g || !v) return;
    const [first = '', ...rest] = text.split(/\r?\n/);
    const name = first.replace(/^#+\s+/, '').trim() || t(locale, 'note.untitled');
    const body = rest.join('\n').replace(/^(?:[ \t]*\n)+/, '');
    const id = newId();
    g.transaction({ key: 'proto.change.create', params: { name } }, (tx) => {
      tx.add(newNode({ id, name, kind: 'note', icon: v.iconFor('note'), x: w.x, y: w.y }));
    });
    editor.current?.focusNode(id);
    if (!body) return;
    // The note is the core's before its content document is.
    await sync.current?.settled();
    const doc = await docs.current?.doc(id);
    if (!doc) return;
    noteText(doc).insert(0, body);
    doc.commit();
  };
  const pasteRef = useRef(paste);
  pasteRef.current = (files, text, w) => paste(files, text, w).catch(failed);

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const el = e.target;
      // Fields, editors and windows paste into themselves.
      if (
        el instanceof HTMLElement &&
        (el.isContentEditable || el.closest('input, textarea, .window, .dialog, .tab-menu'))
      ) {
        return;
      }
      const w = editor.current?.pasteSpot();
      const data = e.clipboardData;
      if (!w || !data) return;
      const files = [...data.files];
      const text = files.length > 0 ? '' : data.getData('text/plain').trim();
      if (files.length === 0 && !text) return;
      e.preventDefault();
      void pasteRef.current(files, text, w);
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, []);

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
              // The core gives the next colour of the palette (07 §2.2).
              [{ op: 'addPerson', id, name }],
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
          close: () => {
            ed?.deselect();
            setDetails(null);
            focusCanvas();
          },
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
        // The style the network's wires go to next (06 §6.2).
        {
          label: t(locale, `proto.change.wires.${ed.nextWireShape}` as MessageKey),
          hint: 'Shift+S',
          separated: true,
          onSelect: () => ed.cycleWireShape(),
        },
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
    // «Сделать проектом / задачей / папкой» (05 §4.2): a step of the core's,
    // the network read again so the canvas shows the new kind.
    const makeInto = (kind: 'project' | 'task' | 'network', key: MessageKey): MenuEntry => ({
      label: t(locale, key),
      onSelect: () =>
        void coreStep([{ op: 'setKind', id: n.id, kind }], 'change.kind', {
          name: n.name,
          kind: t(locale, `kind.${kind}` as MessageKey),
        })
          .then(() => loadRef.current())
          .catch(failed),
    });
    if (n.kind === 'task' || n.kind === 'network')
      items.push(makeInto('project', 'ctx.makeProject'));
    if (n.kind === 'project') {
      items.push(makeInto('task', 'ctx.makeTask'), makeInto('network', 'ctx.makeFolder'));
    }
    // The flags of 06 §8, ticked when every node they hit has them.
    const hit = ed.flagTargets(n.id).flatMap((id) => g.nodes.get(id) ?? []);
    const flag = (f: Flag, hint: string, separated = false): MenuEntry => ({
      label: t(locale, `flag.${f}` as MessageKey),
      hint,
      separated,
      checked: hit.every((x) => flagsOf(x).includes(f)),
      onSelect: () => ed.switchFlag(f, ed.flagTargets(n.id)),
    });
    items.push(flag('key', 'R', true), flag('pause', 'Q'), flag('template', 'E'));
    items.push({
      label: t(locale, 'ctx.delete'),
      hint: 'Del',
      separated: true,
      onSelect: () => ed.deleteSelected(),
    });
    return items;
  };

  // What «Перейти к ноде» ranks with, taken when it opens.
  const finderScope = useMemo<Scope>(
    () => (finder?.within ? { t: 'under', net: finder.within } : { t: 'all' }),
    [finder],
  );
  const finderVisits = useMemo(
    () => (finder ? visits(openedRef.current.workspace.id) : {}),
    [finder],
  );
  // Templates of the whole workspace for the Tab menu (06 §5.2); what this
  // screen has not written yet is in the tree after its next refresh.
  const templates = useMemo(
    () =>
      tree
        .filter((i) => i.flags?.includes('template'))
        .map((i) => ({ id: i.id, name: i.name, kind: i.kind })),
    [tree],
  );
  const nodes: MenuNode[] = g
    ? [...g.nodes.values()]
        .filter((n) => !n.ghostOf)
        .map((n) => ({ id: n.id, name: n.name, kind: n.kind }))
    : [];
  // This network's ghosts as the menu opens: the engine ranks them once per query.
  const ghosts = useMemo((): MenuGhost[] => {
    const now = graph.current;
    if (!menu || !now) return [];
    return [...now.nodes.values()].flatMap((n) =>
      n.ghostOf ? [{ id: n.id, name: n.name, from: now.nodes.get(n.ghostOf)?.name ?? '' }] : [],
    );
  }, [menu]);
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
      data-nodes={nodes.length}
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
          search={searchClient()}
        />
      ) : null}
      {net && view3d === '2d' ? (
        <PathBar
          locale={locale}
          path={net.path}
          kindOf={(id) => tree.find((i) => i.id === id)?.kind ?? 'network'}
          panel={details !== null}
          onGo={(id) => void loadRef.current(id)}
        />
      ) : null}
      <div ref={geckoHost} className="ws-gecko" data-panel={details ? 'open' : 'closed'}>
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
          viewerOpen={viewer?.id === details.id}
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
      {finder && (view3d === '3d') === finder.map ? (
        <NodeSearch
          locale={locale}
          label={t(
            locale,
            finder.map ? (finder.within ? 'map.findHere' : 'map.find') : 'search.goTo',
          )}
          className={finder.map ? 'map-search' : 'goto'}
          search={searchClient()}
          items={tree}
          scope={finderScope}
          here={finder.map ? undefined : netRef.current}
          visits={finderVisits}
          trash={finder.map ? undefined : (trash ?? undefined)}
          left={
            (host.current?.getBoundingClientRect().left ?? 0) + (host.current?.clientWidth ?? 0) / 2
          }
          top={(host.current?.getBoundingClientRect().top ?? 0) + 48}
          onChoose={(id, how) => {
            const map = finder.map;
            setFinder(null);
            visited(openedRef.current.workspace.id, id);
            if (map) {
              map3d.current?.flyTo(id);
              return;
            }
            focusCanvas();
            if (how === 'restore') {
              const item = trash?.find((x) => x.id === id);
              if (item) void restore(item).then(() => goNode(id, false));
              return;
            }
            goNode(id, how === 'open');
          }}
          onClose={() => {
            setFinder(null);
            focusCanvas();
          }}
        />
      ) : null}
      {finding && view3d === '2d' && g && ed ? (
        <FindBar
          locale={locale}
          search={searchClient()}
          graph={g}
          editor={ed}
          view={viewRef.current}
          net={netRef.current}
          tree={tree}
          onClose={() => {
            setFinding(false);
            focusCanvas();
          }}
        />
      ) : null}
      {menu ? (
        <TabMenu
          locale={locale}
          x={menu.sx}
          y={menu.sy}
          bounds={host.current?.getBoundingClientRect()}
          initialQuery={menu.query}
          named={menu.named}
          nodes={nodes}
          ghosts={ghosts}
          recent={recent}
          templates={templates}
          search={searchClient()}
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
      {viewer ? (
        <AssetWindow
          key={viewer.id}
          locale={locale}
          name={g?.nodes.get(viewer.id)?.name ?? ''}
          type={viewer.type}
          url={viewer.url}
          at={viewer.at}
          onFocus={setViewerFocus}
          onEscape={focusCanvas}
          onClose={() => {
            setViewer(null);
            setViewerFocus(false);
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
