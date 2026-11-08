//! What a workspace folder keeps beside its `store.sqlite` (10 §3.1):
//! `.lock`, which keeps a second process out (§3.6), and `backups/`, a
//! snapshot of the store a day and the store as it was before a restore,
//! which «Восстановить из копии» brings back (§3.5).

use crate::backups::{self, Backup, BackupKind, DAY_MS};
use crate::store::StoreError;
use std::fs::{File, OpenOptions, TryLockError};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// A snapshot under way is written under this suffix and renamed when whole.
const PART: &str = ".part";

fn io(e: impl std::fmt::Display) -> StoreError {
    StoreError::Io(e.to_string())
}

/// `.lock` held by this process (10 §3.6): the system's lock on the file,
/// so a second process is refused, and a process that dies — killed, the
/// power cut — leaves no stale lock behind: the system lets it go. The file
/// says who holds it, for the one refused.
#[derive(Debug)]
pub struct FolderLock {
    _file: File,
}

impl FolderLock {
    pub fn take(dir: &Path) -> Result<Self, StoreError> {
        std::fs::create_dir_all(dir).map_err(io)?;
        let path = dir.join(".lock");
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)
            .map_err(io)?;
        match file.try_lock() {
            Ok(()) => {}
            Err(TryLockError::WouldBlock) => {
                // Where the system lets one read a locked file, it says who holds it.
                let who = std::fs::read_to_string(&path).unwrap_or_default();
                return Err(StoreError::Locked(
                    who.lines().collect::<Vec<_>>().join(", "),
                ));
            }
            Err(TryLockError::Error(e)) => return Err(io(e)),
        }
        let host = std::env::var("COMPUTERNAME")
            .or_else(|_| std::env::var("HOSTNAME"))
            .unwrap_or_default();
        let said = format!(
            "pid {}\nhost {host}\nopened {}\n",
            std::process::id(),
            unix_ms()
        );
        file.set_len(0).map_err(io)?;
        file.write_all(said.as_bytes()).map_err(io)?;
        file.sync_all().map_err(io)?;
        Ok(Self { _file: file })
    }
}

fn unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

/// Today's snapshot of `store`, unless `backups/` has it (10 §3.5): taken
/// online with `VACUUM INTO` over a connection of its own, written aside and
/// renamed when whole, so a crash leaves no half snapshot for the day; the
/// old ones go by [`backups::expired`]. Returns the day it is done for.
pub fn back_up(store: &Path) -> Result<i64, StoreError> {
    // One at a time in this process: the folder's lock keeps others out.
    static ONE: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _one = ONE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let now = unix_ms();
    let Some(folder) = store.parent() else {
        return Err(io("a store with no folder"));
    };
    let dir = folder.join("backups");
    std::fs::create_dir_all(&dir).map_err(io)?;
    // What a crash left half written.
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            if e.file_name().to_string_lossy().ends_with(PART) {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    let plan = backups::add(&list(folder), BackupKind::Day, now);
    if let Some(b) = &plan.added {
        let part = dir.join(format!("{}.sqlite{PART}", b.id));
        let db = rusqlite::Connection::open(store).map_err(io)?;
        db.execute("VACUUM INTO ?1", [part.to_string_lossy().as_ref()])
            .map_err(io)?;
        drop(db);
        std::fs::rename(&part, file(folder, &b.id)).map_err(io)?;
    }
    let_go(folder, &plan.gone);
    Ok(now.div_euclid(DAY_MS))
}

/// Today, for the store to know when a day has passed since its snapshot.
pub fn day_now() -> i64 {
    unix_ms().div_euclid(DAY_MS)
}

/// Now, unix ms.
pub fn unix_now() -> i64 {
    unix_ms()
}

/// The week between two `integrity_check`s of a store (NFR-76).
pub const CHECK_EVERY: i64 = 7 * DAY_MS;

/// The week's `integrity_check` of `store` (NFR-76), on a connection of
/// its own beside the open store, after the day's backup: done less than
/// a week ago — nothing; whole — the date is kept; damaged — the store is
/// marked, and its next open refuses it and offers a copy.
pub fn check_weekly(store: &Path, now: i64) {
    let Ok(db) = rusqlite::Connection::open(store) else {
        return;
    };
    let _ = db.busy_timeout(std::time::Duration::from_secs(10));
    let last = db
        .query_row("SELECT value FROM meta WHERE key = 'checked'", [], |r| {
            r.get::<_, String>(0)
        })
        .ok()
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(0);
    if now - last < CHECK_EVERY {
        return;
    }
    let rows: rusqlite::Result<Vec<String>> = db
        .prepare("PRAGMA integrity_check(20)")
        .and_then(|mut stmt| stmt.query_map([], |r| r.get(0))?.collect());
    use rusqlite::ErrorCode::{DatabaseCorrupt, NotADatabase};
    let problems: Vec<String> = match rows {
        Ok(rows) => rows.into_iter().filter(|r| r != "ok").collect(),
        Err(e) if matches!(e.sqlite_error_code(), Some(DatabaseCorrupt | NotADatabase)) => {
            vec![e.to_string()]
        }
        // Busy, or the disk: no verdict — tried again at the next open.
        Err(_) => return,
    };
    let (key, value) = if problems.is_empty() {
        ("checked", now.to_string())
    } else {
        ("damaged", problems.join("; "))
    };
    let _ = db.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        [key, value.as_str()],
    );
}

