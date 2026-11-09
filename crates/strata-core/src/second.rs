//! The second place for copies (10 §3.5, NFR-73, ☑ Q-14-9): a folder on
//! another disk or a network share, one a device, where the day's copy of
//! every workspace goes too, with the workspace's assets — the copies in
//! the workspace's own folder do not outlive its disk.
//!
//! ```text
//! <place>/Gexogon/<folder name> (<8 characters of the id>)/
//!     strata.json            workspaceId, formatVersion, mode: "copies"
//!     backups/               store-YYYYMMDD.sqlite, by the rules of backups.rs
//!     assets/ab/cd/<sha256>  the workspace's assets
//!     .lock                  held while a copy is written
//! ```
//!
//! A folder of copies is no workspace: it does not open as one, and
//! «Открыть…» offers to restore it into a new workspace folder instead
//! ([`restore_into`]).

use crate::backups::{self, Backup, BackupKind};
use crate::folder::{self, FolderLock};
use crate::sqlite::{FolderInfo, file_sha256};
use crate::store::StoreError;
use std::path::{Path, PathBuf};

/// The folder of the place that holds the copies of this app.
pub const DIR: &str = "Gexogon";
/// `strata.json`'s `mode` of a folder of copies.
pub const MODE: &str = "copies";
/// A file under way is written under this suffix and renamed when whole.
const PART: &str = ".part";

fn io(e: impl std::fmt::Display) -> StoreError {
    StoreError::Io(e.to_string())
}

/// `strata.json` of folder `dir`, if it has one that reads.
pub fn info(dir: &Path) -> Option<FolderInfo> {
    let bytes = std::fs::read(dir.join("strata.json")).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Whether `dir` is a folder of copies, not a workspace.
pub fn is_copies(dir: &Path) -> bool {
    info(dir).is_some_and(|i| i.mode == MODE)
}

/// `strata.json` written aside and renamed: a crash leaves the old one.
fn write_info(dir: &Path, info: &FolderInfo) -> Result<(), StoreError> {
    let json = serde_json::to_vec_pretty(info).map_err(io)?;
    let part = dir.join(format!("strata.json{PART}"));
    std::fs::write(&part, json).map_err(io)?;
    std::fs::rename(&part, dir.join("strata.json")).map_err(io)
}

/// The folder of copies of the workspace in `folder`, in `place`: the one
/// whose `strata.json` has its id — a renamed or moved workspace keeps
/// writing where it did — else a new one named after the folder.
pub fn copies_dir(place: &Path, id: &str, folder: &Path) -> PathBuf {
    let root = place.join(DIR);
    for e in std::fs::read_dir(&root).into_iter().flatten().flatten() {
        if info(&e.path()).is_some_and(|i| i.workspace_id == id && i.mode == MODE) {
            return e.path();
        }
    }
    let name = folder
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let name = name.strip_suffix(".strata").unwrap_or(&name).to_owned();
    let short: String = id.chars().take(8).collect();
    let dir = root.join(format!("{name} ({short})"));
    // Another workspace's of the same name and the same first characters.
    if dir.exists() {
        root.join(format!("{name} ({id})"))
    } else {
        dir
    }
}

/// `from` copied to `to` whole (NFR-72): written aside, synced, its SHA-256
/// on the disk checked against the source's, renamed, its folder synced.
fn copy_whole(from: &Path, to: &Path) -> Result<(), StoreError> {
    let dir = to.parent().ok_or_else(|| io("a file with no folder"))?;
    std::fs::create_dir_all(dir).map_err(io)?;
    let mut part = to.as_os_str().to_owned();
    part.push(PART);
    let part = PathBuf::from(part);
    let done = (|| -> std::io::Result<bool> {
        let mut src = std::fs::File::open(from)?;
        let mut dst = std::fs::File::create(&part)?;
        std::io::copy(&mut src, &mut dst)?;
        dst.sync_all()?;
        drop(dst);
        Ok(file_sha256(&part)? == file_sha256(from)?)
    })();
    match done {
        Ok(true) => {}
        Ok(false) => {
            let _ = std::fs::remove_file(&part);
            return Err(io(format!("{} was copied changed", from.display())));
        }
        Err(e) => {
            let _ = std::fs::remove_file(&part);
            return Err(io(e));
        }
    }
    std::fs::rename(&part, to).map_err(io)?;
    if let Ok(d) = std::fs::File::open(dir) {
        let _ = d.sync_all();
    }
    Ok(())
}

/// Every file under `assets` with an asset's name: its SHA-256 and path.
fn asset_files(assets: &Path) -> Vec<(String, PathBuf)> {
    let mut out = Vec::new();
    for a in std::fs::read_dir(assets).into_iter().flatten().flatten() {
        for b in std::fs::read_dir(a.path()).into_iter().flatten().flatten() {
            for f in std::fs::read_dir(b.path()).into_iter().flatten().flatten() {
                let name = f.file_name().to_string_lossy().into_owned();
                if name.len() == 64 && name.bytes().all(|c| c.is_ascii_hexdigit()) {
                    out.push((name, f.path()));
                }
            }
        }
    }
    out.sort();
    out
}

fn asset_path(root: &Path, sha: &str) -> PathBuf {
    root.join("assets")
        .join(&sha[0..2])
        .join(&sha[2..4])
        .join(sha)
}

/// The assets of `from` that `to` has not yet, copied whole. A file of
/// `from` whose SHA-256 is not its name is damaged: it is not spread, its
/// id is returned.
fn copy_assets(from: &Path, to: &Path) -> Result<(usize, Vec<String>), StoreError> {
    let (mut copied, mut damaged) = (0, Vec::new());
    for (sha, path) in asset_files(&from.join("assets")) {
        let target = asset_path(to, &sha);
        if target.is_file() {
            continue;
        }
        if file_sha256(&path).map_err(io)? != sha {
            damaged.push(sha);
            continue;
        }
        copy_whole(&path, &target)?;
        copied += 1;
    }
    Ok((copied, damaged))
}

/// What a copy into the second place came to.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Mirrored {
    /// The folder of copies.
    pub dir: PathBuf,
    /// The day's copy written now; None — it was there already, or the
    /// workspace has no copy yet.
    pub copy: Option<String>,
    /// Assets copied now.
    pub assets: usize,
    /// Assets of the workspace that are damaged (NFR-72): not copied.
    pub damaged: Vec<String>,
}

