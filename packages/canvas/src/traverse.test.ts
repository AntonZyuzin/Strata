import { Graph, newNode } from '@strata/backend';
import { describe, expect, it } from 'vitest';
import {
  arrowStep,
  branchOf,
  chainStep,
  nearestInDirection,
  siblingStep,
  wireStep,
} from './traverse';

/** A network: `P` above, its outputs `A B C` left to right, `D` under `B`. */
function net(): Graph {
  const g = new Graph();
  g.transaction({ key: 't' }, (tx) => {
    const add = (id: string, x: number, y: number) =>
      tx.add(newNode({ id, name: id, kind: 'note', icon: 0, x, y }));
    add('P', 0, -200);
    add('A', -200, 0);
    add('B', 0, 0);
    add('C', 200, 0);
    add('D', 20, 200);
    add('Q', 600, -200);
    tx.connect('P', 'A');
    tx.connect('P', 'B');
    tx.connect('P', 'C');
    tx.connect('B', 'D');
    tx.connect('Q', 'B');
  });
  return g;
}

describe('walking the network from the keyboard (06 §10.3)', () => {
  it('the arrows go to the nearest node ahead, straight ahead first', () => {
    const g = net();
    expect(arrowStep(g, 'B', 'left', { x: 0, y: 0 })).toBe('A');
    expect(arrowStep(g, 'B', 'right', { x: 0, y: 0 })).toBe('C');
    expect(arrowStep(g, 'B', 'up', { x: 0, y: 0 })).toBe('P');
    expect(arrowStep(g, 'B', 'down', { x: 0, y: 0 })).toBe('D');
    // Nothing ahead: no step.
    expect(arrowStep(g, 'A', 'left', { x: 0, y: 0 })).toBeNull();
    // Nothing chosen: the node nearest to the middle of the screen.
    expect(arrowStep(g, null, 'right', { x: 190, y: 10 })).toBe('C');
    // A node far off to the side is not «ahead».
    expect(nearestInDirection({ x: 0, y: 0 }, 'right', [{ id: 'x', x: 10, y: 400 }])).toBeNull();
  });

  it('PgUp and PgDn go along the chain, Shift with them to the neighbours', () => {
    const g = net();
    // Two inputs: the one most above wins.
    expect(chainStep(g, 'B', true)).toBe('P');
    expect(chainStep(g, 'B', false)).toBe('D');
    expect(chainStep(g, 'D', false)).toBeNull();
    expect(siblingStep(g, 'B', false)).toBe('A');
    expect(siblingStep(g, 'B', true)).toBe('C');
    expect(siblingStep(g, 'C', true)).toBeNull();
    expect(siblingStep(g, 'P', true)).toBeNull();
  });

  it('no key lands on a ghost (05 §8.5)', () => {
    const g = net();
    g.derive({ key: 't' }, (tx) => {
      tx.add(
        newNode({
          id: '?g',
          name: 'Идея',
          kind: 'note',
          icon: 0,
          x: -100,
          y: 0,
          ghost: true,
          ghostOf: 'B',
        }),
      );
      tx.connect('B', '?g');
    });
    expect(arrowStep(g, 'B', 'left', { x: 0, y: 0 })).toBe('A');
    expect(chainStep(g, 'B', false)).toBe('D');
  });
});

describe('a branch and the wires of the current node (06 §11, §6.1)', () => {
  it('a branch up is the node and all that feeds it; down, all it feeds', () => {
    const g = net();
    expect(branchOf(g, 'B', true).sort()).toEqual(['B', 'P', 'Q']);
    expect(branchOf(g, 'B', false).sort()).toEqual(['B', 'D']);
    expect(branchOf(g, 'P', false).sort()).toEqual(['A', 'B', 'C', 'D', 'P']);
  });

  it('a branch walks each node once though the wires go round (05 §8.2)', () => {
    const g = net();
    g.transaction({ key: 't' }, (tx) => tx.connect('D', 'P'));
    expect(branchOf(g, 'B', false).sort()).toEqual(['A', 'B', 'C', 'D', 'P']);
  });

  it('Alt+PgDn takes the outgoing wires left to right, round to the first', () => {
    const g = net();
    const first = wireStep(g, 'P', true, null);
    expect(first).toEqual(['P', 'A']);
    const second = wireStep(g, 'P', true, first);
    expect(second).toEqual(['P', 'B']);
    expect(wireStep(g, 'P', true, ['P', 'C'])).toEqual(['P', 'A']);
    // Alt+PgUp: the incoming ones; none — none.
    expect(wireStep(g, 'B', false, null)).toEqual(['P', 'B']);
    expect(wireStep(g, 'B', false, ['P', 'B'])).toEqual(['Q', 'B']);
    expect(wireStep(g, 'P', false, null)).toBeNull();
  });
});
