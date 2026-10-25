//! A note's `[[links]]` as its wires (05 §8.2 rule 4) and ghosts (05 §8.5).
//! A link finds its node by the rule of 13 §3.5, the same for import and for
//! the workspace after it: a wire keeps its node while the node still answers
//! the link; a path names its node from the root, then from the note's
//! folder; a name shared by several nodes goes to the nearest by the tree,
//! then the shortest path, then the oldest. A link to no node is a wire to a
//! ghost: no `to`, the name `X` as `ghost`, the key `h(from ‖ "?" ‖
//! linkKey(X))` (10 §2.5). A ghost resolves as soon as a node answers it:
//! its wire goes and `from → X` comes with the same origins, in one system
//! changeset (05 §11). The networks keep no route or `hidden` per wire yet,
//! so there is nothing of them to carry to the new key.

use super::{Changeset, Store, Val, Workspace, read};
use crate::changeset::Label;
use crate::workspace::Result;
use loro::LoroValue;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use strata_markdown::link_key;
use strata_model::{ChangesetOrigin, EdgeKey, NodeId, NodeKind, now_ms};

/// Fields whose change can make a link find another node, or none (13 §3.5).
const NAMING: [&str; 4] = ["name", "kind", "trashedAt", "primaryNet"];
/// Origins of a wire (10 §2.3).
const ORIGINS: [&str; 3] = ["text", "manual", "import"];

/// What a link names.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Target {
    Node(NodeId),
    Ghost,
}

/// The wires and ghosts a note has, by the edges of its shard.
#[derive(Default)]
struct Outgoing {
    /// Wires with the origin `text`: target → wire key.
    wires: BTreeMap<NodeId, String>,
    /// Ghosts: link key → (wire key, the name as written).
    ghosts: BTreeMap<String, (String, String)>,
}

impl<S: Store> Workspace<S> {
    /// Live nodes by the link key of their name (13 §3.4).
    fn link_names(&self) -> HashMap<String, Vec<NodeId>> {
        let mut out: HashMap<String, Vec<NodeId>> = HashMap::new();
        for shard in self.index_shards() {
            let LoroValue::Map(names) = shard.get_map("name").get_value() else {
                continue;
            };
            for (id, name) in names.iter() {
                let (Ok(n), Some(name)) = (NodeId::parse(id), name.as_string()) else {
                    continue;
                };
                if self.alive(n) {
                    out.entry(link_key(name)).or_default().push(n);
                }
            }
        }
        out
    }

    /// Link keys of a node's canonical path, its own name last and the root
    /// left out (05 §9.3): `/Проекты/Игра` is `["проекты", "игра"]`.
    fn path_keys(&self, n: NodeId) -> Vec<String> {
        let mut out: Vec<String> = self
            .ancestors(n)
            .into_iter()
            .rev()
            .filter(|a| *a != self.root)
            .map(|a| link_key(&self.name(a)))
            .collect();
        out.push(link_key(&self.name(n)));
        out
    }

    /// The node a link of `src` names, by 13 §3.5. `segs` are the parts of
    /// the link's key between `/`; `held` are the nodes `src` has text wires
    /// to, in the trash too (05 §14 rule 6: such a wire stays, hidden).
    fn resolve(
        &self,
        src: NodeId,
        segs: &[String],
        held: &BTreeSet<NodeId>,
        names: &HashMap<String, Vec<NodeId>>,
    ) -> Target {
        let Some(last) = segs.last() else {
            return Target::Ghost;
        };
        let answers = |n: NodeId| self.path_keys(n).ends_with(segs);
        // Sticking (13 §3.5): a new node with the name takes no link over.
        if let Some(&n) = held.iter().find(|&&n| self.kind(n).is_some() && answers(n)) {
            return Target::Node(n);
        }
        let mut found: Vec<NodeId> = names
            .get(last)
            .map(|c| c.iter().copied().filter(|&n| answers(n)).collect())
            .unwrap_or_default();
        if segs.len() > 1 && found.len() > 1 {
            // A path: from the root exactly, then from the note's folder.
            let mut here: Vec<String> = self.path_keys(src);
            here.pop();
            here.extend(segs.iter().cloned());
            for whole in [segs.to_vec(), here] {
                let exact: Vec<NodeId> = found
                    .iter()
                    .copied()
                    .filter(|&n| self.path_keys(n) == whole)
                    .collect();
                if !exact.is_empty() {
                    found = exact;
                    break;
                }
            }
        }
        match found.len() {
            0 => Target::Ghost,
            1 => Target::Node(found[0]),
            _ => Target::Node(self.nearest(src, &found)),
        }
    }

    /// Of several nodes with one name, the nearest to `src` by the tree (the
    /// deeper common network), then the shorter path, then the older (13 §3.5).
    fn nearest(&self, src: NodeId, found: &[NodeId]) -> NodeId {
        let chain = |n: NodeId| -> Vec<NodeId> { self.ancestors(n).into_iter().rev().collect() };
        let mine = chain(src);
        let created = |n: NodeId| {
            self.field(n, "createdAt")
                .and_then(|v| v.as_i64())
                .unwrap_or(i64::MAX)
        };
        let mut best: Vec<(std::cmp::Reverse<usize>, usize, i64, NodeId)> = found
            .iter()
            .map(|&n| {
                let up = chain(n);
                let common = mine.iter().zip(&up).take_while(|(a, b)| a == b).count();
                (std::cmp::Reverse(common), up.len(), created(n), n)
            })
            .collect();
        best.sort();
        best[0].3
    }

