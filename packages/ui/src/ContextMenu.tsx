import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Glyph } from './TabBar';

/**
 * A context menu (07 §8.2: `surface-raised`, 1u frame, `shadow-menu`, rows
 * ≥ 24 px, the key on the right in `text-muted`): the right button on a
 * card, a bubble or the bare canvas (06 §5). Arrows move, `Enter` chooses,
 * `Esc` or a click outside closes. It stays inside the window.
 */

export interface MenuEntry {
  label: string;
  /** A key that does the same, shown on the right. */
  hint?: string;
  disabled?: boolean | undefined;
  /** A line above this entry. */
  separated?: boolean;
  /** An entry that is on or off, as a flag (06 §8): a tick on the left. */
  checked?: boolean | undefined;
  onSelect: () => void;
}

export function ContextMenu(props: {
  x: number;
  y: number;
  label: string;
  items: MenuEntry[];
  onClose: () => void;
}) {
  const { items, onClose } = props;
  const box = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState({ x: props.x, y: props.y });
  const [current, setCurrent] = useState(() => items.findIndex((i) => !i.disabled));
  // Ticks take a column of their own, so every label starts in one line.
  const ticks = items.some((i) => i.checked !== undefined);

  // Inside the window: flip left or up when the menu would leave it.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setAt({
      x: props.x + r.width > window.innerWidth ? Math.max(0, props.x - r.width) : props.x,
      y: props.y + r.height > window.innerHeight ? Math.max(0, props.y - r.height) : props.y,
    });
    el.focus();
  }, [props.x, props.y]);

  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener('pointerdown', away, true);
    return () => window.removeEventListener('pointerdown', away, true);
  }, [onClose]);

  const step = (d: number) => {
    if (items.length === 0) return;
    let i = current;
    for (let k = 0; k < items.length; k++) {
      i = (i + d + items.length) % items.length;
      if (!items[i]?.disabled) break;
    }
    setCurrent(i);
  };

  const choose = (i: number) => {
    const item = items[i];
    if (!item || item.disabled) return;
    onClose();
    item.onSelect();
  };

  return (
    <div
      ref={box}
      className="context-menu"
      role="menu"
      aria-label={props.label}
      tabIndex={-1}
      data-ticks={ticks || undefined}
      style={{ left: at.x, top: at.y }}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'ArrowDown') step(1);
        else if (e.key === 'ArrowUp') step(-1);
        else if (e.key === 'Enter') choose(current);
        else if (e.key === 'Escape') onClose();
        else return;
        e.preventDefault();
      }}
    >
      {items.map((item, i) => {
        const row = {
          'aria-disabled': item.disabled || undefined,
          className: [
            'context-menu-row',
            i === current ? 'is-current' : '',
            item.separated ? 'is-separated' : '',
            item.disabled ? 'is-disabled' : '',
          ]
            .filter(Boolean)
            .join(' '),
          onPointerEnter: () => !item.disabled && setCurrent(i),
          onClick: () => choose(i),
          onKeyDown: () => undefined,
        };
        const body = (
          <>
            {ticks ? (
              <span className="context-menu-tick">
                {item.checked ? <Glyph name="check" /> : null}
              </span>
            ) : null}
            <span className="context-menu-label" title={item.label}>
              {item.label}
            </span>
            {item.hint ? <span className="context-menu-hint">{item.hint}</span> : null}
          </>
        );
        return item.checked === undefined ? (
          <div key={item.label} role="menuitem" tabIndex={-1} {...row}>
            {body}
          </div>
        ) : (
          <div
            key={item.label}
            role="menuitemcheckbox"
            aria-checked={item.checked}
            tabIndex={-1}
            {...row}
          >
            {body}
          </div>
        );
      })}
    </div>
  );
}
