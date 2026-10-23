//! `store.sqlite` of a workspace folder (10 §3.1–3.3): every CRDT document
//! of the workspace in one database, so a changeset that touches several
//! documents is one transaction. WAL with `synchronous = FULL`: writes are
//! small, one per gesture, and a crash keeps all of a changeset or none.

use crate::changeset::Changeset;
use crate::store::{Store, StoreError, StoredDoc};
use crate::workspace::{CoreError, Result, Workspace};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

fn io(e: impl std::fmt::Display) -> StoreError {
    StoreError::Io(e.to_string())
}

#[derive(Debug)]
pub struct SqliteStore {
    db: Connection,
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS docs (
  doc_id     TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  snapshot   BLOB,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS updates (
  local_seq INTEGER PRIMARY KEY,
  doc_id    TEXT NOT NULL,
  bytes     BLOB NOT NULL,
  changeset TEXT,
  ts        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS updates_doc ON updates (doc_id, local_seq);
CREATE TABLE IF NOT EXISTS changesets (
  id      TEXT PRIMARY KEY,
  ts      INTEGER NOT NULL,
  origin  TEXT NOT NULL,
  label   TEXT NOT NULL,
  reverts TEXT,
  status  TEXT NOT NULL,
  body    BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value BLOB);
";

impl SqliteStore {
    pub fn open(path: &Path) -> std::result::Result<Self, StoreError> {
        let db = Connection::open(path).map_err(io)?;
        db.pragma_update(None, "journal_mode", "WAL").map_err(io)?;
        db.pragma_update(None, "synchronous", "FULL").map_err(io)?;
        db.execute_batch(SCHEMA).map_err(io)?;
        Ok(Self { db })
    }

    /// A store in memory with the same tables (tests).
    pub fn in_memory() -> std::result::Result<Self, StoreError> {
        let db = Connection::open_in_memory().map_err(io)?;
        db.execute_batch(SCHEMA).map_err(io)?;
        Ok(Self { db })
    }
}

fn doc_kind(doc: &str) -> &str {
    doc.split('/').next().unwrap_or(doc)
}

impl Store for SqliteStore {
    fn load(&self, doc_id: &str) -> std::result::Result<Option<StoredDoc>, StoreError> {
        let snapshot: Option<Option<Vec<u8>>> = self
            .db
            .query_row(
                "SELECT snapshot FROM docs WHERE doc_id = ?1",
                params![doc_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(io)?;
        let mut stmt = self
            .db
            .prepare_cached("SELECT bytes FROM updates WHERE doc_id = ?1 ORDER BY local_seq")
            .map_err(io)?;
        let updates: Vec<Vec<u8>> = stmt
            .query_map(params![doc_id], |r| r.get(0))
            .map_err(io)?
            .collect::<rusqlite::Result<_>>()
            .map_err(io)?;
        if snapshot.is_none() && updates.is_empty() {
            return Ok(None);
        }
        Ok(Some(StoredDoc {
            snapshot: snapshot.flatten(),
            updates,
        }))
    }

    fn commit(
        &mut self,
        changeset: &Changeset,
        updates: &[(String, Vec<u8>)],
    ) -> std::result::Result<(), StoreError> {
        let tx = self.db.transaction().map_err(io)?;
        for (doc, bytes) in updates {
            tx.execute(
                "INSERT INTO docs (doc_id, kind, snapshot, updated_at) VALUES (?1, ?2, NULL, ?3)
                 ON CONFLICT (doc_id) DO UPDATE SET updated_at = excluded.updated_at",
                params![doc, doc_kind(doc), changeset.ts],
            )
            .map_err(io)?;
            tx.execute(
                "INSERT INTO updates (doc_id, bytes, changeset, ts) VALUES (?1, ?2, ?3, ?4)",
                params![doc, bytes, changeset.id, changeset.ts],
            )
            .map_err(io)?;
        }
        let body = serde_json::to_vec(changeset).map_err(io)?;
        let origin = serde_json::to_string(&changeset.origin).map_err(io)?;
        let label = serde_json::to_string(&changeset.label).map_err(io)?;
        tx.execute(
            "INSERT INTO changesets (id, ts, origin, label, reverts, status, body)
             VALUES (?1, ?2, ?3, ?4, ?5, 'done', ?6)",
            params![
                changeset.id,
                changeset.ts,
                origin,
                label,
                changeset.reverts,
                body
            ],
        )
        .map_err(io)?;
        tx.commit().map_err(io)
    }

    fn append(
        &mut self,
        doc_id: &str,
        update: &[u8],
        ts: i64,
    ) -> std::result::Result<(), StoreError> {
        let tx = self.db.transaction().map_err(io)?;
        tx.execute(
            "INSERT INTO docs (doc_id, kind, snapshot, updated_at) VALUES (?1, ?2, NULL, ?3)
             ON CONFLICT (doc_id) DO UPDATE SET updated_at = excluded.updated_at",
            params![doc_id, doc_kind(doc_id), ts],
        )
        .map_err(io)?;
        tx.execute(
            "INSERT INTO updates (doc_id, bytes, changeset, ts) VALUES (?1, ?2, NULL, ?3)",
            params![doc_id, update, ts],
        )
        .map_err(io)?;
        tx.commit().map_err(io)
    }

    fn changesets(&self) -> std::result::Result<Vec<Changeset>, StoreError> {
        let mut stmt = self
            .db
            .prepare("SELECT body FROM changesets ORDER BY ts, rowid")
            .map_err(io)?;
        let rows: Vec<Vec<u8>> = stmt
            .query_map([], |r| r.get(0))
            .map_err(io)?
            .collect::<rusqlite::Result<_>>()
            .map_err(io)?;
        rows.iter()
            .map(|b| serde_json::from_slice(b).map_err(io))
            .collect()
    }
}

/// `strata.json` of a workspace folder (10 §3.1).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderInfo {
    pub workspace_id: String,
    pub format_version: u32,
    /// `local` or `replica` (10 §3.7).
    pub mode: String,
}

pub const FORMAT_VERSION: u32 = 1;

fn folder_err(e: impl std::fmt::Display) -> CoreError {
    CoreError::Store(StoreError::Io(e.to_string()))
}

/// A new workspace in an empty or new folder, with its root network.
pub fn create_folder(dir: &Path, root_name: &str) -> Result<Workspace<SqliteStore>> {
    std::fs::create_dir_all(dir).map_err(folder_err)?;
    let info_path = dir.join("strata.json");
    if info_path.exists() {
        return Err(CoreError::Invalid(format!(
            "{} is already a workspace",
            dir.display()
        )));
    }
    let store = SqliteStore::open(&dir.join("store.sqlite"))?;
    let ws = Workspace::create(store, root_name)?;
    let info = FolderInfo {
        workspace_id: ws.id().to_owned(),
        format_version: FORMAT_VERSION,
        mode: "local".to_owned(),
    };
    let json = serde_json::to_vec_pretty(&info).map_err(folder_err)?;
    std::fs::write(&info_path, json).map_err(folder_err)?;
    Ok(ws)
}

/// A workspace folder: checks `strata.json` against the store.
pub fn open_folder(dir: &Path) -> Result<Workspace<SqliteStore>> {
    let info: FolderInfo =
        serde_json::from_slice(&std::fs::read(dir.join("strata.json")).map_err(folder_err)?)
            .map_err(folder_err)?;
    if info.format_version > FORMAT_VERSION {
        return Err(CoreError::Invalid(format!(
            "the folder's format {} is newer than this app's {FORMAT_VERSION}",
            info.format_version
        )));
    }
    let ws = Workspace::open(SqliteStore::open(&dir.join("store.sqlite"))?)?;
    if ws.id() != info.workspace_id {
        return Err(CoreError::Invalid(
            "strata.json and store.sqlite belong to different workspaces".to_owned(),
        ));
    }
    Ok(ws)
}

/// The app's default workspace folder in `data_dir`: opened, or created on first run.
pub fn open_or_create(
    data_dir: &Path,
    root_name: &str,
) -> Result<(Workspace<SqliteStore>, PathBuf)> {
    let dir = data_dir.join("Strata.strata");
    let ws = if dir.join("strata.json").exists() {
        open_folder(&dir)?
    } else {
        create_folder(&dir, root_name)?
    };
    Ok((ws, dir))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Label, Op};
    use strata_model::{NodeId, NodeKind};

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("strata-test-{name}-{}", NodeId::new().to_text()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn a_folder_survives_a_restart_with_every_changeset() {
        let dir = temp_dir("restart");
        let root;
        let before;
        {
            let mut ws = create_folder(&dir, "Корень").expect("create");
            root = ws.root();
            let (a, b) = (NodeId::new().to_text(), NodeId::new().to_text());
            let mk = |id: &str| Op::CreateNode {
                id: Some(id.to_owned()),
                kind: NodeKind::Note,
                class: None,
                name: format!("Нода {id}"),
                net: root.clone(),
                x: 1.0,
                y: 2.0,
            };
            ws.apply(&[mk(&a), mk(&b)], Label::new("t"))
                .expect("create nodes");
            ws.apply(&[Op::Connect { from: a, to: b }], Label::new("t"))
                .expect("connect");
            ws.undo().expect("undo");
            ws.redo().expect("redo");
            before = ws.network_view(&root).expect("view");
        }
        let mut again = open_folder(&dir).expect("open");
        assert_eq!(again.root(), root);
        assert_eq!(again.network_view(&root).expect("view"), before);
        // Create, connect, its undo and redo: five changesets with the workspace's own.
        assert_eq!(again.store().changesets().expect("journal").len(), 5);
        assert!(
            create_folder(&dir, "x").is_err(),
            "a folder is not created twice"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_folder_of_another_workspace_is_refused() {
        let a = temp_dir("a");
        let b = temp_dir("b");
        create_folder(&a, "A").expect("a");
        create_folder(&b, "B").expect("b");
        std::fs::copy(b.join("strata.json"), a.join("strata.json")).expect("copy");
        assert!(open_folder(&a).is_err());
        let _ = std::fs::remove_dir_all(&a);
        let _ = std::fs::remove_dir_all(&b);
    }
}
