import type { TrashItem, TreeItem } from '@strata/backend';
import { glyphUrl } from '@strata/design-tokens';
import { type Locale, t } from '@strata/i18n';
import type { Scope, SearchClient, Visit } from '@strata/search';
import { type CSSProperties, useEffect, useMemo, useState } from 'react';

const ROWS = 12;
const TRASH_ROWS = 3;

/** What a row does: go to the node, open it, or bring it back from the trash. */
export type NodeChoice = 'go' | 'open' | 'restore';

interface Row {
  id: string;
  name: string;
  kind: TreeItem['kind'];
  /** The canonical path of its network, the root left out: the tab names it. */
  path: string;
  trashed: boolean;
}

/**
 * «Перейти к ноде» (09 §3.4): `Ctrl+O` on the canvas, `Ctrl+O` and `Ctrl+F`
 * on the star map (08 §6.1, §10). The engine of 09 §2 ranks the workspace's
 * names (collection `space`) in `scope`; with no query — the nodes visited
 * last; nodes in the trash below, three at most. `Enter` or a click goes to
 * the node, `Shift+Enter` opens it; a node in the trash comes back first.
 * An `Enter` typed before the engine's answer chooses once it comes, as in
 * the Tab menu. Drawn like the Tab menu, its width in `ch` whatever the language.
 */
export function NodeSearch(props: {
  locale: Locale;
  label: string;
  className: string;
  search: SearchClient;
  items: readonly TreeItem[];
  scope: Scope;
  /** The network on the canvas: closeness (09 §2.5). */
  here?: string | undefined;
  visits: Record<string, Visit>;
  trash?: readonly TrashItem[] | undefined;
  left: number;
  top: number;
  onChoose: (id: string, how: NodeChoice) => void;
  onClose: () => void;
}) {
  const { locale, items, search, scope, here, visits, trash } = props;
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const [found, setFound] = useState<{ q: string; ids: string[]; trashed: string[] } | null>(null);
  /** `Enter` before the answer: open or go, once it comes. */
  const [waiting, setWaiting] = useState<{ open: boolean } | null>(null);
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);

  useEffect(() => {
    const q = query.trim();
    if (q === '') return;
    let live = true;
    const trashNames = (trash ?? []).map((x) => x.name);
    void Promise.all([
      search.query('space', q, { limit: ROWS, scope, here, visits, now: Date.now() }),
      search.rank(q, trashNames, TRASH_ROWS),
    ]).then(([ids, gone]) => {
      if (!live) return;
      const trashed = gone.flatMap((r) => (trash?.[r.index] ? [trash[r.index]?.id ?? ''] : []));
      setFound({ q: query, ids, trashed });
    });
    return () => {
      live = false;
    };
  }, [search, query, scope, here, visits, trash]);

  const pathOf = (id: string): string => {
    const names: string[] = [];
    for (let at = byId.get(id)?.parent; at; at = byId.get(at)?.parent) {
      const item = byId.get(at);
      if (!item?.parent) break;
      names.unshift(item.name);
    }
    return names.join(' / ');
  };
  const row = (id: string): Row | null => {
    const item = byId.get(id);
    return item ? { id, name: item.name, kind: item.kind, path: pathOf(id), trashed: false } : null;
  };
  let rows: Row[];
  if (query.trim() === '') {
    // The nodes visited last (09 §3.4 «Недавние»), in the scope.
    rows = Object.entries(visits)
      .sort(([, a], [, b]) => b.at - a.at)
      .flatMap(([id]) => row(id) ?? [])
      .filter((r) => inScope(r.id, scope, byId))
      .slice(0, ROWS);
  } else if (found) {
    const gone = new Map((trash ?? []).map((x) => [x.id, x]));
    rows = [
      ...found.ids.flatMap((id) => row(id) ?? []),
      ...found.trashed.flatMap((id) => {
        const x = gone.get(id);
        return x ? [{ id, name: x.name, kind: x.kind, path: '', trashed: true }] : [];
      }),
    ];
  } else {
    rows = [];
  }
  const ready = query.trim() === '' || found?.q === query;
  const choose = (i: number, open: boolean) => {
    if (!ready) {
      setWaiting({ open });
      return;
    }
    const r = rows[i];
    if (r) props.onChoose(r.id, r.trashed ? 'restore' : open ? 'open' : 'go');
  };
  const first = rows[Math.min(index, rows.length - 1)];
  const { onChoose } = props;
  useEffect(() => {
    if (!waiting || !ready) return;
    setWaiting(null);
    if (first) onChoose(first.id, first.trashed ? 'restore' : waiting.open ? 'open' : 'go');
  }, [waiting, ready, first, onChoose]);
  let headed = false;
  return (
    <>
      <div className="menu-backdrop" onPointerDown={props.onClose} />
      <div
        className={`tab-menu node-search ${props.className}`}
        role="dialog"
        aria-label={props.label}
        style={{ left: props.left, top: props.top }}
      >
        <div className="tab-menu-prompt">
          <span aria-hidden="true">&gt;</span>
          <input
            value={query}
            aria-label={props.label}
            title={`${props.label} · ${t(locale, 'search.keys')}`}
            spellCheck={false}
            autoComplete="off"
            // biome-ignore lint/a11y/noAutofocus: the search opens on its key to be typed into
            autoFocus
            onChange={(e) => {
              setQuery(e.target.value);
              setIndex(0);
              setWaiting(null);
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Escape') props.onClose();
              else if (e.key === 'Enter') choose(index, e.shiftKey);
              else if (e.key === 'ArrowDown') setIndex((i) => Math.min(rows.length - 1, i + 1));
              else if (e.key === 'ArrowUp') setIndex((i) => Math.max(0, i - 1));
              else return;
              e.preventDefault();
            }}
          />
        </div>
        <div className="tab-menu-list" role="listbox" aria-label={props.label}>
          {query.trim() && ready && rows.length === 0 ? (
            <div className="tab-menu-empty">{t(locale, 'map.nothing', { q: query })}</div>
          ) : null}
          {rows.map((r, i) => {
            const header = r.trashed && !headed;
            if (header) headed = true;
            return [
              header ? (
                <div key="h:trash" className="tab-menu-header" role="presentation">
                  {t(locale, 'search.trash')}
                </div>
              ) : null,
              <div
                key={r.id}
                role="option"
                tabIndex={-1}
                aria-selected={i === index}
                className={i === index ? 'tab-menu-row is-current' : 'tab-menu-row'}
                title={r.trashed ? t(locale, 'search.restore') : undefined}
                onPointerEnter={() => setIndex(i)}
                onPointerDown={(e) => {
                  e.preventDefault();
                  choose(i, e.shiftKey);
                }}
              >
                <span
                  className="kind-icon"
                  style={{ '--glyph': glyphUrl(r.kind) } as CSSProperties}
                  aria-hidden="true"
                />
                <span className="tab-menu-label" title={r.name}>
                  {r.name || t(locale, 'note.untitled')}
                </span>
                <span className="tab-menu-detail" title={r.path}>
                  {r.path}
                </span>
              </div>,
            ];
          })}
        </div>
      </div>
    </>
  );
}

/** Whether a node lies in a scope, by the tree's parents. */
function inScope(id: string, scope: Scope, byId: ReadonlyMap<string, TreeItem>): boolean {
  if (scope.t === 'all') return true;
  const parent = byId.get(id)?.parent;
  if (scope.t === 'in') return parent === scope.net;
  for (let at = parent; at; at = byId.get(at)?.parent) if (at === scope.net) return true;
  return false;
}
