//! Placements (05 §5, ADR-0002): «node X lies in network N». A node has one
//! primary placement, its `primaryNet`, and any number of appearances; in a
//! network it is placed once at most; networks nest without cycles. The
//! placement's key is `{net}/{node}` in the node's shard, its value says
//! when it was made: the primary that a concurrent edit took away falls to
//! the oldest placement left (10 §8.5).
//!
//! The trash follows 05 §5 and ☑ Q-05-6: a network going to the trash takes
//! the nodes inside that live nowhere else, in the same batch, and the nodes
//! placed elsewhere too only lose their placements inside it.

use super::{Result, Store, Val, Workspace, invalid, read};
use loro::LoroValue;
use std::collections::{HashMap, HashSet};
use strata_model::{NodeId, NodeKind, PlacementKey};

/// What a step to the trash does (05 §5): the nodes that go, the placements
/// of the nodes that stay elsewhere, and their new primaries.
#[derive(Debug, Default)]
pub(super) struct Cascade {
    pub trashed: Vec<NodeId>,
    /// `(node, net)`: a placement inside what goes, of a node that stays.
    pub unplaced: Vec<(NodeId, NodeId)>,
    /// `(node, net)`: the primary of a node whose primary went.
    pub primaries: Vec<(NodeId, NodeId)>,
}

impl<S: Store> Workspace<S> {
    /// Node `n`'s placements in live networks, the oldest first, with when each was made.
    pub(super) fn placements_of(&self, n: NodeId) -> Vec<(NodeId, i64)> {
        let Some(shard) = self.docs.get(&self.index_doc(n)) else {
            return Vec::new();
        };
        let LoroValue::Map(m) = shard.get_map("placement").get_value() else {
            return Vec::new();
        };
        let suffix = format!("/{}", n.to_text());
        let mut out: Vec<(NodeId, i64)> = m
            .iter()
            .filter_map(|(key, v)| {
                let net = NodeId::parse(key.strip_suffix(&suffix)?).ok()?;
                self.alive(net).then(|| (net, placed_at(v)))
            })
            .collect();
        out.sort_by_key(|&(net, at)| (at, net));
        out
    }

    /// Every node's placements in live networks: node → `[(net, made at)]`, the oldest first.
    pub(super) fn placements_index(&self) -> HashMap<NodeId, Vec<(NodeId, i64)>> {
        let mut out: HashMap<NodeId, Vec<(NodeId, i64)>> = HashMap::new();
        for shard in self.index_shards() {
            let LoroValue::Map(m) = shard.get_map("placement").get_value() else {
                continue;
            };
            for (key, v) in m.iter() {
                let Some((net, node)) = key.split_once('/') else {
                    continue;
                };
                let (Ok(net), Ok(node)) = (NodeId::parse(net), NodeId::parse(node)) else {
                    continue;
                };
                if self.alive(net) {
                    out.entry(node).or_default().push((net, placed_at(v)));
                }
            }
        }
        for list in out.values_mut() {
            list.sort_by_key(|&(net, at)| (at, net));
        }
        out
    }

    /// When node `n` was placed in `net`; none when it is not.
    pub(super) fn placed_since(&self, net: NodeId, n: NodeId) -> Option<i64> {
        let key = PlacementKey::new(net, n).to_text();
        let shard = self.docs.get(&self.index_doc(n))?;
        read(shard, "placement", &key).map(|v| v.get("at").and_then(Val::as_i64).unwrap_or(0))
    }

    /// The network of `n`'s primary placement (05 §5 rule 2): `primaryNet`
    /// while it names a placement in a live network, else the oldest
    /// placement left (10 §8.5). None for the root and the unplaced.
    pub(super) fn primary_of(&self, n: NodeId) -> Option<NodeId> {
        let named = self
            .field(n, "primaryNet")
            .and_then(|v| v.as_str().and_then(|s| NodeId::parse(s).ok()));
        if let Some(p) = named.filter(|&p| self.placed(p, n) && self.alive(p)) {
            return Some(p);
        }
        self.placements_of(n).first().map(|&(net, _)| net)
    }

