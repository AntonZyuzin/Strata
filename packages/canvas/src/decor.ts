import type { GraphNode } from '@strata/backend';
import { fog, type GlyphName, hex, palette, people } from '@strata/design-tokens';
import { BitmapText, Container, Graphics, Sprite, Texture } from 'pixi.js';
import type { Camera } from './camera';
import { isClosed, levelOf, nodeAlpha, socketAt, statusGlyph } from './looks';
import { RingLayer } from './rings';
import { GlyphTextures, labelFont, type Plate } from './textures';

/**
 * The screen-space layer of bubbles (07 §4): rims, rings and glyphs are a
 * whole number of pixel units on screen whatever the zoom (07 §4.2), labels
 * are the pixel font at its exact device size on a plate (07 §3.4). Bodies and
 * icons scale with the world and live in the world's render group (view.ts).
 * Rings are one instanced draw (rings.ts); glyphs and labels are pooled
 * sprites; only selection corners and pause hatching are Graphics. Redrawn for
 * the nodes on screen in every rendered frame; idle costs nothing.
 */

export interface Interaction {
  hover: string | null;
  selection: ReadonlySet<string>;
  current: string | null;
}

export interface DecorNode {
  id: string;
  node: GraphNode;
  /** Rendered centre and radius, world units. */
  x: number;
  y: number;
  r: number;
  /** Sources of the wires drawn into this node. */
  inputs: readonly DecorNode[];
}

/** Clock hours of the rim (06 §4.1, 07 §4.1) as angles from 3 o'clock, clockwise. */
function hour(h: number): number {
  return (h / 12) * Math.PI * 2 - Math.PI / 2;
}

const PAPER = hex(palette.paper);
const INK = hex(palette.ink850);
const YELLOW = hex(palette.yellow500);
const RED = hex(palette.red500);
const RIM = fog.scene.rimAlpha;
/** One «today» pulse and the count (07 §4.5): 3 × 800 ms on first sight, then still. */
const PULSE_MS = fog.dur.pulse;
const PULSES = 3;
/** Marching ants of the current node run 3 s, then stand (07 §2.8). */
const ANTS_MS = 3000;
const LABEL_MAX = 160;
/** Input socket: ink disc of radius 3u with a paper ring 1u (07 §5). */
const SOCKET = 3;
const CORNERS = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
] as const;

export class Decor {
  readonly container = new Container();
  private readonly rings: RingLayer;
  private readonly plates = new Container();
  /** Selection corners. */
  private readonly g = new Graphics();
  /** Pause hatching; a separate path, stroked in ink. */
  private readonly hatching = new Graphics();
  private readonly badges = new Container();
  private readonly texts = new Container();
  private readonly platePool: Sprite[] = [];
  private readonly badgePool: Sprite[] = [];
  private readonly textPool: BitmapText[] = [];
  private readonly labels = new Map<string, BitmapText>();
  private readonly glyphs: GlyphTextures;
  private readonly pulseStart = new Map<string, number>();
  private plateUsed = 0;
  private badgeUsed = 0;
  private textUsed = 0;
  private antsFor: string | null = null;
  private antsStart = 0;
  reducedMotion = false;

  /**
   * @param u pixel unit, device px (07 §2.3)
   * @param uiPx size of the `ui` font in device px (07 §2.4)
   */
  constructor(
    private readonly u: number,
    private readonly dpr: number,
    private readonly uiPx: number,
  ) {
    this.glyphs = new GlyphTextures(u, dpr);
    this.rings = new RingLayer(dpr);
    this.container.addChild(
      this.hatching,
      this.rings.mesh,
      this.g,
      this.badges,
      this.plates,
      this.texts,
    );
  }

  destroy(): void {
    this.glyphs.destroy();
    this.rings.destroy();
    this.container.destroy({ children: true });
  }

