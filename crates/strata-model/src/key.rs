//! Deterministic keys for edges, placements and shards (10 §2.5).
//!
//! Keys are computed from the 16 id bytes, never from strings, so two
//! clients (or a repeated import) always derive the same key for the same
//! relation. Re-creating a relation repeats its key; that is not id reuse
//! (05 §14 item 1).

use std::fmt;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::id::{NodeId, decode_base32, encode_base32};

/// Key of an edge: the first 16 bytes of SHA-256 over its endpoints.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct EdgeKey([u8; 16]);

impl EdgeKey {
    /// `h(from ‖ to)` for an edge between two nodes.
    pub fn between(from: NodeId, to: NodeId) -> Self {
        let mut hasher = Sha256::new();
        hasher.update(from.as_bytes());
        hasher.update(to.as_bytes());
        Self::from_digest(hasher)
    }

    /// `h(from ‖ "?" ‖ linkKey(X))` for an edge to a ghost (05 §8.5).
    /// `link_key` is the normalised link key from 13 §3.4, as UTF-8.
    pub fn to_ghost(from: NodeId, link_key: &str) -> Self {
        let mut hasher = Sha256::new();
        hasher.update(from.as_bytes());
        hasher.update(b"?");
        hasher.update(link_key.as_bytes());
        Self::from_digest(hasher)
    }

    fn from_digest(hasher: Sha256) -> Self {
        let digest = hasher.finalize();
        let mut bytes = [0u8; 16];
        bytes.copy_from_slice(&digest[..16]);
        Self(bytes)
    }

    pub const fn as_bytes(&self) -> &[u8; 16] {
        &self.0
    }

    /// The key as it appears in CRDT maps: 26 Crockford base32 characters.
    pub fn to_text(&self) -> String {
        encode_base32(&self.0)
    }

    pub fn parse(text: &str) -> Result<Self, crate::IdParseError> {
        decode_base32(text).map(Self)
    }
}

impl fmt::Display for EdgeKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_text())
    }
}

impl fmt::Debug for EdgeKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "EdgeKey({self})")
    }
}

/// Key of a placement: `"{networkId}/{nodeId}"` from the canonical text forms
/// (05 §5). One key per (network, node) pair keeps invariant 3 under
/// concurrent "place here".
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug, Serialize, Deserialize)]
pub struct PlacementKey {
    pub network: NodeId,
    pub node: NodeId,
}

impl PlacementKey {
    pub const fn new(network: NodeId, node: NodeId) -> Self {
        Self { network, node }
    }

    pub fn to_text(&self) -> String {
        format!("{}/{}", self.network, self.node)
    }
}

impl fmt::Display for PlacementKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}/{}", self.network, self.node)
    }
}

/// Index shard of a node: `u64(sha256(nodeId)[0..8]) mod k`, the u64 read
/// big-endian (10 §2.5). Hashing evens out time-ordered UUIDv7 ids.
pub fn shard_of(node: NodeId, k: u32) -> u32 {
    assert!(k > 0, "shard count must be positive");
    let digest = Sha256::digest(node.as_bytes());
    let mut head = [0u8; 8];
    head.copy_from_slice(&digest[..8]);
    (u64::from_be_bytes(head) % u64::from(k)) as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(text: &str) -> NodeId {
        NodeId::parse(text).unwrap()
    }

    #[test]
    fn edge_key_is_directional_and_stable() {
        let a = id("0192f3a4-7c1e-7b2a-9d40-5e6f7a8b9c0d");
        let b = id("0192f3a4-7c1e-7b2a-9d40-5e6f7a8b9c0e");
        assert_eq!(EdgeKey::between(a, b), EdgeKey::between(a, b));
        assert_ne!(EdgeKey::between(a, b), EdgeKey::between(b, a));
        // UUID and base32 inputs give the same key: keys use bytes, not text.
        let a2 = id(&a.to_text().to_lowercase());
        assert_eq!(EdgeKey::between(a2, b), EdgeKey::between(a, b));
        let k = EdgeKey::between(a, b);
        assert_eq!(EdgeKey::parse(&k.to_text()).unwrap(), k);
    }

    #[test]
    fn ghost_key_differs_from_real_edge() {
        let a = NodeId::new();
        assert_ne!(
            EdgeKey::to_ghost(a, "заметка"),
            EdgeKey::to_ghost(a, "заметка 2")
        );
        assert_eq!(
            EdgeKey::to_ghost(a, "заметка"),
            EdgeKey::to_ghost(a, "заметка")
        );
    }

    #[test]
    fn placement_key_text() {
        let net = NodeId::new();
        let node = NodeId::new();
        let key = PlacementKey::new(net, node);
        assert_eq!(
            key.to_text(),
            format!("{}/{}", net.to_text(), node.to_text())
        );
        assert_eq!(key.to_text().len(), 26 * 2 + 1);
    }

    #[test]
    fn shards_are_roughly_even() {
        let k = 16;
        let mut counts = [0u32; 16];
        for _ in 0..16_000 {
            counts[shard_of(NodeId::new(), k) as usize] += 1;
        }
        for c in counts {
            assert!((800..1200).contains(&c), "uneven shard: {counts:?}");
        }
    }
}
