import { readFileSync } from 'node:fs';
import { loadSearch, rankByName } from '@strata/search';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  type AppActions,
  available,
  COMMANDS,
  type CommandContext,
  commandNames,
  rankedCommands,
  whyNot,
} from './commands';

beforeAll(async () => {
  const wasm = new URL('../../../search/pkg/strata_search_bg.wasm', import.meta.url);
  await loadSearch(readFileSync(wasm));
});

const ctx = (over: Partial<CommandContext> = {}): CommandContext => ({
  view: '2d',
  selected: 0,
  current: null,
  canUndo: false,
  canRedo: false,
  canBack: false,
  canForward: false,
  marks: [false, false, false, false, false],
  clip: false,
  act: () => undefined,
  goTo: () => undefined,
  find: () => undefined,
  walk: () => undefined,
  setMark: () => undefined,
  goMark: () => undefined,
  mapAct: () => undefined,
  quality: 'auto',
  setQuality: () => undefined,
  help: () => undefined,
  typePath: () => undefined,
  nextArea: () => undefined,
  copyPath: () => undefined,
  copyLink: () => undefined,
  ...over,
});

const find = (q: string) => {
  const { names, of } = commandNames();
  return rankedCommands(rankByName(q, names, names.length), of).map((c) => c.id);
};

describe('the command palette (09 §3.5)', () => {
  it('finds a command by its title in either language and by its aliases', () => {
    expect(find('разложить')[0]).toBe('canvas.layout');
    expect(find('layout')[0]).toBe('canvas.layout');
    expect(find('arrange')[0]).toBe('canvas.layout');
    // The other keyboard layout too (09 §2.4): «ьштшьфз» is «minimap».
    expect(find('ьштшьфз')[0]).toBe('canvas.minimap');
    // Each command once, however many of its words match.
    const ids = find('метка');
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('shows only what can run now', () => {
    const can = (id: string, c: CommandContext) => {
      const command = COMMANDS.find((x) => x.id === id);
      if (!command) throw new Error(`no command ${id}`);
      return available(command, c);
    };
    expect(can('canvas.delete', ctx())).toBe(false);
    expect(can('canvas.delete', ctx({ selected: 2 }))).toBe(true);
    expect(can('canvas.rename', ctx({ selected: 1, current: 'a' }))).toBe(true);
    expect(can('canvas.layout', ctx({ view: '3d' }))).toBe(false);
    expect(can('canvas.map', ctx({ view: '3d' }))).toBe(true);
    expect(can('nav.back', ctx())).toBe(false);
    expect(can('nav.mark.go.2', ctx({ marks: [false, true, false, false, false] }))).toBe(true);
    expect(can('nav.mark.go.1', ctx({ marks: [false, true, false, false, false] }))).toBe(false);
    // Cut, copy and wrap take the chosen nodes; a paste — what was cut or copied (06 §12.1).
    expect(can('canvas.cut', ctx())).toBe(false);
    expect(can('canvas.wrap', ctx({ selected: 3 }))).toBe(true);
    expect(can('canvas.paste', ctx())).toBe(false);
    expect(can('canvas.pasteAppearance', ctx({ clip: true }))).toBe(true);
    expect(can('canvas.paste', ctx({ clip: true, view: '3d' }))).toBe(false);
    // The map's steps while the map is shown (08 §5.2); its quality anywhere (08 §8.4).
    expect(can('map.pin', ctx())).toBe(false);
    expect(can('map.pin', ctx({ view: '3d' }))).toBe(true);
    expect(can('map.quality.off', ctx())).toBe(true);
    expect(can('map.quality.auto', ctx())).toBe(false);
  });

  it('says why a command cannot run now, for «Все команды»', () => {
    const why = (id: string, c: CommandContext) => {
      const command = COMMANDS.find((x) => x.id === id);
      if (!command) throw new Error(`no command ${id}`);
      return whyNot(command, c);
    };
    // The view first: a canvas command on the star map is the canvas's only.
    expect(why('canvas.delete', ctx({ view: '3d', selected: 2 }))).toBe('cmd.why.canvas');
    expect(why('canvas.delete', ctx())).toBe('cmd.why.selection');
    expect(why('canvas.rename', ctx())).toBe('cmd.why.node');
    expect(why('canvas.paste', ctx())).toBe('cmd.why.clip');
    expect(why('canvas.undo', ctx())).toBe('cmd.why.undo');
    expect(why('canvas.redo', ctx())).toBe('cmd.why.redo');
    expect(why('nav.back', ctx())).toBe('cmd.why.back');
    expect(why('nav.forward', ctx())).toBe('cmd.why.forward');
    expect(why('nav.mark.go.3', ctx())).toBe('cmd.why.mark');
    expect(why('nav.importReport', ctx())).toBe('cmd.why.report');
    expect(why('map.pin', ctx())).toBe('cmd.why.map');
    expect(why('map.quality.auto', ctx())).toBe('cmd.why.current');
    expect(why('canvas.layout', ctx())).toBeNull();
  });

  it("runs the tab bar's steps where the screen has the bar", () => {
    const done: string[] = [];
    const app: AppActions = {
      open: () => done.push('open'),
      create: () => done.push('create'),
      home: () => done.push('home'),
      settings: () => done.push('settings'),
    };
    const run = (id: string, c: CommandContext) => {
      const command = COMMANDS.find((x) => x.id === id);
      if (!command) throw new Error(`no command ${id}`);
      if (available(command, c)) command.run(c);
      return whyNot(command, c);
    };
    expect(run('app.open', ctx())).toBe('cmd.why.app');
    expect(run('app.save', ctx({ app }))).toBe('cmd.why.unsaved');
    for (const id of ['app.open', 'app.new', 'app.home', 'app.settings']) {
      expect(run(id, ctx({ app }))).toBeNull();
    }
    expect(run('app.save', ctx({ app: { ...app, save: () => done.push('save') } }))).toBeNull();
    expect(done).toEqual(['open', 'create', 'home', 'settings', 'save']);
    // On the star map too: the bar is there.
    expect(run('app.settings', ctx({ app, view: '3d' }))).toBeNull();
    expect(find('export')[0]).toBe('app.save');
    expect(find('настройки')[0]).toBe('app.settings');
  });

  it('finds the moves of 06 §12.1 and the wrap of §13.3 in both languages', () => {
    expect(find('обернуть')[0]).toBe('canvas.wrap');
    expect(find('wrap in a folder')[0]).toBe('canvas.wrap');
    expect(find('появление')[0]).toBe('canvas.pasteAppearance');
    expect(find('вырезать')[0]).toBe('canvas.cut');
  });

  it('every command has words to be found by and an id of its own', () => {
    for (const c of COMMANDS) {
      expect(c.aliases.length, c.id).toBeGreaterThan(0);
    }
    const ids = COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