  /** Draws every node on screen; true while a finite animation still runs. */
  draw(
    nodes: Iterable<DecorNode>,
    cam: Camera,
    w: number,
    h: number,
    ia: Interaction,
    now: number,
    wireAlpha: (from: string, to: string) => number = () => fog.scene.edgeAlpha,
  ): boolean {
    const g = this.g;
    const rings = this.rings;
    g.clear();
    this.hatching.clear();
    rings.clear();
    this.plateUsed = 0;
    this.badgeUsed = 0;
    this.textUsed = 0;
    const U = this.u / this.dpr;
    const shown = new Set<string>();
    let animating = false;
    let corners = false;
    let hatched = false;
    if (ia.current !== this.antsFor) {
      this.antsFor = ia.current;
      this.antsStart = now;
    }
    for (const v of nodes) {
      const s = cam.toScreen(v.x, v.y);
      const R = v.r * cam.zoom;
      const margin = R + 40 * U;
      if (s.x < -margin || s.x > w + margin || s.y < -margin || s.y > h + margin) continue;
      const lv = levelOf(2 * R);
      if (lv === 'dot') continue;
      const n = v.node;
      const a = nodeAlpha(n);
      const selected = ia.selection.has(v.id);
      const hovered = ia.hover === v.id;
      const closed = isClosed(n);

      // Colour band 3u inside the rim, then the rim 1u (07 §4.3).
      if (n.color !== null && !n.ghost) {
        rings.add(s.x, s.y, R - 1.5 * U, 3 * U, {
          color: hex(people[n.color] ?? palette.paper),
          alpha: a,
        });
      }
      if (n.ghost) {
        rings.add(s.x, s.y, R - 0.5 * U, U, { color: PAPER, alpha: a, dash: 3 * U, gap: 3 * U });
      } else if (n.pause) {
        rings.add(s.x, s.y, R - 0.5 * U, U, {
          color: INK,
          alpha: RIM * a,
          dash: 3 * U,
          gap: 2 * U,
        });
        hatch(this.hatching, s.x, s.y, R - U, 4 * U);
        hatched = true;
      } else {
        rings.add(s.x, s.y, R - 0.5 * U, U, { color: INK, alpha: RIM * a });
      }
      // Networks: the second ring of the «stack» (07 §4.4).
      if (n.kind === 'network' && R > 10 * U) {
        rings.add(s.x, s.y, R - 6.5 * U, U, { color: INK, alpha: RIM * a });
      }
      // Key: a paper contour outside the rim makes the double rim (07 §4.5).
      if (n.key) rings.add(s.x, s.y, R + 2.5 * U, U, { color: PAPER, alpha: a });

      // Input sockets where wires enter the rim (07 §5, ✅ S9 2026-10-23), from the
      // icon level up; over the rim, under the assignees and glyphs.
      if (lv !== 'glyph') {
        for (const src of v.inputs) {
          const p = socketAt(v, src);
          if (!p) continue;
          const x = s.x + p.dx * R;
          const y = s.y + p.dy * R;
          rings.dot(x, y, SOCKET * U, INK, a);
          rings.add(x, y, (SOCKET - 0.5) * U, U, {
            color: PAPER,
            alpha: a * wireAlpha(src.id, v.id),
          });
        }
      }

      // Deadline or roll-up ring at r + 4u … r + 6u (07 §4.3); pause and final statuses drop it (07 §4.7).
      const due = closed || n.pause ? 'none' : n.due;
      if (due === 'today') {
        let alpha = 1;
        if (!this.reducedMotion) {
          const start = this.pulseStart.get(v.id) ?? now;
          this.pulseStart.set(v.id, start);
          const t = now - start;
          if (t < PULSE_MS * PULSES) {
            // 1.0 → 0.4 → 1.0 per pulse, no change of the background (07 §11.5).
            alpha = 0.4 + 0.6 * (0.5 + 0.5 * Math.cos((2 * Math.PI * t) / PULSE_MS));
            animating = true;
          }
        }
        rings.add(s.x, s.y, R + 5 * U, 2 * U, { color: YELLOW, alpha });
      } else if (due === 'overdue') {
        // Red against the fog is 1.6:1, so a paper contour carries the contrast (07 §2.2).
        rings.add(s.x, s.y, R + 5 * U, 2 * U, { color: RED });
        rings.add(s.x, s.y, R + 6.5 * U, U, { color: PAPER });
      } else if (n.fold && n.fold.total > 0 && lv !== 'glyph') {
        const burning = n.fold.burning;
        if (burning) {
          rings.add(s.x, s.y, R + 5 * U, U, { color: burning === 'overdue' ? RED : YELLOW });
        } else {
          rings.add(s.x, s.y, R + 5 * U, 2 * U, { color: PAPER, alpha: 0.3 * a });
        }
        const share = Math.min(1, n.fold.done / n.fold.total);
        if (share > 0) {
          rings.add(s.x, s.y, R + 5 * U, 2 * U, {
            color: PAPER,
            alpha: a,
            start: 0,
            sweep: share * Math.PI * 2,
          });
        }
      }

      // Hover, selection, current (07 §4.5): always at full alpha (07 §4.7 rule 3).
      if (selected) {
        if (ia.current === v.id) {
          const t = now - this.antsStart;
          const running = !this.reducedMotion && t < ANTS_MS;
          if (running) animating = true;
          rings.add(s.x, s.y, R + 10 * U, 2 * U, {
            color: PAPER,
            dash: 3 * U,
            gap: 3 * U,
            offset: running ? (t / 50) * U : 0,
          });
        } else {
          rings.add(s.x, s.y, R + 10 * U, 2 * U, { color: PAPER });
        }
        const k = R + 12 * U;
        const arm = 4 * U;
        for (const [cx, cy] of CORNERS) {
          const x = s.x + cx * k;
          const y = s.y + cy * k;
          g.moveTo(x, y - cy * arm)
            .lineTo(x, y)
            .lineTo(x - cx * arm, y);
        }
        corners = true;
      } else if (hovered) {
        rings.add(s.x, s.y, R + 10 * U, U, { color: PAPER });
      }

      // Assignees: dots 8u with an ink outline at 12 o'clock, up to 3 and «+N» (07 §4.5).
      if (n.assignees.length > 0 && lv !== 'glyph') {
        const dots = n.assignees.slice(0, 3);
        const step = 9 * U;
        const x0 = s.x - ((dots.length - 1) * step) / 2;
        dots.forEach((p, i) => {
          const x = x0 + i * step;
          rings.dot(x, s.y - R, 4 * U, hex(people[p] ?? palette.paper));
          rings.add(x, s.y - R, 4.5 * U, U, { color: INK });
        });
        if (n.assignees.length > 3) {
          this.text(`+${n.assignees.length - 3}`, x0 + 2 * step + 6 * U, s.y - R - this.uiCss / 2);
        }
      }

      // Glyphs on the rim's clock hours (07 §4.1, §4.5).
      const status = statusGlyph(n);
      if (lv === 'glyph') {
        // 12–32 px: the kind glyph instead of the icon, one glyph by priority (07 §4.7 rule 6).
        // The ghost has no fill: its «?» is paper on the bare Scene (07 §4.5).
        this.badge(
          n.ghost ? 'question' : kindGlyph(n, 2 * R >= 24),
          'none',
          s.x,
          s.y,
          1,
          a,
          n.ghost,
        );
        const one = status ?? (n.pause ? (['pause', 'ink'] as const) : null);
        if (one) this.badge(one[0], one[1], ...at(s, R, 4.5));
      } else {
        if (n.ghost) {
          const k = Math.max(1, Math.floor((0.55 * 2 * R) / (8 * U)));
          this.badge('question', 'none', s.x, s.y, k, a, true);
        }
        if (status) this.badge(status[0], status[1], ...at(s, R, 4.5));
        // One hour, one glyph: the second flag moves an hour clockwise (07 §4.7 rule 5).
        let flagHour = 10.5;
        if (n.pause) {
          this.badge('pause', 'ink', ...at(s, R, flagHour));
          flagHour += 1;
        }
        if (n.template) this.badge('template', 'ink', ...at(s, R, flagHour));
        if (n.appearance) this.badge('shortcut', 'ink', ...at(s, R, 7.5));
        if (n.external > 0) {
          const [ex, ey] = at(s, R, 1.5);
          this.badge('external', 'ink', ex, ey);
          this.text(String(n.external), ex + 7 * U, ey - this.uiCss / 2);
        }
        if (!n.ghost) this.badge(kindGlyph(n, false), 'ink', ...at(s, R, 6));
      }

      // Label under the rings on a plate (07 §4.1, §2.2 scene-label-plate).
      const labelled = lv !== 'glyph' || n.key || selected || hovered;
      if (labelled && n.name) {
        shown.add(v.id);
        this.label(v.id, n.name, s.x, s.y + R + 13 * U, 2 * R > 160);
      }
    }
    if (corners) g.stroke({ width: U, color: PAPER });
    if (hatched) this.hatching.stroke({ width: U, color: INK, alpha: 0.5 * fog.scene.pauseAlpha });
    rings.upload();
    for (const [id, l] of this.labels) l.visible = shown.has(id);
    hideFrom(this.platePool, this.plateUsed);
    hideFrom(this.badgePool, this.badgeUsed);
    hideFrom(this.textPool, this.textUsed);
    return animating;
  }

