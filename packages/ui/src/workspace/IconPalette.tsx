import type { NodeSize } from '@strata/backend';
import type { IconAuthor, IconPreset } from '@strata/canvas';
import { iconName, iconTerms, type Locale, t } from '@strata/i18n';
import {
  type CSSProperties,
  type DragEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { IconName } from '../icons/Icon';
import { pointerMoved } from '../pointer';
import type { MenuSearch } from '../proto/menu';
import { IconButton } from '../TabBar';
import { rowMove } from './iconGrid';
import { carriesPicture, droppedPicture, OWN_ICON, parseOwnIcon } from './ownIcons';

/** CSS px between the window and the canvas's edges. */
const MARGIN = 8;
/** Rows `PgUp` / `PgDn` move by. */
const PAGE = 4;

/** The prefix of a preset reference in a node's `icon` (05 §4.1 `IconRef`). */
export const PRESET = 'game-icons/';

/** The size row, smallest first; null — by the rules (06 §4.2). */
const SIZES: readonly (NodeSize | null)[] = [null, 's', 'm', 'l', 'xl'];

const NONE: readonly string[] = [];

/** A cell of the grid: the icon it gives — one's own or a preset's reference — and the preset. */
interface Cell {
  value: string;
  preset?: IconPreset;
}

/**
 * The icon and size palette `Z` (06 §2, 07 §6.3, ☑ Q-07-21): the presets
 * that ship, found by their words in either language; the author of the one
 * under the keys or the cursor on the window's last line («© Lorc, CC BY
 * 3.0»). `Enter` or a click gives it to the nodes; the kind's icon beside the
 * query («Значок вида») takes a chosen one back. Under the query, the
 * bubbles' size in this network (06 §4.2): «Авто» by the rules, or S, M, L,
 * XL by hand. One step of undo for each choice. «Своя иконка…» beside it
 * (07 §6.4): a picture from the disk, or the style of the one the node has;
 * a picture dropped on the palette does the same. With the query empty, the
 * workspace's own icons come first, the group «Свои» (07 §6.5). Opens at the
 * cursor, kept inside the canvas; the Tab menu's window, its width in `ch`.
 */
export function IconPalette(props: {
  locale: Locale;
  /** The presets and their authors; null until they load. */
  presets: { authors: Record<string, IconAuthor>; icons: readonly IconPreset[] } | null;
  /** One's own icons of the workspace, the most used first (07 §6.5). */
  own: readonly string[];
  /** An own icon's mask as a picture whose alpha is the ink. */
  ownMask: (ref: string) => Promise<string>;
  /** The node's `icon` now (a preset's or one's own reference, or none — its kind's icon). */
  current: string | null;
  /** The kind's icon of the workspace (05 §4.1): what the node shows with none of its own. */
  kindIcon: string | null;
  /** The kind's icon of the first of the nodes: the button that takes a preset back shows it. */
  kind: IconName;
  /** The first node's size in this network, set by hand; null — by the rules. */
  size: NodeSize | null;
  x: number;
  y: number;
  bounds?: DOMRect | undefined;
  search: Pick<MenuSearch, 'rank'>;
  /**
   * An icon — a preset's or one's own reference — or null, back to the
   * kind's; `forKind` (`Ctrl`): the kind's icon of the workspace (05 §4.1).
   */
  onPick: (icon: string | null, forKind: boolean) => void;
  /** A size by hand, or null — back to the rules. */
  onSize: (size: NodeSize | null) => void;
  /** One's own icon: a picture from the disk, or null — restyle the one the node has. */
  onOwn: (file: File | null) => void;
  onClose: () => void;
}) {
  const { locale, presets, search } = props;
  const icons = presets?.icons ?? [];
  const [query, setQuery] = useState('');
  /** Preset indices the query finds, best first; null — every preset, in order. */
  const [found, setFound] = useState<{ query: string; order: number[] } | null>(null);
  /** The cell under the keys, by the icon it gives; none found — the first. */
  const [key, setKey] = useState<string | null>(props.current ?? props.kindIcon);
  /** The own icons' masks, by reference, as they come. */
  const [masks, setMasks] = useState<Readonly<Record<string, string>>>({});
  /** A picture is dragged over the palette. */
  const [dropping, setDropping] = useState(false);
  const [moved] = useState(pointerMoved);
  const input = useRef<HTMLInputElement>(null);
  const file = useRef<HTMLInputElement>(null);
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

  // One's own icons have no words: a query finds presets only.
  const own = query.trim() === '' ? props.own : NONE;
  const cells = useMemo<Cell[]>(() => {
    const out: Cell[] = own.map((value) => ({ value }));
    for (const k of shown) {
      const preset = icons[k];
      if (preset) out.push({ value: `${PRESET}${preset.id}`, preset });
    }
    return out;
  }, [own, shown, icons]);

  const { ownMask } = props;
  useEffect(() => {
    let live = true;
    for (const ref of props.own) {
      ownMask(ref).then(
        (url) => {
          if (live) setMasks((m) => (m[ref] === url ? m : { ...m, [ref]: url }));
        },
        // A picture that would not decode leaves its cell blank paper.
        () => undefined,
      );
    }
    return () => {
      live = false;
    };
  }, [props.own, ownMask]);

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
  }, [props.x, props.y, cells.length > 0]);

  // The node's own icon is under the keys when the palette opens, once it is listed.
  const at = Math.max(0, key === null ? 0 : cells.findIndex((c) => c.value === key));
  // biome-ignore lint/correctness/useExhaustiveDependencies: `at` — the cell moved
  useEffect(() => {
    grid.current?.querySelector('.is-current')?.scrollIntoView({ block: 'nearest' });
  }, [at]);

  const authorOf = (id: string) => presets?.authors[id.split('/')[0] ?? '']?.name ?? '';
  /** What a cell says: a preset's name and author, or one's own icon's style. */
  const lineOf = (c: Cell) => {
    if (c.preset) {
      const id = c.preset.id;
      return t(locale, 'icons.by', { name: iconName(locale, id), author: authorOf(id) });
    }
    const mode = parseOwnIcon(c.value)?.style.mode ?? 'engraving';
    return t(locale, 'icons.ownIcon', { mode: t(locale, `own.mode.${mode}`) });
  };
  const current = cells[at];
  const line = current ? lineOf(current) : '';
  const groups = own.length > 0 ? [own.length, cells.length - own.length] : [cells.length];

  const onKey = (e: React.KeyboardEvent) => {
    const go = (i: number) => {
      const c = cells[Math.max(0, Math.min(cells.length - 1, i))];
      if (c) setKey(c.value);
    };
    switch (e.key) {
      case 'ArrowRight':
        go(at + 1);
        break;
      case 'ArrowLeft':
        go(at - 1);
        break;
      case 'ArrowDown':
        go(rowMove(groups, at, 1));
        break;
      case 'ArrowUp':
        go(rowMove(groups, at, -1));
        break;
      case 'PageDown':
        go(rowMove(groups, at, PAGE));
        break;
      case 'PageUp':
        go(rowMove(groups, at, -PAGE));
        break;
      case 'Enter':
        if (current) props.onPick(current.value, e.ctrlKey || e.metaKey);
        break;
      case 'Escape':
        props.onClose();
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  // A picture dropped on the palette is «Своя иконка…» with it (07 §6.4).
  const dragOver = (e: DragEvent) => {
    if (!carriesPicture(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    setDropping(true);
  };

  const cellView = (c: Cell, i: number) => {
    const cls = ['icon-cell'];
    if (i === at) cls.push('is-current');
    // What the node shows: its own icon, or its kind's.
    if (c.value === (props.current ?? props.kindIcon)) cls.push('is-chosen');
    const says = lineOf(c);
    const mask = masks[c.value];
    return (
      <div
        key={c.value}
        role="option"
        tabIndex={-1}
        aria-selected={i === at}
        aria-label={c.preset ? iconName(locale, c.preset.id) : says}
        data-icon={c.preset?.id}
        data-own={c.preset ? undefined : c.value}
        className={cls.join(' ')}
        title={says}
        onPointerMove={(e) => {
          if (moved(e)) setKey(c.value);
        }}
        onPointerDown={(e) => {
          // The query keeps the keys.
          e.preventDefault();
          props.onPick(c.value, e.ctrlKey || e.metaKey);
        }}
      >
        {c.preset ? (
          <svg viewBox="0 0 512 512" aria-hidden="true">
            <path d={c.preset.d} />
          </svg>
        ) : (
          <span
            className="icon-own-mask"
            style={mask ? ({ '--glyph': `url("${mask}")` } as CSSProperties) : undefined}
            aria-hidden="true"
          />
        )}
      </div>
    );
  };

  const label = t(locale, 'icons.label');
  const hasOwn = props.current?.startsWith(OWN_ICON) === true;
  return (
    <>
      <div className="menu-backdrop" onPointerDown={props.onClose} />
      <div
        ref={box}
        className={dropping ? 'tab-menu icon-palette is-dropping' : 'tab-menu icon-palette'}
        role="dialog"
        aria-label={label}
        style={{ left: pos.left, top: pos.top }}
        onDragEnter={dragOver}
        onDragOver={dragOver}
        onDragLeave={(e) => {
          const to = e.relatedTarget;
          if (!(to instanceof Node && box.current?.contains(to))) setDropping(false);
        }}
        onDrop={(e) => {
          setDropping(false);
          const file = droppedPicture(e.dataTransfer);
          if (!file) return;
          e.preventDefault();
          e.stopPropagation();
          props.onOwn(file);
        }}
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
                setKey(null);
              }}
              onKeyDown={onKey}
            />
          </div>
          <IconButton
            icon={props.kind}
            label={t(locale, 'icons.kind')}
            title={t(locale, 'icons.kindHint')}
            disabled={props.current === null && props.kindIcon === null}
            onClick={(e) => props.onPick(null, e.ctrlKey || e.metaKey)}
          />
          <IconButton
            icon="filetype-image"
            className="icon-own"
            label={t(locale, 'icons.own')}
            title={t(locale, 'icons.ownHint')}
            pressed={hasOwn}
            onClick={() => (hasOwn ? props.onOwn(null) : file.current?.click())}
          />
          <input
            ref={file}
            className="sr-only"
            type="file"
            accept="image/*"
            tabIndex={-1}
            // The button beside it is the control; this one only opens the chooser.
            aria-hidden="true"
            onChange={(e) => {
              const f = e.currentTarget.files?.[0];
              e.currentTarget.value = '';
              if (f) props.onOwn(f);
            }}
          />
        </div>
        <div className="icon-size" title={t(locale, 'icons.sizeHint')}>
          <span className="icon-size-label" aria-hidden="true">
            {t(locale, 'icons.size')}
          </span>
          <fieldset className="icon-size-choices">
            <legend className="sr-only">{t(locale, 'icons.size')}</legend>
            {SIZES.map((s) => (
              <button
                key={s ?? 'auto'}
                type="button"
                className={s ? 'icon-size-choice' : 'icon-size-choice is-auto'}
                aria-pressed={props.size === s}
                title={t(locale, s ? `icons.size.${s}` : 'icons.size.autoHint')}
                onClick={() => props.onSize(s)}
              >
                {s ? s.toUpperCase() : t(locale, 'icons.size.auto')}
              </button>
            ))}
          </fieldset>
        </div>
        <div ref={grid} className="icon-grid" role="listbox" aria-label={t(locale, 'icons.grid')}>
          {own.length > 0 ? (
            // Two groups under their names; one group needs none (owner, 2026-10-24).
            <>
              <fieldset className="icon-group">
                <legend className="icon-group-name">{t(locale, 'icons.group.own')}</legend>
                <div className="icon-cells">
                  {cells.slice(0, own.length).map((c, i) => cellView(c, i))}
                </div>
              </fieldset>
              <fieldset className="icon-group">
                <legend className="icon-group-name">{t(locale, 'icons.group.presets')}</legend>
                <div className="icon-cells">
                  {cells.slice(own.length).map((c, i) => cellView(c, own.length + i))}
                </div>
              </fieldset>
            </>
          ) : (
            <div className="icon-cells">{cells.map((c, i) => cellView(c, i))}</div>
          )}
          {presets && cells.length === 0 && (query.trim() === '' || found?.query === query) ? (
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
