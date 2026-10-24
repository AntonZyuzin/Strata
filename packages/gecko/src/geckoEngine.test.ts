import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { GeckoEvent, GeckoNodePhase, GeckoRope } from './geckoEngine';
import {
  GECKO_NODE_BLEND_DURATION,
  GECKO_NODE_HANG_DURATION,
  GECKO_REACTION_DURATIONS,
  GECKO_ROPE_DURATION,
  GECKO_ROPE_ENTRY_DURATION,
  GeckoEngine,
} from './geckoEngine';

const makeEngine = (options: ConstructorParameters<typeof GeckoEngine>[0] = {}) =>
  new GeckoEngine({
    width: 640,
    height: 480,
    spriteWidth: 96,
    spriteHeight: 72,
    margin: 16,
    random: () => 0,
    sleepAfterMs: Infinity,
    ...options,
  });

test('starts at the lower-right home and returns independent immutable snapshots', () => {
  const engine = makeEngine();
  const before = engine.snapshot;
  assert.equal(before.x, 528);
  assert.equal(before.y, 392);
  assert.equal(before.mode, 'home');
  assert.equal(before.animation, 'idle');
  assert.ok(Object.isFrozen(before));
  engine.tick(1000);
  assert.equal(engine.snapshot.elapsedMs, 1000);
  assert.equal(before.elapsedMs, 0);
});

test('a walk is deterministic, remains on the lower strip and returns home after a long frame', () => {
  const engine = makeEngine({ speed: 80 });
  const home = engine.snapshot;
  assert.equal(engine.wander(), true);
  engine.tick(1000);
  assert.equal(engine.snapshot.x, home.x - 80);
  assert.equal(engine.snapshot.y, home.y);
  assert.equal(engine.snapshot.mode, 'walking');
  assert.equal(engine.snapshot.facing, -1);
  engine.tick(1000 * 60 * 60 * 24);
  assert.equal(engine.snapshot.mode, 'home');
  assert.equal(engine.snapshot.x, home.x);
  assert.equal(engine.snapshot.y, home.y);
  assert.equal(engine.snapshot.facing, 1);
  assert.ok(Number.isFinite(engine.snapshot.elapsedMs));
});

test('a reaction suspends a walk and resumes it from the same position', () => {
  const engine = makeEngine();
  engine.wander();
  engine.tick(1000);
  const position = engine.snapshot.x;
  engine.trigger('file-created');
  engine.tick(500);
  assert.equal(engine.snapshot.mode, 'reacting');
  assert.equal(engine.snapshot.x, position);
  engine.tick(GECKO_REACTION_DURATIONS['file-created'] - 500);
  assert.equal(engine.snapshot.mode, 'walking');
  engine.tick(1000);
  assert.equal(engine.snapshot.x, position - 80);
});

test('completion preempts a deadline and the displaced reaction is preserved', () => {
  const engine = makeEngine();
  engine.trigger('deadline-near');
  engine.tick(300);
  engine.trigger('task-completed');
  assert.equal(engine.snapshot.animation, 'task-completed');
  assert.equal(engine.snapshot.queueLength, 1);
  engine.tick(GECKO_REACTION_DURATIONS['task-completed']);
  assert.equal(engine.snapshot.animation, 'deadline-near');
  engine.tick(GECKO_REACTION_DURATIONS['deadline-near']);
  assert.equal(engine.snapshot.mode, 'home');
});

test('manual petting takes priority over events, which continue afterward', () => {
  const engine = makeEngine();
  engine.trigger('task-completed');
  engine.pet();
  assert.equal(engine.snapshot.animation, 'pet');
  assert.equal(engine.snapshot.queueLength, 1);
  engine.trigger('deadline-near');
  assert.equal(engine.snapshot.animation, 'pet');
  engine.tick(GECKO_REACTION_DURATIONS.pet);
  assert.equal(engine.snapshot.animation, 'task-completed');
});

test('queue deduplicates active and pending events and evicts the lowest priority when full', () => {
  const engine = makeEngine({ maxQueueLength: 2 });
  engine.startDrag(540, 404);
  assert.equal(engine.trigger('deadline-near'), true);
  assert.equal(engine.trigger('deadline-near'), false);
  engine.trigger('file-created');
  engine.trigger('task-completed');
  assert.equal(engine.snapshot.queueLength, 2);
  assert.equal(engine.snapshot.animation, 'drag');
  engine.endDrag();
  assert.equal(engine.snapshot.animation, 'task-completed');
  assert.equal(engine.trigger('task-completed'), false);
  engine.tick(GECKO_REACTION_DURATIONS['task-completed']);
  assert.equal(engine.snapshot.animation, 'file-created');
  engine.tick(GECKO_REACTION_DURATIONS['file-created']);
  assert.equal(engine.snapshot.mode, 'home');
});

