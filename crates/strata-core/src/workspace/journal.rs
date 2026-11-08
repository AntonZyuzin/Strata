//! «История изменений» (06 §1.2, 10 §9.3–9.4): the journal of the
//! workspace's changesets as its window lists them, the newest first, and
//! the revert of any of them. Locally the one person in the workspace may
//! revert any changeset (10 §9.4); the revert is a new changeset of the
//! user and a step of undo, so `Ctrl+Z` takes it back. The undo stack keeps
//! 200 steps (06 §1.2, 10 §9.2).

use super::{
    Changeset, ChangesetOrigin, KeyWrite, Label, NodeId, Result, RevertReport, Store, Val,
    Workspace, invalid, read,
};
use crate::store::{ChangesetHead, Status};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap, HashSet};

/// Steps of undo kept, the oldest let go first (06 §1.2).
pub const UNDO_DEPTH: usize = 200;

/// Another changeset a row names: its id, time and label.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct JournalRef {
    pub id: String,
    pub ts: i64,
    pub label: Label,
}

/// What a row is: a step, an undo of one, a redo — the undo taken back —,
/// or «Откатить» from the journal.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JournalKind {
    Step,
    Undo,
    Redo,
    Revert,
}

/// A row of «История изменений».
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalEntry {
    pub id: String,
    pub ts: i64,
    pub origin: ChangesetOrigin,
    pub label: Label,
    pub kind: JournalKind,
    /// The changeset this one reverts: an undo, a redo, a revert.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reverts: Option<JournalRef>,
    /// The revert that stands over this one: it is taken back.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reverted_by: Option<JournalRef>,
    /// Why it cannot be reverted: `in-progress` — a long task under way;
    /// `reverted` — it is taken back already (its revert can be); `purge` —
    /// a node gone for good does not come back (10 §10.4); `derived` — the
    /// core's own following of texts and pages (text wires, a link's
    /// preview), which would only follow them again; `workspace` — the
    /// workspace's own making, its root and its id. None — it can.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fixed: Option<String>,
}

/// A page of the journal, the newest first; `more` — older rows follow.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Journal {
    pub entries: Vec<JournalEntry>,
    pub more: bool,
}

/// Who reverts whom in the journal: for each changeset the newest one that
/// reverts it. A changeset is taken back when its chain of reverts is odd:
/// undone, redone, undone again (10 §9.3 «Redo — откат отката»).
struct Reverts<'a> {
    by: HashMap<&'a str, &'a ChangesetHead>,
}

impl<'a> Reverts<'a> {
    fn of(heads: &'a [ChangesetHead]) -> Self {
        let mut by = HashMap::new();
        for h in heads {
            if let Some(r) = &h.reverts {
                by.insert(r.as_str(), h);
            }
        }
        Self { by }
    }

    /// The revert that stands over `id`, if it is taken back.
    fn standing(&self, id: &str) -> Option<&'a ChangesetHead> {
        let first = *self.by.get(id)?;
        let mut odd = true;
        let mut at = first.id.as_str();
        while let Some(next) = self.by.get(at) {
            odd = !odd;
            at = next.id.as_str();
        }
        odd.then_some(first)
    }
}

fn reference(h: &ChangesetHead) -> JournalRef {
    JournalRef {
        id: h.id.clone(),
        ts: h.ts,
        label: h.label.clone(),
    }
}

/// The core's changesets that follow what others wrote: text wires after
/// a text (05 §8.2 rule 4), a link's preview after its page (ADR-0012).
const DERIVED: [&str; 2] = ["core.change.links", "core.change.preview"];

/// Why changeset `h` cannot be reverted, if so.
fn fixed(h: &ChangesetHead, reverts: &Reverts) -> Option<&'static str> {
    if h.status == Status::InProgress {
        Some("in-progress")
    } else if h.label.key == "core.change.purge" {
        Some("purge")
    } else if DERIVED.contains(&h.label.key.as_str()) {
        Some("derived")
    } else if ["core.change.create", "core.change.copy"].contains(&h.label.key.as_str()) {
        Some("workspace")
    } else if h.status == Status::Reverted || reverts.standing(&h.id).is_some() {
        Some("reverted")
    } else {
        None
    }
}

