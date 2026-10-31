//! Where a workspace's documents and changesets live (10 §3.2): a store
//! behind a trait. `MemoryStore` keeps them in memory (tests, the browser
//! build); the SQLite store of the workspace folder implements the same
//! trait.
//!
//! One changeset is one commit: the updates of every document it touched
//! and the changeset itself, all or nothing (10 §3.3).

use crate::changeset::Changeset;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

/// Where a changeset stands (10 §9.1).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    /// A long task's changeset while its parts are being written.
    InProgress,
    Applied,
    Reverted,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InProgress => "in-progress",
            Self::Applied => "applied",
            Self::Reverted => "reverted",
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("storage: {0}")]
    Io(String),
}

/// A document as stored: a snapshot and the updates after it, in order.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct StoredDoc {
    pub snapshot: Option<Vec<u8>>,
    pub updates: Vec<Vec<u8>>,
}

pub trait Store {
    /// A document by its id (`manifest`, `sys`, `index/0/3`, `net/<id>`, `content/<id>`).
    fn load(&self, doc_id: &str) -> Result<Option<StoredDoc>, StoreError>;
    /// The updates of one changeset and the changeset, in one transaction.
    fn commit(
        &mut self,
        changeset: &Changeset,
        updates: &[(String, Vec<u8>)],
    ) -> Result<(), StoreError>;
    /// A part of a long task's changeset (10 §3.3): its updates and its
    /// writes (`changeset.writes` — this part's only) in one transaction.
    /// The first part opens the changeset as `in-progress`; every part
    /// carries its id; it stays in progress until [`Store::close`].
    fn commit_part(
        &mut self,
        changeset: &Changeset,
        updates: &[(String, Vec<u8>)],
    ) -> Result<(), StoreError>;
    /// A long task's changeset ends: `applied` — every part is written,
    /// `reverted` — taken back after it broke off (10 §9.1, §9.3).
    fn close(&mut self, id: &str, status: Status) -> Result<(), StoreError>;
    /// Changesets a long task left `in-progress`, every part's writes in
    /// them: the app stopped in the middle (10 §3.3, NFR-71).
    fn unfinished(&self) -> Result<Vec<Changeset>, StoreError>;
    /// Every changeset, oldest first; a long one with all its parts' writes.
    fn changesets(&self) -> Result<Vec<Changeset>, StoreError>;
    /// An update of a content document outside any changeset: an editor's
    /// typing (15 §3.4), which has its own undo.
    fn append(&mut self, doc_id: &str, update: &[u8], ts: i64) -> Result<(), StoreError>;
    /// Every document in the store: an archive takes them all (10 §3.5).
    fn doc_ids(&self) -> Result<Vec<String>, StoreError>;
    /// The documents (as snapshots) and the journal of an archive, into an
    /// empty store, at once.
    fn restore(
        &mut self,
        docs: &[(String, Vec<u8>)],
        changesets: &[Changeset],
    ) -> Result<(), StoreError>;
    /// An asset (10 §11): bytes by their SHA-256, written once, never changed.
    fn put_asset(&mut self, sha: &str, bytes: &[u8]) -> Result<(), StoreError>;
    fn asset(&self, sha: &str) -> Result<Option<Vec<u8>>, StoreError>;
    /// Every asset's SHA-256: an archive takes them all.
    fn asset_ids(&self) -> Result<Vec<String>, StoreError>;
}

/// A store in memory: the same contract, nothing on disk. The browser
/// build keeps it between sessions as bytes ([`MemoryStore::to_bytes`]).
#[derive(Debug, Default)]
pub struct MemoryStore {
    docs: BTreeMap<String, StoredDoc>,
    changesets: Vec<Changeset>,
    /// Long tasks' changesets still in progress, by id.
    open: BTreeSet<String>,
    assets: BTreeMap<String, Vec<u8>>,
}

/// [`MemoryStore`] as JSON: updates and assets in base64.
#[derive(Serialize, Deserialize)]
struct Dump {
    docs: BTreeMap<String, Vec<String>>,
    changesets: Vec<Changeset>,
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    open: BTreeSet<String>,
    #[serde(default)]
    assets: BTreeMap<String, String>,
}

