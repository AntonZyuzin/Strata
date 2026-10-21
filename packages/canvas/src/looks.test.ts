import { type GraphNode, newNode } from '@strata/backend';
import { describe, expect, it } from 'vitest';
import { dotColor, levelOf, nodeAlpha, statusGlyph } from './looks';

const node = (over: Partial<GraphNode> = {}) =>
  newNode({ id: 'a', name: 'a', kind: 'note', cls: null, icon: 0, x: 0, y: 0, ...over });

describe('looks of bubbles (07 §4.5–4.9)', () => {
  it('switches levels at 12, 32 and 96 px of diameter', () => {
    expect([11.9, 12, 31.9, 32, 96, 96.1].map(levelOf)).toEqual([
      'dot',
      'glyph',
      'glyph',
      'icon',
      'icon',
      'full',
    ]);
  });

  it('takes the lowest alpha of the states (07 §4.7 rule 3)', () => {
    expect(nodeAlpha(node())).toBe(1);
    expect(nodeAlpha(node({ pause: true }))).toBe(0.6);
    expect(nodeAlpha(node({ ghost: true, pause: true }))).toBe(0.5);
    expect(nodeAlpha(node({ status: 'done', ghost: true }))).toBe(0.4);
  });

  it('colours a far dot by the main state', () => {
    expect(dotColor(node())).toBe(0xf2efe6);
    expect(dotColor(node({ due: 'today' }))).toBe(0xe8c547);
    expect(dotColor(node({ due: 'overdue' }))).toBe(0xd64545);
    expect(dotColor(node({ due: 'overdue', status: 'done' }))).toBe(0x9a9a9a);
  });

  it('puts one status glyph at 4–5 o’clock: final status, deadline, burning roll-up', () => {
    expect(statusGlyph(node())).toBeNull();
    expect(statusGlyph(node({ status: 'done', due: 'overdue' }))).toEqual(['check', 'ink']);
    expect(statusGlyph(node({ status: 'cancelled' }))).toEqual(['dash', 'ink']);
    expect(statusGlyph(node({ due: 'overdue' }))).toEqual(['bang', 'overdue']);
    expect(statusGlyph(node({ due: 'soon' }))).toEqual(['hourglass', 'attention']);
    expect(statusGlyph(node({ due: 'far' }))).toBeNull();
    const fold = { done: 1, total: 3, burning: 'soon' as const };
    expect(statusGlyph(node({ kind: 'network', fold }))).toEqual(['clock', 'attention']);
  });
});
