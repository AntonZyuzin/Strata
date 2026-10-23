import { BOARD_TOOLS, BoardCanvas, type BoardHandle, type BoardTool } from '@strata/board';
import { type Locale, t } from '@strata/i18n';
import type { LoroDoc } from 'loro-crdt';
import { Suspense, useState } from 'react';

/**
 * A board's window (06 §13.1: 80 % of the canvas; ADR-0006 item 3): Strata's
 * retro window and toolbar around Excalidraw without its own UI. While the
 * focus is inside, the canvas's keys are off (the board's letters are its
 * tools, `Delete` deletes its elements); `Esc` outside a gesture gives the
 * keyboard back to the canvas.
 */
export function BoardWindow(props: {
  locale: Locale;
  name: string;
  doc: LoroDoc;
  onChange: () => void;
  onFocus: (inside: boolean) => void;
  onClose: () => void;
  onReady?: (handle: BoardHandle) => void;
}) {
  const { locale } = props;
  const [tool, setTool] = useState<BoardTool>('selection');
  const title = props.name || t(locale, 'note.untitled');
  return (
    <section
      className="window board-window"
      aria-label={t(locale, 'board.label', { name: title })}
      onFocusCapture={() => props.onFocus(true)}
      onBlurCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) props.onFocus(false);
      }}
    >
      <header className="window-title">
        <h2 title={title}>{title}</h2>
        <button
          type="button"
          className="window-close"
          aria-label={t(locale, 'board.close')}
          title={t(locale, 'board.close')}
          onClick={props.onClose}
        >
          ×
        </button>
      </header>
      <div className="board-main">
        <fieldset className="board-tools">
          <legend className="sr-only">{t(locale, 'board.tools')}</legend>
          {BOARD_TOOLS.map((k) => (
            <label key={k} className={tool === k ? 'board-tool is-active' : 'board-tool'}>
              <input
                type="radio"
                name="board-tool"
                value={k}
                checked={tool === k}
                onChange={() => setTool(k)}
              />
              <span>{t(locale, `board.tool.${k}` as const)}</span>
            </label>
          ))}
        </fieldset>
        <div className="board-stage">
          <Suspense fallback={null}>
            <BoardCanvas
              doc={props.doc}
              tool={tool}
              onChange={props.onChange}
              {...(props.onReady ? { onReady: props.onReady } : {})}
            />
          </Suspense>
        </div>
      </div>
    </section>
  );
}
