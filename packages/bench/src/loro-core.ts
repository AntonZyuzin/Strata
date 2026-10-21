import { LoroDoc } from 'loro-crdt/web';
// The `web` index re-exports the wasm initializer at runtime but not in its types.
import init from 'loro-crdt/web/loro_wasm.js';
import { rng, round, type Summary, summarize } from './stats';

/**
 * Spike 4 inside the WebView (10 §15 item 3): the index layout of 10 §2.3
 * built, exported and cold-imported by the WASM build of Loro. No Worker
 * references here: this module runs both in the bench workers and, as a
 * fallback, on the main thread.
 */

let wasm: { memory: WebAssembly.Memory } | null = null;

async function ready() {
  if (!wasm) wasm = await init();
  return wasm;
}

/** Size of this instance's WASM memory. It only grows, so it is a high-water mark. */
const wasmMib = () => round((wasm?.memory.buffer.byteLength ?? 0) / 1048576, 1);

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * 26-character time-ordered ids in the Crockford base32 form of 05 §4.1.
 * Built as flat strings (join), not by concatenation: 100 000 rope strings
 * would keep the JS heap five times larger and put GC pauses into the timings.
 */
export function ids(n: number, seed: number): string[] {
  const r = rng(seed);
  const out: string[] = [];
  const chars = new Array<string>(26);
  for (let i = 0; i < n; i++) {
    let ms = 1_760_000_000_000 + i;
    for (let k = 9; k >= 0; k--) {
      chars[k] = ALPHABET[ms % 32] ?? '0';
      ms = Math.floor(ms / 32);
    }
    for (let k = 10; k < 26; k++) chars[k] = ALPHABET[Math.floor(r() * 32)] ?? '0';
    out.push(chars.join(''));
  }
  return out;
}

/**
 * Wire key: 128 uniformly spread bits of (from, to) as 26 base32 characters,
 * like `h(from ‖ to)` of 10 §2.5 (strata-model uses SHA-256; a sync
 * non-cryptographic hash keeps the same key shape and spread for the bench).
 */
export function edgeKey(from: string, to: string): string {
  const s = `${from}>${to}`;
  // cyrb128: four 32-bit lanes.
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ c, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ c, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ c, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ c, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  const lanes = [h1 ^ h2 ^ h3 ^ h4, h2 ^ h1, h3 ^ h1, h4 ^ h1].map((x) => x >>> 0);
  // 128 bits -> 26 characters of 5 bits (the last two bits are zero, as in a 16-byte key).
  const chars = new Array<string>(26);
  let acc = 0;
  let bits = 0;
  let lane = 0;
  for (let k = 0; k < 26; k++) {
    if (bits < 5) {
      const next = lanes[lane++] ?? 0;
      acc = acc * 2 ** 32 + next;
      bits += 32;
    }
    bits -= 5;
    const v = Math.floor(acc / 2 ** bits) % 32;
    acc = acc % 2 ** bits;
    chars[k] = ALPHABET[v] ?? '0';
  }
  return chars.join('');
}

/**
 * Shard of a node for the bench: FNV-1a of the key, mod K. strata-model
 * hashes with SHA-256 (10 §2.5); here only an even spread matters.
 */
function shardOf(key: string, k: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % k;
}

const EDITS = 500;
const KEYSTROKES = 1000;
const SEED = 42;

// The same vocabulary and proportions as the spike 4 generator (spikes/loro-index),
// so that sizes and times compare with S4-loro.md.
const WORDS = [
  'Проект',
  'Задача',
  'Референсы',
  'Идея',
  'Сцена',
  'Персонаж',
  'Уровень',
  'Баг',
  'Заметка',
  'Диздок',
  'Звук',
  'Арт',
  'Сюжет',
  'Спринт',
  'Встреча',
  'Шейдер',
  'Анимация',
  'Интерфейс',
  'Project',
  'Task',
  'Notes',
  'Board',
  'Draft',
  'Research',
  'Prototype',
  'Level',
  'Asset',
  'Lighting',
  'Camera',
  'Gameplay',
  'Story',
  'Roadmap',
];
const KINDS = ['note', 'note', 'note', 'network', 'board', 'checklist', 'media'];
const STATUSES = ['inbox', 'todo', 'doing', 'review', 'done', 'cancelled'];
const TAGS = ['art', 'sound', 'code', 'design', 'bug', 'idea', 'ref', 'urgent'];
const TS = 1_760_000_000_000;
const DAY = 86_400_000;

