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

use crate::sqlite::{SqliteStore, create_folder, open_folder};
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
struct Saved {
    workspaces: Vec<Entry>,
    #[serde(default)]
    profile: Profile,
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
        if !known && early.join("strata.json").exists() {
            if let Ok(ws) = open_folder(&early) {
                home.remember(&ws, &early, 0);
                let _ = home.save();
            }
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

    fn entry(&self, id: &str) -> Result<&Entry> {
        self.saved
            .workspaces
            .iter()
            .find(|e| e.id == id)
            .ok_or_else(|| invalid(format!("no workspace {id} on this device")))
    }

    /// A new workspace in `<data>/Workspaces`, named `name`, opened.
    pub fn create(&mut self, name: &str) -> Result<(Workspace<SqliteStore>, Entry)> {
        let name = name.trim();
        if name.is_empty() {
            return Err(invalid("a workspace needs a name"));
        }
        let parent = self.dir.join("Workspaces");
        let base = folder_name(name);
        let mut path = parent.join(format!("{base}.strata"));
        let mut n = 2;
        while path.exists() {
            path = parent.join(format!("{base} {n}.strata"));
            n += 1;
        }
        let ws = create_folder(&path, name)?;
        let entry = self.remember(&ws, &path, now_ms());
        self.save()?;
        Ok((ws, entry))
    }

    /// A workspace of the list, opened.
    pub fn open(&mut self, id: &str) -> Result<(Workspace<SqliteStore>, Entry)> {
        let path = self.entry(id)?.path.clone();
        let ws = open_folder(&path)?;
        if ws.id() != id {
            return Err(invalid(
                "the folder now holds another workspace: open it with «Открыть…»",
            ));
        }
        let entry = self.remember(&ws, &path, now_ms());
        self.save()?;
        Ok((ws, entry))
    }

    /// «Открыть пространство…» (10 §3.6): a folder of the user's choice, added
    /// to the list or, for a known workspace that moved, its new place.
    pub fn add(&mut self, path: &Path) -> Result<(Workspace<SqliteStore>, Entry)> {
        let ws = open_folder(path)?;
        let entry = self.remember(&ws, path, now_ms());
        self.save()?;
        Ok((ws, entry))
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
    /// Back to the home screen: the open workspace closes.
    Close,
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
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Response {
    Home {
        workspaces: Vec<Entry>,
        profile: Profile,
        current: Option<String>,
    },
    /// A workspace is open: the canvas starts at its root network.
    Opened {
        workspace: Entry,
        root: String,
    },
    Preview {
        png: Option<String>,
    },
    Done,
    Error {
        message: String,
        invalid: bool,
    },
}

fn home_of(home: &Home, current: &Option<Workspace<SqliteStore>>) -> Response {
    Response::Home {
        workspaces: home.list(),
        profile: home.profile().clone(),
        current: current.as_ref().map(|w| w.id().to_owned()),
    }
}

/// One home call. `to_trash` moves a folder to the system trash: the shell
/// knows how (the desktop uses the OS; tests use a stub).
pub fn handle(
    home: &mut Home,
    current: &mut Option<Workspace<SqliteStore>>,
    request: Request,
    to_trash: &dyn Fn(&Path) -> std::result::Result<(), String>,
) -> Response {
    let opened = |current: &mut Option<Workspace<SqliteStore>>,
                  done: Result<(Workspace<SqliteStore>, Entry)>| {
        done.map(|(ws, workspace)| {
            let root = ws.root();
            *current = Some(ws);
            Response::Opened { workspace, root }
        })
    };
    let result = match request {
        Request::Home => Ok(home_of(home, current)),
        Request::Create { name } => {
            *current = None;
            let done = home.create(&name);
            opened(current, done)
        }
        Request::Open { id } => {
            *current = None;
            let done = home.open(&id);
            opened(current, done)
        }
        Request::Add { path } => {
            *current = None;
            let done = home.add(Path::new(&path));
            opened(current, done)
        }
        Request::Close => {
            *current = None;
            Ok(home_of(home, current))
        }
        Request::Rename { id, name } => {
            let done = match current.as_mut().filter(|w| w.id() == id) {
                Some(ws) => home.rename(ws, &name),
                None => home
                    .open(&id)
                    .and_then(|(mut ws, _)| home.rename(&mut ws, &name)),
            };
            done.map(|()| home_of(home, current))
        }
        Request::Forget { id } => {
            if current.as_ref().is_some_and(|w| w.id() == id) {
                *current = None;
            }
            home.forget(&id).map(|_| home_of(home, current))
        }
        Request::Remove { id } => {
            if current.as_ref().is_some_and(|w| w.id() == id) {
                *current = None;
            }
            match home.entry(&id).map(|e| (e.path.clone(), e.missing)) {
                Ok((path, _)) => {
                    let gone = !path.exists() || to_trash(&path).is_ok();
                    if gone {
                        home.forget(&id).map(|_| home_of(home, current))
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
        Request::SetProfile { profile } => {
            home.set_profile(profile).map(|()| home_of(home, current))
        }
    };
    result.unwrap_or_else(|e| Response::Error {
        invalid: matches!(e, CoreError::Invalid(_)),
        message: e.to_string(),
    })
}

/// [`handle`] on JSON.
pub fn call(
    home: &mut Home,
    current: &mut Option<Workspace<SqliteStore>>,
    json: &str,
    to_trash: &dyn Fn(&Path) -> std::result::Result<(), String>,
) -> String {
    let response = match serde_json::from_str::<Request>(json) {
        Ok(r) => handle(home, current, r, to_trash),
        Err(e) => Response::Error {
            message: format!("bad request: {e}"),
            invalid: true,
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

    fn ask(home: &mut Home, current: &mut Option<Workspace<SqliteStore>>, v: Value) -> Value {
        let trash = |p: &Path| std::fs::remove_dir_all(p).map_err(|e| e.to_string());
        serde_json::from_str(&call(home, current, &v.to_string(), &trash)).expect("json")
    }

    #[test]
    fn the_home_screen_creates_lists_and_reopens_workspaces() {
        let dir = temp_dir();
        let mut home = Home::load(&dir);
        let mut current = None;
        let a = ask(
            &mut home,
            &mut current,
            json!({ "call": "create", "name": "Работа: план/факт" }),
        );
        assert_eq!(a["type"], "opened");
        let a_id = a["workspace"]["id"].as_str().expect("id").to_owned();
        assert!(current.is_some());
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
            .as_mut()
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
        let mut none = None;
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
    fn a_folder_opened_by_hand_joins_the_list() {
        let dir = temp_dir();
        let elsewhere = temp_dir().join("Мой проект.strata");
        let id = create_folder(&elsewhere, "Мой проект")
            .expect("folder")
            .id()
            .to_owned();
        let mut home = Home::load(&dir);
        let mut current = None;
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
        current = None;
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
    fn folder_names_are_safe_everywhere() {
        assert_eq!(
            folder_name("  a/b\\c:d*e?f\"g<h>i|j  "),
            "a-b-c-d-e-f-g-h-i-j"
        );
        assert_eq!(folder_name("..."), "Strata");
        assert_eq!(folder_name(&"я".repeat(100)).chars().count(), 60);
    }
}
