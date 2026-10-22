import { type GraphNode, newNode } from '@strata/backend';
import { describe, expect, it } from 'vitest';
import { controls } from './curve';
import {
  arrowOn,
  dotColor,
  levelOf,
  nodeAlpha,
  over,
  type RimMark,
  rimSlot,
  socketAt,
  statusGlyph,
} from './looks';

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

  it('puts the input socket on the line of centres, facing the source (07 §5)', () => {
    const target = { x: 0, y: 0, r: 16 };
    expect(socketAt(target, { x: 0, y: -100, r: 16 })).toEqual({ dx: 0, dy: -1 });
    const p = socketAt(target, { x: 30, y: 40, r: 8 });
    expect(p?.dx).toBeCloseTo(0.6);
    expect(p?.dy).toBeCloseTo(0.8);
    // Overlapping bubbles: no wire to show, no socket.
    expect(socketAt(target, { x: 20, y: 0, r: 8 })).toBeNull();
  });

  it('points the arrowhead along the last stretch of the wire (07 §5)', () => {
    // Straight down: the tip on the target's rim, pointing down.
    const down = controls({ ax: 0, ay: 0, bx: 0, by: 200, ra: 16, rb: 16 });
    const a = arrowOn(down, 1, 10);
    expect(a?.x).toBeCloseTo(0);
    expect(a?.y).toBeCloseTo(184);
    expect(a?.dx).toBeCloseTo(0);
    expect(a?.dy).toBeCloseTo(1);
    // Sideways the S-curve still arrives from above: the arrow follows it,
    // not the line of centres.
    const side = controls({ ax: 0, ay: 0, bx: 200, by: 0, ra: 16, rb: 16 });
    const b = arrowOn(side, 1, 10);
    expect(b?.x).toBeCloseTo(184);
    expect(b?.dy ?? 0).toBeGreaterThan(0.5);
    // The midway arrow sits on the curve at 60 %.
    expect(arrowOn(down, 0.6, 8)?.y).toBeGreaterThan(100);
    // A wire shorter than the arrow carries none.
    expect(arrowOn(controls({ ax: 0, ay: 0, bx: 0, by: 36, ra: 16, rb: 16 }), 1, 10)).toBeNull();
  });

  it('moves a rim glyph off a wire end to the nearest free half hour (07 §4.7 rule 5)', () => {
    const hourAngle = (h: number) => (h / 12) * Math.PI * 2 - Math.PI / 2;
    // A free rim: the glyph keeps its hour.
    expect(rimSlot(6, 6, [], 20, 1)).toBeCloseTo(hourAngle(6));
    // A socket right at 6 o'clock: the kind glyph steps half an hour clockwise.
    const taken: RimMark[] = [{ angle: hourAngle(6), reach: 4 }];
    expect(rimSlot(6, 6, taken, 60, 1)).toBeCloseTo(hourAngle(6.5));
    // The next glyph wanted there finds the other side.
    expect(rimSlot(6, 6, taken, 60, 1)).toBeCloseTo(hourAngle(5.5));
    // A small bubble needs a longer step: half an hour is too short an arc at r = 40.
    expect(rimSlot(6, 6, [{ angle: hourAngle(6), reach: 4 }], 40, 1)).toBeCloseTo(hourAngle(7));
    // Nothing free within two hours: the glyph keeps its hour.
    const full: RimMark[] = [{ angle: hourAngle(6), reach: 200 }];
    expect(rimSlot(6, 6, full, 20, 1)).toBeCloseTo(hourAngle(6));
  });

  it('blends a dimmed mark into one opaque colour', () => {
    expect(over(0x000000, 0xffffff, 0.4)).toBe(0x666666);
    expect(over(0x102030, 0x102030, 0.5)).toBe(0x102030);
    expect(over(0x000000, 0xff8000, 1)).toBe(0xff8000);
  });
});
