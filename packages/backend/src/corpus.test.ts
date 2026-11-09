import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { LoroDoc } from 'loro-crdt';
import { beforeAll, describe, expect, it } from 'vitest';
import { readElements, readFiles } from '../../board/src/binding';
import {
  addTodo,
  createWidget,
  setNoteText,
  setTodoDone,
  todoItems,
  widgetKind,
  widgetsOf,
  widgetText,
} from '../../board/src/widgets';
import { Checklist, type Item } from '../../checklist/src/checklist';
import { vsynthVault } from '../../editor/src/vsynth-vault';
import { browserHome, loadCore, memoryShelf } from './browser';
import type { Core, CoreOp, ImportJob, ImportReport } from './core';
import type { ChangeLabel, NodeKind } from './graph';
import { newId } from './ids';

/**
 * The format corpus (NFR-78, 10 §13): a workspace as a version wrote it —
 * the browser's store, `.strata.zip` and a workspace folder — kept in
 * `corpus/<date>/` and opened by every later version.
 *
 * Here: the TS half. `STRATA_CORPUS_WRITE=<date> pnpm --filter
 * @strata/backend test corpus` makes the workspace through the API the
 * canvas uses and the bindings the windows use — V-synth imported, then
 * every kind, attribute, wire and document a user makes — and writes
 * `browser.json`, `workspace.strata.zip` and `content.json`. Every run
 * checks that the content documents of every version read through today's
 * bindings as they did when written: a note's text and meta, a list's
 * items, a board's elements, files and widgets. The core's half — the
 * folder, the API's answers, every document's value in all three stores —
 * is `crates/strata-core/tests/corpus.rs` and its `write_corpus` example.
 */

const CORPUS = new URL('../../../corpus/', import.meta.url);

/** A 1×1 PNG: an asset of one's own. */
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

beforeAll(async () => {
  await loadCore(readFileSync(new URL('../pkg/strata_core_bg.wasm', import.meta.url)));
});

/** A list's item as the corpus keeps it: its text, tick and children, not its tree id. */
interface ItemFacts {
  text: string;
  done: boolean;
  items: ItemFacts[];
}

/** What today's bindings read of one content document. */
interface ContentFacts {
  /** The node it belongs to, for a reader of the file. */
  node?: string;
  text?: string;
  meta?: Record<string, unknown>;
  items?: ItemFacts[];
  elements?: { id: string; type: string; text?: string; link?: string; deleted?: boolean }[];
  files?: { id: string; mimeType: string }[];
  widgets?: { id: string; kind: string; text: string; todo?: { text: string; done: boolean }[] }[];
}

function itemFacts(i: Item): ItemFacts {
  return { text: i.text, done: i.done, items: i.items.map(itemFacts) };
}

/** Every part of a content document the bindings know, the empty ones left out. */
function contentFacts(doc: LoroDoc): ContentFacts {
  const out: ContentFacts = {};
  const text = doc.getText('text').toString();
  if (text) out.text = text;
  const meta = doc.getMap('meta').toJSON() as Record<string, unknown>;
  if (Object.keys(meta).length > 0) out.meta = meta;
  const items = new Checklist(doc).items();
  if (items.length > 0) out.items = items.map(itemFacts);
  const elements = readElements(doc);
  if (elements.length > 0) {
    out.elements = elements.map((e) => ({
      id: e.id,
      type: String(e.type),
      ...(typeof e.text === 'string' ? { text: e.text } : {}),
      ...(typeof e.link === 'string' ? { link: e.link } : {}),
      ...(e.isDeleted ? { deleted: true } : {}),
    }));
  }
  const files = readFiles(doc);
  if (files.length > 0) {
    out.files = files
      .map((f) => ({ id: f.id, mimeType: f.mimeType }))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
  }
  const widgets = Object.keys(widgetsOf(doc).toJSON() as Record<string, unknown>).sort();
  if (widgets.length > 0) {
    out.widgets = widgets.map((id) => {
      const kind = widgetKind(doc, id) ?? '';
      return {
        id,
        kind,
        text: widgetText(doc, id),
        ...(kind === 'todo'
          ? { todo: todoItems(doc, id).map((t) => ({ text: t.text, done: t.done })) }
          : {}),
      };
    });
  }
  return out;
}

