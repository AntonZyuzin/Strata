import type { Flag } from '@strata/backend';

/**
 * The flag ring (06 §8, 07 §4.8): over a bubble the cursor rests on, a row
 * of a fixed screen size — 28 px from its centre at least — with a slot per
 * flag on an ink plate; a flag that is on inverts its slot. A click on a
 * slot switches the flag, on the selection when the bubble is in it. Holding
 * `Ctrl` hides the ring when it covers a neighbour. «Скрыть от AI» joins the
 * slots with MCP (16 §4.5); the info card's `i` comes with the info card.
 */

/** The ring's flags, left to right. */
export const RING_FLAGS = ['key', 'pause', 'template'] as const satisfies readonly Flag[];

/** The ring shows after the cursor has rested this long (07 §4.5 «Наведение»). */
export const RING_DELAY_MS = 150;

/** A slot's side in pixel units (07 §4.8). */
export const SLOT_U = 16;

/**
 * The selection's corners around a bubble, R + this many pixel units from its
 * centre each way (07 §4.5); the hover ring's top corner stays inside them.
 */
export const FRAME_U = 12;

/** Room between the frame and the slots and between two slots, pixel units (owner: air). */
const GAP_U = 6;

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
 * `u` CSS px to a pixel unit: a row above the selection's corners, a gap clear
 * of them and between the slots, centred on the bubble — the arc of half past
 * ten ran through the corners of a small bubble and its slots touched (owner,
 * 2026-10-28). 28 px from the centre at least (06 §8).
 */
export function ringSlots(sx: number, sy: number, R: number, u: number): RingSlot[] {
  const y = sy - Math.max(28, R + (FRAME_U + GAP_U + SLOT_U / 2) * u);
  const step = (SLOT_U + GAP_U) * u;
  return RING_FLAGS.map((flag, i) => ({
    flag,
    x: sx + (i - (RING_FLAGS.length - 1) / 2) * step,
    y,
  }));
}

/**
 * On the way from a bubble whose centre is at screen height `sy` up to its
 * slots: the band over the row's width from its top down to that centre. The
 * ring stays there.
 */
export function onTheWay(
  slots: readonly RingSlot[],
  sy: number,
  x: number,
  y: number,
  u: number,
): boolean {
  const first = slots[0];
  const last = slots[slots.length - 1];
  if (!first || !last) return false;
  const half = Math.max((SLOT_U / 2) * u, TARGET_PX / 2);
  return x >= first.x - half && x <= last.x + half && y >= first.y - half && y <= sy;
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
