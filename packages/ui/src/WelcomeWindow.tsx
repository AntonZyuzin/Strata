import { type Locale, t } from '@strata/i18n';
import { useEffect, useMemo, useRef } from 'react';
import { keepTab } from './focusTrap';
import { FIRST_STEPS, helpRows, keysText, onMac } from './workspace/help';

/**
 * «Добро пожаловать» (06 §17.2, owner 2026-11-07): the window the app opens
 * with — what a workspace is, in two lines, and the first steps with their
 * keys, the rows of «Клавиши» picked out; «Все клавиши…» opens the whole
 * table. «Показывать при запуске», as Windows 98's welcome had it, keeps
 * the answer on the device. `Esc`, × or «Начать» closes it.
 */
export function WelcomeWindow(props: {
  locale: Locale;
  /** Shown at each start. */
  atStart: boolean;
  onAtStart: (show: boolean) => void;
  /** «Клавиши»: the whole table. */
  onKeys: () => void;
  onClose: () => void;
}) {
  const { locale } = props;
  const start = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLElement>(null);
  const mac = useMemo(onMac, []);
  const rows = useMemo(() => helpRows(FIRST_STEPS), []);
  useEffect(() => start.current?.focus(), []);
  const title = t(locale, 'welcome.title');
  const steps = t(locale, 'welcome.steps');
  return (
    <div className="dialog-backdrop">
      <section
        ref={box}
        className="window welcome-window"
        role="dialog"
        aria-modal="true"
        aria-labelledby="welcome-title"
        onKeyDown={(e) => {
          keepTab(e, box.current);
          if (e.key !== 'Escape') return;
          e.stopPropagation();
          props.onClose();
        }}
      >
        <header className="window-title">
          <h1 id="welcome-title" title={title}>
            {title}
          </h1>
          <button
            type="button"
            className="window-close"
            aria-label={t(locale, 'welcome.close')}
            title={t(locale, 'welcome.close')}
            onClick={props.onClose}
          >
            ×
          </button>
        </header>
        <div className="window-body welcome-body">
          <p className="welcome-text">{t(locale, 'welcome.what')}</p>
          <p className="welcome-text">{t(locale, 'welcome.where')}</p>
          <section className="help-group">
            <h2 className="ins-heading">{steps}</h2>
            <dl className="help-rows">
              {rows.map((r) => {
                const what = t(locale, r.label);
                const keys = keysText(locale, r, mac);
                return (
                  <div key={r.label} className="help-row">
                    <dt title={what}>{what}</dt>
                    <dd title={keys}>{keys}</dd>
                  </div>
                );
              })}
            </dl>
          </section>
          <div className="dialog-actions welcome-actions">
            <label className="check welcome-again">
              <input
                type="checkbox"
                checked={props.atStart}
                onChange={(e) => props.onAtStart(e.currentTarget.checked)}
              />
              <span>{t(locale, 'welcome.atStart')}</span>
            </label>
            <button type="button" onClick={props.onKeys}>
              {t(locale, 'welcome.keys')}
            </button>
            <button ref={start} type="button" className="is-default" onClick={props.onClose}>
              {t(locale, 'welcome.start')}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