    /// Node `n` lies inside network `net`'s placements at any depth, by any
    /// placement: placing `net` in `n` would make a cycle (05 §5 rule 4).
    pub(super) fn inside(&self, n: NodeId, net: NodeId) -> bool {
        let children = self.children();
        let mut seen = HashSet::new();
        let mut stack = vec![net];
        while let Some(at) = stack.pop() {
            if !seen.insert(at) {
                continue;
            }
            for &child in children.get(&at).map(Vec::as_slice).unwrap_or(&[]) {
                if child == n {
                    return true;
                }
                if self.alive(child) && self.kind(child).is_some_and(NodeKind::has_canvas) {
                    stack.push(child);
                }
            }
        }
        false
    }

    /// Network `target` may take node `n` (05 §5 rule 4): not the node
    /// itself, nor a network inside it. `target` may be a network made by
    /// the same step: `made` names the network each such one lies in.
    pub(super) fn may_hold(
        &self,
        target: NodeId,
        n: NodeId,
        made: &HashMap<NodeId, NodeId>,
    ) -> Result<()> {
        if n == self.root {
            return Err(invalid("the root network lies in no network (05 §3)"));
        }
        if !self.kind(n).is_some_and(NodeKind::has_canvas) {
            return Ok(());
        }
        // A network made by this step lies where it was made.
        let mut at = target;
        let mut hops = 0;
        while let Some(&parent) = made.get(&at) {
            if at == n || hops > 1000 {
                break;
            }
            at = parent;
            hops += 1;
        }
        if at == n || self.inside(at, n) {
            return Err(invalid(
                "a network cannot lie in itself or in a network inside it (05 §5 rule 4)",
            ));
        }
        Ok(())
    }

    /// Which of `ids` network `net` may not hold (rule 4) and which lie in it
    /// already (rule 3), for a gesture to show «⊘» before it lands (06 §12.1).
    /// A node gone since — the trash, an unknown id — is in neither list.
    pub fn placeable(&self, net: &str, ids: &[String]) -> Result<super::Placeable> {
        let target = self.network(net)?;
        let mut out = super::Placeable::default();
        for id in ids {
            let Ok(n) = self.live(id) else { continue };
            if self.may_hold(target, n, &HashMap::new()).is_err() {
                out.cycle.push(id.clone());
            }
            if self.placed_since(target, n).is_some() {
                out.here.push(id.clone());
            }
        }
        Ok(out)
    }

    /// What the trash takes with `ids` (05 §5, ☑ Q-05-6): a node inside the
    /// networks that go, whose every placement is in them, goes too; a node
    /// placed elsewhere as well only loses its placements in them, and its
    /// primary falls to the oldest placement left. A locked node does not go.
    pub(super) fn cascade(&self, ids: &[NodeId]) -> Result<Cascade> {
        let children = self.children();
        let index = self.placements_index();
        let mut gone: HashSet<NodeId> = ids.iter().copied().collect();
        let mut order: Vec<NodeId> = ids.to_vec();
        loop {
            let mut grew = false;
            for net in order.clone() {
                for &child in children.get(&net).map(Vec::as_slice).unwrap_or(&[]) {
                    if gone.contains(&child) || !self.alive(child) {
                        continue;
                    }
                    let everywhere = index.get(&child).map(Vec::as_slice).unwrap_or(&[]);
                    if everywhere.iter().all(|(p, _)| gone.contains(p)) {
                        gone.insert(child);
                        order.push(child);
                        grew = true;
                    }
                }
            }
            if !grew {
                break;
            }
        }
        let mut out = Cascade::default();
        for &n in &order {
            if n == self.root {
                return Err(invalid("the root network cannot go to the trash"));
            }
            self.unlocked(n)?;
            out.trashed.push(n);
        }
        let mut stays: Vec<NodeId> = Vec::new();
        for &net in &order {
            for &child in children.get(&net).map(Vec::as_slice).unwrap_or(&[]) {
                if !gone.contains(&child) && self.alive(child) {
                    out.unplaced.push((child, net));
                    if !stays.contains(&child) {
                        stays.push(child);
                    }
                }
            }
        }
        for n in stays {
            if self.primary_of(n).is_some_and(|p| gone.contains(&p)) {
                let left = index
                    .get(&n)
                    .and_then(|all| all.iter().find(|(p, _)| !gone.contains(p)));
                if let Some(&(p, _)) = left {
                    out.primaries.push((n, p));
                }
            }
        }
        Ok(out)
    }
}