/// The node ids a key write is about (10 §2.3–2.4): a field's node, a
/// placement's network and node, a wire's ends — `ends`, by wire id —, a
/// network layout's network and node, a content document's node.
fn ids_of<'a>(w: &'a KeyWrite, ends: &dyn Fn(&str, &str) -> Vec<String>) -> Vec<String> {
    if w.doc.starts_with("index/") {
        return match w.map.as_str() {
            "edge" => [&w.before, &w.after]
                .into_iter()
                .flatten()
                .flat_map(|v| ["from", "to"].map(|k| v.get(k).and_then(Val::as_str)))
                .flatten()
                .map(str::to_owned)
                .collect(),
            "edgeLabel" | "edgeOrigin" => {
                let wire = w.key.split('|').next().unwrap_or_default();
                ends(&w.doc, wire)
            }
            "placement" => w.key.split('/').map(str::to_owned).collect(),
            _ => vec![w.key.split('|').next().unwrap_or_default().to_owned()],
        };
    }
    if let Some(net) = w.doc.strip_prefix("net/") {
        return match w.map.as_str() {
            "pos" | "size" | "collapsed" | "pinned" => vec![net.to_owned(), w.key.clone()],
            _ => vec![net.to_owned()],
        };
    }
    w.doc
        .strip_prefix("content/")
        .map(|id| vec![id.to_owned()])
        .unwrap_or_default()
}

impl<S: Store> Workspace<S> {
    /// A step of undo (05 §11): the redo goes; past 200 the oldest step goes.
    pub(super) fn step(&mut self, cs: Changeset) {
        self.push_undo(cs);
        self.redo.clear();
    }

    /// On the undo stack, 200 at most: a redo's step, an amended gesture's.
    pub(super) fn push_undo(&mut self, cs: Changeset) {
        self.undo.push(cs);
        if self.undo.len() > UNDO_DEPTH {
            self.undo.remove(0);
        }
    }

    /// A page of the journal, the newest first: at most `limit` rows, older
    /// than row `before` when it is given.
    pub fn journal(&self, before: Option<&str>, limit: usize) -> Result<Journal> {
        let heads = self.store.heads()?;
        let by_id: HashMap<&str, &ChangesetHead> =
            heads.iter().map(|h| (h.id.as_str(), h)).collect();
        let reverts = Reverts::of(&heads);
        let mut newest = heads.iter().rev();
        if let Some(b) = before {
            if !by_id.contains_key(b) {
                return Err(invalid(format!("no changeset {b} in the journal")));
            }
            for h in newest.by_ref() {
                if h.id == b {
                    break;
                }
            }
        }
        // Oldest first, each by what it reverts: «Откатить» relabels it
        // «Откат: …»; reverting an undo puts the step back — a redo; any
        // other revert under the same label is an undo.
        let mut kinds: HashMap<&str, JournalKind> = HashMap::new();
        for h in &heads {
            let kind = match h.reverts.as_deref() {
                None => JournalKind::Step,
                Some(r) => match by_id.get(r) {
                    Some(t) if t.label != h.label => JournalKind::Revert,
                    Some(t) if kinds.get(t.id.as_str()) == Some(&JournalKind::Undo) => {
                        JournalKind::Redo
                    }
                    _ => JournalKind::Undo,
                },
            };
            kinds.insert(h.id.as_str(), kind);
        }
        let kind = |h: &ChangesetHead| {
            kinds
                .get(h.id.as_str())
                .copied()
                .unwrap_or(JournalKind::Step)
        };
        let entries: Vec<JournalEntry> = newest
            .by_ref()
            .take(limit)
            .map(|h| JournalEntry {
                id: h.id.clone(),
                ts: h.ts,
                origin: h.origin.clone(),
                label: h.label.clone(),
                kind: kind(h),
                reverts: h
                    .reverts
                    .as_deref()
                    .and_then(|r| by_id.get(r))
                    .map(|r| reference(r)),
                reverted_by: reverts.standing(&h.id).map(reference),
                fixed: fixed(h, &reverts).map(str::to_owned),
            })
            .collect();
        Ok(Journal {
            entries,
            more: newest.next().is_some(),
        })
    }

    /// The ends of wire `wire` of index document `doc`, as the index has it.
    fn wire_ends(&self, doc: &str, wire: &str) -> Vec<String> {
        let Some(v) = self.docs.get(doc).and_then(|d| read(d, "edge", wire)) else {
            return Vec::new();
        };
        ["from", "to"]
            .iter()
            .filter_map(|k| v.get(k).and_then(Val::as_str).map(str::to_owned))
            .collect()
    }

    /// The ids changeset `cs` is about, each once, in the order it touched
    /// them; a wire's ends from its own writes first, the index after.
    fn ids_of_changeset(&self, cs: &Changeset) -> Vec<String> {
        let own: HashMap<&str, Vec<String>> = cs
            .writes
            .iter()
            .filter(|w| w.map == "edge")
            .map(|w| (w.key.as_str(), ids_of(w, &|_, _| Vec::new())))
            .collect();
        let ends = |doc: &str, wire: &str| {
            own.get(wire)
                .cloned()
                .unwrap_or_else(|| self.wire_ends(doc, wire))
        };
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        let texts = cs
            .texts
            .iter()
            .filter_map(|e| e.doc.strip_prefix("content/"));
        for id in cs
            .writes
            .iter()
            .flat_map(|w| ids_of(w, &ends))
            .chain(texts.map(str::to_owned))
        {
            if seen.insert(id.clone()) {
                out.push(id);
            }
        }
        out
    }

