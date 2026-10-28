import type { FromWorker, PinnedBody, ToWorker } from '@strata/layout/worker';
import { FULL_LAYOUT, relaxInputs, type StarMapExtract } from '@strata/view3d/map';

/**
 * The star map's physics worker (08 §3.1) as calls: a full layout, taking a
 * space in, a local relaxation, and the ticks of a thrown star. The worker
 * answers in the order it was asked; each answer settles the oldest call
 * still waiting. Positions are the laid-out ones, without the bridge's
 * offset.
 */
export class MapPhysics {
  private worker: Worker | null = null;
  private readonly waiting: { resolve: (m: FromWorker) => void; reject: (e: Error) => void }[] = [];
  /** The extract the worker holds now and its decay; another one is taken in first. */
  private holds: { x: StarMapExtract; decay: number | undefined } | null = null;

  private get w(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(new URL('./layout.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<FromWorker>) => this.waiting.shift()?.resolve(e.data);
    w.onerror = (e) => {
      const error = new Error(e.message || 'layout worker failed');
      for (const c of this.waiting.splice(0)) c.reject(error);
    };
    this.worker = w;
    return w;
  }

  private ask(msg: ToWorker, transfer: Transferable[] = []): Promise<FromWorker> {
    return new Promise((resolve, reject) => {
      this.waiting.push({ resolve, reject });
      this.w.postMessage(msg, transfer);
    });
  }

  private tell(msg: ToWorker): void {
    this.w.postMessage(msg);
  }

  /**
   * Bodies at `pos` (copied), the pinned ones where they were pinned; `ticks`
   * of a full layout (08 §3.3) or none. `decay` — the share of velocity lost
   * per tick, if not the layout's: a thrown star keeps its way longer
   * (08 §3.6). The positions after it.
   */
  async start(
    x: StarMapExtract,
    pos: Float32Array,
    pinned: PinnedBody[],
    ticks: number,
    decay?: number,
  ): Promise<Float32Array> {
    const input = relaxInputs(x);
    if (decay !== undefined) input.params = { ...input.params, decay };
    const copy = pos.slice();
    const msg: ToWorker = {
      type: 'start',
      pos: copy,
      ...input,
      ticks,
      alphaMin: FULL_LAYOUT.alphaMin,
      pinned,
    };
    this.holds = { x, decay };
    return (await this.ask(msg, [copy.buffer])).pos;
  }

  /** The worker holds `x` with this decay: a later call may tick it as it is. */
  holding(x: StarMapExtract, decay?: number): boolean {
    return this.holds?.x === x && this.holds.decay === decay;
  }

  /** Positions changed outside the worker: the next call takes the space in again. */
  forget(): void {
    this.holds = null;
  }

  /** Which bodies stay put (1) while the rest moves (08 §3.1 p. 4). */
  freeze(mask: Uint8Array): void {
    this.tell({ type: 'freeze', mask });
  }

  /** `ticks` ticks at `alpha` (08 §3.4): the positions after them. */
  async relax(ticks: number, alpha: number): Promise<Float32Array> {
    return (await this.ask({ type: 'relax', ticks, alpha })).pos;
  }

  /**
   * `n` ticks from `alpha`, cooling by `cooling` each: the positions, the
   * fastest free body's speed, the quiet ticks at the end (slower than
   * `rest`) and the alpha reached.
   */
  async tick(
    alpha: number,
    n = 1,
    cooling = 1,
    rest = 0,
  ): Promise<{ pos: Float32Array; speed: number; quiet: number; alpha: number }> {
    const m = await this.ask({ type: 'tick', alpha, n, cooling, rest });
    return m.type === 'positions'
      ? { pos: m.pos, speed: m.speed, quiet: m.quiet, alpha: m.alpha }
      : { pos: m.pos, speed: 0, quiet: 0, alpha };
  }

  move(i: number, p: readonly number[]): void {
    this.tell({ type: 'move', i, x: p[0] ?? 0, y: p[1] ?? 0, z: p[2] ?? 0 });
  }

  fix(i: number, on: boolean): void {
    this.tell({ type: 'fix', i, on });
  }

  /** Body `i` thrown at `v`, world units per tick. */
  velocity(i: number, v: readonly number[]): void {
    this.tell({ type: 'velocity', i, x: v[0] ?? 0, y: v[1] ?? 0, z: v[2] ?? 0 });
  }

  destroy(): void {
    this.worker?.terminate();
    this.worker = null;
    const error = new Error('star map closed');
    for (const c of this.waiting.splice(0)) c.reject(error);
  }
}
