//! Strata core (15 §2.2).
//!
//! Domain operations, invariants, the CRDT document engine, the SQLite
//! projection, assets and the changeset journal live here. The engine is
//! chosen by spike 4 (ADR-0003); until then this crate only exposes build
//! information so the CLI and the desktop shell can link against it.

pub use strata_model as model;

/// Version of the core, shared by every binary built from this workspace.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Short description of the build, shown by `strata --version` and the desktop "About".
pub fn build_info() -> String {
    format!(
        "strata-core {VERSION} ({}-{})",
        std::env::consts::OS,
        std::env::consts::ARCH
    )
}

#[cfg(test)]
mod tests {
    #[test]
    fn build_info_mentions_version() {
        assert!(super::build_info().contains(super::VERSION));
    }
}
