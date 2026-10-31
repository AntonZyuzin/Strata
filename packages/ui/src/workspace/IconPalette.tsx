import type { IconAuthor, IconPreset } from '@strata/canvas';
import { iconName, iconTerms, type Locale, t } from '@strata/i18n';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { IconName } from '../icons/Icon';
import { pointerMoved } from '../pointer';
import type { MenuSearch } from '../proto/menu';
import { IconButton } from '../TabBar';

/** CSS px between the window and the canvas's edges. */
const MARGIN = 8;
/** Cells in a row of the grid; the arrows move by one or by a row. */
const COLS = 8;

/** The prefix of a preset reference in a node's `icon` (05 §4.1 `IconRef`). */
export const PRESET = 'game-icons/';

/**
 * The icon palette `Z` (06 §2, 07 §6.3, ☑ Q-07-21): the presets that ship,
 * found by their words in either language; the author of the one under the
 * keys or the cursor on the window's last line («© Lorc, CC BY 3.0»). `Enter`
 * or a click gives it to the nodes; the kind's icon beside the query
 * («Значок вида») takes a chosen one back; one step of undo either way.
 * Opens at the cursor, kept inside the canvas; the Tab menu's window, its
 * width in `ch`.
 */
export function IconPalette(props: {
  locale: Locale;
  /** The presets and their authors; null until they load. */
  presets: { authors: Record<string, IconAuthor>; icons: readonly IconPreset[] } | null;
  /** The node's `icon` now (a preset's reference, or none — its kind's icon). */
  current: string | null;
  /** The kind's icon of the first of the nodes: the button that takes a preset back shows it. */
  kind: IconName;
  x: number;
  y: number;
  bounds?: DOMRect | undefined;
  search: Pick<MenuSearch, 'rank'>;
  /** A preset by id, or null — back to the kind's icon. */
  onPick: (id: string | null) => void;
  onClose: () => void;
}) {
  const { locale, presets, search } = props;
  const icons = presets?.icons ?? [];
  const [query, setQuery] = useState('');
  /** Preset indices the query finds, best first; null — every preset, in order. */
  const [found, setFound] = useState<{ query: string; order: number[] } | null>(null);
  const [index, setIndex] = useState(0);
  const [moved] = useState(pointerMoved);
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: props.x, top: props.y });

  // Every word of every preset, and whose it is: the engine ranks words.
  const words = useMemo(() => {
    const terms: string[] = [];
    const owner: number[] = [];
    icons.forEach((icon, k) => {
      for (const w of iconTerms(icon.id)) {
        terms.push(w);
        owner.push(k);
      }
    });
    return { terms, owner };
  }, [icons]);

  useEffect(() => {
    const q = query.trim();
    if (q === '') return;
    let live = true;
    void search.rank(q, words.terms, words.terms.length).then((ranked) => {
      if (!live) return;
      const order: number[] = [];
      for (const r of ranked) {
        const k = words.owner[r.index];
        if (k !== undefined && !order.includes(k)) order.push(k);
      }
      setFound({ query, order });
    });
    return () => {
      live = false;
    };
  }, [query, search, words]);

  const shown = useMemo(() => {
    if (query.trim() === '') return icons.map((_, k) => k);
    return found?.query === query ? found.order : [];
  }, [query, found, icons]);

  // The node's own preset is the first under the keys when the palette opens.
  const start = useRef(true);
  useEffect(() => {
    if (!start.current || icons.length === 0) return;
    start.current = false;
    const at = icons.findIndex((i) => `${PRESET}${i.id}` === props.current);
    if (at >= 0) setIndex(at);
  }, [icons, props.current]);

  useEffect(() => {
    input.current?.focus();
  }, []);

  // At the cursor, clamped into the canvas one sees.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the height changes with the rows
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
  }, [props.x, props.y, shown.length > 0]);

  const at = Math.min(index, Math.max(0, shown.length - 1));
  // biome-ignore lint/correctness/useExhaustiveDependencies: `at` — the cell moved
  useEffect(() => {
    grid.current?.querySelector('.is-current')?.scrollIntoView({ block: 'nearest' });
  }, [at]);

  const cell = shown[at];
  const icon = cell === undefined ? undefined : icons[cell];
  const pick = (k: number | undefined) => {
    const i = k === undefined ? undefined : icons[k];
    if (i) props.onPick(i.id);
  };
  const authorOf = (id: string) => presets?.authors[id.split('/')[0] ?? '']?.name ?? '';
  const by = (id: string) =>
    t(locale, 'icons.by', { name: iconName(locale, id), author: authorOf(id) });
  const line = icon ? by(icon.id) : '';

  const onKey = (e: React.KeyboardEvent) => {
    const n = shown.length;
    const move = (d: number) => setIndex(Math.max(0, Math.min(n - 1, at + d)));
    switch (e.key) {
      case 'ArrowRight':
        move(1);
        break;
      case 'ArrowLeft':
        move(-1);
        break;
      case 'ArrowDown':
        move(COLS);
        break;
      case 'ArrowUp':
        move(-COLS);
        break;
      case 'PageDown':
        move(COLS * 4);
        break;
      case 'PageUp':
        move(-COLS * 4);
        break;
      case 'Enter':
        pick(cell);
        break;
      case 'Escape':
        props.onClose();
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const label = t(locale, 'icons.label');
  return (
    <>
      <div className="menu-backdrop" onPointerDown={props.onClose} />
      <div
        ref={box}
        className="tab-menu icon-palette"
        role="dialog"
        aria-label={label}
        style={{ left: pos.left, top: pos.top }}
      >
        <div className="icon-palette-top">
          <div className="tab-menu-prompt">
            <span aria-hidden="true">&gt;</span>
            <input
              ref={input}
              value={query}
              aria-label={t(locale, 'icons.query')}
              title={t(locale, 'icons.keys')}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => {
                setQuery(e.target.value);
                setIndex(0);
              }}
              onKeyDown={onKey}
            />
          </div>
          <IconButton
            icon={props.kind}
            label={t(locale, 'icons.kind')}
            disabled={props.current === null}
            onClick={() => props.onPick(null)}
          />
        </div>
        <div ref={grid} className="icon-grid" role="listbox" aria-label={label}>
          {shown.map((k, i) => {
            const p = icons[k];
            if (!p) return null;
            const chosen = `${PRESET}${p.id}` === props.current;
            const cls = ['icon-cell'];
            if (i === at) cls.push('is-current');
            if (chosen) cls.push('is-chosen');
            return (
              <div
                key={p.id}
                role="option"
                tabIndex={-1}
                aria-selected={i === at}
                aria-label={iconName(locale, p.id)}
                data-icon={p.id}
                className={cls.join(' ')}
                title={by(p.id)}
                onPointerMove={(e) => {
                  if (moved(e)) setIndex(i);
                }}
                onPointerDown={(e) => {
                  // The query keeps the keys.
                  e.preventDefault();
                  pick(k);
                }}
              >
                <svg viewBox="0 0 512 512" aria-hidden="true">
                  <path d={p.d} />
                </svg>
              </div>
            );
          })}
          {presets && shown.length === 0 && (query.trim() === '' || found?.query === query) ? (
            <div className="tab-menu-empty icon-none">{t(locale, 'icons.none')}</div>
          ) : null}
        </div>
        <div className="icon-palette-footer">
          <span className="icon-palette-by" title={line}>
            {line}
          </span>
        </div>
      </div>
    </>
  );
}
