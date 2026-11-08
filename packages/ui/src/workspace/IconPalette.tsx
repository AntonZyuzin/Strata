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
import { emojiIn, withoutEmoji } from './emoji';
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

/**
 * A cell of the grid: the icon it gives — one's own or a preset's
 * reference — and the preset; or an emoji of the query, for «Своя иконка».
 */
interface Cell {
  value: string;
  preset?: IconPreset;
  emoji?: string;
}

/** The grid's groups, in their order: each from a row of its own. */
type GroupId = 'emoji' | 'own' | 'presets';

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
  /** One's own icon of an emoji of the query (07 §6.4): drawn by the system's font. */
  onEmoji: (emoji: string) => void;
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

  // The presets are found by the query's words; its emoji are cells of their own.
  const text = useMemo(() => withoutEmoji(query).trim(), [query]);
  useEffect(() => {
    if (text === '') return;
    let live = true;
    void search.rank(text, words.terms, words.terms.length).then((ranked) => {
      if (!live) return;
      const order: number[] = [];
      for (const r of ranked) {
        const k = words.owner[r.index];
        if (k !== undefined && !order.includes(k)) order.push(k);
      }
      setFound({ query: text, order });
    });
    return () => {
      live = false;
    };
  }, [text, search, words]);

  const shown = useMemo(() => {
    if (query.trim() === '') return icons.map((_, k) => k);
    // Only emoji asked for: no presets under them.
    if (text === '') return [];
    return found?.query === text ? found.order : [];
  }, [query, text, found, icons]);

  // One's own icons have no words: a query finds presets only, and the
  // emoji it holds (07 §6.4).
  const own = query.trim() === '' ? props.own : NONE;
  const emoji = useMemo(() => emojiIn(query), [query]);
  const groups = useMemo(() => {
    const out: { id: GroupId; cells: Cell[] }[] = [];
    if (emoji.length > 0) {
      out.push({ id: 'emoji', cells: emoji.map((e) => ({ value: `emoji:${e}`, emoji: e })) });
    }
    if (own.length > 0) out.push({ id: 'own', cells: own.map((value) => ({ value })) });
    const presets: Cell[] = [];
    for (const k of shown) {
      const preset = icons[k];
      if (preset) presets.push({ value: `${PRESET}${preset.id}`, preset });
    }
    if (presets.length > 0) out.push({ id: 'presets', cells: presets });
    return out;
  }, [emoji, own, shown, icons]);
  const cells = useMemo(() => groups.flatMap((g) => g.cells), [groups]);

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
  /** What a cell says: a preset's name and author, one's own icon's style, an emoji. */
  const lineOf = (c: Cell) => {
    if (c.emoji) return t(locale, 'icons.emojiCell', { emoji: c.emoji });
    if (c.preset) {
      const id = c.preset.id;
      return t(locale, 'icons.by', { name: iconName(locale, id), author: authorOf(id) });
    }
    const mode = parseOwnIcon(c.value)?.style.mode ?? 'engraving';
    return t(locale, 'icons.ownIcon', { mode: t(locale, `own.mode.${mode}`) });
  };
  const current = cells[at];
  const line = current ? lineOf(current) : '';
  const sizes = groups.map((g) => g.cells.length);
  /** A cell given: an icon to the nodes, or an emoji into «Своя иконка». */
  const pick = (c: Cell, forKind: boolean) => {
    if (c.emoji) props.onEmoji(c.emoji);
    else props.onPick(c.value, forKind);
  };

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
        go(rowMove(sizes, at, 1));
        break;
      case 'ArrowUp':
        go(rowMove(sizes, at, -1));
        break;
      case 'PageDown':
        go(rowMove(sizes, at, PAGE));
        break;
      case 'PageUp':
        go(rowMove(sizes, at, -PAGE));
        break;
      case 'Enter':
        if (current) pick(current, e.ctrlKey || e.metaKey);
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
        data-own={c.preset || c.emoji ? undefined : c.value}
        data-emoji={c.emoji}
        className={cls.join(' ')}
        title={says}
        onPointerMove={(e) => {
          if (moved(e)) setKey(c.value);
        }}
        onPointerDown={(e) => {
          // The query keeps the keys.
          e.preventDefault();
          pick(c, e.ctrlKey || e.metaKey);
        }}
      >
        {c.emoji ? (
          <span className="icon-emoji" aria-hidden="true">
            {c.emoji}
          </span>
        ) : c.preset ? (
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
          {groups.length > 1 ? (
            // The groups under their names; one group needs none (owner, 2026-10-24).
            groups.map((g, k) => {
              const from = sizes.slice(0, k).reduce((a, b) => a + b, 0);
              return (
                <fieldset key={g.id} className="icon-group" data-group={g.id}>
                  <legend className="icon-group-name">{t(locale, `icons.group.${g.id}`)}</legend>
                  <div className="icon-cells">{g.cells.map((c, i) => cellView(c, from + i))}</div>
                </fieldset>
              );
            })
          ) : (
            <div className="icon-cells">{cells.map((c, i) => cellView(c, i))}</div>
          )}
          {presets && cells.length === 0 && (query.trim() === '' || found?.query === text) ? (
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
