import type { Flag } from '@strata/backend';

/**
 * The flag ring (06 §8, 07 §4.8): around a bubble the cursor rests on, a
 * ring of a fixed screen size — its radius 28 px at least — with a slot per
 * flag on an ink plate; a flag that is on inverts its slot. A click on a
 * slot switches the flag, on the selection when the bubble is in it. Holding
 * `Ctrl` hides the ring when it covers a neighbour. «Скрыть от AI» joins the
 * slots with MCP (16 §4.5); the info card's `i` comes with the info card.
 */

/** The ring's flags, clockwise. */
export const RING_FLAGS = ['key', 'pause', 'template'] as const satisfies readonly Flag[];

/** The ring shows after the cursor has rested this long (07 §4.5 «Наведение»). */
export const RING_DELAY_MS = 150;

/** A slot's side in pixel units (07 §4.8). */
export const SLOT_U = 16;

/** The smallest target of a pointer, CSS px (WCAG 2.5.8, 07 §11). */
const TARGET_PX = 24;

export interface RingSlot {
  flag: (typeof RING_FLAGS)[number];
  /** The slot's centre, screen px. */
  x: number;
  y: number;
}

/**
 * The slots around a bubble at screen (sx, sy) of screen circumradius `R`,
 * `u` CSS px to a pixel unit: on a circle clear of the rims and rings (07
 * §4.3), centred at half past ten, a slot and a 4u gap apart — the 10–11 o'clock
 * badges of the flags stay visible inside it.
 */
export function ringSlots(sx: number, sy: number, R: number, u: number): RingSlot[] {
  // The hover ring's corners reach R + 11.5u (07 §4.3 on a hexagon): a slot's
  // corner stays 3u beyond them.
  const radius = Math.max(28, R + (SLOT_U / 2 + 18) * u);
  const chord = (SLOT_U + 4) * u;
  const step = 2 * Math.asin(Math.min(1, chord / 2 / radius));
  // Half past ten: 10.5 / 12 of a turn from 12 o'clock, clockwise.
  const mid = (10.5 / 12) * Math.PI * 2 - Math.PI / 2;
  return RING_FLAGS.map((flag, i) => {
    const a = mid + (i - (RING_FLAGS.length - 1) / 2) * step;
    return { flag, x: sx + Math.cos(a) * radius, y: sy + Math.sin(a) * radius };
  });
}

/** The slot under a screen point: the nearest whose target holds it, 24 px at least. */
export function slotAt(
  slots: readonly RingSlot[],
  x: number,
  y: number,
  u: number,
): RingSlot | null {
  const half = Math.max((SLOT_U / 2) * u, TARGET_PX / 2);
  let best: RingSlot | null = null;
  let near = Number.POSITIVE_INFINITY;
  for (const s of slots) {
    if (Math.abs(x - s.x) > half || Math.abs(y - s.y) > half) continue;
    const d = Math.hypot(x - s.x, y - s.y);
    if (d < near) {
      near = d;
      best = s;
    }
  }
  return best;
}
