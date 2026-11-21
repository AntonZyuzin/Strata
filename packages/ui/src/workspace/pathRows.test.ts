import type { PathHit, Resolved, TreeItem } from '@strata/backend';
import { describe, expect, it } from 'vitest';
import { completePath, missingSpan, pathInto, pathQuery, pathRows } from './pathRows';

const hit = (path: [string, string][], kind: PathHit['kind'], primary = true): PathHit => ({
  path,
  kind,
  primary,
});

describe('the path mode of the search windows (09 §4.4, ☑ Q-06-26)', () => {
  it('takes a query that starts with /, ./ or ../ for a path', () => {
    for (const q of ['/', '/Игра', './Аудио', '../', '..', '.', '  /Игра']) {
      expect(pathQuery(q), q).toBe(true);
    }
    for (const q of ['', 'Игра', 'Игра/Аудио', '.Игра', '...']) {
      expect(pathQuery(q), q).toBe(false);
    }
  });

  it('lists what lies in the network a path ending in / names, by name', () => {
    const answer: Resolved = {
      found: [
        hit(
          [
            ['r', 'Пространство'],
            ['g', 'Игра'],
          ],
          'network',
        ),
      ],
    };
    const tree: TreeItem[] = [
      { id: 'r', name: 'Пространство', kind: 'network' },
      { id: 'g', name: 'Игра', kind: 'network', parent: 'r' },
      { id: 'b', name: 'Боёвка', kind: 'note', parent: 'g' },
      { id: 'a', name: 'Арт', kind: 'board', parent: 'g' },
      { id: 'x', name: 'Звук', kind: 'network', parent: 'r' },
      { id: 'e', name: 'Эхо', kind: 'note', parent: 'x', appears: ['g'] },
    ];
    expect(pathInto('/Игра/', answer)).toBe(answer.found[0]);
    // Without the slash the path names the network itself.
    expect(pathInto('/Игра', answer)).toBeNull();
    const rows = pathRows('/Игра/', answer, tree, 'ru', 12);
    expect(rows.map((r) => [r.name, r.path, r.hit.primary])).toEqual([
      ['Арт', 'Игра', true],
      ['Боёвка', 'Игра', true],
      // An appearance (05 §5): the way goes through this network all the same.
      ['Эхо', 'Игра', false],
    ]);
    expect(rows[2]?.hit.path.map(([id]) => id)).toEqual(['r', 'g', 'e']);
  });

  it('offers the names nearest to the segment that named nothing', () => {
    const near = hit(
      [
        ['r', 'Пространство'],
        ['g', 'Игра'],
        ['a', 'Аудио'],
      ],
      'network',
    );
    const answer: Resolved = { found: [], missing: { at: 1, near: [near] } };
    expect(pathRows('/Игра/Ауд', answer, [], 'ru', 12).map((r) => [r.name, r.path])).toEqual([
      ['Аудио', 'Игра'],
    ]);
    expect(missingSpan('/Игра/Ауд', answer)).toEqual({ start: 6, end: 9 });
  });

  it('puts a name in the segment that named nothing, / after a network (09 §4.4)', () => {
    const answer: Resolved = { found: [], missing: { at: 1, near: [] } };
    const audio = { name: 'Аудио', kind: 'network' as const };
    expect(completePath('/Игра/Ауд', answer, audio, true)).toBe('/Игра/Аудио/');
    expect(completePath('/Игра/Ауд', answer, audio, false)).toBe('/Игра/Аудио');
    // A name with a slash is escaped (09 §4.2); no slash after a note.
    expect(completePath('/Игра/Ауд', answer, { name: 'A/B', kind: 'note' }, true)).toBe(
      '/Игра/A\\/B',
    );
    // `.` and `..` name where one goes, not a name to put there.
    const root: Resolved = { found: [hit([['r', 'Пространство']], 'network')] };
    expect(completePath('..', root, audio, true)).toBe('../');
    // A network named alone, with `/` after it: the name goes after the slash.
    const game: Resolved = {
      found: [
        hit(
          [
            ['r', 'Пространство'],
            ['g', 'Игра'],
          ],
          'network',
        ),
      ],
    };
    expect(completePath('/Игра/', game, audio, true)).toBe('/Игра/Аудио/');
    // A path that names nothing yet has no place for a name.
    expect(completePath('/', { found: [] }, audio, true)).toBeNull();
  });
});
