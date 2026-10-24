import type { TreeItem } from '@strata/backend';
import { glyphUrl } from '@strata/design-tokens';
import { type Locale, t } from '@strata/i18n';
import { type CSSProperties, useMemo, useState } from 'react';
import { rank } from '../proto/search';

const ROWS = 8;

/**
 * Search on the star map (08 §6.1, §10): `Ctrl+O` names the whole space,
 * `Ctrl+F` the cluster in focus (`within`). The same ranking as the Tab
 * menu's; `Enter` or a click flies to the star. Drawn like the Tab menu.
 */
export function MapSearch(props: {
  locale: Locale;
  items: readonly TreeItem[];
  /** The cluster in focus for `Ctrl+F`: only its subtree is searched. */
  within: string | null;
  left: number;
  top: number;
  onChoose: (id: string) => void;
  onClose: () => void;
}) {
  const { locale, items, within } = props;
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const pool = useMemo(() => {
    if (!within) return items;
    const parent = new Map(items.map((i) => [i.id, i.parent]));
    const under = (id: string) => {
      for (let at = parent.get(id); at; at = parent.get(at)) if (at === within) return true;
      return false;
    };
    return items.filter((i) => under(i.id));
  }, [items, within]);
  const rows = query.trim() ? rank(query, pool, (i) => i.name, ROWS) : [];
  const label = t(locale, within ? 'map.findHere' : 'map.find');
  const choose = (i: number) => {
    const row = rows[i];
    if (row) props.onChoose(row.id);
  };
  return (
    <>
      <div className="menu-backdrop" onPointerDown={props.onClose} />
      <div
        className="tab-menu map-search"
        role="dialog"
        aria-label={label}
        style={{ left: props.left, top: props.top }}
      >
        <div className="tab-menu-prompt">
          <span aria-hidden="true">&gt;</span>
          <input
            value={query}
            aria-label={label}
            title={label}
            spellCheck={false}
            autoComplete="off"
            // biome-ignore lint/a11y/noAutofocus: the search opens on its key to be typed into
            autoFocus
            onChange={(e) => {
              setQuery(e.target.value);
              setIndex(0);
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Escape') props.onClose();
              else if (e.key === 'Enter') choose(index);
              else if (e.key === 'ArrowDown') setIndex((i) => Math.min(rows.length - 1, i + 1));
              else if (e.key === 'ArrowUp') setIndex((i) => Math.max(0, i - 1));
              else return;
              e.preventDefault();
            }}
          />
        </div>
        <div className="tab-menu-list" role="listbox" aria-label={label}>
          {query.trim() && rows.length === 0 ? (
            <div className="tab-menu-empty">{t(locale, 'map.nothing', { q: query })}</div>
          ) : null}
          {rows.map((row, i) => (
            <div
              key={row.id}
              role="option"
              tabIndex={-1}
              aria-selected={i === index}
              className={i === index ? 'tab-menu-row is-current' : 'tab-menu-row'}
              onPointerEnter={() => setIndex(i)}
              onPointerDown={(e) => {
                e.preventDefault();
                choose(i);
              }}
            >
              <span
                className="kind-icon"
                style={{ '--glyph': glyphUrl(row.kind) } as CSSProperties}
                aria-hidden="true"
              />
              <span className="tab-menu-label" title={row.name}>
                {row.name || t(locale, 'note.untitled')}
              </span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
