import { expect, type Page, test } from '@playwright/test';
import { box, LAYOUTS, LONGEST_CORE, overflowing } from './helpers';

async function switchTo(page: Page, short: 'RU' | 'EN') {
  await page.locator('.segmented label', { hasText: short }).click();
  await expect(page.locator('.segmented label.is-active span[aria-hidden]')).toHaveText(short);
}

for (const { viewport, deviceScaleFactor } of LAYOUTS) {
  test.describe(`${viewport.width}×${viewport.height} @${deviceScaleFactor}x`, () => {
    test.use({ viewport, deviceScaleFactor, locale: 'ru-RU' });

    test('about window keeps its size when the language changes', async ({ page }, info) => {
      await page.goto(`/?core=${encodeURIComponent(LONGEST_CORE)}`);
      await expect(page.locator('.window')).toBeVisible();
      await page.screenshot({ path: info.outputPath('ru.png') });
      const ru = await box(page, '.window');
      expect(await overflowing(page), 'RU text must fit without truncation').toEqual([]);

      await switchTo(page, 'EN');
      await page.screenshot({ path: info.outputPath('en.png') });
      const en = await box(page, '.window');
      expect(await overflowing(page), 'EN text must fit without truncation').toEqual([]);

      for (const k of ['x', 'y', 'width', 'height'] as const) {
        expect(
          Math.abs(en[k] - ru[k]),
          `window ${k} changed: RU ${ru[k]} → EN ${en[k]}`,
        ).toBeLessThanOrEqual(0.5);
      }

      await switchTo(page, 'RU');
      const back = await box(page, '.window');
      expect(back).toEqual(ru);
    });

    test('the pixel × sits in the middle of its button', async ({ page }) => {
      await page.goto('/?about');
      const close = page.locator('.window-close');
      for (const hover of [false, true]) {
        if (hover) await close.hover();
        const m = await inkMargins(page, await close.screenshot());
        expect(m.left + m.right, 'no × drawn').toBeLessThan(m.width);
        expect(
          Math.abs(m.left - m.right),
          `× off centre: ${JSON.stringify(m)}`,
        ).toBeLessThanOrEqual(2);
        expect(
          Math.abs(m.top - m.bottom),
          `× off centre: ${JSON.stringify(m)}`,
        ).toBeLessThanOrEqual(2);
      }
    });
  });
}

/** Device pixels from each edge of a screenshot to its ink: the pixels unlike its corner. */
async function inkMargins(page: Page, png: Buffer) {
  return page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const g = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d');
    if (!g) throw new Error('no 2d context');
    g.drawImage(bmp, 0, 0);
    const { data, width, height } = g.getImageData(0, 0, bmp.width, bmp.height);
    const d = (i: number, k: number) => Math.abs((data[i + k] ?? 0) - (data[k] ?? 0));
    const far = (i: number) => d(i, 0) + d(i, 1) + d(i, 2) > 96;
    let [x0, y0, x1, y1] = [width, height, -1, -1];
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        if (far((y * width + x) * 4))
          [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
    return { width, left: x0, right: width - 1 - x1, top: y0, bottom: height - 1 - y1 };
  }, png.toString('base64'));
}

test('close button hides the window in a browser and it can be reopened', async ({ page }) => {
  await page.goto('/?about');
  await page.locator('.window-close').click();
  await expect(page.locator('.window')).toHaveCount(0);
  await page.getByRole('button').click();
  await expect(page.locator('.window')).toBeVisible();
});
