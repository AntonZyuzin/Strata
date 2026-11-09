//! Rules 3, 5 and 6 of 05 §14 checked on what the documents hold. A revert
//! from the journal (10 §9.3) writes old values back key by key, and a
//! later change may stand on what it takes away: the network a note was
//! made in since, the wire drawn to a node since. Such a revert is tried on
//! a copy first and refused when it breaks a rule the workspace kept.

use super::{ChangesetOrigin, CoreError, KeyWrite, Label, NodeId, Result, Store, Val, Workspace};
use loro::LoroValue;
use std::collections::{BTreeSet, HashMap, HashSet};
use strata_model::NodeKind;

impl<S: Store> Workspace<S> {
    /// What breaks rules 3, 5 and 6 of 05 §14 now, each a line: what
    /// `strata doctor` reports (11 §4.1).
    pub fn broken_rules(&self) -> Vec<String> {
        self.broken().into_iter().collect()
    }

    /// Every document of the store opened in the engine (11 §4.1, `strata
    /// backup verify`): how many there are; one that does not open is an
    /// error naming it.
    pub fn check_docs(&mut self) -> Result<usize> {
        let ids = self.store.doc_ids()?;
        for id in &ids {
            self.ensure_doc(id)
                .map_err(|e| CoreError::Invalid(format!("{id}: {e}")))?;
        }
        Ok(ids.len())
    }

    /// The schema the workspace was written with (10 §13).
    pub fn schema(&self) -> i64 {
        super::read(&self.docs["sys"], "sys", "schema")
            .and_then(|v| v.as_i64())
            .unwrap_or(0)
    }

    /// Which nodes there are, of what kind, and which lie in the trash —
    /// read out of the index shards at once: a check of every node,
    /// placement and wire would read a key of Loro each time, microseconds
    /// apiece, a second at 10 000 nodes.
    pub(super) fn census(&self) -> Census {
        let mut kinds = HashMap::new();
        let mut texts = HashMap::new();
        let mut trashed = HashSet::new();
        for shard in self.index_shards() {
            if let LoroValue::Map(m) = shard.get_map("kind").get_value() {
                for (id, v) in m.iter() {
                    if let (Ok(n), Some(k)) =
                        (NodeId::parse(id), Val::from_loro(v).and_then(kind_of))
                    {
                        kinds.insert(n, k);
                        texts.insert(id.clone(), n);
                    }
                }
            }
            if let LoroValue::Map(m) = shard.get_map("trashedAt").get_value() {
                for (id, v) in m.iter() {
                    if let (Ok(n), Some(_)) = (NodeId::parse(id), Val::from_loro(v)) {
                        trashed.insert(n);
                    }
                }
            }
        }
        Census {
            kinds,
            texts,
            trashed,
        }
    }

    /// What breaks rules 3, 5 and 6 now, each a line: a live node that lies
    /// nowhere or in a node with no canvas, a network inside itself, a wire
    /// with an end that is no node.
    pub(super) fn broken(&self) -> BTreeSet<String> {
        let mut out = BTreeSet::new();
        let c = self.census();
        let root = self.root;
        // The root is the workspace (05 §3): it is there and not in the trash.
        if !c.alive(root) {
            out.insert("the root is gone".to_owned());
        }
        let every = self.placements_every();
        for n in c.nodes() {
            if n == root || !c.alive(n) {
                continue;
            }
            let placed = every.get(&n).map(Vec::as_slice).unwrap_or(&[]);
            // Rule 3: one primary placement, in a live network.
            if !placed.iter().any(|&(net, _)| c.alive(net)) {
                out.insert(format!("{} lies nowhere", n.to_text()));
            }
            // In a node with no canvas — in the trash too: it would bring
            // the placement back with it.
            for &(net, _) in placed {
                if c.kind(net).is_some() && !c.canvas(net) {
                    out.insert(format!(
                        "{} lies in {}, which has no canvas",
                        n.to_text(),
                        net.to_text()
                    ));
                }
            }
        }
        // 05 §3: the root lies in no network — one in the trash would bring
        // it back into itself.
        for &(net, _) in every.get(&root).map(Vec::as_slice).unwrap_or(&[]) {
            if c.kind(net).is_some() {
                out.insert(format!("the root lies in {}", net.to_text()));
            }
        }
        // Rule 6: a wire joins two nodes, live or in the trash, or a node and a ghost.
        for shard in self.index_shards() {
            if let LoroValue::Map(edges) = shard.get_map("edge").get_value() {
                for (key, v) in edges.iter() {
                    if let Some(fault) = c.wire_fault(key, v) {
                        out.insert(fault);
                    }
                }
            }
        }
        // Rule 5: the nesting of live networks has no cycle.
        let mut children: HashMap<NodeId, Vec<NodeId>> = HashMap::new();
        for (&child, placed) in &every {
            if c.canvas(child) && c.alive(child) {
                for &(net, _) in placed {
                    children.entry(net).or_default().push(child);
                }
            }
        }
        let mut done: HashSet<NodeId> = HashSet::new();
        for &net in children.keys() {
            if !c.alive(net) || done.contains(&net) {
                continue;
            }
            let mut path: Vec<(NodeId, usize)> = vec![(net, 0)];
            let mut on_path: HashSet<NodeId> = HashSet::from([net]);
            while let Some(&mut (at, ref mut next)) = path.last_mut() {
                let Some(&child) = children.get(&at).and_then(|k| k.get(*next)) else {
                    on_path.remove(&at);
                    done.insert(at);
                    path.pop();
                    continue;
                };
                *next += 1;
                if on_path.contains(&child) {
                    out.insert(format!("{} lies inside itself", child.to_text()));
                } else if !done.contains(&child) {
                    on_path.insert(child);
                    path.push((child, 0));
                }
            }
        }
        out
    }

