import { writeFile } from 'node:fs/promises';
import { expect, type Page, test } from '@playwright/test';

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

type Animation = (typeof ANIMATIONS)[number];
interface ReviewHook {
  load(): Promise<void>;
  draw(
    context: CanvasRenderingContext2D,
    animation: Animation,
    elapsedMs: number,
    facing: 1 | -1,
    options: {
      variant?: 0 | 1 | 2;
      reducedMotion?: boolean;
      locomotionPhase?: number;
      gripPhase?: number;
      motionAngle?: number;
      tailHangProgress?: number;
    },
  ): void;
  handle: { climbNode(id?: string): void };
  snapshot(): {
    animation: Animation;
    nodeId: string | null;
    nodePhase: 'approach' | 'crawl' | 'hang' | 'recover' | null;
    tailHangProgress: number;
  };
  nodes(): readonly { id: string; x: number; y: number; radius: number }[];
}

/** The review hook is only installed for an explicitly requested review URL. */
type ReviewWindow = Window & { __strataGeckoReview?: ReviewHook };

async function workspace(page: Page) {
  await page.goto('/?plain&geckoReview');
  await page.locator('.home-new').click();
  await page.locator('.dialog .field').fill('Gecko motion');
  await page.locator('.dialog button[type="submit"]').click();
  await page.waitForFunction(
    () => (window as unknown as { __strataWs?: { graph(): unknown } }).__strataWs?.graph() != null,
  );
  await expect(page.locator('[data-gecko-actor]')).toBeVisible();
  await page.waitForFunction(() => (window as ReviewWindow).__strataGeckoReview != null);
  await page.evaluate(() => (window as ReviewWindow).__strataGeckoReview?.load());
}

