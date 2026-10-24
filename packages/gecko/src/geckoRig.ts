import {
  type ConnectedMesh,
  createConnectedMesh,
  deformConnectedMesh,
  type PixelTransform,
} from './geckoDeform';
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
  mesh: ConnectedMesh;
  bodyMesh: ConnectedMesh;
  faceMesh: ConnectedMesh;
}

const ANATOMY: readonly PartName[] = [
  'body',
  'head',
  'armFar',
  'armNear',
  'legFar',
  'legNear',
  'tailBase',
  'tailTip',
];

export const GECKO_ANIMATION_VARIANTS: Record<GeckoAnimation, readonly [string, string, string]> = {
  idle: ['Looks around', 'Plays with its tail', 'Shifts its feet'],
  walk: ['Even pace', 'Sneaks', 'Curious stroll'],
  pet: ['Reaches for the hand', 'Nuzzles', 'Holds still, trusting'],
  drag: ['Hangs calmly', 'Swings', 'Tucks its legs'],
  sleep: ['Sound asleep', 'Twitches in its sleep', 'Covers itself with its tail'],
  balance: ['Holds steady', 'Catches its balance', 'Glances at the wires'],
  climb: ['Hand over hand', 'Big swings', 'Hold, then pull'],
  'tail-hang': ['Gentle sway', 'Looks down', 'Tucks its paws'],
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
  state: Exclude<GeckoAnimation, 'climb' | 'tail-hang'>,
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
        [68, 16],
        [79, 15],
        [86, 18],
        [88, 28],
        [83, 35],
        [71, 37],
        [62, 32],
        [62, 28],
        [65, 22],
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
  const owners = new Uint8Array(96 * 72).fill(255);
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
      const distal = limbKeys.find((key) => {
        const b = bones[key],
          dx = b.tip[0] - b.root[0],
          dy = b.tip[1] - b.root[1],
          projection =
            ((x + 0.5 - b.root[0]) * dx + (y + 0.5 - b.root[1]) * dy) / (dx * dx + dy * dy);
        return projection > 0.55 && polygons[key] && inside(x + 0.5, y + 0.5, polygons[key]!);
      });
      if (propPixel[index]) owner = 'prop';
      else if (polygons.head && inside(x + 0.5, y + 0.5, polygons.head)) owner = 'head';
      else if (distal) owner = distal;
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
      if (owner !== 'prop') owners[index] = ANATOMY.indexOf(owner);
      if (owner !== 'prop' && owner !== 'body') {
        if (
          near(x, y, headPivot, 2.8) ||
          limbKeys.some((key) => near(x, y, bones[key].root, 2.2)) ||
          near(x, y, tailPivot, 2.5)
        )
          masks.body[index] = 1;
      }
    }
  // Grow fingers only along the paw's connected branch. A nearby eye or
  // tail across an air gap must never be pulled into the wrist transform.
  const headPieces = islands(masks.head),
    protectedHead = new Set(
      headPieces.reduce((a, b) => (b.length > a.length ? b : a), [] as number[]),
    );
  for (const key of limbKeys) {
    const owner = ANATOMY.indexOf(key),
      b = bones[key],
      dx = b.tip[0] - b.root[0],
      dy = b.tip[1] - b.root[1],
      distal = (index: number) => {
        const x = (index % 96) + 0.5,
          y = Math.floor(index / 96) + 0.5;
        return ((x - b.root[0]) * dx + (y - b.root[1]) * dy) / (dx * dx + dy * dy) > 0.6;
      },
      queue: number[] = [],
      distances = new Map<number, number>();
    for (let i = 0; i < owners.length; i++)
      if (owners[i] === owner && distal(i)) {
        queue.push(i);
        distances.set(i, 0);
      }
    for (const index of queue) {
      const distance = distances.get(index) ?? 0;
      if (distance >= 4) continue;
      const x = index % 96,
        y = Math.floor(index / 96);
      for (let sy = -1; sy <= 1; sy++)
        for (let sx = -1; sx <= 1; sx++) {
          const nx = x + sx,
            ny = y + sy,
            next = ny * 96 + nx;
          if (
            nx < 0 ||
            ny < 0 ||
            nx >= 96 ||
            ny >= 72 ||
            owners[next] === 255 ||
            protectedHead.has(next) ||
            distances.has(next) ||
            !distal(next)
          )
            continue;
          const previous = ANATOMY[owners[next] ?? 0] ?? 'body';
          masks[previous][next] = 0;
          masks[key][next] = 1;
          owners[next] = owner;
          queue.push(next);
          distances.set(next, distance + 1);
        }
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
  const mesh = createConnectedMesh(new Uint32Array(original.data.buffer), owners, 96, 72);
  const facePixels = mesh.pixels.map((colour, index) => (owners[index] === 1 ? colour : 0));
  const faceOwners = owners.map((owner) => (owner === 1 ? 0 : 255));
  return {
    parts,
    bones,
    kind,
    mesh,
    bodyMesh: {
      ...mesh,
      pixels: mesh.pixels.map((colour, index) => (owners[index] === 1 ? 0 : colour)),
    },
    faceMesh: createConnectedMesh(facePixels, faceOwners, 96, 72),
  };
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
const collecting = new WeakMap<CanvasRenderingContext2D, Map<Part, PixelTransform>>();
const identity: PixelTransform = (x, y) => [x, y];
const rigid =
  (item: Part, angle: number, dx = 0, dy = 0): PixelTransform =>
  (x, y) => {
    const p = turnPoint([x, y], item.pivot, angle);
    return [p[0] + dx, p[1] + dy];
  };
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
  const pose = collecting.get(ctx);
  if (pose) {
    pose.set(item, (x, y) => [x + at[0], y + at[1]]);
    return;
  }
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
  const pose = collecting.get(ctx);
  if (pose) {
    pose.set(item, rigid(item, angle, base[0] + dx, base[1] + dy));
    return;
  }
  ctx.drawImage(turned(item, angle), base[0] + Math.round(dx), base[1] + Math.round(dy));
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
    hip: Point = [49, 52],
    lean = travel(rig.parts.body, hip, p.bodyAngle),
    upper = whole(lean[0] + p.bodyX, lean[1] + p.bodyY, 1);
  tails(ctx, rig, p.tail, p.tip, 0, 0, upper);
  part(ctx, rig.parts.legFar, p.legFar);
  part(ctx, rig.parts.legNear, p.legNear);
  // The upper body leans as one piece: one whole-pixel shift for all of it.
  part(ctx, rig.parts.armFar, p.armFar, 0, 0, upper);
  put(ctx, rig.parts.body, upper);
  part(ctx, rig.parts.armNear, p.armNear, 0, 0, upper);
  // Keep eyes and mouth as one unchanged bitmap during small idle glances.
  put(ctx, rig.parts.head, plus(upper, whole(p.headX - p.head * 5, p.headY + p.head * 2, 2)));
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
  put(ctx, rig.parts.head, plus(body, whole(angle * 2, 0, 1)));
}

/** Local paw travel: a long planted stance followed by a lifted return arc. */
function stepMotion(phase: number, stance: number, length: number, lift: number): Point {
  phase = cycle(phase);
  if (phase < stance) return [mix(length / 2, -length / 2, phase / stance), 0];
  const p = (phase - stance) / (1 - stance);
  return [mix(-length / 2, length / 2, smooth(p)), -Math.sin(p * Math.PI) * lift];
}

type TailCoordinate = { u: number; normal: number; segment: number; fraction: number };
type TailAtlas = {
  project(x: number, y: number): TailCoordinate;
  positive: Float64Array;
  negative: Float64Array;
  at(u: number): { point: Point; normal: Point };
  extent(u: number, side: number): number;
  sample(u: number, fraction: number): number;
  outline: number;
};
const tailAtlases = new WeakMap<GeckoRig, TailAtlas>();

/** The same source coordinates drive the straight tail and its gripping curl. */
function tailAtlas(rig: GeckoRig): TailAtlas {
  const cached = tailAtlases.get(rig);
  if (cached) return cached;
  const points: Point[] = [
      rig.parts.tailBase.pivot,
      [28, 38],
      [19, 43],
      [17, 51],
      [23, 58],
      [32, 61],
      [38, 64],
      [41, 67],
    ],
    lengths = points.slice(1).map((p, i) => Math.hypot(p[0] - points[i]![0], p[1] - points[i]![1])),
    total = lengths.reduce((sum, value) => sum + value, 0),
    memo = new Map<string, TailCoordinate>(),
    project = (x: number, y: number): TailCoordinate => {
      const key = `${x},${y}`,
        known = memo.get(key);
      if (known) return known;
      let best = Infinity,
        travelled = 0,
        result: TailCoordinate = { u: 0, normal: 0, segment: 0, fraction: 0 };
      for (let i = 0; i < points.length - 1; i++) {
        const a = points[i]!,
          b = points[i + 1]!,
          dx = b[0] - a[0],
          dy = b[1] - a[1],
          length = lengths[i]!,
          fraction = clamp(((x - a[0]) * dx + (y - a[1]) * dy) / (length * length)),
          px = a[0] + fraction * dx,
          py = a[1] + fraction * dy,
          distance = (x - px) ** 2 + (y - py) ** 2;
        if (distance < best) {
          best = distance;
          result = {
            u: (travelled + fraction * length) / total,
            normal: (-(x - px) * dy + (y - py) * dx) / length,
            segment: i,
            fraction,
          };
        }
        travelled += length;
      }
      memo.set(key, result);
      return result;
    },
    positive = new Float64Array(25).fill(0.5),
    negative = new Float64Array(25).fill(0.5),
    art = new Uint32Array(96 * 72),
    palette = new Map<number, number>();
  for (const name of ['tailBase', 'tailTip'] as const) {
    const pixels = rig.parts[name].image.getContext('2d')!.getImageData(0, 0, 96, 72).data,
      packed = new Uint32Array(pixels.buffer);
    for (let i = 0; i < 96 * 72; i++)
      if (pixels[i * 4 + 3]) {
        const colour = packed[i] ?? 0;
        art[i] = colour;
        palette.set(colour, (palette.get(colour) ?? 0) + 1);
        const p = project((i % 96) + 0.5, Math.floor(i / 96) + 0.5),
          bin = Math.round(p.u * 24),
          side = p.normal >= 0 ? positive : negative;
        side[bin] = Math.max(side[bin] ?? 0.5, Math.abs(p.normal));
      }
  }
  const extent = (u: number, sign: number) => {
      const bin = Math.round(clamp(u) * 24),
        side = sign >= 0 ? positive : negative;
      let value = 0.5;
      for (let k = Math.max(0, bin - 2); k <= Math.min(24, bin + 2); k++)
        value = Math.max(value, side[k] ?? 0.5);
      return value;
    },
    at = (u: number) => {
      let distance = clamp(u) * total;
      for (let i = 0; i < lengths.length; i++) {
        const length = lengths[i]!;
        if (distance <= length || i === lengths.length - 1) {
          const a = points[i]!,
            b = points[i + 1]!,
            f = clamp(distance / length);
          return {
            point: [mix(a[0], b[0], f), mix(a[1], b[1], f)] as Point,
            normal: [-(b[1] - a[1]) / length, (b[0] - a[0]) / length] as Point,
          };
        }
        distance -= length;
      }
      return { point: points[0]!, normal: [0, -1] as Point };
    },
    colours = [...palette],
    base = colours.reduce((a, b) => (b[1] > a[1] ? b : a), [0xff477643, 0])[0]!,
    brightness = (colour: number) =>
      (colour & 255) * 0.3 + ((colour >>> 8) & 255) * 0.59 + ((colour >>> 16) & 255) * 0.11,
    ranked = colours.sort((a, b) => brightness(a[0]) - brightness(b[0])),
    outline = ranked[Math.floor(ranked.length * 0.12)]?.[0] ?? base,
    sample = (u: number, fraction: number) => {
      const p = at(u),
        n = fraction * extent(u, fraction),
        x = p.point[0] + p.normal[0] * n,
        y = p.point[1] + p.normal[1] * n;
      for (let radius = 0; radius <= 3; radius++)
        for (let dy = -radius; dy <= radius; dy++)
          for (let dx = -radius; dx <= radius; dx++) {
            const sx = Math.floor(x) + dx,
              sy = Math.floor(y) + dy;
            if (sx >= 0 && sy >= 0 && sx < 96 && sy < 72 && art[sy * 96 + sx])
              return art[sy * 96 + sx]!;
          }
      return base;
    };
  const result = { project, positive, negative, at, extent, sample, outline };
  tailAtlases.set(rig, result);
  return result;
}

/** Plump leopard-gecko tail: a straight main axis and a softly tapered tip. */
export function walkTailGeometry(u: number, phase: number, root: Point) {
  u = clamp(u);
  const wave = Math.sin(phase * TAU * 0.7 - u * 0.8),
    displacement = 1.3 * u * u * wave,
    derivative = 1.3 * (2 * u * wave - 0.8 * u * u * Math.cos(phase * TAU * 0.7 - u * 0.8)),
    length = Math.min(35, Math.max(20, root[0] - 3)),
    norm = Math.hypot(length, derivative),
    widths = [4.5, 5.4, 5.8, 5.6, 4.6, 3.1, 1.7, 0.45],
    at = u * (widths.length - 1),
    index = Math.min(widths.length - 2, Math.floor(at));
  return {
    point: [root[0] - length * u, root[1] + displacement] as Point,
    normal: [-derivative / norm, -length / norm] as Point,
    halfWidth: mix(widths[index]!, widths[index + 1]!, smooth(at - index)),
  };
}

function straightTail(rig: GeckoRig, phase: number, root: Point): PixelTransform {
  const atlas = tailAtlas(rig);
  return (x, y) => {
    const p = atlas.project(x, y),
      geometry = walkTailGeometry(p.u, phase, root),
      side = p.normal >= 0 ? atlas.positive : atlas.negative,
      bin = Math.round(p.u * 24);
    let extent = 0.5;
    for (let k = Math.max(0, bin - 2); k <= Math.min(24, bin + 2); k++)
      extent = Math.max(extent, side[k] ?? 0.5);
    const normal = clamp(p.normal / extent, -1.12, 1.12) * geometry.halfWidth;
    return [
      geometry.point[0] + geometry.normal[0] * normal,
      geometry.point[1] + geometry.normal[1] * normal,
    ];
  };
}

/** Two links share a knee/elbow; the foot target stays fixed during stance. */
function articulatedLimb(
  b: Bone,
  targetRoot: Point,
  targetTip: Point,
  side: number,
): PixelTransform {
  const dx = b.tip[0] - b.root[0],
    dy = b.tip[1] - b.root[1],
    rest = Math.hypot(dx, dy),
    bend = Math.min(3, rest * 0.2) * side,
    joint: Point = [
      (b.root[0] + b.tip[0]) / 2 - (dy / rest) * bend,
      (b.root[1] + b.tip[1]) / 2 + (dx / rest) * bend,
    ];
  let a = Math.hypot(joint[0] - b.root[0], joint[1] - b.root[1]),
    c = Math.hypot(b.tip[0] - joint[0], b.tip[1] - joint[1]);
  const tx = targetTip[0] - targetRoot[0],
    ty = targetTip[1] - targetRoot[1],
    distance = Math.max(0.01, Math.hypot(tx, ty)),
    stretch = Math.max(1, distance / ((a + c) * 0.985));
  a *= stretch;
  c *= stretch;
  const along = (a * a - c * c + distance * distance) / (2 * distance),
    height = Math.sqrt(Math.max(0, a * a - along * along)) * side,
    knee: Point = [
      targetRoot[0] + (tx * along - ty * height) / distance,
      targetRoot[1] + (ty * along + tx * height) / distance,
    ];
  const link = (p: Point, q: Point, toP: Point, toQ: Point): PixelTransform => {
    const sx = q[0] - p[0],
      sy = q[1] - p[1],
      length = Math.hypot(sx, sy),
      ux = toQ[0] - toP[0],
      uy = toQ[1] - toP[1],
      targetLength = Math.max(0.01, Math.hypot(ux, uy));
    return (x, y) => {
      const u = ((x - p[0]) * sx + (y - p[1]) * sy) / (length * length),
        n = (-(x - p[0]) * sy + (y - p[1]) * sx) / length;
      return [toP[0] + u * ux - (n * uy) / targetLength, toP[1] + u * uy + (n * ux) / targetLength];
    };
  };
  const upper = link(b.root, joint, targetRoot, knee),
    lower = link(joint, b.tip, knee, targetTip);
  return (x, y) => {
    const t = ((x - b.root[0]) * dx + (y - b.root[1]) * dy) / (rest * rest),
      blend = smooth((t - 0.3) / 0.4),
      p = upper(x, y),
      q = lower(x, y);
    return [mix(p[0], q[0], blend), mix(p[1], q[1], blend)];
  };
}

function drawWalk(
  ctx: CanvasRenderingContext2D,
  rig: GeckoRig,
  ms: number,
  v: number,
  options: GeckoDrawOptions,
) {
  const period = v === 1 ? 1400 : v === 2 ? 1100 : 900,
    fullPhase = options.locomotionPhase ?? ms / period,
    phase = cycle(fullPhase),
    t = ms / 1000;
  const slow = v === 1,
    stance = slow ? 0.76 : 0.68;
  const head = slow
    ? -0.08 + 0.04 * Math.sin(t)
    : v === 2
      ? 0.13 * Math.sin(t * 1.2)
      : 0.035 * Math.sin(t * 3);
  const pose = collecting.get(ctx),
    wave = (x: number) => 0.7 * Math.sin(phase * TAU + (x - 48) * 0.065),
    body: PixelTransform = (x, y) => [x, y + wave(x)],
    tailRoot = rig.parts.tailBase.pivot,
    tail = straightTail(rig, fullPhase, [tailRoot[0], tailRoot[1] + wave(tailRoot[0])]);
  pose?.set(rig.parts.body, body);
  pose?.set(rig.parts.tailBase, tail);
  pose?.set(rig.parts.tailTip, tail);
  const phases: Record<LimbName, number> = {
    armFar: phase,
    legNear: phase,
    armNear: phase + 0.5,
    legFar: phase + 0.5,
  };
  const keys: LimbName[] = ['legFar', 'armFar', 'legNear', 'armNear'];
  for (const key of keys) {
    const b = rig.bones[key],
      d = stepMotion(phases[key], stance, 10 * stance, slow ? 1.1 : 2),
      targetRoot = body(b.root[0], b.root[1]),
      targetTip: Point = [b.tip[0] + d[0], b.tip[1] + d[1] * (key.endsWith('Far') ? -1 : 1)];
    pose?.set(
      rig.parts[key],
      articulatedLimb(b, targetRoot, targetTip, key.endsWith('Far') ? -1 : 1),
    );
  }
  put(ctx, rig.parts.head, whole(-head * 5, wave(rig.parts.head.pivot[0]), 1));
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
  put(ctx, rig.parts.head, whole(v === 1 ? 0.3 * twitch : 0, -0.25 * breath, 1));
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
  put(ctx, rig.parts.head, plus(pull, whole(angle * 2, -0.7 * lift, 1)));
  return { angle, pivot: [48, 12], to: [48, 12], mirror: other };
}

/** Maps the drawn tail's centreline into a curl around the contact point. */
function tailCurl(rig: GeckoRig, root: Point): PixelTransform {
  const atlas = tailAtlas(rig),
    target: Point[] = [root, [42, 18], [41, 14], [43, 10], [47, 8], [51, 9], [52, 12], [48, 12]];
  return (x, y) => {
    const p = atlas.project(x, y),
      { segment, fraction } = p,
      normal = clamp(p.normal, -6, 6) * mix(0.8, 0.45, (segment + fraction) / 7);
    const a = target[segment]!,
      b = target[segment + 1]!,
      dx = b[0] - a[0],
      dy = b[1] - a[1],
      length = Math.max(0.01, Math.hypot(dx, dy));
    return [
      mix(a[0], b[0], fraction) - (normal * dy) / length,
      mix(a[1], b[1], fraction) + (normal * dx) / length,
    ];
  };
}

function drawTailHang(
  ctx: CanvasRenderingContext2D,
  rig: GeckoRig,
  ms: number,
  v: number,
  options: GeckoDrawOptions,
) {
  drawWalk(ctx, rig, ms, v, options);
  const pose = collecting.get(ctx);
  if (!pose) return;
  const walk = new Map(pose);
  const progress = options.reducedMotion ? 1 : smooth(options.tailHangProgress ?? 1),
    t = options.reducedMotion ? 0 : ms / 1000,
    startAngle = options.motionAngle ?? Math.PI / 2,
    endAngle = 1.82 + 0.045 * Math.sin(t * 1.55),
    delta = Math.atan2(Math.sin(endAngle - startAngle), Math.cos(endAngle - startAngle)),
    angle = startAngle + delta * progress,
    fit = poseFit(rig, walk, { angle: startAngle, pivot: [48, 36], to: [48, 36] }),
    scale = mix(fit, 1, progress),
    pivot: Point = [mix(48, 43, progress), mix(36, 32, progress)],
    to: Point = [48, mix(36, 23, progress)],
    global: PixelTransform = (x, y) => {
      const p = turnPoint([x, y], pivot, angle);
      return [to[0] + (p[0] - pivot[0]) * scale, to[1] + (p[1] - pivot[1]) * scale];
    };
  for (const name of ANATOMY) {
    const source = walk.get(rig.parts[name]) ?? identity;
    pose.set(rig.parts[name], (x, y) => {
      const p = source(x, y);
      return global(mix(p[0], x, progress), mix(p[1], y, progress));
    });
  }
  for (const key of ['armFar', 'armNear', 'legFar', 'legNear'] as LimbName[]) {
    const b = rig.bones[key],
      root = global(b.root[0], b.root[1]),
      source = walk.get(rig.parts[key]) ?? identity,
      foot = source(b.tip[0], b.tip[1]),
      initial = global(foot[0], foot[1]),
      far = key.endsWith('Far'),
      tuck = v === 2 ? (3 * (1 - Math.cos(t * 1.5))) / 2 : 0,
      target: Point = [
        mix(initial[0], root[0] + (far ? 1 : -1) * (8 - tuck), progress),
        mix(initial[1], root[1] + 8 + Math.sin(t * 1.8 + (far ? 0 : 0.7)), progress),
      ];
    pose.set(rig.parts[key], articulatedLimb(b, root, target, far ? -1 : 1));
  }
  const tailRoot = rig.parts.tailBase.pivot,
    curl = tailCurl(rig, global(tailRoot[0], tailRoot[1]));
  for (const key of ['tailBase', 'tailTip'] as const) {
    const initial = walk.get(rig.parts[key]) ?? identity;
    pose.set(rig.parts[key], (x, y) => {
      const source = initial(x, y),
        a = global(source[0], source[1]),
        b = curl(x, y);
      return [mix(a[0], b[0], progress), mix(a[1], b[1], progress)];
    });
  }
}

/** Fill the intended tail volume with samples of the approved spotted skin. */
function fillTailProfile(
  pixels: Uint32Array,
  rig: GeckoRig,
  pose: ReadonlyMap<Part, PixelTransform>,
  progress: number,
) {
  const atlas = tailAtlas(rig),
    mapper = pose.get(rig.parts.tailBase) ?? identity,
    head = pose.get(rig.parts.head) ?? identity,
    h0 = head(75, 25),
    h1 = head(76, 25),
    scale = Math.hypot(h1[0] - h0[0], h1[1] - h0[1]),
    samples = Array.from({ length: 49 }, (_, index) => {
      const u = index / 48,
        source = atlas.at(u),
        point = mapper(source.point[0], source.point[1]),
        walking = walkTailGeometry(u, 0, [0, 0]).halfWidth,
        hanging = Math.min(
          3.8,
          Math.max(atlas.extent(u, 1), atlas.extent(u, -1)) * mix(0.8, 0.45, u),
        );
      return { u, point, width: mix(walking, hanging, progress) * scale };
    });
  let left = 95,
    right = 0,
    top = 71,
    bottom = 0;
  for (const sample of samples) {
    left = Math.min(left, Math.floor(sample.point[0] - sample.width));
    right = Math.max(right, Math.ceil(sample.point[0] + sample.width));
    top = Math.min(top, Math.floor(sample.point[1] - sample.width));
    bottom = Math.max(bottom, Math.ceil(sample.point[1] + sample.width));
  }
  for (let y = Math.max(0, top); y <= Math.min(71, bottom); y++)
    for (let x = Math.max(0, left); x <= Math.min(95, right); x++) {
      const index = y * 96 + x;
      if (pixels[index]) continue;
      let best = Infinity,
        at = 0,
        normal = 0,
        width = 1;
      for (let i = 0; i < samples.length - 1; i++) {
        const a = samples[i]!,
          b = samples[i + 1]!,
          dx = b.point[0] - a.point[0],
          dy = b.point[1] - a.point[1],
          length = Math.hypot(dx, dy);
        if (length < 0.001) continue;
        const f = clamp(
            ((x + 0.5 - a.point[0]) * dx + (y + 0.5 - a.point[1]) * dy) / (length * length),
          ),
          px = mix(a.point[0], b.point[0], f),
          py = mix(a.point[1], b.point[1], f),
          distance = Math.hypot(x + 0.5 - px, y + 0.5 - py),
          radius = mix(a.width, b.width, f),
          ratio = distance / radius;
        if (ratio < best) {
          best = ratio;
          at = mix(a.u, b.u, f);
          normal = (-(x + 0.5 - px) * dy + (y + 0.5 - py) * dx) / (length * radius);
          width = radius;
        }
      }
      if (best <= 1)
        pixels[index] =
          best > 1 - 0.8 / Math.max(width, 1) ? atlas.outline : atlas.sample(at, normal);
    }
}

function paintConnected(
  ctx: CanvasRenderingContext2D,
  rig: GeckoRig,
  pose: ReadonlyMap<Part, PixelTransform>,
  state: GeckoAnimation,
  options: GeckoDrawOptions,
) {
  const pixels = deformConnectedMesh(
      rig.bodyMesh,
      ANATOMY.map((name) => pose.get(rig.parts[name]) ?? identity),
    ),
    image = ctx.createImageData(96, 72);
  const head = pose.get(rig.parts.head) ?? identity;
  const face = deformConnectedMesh(rig.faceMesh, [head]);
  if (state === 'walk' || state === 'tail-hang') {
    const progress =
      state === 'walk' ? 0 : options.reducedMotion ? 1 : smooth(options.tailHangProgress ?? 1);
    fillTailProfile(pixels, rig, pose, progress);
  }
  if (rig.kind === 'walk') {
    // A one-pixel slit can lose its colour when the whole mesh is fitted to
    // the canvas. Preserve these face landmarks through the final head map.
    const pupil = rig.mesh.pixels[29 * 96 + 76] ?? 0;
    for (const [x, top, bottom] of [
      [76, 28, 31],
      [80, 19, 21],
    ] as const) {
      const from = head(x + 0.5, top + 0.5);
      const to = head(x + 0.5, bottom + 0.5);
      const steps = Math.max(1, Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]) * 2));
      for (let step = 0; step <= steps; step++) {
        const px = Math.floor(mix(from[0], to[0], step / steps));
        const py = Math.floor(mix(from[1], to[1], step / steps));
        const index = py * 96 + px;
        if (px >= 0 && px < 96 && py >= 0 && py < 72 && face[index]) face[index] = pupil;
      }
    }
  }
  // The complete face is one rigid stamp. The torso and paw skin cannot pull
  // the brow, eye rim or mouth independently of the pupils (owner, 2026-10-25).
  for (let index = 0; index < face.length; index++) if (face[index]) pixels[index] = face[index]!;
  if (options.inspectAnatomy) {
    const origin = head(0, 0),
      x = head(1, 0),
      y = head(0, 1);
    options.inspectAnatomy({
      face: {
        matrix: [
          x[0] - origin[0],
          x[1] - origin[1],
          y[0] - origin[0],
          y[1] - origin[1],
          origin[0],
          origin[1],
        ],
        source: rig.faceMesh.pixels,
        stamp: face,
        width: 96,
        height: 72,
      },
      paws: [],
    });
  }
  new Uint32Array(image.data.buffer).set(pixels);
  ctx.putImageData(image, 0, 0);
  const prop = pose.get(rig.parts.prop);
  if (prop) {
    const centre = rig.parts.prop.pivot,
      a = prop(centre[0], centre[1]),
      b = prop(centre[0] + 1, centre[1]);
    part(
      ctx,
      rig.parts.prop,
      Math.atan2(b[1] - a[1], b[0] - a[0]),
      a[0] - centre[0],
      a[1] - centre[1],
    );
  }
}

