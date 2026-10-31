import { expect, type Page, test } from '@playwright/test';
import { box, LAYOUTS, overflowing } from './helpers';

// Font and window check of spike 9 (07 §13): the window keeps its box in RU
// and EN at every DPR of the matrix, and the pixel fonts land on whole device
// pixels at the sizes of 07 §2.4.

/** Departure Mono `ui` and Press Start 2P `display-s` in device px by DPR (07 §2.4). */
const PHYSICAL: Record<number, { ui: number; display: number }> = {
  1: { ui: 11, display: 16 },
  1.25: { ui: 22, display: 24 },
  1.5: { ui: 22, display: 24 },
  2: { ui: 22, display: 32 },
};

async function switchTo(page: Page, short: 'RU' | 'EN') {
  await page.locator('.segmented label', { hasText: short }).click();
  await expect(page.locator('.segmented label.is-active span[aria-hidden]').first()).toHaveText(
    short,
  );
}

const devicePx = (page: Page, selector: string) =>
  page.evaluate(
    (sel) =>
      Number.parseFloat(getComputedStyle(document.querySelector(sel) as Element).fontSize) *
      window.devicePixelRatio,
    selector,
  );

for (const { viewport, deviceScaleFactor } of LAYOUTS) {
  test(`fonts window is locale-independent at ${viewport.width}×${viewport.height} @${deviceScaleFactor}x`, async ({
    browser,
  }, info) => {
    const context = await browser.newContext({ viewport, deviceScaleFactor, locale: 'ru-RU' });
    const page = await context.newPage();
    await page.goto('/?fonts');
    await expect(page.locator('.window-fonts')).toBeVisible();

    const want = PHYSICAL[deviceScaleFactor];
    expect(want).toBeDefined();
    expect(await devicePx(page, 'body')).toBeCloseTo(want?.ui ?? 0, 3);
    expect(await devicePx(page, '.window-title h1')).toBeCloseTo(want?.display ?? 0, 3);

    await page.screenshot({ path: info.outputPath('ru.png'), fullPage: true });
    const ru = await box(page, '.window-fonts');
    expect(await overflowing(page), 'RU text must fit without truncation').toEqual([]);

    await switchTo(page, 'EN');
    await page.screenshot({ path: info.outputPath('en.png'), fullPage: true });
    const en = await box(page, '.window-fonts');
    expect(await overflowing(page), 'EN text must fit without truncation').toEqual([]);
    for (const k of ['x', 'y', 'width', 'height'] as const) {
      expect(
        Math.abs(en[k] - ru[k]),
        `fonts window ${k}: RU ${ru[k]} → EN ${en[k]}`,
      ).toBeLessThanOrEqual(0.5);
    }
    await context.close();
  });
}

for (const deviceScaleFactor of [1.25, 1.5]) {
  test(`at DPR ${deviceScaleFactor} Departure Mono takes the larger step, 22 device px (☑ Q-07-18)`, async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor,
      locale: 'en-US',
    });
    const page = await context.newPage();
    // A device that chose «Мельче» while the spike compared both: the choice is gone.
    await page.addInitScript(() =>
      localStorage.setItem('strata.pixel', JSON.stringify({ scale: 1, rounding: 'down' })),
    );
    await page.goto('/?fonts');
    await expect(page.locator('.window-fonts')).toBeVisible();
    expect(await devicePx(page, 'body')).toBeCloseTo(22, 3);
    await context.close();
  });
}
