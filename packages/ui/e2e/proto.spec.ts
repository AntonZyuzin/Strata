import { type Browser, expect, type Page, test } from '@playwright/test';
import { type MessageKey, t } from '@strata/i18n';
import { box, chWidth, LAYOUTS, overflowing } from './helpers';

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
  'proto.hint.map',
];

interface Pt {
  x: number;
  y: number;
  r: number;
}

interface Hook {
  view: {
    canvas: HTMLCanvasElement;
    camera: {
      x: number;
      y: number;
      zoom: number;
      toScreen(x: number, y: number): { x: number; y: number };
    };
    nodeAt(id: string): Pt | null;
    eachNode(): Iterable<[string, Pt]>;
    invalidate(): void;
  };
  graph: {
    nodes: Map<string, { id: string; name: string } & Record<string, unknown>>;
    edges(): [string, string][];
    inputs(id: string): Iterable<string>;
    outputs(id: string): Iterable<string>;
    hasEdge(a: string, b: string): boolean;
  };
  /** Time of the last `L` in the worker, ms. */
  layoutMs(): number | null;
  /** The open board's scene (BoardHandle). */
  board?: {
    elements(): { type: string; strokeColor?: string; backgroundColor?: string }[];
    activeTool(): string;
    files(): string[];
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

/** Gestures run on the plain scene: no background, so software WebGL keeps up. */
async function open(page: Page, plain = true) {
  await page.goto(plain ? '/?proto&plain' : '/?proto');
  await page.waitForFunction(() => window.__strataProto !== undefined);
  await expect(page.locator('.proto')).toHaveAttribute('data-nodes', '220');
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
  await open(page, false);
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

for (const { viewport, deviceScaleFactor } of LAYOUTS) {
  test(`prototype Chrome is locale-independent at ${viewport.width}×${viewport.height} @${deviceScaleFactor}x`, async ({
    browser,
  }, info) => {
    const ru = await openIn(browser, 'ru-RU', viewport, deviceScaleFactor);
    const en = await openIn(browser, 'en-US', viewport, deviceScaleFactor);
    const parts = ['.proto-top', '.proto-status', '.proto-status button:first-of-type'];
    for (const side of [ru, en]) {
      expect(await overflowing(side.page, '.proto-top, .proto-status')).toEqual([]);
      // The Tab menu at the centre of the canvas, empty query: the kinds.
      await side.page.mouse.move(viewport.width / 2, viewport.height / 2);
      await side.page.keyboard.press('Tab');
      await expect(side.page.locator('.tab-menu')).toBeVisible();
      expect(await overflowing(side.page, '.tab-menu')).toEqual([]);
      const menu = await box(side.page, '.tab-menu');
      // 52 ch of the UI font: 364 px at DPR 1 and 2, wider with the pixel font at 1.25 and 1.5.
      expect(Math.abs(menu.width - (await chWidth(side.page, 52)))).toBeLessThanOrEqual(0.5);
      // Clamped into the canvas: the status bar stays visible.
      expect(menu.y + menu.height).toBeLessThanOrEqual((await box(side.page, '.proto-status')).y);
    }
    await ru.page.screenshot({ path: info.outputPath('ru.png') });
    await en.page.screenshot({ path: info.outputPath('en.png') });
    for (const sel of [...parts, '.tab-menu']) {
      const a = await box(ru.page, sel);
      const b = await box(en.page, sel);
      for (const k of ['x', 'y', 'width', 'height'] as const) {
        expect(Math.abs(a[k] - b[k]), `${sel} ${k}: RU ${a[k]} vs EN ${b[k]}`).toBeLessThanOrEqual(
          0.5,
        );
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

for (const { viewport, deviceScaleFactor } of LAYOUTS) {
  test(`the note window is locale-independent at ${viewport.width}×${viewport.height} @${deviceScaleFactor}x`, async ({
    browser,
  }) => {
    const sides = [];
    for (const locale of ['ru-RU', 'en-US']) {
      const side = await openIn(browser, locale, viewport, deviceScaleFactor);
      // The gallery's first look, «Обычная» / «Default», is a note.
      const at = await side.page.evaluate(() => {
        const { graph } = window.__strataProto as Hook;
        const first = [...graph.nodes.values()].slice(-20)[0];
        if (!first) throw new Error('no gallery');
        return (window.__e2e as Probe).node(first.id);
      });
      await side.page.mouse.dblclick(at.x, at.y);
      await expect(side.page.locator('.note-window')).toBeVisible();
      expect(await overflowing(side.page, '.note-window')).toEqual([]);
      sides.push(side);
    }
    const [ru, en] = sides as [(typeof sides)[number], (typeof sides)[number]];
    const a = await box(ru.page, '.note-window');
    const b = await box(en.page, '.note-window');
    for (const k of ['x', 'y', 'width', 'height'] as const) {
      expect(Math.abs(a[k] - b[k]), `note window ${k}`).toBeLessThanOrEqual(0.5);
    }
    await ru.context.close();
    await en.context.close();
  });
}

/** The gallery's board, «Доска» / «Board», brought clear of the top window. */
async function galleryBoard(page: Page): Promise<Pt & { id: string }> {
  const at = await page.evaluate(() => {
    const { graph, view } = window.__strataProto as Hook;
    const b = [...graph.nodes.values()].slice(-20).find((n) => n.kind === 'board');
    const p = b && view.nodeAt(b.id);
    if (!b || !p) throw new Error('no board in the gallery');
    // The small window does not show the whole gallery; the top window
    // covers the top left, so the board goes below and right of the middle.
    const { camera, canvas } = view;
    camera.x = p.x - (canvas.clientWidth * 0.65) / camera.zoom;
    camera.y = p.y - (canvas.clientHeight * 0.7) / camera.zoom;
    view.invalidate();
    const e = window.__e2e as Probe;
    const at = e.node(b.id);
    if (!e.free(at.x, at.y, 4)) throw new Error('the board is under the Chrome');
    return { id: b.id, ...at };
  });
  // The camera's move on screen before the double click.
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );
  return at;
}

/** Excalidraw's chunk loads on the first board: slow on CI's software rendering. */
const BOARD_LOAD = { timeout: 30_000 };

for (const { viewport, deviceScaleFactor } of LAYOUTS) {
  test(`the board window is locale-independent at ${viewport.width}×${viewport.height} @${deviceScaleFactor}x`, async ({
    browser,
  }) => {
    test.setTimeout(90_000);
    const sides = [];
    for (const locale of ['ru-RU', 'en-US']) {
      const side = await openIn(browser, locale, viewport, deviceScaleFactor);
      const at = await galleryBoard(side.page);
      await side.page.mouse.dblclick(at.x, at.y);
      await expect(side.page.locator('.board-window')).toBeVisible();
      await expect(side.page.locator('.board-window .excalidraw')).toBeVisible(BOARD_LOAD);
      // Strata's Chrome only: Excalidraw's own DOM is not ours to measure.
      expect(
        await overflowing(
          side.page,
          '.board-window .window-title, .board-window .board-tools, .board-window .board-colors',
        ),
      ).toEqual([]);
      sides.push(side);
    }
    const [ru, en] = sides as [(typeof sides)[number], (typeof sides)[number]];
    for (const sel of ['.board-window', '.board-tools', '.board-stage', '.board-colors']) {
      const a = await box(ru.page, sel);
      const b = await box(en.page, sel);
      for (const k of ['x', 'y', 'width', 'height'] as const) {
        expect(Math.abs(a[k] - b[k]), `${sel} ${k}`).toBeLessThanOrEqual(0.5);
      }
    }
    await ru.context.close();
    await en.context.close();
  });
}

test('backgrounds keep the Scene readable: every preset and a white photo (07 §7, §2.2)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page, false);
  const p95 = () =>
    page.evaluate(
      () =>
        (window.__strataProto as unknown as { view: { background: { p95: number } } }).view
          .background.p95,
    );
  for (const id of ['depth', 'dusk', 'dust', 'fog']) {
    await page.locator(`.proto-bg label:has(input[value="${id}"])`).click();
    await expect(page.locator(`.proto-bg input[value="${id}"]`)).toBeChecked();
    expect(await p95(), id).toBeLessThan(0.13);
    await expect(page.locator('.contrast-cell.is-low')).toHaveCount(0);
  }
  // A plain white photo is the worst case for the brightness normalisation.
  const before = await p95();
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 400;
    canvas.height = 300;
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 400, 300);
    const blob = await new Promise<Blob>((ok) => canvas.toBlob((b) => ok(b as Blob), 'image/png'));
    const input = document.querySelector('.proto-top input[type=file]') as HTMLInputElement;
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'white.png', { type: 'image/png' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect.poll(p95).not.toBe(before);
  expect(await p95()).toBeLessThan(0.13);
  await expect(page.locator('.contrast-cell.is-low')).toHaveCount(0);
});

test('wire ends: a socket at the source, an arrow or a socket at the target (07 §5)', async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  await open(page);
  // A wire between two plain bubbles, the source above, close enough to share
  // the screen, whose ends miss 6 o'clock (06 §4.1) and the labels below.
  const pick = await page.evaluate(() => {
    const { view, graph } = window.__strataProto as Hook;
    const plain = (id: string) => {
      const n = graph.nodes.get(id);
      return (
        n !== undefined &&
        n.color === null &&
        n.status === 'open' &&
        n.due === 'none' &&
        !n.pause &&
        !n.ghost &&
        !n.key &&
        !n.template &&
        !n.appearance &&
        n.external === 0 &&
        (n.assignees as unknown[]).length === 0
      );
    };
    const offSix = (dx: number, dy: number) => Math.abs(Math.atan2(dx, dy)) > Math.PI / 6;
    const all = [...view.eachNode()];
    for (const [from, to] of graph.edges()) {
      const a = view.nodeAt(from);
      const b = view.nodeAt(to);
      if (!a || !b || !plain(from) || !plain(to) || a.y >= b.y) continue;
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const d = Math.hypot(dx, dy);
      if (d < 3 * (a.r + b.r) || d > 200 || !offSix(dx, dy) || !offSix(-dx, -dy)) continue;
      // No third bubble or its label near either end.
      const crowded = all.some(
        ([id, n]) =>
          id !== from &&
          id !== to &&
          (Math.hypot(n.x - a.x, n.y - a.y) < 80 || Math.hypot(n.x - b.x, n.y - b.y) < 80),
      );
      if (!crowded) return { from, to };
    }
    throw new Error('no plain wire');
  });
  // Bubbles at the icon level (07 §4.9), the target in the middle of the canvas.
  await page.mouse.move(2, 790);
  await page.evaluate(({ to }) => {
    const { view } = window.__strataProto as Hook;
    const b = view.nodeAt(to) as Pt;
    const cam = view.camera;
    cam.zoom = 24 / b.r;
    cam.x = b.x - view.canvas.clientWidth / 2 / cam.zoom;
    cam.y = b.y - view.canvas.clientHeight / 2 / cam.zoom;
    view.invalidate();
  }, pick);

  /** Brightness at both ends of the wire in the frame on screen, u = 1 CSS px at DPR 2. */
  const measure = async () => {
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    );
    const png = (await page.screenshot()).toString('base64');
    return page.evaluate(
      async ({ png, pick }) => {
        const img = new Image();
        img.src = `data:image/png;base64,${png}`;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        const g = c.getContext('2d') as CanvasRenderingContext2D;
        g.drawImage(img, 0, 0);
        const k = img.width / window.innerWidth;
        const lum = (x: number, y: number) => {
          const [r = 0, gr = 0, bl = 0] = g.getImageData(
            Math.floor(x * k),
            Math.floor(y * k),
            1,
            1,
          ).data;
          return (r + gr + bl) / 765;
        };
        const e = window.__e2e as Probe;
        const a = e.node(pick.from);
        const b = e.node(pick.to);
        if (!e.free(a.x, a.y) || !e.free(b.x, b.y)) throw new Error('ends under the Chrome');
        // A wire meets the rims along its axis (curve.ts axisOf).
        const axis = (p: Pt, q: Pt) =>
          Math.abs(q.x - p.x) >= Math.abs(q.y - p.y)
            ? { x: q.x >= p.x ? 1 : -1, y: 0 }
            : { x: 0, y: q.y >= p.y ? 1 : -1 };
        const ua = axis(a, b);
        const ub = axis(b, a);
        // Bright pixels outside the target's rim within 12 px of where the wire enters.
        const jx = b.x + ub.x * b.r;
        const jy = b.y + ub.y * b.r;
        let bright = 0;
        for (let y = jy - 12; y <= jy + 12; y += 0.5) {
          for (let x = jx - 12; x <= jx + 12; x += 0.5) {
            if (Math.hypot(x - jx, y - jy) > 12 || Math.hypot(x - b.x, y - b.y) < b.r + 1) continue;
            if (lum(x, y) > 0.8) bright++;
          }
        }
        // The brightest point within 1.5 px: the dot is 2u, the centre may be off by a pixel.
        const peak = (x: number, y: number) => {
          let m = 0;
          for (let oy = -1.5; oy <= 1.5; oy += 0.5) {
            for (let ox = -1.5; ox <= 1.5; ox += 0.5) m = Math.max(m, lum(x + ox, y + oy));
          }
          return m;
        };
        return {
          // The centres of the sockets, on the rims.
          source: peak(a.x + ua.x * a.r, a.y + ua.y * a.r),
          target: peak(b.x + ub.x * b.r, b.y + ub.y * b.r),
          // Across the wire, 5.5 px from the source socket's centre: its dark disc.
          disc: lum(a.x + ua.x * a.r - ua.y * 5.5, a.y + ua.y * a.r + ua.x * 5.5),
          bright,
        };
      },
      { png, pick },
    );
  };

  // Default (✅ Q-07-20): circles on both ends — a bright dot in a dark disc.
  const circles = await measure();
  expect(circles.source).toBeGreaterThan(0.8);
  expect(circles.target).toBeGreaterThan(0.8);
  expect(circles.disc).toBeLessThan(0.3);
  // Arrows: an arrowhead at the target, more bright pixels where the wire enters.
  await page.locator('.proto-ends label', { has: page.locator('input[value="arrow"]') }).click();
  await page.mouse.move(2, 790);
  const arrows = await measure();
  expect(arrows.source).toBeGreaterThan(0.8);
  expect(arrows.bright).toBeGreaterThan(circles.bright + 40);
  await context.close();
});

test('a board opens in its window; what is drawn stays in its document (ADR-0006)', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page, false);
  await page.evaluate(() => localStorage.clear());
  const win = page.locator('.board-window');
  const scene = () =>
    page.evaluate(
      () => (window.__strataProto as Hook).board?.elements().map((e) => e.type) ?? null,
    );
  const openBoard = async () => {
    const at = await galleryBoard(page);
    await page.mouse.dblclick(at.x, at.y);
    await expect(win).toBeVisible();
    await expect(win.locator('.excalidraw')).toBeVisible(BOARD_LOAD);
  };
  const pick = (tool: string) =>
    win.locator('.board-tools label', { has: page.locator(`input[value="${tool}"]`) }).click();
  const drag = async (x0: number, y0: number, x1: number, y1: number) => {
    const s = await box(page, '.board-stage');
    await page.mouse.move(s.x + s.width * x0, s.y + s.height * y0);
    await page.mouse.down();
    await page.mouse.move(s.x + s.width * x1, s.y + s.height * y1, { steps: 8 });
    await page.mouse.up();
  };

  await openBoard();
  await expect.poll(scene).toEqual([]);
  // A tool stays on after use (the host's tool): two rectangles in a row.
  await pick('rectangle');
  await drag(0.1, 0.1, 0.3, 0.3);
  await drag(0.1, 0.4, 0.3, 0.6);
  await pick('ellipse');
  await drag(0.5, 0.1, 0.7, 0.3);
  await expect.poll(scene).toEqual(['rectangle', 'rectangle', 'ellipse']);
  // Text in Cyrillic, in Nunito from the app itself (the CSP blocks esm.sh).
  await pick('text');
  const s = await box(page, '.board-stage');
  await page.mouse.click(s.x + s.width * 0.5, s.y + s.height * 0.7);
  await expect(win.locator('textarea')).toBeFocused();
  await page.keyboard.type('Свет и туман');
  await page.keyboard.press('Escape');
  await expect.poll(scene).toEqual(['rectangle', 'rectangle', 'ellipse', 'text']);
  await expect
    .poll(() =>
      page.evaluate(() =>
        [...document.fonts].some(
          (f) => f.family.replaceAll('"', '') === 'Nunito' && f.status === 'loaded',
        ),
      ),
    )
    .toBe(true);

  // An image dropped from the system: an element and its file.
  await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 48;
    const g = c.getContext('2d') as CanvasRenderingContext2D;
    g.fillStyle = '#c33';
    g.fillRect(0, 0, 64, 48);
    const blob = await new Promise<Blob>((done) =>
      c.toBlob((b) => done(b as Blob), 'image/jpeg', 0.9),
    );
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'swatch.jpg', { type: 'image/jpeg' }));
    const target = document.querySelector('.board-window .excalidraw') as HTMLElement;
    const r = target.getBoundingClientRect();
    target.dispatchEvent(
      new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer: dt,
        clientX: r.left + r.width * 0.7,
        clientY: r.top + r.height * 0.6,
      }),
    );
  });
  const drawn = ['rectangle', 'rectangle', 'ellipse', 'text', 'image'];
  await expect.poll(scene).toEqual(drawn);
  const files = () => page.evaluate(() => (window.__strataProto as Hook).board?.files().length);
  await expect.poll(files).toBe(1);

  // Closed and opened again, then after a reload: the same scene from the document.
  await win.locator('.window-close').click();
  await expect(win).toHaveCount(0);
  await openBoard();
  await expect.poll(scene).toEqual(drawn);
  await win.locator('.window-close').click();
  await open(page, false);
  await openBoard();
  await expect.poll(scene).toEqual(drawn);
  await expect.poll(files).toBe(1);
  expect(errors).toEqual([]);
});