test('every gecko performance retains its connected anatomy throughout the cycle', async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  await workspace(page);
  const result = await page.evaluate((animations) => {
    const review = (window as ReviewWindow).__strataGeckoReview;
    if (!review) throw new Error('Gecko review hook is unavailable');
    const canvas = document.createElement('canvas');
    canvas.width = 96;
    canvas.height = 72;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('A canvas context is required');

    const components = (pixels: Uint8ClampedArray) => {
      const seen = new Uint8Array(96 * 72);
      const groups: number[][] = [];
      for (let i = 0; i < seen.length; i++) {
        if (seen[i] || !pixels[i * 4 + 3]) continue;
        const group = [i];
        seen[i] = 1;
        for (let at = 0; at < group.length; at++) {
          const index = group[at] ?? 0;
          const x = index % 96;
          const y = Math.floor(index / 96);
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const nx = x + dx;
              const ny = y + dy;
              const next = ny * 96 + nx;
              if (
                (!dx && !dy) ||
                nx < 0 ||
                nx >= 96 ||
                ny < 0 ||
                ny >= 72 ||
                seen[next] ||
                !pixels[next * 4 + 3]
              )
                continue;
              seen[next] = 1;
              group.push(next);
            }
          }
        }
        groups.push(group);
      }
      return groups.sort((a, b) => b.length - a.length);
    };

    const eyePattern = (pixels: Uint8ClampedArray, body: readonly number[], facing: 1 | -1) => {
      const iris = body.flatMap((index) => {
        const r = pixels[index * 4] ?? 0;
        const g = pixels[index * 4 + 1] ?? 0;
        const b = pixels[index * 4 + 2] ?? 0;
        // The warm gold iris is redder than the cream throat and green skin.
        if (Math.floor(index / 96) > 35 || r < 150 || g < 140 || r < g * 1.08 || b > r * 0.65)
          return [];
        return [
          { x: facing === 1 ? index % 96 : 95 - (index % 96), y: Math.floor(index / 96), r, g, b },
        ];
      });
      const left = Math.min(...iris.map((p) => p.x));
      const top = Math.min(...iris.map((p) => p.y));
      return iris
        .map((p) => `${p.x - left},${p.y - top},${p.r},${p.g},${p.b}`)
        .sort()
        .join(';');
    };

    const failures: string[] = [];
    const ranges: { animation: string; body: number; min: number; max: number }[] = [];
    const sheet = document.createElement('canvas');
    sheet.dataset.geckoReviewSheet = '';
    sheet.width = 6 * 192;
    sheet.height = animations.length * 3 * 158;
    const sheetContext = sheet.getContext('2d');
    if (!sheetContext) throw new Error('A sheet context is required');
    sheetContext.imageSmoothingEnabled = false;
    sheetContext.fillStyle = '#151914';
    sheetContext.fillRect(0, 0, sheet.width, sheet.height);
    const started = performance.now();
    let row = 0;
    for (const animation of animations) {
      review.draw(context, animation, 0, 1, { reducedMotion: true });
      const referencePixels = context.getImageData(0, 0, 96, 72).data;
      const reference = components(referencePixels);
      const body = reference[0]?.length ?? 0;
      const referenceEye = eyePattern(referencePixels, reference[0] ?? [], 1);
      const seated = ['idle', 'pet', 'balance'].includes(animation);
      if (seated && !referenceEye) failures.push(`${animation}/reference: the iris is missing`);
      const props = reference.slice(1).map((group) => group.length);
      const areaReferences = new Map<string, number>();
      if (animation === 'walk' || animation === 'tail-hang') {
        const angles = animation === 'walk' ? [0, Math.PI / 4, Math.PI / 2, Math.PI] : [0];
        const hangs = animation === 'tail-hang' ? [0, 0.25, 0.5, 0.75, 1] : [1];
        for (const motionAngle of angles) {
          for (const tailHangProgress of hangs) {
            review.draw(context, animation, 0, 1, {
              motionAngle,
              tailHangProgress,
              locomotionPhase: 0,
              gripPhase: 0,
            });
            areaReferences.set(
              `${motionAngle}:${tailHangProgress}`,
              components(context.getImageData(0, 0, 96, 72).data)[0]?.length ?? 0,
            );
          }
        }
      }
      let min = Infinity;
      let max = 0;
      for (const variant of [0, 1, 2] as const) {
        for (let sample = 0; sample <= 24; sample++) {
          const ms = sample * 200;
          for (const facing of [1, -1] as const) {
            const angles = animation === 'walk' ? [0, Math.PI / 4, Math.PI / 2, Math.PI] : [0];
            const hangs = animation === 'tail-hang' ? [0, 0.25, 0.5, 0.75, 1] : [1];
            for (const motionAngle of angles) {
              for (const tailHangProgress of hangs) {
                review.draw(context, animation, ms, facing, {
                  variant,
                  locomotionPhase: sample / 12,
                  gripPhase: (sample / 12) % 1,
                  motionAngle,
                  tailHangProgress,
                });
                const pixels = context.getImageData(0, 0, 96, 72).data;
                const groups = components(pixels);
                const size = groups[0]?.length ?? 0;
                min = Math.min(min, size);
                max = Math.max(max, size);
                const label = `${animation}/${variant}/${facing}/${ms}ms/${motionAngle}/${tailHangProgress}`;
                if (animation === 'walk') {
                  const pupils = pixels.slice();
                  for (let index = 0; index < 96 * 72; index++) {
                    const offset = index * 4;
                    if (
                      pupils[offset] !== 5 ||
                      pupils[offset + 1] !== 7 ||
                      pupils[offset + 2] !== 2
                    )
                      pupils[offset + 3] = 0;
                  }
                  const slits = components(pupils);
                  if (slits.length !== 2 || slits.some((slit) => slit.length < 2))
                    failures.push(
                      `${label}: both walking pupils must remain visible, continuous slits`,
                    );
                }
                if (seated && eyePattern(pixels, groups[0] ?? [], facing) !== referenceEye)
                  failures.push(`${label}: the iris changes shape within the seated face`);
                // The full hanging pose has clear space beside its tail above the paws.
                if (
                  animation === 'tail-hang' &&
                  tailHangProgress === 1 &&
                  new Set(
                    (groups[0] ?? [])
                      .filter((index) => index % 96 >= 60 && Math.floor(index / 96) <= 25)
                      .map((index) => Math.floor(index / 96)),
                  ).size >= 8
                )
                  failures.push(`${label}: an upper paw fragment stretches beside the tail`);
                // Check retained artwork as well as connectivity, so large missing sections fail.
                const fittedBody = areaReferences.get(`${motionAngle}:${tailHangProgress}`) ?? body;
                if (size < fittedBody * 0.76 || size > fittedBody * 1.45)
                  failures.push(`${label}: anatomy area ${size}, reference ${fittedBody}`);
                if (groups.length > reference.length)
                  failures.push(`${label}: ${groups.length - reference.length} detached pieces`);
                for (let p = 1; p < groups.length; p++) {
                  const expected = props[p - 1] ?? 0;
                  const actual = groups[p]?.length ?? 0;
                  if (Math.abs(actual - expected) > Math.max(4, expected * 0.3))
                    failures.push(`${label}: unexpected piece of ${actual}px, prop ${expected}px`);
                }
                if (
                  groups.some((group) =>
                    group.some((index) => {
                      const x = index % 96;
                      const y = Math.floor(index / 96);
                      return x === 0 || x === 95 || y === 0 || y === 71;
                    }),
                  )
                )
                  failures.push(`${label}: silhouette touches the canvas edge`);
              }
            }
          }
          if (sample % 4 === 0 && sample < 24) {
            review.draw(context, animation, ms, 1, {
              variant,
              locomotionPhase: sample / 12,
              gripPhase: (sample / 12) % 1,
            });
            const x = (sample / 4) * 192;
            const y = row * 158;
            sheetContext.drawImage(canvas, x, y + 14, 192, 144);
            sheetContext.fillStyle = '#dce7c7';
            sheetContext.font = '11px monospace';
            sheetContext.fillText(`${animation} v${variant + 1} ${ms}ms`, x + 4, y + 12);
          }
        }
        row++;
      }
      ranges.push({ animation, body, min, max });
    }
    const failureCounts: Record<string, number> = {};
    for (const failure of failures) {
      const animation = failure.split('/')[0] ?? 'unknown';
      failureCounts[animation] = (failureCounts[animation] ?? 0) + 1;
    }
    return {
      failures,
      failureCounts,
      ranges,
      sampledMs: performance.now() - started,
      contactSheet: sheet.toDataURL('image/png'),
    };
  }, ANIMATIONS);
  const contactSheetPath = info.outputPath('animation-contact-sheet.png');
  await writeFile(contactSheetPath, Buffer.from(result.contactSheet.split(',')[1] ?? '', 'base64'));
  await info.attach('animation-contact-sheet', {
    path: contactSheetPath,
    contentType: 'image/png',
  });
  const diagnosticPath = info.outputPath('anatomy-diagnostics.json');
  await writeFile(diagnosticPath, JSON.stringify({ ...result, contactSheet: undefined }, null, 2));
  await info.attach('anatomy-area-ranges', {
    path: diagnosticPath,
    contentType: 'application/json',
  });
  expect(result.failureCounts).toEqual({});
});

