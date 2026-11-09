import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { browserHome, loadCore, memoryShelf, type Shelf } from './browser';
import { newId } from './ids';

beforeAll(async () => {
  await loadCore(readFileSync(new URL('../pkg/strata_core_bg.wasm', import.meta.url)));
});

/** The workspace as a browser opened anew would find it on the shelf. */
async function reread(shelf: Shelf, id: string) {
  const again = await browserHome(shelf);
  await again.open(id);
  return again.core;
}

describe('the browser keeps what a call wrote (10 §3.3)', () => {
  it('a revert, a copy and an asset are on the shelf as soon as they are made', async () => {
    // Each of them alone, nothing after: the page may close right then.
    const shelf = memoryShelf();
    const home = await browserHome(shelf);
    const { workspace, root } = await home.create('Полка');
    const note = newId();
    await home.core.apply(
      [{ op: 'createNode', id: note, kind: 'note', name: 'Первая', net: root, x: 0, y: 0 }],
      { key: 'proto.change.create', params: { name: 'Первая' } },
    );
    await home.core.apply([{ op: 'setAttr', id: note, key: 'color', value: 2 }], {
      key: 'change.color',
      params: { n: 1 },
    });
    expect((await (await reread(shelf, workspace.id)).node(note)).color).toBe(2);

    // «Откатить» in «История изменений» (10 §9.3).
    const colour = (await home.core.journal()).entries.find((e) => e.label.key === 'change.color');
    if (!colour) throw new Error('no colour changeset');
    await home.core.revertChangeset(colour.id);
    expect((await (await reread(shelf, workspace.id)).node(note)).color).toBeUndefined();

    // A copy (06 §12.1).
    await home.core.copyNode(note, { net: root, x: 200, y: 0 }, [], { key: 'core.change.copy' });
    const tree = await (await reread(shelf, workspace.id)).tree();
    expect(tree.filter((n) => n.name === 'Первая')).toHaveLength(2);

    // An asset (10 §11).
    const bytes = new Uint8Array([1, 2, 3]);
    const sha = await home.core.putAsset(bytes);
    expect(await (await reread(shelf, workspace.id)).asset(sha)).toEqual(bytes);
  });

  it('a call that reads leaves the shelf as it was', async () => {
    const shelf = memoryShelf();
    const writes: string[] = [];
    const watched: Shelf = {
      ...shelf,
      set: async (k, v) => {
        writes.push(k);
        await shelf.set(k, v);
      },
      batch: async (w) => {
        writes.push(...w.map(([k]) => k));
        await shelf.batch(w);
      },
    };
    const home = await browserHome(watched);
    const { workspace, root } = await home.create('Чтение');
    writes.length = 0;
    await home.core.tree();
    await home.core.view(root);
    await home.core.journal();
    await home.core.trash();
    expect(writes.filter((k) => k === `ws:${workspace.id}`)).toEqual([]);
  });
});
