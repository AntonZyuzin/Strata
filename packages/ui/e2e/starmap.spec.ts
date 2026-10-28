import { expect, type Page, test } from '@playwright/test';
import { box, overflowing } from './helpers';

// The star map's line of the MVP (08 §1.2, 16 §4.2 item 5): 04 S6, steps 1–6
// and 8, without 2D — fly, find, read the cards, create, enter; flags,
// removal, pins, grab and throw, quick marks, the bridge straight into
// another network, quality presets. On the WASM core in the browser.

interface MapHook {
  state: string;
  still: boolean;
  selectedId(): string | null;
  hoveredId(): string | null;
  focusId(): string | null;
  idNamed(name: string): string | null;
  screenOf(id: string): { x: number; y: number } | null;
  placeOf(id: string): [number, number, number] | null;
  cards(): { brief: string[]; full: string | null; kept: boolean };
  pinnedIds(): string[];
  flagsOf(id: string): { key: boolean; pause: boolean; template: boolean } | null;
  qualityNow(): { quality: string; bloom: boolean };
  feedFrames(ms: number[]): void;
  cameraNow(): { position: number[]; target: number[] } | null;
}

type Method = {
  [K in keyof MapHook]: MapHook[K] extends (...a: never[]) => unknown ? K : never;
}[keyof MapHook];

/**
 * A call of the map's hook in the page; the workspace spec declares the
 * window's own hook, so this one is reached untyped.
 */
function ask<K extends Method>(
  page: Page,
  method: K,
  ...args: Parameters<MapHook[K]>
): Promise<ReturnType<MapHook[K]>> {
  return page.evaluate(
    ([method, args]) => {
      const ws = (window as unknown as Record<string, { map(): unknown } | undefined>).__strataWs;
      const m = ws?.map() as Record<string, (...a: unknown[]) => unknown> | null | undefined;
      if (!m) throw new Error('no map');
      return m[method]?.(...args);
    },
    [method, args] as const,
  ) as Promise<ReturnType<MapHook[K]>>;
}

/** A field of the map: its state, whether it is still. */
function field(page: Page, name: 'state' | 'still'): Promise<string | boolean | null> {
  return page.evaluate((name) => {
    const ws = (window as unknown as Record<string, { map(): unknown } | undefined>).__strataWs;
    const m = ws?.map() as Record<string, string | boolean> | null | undefined;
    return m ? (m[name] ?? null) : null;
  }, name);
}

/** The workspace's hook: settled, its canvas, the core's wires, the graph's flags. */
function ws<T>(page: Page, what: 'settled' | 'focus' | 'wires' | 'net' | 'flags', arg = '') {
  return page.evaluate(
    async ([what, arg]) => {
      const w = (window as unknown as Record<string, Record<string, unknown> | undefined>)
        .__strataWs as unknown as {
        settled(): Promise<void>;
        view: { canvas: HTMLCanvasElement };
        core: { wires(): Promise<{ from: string; to: string }[]> };
        net(): string;
        graph(): { nodes: Map<string, { name: string; key: boolean; pause: boolean }> } | null;
      };
      if (what === 'settled') return w.settled();
      if (what === 'focus') return w.view.canvas.focus();
      if (what === 'wires') return w.core.wires();
      if (what === 'net') return w.net();
      const n = [...(w.graph()?.nodes.values() ?? [])].find((x) => x.name === arg);
      return n ? { key: n.key, pause: n.pause } : null;
    },
    [what, arg] as const,
  ) as Promise<T>;
}

async function createWorkspace(page: Page, name: string) {
  await page.locator('.home-new').click();
  await page.locator('.dialog .field').fill(name);
  await page.locator('.dialog button[type="submit"]').click();
  await expect(page.locator('.workspace')).toBeVisible();
  await expect(page.locator('.workspace')).toHaveAttribute('data-depth', '1', {
    timeout: 15_000,
  });
}

