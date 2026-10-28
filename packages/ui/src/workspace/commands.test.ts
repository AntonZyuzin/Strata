import { readFileSync } from 'node:fs';
import { loadSearch, rankByName } from '@strata/search';
import { beforeAll, describe, expect, it } from 'vitest';
import { available, COMMANDS, type CommandContext, commandNames, rankedCommands } from './commands';

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