impl MemoryStore {
    /// Everything in the store, for the browser to keep (IndexedDB).
    pub fn to_bytes(&self) -> Vec<u8> {
        let dump = Dump {
            docs: self
                .docs
                .iter()
                .map(|(id, d)| {
                    let all = d.snapshot.iter().chain(&d.updates);
                    (id.clone(), all.map(|b| B64.encode(b)).collect())
                })
                .collect(),
            changesets: self.changesets.clone(),
            open: self.open.clone(),
            assets: self
                .assets
                .iter()
                .map(|(sha, b)| (sha.clone(), B64.encode(b)))
                .collect(),
        };
        serde_json::to_vec(&dump).unwrap_or_default()
    }

    /// A store back from [`MemoryStore::to_bytes`].
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, StoreError> {
        let dump: Dump =
            serde_json::from_slice(bytes).map_err(|e| StoreError::Io(e.to_string()))?;
        let mut docs = BTreeMap::new();
        for (id, updates) in dump.docs {
            let updates = updates
                .iter()
                .map(|u| B64.decode(u).map_err(|e| StoreError::Io(e.to_string())))
                .collect::<Result<_, _>>()?;
            docs.insert(
                id,
                StoredDoc {
                    snapshot: None,
                    updates,
                },
            );
        }
        let mut assets = BTreeMap::new();
        for (sha, b) in dump.assets {
            assets.insert(
                sha,
                B64.decode(b).map_err(|e| StoreError::Io(e.to_string()))?,
            );
        }
        Ok(Self {
            docs,
            changesets: dump.changesets,
            open: dump.open,
            assets,
        })
    }
}

impl Store for MemoryStore {
    fn load(&self, doc_id: &str) -> Result<Option<StoredDoc>, StoreError> {
        Ok(self.docs.get(doc_id).cloned())
    }

    fn commit(
        &mut self,
        changeset: &Changeset,
        updates: &[(String, Vec<u8>)],
    ) -> Result<(), StoreError> {
        for (doc, bytes) in updates {
            self.docs
                .entry(doc.clone())
                .or_default()
                .updates
                .push(bytes.clone());
        }
        self.changesets.push(changeset.clone());
        Ok(())
    }

    fn commit_part(
        &mut self,
        changeset: &Changeset,
        updates: &[(String, Vec<u8>)],
    ) -> Result<(), StoreError> {
        for (doc, bytes) in updates {
            self.docs
                .entry(doc.clone())
                .or_default()
                .updates
                .push(bytes.clone());
        }
        match self.changesets.iter_mut().find(|c| c.id == changeset.id) {
            Some(c) => c.writes.extend(changeset.writes.iter().cloned()),
            None => {
                self.changesets.push(changeset.clone());
                self.open.insert(changeset.id.clone());
            }
        }
        Ok(())
    }

    fn close(&mut self, id: &str, _status: Status) -> Result<(), StoreError> {
        self.open.remove(id);
        Ok(())
    }

    fn unfinished(&self) -> Result<Vec<Changeset>, StoreError> {
        Ok(self
            .changesets
            .iter()
            .filter(|c| self.open.contains(&c.id))
            .cloned()
            .collect())
    }

    fn changesets(&self) -> Result<Vec<Changeset>, StoreError> {
        Ok(self.changesets.clone())
    }

    fn append(&mut self, doc_id: &str, update: &[u8], _ts: i64) -> Result<(), StoreError> {
        self.docs
            .entry(doc_id.to_owned())
            .or_default()
            .updates
            .push(update.to_vec());
        Ok(())
    }

    fn doc_ids(&self) -> Result<Vec<String>, StoreError> {
        Ok(self.docs.keys().cloned().collect())
    }

    fn restore(
        &mut self,
        docs: &[(String, Vec<u8>)],
        changesets: &[Changeset],
    ) -> Result<(), StoreError> {
        for (id, snapshot) in docs {
            self.docs.insert(
                id.clone(),
                StoredDoc {
                    snapshot: Some(snapshot.clone()),
                    updates: Vec::new(),
                },
            );
        }
        self.changesets.extend(changesets.iter().cloned());
        Ok(())
    }

    fn put_asset(&mut self, sha: &str, bytes: &[u8]) -> Result<(), StoreError> {
        self.assets
            .entry(sha.to_owned())
            .or_insert_with(|| bytes.to_vec());
        Ok(())
    }

    fn asset(&self, sha: &str) -> Result<Option<Vec<u8>>, StoreError> {
        Ok(self.assets.get(sha).cloned())
    }

    fn asset_ids(&self) -> Result<Vec<String>, StoreError> {
        Ok(self.assets.keys().cloned().collect())
    }
}
