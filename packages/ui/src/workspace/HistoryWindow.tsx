import type { Journal, JournalEntry } from '@strata/backend';
import { type Locale, type MessageKey, t } from '@strata/i18n';
import { useEffect, useRef, useState } from 'react';
import { keepTab } from '../focusTrap';
import { type Clock, type DateFormat, formatDate, formatTime } from '../prefs';
import { changeText } from './changes';

const pad = (n: number) => String(n).padStart(2, '0');

/** A moment as its row reads (06 §1.2): `HH:MM` today, the date and the time before. */
export function whenText(ms: number, date: DateFormat, clock: Clock, now = Date.now()): string {
  const at = new Date(ms);
  const day = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = formatTime(`${pad(at.getHours())}:${pad(at.getMinutes())}`, clock);
  return day(at) === day(new Date(now)) ? time : `${formatDate(day(at), date)} ${time}`;
}

/** Who made a changeset (05 §11): you, an import, the core, an agent by its client. */
export function whoText(locale: Locale, e: JournalEntry): string {
  switch (e.origin.type) {
    case 'user':
      return t(locale, 'history.you');
    case 'import':
      return t(locale, 'history.import');
    case 'system':
      return t(locale, 'history.system');
    case 'ai':
      return t(locale, 'history.ai');
    default:
      return 'client' in e.origin ? e.origin.client : '';
  }
}

/** What a row says: the label, an undo's and a redo's with their arrow. */
export function whatText(locale: Locale, e: JournalEntry): string {
  const label = changeText(locale, e.label);
  if (e.kind === 'undo') return t(locale, 'history.undo', { label });
  if (e.kind === 'redo') return t(locale, 'history.redo', { label });
  return label;
}

/** The result of «Откатить», worded under the list. */
export type RevertResult = { skipped: number; nothing: boolean } | { refused: 'depends' } | null;

/**
 * «История изменений» (06 §1.2, 10 §9.3): the workspace's changesets, the
 * newest first, 100 at a time — «Ещё» brings older ones. A row: when, who,
 * what; a changeset taken back is grey, and its time's tooltip says when.
 * «Показать» goes to the changeset's first live node; «Откатить» takes it
 * back as a new step of undo, the result on the line under the list; a
 * changeset that cannot be reverted says why in the button's tooltip.
 * `↑` `↓` choose, `Enter` — «Показать», `Esc` closes.
 */
