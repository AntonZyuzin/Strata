import { enlarge, sampleTurn } from './geckoRotsprite';
import type { GeckoAnimation, GeckoDrawOptions } from './geckoSprite';

type Point = readonly [number, number];
type PartName =
  | 'body'
  | 'head'
  | 'armFar'
  | 'armNear'
  | 'legFar'
  | 'legNear'
  | 'tailBase'
  | 'tailTip'
  | 'prop';
type LimbName = 'armFar' | 'armNear' | 'legFar' | 'legNear';
type Bone = { root: Point; tip: Point };
/** A piece of the pose: its pixels, the joint it hangs on, the middle of its pixels. */
type Part = { image: HTMLCanvasElement; pivot: Point; center: Point };
export interface GeckoRig {
  parts: Record<PartName, Part>;
  bones: Record<LimbName, Bone>;
  kind: 'seated' | 'walk' | 'drag' | 'sleep' | 'balance';
}

export const GECKO_ANIMATION_VARIANTS: Record<GeckoAnimation, readonly [string, string, string]> = {
  idle: ['Looks around', 'Plays with its tail', 'Shifts its feet'],
  walk: ['Even pace', 'Sneaks', 'Curious stroll'],
  pet: ['Reaches for the hand', 'Nuzzles', 'Holds still, trusting'],
  drag: ['Hangs calmly', 'Swings', 'Tucks its legs'],
  sleep: ['Sound asleep', 'Twitches in its sleep', 'Covers itself with its tail'],
  balance: ['Holds steady', 'Catches its balance', 'Glances at the wires'],
  climb: ['Hand over hand', 'Big swings', 'Hold, then pull'],
  'task-created': ['Notices the task', 'Checks the task', 'Glad of a start'],
  'project-created': ['Looks at the folder', 'Brings the folder', 'Nods to the project'],
  'file-created': ['Reads the sheet', 'Takes it carefully', 'Shows the find'],
  'task-completed': ['Nods happily', 'Claps its paws', 'Stretches'],
  'nodes-linked': ['Checks the link', 'Runs a paw along it', 'Tests the tension'],
  'deadline-near': ['Notices the time', 'Gently reminds', 'Looks at the clock'],
};

const TAU = Math.PI * 2;
const clamp = (value: number, low = 0, high = 1) => Math.min(high, Math.max(low, value));
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (t: number) => {
  t = clamp(t);
  return t * t * (3 - 2 * t);
};
const cycle = (value: number) => ((value % 1) + 1) % 1;
const pulse = (time: number, start: number, end: number) =>
  time <= start || time >= end ? 0 : Math.sin(((time - start) / (end - start)) * Math.PI);

function inside(x: number, y: number, polygon: readonly Point[]): boolean {
  let result = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!,
      b = polygon[j]!;
    if (a[1] > y !== b[1] > y && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0])
      result = !result;
  }
  return result;
}
const near = (x: number, y: number, p: Point, radius: number) =>
  (x - p[0]) ** 2 + (y - p[1]) ** 2 <= radius * radius;

/**
 * The drawn pixels, at most three, that join `piece` to the main piece of a
 * part through the drawing (eight neighbours), or null when none do.
 */
function bridge(piece: number[], main: Uint8Array, drawn: Uint8Array): number[] | null {
  const from = new Map<number, number>();
  let frontier = piece.slice();
  for (const i of piece) from.set(i, -1);
  for (let depth = 0; depth <= 3; depth++) {
    const next: number[] = [];
    for (const index of frontier) {
      const x = index % 96,
        y = Math.floor(index / 96);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx,
            ny = y + dy,
            n = ny * 96 + nx;
          if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= 96 || ny >= 72 || from.has(n)) continue;
          if (main[n]) {
            const path: number[] = [];
            for (let at = index; from.get(at) !== -1; at = from.get(at)!) path.push(at);
            return path;
          }
          if (depth < 3 && drawn[n]) {
            from.set(n, index);
            next.push(n);
          }
        }
    }
    frontier = next;
  }
  return null;
}

/** The pieces of a 96×72 mask: groups of set pixels touching by an edge or a corner. */
function islands(mask: Uint8Array): number[][] {
  const seen = new Uint8Array(mask.length),
    out: number[][] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    const piece = [start];
    seen[start] = 1;
    for (let k = 0; k < piece.length; k++) {
      const index = piece[k]!,
        x = index % 96,
        y = Math.floor(index / 96);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx,
            ny = y + dy,
            next = ny * 96 + nx;
          if ((dx || dy) && nx >= 0 && ny >= 0 && nx < 96 && ny < 72 && mask[next] && !seen[next]) {
            seen[next] = 1;
            piece.push(next);
          }
        }
    }
    out.push(piece);
  }
  return out;
}

/** All rig parts contain only pixels from the approved atlas; joint overlaps
 * reuse those same pixels so a rotating shoulder never exposes a cutout hole. */
