import { readFileSync } from 'node:fs';
import { LoroDoc } from 'loro-crdt';
import { beforeAll, describe, expect, it } from 'vitest';
import { browserHome, loadCore, memoryShelf, type Shelf } from './browser';
import type { HomeBackend, NetworkView } from './core';
import { dueOf, type Graph, newNode } from './graph';
import { CoreSync, followFolds, followWires, graphOf } from './sync';

beforeAll(async () => {
  await loadCore(readFileSync(new URL('../pkg/strata_core_bg.wasm', import.meta.url)));
});

/** The graph and the core's network, compared by what the canvas shows. */
function shape(
  nodes: { id: string; name: string; x: number; y: number }[],
  edges: [string, string][],
) {
  return {
    nodes: nodes.map((n) => `${n.id} ${n.name} ${n.x} ${n.y}`).sort(),
    edges: edges.map(([a, b]) => `${a}→${b}`).sort(),
  };
}

const ofGraph = (g: Graph) => shape([...g.nodes.values()], g.edges());
const ofView = (v: NetworkView) =>
  shape(
    v.nodes,
    v.edges.map((e) => [e.from, e.to]),
  );

async function start(shelf: Shelf = memoryShelf()) {
  const home = await browserHome(shelf);
  const { root } = await home.create('Тест');
  const g = graphOf(await home.core.view(root), () => 0);
  const errors: unknown[] = [];
  const sync = new CoreSync(home.core, g, root, (e) => errors.push(e));
  return { home, root, g, sync, errors, shelf };
}

const node = (id: string, name: string, x = 0, y = 0) =>
  newNode({ id, name, kind: 'note', icon: 0, x, y });

// Crockford base32 UUIDv7-shaped ids, as `newId` makes them.
const A = '01K8A0000000000000000000AA';
const B = '01K8A0000000000000000000BB';
const C = '01K8A0000000000000000000CC';

describe('the canvas and the core in step', () => {
  it('repeats gestures, their rest, undo and redo in the core', async () => {
    const { home, root, g, sync, errors } = await start();
    g.transaction({ key: 't.create' }, (tx) => {
      tx.add(node(A, 'Без имени', 10, 20));
      tx.add(node(B, 'Вторая', 200, 20));
      tx.connect(A, B);
    });
    // The name typed right after creating joins the same step (06 §5.5).
    g.amend((tx) => tx.rename(A, 'Первая'), { key: 't.named' });
    g.transaction({ key: 't.move' }, (tx) => tx.move(B, 300, 40));
    await sync.settled();
    expect(ofView(await home.core.view(root))).toEqual(ofGraph(g));

    g.undo();
    g.undo();
    await sync.settled();
    expect((await home.core.view(root)).nodes).toEqual([]);
    expect(ofView(await home.core.view(root))).toEqual(ofGraph(g));

    g.redo();
    await sync.settled();
    expect(ofView(await home.core.view(root))).toEqual(ofGraph(g));
    expect(errors).toEqual([]);
  });

  it("keeps the network's wire style in the core, one step of undo (06 §6.2)", async () => {
    const { home, root, g, sync, errors } = await start();
    expect(g.wireShape).toBe('bezier');
    g.transaction({ key: 't.style' }, (tx) => tx.wireShape('straight'));
    g.transaction({ key: 't.style' }, (tx) => tx.wireShape('kinetic'));
    await sync.settled();
    expect((await home.core.view(root)).wire_style).toBe('kinetic');
    expect(graphOf(await home.core.view(root), () => 0).wireShape).toBe('kinetic');
    g.undo();
    await sync.settled();
    expect(g.wireShape).toBe('straight');
    expect((await home.core.view(root)).wire_style).toBe('straight');
    expect(errors).toEqual([]);
  });

  it('forgets a cancelled gesture in the core too', async () => {
    const { home, root, g, sync } = await start();
    g.transaction({ key: 't.create' }, (tx) => tx.add(node(A, 'A')));
    g.transaction({ key: 't.create' }, (tx) => tx.add(node(B, 'B')));
    g.revertLast();
    await sync.settled();
    expect(ofView(await home.core.view(root))).toEqual(ofGraph(g));
    // Undo now reaches the step before the cancelled one, in both.
    g.undo();
    await sync.settled();
    expect((await home.core.view(root)).nodes).toEqual([]);
  });

  it('deletes into the trash, and the wires come back with the node', async () => {
    const { home, root, g, sync } = await start();
    g.transaction({ key: 't' }, (tx) => {
      tx.add(node(A, 'A'));
      tx.add(node(B, 'B'));
      tx.add(node(C, 'C'));
      tx.connect(A, B);
      tx.connect(B, C);
    });
    g.transaction({ key: 't.delete' }, (tx) => tx.remove(B));
    await sync.settled();
    expect(ofView(await home.core.view(root))).toEqual(ofGraph(g));
    expect((await home.core.trash()).map((t) => t.name)).toEqual(['B']);
    // Back from the trash by the core: B and both of its wires.
    await home.core.apply([{ op: 'restore', ids: [B] }], { key: 't.restore' });
    const v = await home.core.view(root);
    expect(v.edges.map((e) => `${e.from}→${e.to}`).sort()).toEqual([`${A}→${B}`, `${B}→${C}`]);
  });

  it('keeps the workspace across a restart', async () => {
    const shelf = memoryShelf();
    const { home, root, g, sync } = await start(shelf);
    g.transaction({ key: 't' }, (tx) => {
      tx.add(node(A, 'Остаётся', 5, 6));
      tx.add(node(B, 'Тоже', 7, 8));
      tx.connect(A, B);
    });
    await sync.settled();
    const id = (await home.home()).current as string;

    const later = await browserHome(shelf);
    const list = await later.home();
    expect(list.workspaces.map((w) => w.name)).toEqual(['Тест']);
    expect(list.current).toBe(null);
    const opened = await later.open(id);
    expect(opened.root).toBe(root);
    expect(ofView(await later.core.view(root))).toEqual(ofGraph(g));
  });

  it('reads the network again when the core refuses a step', async () => {
    const { g, sync, home, errors } = await start();
    // A network id the core does not know: every step here is refused.
    const lost = new CoreSync(home.core, g, '01K8A00000000000000000000Z', (e) => errors.push(e));
    sync.destroy();
    g.transaction({ key: 't' }, (tx) => tx.add(node(A, 'A')));
    g.transaction({ key: 't' }, (tx) => tx.add(node(B, 'B')));
    await lost.settled();
    expect(errors).toHaveLength(1);
  });

  it('follows the text wires the core makes from a note', async () => {
    const { home, root, g, sync } = await start();
    g.transaction({ key: 't' }, (tx) => {
      tx.add(node(A, 'Заметка'));
      tx.add(node(B, 'Цель'));
    });
    await sync.settled();
    const doc = new LoroDoc();
    doc.import(await home.core.openDoc(`content/${A}`));
    const from = doc.oplogVersion();
    doc.getText('text').insert(0, 'См. [[цель]]');
    doc.commit();
    const wires = await home.core.pushDoc(`content/${A}`, doc.export({ mode: 'update', from }));
    expect(wires).toBe(true);
    const undoBefore = g.undoLabel;
    followWires(g, await home.core.view(root));
    expect(g.edges()).toEqual([[A, B]]);
    expect(g.undoLabel).toEqual(undoBefore);
  });
});

