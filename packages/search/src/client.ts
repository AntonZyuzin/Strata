import type { Found, Ranked, Scope, SearchContext, SearchItem } from './index';

/** What the UI asks the search worker; answers carry the request's id. */
export type SearchRequest =
  | { t: 'set'; name: string; items: readonly SearchItem[] }
  | { t: 'query'; id: number; name: string; q: string; ctx: SearchContext }
  | { t: 'find'; id: number; name: string; q: string; caseSensitive: boolean; scope: Scope }
  | { t: 'rank'; id: number; q: string; names: readonly string[]; limit: number };

export type SearchAnswer =
  | { id: number; ids: string[] }
  | { id: number; found: Found }
  | { id: number; ranked: Ranked[] }
  | { id: number; error: string };

/**
 * The search worker's client (09 §2.7): the main thread never waits for a
 * query. Named collections — the workspace's names, a canvas's — are set
 * when they change and asked by name; the worker answers in order, so a
 * query sees every `set` before it. `spawn` makes the worker (Vite needs
 * `new Worker(new URL(…))` in the app's own module).
 */
export class SearchClient {
  private worker: Worker | null = null;
  private next = 1;
  private readonly waiting = new Map<number, (a: SearchAnswer) => void>();

  constructor(private readonly spawn: () => Worker) {}

  /** The names of collection `name`, replacing what it had. */
  set(name: string, items: readonly SearchItem[]): void {
    this.post({ t: 'set', name, items });
  }

  /** Ids of collection `name` ranked by name; none for an unknown collection. */
  async query(name: string, q: string, ctx: SearchContext = {}): Promise<string[]> {
    const a = await this.ask({ t: 'query', id: 0, name, q, ctx });
    return 'ids' in a ? a.ids : [];
  }

  /** `Ctrl+F` over collection `name` (09 §3.3). */
  async find(name: string, q: string, caseSensitive: boolean, scope: Scope): Promise<Found> {
    const a = await this.ask({ t: 'find', id: 0, name, q, caseSensitive, scope });
    return 'found' in a ? a.found : { ids: [], unknown: [], text: '' };
  }

  /** A short list ranked by name, best first. */
  async rank(q: string, names: readonly string[], limit: number): Promise<Ranked[]> {
    const a = await this.ask({ t: 'rank', id: 0, q, names, limit });
    return 'ranked' in a ? a.ranked : [];
  }

  destroy(): void {
    this.worker?.terminate();
    this.worker = null;
    for (const done of this.waiting.values()) done({ id: 0, error: 'closed' });
    this.waiting.clear();
  }

  private post(request: SearchRequest): void {
    if (!this.worker) {
      this.worker = this.spawn();
      this.worker.onmessage = (e: MessageEvent<SearchAnswer>) => {
        const done = this.waiting.get(e.data.id);
        this.waiting.delete(e.data.id);
        done?.(e.data);
      };
    }
    this.worker.postMessage(request);
  }

  private ask(request: Exclude<SearchRequest, { t: 'set' }>): Promise<SearchAnswer> {
    const id = this.next++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.post({ ...request, id });
    });
  }
}
