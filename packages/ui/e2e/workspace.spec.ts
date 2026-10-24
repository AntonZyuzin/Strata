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
  fold: { done: number; total: number } | null;
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
  map(): {
    state: string;
    selectedId(): string | null;
    focusId(): string | null;
    idNamed(name: string): string | null;
    screenOf(id: string): { x: number; y: number } | null;
  } | null;
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
  // The panel follows the selection from the core: until it names the node,
  // its fields may still be the previous one's (CI, slow WebKit).
  await expect(page.locator('.ws-inspector .ins-title-name')).toHaveText(name);
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

/** A list from the Tab menu, named at once, opened: its items are in the panel. */
async function openList(page: Page, kind: string, name: string) {
  const c = await box(page, '.proto-canvas');
  await page.mouse.move(c.x + c.width * 0.3, c.y + c.height * 0.4);
  await page.keyboard.press('Tab');
  await page.keyboard.type(kind);
  await page.locator('.tab-menu-row', { hasText: kind }).first().click();
  await expect(page.locator('.name-input')).toBeVisible();
  await page.keyboard.type(name);
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await graphNow(page)).names).toContain(name);
  await select(page, name);
  await page.keyboard.press('Enter');
  await expect(page.locator('.ws-inspector .list-new')).toBeFocused();
}

/** A task from the Tab menu, named at once and chosen: its panel is open. */
async function createTask(page: Page, name: string) {
  const c = await box(page, '.proto-canvas');
  await page.mouse.move(c.x + c.width * 0.3, c.y + c.height * 0.4);
  await page.keyboard.press('Tab');
  await page.keyboard.type('Задача');
  await page.locator('.tab-menu-row', { hasText: 'Задача' }).first().click();
  await expect(page.locator('.name-input')).toBeVisible();
  await page.keyboard.type(name);
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await graphNow(page)).names).toContain(name);
  await select(page, name);
  await expect(page.locator('.ws-inspector')).toBeVisible();
}

/** The items of the list in the panel: two spaces a level, `x` when ticked. */
const outline = (page: Page) =>
  page.locator('.ws-inspector .list-row').evaluateAll((rows) =>
    rows.map((row) => {
      let depth = 0;
      for (let ul = row.closest('ul')?.parentElement?.closest('ul'); ul; ) {
        depth++;
        ul = ul.parentElement?.closest('ul') ?? null;
      }
      const tick = row.querySelector<HTMLInputElement>('.ins-tick')?.checked ? 'x' : ' ';
      const text = row.querySelector<HTMLInputElement>('.list-text')?.value ?? '';
      return `${'  '.repeat(depth)}[${tick}] ${text}`;
    }),
  );

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
      // The language is in «Настройки» (✅ Q-06-23); the logo brings the home back.
      await page.locator('.tabbar-settings').click();
      await page.locator('.settings .segmented label', { hasText: 'EN' }).click();
      await page.locator('.tabbar-logo').click();
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