/// The file of copy `id` in `backups/`.
fn file(folder: &Path, id: &str) -> PathBuf {
    folder.join("backups").join(format!("{id}.sqlite"))
}

/// Copies `ids` gone from `backups/`, with what SQLite may keep beside them.
fn let_go(folder: &Path, ids: &[String]) {
    for id in ids {
        let main = file(folder, id);
        for side in ["", "-wal", "-shm"] {
            let mut path = main.clone().into_os_string();
            path.push(side);
            let _ = std::fs::remove_file(PathBuf::from(path));
        }
    }
}

/// The copies of the folder's store, the newest first (10 §3.5).
pub fn list(folder: &Path) -> Vec<Backup> {
    let Ok(entries) = std::fs::read_dir(folder.join("backups")) else {
        return Vec::new();
    };
    let mut out: Vec<Backup> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().into_string().ok()?;
            Backup::parse(name.strip_suffix(".sqlite")?)
        })
        .collect();
    out.sort_by_key(|b| std::cmp::Reverse(b.at));
    out
}

/// The file of the folder's copy `id`, if it has one.
pub fn backup_path(folder: &Path, id: &str) -> Result<PathBuf, StoreError> {
    match Backup::parse(id) {
        Some(b) if file(folder, &b.id).is_file() => Ok(file(folder, &b.id)),
        _ => Err(io(format!("no copy {id} in {}", folder.display()))),
    }
}

fn damaged(e: impl std::fmt::Display) -> StoreError {
    StoreError::Damaged(e.to_string())
}

/// «Восстановить из копии» (10 §3.5): the folder's store becomes its copy
/// `id`. The copy is checked and written whole beside the store first — a
/// damaged one changes nothing. The store as it is — perhaps the damaged
/// one — goes into a copy of its own byte for byte, `replaced-<ms>`, so a
/// restore can be taken back the same way. Nobody may have the folder open:
/// its `.lock` is taken for the while. The workspace the copy is of is the
/// caller's to check (`sqlite::restore_folder`).
pub fn restore(folder: &Path, id: &str) -> Result<(), StoreError> {
    let from = backup_path(folder, id)?;
    let _lock = FolderLock::take(folder)?;
    let store = folder.join("store.sqlite");
    let next = folder.join(format!("store.sqlite{PART}"));
    if next.exists() {
        std::fs::remove_file(&next).map_err(io)?;
    }
    {
        let db = rusqlite::Connection::open_with_flags(
            &from,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(damaged)?;
        let check: String = db
            .query_row("PRAGMA quick_check", [], |r| r.get(0))
            .map_err(damaged)?;
        if check != "ok" {
            return Err(damaged(check));
        }
        if let Err(e) = db.execute("VACUUM INTO ?1", [next.to_string_lossy().as_ref()]) {
            let _ = std::fs::remove_file(&next);
            return Err(damaged(e));
        }
    }
    let mut gone = Vec::new();
    if store.exists() {
        let plan = backups::add(&list(folder), BackupKind::Replaced, unix_ms());
        if let Some(b) = &plan.added {
            std::fs::copy(&store, file(folder, &b.id)).map_err(io)?;
            let wal = folder.join("store.sqlite-wal");
            if wal.exists() {
                let mut to = file(folder, &b.id).into_os_string();
                to.push("-wal");
                std::fs::copy(&wal, PathBuf::from(to)).map_err(io)?;
            }
        }
        gone = plan.gone;
    }
    // The old store's journal must not be read into the copy.
    for side in ["store.sqlite-wal", "store.sqlite-shm"] {
        let path = folder.join(side);
        if path.exists() {
            std::fs::remove_file(path).map_err(io)?;
        }
    }
    std::fs::rename(&next, &store).map_err(io)?;
    let_go(folder, &gone);
    Ok(())
}
