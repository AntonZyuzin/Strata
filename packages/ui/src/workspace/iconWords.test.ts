import { ICON_WORDS, iconName, iconTerms } from '@strata/i18n';
import { describe, expect, it } from 'vitest';
import atlas from '../../../canvas/src/assets/game-icons.json';

describe('the words of the icon presets (07 §6.3, ☑ Q-07-21)', () => {
  const ids = atlas.icons.map((i) => i.id);

  it('every preset that ships has a name and words in both languages, and only those', () => {
    expect(Object.keys(ICON_WORDS).sort()).toEqual([...ids].sort());
    for (const id of ids) {
      const w = ICON_WORDS[id];
      expect(w?.ru.length, id).toBeGreaterThan(0);
      expect(w?.en.length, id).toBeGreaterThan(0);
      expect(
        w?.ru.every((s) => s.trim() === s && s !== ''),
        id,
      ).toBe(true);
      expect(
        w?.en.every((s) => s.trim() === s && s !== ''),
        id,
      ).toBe(true);
    }
  });

  it('names no two presets alike in one language: the palette tells them apart', () => {
    for (const locale of ['ru', 'en'] as const) {
      const names = ids.map((id) => iconName(locale, id).toLowerCase());
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it('finds a preset by its words in either language', () => {
    expect(iconTerms('lorc/compass')).toEqual(
      expect.arrayContaining(['Компас', 'проект', 'Compass', 'project']),
    );
    expect(iconName('ru', 'lorc/compass')).toBe('Компас');
    expect(iconName('en', 'lorc/compass')).toBe('Compass');
    expect(iconName('ru', 'nobody/unknown')).toBe('nobody/unknown');
  });
});
