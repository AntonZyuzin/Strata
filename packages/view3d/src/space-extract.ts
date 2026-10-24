import { KIND, STATE, type StarMapExtract, subtreeSizes } from './extract';
import type { MergedExtract } from './graph-extract';

/**
 * The 3D extract of a real workspace (08 §8.3, §10): every live node from
 * the core's tree, every live wire. Bodies go parents first from the root
 * (body 0), children in creation order (UUIDv7 ids sort so), as the initial
 * layout and the subtree sizes expect. A node whose network is not in the
 * tree hangs under the root.
 */

export interface SpaceItem {
  id: string;
  kind: keyof typeof KIND;
  /** The network of its primary placement; none for the root. */
  parent?: string | undefined;
  status?: string | undefined;
}

export interface SpaceWire {
  from: string;
  to: string;
}

export interface SpaceExtract {
  x: StarMapExtract;
  /** The node of each body. */
  ids: string[];
  /** The body of each node. */
  body: Map<string, number>;
}

/** Final statuses (05 §6.1): the star is drawn closed. */
const FINAL = new Set(['done', 'cancelled']);

export function spaceExtract(
  items: readonly SpaceItem[],
  wires: readonly SpaceWire[],
): SpaceExtract {
  const known = new Map(items.map((it) => [it.id, it]));
  const root = items.find((it) => !it.parent) ?? items[0];
  const ids: string[] = [];
  const body = new Map<string, number>();
  if (root) {
    const kids = new Map<string, SpaceItem[]>();
    for (const it of items) {
      if (it === root) continue;
      const p = it.parent && known.has(it.parent) ? it.parent : root.id;
      const list = kids.get(p) ?? [];
      list.push(it);
      kids.set(p, list);
    }
    const queue = [root];
    for (let k = 0; k < queue.length; k++) {
      const it = queue[k] as SpaceItem;
      if (body.has(it.id)) continue;
      body.set(it.id, ids.length);
      ids.push(it.id);
      const under = (kids.get(it.id) ?? []).sort((a, b) =>
        a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
      );
      queue.push(...under);
    }
  }
  const count = ids.length;
  const kind = new Uint8Array(count);
  const flags = new Uint8Array(count);
  const state = new Uint8Array(count);
  const primaryNet = new Int32Array(count).fill(-1);
  ids.forEach((id, b) => {
    const it = known.get(id);
    if (!it) return;
    kind[b] = KIND[it.kind] ?? KIND.note;
    state[b] = it.status && FINAL.has(it.status) ? STATE.closed : STATE.plain;
    if (b > 0)
      primaryNet[b] = body.get(it.parent && known.has(it.parent) ? it.parent : (ids[0] ?? '')) ?? 0;
  });
  const pairs: number[] = [];
  for (const w of wires) {
    const from = body.get(w.from);
    const to = body.get(w.to);
    if (from !== undefined && to !== undefined && from !== to) pairs.push(from, to);
  }
  return {
    x: {
      count,
      kind,
      flags,
      state,
      primaryNet,
      edges: Uint32Array.from(pairs),
      subtreeSize: subtreeSizes(primaryNet),
    },
    ids,
    body,
  };
}

/**
 * What the camera bridge needs (08 §7): the bodies of the network on the
 * canvas, in the order of `members` (its nodes' ids), and its own body.
 */
export function bridgeExtract(
  space: SpaceExtract,
  network: string,
  members: readonly string[],
): MergedExtract {
  const shown = members.filter((id) => space.body.has(id));
  return {
    x: space.x,
    members: Int32Array.from(shown, (id) => space.body.get(id) ?? 0),
    ids: shown,
    network: space.body.get(network) ?? 0,
  };
}
