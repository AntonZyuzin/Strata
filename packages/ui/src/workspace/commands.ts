import type { CanvasAction } from '@strata/canvas';
import { type Locale, type MessageKey, t } from '@strata/i18n';
import type { Ranked } from '@strata/search';
import type { Quality } from '@strata/view3d/map';
import type { MapAction } from '../proto/map3d';

/**
 * The palette's commands (09 §3.5): every action of the canvas and of the
 * star map has one (06 §1 rule 6), and so has every step of the tab bar. A
 * command is found by its title in both languages and by its aliases, shows
 * the title in the UI's language and its key; one that cannot run now is not
 * shown, or shown grey with the reason under «Показать все».
 */

export type CommandGroup = 'canvas' | 'node' | 'nav' | 'app';

/** What the tab bar does (06 §2.1), for the palette: the shell gives it. */
export interface AppActions {
  /** The workspace to a `.strata.zip`; none while nothing is open. */
  save?: (() => void) | undefined;
  /** A `.strata.zip` opened as a new workspace. */
  open(): void;
  create(): void;
  home(): void;
  settings(): void;
  /** «Добро пожаловать» (06 §17.2). */
  welcome(): void;
}

/** What a command may do and know: the workspace screen gives it. */
export interface CommandContext {
  view: '2d' | '3d';
  /** Nodes chosen on the canvas. */
  selected: number;
  /** The node the panel shows. */
  current: string | null;
  canUndo: boolean;
  canRedo: boolean;
  canBack: boolean;
  canForward: boolean;
  /** The quick marks set. */
  marks: readonly boolean[];
  /** Nodes cut or copied wait for `Ctrl+V` (06 §12.1). */
  clip: boolean;
  act(action: CanvasAction): void;
  goTo(): void;
  find(): void;
  walk(how: 'back' | 'forward' | 'previous'): void;
  setMark(slot: number): void;
  goMark(slot: number): void;
  /** The report of this workspace's import (13 §3.6), when there is one. */
  importReport?: (() => void) | undefined;
  /** A step on the star map (08 §5.2): what its keys do. */
  mapAct(action: MapAction): void;
  /** The star map's quality chosen by hand, or `auto` (08 §8.4). */
  quality: Quality | 'auto';
  setQuality(q: Quality | 'auto'): void;
  /** «Клавиши» (06 §17). */
  help(): void;
  /** The path becomes its field (09 §4.3). */
  typePath(): void;
  /** The focus to the screen's next area, as `F6` (06 §1.1): a Mac's `F6` wants `Fn`. */
  nextArea(): void;
  /** The canonical path, and a `[[link]]`, of the node chosen or the network on the canvas (09 §4.6). */
  copyPath(): void;
  copyLink(): void;
  /** The tab bar's steps; none where the screen has no bar (the bench's host). */
  app?: AppActions | undefined;
  /** «Фон» of the network on the canvas (07 §7.4). */
  background?: (() => void) | undefined;
}

export interface Command {
  id: string;
  title: MessageKey;
  /** More words to find it by, in both languages. */
  aliases: readonly string[];
  group: CommandGroup;
  /** Its key, as the palette shows it (06 §1). */
  key?: string;
  /** Why it cannot run now, shown under «Показать все»; null — it can. */
  why?(ctx: CommandContext): MessageKey | null;
  run(ctx: CommandContext): void;
}

/** The reason a command cannot run now, or null. */
type Why = (c: CommandContext) => MessageKey | null;

const flat: Why = (c) => (c.view === '2d' ? null : 'cmd.why.canvas');
const spatial: Why = (c) => (c.view === '3d' ? null : 'cmd.why.map');
const chosen: Why = (c) => flat(c) ?? (c.selected > 0 ? null : 'cmd.why.selection');
const one: Why = (c) => flat(c) ?? (c.current !== null ? null : 'cmd.why.node');
const clipped: Why = (c) => flat(c) ?? (c.clip ? null : 'cmd.why.clip');
const always: Why = () => null;
const bar: Why = (c) => (c.app ? null : 'cmd.why.app');

