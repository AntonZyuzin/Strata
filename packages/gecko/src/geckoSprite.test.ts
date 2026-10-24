import { expect, it } from 'vitest';
import { alignWalkingPupils, SPRITE_HEIGHT, SPRITE_WIDTH } from './geckoSprite';

it('keeps the walking pupils straight while preserving the iris highlight and eye outline', () => {
  const pixels = new Uint8ClampedArray(SPRITE_WIDTH * SPRITE_HEIGHT * 4);
  const at = (x: number, y: number) => (y * SPRITE_WIDTH + x) * 4;
  const dark = [5, 7, 2, 255];
  const gold = [233, 203, 120, 255];
  const highlight = [241, 233, 202, 255];
  const rim = [93, 115, 55, 255];
  pixels.set(dark, at(76, 29));
  pixels.set(dark, at(77, 30));
  pixels.set(gold, at(75, 29));
  pixels.set(highlight, at(75, 28));
  pixels.set(rim, at(78, 28));
  alignWalkingPupils(pixels);
  for (let y = 28; y <= 31; y++) expect([...pixels.slice(at(76, y), at(76, y) + 4)]).toEqual(dark);
  for (let y = 28; y <= 30; y++) expect([...pixels.slice(at(77, y), at(77, y) + 4)]).toEqual(gold);
  for (let y = 19; y <= 21; y++) expect([...pixels.slice(at(80, y), at(80, y) + 4)]).toEqual(dark);
  expect([...pixels.slice(at(75, 28), at(75, 28) + 4)]).toEqual(highlight);
  expect([...pixels.slice(at(78, 28), at(78, 28) + 4)]).toEqual(rim);
});