    /// `plan` of a revert tried on a copy of the documents: refused with
    /// `depends` when it breaks a rule of 05 §14 the workspace keeps now —
    /// a later change stands on what it takes away.
    pub(super) fn try_revert(&mut self, plan: &[KeyWrite]) -> Result<()> {
        let docs: Vec<String> = plan
            .iter()
            .filter(|w| !w.doc.starts_with("content/"))
            .map(|w| w.doc.clone())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        let before = self.broken();
        let mut copy = self.shadow(&docs)?;
        copy.write(
            ChangesetOrigin::User,
            Label::new("core.change.revert"),
            |tx| {
                for w in plan.iter().filter(|w| !w.doc.starts_with("content/")) {
                    tx.set(&w.doc, &w.map, &w.key, w.before.clone())?;
                }
                Ok(())
            },
        )?;
        let new: Vec<String> = copy.broken().difference(&before).cloned().collect();
        if new.is_empty() {
            return Ok(());
        }
        Err(CoreError::Depends(new.join("; ")))
    }
}

/// A node's kind as the index spells it (10 §2.3); a node made before
/// ADR-0010 is `media`, an asset.
pub(super) fn kind_of(v: Val) -> Option<NodeKind> {
    serde_json::from_value(serde_json::Value::String(v.as_str()?.to_owned())).ok()
}

/// The nodes of the index with their kinds, and those in the trash:
/// [`Workspace::census`].
pub(super) struct Census {
    kinds: HashMap<NodeId, NodeKind>,
    /// The ids as the index writes them: a wire's ends are matched without
    /// parsing them (a parse is ~0.3 µs, a hundred thousand wires have two).
    texts: HashMap<String, NodeId>,
    trashed: HashSet<NodeId>,
}

impl Census {
    pub(super) fn kind(&self, n: NodeId) -> Option<NodeKind> {
        self.kinds.get(&n).copied()
    }

    /// There and not in the trash.
    pub(super) fn alive(&self, n: NodeId) -> bool {
        self.kinds.contains_key(&n) && !self.trashed.contains(&n)
    }

    /// A folder or a project (05 §4.2), live or not.
    pub(super) fn canvas(&self, n: NodeId) -> bool {
        self.kind(n).is_some_and(NodeKind::has_canvas)
    }

    /// Every node there is.
    pub(super) fn nodes(&self) -> impl Iterator<Item = NodeId> + '_ {
        self.kinds.keys().copied()
    }

    /// What breaks rule 6 of 05 §14 in wire `key` of value `v`: a `from`
    /// that is no node, a `to` that is none — a ghost's has none (05 §8.5)
    /// — or one node at both ends. None when the wire is whole. The value
    /// is read as Loro holds it: a hundred thousand wires are not copied.
    pub(super) fn wire_fault(&self, key: &str, v: &LoroValue) -> Option<String> {
        let end = |e: &str| match v {
            LoroValue::Map(m) => match m.get(e) {
                Some(LoroValue::String(s)) => Some(s.as_ref()),
                _ => None,
            },
            _ => None,
        };
        let node = |id: &str| {
            self.texts.get(id).copied().or_else(|| {
                // Another spelling of an id (its case, a UUID) is still its node.
                NodeId::parse(id).ok().filter(|&n| self.kind(n).is_some())
            })
        };
        let Some(from) = end("from") else {
            return Some(format!("wire {key} starts at no node"));
        };
        let Some(a) = node(from) else {
            return Some(format!("wire {key} ends at {from}, no node"));
        };
        match end("to") {
            None => None,
            Some(to) => match node(to) {
                None => Some(format!("wire {key} ends at {to}, no node")),
                Some(b) if b == a => Some(format!("wire {key} joins {from} with itself")),
                Some(_) => None,
            },
        }
    }
}