/** A node through the Tab menu at a free spot; `kind` — a row of the menu to choose first. */
async function createNode(page: Page, x: number, y: number, name: string, kind?: string) {
  const space = page.locator('.workspace');
  const before = Number(await space.getAttribute('data-nodes'));
  await page.mouse.move(x, y);
  await page.keyboard.press('Tab');
  await expect(page.locator('.tab-menu')).toBeVisible();
  if (kind) {
    await page.keyboard.type(kind);
    await page.locator('.tab-menu-row', { hasText: kind }).first().click();
  }
  await page.keyboard.type(name);
  await page.keyboard.press('Enter');
  await expect(page.locator('.tab-menu')).toHaveCount(0);
  await expect(space).toHaveAttribute('data-nodes', String(before + 1));
  await page.keyboard.press('Escape');
}

async function toMap(page: Page) {
  await ws(page, 'settled');
  await ws(page, 'focus');
  await page.keyboard.press('KeyM');
  await expect(page.locator('.workspace')).toHaveAttribute('data-view', '3d', {
    timeout: 30_000,
  });
  await expect.poll(() => field(page, 'still')).toBe(true);
}

/** `Ctrl+O` on the map: a flight to the star named `name`; it is selected. */
async function flyTo(page: Page, name: string): Promise<string> {
  await page.keyboard.press('Control+o');
  const search = page.locator('.map-search input');
  await expect(search).toBeFocused();
  await search.fill(name);
  await expect(page.locator('.map-search .tab-menu-row').first()).toContainText(name);
  await search.press('Enter');
  await expect(page.locator('.map-search')).toHaveCount(0);
  const id = await ask(page, 'idNamed', name);
  if (!id) throw new Error(`no star ${name}`);
  await expect.poll(() => ask(page, 'selectedId')).toBe(id);
  await expect.poll(() => field(page, 'still')).toBe(true);
  return id;
}

/** The pointer on a star, until the map says it is under it. */
async function hover(page: Page, id: string) {
  const p = await ask(page, 'screenOf', id);
  if (!p) throw new Error('not drawn');
  await page.mouse.move(p.x, p.y);
  await expect.poll(() => ask(page, 'hoveredId')).toBe(id);
}

const dist = (a: readonly number[], b: readonly number[]) =>
  Math.hypot((a[0] ?? 0) - (b[0] ?? 0), (a[1] ?? 0) - (b[1] ?? 0), (a[2] ?? 0) - (b[2] ?? 0));

