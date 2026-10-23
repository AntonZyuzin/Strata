import {
  type ChangeLabel,
  CoreSync,
  followWires,
  type Graph,
  graphOf,
  type History,
  type HomeBackend,
  type NetworkView,
  type Opened,
  type TrashItem,
} from '@strata/backend';
import {
  BACKDROP_SIDE,
  CanvasView,
  Editor,
  type EditorEvents,
  generatePreset,
  type Pixels,
  processBackdrop,
  WIRE_END_STYLES,
  type WireEndStyle,
} from '@strata/canvas';
import { type Locale, type MessageKey, t } from '@strata/i18n';
import type { LoroDoc } from 'loro-crdt';
import { type MutableRefObject, useCallback, useEffect, useRef, useState } from 'react';
import { BoardWindow } from '../proto/BoardWindow';
import { Layouter } from '../proto/layouter';
import { Map3D, type MapState } from '../proto/map3d';
import { type MenuItem, type MenuNode, remember } from '../proto/menu';
import { NameInput } from '../proto/NameInput';
import { NoteWindow } from '../proto/NoteWindow';
import { TabMenu } from '../proto/TabMenu';
import { IconButton } from '../TabBar';
import { CoreDocs } from './docs';

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
const ENDS_KEY = 'strata.proto.ends';
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

