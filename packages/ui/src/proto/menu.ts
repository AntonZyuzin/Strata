import type { NodeKind } from '@strata/backend';
import type { MenuChoice } from '@strata/canvas';
import { type Locale, type MessageKey, t } from '@strata/i18n';
import type { Ranked, SearchContext } from '@strata/search';

/**
 * Items of the Tab menu (06 §5.2): with an empty query — the kinds, and
 * recent choices that are not among them, then «Шаблоны» (nodes with the
 * flag, 05 §7); with a query — «Создать» (a note named by the query first, then
 * matching kinds), the matching templates, «Призраки» (this network's
 * `[[links]]` to no node, 05 §8.5; 09 §3.1) and «Ноды» (existing nodes).
 * Opened from a ghost with Shift (06 §14) — the kinds for its name. Opened
 * by `Ctrl+O` (☑ Q-06-26, «Найти или создать») — «Ноды» first, «В корзине»
 * after them, then «Создать»; with no query, the nodes visited last, or the
 * kinds while there is none. ADR-0010: no classes. The ranking is the search
 * engine's (09 §2, `@strata/search` in its worker): `rankMenu` asks it,
 * `menuItems` lays out what it answered.
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

export type Group =
  | 'recent'
  | 'visited'
  | 'kinds'
  | 'create'
  | 'templates'
  | 'ghosts'
  | 'insert'
  | 'trash'
  | 'path';

/**
 * What a row does: the canvas's choice (06 §5.3), or the window's own — a
 * node back from the trash and gone to (☑ Q-06-26).
 */
export type MenuPick = MenuChoice | { t: 'restore'; id: string };

export interface MenuItem {
  id: string;
  group: Group;
  label: string;
  /** Muted text on the right: where an existing node lies, «уже здесь». */
  detail: string;
  kind: NodeKind;
  choice: MenuPick;
}

/** The rows only «Найти или создать» has (☑ Q-06-26), as the window was opened by `Ctrl+O`. */
export interface FindRows {
  /** The nodes visited last, last first (09 §3.4): the rows with no query. */
  visited: readonly MenuNode[];
  /** The trash (05 §11): a row brings its node back. */
  trash: readonly MenuNode[];
}

export interface MenuNode {
  id: string;
  name: string;
  kind: NodeKind;
  /** The network it lies in, by name: where an appearance would come from (05 §5). */
  where?: string;
}

/** A ghost of the network (05 §8.5): its name and the note it is in. */
export interface MenuGhost {
  id: string;
  name: string;
  /** The name of the note whose `[[link]]` it is. */
  from: string;
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
  /** Rows of the ghosts' names, best first. */
  ghosts: Ranked[];
  /**
   * Ids of existing nodes, best first: the workspace's (collection
   * `space`), then the canvas's not yet in it (`net`).
   */
  nodes: string[];
  /** Rows of the trash's names, best first, three at most (09 §3.4). */
  trash: Ranked[];
}

const MAX_ROWS = 12;
/** The trash's rows in «Найти или создать», at most (09 §3.4). */
const TRASH_ROWS = 3;
/** The nodes visited last that «Найти или создать» shows with no query (09 §3.4). */
export const VISITED_ROWS = 10;

/** A kind's names in both languages: «доска: …» works whatever the UI language is (☑ Q-06-20). */
const KIND_NAMES: { at: number; name: string }[] = KINDS.flatMap((k, at) => [
  { at, name: t('ru', k.key) },
  { at, name: t('en', k.key) },
]);
const NAMES = KIND_NAMES.map((k) => k.name);

/** What else the ranking takes: the trash (`Ctrl+O`), closeness and visits (09 §2.5). */
export interface MenuRankOptions {
  /** The trash's nodes, «Найти или создать» only (☑ Q-06-26). */
  trash?: readonly MenuNode[] | undefined;
  /** The network on the canvas and this device's visits: the workspace's nodes by them. */
  context?: SearchContext | undefined;
}

