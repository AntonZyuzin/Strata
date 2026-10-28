import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { vsynthVault } from '../../editor/src/vsynth-vault';
import { box, LAYOUTS, overflowing } from './helpers';

// Milestone 1C (16 §4.7, scenario S1): V-synth's vault (13 §7.2) picked as a
// folder on the home screen comes in as a new workspace through the WASM
// core; its report opens over the canvas; one undo takes the vault back.

interface ImportHook {
  graph(): { nodes: Map<string, { name: string; kind: string }> } | null;
  editor(): { selected: string[] } | null;
  settled(): Promise<void>;
}

/** The vault on disk, as a folder picker gives it: `…/V-synth/…`. */
function vaultDir(): string {
  const root = join(mkdtempSync(join(tmpdir(), 'strata-vsynth-')), 'V-synth');
  for (const f of vsynthVault()) {
    const path = join(root, f.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, f.bytes);
  }
  return root;
}

test.use({ locale: 'ru-RU' });

const names = (page: Page) =>
  page.evaluate(() => {
    const ws = (window as unknown as { __strataWs?: ImportHook }).__strataWs;
    return [...(ws?.graph()?.nodes.values() ?? [])].map((n) => n.name).sort();
  });

/** Imports V-synth from the home screen and waits for its report. */
async function importVault(page: Page) {
  await page.goto('/?plain');
  await expect(page.locator('.home-vault')).toBeVisible();
  await page.locator('.home-vault-input').setInputFiles(vaultDir());
  await expect(page.locator('.import-report')).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction(
    () => (window as unknown as { __strataWs?: ImportHook }).__strataWs?.graph() != null,
  );
}

test('a vault comes in from the home screen and goes back with one undo', async ({ page }) => {
  test.setTimeout(90_000);
  await importVault(page);
  const report = page.locator('.import-report');
  // What came in, and the sections of 13 §3.6.
  await expect(report.locator('.import-counts li[aria-label="3 доски"]')).toBeVisible();
  for (const section of ['Призраки', 'Неоднозначные ссылки', 'Канвасы', 'Пропущенные файлы']) {
    await expect(report.locator('.import-section h3', { hasText: section })).toBeVisible();
  }
  await expect(
    report.locator('.import-text', { hasText: 'Неоднозначная ссылка [[Диздок]]' }),
  ).toBeVisible();
  // The tab is the vault's folder; the root holds its folders, notes and canvases.
  await expect(page.locator('.tab.is-active')).toHaveText('V-synth');
  await report.locator('.window-close').click();
  await expect(report).toHaveCount(0);
  // Safari leaves `.obsidian` out of a picked folder: what the config decides
  // (attachments, filters) is the core's tests' (13 §2.6).
  const root = await names(page);
  for (const name of ['Входящие', 'Проекты', 'Заметки', 'План', 'Рисунок', 'Идей']) {
    expect(root, name).toContain(name);
  }
  // The palette opens the report again; a line goes to its node.
  await page
    .locator('.workspace canvas')
    .first()
    .click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+p');
  await page.locator('.command-palette input').fill('отчёт импорта');
  await page.keyboard.press('Enter');
  await expect(report).toBeVisible();
  await report
    .locator('.import-section', { hasText: 'Свойства' })
    .locator('.import-row', { hasText: 'Ошибка разбора YAML' })
    .click();
  await expect(report).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const ws = (window as unknown as { __strataWs?: ImportHook }).__strataWs;
        const g = ws?.graph();
        return (ws?.editor()?.selected ?? []).map((id) => g?.nodes.get(id)?.name);
      }),
    )
    .toEqual(['Битый']);
  // One step of undo takes the whole vault back (13 §1.4 item 3).
  await page.keyboard.press('Control+z');
  await expect(page.locator('.workspace')).toHaveAttribute('data-nodes', '0');
  await page.keyboard.press('Control+Shift+z');
  await expect.poll(async () => (await names(page)).length).toBeGreaterThan(20);
});

for (const { viewport, deviceScaleFactor } of LAYOUTS.filter(
  (l) => l.viewport.width === 1280 && (l.deviceScaleFactor === 1 || l.deviceScaleFactor === 2),
)) {
  test(`the import report keeps its size in RU and EN @${deviceScaleFactor}x`, async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const boxes = [];
    for (const locale of ['ru-RU', 'en-US']) {
      const context = await browser.newContext({ viewport, deviceScaleFactor, locale });
      const page = await context.newPage();
      await importVault(page);
      await expect(page.locator('.import-report h2')).toHaveText(
        locale === 'ru-RU' ? 'Отчёт импорта' : 'Import report',
      );
      boxes.push(await box(page, '.import-report'));
      expect(await overflowing(page, '.import-report'), `${locale} text must fit`).toEqual([]);
      await page.screenshot({ path: test.info().outputPath(`import-report-${locale}.png`) });
      await context.close();
    }
    const [ru, en] = boxes;
    for (const k of ['x', 'y', 'width', 'height'] as const) {
      expect(Math.abs((en?.[k] ?? 0) - (ru?.[k] ?? 0)), `report ${k}`).toBeLessThanOrEqual(0.5);
    }
  });
}
