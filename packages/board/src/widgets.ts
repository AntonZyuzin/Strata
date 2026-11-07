import { type LoroDoc, LoroMap, LoroMovableList, LoroText } from 'loro-crdt';

/**
 * The board's widgets (ADR-0006 item 4, ✅ C2): «Заметка» and «To-do» —
 * Strata's own components in Excalidraw's `embeddable` elements. The
 * element keeps the geometry, the layer and the frame (`elements`, merged
 * last writer per element); the content lives here, in the board's content
 * document, merged character by character:
 *
 * - `widgets`: a LoroMap of widget id → a LoroMap with `kind` and either
 *   `text` (a note: a LoroText) or `items` (a to-do: a LoroMovableList of
 *   LoroMaps `{ done, text: LoroText }`, simple ticks, not Strata's tasks,
 *   ☑ Q-15-9).
 * - An element finds its widget by its link,
 *   `strata://<workspace-id>/widget/<board-id>/<widget-id>` (05 §9.4): the
 *   board lets no other link into an embeddable.
 * - Every edit is one commit with the origin `WIDGET`: the widget's own
 *   undo (Loro's UndoManager) takes those and leaves the scene's to
 *   Excalidraw's.
 */

export type WidgetKind = 'note' | 'todo';
export const WIDGET_KINDS: readonly WidgetKind[] = ['note', 'todo'];

/** Origin of the widgets' commits (10 §9.2): their undo takes these only. */
export const WIDGET = 'board:widget';

/** An id of 05 §4.1: 26 characters of Crockford's base32. */
const ID = '[0-9A-HJKMNP-TV-Z]{26}';
const LINK = new RegExp(`^strata://(${ID})/widget/(${ID})/(${ID})$`);

/** A widget's link (05 §9.4). */
export function widgetLink(workspace: string, board: string, widget: string): string {
  return `strata://${workspace}/widget/${board}/${widget}`;
}

/** The workspace, board and widget of a widget's link; null for any other link. */
export function parseWidgetLink(
  link: string | null | undefined,
): { workspace: string; board: string; widget: string } | null {
  const m = link ? LINK.exec(link) : null;
  if (!m?.[1] || !m[2] || !m[3]) return null;
  return { workspace: m[1], board: m[2], widget: m[3] };
}

export function widgetsOf(doc: LoroDoc): LoroMap {
  return doc.getMap('widgets');
}

function widgetMap(doc: LoroDoc, id: string): LoroMap | null {
  const w = widgetsOf(doc).get(id);
  return w instanceof LoroMap ? w : null;
}

/** A widget's kind; null when the document has none by that id. */
export function widgetKind(doc: LoroDoc, id: string): WidgetKind | null {
  const k = widgetMap(doc, id)?.get('kind');
  return k === 'note' || k === 'todo' ? k : null;
}

/** A new widget of `kind`, empty: one commit. A widget by that id already is kept. */
export function createWidget(doc: LoroDoc, id: string, kind: WidgetKind): void {
  if (widgetMap(doc, id)) return;
  const w = widgetsOf(doc).setContainer(id, new LoroMap());
  w.set('kind', kind);
  if (kind === 'note') w.setContainer('text', new LoroText());
  else w.setContainer('items', new LoroMovableList());
  doc.commit({ origin: WIDGET });
}

/** A note's text (a LoroText); null for a to-do or none. */
export function noteText(doc: LoroDoc, id: string): LoroText | null {
  const t = widgetMap(doc, id)?.get('text');
  return t instanceof LoroText ? t : null;
}

/** A note's text as typed: the change merges by character (`LoroText.update`). One commit. */
export function setNoteText(doc: LoroDoc, id: string, text: string): void {
  const t = noteText(doc, id);
  if (!t || t.toString() === text) return;
  t.update(text);
  doc.commit({ origin: WIDGET });
}

export interface TodoItem {
  done: boolean;
  text: string;
}

function itemsOf(doc: LoroDoc, id: string): LoroMovableList | null {
  const l = widgetMap(doc, id)?.get('items');
  return l instanceof LoroMovableList ? l : null;
}

function itemAt(list: LoroMovableList, at: number): LoroMap | null {
  const m = list.get(at);
  return m instanceof LoroMap ? m : null;
}

/** A to-do's items, in order. */
export function todoItems(doc: LoroDoc, id: string): TodoItem[] {
  const list = itemsOf(doc, id);
  if (!list) return [];
  const out: TodoItem[] = [];
  for (let i = 0; i < list.length; i++) {
    const m = itemAt(list, i);
    if (!m) continue;
    const t = m.get('text');
    out.push({ done: m.get('done') === true, text: t instanceof LoroText ? t.toString() : '' });
  }
  return out;
}

/** A new item at `at` (the end when past it), with `text`: one commit. */
export function addTodo(doc: LoroDoc, id: string, at: number, text = ''): void {
  const list = itemsOf(doc, id);
  if (!list) return;
  const m = list.insertContainer(Math.max(0, Math.min(at, list.length)), new LoroMap());
  m.set('done', false);
  const t = m.setContainer('text', new LoroText());
  if (text) t.insert(0, text);
  doc.commit({ origin: WIDGET });
}

/** An item ticked or not: one commit. */
export function setTodoDone(doc: LoroDoc, id: string, at: number, done: boolean): void {
  const list = itemsOf(doc, id);
  const m = list ? itemAt(list, at) : null;
  if (!m || (m.get('done') === true) === done) return;
  m.set('done', done);
  doc.commit({ origin: WIDGET });
}

/** An item's text as typed, merged by character: one commit. */
export function setTodoText(doc: LoroDoc, id: string, at: number, text: string): void {
  const list = itemsOf(doc, id);
  const t = list ? itemAt(list, at)?.get('text') : null;
  if (!(t instanceof LoroText) || t.toString() === text) return;
  t.update(text);
  doc.commit({ origin: WIDGET });
}

/** An item gone: one commit. */
export function removeTodo(doc: LoroDoc, id: string, at: number): void {
  const list = itemsOf(doc, id);
  if (!list || at < 0 || at >= list.length) return;
  list.delete(at, 1);
  doc.commit({ origin: WIDGET });
}

/** An item moved to `to`: one commit. */
export function moveTodo(doc: LoroDoc, id: string, from: number, to: number): void {
  const list = itemsOf(doc, id);
  if (!list || from === to || from < 0 || from >= list.length) return;
  list.move(from, Math.max(0, Math.min(to, list.length - 1)));
  doc.commit({ origin: WIDGET });
}

/**
 * What a widget says, as text (13 §2.8, ADR-0006): a note's text; a
 * to-do's items as a Markdown checklist. For export and the core's links.
 */
export function widgetText(doc: LoroDoc, id: string): string {
  const kind = widgetKind(doc, id);
  if (kind === 'note') return noteText(doc, id)?.toString() ?? '';
  if (kind === 'todo') {
    return todoItems(doc, id)
      .map((i) => `- [${i.done ? 'x' : ' '}] ${i.text}`)
      .join('\n');
  }
  return '';
}
