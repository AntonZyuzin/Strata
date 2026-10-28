import type { ViewGhost } from './core';
import {
  type Core,
  type CoreFold,
  type CoreOp,
  type History,
  isFinal,
  type NetworkView,
  type NodeAttrs,
} from './core';
import {
  type Changeset,
  dueOf,
  type Fold,
  Graph,
  type GraphEvent,
  type GraphNode,
  ghostId,
  ghostSpot,
  isGhostId,
  lookOf,
  type NodeKind,
  newNode,
  type Op,
  type Tx,
  today,
} from './graph';

/**
 * The canvas and the core in step (15 §3.3). The canvas edits a `Graph` —
 * its working copy of one network — at once, as the gesture happens; this
 * class repeats every step in the core, in order: a gesture, the rest of it
 * (`amend`), its cancel, undo and redo. The core checks the model's rules and
 * writes; when it refuses a step, the network is read again from the core,
 * which is the source of truth (NFR-69).
 *
 * Deleting is the trash (05 §11): the core puts the node there and keeps its
 * wires hidden, so «Вернуть из корзины» brings them back too. The graph takes
 * the wires off first, as steps of its own; they are not sent.
 *
 * Fields of a node (05 §6.1) are graph operations too, so the properties
 * panel and the canvas share one undo.
 */

/** A roll-up's look (07 §4.6): progress, and whether something inside burns. */
function foldOf(f: CoreFold, day: string): Fold {
  const due = dueOf(f.nearest, day);
  return {
    done: f.done,
    total: f.total,
    burning: due === 'overdue' ? 'overdue' : due === 'soon' || due === 'today' ? 'soon' : null,
  };
}

/**
 * A graph of one network as the core sees it: `icon` picks each node's icon,
 * `personColor` the dots of its assignees (05 §10).
 */
export function graphOf(
  view: NetworkView,
  icon: (kind: NodeKind) => number,
  personColor: (id: string) => number = () => 0,
  day: () => string = () => today(),
): Graph {
  const g = new Graph();
  g.personColor = personColor;
  g.day = day;
  g.kindColors = true;
  g.derive({ key: 'core.change.load' }, (tx) => {
    for (const n of view.nodes) {
      const { id, kind, name, x, y, fold, external, appearance, places, ...attrs } = n;
      const node = newNode({
        id,
        name,
        kind,
        icon: icon(kind),
        x,
        y,
        attrs: attrs as NodeAttrs,
      });
      Object.assign(node, lookOf(node, day(), personColor));
      if (fold) node.fold = foldOf(fold, day());
      node.external = external ?? 0;
      node.appearance = appearance ?? false;
      node.places = places ?? 1;
      tx.add(node);
    }
    for (const e of view.edges) tx.connect(e.from, e.to);
    for (const ghost of view.ghosts) addGhost(g, tx, ghost, icon('note'));
    tx.wireShape(view.wire_style ?? null);
  });
  g.setRollups(view.rollups);
  g.clearHistory();
  return g;
}

/**
 * A ghost on the canvas (05 §8.5): a node of the canvas only, beside its
 * note, with the wire of its link. The core keeps it as a wire.
 */
function addGhost(graph: Graph, tx: Tx, ghost: ViewGhost, icon: number): void {
  const from = graph.nodes.get(ghost.from);
  if (!from) return;
  const id = ghostId(ghost.edge);
  tx.add(
    newNode({
      id,
      name: ghost.name,
      kind: 'note',
      icon,
      ghost: true,
      ghostOf: ghost.from,
      ...ghostSpot(from, ghost.name),
    }),
  );
  tx.connect(ghost.from, id);
}

/** A finished node: its own status is final (05 §6.3). */
export function finished(n: GraphNode): boolean {
  return isFinal(n.attrs.status);
}

