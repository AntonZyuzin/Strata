// Spike 4, WASM side (10 §15 items 3 and 5). Run after the Rust spike:
//   cargo run --release -p spike-loro-index -- bench-results/loro
//   pnpm --filter @strata/spike-loro-wasm bench
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { LoroDoc } from 'loro-crdt';
import { stateHash } from './canonical.mjs';

const out = process.argv[2] ?? '../../bench-results/loro';
const mib = (b) => Math.round((b / 1048576) * 10) / 10;
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.round((s.length - 1) * p)] ?? 0;
};
const gc = () => globalThis.gc?.();

// Item 5a: a snapshot written by Rust opens here with the same state.
function interopFromRust() {
  const snap = join(out, 'rust-index-10000.snapshot');
  if (!existsSync(snap)) return { rust_snapshot_found: false };
  const doc = new LoroDoc();
  doc.import(readFileSync(snap));
  const expected = readFileSync(join(out, 'rust-index-10000.hash'), 'utf8').trim();
  const got = stateHash(doc);
  return { rust_snapshot_found: true, hash_equal: got === expected, wasm_hash: got, rust_hash: expected };
}

// Item 5b: a document written here, for the Rust side to open.
function writeForRust() {
  const doc = new LoroDoc();
  doc.setPeerId(77n);
  const id = (i) => `01M5AT${String(i).padStart(20, '0')}`;
  for (let i = 0; i < 1000; i++) {
    const key = id(i);
    doc.getMap('kind').set(key, i % 7 === 0 ? 'network' : 'note');
    doc.getMap('name').set(key, `Заметка ${i} — «тест»`);
    doc.getMap('createdAt').set(key, 1760000000000 + i);
    if (i % 3 === 0) doc.getMap('set').set(`${key}|tags|art`, 1);
    doc.commit();
  }
  doc.getText('text').insert(0, 'Текст из WASM: [[ссылка]] и ёлочки «»\n');
  doc.commit();
  writeFileSync(join(out, 'js-index.snapshot'), doc.export({ mode: 'snapshot' }));
  writeFileSync(join(out, 'js-index.hash'), stateHash(doc));
  return { written: true, nodes: 1000 };
}

// Item 3: cold import, memory and field edits of the 100 k index.
function indexBench(dir) {
  const path = join(out, dir);
  if (!existsSync(path)) return { dir, found: false };
  const files = readdirSync(path).filter((f) => f.endsWith('.snapshot')).sort();
  const bytes = files.map((f) => readFileSync(join(path, f)));
  gc();
  const m0 = process.memoryUsage();
  let t = performance.now();
  const docs = bytes.map((b) => {
    const d = new LoroDoc();
    d.import(b);
    return d;
  });
  const importMs = performance.now() - t;
  gc();
  const m1 = process.memoryUsage();
  t = performance.now();
  let names = 0;
  for (const d of docs) names += d.getMap('name').size;
  const sizeMs = performance.now() - t;
  t = performance.now();
  let entries = 0;
  for (const d of docs) for (const f of ['kind', 'name', 'icon', 'status', 'deadline', 'primaryNet', 'placement', 'edge']) entries += Object.keys(d.getMap(f).toJSON()).length;
  const materialiseMs = performance.now() - t;
  gc();
  const m2 = process.memoryUsage();
  const keys = Object.keys(docs[0].getMap('name').toJSON());
  const edits = [];
  for (let i = 0; i < 500; i++) {
    const d = docs[i % docs.length];
    const k = keys[(i * 7919) % keys.length];
    const s = performance.now();
    d.getMap('status').set(k, 'doing');
    d.commit();
    edits.push(performance.now() - s);
  }
  return {
    dir,
    shards: files.length,
    snapshot_mib: mib(bytes.reduce((a, b) => a + b.length, 0)),
    import_ms: importMs,
    names,
    count_names_ms: sizeMs,
    materialise_fields_ms: materialiseMs,
    entries,
    rss_after_import_mib: mib(m1.rss),
    rss_index_after_import_mib: mib(m1.rss - m0.rss),
    rss_after_read_mib: mib(m2.rss),
    rss_index_after_read_mib: mib(m2.rss - m0.rss),
    field_edit_ms: { p50: pct(edits, 0.5), p95: pct(edits, 0.95), max: pct(edits, 1) },
  };
}

function textBench() {
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
  const keys = [];
  for (let i = 0; i < 1000; i++) {
    const pos = (i * 7919) % len;
    t = performance.now();
    text.insert(pos, 'ы');
    doc.commit();
    keys.push(performance.now() - t);
  }
  return { chars: big.length, insert_1mb_ms: insertMs, keystroke_ms: { p50: pct(keys, 0.5), p95: pct(keys, 0.95), max: pct(keys, 1) } };
}

const report = {
  spike: '4-loro',
  engine: 'loro-crdt (WASM) in Node',
  node: process.version,
  interop_from_rust: interopFromRust(),
  wrote_for_rust: writeForRust(),
  index: ['rust-index-10000-k1', 'rust-index-100000-k1', 'rust-index-100000-k16'].map(indexBench),
  text: textBench(),
};
writeFileSync(join(out, 'wasm-node-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
