import { type Due, dueOf, today } from '@strata/backend';
import { type Locale, t } from '@strata/i18n';

/** A near or past deadline's state: the ones the canvas and «Ноды» mark. */
export type NearDue = Extract<Due, 'soon' | 'today' | 'overdue'>;

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** A deadline's state if it is near or past (07 §4.6); null for far, none or a bad date. */
export function nearDue(
  deadline: string | undefined,
  day = today(),
  time?: string,
): NearDue | null {
  const due = time === undefined ? dueOf(deadline, day) : dueOf(deadline, day, time);
  return due === 'soon' || due === 'today' || due === 'overdue' ? due : null;
}

/**
 * A near or past deadline in a word under its bubble's label (Q-07-22, 07
 * §4.6): «сегодня», «завтра», «через 2 дн.», «−3 дн.»; far deadlines say
 * nothing, so the canvas stays quiet.
 */
export function dueWord(
  deadline: string | undefined,
  locale: Locale,
  day = today(),
  time?: string,
): string | null {
  if (!deadline || !nearDue(deadline, day, time)) return null;
  const d = daysBetween(day, deadline.split('T')[0] ?? deadline);
  if (Number.isNaN(d)) return null;
  if (d === 0) return t(locale, 'due.today');
  if (d === 1) return t(locale, 'due.tomorrow');
  if (d > 1) return t(locale, 'due.in', { n: d });
  return t(locale, 'due.late', { n: -d });
}
