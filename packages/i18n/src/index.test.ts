import { describe, expect, it } from 'vitest';
import { detectLocale, formatNumber, pluralIndex, t } from './index';

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

  it('formats numbers in the locale notation', () => {
    expect(formatNumber('ru', 0.025, 3)).toBe('0,025');
    expect(formatNumber('en', 0.025, 3)).toBe('0.025');
    expect(formatNumber('ru', 58.34)).toBe('58,3');
    expect(formatNumber('en', 1234.5)).toBe('1,234.5');
  });

  it('fills placeholders', () => {
    expect(t('ru', 'bench.progress', { done: 2, total: 6, name: 'Холст 5 тыс.' })).toBe(
      '2 из 6 · Холст 5 тыс.',
    );
  });

  it('detects the locale from system languages', () => {
    expect(detectLocale(['ru-RU', 'en-US'])).toBe('ru');
    expect(detectLocale(['en-GB'])).toBe('en');
    expect(detectLocale([])).toBe('en');
  });
});
