import { type Browser, expect, type Page, test } from '@playwright/test';
import { type MessageKey, t } from '@strata/i18n';
import { box, overflowing, SCALES, VIEWPORTS } from './helpers';

// Canvas prototype (16 §3.2 step 0.3). Layout: the top window, the status bar
// and the Tab menu keep their boxes in RU and EN and nothing is cut. Gestures:
// real pointer and keyboard input against the editor, checked on the graph
// through the test hook `window.__strataProto` (06 §5–6, 05 §8).

const HINTS: MessageKey[] = [
  'proto.hint.empty',
  'proto.hint.node',
  'proto.hint.port',
  'proto.hint.wire',
  'proto.hint.drag',
  'proto.hint.dragInsert',
  'proto.hint.wireDrag',
  'proto.hint.marquee',
];

interface Pt {
  x: number;
  y: number;
  r: number;
}

interface Hook {
  view: {
    canvas: HTMLCanvasElement;
    camera: { zoom: number; toScreen(x: number, y: number): { x: number; y: number } };
    nodeAt(id: string): Pt | null;
    eachNode(): Iterable<[string, Pt]>;
  };
  graph: {
    nodes: Map<string, { id: string; name: string }>;
    edges(): [string, string][];
    inputs(id: string): Iterable<string>;
    outputs(id: string): Iterable<string>;
    hasEdge(a: string, b: string): boolean;
  };
}

interface Probe {
  screen(x: number, y: number): { x: number; y: number };
  node(id: string): Pt;
  bubbles(): (Pt & { id: string })[];
  free(x: number, y: number, margin?: number): boolean;
}

declare global {
  interface Window {
    __strataProto?: Hook;
    __e2e?: Probe;
  }
}

async function open(page: Page) {
  await page.goto('/?proto');
  await page.waitForFunction(() => window.__strataProto !== undefined);
  await expect(page.locator('.proto')).toHaveAttribute('data-nodes', '200');
  await installProbe(page);
}

async function openIn(
  browser: Browser,
  locale: string,
  viewport: { width: number; height: number },
  deviceScaleFactor: number,
) {
  const context = await browser.newContext({ locale, viewport, deviceScaleFactor });
  const page = await context.newPage();
  await open(page);
  return { context, page };
}

/** Screen position and radius of a node, in page CSS px. */
function screenOf(page: Page, id: string): Promise<Pt> {
  return page.evaluate((id) => (window.__e2e as Probe).node(id), id);
}

const counts = (page: Page) =>
  page.evaluate(() => {
    const { graph } = window.__strataProto as Hook;
    return { nodes: graph.nodes.size, edges: graph.edges().length };
  });

/** Creates a note through the Tab menu at (x, y) and returns its id. */
async function createNote(page: Page, x: number, y: number, name: string): Promise<string> {
  const before = await counts(page);
  await page.mouse.move(x, y);
  await page.keyboard.press('Tab');
  await expect(page.locator('.tab-menu')).toBeVisible();
  await page.keyboard.type(name);
  await page.keyboard.press('Enter');
  await expect(page.locator('.tab-menu')).toHaveCount(0);
  await expect(page.locator('.proto')).toHaveAttribute('data-nodes', String(before.nodes + 1));
  return page.evaluate((name) => {
    const { graph } = window.__strataProto as Hook;
    const n = [...graph.nodes.values()].find((x) => x.name === name);
    if (!n) throw new Error(`no node named ${name}`);
    return n.id;
  }, name);
}

/**
 * Installs `window.__e2e`: screen positions of bubbles and whether a point is
 * the bare canvas, not the Chrome over it. Coordinates are page CSS px.
 */
async function installProbe(page: Page) {
  await page.evaluate(() => {
    const { view } = window.__strataProto as Hook;
    const screen = (x: number, y: number) => {
      const s = view.camera.toScreen(x, y);
      const rect = view.canvas.getBoundingClientRect();
      return { x: rect.left + s.x, y: rect.top + s.y };
    };
    window.__e2e = {
      screen,
      node(id) {
        const n = view.nodeAt(id);
        if (!n) throw new Error(`no node ${id}`);
        return { ...screen(n.x, n.y), r: n.r * view.camera.zoom };
      },
      bubbles: () =>
        [...view.eachNode()].map(([id, n]) => ({
          id,
          ...screen(n.x, n.y),
          r: n.r * view.camera.zoom,
        })),
      // The point and a margin around it are the canvas itself.
      free: (x, y, m = 0) =>
        [
          [0, 0],
          [m, 0],
          [-m, 0],
          [0, m],
          [0, -m],
        ].every(([dx = 0, dy = 0]) => document.elementFromPoint(x + dx, y + dy) === view.canvas),
    };
  });
}

