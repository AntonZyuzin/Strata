import { type Locale, type MessageKey, t } from '@strata/i18n';
import type { SearchClient } from '@strata/search';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  available,
  COMMANDS,
  type Command,
  type CommandContext,
  type CommandGroup,
  commandNames,
  rankedCommands,
  titleOf,
} from './commands';

const ROWS = 12;
/** Recent commands on top of an empty query (09 §3.5). */
const RECENT = 5;
const RECENT_KEY = 'strata.palette.recent';
const GROUPS: readonly CommandGroup[] = ['node', 'canvas', 'nav'];

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
}

/**
 * The command palette, `Ctrl+P` (09 §3.5): the Tab menu's window, its width in
 * `ch` whatever the language. With no query — the recent five, then every
 * command that can run now by its group; with a query — the search engine's
 * ranking of the titles in both languages and the aliases. A row is the
 * title and its key; `Enter` typed before the engine's answer runs once it
 * comes.
 */
export function CommandPalette(props: {
  locale: Locale;
  search: SearchClient;
  context: CommandContext;
  left: number;
  top: number;
  onRun: (command: Command) => void;
  onClose: () => void;
}) {
  const { locale, search, context } = props;
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const [found, setFound] = useState<{ q: string; commands: Command[] } | null>(null);
  const [waiting, setWaiting] = useState(false);
  const names = useMemo(() => commandNames(), []);
  const list = useRef<HTMLDivElement>(null);

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
    const can = (c: Command) => available(c, context);
    if (query.trim() === '') {
      const recent = loadRecent()
        .flatMap((id) => COMMANDS.filter((c) => c.id === id))
        .filter(can);
      const out: Row[] = recent.map((command, i) => ({
        command,
        header: i === 0 ? 'cmd.recent' : null,
      }));
      for (const g of GROUPS) {
        const list = COMMANDS.filter((c) => c.group === g && can(c) && !recent.includes(c));
        list.forEach((command, i) => {
          out.push({ command, header: i === 0 ? (`cmd.group.${g}` as MessageKey) : null });
        });
      }
      return out;
    }
    if (found?.q !== query) return [];
    return found.commands
      .filter(can)
      .slice(0, ROWS)
      .map((command) => ({ command, header: null }));
  }, [query, found, context]);

  const ready = query.trim() === '' || found?.q === query;
  const { onRun } = props;
  const run = (i: number) => {
    if (!ready) {
      setWaiting(true);
      return;
    }
    const r = rows[i];
    if (!r) return;
    remember(r.command.id);
    onRun(r.command);
  };
  const first = rows[Math.min(index, rows.length - 1)];
  useEffect(() => {
    if (!waiting || !ready) return;
    setWaiting(false);
    if (!first) return;
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
            value={query}
            aria-label={label}
            title={`${label} · ${t(locale, 'cmd.keys')}`}
            spellCheck={false}
            autoComplete="off"
            // biome-ignore lint/a11y/noAutofocus: the palette opens on its key to be typed into
            autoFocus
            onChange={(e) => {
              setQuery(e.target.value);
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
        </div>
        <div ref={list} className="tab-menu-list" role="listbox" aria-label={label}>
          {query.trim() && ready && rows.length === 0 ? (
            <div className="tab-menu-empty">{t(locale, 'menu.nothing', { q: query })}</div>
          ) : null}
          {rows.map((r, i) => {
            const title = titleOf(locale, r.command);
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
                className={i === index ? 'tab-menu-row is-current' : 'tab-menu-row'}
                onPointerEnter={() => setIndex(i)}
                onPointerDown={(e) => {
                  e.preventDefault();
                  run(i);
                }}
              >
                <span className="tab-menu-label" title={title}>
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
