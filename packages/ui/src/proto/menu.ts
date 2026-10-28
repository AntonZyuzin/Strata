import type { NodeKind } from '@strata/backend';
import type { MenuChoice } from '@strata/canvas';
import { type Locale, type MessageKey, t } from '@strata/i18n';
import { norm, rank, score } from './search';

/**
 * Items of the Tab menu (06 §5.2): with an empty query — the kinds, and
 * recent choices that are not among them; with a query — «Создать» (a note named by the query first, then
 * matching kinds), «Вставить здесь» (nodes of this network) and «Разместить
 * здесь» (nodes of other networks: an appearance, 05 §5). ADR-0010: no classes.
 */

export interface Template {
  kind: NodeKind;
  key: MessageKey;
}

export const KINDS: Template[] = [
  { kind: 'network', key: 'kind.network' },
  { kind: 'project', key: 'kind.project' },
  { kind: 'task', key: 'kind.task' },
  { kind: 'note', key: 'kind.note' },
  { kind: 'board', key: 'kind.board' },
  { kind: 'checklist', key: 'kind.checklist' },
  { kind: 'asset', key: 'kind.asset' },
];

const TEMPLATES = KINDS;

export type Group = 'recent' | 'kinds' | 'create' | 'insert' | 'place';

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

const MAX_ROWS = 12;

/** Name of a template in both languages: «доска: …» works whatever the UI language is (☑ Q-06-20). */
const namesOf = (tpl: Template): string[] => [t('ru', tpl.key), t('en', tpl.key)];

function createItem(locale: Locale, tpl: Template, name: string | null, group: Group): MenuItem {
  const label = t(locale, tpl.key);
  return {
    id: `${group}:${tpl.key}:${name ?? ''}`,
    group,
    label: name ? `${label}: ${name}` : label,
    detail: '',
    kind: tpl.kind,
    choice: {
      t: 'create',
      kind: tpl.kind,
      name: name ?? label,
      rename: name === null,
    },
  };
}

export function menuItems(
  locale: Locale,
  query: string,
  nodes: readonly MenuNode[],
  recent: readonly string[],
  elsewhere: readonly MenuNode[] = [],
): MenuItem[] {
  const q = query.trim();
  if (q === '') {
    // Recent choices the kinds below do not show already: none while every
    // template is a kind (review 2026-10-24: «Недавние» repeated them all).
    // The kinds keep their order, so a key finds the same row every time.
    const recentItems = recent
      .filter((key) => !KINDS.some((k) => k.key === key))
      .map((key) => TEMPLATES.find((tpl) => tpl.key === key))
      .filter((tpl): tpl is Template => !!tpl)
      .map((tpl) => createItem(locale, tpl, null, 'recent'));
    return [...recentItems, ...KINDS.map((tpl) => createItem(locale, tpl, null, 'kinds'))].slice(
      0,
      MAX_ROWS,
    );
  }
  // «вид: имя» creates that kind with that name.
  const colon = q.indexOf(':');
  if (colon > 0) {
    const head = q.slice(0, colon);
    const name = q.slice(colon + 1).trim();
    const tpl = TEMPLATES.map((x) => ({
      x,
      s: Math.max(...namesOf(x).map((n) => score(head, n) ?? -1)),
    }))
      .filter((r) => r.s >= 0)
      .sort((a, b) => b.s - a.s)[0]?.x;
    if (tpl && name !== '') return [createItem(locale, tpl, name, 'create')];
  }
  const exact = TEMPLATES.some((tpl) => namesOf(tpl).some((n) => norm(n) === norm(q)));
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
  const templates = rank(
    q,
    TEMPLATES.flatMap((tpl) => namesOf(tpl).map((n) => ({ tpl, n }))),
    (x) => x.n,
    TEMPLATES.length * 2,
  );
  const seen = new Set<string>();
  for (const { tpl } of templates) {
    if (seen.has(tpl.key)) continue;
    seen.add(tpl.key);
    create.push(createItem(locale, tpl, null, 'create'));
  }
  const insert = rank(q, nodes, (n) => n.name, MAX_ROWS).map(
    (n): MenuItem => ({
      id: `insert:${n.id}`,
      group: 'insert',
      label: n.name,
      detail: t(locale, `kind.${n.kind}` as const),
      kind: n.kind,
      choice: { t: 'existing', id: n.id },
    }),
  );
  const place = rank(q, elsewhere, (n) => n.name, MAX_ROWS).map(
    (n): MenuItem => ({
      id: `place:${n.id}`,
      group: 'place',
      label: n.name,
      detail: t(locale, `kind.${n.kind}` as const),
      kind: n.kind,
      choice: { t: 'place', id: n.id, kind: n.kind },
    }),
  );
  return [...create, ...insert, ...place].slice(0, MAX_ROWS);
}

/** Recent choices, the last 8, kept on this device (06 §5.2). */
export function remember(recent: readonly string[], choice: MenuItem): string[] {
  if (choice.choice.t !== 'create') return [...recent];
  const key = choice.id.split(':')[1] ?? '';
  if (!TEMPLATES.some((tpl) => tpl.key === key)) return [...recent];
  return [key, ...recent.filter((k) => k !== key)].slice(0, 8);
}
