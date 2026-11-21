import { readFileSync } from 'node:fs';
import { loadSearch, NameIndex, rankByName } from '@strata/search';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  type FindRows,
  KINDS,
  type MenuNode,
  type MenuSearch,
  menuItems,
  rankMenu,
  VISITED_ROWS,
} from './menu';

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

  it("offers this network's ghosts by a query, and the kinds for a ghost's name (05 §8.5, 06 §14)", async () => {
    const ghosts = [
      { id: '?1', name: 'Звуковая карта', from: 'Заметка' },
      { id: '?2', name: 'Идея', from: 'Дневник' },
    ];
    const ranking = await rankMenu(engine(nodes), 'звуковая', [], ghosts);
    const items = menuItems('ru', 'звуковая', nodes, [], [], ranking, ghosts);
    const ghost = items.filter((i) => i.group === 'ghosts');
    expect(ghost.map((i) => [i.label, i.detail, i.choice])).toEqual([
      ['Звуковая карта', 'Заметка', { t: 'ghost', id: '?1' }],
    ]);
    expect(items.indexOf(ghost[0] as (typeof items)[number])).toBeLessThan(
      items.findIndex((i) => i.group === 'insert'),
    );
    // The query names a ghost: no second note of that name above it.
    const exact = await rankMenu(engine(nodes), 'Идея', [], ghosts);
    const rowsOf = menuItems('ru', 'Идея', nodes, [], [], exact, ghosts);
    expect(rowsOf.some((i) => i.group === 'create' && i.kind === 'note')).toBe(false);

    const named = menuItems('en', '', nodes, [], [], null, ghosts, 'Идея');
    expect(named.map((i) => i.label)).toEqual(
      ['Folder', 'Project', 'Task', 'Note', 'Board', 'List', 'Asset'].map((k) => `${k}: Идея`),
    );
    expect(
      named.every((i) => i.choice.t === 'create' && i.choice.name === 'Идея' && !i.choice.rename),
    ).toBe(true);
  });

  it('has no rows for a query the engine has not answered yet', () => {
    expect(menuItems('ru', 'звук', nodes, [])).toEqual([]);
  });

  it('finds a kind typed in the other layout, a little lower (09 §2.4)', async () => {
    const items = await rows('ljcrf', nodes);
    expect(items.find((i) => i.choice.t === 'create' && i.choice.kind === 'board')).toBeTruthy();
  });
});

describe('«Найти или создать» (☑ Q-06-26)', () => {
  // `a` lies on this canvas; `x` in another network.
  const nodes = [{ id: 'a', name: 'Звук 3', kind: 'note' as const }];
  const space: MenuNode[] = [
    { id: 'a', name: 'Звук 3', kind: 'note', where: 'Игра' },
    { id: 'x', name: 'Звуковой дизайн', kind: 'network', where: 'Игра / Аудио' },
  ];
  const find = (visited: MenuNode[] = [], trash: MenuNode[] = []): FindRows => ({
    visited,
    trash,
  });
  const empty = (rows: FindRows) => menuItems('ru', '', nodes, [], [], null, [], null, space, rows);

  it('shows the nodes visited last with no query, the kinds while there are none (09 §3.4)', () => {
    const more = Array.from({ length: 14 }, (_, i): MenuNode => {
      return { id: `v${i}`, name: `Нода ${i}`, kind: 'note', where: 'Игра' };
    });
    const items = empty(find([space[1] as MenuNode, space[0] as MenuNode, ...more]));
    expect(items).toHaveLength(VISITED_ROWS);
    expect(items[0]).toMatchObject({
      group: 'visited',
      label: 'Звуковой дизайн',
      detail: 'Игра / Аудио',
      choice: { t: 'existing', id: 'x', kind: 'network' },
    });
    // One on this canvas says so instead of where it lies.
    expect(items[1]).toMatchObject({ label: 'Звук 3', detail: 'уже здесь' });
    expect(empty(find()).map((i) => [i.group, i.kind])).toEqual(
      KINDS.map((k) => ['kinds', k.kind]),
    );
  });

  it('puts the nodes first, then the trash, then «Создать»', async () => {
    const trash: MenuNode[] = [{ id: 'g', name: 'Звуки старые', kind: 'note' }];
    const ranking = await rankMenu(engine(space), 'звук', [], [], { trash });
    const items = menuItems('ru', 'звук', nodes, [], [], ranking, [], null, space, find([], trash));
    const groups = items.map((i) => i.group);
    expect(groups.slice(0, 3)).toEqual(['insert', 'insert', 'trash']);
    expect(groups.slice(3).every((g) => g === 'create')).toBe(true);
    expect(items[2]).toMatchObject({ label: 'Звуки старые', choice: { t: 'restore', id: 'g' } });
    expect(items[3]?.label).toBe('Заметка «звук»');
    // The Tab menu keeps «Создать» first and has no trash.
    const tab = menuItems('ru', 'звук', nodes, [], [], ranking, [], null, space);
    expect(tab[0]?.group).toBe('create');
    expect(tab.some((i) => i.group === 'trash')).toBe(false);
  });

  it("ranks the workspace's nodes by the network on the canvas and the visits (09 §2.5)", async () => {
    const asked: [string, unknown][] = [];
    const search: MenuSearch = {
      rank: async (q, names, limit) => rankByName(q, names, limit),
      query: async (collection, _q, ctx) => {
        asked.push([collection, ctx]);
        return [];
      },
    };
    const visits = { a: { at: 1, count: 2 } };
    await rankMenu(search, 'звук', [], [], { context: { here: 'n1', visits, now: 5 } });
    expect(asked).toContainEqual(['space', { here: 'n1', visits, now: 5, limit: 12 }]);
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