/// The newest day's copy of the workspace in `folder` and its assets into
/// the second place `place` (10 §3.5): what the folder of copies has not
/// yet, its old copies let go by the same rules as the folder's own. The
/// folder of copies is locked meanwhile: open as a workspace somewhere, it
/// is not written. Nothing of the workspace's folder changes.
pub fn mirror(folder: &Path, place: &Path) -> Result<Mirrored, StoreError> {
    let workspace = info(folder).ok_or_else(|| io("no workspace folder: no strata.json"))?;
    if !place.is_dir() {
        return Err(io(format!(
            "the second place {} is not there",
            place.display()
        )));
    }
    let dir = copies_dir(place, &workspace.workspace_id, folder);
    std::fs::create_dir_all(dir.join("backups")).map_err(io)?;
    let _lock = FolderLock::take(&dir)?;
    write_info(
        &dir,
        &FolderInfo {
            mode: MODE.to_owned(),
            ..workspace
        },
    )?;
    // What a cut copy left half written.
    for e in std::fs::read_dir(dir.join("backups"))
        .into_iter()
        .flatten()
        .flatten()
    {
        if e.file_name().to_string_lossy().ends_with(PART) {
            let _ = std::fs::remove_file(e.path());
        }
    }
    let mut out = Mirrored {
        dir: dir.clone(),
        ..Mirrored::default()
    };
    let newest = folder::list(folder)
        .into_iter()
        .find(|b| b.kind == BackupKind::Day);
    if let Some(b) = newest {
        let target = dir.join("backups").join(format!("{}.sqlite", b.id));
        if !target.is_file() {
            copy_whole(&folder::backup_path(folder, &b.id)?, &target)?;
            out.copy = Some(b.id);
        }
    }
    folder::let_go(&dir, &backups::expired(&folder::list(&dir)));
    let (assets, damaged) = copy_assets(folder, &dir)?;
    out.assets = assets;
    out.damaged = damaged;
    Ok(out)
}

/// The copies a folder of copies keeps, the newest first.
pub fn list(dir: &Path) -> Vec<Backup> {
    folder::list(dir)
}

