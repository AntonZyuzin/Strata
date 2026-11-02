import type { NodeKind, PathHit, Resolved } from '@strata/backend';
import { type Locale, t } from '@strata/i18n';
import type { SearchClient } from '@strata/search';
import { type CSSProperties, useCallback, useLayoutEffect, useRef, useState } from 'react';
import { ContextMenu, type MenuEntry } from '../ContextMenu';
import { Icon, nodeIcon } from '../icons/Icon';
import { Glyph } from '../TabBar';
import { MENU_GAP, PathMenu, type PathRow, PathRows } from './PathMenu';
import { escapeSegment, type NamedPath, pathLabel, pathText, samePath } from './paths';

/** The networks `▾` after a network lists (09 §4.3), in their order. */
export interface PathChildren {
  rows: PathRow[];
  /** How many on top are the recently visited. */
  recent: number;
}

/**
 * The path (✅ Q-06-25, 06 §10.2, 09 §4.3): where the canvas is, at its
 * bottom left, from depth 2 — the entry path (05 §9.3), the way one came.
 * The workspace is the tab's icon only — the tab says its name — then every
 * folder and project with its icon, the shortcut by one that lies there as
 * an appearance; a click goes there. The network on the canvas ends the
 * path and is no button. One line: when room runs out the names give way to
 * their icons, each keeps its name as a tooltip.
 *
 * - `▾` after a network: the networks lying in it, the alternatives to the
 *   next segment (`PathMenu`); after the last, when it has any.
 * - The canonical path, when the entry path is another: grey under it, ⌂ by
 *   it; a click takes the canonical way to the same network.
 * - A click on what is no button: the path becomes a field with the
 *   canonical path chosen; `Enter` resolves it in the core (09 §4.4) — one
 *   node goes there, several are a choice, none marks the segment that named
 *   nothing and offers the nearest names; `Esc` gives the path back.
 * - The right button: «Скопировать путь», «Скопировать путь захода» when it
 *   is another, «Скопировать как [[ссылку]]» (09 §4.6), «Ввести путь».
 *
 * The quick marks set follow it, ★ and the digit (06 §10.3, 09 §6.2): a
 * click goes there, the right button clears it; empty slots are not shown.
 */