const canvas = (
  id: string,
  action: CanvasAction,
  key: string,
  aliases: readonly string[],
  why: Why = flat,
  group: CommandGroup = 'canvas',
): Command => ({
  id: `canvas.${id}`,
  title: `cmd.canvas.${id}` as MessageKey,
  aliases,
  group,
  key,
  why,
  run: (c) => c.act(action),
});

/** A step of the star map (08 §5.2), shown while the map is. */
const mapped = (
  id: string,
  action: MapAction,
  key: string,
  aliases: readonly string[],
  group: CommandGroup = 'node',
): Command => ({
  id: `map.${id}`,
  title: `cmd.map.${id}` as MessageKey,
  aliases: ['карта', 'звезда', 'map', 'star', ...aliases],
  group,
  key,
  why: spatial,
  run: (c) => c.mapAct(action),
});

/** A preset of the map's quality (08 §8.4): on the canvas too — «off» is turned on here. */
const preset = (q: Quality | 'auto', aliases: readonly string[]): Command => ({
  id: `map.quality.${q}`,
  title: `cmd.map.quality.${q}` as MessageKey,
  aliases: ['качество', 'карта', 'графика', 'quality', 'map', 'graphics', ...aliases],
  group: 'nav',
  why: (c) => (c.quality !== q ? null : 'cmd.why.current'),
  run: (c) => c.setQuality(q),
});

