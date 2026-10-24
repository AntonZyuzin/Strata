import type { GraphNode } from '@strata/backend';
import { fog, type GlyphName, hex, palette, people } from '@strata/design-tokens';
import { BitmapText, Container, Graphics, Sprite, Texture } from 'pixi.js';
import { ArrowLayer } from './arrows';
import type { Camera } from './camera';
import { controls } from './curve';
import {
  arrowOn,
  isClosed,
  levelOf,
  nodeAlpha,
  over,
  type RimMark,
  rimSlot,
  socketAt,
  statusGlyph,
  type WireEndStyle,
} from './looks';
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
  /** Targets of the wires drawn out of this node. */
  outputs: readonly DecorNode[];
}

/** Clock hours of the rim (06 §4.1, 07 §4.1) as angles from 3 o'clock, clockwise. */
function hour(h: number): number {
  return (h / 12) * Math.PI * 2 - Math.PI / 2;
}

const PAPER = hex(palette.paper);
const INK = hex(palette.ink850);
const YELLOW = hex(palette.yellow500);
const RED = hex(palette.red500);
const ACCENT = hex(fog.scene.accent);
const RIM = fog.scene.rimAlpha;
/** One «today» pulse and the count (07 §4.5): 3 × 800 ms on first sight, then still. */
const PULSE_MS = fog.dur.pulse;
const PULSES = 3;
/** Marching ants of the current node run 3 s, then stand (07 §2.8). */
const ANTS_MS = 3000;
const LABEL_MAX = 160;
/** Wire ends (07 §5): sockets of radius 4u with a ring 1u, arrowheads in u. */
/** A wire end's socket radius, u (owner, 2026-10-24: bigger, on both ends). */
const SOCKET = 6;
const ARROW = { length: 10, half: 5 };
/** The midway arrow of `both`: at 60 % of the wire, as the chevron of 06 §6.3. */
const MID = { t: 0.6, length: 8, half: 4 };
/** Half-size of a rim glyph: 8u picture on a 2u plate (textures.ts). */
const GLYPH_REACH = 6;
const CORNERS = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
] as const;

