import { hasCanvas, type PathHit, type Resolved, type TreeItem } from '@strata/backend';
import type { Locale } from '@strata/i18n';
import { escapeSegment, pathLabel, segmentSpans } from './paths';

/**
 * The path mode of the search windows (09 §2.1, §4.4): a query that starts
 * with `/`, `./` or `../` is a path; the core resolves it from the entry
 * path, and the rows are what it names, or the names nearest to the segment
 * that names nothing. `«Найти или создать»` (☑ Q-06-26) and the star map's
 * search share these.
 */

/** A query in the path mode: it starts with `/`, `./`, `../`. */
export function pathQuery(q: string): boolean {
  return /^(\/|\.\.?(\/|$))/.test(q.trimStart());
}

/** A row of the path mode: the node a path names, its network's path as words. */
export interface PathRow {
  id: string;
  name: string;
  kind: TreeItem['kind'];
  path: string;
  hit: PathHit;
}

function hitRow(hit: PathHit): PathRow {
  const [id, name] = hit.path.at(-1) ?? ['', ''];
  return { id, name, kind: hit.kind, path: pathLabel(hit.path.slice(0, -1)), hit };
}

/**
 * The network a path ending in `/` names, alone: what lies in it is offered
 * by name (09 §4.4).
 */
export function pathInto(query: string, answer: Resolved | null): PathHit | null {
  const [one] = answer?.found ?? [];
  return answer &&
    !answer.missing &&
    answer.found.length === 1 &&
    one &&
    hasCanvas(one.kind) &&
    /(^|[^\\])\/\s*$/.test(query)
    ? one
    : null;
}

/** The rows of a path's answer, `limit` at most. */
export function pathRows(
  query: string,
  answer: Resolved | null,
  items: readonly TreeItem[],
  locale: Locale,
  limit: number,
): PathRow[] {
  const into = pathInto(query, answer);
  if (into) {
    const net = into.path.at(-1)?.[0] ?? '';
    return items
      .filter((i) => i.parent === net || (i.appears ?? []).includes(net))
      .sort((a, b) => a.name.localeCompare(b.name, locale) || (a.id < b.id ? -1 : 1))
      .slice(0, limit)
      .map((i) =>
        hitRow({ path: [...into.path, [i.id, i.name]], kind: i.kind, primary: i.parent === net }),
      );
  }
  return (answer ? (answer.missing?.near ?? answer.found) : []).slice(0, limit).map(hitRow);
}

/** The segment of the query that named nothing, where a name offered goes. */
export function missingSpan(
  query: string,
  answer: Resolved | null,
): { start: number; end: number } | undefined {
  return answer?.missing ? segmentSpans(query)[answer.missing.at] : undefined;
}

/**
 * The query with a row's name in the segment that named nothing (or after
 * a network named alone), `/` after a network to go on typing; null — no
 * place for it.
 */
export function completePath(
  query: string,
  answer: Resolved | null,
  row: { name: string; kind: TreeItem['kind'] },
  slash: boolean,
): string | null {
  const tail = slash && hasCanvas(row.kind) ? '/' : '';
  if (pathInto(query, answer)) return query.trimEnd() + escapeSegment(row.name) + tail;
  const missing = missingSpan(query, answer);
  const last = segmentSpans(query).at(-1);
  const word = last ? query.slice(last.start, last.end) : '';
  // `.` and `..` name where one goes, not a name to put there.
  if (!missing && (word === '.' || word === '..')) return `${query.trimEnd()}/`;
  const span = missing ?? (answer?.found.length ? last : undefined);
  if (!span) return null;
  return query.slice(0, span.start) + escapeSegment(row.name) + tail + query.slice(span.end);
}
