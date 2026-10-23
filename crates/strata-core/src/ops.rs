//! Domain operations (05, 10 §4): what the UI, import and MCP ask the core
//! to do. A list of operations is applied as one changeset — one step of
//! undo — so a gesture of several primitive changes («вставить в нить»,
//! `L`) stays one step (05 §11).

use serde::{Deserialize, Serialize};
use strata_model::NodeKind;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum Op {
    /// A new node with its primary placement in `net` at (x, y) (05 §5).
    /// `id` may come from the caller (an optimistic UI); a new one otherwise.
    CreateNode {
        #[serde(default)]
        id: Option<String>,
        kind: NodeKind,
        /// The class it was made from (05 §4.3): `task`, `project`… The
        /// canvas takes the icon and look from kind and class.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        class: Option<String>,
        name: String,
        net: String,
        x: f64,
        y: f64,
    },
    Rename {
        id: String,
        name: String,
    },
    /// The node's position in network `net` (10 §2.4).
    Move {
        net: String,
        id: String,
        x: f64,
        y: f64,
    },
    /// A wire drawn by hand (origin `manual`, 05 §8.1).
    Connect {
        from: String,
        to: String,
    },
    /// Takes the wire's `manual` and `import` origins away; a wire from text
    /// stays while its link is in the text (05 §8.2 rule 5).
    Disconnect {
        from: String,
        to: String,
    },
    /// Soft delete (05 §11): `trashedAt` is set, placements and wires stay hidden.
    Trash {
        ids: Vec<String>,
    },
    /// Back from the trash, to where they were.
    Restore {
        ids: Vec<String>,
    },
}
