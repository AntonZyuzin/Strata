import {
  addTodo,
  LOCAL,
  noteText,
  removeTodo,
  setNoteText,
  setTodoDone,
  setTodoText,
  type TodoItem,
  todoItems,
  type WidgetKind,
} from '@strata/board';
import { type Locale, t } from '@strata/i18n';
import { type LoroDoc, UndoManager } from 'loro-crdt';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';

/**
 * The widgets' own undo (10 §9.2, ADR-0006): Loro's UndoManager over the
 * board's document, the scene's commits (`LOCAL`) left out — they are
 * Excalidraw's to undo. One per board, while its window is open.
 */
export function widgetUndo(doc: LoroDoc): UndoManager {
  return new UndoManager(doc, { mergeInterval: 1000, excludeOriginPrefixes: [LOCAL] });
}

/** `Ctrl+Z` / `Ctrl+Shift+Z` inside a widget: its undo, not the scene's. */
function undoKeys(e: KeyboardEvent, undo: UndoManager): boolean {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return false;
  const k = e.key.toLowerCase();
  const redo = (k === 'z' && e.shiftKey) || k === 'y';
  if (k !== 'z' && k !== 'y') return false;
  e.preventDefault();
  e.stopPropagation();
  if (redo) undo.redo();
  else undo.undo();
  return true;
}

/** Re-reads `read` when the document changes: another tab, an undo. */
function useDoc<T>(doc: LoroDoc, read: () => T): T {
  const [value, setValue] = useState(read);
  const latest = useRef(read);
  latest.current = read;
  useEffect(() => doc.subscribe(() => setValue(latest.current())), [doc]);
  return value;
}

/**
 * «Заметка» (ADR-0006 item 4): a short text on the board, Golos Text; what
 * is typed merges by character with what others type. The note's own
 * undo while the focus is in it.
 */
function NoteWidget(props: { locale: Locale; doc: LoroDoc; id: string; undo: UndoManager }) {
  const { doc, id } = props;
  const text = useDoc(doc, () => noteText(doc, id)?.toString() ?? '');
  // What was typed over the document's text of then: shown until the
  // document moves on (its event comes after the keystroke's render).
  const [typed, setTyped] = useState<{ value: string; over: string } | null>(null);
  const shown = typed && typed.over === text ? typed.value : text;
  return (
    <textarea
      className="board-widget-note"
      value={shown}
      placeholder={t(props.locale, 'widget.note.placeholder')}
      aria-label={t(props.locale, 'board.widget.note')}
      spellCheck={false}
      onChange={(e) => {
        setTyped({ value: e.currentTarget.value, over: text });
        setNoteText(doc, id, e.currentTarget.value);
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        undoKeys(e, props.undo);
      }}
    />
  );
}

/**
 * «To-do» (ADR-0006 item 4, ☑ Q-15-9): simple ticks, not Strata's tasks.
 * `Enter` adds an item below, `Backspace` on an empty one removes it, the
 * arrows walk the items; the widget's own undo while the focus is in it.
 */
function TodoWidget(props: { locale: Locale; doc: LoroDoc; id: string; undo: UndoManager }) {
  const { doc, id, locale } = props;
  const items: TodoItem[] = useDoc(doc, () => todoItems(doc, id));
  const list = useRef<HTMLUListElement>(null);
  const focusAt = (i: number) =>
    requestAnimationFrame(() =>
      list.current?.querySelectorAll<HTMLInputElement>('.board-todo-text')[i]?.focus(),
    );
  const key = (e: KeyboardEvent<HTMLInputElement>, i: number) => {
    e.stopPropagation();
    if (undoKeys(e, props.undo)) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      addTodo(doc, id, i + 1);
      focusAt(i + 1);
    } else if (e.key === 'Backspace' && e.currentTarget.value === '' && items.length > 0) {
      e.preventDefault();
      removeTodo(doc, id, i);
      focusAt(Math.max(0, i - 1));
    } else if (e.key === 'ArrowUp' && i > 0) {
      e.preventDefault();
      focusAt(i - 1);
    } else if (e.key === 'ArrowDown' && i < items.length - 1) {
      e.preventDefault();
      focusAt(i + 1);
    }
  };
  return (
    <div className="board-widget-todo">
      <ul ref={list} className="board-todo-list">
        {items.map((item, i) => (
          // Items have no ids of their own: their place is their key.
          // biome-ignore lint/suspicious/noArrayIndexKey: a to-do's items are addressed by place
          <li key={i} className={item.done ? 'board-todo is-done' : 'board-todo'}>
            <label className="check">
              <input
                type="checkbox"
                checked={item.done}
                aria-label={t(locale, 'widget.todo.done', { text: item.text })}
                onChange={(e) => setTodoDone(doc, id, i, e.currentTarget.checked)}
              />
            </label>
            <input
              className="board-todo-text"
              value={item.text}
              placeholder={t(locale, 'widget.todo.placeholder')}
              aria-label={t(locale, 'widget.todo.item', { n: i + 1 })}
              spellCheck={false}
              onChange={(e) => setTodoText(doc, id, i, e.currentTarget.value)}
              onKeyDown={(e) => key(e, i)}
            />
          </li>
        ))}
      </ul>
      {items.length === 0 ? (
        <button
          type="button"
          className="board-todo-first"
          title={t(locale, 'widget.todo.first')}
          onClick={() => {
            addTodo(doc, id, 0);
            focusAt(0);
          }}
        >
          {t(locale, 'widget.todo.first')}
        </button>
      ) : null}
    </div>
  );
}

/** A widget's face on the board (ADR-0006 item 4): Strata's Chrome, the board's content. */
export function BoardWidget(props: {
  locale: Locale;
  doc: LoroDoc;
  id: string;
  kind: WidgetKind;
  undo: UndoManager;
}) {
  return (
    <div className="board-widget" data-widget={props.kind}>
      {props.kind === 'note' ? <NoteWidget {...props} /> : <TodoWidget {...props} />}
    </div>
  );
}
