//! Rules 3, 5 and 6 of 05 §14 checked on what the documents hold. A revert
//! from the journal (10 §9.3) writes old values back key by key, and a
//! later change may stand on what it takes away: the network a note was
//! made in since, the wire drawn to a node since. Such a revert is tried on
//! a copy first and refused when it breaks a rule the workspace kept.

use super::{ChangesetOrigin, CoreError, KeyWrite, Label, NodeId, Result, Store, Val, Workspace};
use loro::LoroValue;
use std::collections::{BTreeSet, HashSet};

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

    /// What breaks rules 3, 5 and 6 now, each a line: a live node that lies
    /// nowhere or in a node with no canvas, a network inside itself, a wire
    /// with an end that is no node.
    pub(super) fn broken(&self) -> BTreeSet<String> {
        let mut out = BTreeSet::new();
        // The root is the workspace (05 §3): it is there and not in the trash.
        if !self.alive(self.root) {
            out.insert("the root is gone".to_owned());
        }
        let places = self.placements_index();
        let canvas = |n: NodeId| self.kind(n).is_some_and(|k| k.has_canvas());
        for shard in self.index_shards() {
            let LoroValue::Map(kinds) = shard.get_map("kind").get_value() else {
                continue;
            };
            for id in kinds.keys() {
                let Ok(n) = NodeId::parse(id) else { continue };
                if n == self.root || !self.alive(n) {
                    continue;
                }
                // Rule 3: one primary placement, in a live network.
                let placed = places.get(&n).map(Vec::as_slice).unwrap_or(&[]);
                if self.primary_among(n, placed).is_none() {
                    out.insert(format!("{id} lies nowhere"));
                }
                for &(net, _) in placed {
                    if !canvas(net) {
                        out.insert(format!(
                            "{id} lies in {}, which has no canvas",
                            net.to_text()
                        ));
                    }
                }
            }
            // Rule 6: a wire joins nodes — live or in the trash; a ghost's has no `to`.
            let LoroValue::Map(edges) = shard.get_map("edge").get_value() else {
                continue;
            };
            for (key, v) in edges.iter() {
                let v = Val::from_loro(v);
                for end in ["from", "to"] {
                    let Some(id) = v.as_ref().and_then(|v| v.get(end)).and_then(Val::as_str) else {
                        continue;
                    };
                    if NodeId::parse(id).map_or(true, |n| self.kind(n).is_none()) {
                        out.insert(format!("wire {key} ends at {id}, no node"));
                    }
                }
            }
        }
        // Rule 5: the nesting of live networks has no cycle.
        let children = self.children();
        let mut done: HashSet<NodeId> = HashSet::new();
        for &net in children.keys() {
            if !self.alive(net) || done.contains(&net) {
                continue;
            }
            let mut path: Vec<(NodeId, usize)> = vec![(net, 0)];
            let mut on_path: HashSet<NodeId> = HashSet::from([net]);
            while let Some(&mut (at, ref mut next)) = path.last_mut() {
                let kids: Vec<NodeId> = children
                    .get(&at)
                    .map(|k| {
                        k.iter()
                            .copied()
                            .filter(|&c| canvas(c) && self.alive(c))
                            .collect()
                    })
                    .unwrap_or_default();
                if let Some(&child) = kids.get(*next) {
                    *next += 1;
                    if on_path.contains(&child) {
                        out.insert(format!("{} lies inside itself", child.to_text()));
                    } else if !done.contains(&child) {
                        on_path.insert(child);
                        path.push((child, 0));
                    }
                } else {
                    on_path.remove(&at);
                    done.insert(at);
                    path.pop();
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