test.describe('the star map without 2D (04 S6, 08 §1.2)', () => {
  test.use({ viewport: { width: 1280, height: 800 }, locale: 'ru-RU' });

  test('S6: fly, find, read the card, create and enter on the map (steps 1–6, 8)', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await page.goto('/?plain');
    await createWorkspace(page, 'Игра');
    const view = page.locator('.workspace');
    // «Проекты», a folder with «Плейтест» and «Диздок»; «Идея» at the root.
    await createNode(page, 500, 300, 'Проекты', 'Папка');
    await ws(page, 'settled');
    await page.keyboard.press('Enter');
    await expect(view).toHaveAttribute('data-depth', '2');
    await createNode(page, 640, 400, 'Плейтест');
    await createNode(page, 820, 520, 'Диздок');
    await page.keyboard.press('KeyU');
    await expect(view).toHaveAttribute('data-depth', '1');
    await createNode(page, 820, 500, 'Идея');
    // Step 1: to the map.
    await toMap(page);
    // Step 3: the right button held, W flies forward along the look.
    const before = await ask(page, 'cameraNow');
    const box3 = await box(page, '.proto-map');
    await page.mouse.move(box3.x + box3.width / 2, box3.y + box3.height / 2);
    await page.mouse.down({ button: 'right' });
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(400);
    await page.keyboard.up('KeyW');
    await page.mouse.up({ button: 'right' });
    const after = await ask(page, 'cameraNow');
    if (!before || !after) throw new Error('no camera');
    const look = before.target.map((t, i) => t - (before.position[i] ?? 0));
    const moved = after.position.map((p, i) => p - (before.position[i] ?? 0));
    const along = look.reduce((a, l, i) => a + l * (moved[i] ?? 0), 0);
    expect(along).toBeGreaterThan(0);
    // Held longer than a click: no menu (08 §5.4).
    await expect(page.locator('.context-menu')).toHaveCount(0);
    // Step 4: Ctrl+O, a flight on an arc, the star selected.
    const playtest = await flyTo(page, 'Плейтест');
    // Step 5: its full card by it, the name said once.
    const card = page.locator('.map-card.is-full');
    await expect(card.locator('.map-card-name')).toHaveText('Плейтест');
    await expect(card.locator('.map-card-label').first()).toHaveText('Путь');
    await expect(card.locator('.map-card-value').first()).toHaveText('Проекты');
    expect((await ask(page, 'cards')).full).toBe(playtest);
    // Step 6: Tab — the note goes into «Проекты», wired from «Плейтест».
    await page.keyboard.press('Tab');
    await expect(page.locator('.tab-menu-target')).toHaveText('→ Проекты · от «Плейтест»');
    await page.keyboard.type('Итоги плейтеста 1');
    await page.keyboard.press('Enter');
    await expect(page.locator('.tab-menu')).toHaveCount(0);
    await expect.poll(() => ask(page, 'idNamed', 'Итоги плейтеста 1')).not.toBeNull();
    const results = (await ask(page, 'idNamed', 'Итоги плейтеста 1')) as string;
    await expect.poll(() => ask(page, 'selectedId')).toBe(results);
    const wires = await ws<{ from: string; to: string }[]>(page, 'wires');
    expect(wires).toContainEqual({ from: playtest, to: results });
    await expect(view).toHaveAttribute('data-view', '3d');
    // One step of undo: the star goes, the map stays; redo brings it back.
    await page.keyboard.press('Control+z');
    await expect.poll(() => ask(page, 'idNamed', 'Итоги плейтеста 1')).toBeNull();
    await page.keyboard.press('Control+Shift+z');
    await expect.poll(() => ask(page, 'idNamed', 'Итоги плейтеста 1')).toBe(results);
    await expect(view).toHaveAttribute('data-view', '3d');
    // Step 8: Enter on a note — its editor over the map.
    await flyTo(page, 'Итоги плейтеста 1');
    await page.keyboard.press('Enter');
    await expect(page.locator('.note-window h2')).toHaveText('Итоги плейтеста 1');
    await expect(view).toHaveAttribute('data-view', '3d');
    await page.locator('.note-window .window-close').click();
    // Enter on a network: the bridge into it, the new note on its canvas.
    await flyTo(page, 'Проекты');
    await page.keyboard.press('Enter');
    await expect(view).toHaveAttribute('data-view', '2d', { timeout: 30_000 });
    await expect(view).toHaveAttribute('data-depth', '2');
    await expect.poll(() => ws(page, 'flags', 'Итоги плейтеста 1')).not.toBeNull();
  });

  test('flags, pins and removal on the map; undo is the core’s (08 §3.6, §6.7)', async ({
    page,
  }) => {
    test.setTimeout(150_000);
    await page.goto('/?plain');
    await createWorkspace(page, 'Флаги');
    await createNode(page, 500, 320, 'Альфа');
    await createNode(page, 800, 480, 'Бета');
    await toMap(page);
    const alpha = (await ask(page, 'idNamed', 'Альфа')) as string;
    const beta = (await ask(page, 'idNamed', 'Бета')) as string;
    // R, Q, E on the star under the pointer (08 §6.7).
    await hover(page, alpha);
    await page.keyboard.press('KeyR');
    await expect.poll(async () => (await ask(page, 'flagsOf', alpha))?.key).toBe(true);
    await hover(page, alpha);
    await page.keyboard.press('KeyQ');
    await expect.poll(async () => (await ask(page, 'flagsOf', alpha))?.pause).toBe(true);
    await hover(page, alpha);
    await page.keyboard.press('KeyE');
    await expect.poll(async () => (await ask(page, 'flagsOf', alpha))?.template).toBe(true);
    // Ctrl+Z on the map takes the last flag back, the map stays.
    await page.keyboard.press('Control+z');
    await expect.poll(async () => (await ask(page, 'flagsOf', alpha))?.template).toBe(false);
    // B: pinned on this device, with its mark.
    await hover(page, alpha);
    await page.keyboard.press('KeyB');
    await expect.poll(() => ask(page, 'pinnedIds')).toEqual([alpha]);
    await expect(page.locator('.proto-map-pin:not([hidden])')).toHaveCount(1);
    // Shift+click selects without leaving; Delete takes it out of its network.
    const b = await ask(page, 'screenOf', beta);
    if (!b) throw new Error('not drawn');
    await page.keyboard.down('Shift');
    await page.mouse.click(b.x, b.y);
    await page.keyboard.up('Shift');
    await expect.poll(() => ask(page, 'selectedId')).toBe(beta);
    await expect(page.locator('.workspace')).toHaveAttribute('data-view', '3d');
    await page.keyboard.press('Delete');
    await expect.poll(() => ask(page, 'idNamed', 'Бета')).toBeNull();
    await expect(page.locator('.toast', { hasText: 'В корзине' })).toHaveCount(1);
    // The menu of a star: its flags ticked, «Закрепить на карте» too.
    const a = await ask(page, 'screenOf', alpha);
    if (!a) throw new Error('not drawn');
    await page.mouse.click(a.x, a.y, { button: 'right' });
    const menu = page.locator('.context-menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitemcheckbox', { name: /Ключевая/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(
      menu.getByRole('menuitemcheckbox', { name: /Закрепить на карте/ }),
    ).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Escape');
    // Back in 2D: the canvas has read the steps of the map.
    await page.keyboard.press('KeyM');
    await expect(page.locator('.workspace')).toHaveAttribute('data-view', '2d', {
      timeout: 30_000,
    });
    await expect.poll(() => ws(page, 'flags', 'Альфа')).toEqual({ key: true, pause: true });
    await expect.poll(() => ws(page, 'flags', 'Бета')).toBeNull();
    // The pin outlives a reload: it is the device's (08 §3.5).
    await page.reload();
    await page.locator('.tab', { hasText: 'Флаги' }).click();
    await expect(page.locator('.workspace')).toHaveAttribute('data-depth', '1', {
      timeout: 15_000,
    });
    await toMap(page);
    expect(await ask(page, 'pinnedIds')).toEqual([alpha]);
  });

  test('a star is grabbed and thrown, and Shift pins it where it is let go (08 §3.6)', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.goto('/?plain');
    await createWorkspace(page, 'Бросок');
    await createNode(page, 520, 320, 'Камень');
    await createNode(page, 760, 460, 'Галька');
    await toMap(page);
    const stone = (await ask(page, 'idNamed', 'Камень')) as string;
    const before = (await ask(page, 'placeOf', stone)) as number[];
    const s = await ask(page, 'screenOf', stone);
    if (!s) throw new Error('not drawn');
    await page.mouse.move(s.x, s.y);
    await page.mouse.down();
    for (let k = 1; k <= 8; k++) await page.mouse.move(s.x + 15 * k, s.y + 8 * k);
    const held = (await ask(page, 'placeOf', stone)) as number[];
    expect(dist(held, before)).toBeGreaterThan(5);
    await page.mouse.up();
    // A click is not what it was: still in 3D, nothing selected.
    await expect(page.locator('.workspace')).toHaveAttribute('data-view', '3d');
    await expect.poll(() => field(page, 'still'), { timeout: 20_000 }).toBe(true);
    const rest = (await ask(page, 'placeOf', stone)) as number[];
    expect(dist(rest, before)).toBeGreaterThan(1);
    // Shift at the let-go: pinned there, and it stays.
    const p = await ask(page, 'screenOf', stone);
    if (!p) throw new Error('not drawn');
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    for (let k = 1; k <= 6; k++) await page.mouse.move(p.x - 12 * k, p.y + 4 * k);
    await page.keyboard.down('Shift');
    await page.mouse.up();
    await page.keyboard.up('Shift');
    await expect.poll(() => ask(page, 'pinnedIds')).toEqual([stone]);
    await expect.poll(() => field(page, 'still'), { timeout: 20_000 }).toBe(true);
    const pinned = (await ask(page, 'placeOf', stone)) as number[];
    await page.waitForTimeout(500);
    expect(dist((await ask(page, 'placeOf', stone)) as number[], pinned)).toBeLessThan(0.01);
  });

  test('quick marks on the map, and the bridge straight into another network (09 §6.2, 08 §7.2)', async ({
    page,
  }) => {
    test.setTimeout(150_000);
    await page.goto('/?plain');
    await createWorkspace(page, 'Метки');
    const view = page.locator('.workspace');
    await createNode(page, 500, 300, 'Арт', 'Папка');
    await ws(page, 'settled');
    await page.keyboard.press('Enter');
    await expect(view).toHaveAttribute('data-depth', '2');
    await createNode(page, 640, 400, 'Эскиз');
    const art = await ws<string>(page, 'net');
    // ★1 — «Арт» in 2D.
    await page.keyboard.press('Control+1');
    await page.keyboard.press('KeyU');
    await expect(view).toHaveAttribute('data-depth', '1');
    await createNode(page, 820, 500, 'Идея');
    const root = await ws<string>(page, 'net');
    await toMap(page);
    // ★2 — the map with «Арт» in focus, its camera.
    await flyTo(page, 'Арт');
    await page.keyboard.press('KeyI');
    await expect.poll(() => ask(page, 'focusId')).toBe(art);
    await expect.poll(() => field(page, 'still')).toBe(true);
    const marked = await ask(page, 'cameraNow');
    await page.keyboard.press('Control+2');
    // The marks show on the map too, under the path (06 §10.3).
    await expect(page.locator('.ws-mark')).toHaveCount(2);
    // H: the whole space; 2 flies back to the mark.
    await page.keyboard.press('KeyH');
    await expect.poll(() => ask(page, 'focusId')).toBe(root);
    await expect.poll(() => field(page, 'still')).toBe(true);
    await page.keyboard.press('Digit2');
    await expect.poll(() => ask(page, 'focusId')).toBe(art);
    await expect.poll(() => field(page, 'still')).toBe(true);
    const back = await ask(page, 'cameraNow');
    if (!back || !marked) throw new Error('no camera');
    expect(dist(back.position, marked.position)).toBeLessThan(1);
    // 1 from the map: the canvas loads «Арт» under the map, the bridge lands
    // there — never in the root on the way (08 §7.2).
    await page.evaluate(() => {
      const log: [string, string][] = [];
      (window as unknown as Record<string, unknown>).__bridgeLog = log;
      const w = (window as unknown as Record<string, unknown>).__strataWs as {
        net(): string;
        map(): { state: string } | null;
      };
      const tick = () => {
        log.push([w.map()?.state ?? '', w.net()]);
        if (log.length < 400) requestAnimationFrame(tick);
      };
      tick();
    });
    await page.keyboard.press('Digit1');
    await expect(view).toHaveAttribute('data-view', '2d', { timeout: 30_000 });
    await expect(view).toHaveAttribute('data-depth', '2');
    const log = await page.evaluate(
      () => (window as unknown as Record<string, [string, string][]>).__bridgeLog,
    );
    const shown2d = (log ?? []).filter(([state]) => state === '2d').map(([, net]) => net);
    expect(shown2d.length).toBeGreaterThan(0);
    expect(new Set(shown2d)).toEqual(new Set([art]));
  });

  test('the quality: the first frames choose it, the menu and the palette set it (08 §8.4, NFR-19)', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    // Measured before as «Экономия»: frames this slow there turn the map off.
    await page.addInitScript(() => {
      if (!sessionStorage.getItem('quality-set')) {
        localStorage.setItem(
          'strata.map.quality',
          JSON.stringify({ manual: null, auto: 'economy' }),
        );
        sessionStorage.setItem('quality-set', '1');
      }
    });
    await page.goto('/?plain');
    await createWorkspace(page, 'Качество');
    await createNode(page, 640, 400, 'Звезда');
    await toMap(page);
    expect(await ask(page, 'qualityNow')).toEqual({ quality: 'economy', bloom: false });
    await ask(
      page,
      'feedFrames',
      Array.from({ length: 120 }, () => 60),
    );
    expect((await ask(page, 'qualityNow')).quality).toBe('off');
    // Off: M leaves the map, and the next M says why instead of opening it.
    await page.keyboard.press('KeyM');
    await expect(page.locator('.workspace')).toHaveAttribute('data-view', '2d', {
      timeout: 30_000,
    });
    await ws(page, 'focus');
    await page.keyboard.press('KeyM');
    await expect(page.locator('.toast', { hasText: 'Звёздная карта выключена' })).toHaveCount(1);
    await expect(page.locator('.workspace')).toHaveAttribute('data-view', '2d');
    // The palette turns it on by hand: «высокое» — with bloom.
    await page.keyboard.press('Control+p');
    await page.locator('.command-palette input').fill('качество карты высокое');
    await expect(page.locator('.command-palette .tab-menu-row').first()).toContainText(
      'Качество карты: высокое',
    );
    await page.keyboard.press('Enter');
    await toMap(page);
    expect(await ask(page, 'qualityNow')).toEqual({ quality: 'high', bloom: true });
    // The map's menu: «среднее» by hand, without bloom; the hand's choice
    // stays whatever the frames say.
    const r = await box(page, '.proto-map');
    await page.mouse.click(r.x + 40, r.y + 40, { button: 'right' });
    await page.locator('.context-menu').getByText('Качество карты: среднее').click();
    expect(await ask(page, 'qualityNow')).toEqual({ quality: 'medium', bloom: false });
    await ask(
      page,
      'feedFrames',
      Array.from({ length: 120 }, () => 5),
    );
    expect((await ask(page, 'qualityNow')).quality).toBe('medium');
  });
});

