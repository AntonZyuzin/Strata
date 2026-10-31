//! The synthetic vaults as folders (14 §1.3), for importing by hand: V-synth
//! — every rule of the import has its case (13 §7.2) — and V-10k without
//! attachments (NFR-40, NFR-41). CI keeps both as the artifact `vaults` for
//! the owner's checklist of milestone 1C (16 §4.7).
//!
//!   cargo run -p strata-core --example write_vaults -- <folder>
//!
//! V-synth has `Регистр/Note.md` beside `Регистр/note.md` (13 §3.4): on a
//! disk that ignores case, as macOS and Windows have by default, unpacking
//! keeps one of them.

use std::path::Path;
use strata_core::synth::{self, Spec};
use strata_core::vault::VaultFile;

fn write(root: &Path, files: &[VaultFile]) -> std::io::Result<()> {
    for f in files {
        let path = root.join(&f.path);
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::write(path, &f.bytes)?;
    }
    Ok(())
}

fn main() -> std::io::Result<()> {
    let out = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "vaults".to_owned());
    let out = Path::new(&out);
    let vsynth: Vec<VaultFile> =
        serde_json::from_str(include_str!("../src/tests/vsynth-vault.json"))
            .map_err(std::io::Error::other)?;
    write(&out.join("V-synth"), &vsynth)?;
    write(&out.join("V-10k"), &synth::vault(Spec::V10K).files)?;
    println!("V-synth and V-10k in {}", out.display());
    Ok(())
}
