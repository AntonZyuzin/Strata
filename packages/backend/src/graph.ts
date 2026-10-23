/**
 * In-memory graph of one network for the clickable prototype (16 §3.2, step
 * 0.3) and for `pnpm dev` without the core. It applies the wire rules and
 * operations of 05 §8.2 and §8.4 and keeps an undo stack of changesets
 * (05 §11, 06 §1.2). Milestone 1A replaces it with the Rust core behind the
 * same calls; nodes carry their placement in this network directly (05 §9.2).
 */

export type NodeKind = 'network' | 'note' | 'board' | 'checklist' | 'media';
export type NodeClass = 'task' | 'project' | 'references' | 'checklist';

/**
 * Deadline state of 07 §4.6. The core derives it from the date and the viewer's
 * day (05 §6.3); the prototype stores the state to show every look.
 */
export type Due = 'none' | 'far' | 'soon' | 'today' | 'overdue';
export type Status = 'open' | 'done' | 'cancelled';

/** Roll-up of a network (05 §6.4): finished of all, and whether something inside burns. */
export interface Fold {
  done: number;
  total: number;
  burning: 'soon' | 'overdue' | null;
}

export interface GraphNode {
  id: string;
  name: string;
  kind: NodeKind;
  cls: NodeClass | null;
  /** Index into the icon presets (07 §6.3). */
  icon: number;
  /** Flag «Ключевая» (05 §7). */
  key: boolean;
  due: Due;
  status: Status;
  /** Flag «Пауза» (05 §7). */
  pause: boolean;
  /** Flag «Шаблон» (05 §7). */
  template: boolean;
  /** `[[X]]` without a node yet (05 §8.5). */
  ghost: boolean;
  /** This placement is not the node's primary one (05 §5). */
  appearance: boolean;
  /** Wires to nodes not placed in this network (05 §8.3). */
  external: number;
  /** Assignees as indices into the people palette (07 §2.2). */
  assignees: number[];
  /** Node colour, an index into the people palette (05 §4.1, ☑ Q-05-8). */
  color: number | null;
  /** Roll-up for networks, null for other kinds. */
  fold: Fold | null;
  /** Placement in this network, world units (05 §9.2). */
  x: number;
  y: number;
}

/** A plain node: open, no deadline, no flags. */
export function newNode(
  base: Pick<GraphNode, 'id' | 'name' | 'kind' | 'cls' | 'icon' | 'x' | 'y'> & Partial<GraphNode>,
): GraphNode {
  return {
    key: false,
    due: 'none',
    status: 'open',
    pause: false,
    template: false,
    ghost: false,
    appearance: false,
    external: 0,
    assignees: [],
    color: null,
    fold: null,
    ...base,
  };
}

export type Op =
  | { t: 'add'; node: GraphNode }
  | { t: 'remove'; id: string }
  | { t: 'move'; id: string; x: number; y: number }
  | { t: 'connect'; from: string; to: string }
  | { t: 'disconnect'; from: string; to: string }
  | { t: 'rename'; id: string; name: string };

/** Human-readable changeset label: an i18n key and its parameters, translated by the UI. */
export interface ChangeLabel {
  key: string;
  params?: Record<string, string | number>;
}

export interface Changeset {
  id: number;
  label: ChangeLabel;
  /**
   * 05 §11: changesets carry their source. `system` is derived state — wires
   * of `[[links]]` in a note's text (05 §8.2 rule 4) — and stays out of undo.
   */
  source: 'user' | 'system';
  ops: Op[];
  /** Applied in reverse order to undo. */
  inverse: Op[];
}

/**
 * What happened to the graph. `amend` marks the rest of a gesture folded into
 * the last step (its new operations only, and the step's label); `cancel` is
 * a step reverted and forgotten (Esc). A core behind the graph repeats them
 * (15 §3.3).
 */
export type GraphEvent =
  | { type: 'apply'; changeset: Changeset; amend: boolean }
  | { type: 'undo' | 'redo' | 'cancel'; changeset: Changeset };

