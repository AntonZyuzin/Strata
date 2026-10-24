import { describe, expect, it } from 'vitest';
import { dueWord, nearDue } from './due';

describe('a deadline in a word (Q-07-22, 07 §4.6)', () => {
  const day = '2026-10-24';
  it('says near and past deadlines, not far ones', () => {
    expect(dueWord('2026-10-24', 'ru', day, '09:00')).toBe('сегодня');
    expect(dueWord('2026-10-25', 'ru', day)).toBe('завтра');
    expect(dueWord('2026-10-26', 'ru', day)).toBe('через 2 дн.');
    expect(dueWord('2026-10-21', 'ru', day)).toBe('−3 дн.');
    expect(dueWord('2026-11-20', 'ru', day)).toBeNull();
    expect(dueWord(undefined, 'ru', day)).toBeNull();
    expect(dueWord('2026-10-26', 'en', day)).toBe('in 2 d');
    expect(dueWord('2026-10-21', 'en', day)).toBe('3 d late');
  });

  it('a time today that has passed is late, still «today»', () => {
    expect(nearDue('2026-10-24T09:00', day, '10:00')).toBe('overdue');
    expect(dueWord('2026-10-24T09:00', 'ru', day, '10:00')).toBe('сегодня');
  });
});
