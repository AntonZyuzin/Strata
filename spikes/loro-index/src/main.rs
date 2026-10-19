//! Spike 4 (16 §3.2, 10 §15, ADR-0003): does Loro hold Strata's index?
//!
//! Builds the index shard documents exactly as laid out in 10 §2.3
//! ("map per field"), then measures what the acceptance criteria ask for:
//! snapshot size, cold import time, memory, field-edit latency, a 1 MB text
//! insert, convergence of concurrent replicas, and a byte format shared with
//! the WASM build (`spikes/loro-wasm`).
//!
//! Usage: `cargo run --release -p spike-loro-index -- [out_dir]`

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::time::Instant;

use loro::{ExportMode, LoroDoc, LoroValue, ToJson, VersionVector};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use strata_model::{EdgeKey, NodeId, PlacementKey, shard_of};

// ---------------------------------------------------------------- data

/// Deterministic xorshift64* so every run builds the same workspace.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    fn chance(&mut self, p: f64) -> bool {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64 <= p
    }
    fn pick<'a>(&mut self, items: &'a [&'a str]) -> &'a str {
        items[self.below(items.len() as u64) as usize]
    }
}

const WORDS: &[&str] = &[
    "Проект",
    "Задача",
    "Референсы",
    "Идея",
    "Сцена",
    "Персонаж",
    "Уровень",
    "Баг",
    "Заметка",
    "Диздок",
    "Звук",
    "Арт",
    "Сюжет",
    "Спринт",
    "Встреча",
    "Шейдер",
    "Анимация",
    "Интерфейс",
    "Project",
    "Task",
    "Notes",
    "Board",
    "Draft",
    "Research",
    "Prototype",
    "Level",
    "Asset",
    "Lighting",
    "Camera",
    "Gameplay",
    "Story",
    "Roadmap",
];
const KINDS: &[&str] = &[
    "note",
    "note",
    "note",
    "network",
    "board",
    "checklist",
    "media",
];
const STATUSES: &[&str] = &["inbox", "todo", "doing", "review", "done", "cancelled"];
const TAGS: &[&str] = &[
    "art", "sound", "code", "design", "bug", "idea", "ref", "urgent",
];

/// UUIDv7-shaped ids with an increasing time prefix, deterministic per seed.
fn node_ids(n: usize, rng: &mut Rng) -> Vec<NodeId> {
    let start_ms: u64 = 1_760_000_000_000;
    (0..n)
        .map(|i| {
            let ms = start_ms + i as u64;
            let mut b = [0u8; 16];
            b[..6].copy_from_slice(&ms.to_be_bytes()[2..]);
            b[6..14].copy_from_slice(&rng.next().to_be_bytes());
            b[14..].copy_from_slice(&rng.next().to_be_bytes()[..2]);
            b[6] = 0x70 | (b[6] & 0x0f); // version 7
            b[8] = 0x80 | (b[8] & 0x3f); // RFC 4122 variant
            NodeId::from_bytes(b)
        })
        .collect()
}

struct Workspace {
    ids: Vec<NodeId>,
    networks: Vec<usize>,
}

fn workspace(n: usize, seed: u64) -> (Workspace, Rng) {
    let mut rng = Rng(seed | 1);
    let ids = node_ids(n, &mut rng);
    // Roughly one node in seven is a network; the first node is the root.
    let networks: Vec<usize> = (0..n).filter(|&i| i == 0 || i % 7 == 0).collect();
    (Workspace { ids, networks }, rng)
}

// ---------------------------------------------------------------- index layout (10 §2.3)

const TS: i64 = 1_760_000_000_000;

