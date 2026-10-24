import approvedAtlasUrl from '../assets/approved-reference.png';
import { createGeckoRig, drawGeckoRig, type FrameTurn, type GeckoRig } from './geckoRig';
import { enlarge, sampleTurn } from './geckoRotsprite';

export { GECKO_ANIMATION_VARIANTS } from './geckoRig';

export type GeckoAnimation =
  | 'idle'
  | 'walk'
  | 'pet'
  | 'drag'
  | 'sleep'
  | 'balance'
  | 'climb'
  | 'task-created'
  | 'project-created'
  | 'file-created'
  | 'task-completed'
  | 'nodes-linked'
  | 'deadline-near';

/** A pose drawn from the approved sheet; on a rope the gecko hangs in the held pose. */
type FramePose = Exclude<GeckoAnimation, 'climb'>;

/** How one frame is drawn. */
export type GeckoDrawOptions = {
  /** One of the three performances of every animation. */
  variant?: 0 | 1 | 2;
  /** On a rope: its direction of travel, in radians. */
  ropeAngle?: number | null;
  /** On a rope: the phase of the paws' grip cycle, 0…1. */
  gripPhase?: number | null;
  /** Static poses only. */
  reducedMotion?: boolean;
  /** Device pixels per native pixel of the target canvas (it is 96×72 times this). */
  renderScale?: number;
};

export const SPRITE_WIDTH = 96;
export const SPRITE_HEIGHT = 72;

type Rect = { x: number; y: number; width: number; height: number };
type FrameDefinition = {
  crop: Rect;
  sourceAnchor: readonly [number, number];
  targetAnchor: readonly [number, number];
};

/** Source pixels are taken directly from the user's approved twelve-pose sheet. */
const FRAME_DEFINITIONS: Record<FramePose, FrameDefinition> = {
  idle: {
    crop: { x: 120, y: 100, width: 220, height: 192 },
    sourceAnchor: [180, 285],
    targetAnchor: [48, 58],
  },
  walk: {
    crop: { x: 440, y: 85, width: 300, height: 235 },
    sourceAnchor: [597.5, 202.5],
    targetAnchor: [48, 36],
  },
  pet: {
    crop: { x: 920, y: 100, width: 220, height: 192 },
    sourceAnchor: [980, 285],
    targetAnchor: [48, 58],
  },
  // The approved drag pose hangs by its raised paw. Its fingertip is the cursor anchor.
  drag: {
    crop: { x: 90, y: 400, width: 205, height: 250 },
    sourceAnchor: [194, 410],
    targetAnchor: [48, 12],
  },
  'task-created': {
    crop: { x: 520, y: 430, width: 220, height: 205 },
    sourceAnchor: [580, 615],
    targetAnchor: [48, 58],
  },
  'project-created': {
    crop: { x: 920, y: 425, width: 220, height: 210 },
    sourceAnchor: [980, 614],
    targetAnchor: [48, 58],
  },
  'file-created': {
    crop: { x: 120, y: 747, width: 220, height: 205 },
    sourceAnchor: [180, 936],
    targetAnchor: [48, 58],
  },
  'task-completed': {
    crop: { x: 520, y: 747, width: 220, height: 205 },
    sourceAnchor: [580, 937],
    targetAnchor: [48, 58],
  },
  'nodes-linked': {
    crop: { x: 920, y: 747, width: 220, height: 205 },
    sourceAnchor: [980, 936],
    targetAnchor: [48, 58],
  },
  'deadline-near': {
    crop: { x: 120, y: 1064, width: 220, height: 210 },
    sourceAnchor: [180, 1256],
    targetAnchor: [48, 58],
  },
  sleep: {
    crop: { x: 500, y: 1155, width: 200, height: 120 },
    sourceAnchor: [590, 1262],
    targetAnchor: [48, 58],
  },
  balance: {
    crop: { x: 910, y: 1075, width: 230, height: 200 },
    sourceAnchor: [994, 1257],
    targetAnchor: [48, 58],
  },
};

const frameCache: Partial<Record<FramePose, HTMLCanvasElement>> = {};
const rigCache: Partial<Record<FramePose, GeckoRig>> = {};
/** The native 96×72 grid the rig places its parts on, and the frame turned. */
let nativeLayer: CanvasRenderingContext2D | undefined;
let turnedLayer: CanvasRenderingContext2D | undefined;
/** Frames enlarged ×8 by Scale2x, by a hash of their pixels: poses repeat. */
const enlarged = new Map<number, Uint32Array>();
let loading: Promise<void> | undefined;
let ready = false;

function canvas(width: number, height: number): HTMLCanvasElement {
  const result = document.createElement('canvas');
  result.width = width;
  result.height = height;
  return result;
}

