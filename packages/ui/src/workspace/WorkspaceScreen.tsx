import {
  type AttrKey,
  assetType,
  type ChangeLabel,
  type CoreOp,
  CoreSync,
  type ExternalWire,
  type Flag,
  flagsOf,
  followExternal,
  followFolds,
  followGhosts,
  followPreviews,
  followWires,
  type Graph,
  graphOf,
  type History,
  type HomeBackend,
  hasCanvas,
  type ImportProgress,
  type ImportReport,
  isTask,
  linkOf,
  type NetworkView,
  type NodeDetails,
  type NodeKind,
  newId,
  newNode,
  type Opened,
  type Person,
  type Placeable,
  sniffMime,
  type TrashItem,
  type TrashPreview,
  type TreeItem,
} from '@strata/backend';
import {
  BACKDROP_SIDE,
  CanvasView,
  type DropHow,
  Editor,
  type EditorEvents,
  generatePreset,
  type IconAuthor,
  type IconPreset,
  iconPresets,
  type MenuTarget,
  type Pixels,
  processBackdrop,
  WIRE_SHAPES,
} from '@strata/canvas';
import { noteText } from '@strata/editor';
import { GeckoCompanion, type GeckoHandle, type GeckoNode } from '@strata/gecko';
import { type Locale, type MessageKey, t } from '@strata/i18n';
import type { Scope } from '@strata/search';
import { type Quality, qualityOf } from '@strata/view3d/map';
import type { LoroDoc } from 'loro-crdt';
import {
  type MutableRefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { linkPreview } from '../backend';
import { ContextMenu, type MenuEntry } from '../ContextMenu';
import { nodeIcon, nodeIconFile, nodeIconImages } from '../icons/Icon';
import { type Prefs, reading } from '../prefs';
import { BoardWindow } from '../proto/BoardWindow';
import { Layouter } from '../proto/layouter';
import {
  Map3D,
  type MapAction,
  type MapNav,
  type MapState,
  mapQuality,
  setMapQuality,
} from '../proto/map3d';
import { type MenuGhost, type MenuItem, type MenuNode, remember } from '../proto/menu';
import { NameInput } from '../proto/NameInput';
import { NoteWindow } from '../proto/NoteWindow';
import { menuOpening, TabMenu } from '../proto/TabMenu';
import { netItems, searchClient, visited, visits } from '../search';
import { Glyph } from '../TabBar';
import { AssetWindow, type Viewable, viewable } from './AssetWindow';
import { CommandPalette } from './CommandPalette';
import type { CommandContext } from './commands';
import { DeleteDialog } from './DeleteDialog';
import { CoreDocs } from './docs';
import { dueWord } from './due';
import { ExternalList } from './ExternalList';
import { canvasFind, FindBar, type FindTarget, mapFind } from './FindBar';
import { geckoEvents } from './gecko';
import { IconPalette, PRESET } from './IconPalette';
import { ImportReportWindow, type ReportActions } from './ImportReportWindow';
import { ImportStatus } from './ImportStatus';
import { Inspector, type InspectorActions } from './Inspector';
import { InterruptedDialog } from './InterruptedDialog';
import { fixedLines, fixLine, freshReport, jobOf, reportOf, reportShown } from './imports';
import { Layers } from './Layers';
import { mapItems, pathTo, placeIn, removeOps } from './mapSteps';
import { NodeSearch } from './NodeSearch';
import { loadMarks, markOf, type NavEntry, NavHistory } from './nav';
import { PathBar } from './PathBar';
import { pathLabel } from './paths';

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

/** Nodes cut or copied for `Ctrl+V` (06 §12.1): the network they lay in, where each stood. */
interface Clip {
  cut: boolean;
  net: string;
  nodes: { id: string; name: string; x: number; y: number }[];
}

/** Where a node made on the star map goes (08 §6.4). */
interface MapTarget {
  net: string;
  from: string | null;
  /** The Tab menu's header: `→ path · от «P»`. */
  target: string;
}

/** The star map's steps that this screen writes through the core (08 §6). */
type MapCalls = Pick<MapNav, 'create' | 'flag' | 'remove' | 'menu' | 'undo' | 'open'>;

const RECENT_KEY = 'strata.tabmenu.recent';
/** «Перейти к ноде» ranks the whole workspace (09 §3.4). */
const ALL: Scope = { t: 'all' };
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

/** A quick mark is set by holding its digit this long (06 §10.3). */
const MARK_HOLD_MS = 600;
const DIGITS: Partial<Record<string, number>> = {
  Digit1: 0,
  Digit2: 1,
  Digit3: 2,
  Digit4: 3,
  Digit5: 4,
};

const navKey = (ws: string) => `strata.nav.${ws}`;
const marksKey = (ws: string) => `strata.marks.${ws}`;

/** The device's own notes (05 §13): a private window may refuse them. */
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
    // The history and the marks are a convenience.
  }
}

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
  /** Back and forward over the places left (09 §6.1), as `Alt+←` / `Alt+→`. */
  back(): void;
  forward(): void;
}

