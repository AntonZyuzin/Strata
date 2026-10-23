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
use std::collections::BTreeMap;

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
    /// Every changeset, oldest first.
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
}

/// A store in memory: the same contract, nothing on disk. The browser
/// build keeps it between sessions as bytes ([`MemoryStore::to_bytes`]).
#[derive(Debug, Default)]
pub struct MemoryStore {
    docs: BTreeMap<String, StoredDoc>,
    changesets: Vec<Changeset>,
}

/// [`MemoryStore`] as JSON: updates in base64.
#[derive(Serialize, Deserialize)]
struct Dump {
    docs: BTreeMap<String, Vec<String>>,
    changesets: Vec<Changeset>,
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
        Ok(Self {
            docs,
            changesets: dump.changesets,
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
}