  private get uiCss(): number {
    return this.uiPx / this.dpr;
  }

  /** Snaps a CSS coordinate to the device pixel grid. */
  private snap(v: number): number {
    return Math.round(v * this.dpr) / this.dpr;
  }

  private badge(
    name: GlyphName,
    plate: Plate,
    cx: number,
    cy: number,
    scale = 1,
    alpha = 1,
    paper = plate === 'ink',
  ): void {
    let sprite = this.badgePool[this.badgeUsed];
    if (!sprite) {
      sprite = new Sprite();
      this.badgePool.push(sprite);
      this.badges.addChild(sprite);
    }
    this.badgeUsed++;
    const tex = this.glyphs.get(name, plate, scale, paper);
    sprite.texture = tex;
    sprite.position.set(this.snap(cx - tex.width / 2), this.snap(cy - tex.height / 2));
    sprite.alpha = alpha;
    sprite.visible = true;
  }

  private plate(x: number, y: number, w: number, h: number): void {
    let sprite = this.platePool[this.plateUsed];
    if (!sprite) {
      sprite = new Sprite({ texture: Texture.WHITE, tint: 0x000000, alpha: 0.7 });
      this.platePool.push(sprite);
      this.plates.addChild(sprite);
    }
    this.plateUsed++;
    sprite.position.set(x, y);
    sprite.width = w;
    sprite.height = h;
    sprite.visible = true;
  }