/** What the bar shows of the open workspace: undo and redo, the star map. */
export interface UndoState {
  canUndo: boolean;
  canRedo: boolean;
  /** The step undo would take back, for its tooltip. */
  step: string;
  /** The star map is shown, or on its way. */
  map: boolean;
  /** There is a place to go back or forward to (09 §6.1). */
  canBack: boolean;
  canForward: boolean;
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
  /** The icon palette `Z` (07 §6.3): for these nodes, at a page point. */
  const [iconPick, setIconPick] = useState<{ ids: string[]; x: number; y: number } | null>(null);
  /** The presets with their authors, loaded when the palette first opens. */
  const [presets, setPresets] = useState<{
    authors: Record<string, IconAuthor>;
    icons: IconPreset[];
  } | null>(null);
  const [menu, setMenu] = useState<{
    sx: number;
    sy: number;
    query: string;
    named?: string;
    /** Each opening is a menu of its own (see `menuOpening`). */
    seq: number;
    /** Opened on the star map (08 §6.4): where the node goes, and the header saying so. */
    map?: MapTarget;
  } | null>(null);
  const [name, setName] = useState<{
    id: string;
    sx: number;
    sy: number;
    name: string;
    /** A node just made on the star map: its name is written by the core. */
    map?: MapTarget;
  } | null>(null);
  /** The right button's menu on the star map (08 §5.4): of a star, or of the map. */
  const [mapCtx, setMapCtx] = useState<{ x: number; y: number; id: string | null } | null>(null);
  /** The cluster in focus on the star map: its path and the quick marks show under it. */
  const [mapFocus, setMapFocus] = useState<string | null>(null);
  /** The quality of the star map chosen by hand, or `auto` (08 §8.4). */
  const [quality, setQuality] = useState<Quality | 'auto'>(() => mapQuality().manual ?? 'auto');
  const [toasts, setToasts] = useState<Toast[]>([]);
  /** Nodes cut or copied (06 §12.1); a cut one is half seen in its network until the paste. */
  const clipRef = useRef<Clip | null>(null);
  const [clipped, setClipped] = useState(false);
  /** «⊘ Нода уже здесь» beside the cursor (06 §12.1): its word; it follows the cursor by its ref. */
  const [cursorNote, setCursorNote] = useState<{ x: number; y: number; key: string } | null>(null);
  const noteEl = useRef<HTMLDivElement>(null);
  /**
   * The core's «may this network take them» (05 §5 rules 3–4) by network and
   * nodes, asked while a drag rests on a folder; null — asked. A step clears it.
   */
  const verdicts = useRef(new Map<string, Placeable | null>());
  /** A folder just wrapped whose name is being typed: the name joins the wrap's step (06 §13.3). */
  const naming = useRef<{ id: string; n: number } | null>(null);
  /** The steps of 06 §12.1 and §13.3 that the menus and «Ноды» start; set with the canvas. */
  const moves = useRef({
    paste: (_appearance: boolean, _at: { x: number; y: number }): void => undefined,
    layers: (_ids: string[], _to: string): void => undefined,
    named: (_id: string, _n: number, _name: string): void => undefined,
  });
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
    file: Blob | null;
    at: { x: number; y: number; side: 'left' | 'right' };
  } | null>(null);
  /** A list opened: its items are in the panel, the keyboard goes there once. */
  const [listFocus, setListFocus] = useState<string | null>(null);
  /** The shortcut of an appearance clicked: «Где размещена» takes the keyboard once (06 §12.2). */
  const [placesFocus, setPlacesFocus] = useState<string | null>(null);
  const [boardFocus, setBoardFocus] = useState(false);
  const [viewerFocus, setViewerFocus] = useState(false);
  const [view3d, setView3d] = useState<MapState>('2d');
  /** «Перейти к ноде» (09 §3.4): `Ctrl+O` on the canvas and on the star map (08 §10). */
  const [finder, setFinder] = useState<{ map: boolean } | null>(null);
  /** `Ctrl+F` on the canvas (09 §3.3) and on the star map (08 §6.1). */
  const [finding, setFinding] = useState(false);
  /** The report of the import that made this workspace (13 §3.6, S1 step 7). */
  const [importReport, setImportReport] = useState<ImportReport | null>(
    () => freshReport(opened.workspace.id) ?? null,
  );
  /** The import coming into this workspace (13 §3.3): its batches so far. */
  const [importing, setImporting] = useState<ImportProgress | null>(null);
  const importingRef = useRef(false);
  importingRef.current = importing !== null;
  /** The vault of an import the app left in the middle (10 §3.3): asked once. */
  const [interrupted, setInterrupted] = useState<string | null>(null);
  /** The report's lines fixed this session (13 §3.6). */
  const [fixed, setFixed] = useState<ReadonlySet<number>>(() => fixedLines(opened.workspace.id));
  /** A removal that asks first (06 §12.3), and the question's data. */
  const [removal, setRemoval] = useState<{
    ids: string[];
    everywhere: boolean;
    placed: NodeDetails[];
    preview: TrashPreview;
    /** From the star map (08 §6.7): the contextual network it leaves. */
    map?: string;
  } | null>(null);
  const askDeleteRef = useRef<(ids: string[], everywhere: boolean) => boolean>(() => false);
  /** Who hears «the cluster in focus or the selected star changed» on the map. */
  const mapChanged = useRef(new Set<() => void>());
  /** The command palette, `Ctrl+P` (09 §3.5). */
  const [palette, setPalette] = useState(false);
  /** The list behind a node's «↗N» (06 §14), by the mark at (x, y); `wires` null until the core answers. */
  const [external, setExternal] = useState<{
    id: string;
    x: number;
    y: number;
    flipX: number;
    wires: ExternalWire[] | null;
    /** Other ends this network may not hold (05 §5 rule 4): «Показать здесь» is off for them. */
    cycle: ReadonlySet<string>;
  } | null>(null);
  const [trash, setTrash] = useState<TrashItem[] | null>(null);
  /** The core's undo and redo: the session's, across networks (05 §11). */
  const [history, setHistory] = useState<History>({ undo: null, redo: null });
  const [recent, setRecent] = useState<string[]>(loadRecent);
  const [, setVersion] = useState(0);
  /**
   * What network `net` may take of `ids` (05 §5 rules 3–4), from the core
   * once per step: null until it answers, then the canvas and «Ноды» redraw.
   */
  const placeableRef = useRef((net: string, ids: readonly string[]): Placeable | null => {
    const asked = verdicts.current;
    const key = `${net}|${ids.join(',')}`;
    if (asked.has(key)) return asked.get(key) ?? null;
    asked.set(key, null);
    void (sync.current?.settled() ?? Promise.resolve())
      .then(() => core.placeable(net, [...ids]))
      .then((p) => {
        if (verdicts.current !== asked) return;
        asked.set(key, p);
        viewRef.current?.invalidate();
        setVersion((v) => v + 1);
      })
      .catch(() => asked.delete(key));
    return null;
  });
  /** The selected node, read from the core for the properties panel. */
  const [details, setDetails] = useState<NodeDetails | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const peopleRef = useRef<Person[]>([]);
  const [tree, setTree] = useState<TreeItem[]>([]);
  const [ctx, setCtx] = useState<{ x: number; y: number; at: MenuTarget } | null>(null);
  /** Pictures shown in bubbles: node → asset; and asset → object URL for the panel. */
  const shown = useRef(new Map<string, string>());
  const urls = useRef(new Map<string, string>());
  /** The file behind each object URL: pdf.js reads it, the CSP lets no fetch of `blob:` (ADR-0013). */
  const blobs = useRef(new Map<string, Blob>());
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const refreshRef = useRef<() => void>(() => undefined);
  /** Fetches the previews of these link assets (✅ Q-13-16); set with the canvas. */
  const previewRef = useRef<(ids: string[]) => Promise<void>>(async () => {});
  /** Link assets already asked for a preview this session. */
  const previewed = useRef(new Set<string>());
  const eventsRef = useRef<EditorEvents | null>(null);
  /** Where one has been, and the quick marks, on this device (09 §6.1–6.2). */
  const navRef = useRef(NavHistory.load(readLocal(navKey(opened.workspace.id))));
  const [marks, setMarks] = useState(() => loadMarks(readLocal(marksKey(opened.workspace.id))));
  const [navState, setNavState] = useState({
    back: navRef.current.canBack,
    forward: navRef.current.canForward,
  });
  /** The screen now as an entry of the history; a step that goes somewhere leaves it. */
  const hereRef = useRef<() => NavEntry>(() => ({ mode: '2d', net: opened.root, at: 0 }));
  const leaveRef = useRef<() => void>(() => undefined);
  /** To an entry: its view, network, camera and selection. */
  const walkRef = useRef<(e: NavEntry) => Promise<void>>(async () => {});
  /** The history on this device and in the bar after it changed. */
  const saveNav = () => {
    writeLocal(navKey(openedRef.current.workspace.id), navRef.current.save());
    setNavState({ back: navRef.current.canBack, forward: navRef.current.canForward });
  };
  /** The history's own step is going on: it leaves no entry. */
  const walking = useRef(false);
  /** A place in 2D to show once the star map is gone. */
  const pending = useRef<NavEntry | null>(null);
  /** A place on the map to fly to once the map is shown. */
  const pending3d = useRef<NavEntry | null>(null);
  const view3dRef = useRef<MapState>('2d');
  /** The minimap (06 §10.3): open or closed for every network of the session. */
  const [minimap, setMinimap] = useState(false);
  const minimapRef = useRef(false);
  const placeRef = useRef<(e: NavEntry) => Promise<void>>(async () => {});
  const localeRef = useRef(locale);
  localeRef.current = locale;
  const prefsRef = useRef(props.prefs);
  prefsRef.current = props.prefs;
  /** A network loads under the star map for it (08 §7.2): the map stays and lands there. */
  const keepMap = useRef(false);
  /** Steps on the star map changed the core: the canvas reads its network again before 2D. */
  const canvasStale = useRef(false);
  /** The map's steps written by the core, as this render has them. */
  const mapCalls = useRef<MapCalls | null>(null);
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
      // Changes wait while an import is written (13 §3.3).
      if (importingRef.current) toast('import.busy');
      else toast('ws.refused', { message: e instanceof Error ? e.message : String(e) });
      void loadRef.current();
    };

    const events: EditorEvents = {
      // The editor speaks in points of the canvas, which sits right of «Слои»:
      // the Tab menu is fixed to the page, the name field lies in this screen.
      // `Z` (07 §6.3): the palette at the cursor; the presets load once.
      icons: (e) => {
        const r = el.getBoundingClientRect();
        setIconPick({ ids: e.ids, x: e.sx + r.left, y: e.sy + r.top });
        void iconPresets().then(setPresets, refused);
      },
      tabMenu: (e) => {
        const r = el.getBoundingClientRect();
        // The menu ranks the canvas's nodes as they are now (09 §2.7).
        const g = graph.current;
        if (g) searchClient().set('net', netItems(g.nodes.values(), netRef.current));
        setMenu({ ...e, sx: e.sx + r.left, sy: e.sy + r.top, seq: menuOpening() });
      },
      nameInput: (e) =>
        setName(e ? { ...e, sx: e.sx + el.offsetLeft, sy: e.sy + el.offsetTop } : null),
      toast: (e) => toast(e.key, e.params, e.key !== 'proto.toast.exists'),
      // No explanatory lines on screen: hints live in tooltips and menus.
      hint: () => undefined,
      change: () => {
        // A step may have moved what a network holds: its verdicts are asked again.
        verdicts.current = new Map();
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
      // «Разместить здесь» (05 §5): the core places it, the network is read again.
      place: (e) => {
        void queue(async () => {
          await sync.current?.settled();
          const name = treeRef.current.find((i) => i.id === e.id)?.name ?? '';
          const net = netRef.current;
          await core.apply(
            [
              { op: 'place', id: e.id, net, x: e.x, y: e.y },
              ...e.inputs.map((from): CoreOp => ({ op: 'connect', from, to: e.id })),
            ],
            { key: 'ws.change.place', params: { name } },
          );
          await show(net);
          editor.current?.reveal(e.id);
        }).catch(refused);
      },
      // Removing asks first when it would take more than one would see (06 §12.3).
      deleting: (e) => askDeleteRef.current(e.ids, e.everywhere),
      // `Ctrl+X` / `Ctrl+C` (06 §12.1): the nodes and where they stood; a cut is half seen.
      clip: (e) => {
        const g = graph.current;
        if (!g) return;
        const nodes = e.ids.flatMap((id) => {
          const n = g.nodes.get(id);
          return n && !n.ghostOf ? [{ id, name: n.name, x: n.x, y: n.y }] : [];
        });
        if (nodes.length === 0) return;
        clipRef.current = { cut: e.cut, net: netRef.current, nodes };
        setClipped(true);
        viewRef.current?.setCut(e.cut ? nodes.map((n) => n.id) : []);
      },
      paste: (e) => {
        if (!clipRef.current) return false;
        void pasteNodes(e.appearance, e);
        return true;
      },
      // `Esc` takes a cut back in the network it was made in (☑ Q-06-17).
      uncut: () => {
        const c = clipRef.current;
        if (!c?.cut || c.net !== netRef.current) return;
        clipRef.current = null;
        setClipped(false);
        viewRef.current?.setCut([]);
      },
      wrap: (e) => void wrap(e),
      into: (e) => void dropInto(e),
      // The word comes and goes with a render; it follows the cursor without one.
      cursorNote: (e) => {
        if (!e) {
          setCursorNote(null);
          return;
        }
        const r = el.getBoundingClientRect();
        const x = e.sx + r.left;
        const y = e.sy + r.top;
        if (noteEl.current) {
          noteEl.current.style.left = `${x}px`;
          noteEl.current.style.top = `${y}px`;
        }
        setCursorNote((c) => (c?.key === e.key ? c : { x, y, key: e.key }));
      },
      // «↗N» (06 §14): the list opens beside the mark at once, its top level
      // with it, clear of the label under the bubble; the rows come from the core.
      external: (e) => {
        const r = el.getBoundingClientRect();
        const net = netRef.current;
        const v = viewRef.current;
        const n = v?.nodeAt(e.id);
        const left = v && n ? v.camera.toScreen(n.x - n.r, n.y).x : e.sx;
        const at = {
          id: e.id,
          x: e.sx + r.left + 16,
          y: e.sy + r.top - 12,
          flipX: left + r.left - 16,
        };
        setExternal({ ...at, wires: null, cycle: new Set() });
        void (sync.current?.settled() ?? Promise.resolve())
          .then(async () => {
            const wires = await core.external(net, e.id);
            const { cycle } = await core.placeable(
              net,
              wires.map((w) => w.id),
            );
            setExternal((x) =>
              x?.id === e.id && netRef.current === net ? { ...x, wires, cycle: new Set(cycle) } : x,
            );
          })
          .catch(refused);
      },
      // The shortcut of an appearance (06 §12.2): the node is chosen, its
      // panel shows «Где размещена».
      places: (e) => setPlacesFocus(e.id),
      map: () => map3d.current?.toggle(),
      minimap: (open) => {
        minimapRef.current = open;
        setMinimap(open);
      },
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
          leaveRef.current();
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
          setViewer({ id, type, url: null, file: null, at });
          if (!sha) return;
          viewerFile(sha, n.attrs.mime ?? '')
            .then((f) => setViewer((w) => (w?.id === id ? { ...w, ...f } : w)))
            .catch(refused);
          return;
        }
        d.doc(id).then((doc) => setNote({ id, doc, at }), refused);
      },
    };

    /**
     * The star map works in the whole space from the core (08 §6, §10): its
     * steps are the core's; a network it bridges into loads under it first.
     */
    const mapNav: MapNav = {
      space: async () => {
        await sync.current?.settled();
        const [items, wires] = await Promise.all([core.tree(), core.wires()]);
        return { items: mapItems(items), wires };
      },
      network: () => netRef.current,
      change: () => {
        for (const fn of mapChanged.current) fn();
        setMapFocus(map3d.current?.focusId() ?? null);
      },
      load: async (net, node, camera) => {
        keepMap.current = true;
        try {
          if (camera) cameras.current.set(net, camera);
          if (net !== netRef.current || canvasStale.current) {
            canvasStale.current = false;
            await loadRef.current(net);
          } else if (camera && viewRef.current) {
            const c = viewRef.current.camera;
            c.x = camera.x;
            c.y = camera.y;
            c.zoom = camera.zoom;
          }
          if (node) editor.current?.focusNode(node);
        } finally {
          keepMap.current = false;
        }
      },
      leave: () => leaveRef.current(),
      get workspace() {
        return openedRef.current.workspace.id;
      },
      words: () => ({ locale: localeRef.current, date: reading(prefsRef.current).date }),
      person: (id) => peopleRef.current.find((p) => p.id === id)?.name,
      details: async (id) => {
        await sync.current?.settled();
        return core.node(id);
      },
      open: (id, at) => mapCalls.current?.open(id, at) ?? false,
      create: (at) => mapCalls.current?.create(at),
      flag: (ids, flag) => mapCalls.current?.flag(ids, flag),
      remove: (id, net, everywhere) => mapCalls.current?.remove(id, net, everywhere),
      menu: (x, y, id) => mapCalls.current?.menu(x, y, id),
      undo: (redo) => mapCalls.current?.undo(redo),
      toast: (key) => toast(key),
      measure: !new URLSearchParams(window.location.search).has('plain'),
    };

    /** Where the screen is: the view, the network or cluster, the camera, the selection. */
    hereRef.current = () => {
      const v = viewRef.current;
      const three = view3dRef.current !== '2d';
      const selection = editor.current?.selected ?? [];
      // A 3D place keeps its camera too: a quick mark flies back to it (09 §6.2).
      const camera3d = three ? map3d.current?.cameraNow() : null;
      return {
        mode: three ? '3d' : '2d',
        net: three ? (map3d.current?.focusId() ?? netRef.current) : netRef.current,
        ...(v && !three ? { camera: { x: v.camera.x, y: v.camera.y, zoom: v.camera.zoom } } : {}),
        ...(camera3d ? { camera3d } : {}),
        ...(selection.length > 0 && !three ? { selection } : {}),
        at: Date.now(),
      };
    };
    leaveRef.current = () => {
      if (walking.current) return;
      navRef.current.leave(hereRef.current());
      saveNav();
    };
    /** A 2D entry: its network with its camera, its selection. */
    const place = async (e: NavEntry) => {
      if (e.net !== netRef.current) {
        if (e.camera) cameras.current.set(e.net, e.camera);
        await loadRef.current(e.net);
      } else if (e.camera) {
        viewRef.current?.flyTo(e.camera);
      }
      editor.current?.selectNodes(e.selection ?? []);
    };
    placeRef.current = place;
    walkRef.current = async (e: NavEntry) => {
      walking.current = true;
      try {
        const now = view3dRef.current;
        if (e.mode === '2d') {
          // From the star map: the bridge lands straight in the place's
          // network and camera (08 §7.2); its selection once the canvas is back.
          if (now === '3d') {
            const { camera: _, ...rest } = e;
            pending.current = rest;
            map3d.current?.leaveTo(e.net, e.camera);
            return;
          }
          if (now === '2d') await place(e);
          return;
        }
        // A place on the map: from the map, a flight to its camera; from the
        // canvas, the bridge first (09 §6.2).
        if (now === '3d') {
          map3d.current?.goPlace(e.net, e.camera3d);
          return;
        }
        if (now !== '2d') return;
        if (e.net !== netRef.current) await loadRef.current(e.net);
        pending3d.current = e;
        map3d.current?.toggle();
      } finally {
        walking.current = false;
      }
    };

    const up = async () => {
      const path = await core.view(netRef.current).then((v) => v.path);
      const parent = path.at(-2);
      if (!parent) return;
      leaveRef.current();
      await loadRef.current(parent[0]);
    };

    /** The graph's text wires and ghosts as the core has them, outside undo (05 §8.2, §8.5). */
    const followLinks = (g: Graph, nv: NetworkView) => {
      textWires.current = new Set(nv.edges.filter((e) => e.text).map((e) => pair(e.from, e.to)));
      followWires(g, nv);
      followGhosts(g, nv, viewRef.current?.iconFor('note') ?? 0);
      // A wire to a node elsewhere, by hand or from text: «↗N» and the roll-ups (05 §8.3).
      followExternal(g, nv);
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
      // The star map asked for this network (08 §7.2): it stays and lands
      // here; any other load ends it.
      const keep = keepMap.current && map3d.current !== null && map3d.current.state !== '2d';
      if (!keep) map3d.current?.destroy();
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
      // A drag resting on a folder asks the core whether it may go in (06 §12.1).
      ed.placeable = (to, ids) => placeableRef.current(to, ids);
      verdicts.current = new Map();
      setCursorNote(null);
      // What was cut here stays half seen until the paste or `Esc` (☑ Q-06-17).
      const c = clipRef.current;
      v.setCut(c?.cut && c.net === id ? c.nodes.map((n) => n.id) : []);
      // The properties panel covers the canvas's right edge while one node is
      // chosen: framing keeps clear of it (review 2026-10-24).
      ed.coveredRight = () =>
        ed.selection.size === 1
          ? (el.parentElement?.querySelector<HTMLElement>('.ws-panel-probe')?.offsetWidth ?? 0)
          : 0;
      ed.ringMode = ringModeRef.current;
      ed.minimap.open = minimapRef.current;
      editor.current = ed;
      sync.current = new CoreSync(core, g, id, refused, setHistory);
      if (keep && map3d.current) {
        map3d.current.adopt(g);
      } else {
        map3d.current = new Map3D(el, v, g, setView3d, mapNav);
        // A network loads onto the canvas: the screen is in 2D with the new map,
        // even when the old one was open (another tab under the star map).
        setView3d('2d');
      }
      netRef.current = id;
      setNet(nv);
      setMenu(null);
      setName(null);
      setExternal(null);
      // A flight under way belongs to the network left (a paste framed there).
      v.stopFlight();
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

    /** A node's or network's name, from the tree or the canvas. */
    const nameOf = (id: string) =>
      treeRef.current.find((i) => i.id === id)?.name ?? graph.current?.nodes.get(id)?.name ?? '';

    /** Where nodes going into `net` stand (06 §12.1): right of what lies there, as they stood. */
    const spotsIn = async (net: string, nodes: readonly { x: number; y: number }[]) => {
      const there = (await core.view(net)).nodes;
      const x0 = there.length > 0 ? Math.max(...there.map((n) => n.x)) + 200 : 0;
      const y0 = there.length > 0 ? Math.min(...there.map((n) => n.y)) : 0;
      const minX = Math.min(...nodes.map((n) => n.x));
      const minY = Math.min(...nodes.map((n) => n.y));
      return nodes.map((n) => ({ x: x0 + n.x - minX, y: y0 + n.y - minY }));
    };

    /** Folders that would lie in themselves (05 §5 rule 4) stay where they are; the toast names them. */
    const looped = (nodes: readonly { name: string }[]) => {
      if (nodes.length > 0) toast('ws.toast.cycle', { names: nodes.map((n) => n.name).join(', ') });
    };

    /** «Перенести» onto where a node lies already (05 §5): the one there stays, the toast says so. */
    const wasHere = (n: number) => {
      if (n > 0) toast(n === 1 ? 'ws.toast.wasHere' : 'ws.toast.wereHere', { n });
    };

    /** Nodes a step took out of `net` are no longer cut there. */
    const leftClip = (net: string, ids: readonly string[]) => {
      const c = clipRef.current;
      if (!c?.cut || c.net !== net) return;
      const nodes = c.nodes.filter((n) => !ids.includes(n.id));
      clipRef.current = nodes.length > 0 ? { ...c, nodes } : null;
      setClipped(nodes.length > 0);
      if (netRef.current === net) viewRef.current?.setCut(nodes.map((n) => n.id));
    };

    /**
     * `Ctrl+V` and `Ctrl+Shift+V` (06 §12.1) of what was cut or copied, at
     * (x, y) as the nodes stood: a cut — «Перенести», a copy — the nodes with
     * all inside them, an appearance — «Разместить здесь» (05 §5). One step.
     */
    const pasteNodes = (appearance: boolean, at: { x: number; y: number }) =>
      queue(async () => {
        const c = clipRef.current;
        if (!c) return;
        await sync.current?.settled();
        const net = netRef.current;
        const cx = c.nodes.reduce((a, n) => a + n.x, 0) / c.nodes.length;
        const cy = c.nodes.reduce((a, n) => a + n.y, 0) / c.nodes.length;
        const nodes = c.nodes.map((n) => ({ ...n, x: at.x + n.x - cx, y: at.y + n.y - cy }));
        const ids = nodes.map((n) => n.id);
        if (!c.cut && !appearance) {
          const { ids: made } = await core.copyNodes(
            nodes.map(({ id, x, y }) => ({ id, x, y })),
            net,
            { key: 'proto.change.copy', params: { n: nodes.length } },
          );
          await show(net);
          editor.current?.selectNodes(made);
          return;
        }
        const [from, here] = await Promise.all([
          c.cut ? core.placeable(c.net, ids) : Promise.resolve(null),
          core.placeable(net, ids),
        ]);
        // A cut node that left its network since (moved, in the trash) stays out of it.
        const live = nodes.filter((n) => !from || from.here.includes(n.id));
        looped(live.filter((n) => here.cycle.includes(n.id)));
        const fit = live.filter((n) => !here.cycle.includes(n.id));
        const to = nameOf(net);
        if (appearance) {
          // Where the node lies already it cannot appear (05 §5 rule 3): it is framed.
          const already = fit.filter((n) => here.here.includes(n.id));
          const go = fit.filter((n) => !here.here.includes(n.id));
          if (already.length > 0) toast('canvas.isHere');
          if (go.length > 0) {
            await core.apply(
              go.map((n): CoreOp => ({ op: 'place', id: n.id, net, x: n.x, y: n.y })),
              { key: 'ws.change.placeIn', params: { n: go.length, to } },
            );
            await show(net);
          }
          editor.current?.flyTo([...go, ...already].map((n) => n.id));
          return;
        }
        if (fit.length > 0) {
          await core.apply(
            fit.map(
              (n): CoreOp => ({ op: 'relocate', id: n.id, from: c.net, to: net, x: n.x, y: n.y }),
            ),
            { key: 'ws.change.relocate', params: { n: fit.length, to } },
          );
        }
        // The cut is done: what could not go stays whole where it was.
        clipRef.current = null;
        setClipped(false);
        viewRef.current?.setCut([]);
        if (c.net !== net) wasHere(fit.filter((n) => here.here.includes(n.id)).length);
        await show(net);
        editor.current?.selectNodes(fit.map((n) => n.id));
      }).catch(refused);

    /**
     * A drag let go on a folder's or project's bubble after 500 ms (06 §12.1):
     * the nodes go inside — moved, the copies just made, or as appearances.
     * One step of undo with what the gesture wrote before (`amend`).
     */
    const dropInto = (e: { ids: string[]; into: string; how: DropHow; amend: boolean }) =>
      queue(async () => {
        await sync.current?.settled();
        const net = netRef.current;
        const g = graph.current;
        const nodes = e.ids.flatMap((id) => {
          const n = g?.nodes.get(id);
          return n ? [{ id, name: n.name, x: n.x, y: n.y }] : [];
        });
        const p = await core.placeable(e.into, e.ids);
        looped(nodes.filter((n) => p.cycle.includes(n.id)));
        const go = nodes.filter(
          (n) => !p.cycle.includes(n.id) && !(e.how === 'appear' && p.here.includes(n.id)),
        );
        if (go.length > 0) {
          const spots = await spotsIn(e.into, go);
          const to = nameOf(e.into);
          const ops = go.map((n, i): CoreOp => {
            const { x, y } = spots[i] ?? { x: 0, y: 0 };
            return e.how === 'appear'
              ? { op: 'place', id: n.id, net: e.into, x, y }
              : { op: 'relocate', id: n.id, from: net, to: e.into, x, y };
          });
          const params = { n: go.length, to };
          const label =
            e.how === 'appear'
              ? { key: 'ws.change.placeIn', params }
              : e.how === 'copy'
                ? { key: 'proto.change.copy', params }
                : { key: 'ws.change.relocate', params };
          await core.apply(ops, label, e.amend);
          if (e.how !== 'appear') {
            wasHere(go.filter((n) => p.here.includes(n.id)).length);
            leftClip(
              net,
              go.map((n) => n.id),
            );
          }
        }
        await show(net);
        editor.current?.selectNodes(e.how === 'appear' ? go.map((n) => n.id) : [e.into]);
      }).catch(refused);

    /**
     * «Обернуть в папку» (06 §13.3, 05 §4.2): a folder at the nodes' middle,
     * their placements inside as they stood, wires as they were; one step. One
     * node names it; for several the name is typed next, into the same step.
     */
    const wrap = (e: { ids: string[]; x: number; y: number }) =>
      queue(async () => {
        await sync.current?.settled();
        const net = netRef.current;
        const nodes = e.ids.flatMap((id) => graph.current?.nodes.get(id) ?? []);
        if (nodes.length === 0) return;
        const id = newId();
        const one = nodes.length === 1 ? nodes[0] : undefined;
        const name = one?.name || t(localeRef.current, 'kind.network');
        await core.apply(
          [
            { op: 'createNode', id, kind: 'network', name, net, x: e.x, y: e.y },
            ...nodes.map(
              (n): CoreOp => ({
                op: 'relocate',
                id: n.id,
                from: net,
                to: id,
                x: n.x - e.x,
                y: n.y - e.y,
              }),
            ),
          ],
          { key: 'ws.change.wrap', params: { n: nodes.length, name } },
        );
        leftClip(
          net,
          nodes.map((n) => n.id),
        );
        await show(net);
        editor.current?.reveal(id);
        if (!one) {
          naming.current = { id, n: nodes.length };
          editor.current?.rename(id);
        }
      }).catch(refused);

    moves.current = {
      paste: (appearance, at) => void pasteNodes(appearance, at),
      // Rows of «Ноды» dropped on a folder or project (05 §5 «Перенести»): their
      // primary placements move there, as they stood on the canvas; one step.
      layers: (ids, to) =>
        void queue(async () => {
          await sync.current?.settled();
          const g = graph.current;
          const here = netRef.current;
          const items = ids
            .flatMap((id) => treeRef.current.find((i) => i.id === id) ?? [])
            .filter((i) => i.parent !== undefined && i.parent !== to);
          if (items.length === 0) return;
          const p = await core.placeable(
            to,
            items.map((i) => i.id),
          );
          looped(items.filter((i) => p.cycle.includes(i.id)));
          const go = items.filter((i) => !p.cycle.includes(i.id));
          if (go.length === 0) return;
          const spots = await spotsIn(
            to,
            go.map((i, k) => {
              const n = i.parent === here ? g?.nodes.get(i.id) : undefined;
              return n ? { x: n.x, y: n.y } : { x: k * 140, y: 0 };
            }),
          );
          await core.apply(
            go.map(
              (i, k): CoreOp => ({
                op: 'relocate',
                id: i.id,
                from: i.parent ?? '',
                to,
                x: spots[k]?.x ?? 0,
                y: spots[k]?.y ?? 0,
              }),
            ),
            { key: 'ws.change.relocate', params: { n: go.length, to: nameOf(to) } },
          );
          wasHere(go.filter((i) => p.here.includes(i.id)).length);
          for (const i of go) leftClip(i.parent ?? '', [i.id]);
          await show(here);
        }).catch(refused),
      // The wrapped folder's name joins the wrap's step (06 §13.3).
      named: (id, n, name) =>
        void queue(async () => {
          await sync.current?.settled();
          await core.apply(
            [{ op: 'rename', id, name }],
            { key: 'ws.change.wrap', params: { n, name } },
            true,
          );
          await show(netRef.current);
          editor.current?.reveal(id);
        }).catch(refused),
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
      // The core's own edits of open texts: links a rename rewrote (13 §6.5).
      void (sync.current?.settled() ?? Promise.resolve()).then(() => docs.current?.follow());
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
          // A step made since the question is not in the answer yet; the
          // looks read back below move the version too, so it is asked first.
          const fresh = g.version === at;
          followFolds(g, nv);
          if (fresh) followLinks(g, nv);
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
      // The flag ring's slots: their names and keys, as the menu has them (06 §8).
      v.flagWord = (flag) =>
        t(localeRef.current, 'canvas.slot', {
          name: t(localeRef.current, `flag.${flag}`),
          key: { key: 'R', pause: 'Q', template: 'E' }[flag],
        });
      // The rim's marks in words (06 §12.2, §14): what ↳, «×N» and «↗N» mean.
      v.markWord = (mark, n) =>
        mark === 'external'
          ? t(localeRef.current, 'canvas.mark.external', { n: n.external })
          : t(localeRef.current, n.appearance ? 'canvas.mark.appearance' : 'canvas.mark.places', {
              n: n.places,
            });
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

  // A copy waits for `Ctrl+V` while one stays here: away in another app, the
  // clipboard may come to hold something else to paste (13 §3.9). A cut stays.
  useEffect(() => {
    const away = () => {
      if (!clipRef.current || clipRef.current.cut) return;
      clipRef.current = null;
      setClipped(false);
    };
    window.addEventListener('blur', away);
    return () => window.removeEventListener('blur', away);
  }, []);

  // The canvas's words follow the language: deadlines under labels (Q-07-22).
  useEffect(() => {
    if (locale) viewRef.current?.invalidate();
  }, [locale]);

  useEffect(() => {
    // «Настройки» in front cover the canvas: its keys are off too (✅ Q-06-23).
    editor.current?.setOverlayOpen(
      menu !== null ||
        iconPick !== null ||
        name !== null ||
        finder !== null ||
        palette ||
        view3d !== '2d' ||
        boardFocus ||
        viewerFocus ||
        covered,
    );
  }, [menu, iconPick, name, finder, palette, view3d, boardFocus, viewerFocus, covered]);

  useEffect(() => {
    ringModeRef.current = props.prefs.ring;
    if (editor.current) editor.current.ringMode = props.prefs.ring;
  }, [props.prefs.ring]);

  // The search knows the workspace's names (09 §2.7): the core's tree, as it changes.
  useEffect(() => searchClient().set('space', tree), [tree]);

  // The keys are there as soon as the view is: a layout effect runs in the
  // commit that shows the star map, a passive one after paint, and a key
  // pressed between the two was lost (CI under load).
  useLayoutEffect(() => {
    // Mid-bridge (08 §7) neither view takes keys.
    if (view3d === 'to3d' || view3d === 'to2d') return;
    // A search window and the palette take their own keys while open.
    if (finder || palette || covered) return;
    const key = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      // `Ctrl+P` — the palette, on the canvas and on the star map (09 §3.5).
      if (mod && !e.altKey && !e.shiftKey && e.code === 'KeyP') {
        const t = e.target as HTMLElement | null;
        const typing =
          t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
        if (typing || menu || name) return;
        e.preventDefault();
        setFinding(false);
        setPalette(true);
        return;
      }
      const search = mod && !e.altKey && !e.shiftKey && (e.code === 'KeyO' || e.code === 'KeyF');
      // A note's or a list's own search keeps its keys; so does any field,
      // and a window over the star map (08 §5.4) — `Esc` gives the keys back.
      const target = e.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable ||
          (view3d !== '2d' && target.closest('.window, .dialog, .context-menu') !== null));
      if (view3d === '2d') {
        if (!search || typing || menu || name) return;
        e.preventDefault();
        if (e.code === 'KeyO') {
          setFinding(false);
          setFinder({ map: false });
        } else {
          setFinding(true);
        }
        return;
      }
      if (typing || menu || name || mapCtx || removal) return;
      if (search) {
        e.preventDefault();
        if (e.code === 'KeyF') {
          setFinder(null);
          setFinding(true);
        } else {
          setFinding(false);
          setFinder({ map: true });
        }
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
  }, [view3d, finder, palette, covered, menu, name, mapCtx, removal]);

  // A window opened over the star map belongs to it (08 §6.3): back in 2D it
  // stays only for a node of the canvas's network.
  // biome-ignore lint/correctness/useExhaustiveDependencies: on the view's change only
  useEffect(() => {
    setMapCtx(null);
    if (view3d !== '2d') return;
    const now = graph.current;
    const off = (id: string | undefined) => id !== undefined && !now?.nodes.has(id);
    if (off(note?.id) || off(board?.id)) void docs.current?.flush();
    if (off(note?.id)) setNote(null);
    if (off(board?.id)) {
      setBoard(null);
      setBoardFocus(false);
    }
    if (off(viewer?.id)) {
      setViewer(null);
      setViewerFocus(false);
    }
  }, [view3d]);

  // A search of one view closes with it (2D ↔ 3D) — in the commit that
  // changes the view: after paint it would close a `Ctrl+F` typed at once.
  useLayoutEffect(() => {
    setFinder((f) => (f && f.map !== (view3d === '3d') ? null : f));
    setFinding(false);
  }, [view3d]);

  // The history's place in 2D, once the star map has gone (09 §6.1); its
  // place on the map once the map is there.
  useEffect(() => {
    view3dRef.current = view3d;
    const e3 = pending3d.current;
    if (view3d === '3d' && e3) {
      pending3d.current = null;
      map3d.current?.goPlace(e3.net, e3.camera3d);
    }
    const e = pending.current;
    if (view3d !== '2d' || !e) return;
    pending.current = null;
    walking.current = true;
    void placeRef.current(e).finally(() => {
      walking.current = false;
    });
  }, [view3d]);

  /** `Alt+←`, `Alt+→`, `` ` `` (09 §6.1). */
  const walk = useCallback((how: 'back' | 'forward' | 'previous') => {
    const nav = navRef.current;
    const now = hereRef.current();
    const to =
      how === 'back' ? nav.back(now) : how === 'forward' ? nav.forward(now) : nav.previous(now);
    if (!to) return;
    writeLocal(navKey(openedRef.current.workspace.id), nav.save());
    setNavState({ back: nav.canBack, forward: nav.canForward });
    void walkRef.current(to);
  }, []);

  /** Quick marks (09 §6.2): set — the place now, without the selection; go — a step of the history. */
  const setMark = useCallback((i: number) => {
    setMarks((all) => {
      const next = [...all];
      next[i] = markOf(hereRef.current());
      writeLocal(marksKey(openedRef.current.workspace.id), JSON.stringify(next));
      return next;
    });
  }, []);
  const clearMark = useCallback((i: number) => {
    setMarks((all) => {
      const next = [...all];
      next[i] = null;
      writeLocal(marksKey(openedRef.current.workspace.id), JSON.stringify(next));
      return next;
    });
  }, []);
  const marksRef = useRef(marks);
  marksRef.current = marks;
  const goMark = useCallback((i: number) => {
    const m = marksRef.current[i];
    if (!m) return;
    leaveRef.current();
    void walkRef.current(m);
  }, []);

  // The history's and the marks' keys (06 §10.3), on the canvas and the star
  // map; a layout effect for the same reason as the view's keys above.
  useLayoutEffect(() => {
    if (view3d === 'to3d' || view3d === 'to2d' || finder || palette || covered) return;
    // A digit held: its timer, or -1 once the mark is set.
    const held = new Map<string, number>();
    const down = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (menu || name || e.isComposing) return;
      const mod = e.metaKey || e.ctrlKey;
      if (e.altKey && !mod && !e.shiftKey && (e.code === 'ArrowLeft' || e.code === 'ArrowRight')) {
        e.preventDefault();
        walk(e.code === 'ArrowLeft' ? 'back' : 'forward');
        return;
      }
      if (e.code === 'Backquote' && !mod && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        walk('previous');
        return;
      }
      const slot = DIGITS[e.code];
      if (slot === undefined || e.altKey || e.shiftKey) return;
      e.preventDefault();
      // `Ctrl+1…5` sets at once on the desktop; the browser keeps it for its tabs.
      if (mod) {
        setMark(slot);
        return;
      }
      if (e.repeat || held.has(e.code)) return;
      held.set(
        e.code,
        window.setTimeout(() => {
          held.set(e.code, -1);
          setMark(slot);
        }, MARK_HOLD_MS),
      );
    };
    const up = (e: KeyboardEvent) => {
      const timer = held.get(e.code);
      const slot = DIGITS[e.code];
      if (timer === undefined || slot === undefined) return;
      held.delete(e.code);
      if (timer < 0) return;
      window.clearTimeout(timer);
      goMark(slot);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      for (const timer of held.values()) if (timer >= 0) window.clearTimeout(timer);
    };
  }, [view3d, finder, palette, covered, menu, name, walk, setMark, goMark]);

  const focusCanvas = useCallback(() => viewRef.current?.canvas.focus(), []);
  /** The canvas one sees, page px: the properties panel covers its right (review 2026-10-24). */
  const seenBounds = (): DOMRect | undefined => {
    const r = host.current?.getBoundingClientRect();
    if (!r) return undefined;
    const covered = editor.current?.coveredRight() ?? 0;
    return new DOMRect(r.left, r.top, Math.max(0, r.width - covered), r.height);
  };

  const mapChooseRef = useRef<(item: MenuItem, m: MapTarget) => void>(() => undefined);
  const choose = useCallback(
    (item: MenuItem) => {
      const m = menu?.map;
      setMenu(null);
      if (m) {
        mapChooseRef.current(item, m);
      } else {
        editor.current?.setOverlayOpen(false);
        editor.current?.menuChoose(item.choice);
      }
      const next = remember(recent, item);
      setRecent(next);
      try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(next));
      } catch {
        // Recent choices are a convenience; private windows may refuse storage.
      }
      focusCanvas();
    },
    [recent, focusCanvas, menu?.map],
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
      // On the star map the bar's undo is the core's (08 §6.4: one step).
      undo: () =>
        view3dRef.current === '3d' ? mapCalls.current?.undo(false) : editor.current?.undo(),
      redo: () =>
        view3dRef.current === '3d' ? mapCalls.current?.undo(true) : editor.current?.redo(),
      map: () => map3d.current?.toggle(),
      back: () => walk('back'),
      forward: () => walk('forward'),
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
  }, [home, opened.workspace.id, props.bridge, walk]);

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
    // Nodes cut or copied belong to the workspace they came from.
    clipRef.current = null;
    setClipped(false);
    setImportReport(freshReport(opened.workspace.id) ?? null);
    setFixed(fixedLines(opened.workspace.id));
    navRef.current = NavHistory.load(readLocal(navKey(opened.workspace.id)));
    setNavState({ back: navRef.current.canBack, forward: navRef.current.canForward });
    setMarks(loadMarks(readLocal(marksKey(opened.workspace.id))));
    netRef.current = opened.root;
    void loadRef.current(opened.root);
  }, [opened]);

  // A report is shown once; the palette opens it again (13 §3.6).
  useEffect(() => reportShown(opened.workspace.id), [opened.workspace.id]);

  // The import coming into this workspace (13 §3.3, S1 step 5): the canvas
  // reads the core again as each batch lands, the networks appearing; the
  // last batch brings the report and the step of undo.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the refs are stable
  useEffect(() => {
    const job = jobOf(opened.workspace.id);
    setImporting(null);
    if (!job) return;
    let landed = -1;
    return job.watch((e) => {
      if (e.type !== 'progress') {
        setImporting(null);
        return;
      }
      const report = e.progress.report;
      if (report) {
        setImporting(null);
        setImportReport(report);
        reportShown(e.workspace);
        void core.history().then(setHistory);
      } else {
        setImporting(e.progress);
        if (e.progress.done === landed) return;
      }
      landed = e.progress.done;
      void loadRef.current();
      refreshRef.current();
    });
  }, [opened.workspace.id]);

  // An import the app left in the middle (10 §3.3, NFR-71): asked as its
  // workspace opens.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the core is the workspace's
  useEffect(() => {
    setInterrupted(null);
    if (jobOf(opened.workspace.id)) return;
    let live = true;
    void core
      .interrupted()
      .then((label) => {
        if (live && label?.key === 'core.change.import') {
          setInterrupted(String(label.params?.name ?? ''));
        }
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [opened.workspace.id]);

  /**
   * The report's fixes (13 §3.6), each one step of undo: a ghost's note
   * where the ghost stands, as a click on it makes; a link written as the
   * path to the node it is to name (S1 step 8).
   */
  const reportActions: ReportActions = {
    create: async (item) => {
      if (!item.node || !item.link) return;
      const d = await core.node(item.node);
      if (d.parent && d.parent !== netRef.current) await loadRef.current(d.parent);
      editor.current?.flyTo([item.node]);
      if (!editor.current?.materializeGhost(item.node, item.link)) {
        toast('ws.refused', { message: item.link });
        throw new Error('no ghost');
      }
    },
    bind: async (item) => {
      if (!item.node || !item.link || !item.target) return;
      await pinLink(item.node, item.link, item.target, true);
    },
    targets: (item) => core.linkTargets(item.node ?? '', item.link ?? ''),
    choose: async (item, target) => {
      if (!item.node || !item.link) return;
      await pinLink(item.node, item.link, target, false);
    },
  };

  /** A link fixed by the core: the text, its wire and the undo step. */
  const pinLink = async (note: string, link: string, target: string, alias: boolean) => {
    try {
      await sync.current?.settled();
      const h = await core.pinLink(note, link, target, alias);
      graph.current?.clearHistory();
      setHistory(h);
      refreshRef.current();
      await loadRef.current();
    } catch (e) {
      failed(e);
      throw e;
    }
  };

  /** «Оставить» or «Откатить» the import the app broke off. */
  const settle = (keep: boolean) => {
    setInterrupted(null);
    focusCanvas();
    void core
      .settleInterrupted(keep)
      .then((h) => {
        setHistory(h);
        refreshRef.current();
        return loadRef.current();
      })
      .catch(failed);
  };

  /**
   * Goes to a node (09 §3.4): the network of its primary placement on the
   * canvas, a flight to it, the node selected (06 §10.3); `open` — into a
   * folder or project, or its content beside it.
   */
  const goNode = (id: string, open: boolean) => {
    leaveRef.current();
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
    verdicts.current = new Map();
    setHistory(h);
    refreshRef.current();
    void core.tree().then(setTree);
  };

  const failed = (e: unknown) =>
    importingRef.current
      ? toast('import.busy')
      : toast('ws.refused', { message: e instanceof Error ? e.message : String(e) });

  /**
   * «Показать здесь» (06 §14): appearances of the other ends of node `id`'s
   * wires beside it, by the autoplace (§5.4); one step; their wires show.
   */
  /**
   * A preset for the nodes, or back to their kind's icon (07 §6.3): one step
   * of undo; the core keeps the reference (05 §4.1 `IconRef`).
   */
  const setIcon = (ids: readonly string[], preset: string | null) => {
    const g = graph.current;
    if (!g) return;
    const nodes = ids.filter((id) => g.nodes.has(id));
    if (nodes.length === 0) return;
    const value = preset === null ? null : `${PRESET}${preset}`;
    g.transaction({ key: 'change.icon', params: { n: nodes.length } }, (tx) => {
      for (const id of nodes) tx.attr(id, 'icon', value);
    });
  };

  const showHere = (id: string, ends: readonly ExternalWire[]) => {
    const net = netRef.current;
    const spots = editor.current?.spotsBeside(id, ends) ?? [];
    const ops = ends.map(
      (e, i): CoreOp => ({ op: 'place', id: e.id, net, x: spots[i]?.x ?? 0, y: spots[i]?.y ?? 0 }),
    );
    void coreStep(ops, 'ws.change.show', { n: ops.length })
      .then(() => loadRef.current())
      .then(() => editor.current?.reveal(id))
      .catch(failed);
  };

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
  useEffect(() => {
    setListFocus((f) => (f === details?.id ? f : null));
    setPlacesFocus((f) => (f === details?.id ? f : null));
  }, [details?.id]);

  /** An asset's file as an object URL, typed so the browser can show it; made once. */
  const urlOf = async (sha: string, mime: string) => {
    const key = `${sha}|${mime}`;
    const known = urls.current.get(key);
    if (known) return known;
    const bytes = await core.asset(sha);
    const blob = new Blob([new Uint8Array(bytes)], { type: mime });
    const url = URL.createObjectURL(blob);
    urls.current.set(key, url);
    blobs.current.set(url, blob);
    return url;
  };
  /** An asset's file for its viewer: the object URL, and the file itself for pdf.js (ADR-0013). */
  const viewerFile = async (sha: string, mime: string) => {
    const url = await urlOf(sha, mime);
    return { url, file: blobs.current.get(url) ?? null };
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
    leaveRef.current();
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
  const treeRef = useRef(tree);
  treeRef.current = tree;
  /**
   * What `Ctrl+F` searches (09 §3.3, 08 §6.1), made when the bar opens: it
   * keeps the choice of that moment for `Esc`. The network on the canvas,
   * or the cluster in focus on the star map.
   */
  const findTarget = useMemo<FindTarget | null>(() => {
    if (!finding) return null;
    const map = map3d.current;
    if (view3d === '3d' && map) {
      return mapFind({
        map,
        tree: () => treeRef.current,
        onChange: (fn) => {
          mapChanged.current.add(fn);
          return () => mapChanged.current.delete(fn);
        },
      });
    }
    if (view3d !== '2d' || !g || !ed) return null;
    return canvasFind({
      search: searchClient(),
      graph: g,
      editor: ed,
      view: viewRef.current,
      net: netRef.current,
      tree: () => treeRef.current,
    });
  }, [finding, view3d, g, ed]);
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
            leaveRef.current();
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
          net: netRef.current,
          goPlace: (net) => {
            const id = details.id;
            leaveRef.current();
            void loadRef.current(net).then(() => editor.current?.focusNode(id));
          },
          makePrimary: (net) => {
            const path = pathLabel(details.places.find((p) => p.net === net)?.path ?? []);
            void coreStep([{ op: 'setPrimary', id: details.id, net }], 'ws.change.primary', {
              name: details.name,
              path,
            })
              .then(() => toast('ws.toast.primary', { path }))
              .catch(failed);
          },
          unplace: (net) => {
            const path = pathLabel(details.places.find((p) => p.net === net)?.path ?? []);
            void coreStep([{ op: 'unplace', id: details.id, net }], 'ws.change.unplace', {
              name: details.name,
              path,
            }).catch(failed);
          },
        }
      : null;

  /**
   * Asks before a removal that takes more than one sees (06 §12.3): «Удалить
   * везде» of a node placed elsewhere too, or a network that goes to the
   * trash with what is inside. True — the dialog will remove them.
   */
  askDeleteRef.current = (ids, everywhere) => {
    const now = graph.current;
    if (!now) return false;
    const nodes = ids.flatMap((id) => now.nodes.get(id) ?? []);
    // To the trash: all with «везде», else those placed only here.
    const going = nodes.filter((n) => everywhere || n.places <= 1);
    const placed = everywhere ? nodes.filter((n) => n.places > 1) : [];
    if (placed.length === 0 && !going.some((n) => hasCanvas(n.kind))) return false;
    void (async () => {
      await sync.current?.settled();
      const preview =
        going.length > 0
          ? await core.trashPreview(going.map((n) => n.id))
          : { trashed: [], staying: [] };
      const nested = preview.trashed.length > going.length || preview.staying.length > 0;
      if (placed.length === 0 && !nested) {
        editor.current?.removeNodes(ids, everywhere);
        return;
      }
      const details = await Promise.all(placed.map((n) => core.node(n.id)));
      setRemoval({ ids, everywhere, placed: details, preview });
    })().catch(failed);
    return true;
  };

  /** «Вставить» and «Вставить как появление» while nodes wait for them (06 §12.1). */
  const pasteItems = (at: () => { x: number; y: number }): MenuEntry[] =>
    clipped
      ? [
          {
            label: t(locale, 'ctx.paste'),
            hint: 'Ctrl+V',
            onSelect: () => moves.current.paste(false, at()),
          },
          {
            label: t(locale, 'ctx.pasteAppearance'),
            hint: 'Ctrl+Shift+V',
            onSelect: () => moves.current.paste(true, at()),
          },
        ]
      : [];
  /**
   * After a step on the star map (08 §3.4): the map reads the space again —
   * a new star by its source — and the canvas its network before 2D; a
   * network gone with the step leaves the root on the canvas.
   */
  const afterMapStep = async (born?: { id: string; from: string | null }) => {
    canvasStale.current = true;
    const items = await core.tree();
    setTree(items);
    if (!items.some((i) => i.id === netRef.current)) {
      keepMap.current = true;
      try {
        canvasStale.current = false;
        await loadRef.current(openedRef.current.root);
      } finally {
        keepMap.current = false;
      }
    }
    await map3d.current?.refresh(born);
  };

  /** A star's node out of the canvas's network: «Убрать отсюда» or «Удалить везде» (08 §6.7). */
  const mapRemoveNow = async (id: string, net: string, everywhere: boolean, places: number) => {
    await sync.current?.settled();
    const view = await core.view(net);
    const stay = !everywhere && places > 1;
    await coreStep(
      removeOps(id, view, everywhere),
      stay ? 'proto.change.unplace' : 'proto.change.delete',
      { n: 1 },
    );
    toast(stay ? 'proto.toast.unplaced' : 'proto.toast.deleted', { n: 1 });
    await afterMapStep();
  };

  /** Removing on the map asks first as on the canvas (06 §12.3). */
  const mapRemove = async (id: string, net: string, everywhere: boolean) => {
    await sync.current?.settled();
    const d = await core.node(id);
    const going = everywhere || d.places.length <= 1;
    const placed = everywhere && d.places.length > 1;
    const preview = going ? await core.trashPreview([id]) : { trashed: [], staying: [] };
    const nested = preview.trashed.length > 1 || preview.staying.length > 0;
    if (placed || nested) {
      setRemoval({ ids: [id], everywhere, placed: placed ? [d] : [], preview, map: net });
      return;
    }
    await mapRemoveNow(id, net, everywhere, d.places.length);
  };

  /** A page point in this screen's points, where windows and the name field lie. */
  const screenPoint = (page: { x: number; y: number }) => {
    const el = host.current;
    const r = el?.getBoundingClientRect();
    return {
      x: page.x - (r?.left ?? 0) + (el?.offsetLeft ?? 0),
      y: page.y - (r?.top ?? 0) + (el?.offsetTop ?? 0),
    };
  };

  /**
   * A star's content over the map (08 §6.3, 06 §13): a note or a picture
   * beside it, a board in its window; anything else has none there.
   */
  const openOverMap = (id: string, at: { x: number; y: number; r: number }): boolean => {
    const item = treeRef.current.find((i) => i.id === id);
    const d = docs.current;
    const el = host.current;
    if (!item || !d || !el) return false;
    const r = el.getBoundingClientRect();
    const sx = at.x - r.left;
    const sy = at.y - r.top;
    const side = sx < r.width / 2 ? 'right' : 'left';
    const x = el.offsetLeft + (side === 'right' ? sx + at.r + 24 : sx - at.r - 24);
    const y = el.offsetTop + Math.max(8, Math.min(sy - 120, r.height - 320));
    const place = { side, x, y } as const;
    if (item.kind === 'board') {
      d.doc(id).then((doc) => setBoard({ id, doc }), failed);
      return true;
    }
    if (item.kind === 'note') {
      d.doc(id).then((doc) => setNote({ id, doc, at: place }), failed);
      return true;
    }
    const type = item.kind === 'asset' ? assetType(item) : null;
    if (type === null || !viewable(type)) return false;
    setViewer({ id, type, url: null, file: null, at: place });
    if (item.asset) {
      viewerFile(item.asset, item.mime ?? '')
        .then((f) => setViewer((w) => (w?.id === id ? { ...w, ...f } : w)))
        .catch(failed);
    }
    return true;
  };

  /**
   * A choice of the Tab menu opened on the map (08 §6.4): the node goes into
   * the target network where autoPlace puts it, wired from the selected
   * star; one step of undo; its star is born by its source and selected.
   */
  const mapChoose = async (item: MenuItem, m: MapTarget) => {
    await sync.current?.settled();
    const c = item.choice;
    const view = await core.view(m.net);
    const from = m.from && view.nodes.some((n) => n.id === m.from) ? m.from : null;
    const inputs = m.from ? [m.from] : [];
    const at = (kind: NodeKind) => placeIn(view.nodes, view.edges, from, kind);
    if (c.t === 'template') {
      const p = at(c.kind);
      const r = await core.copyNode(c.id, { net: m.net, ...p }, inputs, {
        key: 'proto.change.template',
        params: { name: c.name },
      });
      graph.current?.clearHistory();
      setHistory(r.history);
      await afterMapStep({ id: r.id, from: m.from });
      map3d.current?.selectId(r.id);
      return;
    }
    if (c.t === 'existing') {
      const name = treeRef.current.find((i) => i.id === c.id)?.name ?? '';
      const wires = inputs
        .filter((f) => f !== c.id)
        .map((f): CoreOp => ({ op: 'connect', from: f, to: c.id }));
      const here = view.nodes.some((n) => n.id === c.id);
      // Another network's node is placed here (05 §5); one here is only wired.
      if (!here) {
        const p = at(c.kind);
        await coreStep([{ op: 'place', id: c.id, net: m.net, ...p }, ...wires], 'ws.change.place', {
          name,
        });
      } else if (wires.length > 0) {
        await coreStep(wires, 'proto.change.connect', { name });
      }
      await afterMapStep();
      map3d.current?.selectId(c.id);
      return;
    }
    if (c.t !== 'create') return;
    const id = newId();
    const p = at(c.kind);
    await coreStep(
      [
        { op: 'createNode', id, kind: c.kind, name: c.name, net: m.net, ...p },
        ...inputs.map((f): CoreOp => ({ op: 'connect', from: f, to: id })),
      ],
      'proto.change.create',
      { name: c.name },
    );
    await afterMapStep({ id, from: m.from });
    map3d.current?.selectId(id);
    // A kind without a name: its name is typed under its star, as on the canvas (06 §5.2).
    const s = c.rename ? map3d.current?.screenOf(id) : null;
    if (s) {
      const pt = screenPoint({ x: s.x, y: s.y + 24 });
      setName({ id, sx: pt.x, sy: pt.y, name: '', map: m });
    }
  };

  /** Undo and redo on the map: the core's history (05 §11, 08 §6.4). */
  const mapUndo = async (redo: boolean) => {
    await sync.current?.settled();
    const h = redo ? await core.redo() : await core.undo();
    graph.current?.clearHistory();
    setHistory(h);
    await afterMapStep();
  };

  /** The quality of the star map by hand, or back to the frames (08 §8.4). */
  const chooseQuality = (q: Quality | 'auto') => {
    setMapQuality(q === 'auto' ? null : q);
    setQuality(q);
    const now = q === 'auto' ? qualityOf(mapQuality()) : q;
    const map = map3d.current;
    map?.applyQuality(now);
    // Off while it is shown: back to the canvas (08 §8.4).
    if (now === 'off' && map?.state === '3d') map.toggle();
  };

  mapChooseRef.current = (item, m) => void mapChoose(item, m).catch(failed);
  mapCalls.current = {
    create: ({ x, y, net, from }) => {
      const path = pathLabel(pathTo(treeRef.current, net));
      const source = from ? (treeRef.current.find((i) => i.id === from)?.name ?? '') : '';
      const target = from
        ? t(locale, 'map.menu.targetFrom', { path, name: source })
        : t(locale, 'map.menu.target', { path });
      setMenu({ sx: x, sy: y, query: '', seq: menuOpening(), map: { net, from, target } });
    },
    flag: (ids, flag) => {
      const items = treeRef.current;
      const on = ids.some((id) => !items.find((i) => i.id === id)?.flags?.includes(flag));
      void coreStep(
        ids.map((id): CoreOp => ({ op: 'setFlag', id, flag, on })),
        `proto.change.flag.${flag}.${on ? 'on' : 'off'}`,
        { n: ids.length },
      )
        .then(() => afterMapStep())
        .catch(failed);
    },
    remove: (id, net, everywhere) => void mapRemove(id, net, everywhere).catch(failed),
    menu: (x, y, id) => setMapCtx({ x, y, id }),
    undo: (redo) => void mapUndo(redo).catch(failed),
    open: openOverMap,
  };

  /** The right button's menu on the star map (08 §5.4): a star's steps, or the map's. */
  const mapCtxItems = (id: string | null): MenuEntry[] => {
    const map = map3d.current;
    if (!map) return [];
    if (id === null) {
      return [
        { label: t(locale, 'ctx.create'), hint: 'Tab', onSelect: () => map.act('create') },
        { label: t(locale, 'ctx.showAll'), hint: 'H', onSelect: () => map.act('overview') },
        ...(['auto', 'high', 'medium', 'economy'] as const).map(
          (q, i): MenuEntry => ({
            label: t(locale, `map.quality.${q}` as const),
            radio: true,
            checked: quality === q,
            separated: i === 0,
            onSelect: () => chooseQuality(q),
          }),
        ),
      ];
    }
    const item = tree.find((i) => i.id === id);
    if (!item) return [];
    const flags = item.flags ?? [];
    const flag = (f: Flag, hint: string, separated = false): MenuEntry => ({
      label: t(locale, `flag.${f}` as MessageKey),
      hint,
      separated,
      checked: flags.includes(f),
      onSelect: () => map.act(`flag:${f}` as MapAction, id),
    });
    return [
      { label: t(locale, 'ctx.open'), hint: 'Enter', onSelect: () => map.act('open', id) },
      ...(hasCanvas(item.kind)
        ? [{ label: t(locale, 'map.ctx.into'), hint: 'I', onSelect: () => map.act('into', id) }]
        : []),
      { label: t(locale, 'map.ctx.frame'), hint: 'F', onSelect: () => map.act('frame', id) },
      { label: t(locale, 'map.ctx.card'), hint: 'Shift+I', onSelect: () => map.act('card', id) },
      flag('key', 'R', true),
      flag('pause', 'Q'),
      flag('template', 'E'),
      {
        label: t(locale, 'map.ctx.pin'),
        hint: 'B',
        checked: map.pinnedIds().includes(id),
        onSelect: () => map.act('pin', id),
      },
      {
        label: t(locale, 'ctx.delete'),
        hint: 'Del',
        separated: true,
        onSelect: () => map.act('delete', id),
      },
      {
        label: t(locale, 'ctx.deleteEverywhere'),
        hint: 'Shift+Del',
        separated: true,
        onSelect: () => map.act('deleteEverywhere', id),
      },
    ];
  };

  /** A node's name: on the canvas, or anywhere in the workspace (a window over the map). */
  const nameOf = (id: string) =>
    g?.nodes.get(id)?.name ?? tree.find((i) => i.id === id)?.name ?? '';

  /** The right button's menu (06 §5): for a node, a wire, or the bare canvas. */
  const ctxItems = (at: MenuTarget): MenuEntry[] => {
    if (!g || !ed) return [];
    if (at.t === 'empty') {
      const r = viewRef.current?.canvas.getBoundingClientRect();
      const sx = (ctx?.x ?? 0) - (r?.left ?? 0);
      const sy = (ctx?.y ?? 0) - (r?.top ?? 0);
      const at = viewRef.current?.camera.toWorld(sx, sy) ?? { x: 0, y: 0 };
      return [
        { label: t(locale, 'ctx.create'), hint: 'Tab', onSelect: () => ed.createAt(sx, sy) },
        { label: t(locale, 'ctx.showAll'), hint: 'H', onSelect: () => ed.fitAll() },
        // What was cut or copied goes where the menu was opened (06 §12.1).
        ...pasteItems(() => at),
        // The network's wire styles (06 §6.2): the one they have is ticked,
        // `Shift+S` stands by the one it turns them to.
        ...WIRE_SHAPES.map(
          (shape, i): MenuEntry => ({
            label: t(locale, `ctx.wires.${shape}` as const),
            ...(shape === ed.nextWireShape ? { hint: 'Shift+S' } : {}),
            checked: shape === g.wireShape,
            radio: true,
            separated: i === 0,
            onSelect: () => ed.setWireShape(shape),
          }),
        ),
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
    // Moves of 06 §12.1 and the wrap of §13.3, on the selection.
    items.push(
      {
        label: t(locale, 'ctx.cut'),
        hint: 'Ctrl+X',
        separated: true,
        onSelect: () => ed.act('cut'),
      },
      { label: t(locale, 'ctx.copy'), hint: 'Ctrl+C', onSelect: () => ed.act('copy') },
      // Beside the node the menu is for, not on it.
      ...pasteItems(() => ({ x: n.x + 160, y: n.y })),
      { label: t(locale, 'ctx.wrap'), hint: 'Shift+C', onSelect: () => ed.act('wrap') },
      // The palette at the menu's corner, for what the flags would take (06 §8).
      {
        label: t(locale, 'ctx.icon'),
        hint: 'Z',
        onSelect: () => {
          setIconPick({ ids: ed.flagTargets(n.id), x: ctx?.x ?? 0, y: ctx?.y ?? 0 });
          void iconPresets().then(setPresets, failed);
        },
      },
    );
    // Two commands, not side by side (06 §12.3): «Убрать отсюда» and «Удалить везде».
    items.push({
      label: t(locale, 'ctx.delete'),
      hint: 'Del',
      separated: true,
      onSelect: () => ed.deleteSelected(),
    });
    items.push({
      label: t(locale, 'ctx.deleteEverywhere'),
      hint: 'Shift+Del',
      separated: true,
      onSelect: () => ed.deleteSelected(true),
    });
    return items;
  };

  // What «Перейти к ноде» ranks with, taken when it opens.
  const finderScope = ALL;
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
  // The workspace's nodes for «Вставить здесь» (05 §5): each by the network it lies in.
  const space = useMemo((): MenuNode[] => {
    const name = new Map(tree.map((i) => [i.id, i.name]));
    return tree
      .filter((i) => i.parent)
      .map((i) => ({
        id: i.id,
        name: i.name,
        kind: i.kind,
        where: name.get(i.parent ?? '') ?? '',
      }));
  }, [tree]);
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
  /** What the palette's commands may do here (09 §3.5). */
  const commandContext: CommandContext = {
    view: view3d === '2d' ? '2d' : '3d',
    selected: ed?.selection.size ?? 0,
    current: ed && ed.selection.size === 1 ? ed.current : null,
    canUndo,
    canRedo,
    canBack: navState.back,
    canForward: navState.forward,
    marks: marks.map((m) => m !== null),
    clip: clipped,
    act: (action) => editor.current?.act(action),
    goTo: () => {
      setFinding(false);
      setFinder({ map: view3d !== '2d' });
    },
    find: () => {
      setFinder(null);
      setFinding(true);
    },
    walk,
    setMark,
    goMark,
    importReport: reportOf(opened.workspace.id)
      ? () => setImportReport(reportOf(opened.workspace.id) ?? null)
      : undefined,
    mapAct: (action) => map3d.current?.act(action),
    quality,
    setQuality: chooseQuality,
  };
  const lastStep = canUndo
    ? t(locale, 'proto.lastStep', { label: label(g?.canUndo ? g.undoLabel : history.undo) })
    : label(null);
  const path = net?.path ?? [];
  const { onUndoState } = props;
  useEffect(
    () =>
      onUndoState({
        canUndo,
        canRedo,
        step: lastStep,
        map: view3d !== '2d',
        canBack: navState.back,
        canForward: navState.forward,
      }),
    [onUndoState, canUndo, canRedo, lastStep, view3d, navState],
  );

  return (
    <div
      className="proto workspace"
      data-net={net?.net ?? ''}
      data-depth={path.length}
      data-nodes={nodes.length}
      data-wires={g?.edges().length ?? 0}
      data-view={view3d}
      data-panel={details ? 'open' : 'closed'}
      data-minimap={minimap ? 'open' : 'closed'}
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
          onMove={(ids, to) => moves.current.layers(ids, to)}
          placeable={(to, ids) => placeableRef.current(to, ids)}
          search={searchClient()}
        />
      ) : null}
      {net && (view3d === '2d' || view3d === '3d') ? (
        <PathBar
          locale={locale}
          // On the map: the way to the cluster in focus (08 §5.1).
          path={view3d === '3d' ? pathTo(tree, mapFocus ?? net.net) : net.path}
          kindOf={(id) => tree.find((i) => i.id === id)?.kind ?? 'network'}
          panel={details !== null}
          onGo={(id) => {
            leaveRef.current();
            if (view3d === '3d') map3d.current?.goPlace(id);
            else void loadRef.current(id);
          }}
          marks={marks.map((m) => (m ? (tree.find((i) => i.id === m.net)?.name ?? '') : null))}
          onMark={goMark}
          onClearMark={clearMark}
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
          focusPlaces={placesFocus === details.id}
          noteOpen={note?.id === details.id}
          viewerOpen={viewer?.id === details.id}
          when={reading(props.prefs)}
          onListFocused={() => setListFocus(null)}
          onPlacesFocused={() => setPlacesFocus(null)}
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
      {cursorNote ? (
        <div
          ref={noteEl}
          className="ws-cursor-note"
          role="status"
          style={{ left: cursorNote.x, top: cursorNote.y }}
        >
          <Glyph name="forbid" />
          <span>{t(locale, cursorNote.key as MessageKey)}</span>
        </div>
      ) : null}
      {mapCtx && view3d === '3d' ? (
        <ContextMenu
          x={mapCtx.x}
          y={mapCtx.y}
          label={t(locale, 'ctx.label')}
          items={mapCtxItems(mapCtx.id)}
          onClose={() => setMapCtx(null)}
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
        {importing ? (
          <ImportStatus
            locale={locale}
            progress={importing}
            onCancel={() => void jobOf(opened.workspace.id)?.cancel()}
          />
        ) : null}
      </ul>
      {finder && (view3d === '3d') === finder.map ? (
        <NodeSearch
          locale={locale}
          label={t(locale, finder.map ? 'map.find' : 'search.goTo')}
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
      {external && view3d === '2d' ? (
        <ExternalList
          locale={locale}
          name={g?.nodes.get(external.id)?.name ?? ''}
          wires={external.wires}
          cycle={external.cycle}
          x={external.x}
          y={external.y}
          flipX={external.flipX}
          bounds={seenBounds()}
          onGo={(id) => {
            setExternal(null);
            focusCanvas();
            goNode(id, false);
          }}
          onShow={(ends) => {
            setExternal(null);
            focusCanvas();
            showHere(external.id, ends);
          }}
          onClose={() => {
            setExternal(null);
            focusCanvas();
          }}
        />
      ) : null}
      {interrupted !== null ? (
        <InterruptedDialog locale={locale} name={interrupted} onSettle={settle} />
      ) : null}
      {importReport ? (
        <ImportReportWindow
          locale={locale}
          report={importReport}
          actions={reportActions}
          done={fixed}
          onDone={(i) => {
            fixLine(opened.workspace.id, i);
            setFixed(new Set(fixedLines(opened.workspace.id)));
          }}
          onGo={(id) => {
            setImportReport(null);
            focusCanvas();
            goNode(id, false);
          }}
          onClose={() => {
            setImportReport(null);
            focusCanvas();
          }}
        />
      ) : null}
      {removal ? (
        <DeleteDialog
          locale={locale}
          everywhere={removal.everywhere}
          placed={removal.placed}
          preview={removal.preview}
          chosen={removal.ids.length}
          onConfirm={(everywhere) => {
            setRemoval(null);
            focusCanvas();
            const [id] = removal.ids;
            if (removal.map !== undefined && id !== undefined) {
              const places = removal.placed[0]?.places.length ?? 1;
              void mapRemoveNow(id, removal.map, everywhere, places).catch(failed);
              return;
            }
            editor.current?.removeNodes(removal.ids, everywhere);
          }}
          onCancel={() => {
            setRemoval(null);
            focusCanvas();
          }}
        />
      ) : null}
      {palette ? (
        <CommandPalette
          locale={locale}
          search={searchClient()}
          context={commandContext}
          left={
            (host.current?.getBoundingClientRect().left ?? 0) + (host.current?.clientWidth ?? 0) / 2
          }
          top={(host.current?.getBoundingClientRect().top ?? 0) + 48}
          onRun={(command) => {
            setPalette(false);
            focusCanvas();
            command.run(commandContext);
          }}
          onClose={() => {
            setPalette(false);
            focusCanvas();
          }}
        />
      ) : null}
      {finding && findTarget ? (
        <FindBar
          locale={locale}
          search={searchClient()}
          target={findTarget}
          onClose={() => {
            setFinding(false);
            if (view3d === '2d') focusCanvas();
          }}
        />
      ) : null}
      {iconPick ? (
        <IconPalette
          locale={locale}
          presets={presets}
          current={g?.nodes.get(iconPick.ids[0] ?? '')?.attrs.icon ?? null}
          kind={(() => {
            const n = g?.nodes.get(iconPick.ids[0] ?? '');
            if (!n) return 'note';
            // What «Значок вида» gives back: the icon without the one chosen by hand.
            const { icon: _chosen, ...rest } = n.attrs;
            return nodeIcon(n.kind, rest);
          })()}
          x={iconPick.x}
          y={iconPick.y}
          bounds={seenBounds()}
          search={searchClient()}
          onPick={(id) => {
            setIconPick(null);
            setIcon(iconPick.ids, id);
            focusCanvas();
          }}
          onClose={() => {
            setIconPick(null);
            focusCanvas();
          }}
        />
      ) : null}
      {menu ? (
        <TabMenu
          key={menu.seq}
          locale={locale}
          x={menu.sx}
          y={menu.sy}
          bounds={host.current?.getBoundingClientRect()}
          initialQuery={menu.query}
          named={menu.named}
          nodes={menu.map ? [] : nodes}
          ghosts={menu.map ? [] : ghosts}
          target={menu.map?.target}
          recent={recent}
          templates={templates}
          space={space}
          search={searchClient()}
          onChoose={choose}
          onCancel={() => {
            setMenu(null);
            if (!menu.map) ed?.menuCancel();
            focusCanvas();
          }}
        />
      ) : null}
      {board ? (
        <BoardWindow
          key={board.id}
          locale={locale}
          name={nameOf(board.id)}
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
          name={nameOf(viewer.id)}
          type={viewer.type}
          url={viewer.url}
          file={viewer.file}
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
          name={nameOf(note.id)}
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
            const w = naming.current;
            naming.current = null;
            focusCanvas();
            if (name.map) {
              void coreStep([{ op: 'rename', id: name.id, name: text }], 'proto.change.rename', {
                name: text,
              })
                .then(() => afterMapStep())
                .catch(failed);
              return;
            }
            // A wrapped folder's name goes into the wrap's step (06 §13.3).
            if (w?.id === name.id && text.trim()) {
              ed?.nameCancel();
              moves.current.named(w.id, w.n, text.trim());
              return;
            }
            ed?.nameCommit(text);
          }}
          onCancel={() => {
            setName(null);
            naming.current = null;
            focusCanvas();
            // A node just made on the map without a name is not made (06 §5.5).
            if (name.map) {
              void (async () => {
                await sync.current?.settled();
                setHistory(await core.cancel());
                await afterMapStep();
              })().catch(failed);
              return;
            }
            ed?.nameCancel();
          }}
          onMenu={(text) => {
            const m = name.map;
            if (!m) {
              ed?.nameToMenu(text);
              return;
            }
            // `Tab` in the field: the menu again with the text as its query.
            setName(null);
            void (async () => {
              await sync.current?.settled();
              setHistory(await core.cancel());
              await afterMapStep();
              const el = host.current;
              const r = el?.getBoundingClientRect();
              const sx = name.sx - (el?.offsetLeft ?? 0) + (r?.left ?? 0);
              const sy = name.sy - (el?.offsetTop ?? 0) + (r?.top ?? 0);
              setMenu({ sx, sy, query: text, seq: menuOpening(), map: m });
            })().catch(failed);
          }}
        />
      ) : null}
    </div>
  );
}
