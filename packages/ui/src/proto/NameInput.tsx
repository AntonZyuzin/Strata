import { type Locale, t } from '@strata/i18n';
import { useEffect, useRef, useState } from 'react';

/**
 * Inline name of a node over its label slot (06 §5.5, 07 §4.1: ≤ 160 px).
 * Enter commits, Esc cancels; Tab — or «/» as the first character — turns it
 * into the Tab menu with the typed text as the query.
 */
export function NameInput(props: {
  locale: Locale;
  x: number;
  y: number;
  initial: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
  onMenu: (text: string) => void;
}) {
  const [value, setValue] = useState(props.initial);
  const input = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  const finish = (f: () => void) => {
    if (done.current) return;
    done.current = true;
    f();
  };

  return (
    <input
      ref={input}
      className="name-input"
      style={{ left: props.x, top: props.y }}
      value={value}
      placeholder={t(props.locale, 'proto.name.placeholder')}
      aria-label={t(props.locale, 'proto.name.placeholder')}
      spellCheck={false}
      onChange={(e) => {
        const v = e.target.value;
        if (v === '/' && value === '') {
          finish(() => props.onMenu(''));
          return;
        }
        setValue(v);
      }}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(() => props.onCommit(value));
        } else if (e.key === 'Escape') {
          e.preventDefault();
          finish(props.onCancel);
        } else if (e.key === 'Tab') {
          e.preventDefault();
          finish(() => props.onMenu(value));
        }
      }}
      onBlur={() => finish(() => props.onCommit(value))}
    />
  );
}
