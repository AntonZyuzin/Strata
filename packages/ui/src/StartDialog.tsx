import { type ReactNode, useEffect, useRef } from 'react';

/**
 * A question at the app's start, its keys kept inside: the screen behind,
 * loading as the window opens, would take them otherwise. `Enter` presses
 * the button with the focus, `Esc` the first one.
 */
export function StartDialog(props: {
  id: string;
  title: string;
  /** The whole story, in the tooltip: the Chrome has no explaining lines. */
  hint: string;
  body: ReactNode;
  cancel: string;
  confirm: string;
  busy?: boolean;
  /** What the confirm came to when it failed: the question stays. */
  error?: string | null;
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
          {props.error ? (
            <p className="dialog-text start-error" role="alert" title={props.error}>
              {props.error}
            </p>
          ) : null}
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
