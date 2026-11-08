import { type Locale, type MessageKey, t } from '@strata/i18n';

/**
 * A changeset's label as the core sends it (10 §9.1): a message key and its
 * parameters; a revert's carries the label of what it took back, `of`.
 */
export interface Label {
  key: string;
  params?: Record<string, unknown> | undefined;
}

const isLabel = (v: unknown): v is Label =>
  typeof v === 'object' && v !== null && typeof (v as Label).key === 'string';

/** A changeset's label in words (06 §1.2): «Откат: …» names what it took back. */
export function changeText(locale: Locale, label: Label): string {
  const params = label.params ?? {};
  if (label.key === 'core.change.revert' && isLabel(params.of)) {
    return t(locale, 'core.change.revert', { label: changeText(locale, params.of) });
  }
  const words: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === 'string' || typeof v === 'number') words[k] = v;
  }
  return t(locale, label.key as MessageKey, words);
}
