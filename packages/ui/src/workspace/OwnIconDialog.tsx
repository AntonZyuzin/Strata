import {
  hexPath,
  maskScale,
  type Pixels,
  STYLE_MODES,
  type StyleMode,
  type StyleParams,
  stylize,
} from '@strata/canvas';
import { fog, palette } from '@strata/design-tokens';
import { type Locale, t } from '@strata/i18n';
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { takesThreshold } from './ownIcons';

type State = 'normal' | 'selected' | 'dimmed';
const STATES: readonly State[] = ['normal', 'selected', 'dimmed'];

/** `#rrggbb` → [r, g, b]. */
function rgb(color: string): [number, number, number] {
  return [1, 3, 5].map((i) => Number.parseInt(color.slice(i, i + 2), 16)) as [
    number,
    number,
    number,
  ];
}

/**
 * The mask inside a bubble as the Scene draws it (07 §4.1, §4.5, ADR-0011):
 * the paper hexagon, the mask in ink filling 0.55 of it; selected — the
 * accent's outline around; dimmed — a closed node's grey (07 §4.6).
 */
function Bubble(props: { mask: Uint8ClampedArray; side: number; state: State; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const size = canvas.clientWidth;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx || size === 0) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    const c = size / 2;
    // The outline of the selection keeps inside the box.
    const r = size * 0.4;
    const dimmed = props.state === 'dimmed';
    ctx.globalAlpha = dimmed ? fog.scene.doneAlpha : 1;
    ctx.fillStyle = dimmed ? fog.scene.doneFill : palette.paper;
    hexPath(ctx, c, c, r).fill();
    // The mask as ink: the alpha from the mask, the colour from the state.
    const ink = document.createElement('canvas');
    ink.width = props.side;
    ink.height = props.side;
    const ictx = ink.getContext('2d');
    if (!ictx) return;
    const img = ictx.createImageData(props.side, props.side);
    const [rr, gg, bb] = rgb(dimmed ? fog.scene.doneInk : palette.ink850);
    for (let i = 0; i < props.mask.length; i++) {
      img.data[i * 4] = rr;
      img.data[i * 4 + 1] = gg;
      img.data[i * 4 + 2] = bb;
      img.data[i * 4 + 3] = props.mask[i] ?? 0;
    }
    ictx.putImageData(img, 0, 0);
    const side = maskScale(2 * r, props.side) * props.side;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(ink, c - side / 2, c - side / 2, side, side);
    ctx.globalAlpha = 1;
    if (props.state === 'selected') {
      ctx.strokeStyle = fog.scene.accent;
      ctx.lineWidth = Math.max(1, size / 32);
      hexPath(ctx, c, c, r + size / 16).stroke();
    }
  }, [props.mask, props.side, props.state]);
  return (
    <canvas
      ref={ref}
      className="own-bubble"
      data-state={props.state}
      role="img"
      aria-label={props.label}
    />
  );
}

/**
 * «Своя иконка» (07 §6.4–6.5): one's own picture through «привести к стилю».
 * The original, then the mask in a bubble as the canvas shows it — plain,
 * selected, dimmed; under them the style: the mode, the threshold — Otsu's
 * («Авто») or by hand, for the modes that have one — and «Инвертировать».
 * «Готово» gives the icon to the nodes, one step of undo; «Другая картинка…»
 * takes another file; `Esc` and «Отмена» take nothing.
 */
