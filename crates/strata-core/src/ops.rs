//! Domain operations (05, 10 §4): what the UI, import and MCP ask the core
//! to do. A list of operations is applied as one changeset — one step of
//! undo — so a gesture of several primitive changes («вставить в нить»,
//! `L`) stays one step (05 §11).

use crate::value::Val;
use serde::{Deserialize, Serialize};
use strata_model::{Flag, NodeKind};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum Op {
    /// A new node with its primary placement in `net` at (x, y) (05 §5).
    /// `id` may come from the caller (an optimistic UI); a new one otherwise.
    CreateNode {
        #[serde(default)]
        id: Option<String>,
        kind: NodeKind,
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
    /// «Разместить здесь» (05 §5): an appearance of node `id` in `net` at
    /// (x, y). Not where it lies already (rule 3), not a network in itself
    /// or in a network inside it (rule 4).
    Place {
        id: String,
        net: String,
        x: f64,
        y: f64,
    },
    /// «Убрать отсюда» (05 §5): the placement of `id` in `net` goes. The
    /// primary falls to the oldest placement left; the last one sends the
    /// node to the trash.
    Unplace {
        id: String,
        net: String,
    },
    /// «Сделать основным» (05 §5): `net` becomes the primary placement.
    SetPrimary {
        id: String,
        net: String,
    },
    /// «Перенести» (05 §5): the placement of `id` moves from `from` to `to`
    /// at (x, y); a primary stays primary. Where the node lies already, the
    /// moved placement goes and the one there keeps its place.
    Relocate {
        id: String,
        from: String,
        to: String,
        x: f64,
        y: f64,
    },
    /// Soft delete (05 §11): `trashedAt` is set, placements and wires stay
    /// hidden. A network takes along what lives only inside it (05 §5).
    Trash {
        ids: Vec<String>,
    },
    /// Back from the trash, to where they were, with what went in the same batch.
    Restore {
        ids: Vec<String>,
    },
    /// «Сделать проектом», «Сделать задачей», «Сделать папкой» (05 §4.2):
    /// a kind changes only between task and project and between folder and
    /// project; a project becomes a task only when nothing is inside it.
    SetKind {
        id: String,
        kind: NodeKind,
    },
    /// A built-in attribute (05 §6.1, ADR-0010): `status`, `start`,
    /// `deadline`, `priority` — of tasks and projects; `color` — of any node;
    /// `asset` (the file's SHA-256, 10 §11), `mime`, `url`, `icon` — of
    /// assets. `null` clears it.
    SetAttr {
        id: String,
        key: String,
        #[serde(default)]
        value: Option<Val>,
    },
    /// A person among the node's assignees, or out of them (05 §10).
    Assign {
        id: String,
        person: String,
        on: bool,
    },
    /// A person of the workspace (05 §10): name and colour of the people palette.
    AddPerson {
        #[serde(default)]
        id: Option<String>,
        name: String,
        #[serde(default)]
        color: Option<i64>,
    },
    RenamePerson {
        id: String,
        name: String,
    },
    /// A flag of the node set or cleared (05 §7).
    SetFlag {
        id: String,
        flag: Flag,
        on: bool,
    },
    /// The default style of the wires in network `net` (05 §9.2, 06 §6.2);
    /// `null` takes it away, and the network draws Bézier wires.
    SetWireStyle {
        net: String,
        #[serde(default)]
        style: Option<WireStyle>,
    },
    /// The size of node `id`'s bubble in network `net`, set by hand: `s`,
    /// `m`, `l` or `xl` (05 §9.2, 06 §4.2) — this placement's own, so a node
    /// is big in one project and small in another; `null` — by the rules.
    SetSize {
        id: String,
        net: String,
        #[serde(default)]
        size: Option<String>,
    },
    /// The background of network `net` (05 §3, §9.2; 07 §7): the root's is
    /// the workspace's, which every network without its own shows; `null`
    /// takes a network's own away, the root's back to «Туман».
    SetBackground {
        net: String,
        #[serde(default)]
        background: Option<Background>,
    },
    /// The kind's icon in this workspace (05 §3 `kindIcons`, §4.1): what the
    /// nodes of `kind` without an icon of their own show — a preset or one's
    /// own icon; `null` — the kind's built-in glyph again. An asset has none:
    /// its icon is its content's (05 §4.4).
    SetKindIcon {
        kind: NodeKind,
        #[serde(default)]
        icon: Option<String>,
    },
}

/// The procedural presets of 07 §7.3, generated by the client: zero bytes in
/// the bundle. The photo presets join with their CC0 sources (☑ Q-07-19).
pub const BACKGROUND_PRESETS: [&str; 4] = ["fog", "depth", "dusk", "dust"];

/// A background (05 §3, 07 §7.1): a preset or an uploaded picture, and the
/// pipeline's parameters — normalised, whatever the theme; the original is
/// kept and the derivative rebuilt from it (05 §12).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Background {
    /// `preset:<id>` (07 §7.3) or `asset:<sha256>` (10 §11).
    pub source: String,
    /// The blur's radius at 960 px, 4–16.
    #[serde(default = "Background::default_blur")]
    pub blur: f64,
    /// The share of colour taken away, 0–1.
    #[serde(default = "Background::default_desaturate")]
    pub desaturate: f64,
    /// The ceiling of the luminance's 95th percentile, 0–0.10 (`scene-bg-max-l`).
    #[serde(default = "Background::default_max_l")]
    pub max_l: f64,
    /// The edges' brightness under the baked vignette, 0–1.
    #[serde(default = "Background::default_vignette")]
    pub vignette: f64,
    /// The grain, 0–1: its opacity is `grain` × 0.06 (07 §7.2).
    #[serde(default = "Background::default_grain")]
    pub grain: f64,
    /// The fog's sprites' alpha, 0–1; 0 — no fog.
    #[serde(default)]
    pub fog: f64,
    /// Animated, by the person's wish only (07 §7.4).
    #[serde(default)]
    pub animated: bool,
}

