import {
  cutout,
  foreground,
  hexPath,
  maskScale,
  type Pixels,
  STYLE_MODES,
  type StyleBackground,
  type StyleMode,
  type StyleParams,
  stylize,
} from '@strata/canvas';
import { fog, glyphUrl, palette } from '@strata/design-tokens';
import { type Locale, t } from '@strata/i18n';
import {
  type CSSProperties,
  type PointerEvent,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { keepTab } from '../focusTrap';
import { EraserStrokes } from './eraser';
import { takesThreshold } from './ownIcons';

type State = 'normal' | 'selected' | 'dimmed';
const STATES: readonly State[] = ['normal', 'selected', 'dimmed'];
const BACKGROUNDS: readonly StyleBackground[] = ['auto', 'alpha'];

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

/** Where the picture lies in a box: contained, in the middle. */
function placeIn(box: { width: number; height: number }, px: Pixels) {
  const k = Math.min(box.width / px.width, box.height / px.height);
  return { k, x: (box.width - px.width * k) / 2, y: (box.height - px.height * k) / 2 };
}

/**
 * The picture with its background gone (07 §6.4), on a chessboard where it
 * is transparent: what the bubble will take. With the eraser on, a stroke
 * rubs the background out; the brush's circle follows the pointer.
 */
function Original(props: {
  px: Pixels;
  /** The foreground's weight per pixel: the alpha drawn. */
  weight: Float32Array;
  name: string;
  label: string;
  erasing: boolean;
  /** The brush's radius in the picture's pixels. */
  radius: number;
  onStroke: (phase: 'begin' | 'move' | 'end', x: number, y: number) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [brush, setBrush] = useState<{ x: number; y: number; d: number } | null>(null);
  const { px, weight } = props;
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const box = { width: canvas.clientWidth, height: canvas.clientHeight };
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(box.width * dpr);
    canvas.height = Math.round(box.height * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx || box.width === 0) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const at = placeIn(box, px);
    ctx.fillStyle = fog.color.surfaceSunken;
    ctx.fillRect(0, 0, box.width, box.height);
    // The chessboard under the picture only: the margins are no transparency.
    // Paper and grey, as editors show transparency: the ink of a figure reads on it.
    const cell = Math.max(4, Math.round(box.width / 16));
    ctx.save();
    ctx.beginPath();
    ctx.rect(at.x, at.y, px.width * at.k, px.height * at.k);
    ctx.clip();
    for (let y = 0; y * cell < box.height; y++) {
      for (let x = 0; x * cell < box.width; x++) {
        ctx.fillStyle = (x + y) % 2 === 0 ? palette.paper : palette.gray100;
        ctx.fillRect(x * cell, y * cell, cell, cell);
      }
    }
    ctx.restore();
    const shown = cutout(px, weight);
    const off = document.createElement('canvas');
    off.width = px.width;
    off.height = px.height;
    const octx = off.getContext('2d');
    if (!octx) return;
    const img = octx.createImageData(px.width, px.height);
    img.data.set(shown.data);
    octx.putImageData(img, 0, 0);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(off, at.x, at.y, px.width * at.k, px.height * at.k);
  }, [px, weight]);

  const point = (e: PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const at = placeIn(r, props.px);
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    return { x, y, px: (x - at.x) / at.k, py: (y - at.y) / at.k, d: 2 * props.radius * at.k };
  };
  return (
    <div className="own-original-box">
      <canvas
        ref={ref}
        className={props.erasing ? 'own-original is-erasing' : 'own-original'}
        role="img"
        aria-label={props.label}
        title={props.name}
        onPointerDown={(e) => {
          if (!props.erasing || e.button !== 0) return;
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          const p = point(e);
          props.onStroke('begin', p.px, p.py);
        }}
        onPointerMove={(e) => {
          if (!props.erasing) return;
          const p = point(e);
          setBrush({ x: p.x, y: p.y, d: p.d });
          if (e.currentTarget.hasPointerCapture(e.pointerId)) props.onStroke('move', p.px, p.py);
        }}
        onPointerUp={(e) => {
          if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
          e.currentTarget.releasePointerCapture(e.pointerId);
          const p = point(e);
          props.onStroke('end', p.px, p.py);
        }}
        onPointerCancel={(e) => {
          const p = point(e);
          props.onStroke('end', p.px, p.py);
        }}
        onPointerLeave={() => setBrush(null)}
      />
      {props.erasing && brush ? (
        <span
          className="own-brush"
          aria-hidden="true"
          style={{
            left: brush.x - brush.d / 2,
            top: brush.y - brush.d / 2,
            width: brush.d,
            height: brush.d,
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * «Своя иконка» (07 §6.4–6.5): one's own picture through «привести к стилю».
 * The picture without its background, then the mask in a bubble as the
 * canvas shows it — plain, selected, dimmed; under them the style: the mode,
 * the threshold — Otsu's («Авто») or by hand, for the modes that have one —
 * «Инвертировать», and the background: «Авто» (transparency, or a flood from
 * the corners) or «Только прозрачное», and the eraser, its strokes undone
 * with `Ctrl+Z`. «Готово» gives the icon to the nodes, one step of undo —
 * with the eraser's strokes, a copy of the picture with its background baked
 * in; «Другая картинка…» takes another file; `Esc` and «Отмена» take nothing.
 */
export function OwnIconDialog(props: {
  locale: Locale;
  /** The picture decoded, and its file's name. */
  picture: { px: Pixels; name: string };
  /** The style to start from: the nodes' own icon's, or the default. */
  style: StyleParams;
  /**
   * The style, and the picture as the eraser left it — its background baked
   * into the alpha, for the style's `alpha` background; null — untouched.
   * `forKind` (`Ctrl`): the kind's icon of the workspace (05 §4.1).
   */
  onDone: (style: StyleParams, baked: Pixels | null, forKind: boolean) => void;
  /** Another file chosen from the disk; the style chosen so far stays. */
  onAnother: (file: File, style: StyleParams) => void;
  onCancel: () => void;
}) {
  const { locale, picture } = props;
  const [style, setStyle] = useState<StyleParams>(props.style);
  const [erasing, setErasing] = useState(false);
  // The eraser's marks over the picture; `strokes` counts its changes for the renders.
  const eraser = useMemo(
    () => new EraserStrokes(picture.px.width, picture.px.height),
    [picture.px],
  );
  const [strokes, setStrokes] = useState(0);
  // The slider and the brush move at once; the mask follows when the screen is free.
  const wanted = useMemo(() => ({ style, strokes }), [style, strokes]);
  const shown = useDeferredValue(wanted);
  // `shown` carries the strokes' count: the marks change in place.
  const result = useMemo(
    () => stylize(picture.px, shown.style, eraser.erased),
    [picture.px, shown, eraser],
  );
  const cut = useMemo(
    () => foreground(picture.px, 40, shown.style.background !== 'alpha', eraser.erased).weight,
    [picture.px, shown, eraser],
  );
  const finish = (forKind: boolean) => {
    if (!eraser.any) {
      props.onDone(style, null, forKind);
      return;
    }
    // What the eraser took, and the background as the style found it, into the alpha.
    const weight = foreground(picture.px, 40, style.background !== 'alpha', eraser.erased).weight;
    props.onDone({ ...style, background: 'alpha' }, cutout(picture.px, weight), forKind);
  };
  const stroke = (phase: 'begin' | 'move' | 'end', x: number, y: number) => {
    if (phase === 'begin') eraser.begin(x, y);
    else if (phase === 'move') eraser.move(x, y);
    else eraser.end();
    setStrokes((n) => n + 1);
  };
  const done = useRef<HTMLButtonElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLElement>(null);
  useEffect(() => done.current?.focus(), []);

  const change = (part: Partial<StyleParams>) => setStyle((s) => ({ ...s, ...part }));
  const hand = takesThreshold(style.mode);
  const auto = style.threshold === null;
  const title = t(locale, 'own.title');
  const states = t(locale, 'own.states');
  return (
    <div className="dialog-backdrop">
      <section
        ref={box}
        className="window dialog own-icon-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="own-icon-title"
        title={t(locale, 'own.keys')}
        onKeyDown={(e) => {
          e.stopPropagation();
          keepTab(e, box.current);
          const k = e.key.toLowerCase();
          if ((e.ctrlKey || e.metaKey) && !e.altKey && (k === 'z' || k === 'y')) {
            // The eraser's strokes, one a step; the workspace's undo waits.
            e.preventDefault();
            const again = k === 'y' || e.shiftKey;
            if (again ? eraser.redo() : eraser.undo()) setStrokes((n) => n + 1);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            props.onCancel();
          } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            // For the whole kind, wherever the focus is: a button takes no Ctrl+Enter.
            e.preventDefault();
            finish(true);
          } else if (
            e.key === 'Enter' &&
            !(e.target instanceof HTMLButtonElement) &&
            !(e.target instanceof HTMLInputElement && e.target.type === 'checkbox')
          ) {
            e.preventDefault();
            finish(e.ctrlKey || e.metaKey);
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
            <Original
              px={picture.px}
              weight={cut}
              name={picture.name}
              label={t(locale, 'own.original')}
              erasing={erasing}
              radius={eraser.radius}
              onStroke={stroke}
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
              {t(locale, 'own.background')}
            </span>
            <fieldset className="own-modes own-backgrounds">
              <legend className="sr-only">{t(locale, 'own.background')}</legend>
              {BACKGROUNDS.map((b) => (
                <button
                  key={b}
                  type="button"
                  className="own-mode"
                  data-background={b}
                  aria-pressed={style.background === b}
                  title={t(locale, `own.backgroundHint.${b}`)}
                  onClick={() => change({ background: b })}
                >
                  <span className="own-mode-name">{t(locale, `own.background.${b}`)}</span>
                </button>
              ))}
            </fieldset>
            <button
              type="button"
              className="own-eraser"
              aria-pressed={erasing}
              aria-label={t(locale, 'own.eraser')}
              title={t(locale, 'own.eraserHint')}
              onClick={() => setErasing((on) => !on)}
            >
              <span
                className="kind-icon"
                style={{ '--glyph': glyphUrl('eraser') } as CSSProperties}
                aria-hidden="true"
              />
            </button>
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
              onClick={(e) => finish(e.ctrlKey || e.metaKey)}
            >
              {t(locale, 'own.done')}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
