#!/usr/bin/env node
// The app's icon (✅ Q-16-15, owner 2026-10-25): Gexogon's mark — a node's
// hexagon with a point up (ADR-0011) holding a node — as 32 × 32 pixel art,
// like the bar's mark (design-tokens `logo`) and the rest of the Chrome.
// Drawn from the hexagon's geometry. One command makes every icon of the
// desktop bundle:
//
//   node scripts/app-icon.mjs
//
// `tauri icon` builds icon.icns, icon.ico and the Store logos from a 1024 px
// source; the PNGs at whole multiples of the grid (32, 64, 128, 256, 512) are
// then drawn again pixel for pixel, since its resampling blurs pixel art.
// Colours are the tokens' (packages/design-tokens): the Scene's ink, the
// accent, paper. No dependencies besides the Tauri CLI of the desktop crate.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const GRID = 32;
const SCALE = 32;
const INK = [0x11, 0x11, 0x11, 255]; // palette.ink850, the Scene
const ACCENT = [0xb6, 0xf3, 0x6b, 255]; // palette.lime400, the one accent
const PAPER = [0xf2, 0xef, 0xe6, 255]; // palette.paper, a node's body
const CLEAR = [0, 0, 0, 0];

const HEX_IN = Math.sqrt(3) / 2;
/** The hexagonal distance of packages/canvas/src/hex.ts: a point up. */
const hexDist = (dx, dy) =>
  Math.max(Math.abs(dx), Math.abs(0.5 * dx + HEX_IN * dy), Math.abs(0.5 * dx - HEX_IN * dy));

/** Inside the hexagon of circumradius r, by the pixel's centre. */
const inHex = (x, y, r) => hexDist(x + 0.5 - GRID / 2, y + 0.5 - GRID / 2) <= r * HEX_IN;

/** The tile: the whole square but its corners cut in steps, as the old icon's. */
const CUT = [4, 2, 1, 1];
const inTile = (x, y) => {
  const row = Math.min(y, GRID - 1 - y);
  const col = Math.min(x, GRID - 1 - x);
  return row >= CUT.length || col >= (CUT[row] ?? 0);
};

function pixel(x, y) {
  if (!inTile(x, y)) return CLEAR;
  // The cell: a lime outline two pixels thick, circumradius 13.
  if (inHex(x, y, 13) && !inHex(x, y, 13 - 2 / HEX_IN)) return ACCENT;
  // The node in it: paper, circumradius 7.
  if (inHex(x, y, 7)) return PAPER;
  return INK;
}

function png(width, height, rgba) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = (crcTable[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8 bits, RGBA, no interlace
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // no filter
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** The icon at `size` px, a whole multiple of the grid: every pixel a square. */
function draw(size) {
  const scale = size / GRID;
  if (!Number.isInteger(scale)) throw new Error(`${size} is not a multiple of ${GRID}`);
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      rgba.set(pixel(Math.floor(x / scale), Math.floor(y / scale)), (y * size + x) * 4);
    }
  }
  return png(size, size, rgba);
}

const desktop = new URL('../crates/strata-desktop/', import.meta.url).pathname;
const icons = join(desktop, 'icons');
const work = mkdtempSync(join(tmpdir(), 'gexogon-icon-'));
const source = join(work, 'source.png');
writeFileSync(source, draw(GRID * SCALE));
execFileSync('pnpm', ['exec', 'tauri', 'icon', source, '-o', icons], {
  cwd: desktop,
  stdio: 'inherit',
});
// Phones are no target (ADR-0004).
rmSync(join(icons, 'android'), { recursive: true, force: true });
rmSync(join(icons, 'ios'), { recursive: true, force: true });
rmSync(work, { recursive: true, force: true });
for (const [file, size] of [
  ['32x32.png', 32],
  ['64x64.png', 64],
  ['128x128.png', 128],
  ['128x128@2x.png', 256],
  ['icon.png', 512],
]) {
  writeFileSync(join(icons, file), draw(size));
}
console.log(`${icons}: the icons of the bundle`);