/** 06 §1.2, NFR-79: 200 steps per session. */
export const UNDO_DEPTH = 200;

/** Collects operations of one gesture; every call applies at once and records its inverse. */
export interface Tx {
  add(node: GraphNode): void;
  remove(id: string): void;
  move(id: string, x: number, y: number): void;
  /** 05 §8.2 rule 2: no self-loop, at most one wire per ordered pair. False when skipped. */
  connect(from: string, to: string): boolean;
  disconnect(from: string, to: string): boolean;
  rename(id: string, name: string): void;
}

export class Graph {
  readonly nodes = new Map<string, GraphNode>();
  private readonly outs = new Map<string, Set<string>>();
  private readonly ins = new Map<string, Set<string>>();
  private undoStack: Changeset[] = [];
  private redoStack: Changeset[] = [];
  private nextId = 1;
  private readonly listeners = new Set<(e: GraphEvent) => void>();

  subscribe(fn: (e: GraphEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  hasEdge(from: string, to: string): boolean {
    return this.outs.get(from)?.has(to) ?? false;
  }

  outputs(id: string): string[] {
    return [...(this.outs.get(id) ?? [])];
  }

  inputs(id: string): string[] {
    return [...(this.ins.get(id) ?? [])];
  }

  /** All wires as [from, to]. */
  edges(): [string, string][] {
    const out: [string, string][] = [];
    for (const [from, tos] of this.outs) for (const to of tos) out.push([from, to]);
    return out;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Label of the step `undo()` would revert. */
  get undoLabel(): ChangeLabel | null {
    return this.undoStack.at(-1)?.label ?? null;
  }

  /**
   * Runs one gesture as one changeset and one undo step (06 §1.2). Returns
   * null when the gesture changed nothing, so no empty steps reach the stack.
   */
  transaction(label: ChangeLabel, build: (tx: Tx) => void): Changeset | null {
    return this.apply(label, build, 'user', false);
  }

  /**
   * Applies derived changes with the source `system` (05 §11): wires that
   * follow the text of a note. They are not steps of the user's undo.
   */
  derive(label: ChangeLabel, build: (tx: Tx) => void): Changeset | null {
    return this.apply(label, build, 'system', false);
  }

  private apply(
    label: ChangeLabel,
    build: (tx: Tx) => void,
    source: Changeset['source'],
    amend: boolean,
  ): Changeset | null {
    const ops: Op[] = [];
    const inverse: Op[] = [];
    const run = (op: Op): boolean => {
      const inv = this.applyOp(op);
      if (!inv) return false;
      ops.push(op);
      inverse.push(...inv);
      return true;
    };
    const tx: Tx = {
      add: (node) => {
        run({ t: 'add', node: { ...node } });
      },
      remove: (id) => {
        // Wires go first, each as its own operation, so undo restores them.
        for (const to of this.outputs(id)) run({ t: 'disconnect', from: id, to });
        for (const from of this.inputs(id)) run({ t: 'disconnect', from, to: id });
        run({ t: 'remove', id });
      },
      move: (id, x, y) => {
        run({ t: 'move', id, x, y });
      },
      connect: (from, to) => run({ t: 'connect', from, to }),
      disconnect: (from, to) => run({ t: 'disconnect', from, to }),
      rename: (id, name) => {
        run({ t: 'rename', id, name });
      },
    };
    try {
      build(tx);
    } catch (e) {
      // A gesture that fails half-way leaves no trace.
      for (let i = inverse.length - 1; i >= 0; i--) this.applyOp(inverse[i] as Op);
      throw e;
    }
    if (ops.length === 0) return null;
    const changeset: Changeset = { id: this.nextId++, label, source, ops, inverse };
    if (source === 'user') {
      if (!amend) this.undoStack.push(changeset);
      if (this.undoStack.length > UNDO_DEPTH) this.undoStack.shift();
      this.redoStack = [];
    }
    if (!amend) this.emit({ type: 'apply', changeset, amend: false });
    return changeset;
  }

  /**
   * Adds operations to the last step, for a gesture that continues after a
   * first commit: naming a node right after creating it (06 §5.5), or the
   * move that ends a drag after a shake. Optionally renames the step.
   */
  amend(build: (tx: Tx) => void, label?: ChangeLabel): Changeset | null {
    const last = this.undoStack.at(-1);
    if (!last) return this.transaction(label ?? { key: 'change' }, build);
    const cs = this.apply(label ?? last.label, build, 'user', true);
    // Fold the new operations into the previous step.
    if (cs) {
      last.ops.push(...cs.ops);
      last.inverse.push(...cs.inverse);
    }
    if (label) last.label = label;
    this.emit({
      type: 'apply',
      amend: true,
      changeset: cs ?? { ...last, ops: [], inverse: [] },
    });
    return last;
  }

  /** Reverts the last step without keeping it for redo: a gesture cancelled with Esc. */
  revertLast(): void {
    const cs = this.undoStack.pop();
    if (!cs) return;
    for (let i = cs.inverse.length - 1; i >= 0; i--) this.applyOp(cs.inverse[i] as Op);
    this.emit({ type: 'cancel', changeset: cs });
  }

  undo(): Changeset | null {
    const cs = this.undoStack.pop();
    if (!cs) return null;
    for (let i = cs.inverse.length - 1; i >= 0; i--) this.applyOp(cs.inverse[i] as Op);
    this.redoStack.push(cs);
    this.emit({ type: 'undo', changeset: cs });
    return cs;
  }

  redo(): Changeset | null {
    const cs = this.redoStack.pop();
    if (!cs) return null;
    for (const op of cs.ops) this.applyOp(op);
    this.undoStack.push(cs);
    this.emit({ type: 'redo', changeset: cs });
    return cs;
  }

  /** Forgets undo and redo, for example after loading the demo network. */
  clearHistory(): void {
    this.undoStack = [];
    this.redoStack = [];
  }

  private emit(e: GraphEvent) {
    for (const fn of this.listeners) fn(e);
  }

  /** Applies one operation; returns its inverse, or null when it is a no-op or not allowed. */
  private applyOp(op: Op): Op[] | null {
    switch (op.t) {
      case 'add': {
        if (this.nodes.has(op.node.id)) return null;
        this.nodes.set(op.node.id, { ...op.node });
        return [{ t: 'remove', id: op.node.id }];
      }
      case 'remove': {
        const node = this.nodes.get(op.id);
        if (!node) return null;
        // Tx.remove takes the wires off first, each a step of its own. Wires
        // left here are derived (source system, `[[links]]`) and go with the
        // node when undo or redo removes it; its inverse brings them back.
        const back: Op[] = [];
        for (const to of [...(this.outs.get(op.id) ?? [])]) {
          this.applyOp({ t: 'disconnect', from: op.id, to });
          back.push({ t: 'connect', from: op.id, to });
        }
        for (const from of [...(this.ins.get(op.id) ?? [])]) {
          this.applyOp({ t: 'disconnect', from, to: op.id });
          back.push({ t: 'connect', from, to: op.id });
        }
        this.nodes.delete(op.id);
        // Undo applies inverses from the end: the node first, then its wires.
        return [...back, { t: 'add', node }];
      }
      case 'move': {
        const node = this.nodes.get(op.id);
        if (!node || (node.x === op.x && node.y === op.y)) return null;
        const back: Op = { t: 'move', id: op.id, x: node.x, y: node.y };
        node.x = op.x;
        node.y = op.y;
        return [back];
      }
      case 'rename': {
        const node = this.nodes.get(op.id);
        if (!node || node.name === op.name) return null;
        const back: Op = { t: 'rename', id: op.id, name: node.name };
        node.name = op.name;
        return [back];
      }
      case 'connect': {
        if (op.from === op.to) return null; // 05 §8.2 rule 2: no self-loop
        if (!this.nodes.has(op.from) || !this.nodes.has(op.to)) return null;
        if (this.hasEdge(op.from, op.to)) return null; // one wire per ordered pair
        set(this.outs, op.from).add(op.to);
        set(this.ins, op.to).add(op.from);
        return [{ t: 'disconnect', from: op.from, to: op.to }];
      }
      case 'disconnect': {
        if (!this.hasEdge(op.from, op.to)) return null;
        this.outs.get(op.from)?.delete(op.to);
        this.ins.get(op.to)?.delete(op.from);
        return [{ t: 'connect', from: op.from, to: op.to }];
      }
    }
  }
}

function set(map: Map<string, Set<string>>, key: string): Set<string> {
  let s = map.get(key);
  if (!s) {
    s = new Set();
    map.set(key, s);
  }
  return s;
}

/**
 * Insert X into the wire A → B (05 §8.4): A → B goes, A → X and X → B come.
 * 💡 Precondition: X has no wires in this network. Returns false when not met.
 */
export function insertIntoWire(graph: Graph, tx: Tx, x: string, from: string, to: string): boolean {
  if (!canInsert(graph, x) || !graph.hasEdge(from, to) || x === from || x === to) return false;
  tx.disconnect(from, to);
  tx.connect(from, x);
  tx.connect(x, to);
  return true;
}

/** 05 §8.4 precondition for inserting into a wire: the node has no wires. */
export function canInsert(graph: Graph, x: string): boolean {
  return graph.inputs(x).length === 0 && graph.outputs(x).length === 0;
}

export interface ShakeResult {
  /** Inputs of the node before the shake. */
  inputs: number;
  /** The chain was healed: the single input now feeds every output. */
  healed: boolean;
}

/**
 * Shake X out of its chains (05 §8.4, ✅ D1): all its wires go; with at most
 * one input P, P is connected to every output of X. With two or more inputs X
 * is only disconnected (☑ Q-06-1; the caller shows a toast with undo).
 */
export function shake(graph: Graph, tx: Tx, x: string): ShakeResult {
  const ins = graph.inputs(x);
  const outs = graph.outputs(x);
  for (const p of ins) tx.disconnect(p, x);
  for (const o of outs) tx.disconnect(x, o);
  const p = ins.length === 1 ? ins[0] : undefined;
  if (p !== undefined) for (const o of outs) tx.connect(p, o); // skips loops and existing pairs
  return { inputs: ins.length, healed: p !== undefined && outs.length > 0 };
}

/**
 * Extract a set (Mod+Shift+X, 06 §6.7): wires that cross the set's border go;
 * if the set has at most one distinct external source, that source is
 * connected to every external target. Wires inside the set stay.
 */
export function extract(graph: Graph, tx: Tx, ids: readonly string[]): ShakeResult {
  const inSet = new Set(ids);
  const sources = new Set<string>();
  const targets = new Set<string>();
  const cut: [string, string][] = [];
  for (const id of ids) {
    for (const p of graph.inputs(id)) {
      if (!inSet.has(p)) {
        sources.add(p);
        cut.push([p, id]);
      }
    }
    for (const o of graph.outputs(id)) {
      if (!inSet.has(o)) {
        targets.add(o);
        cut.push([id, o]);
      }
    }
  }
  for (const [a, b] of cut) tx.disconnect(a, b);
  const [p] = sources.size === 1 ? [...sources] : [];
  if (p !== undefined) for (const o of targets) tx.connect(p, o);
  return { inputs: sources.size, healed: p !== undefined && targets.size > 0 };
}

/** Nodes reachable downstream of `start`, cycles allowed (05 §8.2 rule 3). */
export function downstream(graph: Graph, start: string): Set<string> {
  const seen = new Set<string>([start]);
  const stack = [start];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    for (const o of graph.outputs(id)) {
      if (!seen.has(o)) {
        seen.add(o);
        stack.push(o);
      }
    }
  }
  return seen;
}
