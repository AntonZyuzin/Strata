//! The invariants of 05 §14 reconciled (NFR-77, 10 §8.5). The leading core
//! finds what breaks rules 3, 5 and 6 and fixes it as the table of 10 §8.5
//! says. In the MVP nothing merges, so a break can only be a bug that an
//! import or a migration brought in: an import's plan is reconciled on its
//! shadow and its fixes ride in the import's own changeset — undoing the
//! import takes them back with it — and the report names each (13 §3.6);
//! [`Workspace::reconcile`] fixes a workspace as one changeset of the
//! system, outside undo.
//!
//! Only what breaks a rule is fixed. A node living elsewhere too keeps its
//! placement in a network in the trash — a restore leaves it so (05 §11),
//! and the network brings it back when it comes back itself; a node's
//! layout in a network it no longer lies in stays, as nothing reads it; a
//! link of a text whose wire led to no node is a ghost the next time the
//! text is saved (rule 7 is not fixed here).

use super::{ChangesetId, ChangesetOrigin, KeyWrite, Label, Result, Store, Tx, Val, Workspace};
use super::{Writes, places::placed_at, structure::Census};
use loro::LoroValue;
use std::collections::{BTreeMap, HashMap, HashSet};
use strata_model::{NodeId, PlacementKey};

/// Passes at most: a pass fixes what it sees, and a network it sends to the
/// trash takes the nodes lying only inside it in the next pass (05 §5).
const PASSES: usize = 256;

/// One fix of the reconcile (10 §8.5).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reconciled {
    /// `cycle` — a placement closing the nesting on itself went: the
    /// newest on its cycle, or any of the root's (05 §3); `canvas` — a
    /// placement in a node with no canvas went; `trash` — a live node lying
    /// in no live network went to the trash; `wire` — a wire with an end
    /// that is no node, or with one node at both ends, went; `root` — the
    /// root came back from the trash.
    pub fix: &'static str,
    /// The node placed, sent to the trash or come back; a wire's `from`.
    pub node: String,
    /// The network whose placement went (`cycle`, `canvas`).
    pub net: Option<String>,
}

/// What a pass of the reconcile writes, and why.
#[derive(Default)]
struct Pass {
    sets: Writes,
    fixed: Vec<Reconciled>,
    /// `(net, node)`: the placements going in this pass.
    gone: HashSet<(NodeId, NodeId)>,
}

impl Pass {
    fn set(&mut self, doc: String, map: &str, key: String, value: Option<Val>) {
        self.sets.push((doc, map.to_owned(), key, value));
    }
}

impl<S: Store> Workspace<S> {
    /// What breaks rules 3, 5 and 6 of 05 §14, fixed as one changeset of the
    /// system (10 §8.5), outside undo; the links that read names and places
    /// follow it. Nothing broken — nothing written. The fixes back. A
    /// migration (10 §13) ends with it.
    pub fn reconcile(&mut self) -> Result<Vec<Reconciled>> {
        if self.broken().is_empty() {
            return Ok(Vec::new());
        }
        let mut shadow = self.shadow(&[])?;
        let (writes, fixed) = shadow.reconcile_in_memory()?;
        if writes.is_empty() {
            return Ok(fixed);
        }
        let step = self.write(
            ChangesetOrigin::System,
            Label::new("core.change.reconcile"),
            |tx| {
                for w in &writes {
                    tx.set(&w.doc, &w.map, &w.key, w.after.clone())?;
                }
                Ok(())
            },
        )?;
        // The steps of undo before it go: undoing one could break again
        // what it fixed, or leave keys of a node it took away (as a purge).
        self.undo.clear();
        self.redo.clear();
        self.links_after(&step, false)?;
        Ok(fixed)
    }

