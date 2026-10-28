import type { HomeBackend } from '@strata/backend';
import { type Locale, type MessageKey, t } from '@strata/i18n';
import { useEffect, useRef, useState } from 'react';
import { LocaleSwitch } from '../LocaleSwitch';
import { CLOCKS, DATE_FORMATS, type Prefs, RING_MODES } from '../prefs';

/**
 * «Настройки» (✅ Q-06-23): a window the gear opens under itself (owner,
 * 2026-10-28: no tab — it only repeated the gear), with what belongs to the
 * device rather than to a workspace — the profile that signs changes
 * (✅ Q-16-14), the language, how dates and times read (05 §6.1), the
 * canvas, «О программе». The same grid as the properties panel; nothing
 * explains itself in words. The gear, its ×, `Esc` or a click elsewhere
 * closes it.
 */
export function SettingsScreen(props: {
  locale: Locale;
  home: HomeBackend;
  prefs: Prefs;
  onPrefs: (p: Prefs) => void;
  onAbout: () => void;
  onClose: () => void;
}) {
  const { locale, home, prefs, onPrefs, onClose } = props;
  const box = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  // In front with the keyboard once, when it opens; a press elsewhere closes
  // it, the gear's own press is the gear's (it closes it by its click).
  useEffect(() => {
    box.current?.focus();
    const away = (e: PointerEvent) => {
      const at = e.target instanceof Element ? e.target : null;
      if (box.current?.contains(at) || at?.closest('.tabbar-settings')) return;
      close.current();
    };
    window.addEventListener('pointerdown', away, true);
    return () => window.removeEventListener('pointerdown', away, true);
  }, []);
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
    <section
      ref={box}
      className="window settings"
      role="dialog"
      aria-labelledby="settings-title"
      data-profile={saved ?? ''}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <header className="window-title">
        <h2 id="settings-title">{t(locale, 'settings.title')}</h2>
        <button
          type="button"
          className="window-close"
          aria-label={t(locale, 'settings.close')}
          title={t(locale, 'settings.close')}
          onClick={onClose}
        >
          ×
        </button>
      </header>
      <div className="settings-page">
        <section className="ins-section">
          <h3 className="ins-heading">{t(locale, 'settings.profile')}</h3>
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
          <h3 className="ins-heading">{t(locale, 'settings.format')}</h3>
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
          <h3 className="ins-heading">{t(locale, 'settings.canvas')}</h3>
          <dl className="ins-fields">
            <dt className="ins-label">{t(locale, 'settings.ring')}</dt>
            <dd className="ins-value">
              <select
                className="field"
                aria-label={t(locale, 'settings.ring')}
                value={prefs.ring}
                onChange={(e) =>
                  onPrefs({ ...prefs, ring: e.currentTarget.value as Prefs['ring'] })
                }
              >
                {RING_MODES.map((m) => (
                  <option key={m} value={m}>
                    {t(locale, `settings.ring.${m}` as MessageKey)}
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
    </section>
  );
}
