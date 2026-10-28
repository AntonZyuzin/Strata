import { describe, expect, it } from 'vitest';
import { FRAME_U, onTheWay, RING_FLAGS, ringSlots, SLOT_U, slotAt } from './flagring';

describe('the flag ring (06 §8, 07 §4.8)', () => {
  it('is a row over the bubble, 28 px up at least, a slot per flag from the left', () => {
    const slots = ringSlots(100, 100, 1, 1);
    expect(slots.map((s) => s.flag)).toEqual([...RING_FLAGS]);
    for (const s of slots) expect(s.y).toBeCloseTo(100 - 28, 5);
    // Centred on the bubble: the middle one straight above it.
    const [first, mid, last] = slots;
    expect(mid?.x).toBeCloseTo(100, 5);
    expect((first?.x ?? 0) + (last?.x ?? 0)).toBeCloseTo(200, 5);
  });

  it("keeps a gap between the slots and over the selection's corners (owner, 2026-10-28)", () => {
    for (const [R, u] of [
      [10, 1],
      [20, 1],
      [60, 1],
      [60, 2],
    ] as const) {
      const slots = ringSlots(0, 0, R, u);
      for (let i = 1; i < slots.length; i++) {
        const a = slots[i - 1];
        const b = slots[i];
        expect((b?.x ?? 0) - (a?.x ?? 0) - SLOT_U * u).toBeCloseTo(6 * u, 5);
        expect(b?.y).toBe(a?.y);
      }
      // A slot's bottom stays 6u above the corners at R + 12u, which the
      // hover ring's top corner never passes.
      for (const s of slots) {
        expect(-(s.y + (SLOT_U / 2) * u)).toBeGreaterThanOrEqual(R + (FRAME_U + 6) * u - 1e-9);
      }
    }
  });

  it('stays up on the way from the bubble to it, not beside it or below', () => {
    const slots = ringSlots(0, 0, 20, 1);
    const [first, , last] = slots;
    if (!first || !last) throw new Error('no slot');
    expect(onTheWay(slots, 0, 0, -10, 1)).toBe(true);
    expect(onTheWay(slots, 0, first.x, first.y, 1)).toBe(true);
    expect(onTheWay(slots, 0, last.x + 20, first.y, 1)).toBe(false);
    expect(onTheWay(slots, 0, 0, 10, 1)).toBe(false);
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
