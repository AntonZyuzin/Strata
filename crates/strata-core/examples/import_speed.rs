//! The import of V-10k (14 §1.3, §6, bench `import`): NFR-40 — 10 000 notes
//! without attachments ≤ 60 s on M1; NFR-45 — its rollback ≤ 10 s; NFR-42 —
//! attachments copied with their SHA-256 checked at ≥ 50 MB/s. Into a
//! workspace folder (`store.sqlite`, as the desktop has it) and into memory.
//!
//!   cargo run --release -p strata-core --example import_speed
//!   cargo run --release -p strata-core --example import_speed -- --notes 2000 --pictures 200 --picture-kb 1024

use std::time::Instant;
use strata_core::synth::{self, Spec};
use strata_core::{ImportOptions, MemoryStore, Workspace};

fn arg(name: &str, default: usize) -> usize {
    let args: Vec<String> = std::env::args().collect();
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn secs(t: Instant) -> f64 {
    t.elapsed().as_secs_f64()
}

fn main() {
    let spec = Spec {
        notes: arg("--notes", Spec::V10K.notes),
        pictures: arg("--pictures", 0),
        picture_bytes: arg("--picture-kb", 0) * 1024,
        ..Spec::V10K
    };
    let t = Instant::now();
    let vault = synth::vault(spec);
    let bytes: usize = vault.files.iter().map(|f| f.bytes.len()).sum();
    println!(
        "V-10k: {} files, {:.1} MB, made in {:.2} s",
        vault.files.len(),
        bytes as f64 / 1e6,
        secs(t)
    );
    let options = ImportOptions {
        unlinked: "Вложения без ссылок".to_owned(),
        text: "текст".to_owned(),
        ..ImportOptions::default()
    };

    // In memory: the core alone.
    let mut ws = Workspace::create(MemoryStore::default(), "V-10k").expect("a workspace");
    let t = Instant::now();
    let report = ws.import_vault(&vault, None, &options).expect("the import");
    println!(
        "into memory: {:.2} s — {} notes, {} folders, {} wires, {} ghosts, {} lines of the report",
        secs(t),
        report.counts.notes,
        report.counts.folders,
        report.counts.wires,
        report.counts.ghosts,
        report.items.len()
    );
    let t = Instant::now();
    ws.undo().expect("undo");
    println!("its rollback: {:.2} s (NFR-45 ≤ 10 s)", secs(t));

    // Into a workspace folder, as on desktop.
    let dir = std::env::temp_dir().join(format!("strata-import-speed-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let mut ws = strata_core::sqlite::create_folder(&dir, "V-10k").expect("a folder");
    let t = Instant::now();
    ws.import_vault(&vault, None, &options).expect("the import");
    let took = secs(t);
    println!("into a folder: {took:.2} s (NFR-40 ≤ 60 s on M1)");
    if spec.pictures > 0 {
        let mb = (spec.pictures * spec.picture_bytes) as f64 / 1e6;
        println!("  of it {mb:.0} MB of pictures");
    }
    let t = Instant::now();
    ws.undo().expect("undo");
    println!("its rollback: {:.2} s (NFR-45 ≤ 10 s)", secs(t));
    drop(ws);
    let _ = std::fs::remove_dir_all(&dir);
}
