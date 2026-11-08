import { describe, expect, it } from 'vitest';
import { emojiIn, withoutEmoji } from './emoji';

describe("emoji in the palette's query (07 §6.4)", () => {
  it('finds each emoji once, in order, a whole grapheme each', () => {
    expect(emojiIn('сова 🦉 и 🦊, ещё 🦉')).toEqual(['🦉', '🦊']);
    // A family and a flag stay one grapheme each; a skin tone stays with its hand.
    expect(emojiIn('👨‍👩‍👧 🇷🇺 👍🏽')).toEqual(['👨‍👩‍👧', '🇷🇺', '👍🏽']);
  });

  it('takes no digits, signs or letters', () => {
    expect(emojiIn('1 # * компас A')).toEqual([]);
  });

  it('leaves the words when the emoji are taken out', () => {
    expect(withoutEmoji('сова 🦉').trim()).toBe('сова');
    expect(withoutEmoji('👨‍👩‍👧').trim()).toBe('');
  });

  it('keeps to the limit', () => {
    expect(emojiIn('🍎🍐🍊🍋🍌', 3)).toEqual(['🍎', '🍐', '🍊']);
  });
});
