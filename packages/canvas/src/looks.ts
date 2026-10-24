import type { GraphNode, NodeKind } from '@strata/backend';
import { fog, type GlyphName, hex, palette } from '@strata/design-tokens';
import { axisOf, pointAt } from './curve';
import type { Plate } from './textures';

/**
 * How a node looks, without drawing (07 §4.5–4.9): zoom level, alpha, far-dot
 * colour and the status glyph. Pure, so the rules are unit-tested; Decor and
 * the view apply them.
 */

/** Semantic zoom by the on-screen diameter (07 §4.9). */
export type Level = 'dot' | 'glyph' | 'icon' | 'full';

export function levelOf(d: number): Level {
  if (d < 12) return 'dot';
  if (d < 32) return 'glyph';
  return d <= 96 ? 'icon' : 'full';
}

export function isClosed(n: GraphNode): boolean {
  return n.status !== 'open';
}

/** Lowest alpha of the node's states: done 40 %, ghost 50 %, pause 60 % (07 §4.7 rule 3). */
export function nodeAlpha(n: GraphNode): number {
  let a = 1;
  if (isClosed(n)) a = Math.min(a, fog.scene.doneAlpha);
  if (n.ghost) a = Math.min(a, fog.scene.ghostAlpha);
  if (n.pause) a = Math.min(a, fog.scene.pauseAlpha);
  return a;
}

/** Colour of a far dot: its main state (07 §4.9). */
export function dotColor(n: GraphNode): number {
  if (isClosed(n)) return hex(palette.gray250);
  if (n.due === 'overdue') return hex(palette.red500);
  if (n.due === 'today' || n.due === 'soon') return hex(palette.yellow500);
  return hex(palette.paper);
}

/** The 4–5 o'clock glyph: final status, then deadline, then a burning roll-up (07 §4.5). */
export function statusGlyph(n: GraphNode): [GlyphName, Plate] | null {
  if (n.status === 'done') return ['check', 'ink'];
  if (n.status === 'cancelled') return ['dash', 'ink'];
  if (n.due === 'overdue') return ['bang', 'overdue'];
  if (n.due === 'today' || n.due === 'soon') return ['hourglass', 'attention'];
  if (n.fold?.burning === 'overdue') return ['bang', 'overdue'];
  if (n.fold?.burning === 'soon') return ['clock', 'attention'];
  return null;
}

interface Circle {
  x: number;
  y: number;
  r: number;
}

/**
 * How the ends of wires look (07 §5, ✅ S9 2026-10-23, Q-07-20): a solid
 * socket where a wire leaves its source, and where it enters its target a
 * hollow socket (`sockets`), an arrowhead (`arrow`), or a hollow socket with an
 * arrowhead midway along the wire (`both`).
 */
export type WireEndStyle = 'sockets' | 'arrow' | 'both';
export const WIRE_END_STYLES: WireEndStyle[] = ['sockets', 'arrow', 'both'];

/**
 * Direction from the centre of `node` to the socket of the wire from `src`:
 * the wire leaves and enters on the line of centres (06 §6.2). Null when the
 * bubbles overlap and the wire has no length to show.
 */
export function socketAt(node: Circle, src: Circle): { dx: number; dy: number } | null {
  const dx = src.x - node.x;
  const dy = src.y - node.y;
  if (Math.hypot(dx, dy) <= node.r + src.r) return null;
  // Where the wire meets the rim: along its axis (curve.ts axisOf).
  const u = axisOf(dx, dy);
  return { dx: u.x, dy: u.y };
}

/**
 * An arrowhead with its tip at the point `t` of the curve with control points
 * `c` (screen px), pointing from the point `length` back along the curve to
 * the tip: the wire runs into the arrow's base even where it bends. Null when
 * the curve before `t` is shorter than the arrow.
 */
export function arrowOn(
  c: readonly number[],
  t: number,
  length: number,
): { x: number; y: number; dx: number; dy: number } | null {
  const tip = pointAt(c, t, { x: 0, y: 0 });
  const p = { x: 0, y: 0 };
  for (let k = 1; k <= 64; k++) {
    const back = t - k / 64;
    if (back < 0) break;
    pointAt(c, back, p);
    const d = Math.hypot(tip.x - p.x, tip.y - p.y);
    if (d >= length) return { x: tip.x, y: tip.y, dx: (tip.x - p.x) / d, dy: (tip.y - p.y) / d };
  }
  return null;
}

/** Something on the rim: its angle from 3 o'clock clockwise and its half-size, px. */
export interface RimMark {
  angle: number;
  reach: number;
}

const TURN = Math.PI * 2;

function arc(a: number, b: number): number {
  const d = Math.abs(a - b) % TURN;
  return Math.min(d, TURN - d);
}

/**
 * The place on a rim of radius `r` for a glyph of half-size `reach` wanted at
 * clock `hour` (07 §4.7 rule 5: one place, one mark): the hour itself or the
 * nearest half-hour step either way, up to two hours, at least `gap` px clear
 * of every mark in `taken`. Wire ends take their places first: a glyph gives
 * way to a socket. The place found joins `taken`; when none is free the glyph
 * keeps its hour. Returns the angle.
 */
export function rimSlot(
  hour: number,
  reach: number,
  taken: RimMark[],
  r: number,
  gap: number,
): number {
  const base = (hour / 12) * TURN - Math.PI / 2;
  for (const step of [0, 0.5, -0.5, 1, -1, 1.5, -1.5, 2, -2]) {
    const angle = base + (step / 12) * TURN;
    if (taken.every((m) => arc(m.angle, angle) * r >= m.reach + reach + gap)) {
      taken.push({ angle, reach });
      return angle;
    }
  }
  taken.push({ angle: base, reach });
  return base;
}

/** `top` over `bottom` at `alpha` as one opaque colour, 0xRRGGBB. */
export function over(bottom: number, top: number, alpha: number): number {
  let out = 0;
  for (const shift of [16, 8, 0]) {
    const b = (bottom >> shift) & 255;
    const t = (top >> shift) & 255;
    out |= Math.round(b + (t - b) * alpha) << shift;
  }
  return out;
}

/**
 * Icon of a new node (07 §6.3, Q-07-21): its kind's preset (ADR-0010: no
 * classes). Never random; the user changes it in the icon palette `Z` (06 §2.1).
 */
export const DEFAULT_ICONS = {
  network: 'delapouite/family-tree',
  project: 'lorc/compass',
  task: 'lorc/hourglass',
  note: 'lorc/quill-ink',
  board: 'delapouite/palette',
  checklist: 'lorc/scroll-unfurled',
  asset: 'delapouite/photo-camera',
} as const satisfies Record<NodeKind, string>;

/** Preset id of a new node of `kind`. */
export function defaultIcon(kind: NodeKind): string {
  return DEFAULT_ICONS[kind];
}