export class Decor {
  readonly container = new Container();
  private readonly rings: RingLayer;
  private readonly arrows = new ArrowLayer();
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
  /** A deadline in a word under the label (07 §4.6, Q-07-22). */
  private readonly dues = new Map<string, BitmapText>();
  private readonly glyphs: GlyphTextures;
  private readonly pulseStart = new Map<string, number>();
  private plateUsed = 0;
  private badgeUsed = 0;
  private textUsed = 0;
  private antsFor: string | null = null;
  private antsStart = 0;
  reducedMotion = false;
  ends: WireEndStyle = 'sockets';
  /** The kind glyph at six o'clock; off when the icon inside shows the kind. */
  kindBadge = true;
  /**
   * A near or past deadline in words, in the viewer's language («через 2 дн.»,
   * «сегодня», «−3 дн.»; 07 §4.6, Q-07-22); none for the rest.
   */
  dueWord: (n: GraphNode) => string | null = () => null;
  /** The network's wires are straight (06 §6.2): sockets sit on the line of centres. */
  straight = false;
  /**
   * World control points of the wire `a → b` as the wire layer draws it, a
   * kinetic wire's lag included (06 §6.8): arrowheads ride the drawn curve.
   */
  curveOf: (a: DecorNode, b: DecorNode) => readonly number[] = (a, b) =>
    controls({ ax: a.x, ay: a.y, bx: b.x, by: b.y, ra: a.r, rb: b.r, straight: this.straight });

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
      this.arrows.mesh,
      this.g,
      this.badges,
      this.plates,
      this.texts,
    );
  }

  destroy(): void {
    this.glyphs.destroy();
    this.rings.destroy();
    this.arrows.destroy();
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
  ): boolean {
    const g = this.g;
    const rings = this.rings;
    g.clear();
    this.hatching.clear();
    rings.clear();
    this.arrows.clear();
    this.plateUsed = 0;
    this.badgeUsed = 0;
    this.textUsed = 0;
    const U = this.u / this.dpr;
    const shown = new Set<string>();
    const dated = new Set<string>();
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

      // A colour is the rim itself, 6u across it (owner, 2026-10-24: thicker
      // than the 3u band of 07 §4.3, readable from afar).
      const coloured = n.color !== null && !n.ghost;
      const tint = hex(people[n.color ?? 0] ?? palette.paper);
      if (coloured) {
        rings.add(s.x, s.y, R - U, 6 * U, { color: tint, alpha: a });
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
      } else if (!coloured) {
        rings.add(s.x, s.y, R - 0.5 * U, U, { color: INK, alpha: RIM * a });
      }
      // Folders and projects: the second ring of the «stack» (07 §4.4).
      if ((n.kind === 'network' || n.kind === 'project') && R > 10 * U) {
        rings.add(s.x, s.y, R - 6.5 * U, U, { color: INK, alpha: RIM * a });
      }
      // Key: a paper contour outside the rim makes the double rim (07 §4.5).
      if (n.key) rings.add(s.x, s.y, R + 2.5 * U, U, { color: PAPER, alpha: a });

      // Wire ends (07 §5, ✅ S9 2026-10-23) from the icon level up, over the rim
      // and under the assignees and glyphs: a solid socket where a wire leaves,
      // a hollow socket or an arrowhead where it enters.
      const taken: RimMark[] = [];
      // Opaque even on a dimmed node: paper already blended over the Scene,
      // so the wire under a mark never shows through (✅ S9 2026-10-23).
      const paper = over(INK, PAPER, a);
      // A socket, the same on both ends (owner, 2026-10-24): a dark disc,
      // a ring and a dot in the node's colour, or paper.
      const mark = coloured ? tint : paper;
      const socket = (x: number, y: number) => {
        rings.dot(x, y, SOCKET * U, INK);
        rings.add(x, y, (SOCKET - 2) * U, 1.5 * U, { color: mark });
        rings.dot(x, y, 2 * U, mark);
      };
      if (lv !== 'glyph') {
        for (const dst of v.outputs) {
          const p = socketAt(v, dst, this.straight);
          if (!p) continue;
          taken.push({ angle: Math.atan2(p.dy, p.dx), reach: SOCKET * U });
          socket(s.x + p.dx * R, s.y + p.dy * R);
        }
        for (const src of v.inputs) {
          const p = socketAt(v, src, this.straight);
          if (!p) continue;
          // An arrowhead touches the rim with its tip only.
          const reach = this.ends === 'arrow' ? (ARROW.half / 2) * U : SOCKET * U;
          taken.push({ angle: Math.atan2(p.dy, p.dx), reach });
          if (this.ends !== 'arrow') socket(s.x + p.dx * R, s.y + p.dy * R);
          if (this.ends === 'sockets') continue;
          const c = toScreen(cam, this.curveOf(src, v));
          const head = this.ends === 'arrow' ? ARROW : MID;
          // The midway arrow only on wires long enough to carry it.
          const span = Math.hypot((c[6] ?? 0) - (c[0] ?? 0), (c[7] ?? 0) - (c[1] ?? 0));
          if (head === MID && span < 6 * MID.length * U) continue;
          const tip = arrowOn(c, head === MID ? MID.t : 1, head.length * U);
          if (tip) {
            this.arrows.add(tip.x, tip.y, tip.dx, tip.dy, head.length * U, head.half * U, paper);
          }
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
      } else if (due === 'soon') {
        // A thin yellow ring (Q-07-22): the glow did not show at 100 %.
        rings.add(s.x, s.y, R + 5 * U, U, { color: YELLOW });
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
            color: ACCENT,
            dash: 3 * U,
            gap: 3 * U,
            offset: running ? (t / 50) * U : 0,
          });
        } else {
          rings.add(s.x, s.y, R + 10 * U, 2 * U, { color: ACCENT });
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
        rings.add(s.x, s.y, R + 10 * U, U, { color: ACCENT });
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
        // Each glyph takes its hour unless a wire end or an earlier glyph is there (07 §4.7 rule 5).
        const slot = (h: number) => onRim(s, R, rimSlot(h, GLYPH_REACH * U, taken, R, U));
        if (status) this.badge(status[0], status[1], ...slot(4.5));
        // One hour, one glyph: the second flag moves an hour clockwise (07 §4.7 rule 5).
        let flagHour = 10.5;
        if (n.pause) {
          this.badge('pause', 'ink', ...slot(flagHour));
          flagHour += 1;
        }
        if (n.template) this.badge('template', 'ink', ...slot(flagHour));
        if (n.appearance) this.badge('shortcut', 'ink', ...slot(7.5));
        if (n.external > 0) {
          const [ex, ey] = slot(1.5);
          this.badge('external', 'ink', ex, ey);
          this.text(String(n.external), ex + 7 * U, ey - this.uiCss / 2);
        }
        if (!n.ghost && this.kindBadge) this.badge(kindGlyph(n, false), 'ink', ...slot(6));
      }

      // Label under the rings on a plate (07 §4.1, §2.2 scene-label-plate).
      const labelled = lv !== 'glyph' || n.key || selected || hovered;
      if (labelled && n.name) {
        shown.add(v.id);
        const large = 2 * R > 160;
        this.label(v.id, n.name, s.x, s.y + R + 13 * U, large);
        // The deadline in words under the label, in its state's colour (Q-07-22).
        const word =
          due === 'soon' || due === 'today' || due === 'overdue' ? this.dueWord(n) : null;
        if (word) {
          const line = (large ? 2 : 1) * this.uiCss + 3 * U;
          this.due(v.id, word, s.x, s.y + R + 13 * U + line, due === 'overdue' ? RED : YELLOW);
          dated.add(v.id);
        }
      }
    }
    if (corners) g.stroke({ width: U, color: ACCENT });
    if (hatched) this.hatching.stroke({ width: U, color: INK, alpha: 0.5 * fog.scene.pauseAlpha });
    rings.upload();
    this.arrows.upload();
    for (const [id, l] of this.labels) l.visible = shown.has(id);
    for (const [id, l] of this.dues) l.visible = dated.has(id);
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

  private due(id: string, word: string, x: number, y: number, color: number): void {
    let t = this.dues.get(id);
    if (!t) {
      t = this.makeText(false);
      this.dues.set(id, t);
      this.texts.addChild(t);
    }
    if (t.text !== word) t.text = word;
    t.tint = color;
    const U = this.u / this.dpr;
    const left = this.snap(x - t.width / 2);
    const top = this.snap(y);
    t.position.set(left, top);
    t.visible = true;
    this.plate(left - 2 * U, top - U, t.width + 4 * U, this.uiCss + 2 * U);
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

/** World control points on screen. */
function toScreen(cam: Camera, c: readonly number[]): number[] {
  return c.map((v, i) => (v - (i % 2 === 0 ? cam.x : cam.y)) * cam.zoom);
}

function at(s: { x: number; y: number }, R: number, h: number): [number, number] {
  return onRim(s, R, hour(h));
}

function onRim(s: { x: number; y: number }, R: number, angle: number): [number, number] {
  return [s.x + Math.cos(angle) * R, s.y + Math.sin(angle) * R];
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
