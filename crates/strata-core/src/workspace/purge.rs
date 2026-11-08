//! The trash's term (05 §11, 10 §10.3–10.4): a node in the trash longer
//! than 30 days goes for good. Only the leading core does it — here, the
//! core of a local workspace, when it opens it, so no step of undo reaches
//! back past it. Its keys go from the index: its fields, its placements and
//! the placements inside it, its wires either way; its layout goes from the
//! networks it lay in; its own documents — the content and, for a network,
//! the layout — go with their history. Its id goes into `sys.purged` and is
//! never made again (05 §14 rule 1). The changeset is the system's.

use super::{ChangesetOrigin, Label, NodeId, Result, Store, Val, Workspace, read};
use loro::LoroValue;
use std::collections::{BTreeSet, HashSet};

/// Days a node stays in the trash before it goes for good (05 §11).
pub const TRASH_DAYS: i64 = 30;
const DAY_MS: i64 = 86_400_000;

impl<S: Store> Workspace<S> {
    /// The nodes in the trash longer than its term, gone for good (10
    /// §10.4): their ids. Nothing expired — nothing written.
    pub fn purge_expired(&mut self) -> Result<Vec<String>> {
        let cut = (self.clock)() - TRASH_DAYS * DAY_MS;
        let mut gone: Vec<NodeId> = Vec::new();
        for shard in self.index_shards() {
            let LoroValue::Map(m) = shard.get_map("trashedAt").get_value() else {
                continue;
            };
            for (id, v) in m.iter() {
                let at = Val::from_loro(v).and_then(|v| v.as_i64());
                if let (Some(at), Ok(n)) = (at, NodeId::parse(id))
                    && at <= cut
                    && n != self.root
                {
                    gone.push(n);
                }
            }
        }
        if gone.is_empty() {
            return Ok(Vec::new());
        }
        gone.sort();
        self.purge(&gone)?;
        Ok(gone.iter().map(|n| n.to_text()).collect())
    }

    /// Node `id` in the trash gone for good now, with what went in its step
    /// (05 §5): the property tests' purge, the term aside.
    #[cfg(test)]
    pub(crate) fn purge_now(&mut self, id: &str) -> Result<Vec<String>> {
        let n = self.parse(id)?;
        if self.field(n, "trashedAt").is_none() {
            return Err(super::invalid(format!("node {id} is not in the trash")));
        }
        let gone = self.trashed_with(n);
        self.purge(&gone)?;
        Ok(gone.iter().map(|n| n.to_text()).collect())
    }

    /// Whether node `id` went for good (10 §10.4): its id is not to be made again.
    pub(crate) fn purged(&self, id: &str) -> bool {
        read(&self.docs["sys"], "purged", id).is_some()
    }

    /// Nodes in the trash gone for good: one changeset of the system,
    /// outside undo; the steps of undo before it go, as they would bring
    /// back keys of what is gone.
    fn purge(&mut self, gone: &[NodeId]) -> Result<()> {
        let ids: HashSet<String> = gone.iter().map(|n| n.to_text()).collect();
        // The networks whose layout holds them, and their wires either way.
        let mut nets: BTreeSet<String> = BTreeSet::new();
        let mut wires: HashSet<String> = HashSet::new();
        for shard in self.index_shards() {
            if let LoroValue::Map(m) = shard.get_map("placement").get_value() {
                for key in m.keys() {
                    if let Some((net, node)) = key.split_once('/')
                        && ids.contains(node)
                        && !ids.contains(net)
                    {
                        nets.insert(net.to_owned());
                    }
                }
            }
            if let LoroValue::Map(m) = shard.get_map("edge").get_value() {
                for (key, v) in m.iter() {
                    let v = Val::from_loro(v);
                    let end = |k: &str| {
                        v.as_ref()
                            .and_then(|v| v.get(k))
                            .and_then(Val::as_str)
                            .is_some_and(|id| ids.contains(id))
                    };
                    if end("from") || end("to") {
                        wires.insert(key.clone());
                    }
                }
            }
        }
        for net in &nets {
            self.ensure_doc(&format!("net/{net}"))?;
        }
        // A key is theirs: their id, `id|…` (fields, flags, assignees),
        // `net/id` and `id/node` (placements), a wire of theirs and its `wire|…`.
        let theirs = |key: &str| {
            let head = key.split_once('|').map_or(key, |(h, _)| h);
            if ids.contains(head) || wires.contains(head) {
                return true;
            }
            key.split_once('/')
                .is_some_and(|(net, node)| ids.contains(net) || ids.contains(node))
        };
        let mut docs: Vec<String> = (0..self.k).map(|k| format!("index/0/{k}")).collect();
        docs.extend(nets.iter().map(|net| format!("net/{net}")));
        let mut deletes: Vec<(String, String, String)> = Vec::new();
        for doc in &docs {
            let Some(d) = self.docs.get(doc) else {
                continue;
            };
            let LoroValue::Map(root) = d.get_deep_value() else {
                continue;
            };
            for (map, entries) in root.iter() {
                let LoroValue::Map(entries) = entries else {
                    continue;
                };
                for key in entries.keys() {
                    if theirs(key) {
                        deletes.push((doc.clone(), map.clone(), key.clone()));
                    }
                }
            }
        }
        let now = (self.clock)();
        let mut purged: Vec<&String> = ids.iter().collect();
        purged.sort();
        self.write(
            ChangesetOrigin::System,
            Label::new("core.change.purge"),
            |tx| {
                for (doc, map, key) in &deletes {
                    tx.set(doc, map, key, None)?;
                }
                for id in &purged {
                    tx.set("sys", "purged", id, Some(Val::Int(now)))?;
                }
                Ok(())
            },
        )?;
        // Their own documents, with their history.
        let own: Vec<String> = purged
            .iter()
            .flat_map(|id| [format!("content/{id}"), format!("net/{id}")])
            .collect();
        for doc in &own {
            self.docs.remove(doc);
        }
        self.store.drop_docs(&own)?;
        self.undo.clear();
        self.redo.clear();
        Ok(())
    }
}
