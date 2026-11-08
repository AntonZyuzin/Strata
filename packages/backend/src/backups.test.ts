import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { browserHome, loadCore, memoryShelf, type Shelf } from './browser';
import { CoreError, type HomeBackend } from './core';

beforeAll(async () => {
  await loadCore(readFileSync(new URL('../pkg/strata_core_bg.wasm', import.meta.url)));
});

const DAY_MS = 86_400_000;
/** 2026-11-08, 10:00 UTC. */
const START = Date.UTC(2026, 10, 8, 10);

/** A note named `name` in the open workspace's root network. */
async function note(home: HomeBackend, root: string, name: string) {
  await home.core.apply([{ op: 'createNode', kind: 'note', name, net: root, x: 0, y: 0 }], {
    key: 't.note',
  });
}

/** The names of the open workspace's nodes but its root, sorted. */
async function names(home: HomeBackend, root: string): Promise<string[]> {
  const tree = await home.core.tree();
  return tree
    .filter((n) => n.id !== root)
    .map((n) => n.name)
    .sort();
}

/** A browser home on `shelf` whose clock is `clock.now`. */
async function start(shelf: Shelf, clock: { now: number }) {
  return browserHome(shelf, () => clock.now);
}

describe('copies of a workspace in a browser (10 §3.5)', () => {
  it('a copy a day, made as the workspace opens or as a day passes with it open', async () => {
    const shelf = memoryShelf();
    const clock = { now: START };
    const home = await start(shelf, clock);
    const { workspace, root } = await home.create('Копии');
    // Made today: no copy until a day passes, as the desktop's folder.
    await note(home, root, 'Первая');
    expect(await home.backups(workspace.id)).toEqual([]);
    // A day passes with it open: its first write makes the day's copy.
    clock.now += DAY_MS;
    await note(home, root, 'Вторая');
    const day = await home.backups(workspace.id);
    expect(day).toEqual([{ id: 'store-20261109', at: Date.UTC(2026, 10, 9), kind: 'day' }]);
    // Opened anew another day: the copy before anything touches the store.
    clock.now += DAY_MS;
    const again = await start(shelf, clock);
    await again.open(workspace.id);
    expect((await again.backups(workspace.id)).map((b) => b.id)).toEqual([
      'store-20261110',
      'store-20261109',
    ]);
    // Removed: the copies go with it.
    await again.remove(workspace.id);
    expect(await shelf.get(`backup:${workspace.id}:store-20261110`)).toBeUndefined();
    expect(await again.backups(workspace.id)).toEqual([]);
  });

  it('seven days and four weeks stay, by the rules of the desktop', async () => {
    const shelf = memoryShelf();
    const clock = { now: START };
    const home = await start(shelf, clock);
    const { workspace, root } = await home.create('Месяцы');
    for (let d = 1; d <= 60; d++) {
      clock.now = START + d * DAY_MS;
      await note(home, root, `День ${d}`);
    }
    const kept = await home.backups(workspace.id);
    expect(kept).toHaveLength(11);
    // What goes leaves the shelf.
    expect(await shelf.get(`backup:${workspace.id}:store-20261109`)).toBeUndefined();
    expect(await shelf.get(`backup:${workspace.id}:${kept[0]?.id}`)).toBeDefined();
  });

  it('a restore brings the copy back, and the copy of what was takes it back', async () => {
    const shelf = memoryShelf();
    const clock = { now: START };
    const home = await start(shelf, clock);
    const { workspace, root } = await home.create('Назад');
    await note(home, root, 'До копии');
    // The tab closes; opened the next day, it is copied.
    await home.release(workspace.id);
    clock.now += DAY_MS;
    await home.open(workspace.id);
    await note(home, root, 'После копии');
    const [copy] = await home.backups(workspace.id);
    if (!copy) throw new Error('no copy');

    // Its tab is open: it starts afresh, no undo across the restore.
    const back = await home.restore(workspace.id, copy.id);
    expect(back.root).toBe(root);
    expect(await names(home, root)).toEqual(['До копии']);
    expect((await home.core.history()).undo).toBeNull();
    // Kept: a browser opened anew finds it restored.
    const later = await start(shelf, clock);
    await later.open(workspace.id);
    expect(await names(later, root)).toEqual(['До копии']);

    // The store as it was is the newest copy; restoring it takes the restore back.
    const [was] = await later.backups(workspace.id);
    expect(was?.kind).toBe('replaced');
    await later.restore(workspace.id, was?.id ?? '');
    expect(await names(later, root)).toEqual(['До копии', 'После копии']);
  });

  it('a copy that is damaged or of another workspace is refused, and nothing changes', async () => {
    const shelf = memoryShelf();
    const clock = { now: START };
    const home = await start(shelf, clock);
    const mine = await home.create('Своё');
    await note(home, mine.root, 'Своя');
    await home.release(mine.workspace.id);
    clock.now += DAY_MS;
    await home.open(mine.workspace.id);
    const [copy] = await home.backups(mine.workspace.id);
    if (!copy) throw new Error('no copy');
    const key = `backup:${mine.workspace.id}:${copy.id}`;

    const refused = async () => {
      const e = await home.restore(mine.workspace.id, copy.id).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(CoreError);
      expect((e as CoreError).code).toBe('damaged');
    };
    await shelf.set(key, new TextEncoder().encode('not a store'));
    await refused();
    const other = await home.create('Чужое');
    await shelf.set(key, (await shelf.get(`ws:${other.workspace.id}`)) ?? new Uint8Array());
    await refused();
    await expect(home.restore(mine.workspace.id, 'store-20200101')).rejects.toThrow('no copy');

    // Nothing changed: the store, and no copy from before a restore.
    await home.open(mine.workspace.id);
    expect(await names(home, mine.root)).toEqual(['Своя']);
    expect((await home.backups(mine.workspace.id)).every((b) => b.kind === 'day')).toBe(true);
  });
});
