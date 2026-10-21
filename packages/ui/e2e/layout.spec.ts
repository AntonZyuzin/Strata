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
  });
}

test('close button hides the window in a browser and it can be reopened', async ({ page }) => {
  await page.goto('/');
  await page.locator('.window-close').click();
  await expect(page.locator('.window')).toHaveCount(0);
  await page.getByRole('button').click();
  await expect(page.locator('.window')).toBeVisible();
});
