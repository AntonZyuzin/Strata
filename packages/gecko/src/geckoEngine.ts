import type { GeckoAnimation } from './geckoSprite';

/** Application events accepted by the companion. No application data is required. */
export type GeckoEvent =
  | 'task-created'
  | 'project-created'
  | 'file-created'
  | 'task-completed'
  | 'nodes-linked'
  | 'deadline-near';

export type GeckoMode =
  | 'home'
  | 'walking'
  | 'returning'
  | 'dragging'
  | 'reacting'
  | 'sleeping'
  | 'rope'
  | 'node';

/** Visible node, in the companion container's local CSS pixels. */
export interface GeckoNode {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  /** Circumradius: the circle's radius, or the hexagon's corner (Strata's ADR-0011). */
  readonly radius: number;
  /** A hexagon with a point up: the gecko walks its sides. A circle by default. */
  readonly hexagon?: boolean;
}

const HEX_IN = Math.sqrt(3) / 2;

/** Distance from the centre to the outline along `angle`, for circumradius 1. */
function outlineAt(node: GeckoNode, angle: number): number {
  if (!node.hexagon) return 1;
  const x = Math.cos(angle);
  const y = Math.sin(angle);
  // The hexagonal distance of Strata's canvas (hex.ts): normals (1, 0), (½, ±√3/2).
  return (
    HEX_IN / Math.max(Math.abs(x), Math.abs(0.5 * x + HEX_IN * y), Math.abs(0.5 * x - HEX_IN * y))
  );
}

/** The walk from the top of the outline down its right side to the bottom. */
function halfOutline(node: GeckoNode): number {
  // Three sides of the circumradius each, or half the circle.
  return node.hexagon ? 3 * node.radius : Math.PI * node.radius;
}

export type GeckoNodePhase = 'approach' | 'crawl' | 'hang' | 'recover';

export interface GeckoRope {
  readonly id: string;
  readonly start: { readonly x: number; readonly y: number };
  readonly end: { readonly x: number; readonly y: number };
}

export interface GeckoSnapshot {
  /** Top-left of the sprite, in the host container's local CSS pixels. */
  readonly x: number;
  readonly y: number;
  /** Exact CSS coordinates for smooth presentation; x/y retain their pixel grid. */
  readonly renderX: number;
  readonly renderY: number;
  readonly animation: GeckoAnimation;
  readonly animationVariant: 0 | 1 | 2;
  readonly sequenceId: number;
  readonly elapsedMs: number;
  readonly facing: 1 | -1;
  readonly mode: GeckoMode;
  readonly queueLength: number;
  readonly ropeId: string | null;
  readonly ropeProgress: number | null;
  readonly ropeWeight: number;
  readonly ropeAngle: number | null;
  readonly gripPhase: number | null;
  readonly nodeId: string | null;
  readonly nodePhase: GeckoNodePhase | null;
  readonly nodeElapsedMs: number | null;
  /** Unbounded gait cycles driven by distance, so planted paws match travel. */
  readonly locomotionPhase: number;
  /** Overhead crawling direction; the native drawing faces right. */
  readonly motionAngle: number;
  /** Entry/recovery blend; the host lowers the body while the tail grip stays fixed. */
  readonly tailHangProgress: number;
}

export interface GeckoEngineOptions {
  width?: number;
  height?: number;
  spriteWidth?: number;
  spriteHeight?: number;
  margin?: number;
  /** Walking speed, in CSS pixels per second. */
  speed?: number;
  /** Inject a seeded random function for deterministic walks. */
  random?: () => number;
  reducedMotion?: boolean;
  maxQueueLength?: number;
  /** Fixed home inactivity delay; Infinity disables automatic sleeping. */
  sleepAfterMs?: number;
}

export const GECKO_ROPE_SAG = 12;
export const GECKO_ROPE_DURATION = 8000;
export const GECKO_ROPE_ENTRY_DURATION = 450;
export const GECKO_NODE_HANG_DURATION = 3200;
export const GECKO_NODE_BLEND_DURATION = 600;

export const GECKO_REACTION_DURATIONS: Readonly<Record<GeckoEvent | 'pet', number>> = Object.freeze(
  {
    'task-created': 2000,
    'project-created': 2400,
    'file-created': 2000,
    'task-completed': 2400,
    'nodes-linked': 2400,
    'deadline-near': 2600,
    pet: 1800,
  },
);

const EVENT_PRIORITY: Record<GeckoEvent, number> = {
  'task-completed': 100,
  'nodes-linked': 60,
  'project-created': 50,
  'task-created': 40,
  'file-created': 30,
  'deadline-near': 10,
};

