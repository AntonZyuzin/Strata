//! A workspace: its documents (10 §2), the domain operations on them
//! (10 §4), the changeset journal and undo (05 §11), the view of a network
//! for the canvas (10 §7.3).
//!
//! Documents follow 10 §2.3–2.4: the index shards hold node fields,
//! placements and outgoing wires as maps keyed by node, placement or wire;
//! a network's document holds positions. The core is the only writer: an
//! operation checks the invariants of 05 §14 on the state it holds, writes
//! every touched key, records its value before and after, and commits the
//! updates of every touched document with the changeset at once (10 §3.3).
//!
//! Content documents (`content/<id>`, 10 §2.4) are edited in the UI's own
//! Loro document and pushed here as updates (15 §3.4); the core stores them
//! and turns a note's `[[links]]` into its text wires.

use crate::changeset::{Changeset, KeyWrite, Label, RevertReport};
use crate::ops::{Op, WireStyle};
use crate::store::{Store, StoreError, StoredDoc};
use crate::value::Val;
use loro::{ExportMode, LoroDoc, LoroValue, ValueOrContainer, VersionVector};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use strata_model::{
    ChangesetId, ChangesetOrigin, EdgeKey, Flag, NodeId, NodeKind, PlacementKey, now_ms, shard_of,
};

mod links;
mod places;

/// Version of the documents' layout (10 §13).
pub const SCHEMA: i64 = 1;
/// The tree of a list's items in its content document (10 §2.4).
pub const LIST_ITEMS: &str = "items";

/// Statuses of a workspace (05 §6.1), in their order; the last two are final.
pub const STATUSES: [&str; 6] = ["inbox", "todo", "doing", "review", "done", "cancelled"];
/// Priorities (05 §6.1).
pub const PRIORITIES: [&str; 4] = ["low", "medium", "high", "urgent"];
/// Colours of the people palette (07 §2.2, ☑ Q-05-8).
pub const COLORS: i64 = 8;

/// A final status: the node is finished (05 §6.3).
pub fn is_final(status: &str) -> bool {
    status == "done" || status == "cancelled"
}

/// `YYYY-MM-DD`, a real day.
fn is_date(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return false;
    }
    let num = |r: std::ops::Range<usize>| s.get(r).and_then(|x| x.parse::<u32>().ok());
    match (num(0..4), num(5..7), num(8..10)) {
        (Some(y), Some(m), Some(d)) if (1..=12).contains(&m) && d >= 1 => {
            let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
            let days = [
                31,
                if leap { 29 } else { 28 },
                31,
                30,
                31,
                30,
                31,
                31,
                30,
                31,
                30,
                31,
            ];
            d <= days[(m - 1) as usize]
        }
        _ => false,
    }
}

/// A start or a deadline (05 §6.1): a day, `YYYY-MM-DD`, or a day and a time
/// of the viewer's clock, `YYYY-MM-DDTHH:MM` — as Obsidian writes a datetime.
fn is_when(s: &str) -> bool {
    match s.split_once('T') {
        None => is_date(s),
        Some((day, time)) => {
            let b = time.as_bytes();
            let num = |r: std::ops::Range<usize>| time.get(r).and_then(|x| x.parse::<u32>().ok());
            is_date(day)
                && b.len() == 5
                && b[2] == b':'
                && num(0..2).is_some_and(|h| h < 24)
                && num(3..5).is_some_and(|m| m < 60)
        }
    }
}

/// A file type such as `image/png`: two parts, no spaces, not too long.
fn is_mime(s: &str) -> bool {
    s.len() <= 127
        && s.split_once('/')
            .is_some_and(|(a, b)| !a.is_empty() && !b.is_empty())
        && !s.chars().any(char::is_whitespace)
}

/// A link with a scheme (`https://…`, `mailto:…`), no spaces.
fn is_url(s: &str) -> bool {
    s.len() <= 2048
        && s.split_once(':').is_some_and(|(scheme, rest)| {
            !rest.is_empty()
                && scheme
                    .chars()
                    .next()
                    .is_some_and(|c| c.is_ascii_alphabetic())
                && scheme
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
        })
        && !s.chars().any(char::is_whitespace)
}

/// The name a link asset gets with its link (13 §3.9): the host, the link
/// itself, or none — a name the user has not given it.
fn auto_name(name: &str, url: &str) -> bool {
    let name = name.trim();
    if name.is_empty() || name == url.trim() {
        return true;
    }
    // The host: after the scheme's `//`, up to the first `/`, `?`, `#` or `:`.
    let host = url
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(url)
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("");
    let host = host.rsplit_once('@').map_or(host, |(_, h)| h);
    // An IPv6 host keeps its brackets, as the browser's `URL.hostname` does.
    let host = match host.find(']') {
        Some(end) if host.starts_with('[') => &host[..=end],
        _ => host.split(':').next().unwrap_or(""),
    };
    !host.is_empty() && name.eq_ignore_ascii_case(host)
}

/// An icon's name, `filetype-image` and the like (07 §6.1).
fn is_icon_name(s: &str) -> bool {
    (1..=40).contains(&s.len())
        && s.bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}

#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error("document engine: {0}")]
    Engine(String),
    /// The operation breaks the model's rules; nothing was written.
    #[error("{0}")]
    Invalid(String),
}

pub type Result<T> = std::result::Result<T, CoreError>;

fn engine(e: impl std::fmt::Display) -> CoreError {
    CoreError::Engine(e.to_string())
}

fn invalid(msg: impl Into<String>) -> CoreError {
    CoreError::Invalid(msg.into())
}

/// The fields a node carries besides its name (05 §6.1), as the canvas and
/// the properties panel read them.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Attrs {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deadline: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<i64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub assignees: Vec<String>,
    /// An asset's file: its SHA-256 (05 §4.4, 10 §11).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset: Option<String>,
    /// An asset file's type, `image/png` and the like.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime: Option<String>,
    /// An asset's link instead of a file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// An asset's icon chosen by hand (07 §6.1).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    /// A link asset's preview picture, its SHA-256 (05 §4.4, ✅ Q-13-16).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
    /// Its flags (05 §7).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub flags: Vec<Flag>,
}

/// A roll-up (05 §6.4, ☑ Q-05-2, ADR-0010): over the tasks inside a folder
/// or project at any depth and their subtasks by wires, or a task's subtasks
/// by wires — each once; the finished of all, and the nearest open deadline.
/// A list's is over its items: the ticked of all, no deadline.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Fold {
    pub done: u32,
    pub total: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nearest: Option<String>,
}

/// A node as the canvas draws it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ViewNode {
    pub id: String,
    pub kind: NodeKind,
    pub name: String,
    pub x: f64,
    pub y: f64,
    #[serde(flatten)]
    pub attrs: Attrs,
    /// For folders, projects and tasks: the roll-up of their tasks; for a
    /// list, of its items.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fold: Option<Fold>,
    /// Its wires whose other end is not placed in this network: «↗N» (05 §8.3).
    #[serde(default, skip_serializing_if = "is_zero")]
    pub external: u32,
    /// This placement is not its primary one: an appearance (05 §5).
    #[serde(default, skip_serializing_if = "is_false")]
    pub appearance: bool,
    /// The networks it is placed in, this one among them: «×N» (06 §12.2).
    #[serde(default, skip_serializing_if = "is_zero")]
    pub places: u32,
}

fn is_zero(n: &u32) -> bool {
    *n == 0
}

fn is_false(b: &bool) -> bool {
    !*b
}

/// One placement of a node, for «Где размещена» (06 §12.2).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Place {
    pub net: String,
    /// From the root to that network, both included: `[id, name]`.
    pub path: Vec<(String, String)>,
    pub primary: bool,
}

/// A wire of «↗N» (05 §8.3, 06 §14): its other end, not placed in the
/// network, which way it goes and where it comes from.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ExternalWire {
    /// The node at the other end.
    pub id: String,
    pub name: String,
    pub kind: NodeKind,
    /// The wire comes into the node: `id → node`.
    pub incoming: bool,
    /// It comes (also) from a `[[link]]` in text.
    pub text: bool,
    /// It was drawn by hand or imported.
    pub manual: bool,
    /// From the root to the other end's primary network: `[id, name]`.
    pub path: Vec<(String, String)>,
}

/// A roll-up wire (05 §8.3, 06 §13.3): wires between nodes inside a network
/// placed here and the nodes outside it, drawn between the bubbles placed
/// here with their count, both ways together. Only a view: no such wire is
/// in the data.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ViewRollup {
    /// The two bubbles, `a < b`.
    pub a: String,
    pub b: String,
    pub count: u32,
}

/// A row of the checklist preview in a task's or project's panel (05 §4.3):
/// a task or project with its subtasks, a folder with the tasks inside.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TaskRow {
    pub id: String,
    pub kind: NodeKind,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deadline: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rows: Vec<TaskRow>,
}

/// A node at the other end of a wire, for the properties panel.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Linked {
    pub id: String,
    pub kind: NodeKind,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    /// An asset's file, type, link and icon: its icon in the panel (07 §6.1).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
}

/// One node with everything the properties panel shows (06, «P»).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct NodeDetails {
    pub id: String,
    pub kind: NodeKind,
    pub name: String,
    #[serde(flatten)]
    pub attrs: Attrs,
    /// The network of its primary placement (05 §5).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    /// Wires in: from a task, it is that task's subtask or material (05 §4.3).
    pub inputs: Vec<Linked>,
    /// Wires out: a task's subtasks and materials.
    pub outputs: Vec<Linked>,
    /// For folders and projects: the nodes inside.
    pub children: Vec<Linked>,
    /// For tasks and projects: the checklist preview of the hierarchy (05 §4.3).
    pub subtasks: Vec<TaskRow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fold: Option<Fold>,
    /// Where it is placed (05 §5): the primary first, then the oldest.
    #[serde(default)]
    pub places: Vec<Place>,
}

/// A wire's ends, for the star map's whole space (08 §10).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WireEnds {
    pub from: String,
    pub to: String,
}

/// A node in the «Слои» panel: every live node under its primary network.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TreeItem {
    pub id: String,
    pub name: String,
    pub kind: NodeKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    /// A task's or project's deadline: its state's dot in «Ноды» (07 §4.6, Q-07-22).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deadline: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    /// An asset's file, type, link and icon: its icon in the tree (07 §6.1).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    /// Its flags (05 §7): templates are offered in the Tab menu.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub flags: Vec<Flag>,
}

/// A person of the workspace (05 §10).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Person {
    pub id: String,
    pub name: String,
    pub color: i64,
}

/// A wire between two nodes of the network.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ViewEdge {
    pub from: String,
    pub to: String,
    /// It comes (also) from a `[[link]]` in text.
    pub text: bool,
    /// It was drawn by hand or imported.
    pub manual: bool,
}