function context(target: HTMLCanvasElement): CanvasRenderingContext2D {
  const result = target.getContext('2d', { willReadFrequently: true });
  if (!result) throw new Error('A 2D canvas is required to draw the gecko.');
  result.imageSmoothingEnabled = false;
  return result;
}

/**
 * Remove only neutral dark background connected to a crop edge. Enclosed dark
 * pupils and markings remain opaque, as do green outlines and the original
 * coloured props. Labels and panel borders are outside the source crops.
 */
function removeBackground(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  const bitmap = ctx.getImageData(0, 0, width, height);
  const pixels = bitmap.data;
  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let first = 0,
    last = 0;
  const isBackground = (index: number) => {
    const offset = index * 4;
    const r = pixels[offset]!,
      g = pixels[offset + 1]!,
      b = pixels[offset + 2]!;
    const high = Math.max(r, g, b),
      chroma = high - Math.min(r, g, b);
    return pixels[offset + 3]! < 16 || (high < 45 && chroma < 15) || (high < 90 && chroma < 12);
  };
  const visit = (index: number) => {
    if (!visited[index] && isBackground(index)) {
      visited[index] = 1;
      queue[last++] = index;
    }
  };
  for (let x = 0; x < width; x++) {
    visit(x);
    visit((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    visit(y * width);
    visit(y * width + width - 1);
  }
  while (first < last) {
    const index = queue[first++]!,
      x = index % width,
      y = Math.floor(index / width);
    if (x > 0) visit(index - 1);
    if (x + 1 < width) visit(index + 1);
    if (y > 0) visit(index - width);
    if (y + 1 < height) visit(index + width);
  }
  for (let i = 0; i < visited.length; i++) {
    if (visited[i]) {
      const offset = i * 4;
      pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = pixels[offset + 3] = 0;
    }
  }
  ctx.putImageData(bitmap, 0, 0);
}

/**
 * Drop specks: groups of fewer than `min` touching opaque pixels (eight
 * neighbours) left by the downscale. On a moving part they would float away.
 */
function removeSpecks(ctx: CanvasRenderingContext2D, width: number, height: number, min = 5): void {
  const bitmap = ctx.getImageData(0, 0, width, height);
  const pixels = bitmap.data;
  const seen = new Uint8Array(width * height);
  const group: number[] = [];
  for (let start = 0; start < width * height; start++) {
    if (seen[start] || pixels[start * 4 + 3] === 0) continue;
    group.length = 0;
    seen[start] = 1;
    group.push(start);
    for (let k = 0; k < group.length; k++) {
      const index = group[k]!,
        x = index % width,
        y = Math.floor(index / width);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx,
            ny = y + dy;
          if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const next = ny * width + nx;
          if (!seen[next] && pixels[next * 4 + 3] !== 0) {
            seen[next] = 1;
            group.push(next);
          }
        }
    }
    if (group.length < min) for (const index of group) pixels[index * 4 + 3] = 0;
  }
  ctx.putImageData(bitmap, 0, 0);
}

function extractFrame(image: HTMLImageElement, definition: FrameDefinition): HTMLCanvasElement {
  const { crop, sourceAnchor, targetAnchor } = definition;
  const source = canvas(crop.width, crop.height);
  const sourceCtx = context(source);
  sourceCtx.drawImage(
    image,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    0,
    0,
    crop.width,
    crop.height,
  );
  removeBackground(sourceCtx, crop.width, crop.height);
  const result = canvas(SPRITE_WIDTH, SPRITE_HEIGHT),
    ctx = context(result);
  const scale = 0.25;
  ctx.drawImage(
    source,
    Math.round(targetAnchor[0] + (crop.x - sourceAnchor[0]) * scale),
    Math.round(targetAnchor[1] + (crop.y - sourceAnchor[1]) * scale),
    Math.round(crop.width * scale),
    Math.round(crop.height * scale),
  );
  removeSpecks(ctx, SPRITE_WIDTH, SPRITE_HEIGHT);
  return result;
}

/** Decode the approved image and cache all twelve transparent native frames. */
export function loadGeckoAssets(): Promise<void> {
  if (loading) return loading;
  loading = new Promise<void>((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      try {
        for (const animation of Object.keys(FRAME_DEFINITIONS) as FramePose[]) {
          frameCache[animation] = extractFrame(image, FRAME_DEFINITIONS[animation]);
        }
        ready = true;
        resolve();
      } catch (error) {
        reject(error);
      }
    };
    image.onerror = () => reject(new Error('The approved gecko image could not be loaded.'));
    image.src = approvedAtlasUrl;
  });
  return loading;
}

