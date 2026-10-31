//! An import as a long task (13 §3.3, 10 §3.3, 15 §3.7). It is planned at
//! once on a shadow of the workspace, off the workspace's lock: the vault
//! read, its links found by the rule of 13 §3.5, `L` done. Then it is
//! written in batches — the networks first, then the files network by
//! network, each batch one transaction of the store — all carrying one
//! changeset with the origin `import`, `in-progress` until the last batch.
//! The workspace takes no other change meanwhile, so the import stays one
//! changeset and one step of undo (13 §1.4 item 3). Cancelled, it is taken
//! back whole; broken off by the app's end, it waits on the next opening
//! for «Откатить» or «Оставить» (NFR-71).

use super::import::{ImportOptions, ImportReport, Plan};
use super::{CoreError, Result, Store, Tx, Val, Workspace, engine, invalid, load};
use crate::MemoryStore;
use crate::changeset::{Changeset, KeyWrite, Label};
use crate::store::{Status, StoreError};
use crate::vault::Vault;
use loro::{ExportMode, VersionVector};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;
use strata_model::{ChangesetId, ChangesetOrigin, NodeId};

/// What an import has written (13 §3.3): «Импорт: 1 840 из 3 200».
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportProgress {
    /// Files of the vault written so far.
    pub done: u32,
    /// Files the import brings; 0 while it is being planned.
    pub total: u32,
    /// The report (13 §3.6), once the last batch is in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub report: Option<ImportReport>,
}

/// An import under way.
pub(super) enum Job {
    /// The shadow is out: the plan is being made.
    Planning,
    Writing(Box<Writing>),
}

/// An import being written.
pub(super) struct Writing {
    /// The changeset every batch carries; its writes are in `written`.
    header: Changeset,
    plan: Plan,
    /// The next batch.
    next: usize,
    done: u32,
    total: u32,
    /// What the batches wrote: the step of undo the import becomes.
    written: Vec<KeyWrite>,
    vault: Arc<Vault>,
    /// The vault's files by path, for the assets.
    paths: Arc<HashMap<String, usize>>,
    /// A batch taken out to be made ready, not written yet.
    out: bool,
}

impl Writing {
    fn progress(&self) -> ImportProgress {
        ImportProgress {
            done: self.done,
            total: self.total,
            report: None,
        }
    }
}

/// A shadow of the workspace to plan an import on, off its lock (13 §3.3).
pub struct ImportShadow {
    ws: Workspace<MemoryStore>,
    target: NodeId,
}

impl ImportShadow {
    /// The plan: the vault read, its links found, `L` done — the long part
    /// of an import, and it needs no lock.
    pub fn plan(mut self, vault: Vault, options: &ImportOptions) -> Result<PlannedImport> {
        let plan = self.ws.plan_vault(&vault, self.target, options)?;
        Ok(PlannedImport { plan, vault })
    }
}

/// An import planned, its batches to be written.
pub struct PlannedImport {
    plan: Plan,
    vault: Vault,
}

/// A batch out of the plan, to be made ready off the workspace's lock.
pub struct ImportBatch {
    index: usize,
    writes: Vec<KeyWrite>,
    contents: Vec<super::import::Content>,
    assets: Vec<(NodeId, String)>,
    vault: Arc<Vault>,
    paths: Arc<HashMap<String, usize>>,
    config: crate::vault::Config,
}

impl ImportBatch {
    /// Its content documents as snapshots and its assets' bytes, read from
    /// the vault — the part of a batch that needs no lock.
    pub fn prepare(self) -> Result<ReadyBatch> {
        let mut docs = Vec::with_capacity(self.contents.len());
        for c in &self.contents {
            let doc = format!("content/{}", c.node.to_text());
            docs.push((doc, c.snapshot(&self.vault, &self.config)?));
        }
        let mut assets = Vec::with_capacity(self.assets.len());
        for (node, path) in &self.assets {
            let Some(&f) = self.paths.get(path) else {
                continue;
            };
            let bytes = self
                .vault
                .bytes_of(&self.vault.files[f])
                .map_err(|e| CoreError::Store(StoreError::Io(format!("{path}: {e}"))))?;
            assets.push((*node, bytes.into_owned()));
        }
        Ok(ReadyBatch {
            index: self.index,
            writes: self.writes,
            docs,
            assets,
        })
    }
}

