import {
  DEFAULT_STYLE,
  inkShare,
  MASK_SIDE,
  type Pixels,
  STYLE_MODES,
  type StyleMode,
  type StyleParams,
  type StyleResult,
  stylize,
} from '@strata/canvas';
import { fog, palette } from '@strata/design-tokens';
import { type Locale, t } from '@strata/i18n';
import { useEffect, useRef, useState } from 'react';
import { copyText } from './clipboard';

/**
 * «Гравюра» check of spike 9 (07 §6.4–6.5, R7 §8 item 3): the owner adds about
 * 20 different pictures, sees each through «привести к стилю» inside a bubble
 * in three states and marks it good or not. The report counts how many are
 * good with no manual edit — the share 07 §13 asks to record.
 */

/** Pictures are decoded at most this large; the mask is 128 px anyway. */
const DECODE_SIDE = 512;
const PREVIEW = 72;

type Verdict = 'ok' | 'bad' | null;
type PreviewState = 'normal' | 'selected' | 'dimmed';

interface Item {
  id: number;
  name: string;
  url: string;
  px: Pixels;
  params: StyleParams;
  result: StyleResult;
  ms: number;
  edited: boolean;
  verdict: Verdict;
}

/** Decodes any image the WebView can show; SVG goes through <img>, so no script runs (07 §6.4). */
async function decode(file: File): Promise<{ url: string; px: Pixels }> {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.src = url;
  await img.decode();
  const k = Math.min(1, DECODE_SIDE / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
  const w = Math.max(1, Math.round((img.naturalWidth || DECODE_SIDE) * k));
  const h = Math.max(1, Math.round((img.naturalHeight || DECODE_SIDE) * k));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas is not available');
  ctx.drawImage(img, 0, 0, w, h);
  return { url, px: { width: w, height: h, data: ctx.getImageData(0, 0, w, h).data } };
}

function run(px: Pixels, params: StyleParams): { result: StyleResult; ms: number } {
  const t0 = performance.now();
  const result = stylize(px, params);
  return { result, ms: performance.now() - t0 };
}

/** The mask inside a bubble as the Scene would draw it (07 §4.1, §4.5), on a 2D canvas. */
function Preview(props: { mask: Uint8ClampedArray; state: PreviewState }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(PREVIEW * dpr);
    canvas.height = Math.round(PREVIEW * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, PREVIEW, PREVIEW);
    const c = PREVIEW / 2;
    const r = 24;
    const dimmed = props.state === 'dimmed';
    ctx.globalAlpha = dimmed ? fog.scene.doneAlpha : 1;
    ctx.fillStyle = dimmed ? fog.scene.doneFill : palette.paper;
    ctx.beginPath();
    ctx.arc(c, c, r, 0, Math.PI * 2);
    ctx.fill();
    // The mask as ink: alpha from the mask, colour from the state.
    const ink = document.createElement('canvas');
    ink.width = MASK_SIDE;
    ink.height = MASK_SIDE;
    const ictx = ink.getContext('2d');
    if (!ictx) return;
    const img = ictx.createImageData(MASK_SIDE, MASK_SIDE);
    const color = dimmed ? fog.scene.doneInk : palette.ink850;
    const [rr, gg, bb] = [1, 3, 5].map((i) => Number.parseInt(color.slice(i, i + 2), 16));
    for (let i = 0; i < props.mask.length; i++) {
      img.data[i * 4] = rr ?? 0;
      img.data[i * 4 + 1] = gg ?? 0;
      img.data[i * 4 + 2] = bb ?? 0;
      img.data[i * 4 + 3] = props.mask[i] ?? 0;
    }
    ictx.putImageData(img, 0, 0);
    const side = 0.55 * 2 * r;
    ctx.save();
    ctx.beginPath();
    ctx.arc(c, c, r - 1, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(ink, c - side / 2, c - side / 2, side, side);
    ctx.restore();
    ctx.globalAlpha = (dimmed ? fog.scene.doneAlpha : 1) * fog.scene.rimAlpha;
    ctx.strokeStyle = palette.ink850;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(c, c, r - 0.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
    if (props.state === 'selected') {
      ctx.strokeStyle = palette.paper;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(c, c, r + 6, 0, Math.PI * 2);
      ctx.stroke();
      const k = r + 8;
      ctx.lineWidth = 1;
      for (const [sx, sy] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ] as const) {
        ctx.beginPath();
        ctx.moveTo(c + sx * k, c + sy * k - sy * 4);
        ctx.lineTo(c + sx * k, c + sy * k);
        ctx.lineTo(c + sx * k - sx * 4, c + sy * k);
        ctx.stroke();
      }
    }
  }, [props.mask, props.state]);
  return <canvas ref={ref} className="engraving-preview" />;
}

