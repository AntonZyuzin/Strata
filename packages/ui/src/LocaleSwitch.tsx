import type { Locale } from '@strata/i18n';

/** Language names are shown in their own language, so they never change with the locale. */
const LOCALES: readonly { id: Locale; short: string; native: string }[] = [
  { id: 'ru', short: 'RU', native: 'Русский' },
  { id: 'en', short: 'EN', native: 'English' },
];

export function LocaleSwitch(props: {
  locale: Locale;
  onChange: (l: Locale) => void;
  label: string;
}) {
  return (
    <fieldset className="segmented">
      <legend className="sr-only">{props.label}</legend>
      {LOCALES.map((l) => (
        <label
          key={l.id}
          title={l.native}
          className={props.locale === l.id ? 'is-active' : undefined}
        >
          <input
            type="radio"
            name="locale"
            value={l.id}
            checked={props.locale === l.id}
            onChange={() => props.onChange(l.id)}
          />
          <span aria-hidden="true">{l.short}</span>
          <span className="sr-only">{l.native}</span>
        </label>
      ))}
    </fieldset>
  );
}