describe('fields of a node (05 §6.1)', () => {
  it('go to the core as steps of the same undo as gestures', async () => {
    const { home, g, sync } = await start();
    g.transaction({ key: 't' }, (tx) =>
      tx.add(newNode({ id: A, name: 'Задача', kind: 'task', icon: 0, x: 0, y: 0 })),
    );
    g.transaction({ key: 't.status' }, (tx) => {
      tx.attr(A, 'status', 'doing');
      tx.attr(A, 'deadline', '2026-11-01');
    });
    await sync.settled();
    let d = await home.core.node(A);
    expect([d.status, d.deadline]).toEqual(['doing', '2026-11-01']);
    expect(g.nodes.get(A)?.attrs.status).toBe('doing');
    g.undo();
    await sync.settled();
    d = await home.core.node(A);
    expect([d.status, d.deadline]).toEqual([undefined, undefined]);
    expect(g.nodes.get(A)?.attrs).toEqual({});
    g.redo();
    await sync.settled();
    expect((await home.core.node(A)).status).toBe('doing');
  });

  it('a task wired to a task makes it a subtask, in the preview and the roll-up', async () => {
    const { home, g, sync } = await start();
    g.transaction({ key: 't' }, (tx) => {
      tx.add(newNode({ id: A, name: 'Боёвка', kind: 'task', icon: 0, x: 0, y: 0 }));
      tx.add(newNode({ id: B, name: 'Анимации', kind: 'task', icon: 0, x: 200, y: 0 }));
      tx.connect(A, B);
      tx.attr(B, 'status', 'done');
    });
    await sync.settled();
    const d = await home.core.node(A);
    expect(d.subtasks.map((r) => [r.name, r.status])).toEqual([['Анимации', 'done']]);
    expect([d.fold?.done, d.fold?.total]).toEqual([1, 1]);
    // A task takes no asset fields (ADR-0010): the core refuses, nothing is written.
    await expect(
      home.core.apply([{ op: 'setAttr', id: A, key: 'url', value: 'https://example.org' }], {
        key: 't',
      }),
    ).rejects.toThrow();
  });

  it("a tick follows into the parent's progress arc on the canvas, outside undo", async () => {
    const { home, root, g, sync } = await start();
    g.transaction({ key: 't' }, (tx) => {
      tx.add(newNode({ id: A, name: 'Боёвка', kind: 'task', icon: 0, x: 0, y: 0 }));
      tx.add(newNode({ id: B, name: 'Анимации', kind: 'task', icon: 0, x: 200, y: 0 }));
      tx.connect(A, B);
    });
    await sync.settled();
    followFolds(g, await home.core.view(root));
    expect(g.nodes.get(A)?.fold).toMatchObject({ done: 0, total: 1 });
    const looks: string[] = [];
    g.subscribe((e) => {
      if (e.type === 'look') looks.push(e.id);
    });
    g.transaction({ key: 't.done' }, (tx) => tx.attr(B, 'status', 'done'));
    await sync.settled();
    followFolds(g, await home.core.view(root));
    expect(g.nodes.get(A)?.fold).toMatchObject({ done: 1, total: 1 });
    expect(looks).toEqual([A]);
    // The arc is the core's count, not a step: undo takes back the tick only.
    g.undo();
    await sync.settled();
    followFolds(g, await home.core.view(root));
    expect(g.nodes.get(A)?.fold).toMatchObject({ done: 0, total: 1 });
    expect(g.canUndo).toBe(true);
    g.undo();
    expect(g.canUndo).toBe(false);
  });

  it('look: deadlines for the viewer day, status and the kind colour', async () => {
    expect(dueOf('2026-10-24', '2026-10-24')).toBe('today');
    expect(dueOf('2026-10-27', '2026-10-24')).toBe('soon');
    expect(dueOf('2026-10-28', '2026-10-24')).toBe('far');
    expect(dueOf('2026-10-23', '2026-10-24')).toBe('overdue');
    // A time of day (05 §6.1): today until it has passed.
    expect(dueOf('2026-10-24T18:30', '2026-10-24', '18:30')).toBe('today');
    expect(dueOf('2026-10-24T18:30', '2026-10-24', '18:31')).toBe('overdue');
    expect(dueOf('2026-10-25T09:00', '2026-10-24', '23:59')).toBe('soon');
    const { home, root, g, sync } = await start();
    g.day = () => '2026-10-24';
    g.transaction({ key: 't' }, (tx) => {
      tx.add(newNode({ id: A, name: 'T', kind: 'task', icon: 0, x: 0, y: 0 }));
      tx.attr(A, 'deadline', '2026-10-20');
    });
    expect(g.nodes.get(A)?.due).toBe('overdue');
    expect(g.nodes.get(A)?.color).toBe(3);
    g.transaction({ key: 't' }, (tx) => tx.attr(A, 'status', 'done'));
    expect([g.nodes.get(A)?.status, g.nodes.get(A)?.due]).toEqual(['done', 'none']);
    await sync.settled();
    // Read back from the core: the same look.
    const again = graphOf(
      await home.core.view(root),
      () => 0,
      () => 0,
      () => '2026-10-24',
    );
    expect([again.nodes.get(A)?.status, again.nodes.get(A)?.color]).toEqual(['done', 3]);
  });
});

