import { type Locale, type MessageKey, t } from '@strata/i18n';
import { useEffect, useRef, useState } from 'react';
import { type Clock, type DateFormat, joinWhen, readWhen, showWhen, splitWhen } from '../prefs';

/**
 * A start or a deadline (05 §6.1) as the settings read it (✅ Q-06-23,
 * owner 2026-10-24): one field, the day in the chosen form and, after a
 * space, a time of day on a 24- or 12-hour clock if it has one — so its
 * calendar stands on the axis of the selects' triangles (07 §8.2). The
 * browser's date field always shows the system's form, so the text is
 * Strata's; the calendar glyph opens the browser's own calendar. Stored as
 * the model has it: `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM`. A text that is no
 * date keeps a dashed frame until it is fixed or `Esc` gives the value back.
 */

export function WhenField(props: {
  locale: Locale;
  label: string;
  value: string | undefined;
  date: DateFormat;
  clock: Clock;
  onChange: (value: string | null) => void;
}) {
  const { locale, label, value, date, clock, onChange } = props;
  const shown = showWhen(value, date, clock);
  const [text, setText] = useState(shown);
  const [bad, setBad] = useState(false);
  const native = useRef<HTMLInputElement>(null);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => setText(shown), [shown]);
  const { day, time } = splitWhen(value);

  const commit = (typed: string) => {
    const v = readWhen(typed, date);
    if (v === undefined) {
      setBad(true);
      return;
    }
    setBad(false);
    setText(showWhen(v ?? undefined, date, clock));
    if ((v ?? undefined) !== value) onChange(v);
  };

  const pattern = `${t(locale, `settings.date.${date}` as MessageKey)} ${t(locale, 'ins.timePlaceholder')}${clock === '12' ? ' AM' : ''}`;
  return (
    <div className="when">
      <input
        ref={field}
        className="field is-date"
        aria-label={label}
        aria-invalid={bad}
        title={pattern}
        placeholder={pattern}
        value={text}
        spellCheck={false}
        onChange={(e) => setText(e.currentTarget.value)}
        onBlur={(e) => commit(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') {
            setText(shown);
            setBad(false);
            e.currentTarget.blur();
          }
          e.stopPropagation();
        }}
      />
      <button
        type="button"
        className="when-pick"
        tabIndex={-1}
        aria-label={t(locale, 'ins.pickDate', { field: label })}
        title={t(locale, 'ins.pickDate', { field: label })}
        onClick={() => {
          try {
            native.current?.showPicker();
          } catch {
            // No picker in this browser: the day is typed.
            field.current?.focus();
          }
        }}
      />
      <input
        ref={native}
        className="when-native"
        type="date"
        tabIndex={-1}
        aria-hidden="true"
        value={day}
        onChange={(e) => {
          const iso = e.currentTarget.value;
          setBad(false);
          onChange(iso ? joinWhen(iso, time) : null);
        }}
      />
    </div>
  );
}
