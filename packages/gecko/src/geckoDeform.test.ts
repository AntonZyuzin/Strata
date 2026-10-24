import { describe, expect, it } from 'vitest';
import { createConnectedMesh, deformConnectedMesh, type PixelTransform } from './geckoDeform';

function components(pixels: Uint32Array, width: number): number {
  const seen = new Set<number>();
  let count = 0;
  for (let start = 0; start < pixels.length; start++) {
    if (!pixels[start] || seen.has(start)) continue;
    count++;
    const queue = [start];
    seen.add(start);
    for (const current of queue) {
      const x = current % width,
        y = Math.floor(current / width);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx,
            next = (y + dy) * width + nx;
          if (nx < 0 || nx >= width || !pixels[next] || seen.has(next)) continue;
          seen.add(next);
          queue.push(next);
        }
    }
  }
  return count;
}

describe('connected pixel deformation', () => {
  const width = 40,
    height = 32,
    pixels = new Uint32Array(width * height),
    owners = new Uint8Array(pixels.length).fill(255),
    colours = [0xff407b91, 0xffa9d8df];
  // A thick torso, a one-pixel wrist and a splayed three-toe paw.
  for (let y = 10; y <= 19; y++)
    for (let x = 10; x <= 20; x++) {
      const i = y * width + x;
      pixels[i] = colours[(x + y) % 2] ?? 0;
      owners[i] = 0;
    }
  for (const [x, y] of [
    [21, 14],
    [22, 14],
    [23, 14],
    [24, 14],
    [25, 14],
    [26, 13],
    [27, 12],
    [26, 14],
    [27, 14],
    [26, 15],
    [27, 16],
  ]) {
    const i = (y ?? 0) * width + (x ?? 0);
    pixels[i] = colours[0] ?? 0;
    owners[i] = 1;
  }
  const mesh = createConnectedMesh(pixels, owners, width, height),
    identity: PixelTransform = (x, y) => [x, y];

  it('preserves the exact approved pixels in the neutral pose', () => {
    expect(deformConnectedMesh(mesh, [identity, identity])).toEqual(pixels);
  });

  it('retains a connected wrist and every toe through extreme joint turns', () => {
    for (let angle = -1.5; angle <= 1.5; angle += 0.15) {
      const turn: PixelTransform = (x, y) => [
        20 + (x - 20) * Math.cos(angle) - (y - 14) * Math.sin(angle),
        14 + (x - 20) * Math.sin(angle) + (y - 14) * Math.cos(angle),
      ];
      const result = deformConnectedMesh(mesh, [identity, turn]);
      expect(components(result, width), `angle=${angle}`).toBe(1);
      expect(result.filter(Boolean).length).toBeGreaterThan(110);
      expect([...result].filter(Boolean).every((colour) => colours.includes(colour))).toBe(true);
    }
  });

  it('keeps interior face pixels rigid while the neighbouring limb moves', () => {
    const translated: PixelTransform = (x, y) => [x + 2, y],
      result = deformConnectedMesh(mesh, [translated, (x, y) => [x + 4, y + 3]]);
    for (let y = 12; y <= 17; y++)
      for (let x = 12; x <= 16; x++) {
        expect(result[y * width + x + 2]).toBe(pixels[y * width + x]);
      }
  });

  it('does not blend a fingertip with a face across a narrow air gap', () => {
    const art = new Uint32Array(width * height),
      labels = new Uint8Array(art.length).fill(255),
      green = 0xff408040,
      gold = 0xff20c0e0;
    for (let y = 5; y <= 10; y++)
      for (let x = 11; x <= 18; x++) {
        art[y * width + x] = green;
        labels[y * width + x] = 0;
      }
    // The arm and head are connected at the shoulder on the left; there is
    // a one-pixel air gap between the far fingertip and the nearby eye.
    for (let x = 11; x <= 19; x++) {
      art[12 * width + x] = gold;
      labels[12 * width + x] = 1;
    }
    art[11 * width + 11] = gold;
    labels[11 * width + 11] = 1;
    const local = createConnectedMesh(art, labels, width, height),
      result = deformConnectedMesh(local, [identity, (x, y) => [x + 6, y]]);
    expect(result[12 * width + 24]).toBe(gold);
    expect(result[8 * width + 17]).toBe(green);
    expect(components(result, width)).toBe(1);
  });
});