export function createGeckoRig(
  source: HTMLCanvasElement,
  state: Exclude<GeckoAnimation, 'climb'>,
): GeckoRig {
  const kind =
    state === 'walk'
      ? 'walk'
      : state === 'drag'
        ? 'drag'
        : state === 'sleep'
          ? 'sleep'
          : state === 'balance'
            ? 'balance'
            : 'seated';
  let polygons: Partial<Record<PartName | 'tail', readonly Point[]>>;
  let bones: Record<LimbName, Bone>;
  let headPivot: Point, tailPivot: Point, tailTipPivot: Point;
  if (kind === 'walk') {
    polygons = {
      head: [
        [64, 11],
        [87, 11],
        [87, 36],
        [68, 36],
        [62, 30],
      ],
      armFar: [
        [59, 25],
        [57, 18],
        [59, 7],
        [72, 7],
        [70, 18],
        [64, 29],
      ],
      armNear: [
        [59, 30],
        [65, 31],
        [69, 38],
        [72, 47],
        [62, 48],
        [57, 39],
      ],
      legFar: [
        [49, 28],
        [44, 31],
        [38, 25],
        [33, 12],
        [47, 8],
        [51, 20],
      ],
      legNear: [
        [47, 33],
        [49, 38],
        [47, 44],
        [47, 51],
        [36, 51],
        [36, 42],
        [41, 35],
      ],
      tail: [
        [38, 32],
        [42, 38],
        [36, 48],
        [44, 67],
        [28, 69],
        [10, 55],
        [10, 33],
      ],
    };
    bones = {
      armFar: { root: [61, 26], tip: [65, 12] },
      armNear: { root: [60, 32], tip: [67, 43] },
      legFar: { root: [48, 28], tip: [42, 15] },
      legNear: { root: [46, 36], tip: [42, 47] },
    };
    headPivot = [66, 28];
    tailPivot = [38, 37];
    tailTipPivot = [25, 48];
  } else if (kind === 'drag') {
    polygons = {
      head: [
        [49, 20],
        [70, 20],
        [70, 34],
        [56, 36],
        [49, 31],
      ],
      armFar: [
        [43, 9],
        [55, 9],
        [55, 23],
        [52, 32],
        [47, 34],
        [44, 26],
      ],
      armNear: [
        [56, 34],
        [65, 35],
        [69, 43],
        [60, 46],
        [53, 41],
      ],
      legFar: [
        [44, 41],
        [42, 44],
        [32, 40],
        [30, 30],
        [39, 29],
        [47, 36],
      ],
      legNear: [
        [48, 47],
        [57, 48],
        [62, 61],
        [51, 64],
        [46, 55],
      ],
      tail: [
        [23, 48],
        [42, 48],
        [49, 54],
        [48, 64],
        [40, 72],
        [18, 72],
      ],
    };
    bones = {
      armFar: { root: [49, 31], tip: [48, 14] },
      armNear: { root: [56, 37], tip: [63, 42] },
      legFar: { root: [44, 42], tip: [35, 34] },
      legNear: { root: [50, 50], tip: [56, 59] },
    };
    headPivot = [52, 32];
    tailPivot = [43, 53];
    tailTipPivot = [32, 64];
  } else if (kind === 'sleep') {
    polygons = {
      head: [
        [26, 39],
        [46, 39],
        [48, 52],
        [44, 58],
        [26, 58],
      ],
      tail: [
        [60, 39],
        [74, 39],
        [74, 61],
        [43, 61],
        [43, 51],
        [59, 50],
      ],
      legNear: [
        [44, 50],
        [55, 50],
        [56, 59],
        [42, 59],
      ],
    };
    bones = {
      armFar: { root: [44, 49], tip: [41, 53] },
      armNear: { root: [49, 49], tip: [46, 54] },
      legFar: { root: [56, 48], tip: [54, 53] },
      legNear: { root: [49, 52], tip: [46, 56] },
    };
    headPivot = [45, 49];
    tailPivot = [61, 47];
    tailTipPivot = [59, 55];
  } else {
    const balancing = kind === 'balance';
    polygons = {
      head: [
        [33, 11],
        [63, 11],
        [63, 31],
        [55, 35],
        [43, 35],
        [33, 29],
      ],
      armFar: balancing
        ? [
            [43, 32],
            [46, 37],
            [39, 43],
            [28, 44],
            [27, 36],
            [35, 33],
          ]
        : [
            [43, 35],
            [47, 38],
            [44, 46],
            [42, 52],
            [34, 54],
            [34, 47],
            [39, 40],
          ],
      armNear: balancing
        ? [
            [53, 32],
            [58, 34],
            [71, 35],
            [72, 42],
            [62, 44],
            [53, 40],
          ]
        : [
            [54, 35],
            [60, 36],
            [63, 43],
            [60, 49],
            [53, 51],
            [51, 45],
            [56, 41],
          ],
      legFar: [
        [43, 46],
        [48, 48],
        [47, 54],
        [48, 61],
        [33, 61],
        [33, 53],
        [38, 49],
      ],
      legNear: [
        [52, 46],
        [58, 45],
        [63, 49],
        [64, 61],
        [46, 61],
        [46, 54],
        [51, 51],
      ],
      tail: balancing
        ? [
            [59, 46],
            [65, 42],
            [83, 37],
            [85, 59],
            [58, 62],
            [56, 55],
          ]
        : [
            [59, 46],
            [67, 45],
            [88, 43],
            [91, 62],
            [60, 62],
            [57, 57],
            [60, 52],
          ],
    };
    bones = {
      armFar: { root: [43, 37], tip: balancing ? [31, 39] : [39, 50] },
      armNear: { root: [55, 37], tip: balancing ? [68, 39] : [58, 47] },
      legFar: { root: [44, 49], tip: [40, 56] },
      legNear: { root: [54, 49], tip: [55, 57] },
    };
    headPivot = [49, 33];
    tailPivot = [60, 52];
    tailTipPivot = balancing ? [69, 48] : [71, 53];
  }
  const sourceCtx = source.getContext('2d')!;
  const original = sourceCtx.getImageData(0, 0, 96, 72);
  const masks: Record<PartName, Uint8Array> = Object.fromEntries(
    ['body', 'head', 'armFar', 'armNear', 'legFar', 'legNear', 'tailBase', 'tailTip', 'prop'].map(
      (key) => [key, new Uint8Array(96 * 72)],
    ),
  ) as Record<PartName, Uint8Array>;
  const hasProp = !['idle', 'walk', 'drag', 'sleep', 'balance'].includes(state);
  const limbKeys: LimbName[] = ['armFar', 'armNear', 'legFar', 'legNear'];
  // A prop is a piece of the drawing apart from the gecko (the largest piece):
  // it moves whole, never split between a paw and the body.
  const opaque = new Uint8Array(96 * 72);
  for (let i = 0; i < opaque.length; i++) opaque[i] = original.data[i * 4 + 3] ? 1 : 0;
  const drawn = islands(opaque),
    gecko = drawn.reduce((a, b) => (b.length > a.length ? b : a), []);
  const propPixel = new Uint8Array(96 * 72);
  if (hasProp)
    for (const piece of drawn) if (piece !== gecko) for (const i of piece) propPixel[i] = 1;
  for (let y = 0; y < 72; y++)
    for (let x = 0; x < 96; x++) {
      const index = y * 96 + x;
      if (!original.data[index * 4 + 3]) continue;
      let owner: PartName = 'body';
      if (propPixel[index]) owner = 'prop';
      else if (polygons.head && inside(x + 0.5, y + 0.5, polygons.head)) owner = 'head';
      else if (polygons.tail && inside(x + 0.5, y + 0.5, polygons.tail)) {
        const split =
          kind === 'walk'
            ? y >= 48
            : kind === 'drag'
              ? y >= 60
              : kind === 'sleep'
                ? x <= 64 && y >= 51
                : x >= 70;
        owner = split ? 'tailTip' : 'tailBase';
        // Two-pixel overlap at the flexible tail joint preserves its silhouette.
        const overlap =
          kind === 'walk'
            ? Math.abs(y - 48) < 2
            : kind === 'drag'
              ? Math.abs(y - 60) < 2
              : kind === 'sleep'
                ? x >= 62 && x <= 66 && y >= 49
                : x >= 68 && x <= 72;
        if (overlap) {
          masks.tailBase[index] = 1;
          masks.tailTip[index] = 1;
        }
      } else {
        for (const key of limbKeys)
          if (polygons[key] && inside(x + 0.5, y + 0.5, polygons[key]!)) {
            owner = key;
            break;
          }
      }
      masks[owner][index] = 1;
      if (owner !== 'prop' && owner !== 'body') {
        if (
          near(x, y, headPivot, 2.8) ||
          limbKeys.some((key) => near(x, y, bones[key].root, 2.2)) ||
          near(x, y, tailPivot, 2.5)
        )
          masks.body[index] = 1;
      }
    }
  // A moving part turns as one piece. A bit of it joined to its main piece
  // only through the body's pixels (a toe) takes those few pixels along, as
  // a copy, so it turns with the paw; a bit farther off stays with the body.
  for (const name of [
    'head',
    'armFar',
    'armNear',
    'legFar',
    'legNear',
    'tailBase',
    'tailTip',
  ] as PartName[]) {
    for (let round = 0; round < 4; round++) {
      const pieces = islands(masks[name]);
      if (pieces.length < 2) break;
      const main = pieces.reduce((a, b) => (b.length > a.length ? b : a));
      const inMain = new Uint8Array(96 * 72);
      for (const i of main) inMain[i] = 1;
      for (const piece of pieces) {
        if (piece === main) continue;
        const path = bridge(piece, inMain, opaque);
        if (path) for (const i of path) masks[name][i] = 1;
        else
          for (const i of piece) {
            masks[name][i] = 0;
            masks.body[i] = 1;
          }
      }
    }
  }
  // A part turns about its seam — the middle of its pixels touching what it
  // hangs on (the body; the tail's base for its tip) — so a turn keeps the
  // joint joined even where the drawn joint is not where the bones say.
  const seamOf = (name: PartName, on: PartName): Point | null => {
    let sx = 0,
      sy = 0,
      n = 0;
    for (let i = 0; i < masks[name].length; i++) {
      if (!masks[name][i]) continue;
      const x = i % 96,
        y = Math.floor(i / 96);
      let touches = false;
      for (let dy = -1; dy <= 1 && !touches; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx,
            ny = y + dy;
          if (
            nx >= 0 &&
            ny >= 0 &&
            nx < 96 &&
            ny < 72 &&
            masks[on][ny * 96 + nx] &&
            !masks[name][ny * 96 + nx]
          ) {
            touches = true;
            break;
          }
        }
      if (touches) {
        sx += x + 0.5;
        sy += y + 0.5;
        n++;
      }
    }
    return n ? [sx / n, sy / n] : null;
  };
  const seams: Partial<Record<PartName, Point>> = {};
  for (const name of ['head', 'armFar', 'armNear', 'legFar', 'legNear', 'tailBase'] as PartName[]) {
    const p = seamOf(name, 'body');
    if (p) seams[name] = p;
  }
  const tipSeam = seamOf('tailTip', 'tailBase');
  if (tipSeam) seams.tailTip = tipSeam;
  const parts = {} as Record<PartName, Part>;
  for (const name of Object.keys(masks) as PartName[]) {
    const image = document.createElement('canvas');
    image.width = 96;
    image.height = 72;
    const ctx = image.getContext('2d')!,
      data = ctx.createImageData(96, 72);
    for (let i = 0; i < masks[name].length; i++)
      if (masks[name][i]) data.data.set(original.data.subarray(i * 4, i * 4 + 4), i * 4);
    ctx.putImageData(data, 0, 0);
    const pivot: Point =
      seams[name] ??
      (name === 'head'
        ? headPivot
        : name === 'tailBase'
          ? tailPivot
          : name === 'tailTip'
            ? tailTipPivot
            : name in bones
              ? bones[name as LimbName].root
              : name === 'prop'
                ? [68, 21]
                : [49, 51]);
    let cx = 0,
      cy = 0,
      n = 0;
    for (let i = 0; i < masks[name].length; i++)
      if (masks[name][i]) {
        cx += (i % 96) + 0.5;
        cy += Math.floor(i / 96) + 0.5;
        n++;
      }
    parts[name] = { image, pivot, center: n ? [cx / n, cy / n] : pivot };
  }
  return { parts, bones, kind };
}

