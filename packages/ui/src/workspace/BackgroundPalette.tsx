import type { Background } from '@strata/backend';
import { generatePreset, type PresetId, processBackdrop } from '@strata/canvas';
import { type Locale, type MessageKey, t } from '@strata/i18n';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { DOTS_DEFAULT, presetBackground } from './backgrounds';

/** CSS px between the window and the canvas's edges. */
const MARGIN = 8;

/** The procedural presets of 07 §7.3, as the core knows them (`BACKGROUND_PRESETS`). */
export const BACKGROUND_PRESETS: readonly PresetId[] = ['fog', 'depth', 'dusk', 'dust'];

/**
 * The dots' strengths of the palette's row «Точки» (07 §7.2, owner
 * 2026-11-15): none, faint — the default — and clear.
 */
export const DOT_LEVELS = [
  { id: 'none', dots: 0 },
  { id: 'faint', dots: DOTS_DEFAULT },
  { id: 'clear', dots: 0.8 },
] as const;

/** A preset's swatch, made once: the preset small, through the pipeline. */
const swatches = new Map<PresetId, string>();
function swatch(id: PresetId): string {
  const known = swatches.get(id);
  if (known) return known;
  const px = generatePreset(id, 64, 40);
  processBackdrop(px, { blur: 2, desaturate: 0.8, maxL: 0.1, vignette: 0.7 });
  const canvas = document.createElement('canvas');
  canvas.width = px.width;
  canvas.height = px.height;
  // A copy on a plain ArrayBuffer, as ImageData wants it.
  const data = new Uint8ClampedArray(px.data);
  canvas.getContext('2d')?.putImageData(new ImageData(data, px.width, px.height), 0, 0);
  const url = canvas.toDataURL();
  swatches.set(id, url);
  return url;
}

/** A cell of the row: the workspace's, a preset, one's own picture. */
type Cell = { t: 'inherit' } | { t: 'preset'; id: PresetId } | { t: 'own' };

/**
 * «Фон» (07 §7.4): the background of the network on the canvas — the
 * workspace's on the root — one row of swatches: «Как у пространства»
 * (another network than the root), the four presets of 07 §7.3, «Своя
 * картинка…» — a picture from the disk through the pipeline of 07 §7.1. The
 * arrows walk the row, `Enter` or a click chooses, `Esc` closes; each choice
 * is one step of undo.
 */