/// Writes one node with its placements and outgoing edges into its shard,
/// as a single commit (creating a node is one commit, 10 §2.3).
fn write_node(doc: &LoroDoc, ws: &Workspace, i: usize, rng: &mut Rng) -> loro::LoroResult<()> {
    let id = ws.ids[i];
    let key = id.to_text();
    let kind = if ws.networks.contains(&i) {
        "network"
    } else {
        rng.pick(KINDS)
    };
    doc.get_map("kind").insert(&key, kind)?;
    let name = format!("{} {}", rng.pick(WORDS), i);
    doc.get_map("name").insert(&key, name)?;
    doc.get_map("icon")
        .insert(&key, format!("game-icons/lorc/{}", rng.below(4000)))?;
    doc.get_map("createdAt").insert(&key, TS + i as i64)?;
    if rng.chance(0.5) {
        doc.get_map("status").insert(&key, rng.pick(STATUSES))?;
    }
    if rng.chance(0.2) {
        doc.get_map("deadline")
            .insert(&key, TS + rng.below(90 * 86_400_000) as i64)?;
    }
    if rng.chance(0.1) {
        doc.get_map("summary")
            .insert(&key, "Краткая справка о ноде для подсказки и 3D-карты.")?;
    }
    let set = doc.get_map("set");
    for _ in 0..rng.below(3) {
        set.insert(&format!("{key}|tags|{}", rng.pick(TAGS)), 1)?;
    }
    if rng.chance(0.05) {
        doc.get_map("flag").insert(&format!("{key}|key"), 1)?;
    }
    // Placements: a primary one, and an instance for one node in ten (✅ C3).
    if i > 0 {
        let primary = ws.ids[ws.networks[rng.below(ws.networks.len() as u64) as usize]];
        let placement = doc.get_map("placement");
        placement.insert(&PlacementKey::new(primary, id).to_text(), TS + i as i64)?;
        doc.get_map("primaryNet").insert(&key, primary.to_text())?;
        if rng.chance(0.1) {
            let other = ws.ids[ws.networks[rng.below(ws.networks.len() as u64) as usize]];
            if other != primary {
                placement.insert(&PlacementKey::new(other, id).to_text(), TS + i as i64)?;
            }
        }
    }
    // Outgoing edges: 1.5 per node on average, a third of them from [[links]].
    let edges = doc.get_map("edge");
    let origins = doc.get_map("edgeOrigin");
    for _ in 0..(rng.below(4)) {
        let to = ws.ids[rng.below(ws.ids.len() as u64) as usize];
        if to == id {
            continue;
        }
        let ek = EdgeKey::between(id, to).to_text();
        edges.insert(&ek, format!("{key}>{}", to.to_text()))?;
        let origin = if rng.chance(0.33) { "text" } else { "manual" };
        origins.insert(&format!("{ek}|{origin}"), TS + i as i64)?;
    }
    doc.commit();
    Ok(())
}

fn build_index(ws: &Workspace, k: u32, rng: &mut Rng) -> Vec<LoroDoc> {
    let docs: Vec<LoroDoc> = (0..k)
        .map(|s| {
            let d = LoroDoc::new();
            d.set_peer_id(1000 + u64::from(s)).expect("peer id");
            d
        })
        .collect();
    for i in 0..ws.ids.len() {
        let shard = shard_of(ws.ids[i], k) as usize;
        write_node(&docs[shard], ws, i, rng).expect("write node");
    }
    docs
}

// ---------------------------------------------------------------- measurement helpers

fn rss_kib() -> Option<u64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    status.lines().find_map(|l| {
        l.strip_prefix("VmRSS:")
            .and_then(|v| v.trim().trim_end_matches(" kB").trim().parse().ok())
    })
}

fn ms(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1000.0
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let idx = ((sorted.len() - 1) as f64 * p).round() as usize;
    sorted[idx]
}

/// Canonical JSON (sorted keys) of a document's deep value, hashed — the
/// "state hash" both Rust and WASM compute for item 5 of the spike.
fn state_hash(doc: &LoroDoc) -> String {
    let value = doc.get_deep_value().to_json_value();
    let canonical = canonical_json(&value);
    let digest = Sha256::digest(canonical.as_bytes());
    digest.iter().fold(String::new(), |mut s, b| {
        let _ = write!(s, "{b:02x}");
        s
    })
}

