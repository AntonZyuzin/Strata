import type { Graph } from '@strata/backend';
import { noteText, wikiTargets } from '@strata/editor';
import { LoroDoc } from 'loro-crdt';

/**
 * The prototype's note contents (10 §2.4: `content/{nodeId}`, a LoroDoc with
 * `text`), kept as Loro snapshots in localStorage until the core stores them
 * (milestone 1A). Seed nodes have stable ids, so a note survives a reload.
 *
 * `[[Name]]` in a note's text is a wire note → Name (05 §8.2 rule 4, ✅ C8):
 * the graph gets it as a derived change (source `system`), outside undo; a
 * link removed from the text takes its wire away. Names resolve to nodes
 * case-insensitively (13 §3.4 in short); a wire the user drew stays.
 */

const KEY = 'strata.note.';
const SAVE_MS = 400;
const LINK_MS = 250;

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function fromBase64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

export class NoteStore {
  private readonly docs = new Map<string, LoroDoc>();
  /** Per note: the targets whose wires came from its text. */
  private readonly linked = new Map<string, Set<string>>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly graph: Graph) {}

  /** The note's document; loaded from storage on first use. */
  doc(id: string): LoroDoc {
    let d = this.docs.get(id);
    if (!d) {
      d = new LoroDoc();
      try {
        const saved = localStorage.getItem(KEY + id);
        if (saved) d.import(fromBase64(saved));
      } catch {
        // A broken or foreign entry starts the note empty.
      }
      this.docs.set(id, d);
    }
    return d;
  }

  /** Wires of every stored note whose node exists: the graph as the texts say. */
  restore(): void {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(KEY)) continue;
      const id = key.slice(KEY.length);
      if (this.graph.nodes.has(id)) this.link(id, noteText(this.doc(id)).toString());
    }
  }

  /** The text changed in the editor: save a moment later, rewire. */
  changed(id: string, text: string): void {
    this.later(`save:${id}`, SAVE_MS, () => this.save(id));
    this.later(`link:${id}`, LINK_MS, () => this.link(id, text));
  }

  /** Saves at once (the window closes, the page goes away). */
  flush(): void {
    for (const [k, t] of this.timers) {
      clearTimeout(t);
      if (k.startsWith('save:')) this.save(k.slice(5));
    }
    this.timers.clear();
  }

  private later(key: string, ms: number, fn: () => void): void {
    clearTimeout(this.timers.get(key));
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        fn();
      }, ms),
    );
  }

  private save(id: string): void {
    const d = this.docs.get(id);
    if (!d) return;
    try {
      localStorage.setItem(KEY + id, toBase64(d.export({ mode: 'snapshot' })));
    } catch {
      // Storage full or off: the note lives until the page closes.
    }
  }

  private link(id: string, text: string): void {
    const g = this.graph;
    if (!g.nodes.has(id)) return;
    const byName = new Map<string, string>();
    for (const n of g.nodes.values()) {
      const k = n.name.trim().toLowerCase();
      if (k && !byName.has(k)) byName.set(k, n.id);
    }
    const want = new Set<string>();
    for (const { target } of wikiTargets(text)) {
      const to = byName.get(target.toLowerCase());
      if (to && to !== id) want.add(to);
    }
    const had = this.linked.get(id) ?? new Set<string>();
    const mine = new Set<string>();
    g.derive({ key: 'proto.change.links' }, (tx) => {
      for (const to of had) {
        if (!want.has(to)) tx.disconnect(id, to);
        else mine.add(to);
      }
      for (const to of want) {
        if (had.has(to)) continue;
        // A wire the user drew is theirs: the text does not take it over.
        if (!g.hasEdge(id, to) && tx.connect(id, to)) mine.add(to);
      }
    });
    this.linked.set(id, mine);
  }
}