    /// The text wires and ghosts that leave `note`.
    fn outgoing(&self, note: NodeId) -> Outgoing {
        let mut out = Outgoing::default();
        let index = &self.docs[&self.index_doc(note)];
        let from = note.to_text();
        let LoroValue::Map(edges) = index.get_map("edge").get_value() else {
            return out;
        };
        for (key, v) in edges.iter() {
            let Some(v) = Val::from_loro(v) else { continue };
            if v.get("from").and_then(Val::as_str) != Some(from.as_str()) {
                continue;
            }
            if let Some(x) = v.get("ghost").and_then(Val::as_str) {
                out.ghosts.insert(link_key(x), (key.clone(), x.to_owned()));
            } else if let Some(to) = v
                .get("to")
                .and_then(Val::as_str)
                .and_then(|t| NodeId::parse(t).ok())
            {
                if read(index, "edgeOrigin", &format!("{key}|text")).is_some() {
                    out.wires.insert(to, key.clone());
                }
            }
        }
        out
    }

    /// The notes' wires and ghosts follow their `[[links]]` (05 §8.2 rule 4,
    /// §8.5): a link to a node adds the origin `text` to the wire, a link
    /// gone takes it away, a wire with no origin left goes; a link to no node
    /// is a ghost, and a ghost whose link now finds a node resolves. One
    /// system changeset for all the notes, outside undo (05 §11). A note in
    /// the trash keeps what it has: its wires are hidden with it.
    pub(super) fn relink(&mut self, notes: &BTreeSet<NodeId>) -> Result<Option<Changeset>> {
        let notes: Vec<NodeId> = notes
            .iter()
            .copied()
            .filter(|&n| self.alive(n) && self.kind(n) == Some(NodeKind::Note))
            .collect();
        let mut texts = Vec::with_capacity(notes.len());
        for &note in &notes {
            let doc = format!("content/{}", note.to_text());
            self.ensure_doc(&doc)?;
            texts.push(self.docs[&doc].get_text("text").to_string());
        }
        let names = self.link_names();
        let ts = now_ms();
        let at = || Some(Val::map([("at", Val::Int(ts))]));
        let mut plan: Vec<(String, &str, String, Option<Val>)> = Vec::new();
        for (&note, text) in notes.iter().zip(&texts) {
            let index = self.index_doc(note);
            let from = note.to_text();
            let have = self.outgoing(note);
            let held: BTreeSet<NodeId> = have.wires.keys().copied().collect();
            // What the text asks for: nodes, and ghosts by key with the name
            // as first written.
            let mut want: BTreeSet<NodeId> = BTreeSet::new();
            let mut ghosts: BTreeMap<String, String> = BTreeMap::new();
            let mut resolved: HashMap<String, NodeId> = HashMap::new();
            for link in strata_markdown::scan(text).links {
                let k = link_key(&link.target);
                let segs: Vec<String> = k
                    .split('/')
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
                    .collect();
                if segs.is_empty() {
                    continue;
                }
                match self.resolve(note, &segs, &held, &names) {
                    // A link to itself makes no wire (05 §8.2 rule 2).
                    Target::Node(n) if n == note => {}
                    Target::Node(n) => {
                        want.insert(n);
                        resolved.insert(k, n);
                    }
                    Target::Ghost => {
                        ghosts.entry(k).or_insert_with(|| link.target.clone());
                    }
                }
            }
            let origins = |key: &str| -> Vec<&'static str> {
                ORIGINS
                    .into_iter()
                    .filter(|o| {
                        read(&self.docs[&index], "edgeOrigin", &format!("{key}|{o}")).is_some()
                    })
                    .collect()
            };
            // Origins a resolved ghost hands to its new wire, besides `text`.
            let mut carried: BTreeMap<NodeId, Vec<&str>> = BTreeMap::new();
            for (k, (key, _)) in &have.ghosts {
                if ghosts.contains_key(k) {
                    continue;
                }
                let held_by = origins(key);
                let mut left = held_by.len();
                for o in held_by {
                    match resolved.get(k) {
                        Some(&n) => carried.entry(n).or_default().push(o),
                        None if o != "text" => continue,
                        None => {}
                    }
                    plan.push((index.clone(), "edgeOrigin", format!("{key}|{o}"), None));
                    left -= 1;
                }
                if left == 0 {
                    plan.push((index.clone(), "edge", key.clone(), None));
                }
            }
            for (k, x) in &ghosts {
                let key = EdgeKey::to_ghost(note, k).to_text();
                let ends = Val::map([
                    ("from", Val::str(from.clone())),
                    ("ghost", Val::str(x.clone())),
                ]);
                match have.ghosts.get(k) {
                    // The name as the text spells it now.
                    Some((_, was)) if was != x => {
                        plan.push((index.clone(), "edge", key, Some(ends)))
                    }
                    Some(_) => {}
                    None => {
                        plan.push((index.clone(), "edgeOrigin", format!("{key}|text"), at()));
                        plan.push((index.clone(), "edge", key, Some(ends)));
                    }
                }
            }
            for &to in &want {
                let key = EdgeKey::between(note, to).to_text();
                if !have.wires.contains_key(&to) {
                    let ends = Val::map([
                        ("from", Val::str(from.clone())),
                        ("to", Val::str(to.to_text())),
                    ]);
                    plan.push((index.clone(), "edgeOrigin", format!("{key}|text"), at()));
                    plan.push((index.clone(), "edge", key.clone(), Some(ends)));
                }
                for o in carried
                    .get(&to)
                    .into_iter()
                    .flatten()
                    .filter(|o| **o != "text")
                {
                    plan.push((index.clone(), "edgeOrigin", format!("{key}|{o}"), at()));
                }
            }
            for (to, key) in &have.wires {
                if want.contains(to) {
                    continue;
                }
                plan.push((index.clone(), "edgeOrigin", format!("{key}|text"), None));
                // The wire lives while it has an origin (10 §2.3).
                if origins(key).iter().all(|o| *o == "text") {
                    plan.push((index.clone(), "edge", key.clone(), None));
                }
            }
        }
        if plan.is_empty() {
            return Ok(None);
        }
        self.write(
            ChangesetOrigin::System,
            Label::new("core.change.links"),
            |tx| {
                for (doc, map, key, value) in plan {
                    tx.set(&doc, map, &key, value)?;
                }
                Ok(())
            },
        )
        .map(|c| Some(c).filter(|c| !c.writes.is_empty()))
    }

    /// After a step that named, made, removed, trashed, restored or moved
    /// nodes, the links it may change find their nodes again: ghosts that a
    /// new name answers resolve (05 §8.5), and a wire whose node no longer
    /// answers its link becomes a ghost (13 §3.5). Undo and redo too, since
    /// the text wires of 05 §11 are the system's, outside the step.
    pub(super) fn links_after(&mut self, step: &Changeset) -> Result<Option<Changeset>> {
        let mut changed: BTreeSet<NodeId> = BTreeSet::new();
        let mut paths = false;
        for w in &step.writes {
            if !w.doc.starts_with("index/") || !NAMING.contains(&w.map.as_str()) {
                continue;
            }
            let Ok(n) = NodeId::parse(&w.key) else {
                continue;
            };
            changed.insert(n);
            // A network's name and a node's place are the paths below them.
            let canvas = |v: &Option<Val>| {
                v.as_ref()
                    .and_then(Val::as_str)
                    .and_then(|s| {
                        serde_json::from_value::<NodeKind>(serde_json::Value::String(s.to_owned()))
                            .ok()
                    })
                    .is_some_and(NodeKind::has_canvas)
            };
            paths |= w.map == "primaryNet"
                || self.kind(n).is_some_and(NodeKind::has_canvas)
                || (w.map == "kind" && (canvas(&w.before) || canvas(&w.after)));
        }
        if changed.is_empty() {
            return Ok(None);
        }
        let keys: HashSet<String> = changed
            .iter()
            .filter(|&&n| self.alive(n))
            .map(|&n| link_key(&self.name(n)))
            .collect();
        // Text wires into the nodes changed, and into everything below them
        // when a path changed.
        let mut into = changed.clone();
        if paths {
            let children = self.children();
            let mut stack: Vec<NodeId> = changed.iter().copied().collect();
            while let Some(n) = stack.pop() {
                for &c in children.get(&n).into_iter().flatten() {
                    if into.insert(c) {
                        stack.push(c);
                    }
                }
            }
        }
        let mut notes: BTreeSet<NodeId> = changed
            .iter()
            .copied()
            .filter(|&n| self.kind(n) == Some(NodeKind::Note))
            .collect();
        for shard in self.index_shards() {
            let LoroValue::Map(edges) = shard.get_map("edge").get_value() else {
                continue;
            };
            for (key, v) in edges.iter() {
                let Some(v) = Val::from_loro(v) else { continue };
                let Some(from) = v
                    .get("from")
                    .and_then(Val::as_str)
                    .and_then(|s| NodeId::parse(s).ok())
                else {
                    continue;
                };
                if let Some(x) = v.get("ghost").and_then(Val::as_str) {
                    let k = link_key(x);
                    let last = k.rsplit('/').find(|s| !s.is_empty()).unwrap_or_default();
                    if keys.contains(last) || (paths && k.contains('/')) {
                        notes.insert(from);
                    }
                } else if let Some(to) = v
                    .get("to")
                    .and_then(Val::as_str)
                    .and_then(|s| NodeId::parse(s).ok())
                {
                    if into.contains(&to)
                        && read(shard, "edgeOrigin", &format!("{key}|text")).is_some()
                    {
                        notes.insert(from);
                    }
                }
            }
        }
        self.relink(&notes)
    }
}