/** A screen point at least `clear` px from every bubble, on the bare canvas. */
function emptySpot(page: Page, clear: number): Promise<{ x: number; y: number }> {
  return page.evaluate((clear) => {
    const e = window.__e2e as Probe;
    const pts = e.bubbles();
    let best = { x: 0, y: 0, d: -1 };
    // 60 px inside the canvas: a node near its edge would move the camera (06 §3).
    const rect = (window.__strataProto as Hook).view.canvas.getBoundingClientRect();
    for (let y = rect.top + 60; y < rect.bottom - 60; y += 10) {
      for (let x = rect.left + 60; x < rect.right - 60; x += 10) {
        if (!e.free(x, y, 30)) continue;
        const d = Math.min(...pts.map((p) => Math.hypot(p.x - x, p.y - y) - p.r));
        if (d > best.d) best = { x, y, d };
      }
    }
    if (best.d < clear) throw new Error(`no empty spot, best ${best.d}`);
    return { x: best.x, y: best.y };
  }, clear);
}

/** Moves in small steps so the editor sees a drag, not a jump. */
async function glide(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(
      from.x + ((to.x - from.x) * i) / steps,
      from.y + ((to.y - from.y) * i) / steps,
    );
  }
}

for (const viewport of VIEWPORTS) {
  for (const deviceScaleFactor of SCALES) {
    test(`prototype Chrome is locale-independent at ${viewport.width}×${viewport.height} @${deviceScaleFactor}x`, async ({
      browser,
    }, info) => {
      const ru = await openIn(browser, 'ru-RU', viewport, deviceScaleFactor);
      const en = await openIn(browser, 'en-US', viewport, deviceScaleFactor);
      const parts = ['.proto-top', '.proto-status', '.proto-status button:first-of-type'];
      for (const side of [ru, en]) {
        expect(await overflowing(side.page, '.proto-top, .proto-status')).toEqual([]);
        // The Tab menu at the centre of the canvas, empty query: kinds and classes.
        await side.page.mouse.move(viewport.width / 2, viewport.height / 2);
        await side.page.keyboard.press('Tab');
        await expect(side.page.locator('.tab-menu')).toBeVisible();
        expect(await overflowing(side.page, '.tab-menu')).toEqual([]);
        const menu = await box(side.page, '.tab-menu');
        expect(menu.width).toBeCloseTo(360, 0);
        // Clamped into the canvas: the status bar stays visible.
        expect(menu.y + menu.height).toBeLessThanOrEqual((await box(side.page, '.proto-status')).y);
      }
      await ru.page.screenshot({ path: info.outputPath('ru.png') });
      await en.page.screenshot({ path: info.outputPath('en.png') });
      for (const sel of [...parts, '.tab-menu']) {
        const a = await box(ru.page, sel);
        const b = await box(en.page, sel);
        for (const k of ['x', 'y', 'width', 'height'] as const) {
          expect(
            Math.abs(a[k] - b[k]),
            `${sel} ${k}: RU ${a[k]} vs EN ${b[k]}`,
          ).toBeLessThanOrEqual(0.5);
        }
      }
      // Every hint of the status bar fits in both languages at this width.
      for (const [side, lang] of [
        [ru, 'ru'],
        [en, 'en'],
      ] as const) {
        const texts = HINTS.map((k) => t(lang, k));
        const cut = await side.page.locator('.proto-status .hint').evaluate((el, texts) => {
          const keep = el.textContent;
          const out = texts.filter((text) => {
            el.textContent = text;
            return el.scrollWidth > el.clientWidth + 1;
          });
          el.textContent = keep;
          return out;
        }, texts);
        expect(cut, `${lang} hints cut at ${viewport.width} px`).toEqual([]);
      }
      await ru.context.close();
      await en.context.close();
    });
  }
}

