import { describe, expect, it } from 'vitest';
import {
  defaults,
  formatDate,
  formatTime,
  joinWhen,
  loadPrefs,
  parseDate,
  parseTime,
  reading,
  readWhen,
  showWhen,
  splitWhen,
} from './prefs';

describe('dates and times of the settings (✅ Q-06-23, 05 §6.1)', () => {
  it('read by the language unless chosen: RU day first and 24 h, EN month first and 12 h', () => {
    expect(defaults('ru')).toEqual({ date: 'dmy/', clock: '24' });
    expect(defaults('en')).toEqual({ date: 'mdy/', clock: '12' });
    expect(reading({ locale: 'en', date: 'auto', clock: 'auto' })).toEqual(defaults('en'));
    expect(reading({ locale: 'en', date: 'dmy.', clock: '24' })).toEqual({
      date: 'dmy.',
      clock: '24',
    });
  });

  it('show the flag ring always until told otherwise (06 §8)', () => {
    // No storage here: the defaults.
    expect(loadPrefs('ru')).toEqual({ locale: 'ru', date: 'auto', clock: 'auto', ring: 'always' });
  });

  it('show a stored day in the chosen order', () => {
    expect(formatDate('2026-10-26', 'dmy/')).toBe('26/10/2026');
    expect(formatDate('2026-10-26', 'dmy.')).toBe('26.10.2026');
    expect(formatDate('2026-10-26', 'mdy/')).toBe('10/26/2026');
    expect(formatDate('2026-10-26', 'ymd-')).toBe('2026-10-26');
  });

  it('read a typed day back in the same order, and refuse a day that is none', () => {
    expect(parseDate('26/10/2026', 'dmy/')).toBe('2026-10-26');
    expect(parseDate('1.2.2026', 'dmy.')).toBe('2026-02-01');
    expect(parseDate('10/26/2026', 'mdy/')).toBe('2026-10-26');
    expect(parseDate('2026-10-26', 'ymd-')).toBe('2026-10-26');
    expect(parseDate('26/10/2026', 'mdy/')).toBeNull();
    expect(parseDate('29/02/2026', 'dmy/')).toBeNull();
    expect(parseDate('29/02/2024', 'dmy/')).toBe('2024-02-29');
    expect(parseDate('26/10/26', 'dmy/')).toBeNull();
    expect(parseDate('завтра', 'dmy/')).toBeNull();
  });

  it('show a time on a 24- or a 12-hour clock', () => {
    expect(formatTime('18:30', '24')).toBe('18:30');
    expect(formatTime('18:30', '12')).toBe('6:30 PM');
    expect(formatTime('00:05', '12')).toBe('12:05 AM');
    expect(formatTime('12:00', '12')).toBe('12:00 PM');
  });

  it('read a typed time either way', () => {
    expect(parseTime('18:30')).toBe('18:30');
    expect(parseTime('6:30 PM')).toBe('18:30');
    expect(parseTime('6:30pm')).toBe('18:30');
    expect(parseTime('12:05 am')).toBe('00:05');
    expect(parseTime('9')).toBe('09:00');
    expect(parseTime('9.15')).toBe('09:15');
    expect(parseTime('24:00')).toBeNull();
    expect(parseTime('13:00 PM')).toBeNull();
    expect(parseTime('18:60')).toBeNull();
  });

  it('read and show a start or a deadline in one field: the day, then the time if any', () => {
    expect(showWhen('2026-10-26T18:30', 'dmy/', '24')).toBe('26/10/2026 18:30');
    expect(showWhen('2026-10-26T18:30', 'mdy/', '12')).toBe('10/26/2026 6:30 PM');
    expect(showWhen('2026-10-26', 'dmy.', '24')).toBe('26.10.2026');
    expect(showWhen(undefined, 'dmy/', '24')).toBe('');
    expect(readWhen('26/10/2026 18:30', 'dmy/')).toBe('2026-10-26T18:30');
    expect(readWhen('10/26/2026 6:30 pm', 'mdy/')).toBe('2026-10-26T18:30');
    expect(readWhen('26/10/2026', 'dmy/')).toBe('2026-10-26');
    expect(readWhen('  ', 'dmy/')).toBeNull();
    expect(readWhen('26/10/2026 25:00', 'dmy/')).toBeUndefined();
    expect(readWhen('31/02/2026', 'dmy/')).toBeUndefined();
  });

  it('keep a deadline as the model has it: a day, or a day and a time', () => {
    expect(splitWhen('2026-10-26T18:30')).toEqual({ day: '2026-10-26', time: '18:30' });
    expect(splitWhen('2026-10-26')).toEqual({ day: '2026-10-26', time: '' });
    expect(joinWhen('2026-10-26', '18:30')).toBe('2026-10-26T18:30');
    expect(joinWhen('2026-10-26', '')).toBe('2026-10-26');
    expect(joinWhen('', '18:30')).toBeNull();
  });
});
