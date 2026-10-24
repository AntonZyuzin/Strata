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
  attrs: Record<string, unknown>;
  color: number | null;
}

interface WsHook {
  view: {
    hasPicture(id: string): boolean;
    iconOf(id: string): 'picture' | 'kind' | 'preset' | null;
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
  await page.locator('.home-new').click();
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

/** A card's action: its icon, or its right-button menu. */
async function cardAction(page: Page, card: string, action: string, right = false) {
  const el = page.locator('.home-card', { hasText: card });
  if (!right) {
    await el.getByRole('button', { name: action }).click();
    return;
  }
  await el.locator('.home-open').click({ button: 'right' });
  await page.getByRole('menuitem', { name: action }).click();
}

/** Every step so far is written by the core. */
const settled = (page: Page) => page.evaluate(() => window.__strataWs?.settled());

for (const { viewport, deviceScaleFactor } of LAYOUTS.filter((l) => l.deviceScaleFactor !== 1.5)) {
  test.describe(`home ${viewport.width}×${viewport.height} @${deviceScaleFactor}x`, () => {
    test.use({ viewport, deviceScaleFactor, locale: 'ru-RU' });

    test('the home bar keeps its size when the language changes', async ({ page }) => {
      await page.goto('/?plain');
      await createWorkspace(page, 'Очень длинное название пространства для проверки обрезки');
      await page.getByRole('button', { name: 'Главная' }).click();
      await expect(page.locator('.home-card')).toHaveCount(1);
      const ru = await box(page, '.home-top');
      expect(await overflowing(page, '.home'), 'RU text must fit').toEqual([]);
      await page.locator('.segmented label', { hasText: 'EN' }).click();
      await expect(page.locator('.home-new')).toHaveText('New workspace');
      const en = await box(page, '.home-top');
      expect(await overflowing(page, '.home'), 'EN text must fit').toEqual([]);
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
    await expect(page.locator('.workspace')).toHaveAttribute('data-depth', '1');

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
    await expect(page.locator('.workspace')).toHaveAttribute('data-depth', '2');
    await expect(page.locator('.workspace')).toHaveAttribute('data-nodes', '0');
    await createNode(page, 600, 400, 'Внутри');
    await page.keyboard.press('KeyU');
    await expect(page.locator('.workspace')).toHaveAttribute('data-depth', '1');
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
    // The trash is the foot of «Слои».
    await page.locator('.layers-trash summary').click();
    await expect(page.locator('.layers-trash li')).toHaveCount(1);
    await page.locator('.layers-trash button').click();
    await expect(page.locator('.workspace')).toHaveAttribute('data-nodes', '4');
    await expect
      .poll(async () => (await graphNow(page)).edges)
      .toEqual(['Сценарий→Цель', 'Уровни→Цель']);

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

    await cardAction(page, 'Работа', 'Переименовать');
    await page.locator('.dialog .field').fill('Работа 2026');
    await page.locator('.dialog button[type="submit"]').click();
    await expect(page.locator('.home-name')).toHaveText(['Личное', 'Работа 2026']);

    await cardAction(page, 'Личное', 'Удалить', true);
    await expect(page.locator('.dialog')).toContainText('из этого браузера');
    await page.locator('.dialog button.is-default').click();
    await expect(page.locator('.home-name')).toHaveText(['Работа 2026']);

    await page.reload();
    await expect(page.locator('.home-name')).toHaveText(['Работа 2026']);
    await page.locator('.home-open').click();
    await expect(page.locator('.tab.is-active')).toHaveText('Работа 2026');
  });

  test('a workspace goes out as .strata.zip and comes back as a copy', async ({ page }) => {
    await page.goto('/?plain');
    await createWorkspace(page, 'Архив');
    await createNode(page, 600, 400, 'Нода');
    await settled(page);
    await page.getByRole('button', { name: 'Главная' }).click();
    const [file] = await Promise.all([
      page.waitForEvent('download'),
      cardAction(page, 'Архив', 'Экспорт', true),
    ]);
    expect(file.suggestedFilename()).toBe('Архив.strata.zip');
    await expect(page.locator('.home-note')).toContainText('Архив.strata.zip');
    // This browser has the workspace: the archive opens as a copy.
    // «Импорт» in the bar: this browser has the workspace, so it opens as a copy.
    await page.locator('input[type="file"][accept*="zip"]').setInputFiles(await file.path());
    await expect(page.locator('.workspace')).toBeVisible();
    await page.waitForFunction(() => window.__strataWs?.graph() != null);
    await expect(page.locator('.workspace')).toHaveAttribute('data-nodes', '1');
    expect((await graphNow(page)).names).toEqual(['Нода']);
    await page.getByRole('button', { name: 'Главная' }).click();
    await expect(page.locator('.home-name')).toHaveText(['Архив', 'Архив']);
  });

  test('workspaces open in tabs; the logo goes home', async ({ page }) => {
    await page.goto('/?plain');
    await createWorkspace(page, 'Первое');
    await expect(page.locator('.tab')).toHaveText(['Первое']);
    // «+» right after the last tab: a new workspace in a new tab.
    await page.locator('.tab-new').click();
    await expect(page.locator('.tab')).toHaveText(['Первое', 'Без названия']);
    await expect(page.locator('.tab.is-active')).toHaveText('Без названия');
    await page.waitForFunction(() => window.__strataWs?.graph() != null);
    await createNode(page, 600, 400, 'Во второй');
    // Switching tabs keeps each workspace's own canvas.
    await page.locator('.tab', { hasText: 'Первое' }).locator('.tab-name').click();
    await expect(page.locator('.tab.is-active')).toHaveText('Первое');
    await expect(page.locator('.workspace')).toHaveAttribute('data-nodes', '0');
    await page.locator('.tab', { hasText: 'Без названия' }).locator('.tab-name').click();
    await expect(page.locator('.workspace')).toHaveAttribute('data-nodes', '1');
    // The logo: home, with both cards; the tabs stay.
    await page.getByRole('button', { name: 'Главная' }).click();
    await expect(page.locator('.home-card')).toHaveCount(2);
    await expect(page.locator('.tab')).toHaveCount(2);
    // Closing the open tab moves to its neighbour; the last one goes home.
    await page.locator('.tab', { hasText: 'Первое' }).locator('.tab-name').click();
    await page.getByRole('button', { name: 'Закрыть «Первое»' }).click();
    await expect(page.locator('.tab.is-active')).toHaveText('Без названия');
    await page.getByRole('button', { name: 'Закрыть «Без названия»' }).click();
    await expect(page.locator('.home-card')).toHaveCount(2);
    await expect(page.locator('.tab')).toHaveCount(0);
  });

  test('a task: its fields, people, description and subtasks in the panel (05 §4.3, §6)', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.goto('/?plain');
    await createWorkspace(page, 'Проекты');
    // A task from the Tab menu, named at once.
    await page.mouse.move(640, 400);
    await page.keyboard.press('Tab');
    await page.keyboard.type('задача');
    await page.locator('.tab-menu-row', { hasText: 'Задача' }).first().click();
    await expect(page.locator('.name-input')).toBeVisible();
    await page.keyboard.type('Боёвка');
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await graphNow(page)).names).toEqual(['Боёвка']);
    const id = await idOf(page, 'Боёвка');
    await settled(page);
    // Its class's colour, and an «Описание» inside, from the core.
    expect(await page.evaluate((id) => window.__strataWs?.graph()?.nodes.get(id)?.color, id)).toBe(
      3,
    );
    await select(page, 'Боёвка');
    const panel = page.locator('.ws-inspector');
    await expect(panel).toBeVisible();
    await panel.getByLabel('Статус').selectOption('doing');
    await panel.getByLabel('Дедлайн').fill('2026-12-01');
    const attrs = () =>
      page.evaluate((id) => window.__strataWs?.graph()?.nodes.get(id)?.attrs ?? {}, id);
    await expect.poll(attrs).toMatchObject({ status: 'doing', deadline: '2026-12-01' });
    // A field is a step of the same undo as the canvas.
    await page.evaluate(() => window.__strataWs?.view.canvas.focus());
    await page.keyboard.press('Control+z');
    await expect.poll(async () => (await attrs()).deadline).toBeUndefined();
    await page.keyboard.press('Control+Shift+z');
    await expect.poll(async () => (await attrs()).deadline).toBe('2026-12-01');
    // People: a new one, assigned at once.
    await panel.getByLabel('Добавить…').first().selectOption('+');
    await panel.getByLabel('Имя человека').fill('Антон');
    await panel.getByLabel('Имя человека').press('Enter');
    await expect(panel.locator('.ins-chip')).toHaveText(['Антон']);
    // The description: Markdown in the task's «Описание» note.
    await panel.locator('.ins-description .cm-content').click();
    await page.keyboard.type('**Удар** и _отдача_');
    // Subtasks: two, one done — «1 из 2».
    const sub = panel.getByLabel('Новая подзадача');
    await sub.fill('Анимации');
    await sub.press('Enter');
    await expect(panel.locator('.ins-links .check')).toHaveCount(1);
    await sub.fill('Хитбоксы');
    await sub.press('Enter');
    await expect(panel.locator('.ins-links .check')).toHaveCount(2);
    await panel.locator('.ins-links .check input').first().check();
    await expect(panel.locator('.ins-progress')).toHaveText('1 из 2');
    // The tree: the task is a network of the workspace; it goes inside.
    // «Слои»: a click selects the node on the canvas, a double click goes in.
    await page.locator('.layer-name', { hasText: 'Боёвка' }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.__strataWs?.view &&
            document.querySelector('.layer-row.is-selected')?.textContent,
        ),
      )
      .toBe('Боёвка');
    await page.locator('.layer-name', { hasText: 'Боёвка' }).dblclick();
    await expect(page.locator('.workspace')).toHaveAttribute('data-depth', '2');
    await expect
      .poll(async () => (await graphNow(page)).names)
      .toEqual(['Анимации', 'Описание', 'Хитбоксы']);
    // The workspace itself is no layer: out with U.
    await expect(page.locator('.layer-name', { hasText: 'Проекты' })).toHaveCount(0);
    await page.evaluate(() => window.__strataWs?.view.canvas.focus());
    await page.keyboard.press('KeyU');
    await expect(page.locator('.workspace')).toHaveAttribute('data-depth', '1');
    // The right button: «Выполнено».
    const p = await at(page, 'Боёвка');
    await page.mouse.click(p.x, p.y, { button: 'right' });
    await page.getByRole('menuitem', { name: 'Выполнено' }).click();
    await expect.poll(async () => (await attrs()).status).toBe('done');
    // The description is there after a restart.
    await settled(page);
    await page.reload();
    await page.locator('.home-open').click();
    await page.waitForFunction(() => window.__strataWs?.graph() != null);
    await select(page, 'Боёвка');
    await expect(page.locator('.ins-description .cm-content')).toContainText('Удар');
  });

