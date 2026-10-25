/// <reference lib="webworker" />

import type { SearchAnswer, SearchRequest } from './client';
import { loadSearch, NameIndex, rankByName } from './index';

/**
 * The search worker (09 §2.7, 15 §4): the names of the open workspace and of
 * the canvas, each a collection the UI sets when it changes; queries are
 * answered in the order they come, after every `set` before them.
 */

declare const self: DedicatedWorkerGlobalScope;

const collections = new Map<string, NameIndex>();
// One message at a time: the module loads once, then the rest wait their turn.
let queue: Promise<unknown> = Promise.resolve();

function answer(r: Exclude<SearchRequest, { t: 'set' }>): SearchAnswer {
  if (r.t === 'rank') return { id: r.id, ranked: rankByName(r.q, r.names, r.limit) };
  const index = collections.get(r.name);
  if (r.t === 'query') return { id: r.id, ids: index ? index.query(r.q, r.ctx) : [] };
  return {
    id: r.id,
    found: index ? index.find(r.q, r.caseSensitive, r.scope) : { ids: [], unknown: [], text: '' },
  };
}

self.onmessage = (e: MessageEvent<SearchRequest>) => {
  const r = e.data;
  queue = queue.then(async () => {
    await loadSearch();
    if (r.t === 'set') {
      collections.get(r.name)?.free();
      collections.set(r.name, new NameIndex(r.items));
      return;
    }
    try {
      self.postMessage(answer(r));
    } catch (err) {
      self.postMessage({ id: r.id, error: String(err) } satisfies SearchAnswer);
    }
  });
};
