import { type Browser, expect, test } from '@playwright/test';
import { box, overflowing, SCALES, VIEWPORTS } from './helpers';

// Benchmark window (16 §3.2 step 0.3). Layout: the same box in RU and EN, idle
// and with results. Run: the `quick` profile end to end under the desktop CSP,
// which is what WKWebView and WebView2 enforce. CI WebGL is software, so no
// frame thresholds here (14 §17).

async function open(
  browser: Browser,
  locale: string,
  viewport: { width: number; height: number },
  deviceScaleFactor: number,
) {
  const context = await browser.newContext({ locale, viewport, deviceScaleFactor });
  const page = await context.newPage();
  await page.goto('/?bench=quick');
  await expect(page.locator('.bench-table')).toBeVisible();
  return { context, page };
}

for (const viewport of VIEWPORTS) {
  for (const deviceScaleFactor of SCALES) {
    test(`bench window is locale-independent at ${viewport.width}×${viewport.height} @${deviceScaleFactor}x`, async ({
      browser,
    }, info) => {
      const ru = await open(browser, 'ru-RU', viewport, deviceScaleFactor);
      const en = await open(browser, 'en-US', viewport, deviceScaleFactor);
      await ru.page.screenshot({ path: info.outputPath('ru.png') });
      await en.page.screenshot({ path: info.outputPath('en.png') });
      expect(await overflowing(ru.page), 'RU text must fit').toEqual([]);
      expect(await overflowing(en.page), 'EN text must fit').toEqual([]);
      const a = await box(ru.page, '.window');
      const b = await box(en.page, '.window');
      for (const k of ['x', 'y', 'width', 'height'] as const) {
        expect(Math.abs(a[k] - b[k]), `window ${k}: RU ${a[k]} vs EN ${b[k]}`).toBeLessThanOrEqual(
          0.5,
        );
      }
      await ru.context.close();
      await en.context.close();
    });
  }
}

test('quick benchmark runs end to end and reports every scenario', async ({ browser }, info) => {
  test.setTimeout(240_000);
  const context = await browser.newContext({
    locale: 'ru-RU',
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  // `autorun` starts at once and shows the report text when done.
  await page.goto('/?bench=quick&autorun');
  await expect(page.locator('.bench-canvas canvas')).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1_000);
  await page.screenshot({ path: info.outputPath('canvas.png') });

  await expect(page.locator('.bench-table')).toHaveAttribute('data-state', 'done', {
    timeout: 200_000,
  });
  await page.screenshot({ path: info.outputPath('done.png') });
  const cells = await page.locator('.bench-row dd').allTextContents();
  expect(cells).toHaveLength(6);
  for (const c of cells) expect(c, 'a verdict and numbers').toMatch(/^[✓✗] .*\d/);
  for (const c of cells) expect(c).not.toContain('ошибка');
  expect(await overflowing(page), 'results must fit').toEqual([]);

  const report = JSON.parse(await page.locator('textarea.report').inputValue());
  expect(report.report).toBe('strata-bench');
  expect(report.profile).toBe('quick');
  expect(report.outcomes.map((o: { ok: boolean }) => o.ok)).toEqual(Array(6).fill(true));
  expect(report.env.webgl).not.toBeNull();
  const index = report.outcomes.filter((o: { id: string }) => o.id.startsWith('loro-index'));
  for (const o of index) expect(o.result.isolated, `${o.id} ran in workers`).toBe(true);
  expect(errors).toEqual([]);
  await context.close();
});

test('the window keeps its size through a run and the report can be copied', async ({
  browser,
  browserName,
}) => {
  test.setTimeout(240_000);
  const context = await browser.newContext({
    locale: 'ru-RU',
    viewport: { width: 800, height: 500 },
  });
  if (browserName === 'chromium') {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  }
  const page = await context.newPage();
  await page.goto('/?bench=quick&only=loro-text-1mb');
  const before = await box(page, '.window');
  await page.getByRole('button', { name: 'Запустить' }).click();
  await expect(page.locator('.bench-table')).toHaveAttribute('data-state', 'done', {
    timeout: 60_000,
  });
  expect(await box(page, '.window')).toEqual(before);
  await page.getByRole('button', { name: 'Копировать отчёт' }).click();
  const status = page.getByRole('status');
  await expect(status).not.toBeEmpty();
  // WebKit may refuse the clipboard; then the report is shown for manual copy.
  const text =
    (await status.textContent()) === 'Отчёт скопирован'
      ? browserName === 'chromium'
        ? await page.evaluate(() => navigator.clipboard.readText())
        : null
      : await page.locator('textarea.report').inputValue();
  if (text !== null) expect(JSON.parse(text).outcomes).toHaveLength(1);
  await context.close();
});
