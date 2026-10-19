//! Enumerations from the domain model.

use serde::{Deserialize, Serialize};

/// Content kind of a node (05 §4.2). Immutable after creation.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NodeKind {
    /// A canvas with nested nodes (Houdini subnet).
    Network,
    /// Markdown text.
    Note,
    /// Excalidraw scene with widgets.
    Board,
    /// Items with checkboxes.
    Checklist,
    /// A single file: image, PDF, video, audio, other.
    Media,
}

impl NodeKind {
    pub const ALL: [NodeKind; 5] = [
        Self::Network,
        Self::Note,
        Self::Board,
        Self::Checklist,
        Self::Media,
    ];

    /// Whether entering the node dives into a canvas (05 §4.2).
    pub const fn has_canvas(self) -> bool {
        matches!(self, Self::Network)
    }
}

/// Where an edge came from (05 §8.1). An edge may have several origins.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EdgeOrigin {
    /// Drawn by hand.
    Manual,
    /// From a `[[link]]` in note text; lives while the link is in the text.
    Text,
    /// Created by an import.
    Import,
}

/// Source of a changeset (05 §11, 10 §9.1).
#[derive(Clone, PartialEq, Eq, Hash, Debug, Serialize, Deserialize)]
#[serde(tag = "type", content = "client", rename_all = "lowercase")]
pub enum ChangesetOrigin {
    User,
    /// An MCP client, e.g. `claude-code` or `codex`.
    Mcp(String),
    Ai,
    Import,
    /// The authority core: invariant reconciliation, migrations, link rewrites, purge.
    System,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_serialize_lowercase() {
        assert_eq!(
            serde_json::to_string(&NodeKind::Checklist).unwrap(),
            "\"checklist\""
        );
        assert!(NodeKind::Network.has_canvas());
        assert!(!NodeKind::Note.has_canvas());
    }

    #[test]
    fn origin_serialization() {
        let mcp = ChangesetOrigin::Mcp("claude-code".into());
        let json = serde_json::to_string(&mcp).unwrap();
        assert_eq!(json, r#"{"type":"mcp","client":"claude-code"}"#);
        assert_eq!(serde_json::from_str::<ChangesetOrigin>(&json).unwrap(), mcp);
        assert_eq!(
            serde_json::to_string(&ChangesetOrigin::System).unwrap(),
            r#"{"type":"system"}"#
        );
    }
}
