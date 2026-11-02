import type { NodeKind } from '@strata/backend';
import { type Locale, t } from '@strata/i18n';
import type { SearchClient } from '@strata/search';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Icon, nodeIcon } from '../icons/Icon';
import { pointerMoved } from '../pointer';
import { Glyph } from '../TabBar';

/** A row of the path's lists: a network under `▾`, a node a typed path named. */
export interface PathRow {
  id: string;
  name: string;
  kind: NodeKind;
  /** It lies there as an appearance (05 §5): the shortcut by its icon. */
  appearance: boolean;
  /** Where it lies, when the list mixes networks: grey on the right. */
  detail?: string;
}

/** The rows of a list over the path (07 §8.2): the icon, the name, where. */
export function PathRows(props: {
  locale: Locale;
  label: string;
  rows: readonly PathRow[];
  /** A line under this many rows: the recent ones above it (09 §4.3). */
  recent?: number;
  index: number;
  /** The row of the network next on the path: where one is now. */
  chosen?: string | undefined;
  onIndex: (i: number) => void;
  onPick: (i: number) => void;
  /** The list's highest, CSS px: the room it has; thirty rows at most (09 §4.3). */
  maxHeight: number;
}) {
  const { locale, rows } = props;
  const [moved] = useState(pointerMoved);
  const list = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `index` — the row moved
  useEffect(() => {
    list.current?.querySelector('.is-current')?.scrollIntoView({ block: 'nearest' });
  }, [props.index]);

  return (
    <div
      ref={list}
      className="tab-menu-list path-rows"
      role="listbox"
      aria-label={props.label}
      style={{ maxHeight: `min(calc(30 * var(--st-size-row)), ${props.maxHeight}px)` }}
    >
      {rows.map((r, i) => {
        const name = r.name || t(locale, 'note.untitled');
        const cls = ['tab-menu-row'];
        if (i === props.index) cls.push('is-current');
        if (r.id === props.chosen) cls.push('is-chosen');
        if (props.recent !== undefined && i === props.recent && i > 0) cls.push('is-separated');
        const title = r.detail ? `${name} — ${r.detail}` : name;
        return (
          <div
            key={r.id}
            role="option"
            tabIndex={-1}
            aria-selected={i === props.index}
            aria-current={r.id === props.chosen ? 'location' : undefined}
            className={cls.join(' ')}
            title={title}
            onPointerMove={(e) => {
              if (moved(e)) props.onIndex(i);
            }}
            onPointerDown={(e) => {
              // The prompt keeps the keys.
              e.preventDefault();
              props.onPick(i);
            }}
          >
            <Icon name={nodeIcon(r.kind)} />
            {r.appearance ? <Glyph name="shortcut" /> : null}
            <span className="tab-menu-label">{name}</span>
            {r.detail ? <span className="tab-menu-detail path-rows-detail">{r.detail}</span> : null}
          </div>
        );
      })}
    </div>
  );
}

/** CSS px between a list and the canvas's top, and over the path. */
export const MENU_GAP = 4;

/**
 * `▾` after a network on the path (09 §4.3): the networks lying in it, the
 * alternatives to the next segment — the recently visited first, then by
 * name; the one on the path marked. Typing filters by the search engine's
 * ranking (09 §2.3); the arrows walk, `Enter` or a click goes there, `Esc`
 * or a press outside closes. It opens over the path at its triangle, as
 * high as the canvas lets it, thirty rows at most, the rest scrolled.
 */
