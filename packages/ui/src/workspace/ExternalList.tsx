import type { ExternalWire } from '@strata/backend';
import { glyphUrl } from '@strata/design-tokens';
import { type Locale, t } from '@strata/i18n';
import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from '../icons/Icon';
import { pointerMoved } from '../pointer';
import { Glyph } from '../TabBar';
import { pathLabel } from './paths';

/** CSS px between the window and the canvas's edges. */
const MARGIN = 8;
/** «Показать все здесь» asks first past this many nodes (06 §14). */
const ASK_PAST = 10;

/** The other ends one may show here, each once, in the list's order. */
export function showable(
  wires: readonly ExternalWire[],
  cycle: ReadonlySet<string>,
): ExternalWire[] {
  const seen = new Set<string>();
  return wires.filter((w) => !cycle.has(w.id) && !seen.has(w.id) && seen.add(w.id));
}

/**
 * The list behind «↗N» (05 §8.3, 06 §14): the node's wires whose other end
 * is not placed in this network, inputs first. A row is which way the wire
 * goes, the other end with its kind and path, and where the wire comes
 * from; a click or `Enter` goes to that node (09 §3.4), its shortcut button
 * or `Alt+Enter` shows it here — an appearance beside the node (05 §5).
 * «Показать все здесь» asks first past ten nodes. Opens by the mark, kept
 * inside the canvas; the Tab menu's window, its width in `ch`.
 */
