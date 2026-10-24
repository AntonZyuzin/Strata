import type { Core } from '@strata/backend';
import { LoroDoc } from 'loro-crdt';

/**
 * Content documents of the open workspace (10 §2.4, 15 §3.4): a note's text,
 * a board's scene. The editor works on its own `LoroDoc`; what it types goes
 * to the core as updates, in batches of up to 200 ms. When the core answers
 * that a note's text wires changed, `onWires` reads the network again.
 */

const BATCH_MS = 200;

interface Open {
  doc: LoroDoc;
  sent: ReturnType<LoroDoc['oplogVersion']>;
  /**
   * Local changes not yet sent. Not the update's length: Loro's update with
   * nothing new still has a header (22 bytes), and pushing it for every open
   * document on every flush reached the core for nodes it no longer has.
   */
  dirty: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  off: () => void;
}

export class CoreDocs {
  private readonly open = new Map<string, Open>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly core: Core,
    private readonly onWires: () => void,
    private readonly onError: (e: unknown) => void,
  ) {}

  /** The node's content document, from the core on first use. */
  async doc(id: string): Promise<LoroDoc> {
    const known = this.open.get(id);
    if (known) return known.doc;
    const doc = new LoroDoc();
    doc.import(await this.core.openDoc(`content/${id}`));
    const again = this.open.get(id);
    if (again) return again.doc;
    const entry: Open = {
      doc,
      sent: doc.oplogVersion(),
      dirty: false,
      timer: null,
      off: doc.subscribeLocalUpdates(() => {
        entry.dirty = true;
        this.later(id);
      }),
    };
    this.open.set(id, entry);
    return doc;
  }

  private later(id: string): void {
    const e = this.open.get(id);
    if (!e || e.timer) return;
    e.timer = setTimeout(() => {
      e.timer = null;
      this.push(id);
    }, BATCH_MS);
  }

  private push(id: string): void {
    const e = this.open.get(id);
    if (!e?.dirty) return;
    e.dirty = false;
    const update = e.doc.export({ mode: 'update', from: e.sent });
    e.sent = e.doc.oplogVersion();
    this.queue = this.queue
      .then(() => this.core.pushDoc(`content/${id}`, update))
      .then((wires) => {
        if (wires) this.onWires();
      })
      .catch((err: unknown) => this.onError(err));
  }

  /** Sends what is waiting and resolves when the core has it all. */
  flush(): Promise<void> {
    for (const [id, e] of this.open) {
      if (e.timer) {
        clearTimeout(e.timer);
        e.timer = null;
      }
      this.push(id);
    }
    return this.queue.then(() => undefined);
  }

  destroy(): void {
    for (const e of this.open.values()) {
      if (e.timer) clearTimeout(e.timer);
      e.off();
    }
    this.open.clear();
  }
}
