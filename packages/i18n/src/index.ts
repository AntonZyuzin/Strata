/**
 * Interface strings, Russian and English from day one (A5 ✅ R2, NFR-107).
 * Every visible string goes through a key; the Russian catalogue is the
 * source of truth for the set of keys, so a missing English key fails typecheck.
 */

export type Locale = 'ru' | 'en';

const ru = {
  'app.title': 'Strata',
  'app.stage': 'Этап 0 · каркас и спайки',
  'app.tagline': 'Нодовая база знаний и проектов',
  'about.core': 'Ядро',
  'about.shell': 'Оболочка',
  'about.web': 'веб, без ядра',
  'about.language': 'Язык',
  'window.close': 'Закрыть',
  'window.reopen': 'Открыть окно',
  'nodes.count': ['{n} нода', '{n} ноды', '{n} нод'],
} as const;

type Catalog = {
  [K in keyof typeof ru]: (typeof ru)[K] extends readonly string[]
    ? readonly [string, string] | readonly [string, string, string]
    : string;
};

const en: Catalog = {
  'app.title': 'Strata',
  'app.stage': 'Stage 0 · scaffold and spikes',
  'app.tagline': 'A node-based base for knowledge and projects',
  'about.core': 'Core',
  'about.shell': 'Shell',
  'about.web': 'web, no core',
  'about.language': 'Language',
  'window.close': 'Close',
  'window.reopen': 'Open window',
  'nodes.count': ['{n} node', '{n} nodes'],
};

const catalogs: Record<Locale, Catalog> = { ru, en };

export type MessageKey = keyof typeof ru;

/** Index into a plural array (CLDR rules for ru and en). */
export function pluralIndex(locale: Locale, n: number): number {
  const abs = Math.abs(Math.trunc(n));
  if (locale === 'en') return abs === 1 ? 0 : 1;
  const mod10 = abs % 10;
  const mod100 = abs % 100;
  if (mod10 === 1 && mod100 !== 11) return 0;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 1;
  return 2;
}

/** Translate `key`; `{name}` placeholders are filled from `params`; `n` picks the plural form. */
export function t(
  locale: Locale,
  key: MessageKey,
  params: Record<string, string | number> = {},
): string {
  const entry = catalogs[locale][key];
  let text: string;
  if (typeof entry === 'string') {
    text = entry;
  } else {
    const n = Number(params.n ?? 0);
    const forms = entry as readonly string[];
    text = forms[Math.min(pluralIndex(locale, n), forms.length - 1)] ?? forms[0] ?? key;
  }
  return text.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`));
}

/** Locale from the system language: Russian for `ru*`, English otherwise. */
export function detectLocale(languages: readonly string[]): Locale {
  return languages.some((l) => l.toLowerCase().startsWith('ru')) ? 'ru' : 'en';
}
