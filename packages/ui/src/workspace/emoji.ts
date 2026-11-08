import type { Pixels } from '@strata/canvas';

/** The side an emoji is drawn at: the side pictures are decoded at (07 §6.4). */
const SIDE = 512;
/** A grapheme that is a pictograph or a flag: an emoji, not a digit or `#`. */
const PICTOGRAPH = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
/** The systems' colour emoji fonts, each its own: the look depends on the OS (07 §6.4). */
const EMOJI_FONTS =
  '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", "Twemoji Mozilla", sans-serif';

/** The emoji in a text, each once, in order, at most `max` (07 §6.4). */
export function emojiIn(text: string, max = 8): string[] {
  const out: string[] = [];
  const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  for (const { segment } of graphemes.segment(text)) {
    if (!PICTOGRAPH.test(segment) || out.includes(segment)) continue;
    out.push(segment);
    if (out.length === max) break;
  }
  return out;
}

/** The text with its emoji taken out: the words the presets are found by. */
export function withoutEmoji(text: string): string {
  let out = '';
  const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  for (const { segment } of graphemes.segment(text))
    out += PICTOGRAPH.test(segment) ? ' ' : segment;
  return out;
}

/**
 * An emoji drawn by the system's font on nothing (07 §6.4): a picture for
 * «привести к стилю», kept as the original so it looks the same on every
 * device afterwards.
 */
export function drawEmoji(char: string): Pixels {
  const canvas = document.createElement('canvas');
  canvas.width = SIDE;
  canvas.height = SIDE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas is not available');
  ctx.font = `${Math.round(SIDE * 0.8)}px ${EMOJI_FONTS}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(char, SIDE / 2, SIDE / 2);
  return { width: SIDE, height: SIDE, data: ctx.getImageData(0, 0, SIDE, SIDE).data };
}