/** Yields to the event loop every few thousand nodes so a main-thread run keeps repainting. */
const CHUNK = 2_000;
const tick = () => new Promise((r) => setTimeout(r, 0));

export interface BuiltIndex {
  snapshots: Uint8Array[];
  buildMs: number;
  snapshotMib: number;
}

/**
 * Builds the index of `n` nodes over `shards` documents, field for field as
 * spike 4 does (10 §2.3): all fields of a node, its placements and outgoing
 * wires go to the node's shard; `commitEvery = 1` is one commit per node, as
 * creating a node is one changeset.
 */
export async function buildIndex(
  n: number,
  commitEvery: number,
  shards: number,
): Promise<BuiltIndex> {
  await ready();
  const keys = ids(n, SEED);
  const r = rng(5);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
  const nets = keys.filter((_, i) => i === 0 || i % 7 === 0);
  const docs = Array.from({ length: shards }, (_, s) => {
    const doc = new LoroDoc();
    doc.setPeerId(BigInt(s + 1));
    const map = (name: string) => doc.getMap(name);
    return {
      doc,
      kind: map('kind'),
      name: map('name'),
      icon: map('icon'),
      createdAt: map('createdAt'),
      status: map('status'),
      deadline: map('deadline'),
      summary: map('summary'),
      set: map('set'),
      flag: map('flag'),
      placement: map('placement'),
      primaryNet: map('primaryNet'),
      edge: map('edge'),
      edgeOrigin: map('edgeOrigin'),
      dirty: false,
    };
  });
  let buildMs = 0;
  let t0 = performance.now();
  for (let i = 0; i < n; i++) {
    if (i > 0 && i % CHUNK === 0) {
      buildMs += performance.now() - t0;
      await tick();
      t0 = performance.now();
    }
    const k = keys[i] ?? '';
    const d = docs[shardOf(k, shards)];
    if (!d) continue;
    d.dirty = true;
    d.kind.set(k, i === 0 || i % 7 === 0 ? 'network' : pick(KINDS));
    d.name.set(k, `${pick(WORDS)} ${i}`);
    d.icon.set(k, `game-icons/lorc/${Math.floor(r() * 4000)}`);
    d.createdAt.set(k, TS + i);
    if (r() < 0.5) d.status.set(k, pick(STATUSES));
    if (r() < 0.2) d.deadline.set(k, TS + Math.floor(r() * 90 * DAY));
    if (r() < 0.1) d.summary.set(k, 'Краткая справка о ноде для подсказки и 3D-карты.');
    for (let t = Math.floor(r() * 3); t > 0; t--) d.set.set(`${k}|tags|${pick(TAGS)}`, 1);
    if (r() < 0.05) d.flag.set(`${k}|key`, 1);
    // A primary placement, and an instance in a second network for one node in ten.
    if (i > 0) {
      const primary = pick(nets);
      d.placement.set(`${primary}/${k}`, TS + i);
      d.primaryNet.set(k, primary);
      if (r() < 0.1) {
        const other = pick(nets);
        if (other !== primary) d.placement.set(`${other}/${k}`, TS + i);
      }
    }
    // 1.5 outgoing wires per node on average, a third of them from [[links]].
    for (let j = Math.floor(r() * 4); j > 0; j--) {
      const target = pick(keys);
      if (target === k) continue;
      const ek = edgeKey(k, target);
      d.edge.set(ek, `${k}>${target}`);
      d.edgeOrigin.set(`${ek}|${r() < 0.33 ? 'text' : 'manual'}`, TS + i);
    }
    // One commit per `commitEvery` nodes, as the core commits per changeset.
    if ((i + 1) % commitEvery === 0) {
      for (const x of docs) {
        if (x.dirty) x.doc.commit();
        x.dirty = false;
      }
    }
  }
  const snapshots = docs.map((x) => {
    x.doc.commit();
    const s = x.doc.export({ mode: 'snapshot' });
    x.doc.free();
    return s;
  });
  buildMs += performance.now() - t0;
  const bytes = snapshots.reduce((a, s) => a + s.byteLength, 0);
  return { snapshots, buildMs: Math.round(buildMs), snapshotMib: round(bytes / 1048576, 1) };
}