fn canonical_json(v: &Value) -> String {
    match v {
        Value::Object(map) => {
            let sorted: BTreeMap<&String, &Value> = map.iter().collect();
            let inner: Vec<String> = sorted
                .iter()
                .map(|(k, v)| format!("{}:{}", Value::String((*k).clone()), canonical_json(v)))
                .collect();
            format!("{{{}}}", inner.join(","))
        }
        Value::Array(items) => {
            format!(
                "[{}]",
                items
                    .iter()
                    .map(canonical_json)
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        // Integers and floats: Loro keeps i64 and f64 apart; print them the same
        // way on both sides (whole floats never occur in this data).
        other => other.to_string(),
    }
}

// ---------------------------------------------------------------- experiments

fn index_experiment(n: usize, k: u32, out: &Path) -> Value {
    let (ws, mut rng) = workspace(n, 42);
    let t = Instant::now();
    let docs = build_index(&ws, k, &mut rng);
    let build_ms = ms(t);

    let snapshots: Vec<Vec<u8>> = docs
        .iter()
        .map(|d| d.export(ExportMode::Snapshot).expect("snapshot"))
        .collect();
    let snapshot_bytes: usize = snapshots.iter().map(Vec::len).sum();
    let shard_dir = out.join(format!("rust-index-{n}-k{k}"));
    std::fs::create_dir_all(&shard_dir).expect("shard dir");
    for (s, bytes) in snapshots.iter().enumerate() {
        std::fs::write(shard_dir.join(format!("shard-{s:02}.snapshot")), bytes)
            .expect("write shard");
    }
    let memory = measure_import_in_child(&shard_dir);
    let shallow_bytes: usize = docs
        .iter()
        .map(|d| {
            d.export(ExportMode::shallow_snapshot(&d.oplog_frontiers()))
                .expect("shallow")
                .len()
        })
        .sum();
    drop(docs);

    // Cold import into fresh documents.
    let rss_before = rss_kib();
    let t = Instant::now();
    let fresh: Vec<LoroDoc> = snapshots
        .iter()
        .map(|bytes| {
            let d = LoroDoc::new();
            d.import(bytes).expect("import");
            d
        })
        .collect();
    let import_ms = ms(t);
    let rss_after = rss_kib();
    // State hash of the imported (unedited) K = 1 document, for the WASM side.
    let imported_hash = (k == 1).then(|| state_hash(&fresh[0]));

    // Read every name, as the name search and the 3D view do (09 §2, 08 §2).
    let t = Instant::now();
    let mut names = 0usize;
    for d in &fresh {
        if let LoroValue::Map(m) = d.get_map("name").get_value() {
            names += m.len();
        }
    }
    let read_names_ms = ms(t);

    // Field edit latency: change one node's status and commit.
    let mut samples = Vec::with_capacity(500);
    let mut rng = Rng(7);
    for _ in 0..500 {
        let i = rng.below(n as u64) as usize;
        let id = ws.ids[i];
        let d = &fresh[shard_of(id, k) as usize];
        let t = Instant::now();
        d.get_map("status")
            .insert(&id.to_text(), rng.pick(STATUSES))
            .expect("edit");
        d.commit();
        samples.push(ms(t));
    }
    samples.sort_by(f64::total_cmp);

    // Keep the K = 1 snapshot of the 10 k index for the WASM side (item 5).
    if k == 1 {
        let path = out.join(format!("rust-index-{n}.snapshot"));
        std::fs::write(&path, &snapshots[0]).expect("write snapshot");
        std::fs::write(
            out.join(format!("rust-index-{n}.hash")),
            imported_hash.unwrap_or_default(),
        )
        .expect("write hash");
    }

    json!({
        "nodes": n,
        "shards": k,
        "build_ms": build_ms,
        "snapshot_bytes": snapshot_bytes,
        "snapshot_bytes_per_node": snapshot_bytes as f64 / n as f64,
        "shallow_snapshot_bytes": shallow_bytes,
        "import_ms": import_ms,
        "import_rss_delta_mib_in_process": match (rss_before, rss_after) {
            (Some(a), Some(b)) => json!((b.saturating_sub(a)) as f64 / 1024.0),
            _ => Value::Null,
        },
        "memory_fresh_process": memory,
        "read_all_names_ms": read_names_ms,
        "names_read": names,
        "field_edit_ms": { "p50": percentile(&samples, 0.5), "p95": percentile(&samples, 0.95), "max": percentile(&samples, 1.0) },
    })
}

fn text_experiment() -> Value {
    let doc = LoroDoc::new();
    let text = doc.get_text("text");
    let line = "Строка заметки с **жирным**, [[ссылкой]] и `кодом` — 0123456789.\n";
    let mut big = String::new();
    while big.len() < 1_000_000 {
        big.push_str(line);
    }
    let t = Instant::now();
    text.insert(0, &big).expect("insert");
    doc.commit();
    let insert_1mb_ms = ms(t);

    let mut samples = Vec::with_capacity(1000);
    let mut rng = Rng(11);
    let len = text.len_unicode();
    for _ in 0..1000 {
        let pos = rng.below(len as u64) as usize;
        let t = Instant::now();
        text.insert(pos, "ы").expect("type");
        doc.commit();
        samples.push(ms(t));
    }
    samples.sort_by(f64::total_cmp);
    json!({
        "bytes": big.len(),
        "insert_1mb_ms": insert_1mb_ms,
        "keystroke_ms": { "p50": percentile(&samples, 0.5), "p95": percentile(&samples, 0.95), "max": percentile(&samples, 1.0) },
        "snapshot_bytes": doc.export(ExportMode::Snapshot).expect("snapshot").len(),
    })
}

/// Three replicas of one shard edit concurrently and exchange updates in a
/// random order; after a full exchange their states must be identical.
fn convergence_experiment(rounds: usize, ops_per_round: usize) -> Value {
    let (ws, mut rng) = workspace(2_000, 99);
    let base = build_index(&ws, 1, &mut rng).remove(0);
    let snapshot = base.export(ExportMode::Snapshot).expect("snapshot");
    let peers: Vec<LoroDoc> = (0..3)
        .map(|p| {
            let d = LoroDoc::new();
            d.import(&snapshot).expect("import");
            d.set_peer_id(10 + p).expect("peer");
            d
        })
        .collect();
    let mut known: Vec<Vec<VersionVector>> = (0..3)
        .map(|_| (0..3).map(|_| peers[0].oplog_vv()).collect())
        .collect();
    let mut rng = Rng(1234);
    let mut ops = 0usize;
    let mut mismatches = 0usize;
    let t = Instant::now();
    for _ in 0..rounds {
        for _ in 0..ops_per_round {
            let p = rng.below(3) as usize;
            let d = &peers[p];
            let id = ws.ids[rng.below(ws.ids.len() as u64) as usize];
            let key = id.to_text();
            match rng.below(6) {
                0 => d
                    .get_map("name")
                    .insert(&key, format!("Имя {}", rng.below(1000)))
                    .map(|_| ()),
                1 => d
                    .get_map("status")
                    .insert(&key, rng.pick(STATUSES))
                    .map(|_| ()),
                2 => d
                    .get_map("set")
                    .insert(&format!("{key}|tags|{}", rng.pick(TAGS)), 1)
                    .map(|_| ()),
                3 => d
                    .get_map("set")
                    .delete(&format!("{key}|tags|{}", rng.pick(TAGS)))
                    .map(|_| ()),
                4 => {
                    let net = ws.ids[ws.networks[rng.below(ws.networks.len() as u64) as usize]];
                    d.get_map("placement")
                        .insert(&PlacementKey::new(net, id).to_text(), 1)
                        .map(|_| ())
                }
                _ => d.get_map("trashedAt").insert(&key, TS).map(|_| ()),
            }
            .expect("op");
            d.commit();
            ops += 1;
        }
        // Random partial syncs: a sends to b what b has not seen from a.
        for _ in 0..3 {
            let a = rng.below(3) as usize;
            let b = rng.below(3) as usize;
            if a == b {
                continue;
            }
            let update = peers[a]
                .export(ExportMode::updates(&known[a][b]))
                .expect("updates");
            peers[b].import(&update).expect("apply");
            known[a][b] = peers[a].oplog_vv();
        }
    }
    // Full exchange.
    for a in 0..3 {
        for b in 0..3 {
            if a != b {
                let update = peers[a].export(ExportMode::all_updates()).expect("all");
                peers[b].import(&update).expect("apply");
            }
        }
    }
    let hashes: Vec<String> = peers.iter().map(state_hash).collect();
    if hashes.iter().any(|h| h != &hashes[0]) {
        mismatches += 1;
    }
    let vv_equal = peers.iter().all(|p| p.oplog_vv() == peers[0].oplog_vv());
    json!({
        "replicas": 3,
        "rounds": rounds,
        "ops": ops,
        "converged": mismatches == 0 && vv_equal,
        "elapsed_ms": ms(t),
        "state_hash": hashes[0],
    })
}

/// Item 5: documents written by the WASM build open here with the same state.
fn interop_check(out: &Path) -> Value {
    let snap = out.join("js-index.snapshot");
    let hash = out.join("js-index.hash");
    match (std::fs::read(&snap), std::fs::read_to_string(&hash)) {
        (Ok(bytes), Ok(expected)) => {
            let d = LoroDoc::new();
            let imported = d.import(&bytes).is_ok();
            let got = state_hash(&d);
            json!({ "js_snapshot_found": true, "imported": imported, "hash_equal": got == expected.trim(), "rust_hash": got, "js_hash": expected.trim() })
        }
        _ => {
            json!({ "js_snapshot_found": false, "note": "run spikes/loro-wasm first, then rerun this spike" })
        }
    }
}

/// Runs this binary again as `import-rss <dir>` so the allocator starts clean.
fn measure_import_in_child(dir: &Path) -> Value {
    let exe = std::env::current_exe().expect("exe");
    let output = std::process::Command::new(exe)
        .arg("import-rss")
        .arg(dir)
        .output()
        .expect("child");
    serde_json::from_slice(&output.stdout).unwrap_or(Value::Null)
}

/// Child mode: import every shard in `dir`, then read all names (which
/// materialises the lazily imported maps) and report RSS at each step.
fn import_rss(dir: &Path) {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .expect("dir")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "snapshot"))
        .collect();
    files.sort();
    let bytes: Vec<Vec<u8>> = files
        .iter()
        .map(|f| std::fs::read(f).expect("read"))
        .collect();
    let base = rss_kib().unwrap_or(0);
    let t = Instant::now();
    let docs: Vec<LoroDoc> = bytes
        .iter()
        .map(|b| {
            let d = LoroDoc::new();
            d.import(b).expect("import");
            d
        })
        .collect();
    let import_ms = ms(t);
    let after_import = rss_kib().unwrap_or(0);
    drop(bytes);
    let t = Instant::now();
    let mut entries = 0usize;
    for d in &docs {
        for field in [
            "kind",
            "name",
            "icon",
            "status",
            "deadline",
            "primaryNet",
            "placement",
            "edge",
        ] {
            if let LoroValue::Map(m) = d.get_map(field).get_value() {
                entries += m.len();
            }
        }
    }
    let materialise_ms = ms(t);
    let after_read = rss_kib().unwrap_or(0);
    let mib = |kib: u64| kib as f64 / 1024.0;
    println!(
        "{}",
        json!({
            "shards": docs.len(),
            "import_ms": import_ms,
            "materialise_fields_ms": materialise_ms,
            "entries_read": entries,
            "rss_base_mib": mib(base),
            "rss_after_import_mib": mib(after_import),
            "rss_after_read_mib": mib(after_read),
            "rss_index_mib": mib(after_read.saturating_sub(base)),
        })
    );
}

