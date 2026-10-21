import { fog } from '@strata/design-tokens';
import {
  Application,
  BitmapFont,
  BitmapText,
  Container,
  Graphics,
  Rectangle,
  Sprite,
  Texture,
} from 'pixi.js';
// The CSP has no 'unsafe-eval' (11 §8.7), so Pixi needs its eval-free uniform sync.
import 'pixi.js/unsafe-eval';
import { type FrameReport, runFrames } from './frame-loop';
import { rng, type Summary, summarize } from './stats';
import { createWireLayer } from './wires';

/**
 * Spike 1 scenarios (16 §3.2) on the N-5k and N-10k sets of 14 §1.3:
 * - `pan-zoom` — the `canvas-pan-zoom` bench of 14 §17 (NFR-01, NFR-02):
 *   a scripted camera from the whole network to a close-up and back;
 * - `drag` — the `canvas-drag` bench (NFR-03): 100 selected bubbles follow
 *   the cursor while the camera stays.
 */
export interface CanvasScenario {
  mode: 'pan-zoom' | 'drag';
  nodes: number;
  wires: number;
  /** Frame method of 14 §1.4: warmup, then `runs` runs of `runMs` each. */
  warmupMs: number;
  runMs: number;
  runs: number;
  vsyncMs: number;
}

/**
 * Counts WebGL draw calls per frame (NFR-11) by wrapping the context's draw
 * functions; the wrapper costs one increment per call.
 */
function countDrawCalls(gl: WebGL2RenderingContext | undefined): { take(): number } {
  let calls = 0;
  if (gl) {
    for (const name of [
      'drawArrays',
      'drawElements',
      'drawArraysInstanced',
      'drawElementsInstanced',
    ] as const) {
      const original = gl[name].bind(gl) as (...args: unknown[]) => void;
      (gl as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
        calls++;
        original(...args);
      };
    }
  }
  return {
    take() {
      const n = calls;
      calls = 0;
      return n;
    },
  };
}

export interface CanvasResult extends FrameReport {
  mode: CanvasScenario['mode'];
  nodes: number;
  wires: number;
  icons: number;
  dragged: number;
  /** Draw calls per frame (NFR-11: ≤ 20 on N-5k). */
  drawCalls: Summary;
  setupMs: number;
  renderer: string;
}

/** Bubble diameters S, M, L in world units (06 §4.2). */
const SIZE = { s: 32, m: 48, l: 72 } as const;
const SPACING = 96;
const ICONS = 200; // N-5k: 200 distinct icons
const KEY_SHARE = 0.1; // key bubbles are one size up (06 §4.2)
const DEADLINE_SHARE = 0.05; // deadline ring (07 §4.6)
const NETWORK_SHARE = 0.15; // networks are M, other kinds S
const FAR_WIRES = 0.03; // share of wires to a random bubble anywhere in the network
const DRAG_BLOCK = 10; // 10 × 10 = 100 selected bubbles (NFR-03)
// Labels once an M bubble is ≥ 32 px across (07 §4.9). The rest of the semantic
// zoom (dots below 12 px) is left out: the bench draws the full bubble, an upper bound.
const LABEL_ZOOM = 0.67;
const FONT = 'StrataLabel';
const ICON_CELL = 32; // atlas cell, world units at zoom 1
/**
 * Scene structure, as measured in spike 1 (S1-canvas.md): the world and each
 * of its four layers are Pixi 8 render groups. A camera move then changes one
 * transform on the GPU instead of every bubble's on the CPU, and showing or
 * hiding the labels rebuilds only the world's list of five children. Nothing
 * is culled per object: at 10 000 bubbles the GPU drops off-screen geometry
 * cheaper than any CPU pass (Pixi's Culler cost 10–20 ms per frame), and one
 * group per layer keeps draw calls at 4–5 (NFR-11). Tiles as render groups
 * were tried too: no CPU gain, 25–127 draw calls.
 */

let fontInstalled = false;

function installFont() {
  if (fontInstalled) return;
  BitmapFont.install({
    name: FONT,
    style: { fontFamily: fog.font.ui, fontSize: 24, fill: fog.scene.paper },
    chars: [['a', 'z'], ['A', 'Z'], ['0', '9'], ['а', 'я'], ['А', 'Я'], ' ёЁ.,:-—«»№'],
    resolution: 2,
  });
  fontInstalled = true;
}

