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
  'bench.open': 'Бенчмарк',
  'bench.title': 'Бенчмарк',
  'bench.back': 'Назад',
  'bench.hint': 'Около минуты. Окно не сворачивать и не трогать.',
  'bench.run': 'Запустить',
  'bench.copy': 'Копировать отчёт',
  'bench.copied': 'Отчёт скопирован',
  'bench.copyFailed': 'Не скопировалось — выделите текст ниже',
  'bench.failed': 'Не запустился: {message}',
  'bench.progress': '{done} из {total} · {name}',
  'bench.pending': '—',
  'bench.running': 'идёт…',
  'bench.s.canvas-pan-zoom-n5k': 'Холст 5 тыс., зум',
  'bench.s.canvas-drag-n5k': 'Холст 5 тыс., тянем 100',
  'bench.s.canvas-pan-zoom-n10k': 'Холст 10 тыс., зум',
  'bench.s.loro-index-20k': 'Индекс 20 тыс.',
  'bench.s.loro-index-100k': 'Индекс 100 тыс.',
  'bench.s.loro-text-1mb': 'Текст 1 МБ',
  'bench.r.canvas': '{fps} fps · p95 {p95} мс',
  'bench.r.index': 'импорт {importMs} мс · правка {editMean} мс (макс. {editMax})',
  'bench.r.text': '1 МБ за {insertMs} мс · клавиша {keyMean} мс (макс. {keyMax})',
  'bench.r.error': 'ошибка: {message}',
} as const;

type Catalog = {
  [K in keyof typeof ru]: (typeof ru)[K] extends readonly string[]
    ? readonly [string, string] | readonly [string, string, string]
    : string;
};

const en: Catalog = {
  'app.title': 'Strata',
  'app.stage': 'Stage 0 · scaffold and spikes',
  'app.tagline': 'Node-based knowledge and projects',
  'about.core': 'Core',
  'about.shell': 'Shell',
  'about.web': 'web, no core',
  'about.language': 'Language',
  'window.close': 'Close',
  'window.reopen': 'Open window',
  'nodes.count': ['{n} node', '{n} nodes'],
  'bench.open': 'Benchmark',
  'bench.title': 'Benchmark',
  'bench.back': 'Back',
  'bench.hint': 'About a minute. Keep the window in front, hands off.',
  'bench.run': 'Run',
  'bench.copy': 'Copy report',
  'bench.copied': 'Report copied',
  'bench.copyFailed': 'Copy failed — select the text below',
  'bench.failed': 'Failed to start: {message}',
  'bench.progress': '{done} of {total} · {name}',
  'bench.pending': '—',
  'bench.running': 'running…',
  'bench.s.canvas-pan-zoom-n5k': 'Canvas 5k, zoom',
  'bench.s.canvas-drag-n5k': 'Canvas 5k, drag 100',
  'bench.s.canvas-pan-zoom-n10k': 'Canvas 10k, zoom',
  'bench.s.loro-index-20k': 'Index 20k',
  'bench.s.loro-index-100k': 'Index 100k',
  'bench.s.loro-text-1mb': 'Text 1 MB',
  'bench.r.canvas': '{fps} fps · p95 {p95} ms',
  'bench.r.index': 'import {importMs} ms · edit {editMean} ms (max {editMax})',
  'bench.r.text': '1 MB in {insertMs} ms · key {keyMean} ms (max {keyMax})',
  'bench.r.error': 'error: {message}',
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

/** A number in the locale's notation (decimal comma and thin grouping in Russian). */
export function formatNumber(locale: Locale, n: number, maxFractionDigits = 1): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: maxFractionDigits }).format(n);
}

/** Locale from the system language: Russian for `ru*`, English otherwise. */
export function detectLocale(languages: readonly string[]): Locale {
  return languages.some((l) => l.toLowerCase().startsWith('ru')) ? 'ru' : 'en';
}
