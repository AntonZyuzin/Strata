import approvedAtlasUrl from '../assets/approved-reference.png';
import { createGeckoRig, drawGeckoRig, type GeckoRig } from './geckoRig';

export { GECKO_ANIMATION_VARIANTS } from './geckoRig';

export type GeckoAnimation =
  | 'idle'
  | 'walk'
  | 'pet'
  | 'drag'
  | 'sleep'
  | 'balance'
  | 'climb'
  | 'tail-hang'
  | 'task-created'
  | 'project-created'
  | 'file-created'
  | 'task-completed'
  | 'nodes-linked'
  | 'deadline-near';

/** A pose drawn from the approved sheet; on a rope the gecko hangs in the held pose. */
type FramePose = Exclude<GeckoAnimation, 'climb' | 'tail-hang'>;

export interface GeckoAnatomyFrame {
  face: {
    matrix: readonly [number, number, number, number, number, number];
    source: Uint32Array;
    stamp: Uint32Array;
    width: number;
    height: number;
  };
  paws: readonly {
    name: string;
    palm: readonly [number, number];
    toes: readonly (readonly [number, number])[];
    visible: boolean;
  }[];
}

/** How one frame is drawn. */
export type GeckoDrawOptions = {
  /** One of the three performances of every animation. */
  variant?: 0 | 1 | 2;
  /** On a rope: its direction of travel, in radians. */
  ropeAngle?: number | null;
  /** On a rope: the phase of the paws' grip cycle, 0…1. */
  gripPhase?: number | null;
  /** Distance-driven walking cycle; a planted paw moves back as the body advances. */
  locomotionPhase?: number;
  /** Direction of overhead travel, in radians, with the native head facing right. */
  motionAngle?: number;
  /** Blend from crawling down a node to hanging from its edge by the tail. */
  tailHangProgress?: number;
  /** Static poses only. */
  reducedMotion?: boolean;
  /** Device pixels per native pixel of the target canvas (it is 96×72 times this). */
  renderScale?: number;
  /** Frame diagnostics for the explicit anatomy review URL. */
  inspectAnatomy?: (frame: GeckoAnatomyFrame) => void;
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

/** Straight native-pixel slits replace the uneven pupils left by the atlas downscale. */
export function alignWalkingPupils(pixels: Uint8ClampedArray): void {
  const at = (x: number, y: number) => (y * SPRITE_WIDTH + x) * 4;
  const pupil = new Uint8ClampedArray([5, 7, 2, 255]);
  const iris = pixels.slice(at(75, 29), at(75, 29) + 4);
  // Retain the approved eye outline and highlight, changing only its interior.
  for (let y = 28; y <= 31; y++) pixels.set(pupil, at(76, y));
  for (let y = 28; y <= 30; y++) pixels.set(iris, at(77, y));
  for (let y = 19; y <= 21; y++) pixels.set(pupil, at(80, y));
}

/** Decode the approved image and cache all twelve transparent native frames. */
export function loadGeckoAssets(): Promise<void> {
  if (loading) return loading;
  loading = new Promise<void>((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      try {
        for (const animation of Object.keys(FRAME_DEFINITIONS) as FramePose[]) {
          const frame = extractFrame(image, FRAME_DEFINITIONS[animation]);
          if (animation === 'walk') {
            const ctx = context(frame);
            const bitmap = ctx.getImageData(0, 0, SPRITE_WIDTH, SPRITE_HEIGHT);
            alignWalkingPupils(bitmap.data);
            ctx.putImageData(bitmap, 0, 0);
          }
          frameCache[animation] = frame;
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
 * Draw one connected frame from the approved artwork. The mesh retains the
 * face and markings while continuous joints bend between the animated paws,
 * body and tail (owner, 2026-10-25: intermediate joint pixels are allowed).
 * The target canvas is the native 96×72 grid times `renderScale`, drawn
 * without smoothing. All turns are applied before connected rasterization.
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
  const pose: FramePose =
    animation === 'climb' ? 'drag' : animation === 'tail-hang' ? 'walk' : animation;
  const rig = rigOf(pose) ?? rigOf('idle');
  if (!rig) {
    ctx.restore();
    return;
  }
  const ms = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  const shown = rig === rigCache[pose] ? animation : 'idle';
  // Deform the connected artwork before turning the complete native frame.
  nativeLayer ??= context(canvas(SPRITE_WIDTH, SPRITE_HEIGHT));
  const layer = nativeLayer;
  layer.setTransform(1, 0, 0, 1, 0, 0);
  layer.clearRect(0, 0, SPRITE_WIDTH, SPRITE_HEIGHT);
  layer.imageSmoothingEnabled = false;
  drawGeckoRig(layer, rig, shown, ms, options);
  ctx.scale(scale, scale);
  if (
    facing === -1 &&
    shown !== 'climb' &&
    shown !== 'tail-hang' &&
    !(shown === 'walk' && options.motionAngle !== undefined)
  ) {
    ctx.translate(SPRITE_WIDTH, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(layer.canvas, 0, 0);
  ctx.restore();
}
