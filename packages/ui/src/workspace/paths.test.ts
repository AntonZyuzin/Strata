import type { TreeItem } from '@strata/backend';
import { describe, expect, it } from 'vitest';
import {
  appearsIn,
  childNetworks,
  entryHolds,
  escapeSegment,
  menuRows,
  pathLabel,
  pathText,
  RECENT_ROWS,
} from './paths';

describe('a network path in a row (09 §3.4)', () => {
  it('names the networks under the root, the root by its name', () => {
    expect(pathLabel([['r', 'Карта']])).toBe('Карта');
    expect(
      pathLabel([
        ['r', 'Карта'],
        ['a', 'Проекты'],
        ['b', 'Игра'],
      ]),
    ).toBe('Проекты / Игра');
    expect(pathLabel([])).toBe('');
  });
});

describe('the text of a path (09 §4.2, §4.6)', () => {
  it('is / and the names under the root, a slash and a backslash of a name escaped', () => {
    expect(pathText([['r', 'Корень']])).toBe('/');
    expect(
      pathText([
        ['r', 'Корень'],
        ['a', 'Проекты'],
        ['b', 'Игра'],
        ['c', 'Боёвка'],
      ]),
    ).toBe('/Проекты/Игра/Боёвка');
    // As the core reads it back (`parse_path`, crates/strata-core).
    expect(escapeSegment('Вход/выход')).toBe('Вход\\/выход');
    expect(escapeSegment('C:\\Temp')).toBe('C:\\\\Temp');
    expect(
      pathText([
        ['r', 'Корень'],
        ['a', 'A/B'],
      ]),
    ).toBe('/A\\/B');
  });
});

const item = (id: string, name: string, parent?: string, appears?: string[]): TreeItem => ({
  id,
  name,
  kind: 'network',
  ...(parent ? { parent } : {}),
  ...(appears ? { appears } : {}),
});

/** root ─ Проекты ─ Игра;  root ─ Фильм, where Игра appears too; a note in Проекты. */
const tree: TreeItem[] = [
  item('r', 'Корень'),
  item('p', 'Проекты', 'r'),
  item('f', 'Фильм', 'r'),
  item('g', 'Игра', 'p', ['f']),
  { id: 'n', name: 'Заметка', kind: 'note', parent: 'p' },
];
const byId = new Map(tree.map((i) => [i.id, i]));

describe('the networks under a network (09 §4.3)', () => {
  it('are those lying there by the primary placement or as appearances, networks only', () => {
    const kids = childNetworks(tree);
    expect(kids.get('r')?.map((i) => i.id)).toEqual(['p', 'f']);
    expect(kids.get('p')?.map((i) => i.id)).toEqual(['g']);
    expect(kids.get('f')?.map((i) => i.id)).toEqual(['g']);
    expect(kids.get('g')).toBeUndefined();
    expect(appearsIn(byId.get('g'), 'f')).toBe(true);
    expect(appearsIn(byId.get('g'), 'p')).toBe(false);
  });

  it('keep an entry path while each lies in the one before (05 §9.3)', () => {
    expect(entryHolds(['r', 'f', 'g'], byId)).toBe(true);
    expect(entryHolds(['r', 'p', 'g'], byId)).toBe(true);
    expect(entryHolds(['r', 'g'], byId)).toBe(false);
    expect(entryHolds(['p', 'g'], byId)).toBe(false);
    expect(entryHolds(['r', 'f', 'x'], byId)).toBe(false);
    expect(entryHolds([], byId)).toBe(false);
  });

  it('list the recently visited first, the latest on top, then the rest by name', () => {
    const items = ['Ж', 'Б', 'Е', 'А', 'Д', 'В', 'Г'].map((name, i) => item(`k${i}`, name, 'r'));
    const collator = new Intl.Collator('ru');
    expect(menuRows(items, {}, collator).rows.map((i) => i.name)).toEqual([
      'А',
      'Б',
      'В',
      'Г',
      'Д',
      'Е',
      'Ж',
    ]);
    const { rows, recent } = menuRows(items, { k0: { at: 1 }, k2: { at: 3 } }, collator);
    expect(recent).toBe(2);
    expect(rows.map((i) => i.name)).toEqual(['Е', 'Ж', 'А', 'Б', 'В', 'Г', 'Д']);
    const all = Object.fromEntries(items.map((i, at) => [i.id, { at }]));
    expect(menuRows(items, all, collator).recent).toBe(RECENT_ROWS);
  });
});
