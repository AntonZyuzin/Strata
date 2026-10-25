import { describe, expect, it } from 'vitest';
import { KINDS, menuItems } from './menu';
import { norm, rank, score, stage, switchLayout } from './search';

describe('Tab menu search (09 §2, temporary TS engine)', () => {
  it('normalizes case, ё and separators, keeping й', () => {
    expect(norm('Ёлка_Новый-Год')).toBe('елка новый год');
    expect(norm('Café  «Йод»')).toBe('cafe йод');
  });

  it('ranks the stages of 09 §2.3', () => {
    expect(stage('сцена', 'сцена')).toBe(1000);
    expect(stage('сце', 'сцена 12')).toBe(800);
    expect(stage('дд', 'дизайн документ')).toBe(700);
    expect(stage('диз док', 'дизайн документ')).toBe(600);
    expect(stage('док диз', 'дизайн документ')).toBe(500);
    expect(stage('ена', 'сцена')).toBe(400);
    expect(stage('шейдр', 'шейдер')).toBe(200);
    expect(stage('ц', 'сцена')).toBeNull();
  });

  it('fixes the keyboard layout, a little lower', () => {
    expect(switchLayout('ljcrf')).toBe('доска');
    expect(score('ljcrf', 'Доска')).toBe(980);
  });

  it('puts better stages and shorter names first', () => {
    const names = ['Шейдер воды', 'Шейдер', 'Сцена с шейдером'];
    expect(rank('шейдер', names, (n) => n, 3)).toEqual([
      'Шейдер',
      'Шейдер воды',
      'Сцена с шейдером',
    ]);
  });
});

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

  it('puts a note named by the query first, then existing nodes', () => {
    const items = menuItems('ru', 'звук', nodes, []);
    expect(items[0]?.label).toBe('Заметка «звук»');
    expect(items.filter((i) => i.group === 'insert').map((i) => i.label)).toEqual([
      'Звук 3',
      'Звуковой дизайн',
    ]);
  });

  it('creates a kind with a name through «вид: имя» in either language', () => {
    const [ru] = menuItems('en', 'доска: Мудборд', nodes, []);
    expect(ru?.choice).toEqual({
      t: 'create',
      kind: 'board',
      name: 'Мудборд',
      rename: false,
    });
    const [en] = menuItems('ru', 'task: Fix', nodes, []);
    expect(en?.choice).toMatchObject({ kind: 'task', name: 'Fix' });
  });

  it('offers the templates after the kinds, and by a query (05 §7)', () => {
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
    const [first] = menuItems('ru', 'баг', nodes, [], tpls);
    expect(first?.choice).toEqual({ t: 'template', id: 't1', kind: 'project', name: 'Баг' });
    expect(menuItems('ru', 'рел', nodes, [], tpls).map((i) => i.group)).toEqual([
      'create',
      'templates',
    ]);
  });

  it('does not offer «Заметка «доска»» when the query names a kind', () => {
    const items = menuItems('ru', 'доска', nodes, []);
    expect(items[0]?.choice).toMatchObject({ t: 'create', kind: 'board', rename: true });
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