function hashPixels(px: Uint32Array): number {
  let h = 2166136261;
  for (let i = 0; i < px.length; i++) {
    h ^= px[i]!;
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Turns a composed frame as one sprite by RotSprite (see `geckoRotsprite`). */
function turnFrame(
  src: CanvasRenderingContext2D,
  dst: CanvasRenderingContext2D,
  turn: FrameTurn,
): void {
  const px = new Uint32Array(src.getImageData(0, 0, SPRITE_WIDTH, SPRITE_HEIGHT).data.buffer);
  const key = hashPixels(px);
  let big = enlarged.get(key);
  if (!big) {
    big = enlarge(px, SPRITE_WIDTH, SPRITE_HEIGHT);
    enlarged.set(key, big);
    if (enlarged.size > 8) enlarged.delete(enlarged.keys().next().value!);
  }
  const image = dst.createImageData(SPRITE_WIDTH, SPRITE_HEIGHT);
  sampleTurn(
    big,
    SPRITE_WIDTH,
    SPRITE_HEIGHT,
    new Uint32Array(image.data.buffer),
    turn.angle,
    turn.pivot,
    turn.to,
    turn.mirror,
  );
  dst.putImageData(image, 0, 0);
}

/**
 * Mends cracks between parts moved apart: a clear pixel where the approved
 * pose has art, between opaque pixels left and right or above and below (or
 * with three opaque sides), takes the pose's own pixel.
 */
function mendCracks(layer: CanvasRenderingContext2D, pose: HTMLCanvasElement): void {
  const image = layer.getImageData(0, 0, SPRITE_WIDTH, SPRITE_HEIGHT);
  const out = new Uint32Array(image.data.buffer);
  const art = new Uint32Array(
    context(pose).getImageData(0, 0, SPRITE_WIDTH, SPRITE_HEIGHT).data.buffer,
  );
  const W = SPRITE_WIDTH,
    H = SPRITE_HEIGHT;
  for (let pass = 0; pass < 2; pass++) {
    const seen = out.slice();
    const solid = (x: number, y: number) =>
      x >= 0 && y >= 0 && x < W && y < H && seen[y * W + x]! >>> 24 !== 0;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (seen[i]! >>> 24 !== 0 || art[i]! >>> 24 === 0) continue;
        const l = solid(x - 1, y),
          r = solid(x + 1, y),
          u = solid(x, y - 1),
          d = solid(x, y + 1);
        if ((l && r) || (u && d) || +l + +r + +u + +d >= 3) out[i] = art[i]!;
      }
  }
  layer.putImageData(image, 0, 0);
}

/** The pieces (eight neighbours) of an image's opaque pixels, largest first. */
function pieces(px: Uint32Array, w: number, h: number): number[][] {
  const seen = new Uint8Array(w * h),
    out: number[][] = [];
  for (let start = 0; start < w * h; start++) {
    if (seen[start] || px[start]! >>> 24 === 0) continue;
    const piece = [start];
    seen[start] = 1;
    for (let k = 0; k < piece.length; k++) {
      const x = piece[k]! % w,
        y = Math.floor(piece[k]! / w);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx,
            ny = y + dy,
            n = ny * w + nx;
          if (
            (dx || dy) &&
            nx >= 0 &&
            ny >= 0 &&
            nx < w &&
            ny < h &&
            !seen[n] &&
            px[n]! >>> 24 !== 0
          ) {
            seen[n] = 1;
            piece.push(n);
          }
        }
    }
    out.push(piece);
  }
  return out.sort((a, b) => b.length - a.length);
}

/** Sizes of a pose's props: the pieces of its approved frame apart from the gecko. */
const propSizes = new Map<HTMLCanvasElement, number[]>();
function propsOf(art: HTMLCanvasElement): number[] {
  let sizes = propSizes.get(art);
  if (!sizes) {
    const px = new Uint32Array(
      context(art).getImageData(0, 0, SPRITE_WIDTH, SPRITE_HEIGHT).data.buffer,
    );
    sizes = pieces(px, SPRITE_WIDTH, SPRITE_HEIGHT)
      .slice(1)
      .map((p) => p.length);
    propSizes.set(art, sizes);
  }
  return sizes;
}

/**
 * The last guard against the gecko falling apart (owner, 2026-10-24): a bit
 * under twelve pixels torn off the gecko — a toe, a claw — is moved back by
 * the least whole-pixel step, at most three, until it touches the gecko again;
 * failing that, it goes. The pose's own props are left where they are.
 */