test('drag preserves its pointer offset, clamps at every edge and drop saves a new home', () => {
  const engine = makeEngine();
  const home = engine.snapshot;
  engine.startDrag(home.x + 12, home.y + 8);
  engine.dragTo(112, 88);
  assert.equal(engine.snapshot.x, 100);
  assert.equal(engine.snapshot.y, 80);
  engine.dragTo(-100, -100);
  assert.equal(engine.snapshot.x, 0);
  assert.equal(engine.snapshot.y, 0);
  engine.dragTo(10000, 10000);
  assert.equal(engine.snapshot.x, 544);
  assert.equal(engine.snapshot.y, 408);
  engine.dragTo(112, 88);
  engine.endDrag();
  assert.equal(engine.snapshot.mode, 'home');
  engine.tick(10000);
  assert.equal(engine.snapshot.x, 100);
  assert.equal(engine.snapshot.y, 80);
  engine.wander();
  engine.tick(100000);
  assert.equal(engine.snapshot.x, 100);
  assert.equal(engine.snapshot.y, 80);
});

test('drag animates its held pose while freezing the active reaction and queuing new events', () => {
  const engine = makeEngine();
  engine.trigger('task-created');
  engine.tick(250);
  const before = engine.snapshot;
  engine.startDrag(before.x + 10, before.y + 10);
  assert.equal(engine.pet(), false);
  engine.trigger('task-completed');
  engine.tick(350);
  assert.equal(engine.snapshot.elapsedMs, 350);
  assert.equal(engine.snapshot.queueLength, 1);
  engine.tick(100000);
  assert.equal(engine.snapshot.mode, 'dragging');
  assert.equal(engine.snapshot.animation, 'drag');
  assert.ok(engine.snapshot.elapsedMs > 0 && Number.isFinite(engine.snapshot.elapsedMs));
  assert.equal(engine.snapshot.queueLength, 1);
  engine.endDrag();
  assert.equal(engine.snapshot.animation, 'task-created');
  assert.equal(engine.snapshot.elapsedMs, 250);
  engine.tick(GECKO_REACTION_DURATIONS['task-created'] - 250);
  assert.equal(engine.snapshot.animation, 'task-completed');
});

test('cancel restores the original position and keeps the original home', () => {
  const engine = makeEngine();
  const home = engine.snapshot;
  engine.startDrag(home.x + 10, home.y + 10);
  engine.dragTo(20, 20);
  engine.cancelDrag();
  assert.equal(engine.snapshot.mode, 'home');
  assert.equal(engine.snapshot.x, home.x);
  assert.equal(engine.snapshot.y, home.y);
  engine.wander();
  engine.tick(300);
  engine.startDrag(engine.snapshot.x + 1, engine.snapshot.y + 1);
  engine.dragTo(50, 50);
  engine.cancelDrag();
  engine.tick(100000);
  assert.equal(engine.snapshot.x, home.x);
  assert.equal(engine.snapshot.y, home.y);
});

test('resize keeps the initial home anchored and custom homes inside even tiny containers', () => {
  const engine = makeEngine();
  engine.setBounds(800, 600);
  assert.equal(engine.snapshot.x, 688);
  assert.equal(engine.snapshot.y, 512);
  engine.startDrag(700, 524);
  engine.dragTo(212, 132);
  engine.endDrag();
  engine.setBounds(1000, 800);
  assert.equal(engine.snapshot.x, 200);
  assert.equal(engine.snapshot.y, 120);
  engine.setBounds(50, 40);
  assert.equal(engine.snapshot.x, 0);
  assert.equal(engine.snapshot.y, 0);
  engine.wander();
  engine.tick(100000);
  assert.equal(engine.snapshot.mode, 'home');
});

test('resize during drag and a returning walk keeps the sprite in bounds', () => {
  const engine = makeEngine();
  engine.startDrag(540, 404);
  engine.setBounds(240.5, 180.5);
  assert.ok(engine.snapshot.x <= 144);
  assert.ok(engine.snapshot.y <= 108);
  engine.endDrag();
  engine.wander();
  engine.tick(1000);
  engine.returnHome();
  engine.setBounds(200, 160);
  engine.tick(100000);
  assert.equal(engine.snapshot.mode, 'home');
  assert.ok(engine.snapshot.x <= 104);
  assert.ok(engine.snapshot.y <= 88);
});

