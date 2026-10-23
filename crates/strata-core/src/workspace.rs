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
use crate::ops::Op;
use crate::store::{Store, StoreError, StoredDoc};
use crate::value::Val;
use loro::{ExportMode, LoroDoc, LoroValue, ValueOrContainer, VersionVector};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use strata_model::{
    ChangesetId, ChangesetOrigin, EdgeKey, NodeId, NodeKind, PlacementKey, now_ms, shard_of,
};

/// Version of the documents' layout (10 §13).
pub const SCHEMA: i64 = 1;

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
    /// The note that describes it (a task's «Описание», 05 §4.3).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// A media node's picture: the asset's SHA-256 (10 §11).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset: Option<String>,
}

/// A network's roll-up (05 §6.4, ☑ Q-05-2): over its whole depth, each node
/// once — finished of all with a status, and the nearest open deadline.
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
    /// The class it was made from (05 §4.3), if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub class: Option<String>,
    pub name: String,
    pub x: f64,
    pub y: f64,
    #[serde(flatten)]
    pub attrs: Attrs,
    /// For networks: the roll-up of what is inside.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fold: Option<Fold>,
}

/// A node at the other end of a wire, for the properties panel.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Linked {
    pub id: String,
    pub kind: NodeKind,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
}

/// One node with everything the properties panel shows (06, «P»).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct NodeDetails {
    pub id: String,
    pub kind: NodeKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub class: Option<String>,
    pub name: String,
    #[serde(flatten)]
    pub attrs: Attrs,
    /// The network of its primary placement (05 §5).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    /// Wires in: what it depends on (05 §8).
    pub inputs: Vec<Linked>,
    /// Wires out: what depends on it.
    pub outputs: Vec<Linked>,
    /// For networks: the nodes inside (a task's subtasks among them, 05 §4.3).
    pub children: Vec<Linked>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fold: Option<Fold>,
}

