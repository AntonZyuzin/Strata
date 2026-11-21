import type { PathHit, Resolved, TreeItem } from '@strata/backend';
import { glyphUrl } from '@strata/design-tokens';
import { type Locale, t } from '@strata/i18n';
import type { SearchClient, Visit } from '@strata/search';
import { type CSSProperties, useEffect, useMemo, useState } from 'react';
import { pointerMoved } from '../pointer';
import { completePath, missingSpan, pathQuery, pathRows } from './pathRows';

const ROWS = 12;

interface Row {
  id: string;
  name: string;
  kind: TreeItem['kind'];
  /** The canonical path of its network, the root left out: the tab names it. */
  path: string;
  /** A node a typed path named, or a name offered for its segment (09 §4.4). */
  hit?: PathHit;
}

/**
 * The star map's search (08 §6.1, §10): `Ctrl+O` there; on the canvas
 * `Ctrl+O` opens «Найти или создать» (☑ Q-06-26). The engine of 09 §2 ranks
 * the workspace's names (collection `space`); with no query — the nodes
 * visited last. `Enter` or a click flies to the star, `Shift+Enter` the
 * same. An `Enter` typed before the engine's answer chooses once it comes,
 * as in the Tab menu. A query that starts with `/`, `./` or `../` is a path
 * (09 §2.1, §4.4): the core resolves it from the entry path — the nodes it
 * names, or the names nearest to a segment that names nothing; `Tab` puts
 * the row's name in that segment, `/` after a network; `Enter` on a name
 * offered puts it there and asks again. Drawn like the Tab menu, its width
 * in `ch` whatever the language.
 */
export function NodeSearch(props: {
  locale: Locale;
  search: SearchClient;
  items: readonly TreeItem[];
  visits: Record<string, Visit>;
  left: number;
  top: number;
  onChoose: (id: string) => void;
  /** What a typed path names, from the entry path (09 §4.4). */
  resolve: (text: string) => Promise<Resolved>;
  /** A node a typed path named. */
  onHit: (hit: PathHit) => void;
  /** The query it opens with: a path the palette began (09 §3.5). */
  initial?: string | undefined;
  onClose: () => void;
}) {
  const { locale, items, search, visits, resolve } = props;
  const label = t(locale, 'map.find');
  const [query, setQuery] = useState(props.initial ?? '');
  /** The core's answer to a path, for the query it was asked. */
  const [resolved, setResolved] = useState<{ q: string; r: Resolved } | null>(null);
  const paths = pathQuery(query);
  const [index, setIndex] = useState(0);
  const [moved] = useState(pointerMoved);
  const [found, setFound] = useState<{ q: string; ids: string[] } | null>(null);
  /** `Enter` before the answer: chooses once it comes. */
  const [waiting, setWaiting] = useState(false);
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);

  useEffect(() => {
    if (!paths) return;
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
    void search.query('space', q, { limit: ROWS, visits, now: Date.now() }).then((ids) => {
      if (live) setFound({ q: query, ids });
    });
    return () => {
      live = false;
    };
  }, [search, query, visits, paths]);

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
    return item ? { id, name: item.name, kind: item.kind, path: pathOf(id) } : null;
  };
  const answer = paths && resolved?.q === query ? resolved.r : null;
  let rows: Row[];
  if (paths) {
    rows = pathRows(query, answer, items, locale, ROWS);
  } else if (query.trim() === '') {
    // The nodes visited last (09 §3.4 «Недавние»).
    rows = Object.entries(visits)
      .sort(([, a], [, b]) => b.at - a.at)
      .flatMap(([id]) => row(id) ?? [])
      .slice(0, ROWS);
  } else {
    rows = found ? found.ids.flatMap((id) => row(id) ?? []) : [];
  }
  const ready = paths ? answer !== null : query.trim() === '' || found?.q === query;
  /** The segment that named nothing, where a name offered goes. */
  const missing = missingSpan(query, answer);
  const { onChoose, onHit } = props;
  const take = (r: Row) => {
    if (r.hit && answer?.missing) {
      // A name offered: in the segment's place, and the path asked again.
      const next = completePath(query, answer, r, false);
      setIndex(0);
      if (next !== null) {
        setQuery(next);
        setWaiting(true);
      }
      return;
    }
    if (r.hit) onHit(r.hit);
    else onChoose(r.id);
  };
  const choose = (i: number) => {
    if (!ready) {
      setWaiting(true);
      return;
    }
    const r = rows[i];
    if (r) take(r);
  };
  const first = rows[Math.min(index, rows.length - 1)];
  useEffect(() => {
    if (!waiting || !ready) return;
    setWaiting(false);
    // A path asked again after a name offered goes only where it names one node.
    if (paths && (answer?.missing || (answer && answer.found.length !== 1))) return;
    if (first) take(first);
  });
  return (
    <>
      <div className="menu-backdrop" onPointerDown={props.onClose} />
      <div
        className="tab-menu find-menu node-search map-search"
        role="dialog"
        aria-label={label}
        style={{ left: props.left, top: props.top }}
      >
        <div className="tab-menu-prompt">
          <span aria-hidden="true">&gt;</span>
          <input
            value={query}
            aria-label={label}
            title={`${label} · ${t(locale, 'map.findKeys')}`}
            spellCheck={false}
            autoComplete="off"
            // biome-ignore lint/a11y/noAutofocus: the search opens on its key to be typed into
            autoFocus
            // A query it opened with is typed on from its end.
            onFocus={(e) => {
              const end = e.currentTarget.value.length;
              e.currentTarget.setSelectionRange(end, end);
            }}
            onChange={(e) => {
              setQuery(e.target.value);
              setIndex(0);
              setWaiting(false);
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Escape') props.onClose();
              else if (e.key === 'Enter') choose(index);
              else if (e.key === 'Tab' && paths && !e.shiftKey) {
                // The row's name in its segment, as a shell completes a path.
                const r = rows[Math.min(index, rows.length - 1)];
                const next = r ? completePath(query, answer, r, true) : null;
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
        <div className="tab-menu-list" role="listbox" aria-label={label}>
          {query.trim() && ready && rows.length === 0 ? (
            <div className="tab-menu-empty">
              {missing
                ? t(locale, 'path.missing', { name: query.slice(missing.start, missing.end) })
                : t(locale, 'map.nothing', { q: query })}
            </div>
          ) : null}
          {rows.map((r, i) => (
            <div
              key={r.hit ? r.hit.path.map(([id]) => id).join('/') : r.id}
              role="option"
              tabIndex={-1}
              aria-selected={i === index}
              className={i === index ? 'tab-menu-row is-current' : 'tab-menu-row'}
              onPointerMove={(e) => {
                if (moved(e)) setIndex(i);
              }}
              onPointerDown={(e) => {
                e.preventDefault();
                choose(i);
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
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
