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
pub use kind::{ChangesetOrigin, EdgeOrigin, Flag, NodeKind};

/// Milliseconds since the Unix epoch, the clock of UUIDv7 ids: it works in
/// the browser build too, where `std::time::SystemTime` has no clock.
pub fn now_ms() -> i64 {
    let (secs, nanos) = uuid::Timestamp::now(uuid::NoContext).to_unix();
    i64::try_from(secs).unwrap_or(i64::MAX).saturating_mul(1000) + i64::from(nanos / 1_000_000)
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_clock_is_in_milliseconds_of_this_century() {
        let t = super::now_ms();
        assert!((1_700_000_000_000..4_100_000_000_000).contains(&t), "{t}");
    }
}