export function PathBar(props: {
  locale: Locale;
  /** The entry path: from the root to the network on the canvas, `[id, name]`. */
  path: NamedPath;
  /** The canonical path of the network on the canvas, when it is not `path`. */
  canonical?: NamedPath | undefined;
  /** Segment i lies in segment i − 1 as an appearance (05 §5). */
  appearance: readonly boolean[];
  kindOf: (id: string) => NodeKind;
  /** The canonical path of a network on the path, for «Скопировать путь». */
  canonicalOf: (id: string) => NamedPath;
  /** The networks lying in a network, as `▾` lists them: asked when it opens. */
  childrenOf: (id: string) => PathChildren;
  /** Some network lies in this one: the last network gets its `▾`. */
  hasChildren: (id: string) => boolean;
  search: SearchClient;
  /** The properties panel is open: the path keeps left of it. */
  panel: boolean;
  /** Go to the network at the end of `way`, ids from the root: the entry path there. */
  onGo: (way: string[]) => void;
  /** What a typed path names, from the entry path (09 §4.4). */
  resolve: (text: string) => Promise<Resolved>;
  /** Go to a node a typed path named, by the way it went. */
  onHit: (hit: PathHit) => void;
  /** Text for the clipboard (09 §4.6). */
  onCopy: (text: string) => void;
  /** The quick marks' slots: the name of the network each is in, null — empty. */
  marks: readonly (string | null)[];
  onMark: (slot: number) => void;
  onClearMark: (slot: number) => void;
  /** Ask the path to become the field (the palette's «Ввести путь»): a new number each time. */
  editAsked?: number;
}) {
  const { path, locale } = props;
  const nav = useRef<HTMLElement>(null);
  /** `▾` open: after which segment, where its list stands, its rows as they were when it opened. */
  const [menu, setMenu] = useState<{
    at: number;
    left: number;
    room: number;
    kids: PathChildren;
  } | null>(null);
  const [editing, setEditing] = useState(false);
  const [ctx, setCtx] = useState<{ at: number; x: number; y: number } | null>(null);
  const triangles = useRef(new Map<number, HTMLButtonElement>());
  const shown = path.length >= 2;
  const marks = props.marks.flatMap((name, i) => (name === null ? [] : [{ i, name }]));
  const ids = path.map(([id]) => id);
  const last = path.length - 1;

  /** Room over the path in the canvas, and the path's left in it. */
  const room = useCallback(() => {
    const el = nav.current;
    return {
      above: Math.max(0, (el?.offsetTop ?? 0) - 2 * MENU_GAP),
      right: Math.max(
        0,
        (el?.offsetParent?.clientWidth ?? window.innerWidth) - (el?.offsetLeft ?? 0),
      ),
    };
  }, []);

  const openMenu = (at: number) => {
    if (menu?.at === at) {
      setMenu(null);
      return;
    }
    const btn = triangles.current.get(at);
    const left =
      (btn?.getBoundingClientRect().left ?? 0) - (nav.current?.getBoundingClientRect().left ?? 0);
    setEditing(false);
    setMenu({ at, left, room: room().above, kids: props.childrenOf(ids[at] ?? '') });
  };
  const closeMenu = (refocus: boolean) => {
    const at = menu?.at;
    setMenu(null);
    if (refocus && at !== undefined) triangles.current.get(at)?.focus();
  };

  // The palette's «Ввести путь».
  const asked = useRef(props.editAsked);
  useLayoutEffect(() => {
    if (props.editAsked === asked.current) return;
    asked.current = props.editAsked;
    setMenu(null);
    setEditing(true);
  }, [props.editAsked]);

  if (!shown && marks.length === 0 && !editing) return null;

  const copyItems = (at: number): MenuEntry[] => {
    const id = ids[at];
    const name = path[at]?.[1] ?? '';
    if (id === undefined) return [];
    const canonical = props.canonicalOf(id);
    const entry = path.slice(0, at + 1);
    const items: MenuEntry[] = [
      { label: t(locale, 'path.copy'), onSelect: () => props.onCopy(pathText(canonical)) },
    ];
    if (
      !samePath(
        canonical.map(([i]) => i),
        entry.map(([i]) => i),
      )
    ) {
      items.push({
        label: t(locale, 'path.copyEntry'),
        onSelect: () => props.onCopy(pathText(entry)),
      });
    }
    items.push(
      { label: t(locale, 'path.copyLink'), onSelect: () => props.onCopy(`[[${name}]]`) },
      {
        label: t(locale, 'path.type'),
        separated: true,
        onSelect: () => {
          setMenu(null);
          setEditing(true);
        },
      },
    );
    return items;
  };

  const fullPath = pathText(path);
  const triangle = (at: number) => {
    const name = path[at]?.[1] ?? '';
    const label = t(locale, 'path.more', { name });
    const open = menu?.at === at;
    return (
      <button
        type="button"
        className="ws-path-more"
        ref={(el) => {
          if (el) triangles.current.set(at, el);
          else triangles.current.delete(at);
        }}
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => openMenu(at)}
      >
        <Glyph name={open ? 'unfolded' : 'folded'} />
      </button>
    );
  };

  return (
    <nav
      ref={nav}
      className="ws-path"
      data-panel={props.panel ? 'open' : 'closed'}
      aria-label={t(locale, 'ws.path')}
    >
      {editing ? (
        <PathEdit
          locale={locale}
          initial={pathText(props.canonical ?? path)}
          resolve={props.resolve}
          room={room().above}
          onHit={(hit) => {
            setEditing(false);
            props.onHit(hit);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : shown ? (
        <div className="ws-path-box">
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: the keyboard gets the field by the segments' context menu and the palette's «Ввести путь» */}
          <ol
            style={{ '--ancestors': path.length - 2 } as CSSProperties}
            title={t(locale, 'path.title', { path: fullPath })}
            onClick={(e) => {
              // What is no button: the path becomes the field (09 §4.3).
              if ((e.target as Element).closest('button')) return;
              setMenu(null);
              setEditing(true);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              const li = (e.target as Element).closest<HTMLElement>('li[data-at]');
              setMenu(null);
              setCtx({ at: Number(li?.dataset.at ?? last), x: e.clientX, y: e.clientY });
            }}
          >
            {path.map(([id, name], i) => {
              // The workspace has the tab's icon; every folder on the way is open:
              // the canvas is inside it.
              const icon = <Icon name={nodeIcon(props.kindOf(id), {}, i > 0)} />;
              const away = props.appearance[i] ? <Glyph name="shortcut" /> : null;
              if (i === last) {
                const more = props.hasChildren(id);
                return (
                  <li key={id} data-at={i} className="ws-path-here" data-more={more || undefined}>
                    {i > 0 ? triangle(i - 1) : null}
                    <span
                      className="ws-path-step"
                      aria-current="location"
                      data-appearance={props.appearance[i] || undefined}
                    >
                      {icon}
                      {away}
                      <span className="ws-path-name" title={name}>
                        {name}
                      </span>
                    </span>
                    {more ? triangle(i) : null}
                  </li>
                );
              }
              return (
                <li key={id} data-at={i} className={i === 0 ? 'ws-path-root' : undefined}>
                  {i > 0 ? triangle(i - 1) : null}
                  <button
                    type="button"
                    className="ws-path-step"
                    title={name}
                    aria-label={name}
                    data-appearance={props.appearance[i] || undefined}
                    onClick={() => props.onGo(ids.slice(0, i + 1))}
                  >
                    {icon}
                    {away}
                    {i > 0 ? (
                      <span className="ws-path-name" title={name}>
                        {name}
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ol>
          {props.canonical ? (
            <button
              type="button"
              className="ws-path-canonical"
              title={t(locale, 'path.canonical', { path: pathText(props.canonical) })}
              aria-label={t(locale, 'path.canonical', { path: pathText(props.canonical) })}
              onClick={() => props.canonical && props.onGo(props.canonical.map(([i]) => i))}
            >
              <Glyph name="home" />
              <span className="ws-path-name" title={pathText(props.canonical)}>
                {pathText(props.canonical)}
              </span>
            </button>
          ) : null}
        </div>
      ) : null}
      {marks.length > 0 ? (
        <ul className="ws-marks" aria-label={t(locale, 'nav.marks')}>
          {marks.map(({ i, name }) => {
            const label = t(locale, 'nav.mark', { n: i + 1, name });
            return (
              <li key={i}>
                <button
                  type="button"
                  className="ws-mark"
                  title={label}
                  aria-label={label}
                  onClick={() => props.onMark(i)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    props.onClearMark(i);
                  }}
                >
                  <Glyph name="star" />
                  <span>{i + 1}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {menu ? (
        <PathMenu
          locale={locale}
          name={path[menu.at]?.[1] ?? ''}
          rows={menu.kids.rows}
          recent={menu.kids.recent}
          chosen={ids[menu.at + 1]}
          search={props.search}
          left={menu.left}
          room={menu.room}
          right={room().right}
          anchor={triangles.current.get(menu.at)}
          onPick={(id) => {
            setMenu(null);
            props.onGo([...ids.slice(0, menu.at + 1), id]);
          }}
          onClose={closeMenu}
        />
      ) : null}
      {ctx ? (
        <ContextMenu
          x={ctx.x}
          y={ctx.y}
          label={t(locale, 'path.menuLabel')}
          items={copyItems(ctx.at)}
          onClose={() => setCtx(null)}
        />
      ) : null}
    </nav>
  );
}

/**
 * The path as a field (09 §4.3–4.5): the canonical path chosen to be typed
 * over. `Enter` asks the core; the arrows walk a choice or the nearest
 * names, `Enter` or a click takes one — a name offered for a segment that
 * named nothing takes its place and the path is asked again. `Esc` closes
 * the list, then the field; leaving the field gives the path back.
 */
function PathEdit(props: {
  locale: Locale;
  initial: string;
  resolve: (text: string) => Promise<Resolved>;
  /** The room over the path, CSS px. */
  room: number;
  onHit: (hit: PathHit) => void;
  onCancel: () => void;
}) {
  const { locale } = props;
  const [text, setText] = useState(props.initial);
  /** What the last `Enter` found: several to choose from, or a segment that named nothing. */
  const [answer, setAnswer] = useState<
    | { kind: 'choice'; hits: PathHit[] }
    | { kind: 'missing'; at: number; segment: string; near: PathHit[] }
    | null
  >(null);
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const asked = useRef(0);

  useLayoutEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  const ask = (value: string) => {
    const ticket = ++asked.current;
    void props.resolve(value).then((r) => {
      if (ticket !== asked.current) return;
      const [one] = r.found;
      if (one && r.found.length === 1) {
        props.onHit(one);
        return;
      }
      setIndex(0);
      if (r.found.length > 1) {
        setAnswer({ kind: 'choice', hits: r.found });
        return;
      }
      const missing = r.missing;
      if (!missing) return;
      const span = segmentSpans(value)[missing.at];
      setAnswer({
        kind: 'missing',
        at: missing.at,
        segment: span ? value.slice(span.start, span.end) : '',
        near: missing.near,
      });
      // The segment that named nothing, chosen to be typed over.
      if (span) input.current?.setSelectionRange(span.start, span.end);
    });
  };

  const hits = answer?.kind === 'choice' ? answer.hits : (answer?.near ?? []);
  const rows: PathRow[] = hits.map((h) => {
    const [id, name] = h.path.at(-1) ?? ['', ''];
    return {
      id,
      name,
      kind: h.kind,
      appearance: !h.primary,
      detail: pathLabel(h.path.slice(0, -1)),
    };
  });
  const take = (i: number) => {
    const hit = hits[i];
    if (!hit || !answer) return;
    if (answer.kind === 'choice') {
      props.onHit(hit);
      return;
    }
    // A name offered for the segment: in its place, and the path asked again.
    const span = segmentSpans(text)[answer.at];
    const name = hit.path.at(-1)?.[1] ?? '';
    if (!span) return;
    const next = text.slice(0, span.start) + escapeSegment(name) + text.slice(span.end);
    setText(next);
    setAnswer(null);
    ask(next);
  };

  const missing = answer?.kind === 'missing';
  const label = t(locale, 'path.field');
  const said = missing ? t(locale, 'path.missing', { name: answer.segment }) : undefined;
  return (
    <div className="ws-path-box is-editing">
      {answer ? (
        <div className="tab-menu path-menu path-answer" role="dialog" aria-label={label}>
          {rows.length > 0 ? (
            <PathRows
              locale={locale}
              label={said ?? t(locale, 'path.choice')}
              rows={rows}
              index={Math.min(index, rows.length - 1)}
              onIndex={setIndex}
              onPick={take}
              maxHeight={Math.max(0, props.room)}
            />
          ) : (
            <div className="tab-menu-empty" title={said}>
              {said}
            </div>
          )}
        </div>
      ) : null}
      <input
        ref={input}
        className="ws-path-input"
        value={text}
        aria-label={label}
        aria-invalid={missing || undefined}
        title={said ?? `${label} · ${t(locale, 'path.fieldKeys')}`}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => {
          setText(e.target.value);
          setAnswer(null);
          asked.current++;
        }}
        onBlur={props.onCancel}
        onKeyDown={(e) => {
          e.stopPropagation();
          const lastRow = rows.length - 1;
          if (e.key === 'Escape') {
            if (answer) setAnswer(null);
            else props.onCancel();
          } else if (e.key === 'Enter') {
            if (answer && rows.length > 0) take(Math.min(index, lastRow));
            else ask(text);
          } else if (e.key === 'ArrowDown' && answer) setIndex((i) => Math.min(lastRow, i + 1));
          else if (e.key === 'ArrowUp' && answer) setIndex((i) => Math.max(0, i - 1));
          else return;
          e.preventDefault();
        }}
      />
    </div>
  );
}

/**
 * Where each segment of a typed path stands (09 §4.2), as the core reads
 * them (`parse_path`): between `/`, `\/` and `\\` inside a name, the empty
 * ones skipped; each span without the spaces around it.
 */
export function segmentSpans(text: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let start = 0;
  const close = (end: number) => {
    let a = start;
    let b = end;
    while (a < b && /\s/.test(text[a] ?? '')) a++;
    while (b > a && /\s/.test(text[b - 1] ?? '')) b--;
    if (b > a) out.push({ start: a, end: b });
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\' && (text[i + 1] === '/' || text[i + 1] === '\\')) {
      i++;
    } else if (c === '/') {
      close(i);
      start = i + 1;
    }
  }
  close(text.length);
  return out;
}
