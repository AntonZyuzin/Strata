//! The home screen's data (✅ Q-16-12): the workspaces this device knows —
//! «workspaceId → путь» of 10 §3.6 — newest first, a preview of each, and
//! the local profile (✅ Q-16-14). Device state (05 §13): it lives in the
//! app's data folder, never inside a workspace, so a copied folder does not
//! carry it.
//!
//! ```text
//! <data>/home.json              workspaces and profile
//! <data>/previews/<id>.png      a picture of each workspace's root network
//! <data>/Workspaces/<name>.strata  new workspaces (10 §3.1)
//! ```
//!
//! New workspaces go to the app's data folder rather than Documents: a
//! folder synced by iCloud or Dropbox would have two cores writing one
//! SQLite file (10 §3.6).

use crate::sqlite::{SqliteStore, create_folder, import_folder, open_folder, open_folder_with};
use crate::workspace::{CoreError, Result, Workspace};
use crate::{Label, Op};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use strata_model::now_ms;

/// A workspace on the home screen.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    /// The root network's name, as of the last time the workspace was open.
    pub name: String,
    pub path: PathBuf,
    pub opened_at: i64,
    /// The folder is gone from `path` (10 §3.6: «Пространство не найдено»).
    #[serde(default, skip_deserializing)]
    pub missing: bool,
}

/// «Я» on this device (✅ Q-16-14). On a server it is matched to an account (11 §7.3).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Profile {
    pub name: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Saved {
    workspaces: Vec<Entry>,
    #[serde(default)]
    profile: Profile,
    /// The second place for copies (10 §3.5, NFR-73): one a device.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    second_place: Option<PathBuf>,
    /// The first start asked about it already (☑ Q-14-9): asked once.
    #[serde(default)]
    second_offered: bool,
}

#[derive(Debug)]
pub struct Home {
    dir: PathBuf,
    saved: Saved,
}

fn io(e: impl std::fmt::Display) -> CoreError {
    CoreError::Store(crate::StoreError::Io(e.to_string()))
}

fn invalid(msg: impl Into<String>) -> CoreError {
    CoreError::Invalid(msg.into())
}

/// A folder name from a workspace name: no path separators or characters
/// Windows refuses, at most 60 characters.
fn folder_name(name: &str) -> String {
    let clean: String = name
        .trim()
        .chars()
        .map(|c| {
            if c.is_control() || r#"/\:*?"<>|"#.contains(c) {
                '-'
            } else {
                c
            }
        })
        .take(60)
        .collect();
    let clean = clean.trim_matches(|c: char| c == '.' || c.is_whitespace());
    if clean.is_empty() {
        "Strata".to_owned()
    } else {
        clean.to_owned()
    }
}