test('reduced motion disables walks and freezes artwork while reactions still finish', () => {
  const engine = makeEngine({ reducedMotion: true });
  assert.equal(engine.wander(), false);
  engine.trigger('nodes-linked');
  engine.tick(700);
  assert.equal(engine.snapshot.animation, 'nodes-linked');
  assert.equal(engine.snapshot.elapsedMs, 0);
  engine.tick(GECKO_REACTION_DURATIONS['nodes-linked'] - 700);
  assert.equal(engine.snapshot.mode, 'home');
  engine.setReducedMotion(false);
  engine.wander();
  engine.tick(500);
  engine.setReducedMotion(true);
  assert.equal(engine.snapshot.mode, 'home');
  assert.equal(engine.snapshot.x, 528);
});

test('paused ticks and invalid time inputs leave the state untouched', () => {
  const engine = makeEngine();
  engine.trigger('file-created');
  engine.setPaused(true);
  const before = engine.snapshot;
  assert.equal(engine.trigger('task-completed'), false);
  engine.tick(100000);
  assert.deepEqual(engine.snapshot, before);
  engine.setPaused(false);
  for (const delta of [-1, NaN, Infinity, 0]) engine.tick(delta);
  assert.deepEqual(engine.snapshot, before);
  engine.tick(1000);
  assert.equal(engine.snapshot.elapsedMs, 1000);
});

test('one huge frame drains all distinct event reactions without stale work or non-finite coordinates', () => {
  const engine = makeEngine();
  const events: GeckoEvent[] = [
    'deadline-near',
    'file-created',
    'task-created',
    'project-created',
    'nodes-linked',
    'task-completed',
  ];
  for (const event of events) engine.trigger(event);
  engine.tick(Number.MAX_SAFE_INTEGER);
  assert.equal(engine.snapshot.mode, 'home');
  assert.equal(engine.snapshot.animation, 'idle');
  assert.equal(engine.snapshot.queueLength, 0);
  assert.ok(Number.isFinite(engine.snapshot.x));
  assert.ok(Number.isFinite(engine.snapshot.y));
  assert.ok(Number.isFinite(engine.snapshot.elapsedMs));
});

test('home inactivity leads to sleep; petting, events and dragging wake the companion', () => {
  const engine = makeEngine({ sleepAfterMs: 1000 });
  engine.tick(999);
  assert.equal(engine.snapshot.mode, 'home');
  engine.tick(1);
  assert.equal(engine.snapshot.mode, 'sleeping');
  assert.equal(engine.snapshot.animation, 'sleep');
  engine.tick(400);
  assert.equal(engine.snapshot.elapsedMs, 400);
  engine.pet();
  assert.equal(engine.snapshot.animation, 'pet');
  engine.tick(GECKO_REACTION_DURATIONS.pet + 999);
  assert.equal(engine.snapshot.mode, 'home');
  engine.tick(1);
  assert.equal(engine.snapshot.mode, 'sleeping');
  engine.trigger('task-created');
  assert.equal(engine.snapshot.animation, 'task-created');
  engine.tick(GECKO_REACTION_DURATIONS['task-created'] + 1000);
  assert.equal(engine.snapshot.mode, 'sleeping');
  engine.startDrag(engine.snapshot.x + 10, engine.snapshot.y + 10);
  assert.equal(engine.snapshot.mode, 'dragging');
  engine.endDrag();
  assert.equal(engine.snapshot.mode, 'home');
});

test('manual sleep returns from an excursion and wake cancels a pending sleep', () => {
  const engine = makeEngine();
  const home = engine.snapshot;
  engine.wander();
  engine.tick(1500);
  engine.sleep();
  assert.equal(engine.snapshot.mode, 'returning');
  engine.tick(100000);
  assert.equal(engine.snapshot.mode, 'sleeping');
  assert.equal(engine.snapshot.x, home.x);
  assert.equal(engine.snapshot.y, home.y);
  engine.wake();
  engine.wander();
  engine.tick(500);
  engine.sleep();
  engine.wake();
  engine.tick(100000);
  assert.equal(engine.snapshot.mode, 'home');
});

