import type { NodeKind } from '@strata/backend';
import type { MenuChoice } from '@strata/canvas';
import { type Locale, type MessageKey, t } from '@strata/i18n';
import type { Ranked, SearchContext } from '@strata/search';

/**
 * Items of the Tab menu (06 §5.2): with an empty query — the kinds, and
 * recent choices that are not among them, then «Шаблоны» (nodes with the
 * flag, 05 §7); with a query — «Создать» (a note named by the query first, then
 * matching kinds), the matching templates and «Вставить здесь» (existing
 * nodes). ADR-0010: no classes. The ranking is the search engine's (09 §2,
 * `@strata/search` in its worker): `rankMenu` asks it, `menuItems` lays out
 * what it answered.
 */

/** A kind as the menu offers it. */
export interface KindEntry {
  kind: NodeKind;
  key: MessageKey;
}

export const KINDS: KindEntry[] = [
  { kind: 'network', key: 'kind.network' },
  { kind: 'project', key: 'kind.project' },
  { kind: 'task', key: 'kind.task' },
  { kind: 'note', key: 'kind.note' },
  { kind: 'board', key: 'kind.board' },
  { kind: 'checklist', key: 'kind.checklist' },
  { kind: 'asset', key: 'kind.asset' },
];

export type Group = 'recent' | 'kinds' | 'create' | 'templates' | 'insert';

export interface MenuItem {
  id: string;
  group: Group;
  label: string;
  /** Muted text on the right: the kind of an existing node. */
  detail: string;
  kind: NodeKind;
  choice: MenuChoice;
}

export interface MenuNode {
  id: string;
  name: string;
  kind: NodeKind;
}

/** The engine's calls the menu needs: `SearchClient` in the app, the module itself in tests. */
export interface MenuSearch {
  rank(q: string, names: readonly string[], limit: number): Promise<Ranked[]>;
  query(collection: string, q: string, ctx?: SearchContext): Promise<string[]>;
}

/** The engine's answers for one query. */
export interface MenuRanking {
  query: string;
  /** Rows of the kinds' names in both languages, best first. */
  kinds: Ranked[];
  /** The kind named before «:», as an index into `KINDS`. */
  head: number | null;
  /** Rows of the templates' names, best first. */
  templates: Ranked[];
  /** Ids of the canvas's nodes (collection `net`), best first. */
  nodes: string[];
}

const MAX_ROWS = 12;

/** A kind's names in both languages: «доска: …» works whatever the UI language is (☑ Q-06-20). */
const KIND_NAMES: { at: number; name: string }[] = KINDS.flatMap((k, at) => [
  { at, name: t('ru', k.key) },
  { at, name: t('en', k.key) },
]);
const NAMES = KIND_NAMES.map((k) => k.name);

/** The engine's ranking of a query for the menu: kinds, templates, the canvas's nodes. */
export async function rankMenu(
  search: MenuSearch,
  query: string,
  templates: readonly MenuNode[],
): Promise<MenuRanking> {
  const q = query.trim();
  const colon = q.indexOf(':');
  const head = colon > 0 ? q.slice(0, colon) : '';
  const names = templates.map((n) => n.name);
  const [kinds, heads, tpls, nodes] = await Promise.all([
    search.rank(q, NAMES, NAMES.length),
    head ? search.rank(head, NAMES, 1) : Promise.resolve([]),
    search.rank(q, names, MAX_ROWS),
    search.query('net', q, { limit: MAX_ROWS }),
  ]);
  const top = heads[0];
  return {
    query,
    kinds,
    head: top ? (KIND_NAMES[top.index]?.at ?? null) : null,
    templates: tpls,
    nodes,
  };
}

function createItem(locale: Locale, k: KindEntry, name: string | null, group: Group): MenuItem {
  const label = t(locale, k.key);
  return {
    id: `${group}:${k.key}:${name ?? ''}`,
    group,
    label: name ? `${label}: ${name}` : label,
    detail: '',
    kind: k.kind,
    choice: {
      t: 'create',
      kind: k.kind,
      name: name ?? label,
      rename: name === null,
    },
  };
}