    /// The fixes found and made in the documents in memory, pass by pass,
    /// with no changeset: only a shadow is fixed so — an import's (13 §3.3)
    /// or [`Self::reconcile`]'s. The writes come back one a key, with the
    /// value before the first pass and after the last.
    pub(super) fn reconcile_in_memory(&mut self) -> Result<(Vec<KeyWrite>, Vec<Reconciled>)> {
        let mut writes: Vec<KeyWrite> = Vec::new();
        let mut fixed = Vec::new();
        for _ in 0..PASSES {
            let pass = self.reconcile_pass();
            if pass.sets.is_empty() {
                break;
            }
            let mut tx = Tx {
                docs: &mut self.docs,
                before: HashMap::new(),
                writes: Vec::new(),
                texts: Vec::new(),
            };
            for (doc, map, key, value) in pass.sets {
                tx.set(&doc, &map, &key, value)?;
            }
            if tx.writes.is_empty() {
                break;
            }
            writes.extend(tx.writes);
            fixed.extend(pass.fixed);
        }
        Ok((one_a_key(writes), fixed))
    }

    /// `writes` into the documents in memory, with no changeset: only a
    /// shadow takes writes so.
    pub(super) fn apply_in_memory(&mut self, writes: Writes) -> Result<()> {
        for (doc, ..) in &writes {
            self.ensure_doc(doc)?;
        }
        let mut tx = Tx {
            docs: &mut self.docs,
            before: HashMap::new(),
            writes: Vec::new(),
            texts: Vec::new(),
        };
        writes
            .into_iter()
            .try_for_each(|(doc, map, key, value)| tx.set(&doc, &map, &key, value))
    }

    /// One pass: what breaks the rules now, and the writes that fix it.
    fn reconcile_pass(&self) -> Pass {
        let mut p = Pass::default();
        let root = self.root;
        let c = self.census();
        let every = self.placements_every();
        // 05 §3: the root is not in the trash — a pass of its own, as what
        // lies in it lies in a live network only once it is out — and it
        // lies in no network.
        if c.kind(root).is_some() && !c.alive(root) {
            let (doc, key) = (self.index_doc(root), root.to_text());
            p.set(doc.clone(), "trashedAt", key.clone(), None);
            p.set(doc, "trashBatch", key, None);
            p.fixed.push(Reconciled {
                fix: "root",
                node: root.to_text(),
                net: None,
            });
            return p;
        }
        for &(net, _) in every.get(&root).map(Vec::as_slice).unwrap_or(&[]) {
            if c.kind(net).is_some() {
                self.unplace(&mut p, "cycle", net, root);
            }
        }
        // Rule 3: no placement in a node with no canvas — in the trash too:
        // it would bring the placement back with it.
        let mut live: Vec<NodeId> = c.nodes().filter(|&n| n != root && c.alive(n)).collect();
        live.sort();
        for &n in &live {
            for &(net, _) in every.get(&n).map(Vec::as_slice).unwrap_or(&[]) {
                if c.kind(net).is_some() && !c.canvas(net) {
                    self.unplace(&mut p, "canvas", net, n);
                }
            }
        }
        // Rule 5: the newest placement on each cycle of live networks.
        for (net, child) in cycle_closers(&c, &every, &p.gone) {
            self.unplace(&mut p, "cycle", net, child);
        }
        // Rule 3: a live node lies in a live network; its primary is one of
        // its live placements.
        let now = (self.clock)();
        for &n in &live {
            let placed = every.get(&n).map(Vec::as_slice).unwrap_or(&[]);
            let kept = |net: NodeId| !p.gone.contains(&(net, n));
            let left: Vec<(NodeId, i64)> = placed
                .iter()
                .copied()
                .filter(|&(net, _)| kept(net) && c.alive(net) && c.canvas(net))
                .collect();
            let (doc, key) = (self.index_doc(n), n.to_text());
            let named = self
                .field(n, "primaryNet")
                .and_then(|v| v.as_str().and_then(|s| NodeId::parse(s).ok()));
            if left.is_empty() {
                // A network of its in the trash takes it as the trash's
                // cascade would have (10 §8.5): its batch, so the network
                // brings it back. Else it goes as the removal of its last
                // placement sends it, a batch of its own (05 §5). Either way
                // its term runs from now (05 §11).
                let mut held: Vec<(NodeId, i64)> = placed
                    .iter()
                    .copied()
                    .filter(|&(net, _)| kept(net) && c.canvas(net) && !c.alive(net))
                    .collect();
                held.sort_by_key(|&(net, at)| (Some(net) != named, at, net));
                let batch = held
                    .first()
                    .and_then(|&(net, _)| self.field(net, "trashBatch"))
                    .and_then(|v| v.as_str().map(str::to_owned))
                    .filter(|b| !b.is_empty())
                    .unwrap_or_else(|| ChangesetId::new().to_text());
                p.set(doc.clone(), "trashedAt", key.clone(), Some(Val::Int(now)));
                p.set(doc, "trashBatch", key, Some(Val::str(batch)));
                p.fixed.push(Reconciled {
                    fix: "trash",
                    node: n.to_text(),
                    net: None,
                });
                continue;
            }
            // The primary this pass took away falls to the oldest placement
            // left (10 §8.5).
            let took = placed.iter().any(|&(net, _)| !kept(net));
            let holds = named.is_some_and(|m| left.iter().any(|&(net, _)| net == m));
            if took && !holds {
                p.set(doc, "primaryNet", key, Some(Val::str(left[0].0.to_text())));
            }
        }
        // Rule 6: a wire joins two nodes, live or in the trash, or a node
        // and a ghost (05 §8.5); it goes with its origins and its label.
        for (doc, edge, from) in self.loose_wires(&c) {
            if let LoroValue::Map(origins) = self.docs[&doc].get_map("edgeOrigin").get_value() {
                let head = format!("{edge}|");
                for key in origins.keys().filter(|k| k.starts_with(&head)) {
                    p.set(doc.clone(), "edgeOrigin", key.clone(), None);
                }
            }
            p.set(doc.clone(), "edgeLabel", edge.clone(), None);
            p.set(doc, "edge", edge, None);
            p.fixed.push(Reconciled {
                fix: "wire",
                node: from,
                net: None,
            });
        }
        p
    }