export function PathMenu(props: {
  locale: Locale;
  /** The network whose networks these are. */
  name: string;
  rows: readonly PathRow[];
  recent: number;
  chosen?: string | undefined;
  search: SearchClient;
  /** Its left edge in the path's box, CSS px. */
  left: number;
  /** The room over the path, CSS px. */
  room: number;
  /** The room right of the path's left edge, CSS px: the list stays inside the canvas. */
  right: number;
  onPick: (id: string) => void;
  /** Its triangle: a press there is the triangle's own, it toggles the list. */
  anchor?: HTMLElement | undefined;
  /** `byKey`: `Esc` closed it, the keyboard goes back to its triangle. */
  onClose: (byKey: boolean) => void;
}) {
  const { locale, rows, search } = props;
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<{ q: string; rows: PathRow[] } | null>(null);
  const [index, setIndex] = useState(() =>
    Math.max(
      0,
      rows.findIndex((r) => r.id === props.chosen),
    ),
  );
  const box = useRef<HTMLDivElement>(null);
  const prompt = useRef<HTMLDivElement>(null);
  const names = useMemo(() => rows.map((r) => r.name), [rows]);
  const { onClose, anchor } = props;

  useEffect(() => {
    const q = query.trim();
    if (q === '') return;
    let live = true;
    void search.rank(q, names, names.length).then((ranked) => {
      if (!live) return;
      setFound({ q: query, rows: ranked.flatMap((r) => rows[r.index] ?? []) });
      setIndex(0);
    });
    return () => {
      live = false;
    };
  }, [search, query, names, rows]);

  // A press anywhere else closes it, the path's other buttons too.
  useEffect(() => {
    const away = (e: PointerEvent) => {
      const at = e.target as Node;
      if (!box.current?.contains(at) && !anchor?.contains(at)) onClose(false);
    };
    window.addEventListener('pointerdown', away, true);
    return () => window.removeEventListener('pointerdown', away, true);
  }, [onClose, anchor]);

  const filtered = query.trim() !== '';
  // The last answer stays until the next comes: the list does not blink.
  const shown = filtered ? (found?.rows ?? rows) : rows;
  // At its triangle, kept inside the canvas; the rows get what the prompt
  // and the frame leave of the room over the path.
  const [left, setLeft] = useState(props.left);
  const [rowsRoom, setRowsRoom] = useState(props.room);
  useLayoutEffect(() => {
    const w = box.current?.offsetWidth ?? 0;
    setLeft(Math.max(0, Math.min(props.left, props.right - w - MENU_GAP)));
    const frame = box.current ? box.current.offsetHeight - box.current.clientHeight : 0;
    setRowsRoom(Math.max(0, props.room - (prompt.current?.offsetHeight ?? 0) - frame));
  }, [props.left, props.right, props.room]);

  const pick = (i: number) => {
    const r = shown[i];
    if (r) props.onPick(r.id);
  };
  const label = t(locale, 'path.more', { name: props.name });
  return (
    <div ref={box} className="tab-menu path-menu" role="dialog" aria-label={label} style={{ left }}>
      {filtered && found?.q === query && shown.length === 0 ? (
        <div className="tab-menu-empty">{t(locale, 'path.nothing', { q: query })}</div>
      ) : (
        <PathRows
          locale={locale}
          label={label}
          rows={shown}
          {...(filtered ? {} : { recent: props.recent })}
          index={Math.min(index, shown.length - 1)}
          chosen={props.chosen}
          onIndex={setIndex}
          onPick={pick}
          maxHeight={rowsRoom}
        />
      )}
      <div ref={prompt} className="tab-menu-prompt">
        <span aria-hidden="true">&gt;</span>
        <input
          value={query}
          aria-label={label}
          title={`${label} · ${t(locale, 'path.menuKeys')}`}
          spellCheck={false}
          autoComplete="off"
          // biome-ignore lint/a11y/noAutofocus: the list opens on its triangle to be typed into
          autoFocus
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            const last = shown.length - 1;
            if (e.key === 'Escape') onClose(true);
            else if (e.key === 'Enter') pick(Math.min(index, last));
            else if (e.key === 'ArrowDown') setIndex((i) => Math.min(last, i + 1));
            else if (e.key === 'ArrowUp') setIndex((i) => Math.max(0, i - 1));
            else if (e.key === 'PageDown') setIndex((i) => Math.min(last, i + 10));
            else if (e.key === 'PageUp') setIndex((i) => Math.max(0, i - 10));
            else return;
            e.preventDefault();
          }}
        />
      </div>
    </div>
  );
}