/** Core operations for the graph's operations of one step in network `net`. */
export function opsOf(changeset: Changeset, net: string): CoreOp[] {
  const removed = new Set(changeset.ops.flatMap((op) => (op.t === 'remove' ? [op.id] : [])));
  const out: CoreOp[] = [];
  for (const op of changeset.ops) {
    // A ghost is the core's wire, not a node: what happens to it on the
    // canvas follows the note's text (05 §8.5).
    if (touchesGhost(op)) continue;
    const core = opOf(op, net, removed);
    if (core) out.push(core);
  }
  return out;
}

function touchesGhost(op: Op): boolean {
  switch (op.t) {
    case 'add':
      return isGhostId(op.node.id);
    case 'connect':
    case 'disconnect':
      return isGhostId(op.from) || isGhostId(op.to);
    case 'wireShape':
      return false;
    default:
      return isGhostId(op.id);
  }
}

function opOf(op: Op, net: string, removed: Set<string>): CoreOp | null {
  switch (op.t) {
    case 'add': {
      const n: GraphNode = op.node;
      return {
        op: 'createNode',
        id: n.id,
        kind: n.kind,
        name: n.name,
        net,
        x: n.x,
        y: n.y,
      };
    }
    case 'remove':
      // «Убрать отсюда»: the core sends the last placement's node to the trash (05 §5).
      return op.everywhere ? { op: 'trash', ids: [op.id] } : { op: 'unplace', id: op.id, net };
    case 'move':
      return { op: 'move', net, id: op.id, x: op.x, y: op.y };
    case 'rename':
      return { op: 'rename', id: op.id, name: op.name };
    case 'connect':
      return { op: 'connect', from: op.from, to: op.to };
    case 'disconnect':
      // A wire of a node going to the trash stays in the core, hidden.
      if (removed.has(op.from) || removed.has(op.to)) return null;
      return { op: 'disconnect', from: op.from, to: op.to };
    case 'attr':
      return { op: 'setAttr', id: op.id, key: op.key, value: op.value };
    case 'assign':
      return { op: 'assign', id: op.id, person: op.person, on: op.on };
    case 'flag':
      return { op: 'setFlag', id: op.id, flag: op.flag, on: op.on };
    case 'wireShape':
      return { op: 'setWireStyle', net, style: op.value };
  }
}

export class CoreSync {
  private queue: Promise<unknown> = Promise.resolve();
  private broken = false;
  private readonly off: () => void;

  constructor(
    private readonly core: Core,
    graph: Graph,
    readonly net: string,
    /** The core refused or failed a step: the caller reads the network again. */
    private readonly onError: (e: unknown) => void,
    /** The core's undo and redo after each step: the session's, across networks. */
    private readonly onHistory: (h: History) => void = () => undefined,
  ) {
    this.off = graph.subscribe((e) => this.follow(e));
  }

  destroy(): void {
    this.off();
  }

  /** Resolves when every step so far is written. */
  settled(): Promise<void> {
    return this.queue.then(() => undefined);
  }

  private send(f: () => Promise<History>): void {
    // After a refusal the steps queued behind it no longer match the core:
    // they are dropped, and the caller starts over from the core's network.
    this.queue = this.queue.then(async () => {
      if (!this.broken) this.onHistory(await f());
    });
    this.queue = this.queue.catch((e: unknown) => {
      if (this.broken) return;
      this.broken = true;
      this.onError(e);
    });
  }

  private follow(e: GraphEvent): void {
    // A look is the core's own derived state, read back from it.
    if (e.type === 'look') return;
    const cs = e.changeset;
    // System changes (the core's own text wires, a reload) come from the core.
    if (cs.source !== 'user') return;
    switch (e.type) {
      case 'apply': {
        const ops = opsOf(cs, this.net);
        if (ops.length === 0 && !e.amend) return;
        this.send(() => this.core.apply(ops, cs.label, e.amend));
        return;
      }
      case 'undo':
        this.send(() => this.core.undo());
        return;
      case 'redo':
        this.send(() => this.core.redo());
        return;
      case 'cancel':
        this.send(() => this.core.cancel());
        return;
    }
  }
}

