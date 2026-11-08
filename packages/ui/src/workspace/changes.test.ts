import { type Locale, type MessageKey, t } from '@strata/i18n';
import { describe, expect, it } from 'vitest';
import { changeText } from './changes';

/** The labels the core writes its own changesets under (10 §9.1). */
const CORE_LABELS = [
  'core.change.create',
  'core.change.copy',
  'core.change.import',
  'core.change.links',
  'core.change.pinLink',
  'core.change.preview',
  'core.change.purge',
  'core.change.revert',
];

describe('a changeset in words (06 §1.2)', () => {
  it('a revert names what it took back, nested as deep as reverts go', () => {
    const renamed = { key: 'home.change.rename', params: { name: 'Игра' } };
    const revert = { key: 'core.change.revert', params: { of: renamed } };
    const again = { key: 'core.change.revert', params: { of: revert } };
    const ru = changeText('ru', renamed);
    expect(changeText('ru', revert)).toBe(`Откат: ${ru}`);
    expect(changeText('ru', again)).toBe(`Откат: Откат: ${ru}`);
    expect(changeText('en', revert)).toBe(`Revert: ${changeText('en', renamed)}`);
  });

  it('every label of the core is in both catalogs', () => {
    // A key a catalog lacks comes back as itself.
    for (const locale of ['ru', 'en'] as Locale[]) {
      for (const key of CORE_LABELS) {
        expect(t(locale, key as MessageKey, { name: 'x', link: 'x', path: 'x' }), locale).not.toBe(
          key,
        );
      }
    }
  });
});
