import { type Locale, t } from '@strata/i18n';
import { type ReactNode, useEffect, useRef } from 'react';

/** Where the app asks for updates (the release workflow publishes there). */
const CHANNEL = 'github.com/AntonZyuzin/Strata';

/**
 * A question at the app's start, its keys kept inside: the screen behind,
 * loading as the window opens, would take them otherwise. `Enter` presses
 * the button with the focus, `Esc` the first one.
 */
function StartDialog(props: {
  id: string;
  title: string;
  /** The whole story, in the tooltip: the Chrome has no explaining lines. */
  hint: string;
  body: ReactNode;
  cancel: string;
  confirm: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const box = useRef<HTMLElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    confirm.current?.focus();
    const keep = (e: FocusEvent) => {
      if (!box.current?.contains(e.target as Node)) confirm.current?.focus();
    };
    document.addEventListener('focusin', keep);
    return () => document.removeEventListener('focusin', keep);
  }, []);
  return (
    <div className="dialog-backdrop">
      <section
        ref={box}
        className="window dialog update-dialog"
        role="alertdialog"
        aria-labelledby={`${props.id}-title`}
        aria-describedby={`${props.id}-body`}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape' && !props.busy) props.onCancel();
        }}
      >
        <header className="window-title">
          <h2 id={`${props.id}-title`} title={props.title}>
            {props.title}
          </h2>
        </header>
        <div className="window-body">
          <p id={`${props.id}-body`} className="dialog-text update-text" title={props.hint}>
            {props.body}
          </p>
          <div className="dialog-actions">
            <button type="button" disabled={props.busy} onClick={props.onCancel}>
              {props.cancel}
            </button>
            <button ref={confirm} type="button" disabled={props.busy} onClick={props.onConfirm}>
              {props.confirm}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

/**
 * NFR-94: the app asks the network nothing without the person's leave. At
 * the first start of a build with an update channel (NFR-89) it asks once
 * whether to check; «Настройки» change the answer later.
 */
export function UpdateQuestion(props: { locale: Locale; onAnswer: (check: boolean) => void }) {
  const { locale } = props;
  return (
    <StartDialog
      id="update-ask"
      title={t(locale, 'updates.ask')}
      hint={t(locale, 'updates.askHint')}
      body={CHANNEL}
      cancel={t(locale, 'updates.never')}
      confirm={t(locale, 'updates.check')}
      onCancel={() => props.onAnswer(false)}
      onConfirm={() => props.onAnswer(true)}
    />
  );
}

/**
 * A newer version, found at the start (NFR-89): «Установить» downloads it,
 * the updater checks its signature and its version, installs it and starts
 * it; «Позже» — till the next start.
 */
export function UpdateOffer(props: {
  locale: Locale;
  version: string;
  /** The version running. */
  current: string;
  notes?: string | null | undefined;
  installing: boolean;
  onLater: () => void;
  onInstall: () => void;
}) {
  const { locale } = props;
  const title = t(locale, 'updates.found', { version: props.version });
  return (
    <StartDialog
      id="update-offer"
      title={title}
      hint={props.notes?.trim() || title}
      body={
        props.installing
          ? t(locale, 'updates.installing')
          : t(locale, 'updates.now', { version: props.current })
      }
      cancel={t(locale, 'updates.later')}
      confirm={t(locale, 'updates.install')}
      busy={props.installing}
      onCancel={props.onLater}
      onConfirm={props.onInstall}
    />
  );
}
