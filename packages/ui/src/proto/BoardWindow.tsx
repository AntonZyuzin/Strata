import { newId } from '@strata/backend';
import {
  BOARD_COLORS,
  BOARD_TOOL_GROUPS,
  BOARD_TOOL_KEYS,
  BOARD_TOOLS,
  BoardCanvas,
  type BoardColorName,
  type BoardHandle,
  type BoardPaint,
  type BoardTool,
  WIDGET_KINDS,
  type WidgetKind,
  widgetLink,
} from '@strata/board';
import { type GlyphName, glyphUrl } from '@strata/design-tokens';
import { type Locale, t } from '@strata/i18n';
import type { LoroDoc } from 'loro-crdt';
import { type CSSProperties, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import {
  DockEdge,
  dockRoom,
  type ModeStep,
  modeProps,
  type WindowMode,
  WindowTitle,
} from '../workspace/ContentWindow';
import { BoardWidget, widgetUndo } from './BoardWidgets';

/** The widgets' buttons on the toolbar (ADR-0006 item 4). */
const WIDGET_GLYPH: Record<WidgetKind, GlyphName> = { note: 'note', todo: 'checklist' };

/** The toolbar's icons (07 §6.2): own 1-bit glyphs, drawn in the text colour. */
const TOOL_GLYPH: Record<BoardTool, GlyphName> = {
  selection: 'select',
  hand: 'hand',
  rectangle: 'rectangle',
  diamond: 'diamond',
  ellipse: 'ellipse',
  arrow: 'arrow',
  line: 'line',
  freedraw: 'pencil',
  text: 'text',
  eraser: 'eraser',
};

const TOOL_BY_KEY = new Map(BOARD_TOOLS.map((k) => [BOARD_TOOL_KEYS[k], k]));

function editable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.tagName === 'TEXTAREA' || target.tagName === 'INPUT')
  );
}

/**
 * A board's window (06 §13.1: 80 % of the canvas; ADR-0006 item 3): Strata's
 * retro window and toolbar around Excalidraw without its own UI. While the
 * focus is inside, the canvas's keys are off (the board's letters are its
 * tools, `Delete` deletes its elements); `Esc` outside a gesture gives the
 * keyboard back to the canvas.
 *
 * Tools are icons with the name and Excalidraw's letter in the title; the
 * palette is a strip along the bottom, as Paint's (07 §8.4): a click gives
 * the line its colour, the right button the fill, to the selection and to
 * what is drawn next.
 */
