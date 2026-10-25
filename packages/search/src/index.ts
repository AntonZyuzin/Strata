import init, { Names, norm, rankNames } from '../pkg/strata_search.js';

/**
 * The name search of `crates/strata-search` as WASM (09 §2.7): one engine
 * for the Tab menu, `Ctrl+O`, `Ctrl+F`, the «Ноды» filter and the star map's
 * search. It runs in the UI's search worker (`worker.ts`, asked through
 * `SearchClient`); tests load it in Node. The module is built by
 * `pnpm --filter @strata/search build` (wasm-pack) into `pkg/`, which is not
 * committed.
 */

/** A node as the engine reads it: the core's tree item fits as it is. */
export interface SearchItem {
  id: string;
  name: string;
  kind: string;
  /** The network of its primary placement; none for the root. */
  parent?: string | undefined;
  status?: string | undefined;
  flags?: readonly string[] | undefined;
  /** Its other names (05 §6.1), ranked 50 below the name. */
  aliases?: readonly string[] | undefined;
}

/** Where a query looks: everything, a network's nodes, or all under a node. */
export type Scope = { t: 'all' } | { t: 'in'; net: string } | { t: 'under'; net: string };

/** This device's visits of a node (05 §13): last opened, opens in 30 days. */
export interface Visit {
  at: number;
  count: number;
}

/** What the ranking knows besides names (09 §2.5). */
export interface SearchContext {
  /** 50 by default. */
  limit?: number | undefined;
  scope?: Scope | undefined;
  /** The network on the canvas: closeness. */
  here?: string | undefined;
  visits?: Record<string, Visit> | undefined;
  /** Now, for the visits' age. */
  now?: number | undefined;
}

/** `Ctrl+F`'s answer (09 §3.3). */
export interface Found {
  ids: string[];
  /** Filters it does not know (`@` of a person until 1.4): left out. */
  unknown: string[];
  /** The query's text without filters: the fuzzy line asks the index with it. */
  text: string;
}

let ready: Promise<unknown> | null = null;

/**
 * Loads the module once. In a browser or a worker it fetches the `.wasm` next
 * to the script (Vite bundles it as an asset); Node passes the bytes.
 */
export function loadSearch(bytes?: BufferSource): Promise<unknown> {
  ready ??= bytes ? init({ module_or_path: bytes }) : init();
  return ready;
}

/** The names of a workspace or a canvas; call after `loadSearch`. */
export class NameIndex {
  private readonly names: Names;
  private readonly ids: string[];

  constructor(items: readonly SearchItem[]) {
    this.names = new Names(JSON.stringify(items));
    this.ids = items.map((i) => i.id);
  }

  get size(): number {
    return this.ids.length;
  }

  /** Ids ranked by name, best first (09 §2.3, §2.5). */
  query(q: string, ctx: SearchContext = {}): string[] {
    return [...this.names.query(q, JSON.stringify(ctx))].map((n) => this.ids[n] ?? '');
  }

  /** `Ctrl+F` (09 §3.3): the nodes in `scope` the query matches, in the items' order. */
  find(q: string, caseSensitive: boolean, scope: Scope): Found {
    const r = JSON.parse(this.names.find(q, caseSensitive, JSON.stringify(scope))) as {
      nodes: number[];
      unknown: string[];
      text: string;
    };
    return { ids: r.nodes.map((n) => this.ids[n] ?? ''), unknown: r.unknown, text: r.text };
  }

  free(): void {
    this.names.free();
  }
}

/** A row of a short list ranked by name: its index, its score — 1000 is the name exactly. */
export interface Ranked {
  index: number;
  score: number;
}

/** A short list by name only (the Tab menu's kinds and templates), best first. */
export function rankByName(q: string, names: readonly string[], limit: number): Ranked[] {
  const flat = rankNames(q, [...names], limit);
  const out: Ranked[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2)
    out.push({ index: flat[i] ?? 0, score: flat[i + 1] ?? 0 });
  return out;
}

export type { SearchAnswer, SearchRequest } from './client';
export { SearchClient } from './client';
export { norm };
