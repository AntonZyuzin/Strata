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
  /** The flags' looks (05 §7). */
  key: boolean;
  pause: boolean;
  template: boolean;
  /** The note whose `[[X]]` this ghost is (05 §8.5); null for a node. */
  ghostOf: string | null;
  x: number;
  y: number;
}

interface WsHook {
  view: {
    hasPicture(id: string): boolean;
    iconOf(id: string): 'picture' | 'kind' | 'preset' | null;
    camera: { toScreen(x: number, y: number): { x: number; y: number } };
    nodeAt(id: string): { x: number; y: number; r: number } | null;
    canvas: HTMLCanvasElement;
    lens: ReadonlySet<string> | null;
  };
  editor(): {
    selected: string[];
    ringSlots(): { flag: string; x: number; y: number }[];
  } | null;
  graph(): {
    nodes: Map<string, Node>;
    wireShape: 'straight' | 'bezier' | 'kinetic';
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
  // The graph comes before the network's path: the root's depth is 1 once both are in.
  await expect(page.locator('.workspace')).toHaveAttribute('data-depth', '1');
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

/** A file made in the page and dropped on the canvas: a picture, a sound or a PDF. */
async function dropMade(page: Page, kind: 'png' | 'wav' | 'pdf', name: string, x = 600, y = 400) {
  await page.evaluate(
    async ([kind, name, x, y]) => {
      let file: File;
      if (kind === 'png') {
        const c = document.createElement('canvas');
        c.width = 160;
        c.height = 120;
        const g = c.getContext('2d') as CanvasRenderingContext2D;
        g.fillStyle = '#b6f36b';
        g.fillRect(0, 0, 160, 120);
        const blob = await new Promise<Blob>((done) =>
          c.toBlob((b) => done(b as Blob), 'image/png'),
        );
        file = new File([blob], `${name}.png`, { type: 'image/png' });
      } else if (kind === 'wav') {
        // Half a second of silence.
        const n = 4000;
        const buf = new ArrayBuffer(44 + n * 2);
        const v = new DataView(buf);
        const word = (at: number, s: string) => {
          for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i));
        };
        word(0, 'RIFF');
        v.setUint32(4, 36 + n * 2, true);
        word(8, 'WAVE');
        word(12, 'fmt ');
        v.setUint32(16, 16, true);
        v.setUint16(20, 1, true);
        v.setUint16(22, 1, true);
        v.setUint32(24, 8000, true);
        v.setUint32(28, 16000, true);
        v.setUint16(32, 2, true);
        v.setUint16(34, 16, true);
        word(36, 'data');
        v.setUint32(40, n * 2, true);
        file = new File([buf], `${name}.wav`, { type: 'audio/wav' });
      } else {
        const pdf = [
          '%PDF-1.4',
          '1 0 obj <</Type/Catalog/Pages 2 0 R>> endobj',
          '2 0 obj <</Type/Pages/Kids[3 0 R]/Count 1>> endobj',
          '3 0 obj <</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>> endobj',
          'trailer <</Root 1 0 R>>',
          '%%EOF',
        ].join('\n');
        file = new File([pdf], `${name}.pdf`, { type: 'application/pdf' });
      }
      const dt = new DataTransfer();
      dt.items.add(file);
      document.querySelector('.proto-canvas')?.dispatchEvent(
        new DragEvent('drop', {
          dataTransfer: dt,
          clientX: x,
          clientY: y,
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    [kind, name, x, y] as const,
  );
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

/** A folder or project from the Tab menu, named, and the canvas inside it. */
async function diveInto(page: Page, kind: string, name: string) {
  const depth = Number(await page.locator('.workspace').getAttribute('data-depth'));
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
  await page.evaluate(() => window.__strataWs?.view.canvas.focus());
  await page.keyboard.press('Enter');
  await expect(page.locator('.workspace')).toHaveAttribute('data-depth', String(depth + 1));
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
  test(`the path keeps its size in RU and EN at ${viewport.width}×${viewport.height} @${deviceScaleFactor}x (✅ Q-06-25)`, async ({
    browser,
  }) => {
    test.setTimeout(60_000);
    const boxes = [];
    for (const [locale, folder, project] of [
      ['ru-RU', 'Папка', 'Проект'],
      ['en-US', 'Folder', 'Project'],
    ] as const) {
      const context = await browser.newContext({ viewport, deviceScaleFactor, locale });
      const page = await context.newPage();
      await page.goto('/?plain');
      await createWorkspace(page, 'Игра «Туман»');
      // At the root the tab says where one is: no path.
      await expect(page.locator('.ws-path')).toHaveCount(0);
      await diveInto(page, folder, 'Уровни, локации и всё, что между ними');
      await diveInto(page, project, 'Болото у старой мельницы за туманным лесом');
      const path = page.locator('.ws-path');
      await expect(path).toBeVisible();
      // Two quick marks here (06 §10.3): ★1 and ★2 follow the path.
      for (const key of ['Digit1', 'Digit2']) {
        await page.keyboard.down(key);
        await page.waitForTimeout(700);
        await page.keyboard.up(key);
      }
      await expect(page.locator('.ws-mark')).toHaveCount(2);
      await expect(path).toHaveAttribute(
        'title',
        'Игра «Туман» / Уровни, локации и всё, что между ними / Болото у старой мельницы за туманным лесом',
      );
      // Cut names keep themselves whole in their tooltips; nothing else is cut.
      expect(await overflowing(page, '.ws-path'), `${locale} path must fit`).toEqual([]);
      const here = path.locator('[aria-current="location"]');
      await expect(here).toContainText('Болото');
      boxes.push({
        path: await box(page, '.ws-path'),
        here: await box(page, '.ws-path [aria-current="location"]'),
        root: await box(page, '.ws-path .ws-path-root button'),
        marks: await box(page, '.ws-marks'),
      });
      // The bar stands on the canvas, clear of «Ноды» and of the canvas's bottom edge.
      const layers = await box(page, '.ws-layers');
      const canvas = await box(page, '.proto-canvas');
      const b = await box(page, '.ws-path');
      expect(b.x).toBeGreaterThanOrEqual(layers.x + layers.width);
      expect(b.y + b.height).toBeLessThanOrEqual(canvas.y + canvas.height);
      // A click on a folder goes there; on the workspace's icon — to the root, and the path goes.
      await path.getByRole('button', { name: 'Уровни, локации и всё, что между ними' }).click();
      await expect(page.locator('.workspace')).toHaveAttribute('data-depth', '2');
      await expect(path.locator('[aria-current="location"]')).toContainText('Уровни');
      await path.getByRole('button', { name: 'Игра «Туман»' }).click();
      await expect(page.locator('.workspace')).toHaveAttribute('data-depth', '1');
      // At the root the marks alone stay.
      await expect(page.locator('.ws-path ol')).toHaveCount(0);
      await expect(page.locator('.ws-mark')).toHaveCount(2);
      await context.close();
    }
    const [ru, en] = boxes as [(typeof boxes)[number], (typeof boxes)[number]];
    for (const part of ['path', 'here', 'root', 'marks'] as const) {
      for (const k of ['x', 'y', 'width', 'height'] as const) {
        expect(Math.abs(en[part][k] - ru[part][k]), `${part} ${k}`).toBeLessThanOrEqual(0.5);
      }
    }
  });
}

for (const { viewport, deviceScaleFactor } of LAYOUTS.filter((l) => l.deviceScaleFactor !== 1.5)) {
  test(`the minimap keeps its size in RU and EN at ${viewport.width}×${viewport.height} @${deviceScaleFactor}x (06 §10.3)`, async ({
    browser,
  }) => {
    test.setTimeout(60_000);
    const boxes = [];
    for (const locale of ['ru-RU', 'en-US'] as const) {
      const context = await browser.newContext({ viewport, deviceScaleFactor, locale });
      const page = await context.newPage();
      await page.goto('/?plain');
      await createWorkspace(page, 'Карта');
      await createNode(page, 400, 300, 'Север');
      await createNode(page, 700, 450, 'Юг');
      // Nothing chosen: the panel, which follows the core, has closed.
      await expect(page.locator('.workspace')).toHaveAttribute('data-panel', 'closed');
      const map = page.locator('.canvas-minimap');
      await expect(map).toBeHidden();
      await page.evaluate(() => window.__strataWs?.view.canvas.focus());
      await page.keyboard.press('KeyO');
      await expect(map).toBeVisible();
      const b = await box(page, '.canvas-minimap');
      // 200 × 150 px inside its frame, at the canvas's bottom right.
      expect(Math.round(b.width)).toBeGreaterThanOrEqual(200);
      expect(Math.round(b.height)).toBeGreaterThanOrEqual(150);
      const canvas = await box(page, '.proto-canvas');
      expect(b.x + b.width).toBeLessThanOrEqual(canvas.x + canvas.width);
      expect(b.y + b.height).toBeLessThanOrEqual(canvas.y + canvas.height);
      // With a node chosen the panel opens: the minimap keeps left of it.
      await select(page, 'Север');
      const panel = await box(page, '.ws-inspector');
      const beside = await box(page, '.canvas-minimap');
      expect(beside.x + beside.width).toBeLessThanOrEqual(panel.x);
      boxes.push({ alone: b, beside });
      await page.keyboard.press('Escape');
      await page.evaluate(() => window.__strataWs?.view.canvas.focus());
      await page.keyboard.press('KeyO');
      await expect(map).toBeHidden();
      await context.close();
    }
    const [ru, en] = boxes as [(typeof boxes)[number], (typeof boxes)[number]];
    for (const part of ['alone', 'beside'] as const) {
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

for (const deviceScaleFactor of [1, 2]) {
  test(`the command palette keeps its size in RU and EN @${deviceScaleFactor}x (09 §3.5)`, async ({
    browser,
  }) => {
    test.setTimeout(60_000);
    const boxes = [];
    for (const locale of ['ru-RU', 'en-US'] as const) {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor,
        locale,
      });
      const page = await context.newPage();
      await page.goto('/?plain');
      await createWorkspace(page, 'Команды');
      await createNode(page, 640, 400, 'Мельница');
      await select(page, 'Мельница');
      await page.keyboard.press('Control+p');
      const palette = page.locator('.command-palette');
      await expect(palette).toBeVisible();
      await expect(palette.locator('input')).toBeFocused();
      expect(await overflowing(page, '.command-palette'), `${locale} the palette must fit`).toEqual(
        [],
      );
      const rows = await palette.locator('.tab-menu-row').count();
      boxes.push({
        palette: await box(page, '.command-palette'),
        row: await box(page, '.command-palette .tab-menu-row.is-current'),
        rows,
      });
      await palette.locator('input').press('Escape');
      await expect(palette).toHaveCount(0);
      await context.close();
    }
    const [ru, en] = boxes as [(typeof boxes)[number], (typeof boxes)[number]];
    expect(en.rows).toBe(ru.rows);
    for (const part of ['palette', 'row'] as const) {
      for (const k of ['x', 'y', 'width', 'height'] as const) {
        expect(Math.abs(en[part][k] - ru[part][k]), `${part} ${k}`).toBeLessThanOrEqual(0.5);
      }
    }
  });

  test(`«Перейти к ноде» and the find bar keep their size in RU and EN @${deviceScaleFactor}x (09 §3.3–3.4)`, async ({
    browser,
  }) => {
    test.setTimeout(90_000);
    const boxes = [];
    for (const [locale, folder] of [
      ['ru-RU', 'Папка'],
      ['en-US', 'Folder'],
    ] as const) {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor,
        locale,
      });
      const page = await context.newPage();
      await page.goto('/?plain');
      await createWorkspace(page, 'Поиск');
      await diveInto(page, folder, 'Уровни, локации и всё, что между ними');
      await createNode(page, 640, 400, 'Мельница за туманным лесом у самой реки');
      await settled(page);
      await page.keyboard.press('Control+o');
      const goto = page.locator('.goto');
      await goto.locator('input').fill('мельн');
      await expect(goto.locator('.tab-menu-row')).toHaveCount(1);
      expect(await overflowing(page, '.goto'), `${locale} «Перейти» must fit`).toEqual([]);
      const gotoBox = await box(page, '.goto');
      const row = await box(page, '.goto .tab-menu-row');
      await goto.locator('input').press('Escape');
      await page.keyboard.press('Control+f');
      const bar = page.locator('.find-bar');
      // No match: the fuzzy line comes, a second line of the bar.
      await bar.locator('input').fill('мельнциа');
      await expect(bar.locator('.find-fuzzy')).toBeVisible();
      expect(await overflowing(page, '.find-bar'), `${locale} the bar must fit`).toEqual([]);
      boxes.push({
        goto: gotoBox,
        row,
        bar: await box(page, '.find-bar'),
        input: await box(page, '.find-bar input'),
      });
      await context.close();
    }
    const [ru, en] = boxes as [(typeof boxes)[number], (typeof boxes)[number]];
    for (const part of ['goto', 'row', 'bar', 'input'] as const) {
      for (const k of ['x', 'y', 'width', 'height'] as const) {
        expect(Math.abs(en[part][k] - ru[part][k]), `${part} ${k}`).toBeLessThanOrEqual(0.5);
      }
    }
  });
}

for (const deviceScaleFactor of [1, 2]) {
  test(`an asset's viewer keeps its size in RU and EN @${deviceScaleFactor}x (06 §13.4)`, async ({
    browser,
  }) => {
    const boxes = [];
    for (const locale of ['ru-RU', 'en-US'] as const) {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor,
        locale,
      });
      const page = await context.newPage();
      await page.goto('/?plain');
      await createWorkspace(page, 'Звук');
      await dropMade(page, 'wav', 'Запись с очень длинным именем для проверки окна просмотра');
      await expect.poll(async () => (await graphNow(page)).names).toHaveLength(1);
      await settled(page);
      // The window opens on the side with room: the panel must be there first.
      await expect(page.locator('.ws-inspector .ins-title-name')).toHaveText(/^Запись/);
      await page.evaluate(() => window.__strataWs?.view.canvas.focus());
      await page.keyboard.press('Enter');
      await expect(page.locator('.asset-window audio')).toBeVisible();
      expect(await overflowing(page, '.asset-window'), `${locale} text must fit`).toEqual([]);
      boxes.push({
        window: await box(page, '.asset-window'),
        body: await box(page, '.asset-body'),
      });
      await context.close();
    }
    const [ru, en] = boxes as [(typeof boxes)[number], (typeof boxes)[number]];
    for (const part of ['window', 'body'] as const) {
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
    await expect(editor).toBeFocused();
    // At a person's pace: keys faster than WebKit reads an empty line's DOM
    // left the caret before the first letter on CI (run #66).
    await page.keyboard.type('Ёлки-палки, см. [[Цель]]', { delay: 30 });
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
    // Its undo came back with it (05 §11): the node made before the switch goes.
    await page.keyboard.press('Control+z');
    await expect(page.locator('.workspace')).toHaveAttribute('data-nodes', '0');
    await page.keyboard.press('Control+Shift+z');
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
    await expect(panel.locator('.ins-show')).toHaveCount(0);
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
    await expect(panel.locator('.ins-show')).toHaveCount(0);
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

  test('a picture dropped on the canvas is an asset with the picture in its body', async ({
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

  test('a sound dropped on the canvas plays in its panel: the CSP lets blob media in', async ({
    page,
  }) => {
    await page.goto('/?plain');
    await createWorkspace(page, 'Звук');
    await dropMade(page, 'wav', 'Тишина');
    await expect.poll(async () => (await graphNow(page)).names).toEqual(['Тишина']);
    await settled(page);
    await select(page, 'Тишина');
    const audio = page.locator('.ins-asset audio');
    await expect(audio).toBeVisible();
    // HAVE_METADATA: the desktop's CSP (served by the preview too) let it load.
    await expect
      .poll(() => audio.evaluate((a: HTMLAudioElement) => a.error?.code ?? a.readyState))
      .toBeGreaterThanOrEqual(1);
    expect(await audio.evaluate((a: HTMLAudioElement) => a.error)).toBeNull();
  });

  test('an asset opens large in its viewer: a picture, a sound, a PDF (06 §13.4)', async ({
    page,
  }) => {
    await page.goto('/?plain');
    await createWorkspace(page, 'Просмотр');
    const blocked: string[] = [];
    await page.exposeFunction('cspBlocked', (what: string) => blocked.push(what));
    await page.evaluate(() =>
      document.addEventListener('securitypolicyviolation', (e) =>
        (window as unknown as { cspBlocked: (w: string) => void }).cspBlocked(
          `${e.violatedDirective} ${e.blockedURI}`,
        ),
      ),
    );
    const win = page.locator('.asset-window');
    const open = async (name: string) => {
      await settled(page);
      await select(page, name);
      await page.evaluate(() => window.__strataWs?.view.canvas.focus());
      await page.keyboard.press('Enter');
      await expect(win).toBeVisible();
      await expect(win.locator('h2')).toHaveText(name);
    };
    // A picture to its size; the panel does not show it twice.
    await dropMade(page, 'png', 'Скетч');
    await expect.poll(async () => (await graphNow(page)).names).toEqual(['Скетч']);
    await open('Скетч');
    await expect(win).toHaveAttribute('data-type', 'image');
    await expect
      .poll(() => win.locator('img').evaluate((i: HTMLImageElement) => i.naturalWidth))
      .toBe(160);
    await expect(page.locator('.ins-asset img')).toHaveCount(0);
    // Esc gives the keys back and leaves the window and the selection; × closes it.
    await win.locator('img').click();
    await expect(win).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(win).toBeVisible();
    await expect(page.locator('.proto-canvas canvas').first()).toBeFocused();
    await expect(page.locator('.ws-inspector .ins-title-name')).toHaveText('Скетч');
    await win.locator('.window-close').click();
    await expect(win).toHaveCount(0);
    await expect(page.locator('.ins-asset img')).toBeVisible();
    // A sound plays in the viewer.
    await dropMade(page, 'wav', 'Тишина', 420, 300);
    await expect.poll(async () => (await graphNow(page)).names).toContain('Тишина');
    await open('Тишина');
    await expect(win).toHaveAttribute('data-type', 'audio');
    const audio = win.locator('audio');
    await expect
      .poll(() => audio.evaluate((a: HTMLAudioElement) => a.error?.code ?? a.readyState))
      .toBeGreaterThanOrEqual(1);
    expect(await audio.evaluate((a: HTMLAudioElement) => a.error)).toBeNull();
    await win.locator('.window-close').click();
    // A PDF in the WebView's own viewer, at the board's share of the canvas.
    await dropMade(page, 'pdf', 'Смета', 780, 300);
    await expect.poll(async () => (await graphNow(page)).names).toContain('Смета');
    await open('Смета');
    await expect(win).toHaveAttribute('data-type', 'pdf');
    await expect(win.locator('iframe')).toHaveAttribute('src', /^blob:/);
    // As large as a board's window, not a place beside the bubble.
    const board = await box(page, '.workspace');
    const w = await box(page, '.asset-window');
    expect(Math.abs(w.width - board.width * 0.8)).toBeLessThanOrEqual(2);
    // The desktop's CSP, served by the preview too, let the media and the frame in.
    expect(blocked).toEqual([]);
  });

  test('the panel closes by its ×; its eye shows; a late answer does not bring it back', async ({
    page,
  }) => {
    await page.goto('/?plain');
    await createWorkspace(page, 'Панель');
    await createNode(page, 500, 300, 'Черновик');
    await settled(page);
    await select(page, 'Черновик');
    const panel = page.locator('.ws-inspector');
    // The eye in the title plate shows what opens: a note in its window.
    await panel.getByRole('button', { name: 'Показать' }).click();
    await expect(page.locator('.note-window')).toBeVisible();
    await page.locator('.note-window .window-close').click();
    // ×: nothing selected, no panel, the keys back on the canvas.
    await panel.getByRole('button', { name: 'Закрыть панель' }).click();
    await expect(panel).toHaveCount(0);
    await expect(page.locator('.proto-canvas canvas').first()).toBeFocused();
    // The core holds the node's answer back, as a large file over IPC did:
    // a click elsewhere comes first, and the late answer is dropped.
    await page.evaluate(() => {
      const ws = window.__strataWs as unknown as {
        core: { node(id: string): Promise<unknown> };
      };
      const node = ws.core.node.bind(ws.core);
      ws.core.node = async (id: string) => {
        await new Promise((done) => setTimeout(done, 800));
        return node(id);
      };
    });
    const p = await at(page, 'Черновик');
    await page.mouse.click(p.x, p.y);
    // Past the panel's debounce (120 ms): the request is out.
    await page.waitForTimeout(250);
    await page.mouse.click(300, 650);
    await page.waitForTimeout(1200);
    await expect(panel).toHaveCount(0);
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

  test('Ctrl+V on the canvas: a link, a note from text with its body, a picture (13 §3.9)', async ({
    page,
  }) => {
    await page.goto('/?plain');
    await createWorkspace(page, 'Буфер');
    await page.mouse.move(600, 400);
    const paste = (text: string | null, png = false) =>
      page.evaluate(
        async ([text, png]) => {
          const dt = new DataTransfer();
          if (text !== null) dt.setData('text/plain', text);
          if (png) {
            const c = document.createElement('canvas');
            c.width = 32;
            c.height = 24;
            const g = c.getContext('2d') as CanvasRenderingContext2D;
            g.fillStyle = '#3c6';
            g.fillRect(0, 0, 32, 24);
            const blob = await new Promise<Blob>((done) =>
              c.toBlob((b) => done(b as Blob), 'image/png'),
            );
            dt.items.add(new File([blob], 'image.png', { type: 'image/png' }));
          }
          const target = document.activeElement ?? document.body;
          target.dispatchEvent(
            new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
          );
        },
        [text, png] as const,
      );
    await page.evaluate(() => window.__strataWs?.view.canvas.focus());
    // A link: a link asset named by its host.
    await paste('  https://example.org/a?b=1  ');
    await expect.poll(async () => (await graphNow(page)).names).toEqual(['example.org']);
    const attr = (name: string, key: string) =>
      idOf(page, name).then((id) =>
        page.evaluate(
          ([id, key]) =>
            (
              window.__strataWs?.graph()?.nodes.get(id)?.attrs as
                | Record<string, unknown>
                | undefined
            )?.[key],
          [id, key] as const,
        ),
      );
    expect(await attr('example.org', 'url')).toBe('https://example.org/a?b=1');
    // Text: the first line names a note, the rest is its body with its links.
    await page.mouse.move(400, 300);
    await paste('Хлеб');
    await expect.poll(async () => (await graphNow(page)).names).toContain('Хлеб');
    await page.mouse.move(800, 300);
    await paste('# Покупки\n\nкупить [[Хлеб]]\nи молоко');
    await expect.poll(async () => (await graphNow(page)).names).toContain('Покупки');
    await expect.poll(async () => (await graphNow(page)).edges).toEqual(['Покупки→Хлеб']);
    await expect(page.locator('.ws-inspector .ins-title-name')).toHaveText('Покупки');
    await page.evaluate(() => window.__strataWs?.view.canvas.focus());
    await page.keyboard.press('Enter');
    await expect(page.locator('.note-window .cm-content')).toHaveText(
      /купить \[\[Хлеб\]\]\s*и молоко/,
    );
    await page.locator('.note-window .window-close').click();
    // A picture: an asset with the picture in its body; one step of undo.
    await page.evaluate(() => window.__strataWs?.view.canvas.focus());
    await page.mouse.move(600, 550);
    await paste(null, true);
    await expect.poll(async () => (await graphNow(page)).names).toContain('image');
    const pic = await idOf(page, 'image');
    expect(await attr('image', 'mime')).toBe('image/png');
    await expect
      .poll(() => page.evaluate((id) => window.__strataWs?.view.hasPicture(id) ?? false, pic))
      .toBe(true);
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(async () => (await graphNow(page)).names).not.toContain('image');
    // In a field the text is the field's: no node.
    await settled(page);
    await select(page, 'example.org');
    const field = page.locator('.ws-inspector').getByLabel('Ссылка', { exact: true });
    await field.focus();
    const before = (await graphNow(page)).names;
    await paste('Не нода');
    await settled(page);
    expect((await graphNow(page)).names).toEqual(before);
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

  test("a network keeps its wires' style in the core: Shift+S and the menu (06 §6.2)", async ({
    page,
  }) => {
    await page.goto('/?plain');
    await createWorkspace(page, 'Нити');
    const shape = () => page.evaluate(() => window.__strataWs?.graph()?.wireShape);
    expect(await shape()).toBe('bezier');
    await page.mouse.move(640, 400);
    await page.keyboard.press('Shift+S');
    expect(await shape()).toBe('kinetic');
    // The right button on the bare canvas offers the style after it.
    await page.mouse.click(640, 400, { button: 'right' });
    await page.getByRole('menuitem', { name: 'Нити: прямые' }).click();
    expect(await shape()).toBe('straight');
    // One step of undo each.
    await page.keyboard.press('Control+z');
    expect(await shape()).toBe('kinetic');
    await page.keyboard.press('Control+Shift+z');
    expect(await shape()).toBe('straight');
    await settled(page);
    await page.reload();
    await page.locator('.home-open').click();
    await page.waitForFunction(() => window.__strataWs?.graph() != null);
    expect(await shape()).toBe('straight');
  });

  test('R, Q, E flag the node under the cursor; a template is copied from Tab (05 §7, 06 §8)', async ({
    page,
  }) => {
    await page.goto('/?plain');
    await createWorkspace(page, 'Флаги');
    await createNode(page, 500, 300, 'Баг');
    await createNode(page, 800, 300, 'Шаги');
    const flags = (name: string) =>
      page.evaluate((name) => {
        const g = window.__strataWs?.graph();
        const all = [...(g?.nodes.values() ?? [])].filter((x) => x.name === name);
        return all.map((n) => [n.key, n.pause, n.template].map((f) => (f ? 1 : 0)).join(''));
      }, name);
    const bug = await at(page, 'Баг');
    await page.mouse.move(bug.x, bug.y);
    await page.keyboard.press('KeyR');
    expect(await flags('Баг')).toEqual(['100']);
    await page.keyboard.press('KeyR');
    expect(await flags('Баг')).toEqual(['000']);
    // Each switch is one step of undo.
    await page.keyboard.press('Control+z');
    expect(await flags('Баг')).toEqual(['100']);
    await page.keyboard.press('KeyQ');
    await page.keyboard.press('KeyE');
    expect(await flags('Баг')).toEqual(['111']);
    await page.keyboard.press('KeyQ');

    // Nothing under the cursor: the selection; one lacks the flag — all get it.
    await page.keyboard.press('Control+a');
    await page.mouse.move(650, 600);
    await page.keyboard.press('KeyR');
    expect([...(await flags('Баг')), ...(await flags('Шаги'))]).toEqual(['101', '100']);

    // The right button's menu ticks the flags the node has.
    await page.keyboard.press('Escape');
    const steps = await at(page, 'Шаги');
    await page.mouse.click(steps.x, steps.y, { button: 'right' });
    await expect(page.getByRole('menuitemcheckbox', { name: 'Ключевая' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await page.getByRole('menuitemcheckbox', { name: 'Пауза' }).click();
    expect(await flags('Шаги')).toEqual(['110']);

    // The template in the Tab menu: its copy keeps its flags but «Шаблон».
    await page.mouse.move(650, 600);
    await page.keyboard.press('Tab');
    await expect(page.locator('.tab-menu-header', { hasText: 'Шаблоны' })).toBeVisible();
    await page.keyboard.type('Баг');
    await page.locator('.tab-menu-row', { hasText: 'Баг' }).first().click();
    await expect(page.locator('.workspace')).toHaveAttribute('data-nodes', '3');
    expect((await flags('Баг')).sort()).toEqual(['100', '101']);
    await settled(page);
    await page.keyboard.press('Control+z');
    await expect(page.locator('.workspace')).toHaveAttribute('data-nodes', '2');
  });

  test('the flag ring: rest on a bubble, click a slot; Ctrl hides it (06 §8)', async ({ page }) => {
    await page.goto('/?plain');
    await createWorkspace(page, 'Кольцо');
    await createNode(page, 600, 400, 'Узел');
    const look = () =>
      page.evaluate(() => {
        const n = [...(window.__strataWs?.graph()?.nodes.values() ?? [])][0];
        return n ? [n.key, n.pause, n.template].map((f) => (f ? 1 : 0)).join('') : '';
      });
    const slots = () =>
      page.evaluate(() => {
        const ws = window.__strataWs;
        const r = ws?.view.canvas.getBoundingClientRect();
        return (ws?.editor()?.ringSlots() ?? []).map((s) => ({
          flag: s.flag,
          x: s.x + (r?.left ?? 0),
          y: s.y + (r?.top ?? 0),
        }));
      });
    const p = await at(page, 'Узел');
    await page.mouse.move(p.x, p.y);
    // It comes after the cursor has rested (07 §4.5): ★ ‖ and the stencil.
    await expect
      .poll(async () => (await slots()).map((s) => s.flag))
      .toEqual(['key', 'pause', 'template']);
    const pause = (await slots()).find((s) => s.flag === 'pause');
    if (!pause) throw new Error('no pause slot');
    await page.mouse.move(pause.x, pause.y, { steps: 4 });
    await page.mouse.click(pause.x, pause.y);
    expect(await look()).toBe('010');
    // The ring stays on its way back to the bubble; a second click clears it.
    await page.mouse.click(pause.x, pause.y);
    expect(await look()).toBe('000');
    await page.keyboard.down('Control');
    await expect.poll(async () => (await slots()).length).toBe(0);
    await page.keyboard.up('Control');
    await expect.poll(async () => (await slots()).length).toBe(3);
    // Away from the bubble and its ring: gone.
    await page.mouse.move(p.x + 300, p.y + 200, { steps: 4 });
    await expect.poll(async () => (await slots()).length).toBe(0);
    // «Настройки»: never.
    await page.locator('.tabbar-settings').click();
    await page.locator('.settings').getByLabel('Кольцо флагов').selectOption('never');
    await page.locator('.tab', { hasText: 'Кольцо' }).first().click();
    await expect(page.locator('.settings')).toHaveCount(0);
    await page.mouse.move(p.x, p.y, { steps: 4 });
    await page.waitForTimeout(400);
    expect(await slots()).toEqual([]);
  });

  test('Ctrl+O goes to a node anywhere with a flight; Shift+Enter opens; the trash gives back (09 §3.4)', async ({
    page,
  }) => {
    await page.goto('/?plain');
    await createWorkspace(page, 'Переход');
    const ws = page.locator('.workspace');
    await diveInto(page, 'Папка', 'Уровни');
    await createNode(page, 500, 300, 'Мельница');
    await settled(page);
    await page.keyboard.press('KeyU');
    await expect(ws).toHaveAttribute('data-depth', '1');
    const goto = page.locator('.goto');
    await page.keyboard.press('Control+o');
    await goto.locator('input').fill('мельн');
    await expect(goto.locator('.tab-menu-row')).toHaveCount(1);
    await expect(goto.locator('.tab-menu-detail')).toHaveText('Уровни');
    await goto.locator('input').press('Enter');
    await expect(goto).toHaveCount(0);
    // Its network on the canvas, the node selected at the flight's end.
    await expect(ws).toHaveAttribute('data-depth', '2');
    await expect(page.locator('.ws-inspector .ins-title-name')).toHaveText('Мельница');
    // An empty query offers the nodes visited last.
    await page.keyboard.press('Control+o');
    await expect(goto.locator('.tab-menu-row').first()).toContainText('Мельница');
    await goto.locator('input').press('Escape');
    // A node in the trash is found too and comes back.
    await page.evaluate(() => window.__strataWs?.view.canvas.focus());
    await page.keyboard.press('Delete');
    await expect(ws).toHaveAttribute('data-nodes', '0');
    await expect(page.locator('.layers-trash')).toBeVisible();
    await page.keyboard.press('Control+o');
    await goto.locator('input').fill('мельн');
    await expect(goto.locator('.tab-menu-header')).toHaveText('В корзине');
    await goto.locator('input').press('Enter');
    await expect(ws).toHaveAttribute('data-nodes', '1');
    // Shift+Enter opens: into a folder.
    await page.keyboard.press('KeyU');
    await expect(ws).toHaveAttribute('data-depth', '1');
    await page.keyboard.press('Control+o');
    await goto.locator('input').fill('уровни');
    await expect(goto.locator('.tab-menu-row')).toHaveCount(1);
    await goto.locator('input').press('Shift+Enter');
    await expect(ws).toHaveAttribute('data-depth', '2');
  });

  test('Ctrl+F finds by Houdini Find: the rest dims, Enter selects, Esc gives back (09 §3.3)', async ({
    page,
  }) => {
    await page.goto('/?plain');
    await createWorkspace(page, 'Найти');
    await createTask(page, 'Анимация удара');
    await createNode(page, 900, 250, 'Аниматик');
    await createNode(page, 900, 550, 'Звук');
    await select(page, 'Звук');
    const lens = () =>
      page.evaluate(() => {
        const ws = window.__strataWs;
        const g = ws?.graph();
        const l = ws?.view.lens;
        return l ? [...l].map((id) => g?.nodes.get(id)?.name).sort() : null;
      });
    const selected = () =>
      page.evaluate(() => {
        const ws = window.__strataWs;
        const g = ws?.graph();
        return (ws?.editor()?.selected ?? []).map((id) => g?.nodes.get(id)?.name).sort();
      });
    await page.keyboard.press('Control+f');
    const bar = page.locator('.find-bar');
    const field = bar.locator('input');
    await field.fill('аним*');
    await expect(bar.locator('.find-count')).toHaveText('0 из 2');
    expect(await lens()).toEqual(['Аниматик', 'Анимация удара']);
    await field.fill('аним* @задача');
    await expect(bar.locator('.find-count')).toHaveText('0 из 1');
    await field.press('ArrowDown');
    await expect(bar.locator('.find-count')).toHaveText('1 из 1');
    expect(await selected()).toEqual(['Анимация удара']);
    // Esc: the selection as it was, nothing dimmed.
    await field.press('Escape');
    await expect(bar).toHaveCount(0);
    expect(await selected()).toEqual(['Звук']);
    expect(await lens()).toBeNull();
    // Enter selects every match.
    await page.keyboard.press('Control+f');
    await field.fill('аним');
    await expect(bar.locator('.find-count')).toHaveText('0 из 2');
    await field.press('Enter');
    await expect(bar).toHaveCount(0);
    expect(await selected()).toEqual(['Аниматик', 'Анимация удара']);
    // No match: the nearest names, by the engine's typos.
    await page.keyboard.press('Control+f');
    await field.fill('анимцаия');
    await expect(bar.locator('.find-count')).toHaveText('0 из 0');
    await expect(bar.locator('.find-fuzzy')).toContainText('«Анимация удара»');
  });

  test('the filter of «Ноды» keeps the matches and the way to them (09 §2)', async ({ page }) => {
    await page.goto('/?plain');
    await createWorkspace(page, 'Фильтр');
    await diveInto(page, 'Папка', 'Уровни');
    await createNode(page, 500, 300, 'Мельница');
    await createNode(page, 800, 300, 'Река');
    await settled(page);
    const rows = page.locator('.ws-layers .layer-label');
    await expect(rows).toHaveText(['Уровни', 'Мельница', 'Река']);
    const filter = page.locator('.layers-filter input');
    // The other keyboard layout finds too (09 §2.4).
    await filter.fill('vtkmybwf');
    await expect(rows).toHaveText(['Уровни', 'Мельница']);
    await expect(page.locator('.layer-row.is-way .layer-label')).toHaveText(['Уровни']);
    await filter.press('Enter');
    await expect(page.locator('.ws-inspector .ins-title-name')).toHaveText('Мельница');
    await filter.press('Escape');
    await expect(rows).toHaveText(['Уровни', 'Мельница', 'Река']);
  });

  test('a [[link]] to no node is a ghost: a click makes the note, Shift+click its kind (05 §8.5, 06 §14)', async ({
    page,
  }) => {
    await page.goto('/?plain');
    await createWorkspace(page, 'Призраки');
    await createNode(page, 500, 360, 'Дневник');
    const ghosts = () =>
      page.evaluate(() =>
        [...(window.__strataWs?.graph()?.nodes.values() ?? [])]
          .filter((n) => n.ghostOf)
          .map((n) => n.name)
          .sort(),
      );
    await select(page, 'Дневник');
    await page.keyboard.press('Enter');
    const editor = page.locator('.note-window .cm-content');
    await expect(editor).toBeVisible();
    await editor.click();
    await page.keyboard.type('Позже: [[Идея]]', { delay: 30 });
    await expect.poll(ghosts).toEqual(['Идея']);
    await page.locator('.note-window .window-close').click();
    await expect(page.locator('.workspace')).toHaveAttribute('data-nodes', '1');
    expect((await graphNow(page)).edges).toEqual(['Дневник→Идея']);

    // A ghost is not dragged: it stands by its note (06 §14).
    const id = await idOf(page, 'Идея');
    const spot = () =>
      page.evaluate((id) => {
        const n = window.__strataWs?.graph()?.nodes.get(id);
        return n ? [Math.round(n.x), Math.round(n.y)] : null;
      }, id);
    const before = await spot();
    const g = await at(page, 'Идея');
    await page.mouse.move(g.x, g.y);
    await page.mouse.down();
    await page.mouse.move(g.x + 60, g.y + 40, { steps: 5 });
    await page.mouse.up();
    expect(await spot()).toEqual(before);
    await expect.poll(ghosts).toEqual(['Идея']);

    // A click: the note in its place, the ghost's wire now the note's; undo brings it back.
    await page.mouse.click(g.x, g.y);
    await expect.poll(ghosts).toEqual([]);
    await expect(page.locator('.workspace')).toHaveAttribute('data-nodes', '2');
    await settled(page);
    await expect.poll(async () => (await graphNow(page)).edges).toEqual(['Дневник→Идея']);
    const made = await idOf(page, 'Идея');
    expect(await page.evaluate((id) => window.__strataWs?.graph()?.nodes.get(id)?.kind, made)).toBe(
      'note',
    );
    await page.keyboard.press('Control+z');
    await expect.poll(ghosts).toEqual(['Идея']);
    await expect(page.locator('.workspace')).toHaveAttribute('data-nodes', '1');
    await settled(page);
    await expect.poll(ghosts).toEqual(['Идея']);

    // Shift+click: the Tab menu with the kinds for its name.
    const q = await at(page, 'Идея');
    await page.keyboard.down('Shift');
    await page.mouse.click(q.x, q.y);
    await page.keyboard.up('Shift');
    await expect(page.locator('.tab-menu-row')).toHaveCount(7);
    await page.locator('.tab-menu-row', { hasText: 'Задача: Идея' }).click();
    await expect.poll(ghosts).toEqual([]);
    await settled(page);
    await expect.poll(async () => (await graphNow(page)).edges).toEqual(['Дневник→Идея']);
    const task = await idOf(page, 'Идея');
    expect(await page.evaluate((id) => window.__strataWs?.graph()?.nodes.get(id)?.kind, task)).toBe(
      'task',
    );
  });

  test('back, forward, ` and the quick marks go where one has been (09 §6.1–6.2, 06 §10.3)', async ({
    page,
  }) => {
    await page.goto('/?plain');
    await createWorkspace(page, 'История');
    const depth = page.locator('.workspace');
    const back = page.getByRole('button', { name: 'Назад (Alt+←)' });
    const forward = page.getByRole('button', { name: 'Вперёд (Alt+→)' });
    await expect(back).toBeDisabled();
    await diveInto(page, 'Папка', 'Глава');
    await expect(back).toBeEnabled();
    await page.keyboard.press('Alt+ArrowLeft');
    await expect(depth).toHaveAttribute('data-depth', '1');
    await expect(forward).toBeEnabled();
    await page.keyboard.press('Alt+ArrowRight');
    await expect(depth).toHaveAttribute('data-depth', '2');
    // ` goes to the last place and back again.
    await page.keyboard.press('Backquote');
    await expect(depth).toHaveAttribute('data-depth', '1');
    await page.keyboard.press('Backquote');
    await expect(depth).toHaveAttribute('data-depth', '2');
    // The bar's buttons too.
    await back.click();
    await expect(depth).toHaveAttribute('data-depth', '1');
    await forward.click();
    await expect(depth).toHaveAttribute('data-depth', '2');

    // A quick mark: hold 1 here, go up, press 1 — back here; the right button clears it.
    await page.evaluate(() => window.__strataWs?.view.canvas.focus());
    await page.keyboard.down('Digit1');
    await page.waitForTimeout(700);
    await page.keyboard.up('Digit1');
    const mark = page.locator('.ws-mark');
    await expect(mark).toHaveCount(1);
    await expect(mark).toHaveAttribute(
      'title',
      'Метка 1: Глава · клик — перейти, правая кнопка — убрать',
    );
    await page.keyboard.press('KeyU');
    await expect(depth).toHaveAttribute('data-depth', '1');
    await page.keyboard.press('Digit1');
    await expect(depth).toHaveAttribute('data-depth', '2');
    await page.keyboard.press('KeyU');
    await expect(depth).toHaveAttribute('data-depth', '1');
    await mark.click();
    await expect(depth).toHaveAttribute('data-depth', '2');
    await mark.click({ button: 'right' });
    await expect(mark).toHaveCount(0);

    // The minimap: a click puts the camera there (06 §10.3).
    await page.evaluate(() => window.__strataWs?.view.canvas.focus());
    await page.keyboard.press('KeyO');
    const mini = await box(page, '.canvas-minimap');
    const camera = () =>
      page.evaluate(() => {
        const c = window.__strataWs?.view.camera as unknown as { x: number; y: number };
        return [Math.round(c.x), Math.round(c.y)];
      });
    const before = await camera();
    await page.mouse.click(mini.x + 12, mini.y + 12);
    await expect.poll(camera).not.toEqual(before);
    await page.evaluate(() => window.__strataWs?.view.canvas.focus());
    await page.keyboard.press('KeyO');
    await expect(page.locator('.canvas-minimap')).toBeHidden();

    // The arrows walk the canvas, PgDn and PgUp the chain (06 §10.3).
    await createNode(page, 500, 300, 'Верх');
    await createNode(page, 500, 520, 'Низ');
    await createNode(page, 800, 300, 'Справа');
    const top = await at(page, 'Верх');
    const bottom = await at(page, 'Низ');
    // A wire from «Верх» to «Низ», from the port ring just outside the bubble.
    const r = await page.evaluate(
      (id) => {
        const ws = window.__strataWs as WsHook;
        const p = ws.view.nodeAt(id);
        return p ? p.r * (ws.view.camera as unknown as { zoom: number }).zoom : 20;
      },
      await idOf(page, 'Верх'),
    );
    await page.mouse.move(top.x, top.y + Math.max(r, 12) + Math.max(8, 0.25 * r) / 2);
    await page.mouse.down();
    await page.mouse.move(top.x, (top.y + bottom.y) / 2, { steps: 10 });
    await page.mouse.move(bottom.x, bottom.y, { steps: 10 });
    await page.mouse.up();
    await expect.poll(async () => (await graphNow(page)).edges).toEqual(['Верх→Низ']);
    await select(page, 'Верх');
    const selected = () =>
      page.evaluate(() => {
        const ws = window.__strataWs;
        return (ws?.editor()?.selected ?? []).map((id) => ws?.graph()?.nodes.get(id)?.name);
      });
    await page.keyboard.press('ArrowRight');
    await expect.poll(selected).toEqual(['Справа']);
    await page.keyboard.press('ArrowLeft');
    await expect.poll(selected).toEqual(['Верх']);
    await page.keyboard.press('PageDown');
    await expect.poll(selected).toEqual(['Низ']);
    await page.keyboard.press('PageUp');
    await expect.poll(selected).toEqual(['Верх']);
  });

  test('Ctrl+P runs a command found in either language; the last ones come first (09 §3.5)', async ({
    page,
  }) => {
    await page.goto('/?plain');
    await createWorkspace(page, 'Палитра');
    await createNode(page, 500, 360, 'Север');
    const palette = page.locator('.command-palette');
    const input = palette.locator('input');
    const rows = palette.locator('.tab-menu-row');
    // A pointer resting where the rows open chooses none: the first is current.
    await page.keyboard.press('Control+p');
    const fifth = await rows.nth(4).boundingBox();
    if (!fifth) throw new Error('no fifth row');
    await input.press('Escape');
    await page.mouse.move(fifth.x + 20, fifth.y + fifth.height / 2);
    await page.keyboard.press('Control+p');
    await expect(rows.first()).toHaveClass(/is-current/);
    await expect(palette.locator('.tab-menu-row.is-current')).toHaveCount(1);
    // A move over a row makes it current.
    await page.mouse.move(fifth.x + 40, fifth.y + fifth.height / 2);
    await page.mouse.move(fifth.x + 60, fifth.y + fifth.height / 2);
    await expect(rows.nth(4)).toHaveClass(/is-current/);
    await input.press('Escape');
    await page.mouse.move(20, 780);
    // Nothing chosen: no «Удалить»; the minimap by its English name.
    await page.keyboard.press('Control+p');
    await input.fill('удалить');
    await expect(palette.locator('.tab-menu-empty')).toBeVisible();
    await input.fill('minimap');
    await expect(palette.locator('.tab-menu-row').first()).toContainText('Мини-карта');
    await expect(palette.locator('.tab-menu-row').first().locator('.tab-menu-detail')).toHaveText(
      'O',
    );
    await input.press('Enter');
    await expect(palette).toHaveCount(0);
    await expect(page.locator('.canvas-minimap')).toBeVisible();
    // Again: «Недавние» first, the minimap there; Enter at once closes it again.
    await page.keyboard.press('Control+p');
    await expect(palette.locator('.tab-menu-header').first()).toHaveText('Недавние');
    await expect(palette.locator('.tab-menu-row').first()).toContainText('Мини-карта');
    await input.press('Enter');
    await expect(page.locator('.canvas-minimap')).toBeHidden();
    // A node chosen: «Переименовать» opens its name field.
    await select(page, 'Север');
    await page.keyboard.press('Control+p');
    await input.fill('переим');
    await input.press('Enter');
    await expect(page.locator('.name-input')).toBeVisible();
    await page.keyboard.press('Escape');
    // On the star map too: the canvas's commands are not there, the map's are.
    const ws = page.locator('.workspace');
    await page.getByRole('button', { name: 'Холст или звёздная карта (M)' }).click();
    await expect(ws).toHaveAttribute('data-view', '3d', { timeout: 30_000 });
    await page.keyboard.press('Control+p');
    await expect(input).toBeFocused();
    await expect(palette.locator('.tab-menu-row', { hasText: 'Разложить' })).toHaveCount(0);
    await input.fill('star map');
    await expect(palette.locator('.tab-menu-row').first()).toContainText('Звёздная карта');
    await input.press('Enter');
    await expect(ws).toHaveAttribute('data-view', '2d', { timeout: 30_000 });
  });

  test('a rename rewrites the [[links]] that named the node, in an open note too (13 §6.5)', async ({
    page,
  }) => {
    await page.goto('/?plain');
    await createWorkspace(page, 'Переименование');
    await createNode(page, 400, 360, 'Дневник');
    await createNode(page, 800, 360, 'Цель');
    await select(page, 'Дневник');
    await page.keyboard.press('Enter');
    const editor = page.locator('.note-window .cm-content');
    await expect(editor).toBeVisible();
    await editor.click();
    await page.keyboard.type('См. [[Цель]]', { delay: 30 });
    await expect.poll(async () => (await graphNow(page)).edges).toEqual(['Дневник→Цель']);

    // The note stays open; `Esc` gives the keys back to the canvas, `Ctrl+O`
    // goes to the node (the window may cover it), `F2` renames it.
    await page.keyboard.press('Escape');
    await expect(page.locator('.note-window')).toBeVisible();
    await page.keyboard.press('Control+o');
    await page.locator('.goto input').fill('Цель');
    await page.locator('.goto input').press('Enter');
    const goal = await idOf(page, 'Цель');
    await expect
      .poll(() => page.evaluate(() => window.__strataWs?.editor()?.selected))
      .toEqual([goal]);
    await page.keyboard.press('F2');
    await expect(page.locator('.name-input')).toBeVisible();
    await page.keyboard.type('Миссия');
    await page.keyboard.press('Enter');
    // Live preview shows a link without its brackets.
    await expect(editor).toHaveText('См. Миссия');
    await expect.poll(async () => (await graphNow(page)).edges).toEqual(['Дневник→Миссия']);

    // Undo renames back, and the text follows.
    await page.evaluate(() => window.__strataWs?.view.canvas.focus());
    await page.keyboard.press('Control+z');
    await expect(editor).toHaveText('См. Цель');
    await expect.poll(async () => (await graphNow(page)).edges).toEqual(['Дневник→Цель']);
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

  test('nodes carry the Chrome icons, in their bodies and in «Слои» (07 §6.1)', async ({
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

  test('another tab opened under the star map comes in 2D, and M opens its own map (08 §7)', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.goto('/?plain');
    await createWorkspace(page, 'Первое');
    await createNode(page, 640, 400, 'Звезда');
    await page.locator('.tab-new').click();
    await expect(page.locator('.tab.is-active')).toHaveText('Без названия');
    await page.waitForFunction(() => window.__strataWs?.graph() != null);
    await createNode(page, 640, 400, 'Комета');
    const ws = page.locator('.workspace');
    const map = page.getByRole('button', { name: 'Холст или звёздная карта (M)' });
    await map.click();
    await expect(ws).toHaveAttribute('data-view', '3d', { timeout: 30_000 });
    await page.locator('.tab', { hasText: 'Первое' }).locator('.tab-name').click();
    await expect(page.locator('.tab.is-active')).toHaveText('Первое');
    await expect(ws).toHaveAttribute('data-view', '2d');
    await expect(map).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('.proto-map')).toHaveCount(1);
    await expect(page.locator('.proto-map')).toBeHidden();
    // The keys are the canvas's again; M opens the map of this workspace.
    await page.evaluate(() => window.__strataWs?.view.canvas.focus());
    await page.keyboard.press('KeyM');
    await expect(ws).toHaveAttribute('data-view', '3d', { timeout: 30_000 });
    const names = await page.evaluate(() => {
      const m = window.__strataWs?.map();
      return { star: m?.idNamed('Звезда') ?? null, comet: m?.idNamed('Комета') ?? null };
    });
    expect(names.star).toBeTruthy();
    expect(names.comet).toBeNull();
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
