import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { box, chWidth, LAYOUTS, overflowing } from './helpers';

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
  /** Its wires to nodes not placed here, «↗N» (05 §8.3). */
  external: number;
  /** This placement is not its primary one (05 §5). */
  appearance: boolean;
  /** The networks it lies in. */
  places: number;
  /** Its bubble's size here by hand (06 §4.2); null — by the rules. */
  size: 's' | 'm' | 'l' | 'xl' | null;
  x: number;
  y: number;
}

interface WsHook {
  view: {
    hasPicture(id: string): boolean;
    iconOf(id: string): 'picture' | 'kind' | 'preset' | null;
    camera: { toScreen(x: number, y: number): { x: number; y: number } };
    nodeAt(id: string): { x: number; y: number; r: number } | null;
    markOf(id: string, mark: 'external' | 'places'): { x: number; y: number } | null;
    canvas: HTMLCanvasElement;
    lens: ReadonlySet<string> | null;
    /** Nodes cut with `Ctrl+X`, half seen until the paste (06 §12.1). */
    cut: ReadonlySet<string>;
  };
  core: {
    tree(): Promise<{ id: string; name: string; parent?: string }[]>;
    node(id: string): Promise<{ icon?: string; status?: string; color?: number }>;
    view(net: string): Promise<{ nodes: { id: string; name: string; size?: string }[] }>;
  };
  editor(): {
    selected: string[];
    ringSlots(): { slot: string; x: number; y: number }[];
  } | null;
  graph(): {
    nodes: Map<string, Node>;
    wireShape: 'straight' | 'bezier' | 'kinetic';
    rollups: readonly { a: string; b: string; count: number }[];
    edges(): [string, string][];
    transaction(label: { key: string }, build: (tx: unknown) => void): unknown;
  } | null;
  net(): string;
  settled(): Promise<void>;
  /** The open board's scene (13 §2.8). */
  board?: { elements(): { type: string; text?: string; originalText?: string }[] };
  map(): {
    state: string;
    selectedId(): string | null;
    focusId(): string | null;
    idNamed(name: string): string | null;
    screenOf(id: string): { x: number; y: number } | null;
    lensIds(): string[] | null;
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
  // The first frames of software WebGL hold the main thread (CI's WebKit under
  // load): the render with the path may come seconds later than the graph.
  await expect(page.locator('.workspace')).toHaveAttribute('data-depth', '1', {
    timeout: 15_000,
  });
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

/** What node `id` shows and holds: its body's icon and its `icon` on the canvas and in the core. */
const iconState = (page: Page, id: string) =>
  page.evaluate(async (id) => {
    const ws = window.__strataWs as WsHook;
    await ws.settled();
    const icon = ws.graph()?.nodes.get(id)?.attrs.icon ?? null;
    const core = (await ws.core.node(id)).icon ?? null;
    return { shows: ws.view.iconOf(id), icon, core };
  }, id);

/** A node's bubble as drawn — its radius — and its size by hand on the canvas and in the core. */
const sizeState = (page: Page, id: string) =>
  page.evaluate(async (id) => {
    const ws = window.__strataWs as WsHook;
    await ws.settled();
    const core = (await ws.core.view(ws.net())).nodes.find((n) => n.id === id)?.size ?? null;
    const size = ws.graph()?.nodes.get(id)?.size ?? null;
    return { r: ws.view.nodeAt(id)?.r ?? null, size, core };
  }, id);

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
async function dropMade(
  page: Page,
  kind: 'png' | 'wav' | 'pdf' | 'broken-pdf',
  name: string,
  x = 600,
  y = 400,
) {
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
      } else if (kind === 'pdf') {
        // Two pages, a green square on each; no xref, which readers rebuild.
        const ink = '0.7 0.95 0.42 rg 20 20 160 160 re f';
        const pdf = [
          '%PDF-1.4',
          '1 0 obj <</Type/Catalog/Pages 2 0 R>> endobj',
          '2 0 obj <</Type/Pages/Kids[3 0 R 4 0 R]/Count 2>> endobj',
          '3 0 obj <</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 5 0 R>> endobj',
          '4 0 obj <</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 5 0 R>> endobj',
          `5 0 obj <</Length ${ink.length}>> stream`,
          ink,
          'endstream endobj',
          'trailer <</Root 1 0 R>>',
          '%%EOF',
        ].join('\n');
        file = new File([pdf], `${name}.pdf`, { type: 'application/pdf' });
      } else {
        file = new File(['not a PDF at all'], `${name}.pdf`, { type: 'application/pdf' });
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

/**
 * «Арт», a folder with «Эскиз» inside, and «Идея» at the root whose text
 * links to «Эскиз»: a wire to a node placed elsewhere (05 §8.3).
 */
async function linkedAway(page: Page, extra: readonly string[] = []) {
  const ws = page.locator('.workspace');
  await page.mouse.move(420, 300);
  await page.keyboard.press('Tab');
  await page.keyboard.type('папка');
  // The kind by its name in the UI's language.
  const kind = page.locator('.tab-menu-label', { hasText: /^(Папка|Folder)$/ });
  await page.locator('.tab-menu-row', { has: kind }).first().click();
  await page.keyboard.type('Арт');
  await page.keyboard.press('Enter');
  await settled(page);
  await page.keyboard.press('Enter');
  await expect(ws).toHaveAttribute('data-depth', '2');
  await createNode(page, 640, 400, 'Эскиз');
  // More nodes in «Арт», linked too: two rows of six above «Эскиз».
  for (const [i, name] of extra.entries()) {
    await createNode(page, 280 + (i % 6) * 110, 170 + Math.floor(i / 6) * 120, name);
  }
  await page.keyboard.press('KeyU');
  await expect(ws).toHaveAttribute('data-depth', '1');
  await createNode(page, 760, 520, 'Идея');
  await select(page, 'Идея');
  await page.keyboard.press('Enter');
  const editor = page.locator('.note-window .cm-content');
  await expect(editor).toBeVisible();
  await editor.click();
  const links = ['Эскиз', ...extra].map((n) => `[[${n}]]`).join(' ');
  await page.keyboard.type(`См. ${links}`, { delay: 20 });
  await page.locator('.note-window .window-close').click();
  await expect(page.locator('.note-window')).toHaveCount(0);
  const idea = await idOf(page, 'Идея');
  await expect
    .poll(() => page.evaluate((id) => window.__strataWs?.graph()?.nodes.get(id)?.external, idea))
    .toBe(1 + extra.length);
  return idea;
}

/**
 * «Игра», a folder with «Референсы» inside, and an appearance of
 * «Референсы» at the root by the Tab menu's `Alt+Enter` (05 §5, 06 §5.3).
 */
async function appearing(page: Page) {
  const ws = page.locator('.workspace');
  await page.mouse.move(420, 300);
  await page.keyboard.press('Tab');
  await page.keyboard.type('папка');
  const kind = page.locator('.tab-menu-label', { hasText: /^(Папка|Folder)$/ });
  await page.locator('.tab-menu-row', { has: kind }).first().click();
  await page.keyboard.type('Игра');
  await page.keyboard.press('Enter');
  await settled(page);
  await page.keyboard.press('Enter');
  await expect(ws).toHaveAttribute('data-depth', '2');
  await createNode(page, 640, 400, 'Референсы');
  await page.keyboard.press('KeyU');
  await expect(ws).toHaveAttribute('data-depth', '1');
  // The workspace's tree knows it: the menu searches the whole workspace.
  await expect(page.locator('.layer-row', { hasText: 'Референсы' })).toBeVisible();
  await page.mouse.move(760, 480);
  await page.keyboard.press('Tab');
  await page.keyboard.type('Референсы');
  await page.keyboard.press('Alt+Enter');
  await expect(ws).toHaveAttribute('data-nodes', '2');
  const id = await idOf(page, 'Референсы');
  await expect.poll(() => placement(page, id)).toEqual({ appearance: true, places: 2 });
  return id;
}

const placement = (page: Page, id: string) =>
  page.evaluate((id) => {
    const n = window.__strataWs?.graph()?.nodes.get(id);
    return n ? { appearance: n.appearance, places: n.places } : null;
  }, id);

/** Clicks node `id`'s mark on the rim: «↗N» or the shortcut of an appearance. */
async function clickMark(page: Page, id: string, which: 'external' | 'places') {
  const markOf = () =>
    page.evaluate(
      ([id, which]) => {
        const ws = window.__strataWs as WsHook;
        const m = ws.view.markOf(id, which);
        const r = ws.view.canvas.getBoundingClientRect();
        return m ? { x: r.left + m.x, y: r.top + m.y } : null;
      },
      [id, which] as const,
    );
  // The mark is where the last frame drew it: the count comes before the frame.
  await expect.poll(markOf).not.toBeNull();
  const mark = await markOf();
  if (!mark) throw new Error(`no ${which} mark drawn`);
  await page.mouse.click(mark.x, mark.y);
}

/** Opens the list behind node `id`'s «↗N» by a click on the mark. */
async function openExternal(page: Page, id: string, rows = 1) {
  await page.keyboard.press('Escape');
  await clickMark(page, id, 'external');
  await expect(page.locator('.ext-list .tab-menu-row')).toHaveCount(rows);
}

/** Eleven more ends: with «Эскиз», past the ten «Показать все здесь» shows without asking. */
const ELEVEN = ['Н1', 'Н2', 'Н3', 'Н4', 'Н5', 'Н6', 'Н7', 'Н8', 'Н9', 'Н10', 'Н11'];

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

/** A folder from the Tab menu at (x, y), named, the canvas staying where it is. */
async function makeFolder(page: Page, name: string, x: number, y: number) {
  const before = (await graphNow(page)).names.length;
  await page.mouse.move(x, y);
  await page.keyboard.press('Tab');
  await page.keyboard.type('папка');
  const kind = page.locator('.tab-menu-label', { hasText: /^(Папка|Folder)$/ });
  await page.locator('.tab-menu-row', { has: kind }).first().click();
  await expect(page.locator('.name-input')).toBeVisible();
  await page.keyboard.type(name);
  await page.keyboard.press('Enter');
  await expect(page.locator('.workspace')).toHaveAttribute('data-nodes', String(before + 1));
  await settled(page);
}

/** The network a node's primary placement is in, by the core's tree (05 §5). */
const parentOf = (page: Page, name: string) =>
  page.evaluate(async (name) => {
    const ws = window.__strataWs as WsHook;
    await ws.settled();
    const items = await ws.core.tree();
    const item = items.find((i) => i.name === name);
    return items.find((i) => i.id === item?.parent)?.name ?? null;
  }, name);

/** How many nodes of the workspace bear this name. */
const named = (page: Page, name: string) =>
  page.evaluate(async (name) => {
    const ws = window.__strataWs as WsHook;
    await ws.settled();
    return (await ws.core.tree()).filter((i) => i.name === name).length;
  }, name);

const cutNow = (page: Page) =>
  page.evaluate(() => [...((window.__strataWs as WsHook).view.cut ?? [])]);

/**
 * Empties the system clipboard. It is the browser's, not the test's: what an
 * earlier test copied (a board's elements, JSON) would paste on the canvas
 * as a note (13 §3.9). WebKit grants no clipboard permission; there the
 * clipboard stays as it is.
 */
async function emptyClipboard(page: Page) {
  try {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  } catch {
    return;
  }
  await page.evaluate(() => navigator.clipboard.writeText(''));
}

/** Into a network on the canvas by its bubble: chosen, then `Enter`. */
async function enter(page: Page, name: string) {
  const depth = Number(await page.locator('.workspace').getAttribute('data-depth'));
  await select(page, name);
  await page.evaluate(() => window.__strataWs?.view.canvas.focus());
  await page.keyboard.press('Enter');
  await expect(page.locator('.workspace')).toHaveAttribute('data-depth', String(depth + 1));
}

/** Out of the network on the canvas, `U`. */
async function leave(page: Page) {
  const depth = Number(await page.locator('.workspace').getAttribute('data-depth'));
  await page.evaluate(() => window.__strataWs?.view.canvas.focus());
  await page.keyboard.press('KeyU');
  await expect(page.locator('.workspace')).toHaveAttribute('data-depth', String(depth - 1));
}

/**
 * Drags node `name` onto the bubble of `onto`, rests there `hold` ms and lets
 * go (06 §12.1), the keys of `mods` held all along; the steps written are awaited.
 */
async function dragOnto(page: Page, name: string, onto: string, mods: string[] = [], hold = 700) {
  const from = await at(page, name);
  const to = await at(page, onto);
  for (const m of mods) await page.keyboard.down(m);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 8, from.y + 8, { steps: 2 });
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.waitForTimeout(hold);
  await page.mouse.move(to.x + 1, to.y, { steps: 1 });
  await page.mouse.up();
  for (const m of [...mods].reverse()) await page.keyboard.up(m);
  await settled(page);
}

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
      // The whole path as one types it (09 §4.2), and what a click and the right button do.
      await expect(path.locator('ol')).toHaveAttribute(
        'title',
        /^\/Уровни, локации и всё, что между ними\/Болото у старой мельницы за туманным лесом · /,
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
      await path
        .getByRole('button', { name: 'Уровни, локации и всё, что между ними', exact: true })
        .click();
      await expect(page.locator('.workspace')).toHaveAttribute('data-depth', '2');
      await expect(path.locator('[aria-current="location"]')).toContainText('Уровни');
      await path.getByRole('button', { name: 'Игра «Туман»', exact: true }).click();
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

/**
 * root ─ Проекты ─ Игра;  root ─ Фильм, where «Игра» appears too (05 §5),
 * placed there by the Tab menu's `Alt+Enter`. The canvas ends in «Фильм».
 */
async function twoWays(page: Page) {
  await makeFolder(page, 'Проекты', 420, 300);
  await makeFolder(page, 'Фильм', 760, 460);
  await enter(page, 'Проекты');
  await makeFolder(page, 'Игра', 520, 360);
  await leave(page);
  await enter(page, 'Фильм');
  await page.mouse.move(640, 400);
  await page.keyboard.press('Tab');
  await page.keyboard.type('Игра');
  await page.keyboard.press('Alt+Enter');
  await expect(page.locator('.workspace')).toHaveAttribute('data-nodes', '1');
  const game = await idOf(page, 'Игра');
  await expect.poll(() => placement(page, game)).toEqual({ appearance: true, places: 2 });
  await settled(page);
}

for (const deviceScaleFactor of [1, 2]) {
  test(`a content window's title and the dock keep their boxes in RU and EN @${deviceScaleFactor}x (06 §2.2)`, async ({
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
      await createWorkspace(page, 'Окна');
      await createNode(page, 420, 300, 'Черновик с длинным именем, которое не влезет в заголовок');
      await select(page, 'Черновик с длинным именем, которое не влезет в заголовок');
      await page.evaluate(() => window.__strataWs?.view.canvas.focus());
      await page.keyboard.press('Control+Enter');
      const win = page.locator('.note-window');
      await expect(win).toHaveAttribute('data-mode', 'pinned');
      await expect(win.locator('.window-tool')).toHaveCount(3);
      expect(await overflowing(page, '.note-window .window-title'), `${locale} title`).toEqual([]);
      boxes.push({
        window: await box(page, '.note-window'),
        tools: await box(page, '.note-window .window-tools'),
        name: await box(page, '.note-window h2'),
      });
      await context.close();
    }
    const [ru, en] = boxes as [(typeof boxes)[number], (typeof boxes)[number]];
    for (const part of ['window', 'tools', 'name'] as const) {
      for (const k of ['x', 'y', 'width', 'height'] as const) {
        expect(Math.abs(en[part][k] - ru[part][k]), `${part} ${k}`).toBeLessThanOrEqual(0.5);
      }
    }
  });
}

for (const deviceScaleFactor of [1, 2]) {
  test(`▾, the canonical path and the typed path keep their boxes in RU and EN @${deviceScaleFactor}x (09 §4.3)`, async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const boxes = [];
    for (const locale of ['ru-RU', 'en-US'] as const) {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor,
        locale,
      });
      const page = await context.newPage();
      await page.goto('/?plain');
      await createWorkspace(page, 'Пути');
      await twoWays(page);
      await enter(page, 'Игра');
      const path = page.locator('.ws-path');
      await expect(path.locator('.ws-path-canonical')).toBeVisible();
      expect(await overflowing(page, '.ws-path'), `${locale} the path must fit`).toEqual([]);
      const bar = await box(page, '.ws-path-box');
      const canonical = await box(page, '.ws-path-canonical');
      // ▾ after the root, over the path.
      await path.locator('.ws-path-root + li .ws-path-more').click();
      const menu = page.locator('.path-menu');
      await expect(menu.locator('.tab-menu-row')).toHaveCount(2);
      expect(await overflowing(page, '.path-menu'), `${locale} ▾ must fit`).toEqual([]);
      const list = await box(page, '.path-menu');
      expect(list.y + list.height).toBeLessThanOrEqual(bar.y);
      expect(list.width).toBeLessThanOrEqual((await chWidth(page, 40)) + 2);
      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);
      await expect(path.locator('.ws-path-root + li .ws-path-more')).toBeFocused();
      // The field with a segment that names nothing and the name offered.
      await path.locator('[aria-current="location"]').click();
      await page.keyboard.type('/Проекты/Игры');
      await page.keyboard.press('Enter');
      await expect(path.locator('.ws-path-input')).toHaveAttribute('aria-invalid', 'true');
      await expect(page.locator('.path-answer .tab-menu-row')).toHaveCount(1);
      expect(await overflowing(page, '.ws-path'), `${locale} the field must fit`).toEqual([]);
      boxes.push({
        bar,
        canonical,
        list,
        field: await box(page, '.ws-path-input'),
        answer: await box(page, '.path-answer'),
      });
      await context.close();
    }
    const [ru, en] = boxes as [(typeof boxes)[number], (typeof boxes)[number]];
    for (const part of ['bar', 'canonical', 'list', 'field', 'answer'] as const) {
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
        window: await box(page, '.settings'),
        page: await box(page, '.settings-page'),
        fields: await box(page, '.settings section:nth-of-type(2) .ins-fields'),
        gear: await box(page, '.tabbar-settings'),
      });
      await context.close();
    }
    const [ru, en] = boxes as [(typeof boxes)[number], (typeof boxes)[number]];
    for (const part of ['window', 'page', 'fields', 'gear'] as const) {
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
      await expect(palette.locator('.palette-query')).toBeFocused();
      expect(await overflowing(page, '.command-palette'), `${locale} the palette must fit`).toEqual(
        [],
      );
      const rows = await palette.locator('.tab-menu-row').count();
      boxes.push({
        palette: await box(page, '.command-palette'),
        row: await box(page, '.command-palette .tab-menu-row.is-current'),
        rows,
      });
      await palette.locator('.palette-query').press('Escape');
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

  test(`the list behind «↗N» keeps its size in RU and EN @${deviceScaleFactor}x (06 §14)`, async ({
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
      await createWorkspace(page, 'Связи');
      const idea = await linkedAway(page, ELEVEN);
      await openExternal(page, idea, 12);
      const list = page.locator('.ext-list');
      await expect(list.locator('.ext-origin').first()).not.toHaveText('');
      expect(await overflowing(page, '.ext-list'), `${locale} the list must fit`).toEqual([]);
      const footer = await box(page, '.ext-list .ext-footer');
      // Past ten nodes «Показать все здесь» asks first, in the same footer.
      await list.locator('.ext-footer button').click();
      await expect(list.locator('.ext-ask')).toBeVisible();
      expect(await overflowing(page, '.ext-list'), `${locale} the question must fit`).toEqual([]);
      const asking = await box(page, '.ext-list .ext-footer');
      await expect(page.locator('.ws-inspector')).toBeVisible();
      const panel = await box(page, '.ws-inspector');
      const shown = await box(page, '.ext-list');
      expect(shown.x + shown.width, 'left of the panel').toBeLessThanOrEqual(panel.x);
      boxes.push({
        list: await box(page, '.ext-list'),
        row: await box(page, '.ext-list .tab-menu-row:first-child'),
        path: await box(page, '.ext-list .tab-menu-row:first-child .ext-path'),
        origin: await box(page, '.ext-list .tab-menu-row:first-child .ext-origin'),
        footer,
        asking,
      });
      await page.keyboard.press('Escape');
      await expect(list).toHaveCount(0);
      await context.close();
    }
    const [ru, en] = boxes as [(typeof boxes)[number], (typeof boxes)[number]];
    for (const part of ['list', 'row', 'path', 'origin', 'footer', 'asking'] as const) {
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
      const bar2d = await box(page, '.find-bar');
      const input2d = await box(page, '.find-bar input');
      // The same bar on the star map (08 §6.1), with no «поддерево».
      await bar.locator('input').press('Escape');
      await expect(bar).toHaveCount(0);
      await page.evaluate(() => window.__strataWs?.view.canvas.focus());
      await page.keyboard.press('KeyM');
      await expect(page.locator('.workspace')).toHaveAttribute('data-view', '3d', {
        timeout: 30_000,
      });
      await page.keyboard.press('Control+f');
      await bar.locator('input').fill('мельнциа');
      await expect(bar.locator('.find-fuzzy')).toBeVisible();
      expect(await overflowing(page, '.find-bar'), `${locale} the map's bar must fit`).toEqual([]);
      boxes.push({
        goto: gotoBox,
        row,
        bar: bar2d,
        input: input2d,
        bar3d: await box(page, '.find-bar'),
        input3d: await box(page, '.find-bar input'),
      });
      await context.close();
    }
    const [ru, en] = boxes as [(typeof boxes)[number], (typeof boxes)[number]];
    for (const part of ['goto', 'row', 'bar', 'input', 'bar3d', 'input3d'] as const) {
      for (const k of ['x', 'y', 'width', 'height'] as const) {
        expect(Math.abs(en[part][k] - ru[part][k]), `${part} ${k}`).toBeLessThanOrEqual(0.5);
      }
    }
  });
}