/// A ghost (05 §8.5): the wire of a note's `[[X]]` to no node.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ViewGhost {
    /// The wire's key, `h(from ‖ "?" ‖ linkKey(X))` (10 §2.5).
    pub edge: String,
    pub from: String,
    /// `X` as the text spells it.
    pub name: String,
}

/// One network for the canvas (10 §7.3): its nodes, the wires between them,
/// the way from the root.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct NetworkView {
    pub net: String,
    pub name: String,
    /// From the root to this network, both included: `[id, name]`.
    pub path: Vec<(String, String)>,
    pub nodes: Vec<ViewNode>,
    pub edges: Vec<ViewEdge>,
    /// `[[Links]]` of the notes here to no node (05 §8.5).
    #[serde(default)]
    pub ghosts: Vec<ViewGhost>,
    /// Roll-up wires to and from the networks placed here (06 §13.3).
    #[serde(default)]
    pub rollups: Vec<ViewRollup>,
    /// The network's wire style (05 §9.2); none — Bézier.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wire_style: Option<WireStyle>,
}

/// A node in the trash.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TrashItem {
    pub id: String,
    pub kind: NodeKind,
    pub name: String,
    pub trashed_at: i64,
    /// The changeset that put it there: nodes trashed together come back together.
    pub batch: String,
}

/// The undo and redo steps the UI shows.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct History {
    pub undo: Option<Label>,
    pub redo: Option<Label>,
}

pub struct Workspace<S: Store> {
    store: S,
    docs: HashMap<String, LoroDoc>,
    k: u32,
    id: String,
    root: NodeId,
    clock: fn() -> i64,
    undo: Vec<Changeset>,
    redo: Vec<Changeset>,
    /// Content documents the core itself changed — the links rewritten after
    /// a rename (13 §6.5) — by a growing number, for open editors to read
    /// them again (15 §3.4). The last `EDITS_KEPT` only.
    edits: Vec<(u64, String)>,
    edit_seq: u64,
}

/// Edits of content documents kept for editors to catch up with.
const EDITS_KEPT: usize = 256;

/// What the core changed in content documents since an editor last asked.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Edited {
    /// The number to ask with next time.
    pub seq: u64,
    /// The documents; none when the question is older than what is kept:
    /// every open document is to be read again.
    pub docs: Option<Vec<String>>,
}

impl<S: Store> std::fmt::Debug for Workspace<S> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Workspace")
            .field("id", &self.id)
            .field("root", &self.root.to_text())
            .field("k", &self.k)
            .finish_non_exhaustive()
    }
}

/// The writes of one operation in progress.
struct Tx<'a> {
    docs: &'a mut HashMap<String, LoroDoc>,
    before: HashMap<String, VersionVector>,
    writes: Vec<KeyWrite>,
}

fn read(doc: &LoroDoc, map: &str, key: &str) -> Option<Val> {
    match doc.get_map(map).get(key)? {
        ValueOrContainer::Value(v) => Val::from_loro(&v),
        ValueOrContainer::Container(_) => None,
    }
}

impl Tx<'_> {
    fn set(&mut self, doc: &str, map: &str, key: &str, value: Option<Val>) -> Result<()> {
        let d = self
            .docs
            .get(doc)
            .ok_or_else(|| engine(format!("document {doc} is not loaded")))?;
        self.before
            .entry(doc.to_owned())
            .or_insert_with(|| d.oplog_vv());
        let before = read(d, map, key);
        if before == value {
            return Ok(());
        }
        let m = d.get_map(map);
        match &value {
            Some(v) => m.insert(key, LoroValue::from(v.clone())).map_err(engine)?,
            None => m.delete(key).map_err(engine)?,
        }
        self.writes.push(KeyWrite {
            doc: doc.to_owned(),
            map: map.to_owned(),
            key: key.to_owned(),
            before,
            after: value,
        });
        Ok(())
    }
}

impl<S: Store> Workspace<S> {
    /// A new workspace in an empty store: its manifest and the root network (05 §3).
    pub fn create(store: S, root_name: &str) -> Result<Self> {
        let mut ws = Self {
            store,
            docs: HashMap::new(),
            k: 1,
            id: strata_model::WorkspaceId::new().to_text(),
            root: NodeId::new(),
            clock: now_ms,
            undo: Vec::new(),
            redo: Vec::new(),
            edits: Vec::new(),
            edit_seq: 0,
        };
        for doc in ["manifest", "sys"] {
            ws.docs.insert(doc.to_owned(), LoroDoc::new());
        }
        ws.load_index()?;
        let root = ws.root.to_text();
        let ts = (ws.clock)();
        let id = ws.id.clone();
        let index = ws.index_doc(ws.root);
        ws.write(
            ChangesetOrigin::System,
            Label::new("core.change.create"),
            |tx| {
                tx.set("manifest", "ws", "id", Some(Val::str(id)))?;
                tx.set("manifest", "ws", "root", Some(Val::str(root.clone())))?;
                tx.set("sys", "sys", "schema", Some(Val::Int(SCHEMA)))?;
                tx.set("sys", "sys", "k", Some(Val::Int(1)))?;
                tx.set(&index, "kind", &root, Some(Val::str("network")))?;
                tx.set(&index, "name", &root, Some(Val::str(root_name)))?;
                tx.set(&index, "createdAt", &root, Some(Val::Int(ts)))?;
                Ok(())
            },
        )?;
        Ok(ws)
    }