impl Home {
    /// The home of the app's data folder. A missing or unreadable
    /// `home.json` starts an empty list; a workspace folder made by an
    /// earlier build (`Strata.strata`) joins it.
    pub fn load(dir: &Path) -> Self {
        let saved = std::fs::read(dir.join("home.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        let mut home = Self {
            dir: dir.to_owned(),
            saved,
        };
        let early = dir.join("Strata.strata");
        let known = home.saved.workspaces.iter().any(|e| e.path == early);
        if !known
            && early.join("strata.json").exists()
            && let Ok(ws) = open_folder(&early)
        {
            home.remember(&ws, &early, 0);
            let _ = home.save();
        }
        home
    }

    fn save(&self) -> Result<()> {
        std::fs::create_dir_all(&self.dir).map_err(io)?;
        let json = serde_json::to_vec_pretty(&self.saved).map_err(io)?;
        // Written aside and renamed: a crash leaves the old list, not half a file.
        let tmp = self.dir.join("home.json.tmp");
        std::fs::write(&tmp, json).map_err(io)?;
        std::fs::rename(&tmp, self.dir.join("home.json")).map_err(io)
    }

    fn remember(&mut self, ws: &Workspace<SqliteStore>, path: &Path, at: i64) -> Entry {
        let entry = Entry {
            id: ws.id().to_owned(),
            name: ws.root_name(),
            path: path.to_owned(),
            opened_at: at,
            missing: false,
        };
        self.saved.workspaces.retain(|e| e.id != entry.id);
        self.saved.workspaces.push(entry.clone());
        entry
    }

    /// The workspaces, last opened first.
    pub fn list(&self) -> Vec<Entry> {
        let mut out: Vec<Entry> = self
            .saved
            .workspaces
            .iter()
            .map(|e| Entry {
                missing: !e.path.join("strata.json").exists(),
                ..e.clone()
            })
            .collect();
        out.sort_by(|a, b| b.opened_at.cmp(&a.opened_at).then(a.name.cmp(&b.name)));
        out
    }

    pub fn profile(&self) -> &Profile {
        &self.saved.profile
    }

    pub fn set_profile(&mut self, profile: Profile) -> Result<()> {
        self.saved.profile = Profile {
            name: profile.name.trim().to_owned(),
        };
        self.save()
    }

    /// The second place for copies (10 §3.5, NFR-73), if one is chosen.
    pub fn second_place(&self) -> Option<&Path> {
        self.saved.second_place.as_deref()
    }

    /// Whether the first start's question about the second place is answered.
    pub fn second_offered(&self) -> bool {
        self.saved.second_offered
    }

    /// «Второе место для копий» chosen, or none — «Не сейчас», «Убрать»;
    /// either way the first start's question is answered. Not a folder
    /// this device can write, a workspace's or copies' own folder, a
    /// folder inside a workspace: refused.
    pub fn set_second_place(&mut self, place: Option<PathBuf>) -> Result<()> {
        if let Some(p) = &place {
            self.check_place(p)?;
        }
        self.saved.second_place = place;
        self.saved.second_offered = true;
        self.save()
    }

    fn check_place(&self, place: &Path) -> Result<()> {
        let refused = |code, why: String| CoreError::Place(code, why);
        let real = place
            .canonicalize()
            .ok()
            .filter(|p| p.is_dir())
            .ok_or_else(|| refused("place-folder", format!("{} is no folder", place.display())))?;
        if real.join("strata.json").exists() {
            return Err(refused(
                "place-workspace",
                format!(
                    "{} is a workspace's folder or a folder of copies",
                    place.display()
                ),
            ));
        }
        for e in &self.saved.workspaces {
            if e.path.canonicalize().is_ok_and(|w| real.starts_with(w)) {
                return Err(refused(
                    "place-inside",
                    format!("{} lies inside the workspace «{}»", place.display(), e.name),
                ));
            }
        }
        // The copies must be writable there: a probe, at once gone.
        let probe = real.join(".gexogon-probe");
        std::fs::write(&probe, b"")
            .map_err(|e| refused("place-write", format!("{}: {e}", place.display())))?;
        let _ = std::fs::remove_file(&probe);
        Ok(())
    }

    /// A workspace's store learns where its copies go (10 §3.5).
    fn equip(&self, ws: &mut Workspace<SqliteStore>) {
        ws.store_mut()
            .set_second_place(self.saved.second_place.clone());
    }

    /// A folder of copies (10 §3.5): the workspace's name, as its newest
    /// copy has it, and its copies; none — it holds no copy that opens.
    pub fn copies(&self, dir: &Path) -> Result<(String, Vec<crate::backups::Backup>)> {
        let backups = crate::second::list(dir);
        let newest = backups
            .first()
            .ok_or_else(|| invalid(format!("{} holds no copy", dir.display())))?;
        let file = crate::folder::backup_path(dir, &newest.id)?;
        let ws = Workspace::open(SqliteStore::read(&file, None)?)
            .map_err(|e| crate::StoreError::Damaged(e.to_string()))?;
        Ok((ws.root_name(), backups))
    }

    /// A workspace back from a folder of copies (10 §3.5: its own folder is
    /// gone): copy `backup` and the assets become a new folder in
    /// `<data>/Workspaces`, with the workspace's id, opened.
    pub fn restore_copies(
        &mut self,
        dir: &Path,
        backup: &str,
    ) -> Result<(Workspace<SqliteStore>, Entry)> {
        let file = crate::folder::backup_path(dir, backup)?;
        let name = Workspace::open(SqliteStore::read(&file, None)?)
            .map_err(|e| crate::StoreError::Damaged(e.to_string()))?
            .root_name();
        let path = self.new_folder(&name);
        let info = crate::second::restore_into(dir, backup, &path)?;
        let ws = open_folder_with(&path, self.second_place())?;
        if ws.id() != info.workspace_id {
            return Err(
                crate::StoreError::Damaged(format!("a copy of workspace {}", ws.id())).into(),
            );
        }
        let entry = self.remember(&ws, &path, now_ms());
        self.save()?;
        Ok((ws, entry))
    }

    fn entry(&self, id: &str) -> Result<&Entry> {
        self.saved
            .workspaces
            .iter()
            .find(|e| e.id == id)
            .ok_or_else(|| invalid(format!("no workspace {id} on this device")))
    }

    /// A free folder in `<data>/Workspaces` for a workspace called `name`.
    fn new_folder(&self, name: &str) -> PathBuf {
        let parent = self.dir.join("Workspaces");
        let base = folder_name(name);
        let mut path = parent.join(format!("{base}.strata"));
        let mut n = 2;
        while path.exists() {
            path = parent.join(format!("{base} {n}.strata"));
            n += 1;
        }
        path
    }

    /// A new workspace in `<data>/Workspaces`, named `name`, opened.
    pub fn create(&mut self, name: &str) -> Result<(Workspace<SqliteStore>, Entry)> {
        let name = name.trim();
        if name.is_empty() {
            return Err(invalid("a workspace needs a name"));
        }
        let path = self.new_folder(name);
        let mut ws = create_folder(&path, name)?;
        self.equip(&mut ws);
        let entry = self.remember(&ws, &path, now_ms());
        self.save()?;
        Ok((ws, entry))
    }

    /// A workspace of the list, opened.
    pub fn open(&mut self, id: &str) -> Result<(Workspace<SqliteStore>, Entry)> {
        let path = self.entry(id)?.path.clone();
        let ws = open_folder_with(&path, self.second_place())?;
        if ws.id() != id {
            return Err(invalid(
                "the folder now holds another workspace: open it with «Открыть…»",
            ));
        }
        let entry = self.remember(&ws, &path, now_ms());
        self.save()?;
        Ok((ws, entry))
    }

    /// A workspace open in a tab comes to the canvas: it is the last opened.
    pub fn touch(&mut self, id: &str) -> Result<Entry> {
        let at = now_ms();
        let entry = self
            .saved
            .workspaces
            .iter_mut()
            .find(|e| e.id == id)
            .ok_or_else(|| invalid(format!("no workspace {id} on this device")))?;
        entry.opened_at = at;
        let entry = entry.clone();
        self.save()?;
        Ok(entry)
    }

    /// «Открыть пространство…» (10 §3.6): a folder of the user's choice, added
    /// to the list or, for a known workspace that moved, its new place.
    pub fn add(&mut self, path: &Path) -> Result<(Workspace<SqliteStore>, Entry)> {
        let ws = open_folder_with(path, self.second_place())?;
        let entry = self.remember(&ws, path, now_ms());
        self.save()?;
        Ok((ws, entry))
    }

    /// An archive (10 §3.5) as a new workspace in `<data>/Workspaces`,
    /// opened. A workspace this device already knows comes in as a copy with
    /// its own id (10 §3.6).
    pub fn import(&mut self, bytes: &[u8]) -> Result<(Workspace<SqliteStore>, Entry)> {
        let unpacked = crate::archive::unpack(bytes)?;
        let known = self
            .saved
            .workspaces
            .iter()
            .any(|e| e.id == unpacked.info.workspace_id);
        let path = self.new_folder(&unpacked.info.name);
        let mut ws = import_folder(&path, &unpacked, known)?;
        self.equip(&mut ws);
        let entry = self.remember(&ws, &path, now_ms());
        self.save()?;
        Ok((ws, entry))
    }

    /// A vault of Obsidian on disk (13 §3, S1) as a new workspace in
    /// `<data>/Workspaces`, named after the vault's folder, open and waiting
    /// for its import (13 §3.3): the vault is read, planned and written by
    /// [`run_import`] on the caller's thread. The vault is only read (13
    /// §1.4 item 1).
    fn start_import(
        &mut self,
        path: &Path,
        options: &crate::ImportOptions,
    ) -> Result<(Workspace<SqliteStore>, Entry, ImportTask)> {
        if !path.is_dir() {
            return Err(invalid(format!("{} is no folder", path.display())));
        }
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().trim().to_owned())
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| "Obsidian".to_owned());
        self.start(&name, VaultSource::Folder(path.to_owned()), options)
    }

    /// V-10k of `notes` notes (14 §1.3) as a new workspace, imported as a
    /// vault is: the benchmark's `import` scenario (14 §6, NFR-41).
    fn start_synth(
        &mut self,
        notes: usize,
        options: &crate::ImportOptions,
    ) -> Result<(Workspace<SqliteStore>, Entry, ImportTask)> {
        if notes == 0 {
            return Err(invalid("a synthetic vault needs notes"));
        }
        let spec = crate::synth::Spec {
            notes,
            ..crate::synth::Spec::V10K
        };
        self.start("V-10k", VaultSource::Synth(spec), options)
    }

    /// A new workspace `name`, open and waiting for the vault (13 §3.3).
    fn start(
        &mut self,
        name: &str,
        vault: VaultSource,
        options: &crate::ImportOptions,
    ) -> Result<(Workspace<SqliteStore>, Entry, ImportTask)> {
        let folder = self.new_folder(name);
        let mut ws = create_folder(&folder, name)?;
        self.equip(&mut ws);
        let shadow = ws.import_start(None)?;
        let entry = self.remember(&ws, &folder, now_ms());
        self.save()?;
        let task = ImportTask {
            workspace: entry.id.clone(),
            vault,
            options: options.clone(),
            shadow,
        };
        Ok((ws, entry, task))
    }

    /// A half-made workspace goes: an import that did not come in leaves
    /// none behind (13 §3).
    fn drop_import(&mut self, desk: &mut Desk, id: &str) {
        desk.release(id);
        if let Ok(path) = self.forget(id) {
            let _ = std::fs::remove_dir_all(path);
        }
    }

    /// Renames a workspace: its root network (05 §3), as a step of its own.
    pub fn rename(&mut self, ws: &mut Workspace<SqliteStore>, name: &str) -> Result<()> {
        let name = name.trim();
        if name.is_empty() {
            return Err(invalid("a workspace needs a name"));
        }
        let mut label = Label::new("home.change.rename");
        label.params.insert("name".into(), name.into());
        ws.apply(
            &[Op::Rename {
                id: ws.root(),
                name: name.to_owned(),
            }],
            label,
        )?;
        let id = ws.id().to_owned();
        if let Some(e) = self.saved.workspaces.iter_mut().find(|e| e.id == id) {
            e.name = name.to_owned();
        }
        self.save()
    }

    /// The workspace leaves the list; its folder stays where it is.
    pub fn forget(&mut self, id: &str) -> Result<PathBuf> {
        let path = self.entry(id)?.path.clone();
        self.saved.workspaces.retain(|e| e.id != id);
        let _ = std::fs::remove_file(self.preview_path(id));
        self.save()?;
        Ok(path)
    }

    fn preview_path(&self, id: &str) -> PathBuf {
        // Ids are Crockford base32: safe as file names.
        self.dir.join("previews").join(format!("{id}.png"))
    }

    pub fn set_preview(&self, id: &str, png: &[u8]) -> Result<()> {
        self.entry(id)?;
        let path = self.preview_path(id);
        std::fs::create_dir_all(path.parent().unwrap_or(&self.dir)).map_err(io)?;
        std::fs::write(path, png).map_err(io)
    }

    pub fn preview(&self, id: &str) -> Option<Vec<u8>> {
        std::fs::read(self.preview_path(id)).ok()
    }
}