test("a board's palette colours the selection and what comes next; its letters pick tools (07 §8.4)", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page, false);
  await page.evaluate(() => localStorage.clear());
  const win = page.locator('.board-window');
  const openBoard = async () => {
    const at = await galleryBoard(page);
    await page.mouse.dblclick(at.x, at.y);
    await expect(win.locator('.excalidraw')).toBeVisible(BOARD_LOAD);
  };
  const paints = () =>
    page.evaluate(
      () =>
        (window.__strataProto as Hook).board
          ?.elements()
          .map((e) => [e.type, e.strokeColor, e.backgroundColor]) ?? null,
    );
  const tool = () => page.evaluate(() => (window.__strataProto as Hook).board?.activeTool());
  const swatch = (name: string) => win.locator(`.board-swatch[data-color="${name}"]`);
  const drag = async (x0: number, y0: number, x1: number, y1: number) => {
    const s = await box(page, '.board-stage');
    await page.mouse.move(s.x + s.width * x0, s.y + s.height * y0);
    await page.mouse.down();
    await page.mouse.move(s.x + s.width * x1, s.y + s.height * y1, { steps: 8 });
    await page.mouse.up();
  };
  const sky = '#5ec8e5';
  const paper = '#f2efe6';
  const yellow = '#e8c547';
  const pink = '#f28dc6';

  await openBoard();
  // Before anything is drawn: the line from a click, the fill from the right button.
  await swatch('sky').click();
  await swatch('paper').click({ button: 'right' });
  await expect(win.locator('.board-pair-stroke')).toHaveCSS(
    'background-color',
    'rgb(94, 200, 229)',
  );
  await expect(win.locator('.board-pair-fill')).toHaveCSS('background-color', 'rgb(242, 239, 230)');
  await win.locator('.board-tool', { has: page.locator('input[value="rectangle"]') }).click();
  await drag(0.1, 0.1, 0.3, 0.3);
  await expect.poll(paints).toEqual([['rectangle', sky, paper]]);
  // Excalidraw's letters pick Strata's tools: its own switch is off.
  await page.keyboard.press('o');
  await expect.poll(tool).toBe('ellipse');
  await expect(win.locator('.board-tool.is-active input')).toHaveValue('ellipse');
  await swatch('yellow').click({ button: 'right' });
  await drag(0.5, 0.1, 0.7, 0.3);
  await expect.poll(paints).toEqual([
    ['rectangle', sky, paper],
    ['ellipse', sky, yellow],
  ]);
  // The selection takes the colour in one step of undo.
  await page.keyboard.press('v');
  await expect.poll(tool).toBe('selection');
  await page.keyboard.press('ControlOrMeta+a');
  await swatch('pink').click();
  await expect.poll(paints).toEqual([
    ['rectangle', pink, paper],
    ['ellipse', pink, yellow],
  ]);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(paints).toEqual([
    ['rectangle', sky, paper],
    ['ellipse', sky, yellow],
  ]);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await swatch('none').click({ button: 'right' });
  const kept = [
    ['rectangle', pink, 'transparent'],
    ['ellipse', pink, 'transparent'],
  ];
  await expect.poll(paints).toEqual(kept);
  // The colours are the document's: the board opened again has them.
  await win.locator('.window-close').click();
  await expect(win).toHaveCount(0);
  await openBoard();
  await expect.poll(paints).toEqual(kept);
  expect(errors).toEqual([]);
});

