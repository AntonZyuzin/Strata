import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGeckoRig, walkTailGeometry } from './geckoRig';

/** Only the native pixel operations used while constructing a rig. */
class NativeCanvas {
  width = 96;
  height = 72;
  pixels = new Uint8ClampedArray(96 * 72 * 4);

  getContext() {
    return {
      getImageData: () => ({ data: this.pixels.slice() }),
      createImageData: () => ({ data: new Uint8ClampedArray(this.pixels.length) }),
      putImageData: (image: { data: Uint8ClampedArray }) => this.pixels.set(image.data),
    };
  }

  dot(x: number, y: number) {
    this.pixels.set([80, 120, 40, 255], (y * 96 + x) * 4);
  }
}

afterEach(() => vi.unstubAllGlobals());

describe('anatomical ownership', () => {
  it('keeps the brow and mouth in the rigid face instead of the neighbouring limb skin', () => {
    vi.stubGlobal('document', { createElement: () => new NativeCanvas() });
    const source = new NativeCanvas();
    for (let x = 68; x <= 82; x++) for (let y = 17; y <= 32; y++) source.dot(x, y);
    for (let x = 63; x <= 70; x++) source.dot(x, 30);
    const rig = createGeckoRig(source as unknown as HTMLCanvasElement, 'walk');
    for (const [x, y] of [
      [68, 18],
      [70, 17],
      [63, 30],
    ] as const) {
      expect(rig.faceMesh.pixels[y * 96 + x]).not.toBe(0);
      expect(rig.bodyMesh.pixels[y * 96 + x]).toBe(0);
    }
  });

  it('attaches the full rear paw to its wrist, including toes beyond its nominal endpoint radius', () => {
    vi.stubGlobal('document', { createElement: () => new NativeCanvas() });
    const source = new NativeCanvas();
    // The far rear toe at (32,18) lies outside the old leg polygon and more
    // than nine pixels from its nominal foot (42,15), but touches the paw.
    for (let x = 32; x <= 45; x++) source.dot(x, 18);
    for (let y = 18; y <= 29; y++) source.dot(45, y);
    // A nearby face remains a separate, protected anatomical region.
    for (let x = 71; x <= 81; x++) for (let y = 19; y <= 29; y++) source.dot(x, y);
    const rig = createGeckoRig(source as unknown as HTMLCanvasElement, 'walk'),
      toe = rig.mesh.vertices.find((vertex) => vertex.index === 18 * 97 + 32),
      eye = rig.mesh.vertices.find((vertex) => vertex.index === 24 * 97 + 76);
    expect(toe?.weights).toEqual([[4, 1]]);
    expect(eye?.weights).toEqual([[1, 1]]);
  });
});

describe('walking tail', () => {
  it('trails behind a fixed root with a plump main section and a tapered tip', () => {
    const root = [38, 37] as const;
    for (const phase of [0, 0.5, 1, 1.5, 2]) {
      expect(walkTailGeometry(0, phase, root).point).toEqual(root);
      let previousX = root[0] + 1;
      for (let u = 0; u <= 1; u += 0.025) {
        const tail = walkTailGeometry(u, phase, root);
        expect(tail.point[0]).toBeLessThan(previousX);
        expect(Math.abs(tail.point[1] - root[1])).toBeLessThanOrEqual(1.3);
        previousX = tail.point[0];
      }
    }
    expect(walkTailGeometry(0.3, 0, root).halfWidth).toBeGreaterThan(5.5);
    expect(walkTailGeometry(0.5, 0, root).halfWidth).toBeGreaterThan(4.5);
    expect(walkTailGeometry(1, 0, root).halfWidth).toBeLessThan(0.6);
    const before = walkTailGeometry(1, 0.999, root),
      after = walkTailGeometry(1, 1.001, root);
    expect(Math.abs(after.point[1] - before.point[1])).toBeLessThan(0.02);
  });
});