export function ExternalList(props: {
  locale: Locale;
  /** The node whose wires these are. */
  name: string;
  /** Null until the core answers. */
  wires: readonly ExternalWire[] | null;
  /** Other ends this network may not hold, by the core's `placeable` (05 §5 rule 4). */
  cycle: ReadonlySet<string>;
  /** Its left edge beside the mark, page px. */
  x: number;
  y: number;
  /** Its right edge when there is no room beside the mark: left of the bubble. */
  flipX: number;
  bounds?: DOMRect | undefined;
  onGo: (id: string) => void;
  /** «Показать здесь»: appearances of these other ends beside the node. */
  onShow: (ends: readonly ExternalWire[]) => void;
  onClose: () => void;
}) {
  const { locale, wires } = props;
  const [index, setIndex] = useState(0);
  /** «Показать все здесь» past ten nodes: the question instead of the button. */
  const [asking, setAsking] = useState(false);
  const [moved] = useState(pointerMoved);
  const [pos, setPos] = useState({ left: props.x, top: props.y });
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const rows = wires ?? [];

  useEffect(() => {
    list.current?.focus();
  }, []);

  // Beside the mark; with no room there, left of the bubble; clamped into
  // the canvas one sees when neither side has room.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the height changes with the rows
  useLayoutEffect(() => {
    const h = box.current?.offsetHeight ?? 0;
    const w = box.current?.offsetWidth ?? 0;
    const b = props.bounds;
    const left = (b?.left ?? 0) + MARGIN;
    const top = (b?.top ?? 0) + MARGIN;
    const right = (b?.right ?? window.innerWidth) - MARGIN;
    const bottom = (b?.bottom ?? window.innerHeight) - MARGIN;
    const x =
      props.x + w <= right ? props.x : props.flipX - w >= left ? props.flipX - w : right - w;
    setPos({
      left: Math.max(left, x),
      top: Math.max(top, Math.min(props.y, bottom - h)),
    });
  }, [props.x, props.y, props.flipX, rows.length, asking]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `index` — the row moved
  useEffect(() => {
    list.current?.querySelector('.is-current')?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  const go = (i: number) => {
    const w = rows[i];
    if (w) props.onGo(w.id);
  };
  const placeable = (w: ExternalWire) => !props.cycle.has(w.id);
  const show = (i: number) => {
    const w = rows[i];
    if (w && placeable(w)) props.onShow([w]);
  };
  const all = showable(rows, props.cycle);
  const showAll = () => {
    if (all.length > ASK_PAST && !asking) setAsking(true);
    else props.onShow(all);
  };
  const label = t(locale, 'ext.label', { name: props.name });
  return (
    <>
      <div className="menu-backdrop" onPointerDown={props.onClose} />
      <div
        ref={box}
        className="tab-menu ext-list"
        role="dialog"
        aria-label={label}
        style={{ left: pos.left, top: pos.top }}
      >
        <div className="tab-menu-header" aria-hidden="true">
          {t(locale, 'ext.title')}
        </div>
        <div
          ref={list}
          className="tab-menu-list"
          role="listbox"
          aria-label={label}
          title={t(locale, 'ext.keys')}
          tabIndex={0}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Escape') props.onClose();
            else if (e.key === 'Enter' && e.altKey) show(index);
            else if (e.key === 'Enter') go(index);
            else if (e.key === 'ArrowDown') setIndex((i) => Math.min(rows.length - 1, i + 1));
            else if (e.key === 'ArrowUp') setIndex((i) => Math.max(0, i - 1));
            else return;
            e.preventDefault();
          }}
        >
          {wires && rows.length === 0 ? (
            <div className="tab-menu-empty">{t(locale, 'ext.none')}</div>
          ) : null}
          {rows.map((w, i) => {
            const name = w.name || t(locale, 'note.untitled');
            const path = pathLabel(w.path);
            const origin = t(locale, w.manual || !w.text ? 'ext.manual' : 'ext.text');
            return (
              <div
                key={`${w.incoming ? 'in' : 'out'}:${w.id}`}
                role="option"
                tabIndex={-1}
                aria-selected={i === index}
                className={i === index ? 'tab-menu-row is-current' : 'tab-menu-row'}
                title={t(locale, 'ext.go', { name })}
                onPointerMove={(e) => {
                  if (moved(e)) setIndex(i);
                }}
                onPointerDown={(e) => {
                  e.preventDefault();
                  go(i);
                }}
              >
                <span
                  className="ext-way"
                  title={t(locale, w.incoming ? 'ext.in' : 'ext.out', { name: props.name })}
                >
                  {/* «← Арт» — from it; «→ Палитра» — to it. */}
                  <Icon name={w.incoming ? 'go-back' : 'go-forward'} />
                </span>
                <span
                  className="kind-icon"
                  style={{ '--glyph': glyphUrl(w.kind) } as CSSProperties}
                  aria-hidden="true"
                />
                <span className="tab-menu-label" title={name}>
                  {name}
                </span>
                <span className="tab-menu-detail ext-path" title={path}>
                  {path}
                </span>
                <span className="tab-menu-detail ext-origin" title={origin}>
                  {origin}
                </span>
                <button
                  type="button"
                  className="ext-show"
                  tabIndex={-1}
                  disabled={!placeable(w)}
                  aria-label={t(locale, placeable(w) ? 'ext.show' : 'ext.cannot', { name })}
                  title={t(locale, placeable(w) ? 'ext.show' : 'ext.cannot', { name })}
                  onPointerDown={(e) => {
                    // The row's own press goes there; this one shows it here.
                    e.stopPropagation();
                    e.preventDefault();
                    show(i);
                  }}
                >
                  <Glyph name="shortcut" />
                </button>
              </div>
            );
          })}
        </div>
        {all.length > 1 ? (
          <div className="ext-footer">
            {asking ? (
              <>
                <span className="ext-ask" title={t(locale, 'ext.ask', { n: all.length })}>
                  {t(locale, 'ext.ask', { n: all.length })}
                </span>
                <button
                  type="button"
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={() => setAsking(false)}
                >
                  {t(locale, 'ext.cancel')}
                </button>
                <button
                  type="button"
                  className="is-default"
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={showAll}
                >
                  {t(locale, 'ext.confirm')}
                </button>
              </>
            ) : (
              <button type="button" onPointerDown={(e) => e.preventDefault()} onClick={showAll}>
                {t(locale, 'ext.showAll')}
              </button>
            )}
          </div>
        ) : null}
      </div>
    </>
  );
}
