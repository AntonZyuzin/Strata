import { expect, type Page, test } from '@playwright/test';

/** The longest core string a release build can show (15 §2.2). */
const LONGEST_CORE = 'strata-core 0.0.1 (windows-x86_64)';

const VIEWPORTS = [
  { width: 800, height: 500 },
  { width: 1280, height: 800 },
];
const SCALES = [1, 2];

async function box(page: Page, selector: string) {
  const b = await page.locator(selector).boundingBox();
  if (!b) throw new Error(`${selector} is not visible`);
  return b;
}

/** Elements whose text overflows its box (truncated by ellipsis or clipped). */
async function overflowing(page: Page): Promise<string[]> {
  return page.$$eval('.window *', (els) =>
    els
      .filter((el) => el.children.length === 0 && (el.textContent ?? '').trim() !== '')
      .filter((el) => !el.classList.contains('sr-only'))
      .filter((el) => el.scrollWidth > el.clientWidth + 1)
      .map((el) => `${el.tagName.toLowerCase()}.${el.className}: «${el.textContent}»`),
  );
}

async function switchTo(page: Page, short: 'RU' | 'EN') {
  await page.locator('.segmented label', { hasText: short }).click();
  await expect(page.locator('.segmented label.is-active span[aria-hidden]')).toHaveText(short);
}

for (const viewport of VIEWPORTS) {
  for (const deviceScaleFactor of SCALES) {
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
}

test('close button hides the window in a browser and it can be reopened', async ({ page }) => {
  await page.goto('/');
  await page.locator('.window-close').click();
  await expect(page.locator('.window')).toHaveCount(0);
  await page.getByRole('button').click();
  await expect(page.locator('.window')).toBeVisible();
});