export const COMMANDS: readonly Command[] = [
  canvas('create', 'create', 'Tab', ['нода', 'новая', 'node', 'new', 'add']),
  canvas('layout', 'layout', 'L', ['раскладка', 'разложить', 'layout', 'arrange', 'tidy']),
  canvas('fitAll', 'fitAll', 'H', ['всё', 'обзор', 'home', 'all', 'overview']),
  canvas('frame', 'frame', 'G', ['кадр', 'выделенное', 'focus', 'selection']),
  canvas('selectAll', 'selectAll', 'Ctrl+A', ['выделить', 'select']),
  canvas('wireStyle', 'wireStyle', 'Shift+S', ['нити', 'кривые', 'wires', 'curves', 'straight']),
  canvas('minimap', 'minimap', 'O', ['мини-карта', 'обзор', 'minimap', 'overview']),
  {
    id: 'canvas.background',
    title: 'cmd.canvas.background',
    aliases: ['фон', 'картинка', 'обои', 'пространство', 'background', 'wallpaper', 'picture'],
    group: 'canvas',
    why: (c) => flat(c) ?? (c.background ? null : 'cmd.why.app'),
    run: (c) => c.background?.(),
  },
  canvas('zoomIn', 'zoomIn', '+', ['масштаб', 'крупнее', 'zoom', 'bigger']),
  canvas('zoomOut', 'zoomOut', '−', ['масштаб', 'мельче', 'zoom', 'smaller']),
  canvas('zoomReset', 'zoomReset', '0', ['масштаб', '100', 'zoom', 'actual']),
  canvas('undo', 'undo', 'Ctrl+Z', ['отмена', 'undo'], (c) => (c.canUndo ? null : 'cmd.why.undo')),
  canvas('redo', 'redo', 'Ctrl+Shift+Z', ['повтор', 'redo'], (c) =>
    c.canRedo ? null : 'cmd.why.redo',
  ),
  canvas('open', 'open', 'Enter', ['открыть', 'войти', 'open', 'enter', 'dive'], one, 'node'),
  canvas('rename', 'rename', 'F2', ['имя', 'переименовать', 'rename', 'name'], one, 'node'),
  canvas(
    'delete',
    'delete',
    'Del',
    ['убрать', 'удалить', 'отсюда', 'remove', 'delete', 'here'],
    chosen,
    'node',
  ),
  canvas(
    'deleteEverywhere',
    'deleteEverywhere',
    'Shift+Del',
    ['удалить', 'везде', 'корзина', 'delete', 'everywhere', 'trash'],
    chosen,
    'node',
  ),
  canvas(
    'extract',
    'extract',
    'Ctrl+Shift+X',
    ['вынуть', 'цепочка', 'extract', 'chain'],
    chosen,
    'node',
  ),
  canvas('cut', 'cut', 'Ctrl+X', ['вырезать', 'перенести', 'cut', 'move'], chosen, 'node'),
  canvas('copy', 'copy', 'Ctrl+C', ['копировать', 'копия', 'copy'], chosen, 'node'),
  canvas(
    'duplicate',
    'duplicate',
    'Ctrl+D',
    ['дублировать', 'копия рядом', 'duplicate', 'clone'],
    chosen,
    'node',
  ),
  canvas('paste', 'paste', 'Ctrl+V', ['вставить', 'перенести', 'paste', 'move'], clipped),
  canvas(
    'pasteAppearance',
    'pasteAppearance',
    'Ctrl+Shift+V',
    ['вставить', 'появление', 'ярлык', 'разместить', 'paste', 'appearance', 'shortcut', 'place'],
    clipped,
  ),
  canvas(
    'wrap',
    'wrap',
    'Shift+C',
    ['обернуть', 'папка', 'сгруппировать', 'wrap', 'folder', 'group', 'collapse'],
    chosen,
    'node',
  ),
  canvas(
    'icons',
    'icons',
    'Z',
    ['иконка', 'значок', 'пресет', 'картинка', 'icon', 'preset', 'picture'],
    chosen,
    'node',
  ),
  canvas(
    'colors',
    'colors',
    'C',
    ['цвет', 'палитра', 'покрасить', 'colour', 'color', 'palette', 'paint'],
    chosen,
    'node',
  ),
  canvas(
    'panel',
    'panel',
    'P',
    ['панель', 'свойства', 'поля', 'panel', 'properties', 'fields'],
    chosen,
    'node',
  ),
  canvas('flag.key', 'flag:key', 'R', ['флаг', 'ключевая', 'flag', 'key', 'star'], chosen, 'node'),
  canvas(
    'flag.pause',
    'flag:pause',
    'Q',
    ['флаг', 'пауза', 'flag', 'pause', 'hold'],
    chosen,
    'node',
  ),
  canvas(
    'flag.template',
    'flag:template',
    'E',
    ['флаг', 'шаблон', 'flag', 'template'],
    chosen,
    'node',
  ),
  {
    id: 'help',
    title: 'cmd.help',
    aliases: ['клавиши', 'справка', 'горячие клавиши', 'keys', 'help', 'shortcuts'],
    group: 'nav',
    key: '?',
    run: (c) => c.help(),
  },
  {
    id: 'nav.goTo',
    title: 'cmd.nav.goTo',
    aliases: ['перейти', 'найти', 'нода', 'go', 'jump', 'open'],
    group: 'nav',
    key: 'Ctrl+O',
    run: (c) => c.goTo(),
  },
  {
    id: 'nav.find',
    title: 'cmd.nav.find',
    aliases: ['найти', 'поиск', 'find', 'search'],
    group: 'nav',
    key: 'Ctrl+F',
    run: (c) => c.find(),
  },
  canvas('up', 'up', 'U', ['вверх', 'наверх', 'выйти', 'up', 'parent'], flat, 'nav'),
  {
    id: 'nav.nextArea',
    title: 'cmd.nav.nextArea',
    aliases: ['область', 'фокус', 'панель', 'area', 'focus', 'pane'],
    group: 'nav',
    key: 'F6',
    run: (c) => c.nextArea(),
  },
  {
    id: 'nav.typePath',
    title: 'cmd.nav.typePath',
    aliases: ['путь', 'адрес', 'перейти по пути', 'path', 'address', 'go to path'],
    group: 'nav',
    why: flat,
    run: (c) => c.typePath(),
  },
  {
    id: 'nav.copyPath',
    title: 'cmd.nav.copyPath',
    aliases: ['путь', 'буфер', 'копировать', 'path', 'clipboard', 'copy'],
    group: 'nav',
    why: flat,
    run: (c) => c.copyPath(),
  },
  {
    id: 'nav.copyLink',
    title: 'cmd.nav.copyLink',
    aliases: ['ссылка', 'вики-ссылка', 'буфер', 'link', 'wikilink', 'clipboard'],
    group: 'nav',
    why: flat,
    run: (c) => c.copyLink(),
  },
  {
    id: 'nav.back',
    title: 'cmd.nav.back',
    aliases: ['назад', 'история', 'back', 'history'],
    group: 'nav',
    key: 'Alt+←',
    why: (c) => (c.canBack ? null : 'cmd.why.back'),
    run: (c) => c.walk('back'),
  },
  {
    id: 'nav.forward',
    title: 'cmd.nav.forward',
    aliases: ['вперёд', 'история', 'forward', 'history'],
    group: 'nav',
    key: 'Alt+→',
    why: (c) => (c.canForward ? null : 'cmd.why.forward'),
    run: (c) => c.walk('forward'),
  },
  {
    id: 'nav.previous',
    title: 'cmd.nav.previous',
    aliases: ['предыдущее', 'туда-обратно', 'previous', 'toggle'],
    group: 'nav',
    key: '`',
    why: (c) => (c.canBack ? null : 'cmd.why.back'),
    run: (c) => c.walk('previous'),
  },
  canvas('map', 'map', 'M', ['3d', 'звёзды', 'карта', 'star', 'map'], always, 'nav'),
  {
    id: 'nav.importReport',
    title: 'cmd.nav.importReport',
    aliases: ['импорт', 'obsidian', 'отчёт', 'import', 'report', 'vault'],
    group: 'nav',
    why: (c) => (c.importReport ? null : 'cmd.why.report'),
    run: (c) => c.importReport?.(),
  },
  {
    id: 'app.save',
    title: 'cmd.app.save',
    aliases: ['экспорт', 'сохранить', 'архив', 'файл', 'export', 'save', 'archive', 'zip'],
    group: 'app',
    why: (c) => bar(c) ?? (c.app?.save ? null : 'cmd.why.unsaved'),
    run: (c) => c.app?.save?.(),
  },
  {
    id: 'app.open',
    title: 'cmd.app.open',
    aliases: ['открыть', 'архив', 'импорт', 'файл', 'open', 'archive', 'import', 'zip'],
    group: 'app',
    why: bar,
    run: (c) => c.app?.open(),
  },
  {
    id: 'app.new',
    title: 'cmd.app.new',
    aliases: ['новое', 'пространство', 'создать', 'вкладка', 'new', 'workspace', 'create', 'tab'],
    group: 'app',
    why: bar,
    run: (c) => c.app?.create(),
  },
  {
    id: 'app.home',
    title: 'cmd.app.home',
    aliases: ['главная', 'домой', 'пространства', 'home', 'start', 'workspaces'],
    group: 'app',
    why: bar,
    run: (c) => c.app?.home(),
  },
  {
    id: 'app.settings',
    title: 'cmd.app.settings',
    aliases: ['настройки', 'профиль', 'язык', 'дата', 'settings', 'preferences', 'language'],
    group: 'app',
    why: bar,
    run: (c) => c.app?.settings(),
  },
  {
    id: 'app.welcome',
    title: 'cmd.app.welcome',
    aliases: ['приветствие', 'начало', 'первые шаги', 'welcome', 'intro', 'first steps'],
    group: 'app',
    why: bar,
    run: (c) => c.app?.welcome(),
  },
  mapped('create', 'create', 'Tab', ['создать', 'нода', 'create', 'node']),
  mapped('open', 'open', 'Enter', ['войти', 'открыть', 'open', 'enter']),
  mapped('into', 'into', 'I', ['скопление', 'внутрь', 'cluster', 'into'], 'nav'),
  mapped('up', 'up', 'U', ['наверх', 'выше', 'up', 'parent'], 'nav'),
  mapped('overview', 'overview', 'H', ['обзор', 'всё', 'overview', 'all'], 'nav'),
  mapped('frame', 'frame', 'F', ['перелёт', 'лететь', 'fly', 'frame'], 'nav'),
  mapped('card', 'card', 'Shift+I', ['справка', 'карточка', 'card', 'info']),
  mapped('pin', 'pin', 'B', ['закрепить', 'булавка', 'pin', 'fix']),
  mapped('flag.key', 'flag:key', 'R', ['флаг', 'ключевая', 'flag', 'key']),
  mapped('flag.pause', 'flag:pause', 'Q', ['флаг', 'пауза', 'flag', 'pause']),
  mapped('flag.template', 'flag:template', 'E', ['флаг', 'шаблон', 'flag', 'template']),
  mapped('delete', 'delete', 'Del', ['убрать', 'удалить', 'remove', 'delete']),
  {
    id: 'map.relayout',
    title: 'cmd.map.relayout',
    aliases: [
      'карта',
      'пересчитать',
      'раскладка',
      'звёзды',
      'map',
      'relayout',
      'recompute',
      'stars',
    ],
    group: 'nav',
    why: spatial,
    run: (c) => c.mapAct('relayout'),
  },
  mapped('deleteEverywhere', 'deleteEverywhere', 'Shift+Del', [
    'удалить',
    'везде',
    'delete',
    'trash',
  ]),
  preset('auto', ['само', 'авто', 'automatic', 'auto']),
  preset('high', ['высокое', 'bloom', 'high']),
  preset('medium', ['среднее', 'medium']),
  preset('economy', ['экономия', 'слабая', 'economy', 'low']),
  preset('off', ['выключить', 'выкл', 'off', 'disable']),
  ...[0, 1, 2, 3, 4].flatMap((i): Command[] => [
    {
      id: `nav.mark.set.${i + 1}`,
      title: `cmd.nav.markSet.${i + 1}` as MessageKey,
      aliases: ['метка', 'закладка', 'mark', 'bookmark'],
      group: 'nav',
      key: `Ctrl+${i + 1}`,
      run: (c) => c.setMark(i),
    },
    {
      id: `nav.mark.go.${i + 1}`,
      title: `cmd.nav.markGo.${i + 1}` as MessageKey,
      aliases: ['метка', 'закладка', 'mark', 'bookmark'],
      group: 'nav',
      key: `${i + 1}`,
      why: (c) => (c.marks[i] === true ? null : 'cmd.why.mark'),
      run: (c) => c.goMark(i),
    },
  ]),
];