  private text(str: string, x: number, y: number): void {
    let t = this.textPool[this.textUsed];
    if (!t) {
      t = this.makeText(false);
      this.textPool.push(t);
      this.texts.addChild(t);
    }
    this.textUsed++;
    if (t.text !== str) t.text = str;
    t.position.set(this.snap(x), this.snap(y));
    t.visible = true;
  }

  private makeText(large: boolean): BitmapText {
    const px = large ? 2 * this.uiPx : this.uiPx;
    return new BitmapText({
      text: '',
      style: { fontFamily: labelFont(px, this.dpr), fontSize: px / this.dpr },
    });
  }

  private label(id: string, name: string, x: number, y: number, large: boolean): void {
    let t = this.labels.get(id);
    if (!t) {
      t = this.makeText(large);
      this.labels.set(id, t);
      this.texts.addChild(t);
    }
    const px = large ? 2 * this.uiPx : this.uiPx;
    const family = labelFont(px, this.dpr);
    if (t.style.fontFamily !== family) {
      t.style.fontFamily = family;
      t.style.fontSize = px / this.dpr;
    }
    // ≤ 160 px (07 §4.1): Departure Mono advances 0.636 em.
    const max = Math.max(4, Math.floor(LABEL_MAX / ((px / this.dpr) * 0.636)));
    const text = name.length > max ? `${name.slice(0, max - 1)}…` : name;
    if (t.text !== text) t.text = text;
    const U = this.u / this.dpr;
    const left = this.snap(x - t.width / 2);
    const top = this.snap(y);
    t.position.set(left, top);
    t.visible = true;
    this.plate(left - 2 * U, top - U, t.width + 4 * U, px / this.dpr + 2 * U);
  }
}

function hideFrom(pool: { visible: boolean }[], used: number): void {
  for (let i = used; i < pool.length; i++) {
    const item = pool[i];
    if (item) item.visible = false;
  }
}

function at(s: { x: number; y: number }, R: number, h: number): [number, number] {
  return [s.x + Math.cos(hour(h)) * R, s.y + Math.sin(hour(h)) * R];
}

function kindGlyph(n: GraphNode, big: boolean): GlyphName {
  return big ? n.kind : `${n.kind}-8`;
}

/** 45° hatching inside a circle, lines `step` apart (07 §4.5, «Пауза»). */
function hatch(g: Graphics, cx: number, cy: number, r: number, step: number): void {
  const k = Math.SQRT1_2;
  for (let t = -r + step / 2; t < r; t += step) {
    const half = Math.sqrt(r * r - t * t);
    // Normal (k, -k), direction (k, k).
    const mx = cx + k * t;
    const my = cy - k * t;
    g.moveTo(mx - k * half, my - k * half).lineTo(mx + k * half, my + k * half);
  }
}
