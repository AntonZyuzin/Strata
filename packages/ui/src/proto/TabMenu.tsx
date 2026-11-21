import type { Resolved, TreeItem } from '@strata/backend';
import { glyphUrl } from '@strata/design-tokens';
import { type Locale, t } from '@strata/i18n';
import type { SearchContext } from '@strata/search';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { pointerMoved } from '../pointer';
import {
  completePath,
  missingSpan,
  type PathRow,
  pathQuery,
  pathRows,
} from '../workspace/pathRows';
import {
  type FindRows,
  type Group,
  type MenuGhost,
  type MenuItem,
  type MenuNode,
  type MenuRanking,
  type MenuSearch,
  menuItems,
  rankMenu,
} from './menu';

/**
 * «Найти или создать» (06 §5, ☑ Q-06-26; 07 §8.2): the Tab menu and `Ctrl+O`
 * in one window without a title bar, 52 ch of the UI font wide (360 px at
 * DPR 1) whatever the language, prompt «>», up to 12 rows, group headers;
 * the keys are in the tooltip of the prompt, not on a line of their own.
 * From `Tab` it opens at the anchor, «Создать» first; from `Ctrl+O` — over
 * the canvas's top, centred, the nodes first. It stays inside the canvas,
 * clear of the status bar. A query that starts with `/`, `./` or `../` is a
 * path (09 §4.4): the rows are what it names from the entry path.
 */

const MARGIN = 8;
const ROWS = 12;

let openings = 0;

/**
 * A serial for each opening of the menu, its React `key`. A choice made once
 * the engine answers closes the menu in a later render, and a `Tab` typed
 * before that render opens the next one in the same batch: without a key of
 * its own the new menu would be the old one, its query and all.
 */
export function menuOpening(): number {
  openings += 1;
  return openings;
}

/** How a row is chosen (06 §5.3, 09 §3.4): `Shift` — open it, `Alt` — its appearance here. */
export interface MenuHow {
  open: boolean;
  place: boolean;
}

