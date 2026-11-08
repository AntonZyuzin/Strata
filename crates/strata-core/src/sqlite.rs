//! `store.sqlite` of a workspace folder (10 §3.1–3.3): every CRDT document
//! of the workspace in one database, so a changeset that touches several
//! documents is one transaction. WAL with `synchronous = FULL`: writes are
//! small, one per gesture, and a crash keeps all of a changeset or none.

use crate::changeset::Changeset;
use crate::folder::{self, FolderLock};
use crate::store::{ChangesetHead, Status, Store, StoreError, StoredDoc};
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
    /// `assets/` of the workspace folder (10 §3.1); none for a store in memory.
    assets: Option<PathBuf>,
    /// The database's file; none in memory.
    path: Option<PathBuf>,
    /// The day (since 1970, UTC) the daily backup was last seen to (10 §3.5).
    backed_up: i64,
    /// The backup under way, if any: the store closes after it, so a folder
    /// let go holds no half written snapshot.
    backup: Option<std::thread::JoinHandle<()>>,
    /// The folder's `.lock` (10 §3.6), held as long as the store is open.
    _lock: Option<FolderLock>,
}

impl Drop for SqliteStore {
    fn drop(&mut self) {
        if let Some(backup) = self.backup.take() {
            let _ = backup.join();
        }
    }
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
CREATE TABLE IF NOT EXISTS changeset_parts (
  changeset TEXT NOT NULL,
  seq       INTEGER NOT NULL,
  body      BLOB NOT NULL,
  PRIMARY KEY (changeset, seq)
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value BLOB);
";

impl SqliteStore {
    /// Changesets of the journal by `filter`, oldest first, the writes of a
    /// long task's parts in them in order (10 §3.3).
    fn journal(
        &self,
        filter: &str,
        args: impl rusqlite::Params,
    ) -> std::result::Result<Vec<Changeset>, StoreError> {
        let mut stmt = self
            .db
            .prepare(&format!(
                "SELECT body FROM changesets {filter} ORDER BY ts, rowid"
            ))
            .map_err(io)?;
        let rows: Vec<Vec<u8>> = stmt
            .query_map(args, |r| r.get(0))
            .map_err(io)?
            .collect::<rusqlite::Result<_>>()
            .map_err(io)?;
        let mut out: Vec<Changeset> = rows
            .iter()
            .map(|b| serde_json::from_slice(b).map_err(io))
            .collect::<std::result::Result<_, _>>()?;
        let mut parts = self
            .db
            .prepare("SELECT body FROM changeset_parts WHERE changeset = ?1 ORDER BY seq")
            .map_err(io)?;
        for c in &mut out {
            let bodies: Vec<Vec<u8>> = parts
                .query_map(params![c.id], |r| r.get(0))
                .map_err(io)?
                .collect::<rusqlite::Result<_>>()
                .map_err(io)?;
            for b in bodies {
                let writes: Vec<crate::changeset::KeyWrite> =
                    serde_json::from_slice(&b).map_err(io)?;
                c.writes.extend(writes);
            }
        }
        Ok(out)
    }

    /// The store of a folder: its `.lock` taken first (10 §3.6) — a folder
    /// another process has open is refused, [`StoreError::Locked`].
    pub fn open(path: &Path) -> std::result::Result<Self, StoreError> {
        let lock = match path.parent() {
            Some(dir) => Some(FolderLock::take(dir)?),
            None => None,
        };
        let db = Connection::open(path).map_err(io)?;
        db.pragma_update(None, "journal_mode", "WAL").map_err(io)?;
        db.pragma_update(None, "synchronous", "FULL").map_err(io)?;
        db.execute_batch(SCHEMA).map_err(io)?;
        let assets = path.parent().map(|d| d.join("assets"));
        Ok(Self {
            db,
            assets,
            path: Some(path.to_owned()),
            backed_up: folder::day_now(),
            backup: None,
            _lock: lock,
        })
    }

    /// A copy of a store in `backups/` (10 §3.5), opened to be read: no
    /// `.lock`, no backups of its own, no assets.
    fn backup_at(path: &Path) -> std::result::Result<Self, StoreError> {
        let db = Connection::open_with_flags(
            path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|e| StoreError::Damaged(e.to_string()))?;
        Ok(Self {
            db,
            assets: None,
            path: None,
            backed_up: folder::day_now(),
            backup: None,
            _lock: None,
        })
    }