export function HistoryWindow(props: {
  locale: Locale;
  /** The first page, then more: the core's journal. */
  load: (before?: string) => Promise<Journal>;
  date: DateFormat;
  clock: Clock;
  /** Today, for the times of the rows. */
  now?: number;
  /** «Показать»: false — none of its nodes is alive. */
  onShow: (id: string) => Promise<boolean>;
  /** «Откатить»: done, or refused because later changes stand on it. */
  onRevert: (id: string) => Promise<RevertResult>;
  onClose: () => void;
}) {
  const { locale } = props;
  const [rows, setRows] = useState<JournalEntry[] | null>(null);
  const [more, setMore] = useState(false);
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  /** The line under the list: what «Откатить» or «Показать» came to. */
  const [line, setLine] = useState<string | null>(null);
  const box = useRef<HTMLElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const { load } = props;

  useEffect(() => {
    let live = true;
    load().then((j) => {
      if (!live) return;
      setRows(j.entries);
      setMore(j.more);
    });
    list.current?.focus();
    return () => {
      live = false;
    };
  }, [load]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `index` — the row moved
  useEffect(() => {
    list.current?.querySelector('.is-current')?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  const all = rows ?? [];
  const chosen = all[Math.min(index, all.length - 1)];
  const loadMore = async () => {
    const last = all.at(-1);
    if (!last) return;
    const j = await load(last.id);
    setRows([...all, ...j.entries]);
    setMore(j.more);
  };
  const show = async (e: JournalEntry | undefined) => {
    if (!e) return;
    if (!(await props.onShow(e.id))) setLine(t(locale, 'history.noNodes'));
  };
  const revert = async () => {
    if (!chosen || chosen.fixed || busy) return;
    const keep = chosen.id;
    setBusy(true);
    try {
      const r = await props.onRevert(chosen.id);
      setLine(
        r === null
          ? null
          : 'refused' in r
            ? t(locale, 'history.depends')
            : r.nothing
              ? t(locale, 'history.nothing')
              : r.skipped === 0
                ? t(locale, 'history.done')
                : t(locale, 'history.partly', { n: r.skipped }),
      );
      // The journal anew, as deep as it was read: the revert on top, the row grey.
      const j = await load();
      const fresh = [...j.entries];
      let page = j;
      while (page.more && fresh.length < all.length + 1) {
        const last = fresh.at(-1);
        if (!last) break;
        page = await load(last.id);
        fresh.push(...page.entries);
      }
      setRows(fresh);
      setMore(page.more);
      // The same changeset stays chosen, whether a revert came on top or not.
      setIndex(
        Math.max(
          0,
          fresh.findIndex((x) => x.id === keep),
        ),
      );
    } catch (e) {
      // Anything else the core refused, said where the result goes.
      setLine(t(locale, 'ws.refused', { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
      // The button was disabled while it worked, and the focus left with it.
      list.current?.focus();
    }
  };
  const title = t(locale, 'history.title');
  const why = chosen?.fixed ? t(locale, `history.fixed.${chosen.fixed}` as MessageKey) : null;
  return (
    <div className="dialog-backdrop">
      <section
        ref={box}
        className="window history-window"
        role="dialog"
        aria-modal="true"
        aria-labelledby="history-title"
        onKeyDown={(e) => {
          e.stopPropagation();
          keepTab(e, box.current);
          if (e.key === 'Escape') props.onClose();
        }}
      >
        <header className="window-title">
          <h2 id="history-title" title={title}>
            {title}
          </h2>
          <button
            type="button"
            className="window-close"
            aria-label={t(locale, 'history.close')}
            title={t(locale, 'history.close')}
            onClick={props.onClose}
          >
            ×
          </button>
        </header>
        <div className="window-body">
          <div
            ref={list}
            className="history-list"
            role="listbox"
            aria-label={t(locale, 'history.list')}
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') setIndex((i) => Math.min(all.length - 1, i + 1));
              else if (e.key === 'ArrowUp') setIndex((i) => Math.max(0, i - 1));
              else if (e.key === 'Home') setIndex(0);
              else if (e.key === 'End') setIndex(Math.max(0, all.length - 1));
              else if (e.key === 'Enter') void show(chosen);
              else return;
              e.preventDefault();
            }}
          >
            {all.map((e, i) => {
              const what = whatText(locale, e);
              const when = whenText(e.ts, props.date, props.clock, props.now);
              const back = e.revertedBy
                ? t(locale, 'history.revertedAt', {
                    when: whenText(e.revertedBy.ts, props.date, props.clock, props.now),
                  })
                : null;
              const classes = ['history-row', 'tab-menu-row'];
              if (e === chosen) classes.push('is-current');
              if (e.revertedBy) classes.push('is-reverted');
              return (
                <div
                  key={e.id}
                  role="option"
                  tabIndex={-1}
                  data-id={e.id}
                  aria-selected={e === chosen}
                  className={classes.join(' ')}
                  onPointerDown={(ev) => {
                    ev.preventDefault();
                    setIndex(i);
                    list.current?.focus();
                  }}
                  onDoubleClick={() => void show(e)}
                >
                  {/* When it was taken back, by its time: the label keeps its own tooltip. */}
                  <span className="history-when" title={back ? `${when} · ${back}` : when}>
                    {when}
                  </span>
                  <span className="history-who" title={whoText(locale, e)}>
                    {whoText(locale, e)}
                  </span>
                  <span className="history-what" title={what}>
                    {what}
                  </span>
                </div>
              );
            })}
            {more ? (
              <button type="button" className="history-more" onClick={() => void loadMore()}>
                {t(locale, 'history.more')}
              </button>
            ) : null}
          </div>
          <p className="history-result" role="status" title={line ?? undefined}>
            {line}
          </p>
          <div className="dialog-actions">
            <button
              type="button"
              title={t(locale, 'history.showHint')}
              disabled={!chosen}
              onClick={() => void show(chosen)}
            >
              {t(locale, 'history.show')}
            </button>
            <button
              type="button"
              className="is-default"
              title={why ?? t(locale, 'history.revertHint')}
              aria-disabled={Boolean(why) || busy}
              disabled={!chosen || busy}
              data-fixed={chosen?.fixed ?? ''}
              onClick={() => void revert()}
            >
              {t(locale, 'history.revert')}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
