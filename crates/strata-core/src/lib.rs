//! Strata core (15 §2.2).
//!
//! Domain operations, invariants, the CRDT documents, the changeset journal
//! and undo live here (15 §1.4 principle 1): the desktop shell, the CLI, the
//! browser build and later MCP and the server call the same code.
//!
//! - [`workspace`]: documents of 10 §2, operations of 10 §4, changesets and
//!   undo of 05 §11, the network view of 10 §7.3;
//! - [`ops`]: the operations the UI sends; [`api`]: every call as JSON, the
//!   same for the desktop shell and the browser build;
//! - [`store`]: where documents and changesets live; [`sqlite`]: the
//!   workspace folder and its `store.sqlite` (10 §3.1–3.3);
//! - [`home`]: the workspaces of this device for the home screen (✅ Q-16-12);
//! - [`archive`]: `.strata.zip`, a workspace as one file (10 §3.5);
//! - `preview`: a link's preview fetched from its page (ADR-0012), native only.

pub mod api;
pub mod archive;
pub mod changeset;
#[cfg(feature = "sqlite")]
pub mod home;
pub mod ops;
#[cfg(feature = "net")]
pub mod preview;
#[cfg(feature = "sqlite")]
pub mod sqlite;
pub mod store;
pub mod value;
pub mod workspace;

pub use changeset::{Changeset, KeyWrite, Label, RevertReport};
pub use ops::{Op, WireStyle};
pub use store::{MemoryStore, Store, StoreError, StoredDoc};
pub use strata_model as model;
pub use strata_model::Flag;
pub use workspace::{
    Attrs, CoreError, Edited, ExternalWire, Fold, History, Linked, NetworkView, NodeDetails,
    Person, Place, TrashItem, TreeItem, ViewEdge, ViewGhost, ViewNode, WireEnds, Workspace,
};

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
mod tests;
