import { expect, type Page, test } from '@playwright/test';
import { box, LAYOUTS, overflowing } from './helpers';

// Milestone 1A (16 §4.7): the home screen (✅ Q-16-12) and a workspace on the
// canvas, written by the core — here the same Rust core as WASM, its store in
// IndexedDB. The checklist of the milestone, step by step: nodes through
// `Tab`, wires, `Enter` into a network and `U` out, a note in Russian whose
// `[[link]]` becomes a wire, undo of every step, the trash, a restart.

interface Node {
  id: string;
  name: string;
  kind: string;
}

interface WsHook {
  view: {
    camera: { toScreen(x: number, y: number): { x: number; y: number } };
    nodeAt(id: string): { x: number; y: number; r: number } | null;
    canvas: HTMLCanvasElement;
  };
  graph(): {
    nodes: Map<string, Node>;
    edges(): [string, string][];
    transaction(label: { key: string }, build: (tx: unknown) => void): unknown;
  } | null;
  net(): string;
  settled(): Promise<void>;
}

declare global {
  interface Window {
    __strataWs?: WsHook;
  }
}

/** Creates a workspace from the home screen and waits for its canvas. */
async function createWorkspace(page: Page, name: string) {
  await page.getByRole('button', { name: /Новое пространство|New workspace/ }).click();
  const field = page.locator('.dialog .field');
  await field.fill(name);
  await page.locator('.dialog button[type="submit"]').click();
  await expect(page.locator('.workspace')).toBeVisible();
  await page.waitForFunction(() => window.__strataWs?.graph() != null);
}

const graphNow = (page: Page) =>
  page.evaluate(() => {
    const g = window.__strataWs?.graph();
    if (!g) throw new Error('no graph');
    return {
      names: [...g.nodes.values()].map((n) => n.name).sort(),
      edges: g
        .edges()
        .map(([a, b]) => `${g.nodes.get(a)?.name}→${g.nodes.get(b)?.name}`)
        .sort(),
    };
  });

const idOf = (page: Page, name: string) =>
  page.evaluate((name) => {
    const g = window.__strataWs?.graph();
    const n = [...(g?.nodes.values() ?? [])].find((x) => x.name === name);
    if (!n) throw new Error(`no node ${name}`);
    return n.id;
  }, name);

/** Screen point of a node's bubble in page px. */
async function at(page: Page, name: string) {
  const id = await idOf(page, name);
  return page.evaluate((id) => {
    const ws = window.__strataWs as WsHook;
    const p = ws.view.nodeAt(id);
    if (!p) throw new Error('not drawn');
    const s = ws.view.camera.toScreen(p.x, p.y);
    const r = ws.view.canvas.getBoundingClientRect();
    return { x: r.left + s.x, y: r.top + s.y };
  }, id);
}

/** A node through the Tab menu at a free spot: the menu's text is its name. */
async function createNode(page: Page, x: number, y: number, name: string) {
  const before = (await graphNow(page)).names.length;
  await page.mouse.move(x, y);
  await page.keyboard.press('Tab');
  await expect(page.locator('.tab-menu')).toBeVisible();
  await page.keyboard.type(name);
  await page.keyboard.press('Enter');
  await expect(page.locator('.tab-menu')).toHaveCount(0);
  await expect(page.locator('.workspace')).toHaveAttribute('data-nodes', String(before + 1));
  await page.keyboard.press('Escape');
}

async function select(page: Page, name: string) {
  const p = await at(page, name);
  await page.mouse.click(p.x, p.y);
}

/** Every step so far is written by the core. */
const settled = (page: Page) => page.evaluate(() => window.__strataWs?.settled());

for (const { viewport, deviceScaleFactor } of LAYOUTS.filter((l) => l.deviceScaleFactor !== 1.5)) {
  test.describe(`home ${viewport.width}×${viewport.height} @${deviceScaleFactor}x`, () => {
    test.use({ viewport, deviceScaleFactor, locale: 'ru-RU' });

    test('the home window keeps its size when the language changes', async ({ page }) => {
      await page.goto('/?plain');
      await createWorkspace(page, 'Очень длинное название пространства для проверки обрезки');
      await page.getByRole('button', { name: 'Главная' }).click();
      await expect(page.locator('.home-card')).toHaveCount(1);
      const ru = await box(page, '.home-window');
      expect(await overflowing(page), 'RU text must fit').toEqual([]);
      await page.locator('.segmented label', { hasText: 'EN' }).click();
      await expect(page.locator('#home-title')).toHaveText('Home');
      const en = await box(page, '.home-window');
      expect(await overflowing(page), 'EN text must fit').toEqual([]);
      for (const k of ['x', 'y', 'width', 'height'] as const) {
        expect(Math.abs(en[k] - ru[k]), `home ${k}: RU ${ru[k]} → EN ${en[k]}`).toBeLessThanOrEqual(
          0.5,
        );
      }
    });
  });
}