/** The browser's store as `MemoryStore::to_bytes` writes it: each document's updates in base64. */
interface BrowserStore {
  docs: Record<string, string[]>;
}

function docOf(store: BrowserStore, id: string): LoroDoc {
  const doc = new LoroDoc();
  const updates = store.docs[id];
  if (!updates) throw new Error(`no document ${id}`);
  doc.importBatch(updates.map((u) => Uint8Array.from(Buffer.from(u, 'base64'))));
  return doc;
}

/** The corpus's entries: folders with what this half wrote. */
function versions(): string[] {
  if (!existsSync(CORPUS)) return [];
  return readdirSync(CORPUS, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(new URL(`${d.name}/content.json`, CORPUS)))
    .map((d) => d.name)
    .sort();
}

function ended(job: ImportJob): Promise<ImportReport> {
  return new Promise((ok, fail) => {
    job.watch((e) => {
      if (e.type === 'progress' && e.progress.report) ok(e.progress.report);
      else if (e.type === 'failed') fail(new Error(e.message));
      else if (e.type === 'cancelled') fail(new Error('cancelled'));
    });
  });
}

/** A content document changed as a window changes it: its update pushed to the core. */
async function edit(core: Core, id: string, change: (doc: LoroDoc) => void): Promise<void> {
  const doc = new LoroDoc();
  doc.import(await core.openDoc(`content/${id}`));
  const before = doc.oplogVersion();
  change(doc);
  doc.commit();
  await core.pushDoc(`content/${id}`, doc.export({ mode: 'update', from: before }));
}

/**
 * This version's workspace: V-synth imported (13 §3), then what a user
 * makes on top — every kind, the attributes of 05 §4, people, flags,
 * sizes, a wire style, backgrounds, a kind's icon, wires, an appearance,
 * the trash, a note's text with `[[links]]` and a ghost, a list, board
 * widgets, a rename that rewrites links, undo, redo and a revert (10 §9.3).
 */