export function EngravingWindow(props: { locale: Locale; onBack: () => void }) {
  const { locale } = props;
  const [items, setItems] = useState<Item[]>([]);
  const [copy, setCopy] = useState<'none' | 'copied' | 'failed'>('none');
  const nextId = useRef(1);
  const input = useRef<HTMLInputElement>(null);
  const urls = useRef<string[]>([]);

  // Object URLs of the originals live as long as the window.
  useEffect(
    () => () => {
      for (const u of urls.current) URL.revokeObjectURL(u);
    },
    [],
  );

  const add = async (files: Iterable<File>) => {
    const added: Item[] = [];
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue;
      try {
        const { url, px } = await decode(file);
        urls.current.push(url);
        const params = { ...DEFAULT_STYLE };
        added.push({
          id: nextId.current++,
          name: file.name,
          url,
          px,
          params,
          ...run(px, params),
          edited: false,
          verdict: null,
        });
      } catch {
        // A file the WebView cannot decode is skipped; the count shows what was taken.
      }
    }
    setItems((xs) => [...xs, ...added]);
    setCopy('none');
  };

  const update = (id: number, change: Partial<StyleParams>) =>
    setItems((xs) =>
      xs.map((x) => {
        if (x.id !== id) return x;
        const params = { ...x.params, ...change };
        return { ...x, params, ...run(x.px, params), edited: true };
      }),
    );

  const judge = (id: number, verdict: Verdict) =>
    setItems((xs) => xs.map((x) => (x.id === id ? { ...x, verdict } : x)));

  const rated = items.filter((x) => x.verdict !== null);
  const okNoEdit = items.filter((x) => x.verdict === 'ok' && !x.edited).length;
  const report = {
    kind: 'strata-engraving-report',
    version: 1,
    userAgent: navigator.userAgent,
    total: items.length,
    rated: rated.length,
    okNoEdit,
    items: items.map((x) => ({
      name: x.name,
      width: x.px.width,
      height: x.px.height,
      mode: x.params.mode,
      threshold: x.result.threshold,
      auto: x.params.threshold === null,
      invert: x.params.invert,
      background: x.result.background,
      ink: Number(inkShare(x.result.mask).toFixed(3)),
      ms: Number(x.ms.toFixed(1)),
      edited: x.edited,
      verdict: x.verdict,
    })),
  };
  const summary = t(locale, 'engraving.summary', {
    ok: okNoEdit,
    total: items.length,
    rated: rated.length,
  });
  const copyStatus =
    copy === 'copied'
      ? t(locale, 'engraving.copied')
      : copy === 'failed'
        ? t(locale, 'engraving.copyFailed')
        : '';

  return (
    <section
      className="window window-engraving"
      aria-labelledby="engraving-title"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        add(e.dataTransfer.files);
      }}
    >
      <header className="window-title">
        <h1 id="engraving-title">{t(locale, 'engraving.title')}</h1>
        <button
          type="button"
          className="window-close"
          aria-label={t(locale, 'window.back')}
          title={t(locale, 'window.back')}
          onClick={props.onBack}
        >
          ×
        </button>
      </header>
      <div className="window-body">
        <p className="credits-line" title={t(locale, 'engraving.hint')}>
          {t(locale, 'engraving.hint')}
        </p>
        <div className="window-actions engraving-actions">
          <button type="button" onClick={() => input.current?.click()}>
            {t(locale, 'engraving.pick')}
          </button>
          <input
            ref={input}
            className="sr-only"
            type="file"
            accept="image/*"
            multiple
            tabIndex={-1}
            aria-label={t(locale, 'engraving.pick')}
            onChange={(e) => {
              const files = [...(e.currentTarget.files ?? [])];
              e.currentTarget.value = '';
              add(files);
            }}
          />
          <span className="engraving-summary" title={summary}>
            {summary}
          </span>
          <button
            type="button"
            disabled={items.length === 0}
            onClick={async () =>
              setCopy((await copyText(JSON.stringify(report, null, 2))) ? 'copied' : 'failed')
            }
          >
            {t(locale, 'engraving.copy')}
          </button>
        </div>
        <p className="status engraving-status" aria-live="polite">
          {copyStatus}
        </p>
        <div className="divider" />
        {items.length === 0 ? (
          <p className="engraving-drop">{t(locale, 'engraving.drop')}</p>
        ) : (
          <ul className="engraving-list">
            {items.map((x) => (
              <li key={x.id} className="engraving-row" data-verdict={x.verdict ?? ''}>
                <img className="engraving-original" src={x.url} alt="" />
                <div className="engraving-previews" title={t(locale, 'engraving.states')}>
                  <Preview mask={x.result.mask} state="normal" />
                  <Preview mask={x.result.mask} state="selected" />
                  <Preview mask={x.result.mask} state="dimmed" />
                </div>
                <div className="engraving-meta">
                  <span className="engraving-name" title={x.name}>
                    {x.name}
                    {x.edited ? ` · ${t(locale, 'engraving.edited')}` : ''}
                  </span>
                  <div className="engraving-controls">
                    <select
                      className="field"
                      aria-label={t(locale, 'engraving.mode')}
                      value={x.params.mode}
                      onChange={(e) => update(x.id, { mode: e.currentTarget.value as StyleMode })}
                    >
                      {STYLE_MODES.map((m) => (
                        <option key={m} value={m}>
                          {t(locale, `engraving.mode.${m}` as const)}
                        </option>
                      ))}
                    </select>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={x.params.invert}
                        onChange={(e) => update(x.id, { invert: e.currentTarget.checked })}
                      />
                      <span>{t(locale, 'engraving.invert')}</span>
                    </label>
                  </div>
                  <div className="engraving-controls">
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={x.params.threshold === null}
                        onChange={(e) =>
                          update(x.id, {
                            threshold: e.currentTarget.checked ? null : x.result.threshold,
                          })
                        }
                      />
                      <span>{t(locale, 'engraving.auto')}</span>
                    </label>
                    <input
                      className="engraving-threshold"
                      type="range"
                      min={0}
                      max={255}
                      aria-label={t(locale, 'engraving.threshold')}
                      value={x.result.threshold}
                      disabled={x.params.threshold === null}
                      onChange={(e) => update(x.id, { threshold: Number(e.currentTarget.value) })}
                    />
                  </div>
                </div>
                <div className="engraving-verdict">
                  <button
                    type="button"
                    className={x.verdict === 'ok' ? 'is-default' : undefined}
                    aria-pressed={x.verdict === 'ok'}
                    onClick={() => judge(x.id, 'ok')}
                  >
                    {t(locale, 'engraving.ok')}
                  </button>
                  <button
                    type="button"
                    className={x.verdict === 'bad' ? 'is-default' : undefined}
                    aria-pressed={x.verdict === 'bad'}
                    onClick={() => judge(x.id, 'bad')}
                  >
                    {t(locale, 'engraving.bad')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