/** The engine's ranking of a query for the menu: kinds, templates, the canvas's nodes. */
export async function rankMenu(
  search: MenuSearch,
  query: string,
  templates: readonly MenuNode[],
  ghosts: readonly MenuGhost[] = [],
  { trash = [], context = {} }: MenuRankOptions = {},
): Promise<MenuRanking> {
  const q = query.trim();
  const colon = q.indexOf(':');
  const head = colon > 0 ? q.slice(0, colon) : '';
  const names = templates.map((n) => n.name);
  const [kinds, heads, tpls, ghostRows, net, space, gone] = await Promise.all([
    search.rank(q, NAMES, NAMES.length),
    head ? search.rank(head, NAMES, 1) : Promise.resolve([]),
    search.rank(q, names, MAX_ROWS),
    ghosts.length > 0
      ? search.rank(
          q,
          ghosts.map((g) => g.name),
          MAX_ROWS,
        )
      : Promise.resolve([]),
    search.query('net', q, { limit: MAX_ROWS }),
    search.query('space', q, { ...context, limit: MAX_ROWS }),
    trash.length > 0
      ? search.rank(
          q,
          trash.map((n) => n.name),
          TRASH_ROWS,
        )
      : Promise.resolve([]),
  ]);
  const top = heads[0];
  return {
    query,
    kinds,
    head: top ? (KIND_NAMES[top.index]?.at ?? null) : null,
    templates: tpls,
    ghosts: ghostRows,
    // A node just made is on the canvas before the workspace's index has it.
    nodes: [...space, ...net.filter((id) => !space.includes(id))],
    trash: gone,
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
 * `ranking` for it there are no rows yet. `named` — a ghost's name: with no
 * query, the kinds for a node of that name (06 §14).
 */
export function menuItems(
  locale: Locale,
  query: string,
  nodes: readonly MenuNode[],
  recent: readonly string[],
  templates: readonly MenuNode[] = [],
  ranking: MenuRanking | null = null,
  ghosts: readonly MenuGhost[] = [],
  named: string | null = null,
  /** The workspace's other nodes: placed here, or gone to (05 §5, ☑ Q-06-26). */
  space: readonly MenuNode[] = [],
  /** Opened by `Ctrl+O`: the nodes first (☑ Q-06-26). */
  find: FindRows | null = null,
): MenuItem[] {
  const q = query.trim();
  if (q === '' && named !== null) {
    return KINDS.map((k) => createItem(locale, k, named, 'create'));
  }
  if (q === '' && find && find.visited.length > 0) {
    // The nodes visited last (09 §3.4); below, the kinds while there are none.
    const here = new Set(nodes.map((n) => n.id));
    return find.visited.slice(0, VISITED_ROWS).map((n) => nodeItem(locale, n, here, 'visited'));
  }
  if (q === '' && find) return KINDS.map((k) => createItem(locale, k, null, 'kinds'));
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
  // A query that names a kind, a template or a ghost asks for it, not for a
  // note so named.
  const exact = [...ranking.kinds, ...ranking.templates, ...ranking.ghosts].some(
    (r) => r.score >= 1000,
  );
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
  const theirs = ranking.ghosts.flatMap((r): MenuItem[] => {
    const g = ghosts[r.index];
    if (!g) return [];
    return [
      {
        id: `ghost:${g.id}`,
        group: 'ghosts',
        label: g.name,
        detail: g.from,
        kind: 'note',
        choice: { t: 'ghost', id: g.id },
      },
    ];
  });
  // On this canvas — «уже здесь», a choice wires or frames it; elsewhere —
  // where it lies; a choice places it here wired, or goes to it (05 §5, ☑ Q-06-26).
  const here = new Set(nodes.map((n) => n.id));
  const byId = new Map([...space, ...nodes].map((n) => [n.id, n]));
  const insert = ranking.nodes.flatMap((id): MenuItem[] => {
    const n = byId.get(id);
    return n ? [nodeItem(locale, n, here, 'insert')] : [];
  });
  if (!find) return [...create, ...ours, ...theirs, ...insert].slice(0, MAX_ROWS);
  const gone = ranking.trash.flatMap((r): MenuItem[] => {
    const n = find.trash[r.index];
    if (!n) return [];
    return [
      {
        id: `trash:${n.id}`,
        group: 'trash',
        label: n.name,
        detail: '',
        kind: n.kind,
        choice: { t: 'restore', id: n.id },
      },
    ];
  });
  // `Ctrl+O`: what is there first, then what one would make of the query.
  return [...insert, ...gone, ...create, ...ours, ...theirs].slice(0, MAX_ROWS);
}

/** An existing node's row: «уже здесь» on this canvas, else where it lies. */
function nodeItem(
  locale: Locale,
  n: MenuNode,
  here: ReadonlySet<string>,
  group: 'insert' | 'visited',
): MenuItem {
  return {
    id: `${group}:${n.id}`,
    group,
    label: n.name,
    detail: here.has(n.id) ? t(locale, 'menu.here') : (n.where ?? ''),
    kind: n.kind,
    choice: { t: 'existing', id: n.id, kind: n.kind },
  };
}

/** Recent choices, the last 8, kept on this device (06 §5.2). */
export function remember(recent: readonly string[], choice: MenuItem): string[] {
  if (choice.choice.t !== 'create') return [...recent];
  const key = choice.id.split(':')[1] ?? '';
  if (!KINDS.some((k) => k.key === key)) return [...recent];
  return [key, ...recent.filter((k) => k !== key)].slice(0, 8);
}