for (const deviceScaleFactor of [1, 2]) {
  test(`the star map's cards keep their size in RU and EN @${deviceScaleFactor}x (08 §6.2)`, async ({
    browser,
  }) => {
    test.setTimeout(150_000);
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
      await createNode(page, 520, 320, 'Звезда с очень длинным именем для проверки справки');
      await createNode(page, 700, 420, 'Соседка');
      await createNode(page, 860, 520, 'Ещё одна');
      await toMap(page);
      await flyTo(page, 'Звезда с очень длинным именем для проверки справки');
      const card = '.map-card.is-full';
      await expect(page.locator(`${card} .map-card-rows`)).toBeVisible();
      expect(await overflowing(page, card), `${locale} the card must fit`).toEqual([]);
      expect(await overflowing(page, '.map-card.is-brief'), `${locale} brief cards`).toEqual([]);
      boxes.push({
        card: await box(page, card),
        title: await box(page, `${card} .map-card-title`),
        rows: await box(page, `${card} .map-card-rows`),
      });
      await context.close();
    }
    const [ru, en] = boxes as [(typeof boxes)[number], (typeof boxes)[number]];
    for (const part of ['card', 'title', 'rows'] as const) {
      for (const k of ['width', 'height'] as const) {
        expect(Math.abs(en[part][k] - ru[part][k]), `${part} ${k}`).toBeLessThanOrEqual(0.5);
      }
    }
  });
}