  test('a picture dropped on the canvas is a media node with the picture in its circle', async ({
    page,
  }) => {
    await page.goto('/?plain');
    await createWorkspace(page, 'Медиа');
    await page.evaluate(async () => {
      // A small PNG, made here: 8 × 8 of one colour.
      const c = document.createElement('canvas');
      c.width = 8;
      c.height = 8;
      const g = c.getContext('2d');
      if (g) {
        g.fillStyle = '#b6f36b';
        g.fillRect(0, 0, 8, 8);
      }
      const blob = await new Promise<Blob | null>((ok) => c.toBlob(ok, 'image/png'));
      const dt = new DataTransfer();
      dt.items.add(new File([blob as Blob], 'Скетч.png', { type: 'image/png' }));
      document.querySelector('.proto-canvas')?.dispatchEvent(
        new DragEvent('drop', {
          dataTransfer: dt,
          clientX: 600,
          clientY: 400,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await expect.poll(async () => (await graphNow(page)).names).toEqual(['Скетч']);
    const id = await idOf(page, 'Скетч');
    await expect
      .poll(() => page.evaluate((id) => window.__strataWs?.view.hasPicture(id) ?? false, id))
      .toBe(true);
    await select(page, 'Скетч');
    await expect(page.locator('.ins-picture img')).toBeVisible();
  });

  test('nodes carry the Chrome icons, in their circles and in «Слои» (07 §6.1)', async ({
    page,
  }) => {
    await page.goto('/?plain');
    await createWorkspace(page, 'Значки');
    await createNode(page, 640, 400, 'Идея');
    const id = await idOf(page, 'Идея');
    await expect
      .poll(() => page.evaluate((id) => window.__strataWs?.view.iconOf(id), id))
      .toBe('kind');
    const row = page.locator('.layer-name', { hasText: 'Идея' });
    await expect(row.locator('img.icon')).toHaveAttribute('src', /^data:image\/png|\.png$/);
    expect(
      await row.locator('img.icon').evaluate((img: HTMLImageElement) => img.naturalWidth),
    ).toBe(16);
  });

  test('the profile is kept on this device', async ({ page }) => {
    await page.goto('/?plain');
    await expect(page.locator('.home-empty')).toBeVisible();
    const field = page.locator('.home-profile .field');
    await field.fill('Антон');
    await field.press('Enter');
    // Written to this device before the reload.
    await expect(page.locator('.home')).toHaveAttribute('data-profile', 'Антон');
    await page.reload();
    await expect(page.locator('.home-profile .field')).toHaveValue('Антон');
  });
});
