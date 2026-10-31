import { type IconCredits, iconCredits } from '@strata/canvas';
import { type Locale, t } from '@strata/i18n';
import { useEffect, useState } from 'react';
import oflText from './fonts/DepartureMono-OFL.txt?raw';
import { ICON_FILES } from './icons/Icon';
import bsdText from './icons/serenity/LICENSE?raw';

/**
 * «Благодарности» (07 §3.5, §6.3, ☑ Q-07-3, Q-07-11): Strata's licence, the
 * bundled fonts with their copyright lines and the OFL text, and every
 * game-icons author whose icons ship, with the change CC BY 3.0 §4(b) asks to
 * state, SerenityOS's Chrome icons with their BSD 2-Clause text, and pdf.js
 * with the files it ships. Font lines are copied from each font's LICENSE or, for the board's
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

/** The Chrome's icons (07 §6.2), copied unchanged from SerenityOS. */
const SERENITY = {
  name: 'SerenityOS',
  line: 'Copyright (c) 2018-2026, the SerenityOS developers. BSD 2-Clause · github.com/SerenityOS/serenity',
};

/**
 * pdf.js and what it fetches beside its code (ADR-0013), shipped in `pdfjs/`
 * with each licence text (vite.config.ts); for PDFs a WebView cannot show.
 */
const PDF: { name: string; line: string }[] = [
  { name: 'pdf.js', line: 'Copyright Mozilla Foundation. Apache-2.0 · github.com/mozilla/pdf.js' },
  { name: 'Foxit', line: 'Copyright 2014 PDFium Authors. BSD 3-Clause' },
  { name: 'Adobe CMaps', line: 'Copyright 1990–2009 Adobe Systems Incorporated. BSD 3-Clause' },
  {
    name: 'OpenJPEG',
    line: 'Copyright 2002–2014 Université catholique de Louvain (UCL) and the OpenJPEG authors; 2024 Mozilla Foundation. BSD 2-Clause',
  },
  {
    name: 'JBIG2',
    line: 'Copyright 2014 The PDFium Authors. BSD 3-Clause; 2026 Mozilla Foundation. Apache-2.0',
  },
  {
    name: 'qcms',
    line: 'Copyright 2009–2024 Mozilla Corporation, 1998–2007 Marti Maria. MIT',
  },
  { name: 'CGATS001Compat', line: 'ICC profile. CC0 1.0' },
];

/** The OFL itself, without Departure Mono's copyright header. */
const OFL = oflText.slice(oflText.indexOf('This Font Software'));

export function CreditsWindow(props: { locale: Locale; onBack: () => void }) {
  const { locale } = props;
  const [icons, setIcons] = useState<IconCredits | null>(null);

  useEffect(() => {
    iconCredits().then(setIcons);
  }, []);

  const serenity = `${t(locale, 'credits.iconsCount', { n: ICON_FILES })} · ${SERENITY.line}`;
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
        <h2 className="fonts-heading">{t(locale, 'credits.uiIcons')}</h2>
        <dl className="credits-list">
          <div className="fonts-row">
            <dt title={SERENITY.name}>{SERENITY.name}</dt>
            <dd title={serenity}>{serenity}</dd>
          </div>
        </dl>
        <details className="credits-ofl">
          <summary>{t(locale, 'credits.bsd')}</summary>
          <pre>{bsdText}</pre>
        </details>
        <div className="divider" />
        <h2 className="fonts-heading">{t(locale, 'credits.pdf')}</h2>
        <dl className="credits-list">
          {PDF.map((p) => (
            <div key={p.name} className="fonts-row">
              <dt title={p.name}>{p.name}</dt>
              <dd title={p.line}>{p.line}</dd>
            </div>
          ))}
        </dl>
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
