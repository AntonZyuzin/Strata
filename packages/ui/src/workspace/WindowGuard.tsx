import { type Locale, t } from '@strata/i18n';
import { Component, createRef, type ErrorInfo, Fragment, type ReactNode } from 'react';

/**
 * Kinds of window the e2e hook makes fail at their next render (NFR-80):
 * until the guard catches it — React renders again after a throw, and the
 * fault must hold through that try too.
 */
export const windowFaults = new Set<string>();

/** Throws while its kind is in `windowFaults`: a fault an e2e injected. */
function Fault(props: { kind: string }) {
  if (windowFaults.has(props.kind)) {
    throw new Error(`a fault injected into the ${props.kind} window`);
  }
  return null;
}

interface Props {
  locale: Locale;
  /** `note`, `board`, `asset`: what the fault hook and the log name it by. */
  kind: string;
  title: string;
  onClose: () => void;
  children: ReactNode;
}

interface State {
  error: Error | null;
  /** Each «Повторить» mounts the window anew. */
  round: number;
}

/**
 * A content window's own failure (NFR-80): an error in its render or its
 * effects puts its error screen in its place — the canvas, the other
 * windows and the keys work on. The screen says that the window crashed,
 * the error itself in the line's tooltip; «Повторить» mounts the window
 * anew, «Закрыть» and `Esc` close it. Not modal: the canvas stays at hand.
 */
export class WindowGuard extends Component<Props, State> {
  override state: State = { error: null, round: 0 };
  private readonly closer = createRef<HTMLButtonElement>();

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // An injected fault is spent once caught: «Повторить» opens the window.
    windowFaults.delete(this.props.kind);
    console.error(`the ${this.props.kind} window failed`, error, info.componentStack);
  }

  // The focus the window would have taken: `Enter` closes, a screen reader
  // reads the alert. A window failing as it opens mounts the guard with its
  // error, one failing later updates it.
  override componentDidMount(): void {
    if (this.state.error) this.closer.current?.focus();
  }

  override componentDidUpdate(_: Props, before: State): void {
    if (this.state.error && !before.error) this.closer.current?.focus();
  }

  override render(): ReactNode {
    const { locale, title, onClose } = this.props;
    const { error, round } = this.state;
    if (!error) {
      return (
        <Fragment key={round}>
          <Fault kind={this.props.kind} />
          {this.props.children}
        </Fragment>
      );
    }
    // One window of a kind at a time: the kind names its line.
    const line = `window-failed-${this.props.kind}`;
    return (
      <section
        className="window window-failed"
        role="alertdialog"
        aria-label={title}
        aria-describedby={line}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        {/* No ×: «Закрыть» is the one way to close, as in a dialog with actions. */}
        <header className="window-title">
          <h2 title={title}>{title}</h2>
        </header>
        <div className="window-body">
          {/* What happened, in the interface's language; the error for a bug report. */}
          <p id={line} className="dialog-text window-failed-text" title={error.message}>
            {t(locale, 'window.failed')}
          </p>
          <div className="dialog-actions">
            <button
              type="button"
              title={t(locale, 'window.retryHint')}
              onClick={() => this.setState({ error: null, round: round + 1 })}
            >
              {t(locale, 'window.retry')}
            </button>
            <button type="button" ref={this.closer} className="is-default" onClick={onClose}>
              {t(locale, 'window.close')}
            </button>
          </div>
        </div>
      </section>
    );
  }
}