describe('the home screen in a browser', () => {
  it('creates, renames, lists by last opened and removes workspaces', async () => {
    let t = 1_000;
    const home: HomeBackend = await browserHome(memoryShelf(), () => t++);
    const a = await home.create('Работа');
    const b = await home.create('Личное');
    expect((await home.home()).workspaces.map((w) => w.name)).toEqual(['Личное', 'Работа']);
    await home.rename(a.workspace.id, 'Работа 2');
    await home.open(a.workspace.id);
    const list = await home.home();
    expect(list.workspaces.map((w) => w.name)).toEqual(['Работа 2', 'Личное']);
    expect(list.current).toBe(a.workspace.id);
    expect((await home.core.view(a.root)).name).toBe('Работа 2');
    await home.setPreview(b.workspace.id, new Uint8Array([1, 2, 3]));
    expect(await home.preview(b.workspace.id)).toEqual(new Uint8Array([1, 2, 3]));
    const after = await home.remove(b.workspace.id);
    expect(after.workspaces.map((w) => w.name)).toEqual(['Работа 2']);
    expect(await home.preview(b.workspace.id)).toBe(null);
    await expect(home.open(b.workspace.id)).rejects.toThrow();
    expect((await home.setProfile({ name: ' Я ' })).profile.name).toBe('Я');
  });

  it('moves a workspace as .strata.zip and makes a copy of a known one', async () => {
    const { home, root, g, sync } = await start();
    g.transaction({ key: 't' }, (tx) => {
      tx.add(node(A, 'Остаётся'));
      tx.add(node(B, 'Тоже'));
      tx.connect(A, B);
    });
    await sync.settled();
    const id = (await home.home()).current as string;
    const zip = await home.exportArchive(id);
    expect(zip?.subarray(0, 2)).toEqual(new Uint8Array([0x50, 0x4b])); // "PK"

    // Another browser: the same workspace, the same id.
    const there = await browserHome(memoryShelf());
    const moved = await there.importArchive(zip as Uint8Array);
    expect(moved.workspace.id).toBe(id);
    expect(moved.root).toBe(root);
    expect(ofView(await there.core.view(root))).toEqual(ofGraph(g));

    // This browser has it: the archive comes in as a copy with its own id.
    const copy = await home.importArchive(zip as Uint8Array);
    expect(copy.workspace.id).not.toBe(id);
    expect(copy.workspace.name).toBe('Тест');
    expect((await home.home()).workspaces).toHaveLength(2);
    await expect(home.importArchive(new Uint8Array([1, 2, 3]))).rejects.toThrow();
  });
});
