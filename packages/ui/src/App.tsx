import { type Profile, SCENARIO_IDS, type ScenarioId } from '@strata/bench/report';
import { detectLocale, type Locale, t } from '@strata/i18n';
import { useEffect, useState } from 'react';
import { BenchWindow } from './BenchWindow';
import { type BuildInfo, closeAppWindow, loadBuildInfo } from './backend';
import { CreditsWindow } from './CreditsWindow';
import { EngravingWindow } from './EngravingWindow';
import { FontsWindow } from './FontsWindow';
import { LocaleSwitch } from './LocaleSwitch';
import { loadPixelPrefs, type PixelPrefs } from './pixel';
import { Prototype } from './proto/Prototype';

/** `?bench` opens the benchmark at start; `?bench=quick` is the e2e profile; `?only=` picks scenarios. */
function benchFromUrl(): Profile | null {
  const v = new URLSearchParams(window.location.search).get('bench');
  if (v === null) return null;
  return v === 'quick' ? 'quick' : 'full';
}

function onlyFromUrl(): ScenarioId[] | undefined {
  const v = new URLSearchParams(window.location.search).get('only');
  if (!v) return undefined;
  const ids = v.split(',').filter((id): id is ScenarioId => SCENARIO_IDS.some((s) => s === id));
  return ids.length > 0 ? ids : undefined;
}

type Screen = 'about' | 'proto' | 'bench' | 'fonts' | 'engraving' | 'credits';

/** `?proto`, `?bench`, `?fonts`, `?engraving` and `?credits` open a screen at start (e2e and quick checks). */
function screenFromUrl(): Screen {
  const q = new URLSearchParams(window.location.search);
  if (q.has('proto')) return 'proto';
  if (q.has('bench')) return 'bench';
  if (q.has('fonts')) return 'fonts';
  if (q.has('engraving')) return 'engraving';
  if (q.has('credits')) return 'credits';
  return 'about';
}

export function App() {
  const [locale, setLocale] = useState<Locale>(() => detectLocale(navigator.languages));
  // `undefined` while loading; `null` in a browser without the core.
  const [info, setInfo] = useState<BuildInfo | null | undefined>(undefined);
  const core = info?.core ?? null;
  const [open, setOpen] = useState(true);
  const [screen, setScreen] = useState<Screen>(screenFromUrl);
  const [bench, setBench] = useState<Profile>(() => benchFromUrl() ?? 'full');
  const [pixel, setPixel] = useState<PixelPrefs>(loadPixelPrefs);

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

  if (screen === 'proto') {
    return <Prototype locale={locale} onLocale={setLocale} onClose={() => setScreen('about')} />;
  }

  if (screen === 'bench') {
    return (
      <main className="scene">
        <BenchWindow
          locale={locale}
          app={info ?? { core: null, shell: 'web' }}
          profile={bench}
          only={onlyFromUrl()}
          autorun={info !== undefined && new URLSearchParams(window.location.search).has('autorun')}
          onBack={() => setScreen('about')}
        />
      </main>
    );
  }

  if (screen === 'fonts') {
    return (
      <main className="scene">
        <FontsWindow
          locale={locale}
          onLocale={setLocale}
          prefs={pixel}
          onPrefs={setPixel}
          onBack={() => setScreen('about')}
        />
      </main>
    );
  }

  if (screen === 'engraving') {
    return (
      <main className="scene">
        <EngravingWindow locale={locale} onBack={() => setScreen('about')} />
      </main>
    );
  }

  if (screen === 'credits') {
    return (
      <main className="scene">
        <CreditsWindow locale={locale} onBack={() => setScreen('about')} />
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
          <div className="about-actions">
            <button
              type="button"
              title={t(locale, 'proto.open')}
              onClick={() => setScreen('proto')}
            >
              {t(locale, 'proto.open')}
            </button>
            <button
              type="button"
              title={t(locale, 'fonts.open')}
              onClick={() => setScreen('fonts')}
            >
              {t(locale, 'fonts.open')}
            </button>
            <button
              type="button"
              title={t(locale, 'bench.open')}
              onClick={() => {
                setBench('full');
                setScreen('bench');
              }}
            >
              {t(locale, 'bench.open')}
            </button>
            <button
              type="button"
              title={t(locale, 'engraving.open')}
              onClick={() => setScreen('engraving')}
            >
              {t(locale, 'engraving.open')}
            </button>
            <button
              type="button"
              title={t(locale, 'credits.open')}
              onClick={() => setScreen('credits')}
            >
              {t(locale, 'credits.open')}
            </button>
          </div>
        </div>
      </section>
    </main>
  );
}