export function TabMenu(props: {
  locale: Locale;
  x: number;
  y: number;
  /** `x` is the window's middle, not its left edge: `Ctrl+O` over the canvas's top. */
  centred?: boolean | undefined;
  /** Right and bottom edges the menu stays within; the viewport by default. */
  bounds?: { right: number; bottom: number } | undefined;
  initialQuery: string;
  nodes: readonly MenuNode[];
  /** The workspace's nodes: another network's one is placed here or gone to (05 §5). */
  space?: readonly MenuNode[] | undefined;
  recent: readonly string[];
  /** Nodes with the flag «Шаблон» (05 §7), from the whole workspace. */
  templates?: readonly MenuNode[] | undefined;
  /** This network's ghosts (05 §8.5). */
  ghosts?: readonly MenuGhost[] | undefined;
  /** A ghost's name, clicked with Shift: the kinds for it (06 §14). */
  named?: string | undefined;
  /** Where the node goes when that is not on the screen (08 §6.4: the star map): `→ path · от «P»`. */
  target?: string | undefined;
  /** The search engine (09 §2): it ranks what a query matches. */
  search: MenuSearch;
  /** Opened by `Ctrl+O`: the nodes first, the visited and the trash's rows (☑ Q-06-26). */
  find?: FindRows | undefined;
  /** The network on the canvas and this device's visits: the nodes ranked by them (09 §2.5). */
  context?: SearchContext | undefined;
  /** What a typed path names from the entry path (09 §4.4); none — no path mode. */
  resolve?: ((text: string) => Promise<Resolved>) | undefined;
  /** The workspace's tree: what lies in the network a path ending in `/` names. */
  tree?: readonly TreeItem[] | undefined;
  onChoose: (item: MenuItem, how: MenuHow) => void;
  onCancel: () => void;
}) {
  const { locale, search, templates, ghosts, named, space, find, context, resolve } = props;
  const label = t(locale, 'menu.find');
  const [query, setQuery] = useState(props.initialQuery);
  const [index, setIndex] = useState(0);
  const [moved] = useState(pointerMoved);
  const paths = resolve !== undefined && pathQuery(query);
  // The engine answers in its worker: the rows stay those of the last
  // answer until the next one comes, and `Enter` waits for the query's own.
  const [ranking, setRanking] = useState<MenuRanking | null>(null);
  /** The core's answer to a path, for the query it was asked. */
  const [resolved, setResolved] = useState<{ q: string; r: Resolved } | null>(null);
  /** A choice typed before the answer, made once it comes. */
  const [waiting, setWaiting] = useState<MenuHow | null>(null);
  const trash = find?.trash;
  useEffect(() => {
    if (query.trim() === '' || paths) return;
    let live = true;
    void rankMenu(search, query, templates ?? [], ghosts ?? [], { trash, context }).then((r) => {
      if (live) setRanking(r);
    });
    return () => {
      live = false;
    };
  }, [search, query, templates, ghosts, trash, context, paths]);
  useEffect(() => {
    if (!paths || !resolve) return;
    let live = true;
    void resolve(query).then((r) => {
      if (live) setResolved({ q: query, r });
    });
    return () => {
      live = false;
    };
  }, [paths, resolve, query]);
  const answer = paths && resolved?.q === query ? resolved.r : null;
  const shown = query.trim() === '' ? query : (ranking?.query ?? query);
  const { tree } = props;
  /** The path mode's rows: what a typed path names, or the names its missing segment may take. */
  const walked = useMemo(
    (): PathRow[] => (paths ? pathRows(query, answer, tree ?? [], locale, ROWS) : []),
    [paths, query, answer, tree, locale],
  );
  const items = useMemo(
    (): MenuItem[] =>
      paths
        ? walked.map((r) => {
            const way = r.hit.path.map(([id]) => id);
            return {
              id: `path:${way.join('/')}`,
              group: 'path',
              label: r.name || t(locale, 'note.untitled'),
              detail: r.path,
              kind: r.kind,
              choice: { t: 'existing', id: r.id, kind: r.kind, way },
            };
          })
        : menuItems(
            locale,
            shown,
            props.nodes,
            props.recent,
            templates,
            ranking,
            ghosts,
            named ?? null,
            space,
            find ?? null,
          ),
    [
      paths,
      walked,
      locale,
      shown,
      props.nodes,
      props.recent,
      templates,
      ranking,
      ghosts,
      named,
      space,
      find,
    ],
  );
  const ready = paths ? answer !== null : query.trim() === '' || ranking?.query === query;
  /** The path's segment that named nothing. */
  const missing = paths ? missingSpan(query, answer) : undefined;
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: props.x, top: props.y });

  useEffect(() => {
    input.current?.focus();
  }, []);

  // Clamp into the bounds; the anchor stays at the cursor otherwise.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the height changes with the number of rows
  useLayoutEffect(() => {
    const h = box.current?.offsetHeight ?? 0;
    const w = box.current?.offsetWidth ?? 0;
    const right = props.bounds?.right ?? window.innerWidth;
    const bottom = props.bounds?.bottom ?? window.innerHeight;
    const x = props.centred ? props.x - w / 2 : props.x;
    setPos({
      left: Math.max(MARGIN, Math.min(x, right - w - MARGIN)),
      top: Math.max(MARGIN, Math.min(props.y, bottom - h - MARGIN)),
    });
  }, [props.x, props.y, props.centred, items.length]);

  const current = items[Math.min(index, items.length - 1)];
  /**
   * The row a choice takes: the current one; `Alt+Enter` — the current row
   * when it is a node, else the best node (06 §5.3).
   */
  const pick = (how: MenuHow): MenuItem | undefined =>
    how.place && current?.choice.t !== 'existing'
      ? items.find((i) => i.choice.t === 'existing')
      : current;
  /** A path's name offered for the segment that named nothing: in its place, the path asked again. */
  const offered = (item: MenuItem): string | null => {
    if (!paths || !answer?.missing) return null;
    const r = walked[items.indexOf(item)];
    return r ? completePath(query, answer, r, false) : null;
  };
  const { onChoose } = props;
  const take = (item: MenuItem | undefined, how: MenuHow) => {
    if (!item) return;
    const next = offered(item);
    if (next !== null) {
      setQuery(next);
      setIndex(0);
      setWaiting(how);
      return;
    }
    onChoose(item, how);
  };
  // A choice typed before the engine's answer is made once it comes.
  useEffect(() => {
    if (!waiting || !ready) return;
    const how = waiting;
    setWaiting(null);
    // A path asked again after a name offered goes only where it names one node.
    if (paths && (answer?.missing || (answer && answer.found.length !== 1))) return;
    take(pick(how), how);
  });

  /** A path row's name in the query's segment, `/` after a network. */
  const completeRow = (item: MenuItem): string | null => {
    const r = walked[items.indexOf(item)];
    return r ? completePath(query, answer, r, true) : null;
  };

  const onKey = (e: React.KeyboardEvent) => {
    // `Enter` chose the query as it was: what is typed until the answer
    // comes would change a choice already made; only `Esc` takes it back.
    if (waiting && e.key !== 'Escape') {
      e.preventDefault();
      return;
    }
    const n = items.length;
    switch (e.key) {
      case 'Tab': {
        e.preventDefault();
        // In a path, the row's name in its segment, as a shell completes one.
        const next = paths && !e.shiftKey ? current && completeRow(current) : null;
        if (next) {
          setQuery(next);
          setIndex(0);
        } else if (!paths && n > 0) {
          setIndex((i) => (e.shiftKey ? (i - 1 + n) % n : (i + 1) % n));
        }
        return;
      }
      case 'ArrowDown':
        e.preventDefault();
        if (n > 0) setIndex((i) => (i + 1) % n);
        return;
      case 'ArrowUp':
        e.preventDefault();
        if (n > 0) setIndex((i) => (i - 1 + n) % n);
        return;
      case 'PageDown':
        e.preventDefault();
        setIndex((i) => Math.min(n - 1, i + 5));
        return;
      case 'PageUp':
        e.preventDefault();
        setIndex((i) => Math.max(0, i - 5));
        return;
      case 'Enter': {
        e.preventDefault();
        const how = { open: e.shiftKey, place: e.altKey };
        if (!ready) {
          setWaiting(how);
          return;
        }
        take(pick(how), how);
        return;
      }
      case 'Escape':
        e.preventDefault();
        props.onCancel();
        return;
      default:
        return;
    }
  };
  let lastGroup: Group | null = null;
  const grouped = new Set(items.map((i) => i.group)).size > 1;
  return (
    <>
      <div className="menu-backdrop" onPointerDown={props.onCancel} />
      <div
        ref={box}
        className="tab-menu find-menu"
        role="dialog"
        aria-label={label}
        style={{ left: pos.left, top: pos.top }}
      >
        <div className="tab-menu-prompt">
          <span aria-hidden="true">&gt;</span>
          <input
            ref={input}
            value={query}
            aria-label={label}
            title={`${label} · ${t(locale, 'menu.findKeys')}`}
            spellCheck={false}
            autoComplete="off"
            readOnly={waiting !== null}
            aria-busy={waiting !== null}
            // A query it opened with is typed on from its end.
            onFocus={(e) => {
              const end = e.currentTarget.value.length;
              e.currentTarget.setSelectionRange(end, end);
            }}
            onChange={(e) => {
              setQuery(e.target.value);
              setIndex(0);
            }}
            onKeyDown={onKey}
          />
        </div>
        {props.target ? (
          <div className="tab-menu-target" title={props.target}>
            {props.target}
          </div>
        ) : null}
        <div className="tab-menu-list" role="listbox" aria-label={label}>
          {items.length === 0 && ready && query.trim() !== '' ? (
            <div className="tab-menu-empty">
              {missing
                ? t(locale, 'path.missing', { name: query.slice(missing.start, missing.end) })
                : paths
                  ? t(locale, 'map.nothing', { q: query })
                  : t(locale, 'menu.nothing', { q: query })}
            </div>
          ) : null}
          {items.map((item, i) => {
            // One group needs no name: it would repeat what every row says.
            const header = item.group !== lastGroup && grouped ? item.group : null;
            lastGroup = item.group;
            return [
              header ? (
                <div key={`h:${header}`} className="tab-menu-header" role="presentation">
                  {t(locale, `menu.${header}` as const)}
                </div>
              ) : null,
              <div
                key={item.id}
                role="option"
                tabIndex={-1}
                aria-selected={i === index}
                className={i === index ? 'tab-menu-row is-current' : 'tab-menu-row'}
                onPointerMove={(e) => {
                  if (moved(e)) setIndex(i);
                }}
                onPointerDown={(e) => {
                  e.preventDefault();
                  take(item, { open: e.shiftKey, place: e.altKey });
                }}
              >
                <span
                  className="kind-icon"
                  style={{ '--glyph': glyphUrl(item.kind) } as React.CSSProperties}
                  aria-hidden="true"
                />
                <span className="tab-menu-label" title={item.label}>
                  {item.label}
                </span>
                <span className="tab-menu-detail" title={item.detail || undefined}>
                  {item.detail}
                </span>
              </div>,
            ];
          })}
        </div>
      </div>
    </>
  );
}
