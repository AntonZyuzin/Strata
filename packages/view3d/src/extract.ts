/**
 * The 3D extract of 08 §8.3: what the star map reads instead of the CRDT —
 * kinds, flags, states, the tree of primary placements, wires. Binary arrays,
 * index = body. Spike 2 runs on a synthetic one shaped like a real space:
 * networks nested a few levels deep, a few big projects and many small ones,
 * most wires inside a network and some between (14 §1.3, W-sets).
 */

export const KIND = { network: 0, note: 1, board: 2, checklist: 3, media: 4 } as const;
export const FLAG = { key: 1, pause: 2, template: 4 } as const;
/** 08 §8.3: 0 plain, 1 soon, 2 today, 3 overdue, 4 final status. */
export const STATE = { plain: 0, soon: 1, today: 2, overdue: 3, closed: 4 } as const;

export interface StarMapExtract {
  count: number;
  kind: Uint8Array;
  flags: Uint8Array;
  state: Uint8Array;
  /** Body of the network of the primary placement; −1 for the root. */
  primaryNet: Int32Array;
  /** Pairs (from, to). */
  edges: Uint32Array;
  /** Bodies in the subtree of primary placements, the body itself included. */
  subtreeSize: Uint32Array;
}

function rng(seed: number): () => number {
  let x = seed | 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 4294967296;
  };
}

export interface ExtractOptions {
  nodes: number;
  edges: number;
  seed?: number;
  /** Share of networks among nodes; 8 % by default. */
  networkShare?: number;
}

/**
 * A synthetic space: body 0 is the root network; networks form a tree with
 * a skewed branching (a few big projects), other nodes go to networks with a
 * Zipf-like preference, 70 % of wires stay inside one network.
 */
export function syntheticExtract(o: ExtractOptions): StarMapExtract {
  const r = rng(o.seed ?? 3);
  const n = o.nodes;
  const nets = Math.max(1, Math.round(n * (o.networkShare ?? 0.08)));
  const kind = new Uint8Array(n);
  const flags = new Uint8Array(n);
  const state = new Uint8Array(n);
  const primaryNet = new Int32Array(n).fill(-1);
  // Networks: body i's parent is an earlier network, chosen near the front of
  // the list more often, so early networks become big projects.
  for (let i = 1; i < nets; i++) {
    kind[i] = KIND.network;
    primaryNet[i] = Math.floor(i * r() ** 2.2);
  }
  kind[0] = KIND.network;
  const others = [KIND.note, KIND.note, KIND.note, KIND.board, KIND.checklist, KIND.media];
  for (let i = nets; i < n; i++) {
    kind[i] = others[Math.floor(r() * others.length)] ?? KIND.note;
    primaryNet[i] = Math.floor(nets * r() ** 1.6);
  }
  for (let i = 1; i < n; i++) {
    if (r() < 0.1) flags[i] = (flags[i] ?? 0) | FLAG.key;
    if (r() < 0.03) flags[i] = (flags[i] ?? 0) | FLAG.pause;
    const s = r();
    state[i] =
      s < 0.03
        ? STATE.soon
        : s < 0.04
          ? STATE.today
          : s < 0.06
            ? STATE.overdue
            : s < 0.16
              ? STATE.closed
              : STATE.plain;
  }
  // Members of each network, for wires inside it.
  const members: number[][] = Array.from({ length: nets }, () => []);
  for (let i = 1; i < n; i++) members[primaryNet[i] ?? 0]?.push(i);
  const edges = new Uint32Array(o.edges * 2);
  const seen = new Set<number>();
  let e = 0;
  let guard = 0;
  while (e < o.edges && guard++ < o.edges * 20) {
    let a: number;
    let b: number;
    if (r() < 0.7) {
      const list = members[Math.floor(nets * r() ** 1.6)] ?? [];
      if (list.length < 2) continue;
      a = list[Math.floor(r() * list.length)] ?? 0;
      b = list[Math.floor(r() * list.length)] ?? 0;
    } else {
      a = 1 + Math.floor(r() * (n - 1));
      b = 1 + Math.floor(r() * (n - 1));
    }
    if (a === b) continue;
    const k = a * n + b;
    if (seen.has(k)) continue;
    seen.add(k);
    edges[e * 2] = a;
    edges[e * 2 + 1] = b;
    e++;
  }
  return {
    count: n,
    kind,
    flags,
    state,
    primaryNet,
    edges: edges.subarray(0, e * 2),
    subtreeSize: subtreeSizes(primaryNet),
  };
}

/** Subtree sizes of the primary-placement tree; parents always precede children here. */
export function subtreeSizes(primaryNet: Int32Array): Uint32Array {
  const n = primaryNet.length;
  const size = new Uint32Array(n).fill(1);
  // Children have larger indices than parents in an extract built in creation
  // order (UUIDv7); summing from the end folds every subtree into its root.
  for (let i = n - 1; i > 0; i--) {
    const p = primaryNet[i] ?? -1;
    if (p >= 0) size[p] = (size[p] ?? 0) + (size[i] ?? 0);
  }
  return size;
}
