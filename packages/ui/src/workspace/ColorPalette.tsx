import { people as palette } from '@strata/design-tokens';
import { type Locale, t } from '@strata/i18n';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/** CSS px between the window and the canvas's edges. */
const MARGIN = 8;

/**
 * The colour palette `C` (06 §2.1, 05 §4.1 `color`): «Без цвета» and the
 * eight colours of people and nodes (07 §2.2, ☑ Q-05-8), one row. The
 * arrows move along it, `Enter` or a click gives the colour, `1`…`8` give
 * one at once and `0` takes it away; one step of undo for each choice.
 * Opens at the cursor, kept inside the canvas; `Esc` closes it.
 */
export function ColorPalette(props: {
  locale: Locale;
  /** The first node's colour now: an index of the palette, or none. */
  current: number | null;
  x: number;
  y: number;
  bounds?: DOMRect | undefined;
  /** An index of the palette, or null — the kind's colour back (07 §2.2). */
  onPick: (color: number | null) => void;
  onClose: () => void;
}) {
  const { locale } = props;
  /** Under the keys: 0 — «Без цвета», k — colour k − 1. */
  const [index, setIndex] = useState(props.current === null ? 0 : props.current + 1);
  const box = useRef<HTMLDivElement>(null);
  const row = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: props.x, top: props.y });

  useEffect(() => {
    row.current?.focus();
  }, []);

  // At the cursor, clamped into the canvas one sees.
  useLayoutEffect(() => {
    const h = box.current?.offsetHeight ?? 0;
    const w = box.current?.offsetWidth ?? 0;
    const b = props.bounds;
    const left = (b?.left ?? 0) + MARGIN;
    const top = (b?.top ?? 0) + MARGIN;
    const right = (b?.right ?? window.innerWidth) - MARGIN;
    const bottom = (b?.bottom ?? window.innerHeight) - MARGIN;
    setPos({
      left: Math.max(left, Math.min(props.x, right - w)),
      top: Math.max(top, Math.min(props.y, bottom - h)),
    });
  }, [props.x, props.y, props.bounds]);

  const cells = palette.length + 1;
  const pick = (cell: number) => props.onPick(cell === 0 ? null : cell - 1);
  const name = (cell: number) =>
    cell === 0 ? t(locale, 'ins.noColor') : t(locale, `colors.${cell}` as 'colors.1');

  const onKey = (e: React.KeyboardEvent) => {
    if (/^[0-8]$/.test(e.key)) {
      e.preventDefault();
      pick(Number(e.key));
      return;
    }
    switch (e.key) {
      case 'ArrowRight':
        setIndex((i) => Math.min(cells - 1, i + 1));
        break;
      case 'ArrowLeft':
        setIndex((i) => Math.max(0, i - 1));
        break;
      case 'Home':
        setIndex(0);
        break;
      case 'End':
        setIndex(cells - 1);
        break;
      case 'Enter':
      case ' ':
        pick(index);
        break;
      case 'Escape':
        props.onClose();
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const label = t(locale, 'colors.label');
  return (
    <>
      <div className="menu-backdrop" onPointerDown={props.onClose} />
      <div
        ref={box}
        className="tab-menu color-palette"
        role="dialog"
        aria-label={label}
        style={{ left: pos.left, top: pos.top }}
      >
        <div className="tab-menu-header" aria-hidden="true">
          {label}
        </div>
        <div
          ref={row}
          className="color-row"
          role="listbox"
          aria-label={label}
          aria-activedescendant={`color-cell-${index}`}
          title={t(locale, 'colors.keys')}
          tabIndex={0}
          onKeyDown={onKey}
        >
          {Array.from({ length: cells }, (_, cell) => {
            const chosen = (props.current === null ? 0 : props.current + 1) === cell;
            const cls = ['color-cell'];
            if (cell === 0) cls.push('is-none');
            if (cell === index) cls.push('is-current');
            if (chosen) cls.push('is-chosen');
            return (
              <div
                // One fixed list: the position is the colour.
                // biome-ignore lint/suspicious/noArrayIndexKey: the cells never move
                key={cell}
                id={`color-cell-${cell}`}
                role="option"
                tabIndex={-1}
                aria-selected={cell === index}
                aria-label={name(cell)}
                title={cell === 0 ? `${name(cell)} — 0` : `${name(cell)} — ${cell}`}
                className={cls.join(' ')}
                style={cell === 0 ? undefined : { background: palette[cell - 1] }}
                onPointerDown={(e) => {
                  // The row keeps the keys.
                  e.preventDefault();
                  pick(cell);
                }}
              />
            );
          })}
        </div>
      </div>
    </>
  );
}
