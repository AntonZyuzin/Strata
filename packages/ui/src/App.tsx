import type { Profile } from '@strata/bench/report';
import { detectLocale, type Locale, t } from '@strata/i18n';
import { useEffect, useState } from 'react';
import { BenchWindow } from './BenchWindow';
import { type BuildInfo, closeAppWindow, loadBuildInfo } from './backend';

/** `?bench` opens the benchmark at start; `?bench=quick` is the e2e profile. */
function benchFromUrl(): Profile | null {
  const v = new URLSearchParams(window.location.search).get('bench');
  if (v === null) return null;
  return v === 'quick' ? 'quick' : 'full';
}

export function App() {
  const [locale, setLocale] = useState<Locale>(() => detectLocale(navigator.languages));
  // `undefined` while loading; `null` in a browser without the core.
  const [info, setInfo] = useState<BuildInfo | null | undefined>(undefined);
  const core = info?.core ?? null;
  const [open, setOpen] = useState(true);
  const [bench, setBench] = useState<Profile | null>(benchFromUrl);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(() => {
    loadBuildInfo().then(setInfo);
  }, []);

  const close = async () => {
    if (!(await closeAppWindow())) setOpen(false);
  };

  if (!open) {
    return (
      <main className="scene">
        <button type="button" onClick={() => setOpen(true)}>
          {t(locale, 'window.reopen')}
        </button>
      </main>
    );
  }

  if (bench) {
    return (
      <main className="scene">
        <BenchWindow
          locale={locale}
          app={info ?? { core: null, shell: 'web' }}
          profile={bench}
          autorun={info !== undefined && new URLSearchParams(window.location.search).has('autorun')}
          onBack={() => setBench(null)}
        />
      </main>
    );
  }

  return (
    <main className="scene">
      <section className="window" aria-labelledby="about-title">
        <header className="window-title">
          <h1 id="about-title">{t(locale, 'app.title')}</h1>
          <button
            type="button"
            className="window-close"
            aria-label={t(locale, 'window.close')}
            title={t(locale, 'window.close')}
            onClick={close}
          >
            ×
          </button>
        </header>
        <div className="window-body">
          <p className="tagline" title={t(locale, 'app.tagline')}>
            {t(locale, 'app.tagline')}
          </p>
          <p className="stage" title={t(locale, 'app.stage')}>
            {t(locale, 'app.stage')}
          </p>
          <dl>
            <dt>{t(locale, 'about.core')}</dt>
            <dd title={core ?? undefined}>{core ?? t(locale, 'about.web')}</dd>
            <dt>{t(locale, 'about.language')}</dt>
            <dd>
              <LocaleSwitch
                locale={locale}
                onChange={setLocale}
                label={t(locale, 'about.language')}
              />
            </dd>
          </dl>
          <div className="window-actions">
            <button type="button" onClick={() => setBench('full')}>
              {t(locale, 'bench.open')}
            </button>
          </div>
        </div>
      </section>
    </main>
  );
}

/** Language names are shown in their own language, so they never change with the locale. */
const LOCALES: readonly { id: Locale; short: string; native: string }[] = [
  { id: 'ru', short: 'RU', native: 'Русский' },
  { id: 'en', short: 'EN', native: 'English' },
];

function LocaleSwitch(props: { locale: Locale; onChange: (l: Locale) => void; label: string }) {
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