for (const locale of ['ru-RU', 'en-US']) {
  for (const deviceScaleFactor of [1, 2]) {
    test(`the gecko slips from a real node and hangs by its tail in ${locale} at DPR ${deviceScaleFactor}`, async ({
      browser,
    }, info) => {
      test.setTimeout(45_000);
      const context = await browser.newContext({
        locale,
        deviceScaleFactor,
        viewport: { width: 1280, height: 800 },
        reducedMotion: 'no-preference',
      });
      const page = await context.newPage();
      try {
        await workspace(page);
        await page.mouse.move(650, 310);
        await page.keyboard.press('Tab');
        await page.locator('.tab-menu-row').first().click();
        await page.locator('.name-input').fill('Gecko perch');
        await page.keyboard.press('Enter');
        await expect(page.locator('.workspace')).toHaveAttribute('data-nodes', '1');
        await page.keyboard.press('Escape');
        await page.waitForFunction(
          () => ((window as ReviewWindow).__strataGeckoReview?.nodes().length ?? 0) > 0,
          undefined,
          { timeout: 5000 },
        );
        const nodeId = await page.evaluate(() => {
          const review = (window as ReviewWindow).__strataGeckoReview;
          const node = review?.nodes()[0];
          if (!node) throw new Error('No visible node for the gecko');
          review?.handle.climbNode(node.id);
          return node.id;
        });
        const actor = page.locator('[data-gecko-actor]');
        await expect(actor).toHaveAttribute('data-animation', 'tail-hang', { timeout: 20_000 });
        await page.waitForFunction(() => {
          const snapshot = (window as ReviewWindow).__strataGeckoReview?.snapshot();
          return snapshot?.nodePhase === 'hang' && snapshot.tailHangProgress >= 0.99;
        });
        expect(
          await page.evaluate(
            () => (window as ReviewWindow).__strataGeckoReview?.snapshot().nodeId,
          ),
        ).toBe(nodeId);
        await page.screenshot({
          path: info.outputPath(`tail-hang-${locale}-dpr${deviceScaleFactor}.png`),
        });
        const contact = await page.evaluate((id) => {
          const node = (window as ReviewWindow).__strataGeckoReview
            ?.nodes()
            .find((node) => node.id === id);
          const layer = document.querySelector('[data-gecko-layer]');
          const canvas = document.querySelector<HTMLCanvasElement>('[data-gecko-actor] canvas');
          if (!node || !layer || !canvas) throw new Error('The node and gecko must be visible');
          const pixels = canvas
            .getContext('2d')
            ?.getImageData(0, 0, canvas.width, canvas.height).data;
          if (!pixels) throw new Error('A canvas context is required');
          const host = layer.getBoundingClientRect();
          const sprite = canvas.getBoundingClientRect();
          const x = ((host.left + node.x - sprite.left) / sprite.width) * canvas.width;
          const y =
            ((host.top + node.y + node.radius - sprite.top) / sprite.height) * canvas.height;
          const tolerance = (4 * canvas.width) / 96;
          for (let py = Math.floor(y - tolerance); py <= Math.ceil(y + tolerance); py++) {
            for (let px = Math.floor(x - tolerance); px <= Math.ceil(x + tolerance); px++) {
              if (
                px >= 0 &&
                px < canvas.width &&
                py >= 0 &&
                py < canvas.height &&
                Math.hypot(px - x, py - y) <= tolerance &&
                (pixels[(py * canvas.width + px) * 4 + 3] ?? 0) > 0
              )
                return { touches: true, x, y };
            }
          }
          return { touches: false, x, y };
        }, nodeId);
        expect(contact, 'The tail must touch the actual lower edge of its node').toMatchObject({
          touches: true,
        });
      } catch (error) {
        const diagnostic = await page
          .evaluate(() => {
            const review = (window as ReviewWindow).__strataGeckoReview;
            const layer = document.querySelector('[data-gecko-layer]')?.getBoundingClientRect();
            return {
              nodes: review?.nodes(),
              snapshot: review?.snapshot(),
              bounds: layer ? { width: layer.width, height: layer.height } : null,
            };
          })
          .catch(() => undefined);
        if (diagnostic)
          await writeFile(
            info.outputPath('node-failure.json'),
            JSON.stringify(diagnostic, null, 2),
          );
        throw error;
      } finally {
        await context.close().catch(() => {});
      }
    });
  }
}
