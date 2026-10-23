import { type IconCredits, iconCredits } from '@strata/canvas';
import { type Locale, t } from '@strata/i18n';
import { useEffect, useState } from 'react';
import oflText from './fonts/DepartureMono-OFL.txt?raw';

/**
 * «Благодарности» (07 §3.5, §6.3, ☑ Q-07-3, Q-07-11): Strata's licence, the
 * bundled fonts with their copyright lines and the OFL text, and every
 * game-icons author whose icons ship, with the change CC BY 3.0 §4(b) asks to
 * state. Font lines are copied from each font's LICENSE or, for the board's
 * fonts, from the font's name table and its maker's page.
 */

const FONTS: { family: string; line: string }[] = [
  {
    family: 'Press Start 2P',
    line: 'Copyright 2012 The Press Start 2P Project Authors (cody@zone38.net), with Reserved Font Name “Press Start 2P”. OFL 1.1',
  },
  {
    family: 'Departure Mono',
    line: 'Copyright 2022–2024 Helena Zhang (helenazhang.com). OFL 1.1',
  },
  {
    family: 'Tiny5',
    line: 'Copyright 2022–2024 The Tiny5 Project Authors (github.com/Gissio/font_tiny5). OFL 1.1',
  },
  {
    family: 'Golos Text',
    line: 'Copyright 2019 The Golos Text Project Authors (github.com/googlefonts/golos-text). OFL 1.1',
  },
  {
    family: 'JetBrains Mono',
    line: 'Copyright 2020 The JetBrains Mono Project Authors (github.com/JetBrains/JetBrainsMono). OFL 1.1',
  },
  // Boards (ADR-0006): Excalidraw's subsets, served by the app (vite.config.ts).
  {
    family: 'Nunito',
    line: 'Copyright 2014 The Nunito Project Authors (github.com/googlefonts/nunito). OFL 1.1',
  },
  {
    family: 'Excalifont',
    line: 'Copyright 2024 Excalidraw (plus.excalidraw.com/excalifont). OFL 1.1',
  },
];

/** The OFL itself, without Departure Mono's copyright header. */
const OFL = oflText.slice(oflText.indexOf('This Font Software'));

export function CreditsWindow(props: { locale: Locale; onBack: () => void }) {
  const { locale } = props;
  const [icons, setIcons] = useState<IconCredits | null>(null);

  useEffect(() => {
    iconCredits().then(setIcons);
  }, []);

  const counts = new Map<string, number>();
  for (const { id } of icons?.icons ?? []) {
    const folder = id.split('/')[0] ?? '';
    counts.set(folder, (counts.get(folder) ?? 0) + 1);
  }

  return (
    <section className="window window-credits" aria-labelledby="credits-title">
      <header className="window-title">
        <h1 id="credits-title">{t(locale, 'credits.title')}</h1>
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
        <p className="credits-line" title={t(locale, 'credits.strata')}>
          {t(locale, 'credits.strata')}
        </p>
        <div className="divider" />
        <h2 className="fonts-heading">{t(locale, 'credits.fonts')}</h2>
        <dl className="credits-list">
          {FONTS.map((f) => (
            <div key={f.family} className="fonts-row">
              <dt title={f.family}>{f.family}</dt>
              <dd title={f.line}>{f.line}</dd>
            </div>
          ))}
        </dl>
        <details className="credits-ofl">
          <summary>{t(locale, 'credits.ofl')}</summary>
          <pre>{OFL}</pre>
        </details>
        <div className="divider" />
        <h2 className="fonts-heading">{t(locale, 'credits.icons')}</h2>
        <p className="credits-line" title={t(locale, 'credits.iconsNote')}>
          {t(locale, 'credits.iconsNote')}
        </p>
        {icons ? (
          <dl className="credits-list">
            {Object.entries(icons.authors).map(([folder, a]) => {
              const detail = [
                t(locale, 'credits.iconsCount', { n: counts.get(folder) ?? 0 }),
                a.license,
                a.url,
              ]
                .filter(Boolean)
                .join(' · ');
              return (
                <div key={folder} className="fonts-row">
                  <dt title={a.name}>{a.name}</dt>
                  <dd title={detail}>{detail}</dd>
                </div>
              );
            })}
          </dl>
        ) : (
          <p className="credits-line">{t(locale, 'credits.loading')}</p>
        )}
      </div>
    </section>
  );
}
