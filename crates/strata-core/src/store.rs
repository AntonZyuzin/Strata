//! Where a workspace's documents and changesets live (10 §3.2): a store
//! behind a trait. `MemoryStore` keeps them in memory (tests, the browser
//! build); the SQLite store of the workspace folder implements the same
//! trait.
//!
//! One changeset is one commit: the updates of every document it touched
//! and the changeset itself, all or nothing (10 §3.3).

use crate::changeset::Changeset;
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
}

/// A store in memory: the same contract, nothing on disk.
#[derive(Debug, Default)]
pub struct MemoryStore {
    docs: BTreeMap<String, StoredDoc>,
    changesets: Vec<Changeset>,
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
}