for (const deviceScaleFactor of [1, 2]) {
  test(`the icon palette keeps its size in RU and EN @${deviceScaleFactor}x (07 §6.3)`, async ({
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
      await createWorkspace(page, 'Иконки');
      await createNode(page, 460, 300, 'Карта');
      await select(page, 'Карта');
      await page.keyboard.press('KeyZ');
      const palette = page.locator('.icon-palette');
      await expect(palette.locator('.icon-cell')).toHaveCount(200);
      // The longest name under the keys: «Кольцо с бриллиантом» / «Round-bottom flask».
      await page.keyboard.type(locale === 'ru-RU' ? 'бриллиант' : 'flask');
      await expect(palette.locator('.icon-cell').first()).toHaveClass(/is-current/);
      expect(await overflowing(page, '.icon-palette'), `${locale} the palette must fit`).toEqual(
        [],
      );
      boxes.push({
        palette: await box(page, '.icon-palette'),
        cell: await box(page, '.icon-palette .icon-cell:first-child'),
        footer: await box(page, '.icon-palette .icon-palette-footer'),
        kind: await box(page, '.icon-palette .icon-palette-top button:not(.icon-own)'),
        own: await box(page, '.icon-palette .icon-own'),
        auto: await box(page, '.icon-palette .icon-size-choice.is-auto'),
        xl: await box(page, '.icon-palette .icon-size-choice:last-child'),
      });
      await page.keyboard.press('Escape');
      await context.close();
    }
    const [ru, en] = boxes as [(typeof boxes)[number], (typeof boxes)[number]];
    for (const part of ['palette', 'cell', 'footer', 'kind', 'own', 'auto', 'xl'] as const) {
      for (const k of ['x', 'y', 'width', 'height'] as const) {
        expect(Math.abs(en[part][k] - ru[part][k]), `${part} ${k}`).toBeLessThanOrEqual(0.5);
      }
    }
  });

  test(`«Своя иконка» keeps its size in RU and EN @${deviceScaleFactor}x (07 §6.4–6.5)`, async ({
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
      await createWorkspace(page, 'Иконки');
      await createNode(page, 460, 300, 'Карта');
      await select(page, 'Карта');
      const png = await page.evaluate(() => {
        const c = document.createElement('canvas');
        c.width = 64;
        c.height = 48;
        const g = c.getContext('2d') as CanvasRenderingContext2D;
        g.fillStyle = '#f0f0f0';
        g.fillRect(0, 0, 64, 48);
        g.fillStyle = '#303030';
        g.fillRect(16, 8, 32, 32);
        return c.toDataURL('image/png').split(',')[1] ?? '';
      });
      await page.keyboard.press('KeyZ');
      const chooser = page.waitForEvent('filechooser');
      await page.locator('.icon-palette .icon-own').click();
      await (await chooser).setFiles({
        name: 'a-picture-with-a-rather-long-name-of-its-own.png',
        mimeType: 'image/png',
        buffer: Buffer.from(png, 'base64'),
      });
      const dialog = page.locator('.own-icon-dialog');
      await expect(dialog).toBeVisible();
      // The longest mode by hand: «Силуэт» / «Silhouette».
      await dialog.locator('.own-mode[data-mode="silhouette"]').click();
      expect(await overflowing(page, '.own-icon-dialog'), `${locale} the dialog must fit`).toEqual(
        [],
      );
      boxes.push({
        dialog: await box(page, '.own-icon-dialog'),
        previews: await box(page, '.own-icon-dialog .own-previews'),
        modes: await box(page, '.own-icon-dialog .own-modes'),
        first: await box(page, '.own-icon-dialog .own-mode[data-mode="engraving"]'),
        last: await box(page, '.own-icon-dialog .own-mode[data-mode="as-is"]'),
        slider: await box(page, '.own-icon-dialog .own-threshold'),
        actions: await box(page, '.own-icon-dialog .own-actions'),
      });
      await page.keyboard.press('Escape');
      await context.close();
    }
    const [ru, en] = boxes as [(typeof boxes)[number], (typeof boxes)[number]];
    for (const part of [
      'dialog',
      'previews',
      'modes',
      'first',
      'last',
      'slider',
      'actions',
    ] as const) {
      for (const k of ['x', 'y', 'width', 'height'] as const) {
        expect(Math.abs(en[part][k] - ru[part][k]), `${part} ${k}`).toBeLessThanOrEqual(0.5);
      }
    }
  });

  test(`the colour palette keeps its size in RU and EN @${deviceScaleFactor}x (06 §2.1)`, async ({
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
      await createWorkspace(page, 'Цвета');
      await createNode(page, 460, 300, 'Карта');
      await select(page, 'Карта');
      await page.keyboard.press('KeyC');
      const palette = page.locator('.color-palette');
      await expect(palette.locator('.color-cell')).toHaveCount(9);
      expect(await overflowing(page, '.color-palette'), `${locale} the palette must fit`).toEqual(
        [],
      );
      boxes.push({
        palette: await box(page, '.color-palette'),
        header: await box(page, '.color-palette .tab-menu-header'),
        none: await box(page, '.color-palette .color-cell.is-none'),
        last: await box(page, '.color-palette .color-cell:last-child'),
      });
      await page.keyboard.press('Escape');
      await expect(palette).toHaveCount(0);
      await context.close();
    }
    const [ru, en] = boxes as [(typeof boxes)[number], (typeof boxes)[number]];
    // The glyph-free cells are squares; RU and EN draw the same boxes.
    expect(ru.none.width).toBe(ru.none.height);
    for (const part of ['palette', 'header', 'none', 'last'] as const) {
      for (const k of ['x', 'y', 'width', 'height'] as const) {
        expect(Math.abs(en[part][k] - ru[part][k]), `${part} ${k}`).toBeLessThanOrEqual(0.5);
      }
    }
  });

  test(`the info card keeps its size in RU and EN @${deviceScaleFactor}x (06 §4.4)`, async ({
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
      await createWorkspace(page, 'Справка');
      await createNode(page, 460, 300, 'Сценарий финальной битвы с боссом');
      const p = await at(page, 'Сценарий финальной битвы с боссом');
      await page.mouse.move(p.x, p.y);
      await page.keyboard.press('Shift+KeyI');
      const card = page.locator('.ws-info-card');
      await expect(card.locator('.map-card-rows')).toBeVisible();
      expect(await overflowing(page, '.ws-info-card'), `${locale} the card must fit`).toEqual([]);
      boxes.push({
        card: await box(page, '.ws-info-card'),
        title: await box(page, '.ws-info-card .map-card-title'),
        label: await box(page, '.ws-info-card .map-card-label'),
      });
      await card.locator('.window-close').click();
      await context.close();
    }
    const [ru, en] = boxes as [(typeof boxes)[number], (typeof boxes)[number]];
    for (const part of ['card', 'title', 'label'] as const) {
      for (const k of ['x', 'y', 'width', 'height'] as const) {
        expect(Math.abs(en[part][k] - ru[part][k]), `${part} ${k}`).toBeLessThanOrEqual(0.5);
      }
    }
  });

  test(`«Клавиши» keep their size in RU and EN @${deviceScaleFactor}x (06 §17)`, async ({
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
      await createWorkspace(page, 'Клавиши');
      await page.evaluate(() => window.__strataWs?.view.canvas.focus());
      await page.keyboard.press('Shift+Slash');
      const help = page.locator('.help-window');
      await expect(help).toBeVisible();
      await expect(help.locator('.help-group')).toHaveCount(8);
      expect(await overflowing(page, '.help-window'), `${locale} the keys must fit`).toEqual([]);
      boxes.push({
        window: await box(page, '.help-window'),
        heading: await box(page, '.help-window .help-group:first-child .ins-heading'),
        what: await box(page, '.help-window .help-group:first-child .help-row:first-child dt'),
        keys: await box(page, '.help-window .help-group:first-child .help-row:first-child dd'),
      });
      await page.keyboard.press('Escape');
      await expect(help).toHaveCount(0);
      await context.close();
    }
    const [ru, en] = boxes as [(typeof boxes)[number], (typeof boxes)[number]];
    for (const part of ['window', 'heading', 'what', 'keys'] as const) {
      for (const k of ['x', 'y', 'width', 'height'] as const) {
        expect(Math.abs(en[part][k] - ru[part][k]), `${part} ${k}`).toBeLessThanOrEqual(0.5);
      }
    }
  });

  test(`«Где размещена» and «Удалить везде?» keep their size in RU and EN @${deviceScaleFactor}x (06 §12.2–12.3)`, async ({
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
      await createWorkspace(page, 'Появления');
      await appearing(page);
      // A wire from it: the dialog says it hides with the node (06 §12.3).
      // Made on the canvas, not under the panel: the camera stays where it is.
      await select(page, 'Референсы');
      await createNode(page, 700, 640, 'Сценарий');
      await select(page, 'Референсы');
      const places = page.locator('.ws-inspector .ins-places');
      await expect(places.locator('li')).toHaveCount(2);
      // Chosen again after a name typed: no window opened, the text is in the panel.
      await expect(page.locator('.note-window')).toHaveCount(0);
      expect(await overflowing(page, '.ws-inspector'), `${locale} the panel must fit`).toEqual([]);
      const section = await box(page, '.ws-inspector .ins-places');
      const row = await box(page, '.ws-inspector .ins-places li:last-child');
      await page.evaluate(() => window.__strataWs?.view.canvas.focus());
      await page.keyboard.press('Shift+Delete');
      const dialog = page.locator('.delete-dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog.locator('.delete-wires')).toHaveText(
        locale === 'ru-RU'
          ? '1 нить скроется до возврата из корзины'
          : '1 wire hides until restored from the trash',
      );
      expect(await overflowing(page, '.delete-dialog'), `${locale} the dialog must fit`).toEqual(
        [],
      );
      boxes.push({
        section,
        row,
        dialog: await box(page, '.delete-dialog'),
        list: await box(page, '.delete-dialog .delete-list'),
      });
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await context.close();
    }
    const [ru, en] = boxes as [(typeof boxes)[number], (typeof boxes)[number]];
    for (const part of ['section', 'row', 'dialog', 'list'] as const) {
      for (const k of ['x', 'y', 'width', 'height'] as const) {
        expect(Math.abs(en[part][k] - ru[part][k]), `${part} ${k}`).toBeLessThanOrEqual(0.5);
      }
    }
  });
}