/**
 * A turn of the whole composed frame, made after its parts are placed: a
 * source point `s` — mirrored about x = 48 first when `mirror` — lands at
 * `to + R(angle)(s − pivot)`. `geckoSprite` makes it as one sprite by
 * RotSprite, so the art turns without falling apart.
 */
export interface FrameTurn {
  angle: number;
  pivot: Point;
  to: Point;
  mirror?: boolean;
}

type Shift = readonly [number, number];
const turnPoint = (p: Point, pivot: Point, angle: number): Point => {
  const c = Math.cos(angle),
    s = Math.sin(angle),
    x = p[0] - pivot[0],
    y = p[1] - pivot[1];
  return [pivot[0] + x * c - y * s, pivot[1] + x * s + y * c];
};
/** How far a part's middle travels turned by `angle` about `pivot`. */
const travel = (item: Part, pivot: Point, angle: number): Shift => {
  const t = turnPoint(item.center, pivot, angle);
  return [t[0] - item.center[0], t[1] - item.center[1]];
};
/** A shift by whole pixels, at most `limit` either way. */
const whole = (x: number, y: number, limit = 2): Shift => [
  Math.round(clamp(x, -limit, limit)),
  Math.round(clamp(y, -limit, limit)),
];
const plus = (a: Shift, b: Shift): Shift => [a[0] + b[0], a[1] + b[1]];