/// A batch ready to be written under the lock.
pub struct ReadyBatch {
    index: usize,
    writes: Vec<KeyWrite>,
    docs: Vec<(String, Vec<u8>)>,
    assets: Vec<(NodeId, Vec<u8>)>,
}

impl std::fmt::Debug for ImportBatch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ImportBatch")
            .field("index", &self.index)
            .finish_non_exhaustive()
    }
}

impl std::fmt::Debug for ReadyBatch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ReadyBatch")
            .field("index", &self.index)
            .finish_non_exhaustive()
    }
}

impl std::fmt::Debug for ImportShadow {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ImportShadow")
            .field("target", &self.target.to_text())
            .finish_non_exhaustive()
    }
}

impl std::fmt::Debug for PlannedImport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PlannedImport")
            .field("batches", &self.plan.writes.len())
            .field("files", &self.plan.files.iter().sum::<u32>())
            .finish_non_exhaustive()
    }
}

impl<S: Store> Workspace<S> {
    /// An import into network `net` (the root when none) starts: from now on
    /// the workspace takes no other change; the shadow to plan it on comes
    /// back.
    pub fn import_start(&mut self, net: Option<&str>) -> Result<ImportShadow> {
        self.writable()?;
        let target = match net {
            Some(n) => self.network(n)?,
            None => self.root,
        };
        let ws = self.shadow(&[format!("net/{}", target.to_text())])?;
        self.job = Some(Box::new(Job::Planning));
        Ok(ImportShadow { ws, target })
    }

    /// The plan is made: its batches begin. An import cancelled while it was
    /// planned does not.
    pub fn import_begin(&mut self, planned: PlannedImport) -> Result<ImportProgress> {
        if !matches!(self.job.as_deref(), Some(Job::Planning)) {
            return Err(invalid("no import is being planned"));
        }
        let PlannedImport { plan, vault } = planned;
        let header = Changeset {
            id: ChangesetId::new().to_text(),
            ts: (self.clock)(),
            origin: ChangesetOrigin::Import,
            label: plan.label.clone(),
            reverts: None,
            writes: Vec::new(),
        };
        let paths = vault
            .files
            .iter()
            .enumerate()
            .map(|(i, f)| (f.path.trim_start_matches('/').to_owned(), i))
            .collect();
        let w = Writing {
            header,
            total: plan.files.iter().sum(),
            plan,
            next: 0,
            done: 0,
            written: Vec::new(),
            vault: Arc::new(vault),
            paths: Arc::new(paths),
            out: false,
        };
        let p = w.progress();
        self.job = Some(Box::new(Job::Writing(Box::new(w))));
        Ok(p)
    }

    /// The next batch, one transaction of the store (13 §3.3): taken,
    /// made ready and written in one go. The last one closes the changeset,
    /// makes the import one step of undo and gives the report. A batch
    /// that does not go in takes the import back with it.
    pub fn import_step(&mut self) -> Result<ImportProgress> {
        let batch = self.import_take()?;
        let ready = match batch.prepare() {
            Ok(r) => r,
            Err(e) => {
                self.import_cancel()?;
                return Err(e);
            }
        };
        self.import_put(ready)
    }