function keepTogether(layer: CanvasRenderingContext2D, props: readonly number[]): void {
  const W = SPRITE_WIDTH,
    H = SPRITE_HEIGHT;
  const image = layer.getImageData(0, 0, W, H);
  const px = new Uint32Array(image.data.buffer);
  const all = pieces(px, W, H);
  if (all.length < 2) return;
  const gecko = new Uint8Array(W * H);
  for (const i of all[0]!) gecko[i] = 1;
  const steps: [number, number][] = [];
  for (let dy = -3; dy <= 3; dy++)
    for (let dx = -3; dx <= 3; dx++) if (dx || dy) steps.push([dx, dy]);
  steps.sort((a, b) => Math.hypot(a[0], a[1]) - Math.hypot(b[0], b[1]));
  let changed = false;
  for (const piece of all.slice(1)) {
    if (piece.length >= 12 || props.some((size) => Math.abs(size - piece.length) <= 2)) continue;
    const colours = piece.map((i) => px[i]);
    for (const i of piece) px[i] = 0;
    changed = true;
    for (const [dx, dy] of steps) {
      let fits = true,
        touches = false;
      for (const i of piece) {
        const x = (i % W) + dx,
          y = Math.floor(i / W) + dy;
        if (x < 0 || y < 0 || x >= W || y >= H || px[y * W + x]! >>> 24 !== 0) {
          fits = false;
          break;
        }
        for (let ny = y - 1; ny <= y + 1 && !touches; ny++)
          for (let nx = x - 1; nx <= x + 1; nx++) {
            if (nx >= 0 && ny >= 0 && nx < W && ny < H && gecko[ny * W + nx]) {
              touches = true;
              break;
            }
          }
      }
      if (fits && touches) {
        piece.forEach((i, k) => {
          px[(Math.floor(i / W) + dy) * W + (i % W) + dx] = colours[k]!;
        });
        break;
      }
    }
  }
  if (changed) layer.putImageData(image, 0, 0);
}

/** The rig of a pose, cut once from its approved frame. */
function rigOf(pose: FramePose): GeckoRig | null {
  const cached = rigCache[pose];
  if (cached) return cached;
  const frame = frameCache[pose];
  if (!frame) return null;
  const rig = createGeckoRig(frame, pose);
  rigCache[pose] = rig;
  return rig;
}

/**
 * Draw one frame from the approved artwork. Every part of the rig carries
 * only pixels of the approved sheet: motion turns and moves whole parts
 * (head, paws, tail), it never paints a replacement face, pupil or outline.
 * The target canvas is the native 96×72 grid times `renderScale`, drawn
 * without smoothing; a climb turns along the rope instead of mirroring.
 */
export function drawGecko(
  ctx: CanvasRenderingContext2D,
  animation: GeckoAnimation,
  elapsedMs: number,
  facing: 1 | -1 = 1,
  options: GeckoDrawOptions = {},
): void {
  const scale =
    Number.isFinite(options.renderScale) && (options.renderScale ?? 0) > 0
      ? options.renderScale!
      : 1;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, SPRITE_WIDTH * scale, SPRITE_HEIGHT * scale);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.imageSmoothingEnabled = false;
  if (!ready) {
    void loadGeckoAssets().catch(() => {});
    ctx.restore();
    return;
  }
  const pose: FramePose = animation === 'climb' ? 'drag' : animation;
  const rig = rigOf(pose) ?? rigOf('idle');
  if (!rig) {
    ctx.restore();
    return;
  }
  const ms = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  const shown = rig === rigCache[pose] ? animation : 'idle';
  // Every frame is placed on the native grid: parts move by whole pixels,
  // cracks between them take the pose's own pixels, a turn of the whole
  // frame (a sway, a grab on the rope) is made as one sprite, specks go; the
  // frame is then enlarged without smoothing (owner, 2026-10-24: turned one
  // by one, the parts tore at the tail, by the leg and on the rope).
  nativeLayer ??= context(canvas(SPRITE_WIDTH, SPRITE_HEIGHT));
  turnedLayer ??= context(canvas(SPRITE_WIDTH, SPRITE_HEIGHT));
  const layer = nativeLayer;
  layer.setTransform(1, 0, 0, 1, 0, 0);
  layer.clearRect(0, 0, SPRITE_WIDTH, SPRITE_HEIGHT);
  layer.imageSmoothingEnabled = false;
  const turn = drawGeckoRig(layer, rig, shown, ms, options);
  const art = frameCache[shown === 'idle' ? 'idle' : pose];
  if (art && !options.reducedMotion) mendCracks(layer, art);
  let frame = layer;
  if (turn) {
    turnFrame(layer, turnedLayer, turn);
    frame = turnedLayer;
  }
  // The approved poses hold no detail under five pixels (see extractFrame).
  removeSpecks(frame, SPRITE_WIDTH, SPRITE_HEIGHT, 5);
  if (art && !options.reducedMotion) keepTogether(frame, propsOf(art));
  ctx.scale(scale, scale);
  if (facing === -1 && shown !== 'climb') {
    ctx.translate(SPRITE_WIDTH, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(frame.canvas, 0, 0);
  ctx.restore();
}
