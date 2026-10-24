import { type LoroDoc, LoroText, type LoroTree, type LoroTreeNode, type TreeID } from 'loro-crdt';

/**
 * A list (05 §4.2, ADR-0010): items with ticks, nested. Its content document
 * `content/<id>` keeps them as a `LoroTree` (10 §2.4): a node's data is
 * `{ text: LoroText, done }`, the tree keeps siblings in order and moves an
 * item without doubling it (10 §6). Every change here is one commit, so the
 * window's UndoManager takes it back as one step (10 §9, «Список»).
 */

/** The tree of items in a list's content document (10 §2.4). */
export const ITEMS = 'items';

export interface Item {
  id: TreeID;
  text: string;
  done: boolean;
  items: Item[];
}

/** Ticked items of all, at any depth. */
export interface Count {
  done: number;
  total: number;
}

/** Where the caret goes after a change: an item and a place in its text. */
export interface Caret {
  id: TreeID;
  at: number;
}

function read(n: LoroTreeNode): Item {
  const text = n.data.get('text');
  return {
    id: n.id,
    text: text instanceof LoroText ? text.toString() : '',
    done: n.data.get('done') === true,
    items: (n.children() ?? []).map(read),
  };
}

export function countOf(items: Item[]): Count {
  let done = 0;
  let total = 0;
  const walk = (xs: Item[]) => {
    for (const x of xs) {
      total++;
      if (x.done) done++;
      walk(x.items);
    }
  };
  walk(items);
  return { done, total };
}

/** Items depth-first, as the window shows them one under another. */
export function orderOf(items: Item[]): Item[] {
  const out: Item[] = [];
  const walk = (xs: Item[]) => {
    for (const x of xs) {
      out.push(x);
      walk(x.items);
    }
  };
  walk(items);
  return out;
}

export class Checklist {
  readonly tree: LoroTree;

  constructor(readonly doc: LoroDoc) {
    this.tree = doc.getTree(ITEMS);
  }

  items(): Item[] {
    return this.tree.roots().map(read);
  }

  private node(id: TreeID): LoroTreeNode {
    const n = this.tree.getNodeByID(id);
    if (!n || n.isDeleted()) throw new Error(`no item ${id}`);
    return n;
  }

  /** A sibling list: the children of `parent`, or the top level. */
  private siblings(parent: LoroTreeNode | undefined): LoroTreeNode[] {
    return parent ? (parent.children() ?? []) : this.tree.roots();
  }

  /**
   * A new item under `parent` (the top level when none), at `index` (the end
   * when none). Its text is a mergeable container (10 §2.6), made at once.
   */
  add(text = '', parent?: TreeID, index?: number): TreeID {
    const n = this.tree.createNode(parent, index);
    n.data.set('done', false);
    const t = n.data.ensureMergeableText('text');
    if (text) t.insert(0, text);
    this.doc.commit();
    return n.id;
  }

  setText(id: TreeID, text: string): void {
    const t = this.node(id).data.ensureMergeableText('text');
    if (t.toString() === text) return;
    t.update(text);
    this.doc.commit();
  }

  setDone(id: TreeID, done: boolean): void {
    const n = this.node(id);
    if ((n.data.get('done') === true) === done) return;
    n.data.set('done', done);
    this.doc.commit();
  }

  /**
   * `Enter` at `at` in an item's text: the rest of the text goes to a new
   * item below — the first of its children when it has any, else its next
   * sibling. An empty nested item steps out a level instead (`Shift+Tab`).
   */
  split(id: TreeID, at: number): Caret {
    const n = this.node(id);
    const t = n.data.ensureMergeableText('text');
    const text = t.toString();
    if (text === '' && n.parent()) {
      this.outdent(id);
      return { id, at: 0 };
    }
    const rest = text.slice(at);
    if (rest) t.delete(at, rest.length);
    const kids = n.children() ?? [];
    const parent = n.parent();
    const next =
      kids.length > 0
        ? this.tree.createNode(id, 0)
        : this.tree.createNode(parent?.id, (n.index() ?? 0) + 1);
    next.data.set('done', false);
    const nt = next.data.ensureMergeableText('text');
    if (rest) nt.insert(0, rest);
    this.doc.commit();
    return { id: next.id, at: 0 };
  }

  /**
   * `Backspace` at the start of an item: its text joins the item above, its
   * children stay where it was. The first item has nothing above.
   */
  join(id: TreeID): Caret | null {
    const order = orderOf(this.items());
    const i = order.findIndex((x) => x.id === id);
    const above = i > 0 ? order[i - 1] : undefined;
    if (!above) return null;
    const into = this.node(above.id).data.ensureMergeableText('text');
    const at = into.length;
    const text = this.node(id).data.get('text');
    const moved = text instanceof LoroText ? text.toString() : '';
    if (moved) into.insert(at, moved);
    this.lift(id);
    this.tree.delete(id);
    this.doc.commit();
    return { id: above.id, at };
  }

  /** Takes an item away; its children take its place. */
  remove(id: TreeID): void {
    this.lift(id);
    this.tree.delete(id);
    this.doc.commit();
  }

  /** Children of `id` move up into its place, in their order (no commit). */
  private lift(id: TreeID): void {
    const n = this.node(id);
    const parent = n.parent();
    const index = n.index() ?? 0;
    (n.children() ?? []).forEach((c, k) => {
      c.move(parent, index + 1 + k);
    });
  }

  /** `Tab`: the item becomes the last child of the sibling above. */
  indent(id: TreeID): boolean {
    const n = this.node(id);
    const i = n.index() ?? 0;
    const above = this.siblings(n.parent())[i - 1];
    if (!above) return false;
    n.move(above, (above.children() ?? []).length);
    this.doc.commit();
    return true;
  }

  /** `Shift+Tab`: the item steps out, right after its parent. */
  outdent(id: TreeID): boolean {
    const n = this.node(id);
    const parent = n.parent();
    if (!parent) return false;
    n.move(parent.parent(), (parent.index() ?? 0) + 1);
    this.doc.commit();
    return true;
  }

  /** `Alt+↑` / `Alt+↓`: the item swaps places with the sibling above or below. */
  shift(id: TreeID, by: -1 | 1): boolean {
    const n = this.node(id);
    const parent = n.parent();
    const i = n.index() ?? 0;
    const other = this.siblings(parent)[i + by];
    if (!other) return false;
    if (by < 0) n.moveBefore(other);
    else n.moveAfter(other);
    this.doc.commit();
    return true;
  }
}