/** Parts enlarged ×8 once, and each turned by RotSprite once per 2° step. */
const enlargedPart = new WeakMap<Part, Uint32Array>();
const turnedPart = new WeakMap<Part, Map<number, HTMLCanvasElement>>();
const TURN_STEP = Math.PI / 90;

/**
 * A part turned about its joint by RotSprite: whole, without specks, the
 * joint where it was (owner, 2026-10-24: turned plainly, parts tore at the
 * tail and by the leg and lost pixels; only shifted, the paws stood still).
 */
function turned(item: Part, angle: number): HTMLCanvasElement {
  const step = Math.round(angle / TURN_STEP);
  if (step === 0) return item.image;
  let byStep = turnedPart.get(item);
  if (!byStep) {
    byStep = new Map();
    turnedPart.set(item, byStep);
  }
  const known = byStep.get(step);
  if (known) return known;
  let big = enlargedPart.get(item);
  if (!big) {
    big = enlarge(
      new Uint32Array(item.image.getContext('2d')!.getImageData(0, 0, 96, 72).data.buffer),
      96,
      72,
    );
    enlargedPart.set(item, big);
  }
  const image = document.createElement('canvas');
  image.width = 96;
  image.height = 72;
  const ctx = image.getContext('2d')!,
    data = ctx.createImageData(96, 72);
  sampleTurn(
    big,
    96,
    72,
    new Uint32Array(data.data.buffer),
    step * TURN_STEP,
    item.pivot,
    item.pivot,
  );
  ctx.putImageData(data, 0, 0);
  byStep.set(step, image);
  return image;
}

