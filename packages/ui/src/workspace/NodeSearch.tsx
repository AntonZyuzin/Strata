import {
  hasCanvas,
  type PathHit,
  type Resolved,
  type TrashItem,
  type TreeItem,
} from '@strata/backend';
import { glyphUrl } from '@strata/design-tokens';
import { type Locale, t } from '@strata/i18n';
import type { Scope, SearchClient, Visit } from '@strata/search';
import { type CSSProperties, useEffect, useMemo, useState } from 'react';
import { pointerMoved } from '../pointer';
import { segmentSpans } from './PathBar';
import { escapeSegment, pathLabel } from './paths';

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
  /** A node a typed path named, or a name offered for its segment (09 §4.4). */
  hit?: PathHit;
}

/** A query in the path mode (09 §2.1): it starts with `/`, `./`, `../`. */
export function pathQuery(q: string): boolean {
  return /^(\/|\.\.?(\/|$))/.test(q.trimStart());
}

/**
 * «Перейти к ноде» (09 §3.4): `Ctrl+O` on the canvas, `Ctrl+O` and `Ctrl+F`
 * on the star map (08 §6.1, §10). The engine of 09 §2 ranks the workspace's
 * names (collection `space`) in `scope`; with no query — the nodes visited
 * last; nodes in the trash below, three at most. `Enter` or a click goes to
 * the node, `Shift+Enter` opens it; a node in the trash comes back first.
 * An `Enter` typed before the engine's answer chooses once it comes, as in
 * the Tab menu. A query that starts with `/`, `./` or `../` is a path (09
 * §2.1, §4.4): the core resolves it from the entry path — the nodes it names,
 * or the names nearest to a segment that names nothing; `Tab` puts the row's
 * name in that segment, `/` after a network; `Enter` on a name offered puts
 * it there and asks again. Drawn like the Tab menu, its width in `ch`
 * whatever the language.
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
  /** What a typed path names, from the entry path (09 §4.4); none — no path mode. */
  resolve?: ((text: string) => Promise<Resolved>) | undefined;
  /** A node a typed path named, by the way it went; `open` — `Shift+Enter`. */
  onHit?: ((hit: PathHit, open: boolean) => void) | undefined;
  onClose: () => void;
}) {
  const { locale, items, search, scope, here, visits, trash, resolve } = props;
  const [query, setQuery] = useState('');
  /** The core's answer to a path, for the query it was asked. */
  const [resolved, setResolved] = useState<{ q: string; r: Resolved } | null>(null);
  const paths = resolve !== undefined && pathQuery(query);
  const [index, setIndex] = useState(0);
  const [moved] = useState(pointerMoved);
  const [found, setFound] = useState<{ q: string; ids: string[]; trashed: string[] } | null>(null);
  /** `Enter` before the answer: open or go, once it comes. */
  const [waiting, setWaiting] = useState<{ open: boolean } | null>(null);
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);

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

  useEffect(() => {
    const q = query.trim();
    if (q === '' || paths) return;
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
  }, [search, query, scope, here, visits, trash, paths]);

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
  const hitRow = (hit: PathHit): Row => {
    const [id, name] = hit.path.at(-1) ?? ['', ''];
    return {
      id,
      name,
      kind: hit.kind,
      path: pathLabel(hit.path.slice(0, -1)),
      trashed: false,
      hit,
    };
  };
  const answer = paths && resolved?.q === query ? resolved.r : null;
  // A path that ends with `/` and names one network: what lies in it, by name.
  const [one] = answer?.found ?? [];
  const into =
    answer &&
    !answer.missing &&
    answer.found.length === 1 &&
    one &&
    hasCanvas(one.kind) &&
    /(^|[^\\])\/\s*$/.test(query)
      ? one
      : null;
  let rows: Row[];
  if (into) {
    const net = into.path.at(-1)?.[0] ?? '';
    rows = items
      .filter((i) => i.parent === net || (i.appears ?? []).includes(net))
      .sort((a, b) => a.name.localeCompare(b.name, locale) || (a.id < b.id ? -1 : 1))
      .slice(0, ROWS)
      .map((i) =>
        hitRow({ path: [...into.path, [i.id, i.name]], kind: i.kind, primary: i.parent === net }),
      );
  } else if (paths) {
    rows = (answer ? (answer.missing?.near ?? answer.found) : []).slice(0, ROWS).map(hitRow);
  } else if (query.trim() === '') {
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
  const ready = paths ? answer !== null : query.trim() === '' || found?.q === query;
  /** The segment that named nothing, where a name offered goes. */
  const missing = answer?.missing ? segmentSpans(query)[answer.missing.at] : undefined;
  /** A row's name in the segment that named nothing; `/` after a network, to go on typing. */
  const complete = (r: Row, slash: boolean): string | null => {
    const tail = slash && hasCanvas(r.kind) ? '/' : '';
    if (into) return query.trimEnd() + escapeSegment(r.name) + tail;
    const last = segmentSpans(query).at(-1);
    const word = last ? query.slice(last.start, last.end) : '';
    // `.` and `..` name where one goes, not a name to put there.
    if (!missing && (word === '.' || word === '..')) return `${query.trimEnd()}/`;
    const span = missing ?? (answer?.found.length ? last : undefined);
    if (!span) return null;
    return query.slice(0, span.start) + escapeSegment(r.name) + tail + query.slice(span.end);
  };
  const { onChoose, onHit } = props;
  const take = (r: Row, open: boolean) => {
    if (r.hit && answer?.missing) {
      // A name offered: in the segment's place, and the path asked again.
      const next = complete(r, false);
      if (next !== null) setQuery(next);
      setIndex(0);
      if (next !== null) setWaiting({ open });
      return;
    }
    if (r.hit) onHit?.(r.hit, open);
    else onChoose(r.id, r.trashed ? 'restore' : open ? 'open' : 'go');
  };
  const choose = (i: number, open: boolean) => {
    if (!ready) {
      setWaiting({ open });
      return;
    }
    const r = rows[i];
    if (r) take(r, open);
  };
  const first = rows[Math.min(index, rows.length - 1)];
  useEffect(() => {
    if (!waiting || !ready) return;
    setWaiting(null);
    // A path asked again after a name offered goes only where it names one node.
    if (paths && (answer?.missing || (answer && answer.found.length !== 1))) return;
    if (first) take(first, waiting.open);
  });
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
              else if (e.key === 'Tab' && paths && !e.shiftKey) {
                // The row's name in its segment, as a shell completes a path.
                const r = rows[Math.min(index, rows.length - 1)];
                const next = r ? complete(r, true) : null;
                if (next !== null) {
                  setQuery(next);
                  setIndex(0);
                }
              } else if (e.key === 'ArrowDown') setIndex((i) => Math.min(rows.length - 1, i + 1));
              else if (e.key === 'ArrowUp') setIndex((i) => Math.max(0, i - 1));
              else return;
              e.preventDefault();
            }}
          />
        </div>
        <div className="tab-menu-list" role="listbox" aria-label={props.label}>
          {query.trim() && ready && rows.length === 0 ? (
            <div className="tab-menu-empty">
              {missing
                ? t(locale, 'path.missing', { name: query.slice(missing.start, missing.end) })
                : t(locale, 'map.nothing', { q: query })}
            </div>
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
                key={r.hit ? r.hit.path.map(([id]) => id).join('/') : r.id}
                role="option"
                tabIndex={-1}
                aria-selected={i === index}
                className={i === index ? 'tab-menu-row is-current' : 'tab-menu-row'}
                title={r.trashed ? t(locale, 'search.restore') : undefined}
                onPointerMove={(e) => {
                  if (moved(e)) setIndex(i);
                }}
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
