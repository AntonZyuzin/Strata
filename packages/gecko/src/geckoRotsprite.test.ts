import assert from 'node:assert/strict';
import { test } from 'vitest';
import { enlarge, fitTurnScale, sampleTurn } from './geckoRotsprite';

const tail = 0xff315b79;
const body = 0xff497d64;
const head = 0xff77a43e;

test('a quarter turn fits an asymmetric long silhouette without clipping its head or tail', () => {
  const width = 96;
  const height = 72;
  const pixels = new Uint32Array(width * height);
  for (let y = 33; y <= 38; y++)
    for (let x = 6; x <= 91; x++) pixels[y * width + x] = x < 11 ? tail : x > 86 ? head : body;
  for (let y = 29; y <= 32; y++) for (let x = 86; x <= 91; x++) pixels[y * width + x] = head;
  const pivot = [48, 36] as const;
  const angle = Math.PI / 2;
  const scale = fitTurnScale(pixels, width, height, angle, pivot, pivot);
  assert.ok(scale > 0.7 && scale < 1);
  const enlarged = enlarge(pixels, width, height);
  const fitted = new Uint32Array(pixels.length);
  const clipped = new Uint32Array(pixels.length);
  sampleTurn(enlarged, width, height, fitted, angle, pivot, pivot, false, scale);
  sampleTurn(enlarged, width, height, clipped, angle, pivot, pivot);
  assert.ok(fitted.includes(head));
  assert.ok(fitted.includes(tail));
  assert.ok(!clipped.includes(tail));
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      if (!fitted[y * width + x]) continue;
      assert.ok(x >= 1 && x < width - 1 && y >= 1 && y < height - 1);
    }
  assert.deepEqual(new Set(fitted), new Set([0, tail, body, head]));
});

test('fitted oblique and mirrored turns retain only original opaque colors', () => {
  const width = 32;
  const height = 24;
  const pixels = new Uint32Array(width * height);
  for (let y = 8; y <= 15; y++)
    for (let x = 3; x <= 28; x++) pixels[y * width + x] = x < 16 ? body : head;
  const enlarged = enlarge(pixels, width, height);
  const palette = new Set([0, body, head]);
  for (const mirror of [false, true])
    for (const angle of [Math.PI / 4, -Math.PI / 3, Math.PI]) {
      const pivot = [16, 12] as const;
      const scale = fitTurnScale(pixels, width, height, angle, pivot, pivot, mirror);
      const turned = new Uint32Array(pixels.length);
      sampleTurn(enlarged, width, height, turned, angle, pivot, pivot, mirror, scale);
      assert.ok(turned.some((pixel) => pixel !== 0));
      for (const color of turned) assert.ok(palette.has(color));
    }
});

test('unit scale preserves the legacy identity and quarter-turn placements', () => {
  const width = 12;
  const height = 10;
  const pixels = new Uint32Array(width * height);
  for (const y of [3, 4]) for (const x of [4, 5]) pixels[y * width + x] = body;
  const enlarged = enlarge(pixels, width, height);
  const pivot = [6, 5] as const;
  assert.equal(fitTurnScale(pixels, width, height, 0, pivot, pivot), 1);
  const identity = new Uint32Array(pixels.length);
  sampleTurn(enlarged, width, height, identity, 0, pivot, pivot, false, 1);
  assert.deepEqual(identity, pixels);
  const quarterTurn = new Uint32Array(pixels.length);
  const defaultScale = new Uint32Array(pixels.length);
  sampleTurn(enlarged, width, height, quarterTurn, Math.PI / 2, pivot, pivot, false, 1);
  sampleTurn(enlarged, width, height, defaultScale, Math.PI / 2, pivot, pivot);
  assert.deepEqual(quarterTurn, defaultScale);
  const expected = new Uint32Array(pixels.length);
  for (const y of [3, 4]) for (const x of [6, 7]) expected[y * width + x] = body;
  assert.deepEqual(quarterTurn, expected);
});