    /// A workspace from its store.
    pub fn open(store: S) -> Result<Self> {
        let mut docs = HashMap::new();
        for doc in ["manifest", "sys"] {
            let d =
                load(&store, doc)?.ok_or_else(|| invalid(format!("no {doc}: not a workspace")))?;
            docs.insert(doc.to_owned(), d);
        }
        let id = read(&docs["manifest"], "ws", "id")
            .and_then(|v| v.as_str().map(str::to_owned))
            .ok_or_else(|| invalid("the manifest has no workspace id"))?;
        let root = read(&docs["manifest"], "ws", "root")
            .and_then(|v| v.as_str().map(str::to_owned))
            .ok_or_else(|| invalid("the manifest has no root network"))?;
        let k = read(&docs["sys"], "sys", "k")
            .and_then(|v| v.as_i64())
            .unwrap_or(1) as u32;
        let mut ws = Self {
            store,
            docs,
            k,
            id,
            root: NodeId::parse(&root).map_err(|e| invalid(e.to_string()))?,
            clock: now_ms,
            undo: Vec::new(),
            redo: Vec::new(),
            edits: Vec::new(),
            edit_seq: 0,
        };
        ws.load_index()?;
        Ok(ws)
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn root(&self) -> String {
        self.root.to_text()
    }

    /// The workspace's name: its root network's (05 §3).
    pub fn root_name(&self) -> String {
        self.name(self.root)
    }

    /// Every document of the workspace as a Loro snapshot, for an archive
    /// (10 §3.5); documents not in memory are read from the store.
    pub fn snapshots(&self) -> Result<Vec<(String, Vec<u8>)>> {
        let mut out = Vec::new();
        for id in self.store.doc_ids()? {
            let bytes = match self.docs.get(&id) {
                Some(d) => d.export(ExportMode::Snapshot).map_err(engine)?,
                None => match load(&self.store, &id)? {
                    Some(d) => d.export(ExportMode::Snapshot).map_err(engine)?,
                    None => continue,
                },
            };
            out.push((id, bytes));
        }
        Ok(out)
    }

    /// A new workspace id for a copy (10 §3.6, «Сделать независимой»): the
    /// node ids stay, so links inside keep working.
    pub fn reidentify(&mut self) -> Result<String> {
        let id = strata_model::WorkspaceId::new().to_text();
        let text = id.clone();
        self.write(
            ChangesetOrigin::System,
            Label::new("core.change.copy"),
            |tx| tx.set("manifest", "ws", "id", Some(Val::str(text))),
        )?;
        self.id = id.clone();
        Ok(id)
    }

    pub fn store(&self) -> &S {
        &self.store
    }

    /// The store back, to open the workspace again (tests, closing).
    pub fn into_store(self) -> S {
        self.store
    }

    /// A fixed clock for tests.
    pub fn set_clock(&mut self, clock: fn() -> i64) {
        self.clock = clock;
    }

    fn load_index(&mut self) -> Result<()> {
        for k in 0..self.k {
            let id = format!("index/0/{k}");
            let d = load(&self.store, &id)?.unwrap_or_default();
            self.docs.insert(id, d);
        }
        Ok(())
    }

    fn index_doc(&self, node: NodeId) -> String {
        format!("index/0/{}", shard_of(node, self.k))
    }

    fn index_shards(&self) -> impl Iterator<Item = &LoroDoc> {
        (0..self.k).filter_map(|k| self.docs.get(&format!("index/0/{k}")))
    }

    /// A network's document, loaded on first use (10 §6).
    fn ensure_doc(&mut self, doc: &str) -> Result<()> {
        if !self.docs.contains_key(doc) {
            let d = load(&self.store, doc)?.unwrap_or_default();
            self.docs.insert(doc.to_owned(), d);
        }
        Ok(())
    }

    fn field(&self, node: NodeId, map: &str) -> Option<Val> {
        read(self.docs.get(&self.index_doc(node))?, map, &node.to_text())
    }

    fn kind(&self, node: NodeId) -> Option<NodeKind> {
        let v = self.field(node, "kind")?;
        serde_json::from_value(serde_json::Value::String(v.as_str()?.to_owned())).ok()
    }

    fn alive(&self, node: NodeId) -> bool {
        self.kind(node).is_some() && self.field(node, "trashedAt").is_none()
    }

    fn name(&self, node: NodeId) -> String {
        self.field(node, "name")
            .and_then(|v| v.as_str().map(str::to_owned))
            .unwrap_or_default()
    }

    fn parse(&self, id: &str) -> Result<NodeId> {
        NodeId::parse(id).map_err(|e| invalid(format!("node id {id}: {e}")))
    }

    /// A live folder or project: a node with a canvas (05 §4.2).
    fn network(&self, id: &str) -> Result<NodeId> {
        let n = self.parse(id)?;
        if !self.kind(n).is_some_and(NodeKind::has_canvas) || !self.alive(n) {
            return Err(invalid(format!("{id} is not a live folder or project")));
        }
        Ok(n)
    }

    fn live(&self, id: &str) -> Result<NodeId> {
        let n = self.parse(id)?;
        if !self.alive(n) {
            return Err(invalid(format!(
                "node {id} does not exist or is in the trash"
            )));
        }
        Ok(n)
    }

    /// Networks above `net` by primary placements, up to the root (05 §9.3).
    fn ancestors(&self, net: NodeId) -> Vec<NodeId> {
        let mut out = Vec::new();
        let mut at = net;
        while let Some(parent) = self.primary_of(at) {
            if out.contains(&parent) || out.len() > 1000 {
                break;
            }
            out.push(parent);
            at = parent;
        }
        out
    }

    /// Runs `build` as one changeset and commits it; nothing is kept if it fails.
    fn write(
        &mut self,
        origin: ChangesetOrigin,
        label: Label,
        build: impl FnOnce(&mut Tx<'_>) -> Result<()>,
    ) -> Result<Changeset> {
        let mut tx = Tx {
            docs: &mut self.docs,
            before: HashMap::new(),
            writes: Vec::new(),
        };
        let built = build(&mut tx);
        let Tx { before, writes, .. } = tx;
        if let Err(e) = built {
            // The documents in memory go back to the store's state (10 §3.3).
            for doc in before.keys() {
                let d = load(&self.store, doc)?.unwrap_or_default();
                self.docs.insert(doc.clone(), d);
            }
            return Err(e);
        }
        let changeset = Changeset {
            id: ChangesetId::new().to_text(),
            ts: (self.clock)(),
            origin,
            label,
            reverts: None,
            writes,
        };
        let mut updates = Vec::new();
        for (doc, vv) in &before {
            let d = &self.docs[doc];
            d.commit();
            let bytes = d.export(ExportMode::updates(vv)).map_err(engine)?;
            if !bytes.is_empty() {
                updates.push((doc.clone(), bytes));
            }
        }
        updates.sort();
        if let Err(e) = self.store.commit(&changeset, &updates) {
            for doc in before.keys() {
                let d = load(&self.store, doc)?.unwrap_or_default();
                self.docs.insert(doc.clone(), d);
            }
            return Err(e.into());
        }
        Ok(changeset)
    }

    /// Applies the operations as one changeset, one step of undo.
    pub fn apply(&mut self, ops: &[Op], label: Label) -> Result<Changeset> {
        let changeset = self.commit_ops(ops, label)?;
        if !changeset.writes.is_empty() {
            self.undo.push(changeset.clone());
            self.redo.clear();
        }
        self.links_after(&changeset, true)?;
        Ok(changeset)
    }

    /// Adds operations to the last step of undo, for a gesture that goes on
    /// after its first commit: naming a node right after creating it (06
    /// §5.5), the drop that ends a drag after a shake. The journal keeps
    /// their changeset apart; undo reverts both at once. `label` renames the
    /// step; with no operations only the label changes.
    pub fn amend(&mut self, ops: &[Op], label: Label) -> Result<Option<Changeset>> {
        let changeset = if ops.is_empty() {
            None
        } else {
            Some(self.commit_ops(ops, label.clone())?)
        };
        let written = changeset.as_ref().is_some_and(|c| !c.writes.is_empty());
        match self.undo.last_mut() {
            Some(last) => {
                if let Some(c) = &changeset {
                    last.writes.extend(c.writes.iter().cloned());
                }
                last.label = label;
            }
            None => {
                if let Some(c) = changeset.as_ref().filter(|_| written) {
                    self.undo.push(c.clone());
                }
            }
        }
        if written {
            self.redo.clear();
        }
        // The rest of a gesture names what it made (06 §5.5): no text named
        // it before, so nothing is rewritten.
        if let Some(c) = &changeset {
            self.links_after(c, false)?;
        }
        Ok(changeset)
    }

    /// Reverts the last step and forgets it: a gesture cancelled with Esc.
    pub fn cancel(&mut self) -> Result<Option<RevertReport>> {
        let Some(cs) = self.undo.pop() else {
            return Ok(None);
        };
        let (back, report) = self.revert(&cs)?;
        self.links_after(&back, true)?;
        Ok(Some(report))
    }

    /// Checks and writes the operations as one changeset, outside undo.
    fn commit_ops(&mut self, ops: &[Op], label: Label) -> Result<Changeset> {
        self.commit_ops_as(ChangesetOrigin::User, ops, label)
    }

    fn commit_ops_as(
        &mut self,
        origin: ChangesetOrigin,
        ops: &[Op],
        label: Label,
    ) -> Result<Changeset> {
        // Documents of the networks the operations touch, before the transaction.
        for op in ops {
            match op {
                Op::CreateNode { net, .. }
                | Op::Move { net, .. }
                | Op::Place { net, .. }
                | Op::Relocate { to: net, .. }
                | Op::SetWireStyle { net, .. } => {
                    self.ensure_doc(&format!("net/{net}"))?;
                }
                _ => {}
            }
        }
        let plan = self.plan(ops)?;
        self.write(origin, label, |tx| {
            for (doc, map, key, value) in plan {
                tx.set(&doc, &map, &key, value)?;
            }
            Ok(())
        })
    }

    /// The key writes of `ops`, checked against the model's rules first.
    #[allow(clippy::type_complexity)]
    fn plan(&self, ops: &[Op]) -> Result<Vec<(String, String, String, Option<Val>)>> {
        let ts = (self.clock)();
        let batch = ChangesetId::new().to_text();
        let mut out = Vec::new();
        let mut put = |doc: &str, map: &str, key: &str, v: Option<Val>| {
            out.push((doc.to_owned(), map.to_owned(), key.to_owned(), v));
        };
        // Nodes made earlier in this list count as existing for the ops after them.
        let mut made: HashMap<NodeId, NodeKind> = HashMap::new();
        // People added earlier in this list, for the next one's colour.
        let mut people_added = 0i64;
        let exists =
            |n: NodeId, made: &HashMap<NodeId, NodeKind>| made.contains_key(&n) || self.alive(n);
        // Placements as the ops so far leave them (05 §5).
        let mut ov = places::Overlay::default();
        let at_xy = |x: f64, y: f64| Some(Val::List(vec![Val::Float(x), Val::Float(y)]));
        for op in ops {
            match op {
                Op::CreateNode {
                    id,
                    kind,
                    name,
                    net,
                    x,
                    y,
                } => {
                    // A folder or project made earlier in this list takes nodes too.
                    let parent = match self.parse(net) {
                        Ok(p) if made.get(&p).is_some_and(|k| k.has_canvas()) => p,
                        _ => self.network(net)?,
                    };
                    let node = match id {
                        Some(id) => self.parse(id)?,
                        None => NodeId::new(),
                    };
                    if self.kind(node).is_some() || made.contains_key(&node) {
                        return Err(invalid(format!("node {} already exists", node.to_text())));
                    }
                    made.insert(node, *kind);
                    let key = node.to_text();
                    let index = self.index_doc(node);
                    let kind_text = serde_json::to_value(kind)
                        .ok()
                        .and_then(|v| v.as_str().map(str::to_owned))
                        .unwrap_or_default();
                    put(&index, "kind", &key, Some(Val::str(kind_text)));
                    put(&index, "name", &key, Some(Val::str(name.trim())));
                    put(&index, "createdAt", &key, Some(Val::Int(ts)));
                    put(&index, "primaryNet", &key, Some(Val::str(net.clone())));
                    put(
                        &index,
                        "placement",
                        &PlacementKey::new(parent, node).to_text(),
                        Some(Val::map([("at", Val::Int(ts))])),
                    );
                    put(&format!("net/{net}"), "pos", &key, at_xy(*x, *y));
                    ov.placed.insert((parent, node), Some(ts));
                    ov.primary.insert(node, parent);
                    if kind.has_canvas() {
                        ov.made_in.insert(node, parent);
                    }
                }
                Op::Place { id, net, x, y } => {
                    let n = self.parse(id)?;
                    if !exists(n, &made) {
                        return Err(invalid(format!(
                            "node {id} does not exist or is in the trash"
                        )));
                    }
                    let target = match self.parse(net) {
                        Ok(p) if made.get(&p).is_some_and(|k| k.has_canvas()) => p,
                        _ => self.network(net)?,
                    };
                    if self.placed_now(&ov, target, n).is_some() {
                        return Err(invalid(format!(
                            "node {id} lies in {net} already (05 §5 rule 3)"
                        )));
                    }
                    self.may_hold(target, n, &ov.made_in)?;
                    put(
                        &self.index_doc(n),
                        "placement",
                        &PlacementKey::new(target, n).to_text(),
                        Some(Val::map([("at", Val::Int(ts))])),
                    );
                    put(&format!("net/{net}"), "pos", &n.to_text(), at_xy(*x, *y));
                    ov.placed.insert((target, n), Some(ts));
                }
                Op::Unplace { id, net } => {
                    let n = self.live(id)?;
                    let from = self.parse(net)?;
                    if self.placed_now(&ov, from, n).is_none() {
                        return Err(invalid(format!("node {id} is not placed in {net}")));
                    }
                    let was_primary = self.primary_now(&ov, n) == Some(from);
                    let rest: Vec<NodeId> = self
                        .places_now(&ov, n)
                        .into_iter()
                        .map(|(p, _)| p)
                        .filter(|&p| p != from)
                        .collect();
                    let index = self.index_doc(n);
                    let key = n.to_text();
                    match rest.first() {
                        // The last placement: the node goes to the trash from
                        // where it lies, and comes back there (05 §5).
                        None => {
                            let c = self.cascade(&[n])?;
                            self.put_cascade(&mut put, &c, ts, &batch);
                        }
                        Some(&oldest) => {
                            put(
                                &index,
                                "placement",
                                &PlacementKey::new(from, n).to_text(),
                                None,
                            );
                            ov.placed.insert((from, n), None);
                            if was_primary {
                                put(&index, "primaryNet", &key, Some(Val::str(oldest.to_text())));
                                ov.primary.insert(n, oldest);
                            }
                        }
                    }
                }
                Op::SetPrimary { id, net } => {
                    let n = self.live(id)?;
                    let p = self.parse(net)?;
                    if self.placed_now(&ov, p, n).is_none() {
                        return Err(invalid(format!("node {id} is not placed in {net}")));
                    }
                    put(
                        &self.index_doc(n),
                        "primaryNet",
                        &n.to_text(),
                        Some(Val::str(p.to_text())),
                    );
                    ov.primary.insert(n, p);
                }
                Op::Relocate { id, from, to, x, y } => {
                    let n = self.live(id)?;
                    let src = self.parse(from)?;
                    let Some(since) = self.placed_now(&ov, src, n) else {
                        return Err(invalid(format!("node {id} is not placed in {from}")));
                    };
                    let target = match self.parse(to) {
                        Ok(p) if made.get(&p).is_some_and(|k| k.has_canvas()) => p,
                        _ => self.network(to)?,
                    };
                    if target == src {
                        put(&format!("net/{to}"), "pos", &n.to_text(), at_xy(*x, *y));
                        continue;
                    }
                    self.may_hold(target, n, &ov.made_in)?;
                    let was_primary = self.primary_now(&ov, n) == Some(src);
                    let there = self.placed_now(&ov, target, n).is_some();
                    let index = self.index_doc(n);
                    put(
                        &index,
                        "placement",
                        &PlacementKey::new(src, n).to_text(),
                        None,
                    );
                    ov.placed.insert((src, n), None);
                    // Already there (05 §5): the one there keeps its place.
                    if !there {
                        // The same placement, moved: it keeps its age (10 §8.5).
                        put(
                            &index,
                            "placement",
                            &PlacementKey::new(target, n).to_text(),
                            Some(Val::map([("at", Val::Int(since))])),
                        );
                        put(&format!("net/{to}"), "pos", &n.to_text(), at_xy(*x, *y));
                        ov.placed.insert((target, n), Some(since));
                    }
                    if was_primary {
                        put(
                            &index,
                            "primaryNet",
                            &n.to_text(),
                            Some(Val::str(target.to_text())),
                        );
                        ov.primary.insert(n, target);
                    }
                }
                Op::SetKind { id, kind } => {
                    let n = self.parse(id)?;
                    if !exists(n, &made) {
                        return Err(invalid(format!(
                            "node {id} does not exist or is in the trash"
                        )));
                    }
                    self.unlocked(n)?;
                    let from = made.get(&n).copied().or_else(|| self.kind(n));
                    let pair = matches!(
                        (from, *kind),
                        (Some(NodeKind::Task), NodeKind::Project)
                            | (Some(NodeKind::Project), NodeKind::Task)
                            | (Some(NodeKind::Network), NodeKind::Project)
                            | (Some(NodeKind::Project), NodeKind::Network)
                    );
                    if !pair || n == self.root {
                        return Err(invalid(
                            "a kind changes between task and project, folder and project only (05 §4.2)",
                        ));
                    }
                    if *kind == NodeKind::Task {
                        let inside = self.children();
                        let full = inside
                            .get(&n)
                            .is_some_and(|c| c.iter().any(|c| self.alive(*c)));
                        if full {
                            return Err(invalid(
                                "a project becomes a task only when nothing is inside it (05 §4.2)",
                            ));
                        }
                    }
                    let key = n.to_text();
                    let index = self.index_doc(n);
                    // A folder has no task fields (ADR-0010): they go with the step.
                    if *kind == NodeKind::Network {
                        for field in ["status", "priority", "start", "deadline"] {
                            if self.field(n, field).is_some() {
                                put(&index, field, &key, None);
                            }
                        }
                        for person in self.attrs(n).assignees {
                            put(&index, "set", &format!("{key}|assignees|{person}"), None);
                        }
                    }
                    let kind_text = serde_json::to_value(kind)
                        .ok()
                        .and_then(|v| v.as_str().map(str::to_owned))
                        .unwrap_or_default();
                    // Written at once: the ops after this one read the new kind.
                    put(&index, "kind", &key, Some(Val::str(kind_text)));
                }
                Op::Rename { id, name } => {
                    let n = self.parse(id)?;
                    if !exists(n, &made) {
                        return Err(invalid(format!(
                            "node {id} does not exist or is in the trash"
                        )));
                    }
                    self.unlocked(n)?;
                    put(
                        &self.index_doc(n),
                        "name",
                        &n.to_text(),
                        Some(Val::str(name.trim())),
                    );
                }
                Op::Move { net, id, x, y } => {
                    let parent = match self.parse(net) {
                        Ok(p) if made.get(&p).is_some_and(|k| k.has_canvas()) => p,
                        _ => self.network(net)?,
                    };
                    let n = self.parse(id)?;
                    let placed = made.contains_key(&n) || self.placed(parent, n);
                    if !placed {
                        return Err(invalid(format!("node {id} is not placed in {net}")));
                    }
                    put(
                        &format!("net/{net}"),
                        "pos",
                        &n.to_text(),
                        Some(Val::List(vec![Val::Float(*x), Val::Float(*y)])),
                    );
                }
                Op::Connect { from, to } => {
                    let (a, b) = (self.parse(from)?, self.parse(to)?);
                    if a == b {
                        return Err(invalid("a wire needs two different nodes (05 §8.2)"));
                    }
                    for n in [a, b] {
                        if !exists(n, &made) {
                            return Err(invalid(format!("node {} does not exist", n.to_text())));
                        }
                    }
                    let edge = EdgeKey::between(a, b).to_text();
                    let index = self.index_doc(a);
                    put(
                        &index,
                        "edge",
                        &edge,
                        Some(Val::map([
                            ("from", Val::str(from.clone())),
                            ("to", Val::str(to.clone())),
                        ])),
                    );
                    put(
                        &index,
                        "edgeOrigin",
                        &format!("{edge}|manual"),
                        Some(Val::map([("at", Val::Int(ts))])),
                    );
                }
                Op::Disconnect { from, to } => {
                    let (a, b) = (self.parse(from)?, self.parse(to)?);
                    let edge = EdgeKey::between(a, b).to_text();
                    let index = self.index_doc(a);
                    let doc = &self.docs[&index];
                    if read(doc, "edge", &edge).is_none() {
                        return Err(invalid("there is no such wire"));
                    }
                    put(&index, "edgeOrigin", &format!("{edge}|manual"), None);
                    put(&index, "edgeOrigin", &format!("{edge}|import"), None);
                    // The wire lives while it has an origin (10 §2.3).
                    if read(doc, "edgeOrigin", &format!("{edge}|text")).is_none() {
                        put(&index, "edge", &edge, None);
                    }
                }
                Op::Trash { ids } => {
                    let roots = ids
                        .iter()
                        .map(|id| self.live(id))
                        .collect::<Result<Vec<_>>>()?;
                    let c = self.cascade(&roots)?;
                    self.put_cascade(&mut put, &c, ts, &batch);
                }
                Op::Restore { ids } => {
                    for id in ids {
                        let n = self.parse(id)?;
                        if self.field(n, "trashedAt").is_none() {
                            return Err(invalid(format!("node {id} is not in the trash")));
                        }
                        // What went in the same step comes back with it (05 §5).
                        for m in self.trashed_with(n) {
                            let index = self.index_doc(m);
                            let key = m.to_text();
                            put(&index, "trashedAt", &key, None);
                            put(&index, "trashBatch", &key, None);
                        }
                    }
                }
                Op::SetAttr { id, key, value } => {
                    let n = self.parse(id)?;
                    if !exists(n, &made) {
                        return Err(invalid(format!(
                            "node {id} does not exist or is in the trash"
                        )));
                    }
                    self.unlocked(n)?;
                    let kind = made.get(&n).copied().or_else(|| self.kind(n));
                    let task = kind.is_some_and(NodeKind::is_task);
                    let asset = kind == Some(NodeKind::Asset);
                    // Each kind its own fields (05 §4.2–4.4, ADR-0010); one left
                    // on a node of another kind from before can still be cleared.
                    let clear = value.is_none();
                    let fits = match key.as_str() {
                        "status" | "priority" | "start" | "deadline" => task || clear,
                        "color" => true,
                        "asset" | "mime" | "url" | "icon" | "preview" => asset || clear,
                        _ => false,
                    };
                    if !fits {
                        return Err(invalid(format!(
                            "attribute {key}: not a field of this kind of node"
                        )));
                    }
                    let bad = || invalid(format!("attribute {key}: not a value it takes"));
                    let ok = match (key.as_str(), value) {
                        (_, None) => true,
                        ("status", Some(Val::Str(v))) => STATUSES.contains(&v.as_str()),
                        ("priority", Some(Val::Str(v))) => PRIORITIES.contains(&v.as_str()),
                        ("start" | "deadline", Some(Val::Str(v))) => is_when(v),
                        ("color", Some(Val::Int(v))) => (0..COLORS).contains(v),
                        ("asset" | "preview", Some(Val::Str(v))) => {
                            v.len() == 64 && v.bytes().all(|c| c.is_ascii_hexdigit())
                        }
                        ("mime", Some(Val::Str(v))) => is_mime(v),
                        ("url", Some(Val::Str(v))) => is_url(v),
                        ("icon", Some(Val::Str(v))) => is_icon_name(v),
                        _ => false,
                    };
                    if !ok {
                        return Err(bad());
                    }
                    let index = self.index_doc(n);
                    // A preview shows its link (05 §4.4): another link takes it away.
                    if key == "url"
                        && self.attrs(n).url.as_deref() != value.as_ref().and_then(Val::as_str)
                    {
                        put(&index, "attr", &format!("{}|preview", n.to_text()), None);
                    }
                    match key.as_str() {
                        "status" | "priority" | "start" | "deadline" | "color" => {
                            put(&index, key, &n.to_text(), value.clone());
                        }
                        _ => {
                            put(
                                &index,
                                "attr",
                                &format!("{}|{key}", n.to_text()),
                                value.clone(),
                            );
                        }
                    }
                }
                Op::Assign { id, person, on } => {
                    let n = self.parse(id)?;
                    if !exists(n, &made) {
                        return Err(invalid(format!(
                            "node {id} does not exist or is in the trash"
                        )));
                    }
                    self.unlocked(n)?;
                    let kind = made.get(&n).copied().or_else(|| self.kind(n));
                    // Taking a person off stays open to any kind, as clearing a field.
                    if *on && !kind.is_some_and(NodeKind::is_task) {
                        return Err(invalid(
                            "assignees are a field of tasks and projects (05 §4.3)",
                        ));
                    }
                    if *on && read(&self.docs["manifest"], "people", person).is_none() {
                        return Err(invalid(format!("no person {person} in this workspace")));
                    }
                    let key = format!("{}|assignees|{person}", n.to_text());
                    put(&self.index_doc(n), "set", &key, on.then_some(Val::Int(1)));
                }
                Op::AddPerson { id, name, color } => {
                    let name = name.trim();
                    if name.is_empty() {
                        return Err(invalid("a person needs a name"));
                    }
                    let pid = id.clone().unwrap_or_else(|| NodeId::new().to_text());
                    if read(&self.docs["manifest"], "people", &pid).is_some() {
                        return Err(invalid(format!("person {pid} already exists")));
                    }
                    // With no colour asked, the next of the palette in the order
                    // people come (07 §2.2 «Раздача цветов»), those of this list too.
                    let known = match self.docs["manifest"].get_map("people").get_value() {
                        LoroValue::Map(m) => m.len() as i64,
                        _ => 0,
                    };
                    let c = color.unwrap_or(known + people_added).rem_euclid(COLORS);
                    people_added += 1;
                    put(
                        "manifest",
                        "people",
                        &pid,
                        Some(Val::map([("name", Val::str(name)), ("color", Val::Int(c))])),
                    );
                }
                Op::RenamePerson { id, name } => {
                    let Some(Val::Map(mut p)) = read(&self.docs["manifest"], "people", id) else {
                        return Err(invalid(format!("no person {id} in this workspace")));
                    };
                    p.insert("name".to_owned(), Val::str(name.trim()));
                    put("manifest", "people", id, Some(Val::Map(p)));
                }
                Op::SetFlag { id, flag, on } => {
                    let n = self.parse(id)?;
                    if !exists(n, &made) {
                        return Err(invalid(format!(
                            "node {id} does not exist or is in the trash"
                        )));
                    }
                    put(
                        &self.index_doc(n),
                        "flag",
                        &format!("{}|{}", n.to_text(), flag.as_str()),
                        on.then_some(Val::Int(1)),
                    );
                }
                Op::SetWireStyle { net, style } => {
                    // A setting of the network's own document (05 §9.2).
                    match self.parse(net) {
                        Ok(p) if made.get(&p).is_some_and(|k| k.has_canvas()) => {}
                        _ => {
                            self.network(net)?;
                        }
                    }
                    put(
                        &format!("net/{net}"),
                        "settings",
                        "wireStyle",
                        style.map(|s| Val::str(s.as_str())),
                    );
                }
            }
        }
        Ok(out)
    }

    fn placed(&self, net: NodeId, node: NodeId) -> bool {
        let key = PlacementKey::new(net, node).to_text();
        self.docs
            .get(&self.index_doc(node))
            .is_some_and(|d| read(d, "placement", &key).is_some())
    }

    /// Writes the old value back where a key still holds the new one (05 §11).
    fn revert(&mut self, cs: &Changeset) -> Result<(Changeset, RevertReport)> {
        for w in &cs.writes {
            self.ensure_doc(&w.doc)?;
        }
        let mut skipped = Vec::new();
        let mut plan = Vec::new();
        for w in cs.writes.iter().rev() {
            let now = read(&self.docs[&w.doc], &w.map, &w.key);
            if now == w.after {
                plan.push(w.clone());
            } else {
                skipped.push(w.clone());
            }
        }
        let mut out = self.write(cs.origin.clone(), cs.label.clone(), |tx| {
            for w in plan {
                tx.set(&w.doc, &w.map, &w.key, w.before)?;
            }
            Ok(())
        })?;
        out.reverts = Some(cs.id.clone());
        Ok((out, RevertReport { skipped }))
    }

    /// Undoes the last step of this session's user (05 §11).
    pub fn undo(&mut self) -> Result<Option<RevertReport>> {
        let Some(cs) = self.undo.pop() else {
            return Ok(None);
        };
        let (back, report) = self.revert(&cs)?;
        self.links_after(&back, true)?;
        self.redo.push(back);
        Ok(Some(report))
    }

    /// Redoes the last undone step.
    pub fn redo(&mut self) -> Result<Option<RevertReport>> {
        let Some(cs) = self.redo.pop() else {
            return Ok(None);
        };
        let (again, report) = self.revert(&cs)?;
        self.links_after(&again, true)?;
        self.undo.push(again);
        Ok(Some(report))
    }

    pub fn history(&self) -> History {
        History {
            undo: self.undo.last().map(|c| c.label.clone()),
            redo: self.redo.last().map(|c| c.label.clone()),
        }
    }

    /// The node of a content document `content/<id>` (10 §2.4): a note's
    /// text, a board's scene, a list's items; for a task, project, folder or
    /// asset — its description (05 §4.2, ADR-0010).
    fn content_node(&self, doc: &str) -> Result<NodeId> {
        let id = doc
            .strip_prefix("content/")
            .ok_or_else(|| invalid(format!("{doc} is not a content document")))?;
        self.live(id)
    }

    /// A content document as one snapshot for an editor in the UI (15 §3.4);
    /// a node that was never opened gets an empty document.
    pub fn doc_snapshot(&mut self, doc: &str) -> Result<Vec<u8>> {
        self.content_node(doc)?;
        self.ensure_doc(doc)?;
        self.docs[doc].export(ExportMode::Snapshot).map_err(engine)
    }

    /// Updates of a content document from an editor (15 §3.4): stored as
    /// they come, outside undo — the editor keeps its own. A note's links
    /// then become its text wires; the answer says whether they changed.
    pub fn doc_push(&mut self, doc: &str, update: &[u8]) -> Result<bool> {
        let node = self.content_node(doc)?;
        self.unlocked(node)?;
        self.ensure_doc(doc)?;
        let d = &self.docs[doc];
        let vv = d.oplog_vv();
        d.import(update).map_err(engine)?;
        let fresh = d.export(ExportMode::updates(&vv)).map_err(engine)?;
        if fresh.is_empty() {
            return Ok(false);
        }
        if let Err(e) = self.store.append(doc, &fresh, now_ms()) {
            // Memory goes back to what the store holds (10 §3.3).
            let d = load(&self.store, doc)?.unwrap_or_default();
            self.docs.insert(doc.to_owned(), d);
            return Err(e.into());
        }
        if self.kind(node) == Some(NodeKind::Note) {
            return self.relink(&BTreeSet::from([node])).map(|c| c.is_some());
        }
        Ok(false)
    }

    /// What a content document has that an editor at `since` (an encoded
    /// Loro version vector) has not: the core's own edits (13 §6.5).
    pub fn doc_updates(&mut self, doc: &str, since: &[u8]) -> Result<Vec<u8>> {
        self.content_node(doc)?;
        self.ensure_doc(doc)?;
        let vv = VersionVector::decode(since).map_err(engine)?;
        let d = &self.docs[doc];
        // Nothing new: no bytes, not an update with only its header.
        if vv.includes_vv(&d.oplog_vv()) {
            return Ok(Vec::new());
        }
        d.export(ExportMode::updates(&vv)).map_err(engine)
    }

    /// The content documents the core changed after edit `since` (15 §3.4).
    pub fn edited(&self, since: u64) -> Edited {
        let oldest = self.edits.first().map_or(self.edit_seq + 1, |(n, _)| *n);
        let docs = (since + 1 >= oldest || since >= self.edit_seq).then(|| {
            let set: BTreeSet<&String> = self
                .edits
                .iter()
                .filter(|(n, _)| *n > since)
                .map(|(_, d)| d)
                .collect();
            set.into_iter().cloned().collect()
        });
        Edited {
            seq: self.edit_seq,
            docs,
        }
    }

    /// Notes that the core changed a content document: editors read it again.
    fn note_edit(&mut self, doc: &str) {
        self.edit_seq += 1;
        self.edits.push((self.edit_seq, doc.to_owned()));
        if self.edits.len() > EDITS_KEPT {
            self.edits.drain(..self.edits.len() - EDITS_KEPT);
        }
    }

    fn text_field(&self, node: NodeId, map: &str) -> Option<String> {
        self.field(node, map)
            .and_then(|v| v.as_str().map(str::to_owned))
    }

    /// The fields of 05 §6.1 a node carries.
    fn attrs(&self, node: NodeId) -> Attrs {
        let key = node.to_text();
        let index = self.docs.get(&self.index_doc(node));
        let attr = |name: &str| {
            index
                .and_then(|d| read(d, "attr", &format!("{key}|{name}")))
                .and_then(|v| v.as_str().map(str::to_owned))
        };
        let mut assignees = Vec::new();
        if let Some(LoroValue::Map(set)) = index.map(|d| d.get_map("set").get_value()) {
            let prefix = format!("{key}|assignees|");
            assignees = set
                .keys()
                .filter_map(|k| k.strip_prefix(&prefix).map(str::to_owned))
                .collect();
            assignees.sort();
        }
        Attrs {
            status: self.text_field(node, "status"),
            start: self.text_field(node, "start"),
            deadline: self.text_field(node, "deadline"),
            priority: self.text_field(node, "priority"),
            color: self.field(node, "color").and_then(|v| v.as_i64()),
            assignees,
            asset: attr("asset"),
            mime: attr("mime"),
            url: attr("url"),
            icon: attr("icon"),
            preview: attr("preview"),
            flags: self.flags(node),
        }
    }

    /// The node's flags (05 §7), in their order.
    fn flags(&self, node: NodeId) -> Vec<Flag> {
        let Some(index) = self.docs.get(&self.index_doc(node)) else {
            return Vec::new();
        };
        let key = node.to_text();
        Flag::ALL
            .into_iter()
            .filter(|f| read(index, "flag", &format!("{key}|{}", f.as_str())).is_some())
            .collect()
    }

    /// «Замок» (05 §7): a locked node keeps its name, fields and content and
    /// stays out of the trash; it moves and its wires change.
    fn unlocked(&self, node: NodeId) -> Result<()> {
        if self.flagged(node, Flag::Lock) {
            return Err(invalid(format!(
                "node {} is locked (05 §7)",
                node.to_text()
            )));
        }
        Ok(())
    }

    fn flagged(&self, node: NodeId, flag: Flag) -> bool {
        self.docs.get(&self.index_doc(node)).is_some_and(|index| {
            read(
                index,
                "flag",
                &format!("{}|{}", node.to_text(), flag.as_str()),
            )
            .is_some()
        })
    }

    /// Every network's placed nodes: `net → nodes`, from the placements.
    fn children(&self) -> HashMap<NodeId, Vec<NodeId>> {
        let mut out: HashMap<NodeId, Vec<NodeId>> = HashMap::new();
        for shard in self.index_shards() {
            let LoroValue::Map(m) = shard.get_map("placement").get_value() else {
                continue;
            };
            for key in m.keys() {
                let Some((net, node)) = key.split_once('/') else {
                    continue;
                };
                if let (Ok(net), Ok(node)) = (NodeId::parse(net), NodeId::parse(node)) {
                    out.entry(net).or_default().push(node);
                }
            }
        }
        out
    }

    /// Every wire's ends, `from → [to]` in creation order of `to` (05 §8).
    fn wires_out(&self) -> HashMap<NodeId, Vec<NodeId>> {
        let mut out: HashMap<NodeId, Vec<NodeId>> = HashMap::new();
        for shard in self.index_shards() {
            let LoroValue::Map(all) = shard.get_map("edge").get_value() else {
                continue;
            };
            for v in all.values() {
                let Some(v) = Val::from_loro(v) else { continue };
                let end = |k: &str| {
                    v.get(k)
                        .and_then(Val::as_str)
                        .and_then(|s| NodeId::parse(s).ok())
                };
                if let (Some(from), Some(to)) = (end("from"), end("to")) {
                    out.entry(from).or_default().push(to);
                }
            }
        }
        for list in out.values_mut() {
            list.sort();
        }
        out
    }

    /// A live task or project.
    fn is_task(&self, n: NodeId) -> bool {
        self.alive(n) && self.kind(n).is_some_and(NodeKind::is_task)
    }

    /// The roll-up of a node (05 §4.3, §6.4, ADR-0010): for a folder or
    /// project, the tasks and projects inside at any depth; for a task or
    /// project, also the subtasks it wires to, and theirs. Each once, cycles
    /// included; the node itself is not counted. A task with no status is open.
    fn fold(
        &self,
        node: NodeId,
        children: &HashMap<NodeId, Vec<NodeId>>,
        wires: &HashMap<NodeId, Vec<NodeId>>,
    ) -> Fold {
        let mut seen = BTreeSet::from([node]);
        let mut tasks: Vec<NodeId> = Vec::new();
        if self.kind(node).is_some_and(NodeKind::has_canvas) {
            let mut stack = vec![node];
            while let Some(at) = stack.pop() {
                for &n in children.get(&at).map(Vec::as_slice).unwrap_or(&[]) {
                    // A node on pause stays out of roll-ups, and what is inside it (05 §6.4).
                    if !self.alive(n) || self.flagged(n, Flag::Pause) || !seen.insert(n) {
                        continue;
                    }
                    let kind = self.kind(n);
                    if kind.is_some_and(NodeKind::is_task) {
                        tasks.push(n);
                    }
                    if kind.is_some_and(NodeKind::has_canvas) {
                        stack.push(n);
                    }
                }
            }
        }
        let mut stack = tasks.clone();
        if self.kind(node).is_some_and(NodeKind::is_task) {
            stack.push(node);
        }
        while let Some(at) = stack.pop() {
            for &n in wires.get(&at).map(Vec::as_slice).unwrap_or(&[]) {
                if self.is_task(n) && !self.flagged(n, Flag::Pause) && seen.insert(n) {
                    tasks.push(n);
                    stack.push(n);
                }
            }
        }
        let mut fold = Fold::default();
        for n in tasks {
            fold.total += 1;
            match self.text_field(n, "status") {
                Some(status) if is_final(&status) => fold.done += 1,
                _ => {
                    if let Some(d) = self.text_field(n, "deadline") {
                        if fold.nearest.as_ref().is_none_or(|x| d < *x) {
                            fold.nearest = Some(d);
                        }
                    }
                }
            }
        }
        fold
    }

    /// A list's roll-up (05 §6.4): its ticked items of all, at any depth,
    /// from the tree of its content document (10 §2.4), in memory or stored.
    fn list_fold(&self, node: NodeId) -> Fold {
        let doc = format!("content/{}", node.to_text());
        let stored;
        let d = match self.docs.get(&doc) {
            Some(d) => d,
            None => match load(&self.store, &doc) {
                Ok(Some(d)) => {
                    stored = d;
                    &stored
                }
                _ => return Fold::default(),
            },
        };
        let tree = d.get_tree(LIST_ITEMS);
        let mut fold = Fold::default();
        for item in tree.get_nodes(false) {
            fold.total += 1;
            let done = tree.get_meta(item.id).ok().and_then(|m| m.get("done"));
            if matches!(done, Some(ValueOrContainer::Value(LoroValue::Bool(true)))) {
                fold.done += 1;
            }
        }
        fold
    }

    /// The roll-up a node shows, by its kind: tasks for folders, projects
    /// and tasks; ticked items for a list; none for the rest.
    fn fold_of(
        &self,
        node: NodeId,
        kind: NodeKind,
        children: &HashMap<NodeId, Vec<NodeId>>,
        wires: &HashMap<NodeId, Vec<NodeId>>,
    ) -> Option<Fold> {
        if kind == NodeKind::Checklist {
            return Some(self.list_fold(node));
        }
        (kind.has_canvas() || kind.is_task()).then(|| self.fold(node, children, wires))
    }

    /// The checklist preview of a task's or project's hierarchy (05 §4.3):
    /// a task's subtasks by wires; inside a project, its tasks, projects and
    /// folders that are not a subtask of a task beside them. Each node once.
    fn task_rows(
        &self,
        node: NodeId,
        children: &HashMap<NodeId, Vec<NodeId>>,
        wires: &HashMap<NodeId, Vec<NodeId>>,
        seen: &mut BTreeSet<NodeId>,
        depth: u32,
    ) -> Vec<TaskRow> {
        if depth > 32 {
            return Vec::new();
        }
        let kind = self.kind(node);
        let mut ids: Vec<NodeId> = Vec::new();
        let mut looped: BTreeSet<NodeId> = BTreeSet::new();
        if kind.is_some_and(NodeKind::is_task) {
            let subtasks = wires.get(&node).map(Vec::as_slice).unwrap_or(&[]);
            ids.extend(subtasks.iter().copied().filter(|&n| self.is_task(n)));
        }
        if kind.is_some_and(NodeKind::has_canvas) {
            let inside: Vec<NodeId> = children
                .get(&node)
                .map(Vec::as_slice)
                .unwrap_or(&[])
                .iter()
                .copied()
                .filter(|&n| self.alive(n))
                .collect();
            let here: BTreeSet<NodeId> = inside.iter().copied().collect();
            // Only a task is a subtask: a folder a task wires to is a material
            // and stays a row of its own.
            let wired: BTreeSet<NodeId> = inside
                .iter()
                .filter(|&&n| self.is_task(n))
                .flat_map(|n| wires.get(n).map(Vec::as_slice).unwrap_or(&[]))
                .copied()
                .filter(|&t| here.contains(&t) && self.is_task(t))
                .collect();
            ids.extend(inside.into_iter().filter(|n| {
                let k = self.kind(*n);
                (k.is_some_and(NodeKind::is_task) || k == Some(NodeKind::Network))
                    && !wired.contains(n)
            }));
            looped = wired;
        }
        ids.sort();
        ids.dedup();
        let mut out: Vec<TaskRow> = ids
            .into_iter()
            .filter_map(|n| self.task_row(n, children, wires, seen, depth))
            .collect();
        // Subtasks no row above reached are wired in a cycle with no root
        // here: each cycle shows from its first task, in creation order.
        out.extend(
            looped
                .into_iter()
                .filter_map(|n| self.task_row(n, children, wires, seen, depth)),
        );
        out
    }

    /// A row of the preview with the rows under it; none for a node shown
    /// already, a node on pause — the roll-up skips it (05 §7) — or a folder
    /// with no tasks.
    fn task_row(
        &self,
        n: NodeId,
        children: &HashMap<NodeId, Vec<NodeId>>,
        wires: &HashMap<NodeId, Vec<NodeId>>,
        seen: &mut BTreeSet<NodeId>,
        depth: u32,
    ) -> Option<TaskRow> {
        if self.flagged(n, Flag::Pause) || !seen.insert(n) {
            return None;
        }
        let rows = self.task_rows(n, children, wires, seen, depth + 1);
        let kind = self.kind(n).unwrap_or(NodeKind::Task);
        // A folder shows only when it holds tasks.
        if kind == NodeKind::Network && rows.is_empty() {
            return None;
        }
        Some(TaskRow {
            id: n.to_text(),
            kind,
            name: self.name(n),
            status: self.text_field(n, "status"),
            deadline: self.text_field(n, "deadline"),
            rows,
        })
    }

    fn linked(&self, n: NodeId) -> Linked {
        let kind = self.kind(n).unwrap_or(NodeKind::Note);
        let look = if kind == NodeKind::Asset {
            self.attrs(n)
        } else {
            Attrs::default()
        };
        Linked {
            id: n.to_text(),
            kind,
            name: self.name(n),
            status: self.text_field(n, "status"),
            asset: look.asset,
            mime: look.mime,
            url: look.url,
            icon: look.icon,
        }
    }

    /// Everything the properties panel shows about a node.
    pub fn node_details(&self, id: &str) -> Result<NodeDetails> {
        let n = self.live(id)?;
        let mut inputs = Vec::new();
        let mut outputs = Vec::new();
        for shard in self.index_shards() {
            let LoroValue::Map(all) = shard.get_map("edge").get_value() else {
                continue;
            };
            for v in all.values() {
                let Some(v) = Val::from_loro(v) else { continue };
                let ends = (
                    v.get("from")
                        .and_then(Val::as_str)
                        .and_then(|s| NodeId::parse(s).ok()),
                    v.get("to")
                        .and_then(Val::as_str)
                        .and_then(|s| NodeId::parse(s).ok()),
                );
                let (Some(from), Some(to)) = ends else {
                    continue;
                };
                if to == n && self.alive(from) {
                    inputs.push(self.linked(from));
                }
                if from == n && self.alive(to) {
                    outputs.push(self.linked(to));
                }
            }
        }
        let kind = self.kind(n).unwrap_or(NodeKind::Note);
        let all = self.children();
        let wires = self.wires_out();
        let mut children: Vec<Linked> = all
            .get(&n)
            .map(Vec::as_slice)
            .unwrap_or(&[])
            .iter()
            .filter(|c| self.alive(**c))
            .map(|c| self.linked(*c))
            .collect();
        for list in [&mut inputs, &mut outputs, &mut children] {
            list.sort_by(|a, b| a.name.cmp(&b.name).then(a.id.cmp(&b.id)));
        }
        let subtasks = if kind.is_task() {
            self.task_rows(n, &all, &wires, &mut BTreeSet::from([n]), 0)
        } else {
            Vec::new()
        };
        Ok(NodeDetails {
            id: id.to_owned(),
            kind,
            name: self.name(n),
            attrs: self.attrs(n),
            parent: self.primary_of(n).map(|p| p.to_text()),
            inputs,
            outputs,
            children,
            subtasks,
            fold: self.fold_of(n, kind, &all, &wires),
            places: self.places(n),
        })
    }

    /// Where node `n` is placed (05 §5, 06 §12.2): the primary first, then
    /// the others from the oldest, each with its path from the root.
    fn places(&self, n: NodeId) -> Vec<Place> {
        let primary = self.primary_of(n);
        let mut out: Vec<Place> = self
            .placements_of(n)
            .into_iter()
            .map(|(net, _)| {
                let mut path: Vec<(String, String)> = self
                    .ancestors(net)
                    .into_iter()
                    .rev()
                    .map(|a| (a.to_text(), self.name(a)))
                    .collect();
                path.push((net.to_text(), self.name(net)));
                Place {
                    net: net.to_text(),
                    path,
                    primary: Some(net) == primary,
                }
            })
            .collect();
        // Stable: the rest keep the oldest first.
        out.sort_by_key(|p| !p.primary);
        out
    }

    /// A picture or a file into the workspace's assets (10 §11); its
    /// SHA-256 is its id and the value of a media node's `asset`.
    pub fn put_asset(&mut self, bytes: &[u8]) -> Result<String> {
        use sha2::Digest;
        let sha: String = sha2::Sha256::digest(bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        self.store.put_asset(&sha, bytes)?;
        Ok(sha)
    }

    pub fn asset(&self, sha: &str) -> Result<Option<Vec<u8>>> {
        Ok(self.store.asset(sha)?)
    }

    /// A copy of a node where a template is chosen (05 §7, `E`): a new node
    /// of its kind at (x, y) in `net`, with its name, fields, people and
    /// flags — the copy is no template — and its content document; a folder
    /// or a project copies everything inside it, deep, with the positions,
    /// the hand-drawn wires between the copies and the networks' wire style
    /// (05 §5 «Копировать»). `inputs` wire into the copy, as into a node made
    /// at the end of a wire being drawn (06 §5.1). One step of undo; the
    /// copied notes' text wires follow as the system's (05 §8.2 rule 4). The
    /// new node's id back.
    pub fn copy_node(
        &mut self,
        from: &str,
        net: &str,
        (x, y): (f64, f64),
        inputs: &[String],
        label: Label,
    ) -> Result<String> {
        let source = self.live(from)?;
        let target = self.network(net)?;
        let children = self.children();
        // Source, copy, the copy's network and position; parents before children.
        let top = NodeId::new();
        let mut copies: Vec<(NodeId, NodeId, String, f64, f64)> =
            vec![(source, top, net.to_owned(), x, y)];
        // Appearances inside stay appearances of the same nodes (05 §5): (node, copy's network, x, y).
        let mut appear: Vec<(NodeId, NodeId, f64, f64)> = Vec::new();
        let mut stack = vec![(source, top)];
        while let Some((s, d)) = stack.pop() {
            if !self.kind(s).is_some_and(NodeKind::has_canvas) {
                continue;
            }
            let doc = format!("net/{}", s.to_text());
            self.ensure_doc(&doc)?;
            for &child in children.get(&s).map(Vec::as_slice).unwrap_or(&[]) {
                if !self.alive(child) {
                    continue;
                }
                let (px, py) = match read(&self.docs[&doc], "pos", &child.to_text()) {
                    Some(Val::List(p)) => (
                        p.first().and_then(Val::as_f64).unwrap_or(0.0),
                        p.get(1).and_then(Val::as_f64).unwrap_or(0.0),
                    ),
                    _ => (0.0, 0.0),
                };
                // What lives here is copied; an appearance of a node elsewhere
                // appears in the copy too, unless it would lie in itself (05 §5).
                if self.primary_of(child) != Some(s) {
                    let network = self.kind(child).is_some_and(NodeKind::has_canvas);
                    let looped = network && (child == target || self.inside(target, child));
                    if !looped {
                        appear.push((child, d, px, py));
                    }
                    continue;
                }
                let copy = NodeId::new();
                copies.push((child, copy, d.to_text(), px, py));
                stack.push((child, copy));
            }
        }
        let made: HashMap<NodeId, NodeId> = copies.iter().map(|c| (c.0, c.1)).collect();
        let mut ops = Vec::new();
        for (s, d, parent, px, py) in &copies {
            let id = d.to_text();
            let kind = self.kind(*s).unwrap_or(NodeKind::Note);
            ops.push(Op::CreateNode {
                id: Some(id.clone()),
                kind,
                name: self.name(*s),
                net: parent.clone(),
                x: *px,
                y: *py,
            });
            let a = self.attrs(*s);
            let text = |key: &str, v: Option<String>| {
                v.map(|v| Op::SetAttr {
                    id: id.clone(),
                    key: key.to_owned(),
                    value: Some(Val::str(v)),
                })
            };
            ops.extend(
                [
                    text("status", a.status),
                    text("start", a.start),
                    text("deadline", a.deadline),
                    text("priority", a.priority),
                    text("asset", a.asset),
                    text("mime", a.mime),
                    text("url", a.url),
                    text("icon", a.icon),
                    text("preview", a.preview),
                ]
                .into_iter()
                .flatten(),
            );
            if let Some(color) = a.color {
                ops.push(Op::SetAttr {
                    id: id.clone(),
                    key: "color".to_owned(),
                    value: Some(Val::Int(color)),
                });
            }
            for person in a.assignees {
                ops.push(Op::Assign {
                    id: id.clone(),
                    person,
                    on: true,
                });
            }
            // The copy of a template is no template; a template inside stays one.
            for flag in a
                .flags
                .into_iter()
                .filter(|f| !(*s == source && *f == Flag::Template))
            {
                ops.push(Op::SetFlag {
                    id: id.clone(),
                    flag,
                    on: true,
                });
            }
            if kind.has_canvas() {
                let style = read(
                    &self.docs[&format!("net/{}", s.to_text())],
                    "settings",
                    "wireStyle",
                )
                .and_then(|v| v.as_str().and_then(WireStyle::parse));
                if style.is_some() {
                    ops.push(Op::SetWireStyle { net: id, style });
                }
            }
        }
        for &(node, copy, px, py) in &appear {
            ops.push(Op::Place {
                id: node.to_text(),
                net: copy.to_text(),
                x: px,
                y: py,
            });
        }
        // An appearance is the same node in the copy: its wires to the copies come too.
        let mut ends = made.clone();
        for &(node, ..) in &appear {
            ends.insert(node, node);
        }
        // Wires drawn by hand between the copies; text wires come from the text.
        for shard in self.index_shards() {
            let LoroValue::Map(all) = shard.get_map("edge").get_value() else {
                continue;
            };
            for (key, v) in all.iter() {
                let Some(v) = Val::from_loro(v) else { continue };
                let end = |k: &str| {
                    v.get(k)
                        .and_then(Val::as_str)
                        .and_then(|s| NodeId::parse(s).ok())
                };
                let (Some(a), Some(b)) = (end("from"), end("to")) else {
                    continue;
                };
                let manual = ["manual", "import"]
                    .iter()
                    .any(|o| read(shard, "edgeOrigin", &format!("{key}|{o}")).is_some());
                let copied = made.contains_key(&a) || made.contains_key(&b);
                if let (true, true, Some(ca), Some(cb)) =
                    (manual, copied, ends.get(&a), ends.get(&b))
                {
                    ops.push(Op::Connect {
                        from: ca.to_text(),
                        to: cb.to_text(),
                    });
                }
            }
        }
        for input in inputs {
            ops.push(Op::Connect {
                from: input.clone(),
                to: top.to_text(),
            });
        }
        self.apply(&ops, label)?;
        // Content documents as the editors' pushes are: outside the step.
        let mut notes = BTreeSet::new();
        for (s, d, ..) in &copies {
            let Some(doc) = load(&self.store, &format!("content/{}", s.to_text()))? else {
                continue;
            };
            let bytes = doc.export(ExportMode::Snapshot).map_err(engine)?;
            let name = format!("content/{}", d.to_text());
            self.store.append(&name, &bytes, now_ms())?;
            self.docs.insert(name, doc);
            notes.insert(*d);
        }
        self.relink(&notes)?;
        Ok(top.to_text())
    }

    /// The link asset's URL, for its preview to be fetched (✅ Q-13-16).
    pub fn link_of(&self, id: &str) -> Result<Option<String>> {
        let n = self.live(id)?;
        if self.kind(n) != Some(NodeKind::Asset) {
            return Ok(None);
        }
        Ok(self.attrs(n).url)
    }

    /// A link's preview (05 §4.4, ✅ Q-13-16), fetched for `url`: the picture
    /// becomes an asset by its hash (10 §11) and the node's `preview`; the
    /// page's title becomes the node's name while the name is still the one
    /// it got with the link — its host, the link itself, or nothing. Derived
    /// from the link, so a step of the system, not of the user's undo (05
    /// §11). False when nothing changed, the node's link is another by now,
    /// or the node is locked (05 §7).
    pub fn apply_preview(
        &mut self,
        id: &str,
        url: &str,
        title: Option<&str>,
        picture: Option<&[u8]>,
    ) -> Result<bool> {
        let n = self.live(id)?;
        if self.kind(n) != Some(NodeKind::Asset)
            || self.attrs(n).url.as_deref() != Some(url)
            || self.flagged(n, Flag::Lock)
        {
            return Ok(false);
        }
        let mut ops = Vec::new();
        if let Some(bytes) = picture.filter(|b| !b.is_empty()) {
            let sha = self.put_asset(bytes)?;
            if self.attrs(n).preview.as_deref() != Some(sha.as_str()) {
                ops.push(Op::SetAttr {
                    id: id.to_owned(),
                    key: "preview".to_owned(),
                    value: Some(Val::str(sha)),
                });
            }
        }
        let title = title
            .map(|t| t.split_whitespace().collect::<Vec<_>>().join(" "))
            .map(|t| t.chars().take(200).collect::<String>())
            .filter(|t| !t.is_empty());
        let name = self.name(n);
        if let Some(title) = title.filter(|t| *t != name && auto_name(&name, url)) {
            ops.push(Op::Rename {
                id: id.to_owned(),
                name: title,
            });
        }
        if ops.is_empty() {
            return Ok(false);
        }
        let label = Label::new("core.change.preview");
        let step = self.commit_ops_as(ChangesetOrigin::System, &ops, label)?;
        // The page's title may be the name a ghost waits for (05 §8.5).
        self.links_after(&step, true)?;
        Ok(!step.writes.is_empty())
    }

    /// Every live node of the workspace under its primary network, for the
    /// «Слои» panel (owner, 2026-10-24: like Figma's layers); the root has
    /// no parent.
    /// Every wire whose ends are both alive (a wire of a node in the trash
    /// stays hidden, 05 §11): the star map draws the whole space (08 §10).
    pub fn wires(&self) -> Vec<WireEnds> {
        let mut out: Vec<WireEnds> = self
            .wires_out()
            .into_iter()
            .filter(|(from, _)| self.alive(*from))
            .flat_map(|(from, to)| {
                to.into_iter()
                    .filter(|t| self.alive(*t))
                    .map(move |t| WireEnds {
                        from: from.to_text(),
                        to: t.to_text(),
                    })
            })
            .collect();
        out.sort_by(|a, b| a.from.cmp(&b.from).then(a.to.cmp(&b.to)));
        out
    }

    pub fn tree(&self) -> Vec<TreeItem> {
        let mut out = Vec::new();
        for shard in self.index_shards() {
            let LoroValue::Map(kinds) = shard.get_map("kind").get_value() else {
                continue;
            };
            for id in kinds.keys() {
                let Ok(n) = NodeId::parse(id) else { continue };
                if !self.alive(n) {
                    continue;
                }
                // A node with no placement left in a live network lies nowhere (05 §5).
                let parent = self.primary_of(n).map(|p| p.to_text());
                if parent.is_none() && n != self.root {
                    continue;
                }
                let kind = self.kind(n).unwrap_or(NodeKind::Note);
                let look = if kind == NodeKind::Asset {
                    self.attrs(n)
                } else {
                    Attrs::default()
                };
                out.push(TreeItem {
                    id: id.clone(),
                    name: self.name(n),
                    kind,
                    status: self.text_field(n, "status"),
                    deadline: self.text_field(n, "deadline"),
                    parent,
                    asset: look.asset,
                    mime: look.mime,
                    url: look.url,
                    icon: look.icon,
                    flags: self.flags(n),
                });
            }
        }
        out.sort_by(|a, b| a.name.cmp(&b.name).then(a.id.cmp(&b.id)));
        out
    }

    /// The people of the workspace (05 §10), by name.
    pub fn people(&self) -> Vec<Person> {
        let LoroValue::Map(m) = self.docs["manifest"].get_map("people").get_value() else {
            return Vec::new();
        };
        let mut out: Vec<Person> = m
            .iter()
            .filter_map(|(id, v)| {
                let v = Val::from_loro(v)?;
                Some(Person {
                    id: id.clone(),
                    name: v.get("name")?.as_str()?.to_owned(),
                    color: v.get("color").and_then(Val::as_i64).unwrap_or(0),
                })
            })
            .collect();
        out.sort_by(|a, b| a.name.cmp(&b.name).then(a.id.cmp(&b.id)));
        out
    }

    /// The network as the canvas draws it (10 §7.3).
    pub fn network_view(&mut self, net: &str) -> Result<NetworkView> {
        let n = self.network(net)?;
        let doc = format!("net/{net}");
        self.ensure_doc(&doc)?;
        let prefix = format!("{net}/");
        let mut ids = BTreeSet::new();
        for shard in self.index_shards() {
            if let LoroValue::Map(m) = shard.get_map("placement").get_value() {
                for key in m.keys() {
                    if let Some(node) = key.strip_prefix(&prefix) {
                        ids.insert(node.to_owned());
                    }
                }
            }
        }
        // Lists show their ticks (05 §6.4): their documents stay in memory.
        for id in &ids {
            if let Ok(node) = NodeId::parse(id) {
                if self.alive(node) && self.kind(node) == Some(NodeKind::Checklist) {
                    self.ensure_doc(&format!("content/{id}"))?;
                }
            }
        }
        let children = self.children();
        let wires = self.wires_out();
        let pos = &self.docs[&doc];
        let mut nodes = Vec::new();
        for id in &ids {
            let Ok(node) = NodeId::parse(id) else {
                continue;
            };
            if !self.alive(node) {
                continue;
            }
            let (x, y) = match read(pos, "pos", id) {
                Some(Val::List(p)) => (
                    p.first().and_then(Val::as_f64).unwrap_or(0.0),
                    p.get(1).and_then(Val::as_f64).unwrap_or(0.0),
                ),
                _ => (0.0, 0.0),
            };
            let kind = self.kind(node).unwrap_or(NodeKind::Note);
            nodes.push(ViewNode {
                id: id.clone(),
                kind,
                name: self.name(node),
                x,
                y,
                attrs: self.attrs(node),
                fold: self.fold_of(node, kind, &children, &wires),
                external: 0,
                appearance: false,
                places: 0,
            });
        }
        let (external, rollups) = self.beyond(&nodes, &wires);
        let index = self.placements_index();
        for v in &mut nodes {
            v.external = external.get(v.id.as_str()).copied().unwrap_or(0);
            // An appearance and «×N» (05 §5, 06 §12.2).
            if let Ok(node) = NodeId::parse(&v.id) {
                let places = index.get(&node).map_or(0, Vec::len);
                v.places = u32::try_from(places).unwrap_or(u32::MAX);
                v.appearance = node != self.root && self.primary_of(node) != Some(n);
            }
        }
        let shown: BTreeSet<&str> = nodes.iter().map(|v| v.id.as_str()).collect();
        let mut edges = Vec::new();
        let mut ghosts = Vec::new();
        for shard in self.index_shards() {
            let LoroValue::Map(all) = shard.get_map("edge").get_value() else {
                continue;
            };
            let origins: BTreeMap<String, ()> = match shard.get_map("edgeOrigin").get_value() {
                LoroValue::Map(o) => o.keys().map(|k| (k.clone(), ())).collect(),
                _ => BTreeMap::new(),
            };
            for (key, v) in all.iter() {
                let Some(v) = Val::from_loro(v) else { continue };
                let Some(from) = v.get("from").and_then(Val::as_str) else {
                    continue;
                };
                if let Some(name) = v.get("ghost").and_then(Val::as_str) {
                    if shown.contains(from) {
                        ghosts.push(ViewGhost {
                            edge: key.clone(),
                            from: from.to_owned(),
                            name: name.to_owned(),
                        });
                    }
                    continue;
                }
                let Some(to) = v.get("to").and_then(Val::as_str) else {
                    continue;
                };
                if !shown.contains(from) || !shown.contains(to) {
                    continue;
                }
                let has = |o: &str| origins.contains_key(&format!("{key}|{o}"));
                edges.push(ViewEdge {
                    from: from.to_owned(),
                    to: to.to_owned(),
                    text: has("text"),
                    manual: has("manual") || has("import"),
                });
            }
        }
        edges.sort_by(|a, b| (&a.from, &a.to).cmp(&(&b.from, &b.to)));
        ghosts.sort_by(|a, b| (&a.from, &a.name, &a.edge).cmp(&(&b.from, &b.name, &b.edge)));
        let mut path: Vec<(String, String)> = self
            .ancestors(n)
            .into_iter()
            .rev()
            .map(|a| (a.to_text(), self.name(a)))
            .collect();
        path.push((net.to_owned(), self.name(n)));
        let wire_style =
            read(pos, "settings", "wireStyle").and_then(|v| v.as_str().and_then(WireStyle::parse));
        Ok(NetworkView {
            net: net.to_owned(),
            name: self.name(n),
            path,
            nodes,
            edges,
            ghosts,
            rollups,
            wire_style,
        })
    }

    /// The wires of node `id` in network `net` whose other end is not placed
    /// there (05 §8.3, 06 §14): inputs first, then outputs, each by name.
    /// Ends in the trash count for nothing, as in «↗N».
    pub fn external_wires(&mut self, net: &str, id: &str) -> Result<Vec<ExternalWire>> {
        let view = self.network_view(net)?;
        let node = self.live(id)?;
        let placed: HashSet<&str> = view.nodes.iter().map(|v| v.id.as_str()).collect();
        if !placed.contains(id) {
            return Err(invalid(format!("{id} is not placed in {net}")));
        }
        let mut out = Vec::new();
        for shard in self.index_shards() {
            let LoroValue::Map(all) = shard.get_map("edge").get_value() else {
                continue;
            };
            for (key, v) in all.iter() {
                let Some(v) = Val::from_loro(v) else { continue };
                let end = |k: &str| {
                    v.get(k)
                        .and_then(Val::as_str)
                        .and_then(|s| NodeId::parse(s).ok())
                };
                let (Some(from), Some(to)) = (end("from"), end("to")) else {
                    continue;
                };
                let (other, incoming) = match (from == node, to == node) {
                    (true, false) => (to, false),
                    (false, true) => (from, true),
                    _ => continue,
                };
                let other_id = other.to_text();
                if placed.contains(other_id.as_str()) || !self.alive(other) {
                    continue;
                }
                let has = |o: &str| read(shard, "edgeOrigin", &format!("{key}|{o}")).is_some();
                out.push(ExternalWire {
                    name: self.name(other),
                    kind: self.kind(other).unwrap_or(NodeKind::Note),
                    incoming,
                    text: has("text"),
                    manual: has("manual") || has("import"),
                    path: self
                        .ancestors(other)
                        .into_iter()
                        .rev()
                        .map(|a| (a.to_text(), self.name(a)))
                        .collect(),
                    id: other_id,
                });
            }
        }
        out.sort_by(|a, b| (!a.incoming, &a.name, &a.id).cmp(&(!b.incoming, &b.name, &b.id)));
        Ok(out)
    }

    /// The wires of a network's nodes that leave it (05 §8.3): their count
    /// per node, «↗N», and the roll-up wires — a wire whose other end lies
    /// inside a network placed here is drawn to that network's bubble, the
    /// wires between the same two bubbles counted together whichever way
    /// they go (06 §13.3). Ends in the trash count for nothing.
    fn beyond(
        &self,
        nodes: &[ViewNode],
        wires: &HashMap<NodeId, Vec<NodeId>>,
    ) -> (HashMap<String, u32>, Vec<ViewRollup>) {
        let placed: HashSet<NodeId> = nodes
            .iter()
            .filter_map(|v| NodeId::parse(&v.id).ok())
            .collect();
        let mut inside: HashMap<NodeId, Option<NodeId>> = HashMap::new();
        let mut bubble = |n: NodeId| -> Option<NodeId> {
            if placed.contains(&n) {
                return Some(n);
            }
            *inside
                .entry(n)
                .or_insert_with(|| self.ancestors(n).into_iter().find(|a| placed.contains(a)))
        };
        let mut external: HashMap<String, u32> = HashMap::new();
        let mut rolled: BTreeMap<(NodeId, NodeId), u32> = BTreeMap::new();
        for (&a, tos) in wires {
            if !self.alive(a) {
                continue;
            }
            for &b in tos {
                let (here_a, here_b) = (placed.contains(&a), placed.contains(&b));
                if (here_a && here_b) || !self.alive(b) {
                    continue;
                }
                for (n, here) in [(a, here_a), (b, here_b)] {
                    if here {
                        *external.entry(n.to_text()).or_default() += 1;
                    }
                }
                if let (Some(x), Some(y)) = (bubble(a), bubble(b)) {
                    if x != y {
                        *rolled.entry((x.min(y), x.max(y))).or_default() += 1;
                    }
                }
            }
        }
        let rollups = rolled
            .into_iter()
            .map(|((a, b), count)| ViewRollup {
                a: a.to_text(),
                b: b.to_text(),
                count,
            })
            .collect();
        (external, rollups)
    }

    /// Nodes in the trash, newest first: what went inside a network in the
    /// same step is no item of its own, it comes back with the network (05 §5).
    pub fn trash(&self) -> Vec<TrashItem> {
        let batch_of = |n: NodeId| {
            self.field(n, "trashBatch")
                .and_then(|v| v.as_str().map(str::to_owned))
                .unwrap_or_default()
        };
        let mut out = Vec::new();
        for shard in self.index_shards() {
            let LoroValue::Map(m) = shard.get_map("trashedAt").get_value() else {
                continue;
            };
            for (id, at) in m.iter() {
                let Ok(n) = NodeId::parse(id) else { continue };
                let batch = batch_of(n);
                let home = self
                    .field(n, "primaryNet")
                    .and_then(|v| v.as_str().and_then(|s| NodeId::parse(s).ok()));
                let inside = home.is_some_and(|h| {
                    self.field(h, "trashedAt").is_some()
                        && !batch.is_empty()
                        && batch_of(h) == batch
                });
                if inside {
                    continue;
                }
                out.push(TrashItem {
                    id: id.clone(),
                    kind: self.kind(n).unwrap_or(NodeKind::Note),
                    name: self.name(n),
                    trashed_at: Val::from_loro(at).and_then(|v| v.as_i64()).unwrap_or(0),
                    batch,
                });
            }
        }
        out.sort_by(|a, b| b.trashed_at.cmp(&a.trashed_at).then(a.id.cmp(&b.id)));
        out
    }
}

fn load<S: Store>(store: &S, doc: &str) -> Result<Option<LoroDoc>> {
    let Some(StoredDoc { snapshot, updates }) = store.load(doc)? else {
        return Ok(None);
    };
    let d = LoroDoc::new();
    if let Some(s) = snapshot {
        d.import(&s).map_err(engine)?;
    }
    if !updates.is_empty() {
        d.import_batch(&updates).map_err(engine)?;
    }
    Ok(Some(d))
}
