import { type Locale, t } from '@strata/i18n';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { type Group, type MenuItem, type MenuNode, menuItems } from './menu';

/**
 * Tab menu (06 §5, 07 §8.2): a window without a title bar, 360 px wide whatever
 * the language, prompt «>», up to 12 rows, group headers, key hints below.
 * It opens at the anchor and stays inside the canvas, clear of the status bar.
 */

const WIDTH = 360;
const MARGIN = 8;

export function TabMenu(props: {
  locale: Locale;
  x: number;
  y: number;
  /** Right and bottom edges the menu stays within; the viewport by default. */
  bounds?: { right: number; bottom: number };
  initialQuery: string;
  nodes: readonly MenuNode[];
  recent: readonly string[];
  onChoose: (item: MenuItem) => void;
  onCancel: () => void;
}) {
  const { locale } = props;
  const [query, setQuery] = useState(props.initialQuery);
  const [index, setIndex] = useState(0);
  const items = useMemo(
    () => menuItems(locale, query, props.nodes, props.recent),
    [locale, query, props.nodes, props.recent],
  );
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
    const right = props.bounds?.right ?? window.innerWidth;
    const bottom = props.bounds?.bottom ?? window.innerHeight;
    setPos({
      left: Math.max(MARGIN, Math.min(props.x, right - WIDTH - MARGIN)),
      top: Math.max(MARGIN, Math.min(props.y, bottom - h - MARGIN)),
    });
  }, [props.x, props.y, items.length]);

  const current = items[Math.min(index, items.length - 1)];

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
        if (current) props.onChoose(current);
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
  return (
    <>
      <div className="menu-backdrop" onPointerDown={props.onCancel} />
      <div
        ref={box}
        className="tab-menu"
        role="dialog"
        aria-label={t(locale, 'menu.query')}
        style={{ left: pos.left, top: pos.top, width: WIDTH }}
      >
        <div className="tab-menu-prompt">
          <span aria-hidden="true">&gt;</span>
          <input
            ref={input}
            value={query}
            aria-label={t(locale, 'menu.query')}
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
          {items.length === 0 ? (
            <div className="tab-menu-empty">{t(locale, 'menu.nothing', { q: query })}</div>
          ) : null}
          {items.map((item, i) => {
            const header = item.group !== lastGroup ? item.group : null;
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
                onPointerEnter={() => setIndex(i)}
                onPointerDown={(e) => {
                  e.preventDefault();
                  props.onChoose(item);
                }}
              >
                <span className={`kind-icon kind-${item.kind}`} aria-hidden="true" />
                <span className="tab-menu-label" title={item.label}>
                  {item.label}
                </span>
                <span className="tab-menu-detail">{item.detail}</span>
              </div>,
            ];
          })}
        </div>
        <div className="tab-menu-footer" title={t(locale, 'menu.footer')}>
          {t(locale, 'menu.footer')}
        </div>
      </div>
    </>
  );
}
