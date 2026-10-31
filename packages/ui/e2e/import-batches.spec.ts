import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { box, LAYOUTS, overflowing } from './helpers';

// An import as a long task (13 §3.3, S1 step 5): the vault's workspace opens
// at once and its batches land in the background, counted at the foot of
// the canvas — «Импорт: 1 000 из 2 000» — with a cross that cancels it; the
// report comes with the last batch. One the app broke off asks «Откатить»
// or «Оставить» as its workspace opens (10 §3.3, NFR-71).

/**
 * A vault of `n` short notes in ten folders, each linking to the next:
 * several batches of 500. Latin names: a Chromium of the container cannot
 * read files with others (V-synth's Cyrillic is covered in import.spec.ts).
 */
function bigVault(n: number): string {
  const root = join(mkdtempSync(join(tmpdir(), 'strata-batches-')), 'Batches');
  for (let f = 0; f < 10; f++) mkdirSync(join(root, `Folder ${f}`), { recursive: true });
  for (let i = 0; i < n; i++) {
    const text = `# Note ${i}\n\nNext [[Note ${(i + 1) % n}]], #tag${i % 7}.\n`;
    writeFileSync(join(root, `Folder ${i % 10}`, `Note ${i}.md`), text);
  }
  return root;
}

const status = (page: Page) => page.locator('.ws-import');

/** Imports `n` notes; the batches land `pause` ms apart, to be watched. */
async function startImport(page: Page, n = 2000, pause = 400) {
  await page.goto(`/?plain&batchPause=${pause}`);
  await expect(page.locator('.home-vault')).toBeVisible();
  await page.locator('.home-vault-input').setInputFiles(bigVault(n));
  await expect(page.locator('.tab.is-active')).toHaveText('Batches', { timeout: 60_000 });
}

test.use({ locale: 'ru-RU' });

test('an import shows its batches as they land and its report at the end', async ({ page }) => {
  test.setTimeout(120_000);
  await startImport(page);
  // Counted as the batches land: 500 files a batch.
  await expect(status(page)).toBeVisible();
  await expect(status(page).locator('.ws-import-text')).toHaveText(
    /^Импорт: (разбор vault|[\d\s]+ из 2\s000)$/,
  );
  await expect(status(page).getByRole('button', { name: 'Отменить импорт' })).toBeVisible();
  // The report comes with the last one; the count goes.
  await expect(page.locator('.import-report')).toBeVisible({ timeout: 90_000 });
  await expect(status(page)).toHaveCount(0);
  await expect(page.locator('.import-counts li[aria-label="2000 заметок"]')).toBeVisible();
  await page.locator('.import-report .window-close').click();
  // The folders came in, each laid out; one step of undo takes all back.
  await expect(page.locator('.workspace')).toHaveAttribute('data-nodes', '10');
  await page
    .locator('.workspace canvas')
    .first()
    .click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+z');
  await expect(page.locator('.workspace')).toHaveAttribute('data-nodes', '0');
});

test('a cancelled import takes its workspace with it', async ({ page }) => {
  test.setTimeout(120_000);
  await startImport(page);
  await expect(status(page)).toBeVisible();
  await status(page).getByRole('button', { name: 'Отменить импорт' }).click();
  // Home again: no tab, no card of the vault.
  await expect(page.locator('.home-vault')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.tab', { hasText: 'Batches' })).toHaveCount(0);
  await expect(page.locator('.home-card', { hasText: 'Batches' })).toHaveCount(0);
});

for (const { viewport, deviceScaleFactor } of LAYOUTS.filter(
  (l) => l.viewport.width === 1280 && (l.deviceScaleFactor === 1 || l.deviceScaleFactor === 2),
)) {
  test(`the import's count keeps its size in RU and EN @${deviceScaleFactor}x`, async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const boxes = [];
    for (const locale of ['ru-RU', 'en-US']) {
      const context = await browser.newContext({ viewport, deviceScaleFactor, locale });
      const page = await context.newPage();
      await startImport(page);
      await expect(status(page)).toBeVisible();
      boxes.push(await box(page, '.ws-import'));
      expect(await overflowing(page, '.ws-import'), `${locale} text must fit`).toEqual([]);
      await page.screenshot({ path: test.info().outputPath(`import-count-${locale}.png`) });
      await context.close();
    }
    const [ru, en] = boxes;
    for (const k of ['x', 'width', 'height'] as const) {
      expect(Math.abs((en?.[k] ?? 0) - (ru?.[k] ?? 0)), `count ${k}`).toBeLessThanOrEqual(0.5);
    }
  });
}

