import { STYLE_MODES } from '@strata/canvas';
import { describe, expect, it } from 'vitest';
import { blobOf, ownIconRef, parseOwnIcon } from './ownIcons';

const SHA = 'ab'.repeat(32);

describe("one's own icon's reference (07 §6.6)", () => {
  it('spells each style once and reads it back', () => {
    for (const mode of STYLE_MODES) {
      for (const threshold of [null, 0, 97, 255]) {
        for (const invert of [false, true]) {
          const ref = ownIconRef(SHA, { mode, threshold, invert });
          const back = parseOwnIcon(ref);
          // The modes with no threshold of their own keep none (07 §6.5).
          const kept = mode === 'engraving' || mode === 'pixel' ? threshold : null;
          expect(back, ref).toEqual({ sha: SHA, style: { mode, threshold: kept, invert } });
          expect(ownIconRef(SHA, back?.style ?? { mode, threshold, invert })).toBe(ref);
        }
      }
    }
  });

  it('writes the threshold as a whole number of 0–255', () => {
    expect(ownIconRef(SHA, { mode: 'pixel', threshold: 96.6, invert: false })).toBe(
      `asset/${SHA}/pixel/t97`,
    );
    expect(ownIconRef(SHA, { mode: 'engraving', threshold: 300, invert: true })).toBe(
      `asset/${SHA}/engraving/t255/i`,
    );
  });

  it('takes no other spelling, as the core takes none', () => {
    for (const bad of [
      'game-icons/lorc/compass',
      `asset/${SHA}`,
      `asset/${SHA}/sepia`,
      `asset/${SHA}/pixel/t256`,
      `asset/${SHA}/pixel/t09`,
      `asset/${SHA}/pixel/i/t9`,
      `asset/${SHA}/pixel/i/i`,
      `asset/${SHA.slice(1)}/pixel`,
      null,
      undefined,
    ]) {
      expect(parseOwnIcon(bad), String(bad)).toBeNull();
    }
  });
});

describe('a stored original as a picture (07 §6.4)', () => {
  const bytes = (text: string) => new TextEncoder().encode(text);

  it('gives an SVG its type, which the browser does not sniff', () => {
    expect(blobOf(bytes('<svg xmlns="http://www.w3.org/2000/svg"/>')).type).toBe('image/svg+xml');
    expect(blobOf(bytes('﻿  \n<?xml version="1.0"?><svg/>')).type).toBe('image/svg+xml');
  });

  it('leaves the raster formats to the browser', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(blobOf(png).type).toBe('');
    expect(blobOf(new Uint8Array([0xff, 0xd8, 0xff])).type).toBe('');
  });
});
