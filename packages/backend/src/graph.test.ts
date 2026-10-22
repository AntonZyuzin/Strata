import { describe, expect, it } from 'vitest';
import {
  canInsert,
  downstream,
  extract,
  Graph,
  type GraphNode,
  insertIntoWire,
  newNode,
  shake,
  UNDO_DEPTH,
} from './graph';
import { newId } from './ids';
import { GALLERY_SIZE, seedGraph } from './seed';

const node = (id: string, x = 0, y = 0): GraphNode =>
  newNode({ id, name: id, kind: 'note', cls: null, icon: 0, x, y });

/** A graph with nodes a…h and the given wires, history cleared. */
function graph(wires: string[]): Graph {
  const g = new Graph();
  g.transaction({ key: 't' }, (tx) => {
    for (const id of 'abcdefgh') tx.add(node(id));
    for (const w of wires) tx.connect(w[0] ?? '', w[1] ?? '');
  });
  g.clearHistory();
  return g;
}

const wires = (g: Graph) =>
  g
    .edges()
    .map(([a, b]) => a + b)
    .sort();

describe('wire rules (05 §8.2)', () => {
  it('forbids a self-loop', () => {
    const g = graph([]);
    g.transaction({ key: 't' }, (tx) => expect(tx.connect('a', 'a')).toBe(false));
    expect(g.edges()).toEqual([]);
  });

  it('keeps at most one wire per ordered pair, but allows both directions (cycles)', () => {
    const g = graph(['ab']);
    g.transaction({ key: 't' }, (tx) => {
      expect(tx.connect('a', 'b')).toBe(false);
      expect(tx.connect('b', 'a')).toBe(true);
    });
    expect(wires(g)).toEqual(['ab', 'ba']);
  });

  it('walks downstream through cycles', () => {
    expect([...downstream(graph(['ab', 'bc', 'ca', 'cd']), 'b')].sort()).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
  });
});

describe('insert into a wire (05 §8.4)', () => {
  it('replaces A → B by A → X → B', () => {
    const g = graph(['ab']);
    g.transaction({ key: 't' }, (tx) => expect(insertIntoWire(g, tx, 'c', 'a', 'b')).toBe(true));
    expect(wires(g)).toEqual(['ac', 'cb']);
  });

  it('requires a node without wires', () => {
    const g = graph(['ab', 'cd']);
    expect(canInsert(g, 'c')).toBe(false);
    g.transaction({ key: 't' }, (tx) => expect(insertIntoWire(g, tx, 'c', 'a', 'b')).toBe(false));
    expect(wires(g)).toEqual(['ab', 'cd']);
  });
});

describe('shake (05 §8.4, ✅ D1)', () => {
  it('heals a chain through a node with one input', () => {
    const g = graph(['ax', 'xb', 'xc'].map((w) => w.replace('x', 'd')));
    const r = g.transaction({ key: 't' }, (tx) =>
      expect(shake(g, tx, 'd')).toEqual({ inputs: 1, healed: true }),
    );
    expect(r).not.toBeNull();
    expect(wires(g)).toEqual(['ab', 'ac']);
  });

  it('only disconnects a node with two inputs', () => {
    const g = graph(['ad', 'bd', 'dc']);
    g.transaction({ key: 't' }, (tx) =>
      expect(shake(g, tx, 'd')).toEqual({ inputs: 2, healed: false }),
    );
    expect(wires(g)).toEqual([]);
  });

  it('skips a loop and an existing pair when healing', () => {
    const g = graph(['ad', 'da', 'db', 'ab']);
    g.transaction({ key: 't' }, (tx) => shake(g, tx, 'd'));
    expect(wires(g)).toEqual(['ab']);
  });
});

describe('extract a set (Mod+Shift+X)', () => {
  it('connects the single external source to the external targets and keeps inner wires', () => {
    const g = graph(['ab', 'bc', 'cd', 'ce']);
    g.transaction({ key: 't' }, (tx) => expect(extract(g, tx, ['b', 'c']).healed).toBe(true));
    expect(wires(g)).toEqual(['ad', 'ae', 'bc']);
  });

  it('only disconnects with two external sources', () => {
    const g = graph(['ac', 'bc', 'cd']);
    g.transaction({ key: 't' }, (tx) => expect(extract(g, tx, ['c']).inputs).toBe(2));
    expect(wires(g)).toEqual([]);
  });
});

describe('changesets and undo (06 §1.2)', () => {
  it('undoes and redoes a whole gesture in one step', () => {
    const g = graph(['ab']);
    g.transaction({ key: 'insert' }, (tx) => {
      tx.move('c', 10, 20);
      insertIntoWire(g, tx, 'c', 'a', 'b');
    });
    expect(g.undoLabel).toEqual({ key: 'insert' });
    g.undo();
    expect(wires(g)).toEqual(['ab']);
    expect(g.nodes.get('c')).toMatchObject({ x: 0, y: 0 });
    g.redo();
    expect(wires(g)).toEqual(['ac', 'cb']);
    expect(g.nodes.get('c')).toMatchObject({ x: 10, y: 20 });
  });

  it('restores a removed node with its wires', () => {
    const g = graph(['ab', 'bc']);
    g.transaction({ key: 'remove' }, (tx) => tx.remove('b'));
    expect(g.nodes.has('b')).toBe(false);
    g.undo();
    expect(wires(g)).toEqual(['ab', 'bc']);
  });

  it('records no step for a gesture that changed nothing', () => {
    const g = graph(['ab']);
    expect(g.transaction({ key: 't' }, (tx) => tx.connect('a', 'b'))).toBeNull();
    expect(g.canUndo).toBe(false);
  });

  it('rolls back a gesture that throws', () => {
    const g = graph([]);
    expect(() =>
      g.transaction({ key: 't' }, (tx) => {
        tx.connect('a', 'b');
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(g.edges()).toEqual([]);
  });

  it('keeps at most 200 steps', () => {
    const g = graph([]);
    for (let i = 0; i < UNDO_DEPTH + 5; i++)
      g.transaction({ key: 't' }, (tx) => tx.move('a', i + 1, 0));
    let steps = 0;
    while (g.undo()) steps++;
    expect(steps).toBe(UNDO_DEPTH);
  });
});

describe('ids and seed', () => {
  it('makes time-ordered 26-character ids', () => {
    const a = newId(1_760_000_000_000);
    const b = newId(1_760_000_000_000);
    const c = newId(1_760_000_000_001);
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect([a, b, c].sort()).toEqual([a, b, c]);
  });

  it('seeds about 200 nodes and 1.5 wires per node, without history', () => {
    const g = seedGraph();
    expect(g.nodes.size).toBe(200 + GALLERY_SIZE);
    expect(g.edges().length).toBeGreaterThan(200);
    expect(g.canUndo).toBe(false);
    expect([...g.nodes.keys()].some((id) => g.inputs(id).length >= 2)).toBe(true);
  });
});

describe('derived changes (05 §11, source system)', () => {
  it('applies wires from text without a step of undo', () => {
    const g = new Graph();
    g.transaction({ key: 't' }, (tx) => {
      tx.add(node('a', 0, 0));
      tx.add(node('b', 0, 100));
    });
    const cs = g.derive({ key: 'link' }, (tx) => tx.connect('a', 'b'));
    expect(cs?.source).toBe('system');
    expect(g.hasEdge('a', 'b')).toBe(true);
    expect(g.undoLabel).toEqual({ key: 't' });
    g.undo();
    expect(g.nodes.size).toBe(0);
  });
});