fn main() {
    let mut args = std::env::args().skip(1);
    if let Some(cmd) = args.next() {
        if cmd == "canonical" {
            let d = LoroDoc::new();
            d.import(&std::fs::read(args.next().expect("snapshot")).expect("read"))
                .expect("import");
            println!("{}", canonical_json(&d.get_deep_value().to_json_value()));
            return;
        }
        if cmd == "import-rss" {
            import_rss(Path::new(&args.next().expect("dir")));
            return;
        }
    }
    let out = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("bench-results/loro"));
    std::fs::create_dir_all(&out).expect("out dir");
    let mut index = Vec::new();
    for (n, k) in [(10_000, 1), (100_000, 1), (100_000, 16)] {
        eprintln!("index: {n} nodes, {k} shard(s)…");
        index.push(index_experiment(n, k, &out));
    }
    eprintln!("text…");
    let text = text_experiment();
    eprintln!("convergence…");
    let convergence = convergence_experiment(200, 50);
    let interop = interop_check(&out);
    let report = json!({
        "spike": "4-loro",
        "engine": "loro (Rust crate)",
        "host": { "os": std::env::consts::OS, "arch": std::env::consts::ARCH, "cpus": std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0) },
        "index": index,
        "text": text,
        "convergence": convergence,
        "interop_from_wasm": interop,
    });
    let pretty = serde_json::to_string_pretty(&report).expect("json");
    std::fs::write(out.join("rust-report.json"), &pretty).expect("write report");
    println!("{pretty}");
}
