import { readFileSync, writeFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { vsynthVault, vsynthVaultJson } from '../../editor/src/vsynth-vault';
import { browserHome, loadCore, memoryShelf } from './browser';

/**
 * One corpus for the import (13 §7.2): the core's tests read V-synth's vault
 * as JSON, generated here from `packages/editor/src/vsynth-vault.ts`.
 * `VSYNTH_WRITE=1 pnpm --filter @strata/backend test` writes it anew after
 * the generator changes.
 */
const FIXTURE = new URL('../../../crates/strata-core/src/tests/vsynth-vault.json', import.meta.url);

beforeAll(async () => {
  await loadCore(readFileSync(new URL('../pkg/strata_core_bg.wasm', import.meta.url)));
});

describe('V-synth vault', () => {
  it('the core reads the vault the generator makes', () => {
    const now = vsynthVaultJson();
    if (process.env.VSYNTH_WRITE) writeFileSync(FIXTURE, now);
    expect(readFileSync(FIXTURE, 'utf8')).toBe(now);
  });

  it('comes into a browser as a new workspace, one step of undo, kept on the shelf', async () => {
    // 13 §3, S1: the files of the folder picker through the WASM core.
    const shelf = memoryShelf();
    const home = await browserHome(shelf);
    const r = await home.importVault(
      { name: 'V-synth', files: vsynthVault() },
      { unlinked: 'Вложения без ссылок', text: 'текст' },
    );
    expect(r.workspace.name).toBe('V-synth');
    expect(r.report.counts.boards).toBe(3);
    expect(r.report.items.some((i) => i.code === 'ambiguous')).toBe(true);
    const history = await home.core.history();
    expect(history.undo).toEqual({ key: 'core.change.import', params: { name: 'V-synth' } });
    const tree = await home.core.tree();
    expect(tree.some((n) => n.name === 'Диздок' && n.kind === 'note')).toBe(true);
    // Kept: a browser opened anew finds the workspace with what came in.
    const again = await browserHome(shelf);
    const opened = await again.open(r.workspace.id);
    expect(opened.root).toBe(r.root);
    expect((await again.core.tree()).length).toBe(tree.length);
    // Undo takes the whole vault back.
    await home.core.undo();
    expect((await home.core.tree()).length).toBe(1);
  });

  it('a folder with nothing to import leaves no workspace', async () => {
    const home = await browserHome(memoryShelf());
    await expect(home.importVault({ name: 'Пусто', files: [] }, {})).rejects.toThrow();
    expect((await home.home()).workspaces).toEqual([]);
  });
});