/// The workspaces open in tabs (✅ Q-16-12: tabs of a retro browser), kept
/// in memory with their undo (05 §11): switching tabs keeps each one's
/// steps; closing a tab lets its workspace go. One of them is on the canvas.
#[derive(Debug, Default)]
pub struct Desk {
    tabs: Vec<Workspace<SqliteStore>>,
    current: Option<String>,
    /// Imports started and not yet handed to a thread.
    started: Vec<ImportTask>,
}

impl Desk {
    /// The workspace on the canvas.
    pub fn current(&self) -> Option<&Workspace<SqliteStore>> {
        let id = self.current.as_deref()?;
        self.tabs.iter().find(|w| w.id() == id)
    }

    pub fn current_mut(&mut self) -> Option<&mut Workspace<SqliteStore>> {
        let id = self.current.clone()?;
        self.get_mut(&id)
    }

    /// An open workspace, on the canvas or in a tab behind it.
    pub fn get_mut(&mut self, id: &str) -> Option<&mut Workspace<SqliteStore>> {
        self.tabs.iter_mut().find(|w| w.id() == id)
    }

    pub fn is_open(&self, id: &str) -> bool {
        self.tabs.iter().any(|w| w.id() == id)
    }

    /// The imports `importVault` started: the shell runs each on a thread
    /// of its own with [`run_import`] (13 §3.3).
    pub fn take_imports(&mut self) -> Vec<ImportTask> {
        std::mem::take(&mut self.started)
    }

    /// A workspace into its tab, on the canvas; one there with its id gives way.
    fn put(&mut self, ws: Workspace<SqliteStore>) -> String {
        let id = ws.id().to_owned();
        self.tabs.retain(|w| w.id() != id);
        self.tabs.push(ws);
        self.current = Some(id.clone());
        id
    }

    /// The tab closes: its workspace and its undo go.
    fn release(&mut self, id: &str) {
        self.tabs.retain(|w| w.id() != id);
        if self.current.as_deref() == Some(id) {
            self.current = None;
        }
    }
}

/// An import `importVault` started (13 §3.3): its workspace is open and
/// waits; [`run_import`] reads, plans and writes the vault.
pub struct ImportTask {
    /// The workspace the vault comes into.
    pub workspace: String,
    vault: VaultSource,
    options: crate::ImportOptions,
    shadow: crate::ImportShadow,
}

/// Where an import's vault comes from: a folder on disk, or V-10k that
/// the core makes for the benchmark's `import` scenario (14 §6, NFR-41).
#[derive(Clone, Debug)]
enum VaultSource {
    Folder(PathBuf),
    Synth(crate::synth::Spec),
}

impl VaultSource {
    /// The vault's files, read or made off the shell's lock (13 §3.3).
    fn vault(self) -> Result<crate::vault::Vault> {
        match self {
            Self::Folder(path) => crate::vault::Vault::read(&path).map_err(io),
            Self::Synth(spec) => Ok(crate::synth::vault(spec)),
        }
    }
}

impl std::fmt::Debug for ImportTask {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ImportTask")
            .field("workspace", &self.workspace)
            .field("vault", &self.vault)
            .finish_non_exhaustive()
    }
}

/// What an import tells the UI as it goes (13 §3.3): «Импорт: 1 840 из
/// 3 200», the report with the last batch, or its end without one.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ImportEvent {
    Progress {
        workspace: String,
        progress: crate::ImportProgress,
    },
    /// The vault did not come in; its workspace is gone.
    Failed { workspace: String, message: String },
    /// The import was cancelled, or its tab closed.
    Cancelled { workspace: String },
}

/// Lends the home list and the desk under the shell's lock for the time of
/// one call.
pub type Lend<'a> = &'a dyn Fn(&mut dyn FnMut(&mut Home, &mut Desk));

