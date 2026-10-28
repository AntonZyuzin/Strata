import { describe, expect, it } from 'vitest';
import { pathLabel } from './paths';

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