function loadEnds(): WireEndStyle {
  try {
    const v = localStorage.getItem(ENDS_KEY);
    return WIRE_END_STYLES.find((s) => s === v) ?? 'arrow';
  } catch {
    return 'arrow';
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
}

export function WorkspaceScreen(props: {
  locale: Locale;
  home: HomeBackend;
  opened: Opened;
  bridge: MutableRefObject<WorkspaceBridge | null>;
}) {
  const { locale, home, opened } = props;
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
  const [boardFocus, setBoardFocus] = useState(false);
  const [view3d, setView3d] = useState<MapState>('2d');
  const [trash, setTrash] = useState<TrashItem[] | null>(null);
  const [trashOpen, setTrashOpen] = useState(false);
  /** The core's undo and redo: the session's, across networks (05 §11). */
  const [history, setHistory] = useState<History>({ undo: null, redo: null });
  const [recent, setRecent] = useState<string[]>(loadRecent);
  const [, setVersion] = useState(0);

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

    const refused = (e: unknown) => {
      if (cancelled) return;
      toast('ws.refused', { message: e instanceof Error ? e.message : String(e) });
      void loadRef.current();
    };

    const events: EditorEvents = {
      tabMenu: (e) => setMenu(e),
      nameInput: (e) => setName(e),
      toast: (e) => toast(e.key, e.params, e.key !== 'proto.toast.exists'),
      // No explanatory lines on screen: hints live in tooltips and menus.
      hint: () => undefined,
      change: () => {
        setVersion((v) => v + 1);
        if (trashTimer) clearTimeout(trashTimer);
        trashTimer = setTimeout(refreshTrash, 300);
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
        if (n.kind === 'network') {
          void loadRef.current(id);
          return;
        }
        if (n.kind === 'board') {
          d.doc(id).then((doc) => setBoard({ id, doc }), refused);
          return;
        }
        if (n.kind !== 'note') {
          toast('ws.notOpenable');
          return;
        }
        // Beside the bubble, on the side with more room (06 §13.1).
        const s = v.camera.toScreen(p.x, p.y);
        const r = p.r * v.camera.zoom;
        const side = s.x < v.width / 2 ? 'right' : 'left';
        const at = {
          side,
          x: side === 'right' ? s.x + r + 24 : s.x - r - 24,
          y: Math.max(8, Math.min(s.y - 120, v.height - 320)),
        } as const;
        d.doc(id).then((doc) => setNote({ id, doc, at }), refused);
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
      const [nv, h] = await Promise.all([core.view(id), core.history()]);
      if (cancelled) return;
      setHistory(h);
      // A note or board window belongs to its network's canvas.
      if (id !== was) {
        setNote(null);
        setBoard(null);
        setBoardFocus(false);
      }
      editor.current?.destroy();
      sync.current?.destroy();
      map3d.current?.destroy();
      const g = graphOf(nv, (k, c) => v.iconFor(k, c));
      graph.current = g;
      textWires.current = new Set(nv.edges.filter((e) => e.text).map((e) => pair(e.from, e.to)));
      const ed = new Editor(v, g, events);
      editor.current = ed;
      sync.current = new CoreSync(core, g, id, refused, setHistory);
      map3d.current = new Map3D(el, v, g, setView3d);
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
    };
    const load = (id?: string) => queue(() => show(id ?? netRef.current));
    loadRef.current = load;

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

    CanvasView.create(el).then((v) => {
      if (cancelled) {
        v.destroy();
        return;
      }
      view = v;
      viewRef.current = v;
      v.wireEnds = loadEnds();
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
    editor.current?.setOverlayOpen(
      menu !== null || name !== null || view3d !== '2d' || boardFocus || trashOpen,
    );
  }, [menu, name, view3d, boardFocus, trashOpen]);

  useEffect(() => {
    if (view3d !== '3d') return;
    const key = (e: KeyboardEvent) => {
      if (e.code === 'KeyM' && !e.metaKey && !e.ctrlKey && !e.altKey) map3d.current?.toggle();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
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
    setTrashOpen(false);
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

  const g = graph.current;
  const ed = editor.current;
  const nodes: MenuNode[] = g
    ? [...g.nodes.values()].map((n) => ({ id: n.id, name: n.name, kind: n.kind }))
    : [];
  const canUndo = Boolean(g?.canUndo || history.undo);
  const canRedo = Boolean(g?.canRedo || history.redo);
  const lastStep = canUndo
    ? t(locale, 'proto.lastStep', { label: label(g?.canUndo ? g.undoLabel : history.undo) })
    : label(null);
  const path = net?.path ?? [];
  const trashCount = trash?.length ?? 0;

  return (
    <div
      className="proto workspace"
      data-net={net?.net ?? ''}
      data-depth={path.length}
      data-nodes={g?.nodes.size ?? 0}
      data-wires={g?.edges().length ?? 0}
      data-view={view3d}
    >
      <div ref={host} className="proto-canvas" />
      {trashOpen ? (
        <section className="window ws-trash" aria-labelledby="trash-title">
          <header className="window-title">
            <h2 id="trash-title">{t(locale, 'ws.trashTitle')}</h2>
            <button
              type="button"
              className="window-close"
              aria-label={t(locale, 'window.close')}
              title={t(locale, 'window.close')}
              onClick={() => {
                setTrashOpen(false);
                focusCanvas();
              }}
            >
              ×
            </button>
          </header>
          <div className="window-body">
            {trashCount === 0 ? (
              <p className="ws-trash-empty">{t(locale, 'ws.trashEmpty')}</p>
            ) : (
              <ul className="ws-trash-list">
                {(trash ?? []).map((item) => (
                  <li key={item.id}>
                    <span className="ws-trash-name" title={item.name}>
                      {item.name || t(locale, 'note.untitled')}
                    </span>
                    <button type="button" onClick={() => void restore(item)}>
                      {t(locale, 'ws.restore')}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      ) : null}
      <div className="ws-tools">
        <IconButton
          glyph="undo"
          label={canUndo ? lastStep : t(locale, 'proto.undo')}
          disabled={!canUndo}
          onClick={() => ed?.undo()}
        />
        <IconButton
          glyph="redo"
          label={t(locale, 'proto.redo')}
          disabled={!canRedo}
          onClick={() => ed?.redo()}
        />
        <IconButton
          glyph="trash"
          className={trashOpen ? 'is-default' : undefined}
          label={t(locale, 'ws.trash', { n: trashCount })}
          onClick={() => {
            setTrashOpen((o) => !o);
            refreshTrash();
          }}
        >
          {trashCount > 0 ? <span className="ws-count">{trashCount}</span> : null}
        </IconButton>
      </div>
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
