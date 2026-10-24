import { createNoteEditor } from '@strata/editor';
import { type Locale, t } from '@strata/i18n';
import type { LoroDoc } from 'loro-crdt';
import { useEffect, useRef } from 'react';

/**
 * A note's window (06 §13.1): a retro window beside its bubble with the
 * editor of ADR-0007 on the note's content document. `Esc` gives the
 * keyboard back to the canvas and leaves the window open; × closes it.
 */
export function NoteWindow(props: {
  locale: Locale;
  name: string;
  doc: LoroDoc;
  /** Screen point of the bubble's side and which side the window opens on. */
  at: { x: number; y: number; side: 'left' | 'right' };
  onChange: (text: string) => void;
  onEscape: () => void;
  onClose: () => void;
}) {
  const { locale, doc, onChange } = props;
  const host = useRef<HTMLDivElement>(null);
  const change = useRef(onChange);
  change.current = onChange;

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const ed = createNoteEditor({
      parent: el,
      doc,
      onChange: (text) => change.current(text),
    });
    ed.view.focus();
    return () => ed.destroy();
  }, [doc]);

  const style =
    props.at.side === 'right'
      ? { left: props.at.x, top: props.at.y }
      : { right: `calc(100% - ${props.at.x}px)`, top: props.at.y };
  const title = props.name || t(locale, 'note.untitled');
  return (
    <section
      className="window note-window"
      style={style}
      aria-label={t(locale, 'note.label', { name: title })}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          props.onEscape();
        }
      }}
    >
      <header className="window-title">
        <h2 title={title}>{title}</h2>
        <button
          type="button"
          className="window-close"
          aria-label={t(locale, 'note.close')}
          title={t(locale, 'note.close')}
          onClick={props.onClose}
        >
          ×
        </button>
      </header>
      <div className="note-body" ref={host} />
    </section>
  );
}