/** Parts land on whole pixels; `geckoSprite` mends the seams with the pose's own pixels. */
function put(ctx: CanvasRenderingContext2D, item: Part, at: Shift) {
  ctx.drawImage(item.image, at[0], at[1]);
}
function part(
  ctx: CanvasRenderingContext2D,
  item: Part,
  angle = 0,
  dx = 0,
  dy = 0,
  base: Shift = [0, 0],
) {
  ctx.drawImage(turned(item, angle), base[0] + Math.round(dx), base[1] + Math.round(dy));
}
/** A limb turned at its root to point at `target`; not stretched. */
function bone(
  ctx: CanvasRenderingContext2D,
  rig: GeckoRig,
  name: LimbName,
  target: Point,
  base: Shift = [0, 0],
) {
  const b = rig.bones[name];
  const angle =
    Math.atan2(target[1] - b.root[1], target[0] - b.root[0]) -
    Math.atan2(b.tip[1] - b.root[1], b.tip[0] - b.root[0]);
  part(ctx, rig.parts[name], angle, 0, 0, base);
}
/** The tail: its base swings by `a` at its root, its tip is carried and swings by `b` more. */
function tails(
  ctx: CanvasRenderingContext2D,
  rig: GeckoRig,
  a: number,
  b: number,
  dx = 0,
  dy = 0,
  base: Shift = [0, 0],
) {
  const root = rig.parts.tailBase,
    tip = rig.parts.tailTip;
  const at = plus(base, [Math.round(dx), Math.round(dy)]);
  part(ctx, root, a, 0, 0, at);
  const joint = turnPoint(tip.pivot, root.pivot, a);
  part(ctx, tip, a + b, joint[0] - tip.pivot[0], joint[1] - tip.pivot[1], at);
}

interface Pose {
  bodyAngle: number;
  bodyX: number;
  bodyY: number;
  head: number;
  headX: number;
  headY: number;
  armFar: number;
  armNear: number;
  legFar: number;
  legNear: number;
  tail: number;
  tip: number;
  propX: number;
  propY: number;
  propAngle: number;
}
const neutral = (): Pose => ({
  bodyAngle: 0,
  bodyX: 0,
  bodyY: 0,
  head: 0,
  headX: 0,
  headY: 0,
  armFar: 0,
  armNear: 0,
  legFar: 0,
  legNear: 0,
  tail: 0,
  tip: 0,
  propX: 0,
  propY: 0,
  propAngle: 0,
});