test('paused idle does not count toward sleep and reduced motion allows only static manual sleep', () => {
  const engine = makeEngine({ sleepAfterMs: 100 });
  engine.tick(50);
  engine.setPaused(true);
  engine.tick(100000);
  assert.equal(engine.snapshot.mode, 'home');
  engine.setPaused(false);
  engine.tick(49);
  assert.equal(engine.snapshot.mode, 'home');
  engine.tick(1);
  assert.equal(engine.snapshot.mode, 'sleeping');
  const reduced = makeEngine({ sleepAfterMs: 1, reducedMotion: true });
  reduced.tick(100000);
  assert.equal(reduced.snapshot.mode, 'home');
  reduced.sleep();
  reduced.tick(1000);
  assert.equal(reduced.snapshot.animation, 'sleep');
  assert.equal(reduced.snapshot.elapsedMs, 0);
});

const horizontalRope: GeckoRope = {
  id: 'link',
  start: { x: 100, y: 200 },
  end: { x: 500, y: 200 },
};
const assertGripOnRope = (engine: GeckoEngine, rope: GeckoRope, width = 96, height = 72) => {
  const state = engine.snapshot;
  assert.notEqual(state.ropeProgress, null);
  const progress = state.ropeProgress!;
  const x = rope.start.x + (rope.end.x - rope.start.x) * progress;
  const y =
    rope.start.y +
    (rope.end.y - rope.start.y) * progress +
    48 * state.ropeWeight * progress * (1 - progress);
  assert.ok(Math.abs(state.x + width / 2 - x) <= 0.51);
  assert.ok(Math.abs(state.y + height / 2 - y) <= 0.51);
};

test('rope entry is a short hop, the gripping center meets the sag curve, and the finite excursion returns home', () => {
  const engine = makeEngine();
  const home = engine.snapshot;
  engine.setRopes([horizontalRope]);
  assert.equal(engine.climbRope(), true);
  assert.equal(engine.snapshot.mode, 'rope');
  assert.equal(engine.snapshot.animation, 'walk');
  assert.equal(engine.snapshot.x, home.x);
  assert.equal(engine.snapshot.y, home.y);
  assert.equal(engine.snapshot.ropeWeight, 0);
  engine.tick(GECKO_ROPE_ENTRY_DURATION / 2);
  assert.ok(engine.snapshot.x < home.x && engine.snapshot.x > 372);
  engine.tick(GECKO_ROPE_ENTRY_DURATION / 2);
  assert.equal(engine.snapshot.animation, 'climb');
  assert.equal(engine.snapshot.ropeWeight, 1);
  assertGripOnRope(engine, horizontalRope);
  const from = engine.snapshot.ropeProgress!;
  engine.tick(GECKO_ROPE_DURATION / 2);
  assert.ok(engine.snapshot.ropeProgress! < from);
  assertGripOnRope(engine, horizontalRope);
  engine.tick(GECKO_ROPE_DURATION / 2);
  assert.equal(engine.snapshot.mode, 'returning');
  assert.equal(engine.snapshot.ropeId, null);
  assert.equal(engine.snapshot.ropeWeight, 0);
  engine.tick(100000);
  assert.equal(engine.snapshot.mode, 'home');
  assert.equal(engine.snapshot.x, home.x);
  assert.equal(engine.snapshot.y, home.y);
});

test('application reactions and pause suspend rope progress without losing gripping contact', () => {
  const engine = makeEngine();
  engine.setRopes([horizontalRope]);
  engine.climbRope('link');
  engine.tick(GECKO_ROPE_ENTRY_DURATION + 1000);
  const before = engine.snapshot;
  engine.trigger('task-completed');
  engine.tick(1200);
  assert.equal(engine.snapshot.animation, 'task-completed');
  assert.equal(engine.snapshot.ropeProgress, before.ropeProgress);
  assert.equal(engine.snapshot.ropeWeight, 1);
  assertGripOnRope(engine, horizontalRope);
  engine.tick(GECKO_REACTION_DURATIONS['task-completed'] - 1200);
  assert.equal(engine.snapshot.mode, 'rope');
  engine.setPaused(true);
  engine.tick(100000);
  assert.equal(engine.snapshot.ropeProgress, before.ropeProgress);
  engine.setPaused(false);
  engine.tick(1000);
  assert.notEqual(engine.snapshot.ropeProgress, before.ropeProgress);
});