/** A note of the demo network on the bare canvas, and another node to link it to by name. */
async function notePair(page: Page) {
  return page.evaluate(() => {
    const { graph } = window.__strataProto as Hook;
    const e = window.__e2e as Probe;
    const nodes = [...graph.nodes.values()];
    const names = new Map<string, number>();
    for (const n of nodes)
      names.set(n.name.toLowerCase(), (names.get(n.name.toLowerCase()) ?? 0) + 1);
    for (const n of nodes) {
      if (n.kind !== 'note' || n.ghost) continue;
      const p = e.node(n.id);
      if (!e.free(p.x, p.y, 40) || p.x > window.innerWidth * 0.6) continue;
      const target = nodes.find(
        (m) =>
          m.id !== n.id &&
          names.get(m.name.toLowerCase()) === 1 &&
          !graph.hasEdge(n.id, m.id) &&
          m.name.length > 2,
      );
      if (target) return { id: n.id, x: p.x, y: p.y, target: { id: target.id, name: target.name } };
    }
    throw new Error('no note on the bare canvas');
  });
}

test('a note opens in its window; [[links]] in its text are wires (06 §13.1, 05 §8.2)', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  await page.evaluate(() => localStorage.clear());
  const pick = await notePair(page);
  await page.mouse.dblclick(pick.x, pick.y);
  const win = page.locator('.note-window');
  await expect(win).toBeVisible();
  await expect(win.locator('.cm-content')).toBeFocused();
  const edge = () =>
    page.evaluate(({ a, b }) => (window.__strataProto as Hook).graph.hasEdge(a, b), {
      a: pick.id,
      b: pick.target.id,
    });
  await page.keyboard.type(`Связь с [[${pick.target.name}]] и дальше`);
  await expect.poll(edge).toBe(true);
  // A derived wire is not a step of the canvas's undo (05 §11, source system).
  // Remove the link from the text: its wire goes.
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.keyboard.press('Backspace');
  await expect.poll(edge).toBe(false);
  // Esc: the canvas gets the keyboard, the window stays.
  await page.keyboard.press('Escape');
  await expect(win).toBeVisible();
  await win.locator('.window-close').click();
  await expect(win).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('M flies to the star map and back over the camera bridge (08 §7)', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  const proto = page.locator('.proto');
  await expect(proto).toHaveAttribute('data-view', '2d');
  await page.mouse.move(600, 400);
  await page.keyboard.press('KeyM');
  await expect(proto).toHaveAttribute('data-view', '3d', { timeout: 30_000 });
  await expect(page.locator('.proto-map')).toBeVisible();
  // The map listens to its own keys: the canvas's are off while it is shown.
  const hint = await page.locator('.proto-status .hint').textContent();
  expect([t('ru', 'proto.hint.map'), t('en', 'proto.hint.map')]).toContain(hint);
  const first = Number(await page.locator('.proto-canvas').getAttribute('data-first-frame'));
  expect(first).toBeGreaterThan(0);
  await page.keyboard.press('KeyM');
  await expect(proto).toHaveAttribute('data-view', '2d', { timeout: 10_000 });
  await expect(page.locator('.proto-map')).toBeHidden();
  // Back on the canvas: its keys work again.
  const before = await counts(page);
  await page.keyboard.press('Tab');
  await expect(page.locator('.tab-menu')).toBeVisible();
  await page.keyboard.press('Escape');
  expect(await counts(page)).toEqual(before);
  expect(errors).toEqual([]);
});