for (const deviceScaleFactor of [1, 2]) {
  test(`the moves' menu, «⊘ Нода уже здесь» and «⊘» in «Ноды» fit in RU and EN @${deviceScaleFactor}x (06 §12.1)`, async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const boxes = [];
    for (const locale of ['ru-RU', 'en-US'] as const) {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor,
        locale,
      });
      const page = await context.newPage();
      await page.goto('/?plain');
      await createWorkspace(page, 'Перенос');
      await makeFolder(page, 'Архив', 520, 320);
      await createNode(page, 760, 480, 'Эскиз');
      // The node's menu with a copy waiting: cut, copy, duplicate, paste, as an appearance, wrap,
      // icon, colour; its path and a [[link]] to the clipboard (09 §4.6).
      await select(page, 'Эскиз');
      await page.evaluate(() => window.__strataWs?.view.canvas.focus());
      await page.keyboard.press('Control+c');
      const sketch = await at(page, 'Эскиз');
      await page.mouse.click(sketch.x, sketch.y, { button: 'right' });
      const menu = page.locator('.context-menu');
      await expect(menu.locator('.context-menu-row')).toHaveCount(17);
      expect(await overflowing(page, '.context-menu'), `${locale} the menu must fit`).toEqual([]);
      expect((await box(page, '.context-menu')).width).toBeLessThanOrEqual(
        (await chWidth(page, 40)) + 2,
      );
      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);
      // An appearance dragged away from any folder: «⊘ Нода уже здесь» by the cursor.
      const mods = ['Alt', 'ControlOrMeta', 'Shift'];
      for (const m of mods) await page.keyboard.down(m);
      await page.mouse.move(sketch.x, sketch.y);
      await page.mouse.down();
      await page.mouse.move(sketch.x + 60, sketch.y + 40, { steps: 6 });
      const note = page.locator('.ws-cursor-note');
      await expect(note).toBeVisible();
      // The note follows the pointer a frame behind (WebKit coalesces the
      // moves): measured once it stands where the cursor was let rest.
      await expect
        .poll(() =>
          note.evaluate(
            (el, at) => {
              const s = (el as HTMLElement).style;
              return Math.max(
                Math.abs(Number.parseFloat(s.left) - at.x),
                Math.abs(Number.parseFloat(s.top) - at.y),
              );
            },
            { x: sketch.x + 60, y: sketch.y + 40 },
          ),
        )
        .toBeLessThanOrEqual(1);
      expect(await overflowing(page, '.ws-cursor-note'), `${locale} the note must fit`).toEqual([]);
      const glyph = await box(page, '.ws-cursor-note .kind-icon');
      const shown = await box(page, '.ws-cursor-note');
      await page.mouse.up();
      for (const m of [...mods].reverse()) await page.keyboard.up(m);
      await expect(note).toHaveCount(0);
      // «Архив» dragged onto itself in «Ноды»: «⊘» on its row, the drop moves nothing.
      const row = page.locator('.layer-row', { hasText: 'Архив' });
      const name = await box(page, '.layer-row:has-text("Архив") .layer-name');
      await page.mouse.move(name.x + 20, name.y + name.height / 2);
      await page.mouse.down();
      await page.mouse.move(name.x + 60, name.y + name.height / 2, { steps: 4 });
      await expect(row).toHaveClass(/is-refused/);
      boxes.push({
        glyph,
        note: { ...shown, width: 0 },
        row: await box(page, '.layer-row.is-refused'),
        forbid: await box(page, '.layer-row.is-refused .layer-forbid .kind-icon'),
      });
      await page.mouse.up();
      await expect(row).not.toHaveClass(/is-refused/);
      await context.close();
    }
    const [ru, en] = boxes as [(typeof boxes)[number], (typeof boxes)[number]];
    // The glyphs are 16u in both languages; the note grows only to the right.
    expect(ru.glyph.width).toBe(ru.glyph.height);
    for (const part of ['glyph', 'note', 'row', 'forbid'] as const) {
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

for (const deviceScaleFactor of [1, 2]) {
  test(`«Фон» keeps its size in RU and EN @${deviceScaleFactor}x (07 §7.4)`, async ({
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
      await createWorkspace(page, 'Фоны');
      await page.evaluate(() => window.__strataWs?.view.canvas.focus());
      await page.keyboard.press('Control+p');
      await page.locator('.command-palette .palette-query').fill('background');
      await page.keyboard.press('Enter');
      const palette = page.locator('.bg-palette');
      await expect(palette).toBeVisible();
      expect(await overflowing(page, '.bg-palette'), `${locale} «Фон» must fit`).toEqual([]);
      boxes.push({ palette: await box(page, '.bg-palette') });
      await context.close();
    }
    const [ru, en] = boxes as [(typeof boxes)[number], (typeof boxes)[number]];
    for (const k of ['x', 'y', 'width', 'height'] as const) {
      expect(Math.abs(en.palette[k] - ru.palette[k]), k).toBeLessThanOrEqual(0.5);
    }
  });
}

for (const deviceScaleFactor of [1, 2]) {
  test(`the updates' question and offer keep their size in RU and EN @${deviceScaleFactor}x (NFR-89, NFR-94)`, async ({
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
      // A build with a channel and a newer version on it; nothing answered yet.
      await page.goto('/?updates&update=9.9.9');
      const dialog = page.locator('.update-dialog');
      await expect(dialog).toBeVisible();
      expect(await overflowing(page, '.update-dialog'), `${locale} the question must fit`).toEqual(
        [],
      );
      const ask = await box(page, '.update-dialog');
      await dialog.locator('.dialog-actions button').last().click();
      await expect(dialog.locator('h2')).toHaveText(/9\.9\.9/);
      expect(await overflowing(page, '.update-dialog'), `${locale} the offer must fit`).toEqual([]);
      boxes.push({ ask, offer: await box(page, '.update-dialog') });
      await context.close();
    }
    const [ru, en] = boxes as [(typeof boxes)[number], (typeof boxes)[number]];
    for (const part of ['ask', 'offer'] as const) {
      for (const k of ['x', 'y', 'width', 'height'] as const) {
        expect(Math.abs(en[part][k] - ru[part][k]), `${part} ${k}`).toBeLessThanOrEqual(0.5);
      }
    }
  });
}

test.describe('a workspace on the core', () => {
  test.use({ viewport: { width: 1280, height: 800 }, locale: 'ru-RU' });

  test('the path goes the way one came: the entry path, U, ▾, a typed path, «Скопировать путь» (05 §9.3, 09 §4.3–4.6)', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.goto('/?plain');
    await createWorkspace(page, 'Пути');
    await twoWays(page);
    const path = page.locator('.ws-path');
    const here = path.locator('[aria-current="location"]');
    // Into «Игра» through its appearance: the path is the way one came, the
    // shortcut by «Игра»; the canonical path grey under it, ⌂ by it.
    await enter(page, 'Игра');
    await expect(here).toContainText('Игра');
    await expect(path.getByRole('button', { name: 'Фильм', exact: true })).toBeVisible();
    await expect(here).toHaveAttribute('data-appearance', 'true');
    const canonical = path.locator('.ws-path-canonical');
    await expect(canonical).toHaveText('/Проекты/Игра');
    // The right button by «Игра»: «Также в: /Проекты», its other placement —
    // not «Фильм», the way one came; it goes there that way, and back.
    const alsoIn = (where: string) =>
      page.locator('.context-menu .context-menu-label', { hasText: `Также в: ${where}` });
    await here.click({ button: 'right' });
    await expect(alsoIn('/Фильм')).toHaveCount(0);
    await alsoIn('/Проекты').click();
    await expect(canonical).toHaveCount(0);
    await expect(path.getByRole('button', { name: 'Проекты', exact: true })).toBeVisible();
    await expect(here).not.toHaveAttribute('data-appearance', 'true');
    await here.click({ button: 'right' });
    await expect(alsoIn('/Проекты')).toHaveCount(0);
    await alsoIn('/Фильм').click();
    await expect(here).toHaveAttribute('data-appearance', 'true');
    await expect(canonical).toHaveText('/Проекты/Игра');
    // `U` goes back the way one came, not to the canonical «Проекты».
    await leave(page);
    await expect(here).toContainText('Фильм');
    await expect(canonical).toHaveCount(0);
    // ▾ after the root: the networks there, the recently visited first, the one
    // on the path marked; its triangle again closes it.
    const rootMore = path.getByRole('button', { name: 'Сети в «Пути»' });
    await rootMore.click();
    const menu = page.locator('.path-menu');
    await expect(menu.locator('.tab-menu-label')).toHaveText(['Фильм', 'Проекты']);
    await expect(menu.locator('.is-chosen')).toHaveText('Фильм');
    await rootMore.click();
    await expect(menu).toHaveCount(0);
    await rootMore.click();
    await expect(menu).toBeVisible();
    // Typing filters by the search engine's ranking; Enter goes there.
    await page.keyboard.type('проек');
    await expect(menu.locator('.tab-menu-label')).toHaveText(['Проекты']);
    await page.keyboard.press('Enter');
    await expect(here).toContainText('Проекты');
    await expect(menu).toHaveCount(0);
    // ▾ after the last: «Игра», lying here by its primary placement.
    await path.getByRole('button', { name: 'Сети в «Проекты»' }).click();
    await expect(menu.locator('.tab-menu-label')).toHaveText(['Игра']);
    await menu.locator('.tab-menu-row').first().click();
    await expect(here).toContainText('Игра');
    await expect(canonical).toHaveCount(0);
    // A click on the network one is in: the field, the canonical path chosen.
    await here.click();
    const field = path.locator('.ws-path-input');
    await expect(field).toBeFocused();
    await expect(field).toHaveValue('/Проекты/Игра');
    expect(
      await field.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd]),
    ).toEqual([0, '/Проекты/Игра'.length]);
    // Case and `ё` aside, by any placement (09 §4.2): through «Фильм».
    await page.keyboard.type('/фильм/ИГРА');
    await page.keyboard.press('Enter');
    await expect(field).toHaveCount(0);
    await expect(path.getByRole('button', { name: 'Фильм', exact: true })).toBeVisible();
    await expect(canonical).toHaveText('/Проекты/Игра');
    // A segment that names nothing: the dashed field, the segment chosen, the
    // nearest name offered; Enter takes it and goes.
    await here.click();
    await page.keyboard.type('/Проекты/Игры');
    await page.keyboard.press('Enter');
    await expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(
      await field.evaluate((el: HTMLInputElement) =>
        el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0),
      ),
    ).toBe('Игры');
    const answer = path.locator('.path-answer');
    await expect(answer.locator('.tab-menu-label').first()).toHaveText('Игра');
    await page.keyboard.press('Enter');
    await expect(field).toHaveCount(0);
    await expect(here).toContainText('Игра');
    await expect(canonical).toHaveCount(0);
    // `Esc` gives the path back.
    await here.click();
    await page.keyboard.type('/Фильм');
    await page.keyboard.press('Escape');
    await expect(field).toHaveCount(0);
    await expect(here).toContainText('Игра');
    // The right button: the canonical path to the clipboard, said by a toast;
    // «Скопировать путь захода» only where the way one came is another; the
    // other placement of «Игра» as «Также в».
    await here.click({ button: 'right' });
    const ctx = page.locator('.context-menu');
    await expect(ctx.locator('.context-menu-label')).toHaveText([
      'Скопировать путь',
      'Скопировать как [[ссылку]]',
      'Также в: /Фильм',
      'Ввести путь',
    ]);
    await ctx.getByText('Скопировать путь', { exact: true }).click();
    await expect(page.locator('.toast', { hasText: 'Скопировано: /Проекты/Игра' })).toBeVisible();
    // The palette's «Ввести путь» at the root, where the path is not shown.
    await path.getByRole('button', { name: 'Пути', exact: true }).click();
    await expect(path.locator('ol')).toHaveCount(0);
    await page.evaluate(() => window.__strataWs?.view.canvas.focus());
    await page.keyboard.press('Control+p');
    await page.keyboard.type('ввести путь');
    await expect(page.locator('.command-palette .tab-menu-row.is-current')).toContainText(
      'Ввести путь',
    );
    await page.keyboard.press('Enter');
    await expect(field).toBeFocused();
    await expect(field).toHaveValue('/');
    await page.keyboard.type('Фильм/Игра');
    await page.keyboard.press('Enter');
    await expect(here).toContainText('Игра');
    await expect(path.getByRole('button', { name: 'Фильм', exact: true })).toBeVisible();
  });

  test('Ctrl+O takes a path: the core resolves it from the entry path, Tab completes, a path ending in / lists what lies there (09 §2.1, §4.4)', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.goto('/?plain');
    await createWorkspace(page, 'Пути');
    await twoWays(page);
    // In «Игра», come to through «Фильм».
    await enter(page, 'Игра');
    const goto = page.locator('.goto');
    const input = goto.locator('input');
    const rows = goto.locator('.tab-menu-label');
    const here = page.locator('.ws-path [aria-current="location"]');
    await page.keyboard.press('Control+o');
    // `..` goes back the way one came: «Фильм», not the canonical «Проекты».
    await page.keyboard.type('..');
    await expect(rows).toHaveText(['Фильм']);
    // A path that ends with `/` lists what lies in its network, by name.
    await input.fill('/');
    await expect(rows).toHaveText(['Проекты', 'Фильм']);
    // Tab puts the row's name in, `/` after a network.
    await page.keyboard.press('Tab');
    await expect(input).toHaveValue('/Проекты/');
    await expect(rows).toHaveText(['Игра']);
    // A segment typed in part: the nearest names; Enter puts the name there,
    // the path is asked again and goes — «Игра» chosen in «Проекты».
    await page.keyboard.type('иг');
    await expect(rows).toHaveText(['Игра']);
    await page.keyboard.press('Enter');
    await expect(goto).toHaveCount(0);
    await expect(here).toContainText('Проекты');
    await expect(page.locator('.ws-inspector .ins-title-name')).toHaveText('Игра');
    // A segment that names nothing and nothing near: said in the list.
    await page.keyboard.press('Control+o');
    await page.keyboard.type('/Проекты/Ъ');
    await expect(goto.locator('.tab-menu-empty')).toHaveText('Не найдено: «Ъ»');
    // Shift+Enter goes into a network, by the way the path went.
    await input.fill('/Фильм/Игра');
    await expect(rows).toHaveText(['Игра']);
    await page.keyboard.press('Shift+Enter');
    await expect(goto).toHaveCount(0);
    await expect(here).toContainText('Игра');
    await expect(
      page.locator('.ws-path').getByRole('button', { name: 'Фильм', exact: true }),
    ).toBeVisible();
  });

  test('F6 takes the focus through the areas of the screen, Shift+F6 back (06 §1.1, §17)', async ({
    page,
  }) => {
    await page.goto('/?plain');
    await createWorkspace(page, 'Области');
    await makeFolder(page, 'Архив', 420, 300);
    await enter(page, 'Архив');
    await createNode(page, 500, 360, 'Черновик');
    await select(page, 'Черновик');
    await page.evaluate(() => window.__strataWs?.view.canvas.focus());
    await page.keyboard.press('Enter');
    await expect(page.locator('.note-window .cm-content')).toBeFocused();
    const area = () =>
      page.evaluate(() => {
        const a = document.activeElement;
        if (a?.closest('.ws-layers')) return 'layers';
        if (a?.tagName === 'CANVAS') return 'canvas';
        if (a?.closest('.ws-path')) return 'path';
        if (a?.closest('.note-window')) return 'note';
        if (a?.closest('.ws-inspector')) return 'panel';
        return a?.tagName ?? 'none';
      });
    // In reading order: «Ноды», the canvas, the path, the window, the panel.
    for (const next of ['panel', 'layers', 'canvas', 'path', 'note']) {
      await page.keyboard.press('F6');
      expect(await area()).toBe(next);
    }
    await page.keyboard.press('Shift+F6');
    expect(await area()).toBe('path');
    // «Ноды» take it on the network one is in.
    await page.keyboard.press('Shift+F6');
    await page.keyboard.press('Shift+F6');
    await expect(page.locator('.layer-row.is-here .layer-name')).toBeFocused();
    // The palette's «Следующая область» does what F6 does.
    await page.keyboard.press('Control+p');
    await page.keyboard.type('следующая область');
    await expect(page.locator('.command-palette .tab-menu-row.is-current')).toContainText(
      'Следующая область',
    );
    await page.keyboard.press('Enter');
    expect(await area()).toBe('path');
    // `Tab` on the path's button goes on through the Chrome: the Tab menu is
    // the canvas's key, not the button's (06 §1.1).
    const focused = () => page.evaluate(() => document.activeElement?.outerHTML ?? '');
    const before = await focused();
    await page.keyboard.press('Tab');
    await expect(page.locator('.tab-menu')).toHaveCount(0);
    expect(await focused()).not.toBe(before);
  });

  test('a content window docks right, goes over the canvas and back, stays through a dive (06 §2.2, §13.1)', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.goto('/?plain');
    await createWorkspace(page, 'Окна');
    await createNode(page, 420, 300, 'Черновик');
    // Left of where the dock reaches once widened.
    await makeFolder(page, 'Архив', 320, 520);
    const win = page.locator('.note-window');
    const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThanOrEqual(1.5);
    // Ctrl+Enter: docked right, from the top to the bottom, left of the panel.
    await select(page, 'Черновик');
    await page.evaluate(() => window.__strataWs?.view.canvas.focus());
    await page.keyboard.press('Control+Enter');
    await expect(win).toHaveAttribute('data-mode', 'pinned');
    await expect(win.locator('.cm-content')).toBeFocused();
    const screen = await box(page, '.workspace');
    let w = await box(page, '.note-window');
    const panel = await box(page, '.ws-inspector');
    near(w.x + w.width, panel.x);
    near(w.y, screen.y);
    near(w.y + w.height, screen.y + screen.height);
    // Nothing chosen, the panel closes: the dock takes the screen's right edge.
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(page.locator('.workspace')).toHaveAttribute('data-panel', 'closed');
    w = await box(page, '.note-window');
    near(w.x + w.width, screen.x + screen.width);
    // Its edge dragged: wider, and the device keeps the width (05 §13); the
    // canvas keeps 320 px at least.
    const edge = await box(page, '.note-window .dock-edge');
    await page.mouse.move(edge.x + edge.width / 2, edge.y + 200);
    await page.mouse.down();
    await page.mouse.move(edge.x + edge.width / 2 - 100, edge.y + 200, { steps: 5 });
    await page.mouse.up();
    const wider = await box(page, '.note-window');
    near(wider.width, w.width + 100);
    near(wider.x + wider.width, screen.x + screen.width);
    await expect
      .poll(() => page.evaluate(() => Number(localStorage.getItem('strata.dock'))))
      .toBe(Math.round(wider.width));
    // The edge's arrows, 64 px a step with Shift, are the edge's: the canvas
    // does not pan with them (06 §1.1).
    const camera = () =>
      page.evaluate(() => {
        const c = window.__strataWs?.view.camera as unknown as { x: number; y: number };
        return { x: c.x, y: c.y };
      });
    const seen = await camera();
    await page.locator('.note-window .dock-edge').focus();
    await page.keyboard.press('Shift+ArrowLeft');
    near((await box(page, '.note-window')).width, wider.width + 64);
    expect(await camera()).toEqual(seen);
    await page.keyboard.press('Shift+ArrowRight');
    near((await box(page, '.note-window')).width, wider.width);
    // □: over the whole canvas, from «Ноды» to the edge; Esc — back docked.
    await win.getByRole('button', { name: 'На весь экран · Shift+Enter' }).click();
    await expect(win).toHaveAttribute('data-mode', 'full');
    w = await box(page, '.note-window');
    const layers = await box(page, '.ws-layers');
    near(w.x, layers.x + layers.width);
    near(w.x + w.width, screen.x + screen.width);
    await page.keyboard.press('Escape');
    await expect(win).toHaveAttribute('data-mode', 'pinned');
    // Bound to its node, not to the network: it stays through a dive.
    await enter(page, 'Архив');
    await expect(win).toHaveAttribute('data-mode', 'pinned');
    await expect(win.locator('h2')).toHaveText('Черновик');
    // ◎: back to its bubble — the network it lies in, chosen there.
    await win.getByRole('button', { name: 'Показать на холсте' }).click();
    await expect(page.locator('.workspace')).toHaveAttribute('data-depth', '1');
    await expect(page.locator('.ws-inspector .ins-title-name')).toHaveText('Черновик');
    // ▭ again: floating beside its bubble.
    await win.getByRole('button', { name: 'Открепить' }).click();
    await expect(win).toHaveAttribute('data-mode', 'float');
    await win.locator('.window-close').click();
    await expect(win).toHaveCount(0);
    // Shift+Enter: over the canvas at once.
    await select(page, 'Черновик');
    await page.evaluate(() => window.__strataWs?.view.canvas.focus());
    await page.keyboard.press('Shift+Enter');
    await expect(win).toHaveAttribute('data-mode', 'full');
    await win.getByRole('button', { name: 'Восстановить · Esc' }).click();
    await expect(win).toHaveAttribute('data-mode', 'float');
    // The dock holds one window: a board docked sends the note back to float.
    await win.getByRole('button', { name: 'Закрепить справа · Ctrl+Enter' }).click();
    await expect(win).toHaveAttribute('data-mode', 'pinned');
    await page.mouse.move(460, 600);
    await page.evaluate(() => window.__strataWs?.view.canvas.focus());
    await page.keyboard.press('Tab');
    await page.keyboard.type('доска');
    const kind = page.locator('.tab-menu-label', { hasText: /^(Доска|Board)$/ });
    await page.locator('.tab-menu-row', { has: kind }).first().click();
    await page.keyboard.type('Идеи');
    await page.keyboard.press('Enter');
    await settled(page);
    await select(page, 'Идеи');
    await page.evaluate(() => window.__strataWs?.view.canvas.focus());
    await page.keyboard.press('Control+Enter');
    await expect(page.locator('.board-window')).toHaveAttribute('data-mode', 'pinned');
    await expect(win).toHaveAttribute('data-mode', 'float');
  });

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
    // The WebView's own PDF viewer (WebView2, WKWebView): a frame.
    await page.addInitScript(() =>
      Object.defineProperty(Navigator.prototype, 'pdfViewerEnabled', { get: () => true }),
    );
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
    // As large as a board's window, not a place beside the bubble: 80 % of
    // the canvas one sees, between «Ноды» and the open properties panel.
    const layers = await box(page, '.ws-layers');
    const panel = await box(page, '.ws-inspector');
    const from = layers.x + layers.width;
    const room = panel.x - from;
    const w = await box(page, '.asset-window');
    expect(Math.abs(w.width - room * 0.8)).toBeLessThanOrEqual(2);
    expect(Math.abs(w.x - (from + room * 0.1))).toBeLessThanOrEqual(2);
    // The desktop's CSP, served by the preview too, let the media and the frame in.
    expect(blocked).toEqual([]);
  });

  test('where the WebView has no PDF viewer, pdf.js draws the pages (☑ Q-06-24)', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    // WebKitGTK and a browser without the viewer.
    await page.addInitScript(() =>
      Object.defineProperty(Navigator.prototype, 'pdfViewerEnabled', { get: () => false }),
    );
    await page.goto('/?plain');
    await createWorkspace(page, 'Сметы');
    const blocked: string[] = [];
    page.on('console', (m) => {
      if (/Content Security Policy|Refused to/i.test(m.text())) blocked.push(m.text());
    });
    const win = page.locator('.asset-window');
    const open = async (name: string) => {
      await settled(page);
      await select(page, name);
      await page.evaluate(() => window.__strataWs?.view.canvas.focus());
      await page.keyboard.press('Enter');
      await expect(win).toBeVisible();
    };
    await dropMade(page, 'pdf', 'Смета', 780, 300);
    await expect.poll(async () => (await graphNow(page)).names).toEqual(['Смета']);
    await open('Смета');
    await expect(win).toHaveAttribute('data-type', 'pdf');
    await expect(win.locator('iframe')).toHaveCount(0);
    // Both pages, each at the window's width, square as the sheet; drawn.
    const pages = win.locator('.pdf-page');
    await expect(pages).toHaveCount(2);
    await expect(pages.first()).toHaveAttribute('data-drawn', 'true', { timeout: 15_000 });
    const sheet = await box(page, '.pdf-page:first-child');
    expect(Math.abs(sheet.width - sheet.height)).toBeLessThanOrEqual(1);
    const view = await box(page, '.pdf-view');
    expect(sheet.width).toBeGreaterThan(view.width * 0.8);
    // The green square in the middle, white at the corner.
    const colour = (fx: number, fy: number) =>
      pages.first().evaluate(
        (c: HTMLCanvasElement, [fx, fy]) => {
          const px = c.getContext('2d')?.getImageData(c.width * fx, c.height * fy, 1, 1).data;
          return px ? ([px[0] ?? 0, px[1] ?? 0, px[2] ?? 0] as const) : null;
        },
        [fx, fy] as const,
      );
    const [r, g, b] = (await colour(0.5, 0.5)) ?? [0, 0, 0];
    expect(g).toBeGreaterThan(200);
    expect(r).toBeLessThan(g);
    expect(b).toBeLessThan(150);
    expect(await colour(0.02, 0.02)).toEqual([255, 255, 255]);
    // The keys scroll the pages once they have the focus; Esc gives them back.
    await win.locator('.pdf-view').focus();
    await page.keyboard.press('End');
    await expect(pages.last()).toHaveAttribute('data-drawn', 'true');
    await page.keyboard.press('Escape');
    await expect(page.locator('.proto-canvas canvas').first()).toBeFocused();
    await win.locator('.window-close').click();
    await expect(win).toHaveCount(0);
    // A file that is no PDF says so in the window, on one line.
    await dropMade(page, 'broken-pdf', 'Обрывок', 420, 300);
    await expect.poll(async () => (await graphNow(page)).names).toContain('Обрывок');
    await open('Обрывок');
    await expect(win.locator('.pdf-failed')).toHaveText('PDF не открылся');
    expect(await overflowing(page, '.asset-window')).toEqual([]);
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
    // The flight's target has its full card (08 §6.2): its name is said there, not twice.
    await expect(page.locator('.map-card.is-full .map-card-name')).toHaveText('Эскиз');
    await expect(page.locator('.proto-map-label:not(.is-hover)')).toBeHidden();
    // Enter on a note: its window over the map, the map stays (08 §6.3).
    await page.keyboard.press('Enter');
    await expect(page.locator('.note-window h2')).toHaveText('Эскиз');
    await expect(ws).toHaveAttribute('data-view', '3d');
    await page.locator('.note-window .window-close').click();
    await expect(page.locator('.note-window')).toHaveCount(0);
    // M with the star selected: back in 2D, in «Арт», with «Эскиз» selected.
    await page.keyboard.press('KeyM');
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
    // The right button on the bare canvas: the three styles, the one the
    // wires have ticked, Shift+S by the one after it.
    await page.mouse.click(640, 400, { button: 'right' });
    const style = (name: string) => page.getByRole('menuitemradio', { name });
    await expect(style('Кинетические нити')).toHaveAttribute('aria-checked', 'true');
    await expect(style('Нити Безье')).toHaveAttribute('aria-checked', 'false');
    await expect(style('Прямые нити')).toContainText('Shift+S');
    await style('Прямые нити').click();
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

  test('the flag ring: rest on a bubble, click a slot, i keeps the card; Ctrl hides it (06 §8)', async ({
    page,
  }) => {
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
          slot: s.slot,
          x: s.x + (r?.left ?? 0),
          y: s.y + (r?.top ?? 0),
        }));
      });
    const p = await at(page, 'Узел');
    await page.mouse.move(p.x, p.y);
    // It comes after the cursor has rested (07 §4.5): ★ ‖ the stencil, then i.
    await expect
      .poll(async () => (await slots()).map((s) => s.slot))
      .toEqual(['key', 'pause', 'template', 'info']);
    const pause = (await slots()).find((s) => s.slot === 'pause');
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
    await expect.poll(async () => (await slots()).length).toBe(4);
    // i: the bubble's info card kept, as Shift+I (06 §4.4), till its ×.
    const info = (await slots()).find((s) => s.slot === 'info');
    if (!info) throw new Error('no i slot');
    await page.mouse.move(info.x, info.y, { steps: 4 });
    await page.mouse.click(info.x, info.y);
    const card = page.locator('.ws-info-card');
    await expect(card).toHaveClass(/is-kept/);
    await expect(card.locator('.map-card-name')).toHaveText('Узел');
    await card.locator('.window-close').click();
    await expect(card).toHaveCount(0);
    await page.mouse.move(p.x, p.y, { steps: 4 });
    await expect.poll(async () => (await slots()).length).toBe(4);
    // Away from the bubble and its ring: gone.
    await page.mouse.move(p.x + 300, p.y + 200, { steps: 4 });
    await expect.poll(async () => (await slots()).length).toBe(0);
    // «Настройки»: never.
    await page.locator('.tabbar-settings').click();
    await page.locator('.settings').getByLabel('Кольцо флагов').selectOption('never');
    await page.locator('.tabbar-settings').click();
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
    // The lens follows the count's render: an effect after it (WebKit under load).
    await expect.poll(lens).toEqual(['Аниматик', 'Анимация удара']);
    await field.fill('аним* @задача');
    await expect(bar.locator('.find-count')).toHaveText('0 из 1');
    await field.press('ArrowDown');
    await expect(bar.locator('.find-count')).toHaveText('1 из 1');
    expect(await selected()).toEqual(['Анимация удара']);
    // Esc: the selection as it was, nothing dimmed.
    await field.press('Escape');
    await expect(bar).toHaveCount(0);
    expect(await selected()).toEqual(['Звук']);
    await expect.poll(lens).toBeNull();
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

  test("the palette: «/» goes on as a path, «?» opens the keys, «Все команды» shows the rest grey, the bar's steps run (09 §3.5)", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.goto('/?plain');
    await createWorkspace(page, 'Префиксы');
    await makeFolder(page, 'Архив', 520, 320);
    await page.mouse.click(400, 650);
    const palette = page.locator('.command-palette');
    const input = palette.locator('.palette-query');
    // `/`: `Ctrl+O`'s path mode takes the query on, typed on from its end.
    await page.evaluate(() => window.__strataWs?.view.canvas.focus());
    await page.keyboard.press('Control+p');
    await page.keyboard.type('/');
    await expect(palette).toHaveCount(0);
    const goto = page.locator('.node-search.goto');
    const query = goto.locator('input');
    await expect(query).toBeFocused();
    await expect(query).toHaveValue('/');
    await page.keyboard.type('Архив');
    await expect(query).toHaveValue('/Архив');
    await expect(goto.locator('.tab-menu-row.is-current .tab-menu-label')).toHaveText('Архив');
    await page.keyboard.press('Enter');
    await expect(goto).toHaveCount(0);
    const archive = await idOf(page, 'Архив');
    await expect
      .poll(() => page.evaluate(() => window.__strataWs?.editor()?.selected))
      .toEqual([archive]);
    // `?`: «Клавиши».
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+p');
    await page.keyboard.type('?');
    await expect(palette).toHaveCount(0);
    await expect(page.locator('.help-window')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.help-window')).toHaveCount(0);
    // Nothing chosen: no «Удалить»; «Все команды» shows it grey, why in its tooltip.
    await page.evaluate(() => window.__strataWs?.view.canvas.focus());
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+p');
    await input.fill('удалить');
    await expect(palette.locator('.tab-menu-empty')).toBeVisible();
    const all = palette.locator('.palette-all');
    await all.click();
    await expect(all.locator('input')).toBeChecked();
    await expect(input).toBeFocused();
    const grey = palette.locator('.tab-menu-row.is-unavailable').first();
    await expect(grey).toBeVisible();
    await expect(grey.locator('.tab-menu-label')).toHaveAttribute('title', /Ничего не выделено/);
    await expect(grey).toHaveAttribute('aria-disabled', 'true');
    // A grey row does not run: the palette stays.
    await input.press('Enter');
    await expect(palette).toBeVisible();
    // The choice stays on the device.
    await input.press('Escape');
    await page.keyboard.press('Control+p');
    await expect(all.locator('input')).toBeChecked();
    await all.click();
    await expect(all.locator('input')).not.toBeChecked();
    // The tab bar's steps: «Настройки» from the palette.
    await input.fill('настройки');
    await expect(palette.locator('.tab-menu-row.is-current .tab-menu-label')).toHaveText(
      'Настройки',
    );
    await input.press('Enter');
    await expect(palette).toHaveCount(0);
    await expect(page.locator('.settings')).toBeVisible();
  });

  test('Ctrl+P runs a command found in either language; the last ones come first (09 §3.5)', async ({
    page,
  }) => {
    await page.goto('/?plain');
    await createWorkspace(page, 'Палитра');
    await createNode(page, 500, 360, 'Север');
    const palette = page.locator('.command-palette');
    const input = palette.locator('.palette-query');
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

  test('Ctrl+F on the star map lights the matches in the cluster in focus (08 §6.1)', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.goto('/?plain');
    await createWorkspace(page, 'Линза');
    const ws = page.locator('.workspace');
    await createNode(page, 480, 300, 'Эскиз леса');
    await createNode(page, 760, 300, 'Эскиз реки');
    await createNode(page, 620, 500, 'Идея');
    await settled(page);
    await page.evaluate(() => window.__strataWs?.view.canvas.focus());
    await page.keyboard.press('KeyM');
    await expect(ws).toHaveAttribute('data-view', '3d', { timeout: 30_000 });
    const map = () =>
      page.evaluate(() => {
        const m = window.__strataWs?.map();
        return {
          lens: m?.lensIds()?.sort() ?? null,
          selected: m?.selectedId() ?? null,
          forest: m?.idNamed('Эскиз леса') ?? null,
          river: m?.idNamed('Эскиз реки') ?? null,
        };
      });
    const { forest, river } = await map();
    await page.keyboard.press('Control+f');
    const bar = page.locator('.find-bar');
    const input = bar.locator('input');
    await expect(input).toBeFocused();
    // The map shows every depth: «Aa» only, no «поддерево».
    await expect(bar.locator('.find-toggle')).toHaveCount(1);
    await input.fill('эскиз');
    await expect(bar.locator('.find-count')).toHaveText('0 из 2');
    await expect.poll(async () => (await map()).lens).toEqual([forest, river].sort());
    // Ctrl+G flies to one and selects it, again — to the other.
    await input.press('Control+g');
    await expect(bar.locator('.find-count')).toHaveText('1 из 2');
    await expect.poll(async () => (await map()).selected).not.toBeNull();
    const first = (await map()).selected;
    await input.press('Control+g');
    await expect.poll(async () => (await map()).selected).not.toBe(first);
    expect([forest, river]).toContain((await map()).selected);
    // Esc: the lens goes, the choice of before comes back.
    await input.press('Escape');
    await expect(bar).toHaveCount(0);
    // The lens goes with the bar's effects, after the bar has left the page.
    await expect.poll(map).toMatchObject({ lens: null, selected: null });
    // Enter keeps the star found, the map in 3D.
    await page.keyboard.press('Control+f');
    await input.fill('реки');
    await expect(bar.locator('.find-count')).toHaveText('0 из 1');
    await input.press('Enter');
    await expect(bar).toHaveCount(0);
    await expect.poll(async () => (await map()).selected).toBe(river);
    await expect.poll(async () => (await map()).lens).toBeNull();
    await expect(ws).toHaveAttribute('data-view', '3d');
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

  test('«↗N» lists the wires that leave the network; the folder gets a roll-up wire (05 §8.3, 06 §13.3, §14)', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.goto('/?plain');
    await createWorkspace(page, 'Связи');
    const idea = await linkedAway(page);
    const art = await idOf(page, 'Арт');
    // The roll-up: «Идея» — «Арт» ×1, a view only, no wire of the graph.
    await expect
      .poll(() => page.evaluate(() => window.__strataWs?.graph()?.rollups.map((r) => r.count)))
      .toEqual([1]);
    const rolled = await page.evaluate(() => window.__strataWs?.graph()?.rollups[0]);
    expect([rolled?.a, rolled?.b].sort()).toEqual([idea, art].sort());
    expect((await graphNow(page)).edges).toEqual([]);
    // A click on «↗1»: the list, the node chosen; the row — «Эскиз», «Арт», from text.
    await openExternal(page, idea);
    const list = page.locator('.ext-list');
    await expect(list).toHaveAttribute('aria-label', 'Внешние связи «Идея»');
    const row = list.locator('.tab-menu-row');
    await expect(row.locator('.tab-menu-label')).toHaveText('Эскиз');
    await expect(row.locator('.ext-path')).toHaveText('Арт');
    await expect(row.locator('.ext-origin')).toHaveText('из текста');
    await expect(row.locator('.ext-way')).toHaveAttribute('title', 'Нить выходит из «Идея»');
    await expect(page.locator('.ws-inspector .ins-title-name')).toHaveText('Идея');
    // Beside the bubble, left of the panel: with no room right of the mark, on its left.
    const shown = await box(page, '.ext-list');
    const panel = await box(page, '.ws-inspector');
    expect(shown.x + shown.width).toBeLessThanOrEqual(panel.x);
    const bubble = await at(page, 'Идея');
    expect(shown.x + shown.width < bubble.x || shown.x > bubble.x, 'clear of the bubble').toBe(
      true,
    );
    // Esc closes it, the node stays chosen; Enter on the row goes to «Эскиз»
    // in «Арт». The list's keys are its own: the canvas neither clears the
    // choice nor opens «Идея» (06 §1.1).
    await page.keyboard.press('Escape');
    await expect(list).toHaveCount(0);
    await expect(page.locator('.ws-inspector .ins-title-name')).toHaveText('Идея');
    await openExternal(page, idea);
    await page.keyboard.press('Enter');
    await expect(list).toHaveCount(0);
    const ws = page.locator('.workspace');
    await expect(ws).toHaveAttribute('data-depth', '2');
    const sketch = await idOf(page, 'Эскиз');
    await expect
      .poll(() => page.evaluate(() => window.__strataWs?.editor()?.selected))
      .toEqual([sketch]);
    await expect(page.locator('.note-window')).toHaveCount(0);
    // Inside «Арт», «Эскиз» has its «↗1» too: «Идея» is not placed here.
    await expect
      .poll(() =>
        page.evaluate((id) => window.__strataWs?.graph()?.nodes.get(id)?.external, sketch),
      )
      .toBe(1);
    await openExternal(page, sketch);
    await expect(list.locator('.ext-way')).toHaveAttribute('title', 'Нить входит в «Эскиз»');
    // At the root: the root by its name.
    await expect(list.locator('.ext-path')).toHaveText('Связи');
  });

  test('«Показать здесь» places the other end beside the node; «Показать все здесь» asks past ten (06 §14)', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.goto('/?plain');
    await createWorkspace(page, 'Связи');
    const ws = page.locator('.workspace');
    const idea = await linkedAway(page);
    const sketch = await idOf(page, 'Эскиз').catch(() => null);
    expect(sketch, '«Эскиз» lies in «Арт», not here').toBeNull();
    // The row's shortcut: an appearance of «Эскиз» below «Идея», the wire shows.
    await openExternal(page, idea);
    const list = page.locator('.ext-list');
    const show = list.getByRole('button', { name: 'Показать здесь «Эскиз» (Alt+Enter)' });
    await expect(list.locator('.ext-footer'), 'one end: no «Показать все»').toHaveCount(0);
    await show.click();
    await expect(list).toHaveCount(0);
    await expect(ws).toHaveAttribute('data-nodes', '3');
    expect((await graphNow(page)).edges).toEqual(['Идея→Эскиз']);
    const placed = await idOf(page, 'Эскиз');
    await expect.poll(() => placement(page, placed)).toEqual({ appearance: true, places: 2 });
    const [from, to] = [await at(page, 'Идея'), await at(page, 'Эскиз')];
    expect(to.y, 'an output goes below').toBeGreaterThan(from.y);
    await expect
      .poll(() => page.evaluate((id) => window.__strataWs?.graph()?.nodes.get(id)?.external, idea))
      .toBe(0);
    // One step: undo takes it away; `Alt+Enter` on the row shows it again.
    await page.evaluate(() => window.__strataWs?.view.canvas.focus());
    await page.keyboard.press('Control+z');
    await expect(ws).toHaveAttribute('data-nodes', '2');
    await openExternal(page, idea);
    await page.keyboard.press('Alt+Enter');
    await expect(ws).toHaveAttribute('data-nodes', '3');
  });

  test('«Показать здесь» offers no network this one lies inside (05 §5 rule 4, 06 §14)', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.goto('/?plain');
    await createWorkspace(page, 'Связи');
    const ws = page.locator('.workspace');
    await linkedAway(page);
    // Inside «Арт», «Эскиз» links back to «Арт» itself.
    await select(page, 'Арт');
    await page.evaluate(() => window.__strataWs?.view.canvas.focus());
    await page.keyboard.press('Enter');
    await expect(ws).toHaveAttribute('data-depth', '2');
    await select(page, 'Эскиз');
    await page.keyboard.press('Enter');
    const editor = page.locator('.note-window .cm-content');
    await expect(editor).toBeVisible();
    await editor.click();
    await page.keyboard.type('Для [[Арт]]', { delay: 20 });
    await page.locator('.note-window .window-close').click();
    const sketch = await idOf(page, 'Эскиз');
    await expect
      .poll(() =>
        page.evaluate((id) => window.__strataWs?.graph()?.nodes.get(id)?.external, sketch),
      )
      .toBe(2);
    await openExternal(page, sketch, 2);
    const list = page.locator('.ext-list');
    // «Арт» would lie in itself: its shortcut is off and says why; one end left, no «Показать все».
    const art = list.locator('.tab-menu-row', { hasText: 'Арт' }).locator('.ext-show');
    await expect(art).toBeDisabled();
    await expect(art).toHaveAttribute('title', '«Арт» не положить сюда: эта сеть лежит внутри неё');
    await expect(list.locator('.ext-footer')).toHaveCount(0);
    await list.getByRole('button', { name: 'Показать здесь «Идея» (Alt+Enter)' }).click();
    await expect(list).toHaveCount(0);
    await expect.poll(async () => (await graphNow(page)).names).toEqual(['Идея', 'Эскиз']);
  });

  test('Z: the icon palette finds a preset in either language and gives it in one step (07 §6.3, ☑ Q-07-21)', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.goto('/?plain');
    await createWorkspace(page, 'Иконки');
    await createNode(page, 460, 300, 'Карта');
    await createNode(page, 700, 420, 'План');
    const [map, plan] = [await idOf(page, 'Карта'), await idOf(page, 'План')];
    await settled(page);
    expect(await iconState(page, map)).toEqual({ shows: 'kind', icon: null, core: null });
    // At the node under the cursor: every preset, the first one's author below.
    await select(page, 'Карта');
    await page.keyboard.press('KeyZ');
    const palette = page.locator('.icon-palette');
    await expect(palette).toBeVisible();
    await expect(palette.locator('.icon-cell')).toHaveCount(200);
    await expect(palette.locator('.icon-palette-by')).toHaveText(
      'Открытая книга · © Lorc, CC BY 3.0',
    );
    await expect(palette.getByRole('button', { name: 'Значок вида' })).toBeDisabled();
    // By a word in Russian: Enter gives it, the kind's glyph is the body no more.
    await page.keyboard.type('компас');
    const compass = palette.locator('.icon-cell[data-icon="lorc/compass"]');
    await expect(compass).toHaveClass(/is-current/);
    await expect(palette.locator('.icon-palette-by')).toHaveText('Компас · © Lorc, CC BY 3.0');
    await page.keyboard.press('Enter');
    await expect(palette).toHaveCount(0);
    await expect
      .poll(() => iconState(page, map))
      .toEqual({
        shows: 'preset',
        icon: 'game-icons/lorc/compass',
        core: 'game-icons/lorc/compass',
      });
    // One step of undo.
    await page.keyboard.press('Control+z');
    await expect
      .poll(() => iconState(page, map))
      .toEqual({ shows: 'kind', icon: null, core: null });
    // Both nodes, by a word in English; the arrows move along the grid.
    await page.evaluate(() => window.__strataWs?.view.canvas.focus());
    await page.keyboard.press('Control+a');
    await page.keyboard.press('KeyZ');
    await page.keyboard.type('owl');
    await expect(palette.locator('.icon-cell').first()).toHaveAttribute('data-icon', 'lorc/owl');
    await page.keyboard.press('Enter');
    for (const id of [map, plan]) {
      await expect.poll(async () => (await iconState(page, id)).core).toBe('game-icons/lorc/owl');
    }
    // A node's own preset is pressed in and under the keys; «Значок вида» takes it back.
    await select(page, 'План');
    await page.keyboard.press('KeyZ');
    const owl = palette.locator('.icon-cell[data-icon="lorc/owl"]');
    await expect(owl).toHaveClass(/is-chosen/);
    await expect(owl).toHaveClass(/is-current/);
    await page.keyboard.press('ArrowRight');
    await expect(owl).not.toHaveClass(/is-current/);
    await palette.getByRole('button', { name: 'Значок вида' }).click();
    await expect(palette).toHaveCount(0);
    await expect
      .poll(() => iconState(page, plan))
      .toEqual({ shows: 'kind', icon: null, core: null });
    expect((await iconState(page, map)).core).toBe('game-icons/lorc/owl');
    // Esc takes nothing; nothing found says so.
    await select(page, 'Карта');
    await page.keyboard.press('KeyZ');
    await page.keyboard.type('щщщщ');
    await expect(palette.locator('.icon-none')).toHaveText('Ничего не найдено');
    await page.keyboard.press('Escape');
    await expect(palette).toHaveCount(0);
    expect((await iconState(page, map)).core).toBe('game-icons/lorc/owl');
  });

  test("Z: one's own icon from the disk, brought to the canvas's style in one step (07 §6.4–6.6)", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.goto('/?plain');
    await createWorkspace(page, 'Свои иконки');
    await createNode(page, 460, 300, 'Карта');
    const map = await idOf(page, 'Карта');
    await settled(page);
    // A dark figure on white: «Гравюра» floods the white from the corners.
    const png = await page.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 96;
      c.height = 96;
      const g = c.getContext('2d') as CanvasRenderingContext2D;
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, 96, 96);
      g.fillStyle = '#202020';
      g.beginPath();
      g.arc(48, 48, 30, 0, Math.PI * 2);
      g.fill();
      return c.toDataURL('image/png').split(',')[1] ?? '';
    });
    await select(page, 'Карта');
    await page.keyboard.press('KeyZ');
    const palette = page.locator('.icon-palette');
    const own = palette.getByRole('button', { name: 'Своя иконка…' });
    await expect(own).toHaveAttribute('aria-pressed', 'false');
    // A file that is no picture says so and gives nothing.
    let chooser = page.waitForEvent('filechooser');
    await own.click();
    await (await chooser).setFiles({
      name: 'заметки.png',
      mimeType: 'image/png',
      buffer: Buffer.from('не картинка'),
    });
    await expect(
      page.locator('.toast', { hasText: 'Картинку «заметки.png» не прочитать' }),
    ).toBeVisible();
    const dialog = page.locator('.own-icon-dialog');
    await expect(dialog).toHaveCount(0);
    // A picture: the dialog, «Гравюра» by default (☑ Q-05-7) with Otsu's threshold.
    await select(page, 'Карта');
    await page.keyboard.press('KeyZ');
    chooser = page.waitForEvent('filechooser');
    await own.click();
    await (await chooser).setFiles({
      name: 'компас.png',
      mimeType: 'image/png',
      buffer: Buffer.from(png, 'base64'),
    });
    await expect(palette).toHaveCount(0);
    await expect(dialog.locator('h2')).toHaveText('Своя иконка');
    const mode = (name: string) => dialog.getByRole('button', { name, exact: true });
    const auto = dialog.getByRole('checkbox', { name: 'Авто' });
    const slider = dialog.getByRole('slider', { name: 'Порог' });
    await expect(mode('Гравюра')).toHaveAttribute('aria-pressed', 'true');
    await expect(auto).toBeChecked();
    await expect(slider).toBeDisabled();
    await expect(dialog.locator('.own-bubble')).toHaveCount(3);
    await expect(dialog.locator('.own-original')).toHaveAttribute('title', 'компас.png');
    // Nothing is given before «Готово».
    expect((await iconState(page, map)).core).toBeNull();
    await dialog.getByRole('button', { name: 'Готово' }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await iconState(page, map)).shows).toBe('own');
    const first = (await iconState(page, map)).core ?? '';
    expect(first).toMatch(/^asset\/[0-9a-f]{64}\/engraving$/);
    const sha = first.split('/')[1];
    // One step of undo, one of redo.
    await page.keyboard.press('Control+z');
    await expect
      .poll(() => iconState(page, map))
      .toEqual({ shows: 'kind', icon: null, core: null });
    await page.keyboard.press('Control+Shift+z');
    await expect
      .poll(() => iconState(page, map))
      .toEqual({ shows: 'own', icon: first, core: first });
    // The node's own icon is pressed in, and the button restyles it from the stored original.
    await page.keyboard.press('KeyZ');
    await expect(own).toHaveAttribute('aria-pressed', 'true');
    await own.click();
    await expect(dialog.locator('.own-original')).toHaveAttribute('src', /^blob:/);
    await mode('Пиксель').click();
    await expect(mode('Пиксель')).toHaveAttribute('aria-pressed', 'true');
    await expect(mode('Гравюра')).toHaveAttribute('aria-pressed', 'false');
    await auto.uncheck();
    await expect(slider).toBeEnabled();
    await slider.fill('90');
    await dialog.getByRole('checkbox', { name: 'Инвертировать' }).check();
    // Enter outside the buttons is «Готово».
    await slider.focus();
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);
    await expect
      .poll(() => iconState(page, map))
      .toEqual({
        shows: 'own',
        icon: `asset/${sha}/pixel/t90/i`,
        core: `asset/${sha}/pixel/t90/i`,
      });
    // «Силуэт» has no threshold; Esc takes nothing.
    await page.keyboard.press('KeyZ');
    await own.click();
    await mode('Силуэт').click();
    await expect(auto).toBeDisabled();
    await expect(slider).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    expect((await iconState(page, map)).core).toBe(`asset/${sha}/pixel/t90/i`);
    // «Значок вида» takes it back.
    await select(page, 'Карта');
    await page.keyboard.press('KeyZ');
    await palette.getByRole('button', { name: 'Значок вида' }).click();
    await expect
      .poll(() => iconState(page, map))
      .toEqual({ shows: 'kind', icon: null, core: null });
    await page.keyboard.press('Control+z');
    await expect.poll(async () => (await iconState(page, map)).shows).toBe('own');
    // It comes back with the workspace: the mask is made again from the original.
    await page.reload();
    await page.locator('.home-open').click();
    await page.waitForFunction(() => window.__strataWs?.graph() != null);
    await expect
      .poll(() => iconState(page, map))
      .toEqual({
        shows: 'own',
        icon: `asset/${sha}/pixel/t90/i`,
        core: `asset/${sha}/pixel/t90/i`,
      });
  });

  test('Z: a bubble takes a size by hand here and the rules back, one step each (06 §4.2)', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.goto('/?plain');
    await createWorkspace(page, 'Размеры');
    await createNode(page, 460, 300, 'Карта');
    await createNode(page, 760, 420, 'План');
    const [map, plan] = [await idOf(page, 'Карта'), await idOf(page, 'План')];
    // By the rules a note is S: 32, the radius 16.
    expect(await sizeState(page, map)).toEqual({ r: 16, size: null, core: null });
    await select(page, 'Карта');
    await page.keyboard.press('KeyZ');
    const palette = page.locator('.icon-palette');
    const choice = (name: string) =>
      palette.locator('.icon-size').getByRole('button', { name, exact: true });
    await expect(choice('Авто')).toHaveAttribute('aria-pressed', 'true');
    await expect(choice('L')).toHaveAttribute('aria-pressed', 'false');
    await expect(choice('L')).toHaveAttribute('title', 'Крупный — 72');
    await choice('L').click();
    await expect(palette).toHaveCount(0);
    await expect.poll(() => sizeState(page, map)).toEqual({ r: 36, size: 'l', core: 'l' });
    // The node's own is pressed in next time.
    await page.keyboard.press('KeyZ');
    await expect(choice('L')).toHaveAttribute('aria-pressed', 'true');
    await expect(choice('Авто')).toHaveAttribute('aria-pressed', 'false');
    await page.keyboard.press('Escape');
    // One step of undo.
    await page.keyboard.press('Control+z');
    await expect.poll(() => sizeState(page, map)).toEqual({ r: 16, size: null, core: null });
    // Both, by the menu's «Иконка и размер…»; «Авто» takes one back.
    await page.evaluate(() => window.__strataWs?.view.canvas.focus());
    await page.keyboard.press('Control+a');
    const p = await at(page, 'План');
    await page.mouse.click(p.x, p.y, { button: 'right' });
    await page.getByRole('menuitem', { name: 'Иконка и размер…' }).click();
    await choice('XL').click();
    for (const id of [map, plan]) {
      await expect.poll(() => sizeState(page, id)).toEqual({ r: 54, size: 'xl', core: 'xl' });
    }
    await select(page, 'План');
    await page.keyboard.press('KeyZ');
    await choice('Авто').click();
    await expect.poll(() => sizeState(page, plan)).toEqual({ r: 16, size: null, core: null });
    expect((await sizeState(page, map)).core).toBe('xl');
    // A copy keeps its size, `Ctrl+D` and `Alt`+drag alike (06 §12.1).
    await select(page, 'Карта');
    await page.evaluate(() => window.__strataWs?.view.canvas.focus());
    await page.keyboard.press('Control+d');
    await expect(page.locator('.workspace')).toHaveAttribute('data-nodes', '3');
    const copies = () =>
      page.evaluate(async (orig) => {
        const ws = window.__strataWs as WsHook;
        await ws.settled();
        const view = await ws.core.view(ws.net());
        return view.nodes
          .filter((n) => n.name === 'Карта' && n.id !== orig)
          .map((n) => n.size ?? null);
      }, map);
    await expect.poll(copies).toEqual(['xl']);
    const from = await at(page, 'План');
    await page.keyboard.down('Alt');
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 8, from.y + 8, { steps: 2 });
    await page.mouse.move(from.x + 200, from.y + 120, { steps: 8 });
    await page.mouse.up();
    await page.keyboard.up('Alt');
    await expect(page.locator('.workspace')).toHaveAttribute('data-nodes', '4');
    await expect
      .poll(async () => (await graphNow(page)).names.filter((n) => n === 'План').length)
      .toBe(2);
  });

  test("a board's [[links]] are its wires and ghosts; a rename rewrites them (13 §2.8, §6.5)", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.goto('/?plain');
    await createWorkspace(page, 'Доски');
    await createNode(page, 760, 520, 'Цель');
    // A board through the Tab menu, named at once.
    await page.mouse.move(460, 300);
    await page.keyboard.press('Tab');
    await page.keyboard.type('доска');
    const kind = page.locator('.tab-menu-label', { hasText: /^(Доска|Board)$/ });
    await page.locator('.tab-menu-row', { has: kind }).first().click();
    await page.keyboard.type('Идеи');
    await page.keyboard.press('Enter');
    await expect(page.locator('.workspace')).toHaveAttribute('data-nodes', '2');
    await settled(page);
    await select(page, 'Идеи');
    await page.evaluate(() => window.__strataWs?.view.canvas.focus());
    await page.keyboard.press('Enter');
    const win = page.locator('.board-window');
    await expect(win.locator('.excalidraw')).toBeVisible({ timeout: 30_000 });
    // Text on the board: its links are wires and ghosts as a note's are.
    await win.locator('.board-tools label', { has: page.locator('input[value="text"]') }).click();
    const stage = await box(page, '.board-stage');
    await page.mouse.click(stage.x + stage.width * 0.4, stage.y + stage.height * 0.4);
    await expect(win.locator('textarea')).toBeFocused();
    await page.keyboard.type('См. [[Цель]] и [[Нигде]]');
    await page.keyboard.press('Escape');
    await expect
      .poll(async () => (await graphNow(page)).edges, { timeout: 15_000 })
      .toContain('Идеи→Цель');
    await expect
      .poll(() =>
        page.evaluate(() =>
          [...(window.__strataWs?.graph()?.nodes.values() ?? [])]
            .filter((n) => n.ghostOf !== null)
            .map((n) => n.name),
        ),
      )
      .toEqual(['Нигде']);
    // A rename says the new name on the open board, the wire kept.
    const goal = await idOf(page, 'Цель');
    await page.evaluate((id) => {
      window.__strataWs
        ?.graph()
        ?.transaction({ key: 't.rename' }, (tx) =>
          (tx as { rename(id: string, name: string): void }).rename(id, 'Миссия'),
        );
    }, goal);
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              window.__strataWs?.board
                ?.elements()
                .filter((e) => e.type === 'text')
                .map((e) => e.originalText ?? e.text) ?? [],
          ),
        { timeout: 15_000 },
      )
      .toEqual(['См. [[Миссия]] и [[Нигде]]']);
    await expect.poll(async () => (await graphNow(page)).edges).toContain('Идеи→Миссия');
  });

  test('eight wires seen here make a bubble a step larger (06 §4.2)', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/?plain');
    await createWorkspace(page, 'Узлы');
    // With nothing chosen a node goes under the cursor (each `createNode`
    // ends with Esc): a chosen node would make it a child, placed beside
    // the last one (06 §5.4), the camera following it under the panel.
    await createNode(page, 480, 220, 'Узел');
    for (let i = 0; i < 8; i++) {
      await createNode(page, 340 + 80 * (i % 4), i < 4 ? 420 : 520, `Н${i + 1}`);
    }
    const hub = await idOf(page, 'Узел');
    const radius = () =>
      page.evaluate(async (id) => {
        const ws = window.__strataWs as WsHook;
        await ws.settled();
        return ws.view.nodeAt(id)?.r ?? null;
      }, hub);
    const wire = (to: string) =>
      page.evaluate(
        ([from, to]) => {
          window.__strataWs
            ?.graph()
            ?.transaction({ key: 't.wire' }, (tx) =>
              (tx as { connect(a: string, b: string): boolean }).connect(from, to),
            );
        },
        [hub, to] as const,
      );
    for (let i = 1; i <= 7; i++) await wire(await idOf(page, `Н${i}`));
    expect(await radius(), 'seven wires: S').toBe(16);
    await wire(await idOf(page, 'Н8'));
    expect((await graphNow(page)).edges.filter((e) => e.startsWith('Узел→'))).toHaveLength(8);
    await expect.poll(radius).toBe(24);
    // One step of undo takes the eighth wire away, and the bubble back to S.
    await page.evaluate(() => window.__strataWs?.view.canvas.focus());
    await page.keyboard.press('Control+z');
    await expect.poll(radius).toBe(16);
  });

  test('two clicks with a key between them are two clicks, not a double click (06 §5)', async ({
    page,
  }) => {
    await page.goto('/?plain');
    await createWorkspace(page, 'Клики');
    await createNode(page, 460, 300, 'Идея');
    const p = await at(page, 'Идея');
    // At once, as fast as a double click: the key between makes them two.
    await page.mouse.click(p.x, p.y);
    await page.keyboard.press('Escape');
    await page.mouse.click(p.x, p.y);
    await expect(page.locator('.ws-inspector .ins-title-name')).toHaveText('Идея');
    await expect(page.locator('.note-window')).toHaveCount(0);
    // A double click still opens the note.
    await page.mouse.dblclick(p.x, p.y);
    await expect(page.locator('.note-window')).toBeVisible();
  });

  test('Alt+drag copies in the core: the copy keeps its fields and size after a reload (06 §12.1)', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.goto('/?plain');
    await createWorkspace(page, 'Копии');
    await createNode(page, 460, 300, 'Эскиз');
    const sketch = await idOf(page, 'Эскиз');
    await select(page, 'Эскиз');
    await page.keyboard.press('KeyZ');
    await page.locator('.icon-size').getByRole('button', { name: 'L', exact: true }).click();
    await expect.poll(() => sizeState(page, sketch)).toEqual({ r: 36, size: 'l', core: 'l' });
    await page.evaluate(() => window.__strataWs?.view.canvas.focus());
    await page.keyboard.press('KeyQ');
    const ws = page.locator('.workspace');
    const altDrag = async () => {
      const from = await at(page, 'Эскиз');
      await page.keyboard.down('Alt');
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(from.x + 8, from.y + 8, { steps: 2 });
      await page.mouse.move(from.x + 240, from.y + 160, { steps: 8 });
      await page.mouse.up();
      await page.keyboard.up('Alt');
      await expect(ws).toHaveAttribute('data-nodes', '2');
      await settled(page);
    };
    // One step of undo takes the copy back whole, the drag with it.
    await altDrag();
    await page.keyboard.press('Control+z');
    await expect(ws).toHaveAttribute('data-nodes', '1');
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const w = window.__strataWs as WsHook;
          await w.settled();
          return (await w.core.view(w.net())).nodes.length;
        }),
      )
      .toBe(1);
    await select(page, 'Эскиз');
    await altDrag();
    const copy = await page.evaluate((orig) => {
      const g = window.__strataWs?.graph();
      return [...(g?.nodes.values() ?? [])].find((n) => n.name === 'Эскиз' && n.id !== orig)?.id;
    }, sketch);
    if (!copy) throw new Error('no copy');
    await expect.poll(() => sizeState(page, copy)).toEqual({ r: 36, size: 'l', core: 'l' });
    // The network read again from the core: the copy is still paused and large.
    await page.reload();
    await expect(page.locator('.home-card')).toHaveCount(1);
    await page.locator('.home-open').click();
    await page.waitForFunction((id) => window.__strataWs?.graph()?.nodes.has(id) ?? false, copy);
    await expect.poll(() => sizeState(page, copy)).toEqual({ r: 36, size: 'l', core: 'l' });
    expect(
      await page.evaluate((id) => window.__strataWs?.graph()?.nodes.get(id)?.pause, copy),
    ).toBe(true);
  });

  test('«Показать все здесь» asks first past ten nodes (06 §14)', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/?plain');
    await createWorkspace(page, 'Связи');
    const ws = page.locator('.workspace');
    const idea = await linkedAway(page, ELEVEN);
    await openExternal(page, idea, 12);
    const list = page.locator('.ext-list');
    await list.getByRole('button', { name: 'Показать все здесь' }).click();
    await expect(list.locator('.ext-ask')).toHaveText('Показать здесь 12 нод?');
    // «Отмена» takes the question back, nothing is shown.
    await list.getByRole('button', { name: 'Отмена' }).click();
    await expect(list.locator('.ext-ask')).toHaveCount(0);
    await expect(ws).toHaveAttribute('data-nodes', '2');
    await list.getByRole('button', { name: 'Показать все здесь' }).click();
    await list.getByRole('button', { name: 'Показать', exact: true }).click();
    await expect(list).toHaveCount(0);
    await expect(ws).toHaveAttribute('data-nodes', '14');
    // Never on each other: every two bubbles apart.
    const spots = await page.evaluate(() =>
      [...(window.__strataWs?.graph()?.nodes.values() ?? [])].map((n) => [n.x, n.y] as const),
    );
    for (const [i, a] of spots.entries()) {
      for (const b of spots.slice(i + 1)) {
        expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeGreaterThan(40);
      }
    }
  });

  test('an appearance: Tab places a node of another network, the panel says where it lies (05 §5, 06 §12.2)', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.goto('/?plain');
    await createWorkspace(page, 'Карта');
    const ws = page.locator('.workspace');
    const refs = await appearing(page);
    // A click in the middle of the bubble selects it: its marks' targets stop
    // short of it (owner, 2026-10-28), so the keyboard stays on the canvas.
    await page.keyboard.press('Escape');
    const middle = await at(page, 'Референсы');
    await page.mouse.click(middle.x, middle.y);
    await expect(page.locator('.ws-inspector .ins-title-name')).toHaveText('Референсы');
    await expect(page.locator('.ws-inspector .ins-places li')).toHaveCount(2);
    expect(await page.evaluate(() => document.activeElement?.closest('.ins-places') === null)).toBe(
      true,
    );
    // The house and the × keep a column each in every row, empty where a row has no such step.
    for (const cell of [3, 4]) {
      const xs = await page
        .locator(`.ws-inspector .ins-places li > :nth-child(${cell})`)
        .evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().left)));
      expect(new Set(xs).size, `column ${cell}`).toBe(1);
    }
    // A click on the shortcut on the bubble: «Где размещена» with the keyboard.
    await page.mouse.click(400, 650);
    await page.keyboard.press('Escape');
    await clickMark(page, refs, 'places');
    await expect(page.locator('.ws-inspector .ins-title-name')).toHaveText('Референсы');
    await expect(page.locator('.ws-inspector .ins-places .ins-link').first()).toBeFocused();
    const rows = page.locator('.ws-inspector .ins-places li');
    // ⌂ «Игра» first, the root — here, going nowhere.
    await expect(rows.locator('.ins-link')).toHaveText(['Игра', 'Карта']);
    await expect(rows.nth(0).locator('[role="img"]')).toHaveAttribute(
      'aria-label',
      'Основное размещение',
    );
    await expect(rows.nth(1).locator('.ins-link')).toBeDisabled();
    // «Сделать основным»: the root is its home now, «Игра» an appearance.
    await rows.nth(1).getByRole('button', { name: 'Сделать основным: Карта' }).click();
    await expect(page.locator('.toast', { hasText: 'Основным стало Карта' })).toBeVisible();
    await expect.poll(() => placement(page, refs)).toEqual({ appearance: false, places: 2 });
    await expect(rows.locator('.ins-link')).toHaveText(['Карта', 'Игра']);
    // «Убрать отсюда» (Delete): it stays in «Игра», its primary again.
    await page.evaluate(() => window.__strataWs?.view.canvas.focus());
    await page.keyboard.press('Delete');
    await expect(ws).toHaveAttribute('data-nodes', '1');
    await expect(page.locator('.toast', { hasText: 'Убрано отсюда: 1 нода' })).toBeVisible();
    await select(page, 'Игра');
    await page.evaluate(() => window.__strataWs?.view.canvas.focus());
    await page.keyboard.press('Enter');
    await expect(ws).toHaveAttribute('data-depth', '2');
    await expect.poll(() => placement(page, refs)).toEqual({ appearance: false, places: 1 });
    // One place: no section, the path in the corner says it.
    await select(page, 'Референсы');
    await expect(page.locator('.ws-inspector .ins-places')).toHaveCount(0);
  });

  test('removing asks first when it takes more than one sees (05 §5, 06 §12.3)', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.goto('/?plain');
    await createWorkspace(page, 'Карта');
    const ws = page.locator('.workspace');
    const refs = await appearing(page);
    const dialog = page.locator('.delete-dialog');
    // «Удалить везде» of a node placed twice: both places, ⌂ the primary.
    await select(page, 'Референсы');
    await page.evaluate(() => window.__strataWs?.view.canvas.focus());
    await page.keyboard.press('Shift+Delete');
    await expect(dialog.locator('h2')).toHaveText('Удалить везде?');
    await expect(dialog.locator('.dialog-text').first()).toHaveText(
      '«Референсы» размещена в 2 сетях:',
    );
    await expect(dialog.locator('.delete-row')).toHaveText(['Игра', 'Карта']);
    await dialog.getByRole('button', { name: 'Отмена' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(ws).toHaveAttribute('data-nodes', '2');
    // A folder to the trash: what lies elsewhere too stays there.
    await select(page, 'Игра');
    await page.evaluate(() => window.__strataWs?.view.canvas.focus());
    await page.keyboard.press('Delete');
    await expect(dialog.locator('h2')).toHaveText('В корзину?');
    await expect(dialog.locator('.dialog-text')).toHaveText([
      '1 нода внутри размещена ещё где-то и останется там:',
    ]);
    await expect(dialog.locator('.delete-row')).toHaveText(['Референсы · Карта']);
    await dialog.getByRole('button', { name: 'В корзину' }).click();
    await expect(ws).toHaveAttribute('data-nodes', '1');
    await expect.poll(() => placement(page, refs)).toEqual({ appearance: false, places: 1 });
    // One place left: «Удалить везде» asks nothing.
    await select(page, 'Референсы');
    await page.evaluate(() => window.__strataWs?.view.canvas.focus());
    await page.keyboard.press('Shift+Delete');
    await expect(ws).toHaveAttribute('data-nodes', '0');
    await expect(dialog).toHaveCount(0);
    // «Игра» went alone, «Референсы» after it: one node each.
    await expect(page.locator('.toast', { hasText: 'В корзине: 1 нода' })).toHaveCount(2);
  });

  test('Ctrl+X → Ctrl+V moves a node into another network, Esc takes the cut back; one undo (05 §5, 06 §12.1)', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.goto('/?plain');
    await createWorkspace(page, 'Перенос');
    const ws = page.locator('.workspace');
    await makeFolder(page, 'Архив', 520, 320);
    await createNode(page, 760, 480, 'Эскиз');
    const sketch = await idOf(page, 'Эскиз');
    // Cut: half seen with its mark until the paste; `Esc` takes it back.
    await select(page, 'Эскиз');
    await page.evaluate(() => window.__strataWs?.view.canvas.focus());
    await page.keyboard.press('Control+x');
    await expect.poll(() => cutNow(page)).toEqual([sketch]);
    expect((await graphNow(page)).names).toEqual(['Архив', 'Эскиз']);
    await page.keyboard.press('Escape');
    await expect.poll(() => cutNow(page)).toEqual([]);
    // Nothing waits for a paste now: `Ctrl+V` makes nothing of the nodes.
    await emptyClipboard(page);
    await page.keyboard.press('Control+v');
    await settled(page);
    expect((await graphNow(page)).names).toEqual(['Архив', 'Эскиз']);
    // Cut again, into «Архив», `Ctrl+V`: the same node, its placement moved.
    // (A click away first: two clicks on the bubble would be a double click.)
    await page.mouse.click(400, 650);
    await select(page, 'Эскиз');
    await page.evaluate(() => window.__strataWs?.view.canvas.focus());
    await page.keyboard.press('Control+x');
    await expect.poll(() => cutNow(page)).toEqual([sketch]);
    await enter(page, 'Архив');
    await expect.poll(() => cutNow(page)).toEqual([]);
    await page.mouse.move(700, 400);
    await page.keyboard.press('Control+v');
    await expect(ws).toHaveAttribute('data-nodes', '1');
    expect(await idOf(page, 'Эскиз')).toBe(sketch);
    await expect.poll(() => parentOf(page, 'Эскиз')).toBe('Архив');
    await expect
      .poll(() => page.evaluate(() => window.__strataWs?.editor()?.selected))
      .toEqual([sketch]);
    // The cut is done: another `Ctrl+V` moves nothing.
    await page.keyboard.press('Control+v');
    await settled(page);
    await expect(ws).toHaveAttribute('data-nodes', '1');
    // One step of undo brings it back to the root.
    await leave(page);
    await expect(ws).toHaveAttribute('data-nodes', '1');
    await page.keyboard.press('Control+z');
    await expect(ws).toHaveAttribute('data-nodes', '2');
    await expect.poll(() => parentOf(page, 'Эскиз')).toBe('Перенос');
  });

  test('Ctrl+C → Ctrl+V copies, Ctrl+Shift+V places an appearance; «Нода уже здесь», «Нода уже была здесь» (05 §5, 06 §12.1)', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.goto('/?plain');
    await createWorkspace(page, 'Копии');
    const ws = page.locator('.workspace');
    await makeFolder(page, 'Архив', 520, 320);
    await createNode(page, 760, 480, 'Эскиз');
    const sketch = await idOf(page, 'Эскиз');
    await select(page, 'Эскиз');
    await page.evaluate(() => window.__strataWs?.view.canvas.focus());
    await page.keyboard.press('Control+c');
    // A copy is not cut: nothing is half seen.
    expect(await cutNow(page)).toEqual([]);
    // Here it lies already: no appearance, the toast says so.
    await page.keyboard.press('Control+Shift+v');
    await expect(page.locator('.toast', { hasText: 'Нода уже здесь' })).toBeVisible();
    await expect(ws).toHaveAttribute('data-nodes', '2');
    // `Ctrl+V` of a copy: a new node of the same name beside, one step.
    await page.mouse.move(900, 300);
    await page.keyboard.press('Control+v');
    await expect(ws).toHaveAttribute('data-nodes', '3');
    expect(await named(page, 'Эскиз')).toBe(2);
    await page.keyboard.press('Control+z');
    await expect(ws).toHaveAttribute('data-nodes', '2');
    // The palette pastes an appearance too, in «Архив».
    await enter(page, 'Архив');
    await page.keyboard.press('Control+p');
    await page.locator('.command-palette .palette-query').fill('появление');
    await expect(page.locator('.command-palette .tab-menu-row.is-current')).toContainText(
      'Вставить как появление',
    );
    await page.keyboard.press('Enter');
    await expect(ws).toHaveAttribute('data-nodes', '1');
    expect(await idOf(page, 'Эскиз')).toBe(sketch);
    await expect.poll(() => placement(page, sketch)).toEqual({ appearance: true, places: 2 });
    // Cut at the root and pasted where it lies already: one placement left, the toast says so.
    await leave(page);
    await select(page, 'Эскиз');
    await page.evaluate(() => window.__strataWs?.view.canvas.focus());
    await page.keyboard.press('Control+x');
    await enter(page, 'Архив');
    await page.keyboard.press('Control+v');
    await expect(page.locator('.toast', { hasText: 'Нода уже была здесь' })).toBeVisible();
    await expect.poll(() => placement(page, sketch)).toEqual({ appearance: false, places: 1 });
    await expect(ws).toHaveAttribute('data-nodes', '1');
    // One step of undo: both placements again.
    await page.keyboard.press('Control+z');
    await expect.poll(() => placement(page, sketch)).toEqual({ appearance: true, places: 2 });
  });

  test('Ctrl+D puts a copy beside, shifted by 24, one step; the menu and the palette have it (06 §12.1)', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.goto('/?plain');
    await createWorkspace(page, 'Дубли');
    const ws = page.locator('.workspace');
    await createNode(page, 760, 480, 'Эскиз');
    const sketch = await idOf(page, 'Эскиз');
    await select(page, 'Эскиз');
    await page.evaluate(() => window.__strataWs?.view.canvas.focus());
    await page.keyboard.press('Control+d');
    await expect(ws).toHaveAttribute('data-nodes', '2');
    expect(await named(page, 'Эскиз')).toBe(2);
    // The copy, 24 to the right and down of its original, is the one chosen.
    const spots = await page.evaluate((orig) => {
      const ws = window.__strataWs;
      const g = ws?.graph();
      const nodes = [...(g?.nodes.values() ?? [])].filter((n) => n.name === 'Эскиз');
      const a = nodes.find((n) => n.id === orig);
      const b = nodes.find((n) => n.id !== orig);
      return {
        dx: (b?.x ?? 0) - (a?.x ?? 0),
        dy: (b?.y ?? 0) - (a?.y ?? 0),
        chosen: ws?.editor()?.selected ?? [],
        copy: b?.id,
      };
    }, sketch);
    expect([spots.dx, spots.dy]).toEqual([24, 24]);
    expect(spots.chosen).toEqual([spots.copy]);
    await page.keyboard.press('Control+z');
    await expect(ws).toHaveAttribute('data-nodes', '1');
    // The menu by the right button has it, with its key, and so does the palette.
    const at0 = await at(page, 'Эскиз');
    await page.mouse.click(at0.x, at0.y, { button: 'right' });
    await page.getByRole('menuitem', { name: /Дублировать/ }).click();
    await expect(ws).toHaveAttribute('data-nodes', '2');
    await page.evaluate(() => window.__strataWs?.view.canvas.focus());
    await page.keyboard.press('Control+p');
    await page.locator('.command-palette .palette-query').fill('дублировать');
    await expect(page.locator('.command-palette .tab-menu-row.is-current')).toContainText(
      'Дублировать',
    );
    await page.keyboard.press('Enter');
    await expect(ws).toHaveAttribute('data-nodes', '3');
  });

  test('a drag held 500 ms on a folder: inside, Alt — a copy, Alt+Ctrl+Shift — an appearance (06 §12.1)', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.goto('/?plain');
    await createWorkspace(page, 'Броски');
    const ws = page.locator('.workspace');
    await makeFolder(page, 'Архив', 520, 320);
    await createNode(page, 820, 480, 'Эскиз');
    await createNode(page, 900, 300, 'Палитра');
    const sketch = await idOf(page, 'Эскиз');
    // A pass over the bubble does not drop inside: it is a move.
    await dragOnto(page, 'Палитра', 'Архив', [], 0);
    await expect(ws).toHaveAttribute('data-nodes', '3');
    await page.keyboard.press('Control+z');
    await settled(page);
    // Held: «Эскиз» goes inside «Архив».
    await dragOnto(page, 'Эскиз', 'Архив');
    await expect(ws).toHaveAttribute('data-nodes', '2');
    await expect.poll(() => parentOf(page, 'Эскиз')).toBe('Архив');
    await page.keyboard.press('Control+z');
    await expect(ws).toHaveAttribute('data-nodes', '3');
    await expect.poll(() => parentOf(page, 'Эскиз')).toBe('Броски');
    // `Alt`: a copy goes inside, the node stays; one step of undo.
    await dragOnto(page, 'Палитра', 'Архив', ['Alt']);
    await expect.poll(() => named(page, 'Палитра')).toBe(2);
    await expect(ws).toHaveAttribute('data-nodes', '3');
    await page.keyboard.press('Control+z');
    await expect.poll(() => named(page, 'Палитра')).toBe(1);
    // `Alt+Ctrl+Shift`: an appearance inside, the node stays where it was.
    const mods = ['Alt', 'ControlOrMeta', 'Shift'];
    await dragOnto(page, 'Эскиз', 'Архив', mods);
    await expect.poll(() => placement(page, sketch)).toEqual({ appearance: false, places: 2 });
    await expect(ws).toHaveAttribute('data-nodes', '3');
    // Away from a folder's bubble an appearance cannot be: «⊘ Нода уже здесь»,
    // and the gesture is a plain drag.
    const from = await at(page, 'Палитра');
    for (const m of mods) await page.keyboard.down(m);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 40, from.y + 60, { steps: 6 });
    const note = page.locator('.ws-cursor-note');
    await expect(note).toHaveText('Нода уже здесь');
    await expect(note.locator('.kind-icon')).toBeVisible();
    await page.mouse.up();
    for (const m of [...mods].reverse()) await page.keyboard.up(m);
    await expect(note).toHaveCount(0);
    await settled(page);
    await expect.poll(() => named(page, 'Палитра')).toBe(1);
    const moved = await at(page, 'Палитра');
    expect(Math.round(moved.x - from.x)).toBe(40);
  });

  test('the word by the cursor stands where the cursor is, moved before the word was drawn (06 §12.1)', async ({
    page,
  }) => {
    await page.goto('/?plain');
    await createWorkspace(page, 'Курсор');
    await createNode(page, 760, 480, 'Эскиз');
    const from = await at(page, 'Эскиз');
    const to = { x: from.x + 60, y: from.y + 40 };
    const mods = ['Alt', 'ControlOrMeta', 'Shift'];
    for (const m of mods) await page.keyboard.down(m);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    // Six moves in one task: the word is asked for at the first and drawn
    // after the last, as a WebKit under load coalesces them (run 118).
    await page.evaluate(
      ({ from, to }) => {
        const canvas = (window.__strataWs as WsHook).view.canvas;
        for (let i = 1; i <= 6; i++) {
          canvas.dispatchEvent(
            new PointerEvent('pointermove', {
              bubbles: true,
              clientX: from.x + ((to.x - from.x) * i) / 6,
              clientY: from.y + ((to.y - from.y) * i) / 6,
              pointerId: 1,
              pointerType: 'mouse',
              isPrimary: true,
              buttons: 1,
            }),
          );
        }
      },
      { from, to },
    );
    const note = page.locator('.ws-cursor-note');
    await expect(note).toHaveText('Нода уже здесь');
    const off = await note.evaluate((el, at) => {
      const s = (el as HTMLElement).style;
      return Math.max(
        Math.abs(Number.parseFloat(s.left) - at.x),
        Math.abs(Number.parseFloat(s.top) - at.y),
      );
    }, to);
    expect(off).toBeLessThanOrEqual(1);
    await page.mouse.up();
    for (const m of [...mods].reverse()) await page.keyboard.up(m);
    await expect(note).toHaveCount(0);
  });

  test('a network the core does not give says why; the canvas stays on the one it had', async ({
    page,
  }) => {
    await page.goto('/?plain');
    await createWorkspace(page, 'Отказ');
    await makeFolder(page, 'Архив', 520, 320);
    const archive = await idOf(page, 'Архив');
    // The core cannot give «Архив», as with a store it cannot read.
    await page.evaluate((id) => {
      const core = (window.__strataWs as WsHook).core;
      const view = core.view.bind(core);
      core.view = (net) => (net === id ? Promise.reject(new Error('диск недоступен')) : view(net));
    }, archive);
    await select(page, 'Архив');
    await page.evaluate(() => window.__strataWs?.view.canvas.focus());
    await page.keyboard.press('Enter');
    await expect(
      page.locator('.toast', { hasText: 'Сеть не открылась: диск недоступен' }),
    ).toBeVisible();
    await expect(page.locator('.workspace')).toHaveAttribute('data-depth', '1');
    await expect(page.locator('.workspace')).toHaveAttribute('data-nodes', '1');
  });

  test("a gesture's keys are a word by the cursor while it lasts: J, Y (☑ Q-06-5)", async ({
    page,
  }) => {
    await page.goto('/?plain');
    await createWorkspace(page, 'Подсказки');
    await createNode(page, 420, 300, 'Один');
    const hint = page.locator('.ws-cursor-note[data-kind="hint"]');
    // Resting on a bubble says nothing: no status line (owner, 2026-10-24).
    const one = await at(page, 'Один');
    await page.mouse.move(one.x, one.y);
    await expect(hint).toHaveCount(0);
    // `J` held and a stroke: what the stroke does, beside the cursor, while it lasts.
    await page.evaluate(() => window.__strataWs?.view.canvas.focus());
    await page.mouse.move(300, 520);
    await page.keyboard.down('j');
    await page.mouse.down();
    await page.mouse.move(340, 540, { steps: 4 });
    await expect(hint).toHaveText('Ведите через баблы — связать цепочкой · Esc');
    const b = await box(page, '.ws-cursor-note[data-kind="hint"]');
    expect(b.x).toBeGreaterThan(340);
    expect(b.y).toBeGreaterThan(540);
    await page.mouse.up();
    await page.keyboard.up('j');
    await expect(hint).toHaveCount(0);
    // `Y`: the scissors.
    await page.keyboard.down('y');
    await page.mouse.down();
    await page.mouse.move(380, 560, { steps: 4 });
    await expect(hint).toHaveText('Ведите через нити — разрезать · Esc');
    await page.mouse.up();
    await page.keyboard.up('y');
    await expect(hint).toHaveCount(0);
    // «Настройки»: the hints off — the stroke goes without its word.
    const gear = page.locator('.tabbar-settings');
    await gear.click();
    await page.getByRole('combobox', { name: 'Подсказки жестов' }).selectOption('hide');
    await gear.click();
    await expect(page.locator('.settings')).toHaveCount(0);
    await page.evaluate(() => window.__strataWs?.view.canvas.focus());
    await page.mouse.move(300, 520);
    await page.keyboard.down('j');
    await page.mouse.down();
    await page.mouse.move(340, 540, { steps: 4 });
    await expect(page.locator('.ws-cursor-note')).toHaveCount(0);
    await page.mouse.up();
    await page.keyboard.up('j');
  });

  test('the canvas keys of 06 §17: J chains, Alt+click a branch, Alt+PgDn a wire, Ctrl+arrows, S, I', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.goto('/?plain');
    await createWorkspace(page, 'Клавиши');
    const ws = page.locator('.workspace');
    await createNode(page, 420, 300, 'Альфа');
    await createNode(page, 620, 380, 'Бета');
    await createNode(page, 820, 300, 'Гамма');
    const edges = async () => (await graphNow(page)).edges.sort();
    const selected = () =>
      page.evaluate(() => {
        const ws = window.__strataWs as WsHook;
        const g = ws.graph();
        return (ws.editor()?.selected ?? []).map((id) => g?.nodes.get(id)?.name).sort();
      });
    const a = await at(page, 'Альфа');
    const b = await at(page, 'Бета');
    const c = await at(page, 'Гамма');
    /** Held `J`, a stroke from left of «Альфа» through the three, to right of «Гамма». */
    const chain = async (giveUp = false) => {
      await page.mouse.move(a.x - 40, a.y);
      await page.keyboard.down('j');
      await page.mouse.down();
      for (const p of [a, b, c, { x: c.x + 40, y: c.y }]) {
        await page.mouse.move(p.x, p.y, { steps: 8 });
      }
      if (giveUp) await page.keyboard.press('Escape');
      await page.mouse.up();
      await page.keyboard.up('j');
      await settled(page);
    };
    // `J` and a stroke (06 §6.1): a chain in the order it reached them, one step.
    await chain();
    await expect(ws).toHaveAttribute('data-wires', '2');
    expect(await edges()).toEqual(['Альфа→Бета', 'Бета→Гамма']);
    // Again: the wires are there, none is made twice.
    await chain();
    expect(await edges()).toEqual(['Альфа→Бета', 'Бета→Гамма']);
    await page.keyboard.press('Control+z');
    await expect(ws).toHaveAttribute('data-wires', '0');
    // Esc in the middle of the stroke makes none.
    await chain(true);
    await expect(ws).toHaveAttribute('data-wires', '0');
    await page.keyboard.press('Control+Shift+z');
    await expect(ws).toHaveAttribute('data-wires', '2');
    // A branch (06 §11): Alt+Shift — up the stream, Alt+Ctrl — down.
    await page.keyboard.down('Alt');
    await page.keyboard.down('Shift');
    await page.mouse.click(c.x, c.y);
    await page.keyboard.up('Shift');
    await page.keyboard.up('Alt');
    expect(await selected()).toEqual(['Альфа', 'Бета', 'Гамма']);
    await page.keyboard.down('Alt');
    await page.keyboard.down('ControlOrMeta');
    await page.mouse.click(b.x, b.y);
    await page.keyboard.up('ControlOrMeta');
    await page.keyboard.up('Alt');
    expect(await selected()).toEqual(['Бета', 'Гамма']);
    // Alt+PgDn (06 §6.1): the outgoing wire of the current node; Delete takes the wire.
    await select(page, 'Альфа');
    await page.keyboard.press('Alt+PageDown');
    expect(await selected()).toEqual([]);
    await page.keyboard.press('Delete');
    await settled(page);
    expect(await edges()).toEqual(['Бета→Гамма']);
    await page.keyboard.press('Control+z');
    await expect(ws).toHaveAttribute('data-wires', '2');
    // Ctrl+arrows move the selection a grid step, with Shift four units, one step each.
    await select(page, 'Гамма');
    const gamma = await idOf(page, 'Гамма');
    const spot = () =>
      page.evaluate(async (id) => {
        const ws = window.__strataWs as WsHook;
        await ws.settled();
        const n = ws.graph()?.nodes.get(id);
        return { x: n?.x, y: n?.y };
      }, gamma);
    const from = await spot();
    await page.keyboard.press('ControlOrMeta+ArrowRight');
    await page.keyboard.press('ControlOrMeta+Shift+ArrowDown');
    expect(await spot()).toEqual({ x: (from.x ?? 0) + 24, y: (from.y ?? 0) + 4 });
    await page.keyboard.press('Control+z');
    expect(await spot()).toEqual({ x: (from.x ?? 0) + 24, y: from.y });
    await page.keyboard.press('Control+z');
    expect(await spot()).toEqual(from);
    // `S` held: a drag from a bubble is a marquee, nothing moves (06 §11).
    const before = await graphNow(page);
    await page.mouse.move(a.x, a.y);
    await page.keyboard.down('s');
    await page.mouse.down();
    await page.mouse.move(b.x + 40, b.y + 40, { steps: 8 });
    await page.mouse.up();
    await page.keyboard.up('s');
    expect(await selected()).toEqual(['Альфа', 'Бета']);
    expect(await spot()).toEqual(from);
    expect((await graphNow(page)).edges).toEqual(before.edges);
    // `I` dives in as Enter does (06 §10.1).
    await makeFolder(page, 'Ящик', 640, 560);
    await select(page, 'Ящик');
    await page.keyboard.press('KeyI');
    await expect(ws).toHaveAttribute('data-depth', '2');
    await page.keyboard.press('KeyU');
    await expect(ws).toHaveAttribute('data-depth', '1');
  });

  test('A + drag lays out the branch below or above the bubble, which stays put; one step (06 §9.1)', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.goto('/?plain');
    await createWorkspace(page, 'Ветка');
    // A chain «Корень» → «Лист 1» → «Лист 2», laid out against its stream.
    await createNode(page, 640, 560, 'Корень');
    await createNode(page, 420, 260, 'Лист 1');
    await createNode(page, 880, 300, 'Лист 2');
    const root = await at(page, 'Корень');
    const one = await at(page, 'Лист 1');
    const two = await at(page, 'Лист 2');
    await page.mouse.move(root.x, root.y);
    await page.keyboard.down('j');
    await page.mouse.down();
    for (const p of [one, two]) await page.mouse.move(p.x, p.y, { steps: 10 });
    await page.mouse.up();
    await page.keyboard.up('j');
    await expect(page.locator('.workspace')).toHaveAttribute('data-wires', '2');
    const spots = () =>
      page.evaluate(async () => {
        const ws = window.__strataWs as WsHook;
        await ws.settled();
        const out: Record<string, { x: number; y: number }> = {};
        for (const n of ws.graph()?.nodes.values() ?? []) out[n.name] = { x: n.x, y: n.y };
        return out;
      });
    const before = await spots();
    /** Held `A`, a drag from «name» by (dx, dy). */
    const arrange = async (name: string, dx: number, dy: number) => {
      const p = await at(page, name);
      await page.mouse.move(p.x, p.y);
      await page.keyboard.down('a');
      await page.mouse.down();
      await page.mouse.move(p.x + dx, p.y + dy, { steps: 6 });
      await page.mouse.up();
      await page.keyboard.up('a');
    };
    // Down from «Корень»: the branch below it, top to bottom; «Корень» stays.
    await arrange('Корень', 0, 80);
    await expect
      .poll(async () => {
        const s = await spots();
        return (
          (s['Лист 1']?.y ?? 0) > (s['Корень']?.y ?? 0) &&
          (s['Лист 2']?.y ?? 0) > (s['Лист 1']?.y ?? 0)
        );
      })
      .toBe(true);
    const after = await spots();
    expect(after['Корень']).toEqual(before['Корень']);
    // One step of undo takes the layout back whole; the canvas animates it home.
    await page.keyboard.press('Control+z');
    await expect.poll(spots).toEqual(before);
    await expect.poll(() => at(page, 'Лист 2')).toEqual(two);
    // Up from «Лист 2»: the branch above it; «Лист 2» stays, its feeders go above.
    await arrange('Лист 2', 0, -80);
    await expect
      .poll(async () => {
        const s = await spots();
        return (
          (s['Корень']?.y ?? 0) < (s['Лист 1']?.y ?? 0) &&
          (s['Лист 1']?.y ?? 0) < (s['Лист 2']?.y ?? 0)
        );
      })
      .toBe(true);
    expect((await spots())['Лист 2']).toEqual(before['Лист 2']);
  });

  test('C gives the nodes a colour, 0 takes it back, one step each; P opens and closes the panel (06 §2.1, §17)', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.goto('/?plain');
    await createWorkspace(page, 'Цвета');
    await createNode(page, 560, 380, 'Эскиз');
    await createNode(page, 760, 380, 'Палитра');
    const sketch = await idOf(page, 'Эскиз');
    const board = await idOf(page, 'Палитра');
    const colour = (id: string) =>
      page.evaluate(async (id) => {
        const ws = window.__strataWs as WsHook;
        await ws.settled();
        const core = await ws.core.node(id);
        return { canvas: ws.graph()?.nodes.get(id)?.color ?? null, core: core.color ?? null };
      }, id);
    const palette = page.locator('.color-palette');
    // `C` and a digit: the colour at once, in the canvas and in the core.
    await select(page, 'Эскиз');
    await page.keyboard.press('KeyC');
    await expect(palette).toBeVisible();
    await page.keyboard.press('3');
    await expect(palette).toHaveCount(0);
    expect(await colour(sketch)).toEqual({ canvas: 2, core: 2 });
    await page.keyboard.press('Control+z');
    expect(await colour(sketch)).toEqual({ canvas: null, core: null });
    // The arrows and Enter; the palette opens on the colour the node has.
    await page.keyboard.press('KeyC');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    expect(await colour(sketch)).toEqual({ canvas: 1, core: 1 });
    await page.keyboard.press('KeyC');
    await expect(palette.locator('.color-cell.is-chosen')).toHaveAttribute(
      'aria-label',
      'Бирюзовый',
    );
    // `0` — the kind's colour back.
    await page.keyboard.press('0');
    expect(await colour(sketch)).toEqual({ canvas: null, core: null });
    // Two chosen: a click gives both the colour, one step of undo takes both back.
    await page.keyboard.press('Control+a');
    await page.keyboard.press('KeyC');
    await palette.locator('.color-cell').nth(5).click();
    expect(await colour(sketch)).toEqual({ canvas: 4, core: 4 });
    expect(await colour(board)).toEqual({ canvas: 4, core: 4 });
    await page.keyboard.press('Control+z');
    expect(await colour(sketch)).toEqual({ canvas: null, core: null });
    expect(await colour(board)).toEqual({ canvas: null, core: null });
    // `P`: the panel of the current node; again — it closes, as its × does.
    await select(page, 'Эскиз');
    await expect(page.locator('.ws-inspector')).toBeVisible();
    await page.evaluate(() => window.__strataWs?.view.canvas.focus());
    await page.keyboard.press('KeyP');
    await expect(page.locator('.ws-inspector')).toHaveCount(0);
    await page.keyboard.press('KeyP');
    await expect(page.locator('.ws-inspector .ins-title-name')).toHaveText('Эскиз');
  });

  test('the info card: the middle button held, 600 ms of rest, Shift+I keeps it (06 §4.4)', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.goto('/?plain');
    await createWorkspace(page, 'Справка');
    await createNode(page, 520, 380, 'Эскиз');
    await createNode(page, 760, 380, 'Палитра');
    const sketch = await at(page, 'Эскиз');
    const board = await at(page, 'Палитра');
    // A wire Эскиз → Палитра: the card counts it.
    await page.mouse.move(sketch.x - 40, sketch.y);
    await page.keyboard.down('j');
    await page.mouse.down();
    await page.mouse.move(board.x, board.y, { steps: 10 });
    await page.mouse.up();
    await page.keyboard.up('j');
    await expect(page.locator('.workspace')).toHaveAttribute('data-wires', '1');
    const card = page.locator('.ws-info-card');
    const away = { x: (sketch.x + board.x) / 2, y: sketch.y + 200 };
    // Held still: the card while the button holds, its wires once the core answers.
    await page.mouse.move(sketch.x, sketch.y);
    await page.mouse.down({ button: 'middle' });
    await expect(card.locator('.map-card-name')).toHaveText('Эскиз');
    await expect(card.locator('.map-card-value', { hasText: '→ 1' })).toBeVisible();
    await page.mouse.up({ button: 'middle' });
    await expect(card).toHaveCount(0);
    // A drag of the middle button is a pan: no card.
    await page.mouse.move(board.x, board.y);
    await page.mouse.down({ button: 'middle' });
    await page.mouse.move(board.x + 60, board.y + 30, { steps: 4 });
    await page.mouse.up({ button: 'middle' });
    await expect(card).toHaveCount(0);
    const moved = await at(page, 'Палитра');
    expect(Math.round(moved.x - board.x)).toBe(60);
    // The cursor at rest 600 ms: the card till it leaves.
    await page.mouse.move(away.x, away.y);
    await page.mouse.move(moved.x, moved.y, { steps: 4 });
    await expect(card.locator('.map-card-name')).toHaveText('Палитра');
    await page.mouse.move(away.x, away.y, { steps: 4 });
    await expect(card).toHaveCount(0);
    // `Shift+I`: kept, with the accent's line; the cursor away, it stays; its × closes it.
    await page.mouse.move(moved.x, moved.y, { steps: 4 });
    await page.keyboard.press('Shift+KeyI');
    await expect(card).toHaveClass(/is-kept/);
    await page.mouse.move(away.x, away.y, { steps: 4 });
    await expect(card).toHaveClass(/is-kept/);
    await card.locator('.window-close').click();
    await expect(card).toHaveCount(0);
    // «Настройки»: by the middle button only — rest shows nothing.
    await page.locator('.tabbar-settings').click();
    await page.locator('.settings').getByLabel('Инфокарточка').selectOption('hold');
    await page.locator('.tabbar-settings').click();
    await expect(page.locator('.settings')).toHaveCount(0);
    await page.mouse.move(moved.x, moved.y, { steps: 4 });
    await page.waitForTimeout(900);
    await expect(card).toHaveCount(0);
  });

  test('? opens the keys; Esc, × and a press outside close them; the palette has them too (06 §17)', async ({
    page,
  }) => {
    await page.goto('/?plain');
    await createWorkspace(page, 'Клавиши');
    const help = page.locator('.help-window');
    await page.evaluate(() => window.__strataWs?.view.canvas.focus());
    await page.keyboard.press('Shift+Slash');
    await expect(help).toBeVisible();
    // A gesture in words, a key as printed: «J+штрих» for the chain.
    const chain = help.locator('.help-row', { hasText: 'Цепочка' });
    await expect(chain.locator('dd')).toHaveText('J+штрих');
    // The canvas leaves the keys alone meanwhile: `L` does not lay out.
    await page.keyboard.press('Escape');
    await expect(help).toHaveCount(0);
    await page.keyboard.press('Shift+Slash');
    await help.locator('.window-close').click();
    await expect(help).toHaveCount(0);
    await page.keyboard.press('Shift+Slash');
    await page.mouse.click(10, 790);
    await expect(help).toHaveCount(0);
    // «Клавиши» in the command palette.
    await page.evaluate(() => window.__strataWs?.view.canvas.focus());
    await page.keyboard.press('Control+p');
    await page.keyboard.type('клавиши');
    await expect(page.locator('.tab-menu-row').first()).toContainText('Клавиши');
    await page.keyboard.press('Enter');
    await expect(help).toBeVisible();
  });

  test('a store kept in parts, as a large one is (V-10k), comes back after a reload', async ({
    page,
  }) => {
    // `shelfPart`: a part is 1 KiB, so every store goes in parts, not only one over 32 MiB.
    await page.goto('/?plain&shelfPart=1024');
    await createWorkspace(page, 'Части');
    await createNode(page, 640, 400, 'Эскиз');
    await settled(page);
    await page.reload();
    await expect(page.locator('.home-card', { hasText: 'Части' })).toHaveCount(1);
    await page.locator('.home-open').click();
    await expect(page.locator('.workspace')).toHaveAttribute('data-nodes', '1');
    await expect.poll(() => named(page, 'Эскиз')).toBe(1);
  });

  test('Shift+C wraps the chosen nodes in a folder, one step; several are named next (06 §13.3)', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.goto('/?plain');
    await createWorkspace(page, 'Обёртки');
    const ws = page.locator('.workspace');
    await createNode(page, 560, 320, 'Эскиз');
    await createNode(page, 760, 320, 'Палитра');
    await createNode(page, 660, 520, 'Звук');
    // Two chosen: a folder at their middle, its name typed into the same step.
    await select(page, 'Эскиз');
    const b = await at(page, 'Палитра');
    await page.keyboard.down('Shift');
    await page.mouse.click(b.x, b.y);
    await page.keyboard.up('Shift');
    await page.evaluate(() => window.__strataWs?.view.canvas.focus());
    await page.keyboard.press('Shift+c');
    const field = page.locator('input.name-input');
    await expect(field).toHaveValue('Папка');
    await field.fill('Пакет');
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await graphNow(page)).names).toEqual(['Звук', 'Пакет']);
    await expect.poll(() => parentOf(page, 'Эскиз')).toBe('Пакет');
    await expect.poll(() => parentOf(page, 'Палитра')).toBe('Пакет');
    await expect(page.locator('.layer-row', { hasText: 'Пакет' })).toBeVisible();
    // One step: the wrap and its name go back together.
    await page.keyboard.press('Control+z');
    await expect
      .poll(async () => (await graphNow(page)).names)
      .toEqual(['Звук', 'Палитра', 'Эскиз']);
    // One node names its folder; from the menu by the right button.
    const sound = await at(page, 'Звук');
    await page.mouse.click(sound.x, sound.y, { button: 'right' });
    await page.getByRole('menuitem', { name: 'Обернуть в папку' }).click();
    await expect
      .poll(async () => (await graphNow(page)).names)
      .toEqual(['Звук', 'Палитра', 'Эскиз']);
    await expect(page.locator('.name-input')).toHaveCount(0);
    const folder = await page.evaluate(() =>
      [...(window.__strataWs?.graph()?.nodes.values() ?? [])].find((n) => n.kind === 'network'),
    );
    expect(folder?.name).toBe('Звук');
    await expect.poll(() => parentOf(page, 'Звук')).toBe('Звук');
    await expect(ws).toHaveAttribute('data-nodes', '3');
  });

  test('rows of «Ноды» dragged onto a folder move there; a folder onto one inside it is «⊘» (05 §5)', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.goto('/?plain');
    await createWorkspace(page, 'Дерево');
    const ws = page.locator('.workspace');
    await makeFolder(page, 'Архив', 520, 320);
    await createNode(page, 760, 480, 'Эскиз');
    await enter(page, 'Архив');
    await makeFolder(page, 'Внутри', 600, 400);
    await leave(page);
    const row = (name: string) => page.locator('.layer-row', { hasText: name });
    const drag = async (name: string, onto: string, drop = true) => {
      const a = await box(page, `.layer-row[data-layer="${await rowId(name)}"] .layer-name`);
      const b = await box(page, `.layer-row[data-layer="${await rowId(onto)}"] .layer-name`);
      await page.mouse.move(a.x + 20, a.y + a.height / 2);
      await page.mouse.down();
      await page.mouse.move(a.x + 30, a.y + a.height / 2 + 6, { steps: 2 });
      await page.mouse.move(b.x + 40, b.y + b.height / 2, { steps: 6 });
      if (drop) await page.mouse.up();
    };
    const rowId = (name: string) =>
      page.evaluate(async (name) => {
        const items = await (window.__strataWs as WsHook).core.tree();
        return items.find((i) => i.name === name)?.id ?? '';
      }, name);
    // «Эскиз» onto «Архив»: it moves there, the canvas of the root lets it go.
    await drag('Эскиз', 'Архив');
    await expect.poll(() => parentOf(page, 'Эскиз')).toBe('Архив');
    await expect(ws).toHaveAttribute('data-nodes', '1');
    // «Архив» onto «Внутри», a folder inside it: «⊘», and the drop moves nothing.
    await drag('Архив', 'Внутри', false);
    await expect(row('Внутри')).toHaveClass(/is-refused/);
    await expect(row('Внутри').locator('.layer-forbid .kind-icon')).toBeVisible();
    await page.mouse.up();
    await settled(page);
    await expect(row('Внутри')).not.toHaveClass(/is-refused/);
    await expect.poll(() => parentOf(page, 'Архив')).toBe('Дерево');
    // `Esc` puts rows back mid-drag.
    await drag('Внутри', 'Архив', false);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await settled(page);
    await expect.poll(() => parentOf(page, 'Внутри')).toBe('Архив');
    // One step of undo brings «Эскиз» back.
    await page.evaluate(() => window.__strataWs?.view.canvas.focus());
    await page.keyboard.press('Control+z');
    await expect(ws).toHaveAttribute('data-nodes', '2');
    await expect.poll(() => parentOf(page, 'Эскиз')).toBe('Дерево');
  });

  test('updates are asked once; «Не проверять» asks nothing, «Настройки» turn checks on (NFR-94)', async ({
    page,
  }) => {
    await page.goto('/?updates&update=9.9.9');
    const dialog = page.locator('.update-dialog');
    await expect(dialog.locator('h2')).toHaveText('Проверять обновления?');
    await expect(dialog.locator('.update-text')).toHaveText('github.com/AntonZyuzin/Strata');
    await dialog.getByRole('button', { name: 'Не проверять' }).click();
    await expect(dialog).toHaveCount(0);
    // Answered: no question at the next start, and nothing asked.
    await page.reload();
    await expect(page.locator('.home-new')).toBeVisible();
    await expect(dialog).toHaveCount(0);
    // «Настройки»: the answer as it is, then checks at each start.
    await page.locator('.tabbar-settings').click();
    const row = page.getByRole('combobox', { name: 'Обновления' });
    await expect(row).toHaveValue('never');
    await row.selectOption('check');
    await page.reload();
    await expect(dialog.locator('h2')).toHaveText('Доступна версия 9.9.9');
    await expect(dialog.locator('.update-text')).toHaveText('Сейчас 0.0.1');
    await dialog.getByRole('button', { name: 'Позже' }).click();
    await expect(dialog).toHaveCount(0);
    // A build with no channel neither asks nor shows the row.
    await page.goto('/');
    await expect(page.locator('.home-new')).toBeVisible();
    await page.locator('.tabbar-settings').click();
    await expect(page.getByRole('combobox', { name: 'Обновления' })).toHaveCount(0);
  });

  test("a background: the workspace's on the root, a network's own, one's own picture; one step each (07 §7.4)", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.goto('/?plain');
    await createWorkspace(page, 'Фоны');
    await makeFolder(page, 'Папка', 640, 400);
    const ws = page.locator('.workspace');
    const palette = page.locator('.bg-palette');
    const cells = palette.locator('.bg-cell');
    const open = async (item: string) => {
      const c = await box(page, '.proto-canvas');
      await page.mouse.click(c.x + 120, c.y + c.height - 120, { button: 'right' });
      await page.locator('.context-menu').getByText(item, { exact: true }).click();
      await expect(palette).toBeVisible();
    };
    // The root: the workspace's background, «Туман» until chosen; no «Как у пространства».
    await expect(ws).toHaveAttribute('data-background', 'preset:fog');
    await open('Фон пространства');
    await expect(cells).toHaveCount(5);
    await expect(palette.locator('.bg-cell.is-chosen')).toHaveAttribute('aria-label', 'Туман');
    await palette.getByRole('option', { name: 'Сумерки' }).click();
    await expect(palette).toHaveCount(0);
    await expect(ws).toHaveAttribute('data-background', 'preset:dusk');
    // A network shows the workspace's until it has its own.
    await enter(page, 'Папка');
    await expect(ws).toHaveAttribute('data-background', 'preset:dusk');
    await open('Фон сети');
    await expect(cells).toHaveCount(6);
    await expect(palette.locator('.bg-cell.is-chosen')).toHaveAttribute(
      'aria-label',
      'Как у пространства',
    );
    // The keys: → to «Пыль», Enter.
    for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await expect(ws).toHaveAttribute('data-background', 'preset:dust');
    await leave(page);
    await expect(ws).toHaveAttribute('data-background', 'preset:dusk');
    await enter(page, 'Папка');
    await expect(ws).toHaveAttribute('data-background', 'preset:dust');
    // One step of undo: the workspace's again.
    await page.evaluate(() => window.__strataWs?.view.canvas.focus());
    await page.keyboard.press('Control+z');
    await expect(ws).toHaveAttribute('data-background', 'preset:dusk');
    // One's own picture, from the disk: stored, set as the network's own.
    const png = await page.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 64;
      c.height = 40;
      const g = c.getContext('2d') as CanvasRenderingContext2D;
      g.fillStyle = '#3a5a7a';
      g.fillRect(0, 0, 64, 40);
      return c.toDataURL('image/png').split(',')[1] ?? '';
    });
    await open('Фон сети');
    const chooser = page.waitForEvent('filechooser');
    await palette.getByRole('option', { name: 'Своя картинка…' }).click();
    await (await chooser).setFiles({
      name: 'небо.png',
      mimeType: 'image/png',
      buffer: Buffer.from(png, 'base64'),
    });
    await expect(ws).toHaveAttribute('data-background', /^asset:[0-9a-f]{64}$/);
    // The palette's command opens it too.
    await page.evaluate(() => window.__strataWs?.view.canvas.focus());
    await page.keyboard.press('Control+p');
    await page.locator('.command-palette .palette-query').fill('фон сети');
    await page.keyboard.press('Enter');
    await expect(palette).toBeVisible();
    await expect(palette.locator('.bg-cell.is-chosen')).toHaveAttribute(
      'aria-label',
      'Своя картинка…',
    );
    await page.keyboard.press('Escape');
    await expect(palette).toHaveCount(0);
  });

  test('«Настройки» are a window the gear opens, not a tab (owner, 2026-10-28)', async ({
    page,
  }) => {
    await page.goto('/?plain');
    await createWorkspace(page, 'Окно настроек');
    const gear = page.locator('.tabbar-settings');
    const win = page.locator('.settings');
    const tabs = page.locator('.tabbar .tab');
    await expect(tabs).toHaveCount(1);
    // The gear opens it under itself and stays pressed; the bar gets no tab.
    await gear.click();
    await expect(win).toBeVisible();
    await expect(win).toBeFocused();
    await expect(gear).toHaveAttribute('aria-pressed', 'true');
    await expect(tabs).toHaveCount(1);
    await expect(page.locator('.workspace')).toBeVisible();
    const g = await box(page, '.tabbar-settings');
    const w = await box(page, '.settings');
    expect(Math.abs(w.x + w.width - (g.x + g.width))).toBeLessThanOrEqual(8);
    // The gear again, Esc, its ×, a press elsewhere: each closes it.
    await gear.click();
    await expect(win).toHaveCount(0);
    await expect(gear).toHaveAttribute('aria-pressed', 'false');
    await gear.click();
    await page.keyboard.press('Escape');
    await expect(win).toHaveCount(0);
    await gear.click();
    await win.getByRole('button', { name: 'Закрыть настройки' }).click();
    await expect(win).toHaveCount(0);
    await gear.click();
    await page.mouse.click(500, 500);
    await expect(win).toHaveCount(0);
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