test.describe('a workspace on the core', () => {
  test.use({ viewport: { width: 1280, height: 800 }, locale: 'ru-RU' });

  test('the checklist of milestone 1A', async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/?plain');
    await expect(page.locator('.home-empty')).toBeVisible();
    await createWorkspace(page, 'Игра');
    await expect(page.locator('.ws-path')).toHaveText('Игра');

    // Nodes through Tab, a wire between them.
    await createNode(page, 400, 300, 'Сценарий');
    await createNode(page, 700, 300, 'Цель');
    await createNode(page, 550, 520, 'Уровни');
    const a = await at(page, 'Сценарий');
    const b = await at(page, 'Цель');
    // From the port ring just outside the bubble (06 §1.3): a wire.
    const r = await page.evaluate(
      (id) => {
        const ws = window.__strataWs as WsHook;
        const p = ws.view.nodeAt(id);
        return p ? p.r * (ws.view.camera as unknown as { zoom: number }).zoom : 20;
      },
      await idOf(page, 'Сценарий'),
    );
    const ring = Math.max(8, 0.25 * r);
    await page.mouse.move(a.x, a.y + Math.max(r, 12) + ring / 2);
    await page.mouse.down();
    await page.mouse.move((a.x + b.x) / 2, a.y + 60, { steps: 10 });
    await page.mouse.move(b.x, b.y, { steps: 10 });
    await page.mouse.up();
    await expect.poll(async () => (await graphNow(page)).edges).toEqual(['Сценарий→Цель']);

    // Every step undoes and comes back.
    await page.keyboard.press('Control+z');
    await expect.poll(async () => (await graphNow(page)).edges).toEqual([]);
    await page.keyboard.press('Control+Shift+z');
    await expect.poll(async () => (await graphNow(page)).edges).toEqual(['Сценарий→Цель']);

    // A network: the first kind of the Tab menu, named right away (06 §5.5).
    await page.mouse.move(900, 520);
    await page.keyboard.press('Tab');
    await expect(page.locator('.tab-menu')).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.locator('.workspace')).toHaveAttribute('data-nodes', '4');
    await expect(page.locator('.name-input')).toBeVisible();
    await page.keyboard.type('Глава 1');
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await graphNow(page)).names).toContain('Глава 1');

    // Into the network and out (06 §1.4).
    await select(page, 'Глава 1');
    await page.keyboard.press('Enter');
    await expect(page.locator('.ws-path')).toHaveText(/Игра.*Глава 1/);
    await expect(page.locator('.workspace')).toHaveAttribute('data-nodes', '0');
    await createNode(page, 600, 400, 'Внутри');
    await page.keyboard.press('KeyU');
    await expect(page.locator('.ws-path')).toHaveText('Игра');
    await expect(page.locator('.workspace')).toHaveAttribute('data-nodes', '4');
    // Undo reaches the step made inside, from outside: the session's history.
    await page.keyboard.press('Control+z');
    await settled(page);
    await select(page, 'Глава 1');
    await page.keyboard.press('Enter');
    await expect(page.locator('.workspace')).toHaveAttribute('data-nodes', '0');
    await page.keyboard.press('Control+Shift+z');
    await settled(page);
    await expect(page.locator('.workspace')).toHaveAttribute('data-nodes', '1');
    await page.keyboard.press('KeyU');
    await expect(page.locator('.workspace')).toHaveAttribute('data-nodes', '4');

    // A note in Russian; its [[link]] becomes a wire, written by the core.
    await select(page, 'Уровни');
    await page.keyboard.press('Enter');
    const editor = page.locator('.note-window .cm-content');
    await expect(editor).toBeVisible();
    await editor.click();
    await page.keyboard.type('Ёлки-палки, см. [[Цель]]');
    await expect
      .poll(async () => (await graphNow(page)).edges)
      .toEqual(['Сценарий→Цель', 'Уровни→Цель']);
    await page.locator('.note-window .window-close').click();

    // Into the trash and back, with its wire.
    await select(page, 'Сценарий');
    await page.keyboard.press('Delete');
    await expect(page.locator('.workspace')).toHaveAttribute('data-nodes', '3');
    await settled(page);
    await page.getByRole('button', { name: /Корзина/ }).click();
    await expect(page.locator('.ws-trash-list li')).toHaveCount(1);
    await page.locator('.ws-trash-list button').click();
    await expect(page.locator('.workspace')).toHaveAttribute('data-nodes', '4');
    await expect
      .poll(async () => (await graphNow(page)).edges)
      .toEqual(['Сценарий→Цель', 'Уровни→Цель']);
    await page.locator('.ws-trash .window-close').click();

    // A restart: everything in place, the note's text too.
    await settled(page);
    const before = await graphNow(page);
    await page.reload();
    await expect(page.locator('.home-card')).toHaveCount(1);
    await page.locator('.home-open').click();
    await page.waitForFunction(() => window.__strataWs?.graph() != null);
    await expect(page.locator('.workspace')).toHaveAttribute('data-nodes', '4');
    expect(await graphNow(page)).toEqual(before);
    await select(page, 'Уровни');
    await page.keyboard.press('Enter');
    await expect(page.locator('.note-window .cm-content')).toContainText('Ёлки-палки');
  });

  test('workspaces are renamed and deleted from the home screen', async ({ page }) => {
    await page.goto('/?plain');
    await createWorkspace(page, 'Работа');
    await page.getByRole('button', { name: 'Главная' }).click();
    await createWorkspace(page, 'Личное');
    await page.getByRole('button', { name: 'Главная' }).click();
    await expect(page.locator('.home-name')).toHaveText(['Личное', 'Работа']);
    // The card has a picture of the canvas once the workspace was open.
    await expect(page.locator('.home-preview img')).toHaveCount(2);

    const work = page.locator('.home-card', { hasText: 'Работа' });
    await work.getByRole('button', { name: 'Переименовать' }).click();
    await page.locator('.dialog .field').fill('Работа 2026');
    await page.locator('.dialog button[type="submit"]').click();
    await expect(page.locator('.home-name')).toHaveText(['Личное', 'Работа 2026']);

    await page
      .locator('.home-card', { hasText: 'Личное' })
      .getByRole('button', { name: 'Удалить' })
      .click();
    await expect(page.locator('.dialog')).toContainText('из этого браузера');
    await page.locator('.dialog button.is-default').click();
    await expect(page.locator('.home-name')).toHaveText(['Работа 2026']);

    await page.reload();
    await expect(page.locator('.home-name')).toHaveText(['Работа 2026']);
    await page.locator('.home-open').click();
    await expect(page.locator('#ws-title')).toHaveText('Работа 2026');
  });

  test('a workspace goes out as .strata.zip and comes back as a copy', async ({ page }) => {
    await page.goto('/?plain');
    await createWorkspace(page, 'Архив');
    await createNode(page, 600, 400, 'Нода');
    await settled(page);
    await page.getByRole('button', { name: 'Главная' }).click();
    const [file] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('.home-card').getByRole('button', { name: 'Экспорт' }).click(),
    ]);
    expect(file.suggestedFilename()).toBe('Архив.strata.zip');
    await expect(page.locator('.home-note')).toContainText('Архив.strata.zip');
    // This browser has the workspace: the archive opens as a copy.
    await page.locator('.home-bar input[type="file"]').setInputFiles(await file.path());
    await expect(page.locator('.workspace')).toBeVisible();
    await page.waitForFunction(() => window.__strataWs?.graph() != null);
    await expect(page.locator('.workspace')).toHaveAttribute('data-nodes', '1');
    expect((await graphNow(page)).names).toEqual(['Нода']);
    await page.getByRole('button', { name: 'Главная' }).click();
    await expect(page.locator('.home-name')).toHaveText(['Архив', 'Архив']);
  });

  test('the profile is kept on this device', async ({ page }) => {
    await page.goto('/?plain');
    const field = page.locator('.home-profile .field');
    await field.fill('Антон');
    await field.press('Enter');
    // Written to this device before the reload.
    await expect(page.locator('.home-window')).toHaveAttribute('data-profile', 'Антон');
    await page.reload();
    await expect(page.locator('.home-profile .field')).toHaveValue('Антон');
  });
});