/**
 * Brings the graph's roll-ups to what the core says (05 §6.4): a tick, a new
 * subtask or a wire changes the progress arc of a task, project or folder
 * beside it, which only the core counts. Derived state, outside undo. A
 * list's count is its panel's while one ticks (the core gets its document
 * in batches): it is left alone.
 */
export function followFolds(graph: Graph, view: NetworkView, day: string = graph.day()): void {
  for (const n of view.nodes) {
    if (n.kind === 'checklist' || !graph.nodes.has(n.id)) continue;
    graph.setFold(n.id, n.fold ? foldOf(n.fold, day) : null);
  }
}

/**
 * Brings «↗N», the roll-up wires and the appearances' marks to what the
 * core says (05 §5, §8.3, 06 §12.2, §13.3): a wire, a placement or the
 * trash elsewhere changes them, which only the core sees. Derived state,
 * outside undo.
 */
export function followExternal(graph: Graph, view: NetworkView): void {
  for (const n of view.nodes) {
    graph.setExternal(n.id, n.external ?? 0);
    // A placement made or taken away elsewhere: the shortcut and «×N» (05 §5).
    graph.setPlacement(n.id, n.appearance ?? false, n.places ?? 1);
  }
  // Bubbles the graph no longer has (a step since the question) draw nothing.
  graph.setRollups(view.rollups.filter((r) => graph.nodes.has(r.a) && graph.nodes.has(r.b)));
}

/**
 * Brings link assets to their previews from the core (05 §4.4, ✅ Q-13-16),
 * outside undo: the picture, and the page's title for a link the user has
 * not named. The core's step of the system, read back.
 */
export function followPreviews(graph: Graph, view: NetworkView): void {
  graph.derive({ key: 'core.change.preview' }, (tx) => {
    for (const n of view.nodes) {
      const g = graph.nodes.get(n.id);
      if (!g || n.kind !== 'asset') continue;
      if (g.name !== n.name) tx.rename(n.id, n.name);
      if ((g.attrs.preview ?? null) !== (n.preview ?? null)) {
        tx.attr(n.id, 'preview', n.preview ?? null);
      }
    }
  });
}

/**
 * Brings the graph's wires to what the core says, outside undo: text wires
 * that the core made or took away after a note changed (05 §8.2 rule 4).
 */
export function followWires(graph: Graph, view: NetworkView): void {
  const want = new Set(view.edges.map((e) => `${e.from}\u0000${e.to}`));
  graph.derive({ key: 'core.change.links' }, (tx) => {
    for (const [from, to] of graph.edges()) {
      // Ghosts' wires are `followGhosts`'.
      if (isGhostId(to)) continue;
      if (!want.has(`${from}\u0000${to}`)) tx.disconnect(from, to);
    }
    for (const e of view.edges) {
      if (!graph.hasEdge(e.from, e.to)) tx.connect(e.from, e.to);
    }
  });
}

/**
 * Brings the canvas's ghosts to what the core says, outside undo (05 §8.5):
 * a `[[link]]` to no node gets its ghost, a ghost whose link went or found
 * its node goes, a renamed one follows the text. Each stands beside its note.
 */
export function followGhosts(graph: Graph, view: NetworkView, icon: number): void {
  const want = new Map(view.ghosts.map((g) => [ghostId(g.edge), g]));
  graph.derive({ key: 'core.change.links' }, (tx) => {
    for (const n of [...graph.nodes.values()]) {
      if (n.ghostOf === null) continue;
      const g = want.get(n.id);
      if (!g || g.from !== n.ghostOf) {
        tx.remove(n.id);
        continue;
      }
      if (n.name !== g.name) tx.rename(n.id, g.name);
      if (!graph.hasEdge(g.from, n.id)) tx.connect(g.from, n.id);
    }
    for (const [id, g] of want) {
      if (!graph.nodes.has(id)) addGhost(graph, tx, g, icon);
    }
  });
}
