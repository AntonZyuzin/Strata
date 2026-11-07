import { createNoteEditor } from '@strata/editor';
import { type Locale, t } from '@strata/i18n';
import type { LoroDoc } from 'loro-crdt';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  DockEdge,
  dockRoom,
  type ModeStep,
  modeProps,
  settleIn,
  type WindowMode,
  WindowTitle,
} from '../workspace/ContentWindow';

/**
 * A note's window (06 §13.1): a retro window with the editor of ADR-0007 on
 * the note's content document — beside its bubble, docked right or over the
 * canvas (06 §2.2). `Esc` gives the keyboard back to the canvas and leaves
 * the window open; × closes it.
 */
export function NoteWindow(props: {
  locale: Locale;
  name: string;
  doc: LoroDoc;
  /** Screen point of the bubble's side and which side the window opens on. */
  at: { x: number; y: number; side: 'left' | 'right' };
  mode?: WindowMode | undefined;
  /** The dock's width, CSS px; none — 40 % of the canvas. */
  dock?: number | null | undefined;
  /** ▭ and □; none — the window stays where it opened (the prototype's). */
  onMode?: ((step: ModeStep) => void) | undefined;
  /** ◎: to the bubble on the canvas. */
  onLocate?: (() => void) | undefined;
  onDock?: ((width: number) => void) | undefined;
  /** The properties panel is open: a floating window stays left of it. */
  panel?: boolean | undefined;
  onChange: (text: string) => void;
  onEscape: () => void;
  onClose: () => void;
}) {
  const { locale, doc, onChange } = props;
  const box = useRef<HTMLElement>(null);
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

  // Beside the bubble, then settled inside the canvas one sees: between
  // «Ноды» and the panel, which it covered when its 80ch did not fit.
  const floating = (props.mode ?? 'float') === 'float';
  const [place, setPlace] = useState<{ left: number; top: number; max: number } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `at`, `panel` — the room or the bubble moved
  useLayoutEffect(() => {
    setPlace(null);
  }, [floating, props.at.x, props.at.y, props.at.side, props.panel]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `at` is read when the place is asked anew
  useLayoutEffect(() => {
    if (place === null && floating) setPlace(settleIn(box.current, props.at));
  }, [place, floating]);
  const float = place
    ? { left: place.left, top: place.top, maxWidth: place.max }
    : props.at.side === 'right'
      ? { left: props.at.x, top: props.at.y }
      : { right: `calc(100% - ${props.at.x}px)`, top: props.at.y };
  const title = props.name || t(locale, 'note.untitled');
  return (
    <section
      ref={box}
      className="window note-window"
      {...modeProps(props.mode ?? 'float', props.dock ?? null, float)}
      aria-label={t(locale, 'note.label', { name: title })}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          props.onEscape();
        }
      }}
    >
      <WindowTitle
        locale={locale}
        title={title}
        mode={props.mode ?? 'float'}
        onMode={props.onMode}
        onLocate={props.onLocate}
        closeLabel={t(locale, 'note.close')}
        onClose={props.onClose}
      />
      {props.mode === 'pinned' && props.onDock ? (
        <DockEdge
          locale={locale}
          width={() => box.current?.offsetWidth ?? 0}
          room={() => dockRoom(box.current)}
          onWidth={props.onDock}
        />
      ) : null}
      <div className="note-body" ref={host} />
    </section>
  );
}
