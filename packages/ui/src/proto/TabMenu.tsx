import { glyphUrl } from '@strata/design-tokens';
import { type Locale, t } from '@strata/i18n';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { pointerMoved } from '../pointer';
import {
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
 * Tab menu (06 §5, 07 §8.2): a window without a title bar, 52 ch of the UI font
 * wide (360 px at DPR 1) whatever the language, prompt «>», up to 12 rows, group headers;
 * the keys are in the tooltip of the prompt, not on a line of their own.
 * It opens at the anchor and stays inside the canvas, clear of the status bar.
 */

const MARGIN = 8;

export function TabMenu(props: {
  locale: Locale;
  x: number;
  y: number;
  /** Right and bottom edges the menu stays within; the viewport by default. */
  bounds?: { right: number; bottom: number } | undefined;
  initialQuery: string;
  nodes: readonly MenuNode[];
  recent: readonly string[];
  /** Nodes with the flag «Шаблон» (05 §7), from the whole workspace. */
  templates?: readonly MenuNode[] | undefined;
  /** This network's ghosts (05 §8.5). */
  ghosts?: readonly MenuGhost[] | undefined;
  /** A ghost's name, clicked with Shift: the kinds for it (06 §14). */
  named?: string | undefined;
  /** The search engine (09 §2): it ranks what a query matches. */
  search: MenuSearch;
  onChoose: (item: MenuItem) => void;
  onCancel: () => void;
}) {
  const { locale, search, templates, ghosts, named } = props;
  const [query, setQuery] = useState(props.initialQuery);
  const [index, setIndex] = useState(0);
  const [moved] = useState(pointerMoved);
  // The engine answers in its worker: the rows stay those of the last
  // answer until the next one comes, and `Enter` waits for the query's own.
  const [ranking, setRanking] = useState<MenuRanking | null>(null);
  const [waiting, setWaiting] = useState(false);
  useEffect(() => {
    if (query.trim() === '') return;
    let live = true;
    void rankMenu(search, query, templates ?? [], ghosts ?? []).then((r) => {
      if (live) setRanking(r);
    });
    return () => {
      live = false;
    };
  }, [search, query, templates, ghosts]);
  const shown = query.trim() === '' ? query : (ranking?.query ?? query);
  const items = useMemo(
    () =>
      menuItems(
        locale,
        shown,
        props.nodes,
        props.recent,
        templates,
        ranking,
        ghosts,
        named ?? null,
      ),
    [locale, shown, props.nodes, props.recent, templates, ranking, ghosts, named],
  );
  const ready = query.trim() === '' || ranking?.query === query;
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
    setPos({
      left: Math.max(MARGIN, Math.min(props.x, right - w - MARGIN)),
      top: Math.max(MARGIN, Math.min(props.y, bottom - h - MARGIN)),
    });
  }, [props.x, props.y, items.length]);

  const current = items[Math.min(index, items.length - 1)];
  // `Enter` typed before the engine's answer chooses once it comes.
  const { onChoose } = props;
  useEffect(() => {
    if (!waiting || !ready) return;
    setWaiting(false);
    if (current) onChoose(current);
  }, [waiting, ready, current, onChoose]);

  const onKey = (e: React.KeyboardEvent) => {
    const n = items.length;
    switch (e.key) {
      case 'ArrowDown':
      case 'Tab':
        e.preventDefault();
        if (n > 0) setIndex((i) => (e.shiftKey && e.key === 'Tab' ? (i - 1 + n) % n : (i + 1) % n));
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
      case 'Enter':
        e.preventDefault();
        if (!ready) setWaiting(true);
        else if (current) props.onChoose(current);
        return;
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
        className="tab-menu"
        role="dialog"
        aria-label={t(locale, 'menu.query')}
        style={{ left: pos.left, top: pos.top }}
      >
        <div className="tab-menu-prompt">
          <span aria-hidden="true">&gt;</span>
          <input
            ref={input}
            value={query}
            aria-label={t(locale, 'menu.query')}
            title={t(locale, 'menu.footer')}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => {
              setQuery(e.target.value);
              setIndex(0);
            }}
            onKeyDown={onKey}
          />
        </div>
        <div className="tab-menu-list" role="listbox" aria-label={t(locale, 'menu.query')}>
          {items.length === 0 && ready ? (
            <div className="tab-menu-empty">{t(locale, 'menu.nothing', { q: query })}</div>
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
                  props.onChoose(item);
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
                <span className="tab-menu-detail">{item.detail}</span>
              </div>,
            ];
          })}
        </div>
      </div>
    </>
  );
}
