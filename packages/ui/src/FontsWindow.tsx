import { glyphUrl, pixelMetrics } from '@strata/design-tokens';
import { formatNumber, type Locale, type MessageKey, t } from '@strata/i18n';
import { type CSSProperties, useEffect, useState } from 'react';
import { LocaleSwitch } from './LocaleSwitch';
import { type PixelPrefs, SCALES, setPixelPrefs } from './pixel';

/**
 * Font and window check of spike 9 (07 §13, R7 §8 item 2): every bundled font
 * in Russian and English at the current DPR, the pixel unit and sizes it gives,
 * the interface scale (07 §11.4) and the retro components on tokens. The owner
 * opens it on the Mac (DPR 2) and the PC (DPR 1, 1.25 or 1.5) and says whether
 * the text is crisp.
 */

interface Row {
  font: string;
  size: string;
  style: CSSProperties;
  /** Outline fonts keep their smoothing; pixel fonts are drawn without it (07 §3.3). */
  smooth?: boolean;
}

const ROWS: Row[] = [
  {
    font: 'Departure Mono',
    size: 'ui',
    style: { font: 'var(--st-font-ui-size) / var(--st-font-ui-line) var(--st-font-ui)' },
  },
  {
    font: 'Departure Mono',
    size: 'ui × 2',
    style: {
      font: 'calc(2 * var(--st-font-ui-size)) / calc(2 * var(--st-font-ui-line)) var(--st-font-ui)',
    },
  },
  {
    font: 'Press Start 2P',
    size: 'display-s',
    style: {
      font: 'var(--st-font-display-s-size) / var(--st-font-display-s-line) var(--st-font-display)',
    },
  },
  {
    font: 'Press Start 2P',
    size: 'display-m',
    style: {
      font: 'var(--st-font-display-m-size) / var(--st-font-display-m-line) var(--st-font-display)',
    },
  },
  {
    font: 'Tiny5',
    size: 'ui-prop',
    style: {
      font: 'var(--st-font-ui-prop-size) / var(--st-font-ui-prop-line) var(--st-font-ui-prop)',
    },
  },
  {
    font: 'Golos Text',
    size: '16 px',
    style: { font: '16px / 1.5 var(--st-font-text)' },
    smooth: true,
  },
  {
    font: 'JetBrains Mono',
    size: '14 px',
    style: { font: '14px / 1.5 var(--st-font-mono)' },
    smooth: true,
  },
];

const SAMPLES: MessageKey[] = ['fonts.sample.ru', 'fonts.sample.en', 'fonts.sample.extra'];

function useDpr(): number {
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1);
  useEffect(() => {
    const update = () => setDpr(window.devicePixelRatio || 1);
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  return dpr;
}

export function FontsWindow(props: {
  locale: Locale;
  onLocale: (l: Locale) => void;
  prefs: PixelPrefs;
  onPrefs: (p: PixelPrefs) => void;
  onBack: () => void;
}) {
  const { locale, prefs } = props;
  const dpr = useDpr();
  const m = pixelMetrics(dpr, prefs.scale);
  const set = (p: PixelPrefs) => {
    setPixelPrefs(p);
    props.onPrefs(p);
  };
  const metrics = t(locale, 'fonts.metrics', {
    dpr: formatNumber(locale, dpr, 2),
    u: m.u,
    ui: m.font.ui.physical,
  });

  return (
    <section className="window window-fonts" aria-labelledby="fonts-title">
      <header className="window-title">
        <h1 id="fonts-title">{t(locale, 'fonts.title')}</h1>
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
        <div className="fonts-controls">
          <span className="fonts-metrics" title={metrics}>
            {metrics}
          </span>
          <LocaleSwitch
            locale={locale}
            onChange={props.onLocale}
            label={t(locale, 'about.language')}
          />
          <fieldset className="segmented">
            <legend className="sr-only">{t(locale, 'fonts.scale')}</legend>
            {SCALES.map((s) => (
              <label key={s} className={prefs.scale === s ? 'is-active' : undefined}>
                <input
                  type="radio"
                  name="scale"
                  checked={prefs.scale === s}
                  onChange={() => set({ ...prefs, scale: s })}
                />
                <span>{`${s * 100}%`}</span>
              </label>
            ))}
          </fieldset>
        </div>
        <div className="divider" />
        <dl className="fonts-specimens">
          {ROWS.map((row) => {
            const name = t(locale, 'fonts.row', { font: row.font, size: row.size });
            return (
              <div key={name} className="fonts-row">
                <dt title={name}>{name}</dt>
                <dd>
                  {SAMPLES.map((k) => (
                    <span
                      key={k}
                      className={row.smooth ? 'fonts-sample is-smooth' : 'fonts-sample'}
                      style={row.style}
                      title={t(locale, k)}
                    >
                      {t(locale, k)}
                    </span>
                  ))}
                </dd>
              </div>
            );
          })}
        </dl>
        <div className="divider" />
        <h2 className="fonts-heading">{t(locale, 'fonts.components')}</h2>
        <div className="demo">
          <div className="demo-row">
            <button type="button">{t(locale, 'demo.button')}</button>
            <button type="button" className="is-default">
              {t(locale, 'demo.default')}
            </button>
            <button type="button" disabled>
              {t(locale, 'demo.disabled')}
            </button>
          </div>
          <div className="demo-row">
            <input
              className="field"
              aria-label={t(locale, 'demo.field')}
              placeholder={t(locale, 'demo.field')}
            />
            <label className="check">
              <input type="checkbox" defaultChecked />
              <span>{t(locale, 'demo.check')}</span>
            </label>
            <label className="check">
              <input type="radio" name="demo-radio" defaultChecked />
              <span>{t(locale, 'demo.radio')}</span>
            </label>
          </div>
          <div className="demo-row">
            <div
              className="progress"
              role="progressbar"
              aria-valuenow={60}
              aria-label={t(locale, 'demo.progress')}
            >
              <span className="progress-title">{t(locale, 'demo.progress')}</span>
              <span className="progress-track">
                {Array.from({ length: 12 }, (_, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: fixed segments
                  <i key={i} className={i < 7 ? 'is-on' : undefined} />
                ))}
              </span>
            </div>
          </div>
          <div className="demo-row">
            <span className="plate plate-attention">
              <span
                className="kind-icon"
                style={{ '--glyph': glyphUrl('hourglass') } as CSSProperties}
              />
              {t(locale, 'demo.attention')}
            </span>
            <span className="plate plate-overdue">
              <span
                className="kind-icon"
                style={{ '--glyph': glyphUrl('bang') } as CSSProperties}
              />
              {t(locale, 'demo.overdue')}
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