/** A template's row: choosing it makes its copy (05 §7). */
function templateItem(locale: Locale, n: MenuNode): MenuItem {
  return {
    id: `template:${n.id}`,
    group: 'templates',
    label: n.name,
    detail: t(locale, `kind.${n.kind}` as const),
    kind: n.kind,
    choice: { t: 'template', id: n.id, kind: n.kind, name: n.name },
  };
}

/**
 * The menu's rows for `query`. A query asks the engine first: with no
 * `ranking` for it there are no rows yet.
 */
export function menuItems(
  locale: Locale,
  query: string,
  nodes: readonly MenuNode[],
  recent: readonly string[],
  templates: readonly MenuNode[] = [],
  ranking: MenuRanking | null = null,
): MenuItem[] {
  const q = query.trim();
  if (q === '') {
    // Recent choices the kinds below do not show already: none while every
    // recent choice is a kind (review 2026-10-24: «Недавние» repeated them all).
    // The kinds keep their order, so a key finds the same row every time.
    const recentItems = recent
      .filter((key) => !KINDS.some((k) => k.key === key))
      .flatMap((key) => KINDS.filter((k) => k.key === key))
      .map((k) => createItem(locale, k, null, 'recent'));
    // The templates by name, so the same template keeps its row.
    const ours = [...templates]
      .sort((a, b) => a.name.localeCompare(b.name, locale))
      .map((n) => templateItem(locale, n));
    return [
      ...recentItems,
      ...KINDS.map((k) => createItem(locale, k, null, 'kinds')),
      ...ours,
    ].slice(0, MAX_ROWS);
  }
  if (!ranking || ranking.query.trim() !== q) return [];
  // «вид: имя» creates that kind with that name.
  const colon = q.indexOf(':');
  if (colon > 0) {
    const name = q.slice(colon + 1).trim();
    const k = ranking.head === null ? undefined : KINDS[ranking.head];
    if (k && name !== '') return [createItem(locale, k, name, 'create')];
  }
  // A query that names a kind or a template asks for it, not for a note so named.
  const exact = [...ranking.kinds, ...ranking.templates].some((r) => r.score >= 1000);
  const create: MenuItem[] = exact
    ? []
    : [
        {
          id: `create:note:${q}`,
          group: 'create',
          label: t(locale, 'menu.noteNamed', { q }),
          detail: '',
          kind: 'note',
          choice: { t: 'create', kind: 'note', name: q, rename: false },
        },
      ];
  const seen = new Set<number>();
  for (const r of ranking.kinds) {
    const at = KIND_NAMES[r.index]?.at;
    const k = at === undefined ? undefined : KINDS[at];
    if (at === undefined || !k || seen.has(at)) continue;
    seen.add(at);
    create.push(createItem(locale, k, null, 'create'));
  }
  const ours = ranking.templates.flatMap((r) => {
    const n = templates[r.index];
    return n ? [templateItem(locale, n)] : [];
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const insert = ranking.nodes.flatMap((id): MenuItem[] => {
    const n = byId.get(id);
    if (!n) return [];
    return [
      {
        id: `insert:${n.id}`,
        group: 'insert',
        label: n.name,
        detail: t(locale, `kind.${n.kind}` as const),
        kind: n.kind,
        choice: { t: 'existing', id: n.id },
      },
    ];
  });
  return [...create, ...ours, ...insert].slice(0, MAX_ROWS);
}

/** Recent choices, the last 8, kept on this device (06 §5.2). */
export function remember(recent: readonly string[], choice: MenuItem): string[] {
  if (choice.choice.t !== 'create') return [...recent];
  const key = choice.id.split(':')[1] ?? '';
  if (!KINDS.some((k) => k.key === key)) return [...recent];
  return [key, ...recent.filter((k) => k !== key)].slice(0, 8);
}