export function OwnIconDialog(props: {
  locale: Locale;
  /** The picture decoded, and an address of the original to show it. */
  picture: { px: Pixels; url: string; name: string };
  /** The style to start from: the nodes' own icon's, or the default. */
  style: StyleParams;
  onDone: (style: StyleParams) => void;
  /** Another file chosen from the disk; the style chosen so far stays. */
  onAnother: (file: File, style: StyleParams) => void;
  onCancel: () => void;
}) {
  const { locale, picture } = props;
  const [style, setStyle] = useState<StyleParams>(props.style);
  // The slider moves at once; the mask follows when the screen is free.
  const shown = useDeferredValue(style);
  const result = useMemo(() => stylize(picture.px, shown), [picture.px, shown]);
  const done = useRef<HTMLButtonElement>(null);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => done.current?.focus(), []);

  const change = (part: Partial<StyleParams>) => setStyle((s) => ({ ...s, ...part }));
  const hand = takesThreshold(style.mode);
  const auto = style.threshold === null;
  const title = t(locale, 'own.title');
  const states = t(locale, 'own.states');
  return (
    <div className="dialog-backdrop">
      <section
        className="window dialog own-icon-dialog"
        role="dialog"
        aria-labelledby="own-icon-title"
        title={t(locale, 'own.keys')}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') {
            e.preventDefault();
            props.onCancel();
          } else if (
            e.key === 'Enter' &&
            !(e.target instanceof HTMLButtonElement) &&
            !(e.target instanceof HTMLInputElement && e.target.type === 'checkbox')
          ) {
            e.preventDefault();
            props.onDone(style);
          }
        }}
      >
        <header className="window-title">
          <h2 id="own-icon-title" title={title}>
            {title}
          </h2>
        </header>
        <div className="window-body">
          <div className="own-previews" title={states}>
            <img
              className="own-original"
              src={picture.url}
              alt={t(locale, 'own.original')}
              title={picture.name}
            />
            {STATES.map((s) => (
              <Bubble
                key={s}
                mask={result.mask}
                side={Math.round(Math.sqrt(result.mask.length))}
                state={s}
                label={t(locale, `own.state.${s}`)}
              />
            ))}
          </div>
          <div className="own-row">
            <span className="own-label" aria-hidden="true">
              {t(locale, 'own.style')}
            </span>
            <fieldset className="own-modes">
              <legend className="sr-only">{t(locale, 'own.style')}</legend>
              {STYLE_MODES.map((m: StyleMode) => (
                <button
                  key={m}
                  type="button"
                  className="own-mode"
                  data-mode={m}
                  aria-pressed={style.mode === m}
                  title={t(locale, `own.modeHint.${m}`)}
                  onClick={() => change({ mode: m })}
                >
                  <span className="own-mode-name">{t(locale, `own.mode.${m}`)}</span>
                </button>
              ))}
            </fieldset>
          </div>
          <div className="own-row">
            <span className="own-label" aria-hidden="true">
              {t(locale, 'own.threshold')}
            </span>
            <label className="check own-auto" title={t(locale, 'own.autoHint')}>
              <input
                type="checkbox"
                checked={auto}
                disabled={!hand}
                onChange={(e) =>
                  change({ threshold: e.currentTarget.checked ? null : result.threshold })
                }
              />
              <span>{t(locale, 'own.auto')}</span>
            </label>
            <input
              className="own-threshold"
              type="range"
              min={0}
              max={255}
              aria-label={t(locale, 'own.threshold')}
              value={auto ? result.threshold : (style.threshold ?? result.threshold)}
              disabled={!hand || auto}
              onChange={(e) => change({ threshold: Number(e.currentTarget.value) })}
            />
          </div>
          <div className="own-row">
            <span className="own-label" aria-hidden="true" />
            <label className="check">
              <input
                type="checkbox"
                checked={style.invert}
                onChange={(e) => change({ invert: e.currentTarget.checked })}
              />
              <span>{t(locale, 'own.invert')}</span>
            </label>
          </div>
          <div className="dialog-actions own-actions">
            <button type="button" className="own-another" onClick={() => file.current?.click()}>
              {t(locale, 'own.another')}
            </button>
            <input
              ref={file}
              className="sr-only"
              type="file"
              accept="image/*"
              tabIndex={-1}
              // The button beside it is the control; this one only opens the chooser.
              aria-hidden="true"
              onChange={(e) => {
                const f = e.currentTarget.files?.[0];
                e.currentTarget.value = '';
                if (f) props.onAnother(f, style);
              }}
            />
            <button type="button" onClick={props.onCancel}>
              {t(locale, 'own.cancel')}
            </button>
            <button
              ref={done}
              type="button"
              className="is-default"
              onClick={() => props.onDone(style)}
            >
              {t(locale, 'own.done')}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