/**
 * The app stopped in the middle of the import: its changeset is left
 * `in-progress` in the store (here — the browser's shelf, as the batches
 * had written it), and the workspace opens again.
 */
async function breakOff(page: Page): Promise<string> {
  await startImport(page, 40, 0);
  await expect(page.locator('.import-report')).toBeVisible({ timeout: 60_000 });
  const id = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((ok, fail) => {
      const r = indexedDB.open('strata', 1);
      r.onsuccess = () => ok(r.result);
      r.onerror = () => fail(r.error);
    });
    const get = <T>(store: IDBObjectStore, key: string) =>
      new Promise<T>((ok, fail) => {
        const r = store.get(key);
        r.onsuccess = () => ok(r.result as T);
        r.onerror = () => fail(r.error);
      });
    const kv = db.transaction('kv', 'readonly').objectStore('kv');
    const home = JSON.parse(new TextDecoder().decode(await get<Uint8Array>(kv, 'home'))) as {
      workspaces: { id: string; name: string }[];
    };
    const ws = home.workspaces.find((w) => w.name === 'Batches');
    if (!ws) throw new Error('no workspace');
    const raw = await get<Uint8Array>(
      db.transaction('kv', 'readonly').objectStore('kv'),
      `ws:${ws.id}`,
    );
    const dump = JSON.parse(new TextDecoder().decode(raw)) as {
      changesets: { id: string; origin: { type: string }; reverts?: string }[];
      open?: string[];
    };
    const imported = dump.changesets.find((c) => c.origin.type === 'import' && !c.reverts);
    if (!imported) throw new Error('no import');
    dump.open = [imported.id];
    await new Promise<void>((ok, fail) => {
      const t = db.transaction('kv', 'readwrite');
      t.objectStore('kv').put(new TextEncoder().encode(JSON.stringify(dump)), `ws:${ws.id}`);
      t.oncomplete = () => ok();
      t.onerror = () => fail(t.error);
    });
    return ws.id;
  });
  await page.goto('/?plain');
  await page.locator('.home-card', { hasText: 'Batches' }).locator('.home-open').click();
  return id;
}

test('an import the app broke off asks «Откатить» or «Оставить»', async ({ page }) => {
  test.setTimeout(120_000);
  await breakOff(page);
  const dialog = page.locator('.interrupted-dialog');
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await expect(dialog.locator('h2')).toHaveText('Импорт прерван');
  await expect(dialog.locator('.interrupted-name')).toHaveText('Batches');
  // «Откатить» is the default: what the batches wrote goes.
  await expect(dialog.getByRole('button', { name: 'Откатить' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.workspace')).toHaveAttribute('data-nodes', '0');
});

for (const { viewport, deviceScaleFactor } of LAYOUTS.filter(
  (l) => l.viewport.width === 1280 && (l.deviceScaleFactor === 1 || l.deviceScaleFactor === 2),
)) {
  test(`the broken-off import's question keeps its size in RU and EN @${deviceScaleFactor}x`, async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const boxes = [];
    for (const locale of ['ru-RU', 'en-US']) {
      const context = await browser.newContext({ viewport, deviceScaleFactor, locale });
      const page = await context.newPage();
      await breakOff(page);
      const dialog = page.locator('.interrupted-dialog');
      await expect(dialog).toBeVisible({ timeout: 30_000 });
      boxes.push(await box(page, '.interrupted-dialog'));
      expect(await overflowing(page, '.interrupted-dialog'), `${locale} text must fit`).toEqual([]);
      await page.screenshot({ path: test.info().outputPath(`import-interrupted-${locale}.png`) });
      // «Оставить» keeps what came in.
      await dialog.locator('.dialog-actions button').first().click();
      await expect(dialog).toHaveCount(0);
      await expect(page.locator('.workspace')).toHaveAttribute('data-nodes', '10');
      await context.close();
    }
    const [ru, en] = boxes;
    for (const k of ['x', 'y', 'width', 'height'] as const) {
      expect(Math.abs((en?.[k] ?? 0) - (ru?.[k] ?? 0)), `dialog ${k}`).toBeLessThanOrEqual(0.5);
    }
  });
}
