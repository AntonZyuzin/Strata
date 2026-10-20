import { detectLocale, type Locale, t } from '@strata/i18n';
import { useEffect, useState } from 'react';
import { closeAppWindow, loadBuildInfo } from './backend';

export function App() {
  const [locale, setLocale] = useState<Locale>(() => detectLocale(navigator.languages));
  const [core, setCore] = useState<string | null>(null);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(() => {
    loadBuildInfo().then((info) => setCore(info?.core ?? null));
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
          <p className="tagline">{t(locale, 'app.tagline')}</p>
          <p className="stage">{t(locale, 'app.stage')}</p>
          <dl>
            <dt>{t(locale, 'about.core')}</dt>
            <dd>{core ?? t(locale, 'about.web')}</dd>
            <dt>{t(locale, 'about.language')}</dt>
            <dd>
              <button type="button" onClick={() => setLocale(locale === 'ru' ? 'en' : 'ru')}>
                {locale === 'ru' ? 'RU → EN' : 'EN → RU'}
              </button>
            </dd>
          </dl>
        </div>
      </section>
    </main>
  );
}
