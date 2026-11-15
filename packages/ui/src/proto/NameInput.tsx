import { type Locale, t } from '@strata/i18n';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * Inline name of a node over its label slot (06 §5.5, 07 §4.1: ≤ 160 px).
 * Enter commits, Esc cancels; Tab — or «/» as the first character — turns it
 * into the Tab menu with the typed text as the query.
 *
 * The field is as wide as its text, between 12ch and 24ch, centred under the
 * bubble on whole device pixels, and the text starts on one too: a pixel font
 * drawn half a pixel off looks bolder, and text centred inside a fixed box
 * moved by half a glyph with every letter typed, its weight flickering
 * (owner, 2026-11-15).
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
  const [box, setBox] = useState<{ left: number; width: number; pad: number } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const text = useRef<HTMLSpanElement>(null);
  const zero = useRef<HTMLSpanElement>(null);
  const done = useRef(false);
  const placeholder = t(props.locale, 'proto.name.placeholder');

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  // `value` and `placeholder` reach the measure through the mirror's text.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure on each change of the shown text
  useLayoutEffect(() => {
    const el = input.current;
    if (!el || !text.current || !zero.current) return;
    const dpr = window.devicePixelRatio || 1;
    const snap = (v: number) => Math.round(v * dpr) / dpr;
    const css = getComputedStyle(el);
    const px = (v: string) => Number.parseFloat(v) || 0;
    const side = px(css.paddingRight);
    const edge = px(css.borderLeftWidth);
    const frame = edge + px(css.borderRightWidth);
    const ch = zero.current.getBoundingClientRect().width;
    const shown = text.current.getBoundingClientRect().width;
    // Room for the caret after the last letter: the field never scrolls by a fraction.
    const caret = 2 / dpr;
    const inner = snap(Math.min(Math.max(shown + caret, 12 * ch), 24 * ch));
    const width = inner + 2 * side + frame;
    const left = snap(props.x - width / 2);
    // The text's first pixel on a device pixel, whatever the frame is drawn
    // with: at DPR 1.25 a frame of `1u` is laid out as a whole CSS pixel.
    const start = snap(left + edge + side + Math.max(0, (inner - shown - caret) / 2));
    setBox({ left, width, pad: start - left - edge });
  }, [value, placeholder, props.x]);

  const finish = (f: () => void) => {
    if (done.current) return;
    done.current = true;
    f();
  };

  const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
  const top = Math.round(props.y * dpr) / dpr;
  return (
    <>
      <span ref={text} className="name-input-mirror" aria-hidden="true">
        {value || placeholder}
      </span>
      <span ref={zero} className="name-input-mirror" aria-hidden="true">
        0
      </span>
      <input
        ref={input}
        className="name-input"
        style={
          box
            ? { left: box.left, top, width: box.width, paddingLeft: box.pad }
            : // Unmeasured for a moment before the first paint; still takes the focus.
              { left: props.x, top, opacity: 0 }
        }
        value={value}
        placeholder={placeholder}
        aria-label={placeholder}
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
    </>
  );
}
