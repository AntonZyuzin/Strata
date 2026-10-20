import { LoroDoc } from 'loro-crdt/web';
// The `web` index re-exports the wasm initializer at runtime but not in its types.
import init from 'loro-crdt/web/loro_wasm.js';
import { rng, round, type Summary, summarize } from './stats';

/**
 * Spike 4 inside the WebView (10 §15 item 3): the index layout of 10 §2.3
 * built, exported and cold-imported by the WASM build of Loro, as WKWebView
 * and WebView2 run it on the owner's machines.
 */

let wasm: { memory: WebAssembly.Memory } | null = null;

async function ready() {
  if (!wasm) wasm = await init();
  return wasm;
}

const wasmMib = () => round((wasm?.memory.buffer.byteLength ?? 0) / 1048576, 1);

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 26-character time-ordered ids in the Crockford base32 form of 05 §4.1. */
function ids(n: number, seed: number): string[] {
  const r = rng(seed);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    let s = '';
    let ms = 1_760_000_000_000 + i;
    for (let k = 0; k < 10; k++) {
      s = ALPHABET[ms % 32] + s;
      ms = Math.floor(ms / 32);
    }
    for (let k = 0; k < 16; k++) s += ALPHABET[Math.floor(r() * 32)];
    out.push(s);
  }
  return out;
}

const EDITS = 500;
const KEYSTROKES = 1000;

const KINDS = ['note', 'note', 'note', 'network', 'board', 'checklist', 'media'];
const STATUSES = ['inbox', 'todo', 'doing', 'review', 'done', 'cancelled'];
const TAGS = ['art', 'sound', 'code', 'design', 'bug', 'idea'];

/** Yields to the event loop every few thousand nodes so the window keeps repainting. */
const CHUNK = 2_000;
const tick = () => new Promise((r) => setTimeout(r, 0));

async function buildIndex(
  n: number,
  commitEvery: number,
): Promise<{ doc: LoroDoc; keys: string[]; buildMs: number }> {
  const keys = ids(n, 42);
  const r = rng(5);
  const nets = keys.filter((_, i) => i % 7 === 0);
  const doc = new LoroDoc();
  doc.setPeerId(1n);
  const kind = doc.getMap('kind');
  const name = doc.getMap('name');
  const icon = doc.getMap('icon');
  const createdAt = doc.getMap('createdAt');
  const status = doc.getMap('status');
  const set = doc.getMap('set');
  const placement = doc.getMap('placement');
  const primaryNet = doc.getMap('primaryNet');
  const edge = doc.getMap('edge');
  const edgeOrigin = doc.getMap('edgeOrigin');
  let buildMs = 0;
  let t0 = performance.now();
  for (let i = 0; i < n; i++) {
    if (i > 0 && i % CHUNK === 0) {
      buildMs += performance.now() - t0;
      await tick();
      t0 = performance.now();
    }
    const k = keys[i] ?? '';
    kind.set(k, i % 7 === 0 ? 'network' : (KINDS[Math.floor(r() * KINDS.length)] ?? 'note'));
    name.set(k, `Заметка ${i}`);
    icon.set(k, `game-icons/lorc/${Math.floor(r() * 4000)}`);
    createdAt.set(k, 1_760_000_000_000 + i);
    if (r() < 0.5) status.set(k, STATUSES[Math.floor(r() * STATUSES.length)] ?? 'todo');
    if (r() < 0.5) set.set(`${k}|tags|${TAGS[Math.floor(r() * TAGS.length)]}`, 1);
    if (i > 0) {
      const net = nets[Math.floor(r() * nets.length)] ?? '';
      placement.set(`${net}/${k}`, 1_760_000_000_000 + i);
      primaryNet.set(k, net);
    }
    const out = Math.floor(r() * 4);
    for (let j = 0; j < out; j++) {
      const target = keys[Math.floor(r() * n)] ?? '';
      const ek = `${k.slice(0, 13)}${target.slice(13)}`;
      edge.set(ek, `${k}>${target}`);
      edgeOrigin.set(`${ek}|${r() < 0.33 ? 'text' : 'manual'}`, 1);
    }
    if ((i + 1) % commitEvery === 0) doc.commit();
  }
  doc.commit();
  return { doc, keys, buildMs: buildMs + performance.now() - t0 };
}

export interface LoroIndexResult {
  nodes: number;
  commitEvery: number;
  buildMs: number;
  snapshotMib: number;
  importMs: number;
  countNamesMs: number;
  firstEditMs: number;
  /** Per edit. WebKit rounds timers to 1 ms, so p50/p95 there are 0 or 1; see `editMeanMs`. */
  editMs: Summary;
  /** Total time of all edits over their count: exact even with a coarse timer. */
  editMeanMs: number;
  wasmMemoryMib: number;
}

export async function runLoroIndex(nodes: number, commitEvery: number): Promise<LoroIndexResult> {
  await ready();
  const built = await buildIndex(nodes, commitEvery);
  const snapshot = built.doc.export({ mode: 'snapshot' });
  built.doc.free();
  await new Promise((r) => setTimeout(r, 50));

  let t = performance.now();
  const doc = new LoroDoc();
  doc.import(snapshot);
  const importMs = performance.now() - t;

  t = performance.now();
  const count = doc.getMap('name').size;
  const countNamesMs = performance.now() - t;
  if (count !== nodes) throw new Error(`expected ${nodes} names, got ${count}`);

  const status = doc.getMap('status');
  const keys = built.keys;
  t = performance.now();
  status.set(keys[0] ?? '', 'doing');
  doc.commit();
  const firstEditMs = performance.now() - t;
  const edits: number[] = [];
  const editsStart = performance.now();
  for (let i = 1; i <= EDITS; i++) {
    const k = keys[(i * 7919) % keys.length] ?? '';
    const s = performance.now();
    status.set(k, STATUSES[i % STATUSES.length] ?? 'todo');
    doc.commit();
    edits.push(performance.now() - s);
  }
  const editMeanMs = (performance.now() - editsStart) / EDITS;
  const memory = wasmMib();
  doc.free();
  return {
    nodes,
    commitEvery,
    buildMs: Math.round(built.buildMs),
    snapshotMib: round(snapshot.byteLength / 1048576, 1),
    importMs: round(importMs, 1),
    countNamesMs: round(countNamesMs, 1),
    firstEditMs: round(firstEditMs, 2),
    editMs: summarize(edits),
    editMeanMs: round(editMeanMs, 4),
    wasmMemoryMib: memory,
  };
}

export interface LoroTextResult {
  chars: number;
  insert1MbMs: number;
  keystrokeMs: Summary;
  /** As `editMeanMs` of the index. */
  keystrokeMeanMs: number;
}

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
