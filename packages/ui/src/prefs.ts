import type { Locale } from '@strata/i18n';

/**
 * The device's settings of the «Настройки» tab (✅ Q-06-23, owner
 * 2026-10-24): the language, and how dates and times read — a device's
 * state (05 §13), kept in this browser or WebView. Dates are stored as
 * the model has them (05 §6.1): `YYYY-MM-DD`, or with a time of the
 * viewer's clock, `YYYY-MM-DDTHH:MM`; only how they read changes here.
 */

/** The order and the separator of a date: day first, month first, or the year first. */
export type DateFormat = 'dmy/' | 'dmy.' | 'mdy/' | 'ymd-';
/** A 24-hour or a 12-hour clock. */
export type Clock = '24' | '12';

export const DATE_FORMATS: readonly DateFormat[] = ['dmy/', 'dmy.', 'mdy/', 'ymd-'];
export const CLOCKS: readonly Clock[] = ['24', '12'];
/** When the flag ring shows (06 §8): always, on bubbles seen from afar, never. */
export type RingMode = 'always' | 'far' | 'never';
export const RING_MODES: readonly RingMode[] = ['always', 'far', 'never'];

/**
 * What the device keeps: the language; a date's form and the clock, or
 * `auto` — as the language reads them (owner, 2026-10-24).
 */
export interface Prefs {
  locale: Locale;
  date: DateFormat | 'auto';
  clock: Clock | 'auto';
  /** The flag ring (06 §8): «Всегда» by default. */
  ring: RingMode;
}

const KEY = 'strata.prefs';

/** How a language reads by default (owner, 2026-10-24): RU — day first and 24 h, EN — month first and 12 h. */
export function defaults(locale: Locale): { date: DateFormat; clock: Clock } {
  return locale === 'ru' ? { date: 'dmy/', clock: '24' } : { date: 'mdy/', clock: '12' };
}

/** The date form and the clock in force: chosen, or the language's. */
export function reading(p: Pick<Prefs, 'locale' | 'date' | 'clock'>): {
  date: DateFormat;
  clock: Clock;
} {
  const base = defaults(p.locale);
  return {
    date: p.date === 'auto' ? base.date : p.date,
    clock: p.clock === 'auto' ? base.clock : p.clock,
  };
}

export function loadPrefs(fallback: Locale): Prefs {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Prefs> | null;
    return {
      locale: v?.locale === 'ru' || v?.locale === 'en' ? v.locale : fallback,
      date: DATE_FORMATS.includes(v?.date as DateFormat) ? (v?.date as DateFormat) : 'auto',
      clock: CLOCKS.includes(v?.clock as Clock) ? (v?.clock as Clock) : 'auto',
      ring: RING_MODES.includes(v?.ring as RingMode) ? (v?.ring as RingMode) : 'always',
    };
  } catch {
    return { locale: fallback, date: 'auto', clock: 'auto', ring: 'always' };
  }
}

export function savePrefs(prefs: Prefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Private windows may refuse storage: the settings last for the session.
  }
}

const pad = (n: number) => String(n).padStart(2, '0');

/** `YYYY-MM-DD` → the chosen form, e.g. `26/10/2026`. */
export function formatDate(iso: string, f: DateFormat): string {
  const [y = '', m = '', d = ''] = iso.split('-');
  switch (f) {
    case 'dmy/':
      return `${d}/${m}/${y}`;
    case 'dmy.':
      return `${d}.${m}.${y}`;
    case 'mdy/':
      return `${m}/${d}/${y}`;
    case 'ymd-':
      return `${y}-${m}-${d}`;
  }
}

function realDay(y: number, m: number, d: number): boolean {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/**
 * A typed date in the chosen order → `YYYY-MM-DD`; null when it is no real
 * day. Any of `/ . -` separates; a day or a month may have one digit.
 */
export function parseDate(text: string, f: DateFormat): string | null {
  const parts = text.trim().split(/[/.\-\s]+/);
  if (parts.length !== 3 || parts.some((p) => !/^\d+$/.test(p))) return null;
  const [a = '', b = '', c = ''] = parts;
  const [y, m, d] = f === 'ymd-' ? [a, b, c] : f === 'mdy/' ? [c, a, b] : [c, b, a];
  if (y.length !== 4 || m.length > 2 || d.length > 2) return null;
  const Y = Number(y);
  const M = Number(m);
  const D = Number(d);
  if (!realDay(Y, M, D)) return null;
  return `${y}-${pad(M)}-${pad(D)}`;
}

/** `HH:MM` → the chosen clock, e.g. `18:30` or `6:30 PM`. */
export function formatTime(hm: string, c: Clock): string {
  if (c === '24') return hm;
  const [h = 0, m = 0] = hm.split(':').map(Number);
  const half = h < 12 ? 'AM' : 'PM';
  return `${h % 12 === 0 ? 12 : h % 12}:${pad(m)} ${half}`;
}

/**
 * A typed time → `HH:MM`; null when it is none. `18:30` reads in either
 * clock; `6:30 pm` or `6:30 PM` reads as the evening; on a 12-hour clock a
 * time with no AM or PM is the morning.
 */
export function parseTime(text: string): string | null {
  const m = /^\s*(\d{1,2})(?:[:.](\d{2}))?\s*([ap]\.?m\.?)?\s*$/i.exec(text);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? '0');
  const half = m[3]?.toLowerCase().replace(/\./g, '');
  if (min > 59) return null;
  if (half) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (half === 'pm' ? 12 : 0);
  } else if (h > 23) {
    return null;
  }
  return `${pad(h)}:${pad(min)}`;
}

/** A start or a deadline of the model split into its day and its time. */
export function splitWhen(value: string | undefined): { day: string; time: string } {
  const [day = '', time = ''] = (value ?? '').split('T');
  return { day, time };
}

/** A day and a time back into the model's value; a time with no day is nothing. */
export function joinWhen(day: string, time: string): string | null {
  if (!day) return null;
  return time ? `${day}T${time}` : day;
}

/** A stored start or deadline as it reads. */
export function showWhen(value: string | undefined, date: DateFormat, clock: Clock): string {
  const { day, time } = splitWhen(value);
  if (!day) return '';
  return time ? `${formatDate(day, date)} ${formatTime(time, clock)}` : formatDate(day, date);
}

/** A typed day and maybe a time → the stored value; `undefined` when it reads as none. */
export function readWhen(text: string, date: DateFormat): string | null | undefined {
  const s = text.trim();
  if (s === '') return null;
  const [, dayText = '', timeText] = /^(\S+)(?:\s+(.+))?$/.exec(s) ?? [];
  const day = parseDate(dayText, date);
  const time = timeText ? parseTime(timeText) : '';
  if (!day || time === null) return undefined;
  return joinWhen(day, time);
}
