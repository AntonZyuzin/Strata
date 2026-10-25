import { describe, expect, it } from 'vitest';
import { RING_FLAGS, ringSlots, SLOT_U, slotAt } from './flagring';

describe('the flag ring (06 §8, 07 §4.8)', () => {
  it('has a radius of 28 px at least, a slot per flag, clockwise from the left', () => {
    const slots = ringSlots(100, 100, 1, 1);
    expect(slots.map((s) => s.flag)).toEqual([...RING_FLAGS]);
    for (const s of slots) expect(Math.hypot(s.x - 100, s.y - 100)).toBeCloseTo(28, 5);
    // Upper left, the middle one at half past ten.
    const [, mid] = slots;
    expect(mid?.x).toBeLessThan(100);
    expect(mid?.y).toBeLessThan(100);
    expect(Math.abs((mid?.x ?? 0) - 100)).toBeCloseTo(Math.abs((mid?.y ?? 0) - 100), 5);
  });

  it('keeps the slots a slot and a gap apart, clear of a big bubble', () => {
    for (const [R, u] of [
      [10, 1],
      [60, 1],
      [60, 2],
    ] as const) {
      const slots = ringSlots(0, 0, R, u);
      for (let i = 1; i < slots.length; i++) {
        const a = slots[i - 1];
        const b = slots[i];
        expect(Math.hypot((b?.x ?? 0) - (a?.x ?? 0), (b?.y ?? 0) - (a?.y ?? 0))).toBeCloseTo(
          (SLOT_U + 4) * u,
          5,
        );
      }
      // A slot's nearest corner clears the hover ring's corners at R + 11.5u.
      for (const s of slots) {
        expect(Math.hypot(s.x, s.y) - Math.SQRT2 * (SLOT_U / 2) * u).toBeGreaterThan(R + 11.5 * u);
      }
    }
  });

  it('takes a click 24 px wide at least, the nearest slot first', () => {
    const slots = ringSlots(0, 0, 4, 1);
    const [first] = slots;
    if (!first) throw new Error('no slot');
    expect(slotAt(slots, first.x + 11, first.y, 1)?.flag).toBe('key');
    expect(slotAt(slots, first.x - 13, first.y, 1)).toBeNull();
    expect(slotAt(slots, 0, 0, 1)).toBeNull();
  });
});
