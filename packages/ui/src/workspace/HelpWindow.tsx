import { type Locale, t } from '@strata/i18n';
import { useEffect, useMemo, useRef } from 'react';
import { isTauri } from '../backend';
import { HELP, keysText, onMac } from './help';

/**
 * «Клавиши» (06 §17): `?` opens the keys and gestures of the canvas, group
 * by group, the modifiers named as this OS names them (⌘ ⌥ ⇧ on macOS). A
 * row is one line, a value too long for it cut and told in full by its
 * tooltip; the width is in `ch`, the same in both languages. `Esc`, × or a
 * press outside closes it.
 */
export function HelpWindow(props: { locale: Locale; onClose: () => void }) {
  const { locale } = props;
  const box = useRef<HTMLElement>(null);
  const mac = useMemo(onMac, []);
  const desktop = useMemo(isTauri, []);

  useEffect(() => {
    box.current?.focus();
  }, []);

  return (
    <div
      className="dialog-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <section
        ref={box}
        className="window help-window"
        role="dialog"
        aria-labelledby="help-title"
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return;
          e.stopPropagation();
          props.onClose();
        }}
      >
        <header className="window-title">
          <h1 id="help-title">{t(locale, 'help.title')}</h1>
          <button
            type="button"
            className="window-close"
            aria-label={t(locale, 'help.close')}
            title={t(locale, 'help.close')}
            onClick={props.onClose}
          >
            ×
          </button>
        </header>
        <div className="window-body help-body">
          {HELP.map((g) => (
            <section key={g.title} className="help-group">
              <h2 className="ins-heading">{t(locale, g.title)}</h2>
              <dl className="help-rows">
                {g.rows
                  .filter((r) => desktop || !r.desktop)
                  .map((r) => {
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
          ))}
        </div>
      </section>
    </div>
  );
}