export function BackgroundPalette(props: {
  locale: Locale;
  /** The root: the workspace's background, no «Как у пространства». */
  root: boolean;
  /** The network's own background; none — the workspace's. */
  current: Background | null;
  /** The background shown: the network's own, else the workspace's; none — the default. */
  shown: Background | null;
  x: number;
  y: number;
  bounds?: DOMRect | undefined;
  onPick: (background: Background | null) => void;
  /** A picture chosen from the disk: the caller stores it and sets it. */
  onPicture: (file: File) => void;
  onClose: () => void;
}) {
  const { locale } = props;
  const cells: Cell[] = [
    ...(props.root ? [] : [{ t: 'inherit' } as const]),
    ...BACKGROUND_PRESETS.map((id) => ({ t: 'preset', id }) as const),
    { t: 'own' },
  ];
  const chosen = (c: Cell): boolean => {
    const b = props.current;
    if (c.t === 'inherit') return b === null;
    if (c.t === 'own') return b?.source.startsWith('asset:') === true;
    return b === null ? props.root && c.id === 'fog' : b.source === `preset:${c.id}`;
  };
  const [index, setIndex] = useState(() => Math.max(0, cells.findIndex(chosen)));
  const box = useRef<HTMLDivElement>(null);
  const row = useRef<HTMLDivElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState({ left: props.x, top: props.y });

  useEffect(() => {
    row.current?.focus();
  }, []);

  // At the menu's place, clamped into the canvas one sees.
  useLayoutEffect(() => {
    const h = box.current?.offsetHeight ?? 0;
    const w = box.current?.offsetWidth ?? 0;
    const b = props.bounds;
    const left = (b?.left ?? 0) + MARGIN;
    const top = (b?.top ?? 0) + MARGIN;
    const right = (b?.right ?? window.innerWidth) - MARGIN;
    const bottom = (b?.bottom ?? window.innerHeight) - MARGIN;
    setPos({
      left: Math.max(left, Math.min(props.x, right - w)),
      top: Math.max(top, Math.min(props.y, bottom - h)),
    });
  }, [props.x, props.y, props.bounds]);

  const name = (c: Cell): string =>
    c.t === 'inherit'
      ? t(locale, 'bg.inherit')
      : c.t === 'own'
        ? t(locale, 'bg.own')
        : t(locale, `proto.bg.${c.id}` as MessageKey);
  /** The dots shown now: a new picture or preset keeps them. */
  const dots = props.shown?.dots ?? DOTS_DEFAULT;
  const pick = (i: number) => {
    const c = cells[i];
    if (!c) return;
    if (c.t === 'own') file.current?.click();
    else props.onPick(c.t === 'inherit' ? null : presetBackground(c.id, dots));
  };
  /** The row «Точки»: the shown background with these dots, as this network's own. */
  const pickDots = (level: number) =>
    props.onPick({ ...(props.shown ?? presetBackground('fog')), dots: level });

  const label = t(locale, props.root ? 'bg.workspace' : 'bg.network');
  return (
    <>
      <div className="menu-backdrop" onPointerDown={props.onClose} />
      <div
        ref={box}
        className="tab-menu bg-palette"
        role="dialog"
        aria-label={label}
        style={{ left: pos.left, top: pos.top }}
      >
        <div className="tab-menu-header" aria-hidden="true">
          {label}
        </div>
        <div
          ref={row}
          className="bg-row"
          role="listbox"
          aria-label={label}
          aria-activedescendant={`bg-cell-${index}`}
          title={t(locale, 'bg.keys')}
          tabIndex={0}
          onKeyDown={(e) => {
            switch (e.key) {
              case 'ArrowRight':
                setIndex((i) => Math.min(cells.length - 1, i + 1));
                break;
              case 'ArrowLeft':
                setIndex((i) => Math.max(0, i - 1));
                break;
              case 'Home':
                setIndex(0);
                break;
              case 'End':
                setIndex(cells.length - 1);
                break;
              case 'Enter':
              case ' ':
                pick(index);
                break;
              case 'Escape':
                props.onClose();
                break;
              default:
                return;
            }
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          {cells.map((c, i) => {
            const cls = ['bg-cell', `is-${c.t}`];
            if (i === index) cls.push('is-current');
            if (chosen(c)) cls.push('is-chosen');
            return (
              <div
                key={c.t === 'preset' ? c.id : c.t}
                id={`bg-cell-${i}`}
                role="option"
                tabIndex={-1}
                aria-selected={i === index}
                aria-label={name(c)}
                title={name(c)}
                className={cls.join(' ')}
                style={c.t === 'preset' ? { backgroundImage: `url(${swatch(c.id)})` } : undefined}
                onPointerDown={(e) => {
                  // The row keeps the keys.
                  e.preventDefault();
                  setIndex(i);
                  pick(i);
                }}
              />
            );
          })}
        </div>
        <div className="tab-menu-header" aria-hidden="true">
          {t(locale, 'bg.dots')}
        </div>
        <fieldset className="segmented bg-dots">
          <legend className="sr-only">{t(locale, 'bg.dots')}</legend>
          {DOT_LEVELS.map((l) => (
            <label
              key={l.id}
              title={t(locale, `bg.dots.${l.id}Hint`)}
              className={Math.abs(dots - l.dots) < 0.05 ? 'is-active' : undefined}
            >
              <input
                type="radio"
                name="bg-dots"
                value={l.id}
                checked={Math.abs(dots - l.dots) < 0.05}
                onChange={() => pickDots(l.dots)}
                onKeyDown={(e) => {
                  if (e.key !== 'Escape') return;
                  e.preventDefault();
                  props.onClose();
                }}
              />
              <span className="bg-dots-name">{t(locale, `bg.dots.${l.id}`)}</span>
            </label>
          ))}
        </fieldset>
        <input
          ref={file}
          className="sr-only"
          type="file"
          accept="image/*"
          tabIndex={-1}
          aria-label={t(locale, 'bg.own')}
          onChange={(e) => {
            const f = e.currentTarget.files?.[0];
            e.currentTarget.value = '';
            if (f) props.onPicture(f);
          }}
        />
      </div>
    </>
  );
}
