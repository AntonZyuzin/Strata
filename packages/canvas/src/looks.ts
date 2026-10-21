import type { GraphNode } from '@strata/backend';
import { fog, type GlyphName, hex, palette } from '@strata/design-tokens';
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