/// Runs an import [`handle`] started to its end on the caller's thread:
/// the vault is read and planned with no lock (13 §3.3), each batch under
/// `with`, which lends the home list and the desk while it holds the lock;
/// `tell` hears every step. A vault that does not come in leaves no
/// workspace behind; one whose workspace went meanwhile stops.
pub fn run_import(task: ImportTask, with: Lend<'_>, tell: &dyn Fn(ImportEvent)) {
    let ImportTask {
        workspace: id,
        vault,
        options,
        shadow,
        ..
    } = task;
    let fail = |e: CoreError| {
        with(&mut |home, desk| home.drop_import(desk, &id));
        tell(ImportEvent::Failed {
            workspace: id.clone(),
            message: e.to_string(),
        });
    };
    let planned = match vault.vault().and_then(|v| shadow.plan(v, &options)) {
        Ok(p) => p,
        Err(e) => return fail(e),
    };
    let mut planned = Some(planned);
    let mut step: Option<Result<crate::ImportProgress>> = None;
    with(&mut |_, desk| {
        if let (Some(ws), Some(p)) = (desk.get_mut(&id), planned.take()) {
            step = Some(ws.import_begin(p));
        }
    });
    loop {
        match step.take() {
            None => {
                return tell(ImportEvent::Cancelled {
                    workspace: id.clone(),
                });
            }
            Some(Err(e)) => return fail(e),
            Some(Ok(progress)) => {
                let done = progress.report.is_some();
                tell(ImportEvent::Progress {
                    workspace: id.clone(),
                    progress,
                });
                if done {
                    return;
                }
            }
        }
        // The next batch, made ready off the lock: only its writing holds it.
        let mut batch = None;
        with(&mut |_, desk| batch = desk.get_mut(&id).map(Workspace::import_take));
        let ready = match batch.map(|b| b.and_then(crate::ImportBatch::prepare)) {
            None => continue,
            Some(Err(e)) => return fail(e),
            Some(Ok(r)) => r,
        };
        let mut ready = Some(ready);
        with(&mut |_, desk| {
            if let (Some(ws), Some(r)) = (desk.get_mut(&id), ready.take()) {
                step = Some(ws.import_put(r));
            }
        });
    }
}