/// A network in the «Структура» tree.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TreeItem {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub class: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
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

    fn network(&self, id: &str) -> Result<NodeId> {
        let n = self.parse(id)?;
        if self.kind(n) != Some(NodeKind::Network) || !self.alive(n) {
            return Err(invalid(format!("{id} is not a live network")));
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
        while let Some(parent) = self
            .field(at, "primaryNet")
            .and_then(|v| v.as_str().and_then(|s| NodeId::parse(s).ok()))
        {
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
        Ok(changeset)
    }

    /// Reverts the last step and forgets it: a gesture cancelled with Esc.
    pub fn cancel(&mut self) -> Result<Option<RevertReport>> {
        let Some(cs) = self.undo.pop() else {
            return Ok(None);
        };
        self.revert(&cs).map(|(_, report)| Some(report))
    }

    /// Checks and writes the operations as one changeset, outside undo.
    fn commit_ops(&mut self, ops: &[Op], label: Label) -> Result<Changeset> {
        // Documents of the networks the operations touch, before the transaction.
        for op in ops {
            match op {
                Op::CreateNode { net, .. } | Op::Move { net, .. } => {
                    self.ensure_doc(&format!("net/{net}"))?;
                }
                _ => {}
            }
        }
        let plan = self.plan(ops)?;
        self.write(ChangesetOrigin::User, label, |tx| {
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
        let exists =
            |n: NodeId, made: &HashMap<NodeId, NodeKind>| made.contains_key(&n) || self.alive(n);
        for op in ops {
            match op {
                Op::CreateNode {
                    id,
                    kind,
                    class,
                    name,
                    net,
                    x,
                    y,
                } => {
                    // A network made earlier in this list takes nodes too: a
                    // task and its «Описание» are one step (05 §4.3).
                    let parent = match self.parse(net) {
                        Ok(p) if made.get(&p) == Some(&NodeKind::Network) => p,
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
                    if let Some(class) = class {
                        put(&index, "class", &key, Some(Val::str(class.clone())));
                    }
                    put(&index, "createdAt", &key, Some(Val::Int(ts)));
                    put(&index, "primaryNet", &key, Some(Val::str(net.clone())));
                    put(
                        &index,
                        "placement",
                        &PlacementKey::new(parent, node).to_text(),
                        Some(Val::map([("at", Val::Int(ts))])),
                    );
                    put(
                        &format!("net/{net}"),
                        "pos",
                        &key,
                        Some(Val::List(vec![Val::Float(*x), Val::Float(*y)])),
                    );
                }
                Op::Rename { id, name } => {
                    let n = self.parse(id)?;
                    if !exists(n, &made) {
                        return Err(invalid(format!(
                            "node {id} does not exist or is in the trash"
                        )));
                    }
                    put(
                        &self.index_doc(n),
                        "name",
                        &n.to_text(),
                        Some(Val::str(name.trim())),
                    );
                }
                Op::Move { net, id, x, y } => {
                    let parent = match self.parse(net) {
                        Ok(p) if made.get(&p) == Some(&NodeKind::Network) => p,
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
                    for id in ids {
                        let n = self.live(id)?;
                        if n == self.root {
                            return Err(invalid("the root network cannot go to the trash"));
                        }
                        let index = self.index_doc(n);
                        let key = n.to_text();
                        put(&index, "trashedAt", &key, Some(Val::Int(ts)));
                        put(&index, "trashBatch", &key, Some(Val::str(batch.clone())));
                    }
                }
                Op::Restore { ids } => {
                    for id in ids {
                        let n = self.parse(id)?;
                        if self.field(n, "trashedAt").is_none() {
                            return Err(invalid(format!("node {id} is not in the trash")));
                        }
                        let index = self.index_doc(n);
                        let key = n.to_text();
                        put(&index, "trashedAt", &key, None);
                        put(&index, "trashBatch", &key, None);
                    }
                }
                Op::SetAttr { id, key, value } => {
                    let n = self.parse(id)?;
                    if !exists(n, &made) {
                        return Err(invalid(format!(
                            "node {id} does not exist or is in the trash"
                        )));
                    }
                    let bad = || invalid(format!("attribute {key}: not a value it takes"));
                    let ok = match (key.as_str(), value) {
                        (_, None) => true,
                        ("status", Some(Val::Str(v))) => STATUSES.contains(&v.as_str()),
                        ("priority", Some(Val::Str(v))) => PRIORITIES.contains(&v.as_str()),
                        ("start" | "deadline", Some(Val::Str(v))) => is_date(v),
                        ("color", Some(Val::Int(v))) => (0..COLORS).contains(v),
                        ("description", Some(Val::Str(v))) => self.parse(v).ok().is_some_and(|d| {
                            made.get(&d) == Some(&NodeKind::Note)
                                || (self.alive(d) && self.kind(d) == Some(NodeKind::Note))
                        }),
                        ("asset", Some(Val::Str(v))) => {
                            v.len() == 64 && v.bytes().all(|c| c.is_ascii_hexdigit())
                        }
                        _ => false,
                    };
                    if !ok {
                        return Err(bad());
                    }
                    let index = self.index_doc(n);
                    match key.as_str() {
                        "status" | "priority" | "start" | "deadline" | "color" => {
                            put(&index, key, &n.to_text(), value.clone());
                        }
                        "description" | "asset" => {
                            put(
                                &index,
                                "attr",
                                &format!("{}|{key}", n.to_text()),
                                value.clone(),
                            );
                        }
                        _ => return Err(bad()),
                    }
                }
                Op::Assign { id, person, on } => {
                    let n = self.parse(id)?;
                    if !exists(n, &made) {
                        return Err(invalid(format!(
                            "node {id} does not exist or is in the trash"
                        )));
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
                    let c = color.unwrap_or(0).rem_euclid(COLORS);
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
        self.redo.push(back);
        Ok(Some(report))
    }

    /// Redoes the last undone step.
    pub fn redo(&mut self) -> Result<Option<RevertReport>> {
        let Some(cs) = self.redo.pop() else {
            return Ok(None);
        };
        let (again, report) = self.revert(&cs)?;
        self.undo.push(again);
        Ok(Some(report))
    }

    pub fn history(&self) -> History {
        History {
            undo: self.undo.last().map(|c| c.label.clone()),
            redo: self.redo.last().map(|c| c.label.clone()),
        }
    }

    /// The node of a content document `content/<id>` (10 §2.4): live and of a
    /// kind that has content.
    fn content_node(&self, doc: &str) -> Result<NodeId> {
        let id = doc
            .strip_prefix("content/")
            .ok_or_else(|| invalid(format!("{doc} is not a content document")))?;
        let n = self.live(id)?;
        if self.kind(n) == Some(NodeKind::Network) {
            return Err(invalid("a network has no content document (10 §2.4)"));
        }
        Ok(n)
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
            return self.relink(node).map(|c| c.is_some());
        }
        Ok(false)
    }

    /// The note's text wires follow its `[[links]]` (05 §8.2 rule 4): a link
    /// to a live node by its name adds the origin `text`, a link gone takes
    /// it away, and a wire with no origin left goes. A system changeset,
    /// outside undo (05 §11). Links to no node become ghosts in 1C (05 §8.5).
    fn relink(&mut self, note: NodeId) -> Result<Option<Changeset>> {
        let doc = format!("content/{}", note.to_text());
        let text = self.docs[&doc].get_text("text").to_string();
        let mut by_name: HashMap<String, NodeId> = HashMap::new();
        for shard in self.index_shards() {
            let LoroValue::Map(names) = shard.get_map("name").get_value() else {
                continue;
            };
            for (id, name) in names.iter() {
                let (Ok(n), Some(name)) = (NodeId::parse(id), name.as_string()) else {
                    continue;
                };
                // One name, several nodes: the oldest wins (UUIDv7 sorts by time).
                let slot = by_name.entry(name.trim().to_lowercase()).or_insert(n);
                if n < *slot {
                    *slot = n;
                }
            }
        }
        let want: BTreeSet<NodeId> = strata_markdown::scan(&text)
            .links
            .iter()
            .filter_map(|l| by_name.get(&l.target.trim().to_lowercase()).copied())
            .filter(|&n| n != note && self.alive(n))
            .collect();
        let index = self.index_doc(note);
        let from = note.to_text();
        let mut have: BTreeMap<NodeId, String> = BTreeMap::new();
        if let LoroValue::Map(edges) = self.docs[&index].get_map("edge").get_value() {
            for (key, v) in edges.iter() {
                let Some(v) = Val::from_loro(v) else { continue };
                if v.get("from").and_then(Val::as_str) != Some(from.as_str())
                    || read(&self.docs[&index], "edgeOrigin", &format!("{key}|text")).is_none()
                {
                    continue;
                }
                if let Some(to) = v
                    .get("to")
                    .and_then(Val::as_str)
                    .and_then(|t| NodeId::parse(t).ok())
                {
                    have.insert(to, key.clone());
                }
            }
        }
        let ts = now_ms();
        let mut plan: Vec<(&str, String, Option<Val>)> = Vec::new();
        for &to in want.iter().filter(|t| !have.contains_key(t)) {
            let edge = EdgeKey::between(note, to).to_text();
            let ends = Val::map([
                ("from", Val::str(from.clone())),
                ("to", Val::str(to.to_text())),
            ]);
            plan.push((
                "edgeOrigin",
                format!("{edge}|text"),
                Some(Val::map([("at", Val::Int(ts))])),
            ));
            plan.push(("edge", edge, Some(ends)));
        }
        for edge in have
            .iter()
            .filter(|(t, _)| !want.contains(t))
            .map(|(_, e)| e)
        {
            plan.push(("edgeOrigin", format!("{edge}|text"), None));
            let other = ["manual", "import"]
                .iter()
                .any(|o| read(&self.docs[&index], "edgeOrigin", &format!("{edge}|{o}")).is_some());
            if !other {
                plan.push(("edge", edge.clone(), None));
            }
        }
        if plan.is_empty() {
            return Ok(None);
        }
        self.write(
            ChangesetOrigin::System,
            Label::new("core.change.links"),
            |tx| {
                for (map, key, value) in plan {
                    tx.set(&index, map, &key, value)?;
                }
                Ok(())
            },
        )
        .map(Some)
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
            description: attr("description")
                .filter(|d| NodeId::parse(d).is_ok_and(|n| self.alive(n))),
            asset: attr("asset"),
        }
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

    /// The roll-up of a network (05 §6.4): nodes with a status over the
    /// whole depth, each once; the nearest deadline of the open ones.
    fn fold(&self, net: NodeId, children: &HashMap<NodeId, Vec<NodeId>>) -> Fold {
        let mut seen = BTreeSet::from([net]);
        let mut stack = vec![net];
        let mut fold = Fold::default();
        while let Some(at) = stack.pop() {
            for &n in children.get(&at).map(Vec::as_slice).unwrap_or(&[]) {
                if !seen.insert(n) || !self.alive(n) {
                    continue;
                }
                if let Some(status) = self.text_field(n, "status") {
                    fold.total += 1;
                    if is_final(&status) {
                        fold.done += 1;
                    } else if let Some(d) = self.text_field(n, "deadline") {
                        if fold.nearest.as_ref().is_none_or(|x| d < *x) {
                            fold.nearest = Some(d);
                        }
                    }
                }
                if self.kind(n) == Some(NodeKind::Network) {
                    stack.push(n);
                }
            }
        }
        fold
    }

    fn linked(&self, n: NodeId) -> Linked {
        Linked {
            id: n.to_text(),
            kind: self.kind(n).unwrap_or(NodeKind::Note),
            name: self.name(n),
            status: self.text_field(n, "status"),
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
        Ok(NodeDetails {
            id: id.to_owned(),
            kind,
            class: self.text_field(n, "class"),
            name: self.name(n),
            attrs: self.attrs(n),
            parent: self.text_field(n, "primaryNet"),
            inputs,
            outputs,
            children,
            fold: (kind == NodeKind::Network).then(|| self.fold(n, &all)),
        })
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

    /// Every live network of the workspace with its parent, for the
    /// «Структура» tree; the root has none.
    pub fn tree(&self) -> Vec<TreeItem> {
        let mut out = Vec::new();
        for shard in self.index_shards() {
            let LoroValue::Map(kinds) = shard.get_map("kind").get_value() else {
                continue;
            };
            for (id, kind) in kinds.iter() {
                let Ok(n) = NodeId::parse(id) else { continue };
                if kind.as_string().map(|s| s.as_str()) != Some("network") || !self.alive(n) {
                    continue;
                }
                out.push(TreeItem {
                    id: id.clone(),
                    name: self.name(n),
                    class: self.text_field(n, "class"),
                    parent: if n == self.root {
                        None
                    } else {
                        self.text_field(n, "primaryNet")
                    },
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
        let children = self.children();
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
                class: self.text_field(node, "class"),
                name: self.name(node),
                x,
                y,
                attrs: self.attrs(node),
                fold: (kind == NodeKind::Network).then(|| self.fold(node, &children)),
            });
        }
        let shown: BTreeSet<&str> = nodes.iter().map(|v| v.id.as_str()).collect();
        let mut edges = Vec::new();
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
                let (Some(from), Some(to)) = (
                    v.get("from").and_then(Val::as_str),
                    v.get("to").and_then(Val::as_str),
                ) else {
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
        let mut path: Vec<(String, String)> = self
            .ancestors(n)
            .into_iter()
            .rev()
            .map(|a| (a.to_text(), self.name(a)))
            .collect();
        path.push((net.to_owned(), self.name(n)));
        Ok(NetworkView {
            net: net.to_owned(),
            name: self.name(n),
            path,
            nodes,
            edges,
        })
    }

    /// Nodes in the trash, newest first.
    pub fn trash(&self) -> Vec<TrashItem> {
        let mut out = Vec::new();
        for shard in self.index_shards() {
            let LoroValue::Map(m) = shard.get_map("trashedAt").get_value() else {
                continue;
            };
            for (id, at) in m.iter() {
                let Ok(n) = NodeId::parse(id) else { continue };
                out.push(TrashItem {
                    id: id.clone(),
                    kind: self.kind(n).unwrap_or(NodeKind::Note),
                    name: self.name(n),
                    trashed_at: Val::from_loro(at).and_then(|v| v.as_i64()).unwrap_or(0),
                    batch: self
                        .field(n, "trashBatch")
                        .and_then(|v| v.as_str().map(str::to_owned))
                        .unwrap_or_default(),
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
