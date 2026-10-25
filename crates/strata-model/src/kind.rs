//! Enumerations from the domain model.

use serde::{Deserialize, Serialize};

/// Content kind of a node (05 §4.2, ADR-0010). Immutable after creation,
/// except task ↔ project and folder ↔ project.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NodeKind {
    /// A folder («Папка»): a canvas with nested nodes (Houdini subnet).
    Network,
    /// A task one can dive into: the task's fields and a canvas.
    Project,
    /// A unit of work: status, priority, dates, assignees, a description;
    /// one cannot dive into it. Its subtasks are the tasks it wires to.
    Task,
    /// Markdown text.
    Note,
    /// Excalidraw scene: drawing and pictures.
    Board,
    /// Items with checkboxes.
    Checklist,
    /// One attachment: a file (picture, video, sound, PDF, other) or a link.
    /// Nodes made before ADR-0010 were `media`.
    #[serde(alias = "media")]
    Asset,
}

impl NodeKind {
    pub const ALL: [NodeKind; 7] = [
        Self::Network,
        Self::Project,
        Self::Task,
        Self::Note,
        Self::Board,
        Self::Checklist,
        Self::Asset,
    ];

    /// Whether entering the node dives into a canvas (05 §4.2): a folder or a project.
    pub const fn has_canvas(self) -> bool {
        matches!(self, Self::Network | Self::Project)
    }

    /// Whether it carries the task's fields — status, priority, dates,
    /// assignees (05 §4.3): a task or a project.
    pub const fn is_task(self) -> bool {
        matches!(self, Self::Task | Self::Project)
    }
}

/// The flags of 05 §7, Houdini's rethought: `R` key, `Q` pause, `E`
/// template; «Скрыть от AI» and «Замок» are in the model from the MVP, their
/// interface comes with MCP (16 §4.5).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Flag {
    Key,
    Pause,
    Template,
    HideAi,
    Lock,
}

impl Flag {
    pub const ALL: [Flag; 5] = [
        Flag::Key,
        Flag::Pause,
        Flag::Template,
        Flag::HideAi,
        Flag::Lock,
    ];

    /// The name in the documents (10 §2.3, `flag` map).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Key => "key",
            Self::Pause => "pause",
            Self::Template => "template",
            Self::HideAi => "hideAi",
            Self::Lock => "lock",
        }
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
        assert!(NodeKind::Project.has_canvas());
        assert!(!NodeKind::Task.has_canvas());
        assert!(!NodeKind::Note.has_canvas());
        assert!(NodeKind::Task.is_task() && NodeKind::Project.is_task());
        assert!(!NodeKind::Network.is_task() && !NodeKind::Note.is_task());
    }

    #[test]
    fn media_reads_as_asset() {
        // Nodes made before ADR-0010 keep opening.
        let k: NodeKind = serde_json::from_str("\"media\"").unwrap();
        assert_eq!(k, NodeKind::Asset);
        assert_eq!(serde_json::to_string(&k).unwrap(), "\"asset\"");
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
