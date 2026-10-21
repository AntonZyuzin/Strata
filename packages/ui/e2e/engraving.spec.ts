import { expect, type Page, test } from '@playwright/test';
import { box, LAYOUTS, overflowing } from './helpers';

// «Гравюра» check of spike 9 (07 §6.4–6.5): pictures go through «привести к
// стилю» and land in three bubbles; the window keeps its box in RU and EN, and
// the summary counts good pictures with no manual edit only.

/** Adds three generated pictures through the file input: a logo, a photo-like gradient, a cut-out. */
async function addPictures(page: Page) {
  await page.evaluate(async () => {
    const make = async (name: string, draw: (c: CanvasRenderingContext2D) => void) => {
      const canvas = document.createElement('canvas');
      canvas.width = 300;
      canvas.height = 200;
      const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
      draw(ctx);
      const blob = await new Promise<Blob>((ok) =>
        canvas.toBlob((b) => ok(b as Blob), 'image/png'),
      );
      return new File([blob], name, { type: 'image/png' });
    };
    const files = [
      await make('logo.png', (c) => {
        c.fillStyle = '#ffffff';
        c.fillRect(0, 0, 300, 200);
        c.fillStyle = '#1a2a6c';
        c.beginPath();
        c.arc(150, 100, 70, 0, Math.PI * 2);
        c.fill();
      }),
      await make('photo.png', (c) => {
        const g = c.createLinearGradient(0, 0, 300, 200);
        g.addColorStop(0, '#d9a066');
        g.addColorStop(0.5, '#3b5b8a');
        g.addColorStop(1, '#f0e0c0');
        c.fillStyle = g;
        c.fillRect(0, 0, 300, 200);
      }),
      await make('cutout.png', (c) => {
        c.fillStyle = '#333333';
        c.fillRect(100, 40, 100, 120);
      }),
    ];
    const input = document.querySelector('.window-engraving input[type=file]') as HTMLInputElement;
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(f);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(page.locator('.engraving-row')).toHaveCount(3);
}

for (const { viewport, deviceScaleFactor } of LAYOUTS) {
  test(`engraving window is locale-independent at ${viewport.width}×${viewport.height} @${deviceScaleFactor}x`, async ({
    browser,
  }, info) => {
    const boxes = [];
    for (const locale of ['ru-RU', 'en-US']) {
      const context = await browser.newContext({ viewport, deviceScaleFactor, locale });
      const page = await context.newPage();
      await page.goto('/?engraving');
      await expect(page.locator('.window-engraving')).toBeVisible();
      await addPictures(page);
      expect(await overflowing(page), `${locale}: text must fit or carry a tooltip`).toEqual([]);
      await page.screenshot({ path: info.outputPath(`${locale}.png`) });
      boxes.push(await box(page, '.window-engraving'));
      await context.close();
    }
    const [ru, en] = boxes;
    for (const k of ['x', 'y', 'width', 'height'] as const) {
      expect(Math.abs((en?.[k] ?? 0) - (ru?.[k] ?? 0)), `engraving ${k}`).toBeLessThanOrEqual(0.5);
    }
  });
}

test('only pictures good with no edit count, and every one gets ink in its bubble', async ({
  page,
}) => {
  await page.goto('/?engraving');
  await addPictures(page);
  const rows = page.locator('.engraving-row');
  // Each picture leaves ink in the bubble: some dark pixels inside the preview.
  const inked = await page.$$eval('.engraving-preview', (canvases) =>
    canvases.map((c) => {
      const ctx = (c as HTMLCanvasElement).getContext('2d') as CanvasRenderingContext2D;
      const { width, height } = c as HTMLCanvasElement;
      const d = ctx.getImageData(0, 0, width, height).data;
      let dark = 0;
      for (let i = 0; i < d.length; i += 4) if ((d[i + 3] ?? 0) > 200 && (d[i] ?? 255) < 80) dark++;
      return dark;
    }),
  );
  expect(inked.filter((_, i) => i % 3 === 0).every((n) => n > 20)).toBe(true);

  await rows.nth(0).locator('.engraving-verdict button').first().click();
  await rows.nth(1).locator('.engraving-verdict button').last().click();
  await rows.nth(2).locator('select').selectOption('silhouette');
  await rows.nth(2).locator('.engraving-verdict button').first().click();
  await expect(page.locator('.engraving-summary')).toContainText('1');
  await expect(page.locator('.engraving-summary')).toContainText('3');
  const summary = await page.locator('.engraving-summary').textContent();
  expect(summary).toMatch(/\b1\b\D+\b3\b\D+\b3\b/);
});