    /// The next batch out of the plan, to be made ready off the lock
    /// ([`ImportBatch::prepare`]): its content documents are built and its
    /// assets read there, so the lock is held only to write it.
    pub fn import_take(&mut self) -> Result<ImportBatch> {
        let w = match self.job.as_deref_mut() {
            Some(Job::Writing(w)) if !w.out && w.next < w.plan.writes.len() => w,
            Some(Job::Planning) => return Err(invalid("the import is still being planned")),
            _ => return Err(invalid("no import is under way")),
        };
        let i = w.next;
        w.out = true;
        Ok(ImportBatch {
            index: i,
            writes: std::mem::take(&mut w.plan.writes[i]),
            contents: std::mem::take(&mut w.plan.contents[i]),
            assets: std::mem::take(&mut w.plan.assets[i]),
            vault: Arc::clone(&w.vault),
            paths: Arc::clone(&w.paths),
            config: w.plan.config.clone(),
        })
    }

    /// Writes a batch made ready: its assets, then its keys and documents in
    /// one transaction. The last one ends the import (see [`Self::import_step`]).
    pub fn import_put(&mut self, ready: ReadyBatch) -> Result<ImportProgress> {
        let Some(job) = self.job.take() else {
            return Err(invalid("no import is under way"));
        };
        let mut w = match *job {
            Job::Writing(w) if w.out && w.next == ready.index => w,
            other => {
                self.job = Some(Box::new(other));
                return Err(invalid("not the import's next batch"));
            }
        };
        if let Err(e) = self.write_batch(&mut w, ready) {
            let _ = self.take_back(*w);
            return Err(e);
        }
        if w.next < w.plan.writes.len() {
            let p = w.progress();
            self.job = Some(Box::new(Job::Writing(w)));
            return Ok(p);
        }
        self.store.close(&w.header.id, Status::Applied)?;
        let Writing {
            header,
            plan,
            done,
            total,
            written,
            ..
        } = *w;
        let step = Changeset {
            writes: written,
            ..header
        };
        // Notes already here whose links the new names answer (05 §8.5).
        self.links_after_but(&step, false, &plan.notes)?;
        if !step.writes.is_empty() {
            self.undo.push(step);
            self.redo.clear();
        }
        Ok(ImportProgress {
            done,
            total,
            report: Some(plan.report),
        })
    }

    /// The import stops and is taken back whole (13 §3.3 «Отмена»).
    pub fn import_cancel(&mut self) -> Result<()> {
        let Some(job) = self.job.take() else {
            return Ok(());
        };
        match *job {
            Job::Planning => Ok(()),
            Job::Writing(w) => self.take_back(*w),
        }
    }

    /// Where the import stands; none when there is none.
    pub fn import_progress(&self) -> Option<ImportProgress> {
        match self.job.as_deref()? {
            Job::Planning => Some(ImportProgress {
                done: 0,
                total: 0,
                report: None,
            }),
            Job::Writing(w) => Some(w.progress()),
        }
    }

    /// A vault into network `net` (the root when none), all at once: the
    /// same plan and batches, one after another. One changeset with the
    /// origin `import` and one step of undo; the report back (13 §3.6).
    pub fn import_vault(
        &mut self,
        vault: Vault,
        net: Option<&str>,
        options: &ImportOptions,
    ) -> Result<ImportReport> {
        let shadow = self.import_start(net)?;
        let planned = match shadow.plan(vault, options) {
            Ok(p) => p,
            Err(e) => {
                self.job = None;
                return Err(e);
            }
        };
        self.import_begin(planned)?;
        loop {
            if let Some(report) = self.import_step()?.report {
                return Ok(report);
            }
        }
    }

    /// A long task the app left in the middle (10 §3.3, NFR-71): its label,
    /// for the question «Откатить или оставить?».
    pub fn interrupted(&self) -> Option<Label> {
        self.interrupted.as_ref().map(|c| c.label.clone())
    }

