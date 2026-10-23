import type { TreeItem } from '@strata/backend';
import { type Locale, t } from '@strata/i18n';
import { Glyph } from '../TabBar';

/**
 * «Структура» (owner's sketch, 2026-10-24): the workspace's networks and
 * tasks as a tree, the one you are in lit with the accent. It replaces the
 * path bar: where you are and how to get anywhere, in one place.
 */
export function Structure(props: {
  locale: Locale;
  items: TreeItem[];
  current: string;
  onGo: (id: string) => void;
}) {
  const { items, current } = props;
  const children = new Map<string, TreeItem[]>();
  for (const it of items) {
    const key = it.parent ?? '';
    const list = children.get(key) ?? [];
    list.push(it);
    children.set(key, list);
  }
  // The path of the current network stays open; other branches show one level.
  const parentOf = new Map(items.map((i) => [i.id, i.parent ?? null]));
  const open = new Set<string>();
  for (let at: string | null = current; at; at = parentOf.get(at) ?? null) open.add(at);

  const branch = (parent: string, depth: number) =>
    (children.get(parent) ?? []).map((it) => (
      <li key={it.id}>
        <button
          type="button"
          className={it.id === current ? 'tree-row is-current' : 'tree-row'}
          style={{ paddingLeft: `calc(${4 + depth * 8} * var(--u))` }}
          aria-current={it.id === current ? 'location' : undefined}
          title={it.name}
          onClick={() => props.onGo(it.id)}
        >
          <Glyph name="network" />
          <span>{it.name}</span>
        </button>
        {(open.has(it.id) || depth === 0) && children.has(it.id) ? (
          <ul>{branch(it.id, depth + 1)}</ul>
        ) : null}
      </li>
    ));

  return (
    <nav className="window ws-tree" aria-label={t(props.locale, 'tree.label')}>
      <ul>{branch('', 0)}</ul>
    </nav>
  );
}