function seatedPose(state: GeckoAnimation, ms: number, variant: number): Pose {
  const p = neutral(),
    t = ms / 1000;
  p.bodyY = -0.35 * (1 - Math.cos(t * 2.1));
  p.head = 0.018 * Math.sin(t * 1.7);
  p.tail = 0.025 * Math.sin(t * 1.4);
  p.tip = 0.04 * Math.sin(t * 1.4 - 1);
  if (state === 'idle') {
    if (variant === 0) {
      const look = pulse(t % 7, 0.8, 4.5);
      p.head = -0.14 * look + 0.025 * Math.sin(t * 1.4);
      p.armNear = 0.05 * look;
    } else if (variant === 1) {
      p.tail = -0.16 * (1 - Math.cos(t * 1.7));
      p.tip = 0.23 * Math.sin(t * 2.2);
      p.head = 0.07 * Math.sin(t * 1.3);
      p.armNear = -0.07 * Math.sin(t * 1.7);
    } else {
      const f = pulse(t % 5, 1, 2.4);
      p.bodyX = -0.8 * f;
      p.bodyAngle = -0.045 * f;
      p.legNear = 0.16 * f;
      p.armFar = -0.16 * f;
      p.head = 0.1 * f;
      p.tip = -0.2 * f;
    }
  } else if (state === 'balance') {
    const w = Math.sin(t * (variant === 1 ? 2.9 : 1.8));
    p.bodyAngle = (variant === 1 ? 0.13 : 0.055) * w;
    p.bodyX = 0.7 * w;
    p.tail = -0.23 * w;
    p.tip = 0.18 * Math.sin(t * 2 - 0.6);
    p.head = -p.bodyAngle * 0.7;
    p.armFar = 0.13 * w;
    p.armNear = 0.18 * w;
    if (variant === 2) {
      const glance = pulse(t % 6, 1, 4);
      p.head -= 0.19 * glance;
      p.armNear += 0.12 * glance;
    }
  } else if (state === 'pet') {
    const u = clamp(ms / 1800),
      e = Math.sin(u * Math.PI);
    if (variant === 0) {
      p.bodyAngle = -0.06 * e;
      p.head = -0.19 * e;
      p.headX = -1.4 * e;
      p.headY = 0.7 * e;
      p.armFar = -0.2 * e;
      p.tail = -0.08 * e;
    } else if (variant === 1) {
      p.bodyX = -1.3 * e;
      p.bodyAngle = -0.08 * e;
      p.head = -0.11 * e;
      p.headX = -1.1 * e;
      p.headY = 1.2 * e;
      p.armNear = 0.2 * e;
      p.tip = 0.25 * e;
    } else {
      p.bodyY = 0.5 * e;
      p.head = 0.1 * e;
      p.headY = 1.1 * e;
      p.armFar = 0.12 * e;
      p.armNear = -0.12 * e;
      p.tail = -0.15 * e;
      p.tip = -0.16 * e;
    }
    p.propY = -1.5 * e;
  } else {
    const duration =
      state === 'task-created' || state === 'file-created'
        ? 2000
        : state === 'deadline-near'
          ? 2600
          : 2400;
    const u = clamp(ms / duration),
      e = Math.sin(Math.PI * u),
      nod = Math.sin(u * TAU * 2) * e;
    p.propY = -0.8 * e;
    p.propAngle = 0.035 * Math.sin(u * TAU) * e;
    if (state === 'task-created') {
      if (variant === 0) {
        p.head = 0.12 * e;
        p.armNear = -0.32 * e;
        p.bodyAngle = 0.025 * e;
      } else if (variant === 1) {
        p.head = 0.08 * nod;
        p.armNear = -0.21 * e - 0.1 * nod;
        p.armFar = 0.1 * e;
      } else {
        p.bodyY -= 1.1 * e;
        p.armNear = -0.3 * e;
        p.armFar = 0.2 * e;
        p.tail = -0.16 * e;
        p.tip = 0.23 * e;
      }
    } else if (state === 'project-created') {
      if (variant === 0) {
        p.head = 0.17 * e;
        p.armNear = -0.35 * e;
        p.bodyAngle = 0.045 * e;
      } else if (variant === 1) {
        p.propX = -2.6 * e;
        p.propY = 2 * e;
        p.armNear = -0.3 * e;
        p.armFar = 0.12 * e;
        p.head = 0.1 * e;
      } else {
        p.head = 0.12 * nod;
        p.bodyY += 0.45 * nod;
        p.tail = -0.1 * e;
        p.armNear = -0.14 * e;
      }
    } else if (state === 'file-created') {
      if (variant === 0) {
        p.head = 0.2 * e;
        p.headX = 0.6 * e;
        p.armNear = -0.25 * e;
        p.propAngle = -0.08 * e;
      } else if (variant === 1) {
        p.armNear = -0.38 * e;
        p.armFar = 0.18 * e;
        p.propX = -2 * e;
        p.propY = 2 * e;
        p.head = 0.09 * e;
      } else {
        p.armNear = -0.55 * e;
        p.bodyAngle = -0.035 * e;
        p.head = -0.08 * e;
        p.propY = -2 * e;
        p.tip = 0.19 * e;
      }
    } else if (state === 'task-completed') {
      if (variant === 0) {
        p.head = 0.13 * nod;
        p.bodyY -= 0.7 * e;
        p.armNear = -0.2 * e;
        p.tail = -0.15 * e;
      } else if (variant === 1) {
        const clap = 0.22 * (1 - Math.cos(u * TAU * 3)) * e;
        p.armFar = -clap;
        p.armNear = clap;
        p.head = 0.05 * nod;
      } else {
        p.bodyY -= 1.4 * e;
        p.bodyAngle = 0.04 * e;
        p.armFar = -0.45 * e;
        p.armNear = -0.65 * e;
        p.head = -0.11 * e;
        p.tail = -0.25 * e;
        p.tip = 0.25 * e;
      }
    } else if (state === 'nodes-linked') {
      if (variant === 0) {
        p.head = 0.14 * Math.sin(u * TAU) * e;
        p.armNear = -0.18 * e;
      } else if (variant === 1) {
        p.armNear = -0.55 * e;
        p.head = 0.11 * e;
        p.propX = -1.2 * e;
        p.propY = -0.8 * e;
      } else {
        p.armNear = -0.34 * e;
        p.bodyAngle = -0.09 * e;
        p.bodyX = -1.4 * e;
        p.head = 0.16 * e;
        p.tail = 0.2 * e;
        p.propX = -1.5 * e;
      }
    } else if (state === 'deadline-near') {
      if (variant === 0) {
        p.head = 0.16 * e;
        p.headY = -0.6 * e;
        p.armNear = -0.12 * e;
      } else if (variant === 1) {
        p.armNear = -0.22 * e - 0.12 * nod;
        p.head = 0.07 * nod;
        p.tail = -0.09 * e;
      } else {
        p.head = 0.2 * e;
        p.bodyAngle = 0.035 * e;
        p.armNear = -0.29 * e;
        p.propAngle = 0.05 * nod;
      }
    }
  }
  return p;
}