export interface IndexMeasure {
  nodes: number;
  shards: number;
  /** Cold import of all shards. */
  importMs: number;
  countNamesMs: number;
  /** The first write after the lazy import materializes the map (S4: 72–116 ms at one shard of 100k). */
  firstEditMs: number;
  /** Per edit. WebKit rounds timers to 1 ms, so p50/p95 there are 0 or 1; see `editMeanMs`. */
  editMs: Summary;
  /** Total time of all edits over their count: exact even with a coarse timer. */
  editMeanMs: number;
  /** WASM memory of a fresh instance: before the import, after it, after the edits. */
  baseMemoryMib: number;
  importMemoryMib: number;
  wasmMemoryMib: number;
}

/**
 * Runs the import and edit paths once on a tiny document, so that the first
 * measured edit pays for materializing the map (what S4 measured), not for
 * the engine's first compilation of the code in a fresh worker.
 */
function warmUp() {
  const doc = new LoroDoc();
  doc.getMap('status').set('warm', 'todo');
  doc.commit();
  const copy = new LoroDoc();
  copy.import(doc.export({ mode: 'snapshot' }));
  copy.getMap('status').set('warm', 'done');
  copy.commit();
  copy.free();
  doc.free();
}

/** Cold import and edits, measured in this instance; meant to run in a fresh worker. */
export async function measureIndex(
  snapshots: Uint8Array[],
  n: number,
  shards: number,
): Promise<IndexMeasure> {
  await ready();
  // Keys first, so neither their allocation nor a GC of it lands in the timed part.
  const keys = ids(n, SEED);
  warmUp();
  const baseMemoryMib = wasmMib();
  let t = performance.now();
  const docs = snapshots.map((s) => {
    const doc = new LoroDoc();
    doc.import(s);
    return doc;
  });
  const importMs = performance.now() - t;
  const importMemoryMib = wasmMib();

  t = performance.now();
  const count = docs.reduce((a, d) => a + d.getMap('name').size, 0);
  const countNamesMs = performance.now() - t;
  if (count !== n) throw new Error(`expected ${n} names, got ${count}`);

  const edit = (k: string, value: string) => {
    const doc = docs[shardOf(k, shards)];
    doc?.getMap('status').set(k, value);
    doc?.commit();
  };
  t = performance.now();
  edit(keys[0] ?? '', 'doing');
  const firstEditMs = performance.now() - t;
  const edits: number[] = [];
  const editsStart = performance.now();
  for (let i = 1; i <= EDITS; i++) {
    const s = performance.now();
    edit(keys[(i * 7919) % keys.length] ?? '', STATUSES[i % STATUSES.length] ?? 'todo');
    edits.push(performance.now() - s);
  }
  const editMeanMs = (performance.now() - editsStart) / EDITS;
  const wasmMemoryMib = wasmMib();
  for (const d of docs) d.free();
  return {
    nodes: n,
    shards,
    importMs: round(importMs, 1),
    countNamesMs: round(countNamesMs, 1),
    firstEditMs: round(firstEditMs, 2),
    editMs: summarize(edits),
    editMeanMs: round(editMeanMs, 4),
    baseMemoryMib,
    importMemoryMib,
    wasmMemoryMib,
  };
}

export interface LoroTextResult {
  chars: number;
  insert1MbMs: number;
  keystrokeMs: Summary;
  /** As `editMeanMs` of the index. */
  keystrokeMeanMs: number;
}

/** 1 MB of Markdown as a CRDT text, on the main thread where the editor lives (ADR-0007). */
export async function runLoroText(): Promise<LoroTextResult> {
  await ready();
  const doc = new LoroDoc();
  const text = doc.getText('text');
  const line = 'Строка заметки с **жирным**, [[ссылкой]] и `кодом` — 0123456789.\n';
  let big = '';
  while (big.length < 1_000_000) big += line;
  let t = performance.now();
  text.insert(0, big);
  doc.commit();
  const insertMs = performance.now() - t;
  const len = text.length;
  const keys: number[] = [];
  const keysStart = performance.now();
  for (let i = 0; i < KEYSTROKES; i++) {
    t = performance.now();
    text.insert((i * 7919) % len, 'ы');
    doc.commit();
    keys.push(performance.now() - t);
  }
  const keystrokeMeanMs = (performance.now() - keysStart) / KEYSTROKES;
  doc.free();
  return {
    chars: big.length,
    insert1MbMs: round(insertMs, 1),
    keystrokeMs: summarize(keys),
    keystrokeMeanMs: round(keystrokeMeanMs, 4),
  };
}