test('a dragged drop enters the rope near the dropped foot, and nearest selection ignores invalid inputs', () => {
  const engine = makeEngine();
  engine.startDrag(engine.snapshot.x, engine.snapshot.y);
  engine.dragTo(250, 150);
  engine.endDrag();
  engine.setRopes([
    { id: 'bad', start: { x: NaN, y: 0 }, end: { x: 400, y: 200 } },
    { id: 'short', start: { x: 50, y: 50 }, end: { x: 51, y: 50 } },
    horizontalRope,
    { id: 'far', start: { x: 100, y: 90 }, end: { x: 500, y: 90 } },
    { id: 'link', start: { x: 100, y: 350 }, end: { x: 500, y: 350 } },
  ]);
  assert.equal(engine.climbRope('bad'), false);
  assert.equal(engine.climbRope('short'), false);
  assert.equal(engine.climbRope(), true);
  assert.equal(engine.snapshot.ropeId, 'link');
  assert.ok(Math.abs(engine.snapshot.ropeProgress! - 0.495) < 0.001);
  assert.equal(engine.snapshot.x, 250);
  assert.equal(engine.snapshot.y, 150);
  engine.tick(GECKO_ROPE_ENTRY_DURATION);
  assertGripOnRope(engine, horizontalRope);
});

test('removing a rope during a reaction returns home, while moving a rope preserves contact', () => {
  const engine = makeEngine();
  engine.setRopes([horizontalRope]);
  engine.climbRope();
  engine.tick(GECKO_ROPE_ENTRY_DURATION + 1000);
  const moved = { ...horizontalRope, start: { x: 100, y: 250 }, end: { x: 500, y: 250 } };
  engine.setRopes([moved]);
  assertGripOnRope(engine, moved);
  engine.trigger('file-created');
  engine.setRopes([]);
  assert.equal(engine.snapshot.ropeId, null);
  assert.equal(engine.snapshot.animation, 'file-created');
  engine.tick(GECKO_REACTION_DURATIONS['file-created']);
  assert.equal(engine.snapshot.mode, 'returning');
  engine.tick(100000);
  assert.equal(engine.snapshot.mode, 'home');
  assert.equal(engine.climbRope(), false);
});

test('large sprites use an interior rope segment, and unusable or resized-away ropes are rejected', () => {
  const engine = makeEngine({ width: 800, height: 600, spriteWidth: 288, spriteHeight: 216 });
  const diagonal: GeckoRope = { id: 'diagonal', start: { x: 50, y: 80 }, end: { x: 700, y: 450 } };
  engine.setRopes([diagonal]);
  assert.equal(engine.climbRope(), true);
  engine.tick(GECKO_ROPE_ENTRY_DURATION);
  for (let i = 0; i < 15; i++) {
    assertGripOnRope(engine, diagonal, 288, 216);
    assert.ok(engine.snapshot.x >= 0 && engine.snapshot.x <= 512);
    assert.ok(engine.snapshot.y >= 0 && engine.snapshot.y <= 384);
    engine.tick(400);
  }
  engine.setBounds(120, 100);
  assert.equal(engine.snapshot.ropeId, null);
  assert.equal(engine.climbRope(), false);
  engine.tick(100000);
  assert.equal(engine.snapshot.mode, 'home');
  assert.equal(engine.snapshot.x, 0);
  assert.equal(engine.snapshot.y, 0);
  const reduced = makeEngine({ reducedMotion: true });
  reduced.setRopes([horizontalRope]);
  assert.equal(reduced.climbRope(), false);
});

test('a 1.5× sprite keeps its 72,54 gripping center on the rope with integer positions in bounds', () => {
  const width = 96 * 1.5;
  const height = 72 * 1.5;
  assert.equal(width / 2, 72);
  assert.equal(height / 2, 54);
  const engine = makeEngine({
    width: 640.5,
    height: 480.5,
    spriteWidth: width,
    spriteHeight: height,
  });
  engine.setRopes([horizontalRope]);
  assert.equal(engine.climbRope(), true);
  let contactFrames = 0;
  for (let frame = 0; frame < 60; frame++) {
    const state = engine.snapshot;
    assert.ok(Number.isInteger(state.x) && Number.isInteger(state.y));
    assert.ok(state.x >= 0 && state.x <= Math.floor(640.5 - width));
    assert.ok(state.y >= 0 && state.y <= Math.floor(480.5 - height));
    if (state.animation === 'climb') {
      // Integer top-left coordinates can put the rendered feet at most 0.5px
      // away from the exact continuous rope curve.
      assertGripOnRope(engine, horizontalRope, width, height);
      contactFrames++;
    }
    engine.tick(250);
  }
  assert.ok(contactFrames > 20);
  assert.equal(engine.snapshot.mode, 'home');
  assert.equal(engine.snapshot.ropeId, null);
});

