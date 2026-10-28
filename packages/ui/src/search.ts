import type { GraphNode } from '@strata/backend';
import { flagsOf } from '@strata/backend';
import { SearchClient, type SearchItem, type Visit } from '@strata/search';

/**
 * The search worker of the app (09 §2.7): one for the page. Its
 * collections: `space` — the names of the open workspace, from the core's
 * tree; `net` — the nodes of the canvas, from its graph, as fresh as it is.
 */
let client: SearchClient | null = null;

export function searchClient(): SearchClient {
  client ??= new SearchClient(
    () => new Worker(new URL('./search.worker.ts', import.meta.url), { type: 'module' }),
  );
  return client;
}

/** A canvas's nodes as the engine reads them; `net` is their network. */
export function netItems(nodes: Iterable<GraphNode>, net: string): SearchItem[] {
  const out: SearchItem[] = [];
  for (const n of nodes) {
    // A ghost is not a node (05 §8.5): the Tab menu offers it on its own.
    if (n.ghostOf) continue;
    out.push({
      id: n.id,
      name: n.name,
      kind: n.kind,
      parent: net,
      status: n.attrs.status,
      flags: flagsOf(n),
    });
  }
  return out;
}

/**
 * This device's visits of nodes (05 §13, 09 §2.5): when a node was last
 * chosen in a search or opened, and how often in 30 days; per workspace, in
 * `localStorage`. A convenience: private windows may refuse storage.
 */
const MONTH_MS = 30 * 86_400_000;

function visitsKey(workspace: string): string {
  return `strata.visits.${workspace}`;
}

function readVisits(workspace: string): Record<string, number[]> {
  try {
    const raw = localStorage.getItem(visitsKey(workspace));
    return raw ? (JSON.parse(raw) as Record<string, number[]>) : {};
  } catch {
    return {};
  }
}

/** The visits as the ranking takes them. */
export function visits(workspace: string, now = Date.now()): Record<string, Visit> {
  const out: Record<string, Visit> = {};
  for (const [id, times] of Object.entries(readVisits(workspace))) {
    const recent = times.filter((t) => now - t < MONTH_MS);
    const at = recent.at(-1);
    if (at !== undefined) out[id] = { at, count: recent.length };
  }
  return out;
}

/** A node chosen or opened now. */
export function visited(workspace: string, id: string, now = Date.now()): void {
  const all = readVisits(workspace);
  const times = (all[id] ?? []).filter((t) => now - t < MONTH_MS).slice(-19);
  all[id] = [...times, now];
  try {
    localStorage.setItem(visitsKey(workspace), JSON.stringify(all));
  } catch {
    // The ranking works without them.
  }
}