async function makeWorkspace(core: Core, root: string): Promise<void> {
  const step = (ops: CoreOp[], key: string, params?: ChangeLabel['params']) =>
    core.apply(ops, params ? { key, params } : { key });
  // The canvas names a node before the core makes it (`newId`), as here.
  const node = async (kind: NodeKind, name: string, net: string, x: number, y: number) => {
    const id = newId();
    await step([{ op: 'createNode', id, kind, name, net, x, y }], 'proto.change.create', { name });
    return id;
  };

  const archive = await node('network', 'Архив', root, 0, 900);
  const release = await node('project', 'Выпуск', root, 400, 900);
  const task = await node('task', 'Проверить корпус', release, 0, 0);
  const list = await node('checklist', 'Сборы', root, 800, 900);
  const board = await node('board', 'Виджеты', root, 1200, 900);
  const fresh = await node('note', 'Свежая', root, 1600, 900);
  const picture = await node('asset', 'Точка', root, 2000, 900);
  const site = await node('asset', 'Сайт', root, 2400, 900);

  // Attributes (05 §4): a task's, a picture's file, a link, a colour, an icon.
  await step(
    [
      { op: 'setAttr', id: task, key: 'status', value: 'doing' },
      { op: 'setAttr', id: task, key: 'start', value: '2026-11-09' },
      { op: 'setAttr', id: task, key: 'deadline', value: '2026-12-01' },
      { op: 'setAttr', id: task, key: 'priority', value: 'high' },
    ],
    'change.attr',
    { name: 'Проверить корпус', field: 'status' },
  );
  const sha = await core.putAsset(Uint8Array.from(Buffer.from(PNG, 'base64')));
  await step(
    [
      { op: 'setAttr', id: picture, key: 'asset', value: sha },
      { op: 'setAttr', id: picture, key: 'mime', value: 'image/png' },
    ],
    'change.file',
    { name: 'Точка' },
  );
  await step(
    [{ op: 'setAttr', id: site, key: 'url', value: 'https://example.org/' }],
    'change.link',
    {
      name: 'Сайт',
    },
  );
  await step([{ op: 'setAttr', id: fresh, key: 'color', value: 3 }], 'change.color', { n: 1 });
  await step(
    [{ op: 'setAttr', id: archive, key: 'icon', value: 'game-icons/lorc/open-book' }],
    'change.icon',
    { n: 1 },
  );
  // People (05 §10), flags (05 §7), a size by hand (06 §4.2).
  const person = newId();
  await step([{ op: 'addPerson', id: person, name: 'Аня' }], 'change.assign', { name: 'Аня' });
  await step([{ op: 'assign', id: task, person, on: true }], 'change.assign', {
    name: 'Проверить корпус',
  });
  await step(
    [{ op: 'setFlag', id: list, flag: 'template', on: true }],
    'proto.change.flag.template.on',
    {
      n: 1,
    },
  );
  await step([{ op: 'setFlag', id: release, flag: 'key', on: true }], 'proto.change.flag.key.on', {
    n: 1,
  });
  await step([{ op: 'setFlag', id: task, flag: 'pause', on: true }], 'proto.change.flag.pause.on', {
    n: 1,
  });
  await step([{ op: 'setSize', id: fresh, net: root, size: 'l' }], 'change.size', { n: 1 });
  // A network's look: its wires, the workspace's and a network's background, a kind's icon.
  await step(
    [{ op: 'setWireStyle', net: release, style: 'straight' }],
    'proto.change.wires.straight',
  );
  const fog = {
    source: 'preset:fog',
    blur: 8,
    desaturate: 0.6,
    maxL: 0.08,
    vignette: 0.4,
    grain: 0.2,
    fog: 0.3,
    animated: false,
  };
  await step(
    [{ op: 'setBackground', net: root, background: fog }],
    'ws.change.workspaceBackground',
  );
  await step(
    [{ op: 'setBackground', net: release, background: { ...fog, source: `asset:${sha}` } }],
    'ws.change.background',
  );
  await step(
    [{ op: 'setKindIcon', kind: 'note', icon: 'game-icons/lorc/book-cover' }],
    'change.kindIcon',
    {
      kind: 'note',
    },
  );
  // Wires and an appearance (05 §5, §8).
  await step([{ op: 'connect', from: fresh, to: list }], 'proto.change.connect', { name: 'Сборы' });
  await step([{ op: 'connect', from: release, to: archive }], 'proto.change.connect', {
    name: 'Архив',
  });
  await step([{ op: 'place', id: fresh, net: release, x: 300, y: 0 }], 'ws.change.place', {
    name: 'Свежая',
  });

  // Content documents as the windows write them (10 §2.4).
  await edit(core, fresh, (doc) =>
    doc.getText('text').insert(0, '# Свежая\n\nСо ссылкой на [[Входящие]] и на [[Нет такой]].\n'),
  );
  await edit(core, task, (doc) =>
    doc.getText('text').insert(0, 'Открыть корпус **каждой** версией.\n'),
  );
  await edit(core, list, (doc) => {
    const c = new Checklist(doc);
    const tent = c.add('Палатка');
    c.setDone(tent, true);
    const food = c.add('Еда');
    c.add('Хлеб', food);
    c.add('Сыр', food);
  });
  await edit(core, board, (doc) => {
    createWidget(doc, 'note1', 'note');
    setNoteText(doc, 'note1', 'Заметка на доске');
    createWidget(doc, 'todo1', 'todo');
    addTodo(doc, 'todo1', 0, 'Купить плёнку');
    addTodo(doc, 'todo1', 1, 'Проявить');
    setTodoDone(doc, 'todo1', 0, true);
  });

  // The trash and back (05 §11), a rename that rewrites `[[links]]` (13 §6.5).
  const tree = await core.tree();
  const named = (name: string) => {
    const n = tree.find((t) => t.name === name);
    if (!n) throw new Error(`no «${name}» in V-synth`);
    return n.id;
  };
  await step([{ op: 'trash', ids: [named('note-9')] }], 'proto.change.delete', { n: 1 });
  await step([{ op: 'trash', ids: [named('note-8')] }], 'proto.change.delete', { n: 1 });
  await step([{ op: 'restore', ids: [named('note-8')] }], 'ws.change.restore', { name: 'note-8' });
  await step(
    [{ op: 'rename', id: named('Входящие'), name: 'Входящие дела' }],
    'proto.change.rename',
    {
      name: 'Входящие дела',
    },
  );
  // Undo and redo, and a changeset reverted from the journal (10 §9.3).
  await step([{ op: 'move', net: root, id: fresh, x: 1700, y: 950 }], 'proto.change.move');
  await core.undo();
  await core.redo();
  const colour = (await core.journal(undefined, 500)).entries.find(
    (e) => e.label.key === 'change.color',
  );
  if (!colour) throw new Error('no colour changeset');
  await core.revertChangeset(colour.id);
}