/** The words a command is found by, as one list, and the command of each. */
export function commandNames(commands: readonly Command[] = COMMANDS): {
  names: string[];
  of: number[];
} {
  const names: string[] = [];
  const of: number[] = [];
  commands.forEach((c, i) => {
    for (const word of [t('ru', c.title), t('en', c.title), ...c.aliases]) {
      names.push(word);
      of.push(i);
    }
  });
  return { names, of };
}

/** The engine's rows of `names` as commands, best first, each once. */
export function rankedCommands(
  ranked: readonly Ranked[],
  of: readonly number[],
  commands: readonly Command[] = COMMANDS,
): Command[] {
  const seen = new Set<number>();
  const out: Command[] = [];
  for (const r of ranked) {
    const i = of[r.index];
    if (i === undefined || seen.has(i)) continue;
    seen.add(i);
    const c = commands[i];
    if (c) out.push(c);
  }
  return out;
}

/** Why command `c` cannot run now, or null when it can. */
export function whyNot(c: Command, ctx: CommandContext): MessageKey | null {
  return c.why ? c.why(ctx) : null;
}

/** A command can run now. */
export function available(c: Command, ctx: CommandContext): boolean {
  return whyNot(c, ctx) === null;
}

/** Its title in the UI's language. */
export function titleOf(locale: Locale, c: Command): string {
  return t(locale, c.title);
}