test('each event and petting cycles through three deterministic performances without immediate repeats', () => {
  const engine = makeEngine();
  const events: GeckoEvent[] = [
    'task-created',
    'project-created',
    'file-created',
    'task-completed',
    'nodes-linked',
    'deadline-near',
  ];
  let sequence = engine.snapshot.sequenceId;
  for (const event of events) {
    const variants: number[] = [];
    for (let performance = 0; performance < 3; performance++) {
      engine.trigger(event);
      variants.push(engine.snapshot.animationVariant);
      assert.ok(engine.snapshot.sequenceId > sequence);
      sequence = engine.snapshot.sequenceId;
      engine.tick(GECKO_REACTION_DURATIONS[event]);
    }
    assert.deepEqual(variants, [0, 1, 2]);
  }
  const petVariants: number[] = [];
  for (let performance = 0; performance < 3; performance++) {
    engine.pet();
    petVariants.push(engine.snapshot.animationVariant);
    engine.tick(GECKO_REACTION_DURATIONS.pet);
  }
  assert.deepEqual(petVariants, [0, 1, 2]);
});

test('idle and sleeping change performances at resting intervals and pause preserves the chosen performance', () => {
  const engine = makeEngine();
  const idleVariants = [engine.snapshot.animationVariant];
  engine.tick(6000);
  idleVariants.push(engine.snapshot.animationVariant);
  engine.tick(6000);
  idleVariants.push(engine.snapshot.animationVariant);
  assert.deepEqual(idleVariants, [0, 1, 2]);
  engine.sleep();
  const sleepVariants = [engine.snapshot.animationVariant];
  const pausedState = engine.snapshot;
  engine.setPaused(true);
  engine.tick(100000);
  assert.deepEqual(engine.snapshot, pausedState);
  engine.setPaused(false);
  engine.tick(8000);
  sleepVariants.push(engine.snapshot.animationVariant);
  engine.tick(8000);
  sleepVariants.push(engine.snapshot.animationVariant);
  assert.deepEqual(sleepVariants, [0, 1, 2]);
});

test('walk performances survive reaction returns and reaction performances survive a drag', () => {
  const engine = makeEngine();
  const walkingVariants: number[] = [];
  for (let journey = 0; journey < 3; journey++) {
    engine.wander();
    walkingVariants.push(engine.snapshot.animationVariant);
    engine.tick(400);
    const walking = engine.snapshot;
    engine.trigger('file-created');
    engine.tick(GECKO_REACTION_DURATIONS['file-created']);
    assert.equal(engine.snapshot.animation, 'walk');
    assert.equal(engine.snapshot.animationVariant, walking.animationVariant);
    assert.equal(engine.snapshot.elapsedMs, walking.elapsedMs);
    engine.tick(100000);
  }
  assert.deepEqual(walkingVariants, [0, 1, 2]);
  const dragVariants: number[] = [];
  for (let pickup = 0; pickup < 3; pickup++) {
    engine.trigger('task-created');
    engine.tick(350);
    const reaction = engine.snapshot;
    engine.startDrag(reaction.x + 4, reaction.y + 4);
    dragVariants.push(engine.snapshot.animationVariant);
    engine.tick(1000);
    engine.endDrag();
    assert.equal(engine.snapshot.animationVariant, reaction.animationVariant);
    assert.equal(engine.snapshot.elapsedMs, reaction.elapsedMs);
    engine.tick(GECKO_REACTION_DURATIONS['task-created'] - 350);
  }
  assert.deepEqual(dragVariants, [0, 1, 2]);
});

test('climbing has planted holds, eased pulls, and three distinct visit rhythms', () => {
  const engine = makeEngine();
  engine.setRopes([horizontalRope]);
  const variants: number[] = [];
  const firstPulls: number[] = [];
  for (let visit = 0; visit < 3; visit++) {
    engine.climbRope('link');
    engine.tick(GECKO_ROPE_ENTRY_DURATION);
    assert.equal(engine.snapshot.animation, 'climb');
    variants.push(engine.snapshot.animationVariant);
    const initial = engine.snapshot.ropeProgress!;
    engine.tick(50);
    assert.equal(engine.snapshot.ropeProgress, initial);
    const beforePull = engine.snapshot;
    engine.tick(350);
    const pulled = engine.snapshot;
    assert.notEqual(pulled.ropeProgress, beforePull.ropeProgress);
    firstPulls.push(Math.abs(pulled.ropeProgress! - initial));
    assert.ok(pulled.gripPhase! >= 0 && pulled.gripPhase! <= 1);
    assert.ok(pulled.ropeWeight >= 0.85 && pulled.ropeWeight <= 1);
    assertGripOnRope(engine, horizontalRope);
    engine.tick(20000);
    assert.equal(engine.snapshot.mode, 'home');
  }
  assert.deepEqual(variants, [0, 1, 2]);
  assert.equal(new Set(firstPulls.map((value) => value.toFixed(5))).size, 3);
});

