import type { Graph, GraphNode } from '@strata/backend';
import { FLAG, KIND, STATE, type StarMapExtract, subtreeSizes } from './extract';

/**
 * The 3D extract of 08 §8.3 for the clickable prototype: the space is
 * `base` (synthetic, the rest of a workspace), and the prototype's one
 * network joins it as a network under the root with its nodes and wires.
 * The prototype has no core yet (16 §3.2); milestone 1D reads the extract
 * from the projection.
 */
export interface MergedExtract {
  x: StarMapExtract;
  /** Bodies of the graph's nodes, in `ids` order. */
  members: Int32Array;
  ids: string[];
  /** Body of the network itself. */
  network: number;
}

function stateOf(n: GraphNode): number {
  if (n.status !== 'open') return STATE.closed;
  if (n.due === 'overdue') return STATE.overdue;
  if (n.due === 'today') return STATE.today;
  if (n.due === 'soon') return STATE.soon;
  return STATE.plain;
}

export function mergeGraph(base: StarMapExtract, graph: Graph): MergedExtract {
  const nodes = [...graph.nodes.values()];
  const network = base.count;
  const count = base.count + 1 + nodes.length;
  const kind = new Uint8Array(count);
  const flags = new Uint8Array(count);
  const state = new Uint8Array(count);
  const primaryNet = new Int32Array(count);
  kind.set(base.kind);
  flags.set(base.flags);
  state.set(base.state);
  primaryNet.set(base.primaryNet);
  kind[network] = KIND.network;
  primaryNet[network] = 0;
  const index = new Map<string, number>();
  nodes.forEach((n, j) => {
    const b = network + 1 + j;
    index.set(n.id, b);
    kind[b] = KIND[n.kind];
    flags[b] =
      (n.key ? FLAG.key : 0) | (n.pause ? FLAG.pause : 0) | (n.template ? FLAG.template : 0);
    state[b] = stateOf(n);
    primaryNet[b] = network;
  });
  const own = graph.edges();
  const edges = new Uint32Array(base.edges.length + own.length * 2);
  edges.set(base.edges);
  own.forEach(([from, to], e) => {
    edges[base.edges.length + e * 2] = index.get(from) ?? 0;
    edges[base.edges.length + e * 2 + 1] = index.get(to) ?? 0;
  });
  return {
    x: { count, kind, flags, state, primaryNet, edges, subtreeSize: subtreeSizes(primaryNet) },
    members: Int32Array.from(nodes, (_, j) => network + 1 + j),
    ids: nodes.map((n) => n.id),
    network,
  };
}
