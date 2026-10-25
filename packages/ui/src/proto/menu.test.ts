import { readFileSync } from 'node:fs';
import { loadSearch, NameIndex, rankByName } from '@strata/search';
import { beforeAll, describe, expect, it } from 'vitest';
import { KINDS, type MenuNode, type MenuSearch, menuItems, rankMenu } from './menu';

beforeAll(async () => {
  const wasm = new URL('../../../search/pkg/strata_search_bg.wasm', import.meta.url);
  await loadSearch(readFileSync(wasm));
});

/** The engine as the worker answers, here on the test's thread; `net` — the canvas's nodes. */
function engine(nodes: readonly MenuNode[]): MenuSearch {
  const net = new NameIndex(nodes.map((n) => ({ ...n, parent: 'net' })));
  return {
    rank: async (q, names, limit) => rankByName(q, names, limit),
    query: async (_collection, q, ctx) => net.query(q, ctx),
  };
}

/** The rows for a query, after the engine's answer. */
async function rows(
  query: string,
  nodes: readonly MenuNode[],
  templates: readonly MenuNode[] = [],
  locale: 'ru' | 'en' = 'ru',
) {
  const ranking = await rankMenu(engine(nodes), query, templates);
  return menuItems(locale, query, nodes, [], templates, ranking);
}

describe('Tab menu items (06 §5.2)', () => {
  const nodes = [
    { id: 'a', name: 'Звук 3', kind: 'note' as const },
    { id: 'b', name: 'Звуковой дизайн', kind: 'network' as const },
  ];

  it('offers the kinds for an empty query (ADR-0010)', () => {
    const items = menuItems('ru', '', nodes, []);
    expect(items.map((i) => i.label)).toEqual([
      'Папка',
      'Проект',
      'Задача',
      'Заметка',
      'Доска',
      'Список',
      'Ассет',
    ]);
  });

  it('puts a note named by the query first, then existing nodes', async () => {
    const items = await rows('звук', nodes);
    expect(items[0]?.label).toBe('Заметка «звук»');
    expect(items.filter((i) => i.group === 'insert').map((i) => i.label)).toEqual([
      'Звук 3',
      'Звуковой дизайн',
    ]);
  });

  it('creates a kind with a name through «вид: имя» in either language', async () => {
    const [ru] = await rows('доска: Мудборд', nodes, [], 'en');
    expect(ru?.choice).toEqual({
      t: 'create',
      kind: 'board',
      name: 'Мудборд',
      rename: false,
    });
    const [en] = await rows('task: Fix', nodes);
    expect(en?.choice).toMatchObject({ kind: 'task', name: 'Fix' });
  });

  it('offers the templates after the kinds, and by a query (05 §7)', async () => {
    const tpls = [
      { id: 't2', name: 'Релиз', kind: 'network' as const },
      { id: 't1', name: 'Баг', kind: 'project' as const },
    ];
    const items = menuItems('ru', '', nodes, [], tpls);
    expect(items.filter((i) => i.group === 'templates').map((i) => i.label)).toEqual([
      'Баг',
      'Релиз',
    ]);
    expect(items.at(-2)).toMatchObject({
      detail: 'Проект',
      choice: { t: 'template', id: 't1', kind: 'project', name: 'Баг' },
    });
    // A query that names a template asks for it, not for a note so named.
    const [first] = await rows('баг', nodes, tpls);
    expect(first?.choice).toEqual({ t: 'template', id: 't1', kind: 'project', name: 'Баг' });
    expect((await rows('рел', nodes, tpls)).map((i) => i.group)).toEqual(['create', 'templates']);
  });

  it('does not offer «Заметка «доска»» when the query names a kind', async () => {
    const items = await rows('доска', nodes);
    expect(items[0]?.choice).toMatchObject({ t: 'create', kind: 'board', rename: true });
  });

  it('has no rows for a query the engine has not answered yet', () => {
    expect(menuItems('ru', 'звук', nodes, [])).toEqual([]);
  });

  it('finds a kind typed in the other layout, a little lower (09 §2.4)', async () => {
    const items = await rows('ljcrf', nodes);
    expect(items.find((i) => i.choice.t === 'create' && i.choice.kind === 'board')).toBeTruthy();
  });
});

describe('kinds of the Tab menu (05 §4.2, ADR-0010)', () => {
  it('offers the seven kinds, the folder first', () => {
    expect(KINDS.map((k) => k.kind)).toEqual([
      'network',
      'project',
      'task',
      'note',
      'board',
      'checklist',
      'asset',
    ]);
  });
});
