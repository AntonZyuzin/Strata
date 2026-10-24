import { writeFile } from 'node:fs/promises';
import { expect, type Page, test } from '@playwright/test';

type Point = readonly [number, number];
const ANIMATIONS = [
  'idle',
  'walk',
  'pet',
  'drag',
  'sleep',
  'balance',
  'climb',
  'tail-hang',
  'task-created',
  'project-created',
  'file-created',
  'task-completed',
  'nodes-linked',
  'deadline-near',
] as const;
type AnatomyOptions = {
  variant: 0 | 1 | 2;
  motionAngle?: number;
  locomotionPhase?: number;
  tailHangProgress?: number;
};
interface AnatomyReview {
  load(): Promise<void>;
  draw(
    context: CanvasRenderingContext2D,
    animation: (typeof ANIMATIONS)[number],
    elapsedMs: number,
    facing: 1 | -1,
    options: AnatomyOptions,
  ): void;
  anatomy(): {
    face: {
      matrix: readonly [number, number, number, number, number, number];
      source: Uint32Array;
      stamp: Uint32Array;
      width: number;
      height: number;
    };
    paws: readonly { name: string; toes: readonly Point[]; palm: Point; visible: boolean }[];
  };
}
type AnatomyWindow = Window & { __strataGeckoReview?: AnatomyReview };

async function openReview(page: Page) {
  await page.goto('/?plain&geckoReview');
  await page.locator('.home-new').click();
  await page.locator('.dialog .field').fill('Gecko anatomy');
  await page.locator('.dialog button[type="submit"]').click();
  await page.waitForFunction(() => (window as AnatomyWindow).__strataGeckoReview != null);
  await page.evaluate(() => (window as AnatomyWindow).__strataGeckoReview?.load());
}

test('eyes and mouth remain on one rigid face while crawling down and hanging', async ({
  page,
}, info) => {
  await openReview(page);
  const result = await page.evaluate(() => {
    const review = (window as AnatomyWindow).__strataGeckoReview;
    if (!review) throw new Error('The anatomy review hook is unavailable');
    const canvas = document.createElement('canvas');
    canvas.width = 96;
    canvas.height = 72;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('A canvas context is required');
    const sheet = document.createElement('canvas');
    sheet.width = 1536;
    sheet.height = 1200;
    const sheetContext = sheet.getContext('2d');
    if (!sheetContext) throw new Error('A sheet context is required');
    sheetContext.imageSmoothingEnabled = false;
    sheetContext.fillStyle = '#151914';
    sheetContext.fillRect(0, 0, sheet.width, sheet.height);
    const failures: string[] = [];
    let frames = 0;
    for (const animation of ['walk', 'tail-hang'] as const) {
      for (const variant of [0, 1, 2] as const) {
        const angles =
          animation === 'walk' ? [Math.PI / 2 - 0.1, Math.PI / 2, Math.PI / 2 + 0.1] : [0];
        const progresses = animation === 'tail-hang' ? [0, 0.25, 0.5, 0.75, 1] : [0];
        for (const motionAngle of angles) {
          for (const tailHangProgress of progresses) {
            for (let sample = 0; sample <= 24; sample++) {
              const ms = sample * 200;
              review.draw(context, animation, ms, 1, {
                variant,
                motionAngle,
                tailHangProgress,
                locomotionPhase: sample / 12,
              });
              frames++;
              const face = review.anatomy().face;
              const label = `${animation}/${variant}/${motionAngle}/${tailHangProgress}/${ms}`;
              if (!face || face.stamp.length !== 96 * 72) {
                failures.push(`${label}: no face diagnostic`);
                continue;
              }
              const [a, b, c, d, e, f] = face.matrix;
              const sx = Math.hypot(a, b);
              const sy = Math.hypot(c, d);
              if (sx < 0.1 || Math.abs(sx - sy) > 0.00001 || Math.abs(a * c + b * d) > 0.00001)
                failures.push(`${label}: the face transform stretches or shears the artwork`);
              const actual = new Uint32Array(context.getImageData(0, 0, 96, 72).data.buffer);
              let interior = 0;
              let left = 95;
              let right = 0;
              let top = 71;
              let bottom = 0;
              for (let y = 1; y < 71; y++) {
                for (let x = 1; x < 95; x++) {
                  const index = y * 96 + x;
                  if ((face.stamp[index] ?? 0) >>> 24 === 0) continue;
                  left = Math.min(left, x);
                  right = Math.max(right, x);
                  top = Math.min(top, y);
                  bottom = Math.max(bottom, y);
                  if (
                    (face.stamp[index - 1] ?? 0) >>> 24 &&
                    (face.stamp[index + 1] ?? 0) >>> 24 &&
                    (face.stamp[index - 96] ?? 0) >>> 24 &&
                    (face.stamp[index + 96] ?? 0) >>> 24
                  ) {
                    interior++;
                    if (actual[index] !== face.stamp[index])
                      failures.push(
                        `${label}: a face pixel at ${x},${y} moves with another body part`,
                      );
                  }
                }
              }
              if (interior < 80) failures.push(`${label}: the face interior disappears`);
              for (const [name, x, y] of [
                ['near pupil', 76, 29],
                ['far pupil', 80, 20],
                ['jaw', 63, 30],
                ['brow', 68, 18],
              ] as const) {
                if ((face.source[y * 96 + x] ?? 0) >>> 24 === 0)
                  failures.push(`${label}: ${name} is missing from the rigid face source`);
                const tx = Math.floor(a * (x + 0.5) + c * (y + 0.5) + e);
                const ty = Math.floor(b * (x + 0.5) + d * (y + 0.5) + f);
                const index = ty * 96 + tx;
                if (
                  tx < 0 ||
                  tx >= 96 ||
                  ty < 0 ||
                  ty >= 72 ||
                  (face.stamp[index] ?? 0) >>> 24 === 0 ||
                  actual[index] !== face.stamp[index]
                )
                  failures.push(`${label}: ${name} drifts from the face stamp`);
              }
              if (
                sample % 4 === 0 &&
                sample <= 12 &&
                (animation === 'walk' ? motionAngle === Math.PI / 2 : tailHangProgress === 1)
              ) {
                const row = (animation === 'walk' ? 0 : 3) + variant;
                const x = (sample / 4) * 384;
                const y = row * 200;
                sheetContext.drawImage(canvas, x, y + 24, 192, 144);
                const width = Math.max(1, right - left + 1);
                const height = Math.max(1, bottom - top + 1);
                sheetContext.drawImage(
                  canvas,
                  left,
                  top,
                  width,
                  height,
                  x + 192,
                  y + 24,
                  width * 5,
                  height * 5,
                );
                sheetContext.fillStyle = '#dce7c7';
                sheetContext.font = '12px monospace';
                sheetContext.fillText(`${animation} v${variant + 1} ${ms}ms`, x + 4, y + 16);
              }
            }
          }
        }
      }
    }
    return { failures, frames, sheet: sheet.toDataURL('image/png') };
  });
  const sheetPath = info.outputPath('face-anatomy-contact-sheet.png');
  await writeFile(sheetPath, Buffer.from(result.sheet.split(',')[1] ?? '', 'base64'));
  await info.attach('face-anatomy-contact-sheet', { path: sheetPath, contentType: 'image/png' });
  await writeFile(
    info.outputPath('face-anatomy-diagnostics.json'),
    JSON.stringify({ ...result, sheet: undefined }, null, 2),
  );
  expect(result.failures.slice(0, 30)).toEqual([]);
});