    /// Node `n`'s placement in `net` goes in pass `p`, for `fix`.
    fn unplace(&self, p: &mut Pass, fix: &'static str, net: NodeId, n: NodeId) {
        if p.gone.insert((net, n)) {
            let key = PlacementKey::new(net, n).to_text();
            p.set(self.index_doc(n), "placement", key, None);
            p.fixed.push(Reconciled {
                fix,
                node: n.to_text(),
                net: Some(net.to_text()),
            });
        }
    }

    /// Every placement, whatever its network is now: node → `[(net, made
    /// at)]`, the oldest first.
    pub(super) fn placements_every(&self) -> HashMap<NodeId, Vec<(NodeId, i64)>> {
        let mut out: HashMap<NodeId, Vec<(NodeId, i64)>> = HashMap::new();
        for shard in self.index_shards() {
            let LoroValue::Map(m) = shard.get_map("placement").get_value() else {
                continue;
            };
            for (key, v) in m.iter() {
                let Some((net, node)) = key.split_once('/') else {
                    continue;
                };
                if let (Ok(net), Ok(node)) = (NodeId::parse(net), NodeId::parse(node)) {
                    out.entry(node).or_default().push((net, placed_at(v)));
                }
            }
        }
        for list in out.values_mut() {
            list.sort_by_key(|&(net, at)| (at, net));
        }
        out
    }

    /// The wires that break rule 6 ([`Census::wire_fault`]): their shard,
    /// key and `from`, in key order.
    fn loose_wires(&self, c: &Census) -> Vec<(String, String, String)> {
        let mut out = Vec::new();
        for k in 0..self.k {
            let doc = format!("index/0/{k}");
            let Some(shard) = self.docs.get(&doc) else {
                continue;
            };
            let LoroValue::Map(edges) = shard.get_map("edge").get_value() else {
                continue;
            };
            for (key, v) in edges.iter() {
                if c.wire_fault(key, v).is_some() {
                    let from = match v {
                        LoroValue::Map(m) => match m.get("from") {
                            Some(LoroValue::String(s)) => s.to_string(),
                            _ => String::new(),
                        },
                        _ => String::new(),
                    };
                    out.push((doc.clone(), key.clone(), from));
                }
            }
        }
        out.sort();
        out
    }
}