describe('format corpus (NFR-78)', () => {
  const write = process.env.STRATA_CORPUS_WRITE;

  it.runIf(write)('writes this version into the corpus', { timeout: 120_000 }, async () => {
    const dir = new URL(`${write}/`, CORPUS);
    if (existsSync(new URL('content.json', dir))) {
      throw new Error(`corpus/${write} is written: an entry is never changed, a new one is added`);
    }
    mkdirSync(dir, { recursive: true });
    const shelf = memoryShelf();
    const home = await browserHome(shelf);
    const r = await home.importVault(
      { name: 'Корпус', files: vsynthVault() },
      { unlinked: 'Вложения без ссылок', text: 'текст' },
    );
    await ended(r.job);
    await makeWorkspace(home.core, r.root);
    const tree = await home.core.tree();
    const zip = await home.exportArchive(r.workspace.id);
    await home.close();
    const bytes = await shelf.get(`ws:${r.workspace.id}`);
    if (!bytes || !zip) throw new Error('the workspace was not kept');
    const store = JSON.parse(new TextDecoder().decode(bytes)) as BrowserStore;
    const content: Record<string, ContentFacts> = {};
    for (const id of Object.keys(store.docs).sort()) {
      if (!id.startsWith('content/')) continue;
      const node = tree.find((n) => `content/${n.id}` === id)?.name;
      content[id] = { ...(node ? { node } : {}), ...contentFacts(docOf(store, id)) };
    }
    writeFileSync(new URL('browser.json', dir), bytes);
    writeFileSync(new URL('workspace.strata.zip', dir), zip);
    writeFileSync(new URL('content.json', dir), `${JSON.stringify(content, null, 2)}\n`);
  });

  for (const v of versions()) {
    it(`the content documents of ${v} read as they were written`, () => {
      const dir = new URL(`${v}/`, CORPUS);
      const store = JSON.parse(readFileSync(new URL('browser.json', dir), 'utf8')) as BrowserStore;
      const want = JSON.parse(readFileSync(new URL('content.json', dir), 'utf8')) as Record<
        string,
        ContentFacts
      >;
      expect(Object.keys(want).length).toBeGreaterThan(0);
      for (const [id, { node, ...facts }] of Object.entries(want)) {
        expect(contentFacts(docOf(store, id)), `${id} (${node ?? '?'})`).toEqual(facts);
      }
    });
  }
});