for (const { viewport, deviceScaleFactor } of LAYOUTS.filter((l) => l.deviceScaleFactor !== 1.5)) {
  test(`a list's panel and «Слои» keep their size in RU and EN at ${viewport.width}×${viewport.height} @${deviceScaleFactor}x`, async ({
    browser,
  }) => {
    test.setTimeout(60_000);
    const boxes = [];
    for (const [locale, kind] of [
      ['ru-RU', 'Список'],
      ['en-US', 'List'],
    ] as const) {
      const context = await browser.newContext({ viewport, deviceScaleFactor, locale });
      const page = await context.newPage();
      await page.goto('/?plain');
      await createWorkspace(page, 'Списки');
      await openList(page, kind, 'Очень длинное название списка для проверки обрезки');
      await page.keyboard.type(
        'Пункт с длинным текстом, который не помещается в одну строку панели',
      );
      await page.keyboard.press('Enter');
      const panel = page.locator('.ws-inspector');
      await panel.locator('.list-text').first().click();
      await page.keyboard.press('End');
      await page.keyboard.press('Enter');
      await page.keyboard.type('Вложенный пункт');
      await page.keyboard.press('Tab');
      await panel.locator('.ins-tick').first().check();
      await expect(panel.locator('.ins-progress')).toBeVisible();
      expect(await overflowing(page, '.ws-inspector'), `${locale} text must fit`).toEqual([]);
      expect(await overflowing(page, '.ws-layers'), `${locale} layers must fit`).toEqual([]);
      boxes.push({
        panel: await box(page, '.ws-inspector'),
        heading: await box(page, '.ws-inspector .ins-heading'),
        item: await box(page, '.ws-inspector .ins-section > .ins-tree > li > .list-row .list-text'),
        nested: await box(page, '.ws-inspector .ins-tree .ins-tree .list-text'),
        fresh: await box(page, '.ws-inspector .list-new'),
        layers: await box(page, '.ws-layers'),
        layersTitle: await box(page, '.layers-title'),
        layer: await box(page, '.layer-row'),
      });
      await context.close();
    }
    const [ru, en] = boxes as [(typeof boxes)[number], (typeof boxes)[number]];
    for (const part of [
      'panel',
      'heading',
      'item',
      'nested',
      'fresh',
      'layers',
      'layersTitle',
      'layer',
    ] as const) {
      for (const k of ['x', 'y', 'width', 'height'] as const) {
        expect(Math.abs(en[part][k] - ru[part][k]), `${part} ${k}`).toBeLessThanOrEqual(0.5);
      }
    }
  });
}

for (const { viewport, deviceScaleFactor } of LAYOUTS.filter((l) => l.deviceScaleFactor !== 1.5)) {
  test(`«Настройки» keep their size in RU and EN at ${viewport.width}×${viewport.height} @${deviceScaleFactor}x`, async ({
    browser,
  }) => {
    const boxes = [];
    for (const locale of ['ru-RU', 'en-US'] as const) {
      const context = await browser.newContext({ viewport, deviceScaleFactor, locale });
      const page = await context.newPage();
      await page.goto('/?plain');
      await expect(page.locator('.home-empty')).toBeVisible();
      await page.locator('.tabbar-settings').click();
      await expect(page.locator('.settings')).toBeVisible();
      expect(await overflowing(page, '.settings, .tabbar'), `${locale} text must fit`).toEqual([]);
      boxes.push({
        page: await box(page, '.settings-page'),
        fields: await box(page, '.settings section:nth-of-type(2) .ins-fields'),
        tab: await box(page, '.tab.is-active'),
        gear: await box(page, '.tabbar-settings'),
      });
      await context.close();
    }
    const [ru, en] = boxes as [(typeof boxes)[number], (typeof boxes)[number]];
    for (const part of ['page', 'fields', 'tab', 'gear'] as const) {
      for (const k of ['x', 'y', 'width', 'height'] as const) {
        expect(Math.abs(en[part][k] - ru[part][k]), `${part} ${k}`).toBeLessThanOrEqual(0.5);
      }
    }
  });
}

