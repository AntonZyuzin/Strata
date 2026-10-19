import { describe, expect, it } from 'vitest';
import { detectLocale, pluralIndex, t } from './index';

describe('i18n', () => {
  it('uses Russian plural rules', () => {
    expect([1, 2, 5, 11, 21, 22, 25, 111].map((n) => pluralIndex('ru', n))).toEqual([
      0, 1, 2, 2, 0, 1, 2, 2,
    ]);
    expect(t('ru', 'nodes.count', { n: 21 })).toBe('21 нода');
    expect(t('ru', 'nodes.count', { n: 3 })).toBe('3 ноды');
    expect(t('ru', 'nodes.count', { n: 12 })).toBe('12 нод');
  });

  it('uses English plural rules', () => {
    expect(t('en', 'nodes.count', { n: 1 })).toBe('1 node');
    expect(t('en', 'nodes.count', { n: 7 })).toBe('7 nodes');
  });

  it('detects the locale from system languages', () => {
    expect(detectLocale(['ru-RU', 'en-US'])).toBe('ru');
    expect(detectLocale(['en-GB'])).toBe('en');
    expect(detectLocale([])).toBe('en');
  });
});