impl Background {
    fn default_blur() -> f64 {
        8.0
    }
    fn default_desaturate() -> f64 {
        0.8
    }
    fn default_max_l() -> f64 {
        0.10
    }
    fn default_vignette() -> f64 {
        0.7
    }
    fn default_grain() -> f64 {
        0.67
    }

    /// A preset with the pipeline's defaults.
    pub fn preset(id: &str) -> Self {
        Self {
            source: format!("preset:{id}"),
            blur: Self::default_blur(),
            desaturate: Self::default_desaturate(),
            max_l: Self::default_max_l(),
            vignette: Self::default_vignette(),
            grain: Self::default_grain(),
            fog: 0.0,
            animated: false,
        }
    }

    /// The uploaded picture's SHA-256, for an `asset:` source.
    pub fn asset(&self) -> Option<&str> {
        self.source.strip_prefix("asset:")
    }

    /// Why it cannot be stored, if it cannot: a preset unknown, a picture's
    /// hash malformed, a number out of its range.
    pub fn invalid(&self) -> Option<String> {
        let known = match self.source.split_once(':') {
            Some(("preset", id)) => BACKGROUND_PRESETS.contains(&id),
            Some(("asset", sha)) => sha.len() == 64 && sha.bytes().all(|c| c.is_ascii_hexdigit()),
            _ => false,
        };
        if !known {
            return Some(format!(
                "background source {}: no preset or picture",
                self.source
            ));
        }
        let ranges = [
            ("blur", self.blur, 4.0, 16.0),
            ("desaturate", self.desaturate, 0.0, 1.0),
            ("maxL", self.max_l, 0.0, 0.10),
            ("vignette", self.vignette, 0.0, 1.0),
            ("grain", self.grain, 0.0, 1.0),
            ("fog", self.fog, 0.0, 1.0),
        ];
        ranges
            .iter()
            .find(|(_, v, lo, hi)| !(v.is_finite() && (*lo..=*hi).contains(v)))
            .map(|(name, v, lo, hi)| format!("background {name} {v}: not within {lo}–{hi}"))
    }
}

/// How a network draws its wires (06 §6.2): a segment, an S-curve, an
/// S-curve that follows the hand.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WireStyle {
    Straight,
    Bezier,
    Kinetic,
}

impl WireStyle {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Straight => "straight",
            Self::Bezier => "bezier",
            Self::Kinetic => "kinetic",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "straight" => Some(Self::Straight),
            "bezier" => Some(Self::Bezier),
            "kinetic" => Some(Self::Kinetic),
            _ => None,
        }
    }
}
