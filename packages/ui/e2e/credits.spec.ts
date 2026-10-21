import { expect, test } from '@playwright/test';
import { box, LAYOUTS, overflowing } from './helpers';

// «Благодарности» (07 §6.3): the same box in RU and EN at every DPR of the
// matrix, nothing cut, and every game-icons author of the shipped presets listed.

for (const { viewport, deviceScaleFactor } of LAYOUTS) {
  test(`credits window is locale-independent at ${viewport.width}×${viewport.height} @${deviceScaleFactor}x`, async ({
    browser,
  }, info) => {
    const sides = [];
    for (const locale of ['ru-RU', 'en-US']) {
      const context = await browser.newContext({ viewport, deviceScaleFactor, locale });
      const page = await context.newPage();
      await page.goto('/?credits');
      await expect(page.locator('.credits-list dt', { hasText: 'Lorc' })).toBeVisible();
      await expect(page.locator('.credits-list dt', { hasText: 'Delapouite' })).toBeVisible();
      expect(await overflowing(page), `${locale}: text must fit or carry a tooltip`).toEqual([]);
      await page.screenshot({ path: info.outputPath(`${locale}.png`) });
      sides.push({ context, box: await box(page, '.window-credits') });
    }
    const [ru, en] = sides;
    for (const k of ['x', 'y', 'width', 'height'] as const) {
      expect(Math.abs((en?.box[k] ?? 0) - (ru?.box[k] ?? 0)), `credits ${k}`).toBeLessThanOrEqual(
        0.5,
      );
    }
    for (const s of sides) await s.context.close();
  });
}
