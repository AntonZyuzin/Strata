import type { Graph } from '@strata/backend';
import type { CanvasView } from '@strata/canvas';
import type { LayoutSpacing, NetLayout } from '@strata/layout';
import type { LayoutAnswer, LayoutRequest } from '@strata/layout/net-worker';

/**
 * `L` of the prototype (06 §9.1–9.2, spike 10): the chosen nodes and the
 * wires between them go to the layout worker; the answer comes back as one
 * step of the graph (one undo), and the view animates the move (06 §1.4).
 */

/**
 * Gaps of `L`, world units: S bubbles are 32 across, M 48, L 72 (07 §4.2);
 * `strata_layout::Spacing::DEFAULT`, which the core's import lays out with.
 */
export const LAYOUT_SPACING: LayoutSpacing = { gap: 24, layer: 72 };

export class Layouter {
  private worker: Worker | null = null;
  private next = 0;
  private waiting = new Map<number, (a: LayoutAnswer) => void>();
  /** Time of the last layout in the worker, ms (NFR-08). */
  lastMs: number | null = null;

  /** New positions of `ids`, `[x, y]` per id, or null when there is nothing to do. */
  async layout(
    graph: Graph,
    view: CanvasView,
    ids: readonly string[],
    kind: NetLayout,
    fromText: (a: string, b: string) => boolean,
  ): Promise<Float32Array | null> {
    if (ids.length < 2) return null;
    const index = new Map(ids.map((id, i) => [id, i]));
    const pos = new Float32Array(ids.length * 2);
    const radius = new Float32Array(ids.length);
    ids.forEach((id, i) => {
      const node = graph.nodes.get(id);
      pos[i * 2] = node?.x ?? 0;
      pos[i * 2 + 1] = node?.y ?? 0;
      radius[i] = view.nodeAt(id)?.r ?? 16;
    });
    const from: number[] = [];
    const to: number[] = [];
    const text: number[] = [];
    for (const [a, b] of graph.edges()) {
      const ia = index.get(a);
      const ib = index.get(b);
      if (ia === undefined || ib === undefined) continue;
      from.push(ia);
      to.push(ib);
      text.push(fromText(a, b) ? 1 : 0);
    }
    const request: LayoutRequest = {
      id: ++this.next,
      kind,
      net: {
        pos,
        radius,
        // Pinning comes with the core (06 §9.1); the prototype has none.
        pinned: new Uint8Array(ids.length),
        from: Uint32Array.from(from),
        to: Uint32Array.from(to),
        text: Uint8Array.from(text),
      },
      spacing: LAYOUT_SPACING,
    };
    const answer = await this.ask(request);
    if ('error' in answer) throw new Error(answer.error);
    this.lastMs = answer.ms;
    return answer.pos;
  }

  destroy(): void {
    this.worker?.terminate();
    this.worker = null;
  }

  private ask(request: LayoutRequest): Promise<LayoutAnswer> {
    if (!this.worker) {
      this.worker = new Worker(new URL('./layout-net.worker.ts', import.meta.url), {
        type: 'module',
      });
      this.worker.onmessage = (e: MessageEvent<LayoutAnswer>) => {
        const done = this.waiting.get(e.data.id);
        this.waiting.delete(e.data.id);
        done?.(e.data);
      };
    }
    const w = this.worker;
    return new Promise((resolve) => {
      this.waiting.set(request.id, resolve);
      const { net } = request;
      w.postMessage(request, [
        net.pos.buffer,
        net.radius.buffer,
        net.pinned.buffer,
        net.from.buffer,
        net.to.buffer,
        net.text.buffer,
      ]);
    });
  }
}