/// The home screen's calls as JSON, beside [`crate::api`] for the open workspace.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "call", rename_all = "camelCase")]
pub enum Request {
    /// The list, the profile and the open workspace.
    Home,
    Create {
        name: String,
    },
    Open {
        id: String,
    },
    /// «Открыть…»: a folder of the user's choice.
    Add {
        path: String,
    },
    /// Back to the home screen: the tabs stay open behind it.
    Close,
    /// A tab closes: its workspace leaves memory, its undo with it.
    Release {
        id: String,
    },
    Rename {
        id: String,
        name: String,
    },
    Forget {
        id: String,
    },
    /// The workspace's folder to the system trash, and off the list.
    Remove {
        id: String,
    },
    SetPreview {
        id: String,
        /// PNG in base64.
        png: String,
    },
    Preview {
        id: String,
    },
    SetProfile {
        profile: Profile,
    },
    /// The workspace as `.strata.zip` into the file `path` (10 §3.5).
    Export {
        id: String,
        path: String,
    },
    /// The copies of the workspace's store (10 §3.5), the newest first.
    Backups {
        id: String,
    },
    /// «Восстановить из копии» (10 §3.5): the workspace's store becomes its
    /// copy `backup` — of its folder, or of the second place (`second`);
    /// its tab closes first, and the workspace opens again.
    Restore {
        id: String,
        backup: String,
        #[serde(default)]
        second: bool,
    },
    /// «Второе место для копий» (10 §3.5, NFR-73): a folder, or none.
    SetSecondPlace {
        path: Option<String>,
    },
    /// A workspace back from the folder of copies `path`: its copy
    /// `backup` and the assets as a new workspace folder, opened.
    RestoreCopies {
        path: String,
        backup: String,
    },
    /// The archive at `path` as a new workspace, opened.
    Import {
        path: String,
    },
    /// The vault of Obsidian at `path` as a new workspace named after its
    /// folder, opened (13 §3, S1); its import goes on in the background
    /// (13 §3.3) and becomes its first step of undo.
    ImportVault {
        path: String,
        #[serde(default)]
        options: crate::ImportOptions,
    },
    /// V-10k of `notes` notes (14 §1.3), made by the core, as a new
    /// workspace «V-10k», imported in the background as a vault is: the
    /// benchmark's `import` scenario measures the canvas meanwhile (NFR-41).
    ImportSynth {
        notes: usize,
        #[serde(default)]
        options: crate::ImportOptions,
    },
    /// The import into workspace `id` stops; the workspace goes with it.
    CancelImport {
        id: String,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Response {
    #[serde(rename_all = "camelCase")]
    Home {
        workspaces: Vec<Entry>,
        profile: Profile,
        current: Option<String>,
        /// The second place for copies (10 §3.5); none — not chosen.
        second_place: Option<String>,
        /// The first start's question about it is answered.
        second_offered: bool,
    },
    /// A workspace is open: the canvas starts at its root network.
    Opened {
        workspace: Entry,
        root: String,
    },
    Preview {
        png: Option<String>,
    },
    Backups {
        backups: Vec<crate::backups::Backup>,
        /// The second place's copies of the workspace (10 §3.5).
        second: Vec<crate::backups::Backup>,
    },
    /// «Открыть…» found a folder of copies, not a workspace (10 §3.5):
    /// the workspace's name and its copies, for a restore.
    Copies {
        path: String,
        name: String,
        backups: Vec<crate::backups::Backup>,
    },
    /// A vault is coming in as a new workspace, open: its batches follow
    /// as `import` events (13 §3.3).
    Importing {
        workspace: Entry,
        root: String,
    },
    Done,
    Error {
        message: String,
        invalid: bool,
        /// What the interface words in its own way (`CoreError::code`): `locked`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        code: Option<String>,
    },
}

fn home_of(home: &Home, desk: &Desk) -> Response {
    Response::Home {
        workspaces: home.list(),
        profile: home.profile().clone(),
        current: desk.current.clone(),
        second_place: home
            .second_place()
            .map(|p| p.to_string_lossy().into_owned()),
        second_offered: home.second_offered(),
    }
}

/// The second place's folder of copies of the workspace in `path`, if any.
fn second_copies(home: &Home, id: &str, path: &Path) -> Option<PathBuf> {
    let dir = crate::second::copies_dir(home.second_place()?, id, path);
    crate::second::is_copies(&dir).then_some(dir)
}

/// An import started: its workspace in a tab, its task for the shell's thread.
fn importing(desk: &mut Desk, started: (Workspace<SqliteStore>, Entry, ImportTask)) -> Response {
    let (ws, workspace, task) = started;
    let root = ws.root();
    desk.put(ws);
    desk.started.push(task);
    Response::Importing { workspace, root }
}

/// One home call. `to_trash` moves a folder to the system trash: the shell
/// knows how (the desktop uses the OS; tests use a stub).
pub fn handle(
    home: &mut Home,
    desk: &mut Desk,
    request: Request,
    to_trash: &dyn Fn(&Path) -> std::result::Result<(), String>,
) -> Response {
    let opened = |desk: &mut Desk, done: Result<(Workspace<SqliteStore>, Entry)>| {
        done.map(|(ws, workspace)| {
            let root = ws.root();
            desk.put(ws);
            Response::Opened { workspace, root }
        })
    };
    let result = match request {
        Request::Home => Ok(home_of(home, desk)),
        Request::Create { name } => {
            let done = home.create(&name);
            opened(desk, done)
        }
        // A workspace in a tab comes back as it was, its undo too.
        Request::Open { id } => match desk.get_mut(&id).map(|w| w.root()) {
            Some(root) => home.touch(&id).map(|workspace| {
                desk.current = Some(id);
                Response::Opened { workspace, root }
            }),
            None => {
                let done = home.open(&id);
                opened(desk, done)
            }
        },
        // A folder of copies is no workspace: its copies, for a restore (10 §3.5).
        Request::Add { path } if crate::second::is_copies(Path::new(&path)) => home
            .copies(Path::new(&path))
            .map(|(name, backups)| Response::Copies {
                path,
                name,
                backups,
            }),
        // A folder this app has open already (its `.lock` is ours): its tab.
        Request::Add { path } => match crate::sqlite::folder_id(Path::new(&path)) {
            Ok(id) if desk.is_open(&id) => home.touch(&id).map(|workspace| {
                let root = desk.get_mut(&id).map(|w| w.root()).unwrap_or_default();
                desk.current = Some(id);
                Response::Opened { workspace, root }
            }),
            _ => {
                let done = home.add(Path::new(&path));
                opened(desk, done)
            }
        },
        Request::Close => {
            desk.current = None;
            Ok(home_of(home, desk))
        }
        Request::Release { id } => {
            desk.release(&id);
            Ok(home_of(home, desk))
        }
        Request::Rename { id, name } => {
            let done = match desk.get_mut(&id) {
                Some(ws) => home.rename(ws, &name),
                None => home
                    .open(&id)
                    .and_then(|(mut ws, _)| home.rename(&mut ws, &name)),
            };
            done.map(|()| home_of(home, desk))
        }
        Request::Forget { id } => {
            desk.release(&id);
            home.forget(&id).map(|_| home_of(home, desk))
        }
        Request::Remove { id } => {
            desk.release(&id);
            match home.entry(&id).map(|e| (e.path.clone(), e.missing)) {
                Ok((path, _)) => {
                    let gone = !path.exists() || to_trash(&path).is_ok();
                    if gone {
                        home.forget(&id).map(|_| home_of(home, desk))
                    } else {
                        Err(io(format!("{} could not go to the trash", path.display())))
                    }
                }
                Err(e) => Err(e),
            }
        }
        Request::SetPreview { id, png } => B64
            .decode(png)
            .map_err(|e| invalid(format!("png: {e}")))
            .and_then(|bytes| home.set_preview(&id, &bytes))
            .map(|()| Response::Done),
        Request::Preview { id } => Ok(Response::Preview {
            png: home.preview(&id).map(|b| B64.encode(b)),
        }),
        Request::SetProfile { profile } => home.set_profile(profile).map(|()| home_of(home, desk)),
        Request::Export { id, path } => {
            let bytes = match desk.get_mut(&id) {
                Some(ws) => crate::archive::export(ws),
                None => home
                    .entry(&id)
                    .map(|e| e.path.clone())
                    .and_then(|p| open_folder(&p))
                    .and_then(|ws| crate::archive::export(&ws)),
            };
            bytes
                .and_then(|b| std::fs::write(&path, b).map_err(io))
                .map(|()| Response::Done)
        }
        Request::Backups { id } => home.entry(&id).map(|e| Response::Backups {
            backups: crate::folder::list(&e.path),
            second: second_copies(home, &id, &e.path)
                .map(|dir| crate::second::list(&dir))
                .unwrap_or_default(),
        }),
        Request::Restore { id, backup, second } => {
            // The tab lets the folder go: its `.lock` is the restore's for the while.
            desk.release(&id);
            let done = home
                .entry(&id)
                .map(|e| e.path.clone())
                .and_then(|path| {
                    if !second {
                        return crate::sqlite::restore_folder(&path, &backup);
                    }
                    let dir = second_copies(home, &id, &path)
                        .ok_or_else(|| invalid("the second place has no copies of it"))?;
                    let from = crate::folder::backup_path(&dir, &backup)?;
                    crate::sqlite::restore_folder_from(&path, &from)
                })
                .and_then(|()| home.open(&id));
            opened(desk, done)
        }
        Request::SetSecondPlace { path } => {
            let place = path.map(PathBuf::from);
            home.set_second_place(place.clone()).map(|()| {
                // The open workspaces copy there from now on, starting now.
                for ws in &mut desk.tabs {
                    ws.store_mut().set_second_place(place.clone());
                    ws.store_mut().mirror_now();
                }
                home_of(home, desk)
            })
        }
        Request::RestoreCopies { path, backup } => {
            let done = home.restore_copies(Path::new(&path), &backup);
            opened(desk, done)
        }
        Request::Import { path } => {
            let done = std::fs::read(&path)
                .map_err(io)
                .and_then(|b| home.import(&b));
            opened(desk, done)
        }
        Request::ImportVault { path, options } => home
            .start_import(Path::new(&path), &options)
            .map(|started| importing(desk, started)),
        Request::ImportSynth { notes, options } => home
            .start_synth(notes, &options)
            .map(|started| importing(desk, started)),
        Request::CancelImport { id } => {
            home.drop_import(desk, &id);
            Ok(home_of(home, desk))
        }
    };
    result.unwrap_or_else(|e| Response::Error {
        invalid: matches!(e, CoreError::Invalid(_) | CoreError::Place(..)),
        code: e.code().map(str::to_owned),
        message: e.to_string(),
    })
}

/// [`handle`] on JSON.
pub fn call(
    home: &mut Home,
    desk: &mut Desk,
    json: &str,
    to_trash: &dyn Fn(&Path) -> std::result::Result<(), String>,
) -> String {
    let response = match serde_json::from_str::<Request>(json) {
        Ok(r) => handle(home, desk, r, to_trash),
        Err(e) => Response::Error {
            message: format!("bad request: {e}"),
            invalid: true,
            code: None,
        },
    };
    serde_json::to_string(&response).unwrap_or_else(|e| {
        format!(r#"{{"type":"error","message":"response: {e}","invalid":false}}"#)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    use strata_model::NodeId;

    fn temp_dir() -> PathBuf {
        std::env::temp_dir().join(format!("strata-home-{}", NodeId::new().to_text()))
    }

    fn ask(home: &mut Home, desk: &mut Desk, v: Value) -> Value {
        let trash = |p: &Path| std::fs::remove_dir_all(p).map_err(|e| e.to_string());
        serde_json::from_str(&call(home, desk, &v.to_string(), &trash)).expect("json")
    }

    #[test]
    fn the_home_screen_creates_lists_and_reopens_workspaces() {
        let dir = temp_dir();
        let mut home = Home::load(&dir);
        let mut current = Desk::default();
        let a = ask(
            &mut home,
            &mut current,
            json!({ "call": "create", "name": "Работа: план/факт" }),
        );
        assert_eq!(a["type"], "opened");
        let a_id = a["workspace"]["id"].as_str().expect("id").to_owned();
        assert!(current.current().is_some());
        let folder = PathBuf::from(a["workspace"]["path"].as_str().expect("path"));
        assert_eq!(
            folder.file_name().and_then(|f| f.to_str()),
            Some("Работа- план-факт.strata")
        );

        let b = ask(
            &mut home,
            &mut current,
            json!({ "call": "create", "name": "Личное" }),
        );
        let b_id = b["workspace"]["id"].as_str().expect("id").to_owned();
        let list = ask(&mut home, &mut current, json!({ "call": "home" }));
        let names: Vec<&str> = list["workspaces"]
            .as_array()
            .expect("list")
            .iter()
            .map(|e| e["name"].as_str().unwrap_or(""))
            .collect();
        assert_eq!(
            names,
            vec!["Личное", "Работа: план/факт"],
            "last opened first"
        );
        assert_eq!(list["current"], b_id.as_str());

        // Rename the closed one, then reopen it: the name is its root's.
        ask(
            &mut home,
            &mut current,
            json!({ "call": "rename", "id": a_id, "name": "Работа" }),
        );
        let again = ask(
            &mut home,
            &mut current,
            json!({ "call": "open", "id": a_id }),
        );
        assert_eq!(again["workspace"]["name"], "Работа");
        let root = again["root"].as_str().expect("root").to_owned();
        let view = current
            .current_mut()
            .expect("open")
            .network_view(&root)
            .expect("view");
        assert_eq!(view.name, "Работа");

        // The list outlives the app.
        ask(
            &mut home,
            &mut current,
            json!({ "call": "setProfile", "profile": { "name": " Антон " } }),
        );
        let mut later = Home::load(&dir);
        let mut none = Desk::default();
        let list = ask(&mut later, &mut none, json!({ "call": "home" }));
        assert_eq!(list["workspaces"].as_array().map(Vec::len), Some(2));
        assert_eq!(list["profile"]["name"], "Антон");
        assert_eq!(list["current"], Value::Null);

        // Previews, forgetting, removing.
        let png = B64.encode([0x89, b'P', b'N', b'G']);
        assert_eq!(
            ask(
                &mut later,
                &mut none,
                json!({ "call": "setPreview", "id": b_id, "png": png })
            )["type"],
            "done"
        );
        assert_eq!(
            ask(
                &mut later,
                &mut none,
                json!({ "call": "preview", "id": b_id })
            )["png"],
            png
        );
        let removed = ask(
            &mut later,
            &mut none,
            json!({ "call": "remove", "id": a_id }),
        );
        assert_eq!(removed["workspaces"].as_array().map(Vec::len), Some(1));
        assert!(!folder.exists(), "the folder went to the trash");
        let forgot = ask(
            &mut later,
            &mut none,
            json!({ "call": "forget", "id": b_id }),
        );
        assert_eq!(forgot["workspaces"].as_array().map(Vec::len), Some(0));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn tabs_keep_their_workspaces_and_their_undo() {
        let dir = temp_dir();
        let mut home = Home::load(&dir);
        let mut desk = Desk::default();
        let a = ask(
            &mut home,
            &mut desk,
            json!({ "call": "create", "name": "А" }),
        );
        let a_id = a["workspace"]["id"].as_str().expect("id").to_owned();
        let root = a["root"].as_str().expect("root").to_owned();
        let step = json!({
            "call": "apply",
            "label": { "key": "t.create" },
            "ops": [{ "op": "createNode", "kind": "note", "name": "Заметка", "net": root, "x": 0, "y": 0 }],
        });
        let ws = desk.current_mut().expect("A on the canvas");
        let out: Value =
            serde_json::from_str(&crate::api::call(ws, &step.to_string())).expect("json");
        assert_eq!(out["type"], "applied");
        let undo = |desk: &Desk| desk.current().and_then(|w| w.history().undo);

        // Another tab, then back: A's step can still be undone.
        let b = ask(
            &mut home,
            &mut desk,
            json!({ "call": "create", "name": "Б" }),
        );
        assert_eq!(
            desk.current().map(Workspace::id),
            b["workspace"]["id"].as_str()
        );
        assert_eq!(undo(&desk), None);
        let back = ask(&mut home, &mut desk, json!({ "call": "open", "id": a_id }));
        assert_eq!(back["type"], "opened");
        assert_eq!(back["root"], root.as_str());
        assert_eq!(
            undo(&desk),
            Some(Label::new("t.create")),
            "the undo of A kept"
        );
        let list = ask(&mut home, &mut desk, json!({ "call": "home" }));
        assert_eq!(
            list["workspaces"][0]["id"],
            a_id.as_str(),
            "the last opened first"
        );

        // The home screen keeps the tabs behind it.
        ask(&mut home, &mut desk, json!({ "call": "close" }));
        assert!(desk.current().is_none() && desk.is_open(&a_id));
        ask(&mut home, &mut desk, json!({ "call": "open", "id": a_id }));
        assert_eq!(undo(&desk), Some(Label::new("t.create")));

        // A closed tab lets its workspace go: opened again, it starts afresh.
        let gone = ask(
            &mut home,
            &mut desk,
            json!({ "call": "release", "id": a_id }),
        );
        assert_eq!(gone["current"], Value::Null);
        assert!(!desk.is_open(&a_id));
        ask(&mut home, &mut desk, json!({ "call": "open", "id": a_id }));
        assert_eq!(undo(&desk), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_workspace_comes_back_from_a_copy_through_the_home_screen() {
        // 10 §3.5: «Восстановить из копии» on a card — the tab lets the folder
        // go, the store becomes the copy, and the workspace opens afresh.
        let dir = temp_dir();
        let mut home = Home::load(&dir);
        let mut desk = Desk::default();
        let a = ask(
            &mut home,
            &mut desk,
            json!({ "call": "create", "name": "Копии" }),
        );
        let id = a["workspace"]["id"].as_str().expect("id").to_owned();
        let root = a["root"].as_str().expect("root").to_owned();
        let folder = PathBuf::from(a["workspace"]["path"].as_str().expect("path"));
        let backups = |home: &mut Home, desk: &mut Desk| {
            ask(home, desk, json!({ "call": "backups", "id": id }))
        };
        assert_eq!(
            backups(&mut home, &mut desk),
            json!({ "type": "backups", "backups": [], "second": [] })
        );
        crate::folder::back_up(&folder.join("store.sqlite")).expect("today's copy");
        let step = json!({
            "call": "apply",
            "label": { "key": "t.create" },
            "ops": [{ "op": "createNode", "kind": "note", "name": "После копии", "net": root, "x": 0, "y": 0 }],
        });
        let ws = desk.current_mut().expect("open");
        let out: Value =
            serde_json::from_str(&crate::api::call(ws, &step.to_string())).expect("json");
        assert_eq!(out["type"], "applied");
        let list = backups(&mut home, &mut desk);
        let copy = list["backups"][0].clone();
        assert_eq!(copy["kind"], "day", "{list}");

        // Its tab is open: the restore lets it go first.
        let back = ask(
            &mut home,
            &mut desk,
            json!({ "call": "restore", "id": id, "backup": copy["id"] }),
        );
        assert_eq!(back["type"], "opened", "{back}");
        let ws = desk.current_mut().expect("open again");
        assert!(
            ws.network_view(&root).expect("view").nodes.is_empty(),
            "the note came after the copy"
        );
        assert_eq!(ws.history().undo, None, "no undo across a restore");
        let list = backups(&mut home, &mut desk);
        assert_eq!(list["backups"][0]["kind"], "replaced", "{list}");

        // A copy that is not there: said so.
        let none = ask(
            &mut home,
            &mut desk,
            json!({ "call": "restore", "id": id, "backup": "store-20200101" }),
        );
        assert_eq!(none["type"], "error", "{none}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn copies_go_to_the_second_place_and_a_workspace_comes_back_from_it() {
        // 10 §3.5, NFR-73: one place a device, asked once; the day's copy
        // and the assets go there; a lost folder comes back from it.
        let dir = temp_dir();
        let place = temp_dir();
        std::fs::create_dir_all(&place).expect("the place");
        let mut home = Home::load(&dir);
        let mut desk = Desk::default();
        let state = ask(&mut home, &mut desk, json!({ "call": "home" }));
        assert_eq!(
            (state["secondPlace"].clone(), state["secondOffered"].clone()),
            (Value::Null, json!(false))
        );
        let a = ask(
            &mut home,
            &mut desk,
            json!({ "call": "create", "name": "Архив" }),
        );
        let id = a["workspace"]["id"].as_str().expect("id").to_owned();
        let folder = PathBuf::from(a["workspace"]["path"].as_str().expect("path"));
        // Not a place, each said by its code: a folder inside the workspace,
        // the workspace itself, no folder at all.
        for (wrong, code) in [
            (folder.join("backups"), "place-inside"),
            (folder.clone(), "place-workspace"),
            (place.join("нет такой"), "place-folder"),
        ] {
            if code != "place-folder" {
                std::fs::create_dir_all(&wrong).expect("a folder");
            }
            let no = ask(
                &mut home,
                &mut desk,
                json!({ "call": "setSecondPlace", "path": wrong.to_string_lossy() }),
            );
            assert_eq!(
                (no["type"].clone(), no["code"].clone()),
                (json!("error"), json!(code)),
                "{no}"
            );
        }
        crate::folder::back_up(&folder.join("store.sqlite")).expect("today's copy");
        // Chosen: the open workspace's copy goes there at once.
        let set = ask(
            &mut home,
            &mut desk,
            json!({ "call": "setSecondPlace", "path": place.to_string_lossy() }),
        );
        assert_eq!(set["secondPlace"], json!(place.to_string_lossy()), "{set}");
        assert_eq!(set["secondOffered"], json!(true));
        ask(&mut home, &mut desk, json!({ "call": "release", "id": id }));
        let list = ask(&mut home, &mut desk, json!({ "call": "backups", "id": id }));
        assert_eq!(list["second"].as_array().map(Vec::len), Some(1), "{list}");
        let copy = list["second"][0]["id"].clone();
        // Restored from the second place's copy, in its own folder.
        let back = ask(
            &mut home,
            &mut desk,
            json!({ "call": "restore", "id": id, "backup": copy, "second": true }),
        );
        assert_eq!(back["type"], "opened", "{back}");
        ask(&mut home, &mut desk, json!({ "call": "release", "id": id }));
        // The folder gone with its disk: «Открыть…» on the folder of copies.
        std::fs::remove_dir_all(&folder).expect("the disk failed");
        let copies = crate::second::copies_dir(&place, &id, &folder);
        let found = ask(
            &mut home,
            &mut desk,
            json!({ "call": "add", "path": copies.to_string_lossy() }),
        );
        assert_eq!(
            (found["type"].clone(), found["name"].clone()),
            (json!("copies"), json!("Архив")),
            "{found}"
        );
        let again = ask(
            &mut home,
            &mut desk,
            json!({ "call": "restoreCopies", "path": copies.to_string_lossy(), "backup": found["backups"][0]["id"] }),
        );
        assert_eq!(again["type"], "opened", "{again}");
        assert_eq!(again["workspace"]["id"], json!(id), "the same workspace");
        let restored = PathBuf::from(again["workspace"]["path"].as_str().expect("path"));
        assert!(restored.join("store.sqlite").is_file());
        // The list knows it once, at its new folder; «Убрать» takes the place off.
        let state = ask(&mut home, &mut desk, json!({ "call": "home" }));
        assert_eq!(
            state["workspaces"].as_array().map(Vec::len),
            Some(1),
            "{state}"
        );
        let off = ask(
            &mut home,
            &mut desk,
            json!({ "call": "setSecondPlace", "path": null }),
        );
        assert_eq!(
            (off["secondPlace"].clone(), off["secondOffered"].clone()),
            (Value::Null, json!(true))
        );
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&place);
    }

    #[test]
    fn a_folder_opened_by_hand_joins_the_list() {
        let dir = temp_dir();
        let elsewhere = temp_dir().join("Мой проект.strata");
        let id = create_folder(&elsewhere, "Мой проект")
            .expect("folder")
            .id()
            .to_owned();
        let mut home = Home::load(&dir);
        let mut current = Desk::default();
        let opened = ask(
            &mut home,
            &mut current,
            json!({ "call": "add", "path": elsewhere.to_string_lossy() }),
        );
        assert_eq!(opened["workspace"]["id"], id.as_str());
        assert_eq!(opened["workspace"]["name"], "Мой проект");
        // A folder that is not a workspace is refused.
        let bad = ask(
            &mut home,
            &mut current,
            json!({ "call": "add", "path": dir.to_string_lossy() }),
        );
        assert_eq!(bad["type"], "error");
        // A folder gone missing stays on the list, marked.
        current = Desk::default();
        std::fs::remove_dir_all(&elsewhere).expect("rm");
        let list = ask(&mut home, &mut current, json!({ "call": "home" }));
        assert_eq!(list["workspaces"][0]["missing"], true);
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(elsewhere.parent().expect("parent"));
    }

    #[test]
    fn the_first_build_s_workspace_is_adopted() {
        let dir = temp_dir();
        let (ws, _) = crate::sqlite::open_or_create(&dir, "Strata").expect("early");
        let id = ws.id().to_owned();
        drop(ws);
        let home = Home::load(&dir);
        assert_eq!(
            home.list().first().map(|e| e.id.as_str()),
            Some(id.as_str())
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn archives_go_out_and_come_back_as_copies() {
        let dir = temp_dir();
        let mut home = Home::load(&dir);
        let mut current = Desk::default();
        let made = ask(
            &mut home,
            &mut current,
            json!({ "call": "create", "name": "Проект" }),
        );
        let id = made["workspace"]["id"].as_str().expect("id").to_owned();
        let zip = dir.join("Проект.strata.zip");
        let out = ask(
            &mut home,
            &mut current,
            json!({ "call": "export", "id": id, "path": zip.to_string_lossy() }),
        );
        assert_eq!(out["type"], "done");
        // The same device knows it: the archive comes in as a copy.
        let copy = ask(
            &mut home,
            &mut current,
            json!({ "call": "import", "path": zip.to_string_lossy() }),
        );
        assert_eq!(copy["type"], "opened");
        assert_ne!(copy["workspace"]["id"], id.as_str());
        assert_eq!(copy["workspace"]["name"], "Проект");
        let list = ask(&mut home, &mut current, json!({ "call": "home" }));
        assert_eq!(list["workspaces"].as_array().map(Vec::len), Some(2));
        // Another device does not: the same id.
        let other = temp_dir();
        let mut there = Home::load(&other);
        let mut none = Desk::default();
        let moved = ask(
            &mut there,
            &mut none,
            json!({ "call": "import", "path": zip.to_string_lossy() }),
        );
        assert_eq!(moved["workspace"]["id"], id.as_str());
        let bad = ask(
            &mut there,
            &mut none,
            json!({ "call": "import", "path": dir.join("home.json").to_string_lossy() }),
        );
        assert_eq!(bad["type"], "error");
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&other);
    }

    #[test]
    fn a_vault_comes_in_as_a_new_workspace_and_stays_unchanged() {
        // 13 §3, S1: the vault's folder name, opened in a tab whose first
        // step of undo is the import; the vault is only read (13 §1.4).
        let dir = temp_dir();
        let vault = temp_dir().join("Мой vault");
        std::fs::create_dir_all(vault.join("Папка")).expect("vault");
        std::fs::write(vault.join("Папка/Заметка.md"), "[[Другая]]\n").expect("note");
        std::fs::write(vault.join("Другая.md"), "Текст\n").expect("note");
        let mtime = |p: &Path| std::fs::metadata(p).and_then(|m| m.modified()).ok();
        let before = mtime(&vault.join("Другая.md"));
        let mut home = Home::load(&dir);
        let mut desk = Desk::default();
        let r = ask(
            &mut home,
            &mut desk,
            json!({ "call": "importVault", "path": vault.to_string_lossy(), "options": { "unlinked": "Без ссылок" } }),
        );
        assert_eq!(r["type"], "importing", "{r}");
        assert_eq!(r["workspace"]["name"], "Мой vault");
        // Open in its tab and waiting: no other change till the import ends.
        let ws = desk.current_mut().expect("open in a tab");
        assert!(ws.import_progress().is_some());
        let events = run(&mut home, &mut desk);
        let Some(ImportEvent::Progress { progress, .. }) = events.last() else {
            panic!("{events:?}");
        };
        assert_eq!(progress.report.as_ref().map(|r| r.counts.notes), Some(2));
        assert_eq!((progress.done, progress.total), (2, 2));
        let ws = desk.current_mut().expect("open in a tab");
        assert_eq!(
            ws.history().undo.map(|l| l.key).as_deref(),
            Some("core.change.import")
        );
        assert_eq!(ws.tree().len(), 4, "root, folder and two notes");
        assert_eq!(mtime(&vault.join("Другая.md")), before);
        // A folder with nothing to import leaves no workspace.
        let empty = temp_dir();
        std::fs::create_dir_all(&empty).expect("empty");
        let r = ask(
            &mut home,
            &mut desk,
            json!({ "call": "importVault", "path": empty.to_string_lossy() }),
        );
        assert_eq!(r["type"], "importing");
        let events = run(&mut home, &mut desk);
        assert!(
            matches!(events.last(), Some(ImportEvent::Failed { .. })),
            "{events:?}"
        );
        assert_eq!(home.list().len(), 1);
        // A cancelled one neither: its tab and its folder go.
        let r = ask(
            &mut home,
            &mut desk,
            json!({ "call": "importVault", "path": vault.to_string_lossy() }),
        );
        let id = r["workspace"]["id"].as_str().expect("id").to_owned();
        let folder = home.entry(&id).expect("listed").path.clone();
        ask(
            &mut home,
            &mut desk,
            json!({ "call": "cancelImport", "id": id }),
        );
        let events = run(&mut home, &mut desk);
        assert!(
            matches!(events.last(), Some(ImportEvent::Cancelled { .. })),
            "{events:?}"
        );
        assert!(!desk.is_open(&id) && !folder.exists());
        assert_eq!(home.list().len(), 1);
        for d in [dir, vault, empty] {
            let _ = std::fs::remove_dir_all(d);
        }
    }

    #[test]
    fn the_benchmark_imports_v10k_the_core_makes() {
        // 14 §6, NFR-41: the `import` scenario's vault, made by the core and
        // imported in the background as a picked folder is.
        let dir = temp_dir();
        let mut home = Home::load(&dir);
        let mut desk = Desk::default();
        let r = ask(
            &mut home,
            &mut desk,
            json!({ "call": "importSynth", "notes": 40, "options": { "unlinked": "Без ссылок" } }),
        );
        assert_eq!(r["type"], "importing", "{r}");
        assert_eq!(r["workspace"]["name"], "V-10k");
        let events = run(&mut home, &mut desk);
        let Some(ImportEvent::Progress { progress, .. }) = events.last() else {
            panic!("{events:?}");
        };
        let counts = &progress.report.as_ref().expect("the report").counts;
        // Each canvas's text card is a note too.
        assert_eq!(
            counts.notes + counts.tasks + counts.lists,
            40 + counts.canvases
        );
        assert!(counts.folders > 0 && counts.wires > 0, "{counts:?}");
        let id = r["workspace"]["id"].as_str().expect("id");
        assert!(desk.is_open(id));
        let none = ask(
            &mut home,
            &mut desk,
            json!({ "call": "importSynth", "notes": 0 }),
        );
        assert_eq!(none["type"], "error");
        assert_eq!(home.list().len(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn an_import_goes_to_a_thread_of_its_own() {
        // 13 §3.3: the shell moves the task to a thread and lends the desk.
        fn send<T: Send>() {}
        send::<ImportTask>();
        send::<ImportEvent>();
        send::<crate::ReadyBatch>();
    }

    /// The imports a call started, run here to their end as a shell's thread would.
    fn run(home: &mut Home, desk: &mut Desk) -> Vec<ImportEvent> {
        let tasks = desk.take_imports();
        let events = std::cell::RefCell::new(Vec::new());
        let lent = std::cell::RefCell::new((home, desk));
        for task in tasks {
            run_import(
                task,
                &|f| {
                    let mut l = lent.borrow_mut();
                    let (h, d) = &mut *l;
                    f(h, d);
                },
                &|e| events.borrow_mut().push(e),
            );
        }
        events.into_inner()
    }

    #[test]
    fn folder_names_are_safe_everywhere() {
        assert_eq!(
            folder_name("  a/b\\c:d*e?f\"g<h>i|j  "),
            "a-b-c-d-e-f-g-h-i-j"
        );
        assert_eq!(folder_name("..."), "Strata");
        assert_eq!(folder_name(&"я".repeat(100)).chars().count(), 60);
    }
}
