import { type Profile, SCENARIO_IDS, type ScenarioId } from '@strata/bench/report';
import { detectLocale, type Locale, t } from '@strata/i18n';
import { useEffect, useState } from 'react';
import { BenchWindow } from './BenchWindow';
import { type BuildInfo, closeAppWindow, loadBuildInfo } from './backend';
import { LocaleSwitch } from './LocaleSwitch';
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

export function App() {
  const [locale, setLocale] = useState<Locale>(() => detectLocale(navigator.languages));
  // `undefined` while loading; `null` in a browser without the core.
  const [info, setInfo] = useState<BuildInfo | null | undefined>(undefined);
  const core = info?.core ?? null;
  const [open, setOpen] = useState(true);
  const [bench, setBench] = useState<Profile | null>(benchFromUrl);
  // `?proto` opens the canvas prototype at start (e2e and quick checks).
  const [proto, setProto] = useState(() =>
    new URLSearchParams(window.location.search).has('proto'),
  );

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

  if (proto) {
    return <Prototype locale={locale} onLocale={setLocale} onClose={() => setProto(false)} />;
  }

  if (bench) {
    return (
      <main className="scene">
        <BenchWindow
          locale={locale}
          app={info ?? { core: null, shell: 'web' }}
          profile={bench}
          only={onlyFromUrl()}
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
            <button type="button" onClick={() => setProto(true)}>
              {t(locale, 'proto.open')}
            </button>
            <button type="button" onClick={() => setBench('full')}>
              {t(locale, 'bench.open')}
            </button>
          </div>
        </div>
      </section>
    </main>
  );
}