function drawSeated(
  ctx: CanvasRenderingContext2D,
  rig: GeckoRig,
  state: GeckoAnimation,
  ms: number,
  v: number,
) {
  const p = seatedPose(state, ms, v),
    hip: Point = [49, 52];
  tails(ctx, rig, p.tail, p.tip);
  part(ctx, rig.parts.legFar, p.legFar);
  part(ctx, rig.parts.legNear, p.legNear);
  // The upper body leans as one piece: one whole-pixel shift for all of it.
  const lean = travel(rig.parts.body, hip, p.bodyAngle),
    upper = whole(lean[0] + p.bodyX, lean[1] + p.bodyY, 1);
  part(ctx, rig.parts.armFar, p.armFar, 0, 0, upper);
  put(ctx, rig.parts.body, upper);
  part(ctx, rig.parts.armNear, p.armNear, 0, 0, upper);
  part(ctx, rig.parts.head, p.head, p.headX, p.headY, upper);
  part(ctx, rig.parts.prop, p.propAngle, p.propX, p.propY);
}

function drawDrag(ctx: CanvasRenderingContext2D, rig: GeckoRig, ms: number, v: number): FrameTurn {
  const t = ms / 1000,
    w = Math.sin(t * (v === 1 ? 2.15 : 1.65)),
    angle = (v === 1 ? 0.14 : 0.045) * w;
  dangle(ctx, rig, t, w, angle, v, [0, 0]);
  // The whole gecko sways from the raised paw, turned as one sprite.
  return { angle, pivot: [48, 12], to: [48, 12] };
}

/** Held up by the raised paw: legs, tail and the free paw hang and move. */
function dangle(
  ctx: CanvasRenderingContext2D,
  rig: GeckoRig,
  t: number,
  w: number,
  angle: number,
  v: number,
  body: Shift,
) {
  const curl = v === 2 ? 0.32 * (1 - Math.cos(t * 1.8)) : 0;
  tails(ctx, rig, -0.14 * w - curl, 0.2 * Math.sin(t * 2.1 - 0.8) + curl, 0, 0, body);
  part(ctx, rig.parts.legFar, (v === 2 ? -0.42 : 0.08) * Math.sin(t * 1.8), 0, 0, body);
  part(ctx, rig.parts.legNear, (v === 2 ? 0.5 : 0.1) * Math.sin(t * 1.8 + 0.4), 0, 0, body);
  part(ctx, rig.parts.armFar);
  put(ctx, rig.parts.body, body);
  part(ctx, rig.parts.armNear, -0.12 * w + (v === 2 ? 0.18 : 0), 0, 0, body);
  part(ctx, rig.parts.head, -angle * 0.38 + 0.025 * Math.sin(t * 1.4), 0, 0, body);
}

/** Local paw travel: a long planted stance followed by a lifted return arc. */
function stepMotion(phase: number, stance: number, length: number, lift: number): Point {
  phase = cycle(phase);
  if (phase < stance) return [mix(length / 2, -length / 2, phase / stance), 0];
  const p = (phase - stance) / (1 - stance);
  return [mix(-length / 2, length / 2, smooth(p)), -Math.sin(p * Math.PI) * lift];
}

function drawWalk(ctx: CanvasRenderingContext2D, rig: GeckoRig, ms: number, v: number) {
  const period = v === 1 ? 1400 : v === 2 ? 1100 : 900,
    phase = cycle(ms / period),
    t = ms / 1000;
  const slow = v === 1,
    pause = v === 2 ? 1 - 0.45 * pulse(t % 5, 2, 3.5) : 1;
  const head = slow
    ? -0.08 + 0.04 * Math.sin(t)
    : v === 2
      ? 0.13 * Math.sin(t * 1.2)
      : 0.035 * Math.sin(t * 3);
  tails(ctx, rig, 0.06 * Math.sin(phase * TAU), 0.13 * Math.sin(phase * TAU - 1));
  const phases: Record<LimbName, number> = {
    armFar: phase,
    legNear: phase,
    armNear: phase + 0.5,
    legFar: phase + 0.5,
  };
  const keys: LimbName[] = ['legFar', 'armFar', 'legNear', 'armNear'];
  const bodyY = slow ? 0.3 * Math.sin(phase * TAU * 2) : 0.55 * Math.sin(phase * TAU * 2);
  const lift = whole(0, bodyY, 1);
  for (const key of keys) {
    const b = rig.bones[key],
      d = stepMotion(phases[key], slow ? 0.77 : 0.63, (slow ? 3.6 : 5.8) * pause, slow ? 1 : 2.2);
    bone(ctx, rig, key, [b.tip[0] + d[0], b.tip[1] + d[1] - lift[1]]);
  }
  put(ctx, rig.parts.body, lift);
  part(ctx, rig.parts.head, head, 0, 0, lift);
}

