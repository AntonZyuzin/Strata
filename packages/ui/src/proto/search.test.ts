import { describe, expect, it } from 'vitest';
import { CLASSES, menuItems } from './menu';
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

  it('offers kinds and classes for an empty query', () => {
    const items = menuItems('ru', '', nodes, []);
    expect(items.map((i) => i.label)).toEqual([
      'Сеть',
      'Заметка',
      'Доска',
      'Список',
      'Медиа',
      'Задача',
      'Проект',
      'Референсы',
      'Чек-лист',
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
      cls: null,
      name: 'Мудборд',
      rename: false,
    });
    const [en] = menuItems('ru', 'task: Fix', nodes, []);
    expect(en?.choice).toMatchObject({ kind: 'network', cls: 'task', name: 'Fix' });
  });

  it('does not offer «Заметка «доска»» when the query names a kind', () => {
    const items = menuItems('ru', 'доска', nodes, []);
    expect(items[0]?.choice).toMatchObject({ t: 'create', kind: 'board', rename: true });
  });
});

describe('classes of the Tab menu (05 §4.3)', () => {
  it('builds a task and a project on networks, references on a board, a checklist on a list', () => {
    const kindOf = Object.fromEntries(CLASSES.map((c) => [c.cls, c.kind]));
    expect(kindOf).toEqual({
      task: 'network',
      project: 'network',
      references: 'board',
      checklist: 'checklist',
    });
  });
});