for (const deviceScaleFactor of [1, 2]) {
  test(`the star map's search keeps its size in RU and EN @${deviceScaleFactor}x (08 §10)`, async ({
    browser,
  }) => {
    test.setTimeout(90_000);
    const boxes = [];
    for (const locale of ['ru-RU', 'en-US'] as const) {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor,
        locale,
      });
      const page = await context.newPage();
      await page.goto('/?plain');
      await createWorkspace(page, 'Карта');
      await createNode(page, 640, 400, 'Звезда с очень длинным именем для проверки');
      await settled(page);
      await page.locator('.tabbar-tools [aria-pressed]').click();
      await expect(page.locator('.workspace')).toHaveAttribute('data-view', '3d', {
        timeout: 30_000,
      });
      await page.keyboard.press('Control+o');
      await page.locator('.map-search input').fill('Звезда');
      await expect(page.locator('.map-search .tab-menu-row')).toHaveCount(1);
      expect(await overflowing(page, '.map-search'), `${locale} text must fit`).toEqual([]);
      boxes.push({
        window: await box(page, '.map-search'),
        row: await box(page, '.map-search .tab-menu-row'),
      });
      await context.close();
    }
    const [ru, en] = boxes as [(typeof boxes)[number], (typeof boxes)[number]];
    for (const part of ['window', 'row'] as const) {
      for (const k of ['x', 'y', 'width', 'height'] as const) {
        expect(Math.abs(en[part][k] - ru[part][k]), `${part} ${k}`).toBeLessThanOrEqual(0.5);
      }
    }
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

  test('a task: its fields, people, description and subtasks by wires (05 §4.3, ADR-0010)', async ({
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
    // Its kind's colour.
    expect(await page.evaluate((id) => window.__strataWs?.graph()?.nodes.get(id)?.color, id)).toBe(
      3,
    );
    await select(page, 'Боёвка');
    const panel = page.locator('.ws-inspector');
    await expect(panel).toBeVisible();
    await panel.getByLabel('Статус').selectOption('doing');
    // The day as RU reads it (✅ Q-06-23): day first.
    const deadline = panel.getByLabel('Дедлайн', { exact: true });
    await deadline.fill('01/12/2026');
    await deadline.press('Enter');
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
    // The description: Markdown in the task's own document, no hint in it.
    await expect(panel.locator('.ins-description .cm-placeholder')).toHaveCount(0);
    await panel.locator('.ins-description .cm-content').click();
    await page.keyboard.type('**Удар** и _отдача_');
    // Subtasks: tasks beside it, wired from it; one done — «1 из 2».
    const sub = panel.getByLabel('Новая подзадача');
    await sub.fill('Анимации');
    await sub.press('Enter');
    await expect(panel.locator('.ins-tree .ins-row')).toHaveCount(1);
    await sub.fill('Хитбоксы');
    await sub.press('Enter');
    await expect(panel.locator('.ins-tree .ins-row')).toHaveCount(2);
    await expect
      .poll(async () => (await graphNow(page)).edges)
      .toEqual(['Боёвка→Анимации', 'Боёвка→Хитбоксы']);
    await panel.locator('.ins-tree .ins-row input').first().check();
    await expect(panel.locator('.ins-progress')).toHaveText('1 из 2');
    // The bubble's arc follows the tick (05 §6.4); undo takes back both.
    const fold = () =>
      page.evaluate((id) => window.__strataWs?.graph()?.nodes.get(id)?.fold ?? null, id);
    await expect.poll(fold).toMatchObject({ done: 1, total: 2 });
    await page.evaluate(() => window.__strataWs?.view.canvas.focus());
    await page.keyboard.press('Control+z');
    await expect(panel.locator('.ins-tree .ins-row input').first()).not.toBeChecked();
    await expect.poll(fold).toMatchObject({ done: 0, total: 2 });
    await page.keyboard.press('Control+Shift+z');
    await expect(panel.locator('.ins-tree .ins-row input').first()).toBeChecked();
    await expect.poll(fold).toMatchObject({ done: 1, total: 2 });
    // Esc takes the typing back: no subtask.
    await sub.fill('Лишнее');
    await sub.press('Escape');
    await expect(sub).toHaveValue('');
    await expect(panel.locator('.ins-tree .ins-row')).toHaveCount(2);
    // One does not dive into a task (ADR-0010): nothing offers it, and a double
    // click in «Слои» or Enter on the canvas asks the core for no network of it
    // (the core refuses one: that would surface as a page error).
    await expect(panel.locator('.ins-open')).toHaveCount(0);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.locator('.layer-name', { hasText: 'Боёвка' }).dblclick();
    await page.evaluate(() => window.__strataWs?.view.canvas.focus());
    await page.keyboard.press('Enter');
    await settled(page);
    await expect(page.locator('.workspace')).toHaveAttribute('data-depth', '1');
    await expect(panel.locator('.ins-title-name')).toHaveText('Боёвка');
    await expect(page.locator('.layer-name', { hasText: 'Проекты' })).toHaveCount(0);
    expect(errors).toEqual([]);
    // The right button: «Выполнено», and no «Открыть».
    const p = await at(page, 'Боёвка');
    await page.mouse.click(p.x, p.y, { button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Открыть' })).toHaveCount(0);
    await page.getByRole('menuitem', { name: 'Выполнено' }).click();
    await expect.poll(async () => (await attrs()).status).toBe('done');
    // A project is a task one dives into; its new task goes inside.
    await page.mouse.move(400, 300);
    await page.keyboard.press('Tab');
    await page.keyboard.type('проект');
    await page.locator('.tab-menu-row', { hasText: 'Проект' }).first().click();
    await page.keyboard.type('Срез');
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await graphNow(page)).names).toContain('Срез');
    await settled(page);
    await select(page, 'Срез');
    const inside = panel.getByLabel('Новая задача');
    await inside.fill('Меню');
    await inside.press('Enter');
    await expect(panel.locator('.ins-tree .ins-row')).toHaveText(['Меню']);
    await expect(inside).toHaveValue('');
    await page.evaluate(() => window.__strataWs?.view.canvas.focus());
    await page.keyboard.press('Enter');
    await expect(page.locator('.workspace')).toHaveAttribute('data-depth', '2');
    await expect.poll(async () => (await graphNow(page)).names).toEqual(['Меню']);
    await page.keyboard.press('KeyU');
    await expect(page.locator('.workspace')).toHaveAttribute('data-depth', '1');
    // The description is there after a restart.
    await settled(page);
    await page.reload();
    await page.locator('.home-open').click();
    await page.waitForFunction(() => window.__strataWs?.graph() != null);
    await select(page, 'Боёвка');
    await expect(page.locator('.ins-description .cm-content')).toContainText('Удар');
  });

  test('a list: items with ticks, nested, in its panel (05 §4.2, 06 §13.1)', async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/?plain');
    await createWorkspace(page, 'Дом');
    await openList(page, 'Список', 'Покупки');
    const panel = page.locator('.ws-inspector');
    // A list has no window: its panel is the list.
    await expect(panel.locator('.ins-open')).toHaveCount(0);
    // The new item's field: Enter adds an item and stays for the next.
    await page.keyboard.type('Хлеб');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Молоко');
    await page.keyboard.press('Enter');
    await expect.poll(() => outline(page)).toEqual(['[ ] Хлеб', '[ ] Молоко']);
    await expect(panel.locator('.list-new')).toBeFocused();
    // Enter at the end of an item: a new one below; Tab nests it.
    await panel.locator('.list-text').first().click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Белый');
    await page.keyboard.press('Tab');
    await expect.poll(() => outline(page)).toEqual(['[ ] Хлеб', '  [ ] Белый', '[ ] Молоко']);
    // Keys typed into the list stay there: the canvas has made no node.
    await expect(page.locator('.workspace')).toHaveAttribute('data-nodes', '1');
    // Ticks: a click and Ctrl+Enter; the heading and the bubble count them.
    await panel.locator('.ins-tick').nth(1).check();
    await expect(panel.locator('.ins-progress')).toHaveText('1 из 3');
    // Typing merges into one step for a second (10 §9): the next tick is a step of its own.
    await page.waitForTimeout(1_100);
    await panel.locator('.list-text').nth(2).click();
    await page.keyboard.press('Control+Enter');
    await expect(panel.locator('.ins-progress')).toHaveText('2 из 3');
    const id = await idOf(page, 'Покупки');
    const fold = () =>
      page.evaluate((id) => {
        const f = window.__strataWs?.graph()?.nodes.get(id) as { fold?: unknown } | undefined;
        return f?.fold;
      }, id);
    await expect.poll(fold).toMatchObject({ done: 2, total: 3 });
    // The list's own undo, not the canvas's.
    await page.keyboard.press('Control+z');
    await expect.poll(() => outline(page)).toEqual(['[ ] Хлеб', '  [x] Белый', '[ ] Молоко']);
    await page.keyboard.press('Control+Shift+z');
    await expect.poll(() => outline(page)).toEqual(['[ ] Хлеб', '  [x] Белый', '[x] Молоко']);
    await expect(page.locator('.workspace')).toHaveAttribute('data-nodes', '1');
    // Alt+↑ moves an item among its siblings.
    await page.keyboard.press('Alt+ArrowUp');
    await expect.poll(() => outline(page)).toEqual(['[x] Молоко', '[ ] Хлеб', '  [x] Белый']);
    // Enter on an empty nested item steps it out; Backspace at the start joins it up.
    await panel.locator('.list-text').nth(2).click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await expect
      .poll(() => outline(page))
      .toEqual(['[x] Молоко', '[ ] Хлеб', '  [x] Белый', '  [ ] ']);
    await page.keyboard.press('Enter');
    await expect
      .poll(() => outline(page))
      .toEqual(['[x] Молоко', '[ ] Хлеб', '  [x] Белый', '[ ] ']);
    await page.keyboard.press('Backspace');
    await expect.poll(() => outline(page)).toEqual(['[x] Молоко', '[ ] Хлеб', '  [x] Белый']);
    await expect(panel.locator('.list-text').nth(2)).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect.poll(() => outline(page)).toEqual(['[x] Молоко', '[ ] Хлеб', '[x] Белый']);
    // The right button: the same, as words.
    await panel.locator('.list-text').nth(2).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Вложить' }).click();
    await expect.poll(() => outline(page)).toEqual(['[x] Молоко', '[ ] Хлеб', '  [x] Белый']);
    // Esc: the canvas gets the keyboard back; a click selects, Enter opens again.
    await page.keyboard.press('Escape');
    await expect(panel.locator('.list-text').nth(2)).not.toBeFocused();
    await select(page, 'Покупки');
    await settled(page);
    await expect(panel.locator('.list-new')).not.toBeFocused();
    await page.keyboard.press('Enter');
    await expect(panel.locator('.list-new')).toBeFocused();
    await page.keyboard.press('Escape');
    // A restart: the items from the core, the ticks on the bubble.
    await settled(page);
    await page.reload();
    await page.locator('.home-open').click();
    await page.waitForFunction(() => window.__strataWs?.graph() != null);
    await expect.poll(fold).toMatchObject({ done: 2, total: 3 });
    await select(page, 'Покупки');
    await expect.poll(() => outline(page)).toEqual(['[x] Молоко', '[ ] Хлеб', '  [x] Белый']);
    await expect(panel.locator('.ins-progress')).toHaveText('2 из 3');
  });

  test('a picture dropped on the canvas is an asset with the picture in its circle', async ({
    page,
  }) => {
    await page.goto('/?plain');
    await createWorkspace(page, 'Ассеты');
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
    expect(
      await page.evaluate((id) => window.__strataWs?.graph()?.nodes.get(id)?.attrs.mime, id),
    ).toBe('image/png');
    await select(page, 'Скетч');
    await expect(page.locator('.ins-asset img')).toBeVisible();
  });

  test('a link dropped on the canvas is a link asset; a link typed with no scheme is kept', async ({
    page,
  }) => {
    await page.goto('/?plain');
    await createWorkspace(page, 'Ссылки');
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData('text/uri-list', '# a comment\r\nhttps://example.org/a');
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
    await expect.poll(async () => (await graphNow(page)).names).toEqual(['example.org']);
    const id = await idOf(page, 'example.org');
    const url = () =>
      page.evaluate((id) => window.__strataWs?.graph()?.nodes.get(id)?.attrs.url, id);
    expect(await url()).toBe('https://example.org/a');
    await settled(page);
    await select(page, 'example.org');
    const field = page.locator('.ws-inspector').getByLabel('Ссылка', { exact: true });
    await expect(field).toHaveValue('https://example.org/a');
    // Esc takes the typing back; «example.com/page» gets its scheme.
    await field.fill('что-то не то');
    await field.press('Escape');
    await expect(field).toHaveValue('https://example.org/a');
    await field.fill('example.com/page');
    await field.press('Enter');
    await expect.poll(url).toBe('https://example.com/page');
    await expect(page.locator('.toast', { hasText: 'Ядро не приняло' })).toHaveCount(0);
  });

  test('the star map navigates the whole space: a search, Enter, a click, I and U (08 §10)', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.goto('/?plain');
    await createWorkspace(page, 'Карта');
    const ws = page.locator('.workspace');
    // A folder with a note inside, and a note beside it at the root.
    await page.mouse.move(500, 300);
    await page.keyboard.press('Tab');
    await page.keyboard.type('папка');
    await page.locator('.tab-menu-row', { hasText: 'Папка' }).first().click();
    await page.keyboard.type('Арт');
    await page.keyboard.press('Enter');
    await settled(page);
    await page.keyboard.press('Enter');
    await expect(ws).toHaveAttribute('data-depth', '2');
    await createNode(page, 640, 400, 'Эскиз');
    await page.keyboard.press('KeyU');
    await expect(ws).toHaveAttribute('data-depth', '1');
    await createNode(page, 800, 500, 'Идея');
    await settled(page);
    const map = () => page.evaluate(() => window.__strataWs?.map());
    const toMap = async () => {
      await page.getByRole('button', { name: 'Холст или звёздная карта (M)' }).click();
      await expect(ws).toHaveAttribute('data-view', '3d', { timeout: 30_000 });
    };
    const ids = () =>
      page.evaluate(() => {
        const m = window.__strataWs?.map();
        return { art: m?.idNamed('Арт'), idea: m?.idNamed('Идея'), sketch: m?.idNamed('Эскиз') };
      });
    // Ctrl+O names the whole space; Enter flies to the star and selects it.
    await toMap();
    expect(await map()).not.toBeNull();
    await page.keyboard.press('Control+o');
    const search = page.locator('.map-search input');
    await expect(search).toBeFocused();
    await search.fill('Эскиз');
    await search.press('Enter');
    await expect(page.locator('.map-search')).toHaveCount(0);
    const known = await ids();
    expect(known.sketch).toBeTruthy();
    await expect
      .poll(() => page.evaluate(() => window.__strataWs?.map()?.selectedId()))
      .toBe(known.sketch);
    await expect(page.locator('.proto-map-label')).toHaveText('Эскиз');
    // Enter: back in 2D, in «Арт», with «Эскиз» selected.
    await page.keyboard.press('Enter');
    await expect(ws).toHaveAttribute('data-view', '2d', { timeout: 30_000 });
    await expect(ws).toHaveAttribute('data-depth', '2');
    await expect(page.locator('.ins-title-name')).toHaveText('Эскиз');
    // A click on a star goes to it in 2D: «Идея» at the root.
    await toMap();
    const at = await page.evaluate(
      (id) => window.__strataWs?.map()?.screenOf(id ?? '') ?? null,
      known.idea,
    );
    expect(at).not.toBeNull();
    await page.mouse.click(at?.x ?? 0, at?.y ?? 0);
    await expect(ws).toHaveAttribute('data-view', '2d', { timeout: 30_000 });
    await expect(ws).toHaveAttribute('data-depth', '1');
    await expect(page.locator('.ins-title-name')).toHaveText('Идея');
    // I into the folder's cluster, U back to the space.
    await toMap();
    await page.keyboard.press('Control+o');
    await page.locator('.map-search input').fill('Арт');
    await page.locator('.map-search input').press('Enter');
    await expect
      .poll(() => page.evaluate(() => window.__strataWs?.map()?.selectedId()))
      .toBe(known.art);
    await page.keyboard.press('KeyI');
    await expect
      .poll(() => page.evaluate(() => window.__strataWs?.map()?.focusId()))
      .toBe(known.art);
    await page.keyboard.press('KeyU');
    await expect
      .poll(() => page.evaluate(() => window.__strataWs?.map()?.focusId()))
      .not.toBe(known.art);
  });

  test('Tab from outside the canvas puts the node beside, not on top (review 2026-10-24)', async ({
    page,
  }) => {
    await page.goto('/?plain');
    await createWorkspace(page, 'Рядом');
    const mid = await page.evaluate(() => {
      const ws = window.__strataWs;
      const r = ws?.view.canvas.getBoundingClientRect();
      return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: 0, y: 0 };
    });
    await createNode(page, mid.x, mid.y, 'Первая');
    // Nothing selected, the cursor over «Ноды», the keys still the canvas's.
    await page.keyboard.press('Escape');
    await page.locator('.layers-title').hover();
    await page.evaluate(() => window.__strataWs?.view.canvas.focus());
    await page.keyboard.press('Tab');
    await expect(page.locator('.tab-menu')).toBeVisible();
    await page.keyboard.type('Вторая');
    await page.keyboard.press('Enter');
    await expect(page.locator('.workspace')).toHaveAttribute('data-nodes', '2');
    const gap = await page.evaluate(() => {
      const nodes = [...(window.__strataWs?.graph()?.nodes.values() ?? [])] as unknown as {
        x: number;
        y: number;
      }[];
      const [a, b] = nodes;
      return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
    });
    expect(gap).toBeGreaterThan(60);
  });

  test('a subtask tick takes a click 4 px outside its square (WCAG 2.5.8)', async ({ page }) => {
    await page.goto('/?plain');
    await createWorkspace(page, 'Цели');
    await createTask(page, 'Главная');
    const panel = page.locator('.ws-inspector');
    const sub = panel.getByLabel('Новая подзадача');
    await sub.fill('Шаг');
    await sub.press('Enter');
    const tick = panel.locator('.ins-tree .ins-tick').first();
    const b = await tick.boundingBox();
    expect(b).not.toBeNull();
    await page.mouse.click((b?.x ?? 0) - 4, (b?.y ?? 0) + (b?.height ?? 0) / 2);
    await expect(tick).toBeChecked();
  });

  test('a task becomes a project, a project a folder or a task (05 §4.2)', async ({ page }) => {
    await page.goto('/?plain');
    await createWorkspace(page, 'Виды');
    await createTask(page, 'Сюжет');
    const kind = () =>
      page.evaluate(() => {
        const g = window.__strataWs?.graph();
        return [...(g?.nodes.values() ?? [])].find((n) => n.name === 'Сюжет')?.kind;
      });
    const menu = async (item: string) => {
      const p = await at(page, 'Сюжет');
      await page.mouse.click(p.x, p.y, { button: 'right' });
      await page.getByRole('menuitem', { name: item }).click();
    };
    // No «Открыть» for a task: it becomes a project to be dived into.
    await menu('Сделать проектом');
    await expect.poll(kind).toBe('project');
    await select(page, 'Сюжет');
    await page.evaluate(() => window.__strataWs?.view.canvas.focus());
    await page.keyboard.press('Enter');
    await expect(page.locator('.workspace')).toHaveAttribute('data-depth', '2');
    await page.keyboard.press('KeyU');
    await expect(page.locator('.workspace')).toHaveAttribute('data-depth', '1');
    await menu('Сделать папкой');
    await expect.poll(kind).toBe('network');
    await menu('Сделать проектом');
    await expect.poll(kind).toBe('project');
    // Empty inside: a project can be a task again.
    await menu('Сделать задачей');
    await expect.poll(kind).toBe('task');
  });

  test('a near deadline is a dot in «Ноды» with its word (Q-07-22)', async ({ page }) => {
    await page.goto('/?plain');
    await createWorkspace(page, 'Сроки');
    await createTask(page, 'Завтрашняя');
    const tomorrow = new Date(Date.now() + 86_400_000);
    const p = (n: number) => String(n).padStart(2, '0');
    const typed = `${p(tomorrow.getDate())}/${p(tomorrow.getMonth() + 1)}/${tomorrow.getFullYear()}`;
    const deadline = page.locator('.ws-inspector').getByLabel('Дедлайн', { exact: true });
    await deadline.fill(typed);
    await deadline.press('Enter');
    const dot = page.locator('.layer-name', { hasText: 'Завтрашняя' }).locator('.layer-due');
    await expect(dot).toHaveAttribute('data-due', 'soon');
    await expect(dot).toHaveAttribute('title', 'завтра');
    // Done: no dot.
    await page.locator('.ws-inspector').getByLabel('Статус').selectOption('done');
    await expect(dot).toHaveCount(0);
  });

  test('the gecko lives on the canvas and notices a new task (07 §10.4)', async ({ page }) => {
    await page.goto('/?plain');
    await createWorkspace(page, 'Гекон');
    const gecko = page.locator('[data-gecko-actor]');
    await expect(gecko).toBeVisible();
    await expect(gecko).toHaveAttribute('aria-label', /^Гекон\./);
    // At home in the canvas one can see: right of «Ноды».
    const layers = await page.locator('.ws-layers').boundingBox();
    const at = await gecko.boundingBox();
    expect(at && layers && at.x >= layers.x + layers.width).toBe(true);
    await expect(gecko).toHaveAttribute('data-animation', 'idle');
    await page.mouse.move(640, 300);
    await page.keyboard.press('Tab');
    await page.keyboard.type('задача');
    await page.locator('.tab-menu-row', { hasText: 'Задача' }).first().click();
    await page.keyboard.type('Покормить');
    await page.keyboard.press('Enter');
    await expect(gecko).toHaveAttribute('data-animation', 'task-created');
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

  test('the star map opens from the bar, not only by M (08 §7)', async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto('/?plain');
    await createWorkspace(page, 'Карта');
    await createNode(page, 640, 400, 'Звезда');
    const map = page.getByRole('button', { name: 'Холст или звёздная карта (M)' });
    await expect(map).toHaveAttribute('aria-pressed', 'false');
    await map.click();
    await expect(page.locator('.workspace')).toHaveAttribute('data-view', '3d', {
      timeout: 30_000,
    });
    await expect(map).toHaveAttribute('aria-pressed', 'true');
    await map.click();
    await expect(page.locator('.workspace')).toHaveAttribute('data-view', '2d', {
      timeout: 10_000,
    });
    await expect(map).toHaveAttribute('aria-pressed', 'false');
  });

  test('the profile and the language are kept on this device, in «Настройки»', async ({ page }) => {
    await page.goto('/?plain');
    await expect(page.locator('.home-empty')).toBeVisible();
    await page.locator('.tabbar-settings').click();
    const field = page.locator('.settings').getByLabel('Имя', { exact: true });
    await field.fill('Антон');
    await field.press('Enter');
    // Written to this device before the reload.
    await expect(page.locator('.settings')).toHaveAttribute('data-profile', 'Антон');
    await page.locator('.settings .segmented label', { hasText: 'EN' }).click();
    await page.reload();
    await expect(page.locator('.home-new')).toHaveText('New workspace');
    await page.locator('.tabbar-settings').click();
    await expect(page.locator('.settings').getByLabel('Name', { exact: true })).toHaveValue(
      'Антон',
    );
  });

  test('dates read as «Настройки» say: the language, or the form chosen (✅ Q-06-23)', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await page.goto('/?plain');
    await createWorkspace(page, 'Сроки');
    await createTask(page, 'Релиз');
    const panel = page.locator('.ws-inspector');
    const deadline = panel.getByLabel('Дедлайн', { exact: true });
    // RU: day first, a time on a 24-hour clock; stored as the model has it.
    await deadline.fill('26/10/2026 18:30');
    await deadline.press('Enter');
    const id = await idOf(page, 'Релиз');
    await expect
      .poll(() => page.evaluate((id) => window.__strataWs?.graph()?.nodes.get(id)?.attrs, id))
      .toMatchObject({ deadline: '2026-10-26T18:30' });
    await expect(deadline).toHaveValue('26/10/2026 18:30');
    // Not a day: a dashed frame, nothing written.
    await deadline.fill('31/02/2026');
    await deadline.press('Enter');
    await expect(deadline).toHaveAttribute('aria-invalid', 'true');
    await deadline.press('Escape');
    await expect(deadline).toHaveValue('26/10/2026 18:30');
    // Another form and a 12-hour clock: the same deadline reads anew.
    await page.locator('.tabbar-settings').click();
    await page.locator('.settings').getByLabel('Формат даты').selectOption('ymd-');
    await page.locator('.settings').getByLabel('Время', { exact: true }).selectOption('12');
    await page.locator('.tab-name', { hasText: 'Сроки' }).click();
    await expect(page.locator('.settings')).toHaveCount(0);
    await expect(deadline).toHaveValue('2026-10-26 6:30 PM');
    // EN as the language, its own forms: month first.
    await page.locator('.tabbar-settings').click();
    await page.locator('.settings').getByLabel('Формат даты').selectOption('auto');
    await page.locator('.settings').getByLabel('Время', { exact: true }).selectOption('auto');
    await page.locator('.settings .segmented label', { hasText: 'EN' }).click();
    await page.locator('.tab-name', { hasText: 'Сроки' }).click();
    await expect(panel.getByLabel('Deadline', { exact: true })).toHaveValue('10/26/2026 6:30 PM');
  });
});