type Point = { x: number; y: number };
type TravelMode = 'home' | 'walking' | 'returning' | 'rope' | 'node';
type Variant = 0 | 1 | 2;
type Visual = { animation: GeckoAnimation; variant: Variant; elapsedMs: number };
type Reaction = { animation: GeckoEvent | 'pet'; elapsedMs: number; variant: Variant };
type QueuedEvent = { event: GeckoEvent; order: number; suspended?: Reaction | undefined };
type RopeVisit = {
  id: string;
  from: number;
  to: number;
  progress: number;
  elapsedMs: number;
  entryOrigin: Point;
  entryElapsedMs: number;
  variant: Variant;
};
type NodeVisit = {
  id: string;
  phase: GeckoNodePhase;
  elapsedMs: number;
  crawlProgress: number;
  visualElapsedMs: number;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const smooth = (value: number) => {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
};
const nonnegative = (value: number | undefined, fallback: number) =>
  value !== undefined && Number.isFinite(value) ? Math.max(0, value) : fallback;

/**
 * Timer-free companion state machine. Call tick from your render loop and feed it
 * local pointer coordinates. It never reads the DOM or changes application data.
 */
export class GeckoEngine {
  private width: number;
  private height: number;
  private spriteWidth: number;
  private spriteHeight: number;
  private readonly margin: number;
  private readonly speed: number;
  private readonly random: () => number;
  private readonly maxQueueLength: number;
  private readonly sleepAfterMs: number;
  private position: Point;
  private home: Point;
  private anchoredHome = true;
  private mode: GeckoMode = 'home';
  private resumeMode: TravelMode = 'home';
  private facing: 1 | -1 = -1;
  private animationElapsedMs = 0;
  private activeAnimation: GeckoAnimation = 'idle';
  private animationVariant: Variant = 0;
  private variantOverride: Variant | undefined;
  private sequenceId = 0;
  private lastVariants = new Map<GeckoAnimation, Variant>();
  private resumeVisual?: Visual;
  private variantElapsedMs = 0;
  private variantDelayMs = 6000;
  private reaction: Reaction | undefined;
  private queue: QueuedEvent[] = [];
  private nextOrder = 0;
  private waypoints: Point[] = [];
  private drag: { offset: Point; origin: Point } | undefined;
  private reducedMotion: boolean;
  private paused = false;
  private idleElapsedMs = 0;
  private sleepRequested = false;
  private ropes = new Map<string, GeckoRope>();
  private rope: RopeVisit | undefined;
  private nodes = new Map<string, GeckoNode>();
  private node: NodeVisit | undefined;
  private locomotionPhase = 0;
  private motionAngle = Math.PI;

  constructor(options: GeckoEngineOptions = {}) {
    this.width = nonnegative(options.width, 800);
    this.height = nonnegative(options.height, 600);
    this.spriteWidth = nonnegative(options.spriteWidth, 96);
    this.spriteHeight = nonnegative(options.spriteHeight, 72);
    this.margin = nonnegative(options.margin, 16);
    this.speed = Math.max(1, nonnegative(options.speed, 80));
    this.random = options.random ?? Math.random;
    this.maxQueueLength = Math.max(1, Math.floor(nonnegative(options.maxQueueLength, 5)));
    const sleepRandom = this.random();
    this.sleepAfterMs =
      options.sleepAfterMs === Infinity
        ? Infinity
        : options.sleepAfterMs !== undefined
          ? nonnegative(options.sleepAfterMs, 45000)
          : 45000 + clamp(Number.isFinite(sleepRandom) ? sleepRandom : 0.5, 0, 1) * 30000;
    this.reducedMotion = options.reducedMotion ?? false;
    this.home = this.defaultHome();
    this.position = { ...this.home };
    this.activate('idle');
  }

  get snapshot(): Readonly<GeckoSnapshot> {
    const rope = this.rope && this.ropes.get(this.rope.id);
    const weight = this.ropeWeight;
    const direction = this.rope && this.rope.to < this.rope.from ? -1 : 1;
    const tangentX = rope ? (rope.end.x - rope.start.x) * direction : 0;
    const tangentY =
      rope && this.rope
        ? (rope.end.y - rope.start.y + 48 * weight * (1 - 2 * this.rope.progress)) * direction
        : 0;
    return Object.freeze({
      x: Math.round(this.position.x),
      y: Math.round(this.position.y),
      renderX: this.position.x,
      renderY: this.position.y,
      animation: this.activeAnimation,
      animationVariant: this.animationVariant,
      sequenceId: this.sequenceId,
      elapsedMs: this.reducedMotion
        ? 0
        : this.reaction && this.mode === 'reacting'
          ? this.reaction.elapsedMs
          : this.animationElapsedMs,
      facing: this.facing,
      mode: this.mode,
      queueLength: this.queue.length,
      ropeId: this.rope?.id ?? null,
      ropeProgress: this.rope?.progress ?? null,
      ropeWeight: weight,
      ropeAngle: rope ? Math.atan2(tangentY, tangentX) : null,
      gripPhase: this.rope ? this.climbPhase(this.rope) : null,
      nodeId: this.node?.id ?? null,
      nodePhase: this.node?.phase ?? null,
      nodeElapsedMs: this.node?.visualElapsedMs ?? null,
      locomotionPhase: this.reducedMotion ? 0 : this.locomotionPhase,
      motionAngle: this.motionAngle,
      tailHangProgress: this.tailHangProgress,
    });
  }

  setBounds(
    width: number,
    height: number,
    spriteWidth = this.spriteWidth,
    spriteHeight = this.spriteHeight,
  ): void {
    this.width = nonnegative(width, this.width);
    this.height = nonnegative(height, this.height);
    this.spriteWidth = nonnegative(spriteWidth, this.spriteWidth);
    this.spriteHeight = nonnegative(spriteHeight, this.spriteHeight);
    this.home = this.anchoredHome ? this.defaultHome() : this.clampPoint(this.home);
    this.position = this.clampPoint(this.position);
    this.waypoints = this.waypoints.map((point) => this.clampPoint(point));
    if (
      this.mode === 'home' ||
      this.mode === 'sleeping' ||
      (this.mode === 'reacting' && this.resumeMode === 'home')
    ) {
      this.position = { ...this.home };
    }
    if (
      this.mode === 'returning' ||
      (this.mode === 'reacting' && this.resumeMode === 'returning')
    ) {
      this.waypoints = [{ ...this.home }];
    }
    if (this.drag) this.drag.origin = this.clampPoint(this.drag.origin);
    this.refreshRope();
    this.refreshNode();
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  /** Preview a particular performance. Clearing resumes automatic selection on the next activation. */
  setVariantOverride(variant?: Variant): void {
    if (variant !== undefined && variant !== 0 && variant !== 1 && variant !== 2) return;
    if (this.variantOverride === variant) return;
    this.variantOverride = variant;
    if (variant === undefined) return;
    if (this.rope) {
      const completion = this.climbCompletion(this.rope);
      this.rope.variant = variant;
      this.lastVariants.set('climb', variant);
      const timing = this.climbTiming(variant);
      let low = 0;
      let high = timing.cycleMs * timing.cycles;
      // Preserve the physical grip point when comparing different pull rhythms.
      for (let iteration = 0; iteration < 40; iteration++) {
        const middle = (low + high) / 2;
        if (this.climbCompletion({ ...this.rope, elapsedMs: middle }) < completion) low = middle;
        else high = middle;
      }
      this.rope.elapsedMs = completion <= 0 ? 0 : (low + high) / 2;
      const rope = this.ropes.get(this.rope.id);
      if (rope) this.placeOnRope(rope);
    }
    if (this.reaction) this.reaction.variant = variant;
    this.lastVariants.set(this.activeAnimation, variant);
    this.activate(
      this.activeAnimation,
      variant,
      this.activeAnimation === 'climb' && this.rope ? this.rope.elapsedMs : this.animationElapsedMs,
    );
  }

  setReducedMotion(reducedMotion: boolean): void {
    this.reducedMotion = reducedMotion;
    if (!reducedMotion || this.mode === 'dragging') return;
    this.waypoints = [];
    this.rope = undefined;
    this.node = undefined;
    this.resumeMode = 'home';
    this.position = { ...this.home };
    if (this.mode === 'reacting') this.resumeVisual = this.makeVisual('idle');
    else if (this.mode !== 'sleeping' && this.mode !== 'home') {
      this.mode = 'home';
      this.activate('idle');
    }
    this.animationElapsedMs = 0;
  }

  /** Host-provided node connections. Copies input so graph mutations cannot leak in. */
  setRopes(ropes: readonly GeckoRope[]): void {
    const next = new Map<string, GeckoRope>();
    for (const rope of ropes) {
      if (
        !rope ||
        typeof rope.id !== 'string' ||
        !rope.id.trim() ||
        next.has(rope.id) ||
        !rope.start ||
        !rope.end ||
        ![rope.start.x, rope.start.y, rope.end.x, rope.end.y].every(Number.isFinite) ||
        Math.hypot(rope.end.x - rope.start.x, rope.end.y - rope.start.y) < 24
      )
        continue;
      next.set(rope.id, { id: rope.id, start: { ...rope.start }, end: { ...rope.end } });
    }
    this.ropes = next;
    this.refreshRope();
  }

  /** Copy visible nodes so host graph updates cannot mutate an active visit. */
  setNodes(nodes: readonly GeckoNode[]): void {
    const next = new Map<string, GeckoNode>();
    for (const node of nodes) {
      if (
        !node ||
        typeof node.id !== 'string' ||
        !node.id.trim() ||
        next.has(node.id) ||
        ![node.x, node.y, node.radius].every(Number.isFinite) ||
        node.radius < 4
      )
        continue;
      next.set(node.id, { ...node });
    }
    this.nodes = next;
    this.refreshNode();
  }

  /** Crawl onto a node, slip down its rim, catch it with the tail, then recover. */
  climbNode(id?: string): boolean {
    if (this.paused || this.mode === 'dragging' || this.reducedMotion) return false;
    let chosen: GeckoNode | undefined;
    let nearest = Infinity;
    for (const node of this.nodes.values()) {
      if ((id !== undefined && node.id !== id) || !this.usableNode(node)) continue;
      const distance = Math.hypot(
        node.x - this.position.x - this.spriteWidth / 2,
        node.y - this.position.y - this.spriteHeight / 2,
      );
      if (distance < nearest) {
        chosen = node;
        nearest = distance;
      }
    }
    if (!chosen) return false;
    this.wake();
    this.rope = undefined;
    this.detachNode();
    this.waypoints = [];
    this.node = {
      id: chosen.id,
      phase: 'approach',
      elapsedMs: 0,
      crawlProgress: 0,
      visualElapsedMs: 0,
    };
    if (this.mode === 'reacting') {
      this.resumeMode = 'node';
      this.resumeVisual = this.makeVisual('walk');
    } else {
      this.mode = 'node';
      this.activate('walk');
    }
    return true;
  }

  /** Climb along the nearest usable connection, or the requested connection. */
  climbRope(id?: string): boolean {
    if (this.paused || this.mode === 'dragging' || this.reducedMotion) return false;
    const foot = {
      x: this.position.x + this.spriteWidth / 2,
      y: this.position.y + this.spriteHeight / 2,
    };
    let choice: { rope: GeckoRope; from: number; to: number; distance: number } | undefined;
    for (const rope of this.ropes.values()) {
      if (id !== undefined && rope.id !== id) continue;
      const interval = this.usableRopeInterval(rope);
      if (!interval) continue;
      let distance = Infinity;
      for (let index = 0; index <= 12; index++) {
        const point = this.ropePoint(
          rope,
          interval.from + ((interval.to - interval.from) * index) / 12,
        );
        distance = Math.min(distance, Math.hypot(point.x - foot.x, point.y - foot.y));
      }
      if (!choice || distance < choice.distance) choice = { rope, ...interval, distance };
    }
    if (!choice) return false;
    this.wake();
    this.detachNode();
    this.waypoints = [];
    const dx = choice.rope.end.x - choice.rope.start.x;
    const dy = choice.rope.end.y - choice.rope.start.y;
    const projection =
      ((foot.x - choice.rope.start.x) * dx + (foot.y - choice.rope.start.y) * dy) /
      (dx * dx + dy * dy);
    const from = clamp(projection, choice.from, choice.to);
    const to = from > (choice.from + choice.to) / 2 ? choice.from : choice.to;
    this.rope = {
      id: choice.rope.id,
      from,
      to,
      progress: from,
      elapsedMs: 0,
      entryOrigin: { ...this.position },
      entryElapsedMs: 0,
      variant: this.pickVariant('climb'),
    };
    this.placeOnRope(choice.rope);
    if (this.mode === 'reacting') {
      this.resumeMode = 'rope';
      this.resumeVisual = this.makeVisual('walk');
    } else {
      this.mode = 'rope';
      this.activate('walk');
    }
    return true;
  }

  /** Sleep at home; an ongoing excursion first returns to its saved home. */
  sleep(): boolean {
    if (this.paused || this.mode === 'dragging') return false;
    this.returnHome();
    this.sleepRequested = true;
    if (this.mode === 'home') {
      this.mode = 'sleeping';
      this.activate('sleep');
    }
    return true;
  }

  wake(): void {
    this.idleElapsedMs = 0;
    this.sleepRequested = false;
    if (this.mode === 'sleeping') {
      this.mode = 'home';
      this.activate('idle');
    }
  }

  /** A direct interaction always wins over queued application reactions. */
  pet(): boolean {
    if (this.mode === 'dragging') return false;
    this.wake();
    if (this.reaction && this.reaction.animation !== 'pet')
      this.enqueue(this.reaction.animation, this.reaction);
    this.beginReaction('pet');
    return true;
  }

  /** Take one short walk along the lower edge, then return to the saved home. */
  wander(): boolean {
    this.wake();
    if (this.mode === 'dragging' || this.reducedMotion) return false;
    if (this.climbNode()) return true;
    this.rope = undefined;
    this.node = undefined;
    const minX = Math.min(this.margin, this.maxX);
    const maxX = Math.max(minX, this.maxX - this.margin);
    const randomValue = this.random();
    const fraction = Number.isFinite(randomValue) ? clamp(randomValue, 0, 1) : 0.5;
    let destinationX = minX + (maxX - minX) * fraction;
    if (Math.abs(destinationX - this.position.x) < Math.min(70, (maxX - minX) / 3)) {
      destinationX = this.position.x > (minX + maxX) / 2 ? minX : maxX;
    }
    const laneY = Math.max(0, this.maxY - this.margin);
    this.waypoints = [];
    if (Math.abs(this.position.y - laneY) > 1)
      this.waypoints.push({ x: this.position.x, y: laneY });
    this.waypoints.push({ x: destinationX, y: laneY });
    if (this.mode === 'reacting') {
      this.resumeMode = 'walking';
      this.resumeVisual = this.makeVisual('walk');
    } else {
      this.mode = 'walking';
      this.activate('walk');
    }
    return true;
  }

  returnHome(): void {
    if (this.mode === 'dragging') return;
    this.wake();
    this.rope = undefined;
    this.detachNode();
    if (this.position.x === this.home.x && this.position.y === this.home.y) {
      this.waypoints = [];
      this.resumeMode = 'home';
      if (this.mode === 'reacting') {
        if (this.resumeVisual?.animation !== 'idle') this.resumeVisual = this.makeVisual('idle');
      } else if (this.mode !== 'home') {
        this.mode = 'home';
        this.activate('idle');
      }
      return;
    }
    this.waypoints = [{ ...this.home }];
    if (this.reducedMotion) {
      this.position = { ...this.home };
      this.waypoints = [];
      this.resumeMode = 'home';
      if (this.mode === 'reacting') this.resumeVisual = this.makeVisual('idle');
      else if (this.mode !== 'home') {
        this.mode = 'home';
        this.activate('idle');
      }
      return;
    }
    if (this.mode === 'reacting') {
      this.resumeMode = 'returning';
      if (this.resumeVisual?.animation !== 'walk') this.resumeVisual = this.makeVisual('walk');
    } else {
      this.mode = 'returning';
      if (this.activeAnimation !== 'walk') this.activate('walk');
    }
  }

  /** Coordinates are the pointer's position inside the companion's container. */
  startDrag(x: number, y: number): boolean {
    if (this.mode === 'dragging' || !Number.isFinite(x) || !Number.isFinite(y)) return false;
    this.wake();
    this.rope = undefined;
    this.detachNode();
    this.drag = {
      offset: { x: x - this.position.x, y: y - this.position.y },
      origin: { ...this.position },
    };
    this.waypoints = [];
    this.resumeMode = 'home';
    this.resumeVisual = this.makeVisual('idle');
    this.mode = 'dragging';
    this.activate('drag');
    return true;
  }

  dragTo(x: number, y: number): void {
    if (!this.drag || !Number.isFinite(x) || !Number.isFinite(y)) return;
    const point = this.clampPoint({ x: x - this.drag.offset.x, y: y - this.drag.offset.y });
    if (Math.abs(point.x - this.position.x) > 1) this.facing = point.x > this.position.x ? 1 : -1;
    this.position = point;
  }

  /** Dropping establishes a new home. There is deliberately no falling physics. */
  endDrag(): void {
    if (!this.drag) return;
    this.drag = undefined;
    this.home = { ...this.position };
    this.anchoredHome = false;
    this.finishDrag();
  }

  /** Cancelling restores the pre-drag position without moving the saved home. */
  cancelDrag(): void {
    if (!this.drag) return;
    this.position = this.clampPoint(this.drag.origin);
    this.drag = undefined;
    this.finishDrag();
    if (this.position.x !== this.home.x || this.position.y !== this.home.y) this.returnHome();
  }

  /** Returns false when this exact event is already active or waiting. */
  trigger(event: GeckoEvent): boolean {
    if (this.paused || !Object.hasOwn(EVENT_PRIORITY, event)) return false;
    this.wake();
    if (this.reaction?.animation === event || this.queue.some((item) => item.event === event))
      return false;
    if (this.mode === 'dragging') return this.enqueue(event);
    if (!this.reaction) {
      this.beginReaction(event);
      return true;
    }
    if (
      this.reaction.animation !== 'pet' &&
      EVENT_PRIORITY[event] > EVENT_PRIORITY[this.reaction.animation]
    ) {
      this.enqueue(this.reaction.animation, this.reaction);
      this.beginReaction(event);
      return true;
    }
    return this.enqueue(event);
  }

  /** Advance across reaction and travel boundaries, even after a long frame. */
  tick(deltaMs: number): void {
    if (this.paused || !Number.isFinite(deltaMs) || deltaMs <= 0) return;
    if (this.mode === 'dragging') {
      // Animate the held pose without advancing the suspended reaction or queue.
      // A common 2π-second period preserves the renderer's integer sine rates.
      this.animationElapsedMs = (this.animationElapsedMs + deltaMs) % (Math.PI * 2000);
      return;
    }
    let remaining = deltaMs;
    // The queue is bounded and a walk has at most three legs. This guard also
    // protects callers who supply a pathological sequence of zero-sized bounds.
    let transitions = 0;
    while (remaining > 0 && transitions++ < this.maxQueueLength + 16) {
      if (this.mode === 'reacting' && this.reaction) {
        const duration = GECKO_REACTION_DURATIONS[this.reaction.animation];
        const step = Math.min(remaining, duration - this.reaction.elapsedMs);
        this.reaction.elapsedMs += step;
        remaining -= step;
        if (this.reaction.elapsedMs >= duration) {
          this.reaction = undefined;
          this.mode = this.resumeMode;
          this.restoreVisual(this.resumeVisual ?? this.makeVisual('idle'));
          this.startNextReaction();
          if (!this.reaction && this.mode === 'home' && this.sleepRequested) {
            this.mode = 'sleeping';
            this.activate('sleep');
          }
        }
        continue;
      }
      if (this.mode === 'sleeping') {
        this.advanceResting(remaining, 'sleep');
        break;
      }
      if (this.mode === 'node' && this.node) {
        const node = this.nodes.get(this.node.id);
        if (!node || !this.usableNode(node)) {
          this.returnHome();
          continue;
        }
        if (this.node.phase === 'approach') {
          const target = this.nodePoint(node, 0);
          const distance = Math.hypot(target.x - this.position.x, target.y - this.position.y);
          const duration = (distance / this.speed) * 1000;
          const step = Math.min(remaining, duration);
          if (distance > 0.001) {
            const dx = target.x - this.position.x;
            const dy = target.y - this.position.y;
            const fraction = step / duration;
            this.advanceGait(distance * fraction, Math.atan2(dy, dx));
            this.position = {
              x: this.position.x + dx * fraction,
              y: this.position.y + dy * fraction,
            };
          }
          remaining -= step;
          this.animationElapsedMs += step;
          this.node.visualElapsedMs += step;
          if (step >= duration || distance <= 0.001) {
            this.position = target;
            this.node.phase = 'crawl';
            this.node.elapsedMs = 0;
            this.motionAngle = 0;
          }
          continue;
        }
        if (this.node.phase === 'crawl') {
          const duration = (halfOutline(node) * 1000) / this.speed;
          const step = Math.min(remaining, duration - this.node.elapsedMs);
          this.node.elapsedMs += step;
          this.node.crawlProgress = clamp(this.node.elapsedMs / duration, 0, 1);
          this.position = this.nodePoint(node, this.node.crawlProgress);
          this.advanceGait((step * this.speed) / 1000, Math.PI * this.node.crawlProgress);
          this.animationElapsedMs += step;
          this.node.visualElapsedMs += step;
          remaining -= step;
          if (this.node.crawlProgress >= 1) {
            this.node.phase = 'hang';
            this.node.elapsedMs = 0;
            this.node.visualElapsedMs = 0;
            this.activate('tail-hang');
          }
          continue;
        }
        const duration =
          this.node.phase === 'hang' ? GECKO_NODE_HANG_DURATION : GECKO_NODE_BLEND_DURATION;
        const step = Math.min(remaining, duration - this.node.elapsedMs);
        this.node.elapsedMs += step;
        this.animationElapsedMs += step;
        this.node.visualElapsedMs += step;
        remaining -= step;
        if (this.node.elapsedMs >= duration) {
          if (this.node.phase === 'hang') {
            this.node.phase = 'recover';
            this.node.elapsedMs = 0;
          } else this.returnHome();
        }
        continue;
      }
      if (this.mode === 'rope' && this.rope) {
        const rope = this.ropes.get(this.rope.id);
        if (this.rope.entryElapsedMs < GECKO_ROPE_ENTRY_DURATION) {
          const step = Math.min(remaining, GECKO_ROPE_ENTRY_DURATION - this.rope.entryElapsedMs);
          this.rope.entryElapsedMs += step;
          if (rope) this.placeOnRope(rope);
          this.animationElapsedMs += step;
          remaining -= step;
          if (this.rope.entryElapsedMs >= GECKO_ROPE_ENTRY_DURATION)
            this.activate('climb', this.rope.variant);
          if (!rope) this.returnHome();
          continue;
        }
        const timing = this.climbTiming(this.rope.variant);
        const duration = timing.cycleMs * timing.cycles;
        const step = Math.min(remaining, duration - this.rope.elapsedMs);
        this.rope.elapsedMs += step;
        this.rope.progress =
          this.rope.from + (this.rope.to - this.rope.from) * this.climbCompletion(this.rope);
        if (rope) this.placeOnRope(rope);
        this.animationElapsedMs = this.rope.elapsedMs;
        remaining -= step;
        if (this.rope.elapsedMs >= duration || !rope) this.returnHome();
        continue;
      }
      if (this.mode === 'home') {
        const untilSleep = this.reducedMotion
          ? Infinity
          : Math.max(0, this.sleepAfterMs - this.idleElapsedMs);
        const step = Math.min(remaining, untilSleep);
        this.idleElapsedMs += step;
        this.advanceResting(step, 'idle');
        remaining -= step;
        if (!this.reducedMotion && this.idleElapsedMs >= this.sleepAfterMs) {
          this.mode = 'sleeping';
          this.activate('sleep');
          continue;
        }
        break;
      }
      const target = this.waypoints[0];
      if (!target) {
        this.finishTravelLeg();
        continue;
      }
      const dx = target.x - this.position.x;
      const dy = target.y - this.position.y;
      const distance = Math.hypot(dx, dy);
      if (Math.abs(dx) > 0.001) this.facing = dx > 0 ? 1 : -1;
      if (distance < 0.001) {
        this.position = { ...target };
        this.waypoints.shift();
        if (!this.waypoints.length) this.finishTravelLeg();
        continue;
      }
      const duration = (distance / this.speed) * 1000;
      const step = Math.min(remaining, duration);
      const fraction = step / duration;
      this.advanceGait(distance * fraction, Math.atan2(dy, dx));
      this.position = this.clampPoint({
        x: this.position.x + dx * fraction,
        y: this.position.y + dy * fraction,
      });
      this.animationElapsedMs = (this.animationElapsedMs + step) % 800;
      remaining -= step;
      if (step >= duration) {
        this.position = { ...target };
        this.waypoints.shift();
        if (!this.waypoints.length) this.finishTravelLeg();
      }
    }
  }

  private get maxX(): number {
    return Math.max(0, Math.floor(this.width - this.spriteWidth));
  }
  private get maxY(): number {
    return Math.max(0, Math.floor(this.height - this.spriteHeight));
  }

  private get tailHangProgress(): number {
    if (!this.node) return 0;
    if (this.node.phase === 'hang') return smooth(this.node.elapsedMs / GECKO_NODE_BLEND_DURATION);
    if (this.node.phase === 'recover')
      return 1 - smooth(this.node.elapsedMs / GECKO_NODE_BLEND_DURATION);
    return 0;
  }

  private advanceGait(distance: number, angle: number): void {
    this.locomotionPhase += distance / Math.max(1, (10 * this.spriteWidth) / 96);
    this.motionAngle = angle;
    const dx = Math.cos(angle);
    if (Math.abs(dx) > 0.001) this.facing = dx >= 0 ? 1 : -1;
  }

  private usableNode(node: GeckoNode): boolean {
    return (
      node.x - node.radius >= this.spriteWidth / 2 &&
      node.x + node.radius <= this.width - this.spriteWidth / 2 &&
      node.y - node.radius >= this.spriteHeight / 2 &&
      node.y + node.radius + this.spriteHeight / 2 + this.spriteHeight / 3 <= this.height
    );
  }

  private nodePoint(node: GeckoNode, progress: number): Point {
    const angle = -Math.PI / 2 + progress * Math.PI;
    const r = node.radius * outlineAt(node, angle);
    return {
      x: node.x + Math.cos(angle) * r - this.spriteWidth / 2,
      y: node.y + Math.sin(angle) * r - this.spriteHeight / 2,
    };
  }

  private refreshNode(): void {
    if (!this.node) return;
    const node = this.nodes.get(this.node.id);
    if (!node || !this.usableNode(node)) {
      this.returnHome();
      return;
    }
    if (this.node.phase === 'crawl')
      this.node.elapsedMs = (this.node.crawlProgress * halfOutline(node) * 1000) / this.speed;
    if (this.node.phase !== 'approach')
      this.position = this.nodePoint(node, this.node.crawlProgress);
  }

  /** Preserve the presented body position when its fixed tail attachment disappears. */
  private detachNode(): void {
    if (!this.node) return;
    this.position = this.clampPoint({
      x: this.position.x,
      y: this.position.y + (this.spriteHeight / 3) * this.tailHangProgress,
    });
    this.node = undefined;
  }

  private randomUnit(): number {
    const value = this.random();
    return Number.isFinite(value) ? clamp(value, 0, 1 - Number.EPSILON) : 0.5;
  }

  private pickVariant(animation: GeckoAnimation): Variant {
    if (this.variantOverride !== undefined) {
      this.lastVariants.set(animation, this.variantOverride);
      return this.variantOverride;
    }
    const previous = this.lastVariants.get(animation);
    const variant = (
      previous === undefined
        ? Math.floor(this.randomUnit() * 3)
        : (previous + 1 + Math.floor(this.randomUnit() * 2)) % 3
    ) as Variant;
    this.lastVariants.set(animation, variant);
    return variant;
  }

  private captureVisual(): Visual {
    return {
      animation: this.activeAnimation,
      variant: this.animationVariant,
      elapsedMs: this.animationElapsedMs,
    };
  }

  private makeVisual(animation: GeckoAnimation): Visual {
    return { animation, variant: this.pickVariant(animation), elapsedMs: 0 };
  }

  private activate(
    animation: GeckoAnimation,
    variant = this.pickVariant(animation),
    elapsedMs = 0,
  ): void {
    this.activeAnimation = animation;
    this.animationVariant = this.variantOverride ?? variant;
    this.animationElapsedMs = elapsedMs;
    this.variantElapsedMs = elapsedMs;
    this.variantDelayMs =
      animation === 'sleep' ? 8000 + this.randomUnit() * 4000 : 6000 + this.randomUnit() * 3000;
    this.sequenceId++;
  }

  private restoreVisual(visual: Visual): void {
    this.activate(visual.animation, visual.variant, visual.elapsedMs);
  }

  private advanceResting(deltaMs: number, animation: 'idle' | 'sleep'): void {
    this.animationElapsedMs += deltaMs;
    this.variantElapsedMs += deltaMs;
    if (!this.reducedMotion && this.variantElapsedMs >= this.variantDelayMs) {
      const overrun = this.variantElapsedMs - this.variantDelayMs;
      this.activate(animation);
      // Avoid processing millions of cosmetic activations after a huge frame.
      this.animationElapsedMs = overrun % this.variantDelayMs;
      this.variantElapsedMs = this.animationElapsedMs;
    }
  }

  private climbTiming(variant: Variant): { cycleMs: number; cycles: number } {
    return variant === 1
      ? { cycleMs: 800, cycles: 10 }
      : variant === 2
        ? { cycleMs: 1250, cycles: 8 }
        : { cycleMs: 1000, cycles: 8 };
  }

  private climbPhase(visit: RopeVisit): number {
    const { cycleMs } = this.climbTiming(visit.variant);
    return (visit.elapsedMs % cycleMs) / cycleMs;
  }

  private climbCompletion(visit: RopeVisit): number {
    const { cycleMs, cycles } = this.climbTiming(visit.variant);
    if (visit.elapsedMs >= cycleMs * cycles) return 1;
    const cycle = Math.floor(visit.elapsedMs / cycleMs);
    const phase = this.climbPhase(visit);
    const smooth = (from: number, to: number) => {
      const x = clamp((phase - from) / (to - from), 0, 1);
      return x * x * (3 - 2 * x);
    };
    const pull =
      visit.variant === 1
        ? 0.5 * smooth(0.08, 0.35) + 0.5 * smooth(0.55, 0.82)
        : visit.variant === 2
          ? smooth(0.3, 0.82)
          : smooth(0.18, 0.78);
    return (cycle + pull) / cycles;
  }

  private get ropeWeight(): number {
    if (!this.rope) return 0;
    const entryWeight = clamp(
      (this.rope.entryElapsedMs / GECKO_ROPE_ENTRY_DURATION - 0.75) * 4,
      0,
      1,
    );
    return entryWeight * (0.925 + 0.075 * Math.cos(this.climbPhase(this.rope) * Math.PI * 2));
  }

  private defaultHome(): Point {
    return { x: Math.max(0, this.maxX - this.margin), y: Math.max(0, this.maxY - this.margin) };
  }

  private clampPoint(point: Point): Point {
    return { x: clamp(point.x, 0, this.maxX), y: clamp(point.y, 0, this.maxY) };
  }

  private ropePoint(rope: GeckoRope, progress: number, weight = 1): Point {
    return {
      x: rope.start.x + (rope.end.x - rope.start.x) * progress,
      y:
        rope.start.y +
        (rope.end.y - rope.start.y) * progress +
        GECKO_ROPE_SAG * 4 * weight * progress * (1 - progress),
    };
  }

  /** Find an interior segment where the body center can grip the rope in bounds. */
  private usableRopeInterval(rope: GeckoRope): { from: number; to: number } | undefined {
    let currentFrom = -1;
    let best: { from: number; to: number } | undefined;
    for (let sample = 10; sample <= 90; sample++) {
      const progress = sample / 100;
      const point = this.ropePoint(rope, progress);
      const lighterPoint = this.ropePoint(rope, progress, 0.85);
      const x = point.x - this.spriteWidth / 2;
      const y = point.y - this.spriteHeight / 2;
      const lighterY = lighterPoint.y - this.spriteHeight / 2;
      const fits = x >= 0 && lighterY >= 0 && x <= this.maxX && y <= this.maxY;
      if (fits && currentFrom < 0) currentFrom = progress;
      if (currentFrom >= 0 && (!fits || sample === 90)) {
        const to = fits ? progress : progress - 0.01;
        if (!best || to - currentFrom > best.to - best.from) best = { from: currentFrom, to };
        currentFrom = -1;
      }
    }
    if (!best) return undefined;
    const from = Math.max(0.2, best.from);
    const to = Math.min(0.8, best.to);
    if (
      to - from < 0.12 ||
      Math.hypot(rope.end.x - rope.start.x, rope.end.y - rope.start.y) * (to - from) < 24
    )
      return undefined;
    return { from, to };
  }

  private placeOnRope(rope: GeckoRope): void {
    if (!this.rope) return;
    const point = this.ropePoint(rope, this.rope.progress, this.ropeWeight);
    const target = {
      x: point.x - this.spriteWidth / 2,
      y: point.y - this.spriteHeight / 2,
    };
    const progress = clamp(this.rope.entryElapsedMs / GECKO_ROPE_ENTRY_DURATION, 0, 1);
    this.position =
      progress < 1
        ? this.clampPoint({
            x: this.rope.entryOrigin.x + (target.x - this.rope.entryOrigin.x) * progress,
            y:
              this.rope.entryOrigin.y +
              (target.y - this.rope.entryOrigin.y) * progress -
              Math.sin(progress * Math.PI) * 20,
          })
        : target;
    this.facing = (rope.end.x - rope.start.x) * (this.rope.to - this.rope.from) >= 0 ? 1 : -1;
  }

  private refreshRope(): void {
    if (!this.rope) return;
    const rope = this.ropes.get(this.rope.id);
    const interval = rope && this.usableRopeInterval(rope);
    if (!rope || !interval) {
      this.returnHome();
      return;
    }
    const forward = this.rope.to > this.rope.from;
    this.rope.from = clamp(this.rope.from, interval.from, interval.to);
    this.rope.to = forward ? interval.to : interval.from;
    this.rope.progress =
      this.rope.from + (this.rope.to - this.rope.from) * this.climbCompletion(this.rope);
    this.rope.entryOrigin = this.clampPoint(this.rope.entryOrigin);
    this.placeOnRope(rope);
  }

  private enqueue(event: GeckoEvent, suspended?: Reaction): boolean {
    if (this.queue.some((item) => item.event === event)) return false;
    const item = {
      event,
      order: this.nextOrder++,
      suspended: suspended ? { ...suspended } : undefined,
    };
    this.queue.push(item);
    this.queue.sort(
      (a, b) => EVENT_PRIORITY[b.event] - EVENT_PRIORITY[a.event] || a.order - b.order,
    );
    this.queue.length = Math.min(this.queue.length, this.maxQueueLength);
    return this.queue.includes(item);
  }

  private beginReaction(animation: GeckoEvent | 'pet', suspended?: Reaction): void {
    if (this.mode !== 'reacting') {
      this.resumeMode =
        this.mode === 'walking' ||
        this.mode === 'returning' ||
        this.mode === 'rope' ||
        this.mode === 'node'
          ? this.mode
          : 'home';
      this.resumeVisual = this.captureVisual();
    }
    this.reaction = suspended
      ? { ...suspended }
      : { animation, elapsedMs: 0, variant: this.pickVariant(animation) };
    this.mode = 'reacting';
    this.activate(animation, this.reaction.variant, this.reaction.elapsedMs);
  }

  private startNextReaction(): void {
    const next = this.queue.shift();
    if (next) this.beginReaction(next.event, next.suspended);
  }

  private finishTravelLeg(): void {
    if (this.mode === 'walking') {
      this.mode = 'returning';
      this.waypoints = [{ ...this.home }];
    } else {
      this.position = { ...this.home };
      this.mode = this.sleepRequested ? 'sleeping' : 'home';
      this.waypoints = [];
      this.activate(this.mode === 'sleeping' ? 'sleep' : 'idle');
    }
  }

  private finishDrag(): void {
    this.resumeMode = 'home';
    this.mode = this.reaction ? 'reacting' : 'home';
    if (this.reaction)
      this.activate(this.reaction.animation, this.reaction.variant, this.reaction.elapsedMs);
    else {
      this.restoreVisual(this.resumeVisual ?? this.makeVisual('idle'));
      this.startNextReaction();
    }
  }
}