export function BoardWindow(props: {
  locale: Locale;
  name: string;
  doc: LoroDoc;
  /**
   * The workspace and the board's node: a widget's link names them (05
   * §9.4); none — the prototype's board, which takes no widgets.
   */
  ids?: { workspace: string; board: string } | undefined;
  /** At 80 % of the canvas, docked right or over the canvas (06 §2.2). */
  mode?: WindowMode | undefined;
  /** The dock's width, CSS px; none — 40 % of the canvas. */
  dock?: number | null | undefined;
  /** ▭ and □; none — the window stays where it opened (the prototype's). */
  onMode?: ((step: ModeStep) => void) | undefined;
  /** ◎: to the bubble on the canvas. */
  onLocate?: (() => void) | undefined;
  onDock?: ((width: number) => void) | undefined;
  onChange: () => void;
  onFocus: (inside: boolean) => void;
  onClose: () => void;
  onReady?: (handle: BoardHandle) => void;
}) {
  const { locale } = props;
  const [tool, setTool] = useState<BoardTool>('selection');
  // Excalidraw's start as BoardCanvas sets it: paper lines, no fill.
  const [paints, setPaints] = useState<Record<BoardPaint, BoardColorName>>({
    stroke: 'paper',
    fill: 'none',
  });
  const board = useRef<BoardHandle | null>(null);
  const box = useRef<HTMLElement>(null);
  // The widgets' own undo, as long as the window is open (10 §9.2).
  const undo = useMemo(() => widgetUndo(props.doc), [props.doc]);
  useEffect(() => () => undo.free(), [undo]);
  const ids = props.ids;
  const insert = (kind: WidgetKind) => {
    if (!ids) return;
    const id = newId();
    board.current?.insertWidget(kind, id, widgetLink(ids.workspace, ids.board, id));
  };
  const title = props.name || t(locale, 'note.untitled');
  const colorOf = (name: BoardColorName) =>
    BOARD_COLORS.find((c) => c.name === name)?.color ?? 'transparent';
  const paint = (which: BoardPaint, name: BoardColorName) => {
    setPaints((p) => ({ ...p, [which]: name }));
    board.current?.paint(which, colorOf(name));
  };
  const swatch = (name: BoardColorName) =>
    name === 'none' ? undefined : ({ background: colorOf(name) } as CSSProperties);
  const named = (name: BoardColorName) => t(locale, `board.color.${name}` as const);
  return (
    <section
      ref={box}
      className="window board-window"
      {...modeProps(props.mode ?? 'float', props.dock ?? null, undefined)}
      // `F6` brings the focus here (06 §1.1): the board's keys are its own then.
      tabIndex={-1}
      aria-label={t(locale, 'board.label', { name: title })}
      onFocusCapture={() => props.onFocus(true)}
      onBlurCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) props.onFocus(false);
      }}
      onKeyDownCapture={(e) => {
        if (e.ctrlKey || e.metaKey || e.altKey || editable(e.target)) return;
        const k = TOOL_BY_KEY.get(e.key.toUpperCase());
        if (!k) return;
        // Excalidraw would refuse the switch itself: the tool is the host's.
        e.preventDefault();
        e.stopPropagation();
        setTool(k);
      }}
    >
      <WindowTitle
        locale={locale}
        title={title}
        mode={props.mode ?? 'float'}
        onMode={props.onMode}
        onLocate={props.onLocate}
        closeLabel={t(locale, 'board.close')}
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
      <div className="board-main">
        <fieldset className="board-tools">
          <legend className="sr-only">{t(locale, 'board.tools')}</legend>
          {BOARD_TOOL_GROUPS.map((group) => (
            <div key={group[0]} className="board-tool-group">
              {group.map((k) => {
                const name = t(locale, `board.tool.${k}` as const);
                return (
                  <label
                    key={k}
                    className={tool === k ? 'board-tool is-active' : 'board-tool'}
                    title={t(locale, 'board.toolKey', { name, key: BOARD_TOOL_KEYS[k] })}
                  >
                    <input
                      type="radio"
                      name="board-tool"
                      value={k}
                      aria-label={name}
                      checked={tool === k}
                      onChange={() => setTool(k)}
                    />
                    <span
                      className="kind-icon"
                      style={{ '--glyph': glyphUrl(TOOL_GLYPH[k]) } as CSSProperties}
                      aria-hidden="true"
                    />
                  </label>
                );
              })}
            </div>
          ))}
          {ids ? (
            <div className="board-tool-group">
              {WIDGET_KINDS.map((kind) => {
                const name = t(locale, `board.widget.${kind}` as const);
                return (
                  <button
                    key={kind}
                    type="button"
                    className="board-tool board-widget-add"
                    data-widget={kind}
                    aria-label={name}
                    title={t(locale, `board.widget.${kind}Hint` as const)}
                    onClick={() => insert(kind)}
                  >
                    <span
                      className="kind-icon"
                      style={{ '--glyph': glyphUrl(WIDGET_GLYPH[kind]) } as CSSProperties}
                      aria-hidden="true"
                    />
                  </button>
                );
              })}
            </div>
          ) : null}
        </fieldset>
        <div className="board-stage">
          <Suspense fallback={null}>
            <BoardCanvas
              doc={props.doc}
              tool={tool}
              onChange={props.onChange}
              onReady={(h) => {
                board.current = h;
                props.onReady?.(h);
              }}
              renderWidget={(w) => (
                <BoardWidget locale={locale} doc={props.doc} id={w.id} kind={w.kind} undo={undo} />
              )}
            />
          </Suspense>
        </div>
      </div>
      <fieldset className="board-colors">
        <legend className="sr-only">{t(locale, 'board.colors')}</legend>
        <span
          className="board-pair"
          role="img"
          aria-label={t(locale, 'board.pair', {
            stroke: named(paints.stroke),
            fill: named(paints.fill),
          })}
          title={t(locale, 'board.pair', {
            stroke: named(paints.stroke),
            fill: named(paints.fill),
          })}
        >
          <span
            className={paints.fill === 'none' ? 'board-pair-fill is-none' : 'board-pair-fill'}
            style={swatch(paints.fill)}
          />
          <span
            className={paints.stroke === 'none' ? 'board-pair-stroke is-none' : 'board-pair-stroke'}
            style={swatch(paints.stroke)}
          />
        </span>
        {BOARD_COLORS.map((c) => (
          <button
            key={c.name}
            type="button"
            className={
              c.name === 'none' ? 'ins-swatch board-swatch is-none' : 'ins-swatch board-swatch'
            }
            data-color={c.name}
            style={swatch(c.name)}
            aria-label={named(c.name)}
            title={t(locale, 'board.swatch', { name: named(c.name) })}
            // The text being typed keeps its focus and takes the colour.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => paint('stroke', c.name)}
            onContextMenu={(e) => {
              e.preventDefault();
              paint('fill', c.name);
            }}
          />
        ))}
      </fieldset>
    </section>
  );
}