fn placed_at(v: &LoroValue) -> i64 {
    Val::from_loro(v)
        .and_then(|v| v.get("at").and_then(Val::as_i64))
        .unwrap_or(0)
}

/// Placements as the operations of one step so far leave them, over the
/// documents' state: a step that makes a network and moves nodes into it
/// reads what it has done (05 §4.2 «Обернуть в сеть»).
#[derive(Debug, Default)]
pub(super) struct Overlay {
    /// `(net, node)` → placed at, or `None` — taken away by this step.
    pub placed: HashMap<(NodeId, NodeId), Option<i64>>,
    pub primary: HashMap<NodeId, NodeId>,
    /// Folders and projects this step made, with the network each lies in.
    pub made_in: HashMap<NodeId, NodeId>,
}

impl<S: Store> Workspace<S> {
    pub(super) fn placed_now(&self, ov: &Overlay, net: NodeId, n: NodeId) -> Option<i64> {
        match ov.placed.get(&(net, n)) {
            Some(v) => *v,
            None => self.placed_since(net, n),
        }
    }

    /// Node `n`'s placements after the step so far, the oldest first.
    pub(super) fn places_now(&self, ov: &Overlay, n: NodeId) -> Vec<(NodeId, i64)> {
        let mut out = self.placements_of(n);
        for (&(net, node), v) in &ov.placed {
            if node != n {
                continue;
            }
            out.retain(|&(p, _)| p != net);
            if let Some(at) = v {
                out.push((net, *at));
            }
        }
        out.sort_by_key(|&(net, at)| (at, net));
        out
    }

    /// The primary placement after the step so far (05 §5 rule 2, 10 §8.5).
    pub(super) fn primary_now(&self, ov: &Overlay, n: NodeId) -> Option<NodeId> {
        let named = ov.primary.get(&n).copied().or_else(|| {
            self.field(n, "primaryNet")
                .and_then(|v| v.as_str().and_then(|s| NodeId::parse(s).ok()))
        });
        let live = |p: NodeId| self.alive(p) || ov.made_in.contains_key(&p);
        if let Some(p) = named.filter(|&p| self.placed_now(ov, p, n).is_some() && live(p)) {
            return Some(p);
        }
        self.places_now(ov, n)
            .into_iter()
            .find(|&(p, _)| live(p))
            .map(|(p, _)| p)
    }
}

impl<S: Store> Workspace<S> {
    /// The writes of a step to the trash (05 §5): the nodes that go, in one
    /// batch, and the placements and primaries of those that stay elsewhere.
    pub(super) fn put_cascade(
        &self,
        put: &mut impl FnMut(&str, &str, &str, Option<Val>),
        c: &Cascade,
        ts: i64,
        batch: &str,
    ) {
        for &n in &c.trashed {
            let index = self.index_doc(n);
            let key = n.to_text();
            put(&index, "trashedAt", &key, Some(Val::Int(ts)));
            put(&index, "trashBatch", &key, Some(Val::str(batch)));
        }
        for &(n, net) in &c.unplaced {
            let key = PlacementKey::new(net, n).to_text();
            put(&self.index_doc(n), "placement", &key, None);
        }
        for &(n, net) in &c.primaries {
            put(
                &self.index_doc(n),
                "primaryNet",
                &n.to_text(),
                Some(Val::str(net.to_text())),
            );
        }
    }

    /// The nodes that went to the trash in the same step as `n`, `n` among them.
    pub(super) fn trashed_with(&self, n: NodeId) -> Vec<NodeId> {
        let batch = self
            .field(n, "trashBatch")
            .and_then(|v| v.as_str().map(str::to_owned));
        let Some(batch) = batch.filter(|b| !b.is_empty()) else {
            return vec![n];
        };
        let mut out = Vec::new();
        for shard in self.index_shards() {
            let LoroValue::Map(m) = shard.get_map("trashBatch").get_value() else {
                continue;
            };
            for (id, v) in m.iter() {
                let same = Val::from_loro(v).is_some_and(|v| v.as_str() == Some(batch.as_str()));
                if let (true, Ok(m)) = (same, NodeId::parse(id)) {
                    out.push(m);
                }
            }
        }
        if !out.contains(&n) {
            out.push(n);
        }
        out
    }
}
