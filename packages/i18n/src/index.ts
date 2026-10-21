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
  'bench.hint': 'Около трёх минут. Ноутбук на зарядке, окно не трогать.',
  'bench.run': 'Запустить',
  'bench.copy': 'Копировать отчёт',
  'bench.copied': 'Отчёт скопирован',
  'bench.copyFailed': 'Не скопировалось — выделите текст ниже',
  'bench.failed': 'Не запустился: {message}',
  'bench.progress': '{done} из {total} · {name}',
  'bench.pending': '—',
  'bench.pass': '✓ {result}',
  'bench.fail': '✗ {result}',
  'bench.running': 'идёт…',
  'bench.s.canvas-pan-zoom-n5k': 'Холст 5 тыс., зум',
  'bench.s.canvas-drag-n5k': 'Холст 5 тыс., тянем 100',
  'bench.s.canvas-pan-zoom-n10k': 'Холст 10 тыс., зум',
  'bench.s.loro-index-20k': 'Индекс 20 тыс.',
  'bench.s.loro-index-100k-k16': 'Индекс 100 тыс., 16 шардов',
  'bench.s.loro-text-1mb': 'Текст 1 МБ',
  'bench.r.canvas': '{fps} fps · p95 {p95} мс',
  'bench.r.index': 'импорт {importMs} мс · {memoryMib} МБ · 1-я правка {firstEdit} мс',
  'bench.r.text': '1 МБ за {insertMs} мс · клавиша {keyMean} мс',
  'bench.r.error': 'ошибка: {message}',
  'proto.open': 'Прототип холста',
  'proto.title': 'Прототип холста',
  'proto.close': 'Закрыть прототип',
  'proto.wheel': 'Колесо',
  'proto.wheel.mouse': 'Мышь',
  'proto.wheel.trackpad': 'Тачпад',
  'proto.undo': 'Отменить',
  'proto.redo': 'Повторить',
  'proto.lastStep': 'Последний шаг: {label}',
  'proto.noSteps': 'Шагов пока нет',
  'proto.counts': '{nodes} · нитей: {wires}',
  'proto.hint.empty': 'Tab — создать · пробел — панорама · H — всё',
  'proto.hint.node': 'Тяните — двигать · от края — нить · Alt — копия',
  'proto.hint.port': 'Тяните нить к ноде · клик — нить в руке',
  'proto.hint.wire': 'Клик — выделить нить · Delete — удалить',
  'proto.hint.drag': 'Встряхните — отцепить · на нить — вставить',
  'proto.hint.dragInsert': 'Бросьте — вставить · держите 8 — не вставлять',
  'proto.hint.wireDrag': 'На ноде — связь · в пустоте — заметка · Esc',
  'proto.hint.marquee': 'Рамка · Shift — добавить · Cmd или Ctrl — убрать',
  'proto.name.placeholder': 'Имя ноды',
  'proto.seed': 'Демо-сеть',
  'proto.change.create': 'Создать «{name}»',
  'proto.change.connect': 'Соединить с «{name}»',
  'proto.change.insert': 'Вставить «{name}» между «{from}» и «{to}»',
  'proto.change.shake': 'Встряхнуть «{name}»',
  'proto.change.move': 'Переместить «{name}»',
  'proto.change.moveMany': ['Переместить {n} ноду', 'Переместить {n} ноды', 'Переместить {n} нод'],
  'proto.change.extract': ['Извлечь {n} ноду', 'Извлечь {n} ноды', 'Извлечь {n} нод'],
  'proto.change.delete': ['Удалить {n} ноду', 'Удалить {n} ноды', 'Удалить {n} нод'],
  'proto.change.copy': ['Копия {n} ноды', 'Копия {n} нод', 'Копия {n} нод'],
  'proto.change.rename': 'Переименовать в «{name}»',
  'proto.change.disconnect': 'Удалить нить',
  'proto.toast.notHealed': [
    'Отсоединено без залечивания: {n} вход',
    'Отсоединено без залечивания: {n} входа',
    'Отсоединено без залечивания: {n} входов',
  ],
  'proto.toast.exists': 'Такая нить уже есть',
  'proto.toast.deleted': ['В корзине: {n} нода', 'В корзине: {n} ноды', 'В корзине: {n} нод'],
  'menu.recent': 'Недавние',
  'menu.kinds': 'Виды',
  'menu.classes': 'Классы',
  'menu.create': 'Создать',
  'menu.insert': 'Вставить здесь',
  'menu.noteNamed': 'Заметка «{q}»',
  'menu.nothing': 'Ничего. Enter — создать заметку «{q}»',
  'menu.footer': '↑↓ выбор · Enter создать · Esc закрыть',
  'menu.query': 'Поиск по меню',
  'kind.network': 'Сеть',
  'kind.note': 'Заметка',
  'kind.board': 'Доска',
  'kind.checklist': 'Список',
  'kind.media': 'Медиа',
  'class.task': 'Задача',
  'class.project': 'Проект',
  'class.references': 'Референсы',
  'class.checklist': 'Чек-лист',
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
  'bench.hint': 'About three minutes. Laptop on power, hands off the window.',
  'bench.run': 'Run',
  'bench.copy': 'Copy report',
  'bench.copied': 'Report copied',
  'bench.copyFailed': 'Copy failed — select the text below',
  'bench.failed': 'Failed to start: {message}',
  'bench.progress': '{done} of {total} · {name}',
  'bench.pending': '—',
  'bench.pass': '✓ {result}',
  'bench.fail': '✗ {result}',
  'bench.running': 'running…',
  'bench.s.canvas-pan-zoom-n5k': 'Canvas 5k, zoom',
  'bench.s.canvas-drag-n5k': 'Canvas 5k, drag 100',
  'bench.s.canvas-pan-zoom-n10k': 'Canvas 10k, zoom',
  'bench.s.loro-index-20k': 'Index 20k',
  'bench.s.loro-index-100k-k16': 'Index 100k, 16 shards',
  'bench.s.loro-text-1mb': 'Text 1 MB',
  'bench.r.canvas': '{fps} fps · p95 {p95} ms',
  'bench.r.index': 'import {importMs} ms · {memoryMib} MB · 1st edit {firstEdit} ms',
  'bench.r.text': '1 MB in {insertMs} ms · key {keyMean} ms',
  'bench.r.error': 'error: {message}',
  'proto.open': 'Canvas prototype',
  'proto.title': 'Canvas prototype',
  'proto.close': 'Close the prototype',
  'proto.wheel': 'Wheel',
  'proto.wheel.mouse': 'Mouse',
  'proto.wheel.trackpad': 'Trackpad',
  'proto.undo': 'Undo',
  'proto.redo': 'Redo',
  'proto.lastStep': 'Last step: {label}',
  'proto.noSteps': 'No steps yet',
  'proto.counts': '{nodes} · wires: {wires}',
  'proto.hint.empty': 'Tab to create · Space to pan · H for all',
  'proto.hint.node': 'Drag to move · rim for a wire · Alt to copy',
  'proto.hint.port': 'Drag a wire to a node · click to hold it',
  'proto.hint.wire': 'Click to select the wire · Delete to remove',
  'proto.hint.drag': 'Shake to detach · drop on a wire to insert',
  'proto.hint.dragInsert': 'Drop to insert · hold 8 not to insert',
  'proto.hint.wireDrag': 'On a node to link · in space, a note · Esc',
  'proto.hint.marquee': 'Marquee · Shift to add · Cmd or Ctrl to remove',
  'proto.name.placeholder': 'Node name',
  'proto.seed': 'Demo network',
  'proto.change.create': 'Create “{name}”',
  'proto.change.connect': 'Connect to “{name}”',
  'proto.change.insert': 'Insert “{name}” between “{from}” and “{to}”',
  'proto.change.shake': 'Shake “{name}” out',
  'proto.change.move': 'Move “{name}”',
  'proto.change.moveMany': ['Move {n} node', 'Move {n} nodes'],
  'proto.change.extract': ['Extract {n} node', 'Extract {n} nodes'],
  'proto.change.delete': ['Delete {n} node', 'Delete {n} nodes'],
  'proto.change.copy': ['Copy of {n} node', 'Copy of {n} nodes'],
  'proto.change.rename': 'Rename to “{name}”',
  'proto.change.disconnect': 'Remove the wire',
  'proto.toast.notHealed': [
    'Detached without healing: {n} input',
    'Detached without healing: {n} inputs',
  ],
  'proto.toast.exists': 'This wire already exists',
  'proto.toast.deleted': ['In the trash: {n} node', 'In the trash: {n} nodes'],
  'menu.recent': 'Recent',
  'menu.kinds': 'Kinds',
  'menu.classes': 'Classes',
  'menu.create': 'Create',
  'menu.insert': 'Insert here',
  'menu.noteNamed': 'Note “{q}”',
  'menu.nothing': 'Nothing. Enter creates the note “{q}”',
  'menu.footer': '↑↓ choose · Enter create · Esc close',
  'menu.query': 'Menu search',
  'kind.network': 'Network',
  'kind.note': 'Note',
  'kind.board': 'Board',
  'kind.checklist': 'List',
  'kind.media': 'Media',
  'class.task': 'Task',
  'class.project': 'Project',
  'class.references': 'References',
  'class.checklist': 'Checklist',
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
  const entry = catalogs[locale][key] as Catalog[MessageKey] | undefined;
  // Unreachable through the types; a key built at run time shows itself instead of crashing.
  if (entry === undefined) return key;
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
