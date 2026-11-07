import { hasCanvas, type TreeItem } from '@strata/backend';

/** A path as the core gives it: from the root, `[id, name]`. */
export type NamedPath = readonly (readonly [string, string])[];

/**
 * A network's path as a row shows it: the names under the root, as
 * «Перейти к ноде» shows them (09 §3.4); the root by its own name.
 */
export function pathLabel(path: NamedPath): string {
  if (path.length <= 1) return path[0]?.[1] ?? '';
  return path
    .slice(1)
    .map(([, name]) => name)
    .join(' / ');
}

/** A name as a segment of a path (09 §4.2): its `\` as `\\`, its `/` as `\/`. */
export function escapeSegment(name: string): string {
  return name.replace(/[\\/]/g, (c) => `\\${c}`);
}

/**
 * The text of a path (09 §4.2): `/` and the names under the root, escaped —
 * what «Скопировать путь» copies (09 §4.6) and the core reads back
 * (`resolve`); the root alone is `/`.
 */
export function pathText(path: NamedPath): string {
  const names = path.slice(1).map(([, name]) => `/${escapeSegment(name)}`);
  return names.length === 0 ? '/' : names.join('');
}

/** Two paths are the same way: the same networks one after another. */
export function samePath(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => b[i] === id);
}

/**
 * The networks lying in each network (09 §4.3): by their primary placement
 * and by their appearances (05 §5) — what `▾` after a network lists.
 */
export function childNetworks(tree: readonly TreeItem[]): Map<string, TreeItem[]> {
  const out = new Map<string, TreeItem[]>();
  const add = (net: string, item: TreeItem) => {
    const list = out.get(net);
    if (list) list.push(item);
    else out.set(net, [item]);
  };
  for (const item of tree) {
    if (!hasCanvas(item.kind)) continue;
    if (item.parent) add(item.parent, item);
    for (const net of item.appears ?? []) add(net, item);
  }
  return out;
}

/**
 * «Также в: …» (09 §4.3): the other ways to network `id` — one by each of its
 * placements (05 §5) whose network is not the one `way` came through, each
 * the canonical path to that network and then `id`; the primary one first,
 * the rest by their text. One placement each, not every path through nested
 * appearances: those many come later, lazily (05 §9.3).
 */
export function alsoIn(
  byId: ReadonlyMap<string, TreeItem>,
  id: string,
  way: readonly string[],
  pathTo: (id: string) => NamedPath,
): NamedPath[] {
  const item = byId.get(id);
  if (!item) return [];
  const came = way.at(-2);
  const nets = [...new Set([item.parent, ...(item.appears ?? [])])].filter(
    (n): n is string => n !== null && n !== undefined && n !== came && byId.has(n),
  );
  const ways = nets.map((n) => [...pathTo(n), [id, item.name] as const] as NamedPath);
  const primary = ways.filter((w) => w.at(-2)?.[0] === item.parent);
  const rest = ways
    .filter((w) => w.at(-2)?.[0] !== item.parent)
    .sort((a, b) => pathText(a).localeCompare(pathText(b)));
  return [...primary, ...rest];
}

/** `item` lies in `net` as an appearance, not by its primary placement (05 §5). */
export function appearsIn(item: TreeItem | undefined, net: string): boolean {
  return item !== undefined && item.parent !== net && (item.appears ?? []).includes(net);
}

/**
 * An entry path still holds (05 §9.3): it starts at the root and each
 * network on it lies in the one before, by any placement. One that does not
 * — a placement on it taken away, a network gone — gives way to the
 * canonical path.
 */
export function entryHolds(entry: readonly string[], byId: ReadonlyMap<string, TreeItem>): boolean {
  const first = entry[0] === undefined ? undefined : byId.get(entry[0]);
  if (!first || first.parent !== undefined) return false;
  for (let i = 1; i < entry.length; i++) {
    const item = byId.get(entry[i] ?? '');
    const before = entry[i - 1] ?? '';
    if (!item || (item.parent !== before && !(item.appears ?? []).includes(before))) return false;
  }
  return true;
}

/** How many rows of `▾` the recently visited take before the rest by name (09 §4.3). */
export const RECENT_ROWS = 5;

/**
 * The rows of `▾` (09 §4.3): the recently visited first, the latest on top,
 * five at most; then the rest by name in the UI's language, by id when two
 * share one.
 */
export function menuRows(
  items: readonly TreeItem[],
  visits: Readonly<Record<string, { at: number }>>,
  collator: Intl.Collator,
): { rows: TreeItem[]; recent: number } {
  const recent = items
    .filter((i) => visits[i.id] !== undefined)
    .sort((a, b) => (visits[b.id]?.at ?? 0) - (visits[a.id]?.at ?? 0))
    .slice(0, RECENT_ROWS);
  const top = new Set(recent.map((i) => i.id));
  const rest = items
    .filter((i) => !top.has(i.id))
    .sort((a, b) => collator.compare(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { rows: [...recent, ...rest], recent: recent.length };
}