/// For each cycle in the nesting of live networks that the placements left
/// by `gone` keep, its newest placement (05 §14 rule 5, 10 §8.5: the one
/// made last; ties by id): the network it is in, and the child.
fn cycle_closers(
    c: &Census,
    every: &HashMap<NodeId, Vec<(NodeId, i64)>>,
    gone: &HashSet<(NodeId, NodeId)>,
) -> Vec<(NodeId, NodeId)> {
    let nest = |n: NodeId| c.alive(n) && c.canvas(n);
    let mut kids: BTreeMap<NodeId, Vec<NodeId>> = BTreeMap::new();
    let mut since: HashMap<(NodeId, NodeId), i64> = HashMap::new();
    for (&child, placed) in every {
        if !nest(child) {
            continue;
        }
        for &(net, at) in placed {
            if nest(net) && !gone.contains(&(net, child)) {
                kids.entry(net).or_default().push(child);
                since.insert((net, child), at);
            }
        }
    }
    cycle_cuts(kids, |net, child| {
        (since.get(&(net, child)).copied(), net, child)
    })
}

/// The placements to take away so that nesting `kids` — a network and the
/// networks placed in it — has no cycle (05 §14 rule 5): on each cycle the
/// one `rank` puts last. A cycle that a placement taken already breaks
/// takes no other.
pub(super) fn cycle_cuts<K: Ord>(
    mut kids: BTreeMap<NodeId, Vec<NodeId>>,
    rank: impl Fn(NodeId, NodeId) -> K,
) -> Vec<(NodeId, NodeId)> {
    for list in kids.values_mut() {
        list.sort();
        list.dedup();
    }
    let mut cut: Vec<(NodeId, NodeId)> = Vec::new();
    let mut done: HashSet<NodeId> = HashSet::new();
    for &start in kids.keys() {
        if done.contains(&start) {
            continue;
        }
        let mut path: Vec<(NodeId, usize)> = vec![(start, 0)];
        let mut on_path: HashSet<NodeId> = HashSet::from([start]);
        while let Some(&mut (at, ref mut next)) = path.last_mut() {
            let Some(&child) = kids.get(&at).and_then(|k| k.get(*next)) else {
                on_path.remove(&at);
                done.insert(at);
                path.pop();
                continue;
            };
            *next += 1;
            if cut.contains(&(at, child)) {
                continue;
            }
            if on_path.contains(&child) {
                // The cycle: child … at → child.
                let from = path.iter().position(|&(n, _)| n == child).unwrap_or(0);
                let mut ring: Vec<(NodeId, NodeId)> =
                    path[from..].windows(2).map(|w| (w[0].0, w[1].0)).collect();
                ring.push((at, child));
                if ring.iter().any(|e| cut.contains(e)) {
                    continue;
                }
                cut.extend(ring.into_iter().max_by_key(|&(net, c)| rank(net, c)));
            } else if !done.contains(&child) {
                on_path.insert(child);
                path.push((child, 0));
            }
        }
    }
    cut
}

/// One write a key: the value before its first write and after its last;
/// a key that came back to where it was is none.
fn one_a_key(writes: Vec<KeyWrite>) -> Vec<KeyWrite> {
    let mut at: HashMap<(String, String, String), usize> = HashMap::new();
    let mut out: Vec<KeyWrite> = Vec::new();
    for w in writes {
        let key = (w.doc.clone(), w.map.clone(), w.key.clone());
        match at.get(&key) {
            Some(&i) => out[i].after = w.after,
            None => {
                at.insert(key, out.len());
                out.push(w);
            }
        }
    }
    out.retain(|w| w.before != w.after);
    out
}

#[cfg(test)]
impl<S: Store> Workspace<S> {
    /// A key of node `shard`'s index shard written as it is, the rules
    /// aside: what a bug of an import or a migration could leave (NFR-77's
    /// tests). A changeset of its own, outside undo.
    pub(crate) fn set_raw(
        &mut self,
        shard: &str,
        map: &str,
        key: &str,
        value: Option<Val>,
    ) -> Result<()> {
        let doc = self.index_doc(self.parse(shard)?);
        self.write(ChangesetOrigin::System, Label::new("test.raw"), |tx| {
            tx.set(&doc, map, key, value)
        })?;
        Ok(())
    }

    /// A key of node `shard`'s index shard as it is.
    pub(crate) fn raw(&self, shard: &str, map: &str, key: &str) -> Option<Val> {
        let doc = self.index_doc(NodeId::parse(shard).ok()?);
        super::read(self.docs.get(&doc)?, map, key)
    }
}