function poseFit(rig: GeckoRig, pose: ReadonlyMap<Part, PixelTransform>, turn: FrameTurn) {
  const initial = ANATOMY.map((name) => pose.get(rig.parts[name]) ?? identity),
    cos = Math.cos(turn.angle),
    sin = Math.sin(turn.angle);
  let fit = 1;
  for (const vertex of rig.mesh.vertices) {
    const x = vertex.index % 97,
      y = Math.floor(vertex.index / 97);
    let px = 0,
      py = 0;
    for (const [owner, weight] of vertex.weights) {
      const p = initial[owner]?.(x, y) ?? [x, y];
      px += p[0] * weight;
      py += p[1] * weight;
    }
    const dx = (turn.mirror ? 96 - px : px) - turn.pivot[0],
      dy = py - turn.pivot[1],
      tx = dx * cos - dy * sin,
      ty = dx * sin + dy * cos;
    if (tx < 0) fit = Math.min(fit, (turn.to[0] - 2) / -tx);
    if (tx > 0) fit = Math.min(fit, (94 - turn.to[0]) / tx);
    if (ty < 0) fit = Math.min(fit, (turn.to[1] - 2) / -ty);
    if (ty > 0) fit = Math.min(fit, (70 - turn.to[1]) / ty);
  }
  return fit;
}