test.describe('gestures', () => {
  test.use({ viewport: { width: 1280, height: 800 }, locale: 'ru-RU' });

  test('L lays the network out top to bottom in one step of undo (06 §9)', async ({ page }) => {
    await open(page);
    const state = () =>
      page.evaluate(() => {
        const { graph, view } = window.__strataProto as Hook;
        const nodes = [...graph.nodes.values()];
        return {
          pos: Object.fromEntries(nodes.map((n) => [n.id, [n.x as number, n.y as number]])),
          r: Object.fromEntries(nodes.map((n) => [n.id, view.nodeAt(n.id)?.r ?? 0])),
          gallery: nodes.slice(-20).map((n) => n.id),
          edges: graph.edges(),
        };
      });
    const before = await state();
    const spot = await emptySpot(page, 40);
    await page.mouse.click(spot.x, spot.y);
    await page.keyboard.press('KeyL');
    await expect
      .poll(() => page.evaluate(() => (window.__strataProto as Hook).layoutMs()))
      .not.toBeNull();
    await expect(page.locator('.proto-status .last-step')).toContainText('Раскладка 200 нод');
    const after = await state();
    const ids = Object.keys(after.pos).filter((id) => !after.gallery.includes(id));
    const moved = ids.filter((id) => after.pos[id]?.[0] !== before.pos[id]?.[0]);
    expect(moved.length).toBeGreaterThan(150);
    // The gallery stays; no two bubbles overlap; wires point down.
    for (const id of after.gallery) expect(after.pos[id]).toEqual(before.pos[id]);
    let closest = Number.POSITIVE_INFINITY;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i] as string;
        const b = ids[j] as string;
        const [ax = 0, ay = 0] = after.pos[a] ?? [];
        const [bx = 0, by = 0] = after.pos[b] ?? [];
        closest = Math.min(
          closest,
          Math.hypot(ax - bx, ay - by) - (after.r[a] ?? 0) - (after.r[b] ?? 0),
        );
      }
    }
    expect(closest).toBeGreaterThan(10);
    const down = after.edges.filter(
      ([a, b]) => (after.pos[b]?.[1] ?? 0) > (after.pos[a]?.[1] ?? 0),
    );
    expect(down.length / after.edges.length).toBeGreaterThan(0.95);
    // One step: Ctrl+Z puts every node back.
    await page.keyboard.press('Control+z');
    expect((await state()).pos).toEqual(before.pos);
  });

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
    // Four reversals on one axis, 40 px and more, within 600 ms (06 §1.3). The swings are
    // synthetic pointer events dispatched at once: the detector reads their
    // timestamps, so the gesture no longer depends on how fast software WebGL
    // in CI renders a frame per event. Press, drag start and release are real.
    // Holding 8 keeps the node from being dropped back onto the healed wire.
    await page.keyboard.down('8');
    await page.mouse.move(p.x + 10, p.y, { steps: 2 });
    await page.evaluate(({ x, y }) => {
      const canvas = (window.__strataProto as Hook).view.canvas;
      for (let i = 0; i < 6; i++) {
        canvas.dispatchEvent(
          new PointerEvent('pointermove', {
            clientX: x + (i % 2 === 0 ? 60 : -60),
            clientY: y,
            pointerId: 1,
            pointerType: 'mouse',
            isPrimary: true,
            buttons: 1,
            bubbles: true,
          }),
        );
      }
    }, p);
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
