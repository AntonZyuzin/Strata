import type { HomeBackend } from '@strata/backend';
import { type Locale, type MessageKey, t } from '@strata/i18n';
import { useEffect, useState } from 'react';
import { LocaleSwitch } from '../LocaleSwitch';
import { CLOCKS, DATE_FORMATS, type Prefs } from '../prefs';

/**
 * «Настройки» (✅ Q-06-23, owner 2026-10-24): a tab of the bar, like a
 * browser's or Figma's settings, with what belongs to the device rather
 * than to a workspace — the profile that signs changes (✅ Q-16-14), the
 * language, how dates and times read (05 §6.1), «О программе». The same
 * grid as the properties panel; nothing explains itself in words.
 */
export function SettingsScreen(props: {
  locale: Locale;
  home: HomeBackend;
  prefs: Prefs;
  onPrefs: (p: Prefs) => void;
  onAbout: () => void;
}) {
  const { locale, home, prefs, onPrefs } = props;
  const [saved, setSaved] = useState<string | null>(null);
  const [name, setName] = useState('');

  useEffect(() => {
    let live = true;
    void home.home().then((s) => {
      if (!live) return;
      setSaved(s.profile.name);
      setName(s.profile.name);
    });
    return () => {
      live = false;
    };
  }, [home]);

  const saveName = () => {
    const v = name.trim();
    if (saved === null || v === saved) return;
    void home.setProfile({ name: v }).then((s) => setSaved(s.profile.name));
  };

  return (
    <main className="settings" aria-labelledby="settings-title" data-profile={saved ?? ''}>
      <div className="settings-page">
        {/* The tab already says «Настройки»: the page's name is for screen readers only. */}
        <h1 className="sr-only" id="settings-title">
          {t(locale, 'settings.title')}
        </h1>
        <section className="ins-section">
          <h2 className="ins-heading">{t(locale, 'settings.profile')}</h2>
          <dl className="ins-fields">
            <dt className="ins-label">{t(locale, 'settings.name')}</dt>
            <dd className="ins-value">
              <input
                className="field"
                aria-label={t(locale, 'settings.name')}
                title={t(locale, 'home.profileHint')}
                placeholder={t(locale, 'home.profilePlaceholder')}
                maxLength={80}
                value={name}
                onChange={(e) => setName(e.currentTarget.value)}
                onBlur={saveName}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                }}
              />
            </dd>
          </dl>
        </section>
        <section className="ins-section">
          <h2 className="ins-heading">{t(locale, 'settings.format')}</h2>
          <dl className="ins-fields">
            <dt className="ins-label">{t(locale, 'about.language')}</dt>
            <dd className="ins-value">
              <LocaleSwitch
                locale={locale}
                onChange={(l) => onPrefs({ ...prefs, locale: l })}
                label={t(locale, 'about.language')}
              />
            </dd>
            <dt className="ins-label">{t(locale, 'settings.dateFormat')}</dt>
            <dd className="ins-value">
              <select
                className="field"
                aria-label={t(locale, 'settings.dateFormat')}
                value={prefs.date}
                onChange={(e) =>
                  onPrefs({ ...prefs, date: e.currentTarget.value as Prefs['date'] })
                }
              >
                <option value="auto">{t(locale, 'settings.auto')}</option>
                {DATE_FORMATS.map((f) => (
                  <option key={f} value={f}>
                    {t(locale, `settings.date.${f}` as MessageKey)}
                  </option>
                ))}
              </select>
            </dd>
            <dt className="ins-label">{t(locale, 'settings.clock')}</dt>
            <dd className="ins-value">
              <select
                className="field"
                aria-label={t(locale, 'settings.clock')}
                value={prefs.clock}
                onChange={(e) =>
                  onPrefs({ ...prefs, clock: e.currentTarget.value as Prefs['clock'] })
                }
              >
                <option value="auto">{t(locale, 'settings.auto')}</option>
                {CLOCKS.map((c) => (
                  <option key={c} value={c}>
                    {t(locale, `settings.clock.${c}` as MessageKey)}
                  </option>
                ))}
              </select>
            </dd>
          </dl>
        </section>
        <section className="ins-section">
          <button type="button" className="settings-about" onClick={props.onAbout}>
            {t(locale, 'home.about')}
          </button>
        </section>
      </div>
    </main>
  );
}