test('climbing angle follows the weighted SVG tangent in both travel directions with a precise 1.5× grip', () => {
  const line: GeckoRope = { id: 'diagonal', start: { x: 100, y: 120 }, end: { x: 500, y: 320 } };
  const engine = makeEngine({ spriteWidth: 144, spriteHeight: 108 });
  engine.setRopes([line]);
  for (const forward of [false, true]) {
    if (forward) {
      engine.startDrag(engine.snapshot.x, engine.snapshot.y);
      engine.dragTo(60, 80);
      engine.endDrag();
    }
    engine.climbRope('diagonal');
    engine.tick(GECKO_ROPE_ENTRY_DURATION + 410);
    const state = engine.snapshot;
    const sign = forward ? 1 : -1;
    const dx = line.end.x - line.start.x;
    const dy = line.end.y - line.start.y + 48 * state.ropeWeight * (1 - 2 * state.ropeProgress!);
    assert.ok(Math.abs(state.ropeAngle! - Math.atan2(dy * sign, dx * sign)) < 1e-12);
    const expectedX = line.start.x + dx * state.ropeProgress!;
    const expectedY =
      line.start.y +
      (line.end.y - line.start.y) * state.ropeProgress! +
      48 * state.ropeWeight * state.ropeProgress! * (1 - state.ropeProgress!);
    assert.ok(Math.abs(state.renderX + 72 - expectedX) < 1e-10);
    assert.ok(Math.abs(state.renderY + 54 - expectedY) < 1e-10);
    assert.ok(Number.isInteger(state.x) && Number.isInteger(state.y));
    engine.returnHome();
    engine.tick(20000);
  }
});

test('forced variant previews change the climb rhythm without moving its grip point', () => {
  const engine = makeEngine();
  engine.setRopes([horizontalRope]);
  engine.setVariantOverride(2);
  engine.climbRope();
  engine.tick(GECKO_ROPE_ENTRY_DURATION + 1600);
  assert.equal(engine.snapshot.animationVariant, 2);
  const before = engine.snapshot;
  engine.setVariantOverride(1);
  assert.equal(engine.snapshot.animationVariant, 1);
  assert.equal(engine.snapshot.ropeProgress, before.ropeProgress);
  assert.ok(engine.snapshot.sequenceId > before.sequenceId);
  assertGripOnRope(engine, horizontalRope);
  engine.setVariantOverride(undefined);
  engine.tick(20000);
  engine.climbRope();
  engine.tick(GECKO_ROPE_ENTRY_DURATION);
  assert.notEqual(engine.snapshot.animationVariant, 1);
});

const roundNode = { id: 'task-node', x: 280, y: 210, radius: 42 };
const reachNodePhase = (engine: GeckoEngine, phase: GeckoNodePhase) => {
  for (let frame = 0; frame < 1500 && engine.snapshot.nodePhase !== phase; frame++) engine.tick(16);
  assert.equal(engine.snapshot.nodePhase, phase);
};

