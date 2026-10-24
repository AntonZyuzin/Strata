import {
  type CSSProperties,
  forwardRef,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from 'react';
import {
  drawGeckoEffects,
  EFFECT_HEIGHT,
  EFFECT_OFFSET_X,
  EFFECT_OFFSET_Y,
  EFFECT_WIDTH,
} from './geckoEffects';
import {
  GeckoEngine,
  type GeckoEvent,
  type GeckoNode,
  type GeckoRope,
  type GeckoSnapshot,
} from './geckoEngine';
import {
  drawGecko,
  type GeckoAnatomyFrame,
  loadGeckoAssets,
  SPRITE_HEIGHT,
  SPRITE_WIDTH,
} from './geckoSprite';

/**
 * Canvas pixels per native pixel: what the screen shows of one, rounded, so
 * the enlargement by the browser is about one to one and every native pixel
 * keeps one size (owner, 2026-10-24: a fixed 3 stretched them unevenly at
 * other sizes and densities).
 */
const renderScaleFor = (pixelScale: number) =>
  Math.max(
    1,
    Math.round(pixelScale * (typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1)),
  );

export type GeckoHandle = {
  react(event: GeckoEvent): void;
  pet(): void;
  wander(): void;
  home(): void;
  sleep(): void;
  wake(): void;
  climbRope(id?: string): void;
  climbNode(id?: string): void;
  setNodes(nodes: readonly GeckoNode[]): void;
};

export type GeckoCompanionProps = {
  /** Magnification of the native sprite. The default is 1.5. */
  scale?: number;
  /** Demo/review override; undefined lets the companion choose naturally. */
  variant?: 0 | 1 | 2;
  ropes?: readonly GeckoRope[];
  nodes?: readonly GeckoNode[];
  /** Undefined respects the operating system's motion preference. */
  reducedMotion?: boolean;
  paused?: boolean;
  hidden?: boolean;
  onStateChange?: (snapshot: GeckoSnapshot) => void;
  onRopeFrame?: (snapshot: GeckoSnapshot) => void;
  style?: CSSProperties;
  /** The gecko's accessible name: what a click, a double click and the keys do. */
  label?: string;
  /** Its tooltip. */
  hint?: string;
};

/** Mount inside a position:relative container. Only the gecko captures input. */
export const GeckoCompanion = forwardRef<GeckoHandle, GeckoCompanionProps>(function GeckoCompanion(
  {
    scale = 1.5,
    variant,
    ropes,
    nodes,
    reducedMotion,
    paused = false,
    hidden = false,
    onStateChange,
    onRopeFrame,
    style,
    label = 'Gecko. Click to pet, double-click to walk. Arrows move it, Escape sends it home.',
    hint = 'Pet · Double-click to walk · Drag to move',
  },
  ref,
) {
  const pixelScale = Number.isFinite(scale) ? Math.max(0.5, Math.min(4, scale)) : 1.5;
  const RENDER_SCALE = renderScaleFor(pixelScale);
  const layer = useRef<HTMLDivElement>(null);
  const actor = useRef<HTMLButtonElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const effects = useRef<HTMLCanvasElement>(null);
  const variantRef = useRef(variant);
  variantRef.current = variant;
  const engineRef = useRef<GeckoEngine | null>(null);
  if (!engineRef.current) engineRef.current = new GeckoEngine();
  const engine = engineRef.current;
  const nodesRef = useRef<readonly GeckoNode[]>(nodes ?? []);
  const callback = useRef(onStateChange);
  callback.current = onStateChange;
  const ropeCallback = useRef(onRopeFrame);
  ropeCallback.current = onRopeFrame;
  const clicks = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointer = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const motion = useRef(false);
  const hiddenRef = useRef(hidden);
  const pausedRef = useRef(paused);
  hiddenRef.current = hidden;
  pausedRef.current = paused;

  // Stable: it reads refs only, so the effects that call it do not restart.
  const clearClick = useCallback(() => {
    if (clicks.current !== null) clearTimeout(clicks.current);
    clicks.current = null;
  }, []);

  useEffect(() => {
    void loadGeckoAssets().catch((error) => console.error('The gecko picture did not load', error));
  }, []);

  const controls = useMemo<GeckoHandle>(
    () => ({
      react: (event) => {
        if (!hiddenRef.current && !pausedRef.current && !document.hidden) engine.trigger(event);
      },
      pet: () => {
        if (!hiddenRef.current && !pausedRef.current && !document.hidden) engine.pet();
      },
      wander: () => {
        if (!hiddenRef.current && !pausedRef.current && !document.hidden) engine.wander();
      },
      home: () => {
        if (!hiddenRef.current && !pausedRef.current && !document.hidden) engine.returnHome();
      },
      sleep: () => {
        if (!hiddenRef.current && !pausedRef.current && !document.hidden) engine.sleep();
      },
      wake: () => {
        if (!hiddenRef.current && !pausedRef.current && !document.hidden) engine.wake();
      },
      climbRope: (id) => {
        if (!hiddenRef.current && !pausedRef.current && !document.hidden) engine.climbRope(id);
      },
      climbNode: (id) => {
        if (!hiddenRef.current && !pausedRef.current && !document.hidden) engine.climbNode(id);
      },
      setNodes: (surfaces) => {
        nodesRef.current = surfaces;
        engine.setNodes(surfaces);
      },
    }),
    [engine],
  );
  useImperativeHandle(ref, () => controls, [controls]);

  useEffect(() => {
    // An explicit review URL exposes the production renderer for frame regression tests.
    if (!new URLSearchParams(window.location.search).has('geckoReview')) return;
    const target = window as unknown as { __strataGeckoReview?: unknown };
    let anatomy: GeckoAnatomyFrame | null = null;
    const review = {
      draw: ((ctx, animation, elapsedMs, facing, options) =>
        drawGecko(ctx, animation, elapsedMs, facing, {
          ...options,
          inspectAnatomy: (frame) => {
            anatomy = frame;
            options?.inspectAnatomy?.(frame);
          },
        })) as typeof drawGecko,
      anatomy: () => anatomy,
      load: loadGeckoAssets,
      handle: controls,
      snapshot: () => engine.snapshot,
      nodes: () => nodesRef.current,
    };
    target.__strataGeckoReview = review;
    return () => {
      if (target.__strataGeckoReview === review) delete target.__strataGeckoReview;
    };
  }, [engine, controls]);

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => {
      motion.current = reducedMotion ?? media.matches;
      engine.setReducedMotion(motion.current);
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [engine, reducedMotion]);

  useEffect(() => {
    const surface = layer.current;
    if (!surface) return;
    const measure = () => {
      // display:none must not overwrite a manually chosen home with (0, 0).
      if (!surface.clientWidth || !surface.clientHeight) return;
      engine.setBounds(
        surface.clientWidth,
        surface.clientHeight,
        SPRITE_WIDTH * pixelScale,
        SPRITE_HEIGHT * pixelScale,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(surface);
    return () => observer.disconnect();
  }, [engine, pixelScale]);

  useEffect(() => {
    engine.setRopes(ropes ?? []);
  }, [engine, ropes]);
  useEffect(() => {
    if (nodes !== undefined) controls.setNodes(nodes);
  }, [controls, nodes]);
  useEffect(() => {
    engine.setVariantOverride(variant);
  }, [engine, variant]);

  useEffect(() => {
    // Hidden and inactive windows do no animation work and accumulate no stale reactions.
    let frame = 0;
    let previous = 0;
    let lastStatus = '';
    let lastRopeStamp = '';
    const context = canvas.current?.getContext('2d');
    const effectsContext = effects.current?.getContext('2d');
    const live = document.createElement('canvas');
    live.width = SPRITE_WIDTH * RENDER_SCALE;
    live.height = SPRITE_HEIGHT * RENDER_SCALE;
    const liveContext = live.getContext('2d')!;
    let lastPoseKey = '';
    let transitionStart = -Infinity;
    let presentedAngle = engine.snapshot.motionAngle;
    let lastRopePaint = -Infinity;
    const ease = (value: number) => {
      const t = Math.max(0, Math.min(1, value));
      return t * t * (3 - 2 * t);
    };
    const run = (now: number) => {
      const delta = previous ? Math.min(now - previous, 100) : 0;
      previous = now;
      engine.tick(delta);
      const state = engine.snapshot;
      const angleDifference = Math.atan2(
        Math.sin(state.motionAngle - presentedAngle),
        Math.cos(state.motionAngle - presentedAngle),
      );
      presentedAngle += angleDifference * (motion.current ? 1 : 1 - Math.exp(-delta / 90));
      const renderVariant = variantRef.current ?? state.animationVariant;
      const bodyAnimation =
        state.mode === 'reacting' && state.nodeId
          ? state.nodePhase === 'hang' || state.nodePhase === 'recover'
            ? 'tail-hang'
            : 'walk'
          : state.ropeId && state.mode === 'reacting'
            ? 'climb'
            : state.animation;
      if (actor.current) {
        // On a rope the gecko hangs from it by the raised paw at (48, 12):
        // the engine's grip point is the sprite's centre, so the paw goes there.
        const attachment =
          bodyAnimation === 'climb'
            ? 1
            : bodyAnimation === 'tail-hang'
              ? state.tailHangProgress
              : 0;
        const hang = (SPRITE_HEIGHT / 2 - 12) * pixelScale * attachment;
        actor.current.style.transform = `translate(${state.renderX ?? state.x}px, ${(state.renderY ?? state.y) + hang}px)`;
        actor.current.dataset.animation = state.animation;
        actor.current.dataset.mode = state.mode;
        actor.current.dataset.nodeId = state.nodeId ?? '';
        actor.current.dataset.nodePhase = state.nodePhase ?? '';
        actor.current.style.cursor = state.mode === 'dragging' ? 'grabbing' : 'grab';
      }
      const status = `${state.animation}:${state.mode}:${state.queueLength}:${state.animationVariant}:${state.sequenceId}`;
      if (context) {
        const poseKey = `${bodyAnimation}:${renderVariant}:${state.sequenceId}`;
        if (lastPoseKey !== poseKey) transitionStart = now;
        lastPoseKey = poseKey;
        drawGecko(
          liveContext,
          bodyAnimation,
          motion.current ? 0 : (state.nodeElapsedMs ?? state.elapsedMs),
          state.facing,
          {
            variant: renderVariant,
            ropeAngle: state.ropeAngle,
            gripPhase: state.gripPhase,
            locomotionPhase: state.locomotionPhase,
            motionAngle: presentedAngle,
            tailHangProgress: state.tailHangProgress,
            reducedMotion: motion.current,
            renderScale: RENDER_SCALE,
          },
        );
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.clearRect(0, 0, live.width, live.height);
        context.imageSmoothingEnabled = false;
        const t = motion.current ? 1 : Math.min(1, (now - transitionStart) / 180);
        // One opaque connected pose: cross-fading unrelated poses duplicated limbs.
        context.drawImage(live, 0, 0);
        if (effectsContext)
          drawGeckoEffects(effectsContext, state.animation, state.elapsedMs, {
            variant: renderVariant,
            facing: state.facing,
            renderScale: RENDER_SCALE,
            reducedMotion: motion.current,
            intensity: t < 1 ? ease(t) : 1,
          });
        const stamp = `${state.ropeId}:${Math.round((state.ropeProgress ?? 0) * 1000)}:${state.ropeWeight}`;
        if (stamp !== lastRopeStamp && (now - lastRopePaint >= 32 || state.ropeId === null)) {
          lastRopeStamp = stamp;
          lastRopePaint = now;
          ropeCallback.current?.(state);
        }
      }
      if (status !== lastStatus) {
        lastStatus = status;
        callback.current?.(state);
      }
      frame = requestAnimationFrame(run);
    };
    const syncVisibility = () => {
      cancelAnimationFrame(frame);
      const inactive = hidden || paused || document.hidden;
      engine.setPaused(inactive);
      if (inactive) {
        clearClick();
        if (pointer.current?.moved) engine.cancelDrag();
        pointer.current = null;
        if (hidden)
          ropeCallback.current?.({
            ...engine.snapshot,
            ropeId: null,
            ropeProgress: null,
            ropeWeight: 0,
          });
      }
      previous = 0;
      if (!inactive) frame = requestAnimationFrame(run);
    };
    syncVisibility();
    document.addEventListener('visibilitychange', syncVisibility);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('visibilitychange', syncVisibility);
    };
  }, [engine, hidden, paused, RENDER_SCALE, pixelScale, clearClick]);

  useEffect(() => {
    if (!hidden && !paused) return;
    clearClick();
    if (pointer.current?.moved) engine.cancelDrag();
    pointer.current = null;
  }, [engine, hidden, paused, clearClick]);

  useEffect(
    () => () => {
      clearClick();
    },
    [clearClick],
  );

  const localPoint = (event: ReactPointerEvent) => {
    const rect = layer.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const down = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || pointer.current || paused) return;
    const point = localPoint(event);
    pointer.current = { id: event.pointerId, ...point, moved: false };
    suppressClick.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const move = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const press = pointer.current;
    if (!press || press.id !== event.pointerId) return;
    const point = localPoint(event);
    if (!press.moved && Math.hypot(point.x - press.x, point.y - press.y) >= 5) {
      clearClick();
      // The approved held pose hangs from the cursor by its raised paw.
      const state = engine.snapshot;
      engine.startDrag(
        state.renderX + (SPRITE_WIDTH * pixelScale) / 2,
        state.renderY + (12 + 24 * state.tailHangProgress) * pixelScale,
      );
      press.moved = true;
    }
    if (press.moved) engine.dragTo(point.x, point.y);
  };
  const up = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const press = pointer.current;
    if (!press || press.id !== event.pointerId) return;
    pointer.current = null;
    if (press.moved) {
      engine.endDrag();
      suppressClick.current = true;
      const point = localPoint(event);
      let nearest: { id: string; distance: number } | null = null;
      for (const rope of ropes ?? []) {
        const dx = rope.end.x - rope.start.x;
        const dy = rope.end.y - rope.start.y;
        const lengthSquared = dx * dx + dy * dy;
        if (lengthSquared < 1) continue;
        const u = Math.max(
          0,
          Math.min(
            1,
            ((point.x - rope.start.x) * dx + (point.y - rope.start.y) * dy) / lengthSquared,
          ),
        );
        const distance = Math.hypot(
          point.x - rope.start.x - u * dx,
          point.y - rope.start.y - u * dy,
        );
        if (distance <= 18 && (!nearest || distance < nearest.distance))
          nearest = { id: rope.id, distance };
      }
      const node = nodesRef.current
        .map((surface) => ({
          surface,
          distance: Math.hypot(point.x - surface.x, point.y - surface.y),
        }))
        .filter(({ surface, distance }) => distance <= surface.radius + 24)
        .sort((a, b) => a.distance - b.distance)[0]?.surface;
      if (node) engine.climbNode(node.id);
      else if (nearest) engine.climbRope(nearest.id);
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const cancel = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const press = pointer.current;
    if (!press || press.id !== event.pointerId) return;
    if (press.moved) engine.cancelDrag();
    pointer.current = null;
    suppressClick.current = true;
  };

  return (
    <div
      ref={layer}
      data-gecko-layer
      aria-hidden={hidden || undefined}
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        overflow: 'hidden',
        zIndex: 20,
        display: hidden ? 'none' : undefined,
        ...style,
      }}
    >
      <button
        ref={actor}
        type="button"
        data-gecko-actor
        aria-label={label}
        title={hint}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={cancel}
        onLostPointerCapture={cancel}
        onClick={(event) => {
          if (paused || suppressClick.current) {
            suppressClick.current = false;
            return;
          }
          clearClick();
          if (event.detail === 0) engine.pet();
          else if (event.detail === 1)
            clicks.current = setTimeout(() => {
              if (!hiddenRef.current && !pausedRef.current && !document.hidden) engine.pet();
              clicks.current = null;
            }, 280);
        }}
        onDoubleClick={() => {
          if (!paused) {
            clearClick();
            engine.wander();
          }
        }}
        onKeyDown={(event) => {
          if (paused) return;
          if (event.key === 'Escape') {
            clearClick();
            engine.returnHome();
            return;
          }
          const directions: Record<string, [number, number]> = {
            ArrowLeft: [-1, 0],
            ArrowRight: [1, 0],
            ArrowUp: [0, -1],
            ArrowDown: [0, 1],
          };
          const direction = directions[event.key];
          if (!direction) return;
          event.preventDefault();
          const { x, y } = engine.snapshot;
          const step = event.shiftKey ? 24 : 8;
          engine.startDrag(x, y);
          engine.dragTo(x + direction[0] * step, y + direction[1] * step);
          engine.endDrag();
        }}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          margin: 0,
          padding: 0,
          width: SPRITE_WIDTH * pixelScale,
          height: SPRITE_HEIGHT * pixelScale,
          // No frame of the host's buttons (owner, 2026-10-24): only the gecko shows.
          border: 0,
          borderRadius: 0,
          background: 'transparent',
          boxShadow: 'none',
          minHeight: 0,
          pointerEvents: 'auto',
          cursor: 'grab',
          touchAction: 'none',
          userSelect: 'none',
          WebkitUserSelect: 'none',
        }}
      >
        <canvas
          ref={canvas}
          width={SPRITE_WIDTH * RENDER_SCALE}
          height={SPRITE_HEIGHT * RENDER_SCALE}
          style={{
            display: 'block',
            width: '100%',
            height: '100%',
            imageRendering: 'pixelated',
            pointerEvents: 'none',
          }}
        />
        <canvas
          ref={effects}
          width={EFFECT_WIDTH * RENDER_SCALE}
          height={EFFECT_HEIGHT * RENDER_SCALE}
          style={{
            position: 'absolute',
            left: EFFECT_OFFSET_X * pixelScale,
            top: EFFECT_OFFSET_Y * pixelScale,
            width: EFFECT_WIDTH * pixelScale,
            height: EFFECT_HEIGHT * pixelScale,
            imageRendering: 'pixelated',
            pointerEvents: 'none',
          }}
        />
      </button>
    </div>
  );
});
