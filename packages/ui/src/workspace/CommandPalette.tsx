import { type Locale, type MessageKey, t } from '@strata/i18n';
import type { SearchClient } from '@strata/search';
import { useEffect, useMemo, useRef, useState } from 'react';
import { pointerMoved } from '../pointer';
import {
  COMMANDS,
  type Command,
  type CommandContext,
  type CommandGroup,
  commandNames,
  rankedCommands,
  titleOf,
  whyNot,
} from './commands';
import { pathQuery } from './NodeSearch';

const ROWS = 12;
/** Recent commands on top of an empty query (09 §3.5). */
const RECENT = 5;
const RECENT_KEY = 'strata.palette.recent';
/** «Все команды» on or off, kept on the device (05 §13). */
const ALL_KEY = 'strata.palette.all';
const GROUPS: readonly CommandGroup[] = ['node', 'canvas', 'nav', 'app'];

function loadAll(): boolean {
  try {
    return localStorage.getItem(ALL_KEY) === '1';
  } catch {
    return false;
  }
}

function saveAll(on: boolean): void {
  try {
    localStorage.setItem(ALL_KEY, on ? '1' : '0');
  } catch {
    // A convenience too: the choice lasts for the session.
  }
}

function loadRecent(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function remember(id: string): void {
  try {
    const next = [id, ...loadRecent().filter((x) => x !== id)].slice(0, RECENT);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Recent commands are a convenience; private windows may refuse storage.
  }
}

interface Row {
  command: Command;
  header: MessageKey | null;
  /** Why it cannot run now (shown under «Все команды»): grey, the reason in its tooltip. */
  why: MessageKey | null;
}

/**
 * The command palette, `Ctrl+P` (09 §3.5): the Tab menu's window, its width in
 * `ch` whatever the language. With no query — the recent five, then every
 * command that can run now by its group; with a query — the search engine's
 * ranking of the titles in both languages and the aliases. A row is the
 * title and its key; `Enter` typed before the engine's answer runs once it
 * comes. «Все команды» shows the ones that cannot run now too, grey, the
 * reason in the row's tooltip. A query that starts as a path (`/`, `./`,
 * `../`) goes on in `Ctrl+O`'s path mode; `?` opens «Клавиши».
 */
export function CommandPalette(props: {
  locale: Locale;
  search: SearchClient;
  context: CommandContext;
  left: number;
  top: number;
  onRun: (command: Command) => void;
  /** The query became a path: `Ctrl+O` takes it on. */
  onPath: (query: string) => void;
  /** `?`: «Клавиши». */
  onHelp: () => void;
  onClose: () => void;
}) {
  const { locale, search, context } = props;
  const [query, setQuery] = useState('');
  const [all, setAll] = useState(loadAll);
  const [index, setIndex] = useState(0);
  const [moved] = useState(pointerMoved);
  const [found, setFound] = useState<{ q: string; commands: Command[] } | null>(null);
  const [waiting, setWaiting] = useState(false);
  const names = useMemo(() => commandNames(), []);
  const list = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const q = query.trim();
    if (q === '') return;
    let live = true;
    void search.rank(q, names.names, names.names.length).then((ranked) => {
      if (live) setFound({ q: query, commands: rankedCommands(ranked, names.of) });
    });
    return () => {
      live = false;
    };
  }, [search, query, names]);

  const rows: Row[] = useMemo(() => {
    const can = (c: Command) => whyNot(c, context) === null;
    const shown = (c: Command) => all || can(c);
    const row = (command: Command, header: MessageKey | null): Row => ({
      command,
      header,
      why: whyNot(command, context),
    });
    if (query.trim() === '') {
      // The recent ones that can run; the rest in their groups, in order.
      const recent = loadRecent()
        .flatMap((id) => COMMANDS.filter((c) => c.id === id))
        .filter(can);
      const out: Row[] = recent.map((command, i) => row(command, i === 0 ? 'cmd.recent' : null));
      for (const g of GROUPS) {
        const list = COMMANDS.filter((c) => c.group === g && shown(c) && !recent.includes(c));
        list.forEach((command, i) => {
          out.push(row(command, i === 0 ? (`cmd.group.${g}` as MessageKey) : null));
        });
      }
      return out;
    }
    if (found?.q !== query) return [];
    return found.commands
      .filter(shown)
      .slice(0, ROWS)
      .map((command) => row(command, null));
  }, [query, found, context, all]);

  const ready = query.trim() === '' || found?.q === query;
  const { onRun } = props;
  const run = (i: number) => {
    if (!ready) {
      setWaiting(true);
      return;
    }
    const r = rows[i];
    // A grey row says why in its tooltip; it does not run.
    if (!r || r.why) return;
    remember(r.command.id);
    onRun(r.command);
  };
  const first = rows[Math.min(index, rows.length - 1)];
  useEffect(() => {
    if (!waiting || !ready) return;
    setWaiting(false);
    if (!first || first.why) return;
    remember(first.command.id);
    onRun(first.command);
  }, [waiting, ready, first, onRun]);

  // The current row stays in view as the arrows walk a long list.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `index` — the row moved
  useEffect(() => {
    list.current?.querySelector('.is-current')?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  const label = t(locale, 'cmd.title');
  return (
    <>
      <div className="menu-backdrop" onPointerDown={props.onClose} />
      <div
        className="tab-menu node-search command-palette"
        role="dialog"
        aria-label={label}
        style={{ left: props.left, top: props.top }}
      >
        <div className="tab-menu-prompt">
          <span aria-hidden="true">&gt;</span>
          <input
            ref={field}
            className="palette-query"
            value={query}
            aria-label={label}
            title={`${label} · ${t(locale, 'cmd.keys')}`}
            spellCheck={false}
            autoComplete="off"
            // biome-ignore lint/a11y/noAutofocus: the palette opens on its key to be typed into
            autoFocus
            onChange={(e) => {
              const v = e.target.value;
              // The prefixes (09 §3.5): a path goes on in `Ctrl+O`, `?` — the keys.
              if (pathQuery(v)) {
                props.onPath(v);
                return;
              }
              if (v.trimStart().startsWith('?')) {
                props.onHelp();
                return;
              }
              setQuery(v);
              setIndex(0);
              setWaiting(false);
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Escape') props.onClose();
              else if (e.key === 'Enter') run(index);
              else if (e.key === 'ArrowDown') setIndex((i) => Math.min(rows.length - 1, i + 1));
              else if (e.key === 'ArrowUp') setIndex((i) => Math.max(0, i - 1));
              else return;
              e.preventDefault();
            }}
          />
          <label
            className="check palette-all"
            title={t(locale, 'cmd.allHint')}
            // The query keeps its caret through the press.
            onMouseDown={(e) => e.preventDefault()}
          >
            <input
              type="checkbox"
              checked={all}
              onChange={(e) => {
                const on = e.currentTarget.checked;
                setAll(on);
                saveAll(on);
                setIndex(0);
                // The palette is typed into: the keys go back to the query once
                // the click is done — an engine may focus the label's box after
                // this handler (WebKit does).
                window.setTimeout(() => field.current?.focus(), 0);
              }}
            />
            <span>{t(locale, 'cmd.all')}</span>
          </label>
        </div>
        <div ref={list} className="tab-menu-list" role="listbox" aria-label={label}>
          {query.trim() && ready && rows.length === 0 ? (
            <div className="tab-menu-empty">{t(locale, 'menu.nothing', { q: query })}</div>
          ) : null}
          {rows.map((r, i) => {
            const title = titleOf(locale, r.command);
            const cls = ['tab-menu-row'];
            if (i === index) cls.push('is-current');
            if (r.why) cls.push('is-unavailable');
            return [
              r.header ? (
                <div key={`h:${r.header}`} className="tab-menu-header" role="presentation">
                  {t(locale, r.header)}
                </div>
              ) : null,
              <div
                key={r.command.id}
                role="option"
                tabIndex={-1}
                aria-selected={i === index}
                aria-disabled={r.why ? true : undefined}
                className={cls.join(' ')}
                onPointerMove={(e) => {
                  if (moved(e)) setIndex(i);
                }}
                onPointerDown={(e) => {
                  e.preventDefault();
                  run(i);
                }}
              >
                <span
                  className="tab-menu-label"
                  title={r.why ? `${title} — ${t(locale, r.why)}` : title}
                >
                  {title}
                </span>
                <span className="tab-menu-detail">{r.command.key ?? ''}</span>
              </div>,
            ];
          })}
        </div>
      </div>
    </>
  );
}
