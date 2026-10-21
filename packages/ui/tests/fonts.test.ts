import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fontkit from 'fontkit';
import { describe, expect, it } from 'vitest';

/**
 * CI font test of 07 §3.5: every font file the build ships is opened and its
 * cmap must hold the Russian alphabet, Russian typography, ЄІЇҐЎ (☑ Q-07-1),
 * Latin, digits, ASCII punctuation and English quotes. It catches fonts whose
 * metadata claims Cyrillic without the glyphs (Pixelify Sans, R7 risks).
 */

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const FONTS_CSS = resolve(here, '../src/fonts/fonts.css');

const RU = 'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдеёжзийклмнопрстуфхцчшщъыьэюя';
const REQUIRED = [
  RU,
  '«»—–…№',
  'ЄІЇҐЎ',
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
  '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~',
  '“”‘’',
].join('');

/** Font files per family, following `@import` and `@font-face` from `fonts.css`. */
function shippedFaces(cssPath: string, out = new Map<string, string[]>()): Map<string, string[]> {
  const css = readFileSync(cssPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of css.matchAll(/@import\s+['"]([^'"]+)['"]/g)) {
    const spec = m[1] as string;
    shippedFaces(
      spec.startsWith('.') ? resolve(dirname(cssPath), spec) : require.resolve(spec),
      out,
    );
  }
  for (const m of css.matchAll(/@font-face\s*{([^}]*)}/g)) {
    const body = m[1] as string;
    const family = /font-family:\s*['"]([^'"]+)['"]/.exec(body)?.[1];
    const url = /url\(['"]?([^'")]+\.woff2)['"]?\)/.exec(body)?.[1];
    if (!family || !url) continue;
    const files = out.get(family) ?? [];
    files.push(resolve(dirname(cssPath), url));
    out.set(family, files);
  }
  return out;
}

const faces = shippedFaces(FONTS_CSS);

describe('bundled fonts (07 §3.5)', () => {
  it('ships the five families of 07 §3.1', () => {
    expect([...faces.keys()].sort()).toEqual([
      'Departure Mono',
      'Golos Text',
      'JetBrains Mono',
      'Press Start 2P',
      'Tiny5',
    ]);
  });

  for (const [family, files] of faces) {
    it(`${family} covers Russian, Ukrainian and Belarusian letters, Latin and typography`, () => {
      const cmap = new Set<number>();
      for (const file of files) {
        const font = fontkit.create(readFileSync(file));
        for (const cp of font.characterSet) cmap.add(cp);
      }
      const missing = [...REQUIRED].filter((c) => !cmap.has(c.codePointAt(0) ?? 0));
      expect(missing, `${family}: missing glyphs`).toEqual([]);
    });
  }
});