/** Apply the final turn to the source mesh, before pixels are sampled. */
function turnConnected(rig: GeckoRig, pose: Map<Part, PixelTransform>, turn: FrameTurn) {
  const fit = poseFit(rig, pose, turn),
    cos = Math.cos(turn.angle),
    sin = Math.sin(turn.angle);
  for (const name of ANATOMY) {
    const mapper = pose.get(rig.parts[name]) ?? identity;
    pose.set(rig.parts[name], (x, y) => {
      const p = mapper(x, y),
        dx = (turn.mirror ? 96 - p[0] : p[0]) - turn.pivot[0],
        dy = p[1] - turn.pivot[1];
      return [turn.to[0] + (dx * cos - dy * sin) * fit, turn.to[1] + (dx * sin + dy * cos) * fit];
    });
  }
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
  const v = options.variant === 1 || options.variant === 2 ? options.variant : 0,
    pose = new Map<Part, PixelTransform>();
  let turn: FrameTurn | null = null;
  collecting.set(ctx, pose);
  if (state === 'tail-hang') drawTailHang(ctx, rig, ms, v, options);
  else if (options.reducedMotion) {
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
    if (state === 'walk') {
      const tail = straightTail(rig, 0, rig.parts.tailBase.pivot);
      pose.set(rig.parts.tailBase, tail);
      pose.set(rig.parts.tailTip, tail);
    }
  } else if (state === 'climb') turn = drawHang(ctx, rig, ms, v, options);
  else if (state === 'drag') turn = drawDrag(ctx, rig, ms, v);
  else if (state === 'walk') drawWalk(ctx, rig, ms, v, options);
  else if (state === 'sleep') drawSleep(ctx, rig, ms, v);
  else drawSeated(ctx, rig, state, ms, v);
  collecting.delete(ctx);
  if (state === 'walk' && options.motionAngle !== undefined)
    turn = { angle: options.motionAngle, pivot: [48, 36], to: [48, 36] };
  if (turn) turnConnected(rig, pose, turn);
  paintConnected(ctx, rig, pose, state, options);
  return null;
}