    /// «Откатить» (`keep` false): what the task wrote goes, as a changeset
    /// of its own. «Оставить»: it stays as it is, and the notes it brought
    /// take up their links again — the files that never came are ghosts.
    pub fn settle_interrupted(&mut self, keep: bool) -> Result<()> {
        let Some(cs) = self.interrupted.take() else {
            return Ok(());
        };
        if !keep {
            return self.revert_long(cs);
        }
        self.store.close(&cs.id, Status::Applied)?;
        let note = Some(Val::str("note"));
        let notes: BTreeSet<NodeId> = cs
            .writes
            .iter()
            .filter(|w| w.doc.starts_with("index/") && w.map == "kind" && w.after == note)
            .filter_map(|w| NodeId::parse(&w.key).ok())
            .collect();
        self.relink(&notes)?;
        Ok(())
    }

    /// Writes batch `w.next`, made ready: the assets' bytes first (10 §11),
    /// then its keys and its content documents in one transaction.
    fn write_batch(&mut self, w: &mut Writing, ready: ReadyBatch) -> Result<()> {
        let ReadyBatch {
            index,
            writes: keys,
            docs,
            assets,
        } = ready;
        let mut writes: Vec<(String, String, String, Option<Val>)> = keys
            .into_iter()
            .map(|k| (k.doc, k.map, k.key, k.after))
            .collect();
        for (node, bytes) in &assets {
            let sha = self.put_asset(bytes)?;
            // The field as `SetAttr` keeps it (05 §4.4): `attr`, `{id}|asset`.
            let key = format!("{}|asset", node.to_text());
            writes.push((
                self.index_doc(*node),
                "attr".to_owned(),
                key,
                Some(Val::str(sha)),
            ));
        }
        for (doc, ..) in &writes {
            self.ensure_doc(doc)?;
        }
        let mut tx = Tx {
            docs: &mut self.docs,
            before: HashMap::new(),
            writes: Vec::new(),
        };
        let built = writes
            .into_iter()
            .try_for_each(|(doc, map, key, value)| tx.set(&doc, &map, &key, value));
        let Tx { before, writes, .. } = tx;
        let part = self.finish_part(&w.header, before, writes, docs, built)?;
        w.written.extend(part);
        w.done += w.plan.files[index];
        w.next += 1;
        w.out = false;
        Ok(())
    }

    /// Commits a part of a long task's changeset (10 §3.3): its keys and the
    /// content documents it gives whole, in one transaction; or, when it
    /// failed, takes its keys back out of memory.
    fn finish_part(
        &mut self,
        header: &Changeset,
        before: HashMap<String, VersionVector>,
        writes: Vec<KeyWrite>,
        docs: Vec<(String, Vec<u8>)>,
        built: Result<()>,
    ) -> Result<Vec<KeyWrite>> {
        let mut done = built.and_then(|()| {
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
            for (doc, _) in &docs {
                // The document is new: none stale stays in memory.
                self.docs.remove(doc);
            }
            updates.extend(docs);
            let part = Changeset {
                writes,
                ..header.clone()
            };
            self.store.commit_part(&part, &updates)?;
            Ok(part.writes)
        });
        if done.is_err() {
            // The documents in memory go back to the store's state (10 §3.3).
            for doc in before.keys() {
                match load(&self.store, doc) {
                    Ok(d) => {
                        self.docs.insert(doc.clone(), d.unwrap_or_default());
                    }
                    Err(e) => done = Err(e),
                }
            }
        }
        done
    }

    /// An import that stops in the middle: what its batches wrote goes.
    fn take_back(&mut self, w: Writing) -> Result<()> {
        self.job = None;
        if w.next == 0 {
            // Nothing reached the store.
            return Ok(());
        }
        self.revert_long(Changeset {
            writes: w.written,
            ..w.header
        })
    }

    /// Reverts a long task's changeset as a changeset of its own (10 §9.3)
    /// and closes it `reverted`.
    fn revert_long(&mut self, cs: Changeset) -> Result<()> {
        let (back, _) = self.revert(&cs)?;
        self.store.close(&cs.id, Status::Reverted)?;
        self.links_after(&back, false)?;
        Ok(())
    }
}
