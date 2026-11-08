import type { Backup } from '@strata/backend';
import { type Locale, t } from '@strata/i18n';
import { useEffect, useId, useRef, useState } from 'react';
import { keepTab } from '../focusTrap';
import { type Clock, type DateFormat, formatDate, formatTime } from '../prefs';

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * A copy as its row reads (10 §3.5): a day's by its day — the day it is
 * named by, in UTC; one from before a restore by the moment, here and now.
 */
export function backupLabel(locale: Locale, b: Backup, date: DateFormat, clock: Clock): string {
  if (b.kind === 'day') {
    return t(locale, 'home.backupDay', {
      date: formatDate(new Date(b.at).toISOString().slice(0, 10), date),
    });
  }
  const at = new Date(b.at);
  const day = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  return t(locale, 'home.backupReplaced', {
    when: `${formatDate(day, date)} ${formatTime(time, clock)}`,
  });
}

/**
 * «Восстановить из копии» (10 §3.5): the copies of a workspace's store, the
 * newest first — a day's, and the store as it was before a restore. The one
 * chosen becomes the workspace, which opens; the workspace as it is stays
 * as a copy of its own, which the button's tooltip says. `↑` `↓` choose,
 * `Enter` restores, `Esc` and «Отмена» take nothing.
 */
export function RestoreDialog(props: {
  locale: Locale;
  name: string;
  /** Null until the backend answers. */
  backups: readonly Backup[] | null;
  date: DateFormat;
  clock: Clock;
  busy: boolean;
  /** What failed, worded: the window stays for another choice. */
  error: string | null;
  onRestore: (backup: Backup) => void;
  onCancel: () => void;
}) {
  const { locale, backups } = props;
  const [index, setIndex] = useState(0);
  const box = useRef<HTMLElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const rows = backups ?? [];
  const chosen = rows[Math.min(index, rows.length - 1)];
  /** The rows' ids: the list names the chosen one to a screen reader (WAI-ARIA listbox). */
  const ids = useId();

  useEffect(() => {
    list.current?.focus();
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `index` — the row moved
  useEffect(() => {
    list.current?.querySelector('.is-current')?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  const restore = () => {
    if (chosen && !props.busy) props.onRestore(chosen);
  };
  const title = t(locale, 'home.restoreTitle', { name: props.name });
  return (
    <div className="dialog-backdrop">
      <section
        ref={box}
        className="window dialog restore-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="restore-title"
        onKeyDown={(e) => {
          e.stopPropagation();
          keepTab(e, box.current);
          if (e.key === 'Escape') props.onCancel();
        }}
      >
        <header className="window-title">
          <h2 id="restore-title" title={title}>
            {title}
          </h2>
        </header>
        <div className="window-body">
          <div
            ref={list}
            className="restore-list"
            role="listbox"
            aria-label={t(locale, 'home.backups')}
            aria-activedescendant={chosen ? `${ids}-${rows.indexOf(chosen)}` : undefined}
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') setIndex((i) => Math.min(rows.length - 1, i + 1));
              else if (e.key === 'ArrowUp') setIndex((i) => Math.max(0, i - 1));
              else if (e.key === 'Home') setIndex(0);
              else if (e.key === 'End') setIndex(Math.max(0, rows.length - 1));
              else if (e.key === 'Enter') restore();
              else return;
              e.preventDefault();
            }}
          >
            {backups && rows.length === 0 ? (
              <div
                className="tab-menu-empty"
                role="option"
                aria-selected="false"
                aria-disabled="true"
                title={t(locale, 'home.noBackupsHint')}
              >
                {t(locale, 'home.noBackups')}
              </div>
            ) : null}
            {rows.map((b, i) => {
              const label = backupLabel(locale, b, props.date, props.clock);
              return (
                <div
                  key={b.id}
                  id={`${ids}-${i}`}
                  role="option"
                  tabIndex={-1}
                  aria-selected={b === chosen}
                  className={b === chosen ? 'tab-menu-row is-current' : 'tab-menu-row'}
                  onPointerDown={(e) => {
                    e.preventDefault();
                    setIndex(i);
                    list.current?.focus();
                  }}
                  onDoubleClick={restore}
                >
                  <span className="tab-menu-label" title={label}>
                    {label}
                  </span>
                </div>
              );
            })}
          </div>
          {props.error ? (
            <p className="restore-error" role="alert" title={props.error}>
              {props.error}
            </p>
          ) : null}
          <div className="dialog-actions">
            <button type="button" onClick={props.onCancel}>
              {t(locale, 'home.cancel')}
            </button>
            <button
              type="button"
              className="is-default"
              title={t(locale, 'home.restoreHint')}
              disabled={props.busy || !chosen}
              onClick={restore}
            >
              {t(locale, 'home.restoreAction')}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