/// A folder of copies' copy `id` and its assets as a new workspace folder
/// `to` (10 §3.5: the workspace's own folder is gone): the copy checked
/// and written whole as «Восстановить из копии» writes one, the assets
/// copied whole, `strata.json` of a workspace with the same id. `to` must
/// be new or empty. The workspace the copy holds is the caller's to check.
pub fn restore_into(dir: &Path, id: &str, to: &Path) -> Result<FolderInfo, StoreError> {
    let copies = info(dir)
        .filter(|i| i.mode == MODE)
        .ok_or_else(|| io(format!("{} is no folder of copies", dir.display())))?;
    let from = folder::backup_path(dir, id)?;
    if std::fs::read_dir(to).is_ok_and(|mut e| e.next().is_some()) {
        return Err(io(format!("{} is not empty", to.display())));
    }
    std::fs::create_dir_all(to).map_err(io)?;
    let part = to.join(format!("store.sqlite{PART}"));
    folder::vacuum_checked(&from, &part)?;
    std::fs::rename(&part, to.join("store.sqlite")).map_err(io)?;
    copy_assets(dir, to)?;
    let workspace = FolderInfo {
        mode: "local".to_owned(),
        ..copies
    };
    write_info(to, &workspace)?;
    Ok(workspace)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sqlite::{create_folder, open_folder, open_folder_with, restore_folder_from};
    use crate::value::Val;
    use crate::{Label, Op};
    use strata_model::{NodeId, NodeKind};

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("strata-second-{name}-{}", NodeId::new().to_text()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    /// A workspace folder with a picture and today's copy; the picture's SHA-256.
    fn workspace(dir: &Path) -> String {
        let mut ws = create_folder(dir, "Проект").expect("a folder");
        let root = ws.root();
        let id = NodeId::new().to_text();
        ws.apply(
            &[Op::CreateNode {
                id: Some(id.clone()),
                kind: NodeKind::Asset,
                name: "Скетч".to_owned(),
                net: root,
                x: 0.0,
                y: 0.0,
            }],
            Label::new("t"),
        )
        .expect("a node");
        let sha = ws.put_asset(b"\x89PNG a picture").expect("an asset");
        ws.apply(
            &[Op::SetAttr {
                id,
                key: "asset".to_owned(),
                value: Some(Val::str(sha.clone())),
            }],
            Label::new("t"),
        )
        .expect("its picture");
        drop(ws);
        folder::back_up(&dir.join("store.sqlite")).expect("today's copy");
        sha
    }

    #[test]
    fn the_days_copy_and_the_assets_go_to_the_second_place() {
        let (dir, place) = (temp_dir("ws").join("Проект.strata"), temp_dir("place"));
        std::fs::create_dir_all(&place).expect("the place");
        let sha = workspace(&dir);
        let id = info(&dir).expect("strata.json").workspace_id;
        let done = mirror(&dir, &place).expect("mirrored");
        let short: String = id.chars().take(8).collect();
        assert_eq!(done.dir, place.join(DIR).join(format!("Проект ({short})")));
        let today = folder::list(&dir)[0].id.clone();
        assert_eq!(done.copy.as_deref(), Some(today.as_str()));
        assert_eq!(done.assets, 1);
        // A folder of copies, not a workspace: its copies, its assets.
        assert!(is_copies(&done.dir));
        assert_eq!(info(&done.dir).expect("strata.json").workspace_id, id);
        assert_eq!(
            list(&done.dir)
                .iter()
                .map(|b| b.id.clone())
                .collect::<Vec<_>>(),
            [today]
        );
        assert!(asset_path(&done.dir, &sha).is_file());
        assert!(
            open_folder(&done.dir).is_err(),
            "a folder of copies does not open"
        );
        // Again the same day: nothing new to write.
        let again = mirror(&dir, &place).expect("mirrored again");
        assert_eq!((again.copy, again.assets), (None, 0));
        // Moved and renamed, the workspace writes where it did: found by its id.
        let moved = temp_dir("moved").join("Другое имя");
        std::fs::create_dir_all(moved.parent().expect("parent")).expect("parent");
        std::fs::rename(&dir, &moved).expect("moved");
        assert_eq!(mirror(&moved, &place).expect("mirrored").dir, done.dir);
        let _ = std::fs::remove_dir_all(moved.parent().expect("parent"));
        let _ = std::fs::remove_dir_all(dir.parent().expect("parent"));
        let _ = std::fs::remove_dir_all(&place);
    }

    #[test]
    fn the_second_place_keeps_its_copies_by_the_same_rules() {
        // 10 §3.5: 7 days and the newest of 4 weeks before them.
        let (dir, place) = (temp_dir("rules"), temp_dir("rules-place"));
        std::fs::create_dir_all(&place).expect("the place");
        workspace(&dir);
        let copies = mirror(&dir, &place).expect("mirrored").dir;
        let today = folder::list(&dir)[0].at / backups::DAY_MS;
        for back in 1..=60 {
            let b = Backup::parse(&format!("store-{}", backups::day_stamp(today - back)))
                .expect("a day's name");
            std::fs::write(
                copies.join("backups").join(format!("{}.sqlite", b.id)),
                b"old",
            )
            .expect("an old copy");
        }
        mirror(&dir, &place).expect("mirrored");
        let kept = list(&copies);
        assert_eq!(kept.len(), 11, "{kept:?}");
        assert_eq!(kept[0].at / backups::DAY_MS, today);
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&place);
    }

    #[test]
    fn a_place_away_or_in_use_takes_nothing_and_changes_nothing() {
        let (dir, place) = (temp_dir("away"), temp_dir("away-place"));
        workspace(&dir);
        let before = folder::list(&dir);
        // Not there: an unplugged disk, a share offline.
        assert!(mirror(&dir, &place).is_err());
        assert_eq!(folder::list(&dir), before);
        // Open as a workspace somewhere: its `.lock` held, not written.
        std::fs::create_dir_all(&place).expect("the place");
        let copies = mirror(&dir, &place).expect("mirrored").dir;
        let held = FolderLock::take(&copies).expect("held");
        assert!(matches!(mirror(&dir, &place), Err(StoreError::Locked(_))));
        drop(held);
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&place);
    }

    #[test]
    fn a_damaged_asset_is_not_spread() {
        // NFR-72: a file whose SHA-256 is not its name stays where it is.
        let (dir, place) = (temp_dir("damaged"), temp_dir("damaged-place"));
        std::fs::create_dir_all(&place).expect("the place");
        let sha = workspace(&dir);
        std::fs::write(asset_path(&dir, &sha), b"\x89PNG a pictur").expect("spoilt");
        let done = mirror(&dir, &place).expect("mirrored");
        assert_eq!(done.damaged, std::slice::from_ref(&sha));
        assert!(!asset_path(&done.dir, &sha).exists());
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&place);
    }

    #[test]
    fn a_workspace_comes_back_from_the_second_place() {
        let (dir, place) = (temp_dir("lost"), temp_dir("lost-place"));
        std::fs::create_dir_all(&place).expect("the place");
        let sha = workspace(&dir);
        let id = info(&dir).expect("strata.json").workspace_id;
        let copies = mirror(&dir, &place).expect("mirrored").dir;
        let copy = list(&copies)[0].id.clone();
        // Into the workspace's own folder, from the second place's copy.
        restore_folder_from(&dir, &copies.join("backups").join(format!("{copy}.sqlite")))
            .expect("restored in place");
        // The folder gone with its disk: a new one from the folder of copies.
        std::fs::remove_dir_all(&dir).expect("the disk failed");
        let to = temp_dir("found");
        let restored = restore_into(&copies, &copy, &to).expect("restored");
        assert_eq!(
            (restored.workspace_id.as_str(), restored.mode.as_str()),
            (id.as_str(), "local")
        );
        let ws = open_folder(&to).expect("opens");
        assert_eq!(ws.id(), id);
        assert!(ws.tree().iter().any(|i| i.name == "Скетч"));
        assert_eq!(
            ws.asset(&sha).expect("read"),
            Some(b"\x89PNG a picture".to_vec())
        );
        drop(ws);
        // Never over a folder with something in it.
        assert!(restore_into(&copies, &copy, &to).is_err());
        let _ = std::fs::remove_dir_all(&to);
        let _ = std::fs::remove_dir_all(&place);
    }

    #[test]
    fn the_backup_thread_writes_to_the_second_place() {
        // A store with a second place: its day's copy goes there too.
        let (dir, place) = (temp_dir("thread"), temp_dir("thread-place"));
        std::fs::create_dir_all(&place).expect("the place");
        drop(create_folder(&dir, "Проект").expect("a folder"));
        drop(open_folder_with(&dir, Some(&place)).expect("opens"));
        let copies = copies_dir(&place, &info(&dir).expect("strata.json").workspace_id, &dir);
        assert_eq!(
            list(&copies).len(),
            1,
            "the day's copy, mirrored as the store closed"
        );
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&place);
    }
}