function texture(app: Application, g: Graphics, frame?: Rectangle): Texture {
  const tex = app.renderer.generateTexture({
    target: g,
    resolution: 2,
    antialias: true,
    ...(frame ? { frame } : {}),
  });
  g.destroy();
  return tex;
}

/** One L bubble; S and M are the same texture scaled down. */
const bubbleTexture = (app: Application) =>
  texture(
    app,
    new Graphics()
      .circle(0, 0, SIZE.l / 2)
      .fill(fog.scene.paper)
      .circle(0, 0, SIZE.l / 2 - 1.5)
      .stroke({ color: fog.scene.ink, width: 1.5, alpha: 0.25 }),
  );

const ringTexture = (app: Application) =>
  texture(app, new Graphics().circle(0, 0, SIZE.l / 2 + 6).stroke({ color: 0xffffff, width: 3 }));

/**
 * 200 procedural 1-bit glyphs standing in for the engraved icons of spike 9,
 * in one atlas, as the real canvas packs icons: one texture keeps all
 * bubbles in a few batches.
 */
function iconAtlas(app: Application): Texture[] {
  const perRow = 20;
  const rows = Math.ceil(ICONS / perRow);
  const g = new Graphics();
  const px = 3;
  for (let k = 0; k < ICONS; k++) {
    const r = rng(1000 + k);
    const ox = (k % perRow) * ICON_CELL + 1;
    const oy = Math.floor(k / perRow) * ICON_CELL + 1;
    for (let y = 0; y < 10; y++) {
      for (let x = 0; x < 5; x++) {
        if (r() > 0.5) {
          g.rect(ox + x * px, oy + y * px, px, px).rect(ox + (9 - x) * px, oy + y * px, px, px);
        }
      }
    }
  }
  g.fill(fog.scene.ink);
  const atlas = texture(app, g, new Rectangle(0, 0, perRow * ICON_CELL, rows * ICON_CELL));
  return Array.from(
    { length: ICONS },
    (_, k) =>
      new Texture({
        source: atlas.source,
        frame: new Rectangle(
          (k % perRow) * ICON_CELL,
          Math.floor(k / perRow) * ICON_CELL,
          ICON_CELL,
          ICON_CELL,
        ),
      }),
  );
}

const WORDS = [
  'Задача',
  'Заметка',
  'Референсы',
  'Сцена',
  'Персонаж',
  'Уровень',
  'Project',
  'Board',
];

