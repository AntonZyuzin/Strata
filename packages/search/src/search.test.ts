import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadSearch, NameIndex, norm, rankByName } from './index';

beforeAll(async () => {
  await loadSearch(readFileSync(new URL('../pkg/strata_search_bg.wasm', import.meta.url)));
});

const items = [
  { id: 'root', name: 'Корень', kind: 'network' },
  { id: 'game', name: 'Игра', kind: 'project', parent: 'root' },
  { id: 'fight', name: 'Боёвка', kind: 'task', parent: 'game', flags: ['key'] },
  { id: 'anim', name: 'Анимации удара', kind: 'task', parent: 'game', flags: ['pause'] },
  { id: 'shader', name: 'Шейдер', kind: 'note', parent: 'root' },
  { id: 'water', name: 'Шейдер воды', kind: 'note', parent: 'game' },
  { id: 'shader2', name: 'Шейдер', kind: 'board', parent: 'game' },
];

describe('strata-search in WASM (09 §2)', () => {
  it('normalizes as 09 §2.2 says', () => {
    expect(norm('Ёлка_Новый-Год')).toBe('елка новый год');
    expect(norm('PointWrangle2')).toBe('point wrangle 2');
  });

  it('ranks names by stage, closeness and length; the other layout too', () => {
    const ix = new NameIndex(items);
    expect(ix.query('шейдер')).toEqual(['shader', 'shader2', 'water']);
    // Placed in the network on the canvas: +80; in its parent: +50.
    expect(ix.query('шейдер', { here: 'game' })).toEqual(['shader2', 'shader', 'water']);
    expect(ix.query(',jtdrf')).toEqual(['fight']);
    expect(ix.query('шейдер', { scope: { t: 'in', net: 'game' } })).toEqual(['shader2', 'water']);
    ix.free();
  });

  it('finds by Houdini Find in a network (09 §3.3)', () => {
    const ix = new NameIndex(items);
    expect(ix.find('@задача -+пауза', false, { t: 'in', net: 'game' }).ids).toEqual(['fight']);
    const f = ix.find('уда* @аня', false, { t: 'under', net: 'root' });
    expect(f).toEqual({ ids: [], unknown: ['@аня'], text: 'уда' });
    expect(ix.find('*удара', false, { t: 'all' }).ids).toEqual(['anim']);
    ix.free();
  });

  it('ranks a short list by name alone', () => {
    expect(rankByName('ljcrf', ['Папка', 'Доска', 'Задача'], 3)).toEqual([
      { index: 1, score: 980 },
    ]);
    expect(rankByName('задача', ['Папка', 'Доска', 'Задача'], 3)).toEqual([
      { index: 2, score: 1000 },
    ]);
  });
});
