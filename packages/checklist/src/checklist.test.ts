import { LoroDoc, type TreeID, UndoManager } from 'loro-crdt';
import { describe, expect, it } from 'vitest';
import { Checklist, countOf, type Item, orderOf } from './checklist';

/** The list as an outline: one line per item, two spaces a level, `x` when ticked. */
function outline(items: Item[], depth = 0): string[] {
  return items.flatMap((x) => [
    `${'  '.repeat(depth)}[${x.done ? 'x' : ' '}] ${x.text}`,
    ...outline(x.items, depth + 1),
  ]);
}

function list(...texts: string[]): Checklist {
  const c = new Checklist(new LoroDoc());
  for (const t of texts) c.add(t);
  return c;
}

const ids = (c: Checklist) => orderOf(c.items()).map((x) => x.id);

describe('a list (05 §4.2, 10 §2.4)', () => {
  it('keeps items in order with their text and ticks', () => {
    const c = list('Хлеб', 'Молоко');
    const [a] = ids(c);
    c.setDone(a as TreeID, true);
    c.add('Сыр', undefined, 1);
    expect(outline(c.items())).toEqual(['[x] Хлеб', '[ ] Сыр', '[ ] Молоко']);
    expect(countOf(c.items())).toEqual({ done: 1, total: 3 });
  });

  it('nests items: Tab under the one above, Shift+Tab out after the parent', () => {
    const c = list('A', 'B', 'C');
    const [a, b, cc] = ids(c) as [TreeID, TreeID, TreeID];
    expect(c.indent(a)).toBe(false);
    expect(c.indent(b)).toBe(true);
    expect(c.indent(cc)).toBe(true);
    expect(outline(c.items())).toEqual(['[ ] A', '  [ ] B', '  [ ] C']);
    expect(c.indent(cc)).toBe(true);
    expect(outline(c.items())).toEqual(['[ ] A', '  [ ] B', '    [ ] C']);
    expect(c.outdent(b)).toBe(true);
    expect(outline(c.items())).toEqual(['[ ] A', '[ ] B', '  [ ] C']);
    expect(c.outdent(a)).toBe(false);
    // Children count at any depth.
    c.setDone(cc, true);
    expect(countOf(c.items())).toEqual({ done: 1, total: 3 });
  });

  it('moves an item among its siblings with Alt+↑ and Alt+↓', () => {
    const c = list('A', 'B', 'C');
    const [a, , cc] = ids(c) as [TreeID, TreeID, TreeID];
    expect(c.shift(a, -1)).toBe(false);
    expect(c.shift(a, 1)).toBe(true);
    expect(c.shift(cc, -1)).toBe(true);
    expect(outline(c.items())).toEqual(['[ ] B', '[ ] C', '[ ] A']);
    expect(c.shift(a, 1)).toBe(false);
  });

  it('splits an item at the caret on Enter', () => {
    const c = list('Хлебмолоко');
    const [a] = ids(c) as [TreeID];
    const caret = c.split(a, 4);
    expect(outline(c.items())).toEqual(['[ ] Хлеб', '[ ] молоко']);
    expect(caret).toEqual({ id: ids(c)[1], at: 0 });
    // At the end: an empty item below.
    c.split(caret.id, 'молоко'.length);
    expect(outline(c.items())).toEqual(['[ ] Хлеб', '[ ] молоко', '[ ] ']);
  });

  it('puts the new item first among the children of an item that has them', () => {
    const c = list('A', 'B');
    const [a, b] = ids(c) as [TreeID, TreeID];
    c.indent(b);
    const caret = c.split(a, 1);
    expect(outline(c.items())).toEqual(['[ ] A', '  [ ] ', '  [ ] B']);
    expect(ids(c)[1]).toBe(caret.id);
  });

  it('steps an empty nested item out on Enter instead of adding one', () => {
    const c = list('A', '');
    const [, b] = ids(c) as [TreeID, TreeID];
    c.indent(b);
    expect(c.split(b, 0)).toEqual({ id: b, at: 0 });
    expect(outline(c.items())).toEqual(['[ ] A', '[ ] ']);
  });

  it('joins an item into the one above on Backspace; its children stay', () => {
    const c = list('Хлеб', 'молоко', 'кефир');
    const [, b, k] = ids(c) as [TreeID, TreeID, TreeID];
    c.indent(k);
    expect(c.join(ids(c)[0] as TreeID)).toBeNull();
    const caret = c.join(b);
    expect(outline(c.items())).toEqual(['[ ] Хлебмолоко', '[ ] кефир']);
    expect(caret).toEqual({ id: ids(c)[0], at: 4 });
  });

  it('takes an item away; its children take its place', () => {
    const c = list('A', 'B', 'C', 'D');
    const [, b, cc, d] = ids(c) as [TreeID, TreeID, TreeID, TreeID];
    c.indent(cc);
    c.indent(d);
    c.remove(b);
    expect(outline(c.items())).toEqual(['[ ] A', '[ ] C', '[ ] D']);
  });

  it('takes every change back as one step of its undo', () => {
    const doc = new LoroDoc();
    const c = new Checklist(doc);
    const undo = new UndoManager(doc, { maxUndoSteps: 100, mergeInterval: 0 });
    const a = c.add('A');
    const b = c.add('B');
    c.indent(b);
    c.setDone(b, true);
    c.setText(a, 'AA');
    expect(outline(c.items())).toEqual(['[ ] AA', '  [x] B']);
    undo.undo();
    expect(outline(c.items())).toEqual(['[ ] A', '  [x] B']);
    undo.undo();
    expect(outline(c.items())).toEqual(['[ ] A', '  [ ] B']);
    undo.undo();
    expect(outline(c.items())).toEqual(['[ ] A', '[ ] B']);
    undo.redo();
    expect(outline(c.items())).toEqual(['[ ] A', '  [ ] B']);
  });

  it('two copies converge: concurrent moves keep one item, texts merge', () => {
    const one = new Checklist(new LoroDoc());
    one.doc.setPeerId(1n);
    const a = one.add('Хлеб');
    const b = one.add('Сыр');
    one.add('Чай');
    const two = new Checklist(new LoroDoc());
    two.doc.setPeerId(2n);
    two.doc.import(one.doc.export({ mode: 'snapshot' }));
    // One nests «Сыр» under «Хлеб», the other moves it down; both type in «Хлеб».
    one.indent(b);
    one.setText(a, 'Хлеб белый');
    two.shift(b, 1);
    two.setText(a, 'Хлеб, 2');
    two.setDone(a, true);
    one.doc.import(two.doc.export({ mode: 'update', from: one.doc.oplogVersion() }));
    two.doc.import(one.doc.export({ mode: 'update', from: two.doc.oplogVersion() }));
    expect(outline(one.items())).toEqual(outline(two.items()));
    const all = orderOf(one.items());
    expect(all.map((x) => x.id).filter((id) => id === b)).toHaveLength(1);
    expect(all.length).toBe(3);
    const bread = all.find((x) => x.id === a);
    expect(bread?.text).toContain('белый');
    expect(bread?.text).toContain(', 2');
    expect(bread?.done).toBe(true);
  });

  it('reads back from a snapshot, as the core keeps it', () => {
    const c = list('Один', 'Два');
    c.indent(ids(c)[1] as TreeID);
    const again = new Checklist(new LoroDoc());
    again.doc.import(c.doc.export({ mode: 'snapshot' }));
    expect(outline(again.items())).toEqual(['[ ] Один', '  [ ] Два']);
  });
});
