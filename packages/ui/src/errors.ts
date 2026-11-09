import { CoreError } from '@strata/backend';
import { type Locale, t } from '@strata/i18n';

/**
 * What went wrong, in words: the interface's own for what it knows — a
 * folder open in another copy of the app (10 §3.6), a copy that cannot be
 * restored (§3.5), a damaged store (NFR-76) — the core's words otherwise.
 */
export function errorText(locale: Locale, e: unknown): string {
  if (e instanceof CoreError) {
    if (e.code === 'locked') return t(locale, 'home.locked');
    if (e.code === 'damaged') return t(locale, 'home.damaged');
    if (e.code === 'corrupt') return t(locale, 'home.corrupt');
    // A folder refused as the second place for copies (10 §3.5).
    if (e.code === 'place-folder') return t(locale, 'second.notFolder');
    if (e.code === 'place-workspace') return t(locale, 'second.workspace');
    if (e.code === 'place-inside') return t(locale, 'second.inside');
    if (e.code === 'place-write') return t(locale, 'second.unwritable');
  }
  return e instanceof Error ? e.message : String(e);
}
