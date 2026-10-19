//! Domain types shared by the Strata core, server, CLI and (via WASM) the UI.
//!
//! The model follows `docs/05-domain-model.md`. This crate does no IO.

pub mod id;
pub mod key;
pub mod kind;

pub use id::{
    ChangesetId, DotId, Id, IdParseError, NetworkBoxId, NodeId, StickyNoteId, WorkspaceId,
};
pub use key::{EdgeKey, PlacementKey, shard_of};
pub use kind::{ChangesetOrigin, EdgeOrigin, NodeKind};