    /// The live nodes changeset `id` touched, in the order it touched them:
    /// «Показать» goes to the first (06 §1.2). The root is one only when
    /// nothing else is.
    pub fn changeset_nodes(&mut self, id: &str) -> Result<Vec<String>> {
        let cs = self
            .store
            .changeset(id)?
            .ok_or_else(|| invalid(format!("no changeset {id} in the journal")))?;
        for w in &cs.writes {
            self.ensure_doc(&w.doc)?;
        }
        let root = self.root.to_text();
        let mut live: Vec<String> = self
            .ids_of_changeset(&cs)
            .into_iter()
            .filter(|i| NodeId::parse(i).is_ok_and(|n| self.alive(n)))
            .collect();
        if live.len() > 1 {
            live.retain(|i| *i != root);
        }
        Ok(live)
    }

    /// The ids of nodes gone for good (10 §10.4).
    fn purged_ids(&self) -> HashSet<String> {
        match self.docs["sys"].get_map("purged").get_value() {
            loro::LoroValue::Map(m) => m.keys().cloned().collect(),
            _ => HashSet::new(),
        }
    }

    /// The writes of `plan` about a node gone for good, moved to `skipped`:
    /// a revert must not bring back a key of what is gone (10 §10.4).
    pub(super) fn keep_purged(
        &self,
        cs: &Changeset,
        plan: &mut Vec<KeyWrite>,
        skipped: &mut Vec<KeyWrite>,
    ) {
        let purged = self.purged_ids();
        if purged.is_empty() {
            return;
        }
        let own: HashMap<&str, Vec<String>> = cs
            .writes
            .iter()
            .filter(|w| w.map == "edge")
            .map(|w| (w.key.as_str(), ids_of(w, &|_, _| Vec::new())))
            .collect();
        let ends = |doc: &str, wire: &str| {
            own.get(wire)
                .cloned()
                .unwrap_or_else(|| self.wire_ends(doc, wire))
        };
        let (gone, kept): (Vec<KeyWrite>, Vec<KeyWrite>) = std::mem::take(plan)
            .into_iter()
            .partition(|w| ids_of(w, &ends).iter().any(|i| purged.contains(i)));
        *plan = kept;
        skipped.extend(gone);
    }

    /// «Откатить» (10 §9.3): changeset `id` of the journal reverted as a new
    /// changeset of the user, labelled «Откат: …», one step of undo. Keys
    /// someone changed since are skipped and reported. A long task under
    /// way, a changeset taken back already, a purge — refused.
    pub fn revert_changeset(&mut self, id: &str) -> Result<RevertReport> {
        self.writable()?;
        let heads = self.store.heads()?;
        let reverts = Reverts::of(&heads);
        let head = heads
            .iter()
            .find(|h| h.id == id)
            .ok_or_else(|| invalid(format!("no changeset {id} in the journal")))?;
        if let Some(why) = fixed(head, &reverts) {
            return Err(invalid(format!("changeset {id} cannot be reverted: {why}")));
        }
        let cs = self
            .store
            .changeset(id)?
            .ok_or_else(|| invalid(format!("no changeset {id} in the journal")))?;
        let mut params = serde_json::Map::new();
        params.insert(
            "of".to_owned(),
            serde_json::to_value(&cs.label).map_err(|e| invalid(e.to_string()))?,
        );
        let label = Label {
            key: "core.change.revert".to_owned(),
            params,
        };
        let (plan, skipped) = self.revert_plan(&cs)?;
        // Nothing left to take back: nothing is written, and the changeset
        // is not marked as reverted.
        if plan.is_empty() && cs.texts.is_empty() {
            return Ok(RevertReport {
                skipped,
                nothing: true,
            });
        }
        // A later change may stand on what it takes away: tried on a copy first.
        self.try_revert(&plan)?;
        let (back, report) =
            self.revert_with(&cs, (ChangesetOrigin::User, label), plan, skipped)?;
        self.links_after(&back, true)?;
        // Text wires follow the texts (05 §14 rule 7): the notes it touched
        // say again which of their wires stay.
        let touched: BTreeSet<NodeId> = self
            .ids_of_changeset(&back)
            .iter()
            .filter_map(|i| NodeId::parse(i).ok())
            .collect();
        self.relink(&touched)?;
        self.step(back);
        Ok(report)
    }
}
