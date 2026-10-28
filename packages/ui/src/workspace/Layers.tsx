import { isFinal, type TrashItem, type TreeItem } from '@strata/backend';
import { type Locale, t } from '@strata/i18n';
import type { SearchClient } from '@strata/search';
import { useEffect, useMemo, useState } from 'react';
import { Icon, nodeIcon } from '../icons/Icon';
import { Glyph } from '../TabBar';
import { dueWord, nearDue } from './due';

/** The filter's matches at most. */
const FILTERED = 100;

/**
 * «Слои» (owner, 2026-10-24: like Figma's layers): the whole workspace as a
 * tree along the left edge, every node under its network; the workspace
 * itself is not a row — it is the whole board. A click selects
 * the node on the canvas (going into its network when needed), a double
 * click opens it, the triangle folds a branch. The filter on top keeps the
 * nodes whose names match, by the search engine (09 §2: typos and the other
 * layout too), with the way to each; `Enter` goes to the first, `Esc`
 * clears it. The trash is the panel's foot.
 */
export function Layers(props: {
  locale: Locale;
  items: TreeItem[];
  /** The network on the canvas. */
  current: string;
  selected: ReadonlySet<string>;
  trash: TrashItem[];
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
  onRestore: (item: TrashItem) => void;
  /** The search engine; the workspace's names are its collection `space`. */
  search: SearchClient;
}) {
  const { locale, items, current, selected, search } = props;
  const [filter, setFilter] = useState('');
  /** The matches of the filter, best first; null — no filter. */
  const [matches, setMatches] = useState<string[] | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `items` — the tree changed, so may the names
  useEffect(() => {
    if (filter.trim() === '') {
      setMatches(null);
      return;
    }
    let live = true;
    void search.query('space', filter, { limit: FILTERED }).then((ids) => {
      if (live) setMatches(ids);
    });
    return () => {
      live = false;
    };
  }, [search, filter, items]);
  const children = useMemo(() => {
    const m = new Map<string, TreeItem[]>();
    for (const it of items) {
      const key = it.parent ?? '';
      const list = m.get(key) ?? [];
      list.push(it);
      m.set(key, list);
    }
    return m;
  }, [items]);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const root = items.find((i) => !i.parent);
  // Filtered: the matches and the networks on the way to them, unfolded.
  const shown = useMemo(() => {
    if (!matches) return null;
    const parentOf = new Map(items.map((i) => [i.id, i.parent]));
    const out = new Set<string>();
    for (const id of matches) {
      for (let at: string | undefined = id; at && !out.has(at); at = parentOf.get(at)) out.add(at);
    }
    return out;
  }, [matches, items]);

  // The way to the network on the canvas stays open.
  useEffect(() => {
    const parentOf = new Map(items.map((i) => [i.id, i.parent ?? null]));
    setOpen((o) => {
      const next = new Set(o);
      for (let at: string | null = current; at; at = parentOf.get(at) ?? null) next.add(at);
      return next;
    });
  }, [current, items]);

  const toggle = (id: string) =>
    setOpen((o) => {
      const next = new Set(o);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const branch = (parent: string, depth: number) =>
    (children.get(parent) ?? [])
      .filter((it) => !shown || shown.has(it.id))
      .map((it) => {
        const kids = children.has(it.id);
        const unfolded = shown ? true : open.has(it.id);
        const due = isFinal(it.status) ? null : nearDue(it.deadline);
        const cls = ['layer-row'];
        if (selected.has(it.id)) cls.push('is-selected');
        if (it.id === current) cls.push('is-here');
        // On the way to a match, not one itself.
        if (shown && !matches?.includes(it.id)) cls.push('is-way');
        return (
          <li key={it.id}>
            <div
              className={cls.join(' ')}
              // Like Figma's: a level is 16u, a child's triangle under its parent's icon.
              style={{ paddingLeft: `calc(${10 + depth * 16} * var(--u))` }}
            >
              {kids ? (
                <button
                  type="button"
                  className="layer-fold"
                  aria-label={it.name}
                  aria-expanded={unfolded}
                  tabIndex={-1}
                  onClick={() => toggle(it.id)}
                >
                  <Glyph name={unfolded ? 'unfolded' : 'folded'} />
                </button>
              ) : (
                <span className="layer-fold" aria-hidden="true" />
              )}
              <button
                type="button"
                className={isFinal(it.status) ? 'layer-name is-done' : 'layer-name'}
                aria-current={it.id === current ? 'location' : undefined}
                onClick={() => props.onSelect(it.id)}
                onDoubleClick={() => props.onOpen(it.id)}
              >
                <Icon name={nodeIcon(it.kind, it, kids && unfolded)} />
                {/* A cut name shows whole in its tooltip. */}
                <span className="layer-label" title={it.name || t(locale, 'note.untitled')}>
                  {it.name || t(locale, 'note.untitled')}
                </span>
                {/* A near or past deadline's state (Q-07-22), its word in the tooltip. */}
                {due ? (
                  <span
                    className="layer-due"
                    data-due={due}
                    role="img"
                    aria-label={dueWord(it.deadline, locale) ?? ''}
                    title={dueWord(it.deadline, locale) ?? ''}
                  />
                ) : null}
              </button>
            </div>
            {kids && unfolded ? <ul>{branch(it.id, depth + 1)}</ul> : null}
          </li>
        );
      });

  return (
    <nav className="ws-layers" aria-labelledby="layers-title">
      <h2 className="layers-title" id="layers-title">
        {t(locale, 'tree.label')}
      </h2>
      <div className="tab-menu-prompt layers-filter">
        <span aria-hidden="true">&gt;</span>
        <input
          value={filter}
          aria-label={t(locale, 'tree.filter')}
          title={t(locale, 'tree.filter')}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setFilter('');
            else if (e.key === 'Enter' && matches?.[0]) props.onSelect(matches[0]);
            else return;
            e.preventDefault();
          }}
        />
      </div>
      <ul className="layers-list">{root ? branch(root.id, 0) : null}</ul>
      {props.trash.length > 0 ? (
        <details className="layers-trash">
          <summary>{t(locale, 'ws.trash', { n: props.trash.length })}</summary>
          <ul>
            {props.trash.map((item) => (
              <li key={item.id}>
                <span className="trash-name" title={item.name}>
                  {item.name || t(locale, 'note.untitled')}
                </span>
                <button type="button" onClick={() => props.onRestore(item)}>
                  {t(locale, 'ws.restore')}
                </button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </nav>
  );
}