    /// A store in memory with the same tables (tests).
    pub fn in_memory() -> std::result::Result<Self, StoreError> {
        let db = Connection::open_in_memory().map_err(io)?;
        db.execute_batch(SCHEMA).map_err(io)?;
        Ok(Self {
            db,
            assets: None,
            path: None,
            backed_up: folder::day_now(),
            backup: None,
            _lock: None,
        })
    }

    /// Today's backup of the folder's store (10 §3.5), on a thread of its
    /// own: a large store does not hold the open or the next step up.
    pub fn back_up_today(&mut self) {
        let Some(path) = self.path.clone() else {
            return;
        };
        self.backed_up = folder::day_now();
        if let Some(before) = self.backup.take() {
            let _ = before.join();
        }
        self.backup = Some(std::thread::spawn(move || {
            // A failed backup is tried again at the next open or the next day.
            let _ = folder::back_up(&path);
        }));
    }

    /// `assets/ab/cd/<sha256>` (10 §3.1).
    fn asset_path(&self, sha: &str) -> std::result::Result<PathBuf, StoreError> {
        let dir = self
            .assets
            .as_ref()
            .ok_or_else(|| io("a store in memory keeps no assets"))?;
        let ok = sha.len() == 64 && sha.bytes().all(|c| c.is_ascii_hexdigit());
        if !ok {
            return Err(io(format!("not an asset id: {sha}")));
        }
        Ok(dir.join(&sha[0..2]).join(&sha[2..4]).join(sha))
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
             VALUES (?1, ?2, ?3, ?4, ?5, 'applied', ?6)",
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
        tx.commit().map_err(io)?;
        // A day passed with the folder open: its backup (10 §3.5).
        if folder::day_now() != self.backed_up {
            self.back_up_today();
        }
        Ok(())
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

    fn doc_ids(&self) -> std::result::Result<Vec<String>, StoreError> {
        let mut stmt = self
            .db
            .prepare("SELECT doc_id FROM docs ORDER BY doc_id")
            .map_err(io)?;
        stmt.query_map([], |r| r.get(0))
            .map_err(io)?
            .collect::<rusqlite::Result<_>>()
            .map_err(io)
    }

    fn drop_docs(&mut self, doc_ids: &[String]) -> std::result::Result<(), StoreError> {
        let tx = self.db.transaction().map_err(io)?;
        for id in doc_ids {
            tx.execute("DELETE FROM updates WHERE doc_id = ?1", params![id])
                .map_err(io)?;
            tx.execute("DELETE FROM docs WHERE doc_id = ?1", params![id])
                .map_err(io)?;
        }
        tx.commit().map_err(io)
    }

    fn restore(
        &mut self,
        docs: &[(String, Vec<u8>)],
        changesets: &[Changeset],
    ) -> std::result::Result<(), StoreError> {
        let tx = self.db.transaction().map_err(io)?;
        let ts = changesets.last().map_or(0, |c| c.ts);
        for (doc, snapshot) in docs {
            tx.execute(
                "INSERT INTO docs (doc_id, kind, snapshot, updated_at) VALUES (?1, ?2, ?3, ?4)",
                params![doc, doc_kind(doc), snapshot, ts],
            )
            .map_err(io)?;
        }
        for c in changesets {
            let body = serde_json::to_vec(c).map_err(io)?;
            let origin = serde_json::to_string(&c.origin).map_err(io)?;
            let label = serde_json::to_string(&c.label).map_err(io)?;
            tx.execute(
                "INSERT INTO changesets (id, ts, origin, label, reverts, status, body)
                 VALUES (?1, ?2, ?3, ?4, ?5, 'applied', ?6)",
                params![c.id, c.ts, origin, label, c.reverts, body],
            )
            .map_err(io)?;
        }
        tx.commit().map_err(io)
    }

    fn put_asset(&mut self, sha: &str, bytes: &[u8]) -> std::result::Result<(), StoreError> {
        let path = self.asset_path(sha)?;
        if path.exists() {
            return Ok(());
        }
        let dir = path.parent().ok_or_else(|| io("asset path"))?;
        std::fs::create_dir_all(dir).map_err(io)?;
        // Written aside and renamed: an asset is there whole or not at all.
        let tmp = dir.join(format!("{sha}.tmp"));
        std::fs::write(&tmp, bytes).map_err(io)?;
        std::fs::rename(&tmp, &path).map_err(io)
    }

    fn asset(&self, sha: &str) -> std::result::Result<Option<Vec<u8>>, StoreError> {
        match std::fs::read(self.asset_path(sha)?) {
            Ok(b) => Ok(Some(b)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(io(e)),
        }
    }

    fn asset_ids(&self) -> std::result::Result<Vec<String>, StoreError> {
        let mut out = Vec::new();
        let Some(dir) = &self.assets else {
            return Ok(out);
        };
        let Ok(a) = std::fs::read_dir(dir) else {
            return Ok(out);
        };
        for a in a.flatten() {
            for b in std::fs::read_dir(a.path()).into_iter().flatten().flatten() {
                for f in std::fs::read_dir(b.path()).into_iter().flatten().flatten() {
                    let name = f.file_name().to_string_lossy().into_owned();
                    if name.len() == 64 && name.bytes().all(|c| c.is_ascii_hexdigit()) {
                        out.push(name);
                    }
                }
            }
        }
        out.sort();
        Ok(out)
    }

    fn commit_part(
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
        // The changeset's row once, without writes: they are in its parts.
        let header = Changeset {
            writes: Vec::new(),
            ..changeset.clone()
        };
        let body = serde_json::to_vec(&header).map_err(io)?;
        let origin = serde_json::to_string(&changeset.origin).map_err(io)?;
        let label = serde_json::to_string(&changeset.label).map_err(io)?;
        tx.execute(
            "INSERT INTO changesets (id, ts, origin, label, reverts, status, body)
             VALUES (?1, ?2, ?3, ?4, ?5, 'in-progress', ?6)
             ON CONFLICT (id) DO NOTHING",
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
        let part = serde_json::to_vec(&changeset.writes).map_err(io)?;
        tx.execute(
            "INSERT INTO changeset_parts (changeset, seq, body) VALUES (?1,
               (SELECT COALESCE(MAX(seq), 0) + 1 FROM changeset_parts WHERE changeset = ?1), ?2)",
            params![changeset.id, part],
        )
        .map_err(io)?;
        tx.commit().map_err(io)
    }

    fn close(&mut self, id: &str, status: Status) -> std::result::Result<(), StoreError> {
        self.db
            .execute(
                "UPDATE changesets SET status = ?2 WHERE id = ?1",
                params![id, status.as_str()],
            )
            .map_err(io)?;
        Ok(())
    }

    fn unfinished(&self) -> std::result::Result<Vec<Changeset>, StoreError> {
        self.journal("WHERE status = 'in-progress'", [])
    }

    fn changesets(&self) -> std::result::Result<Vec<Changeset>, StoreError> {
        self.journal("", [])
    }

    fn heads(&self) -> std::result::Result<Vec<ChangesetHead>, StoreError> {
        let mut stmt = self
            .db
            .prepare(
                "SELECT id, ts, origin, label, reverts, status FROM changesets ORDER BY ts, rowid",
            )
            .map_err(io)?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, Option<String>>(4)?,
                    r.get::<_, String>(5)?,
                ))
            })
            .map_err(io)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(io)?;
        rows.into_iter()
            .map(|(id, ts, origin, label, reverts, status)| {
                Ok(ChangesetHead {
                    origin: serde_json::from_str(&origin).map_err(io)?,
                    label: serde_json::from_str(&label).map_err(io)?,
                    status: Status::parse(&status)
                        .ok_or_else(|| io(format!("changeset {id}: status {status}")))?,
                    id,
                    ts,
                    reverts,
                })
            })
            .collect()
    }

    fn changeset(&self, id: &str) -> std::result::Result<Option<Changeset>, StoreError> {
        let mut one = self.journal("WHERE id = ?1", [id])?;
        Ok(one.pop())
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

/// An archive (10 §3.5) into a new folder: its documents and journal, and
/// `strata.json`. `copy` gives it a new workspace id (10 §3.6).
pub fn import_folder(
    dir: &Path,
    unpacked: &crate::archive::Unpacked,
    copy: bool,
) -> Result<Workspace<SqliteStore>> {
    std::fs::create_dir_all(dir).map_err(folder_err)?;
    let info_path = dir.join("strata.json");
    if info_path.exists() {
        return Err(CoreError::Invalid(format!(
            "{} is already a workspace",
            dir.display()
        )));
    }
    let store = SqliteStore::open(&dir.join("store.sqlite"))?;
    let ws = crate::archive::import(unpacked, store, copy)?;
    let info = FolderInfo {
        workspace_id: ws.id().to_owned(),
        format_version: FORMAT_VERSION,
        mode: "local".to_owned(),
    };
    let json = serde_json::to_vec_pretty(&info).map_err(folder_err)?;
    std::fs::write(&info_path, json).map_err(folder_err)?;
    Ok(ws)
}

/// The id of the workspace in folder `dir`, as its `strata.json` says.
pub fn folder_id(dir: &Path) -> Result<String> {
    let info: FolderInfo =
        serde_json::from_slice(&std::fs::read(dir.join("strata.json")).map_err(folder_err)?)
            .map_err(folder_err)?;
    Ok(info.workspace_id)
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
    let mut store = SqliteStore::open(&dir.join("store.sqlite"))?;
    // Today's backup before anything else touches the store (10 §3.5, §13).
    store.back_up_today();
    let mut ws = Workspace::open(store)?;
    if ws.id() != info.workspace_id {
        return Err(CoreError::Invalid(
            "strata.json and store.sqlite belong to different workspaces".to_owned(),
        ));
    }
    // The trash's term (05 §11): a purge that fails leaves all as it was,
    // and the workspace opens all the same.
    let _ = ws.purge_expired();
    Ok(ws)
}

/// «Восстановить из копии» (10 §3.5): folder `dir`'s store becomes its copy
/// `backup`. The copy is read as a workspace first: one that is not, or is
/// another workspace's, is refused, and nothing changes.
pub fn restore_folder(dir: &Path, backup: &str) -> Result<()> {
    let id = folder_id(dir)?;
    let copy = Workspace::open(SqliteStore::backup_at(&folder::backup_path(dir, backup)?)?)
        .map_err(|e| StoreError::Damaged(e.to_string()))?;
    if copy.id() != id {
        return Err(StoreError::Damaged(format!("a copy of workspace {}", copy.id())).into());
    }
    drop(copy);
    folder::restore(dir, backup)?;
    Ok(())
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
    use crate::backups::BackupKind;
    use crate::{Label, Op};
    use strata_model::{NodeId, NodeKind};

    /// A note named `name` in the root network of `ws`.
    fn note(ws: &mut Workspace<SqliteStore>, name: &str) {
        let root = ws.root();
        ws.apply(
            &[Op::CreateNode {
                id: None,
                net: root,
                kind: NodeKind::Note,
                name: name.to_owned(),
                x: 0.0,
                y: 0.0,
            }],
            Label::new("t"),
        )
        .expect("a note");
    }

    /// The names of the nodes in the root network of `ws`, sorted.
    fn names(ws: &mut Workspace<SqliteStore>) -> Vec<String> {
        let root = ws.root();
        let mut out: Vec<String> = ws
            .network_view(&root)
            .expect("view")
            .nodes
            .into_iter()
            .map(|n| n.name)
            .collect();
        out.sort();
        out
    }

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
    fn a_folder_open_elsewhere_is_refused_until_let_go() {
        // 10 §3.6: `.lock` keeps a second opener out; letting go opens it again.
        let dir = temp_dir("lock");
        let first = create_folder(&dir, "Замок").expect("create");
        let again = open_folder(&dir).expect_err("the folder is open");
        assert_eq!(again.code(), Some("locked"), "{again}");
        assert!(
            std::fs::read_to_string(dir.join(".lock"))
                .expect("who holds it")
                .contains(&format!("pid {}", std::process::id()))
        );
        drop(first);
        let reopened = open_folder(&dir).expect("let go, it opens");
        drop(reopened);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_folder_is_backed_up_once_a_day_and_whole() {
        // 10 §3.5: `VACUUM INTO backups/store-YYYYMMDD.sqlite`, once a day;
        // a snapshot a crash left half written goes.
        let dir = temp_dir("backup");
        let mut ws = create_folder(&dir, "Копия").expect("create");
        let root = ws.root();
        ws.apply(
            &[Op::CreateNode {
                id: None,
                net: root,
                kind: NodeKind::Note,
                name: "Заметка".to_owned(),
                x: 0.0,
                y: 0.0,
            }],
            Label::new("t"),
        )
        .expect("a note");
        let store = dir.join("store.sqlite");
        let backups = dir.join("backups");
        std::fs::create_dir_all(&backups).expect("backups");
        std::fs::write(backups.join("store-20200101.sqlite.part"), b"half").expect("half");
        let day = folder::back_up(&store).expect("backup");
        assert_eq!(folder::back_up(&store).expect("the same day"), day);
        let names: Vec<String> = std::fs::read_dir(&backups)
            .expect("backups")
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            names,
            vec![format!("store-{}.sqlite", crate::backups::day_stamp(day))]
        );
        // The snapshot is the store: the note is there.
        let copy = Connection::open(backups.join(&names[0])).expect("open the copy");
        let n: i64 = copy
            .query_row("SELECT count(*) FROM changesets", [], |r| r.get(0))
            .expect("changesets");
        assert_eq!(n, 2, "the workspace's own and the note's");
        drop(ws);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_folder_comes_back_from_a_copy_and_the_restore_can_be_taken_back() {
        // 10 §3.5: «Восстановить из копии» — the store becomes the copy; the
        // store as it was goes into a copy of its own, which brings it back.
        let dir = temp_dir("restore");
        let mut ws = create_folder(&dir, "Копия").expect("create");
        note(&mut ws, "До копии");
        let day = folder::back_up(&dir.join("store.sqlite")).expect("today's copy");
        note(&mut ws, "После копии");
        let id = format!("store-{}", crate::backups::day_stamp(day));
        // The folder is open: refused, nothing changes.
        let open = restore_folder(&dir, &id).expect_err("the folder is open");
        assert_eq!(open.code(), Some("locked"), "{open}");
        drop(ws);
        let ids =
            |dir: &Path| -> Vec<String> { folder::list(dir).into_iter().map(|b| b.id).collect() };
        assert_eq!(ids(&dir), std::slice::from_ref(&id));
        restore_folder(&dir, &id).expect("restore");
        let mut back = open_folder(&dir).expect("open the restored");
        assert_eq!(names(&mut back), ["До копии"]);
        drop(back);
        // The store as it was is a copy now, the newest.
        let list = folder::list(&dir);
        assert_eq!(list.len(), 2, "{list:?}");
        assert_eq!(list[0].kind, BackupKind::Replaced);
        restore_folder(&dir, &list[0].id).expect("take the restore back");
        let mut again = open_folder(&dir).expect("open");
        assert_eq!(names(&mut again), ["До копии", "После копии"]);
        drop(again);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_damaged_copy_or_another_workspaces_is_refused_and_nothing_changes() {
        let dir = temp_dir("restore-bad");
        let other = temp_dir("restore-other");
        let mut ws = create_folder(&dir, "Своё").expect("create");
        note(&mut ws, "Своя");
        drop(ws);
        let backups = dir.join("backups");
        std::fs::create_dir_all(&backups).expect("backups");
        // Not a database at all.
        std::fs::write(backups.join("store-20200101.sqlite"), b"not a database").expect("junk");
        let e = restore_folder(&dir, "store-20200101").expect_err("junk");
        assert_eq!(e.code(), Some("damaged"), "{e}");
        // Another workspace's store.
        drop(create_folder(&other, "Чужое").expect("other"));
        folder::back_up(&other.join("store.sqlite")).expect("its copy");
        let theirs = folder::list(&other)[0].id.clone();
        std::fs::copy(
            other.join("backups").join(format!("{theirs}.sqlite")),
            backups.join("store-20200102.sqlite"),
        )
        .expect("copy");
        let e = restore_folder(&dir, "store-20200102").expect_err("theirs");
        assert_eq!(e.code(), Some("damaged"), "{e}");
        // No such copy; a name that is no copy's.
        assert!(restore_folder(&dir, "store-20200103").is_err());
        assert!(restore_folder(&dir, "../store").is_err());
        // Nothing changed: the store, and no copy from before a restore.
        let mut ws = open_folder(&dir).expect("open");
        assert_eq!(names(&mut ws), ["Своя"]);
        assert!(folder::list(&dir).iter().all(|b| b.kind == BackupKind::Day));
        drop(ws);
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&other);
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