test.describe('gestures', () => {
  test.use({ viewport: { width: 1280, height: 800 }, locale: 'ru-RU' });

  test('Tab menu creates a named note, Ctrl+Z takes it back', async ({ page }) => {
    await open(page);
    const start = await counts(page);
    const spot = await emptySpot(page, 40);
    const id = await createNote(page, spot.x, spot.y, 'Проверка');
    await expect(page.locator('.proto-status .last-step')).toContainText('Проверка');
    const at = await screenOf(page, id);
    expect(Math.hypot(at.x - spot.x, at.y - spot.y)).toBeLessThan(120);
    await page.keyboard.press('Control+z');
    expect(await counts(page)).toEqual(start);
    await page.keyboard.press('Control+Shift+z');
    expect((await counts(page)).nodes).toBe(start.nodes + 1);
  });

  test('a wire dragged from the rim into empty space makes a named note', async ({ page }) => {
    await open(page);
    const start = await counts(page);
    const spot = await emptySpot(page, 50);
    // The port ring is just outside the bubble (06 §1.3): press there, below
    // a bubble with no other bubble close to that point.
    const { src, press } = await page.evaluate(() => {
      const e = window.__e2e as Probe;
      const all = e.bubbles();
      for (const a of all) {
        const ring = Math.max(8, 0.25 * a.r);
        const press = { x: a.x, y: a.y + Math.max(a.r, 12) + ring / 2 };
        if (!e.free(press.x, press.y, 20)) continue;
        const near = all.some(
          (b) => b.id !== a.id && Math.hypot(b.x - press.x, b.y - press.y) < b.r + 40,
        );
        if (!near) return { src: a.id, press };
      }
      throw new Error('no free port');
    });
    await page.mouse.move(press.x, press.y);
    await page.mouse.down();
    await glide(page, press, spot);
    await page.mouse.up();
    const input = page.locator('.name-input');
    await expect(input).toBeVisible();
    await input.fill('Хвост');
    await input.press('Enter');
    await expect(input).toHaveCount(0);
    const made = await page.evaluate((src) => {
      const { graph } = window.__strataProto as Hook;
      const n = [...graph.nodes.values()].find((x) => x.name === 'Хвост');
      return n ? graph.hasEdge(src, n.id) : false;
    }, src);
    expect(made).toBe(true);
    expect(await counts(page)).toEqual({ nodes: start.nodes + 1, edges: start.edges + 1 });
    // Creating and naming is one step (05 §8.4).
    await page.keyboard.press('Control+z');
    expect(await counts(page)).toEqual(start);
  });

  test('a free node dropped on a wire is inserted into it', async ({ page }) => {
    await open(page);
    const start = await counts(page);
    const spot = await emptySpot(page, 40);
    const x = await createNote(page, spot.x, spot.y, 'Вставка');
    // The longest wire on screen with nothing else near its middle.
    const wire = await page.evaluate((x) => {
      const { view, graph } = window.__strataProto as Hook;
      const e = window.__e2e as Probe;
      const nodes = [...view.eachNode()];
      let best: { from: string; to: string; mx: number; my: number; len: number } | null = null;
      for (const [from, to] of graph.edges()) {
        const a = view.nodeAt(from);
        const b = view.nodeAt(to);
        if (!a || !b) continue;
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        const ux = (b.x - a.x) / len;
        const uy = (b.y - a.y) / len;
        // Middle of the cubic of 06 §6.2: the middle of its ends on the circles.
        const mx = (a.x + ux * (a.r + 1) + b.x - ux * (b.r + 1)) / 2;
        const my = (a.y + uy * (a.r + 1) + b.y - uy * (b.r + 1)) / 2;
        const s = e.screen(mx, my);
        if (!e.free(s.x, s.y, 40)) continue;
        const crowded = nodes.some(
          ([id, n]) => id !== x && Math.hypot(n.x - mx, n.y - my) < n.r + 60,
        );
        if (!crowded && (!best || len > best.len)) best = { from, to, mx, my, len };
      }
      if (!best) throw new Error('no free wire');
      const s = e.screen(best.mx, best.my);
      return { from: best.from, to: best.to, x: s.x, y: s.y };
    }, x);
    const a = await screenOf(page, x);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await glide(page, a, wire);
    // Held over the wire for 200 ms (06 §6.4).
    await page.waitForTimeout(350);
    await page.mouse.move(wire.x + 1, wire.y);
    await page.mouse.up();
    const after = await page.evaluate(
      ({ x, from, to }) => {
        const { graph } = window.__strataProto as Hook;
        return [graph.hasEdge(from, x), graph.hasEdge(x, to), graph.hasEdge(from, to)];
      },
      { x, from: wire.from, to: wire.to },
    );
    expect(after).toEqual([true, true, false]);
    expect(await counts(page)).toEqual({ nodes: start.nodes + 1, edges: start.edges + 1 });
    await expect(page.locator('.proto-status .last-step')).toContainText('Вставить');
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+z');
    expect(await counts(page)).toEqual(start);
  });

  test('shaking a node in a chain detaches it and heals the chain', async ({ page }) => {
    await open(page);
    const start = await counts(page);
    // One input, one output, and no wire yet between the two ends (05 §8.4).
    const pick = await page.evaluate(() => {
      const { graph } = window.__strataProto as Hook;
      const e = window.__e2e as Probe;
      for (const id of graph.nodes.keys()) {
        const p = e.node(id);
        if (!e.free(p.x, p.y, 70)) continue;
        const ins = [...graph.inputs(id)];
        const outs = [...graph.outputs(id)];
        const [i] = ins;
        const [o] = outs;
        if (ins.length === 1 && outs.length === 1 && i && o && i !== o && !graph.hasEdge(i, o)) {
          return { id, from: i, to: o };
        }
      }
      throw new Error('no chain node');
    });
    const p = await screenOf(page, pick.id);
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    // Four reversals of 40 px and more, fast (06 §6.5). Holding 8 keeps the
    // node from being dropped back onto the healed wire.
    await page.keyboard.down('8');
    for (let i = 0; i < 6; i++) {
      await page.mouse.move(p.x + (i % 2 === 0 ? 45 : -45), p.y, { steps: 2 });
    }
    await page.mouse.move(p.x, p.y - 60, { steps: 3 });
    await page.mouse.up();
    await page.keyboard.up('8');
    const after = await page.evaluate(({ id, from, to }) => {
      const { graph } = window.__strataProto as Hook;
      return {
        ins: [...graph.inputs(id)].length,
        outs: [...graph.outputs(id)].length,
        healed: graph.hasEdge(from, to),
      };
    }, pick);
    expect(after).toEqual({ ins: 0, outs: 0, healed: true });
    expect(await counts(page)).toEqual({ nodes: start.nodes, edges: start.edges - 1 });
    await page.keyboard.press('Control+z');
    expect(await counts(page)).toEqual(start);
  });
});