export async function runCanvasScenario(
  stage: HTMLElement,
  sc: CanvasScenario,
): Promise<CanvasResult> {
  const t0 = performance.now();
  const app = new Application();
  await app.init({
    resizeTo: stage,
    background: fog.scene.bg,
    antialias: true,
    autoDensity: true,
    resolution: window.devicePixelRatio,
    preference: 'webgl',
    autoStart: false,
    sharedTicker: false,
  });
  // A canvas left by a failed run must not push this one off screen.
  stage.replaceChildren(app.canvas);
  // Numbers from a run that lost the GPU context (driver reset, GPU switch) are void.
  let lost = false;
  app.canvas.addEventListener('webglcontextlost', () => {
    lost = true;
  });
  const teardown: (() => void)[] = [];
  try {
    installFont();

    const world = new Container({ isRenderGroup: true });
    app.stage.addChild(world);
    const bubbleTex = bubbleTexture(app);
    const ringTex = ringTexture(app);
    const icons = iconAtlas(app);
    teardown.push(() => {
      for (const t of icons) t.destroy();
    });

    // Grid layout with jitter: one big network seen from above.
    const n = sc.nodes;
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    const r = rng(7);
    const x = new Float32Array(n);
    const y = new Float32Array(n);
    const diameter = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      x[i] = (i % cols) * SPACING + (r() - 0.5) * SPACING * 0.5;
      y[i] = Math.floor(i / cols) * SPACING + (r() - 0.5) * SPACING * 0.5;
      const network = r() < NETWORK_SHARE;
      const key = r() < KEY_SHARE;
      diameter[i] = key ? (network ? SIZE.l : SIZE.m) : network ? SIZE.m : SIZE.s;
    }

    // Wires: mostly to bubbles one to three rows below, a few anywhere.
    const from = new Uint32Array(sc.wires);
    const to = new Uint32Array(sc.wires);
    for (let e = 0; e < sc.wires; e++) {
      const a = Math.floor(r() * n);
      let b: number;
      if (r() < FAR_WIRES) b = Math.floor(r() * n);
      else {
        const col = Math.min(cols - 1, Math.max(0, (a % cols) + Math.round((r() - 0.5) * 6)));
        const row = Math.min(rows - 1, Math.floor(a / cols) + 1 + Math.floor(r() * 3));
        b = Math.min(n - 1, row * cols + col);
      }
      from[e] = a;
      to[e] = b === a ? (a + 1) % n : b;
    }
    const wires = createWireLayer(sc.wires, { width: 1.5, color: [0.95, 0.94, 0.9, 0.6] });
    teardown.push(() => wires.destroy());
    for (let e = 0; e < sc.wires; e++) {
      wires.radii.set([(diameter[from[e] ?? 0] ?? 0) / 2, (diameter[to[e] ?? 0] ?? 0) / 2], e * 2);
    }
    // No allocations in the frame loop (15 §4.1 rule 8): plain stores into the buffer.
    const ends = wires.ends;
    const writeWire = (e: number) => {
      const a = from[e] ?? 0;
      const b = to[e] ?? 0;
      ends[e * 4] = x[a] ?? 0;
      ends[e * 4 + 1] = y[a] ?? 0;
      ends[e * 4 + 2] = x[b] ?? 0;
      ends[e * 4 + 3] = y[b] ?? 0;
    };
    for (let e = 0; e < sc.wires; e++) writeWire(e);
    wires.upload();
    world.addChild(wires.mesh);

    // Draw order of 07 §4.1, reduced to four layers: body, icon, deadline ring, label.
    const layer = () => world.addChild(new Container({ isRenderGroup: true }));
    const bubbles = layer();
    const glyphs = layer();
    const rings = layer();
    const labels = layer();
    const ringOf = new Map<number, Sprite>();
    const bubbleSprites: Sprite[] = [];
    const glyphSprites: Sprite[] = [];
    const labelTexts: BitmapText[] = [];
    for (let i = 0; i < n; i++) {
      const d = diameter[i] ?? SIZE.s;
      const px = x[i] ?? 0;
      const py = y[i] ?? 0;
      if (r() < DEADLINE_SHARE) {
        const ring = new Sprite({ texture: ringTex, anchor: 0.5, tint: fog.scene.attention });
        ring.scale.set(d / SIZE.l);
        ring.position.set(px, py);
        rings.addChild(ring);
        ringOf.set(i, ring);
      }
      const b = new Sprite({ texture: bubbleTex, anchor: 0.5 });
      b.scale.set(d / SIZE.l);
      b.position.set(px, py);
      bubbles.addChild(b);
      bubbleSprites.push(b);
      const g = new Sprite({ texture: icons[i % ICONS] ?? Texture.EMPTY, anchor: 0.5 });
      g.scale.set((d * 0.55) / ICON_CELL); // icon is 0.55 · d (07 §4.1)
      g.position.set(px, py);
      glyphs.addChild(g);
      glyphSprites.push(g);
      const l = new BitmapText({
        text: `${WORDS[i % WORDS.length]} ${i}`,
        style: { fontFamily: FONT, fontSize: 11 },
      });
      l.anchor.set(0.5, 0);
      l.position.set(px, py + d / 2 + 4);
      labels.addChild(l);
      labelTexts.push(l);
    }

    // Drag: a 10 × 10 block of selected bubbles in the middle of the network.
    const dragged: number[] = [];
    if (sc.mode === 'drag') {
      const r0 = Math.floor(rows / 2 - DRAG_BLOCK / 2);
      const c0 = Math.floor(cols / 2 - DRAG_BLOCK / 2);
      for (let i = 0; i < DRAG_BLOCK; i++) {
        for (let j = 0; j < DRAG_BLOCK; j++) dragged.push((r0 + i) * cols + c0 + j);
      }
    }
    const isDragged = new Uint8Array(n);
    for (const i of dragged) isDragged[i] = 1;
    const draggedWires: number[] = [];
    for (let e = 0; e < sc.wires; e++) {
      if (isDragged[from[e] ?? 0] || isDragged[to[e] ?? 0]) draggedWires.push(e);
    }
    // The selection being dragged moves to its own render group, in the same
    // layer order, and follows the cursor as one transform: the big layers'
    // buffers are not touched, only the wires of the selection are rewritten.
    const selection = world.addChild(new Container({ isRenderGroup: true }));
    const selBodies = selection.addChild(new Container());
    const selIcons = selection.addChild(new Container());
    const selRings = selection.addChild(new Container());
    const selLabels = selection.addChild(new Container());
    for (const i of dragged) {
      const b = bubbleSprites[i];
      const g = glyphSprites[i];
      const ring = ringOf.get(i);
      const l = labelTexts[i];
      if (b) selBodies.addChild(b);
      if (g) selIcons.addChild(g);
      if (ring) selRings.addChild(ring);
      if (l) selLabels.addChild(l);
    }
    const baseX = x.slice();
    const baseY = y.slice();
    // Build every layer's draw list once, labels included, as the app would when a
    // network loads; otherwise the first zoom past LABEL_ZOOM pays for all labels in one frame.
    app.render();
    const setupMs = performance.now() - t0;

    const worldW = cols * SPACING;
    const worldH = rows * SPACING;
    const camera = (zoom: number, cx: number, cy: number) => {
      world.scale.set(zoom);
      world.position.set(app.screen.width / 2 - cx * zoom, app.screen.height / 2 - cy * zoom);
      wires.setZoom(zoom);
      labels.visible = zoom >= LABEL_ZOOM;
      selLabels.visible = labels.visible;
    };

    const panZoom = (p: number) => {
      // Zoomed out at the start and the end, a close-up in the middle.
      const zoom = Math.exp(
        Math.log(0.12) + (Math.log(1.6) - Math.log(0.12)) * (0.5 - 0.5 * Math.cos(2 * Math.PI * p)),
      );
      camera(
        zoom,
        worldW * (0.5 + 0.35 * Math.sin(2 * Math.PI * p)),
        worldH * (0.5 + 0.35 * Math.sin(4 * Math.PI * p)),
      );
    };

    const drag = (p: number) => {
      camera(0.75, worldW / 2, worldH / 2);
      // The cursor path: a Lissajous figure a few bubbles wide.
      const dx = Math.sin(2 * Math.PI * 3 * p) * SPACING * 3;
      const dy = Math.sin(2 * Math.PI * 2 * p) * SPACING * 2;
      selection.position.set(dx, dy);
      for (const i of dragged) {
        x[i] = (baseX[i] ?? 0) + dx;
        y[i] = (baseY[i] ?? 0) + dy;
      }
      for (const e of draggedWires) writeWire(e);
      wires.upload();
    };

    const draws = countDrawCalls((app.renderer as unknown as { gl?: WebGL2RenderingContext }).gl);
    const drawCalls: number[] = [];
    const frame = (p: number, timed: boolean) => {
      if (sc.mode === 'drag') drag(p);
      else panZoom(p);
      wires.setTime((performance.now() - t0) / 1000);
      app.render();
      const calls = draws.take();
      if (timed) drawCalls.push(calls);
    };

    const report = await runFrames(
      { warmupMs: sc.warmupMs, runMs: sc.runMs, runs: sc.runs, vsyncMs: sc.vsyncMs },
      frame,
    );
    if (lost) throw new Error('WebGL context was lost during the run; its numbers are void');
    return {
      ...report,
      mode: sc.mode,
      nodes: n,
      wires: sc.wires,
      icons: ICONS,
      dragged: dragged.length,
      drawCalls: summarize(drawCalls),
      setupMs: Math.round(setupMs),
      renderer: app.renderer.name,
    };
  } finally {
    for (const f of teardown) f();
    app.destroy({ removeView: true }, { children: true, texture: true, textureSource: true });
  }
}
