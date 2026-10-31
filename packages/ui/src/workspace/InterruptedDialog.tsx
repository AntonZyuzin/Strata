import { type Locale, t } from '@strata/i18n';
import { useEffect, useRef } from 'react';

/**
 * An import the app left in the middle (10 §3.3, NFR-71): each batch it
 * wrote is whole; «Откатить» takes them all back, «Оставить» keeps them —
 * the files that never came are ghosts then. Asked as the workspace opens;
 * `Enter` rolls back, `Esc` keeps.
 */
export function InterruptedDialog(props: {
  locale: Locale;
  /** The vault's name. */
  name: string;
  onSettle: (keep: boolean) => void;
}) {
  const { locale } = props;
  const box = useRef<HTMLElement>(null);
  const revert = useRef<HTMLButtonElement>(null);
  // The keys stay here: the canvas behind, loading as the window opens,
  // would take them — and `Enter` would dive into a network.
  useEffect(() => {
    revert.current?.focus();
    const keep = (e: FocusEvent) => {
      if (!box.current?.contains(e.target as Node)) revert.current?.focus();
    };
    document.addEventListener('focusin', keep);
    return () => document.removeEventListener('focusin', keep);
  }, []);
  const title = t(locale, 'import.interrupted');
  const hint = t(locale, 'import.interruptedHint', { name: props.name });
  return (
    <div className="dialog-backdrop">
      <section
        ref={box}
        className="window dialog interrupted-dialog"
        role="alertdialog"
        aria-labelledby="interrupted-title"
        aria-describedby="interrupted-name"
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') props.onSettle(true);
        }}
      >
        <header className="window-title">
          <h2 id="interrupted-title" title={title}>
            {title}
          </h2>
        </header>
        <div className="window-body">
          <p id="interrupted-name" className="dialog-text interrupted-name" title={hint}>
            {props.name}
          </p>
          <div className="dialog-actions">
            <button type="button" onClick={() => props.onSettle(true)}>
              {t(locale, 'import.keep')}
            </button>
            <button ref={revert} type="button" onClick={() => props.onSettle(false)}>
              {t(locale, 'import.revert')}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
