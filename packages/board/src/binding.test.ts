import { LoroDoc } from 'loro-crdt';
import { describe, expect, it } from 'vitest';
import {
  type BoardElement,
  newer,
  readElements,
  readFiles,
  reconcile,
  writeFiles,
  writeLocal,
} from './binding';

function rng(seed: number) {
  let x = seed | 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 4294967296;
  };
}

const rect = (id: string, i: number): BoardElement => ({
  id,
  type: 'rectangle',
  x: (i % 50) * 30,
  y: Math.floor(i / 50) * 30,
  width: 20,
  height: 20,
  version: 1,
  versionNonce: 1000 + i,
  index: `a${String(i).padStart(5, '0')}`,
  isDeleted: false,
});

/** A client: its document and the scene Excalidraw would hold. */
interface Client {
  doc: LoroDoc;
  scene: Map<string, BoardElement>;
}

function edit(c: Client, r: () => number, ids: string[], k: number): void {
  const touched: string[] = [];
  for (let n = 0; n < 40; n++) {
    const id = ids[Math.floor(r() * ids.length)] as string;
    const el = c.scene.get(id);
    if (!el) continue;
    const kind = r();
    const next: BoardElement = {
      ...el,
      version: el.version + 1,
      versionNonce: Math.floor(r() * 1e9),
      ...(kind < 0.1 ? { isDeleted: true } : { x: (el.x as number) + Math.round(r() * 20 - 10) }),
    };
    c.scene.set(id, next);
    touched.push(id);
  }
  // A new element now and then.
  if (r() < 0.5) {
    const id = `new-${k}-${Math.floor(r() * 1e6)}`;
    c.scene.set(id, rect(id, ids.length + k));
    ids.push(id);
    touched.push(id);
  }
  writeLocal(c.doc, [...c.scene.values()], touched);
}

function syncAll(clients: Client[]): void {
  for (const a of clients) {
    for (const b of clients) {
      if (a === b) continue;
      b.doc.import(a.doc.export({ mode: 'update', from: b.doc.version() }));
    }
  }
  // Each client merges what came in and writes back what it holds newer.
  for (const c of clients) {
    const { elements, writeBack } = reconcile([...c.scene.values()], readElements(c.doc));
    c.scene = new Map(elements.map((e) => [e.id, e]));
    writeLocal(c.doc, elements, writeBack);
  }
}

describe('board binding: Excalidraw ↔ LoroMap (ADR-0006 item 7, 10 §15 item 2)', () => {
  it('follows Excalidraw: a higher version wins, on a tie the lower nonce', () => {
    const a = { id: 'x', version: 3, versionNonce: 9 };
    expect(newer(a, { id: 'x', version: 2, versionNonce: 1 })).toBe(true);
    expect(newer(a, { id: 'x', version: 3, versionNonce: 10 })).toBe(true);
    expect(newer(a, { id: 'x', version: 3, versionNonce: 5 })).toBe(false);
    expect(newer(a, undefined)).toBe(true);
  });

  it('keeps the element under the hands of the user while a gesture lasts', () => {
    const local = [{ id: 'a', version: 2, versionNonce: 1, x: 10 }];
    const remote = [{ id: 'a', version: 5, versionNonce: 1, x: 99 }];
    const merged = reconcile(local, remote, new Set(['a']));
    expect(merged.elements[0]?.x).toBe(10);
    expect(reconcile(local, remote).elements[0]?.x).toBe(99);
  });

  it('converges three clients on 2 000 elements after concurrent edits (B-2k)', () => {
    const r = rng(42);
    const ids = Array.from({ length: 2000 }, (_, i) => `el-${i}`);
    const seed = new LoroDoc();
    writeLocal(seed, ids.map(rect));
    const snapshot = seed.export({ mode: 'snapshot' });
    const clients: Client[] = [1n, 2n, 3n].map((peer) => {
      const doc = LoroDoc.fromSnapshot(snapshot);
      doc.setPeerId(peer);
      return { doc, scene: new Map(readElements(doc).map((e) => [e.id, e])) };
    });
    for (let round = 0; round < 30; round++) {
      for (const [k, c] of clients.entries()) edit(c, r, ids, round * 3 + k);
      // Every other round only two of them talk: partial syncs before the full one.
      if (round % 2 === 0) {
        const [a, b] = clients as [Client, Client, Client];
        b.doc.import(a.doc.export({ mode: 'update', from: b.doc.version() }));
      } else syncAll(clients);
    }
    syncAll(clients);
    syncAll(clients);
    const views = clients.map((c) => JSON.stringify(readElements(c.doc)));
    expect(new Set(views).size).toBe(1);
    const scenes = clients.map((c) => JSON.stringify([...c.scene.values()]));
    expect(scenes[0]).toBe(views[0]);
    expect(new Set(scenes).size).toBe(1);
    // Every element is at the newest version anyone wrote.
    for (const el of readElements(clients[0]?.doc as LoroDoc)) {
      for (const c of clients) {
        const mine = c.scene.get(el.id);
        expect(mine && newer(mine, el)).toBeFalsy();
      }
    }
  });
});

describe('files', () => {
  const png = (id: string) => ({
    id,
    mimeType: 'image/png',
    dataURL: `data:image/png;base64,${id}`,
    created: 1,
  });

  it('writes a file once and merges files by id across clients', () => {
    const a = new LoroDoc();
    const b = new LoroDoc();
    expect(writeFiles(a, [png('f1')])).toBe(1);
    expect(writeFiles(a, [png('f1')])).toBe(0);
    expect(writeFiles(b, [png('f2'), png('f1')])).toBe(2);
    a.import(b.export({ mode: 'update' }));
    b.import(a.export({ mode: 'update' }));
    const ids = (d: LoroDoc) =>
      readFiles(d)
        .map((f) => f.id)
        .sort();
    expect(ids(a)).toEqual(['f1', 'f2']);
    expect(ids(b)).toEqual(['f1', 'f2']);
    expect(readFiles(a).find((f) => f.id === 'f2')?.dataURL).toBe('data:image/png;base64,f2');
  });
});
