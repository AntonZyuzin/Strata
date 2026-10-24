import { describe, expect, it } from 'vitest';
import { JITTER_CYCLES, JITTER_MS, JITTER_PX, Kinetics, MAX_ACTIVE } from './kinetic';

/** Control points of a straight horizontal wire from x0 to x1. */
const wire = (x0: number, x1: number) => [
  x0,
  0,
  x0 + (x1 - x0) / 3,
  0,
  x1 - (x1 - x0) / 3,
  0,
  x1,
  0,
];

describe('kinetic wires (06 §6.8)', () => {
  it('lag behind a moved end and settle in 200–300 ms without overshoot', () => {
    const k = new Kinetics();
    k.bind(['a']);
    let now = 1000;
    k.frame(now);
    expect(k.follow(0, wire(0, 300), 1)).toBeNull();
    // The target end jumps 90 to the right: the curve stays where it was drawn.
    const moved = wire(0, 390);
    let lag = 0;
    const seen: number[] = [];
    for (let f = 0; f < 30; f++) {
      now += 16;
      k.frame(now);
      const kick = k.follow(0, moved, 1);
      lag = kick ? (kick[0] ?? 0) : 0;
      seen.push(lag);
    }
    // It started behind the target (negative x) and never went past it.
    expect(seen[0]).toBeLessThan(-20);
    expect(Math.max(...seen)).toBeLessThanOrEqual(0);
    // Still from about 300 ms on; it was moving at 160 ms.
    expect(seen[19]).toBe(0);
    expect(lag).toBe(0);
    expect(Math.abs(seen[9] ?? 0)).toBeGreaterThan(0.25);
    expect(k.moving).toBe(false);
  });

  it('jitter three cycles of 0.8 s after selection, then stand', () => {
    const k = new Kinetics();
    k.bind(['a']);
    k.frame(1000);
    k.follow(0, wire(0, 300), 2);
    k.shake('a');
    k.frame(1000 + JITTER_MS / 4);
    const kick = k.follow(0, wire(0, 300), 2);
    // A quarter period in: the full swing, across the wire, half as many world units at zoom 2.
    expect(kick?.[1]).toBeCloseTo(JITTER_PX / 2);
    expect(kick?.[3]).toBeCloseTo(-JITTER_PX / 2);
    k.frame(1000 + JITTER_MS * JITTER_CYCLES);
    expect(k.follow(0, wire(0, 300), 2)).toBeNull();
    expect(k.moving).toBe(false);
  });

  it(`moves at most ${MAX_ACTIVE} wires at once and keeps them across a new wire list`, () => {
    const k = new Kinetics();
    const keys = Array.from({ length: MAX_ACTIVE + 10 }, (_, i) => `w${i}`);
    k.bind(keys);
    k.frame(1000);
    for (let i = 0; i < keys.length; i++) k.follow(i, wire(0, 300), 1);
    k.frame(1016);
    const moving = keys.filter((_, i) => k.follow(i, wire(0, 400), 1) !== null);
    expect(moving.length).toBe(MAX_ACTIVE);
    // A step rebuilds the list (a new wire first): the moving ones keep moving.
    k.bind(['new', ...keys]);
    k.frame(1032);
    expect(k.follow(1, wire(0, 400), 1)).not.toBeNull();
    expect(k.kickOf('w0')).not.toBeNull();
  });
});
