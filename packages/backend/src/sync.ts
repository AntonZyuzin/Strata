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
  lookOf,
  type NodeClass,
  type NodeKind,
  newNode,
  type Op,
  today,
} from './graph';
import { newId } from './ids';

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

const CLASSES: readonly NodeClass[] = ['task', 'project', 'references', 'checklist'];

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
  icon: (kind: NodeKind, cls: NodeClass | null) => number,
  personColor: (id: string) => number = () => 0,
  day: () => string = () => today(),
): Graph {
  const g = new Graph();
  g.personColor = personColor;
  g.day = day;
  g.classColors = true;
  g.derive({ key: 'core.change.load' }, (tx) => {
    for (const n of view.nodes) {
      const cls = CLASSES.find((c) => c === n.class) ?? null;
      const { id, kind, class: _class, name, x, y, fold, ...attrs } = n;
      const node = newNode({
        id,
        name,
        kind,
        cls,
        icon: icon(kind, cls),
        x,
        y,
        attrs: attrs as NodeAttrs,
      });
      Object.assign(node, lookOf(node, day(), personColor));
      if (fold) node.fold = foldOf(fold, day());
      tx.add(node);
    }
    for (const e of view.edges) tx.connect(e.from, e.to);
  });
  g.clearHistory();
  return g;
}

/** The names of what a new task holds (05 §4.3), in the language of the screen. */
export interface TaskContents {
  description: string;
}

/** A finished node: its own status is final (05 §6.3). */
export function finished(n: GraphNode): boolean {
  return isFinal(n.attrs.status);
}

/**
 * Core operations for the graph's operations of one step in network `net`.
 * A new task brings its «Описание» inside, in the same step (05 §4.3).
 */
export function opsOf(changeset: Changeset, net: string, task?: TaskContents): CoreOp[] {
  const removed = new Set(changeset.ops.flatMap((op) => (op.t === 'remove' ? [op.id] : [])));
  const out: CoreOp[] = [];
  for (const op of changeset.ops) {
    const core = opOf(op, net, removed);
    if (!core) continue;
    out.push(core);
    if (task && op.t === 'add' && op.node.cls === 'task' && op.node.kind === 'network') {
      const about = newId();
      out.push(
        {
          op: 'createNode',
          id: about,
          kind: 'note',
          name: task.description,
          net: op.node.id,
          x: 0,
          y: 0,
        },
        { op: 'setAttr', id: op.node.id, key: 'description', value: about },
      );
    }
  }
  return out;
}

function opOf(op: Op, net: string, removed: Set<string>): CoreOp | null {
  switch (op.t) {
    case 'add': {
      const n: GraphNode = op.node;
      return {
        op: 'createNode',
        id: n.id,
        kind: n.kind,
        ...(n.cls ? { class: n.cls } : {}),
        name: n.name,
        net,
        x: n.x,
        y: n.y,
      };
    }
    case 'remove':
      return { op: 'trash', ids: [op.id] };
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
    /** What a new task holds, named in the screen's language. */
    private readonly task?: TaskContents,
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
    const cs = e.changeset;
    // System changes (the core's own text wires, a reload) come from the core.
    if (cs.source !== 'user') return;
    switch (e.type) {
      case 'apply': {
        const ops = opsOf(cs, this.net, this.task);
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
 * Brings the graph's wires to what the core says, outside undo: text wires
 * that the core made or took away after a note changed (05 §8.2 rule 4).
 */
export function followWires(graph: Graph, view: NetworkView): void {
  const want = new Set(view.edges.map((e) => `${e.from}\u0000${e.to}`));
  graph.derive({ key: 'core.change.links' }, (tx) => {
    for (const [from, to] of graph.edges()) {
      if (!want.has(`${from}\u0000${to}`)) tx.disconnect(from, to);
    }
    for (const e of view.edges) {
      if (!graph.hasEdge(e.from, e.to)) tx.connect(e.from, e.to);
    }
  });
}