test('a node excursion approaches continuously, crawls down the rim, catches with its tail and recovers', () => {
  const engine = makeEngine();
  const home = engine.snapshot;
  engine.setNodes([roundNode]);
  assert.equal(engine.climbNode('task-node'), true);
  assert.equal(engine.snapshot.nodePhase, 'approach');
  assert.equal(engine.snapshot.renderX, home.renderX);
  assert.equal(engine.snapshot.renderY, home.renderY);
  reachNodePhase(engine, 'crawl');
  const atTop = engine.snapshot;
  assert.ok(Math.abs(atTop.renderX + 48 - roundNode.x) < 2);
  assert.ok(Math.abs(atTop.renderY + 36 - (roundNode.y - roundNode.radius)) < 2);
  engine.tick(300);
  const crawling = engine.snapshot;
  assert.ok(crawling.renderX > atTop.renderX);
  assert.ok(crawling.locomotionPhase > atTop.locomotionPhase);
  assert.ok(crawling.motionAngle > 0 && crawling.motionAngle < Math.PI);
  let before = engine.snapshot;
  while ((engine.snapshot.nodePhase as GeckoNodePhase | null) === 'crawl') {
    before = engine.snapshot;
    engine.tick(1);
  }
  const caught = engine.snapshot;
  assert.equal(caught.animation, 'tail-hang');
  assert.ok(Math.hypot(caught.renderX - before.renderX, caught.renderY - before.renderY) < 0.1);
  assert.ok(caught.tailHangProgress < 0.001);
  engine.tick(GECKO_NODE_BLEND_DURATION);
  assert.equal(engine.snapshot.tailHangProgress, 1);
  assert.ok(Math.abs(engine.snapshot.renderX + 48 - roundNode.x) < 1e-8);
  assert.ok(Math.abs(engine.snapshot.renderY + 36 - roundNode.y - roundNode.radius) < 1e-8);
  engine.tick(GECKO_NODE_HANG_DURATION - GECKO_NODE_BLEND_DURATION / 2);
  assert.equal(engine.snapshot.nodePhase, 'recover');
  assert.ok(engine.snapshot.tailHangProgress < 1);
  engine.tick(100000);
  assert.equal(engine.snapshot.mode, 'home');
  assert.equal(engine.snapshot.nodeId, null);
  assert.equal(engine.snapshot.x, home.x);
  assert.equal(engine.snapshot.y, home.y);
});

test('node movement preserves contact and deleting an occupied node preserves the visible body position', () => {
  const engine = makeEngine();
  engine.setNodes([roundNode]);
  engine.climbNode();
  reachNodePhase(engine, 'hang');
  engine.tick(GECKO_NODE_BLEND_DURATION);
  const before = engine.snapshot;
  engine.setNodes([{ ...roundNode, x: roundNode.x + 20, y: roundNode.y + 10 }]);
  const moved = engine.snapshot;
  assert.equal(moved.renderX, before.renderX + 20);
  assert.equal(moved.renderY, before.renderY + 10);
  engine.trigger('file-created');
  engine.tick(200);
  assert.equal(engine.snapshot.nodeElapsedMs, moved.nodeElapsedMs);
  assert.equal(engine.snapshot.tailHangProgress, 1);
  engine.setNodes([]);
  assert.equal(engine.snapshot.nodeId, null);
  assert.equal(engine.snapshot.renderX, moved.renderX);
  assert.equal(engine.snapshot.renderY, moved.renderY + 24);
  engine.tick(100000);
  assert.equal(engine.snapshot.mode, 'home');
});

test('node walks are reachable through wander and interruption, resizing and reduced motion release the attachment', () => {
  const engine = makeEngine();
  engine.setNodes([
    { ...roundNode, id: 'invalid', radius: NaN },
    { ...roundNode, id: 'offscreen', x: 10 },
    roundNode,
  ]);
  assert.equal(engine.climbNode('invalid'), false);
  assert.equal(engine.climbNode('offscreen'), false);
  assert.equal(engine.wander(), true);
  assert.equal(engine.snapshot.nodeId, 'task-node');
  reachNodePhase(engine, 'hang');
  engine.tick(1000);
  assert.equal(engine.startDrag(engine.snapshot.x + 48, engine.snapshot.y + 12), true);
  assert.equal(engine.snapshot.nodeId, null);
  assert.equal(engine.snapshot.animation, 'drag');
  engine.endDrag();
  engine.climbNode();
  engine.setBounds(120, 100);
  assert.equal(engine.snapshot.nodeId, null);
  assert.equal(engine.climbNode(), false);
  engine.setBounds(640, 480);
  engine.climbNode();
  engine.setReducedMotion(true);
  assert.equal(engine.snapshot.nodeId, null);
  assert.equal(engine.snapshot.mode, 'home');
  assert.equal(engine.climbNode(), false);
  assert.equal(engine.snapshot.locomotionPhase, 0);
});

test('gait advances by traveled distance and stays frozen during event reactions', () => {
  const slow = makeEngine({ speed: 40 });
  const fast = makeEngine({ speed: 80 });
  slow.wander();
  fast.wander();
  slow.tick(1000);
  fast.tick(500);
  assert.equal(slow.snapshot.locomotionPhase, fast.snapshot.locomotionPhase);
  const phase = fast.snapshot.locomotionPhase;
  fast.trigger('task-completed');
  fast.tick(1000);
  assert.equal(fast.snapshot.locomotionPhase, phase);
});
