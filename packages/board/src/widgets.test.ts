import { LoroDoc } from 'loro-crdt';
import { describe, expect, it } from 'vitest';
import {
  addTodo,
  createWidget,
  moveTodo,
  parseWidgetLink,
  removeTodo,
  setNoteText,
  setTodoDone,
  setTodoText,
  todoItems,
  widgetKind,
  widgetLink,
  widgetText,
} from './widgets';

// Crockford's base32 has no I, L, O or U.
const WS = `01JBR${'0'.repeat(17)}WS01`;
const BOARD = `01JBR${'0'.repeat(17)}BD01`;
const NOTE = `01JBR${'0'.repeat(17)}NT01`;
const TODO = `01JBR${'0'.repeat(17)}TD01`;

/** Two peers that send each other what they did. */
function peers(): [LoroDoc, LoroDoc] {
  const a = new LoroDoc();
  a.setPeerId(1n);
  const b = new LoroDoc();
  b.setPeerId(2n);
  return [a, b];
}
const sync = (from: LoroDoc, to: LoroDoc) => to.import(from.export({ mode: 'update' }));

describe('the board widgets (ADR-0006 item 4)', () => {
  it("read a widget's link and no other (05 §9.4)", () => {
    const link = widgetLink(WS, BOARD, NOTE);
    expect(link).toBe(`strata://${WS}/widget/${BOARD}/${NOTE}`);
    expect(parseWidgetLink(link)).toEqual({ workspace: WS, board: BOARD, widget: NOTE });
    for (const bad of [
      'https://example.org/embed',
      `strata://${WS}/n/${NOTE}`,
      `strata://${WS}/widget/${BOARD}`,
      `strata://${WS}/widget/${BOARD}/${NOTE}/x`,
      `strata://${WS.toLowerCase()}/widget/${BOARD}/${NOTE}`,
      null,
    ]) {
      expect(parseWidgetLink(bad), String(bad)).toBeNull();
    }
  });

  it('keep a note whose text two peers type merges by character', () => {
    const [a, b] = peers();
    createWidget(a, NOTE, 'note');
    setNoteText(a, NOTE, 'Удар');
    sync(a, b);
    expect(widgetKind(b, NOTE)).toBe('note');
    setNoteText(a, NOTE, 'Удар мечом');
    setNoteText(b, NOTE, 'Сильный удар');
    sync(a, b);
    sync(b, a);
    expect(widgetText(a, NOTE)).toBe(widgetText(b, NOTE));
    expect(widgetText(a, NOTE)).toContain('мечом');
    expect(widgetText(a, NOTE)).toContain('Сильный');
  });

  it('keep a to-do of simple ticks: add, tick, retype, move, remove', () => {
    const [a, b] = peers();
    createWidget(a, TODO, 'todo');
    addTodo(a, TODO, 0, 'Молоко');
    addTodo(a, TODO, 1, 'Хлеб');
    addTodo(a, TODO, 9, 'Сыр');
    setTodoDone(a, TODO, 1, true);
    expect(todoItems(a, TODO)).toEqual([
      { done: false, text: 'Молоко' },
      { done: true, text: 'Хлеб' },
      { done: false, text: 'Сыр' },
    ]);
    sync(a, b);
    // Both peers at once: a renames the first, b ticks it; both stay.
    setTodoText(a, TODO, 0, 'Молоко 2 л');
    setTodoDone(b, TODO, 0, true);
    sync(a, b);
    sync(b, a);
    expect(todoItems(a, TODO)).toEqual(todoItems(b, TODO));
    expect(todoItems(a, TODO)[0]).toEqual({ done: true, text: 'Молоко 2 л' });
    moveTodo(a, TODO, 2, 0);
    expect(todoItems(a, TODO).map((i) => i.text)).toEqual(['Сыр', 'Молоко 2 л', 'Хлеб']);
    removeTodo(a, TODO, 1);
    expect(widgetText(a, TODO)).toBe('- [ ] Сыр\n- [x] Хлеб');
  });

  it('make each edit one commit of their own origin, for their own undo (10 §9.2)', () => {
    const doc = new LoroDoc();
    const origins: (string | undefined)[] = [];
    doc.subscribe((e) => origins.push(e.origin));
    createWidget(doc, NOTE, 'note');
    setNoteText(doc, NOTE, 'a');
    setNoteText(doc, NOTE, 'a');
    expect(origins).toEqual(['board:widget', 'board:widget']);
  });
});