function drawSleep(ctx: CanvasRenderingContext2D, rig: GeckoRig, ms: number, v: number) {
  const t = ms / 1000,
    breath = (1 - Math.cos(t * 1.35)) / 2,
    twitch = pulse(t % 6, 3.1, 3.5);
  const blanket = v === 2 ? 0.18 * (1 - Math.cos(t * 0.85)) : 0;
  tails(
    ctx,
    rig,
    -blanket,
    v === 1 ? 0.18 * twitch : blanket * 0.5,
    0,
    -(v === 2 ? 1.1 * breath : 0),
  );
  part(ctx, rig.parts.legFar);
  part(ctx, rig.parts.armFar);
  part(ctx, rig.parts.armNear);
  part(ctx, rig.parts.body, 0, 0, -breath);
  part(ctx, rig.parts.legNear, v === 1 ? 0.24 * twitch : 0.015 * Math.sin(t), 0, -0.1 * breath);
  part(ctx, rig.parts.head, v === 1 ? 0.06 * twitch : -0.015 * breath, 0, -0.25 * breath);
}

/**
 * On a rope the gecko holds on to it (owner, 2026-10-24: «держаться за нить»,
 * and the paws must move as it goes up): the approved held pose hangs from
 * the rope by its raised paw and goes along hand over hand. Each grab: the
 * free paw reaches up for the rope, the hind legs push, the body pulls up;
 * then the other paw holds — the pose mirrored about the paw, which stays on
 * the rope — and the gecko swings, turned as one sprite.
 */
function drawHang(
  ctx: CanvasRenderingContext2D,
  rig: GeckoRig,
  ms: number,
  v: number,
  options: GeckoDrawOptions,
): FrameTurn {
  const period = v === 1 ? 1700 : v === 2 ? 2100 : 1400;
  const phase = options.gripPhase == null ? cycle(ms / period) : cycle(options.gripPhase);
  const grab = cycle(phase * 2),
    other = phase >= 0.5;
  const lift = pulse(grab, 0, 0.55),
    reach = smooth(grab / 0.6);
  const pull: Shift = [0, -Math.round(2 * lift)];
  const swing = Math.sin(grab * TAU - 0.6) * (1 - 0.6 * lift);
  const angle = (v === 1 ? 0.16 : v === 2 ? 0.06 : 0.1) * swing;
  const kick = Math.sin(grab * TAU);
  tails(ctx, rig, -0.2 * swing - 0.12 * lift, 0.3 * Math.sin(grab * TAU - 1.2), 0, 0, pull);
  part(ctx, rig.parts.legFar, 0.55 * kick - 0.25 * lift, 0, 0, pull);
  part(ctx, rig.parts.legNear, -0.55 * Math.sin(grab * TAU + 0.9) + 0.25 * lift, 0, 0, pull);
  part(ctx, rig.parts.armFar);
  put(ctx, rig.parts.body, pull);
  part(ctx, rig.parts.armNear, -2.1 * reach, 0, 0, pull);
  part(ctx, rig.parts.head, -angle * 0.4 - 0.14 * lift, 0, 0, pull);
  return { angle, pivot: [48, 12], to: [48, 12], mirror: other };
}

/**
 * Places the parts of one frame on the native grid; returns the turn of the
 * whole frame, if any (a sway, a grab), for `geckoSprite` to make.
 */
export function drawGeckoRig(
  ctx: CanvasRenderingContext2D,
  rig: GeckoRig,
  state: GeckoAnimation,
  ms: number,
  options: GeckoDrawOptions,
): FrameTurn | null {
  const v = options.variant === 1 || options.variant === 2 ? options.variant : 0;
  if (options.reducedMotion) {
    for (const name of [
      'tailBase',
      'tailTip',
      'legFar',
      'armFar',
      'legNear',
      'body',
      'armNear',
      'head',
      'prop',
    ] as PartName[])
      part(ctx, rig.parts[name]);
    return null;
  }
  if (state === 'climb') return drawHang(ctx, rig, ms, v, options);
  if (state === 'drag') return drawDrag(ctx, rig, ms, v);
  if (state === 'walk') drawWalk(ctx, rig, ms, v);
  else if (state === 'sleep') drawSleep(ctx, rig, ms, v);
  else drawSeated(ctx, rig, state, ms, v);
  return null;
}
