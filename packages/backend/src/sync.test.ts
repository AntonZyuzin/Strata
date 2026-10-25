import { readFileSync } from 'node:fs';
import { LoroDoc } from 'loro-crdt';
import { beforeAll, describe, expect, it } from 'vitest';
import { browserHome, loadCore, memoryShelf, type Shelf } from './browser';
import type { HomeBackend, NetworkView } from './core';
import { dueOf, type Graph, ghostId, ghostSpot, newNode } from './graph';
import {
  CoreSync,
  followExternal,
  followFolds,
  followGhosts,
  followPreviews,
  followWires,
  graphOf,
  opsOf,
} from './sync';

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

  it('keeps the flags in the core and copies a template, one step of undo (05 §7)', async () => {
    const { home, root, g, sync, errors } = await start();
    g.transaction({ key: 't.create' }, (tx) => {
      tx.add(newNode({ id: A, name: 'Баг', kind: 'project', icon: 0, x: 0, y: 0 }));
      tx.flag(A, 'template', true);
      tx.flag(A, 'key', true);
    });
    await sync.settled();
    const tree = await home.core.tree();
    expect(tree.find((i) => i.id === A)?.flags).toEqual(['key', 'template']);
    expect(graphOf(await home.core.view(root), () => 0).nodes.get(A)).toMatchObject({
      key: true,
      template: true,
    });
    const at = { net: root, x: 300, y: 40 };
    const { id, history } = await home.core.copyNode(A, at, [], { key: 't.copy' });
    expect(history.undo).toEqual({ key: 't.copy' });
    const copy = (await home.core.view(root)).nodes.find((n) => n.id === id);
    expect(copy).toMatchObject({ name: 'Баг', kind: 'project', x: 300, y: 40, flags: ['key'] });
    expect(errors).toEqual([]);
  });

  it("follows a link's preview from the core, outside undo (✅ Q-13-16)", async () => {
    const { home, root, g, sync } = await start();
    g.transaction({ key: 't.link' }, (tx) => {
      tx.add(newNode({ id: A, name: 'example.org', kind: 'asset', icon: 0, x: 0, y: 0 }));
      tx.attr(A, 'url', 'https://example.org/mill');
    });
    await sync.settled();
    const view = await home.core.view(root);
    const sha = 'a'.repeat(64);
    // What the core holds after its step of the system: the page's title and picture.
    const after = {
      ...view,
      nodes: view.nodes.map((n) => (n.id === A ? { ...n, name: 'Мельница', preview: sha } : n)),
    };
    const steps = g.undoLabel;
    followPreviews(g, after);
    expect(g.nodes.get(A)?.name).toBe('Мельница');
    expect(g.nodes.get(A)?.attrs.preview).toBe(sha);
    expect(g.undoLabel).toEqual(steps);
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

  it('shows ghosts beside their note and a new node with the name resolves one (05 §8.5)', async () => {
    const { home, root, g, sync, errors } = await start();
    g.transaction({ key: 't' }, (tx) => tx.add(node(A, 'Заметка', 0, 0)));
    await sync.settled();
    const doc = new LoroDoc();
    doc.import(await home.core.openDoc(`content/${A}`));
    doc.getText('text').insert(0, 'Позже: [[Идея]]');
    doc.commit();
    await home.core.pushDoc(`content/${A}`, doc.export({ mode: 'update' }));
    const view = await home.core.view(root);
    expect(view.ghosts.map((x) => [x.from, x.name])).toEqual([[A, 'Идея']]);
    const id = ghostId(view.ghosts[0]?.edge ?? '');
    const undoBefore = g.undoLabel;
    followGhosts(g, view, 0);
    expect(g.undoLabel).toEqual(undoBefore);
    const ghost = () => g.nodes.get(id);
    expect(ghost()).toMatchObject({
      ghost: true,
      ghostOf: A,
      name: 'Идея',
      ...ghostSpot({ x: 0, y: 0 }, 'Идея'),
    });
    expect(g.edges()).toEqual([[A, id]]);
    // A graph read afresh has it too.
    expect(graphOf(view, () => 0).nodes.get(id)).toMatchObject({ ghostOf: A, x: ghost()?.x });

    // It follows its note and is not dragged, wired or sent to the core.
    const moved = g.transaction({ key: 't.move' }, (tx) => tx.move(A, 100, 0));
    expect(ghost()).toMatchObject(ghostSpot({ x: 100, y: 0 }, 'Идея'));
    expect(
      opsOf(moved ?? { id: 0, label: { key: '' }, source: 'user', ops: [], inverse: [] }, root),
    ).toEqual([{ op: 'move', net: root, id: A, x: 100, y: 0 }]);
    g.transaction({ key: 't' }, (tx) => tx.add(node(B, 'Другая', 0, 200)));
    expect(g.transaction({ key: 't.move' }, (tx) => tx.move(id, 5, 5))).toBeNull();
    expect(g.transaction({ key: 't.wire' }, (tx) => tx.connect(B, id))).toBeNull();
    await sync.settled();
    expect(errors).toEqual([]);

    // A node with the name: the ghost resolves into a wire, outside undo.
    const spot = { x: ghost()?.x ?? 0, y: ghost()?.y ?? 0 };
    g.transaction({ key: 't.create' }, (tx) => tx.add(node(C, 'идея', spot.x, spot.y)));
    await sync.settled();
    let v = await home.core.view(root);
    followGhosts(g, v, 0);
    followWires(g, v);
    expect(ghost()).toBeUndefined();
    expect(g.edges().sort()).toEqual([[A, C]]);
    expect(g.undoLabel).toEqual({ key: 't.create' });

    // Undo: the node goes and the ghost comes back.
    g.undo();
    await sync.settled();
    v = await home.core.view(root);
    followGhosts(g, v, 0);
    followWires(g, v);
    expect(ghost()?.ghostOf).toBe(A);
    expect(g.edges()).toEqual([[A, id]]);

    // The note to the trash takes its ghost along; undo brings both back.
    const trashed = g.transaction({ key: 't.delete' }, (tx) => tx.remove(A));
    expect(ghost()).toBeUndefined();
    expect(
      opsOf(trashed ?? { id: 0, label: { key: '' }, source: 'user', ops: [], inverse: [] }, root),
    ).toEqual([{ op: 'trash', ids: [A] }]);
    g.undo();
    expect(ghost()?.ghostOf).toBe(A);
    expect(g.edges()).toEqual([[A, id]]);
    await sync.settled();
    expect(errors).toEqual([]);
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

  it('«↗N» and the roll-up wires come from the core, outside undo (05 §8.3, 06 §13.3)', async () => {
    const { home, root, g, sync } = await start();
    // «Арт» here wired to «Эскиз» inside the folder «Папка» placed here.
    g.transaction({ key: 't' }, (tx) => {
      tx.add(node(A, 'Арт', 0, 0));
      tx.add(newNode({ id: B, name: 'Папка', kind: 'network', icon: 0, x: 300, y: 0 }));
    });
    await sync.settled();
    await home.core.apply(
      [
        { op: 'createNode', id: C, kind: 'note', name: 'Эскиз', net: B, x: 0, y: 0 },
        { op: 'connect', from: A, to: C },
      ],
      { key: 't' },
    );
    const view = await home.core.view(root);
    expect(view.nodes.find((n) => n.id === A)?.external).toBe(1);
    const looks: (string | null)[] = [];
    g.subscribe((e) => {
      if (e.type === 'look') looks.push(e.id);
    });
    followExternal(g, view);
    expect(g.nodes.get(A)?.external).toBe(1);
    expect(g.rollups).toEqual([{ a: A < B ? A : B, b: A < B ? B : A, count: 1 }]);
    expect(looks).toEqual([A, null]);
    // Looks only, no step: the same answer again changes nothing.
    followExternal(g, view);
    expect(looks).toHaveLength(2);
    // A fresh graph reads them at once.
    expect(graphOf(view, () => 0).rollups).toHaveLength(1);
    expect(graphOf(view, () => 0).nodes.get(A)?.external).toBe(1);
    // The list behind «↗1» (06 §14): the other end, its way and its path.
    const list = await home.core.external(root, A);
    expect(list.map((w) => [w.name, w.incoming, w.manual, w.path.map(([, n]) => n)])).toEqual([
      ['Эскиз', false, true, ['Тест', 'Папка']],
    ]);
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
    const looks: (string | null)[] = [];
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
  it("keeps a tab's undo while another opens, and lets it go with the tab (05 §11)", async () => {
    const home = await browserHome(memoryShelf());
    const a = await home.create('А');
    const step = { key: 't.create' };
    await home.core.apply(
      [{ op: 'createNode', kind: 'note', name: 'Заметка', net: a.root, x: 0, y: 0 }],
      step,
    );
    await home.create('Б');
    expect((await home.core.history()).undo).toBeNull();
    await home.open(a.workspace.id);
    expect((await home.core.history()).undo).toEqual(step);
    // The home screen keeps the tabs behind it.
    await home.close();
    await home.open(a.workspace.id);
    expect((await home.core.history()).undo).toEqual(step);
    // A closed tab: opened again, the workspace starts afresh, its work kept.
    expect((await home.release(a.workspace.id)).current).toBeNull();
    await home.open(a.workspace.id);
    expect((await home.core.history()).undo).toBeNull();
    expect((await home.core.view(a.root)).nodes.map((n) => n.name)).toEqual(['Заметка']);
  });

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
