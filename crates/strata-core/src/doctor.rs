//! `strata doctor` and `strata backup verify` for a workspace folder (11
//! §4.1): what is wrong with it, check by check. Both only read: a folder
//! the app has open is read as one snapshot (`SqliteStore::read`).

use crate::backups::{BackupKind, DAY_MS};
use crate::folder::{self, FolderLock};
use crate::sqlite::{FORMAT_VERSION, FolderInfo, SqliteStore};
use crate::store::{Store, StoreError};
use crate::workspace::{SCHEMA, Workspace};
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::Path;

/// Free space under this share of the disk is a warning.
const LOW_SPACE: f64 = 0.10;
/// The newest day's copy older than this is a warning (10 §3.5).
const OLD_COPY_DAYS: i64 = 2;
/// Problems a line names before «and N more».
const NAMED: usize = 5;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Verdict {
    Ok,
    Info,
    Warn,
    Fail,
    Skip,
}

/// One check: what it is, its verdict and what it found, by name. The words
/// of its line are the CLI's, in the system's language; `--json` gives this.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Check {
    pub check: &'static str,
    pub verdict: Verdict,
    #[serde(flatten)]
    pub facts: BTreeMap<&'static str, Value>,
}

impl Check {
    fn new(check: &'static str, verdict: Verdict, facts: Vec<(&'static str, Value)>) -> Self {
        Self {
            check,
            verdict,
            facts: facts.into_iter().collect(),
        }
    }
}

/// The first problems and how many there are.
fn named(problems: &[String]) -> Vec<(&'static str, Value)> {
    vec![
        ("count", json!(problems.len())),
        (
            "first",
            json!(problems.iter().take(NAMED).collect::<Vec<_>>()),
        ),
    ]
}

fn folder_info(dir: &Path) -> Result<FolderInfo, String> {
    let bytes = std::fs::read(dir.join("strata.json")).map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

/// The store of folder `dir` opened as one snapshot, with its assets.
fn snapshot(dir: &Path) -> Result<SqliteStore, StoreError> {
    SqliteStore::read(&dir.join("store.sqlite"), Some(dir.join("assets")))
}

/// The checks of 11 §4.1 on folder `dir`, at `now` (unix ms).
pub fn doctor(dir: &Path, now: i64) -> Vec<Check> {
    use Verdict::{Fail, Info, Ok, Skip, Warn};
    let mut out = Vec::new();
    let skip_rest = |out: &mut Vec<Check>, from: usize| {
        const LATER: [&str; 9] = [
            "lock",
            "space",
            "write",
            "store",
            "workspace",
            "structure",
            "interrupted",
            "backups",
            "assets",
        ];
        for check in &LATER[from..] {
            out.push(Check::new(check, Skip, vec![]));
        }
    };
    // The folder: `strata.json`, a format this app reads.
    let info = match folder_info(dir) {
        Err(e) => {
            out.push(Check::new("folder", Fail, vec![("error", json!(e))]));
            skip_rest(&mut out, 0);
            return out;
        }
        Result::Ok(info) => info,
    };
    let folder_facts = vec![
        ("id", json!(info.workspace_id)),
        ("format", json!(info.format_version)),
        ("supported", json!(FORMAT_VERSION)),
    ];
    if info.format_version > FORMAT_VERSION {
        out.push(Check::new("folder", Fail, folder_facts));
        skip_rest(&mut out, 0);
        return out;
    }
    out.push(Check::new("folder", Ok, folder_facts));
    // The lock, for the record: taken and let go at once when it is free.
    out.push(match FolderLock::take(dir) {
        Result::Ok(lock) => {
            drop(lock);
            Check::new("lock", Ok, vec![])
        }
        Err(StoreError::Locked(who)) => Check::new("lock", Info, vec![("who", json!(who))]),
        Err(e) => Check::new("lock", Warn, vec![("error", json!(e.to_string()))]),
    });
    // The disk.
    out.push(match (fs4::available_space(dir), fs4::total_space(dir)) {
        (Result::Ok(free), Result::Ok(total)) => {
            let low = total > 0 && (free as f64) < LOW_SPACE * total as f64;
            Check::new(
                "space",
                if low { Warn } else { Ok },
                vec![("free", json!(free)), ("total", json!(total))],
            )
        }
        (Err(e), _) | (_, Err(e)) => {
            Check::new("space", Warn, vec![("error", json!(e.to_string()))])
        }
    });
    // Writing: a probe in the folder, read back and taken away.
    let probe = dir.join(format!(".doctor-{}", std::process::id()));
    let wrote = std::fs::write(&probe, b"probe")
        .and_then(|()| std::fs::read(&probe))
        .and_then(|b| {
            std::fs::remove_file(&probe)?;
            Result::Ok(b)
        });
    out.push(match wrote {
        Result::Ok(b) if b == b"probe" => Check::new("write", Ok, vec![]),
        Result::Ok(_) => Check::new("write", Fail, vec![("error", json!("read back differs"))]),
        Err(e) => {
            let _ = std::fs::remove_file(&probe);
            Check::new("write", Fail, vec![("error", json!(e.to_string()))])
        }
    });
    // The store, whole.
    let store = match snapshot(dir) {
        Err(e) => {
            out.push(Check::new(
                "store",
                Fail,
                vec![("error", json!(e.to_string()))],
            ));
            skip_rest(&mut out, 4);
            return out;
        }
        Result::Ok(store) => store,
    };
    match store.integrity() {
        Result::Ok(problems) if problems.is_empty() => out.push(Check::new("store", Ok, vec![])),
        Result::Ok(problems) => out.push(Check::new("store", Fail, named(&problems))),
        Err(e) => out.push(Check::new(
            "store",
            Fail,
            vec![("error", json!(e.to_string()))],
        )),
    }
    // The workspace: its documents open, it is the folder's, a schema this app reads.
    let mut ws = match Workspace::open(store) {
        Err(e) => {
            out.push(Check::new(
                "workspace",
                Fail,
                vec![("error", json!(e.to_string()))],
            ));
            skip_rest(&mut out, 5);
            return out;
        }
        Result::Ok(ws) => ws,
    };
    let changesets = ws.store().heads().map(|h| h.len()).unwrap_or(0);
    let facts = vec![
        ("id", json!(ws.id())),
        ("nodes", json!(ws.tree().len())),
        ("changesets", json!(changesets)),
        ("schema", json!(ws.schema())),
        ("supported", json!(SCHEMA)),
    ];
    let mismatch = ws.id() != info.workspace_id;
    out.push(if mismatch || ws.schema() > SCHEMA {
        let mut facts = facts;
        facts.push(("expected", json!(info.workspace_id)));
        Check::new("workspace", Fail, facts)
    } else {
        Check::new("workspace", Ok, facts)
    });
    // The rules of 05 §14 the core keeps on what it holds.
    let broken = ws.broken_rules();
    out.push(Check::new(
        "structure",
        if broken.is_empty() { Ok } else { Fail },
        named(&broken),
    ));
    // A long task the app left in the middle (13 §3.3).
    out.push(match ws.interrupted() {
        None => Check::new("interrupted", Ok, vec![]),
        Some(label) => Check::new(
            "interrupted",
            Warn,
            vec![
                ("task", json!(label.key)),
                (
                    "name",
                    label.params.get("name").cloned().unwrap_or(json!("")),
                ),
            ],
        ),
    });
    // The copies (10 §3.5).
    let copies = folder::list(dir);
    let newest = copies.iter().find(|b| b.kind == BackupKind::Day);
    out.push(match newest {
        None => Check::new("backups", Warn, vec![("count", json!(copies.len()))]),
        Some(b) => {
            let age = (now - b.at).div_euclid(DAY_MS);
            Check::new(
                "backups",
                if age > OLD_COPY_DAYS { Warn } else { Ok },
                vec![
                    ("count", json!(copies.len())),
                    ("newest", json!(b.id)),
                    ("days", json!(age)),
                ],
            )
        }
    });
    // The files the workspace refers to.
    out.push(assets_check("assets", &mut ws));
    out
}

/// The assets workspace `ws` refers to, looked for among its store's.
fn assets_check(check: &'static str, ws: &mut Workspace<SqliteStore>) -> Check {
    let have: std::collections::BTreeSet<String> = ws
        .store()
        .asset_ids()
        .unwrap_or_default()
        .into_iter()
        .collect();
    match ws.referenced_assets() {
        Err(e) => Check::new(check, Verdict::Fail, vec![("error", json!(e.to_string()))]),
        Result::Ok(refs) => {
            let missing: Vec<String> = refs
                .iter()
                .filter(|s| !have.contains(*s))
                .cloned()
                .collect();
            if missing.is_empty() {
                Check::new(check, Verdict::Ok, vec![("count", json!(refs.len()))])
            } else {
                Check::new(check, Verdict::Fail, named(&missing))
            }
        }
    }
}

/// `strata backup verify` of copy `id` of folder `dir` (11 §4.1, NFR-73):
/// whole, every document opens in the engine, the folder's workspace, and
/// the assets it refers to are in `assets/`. One check, `backup`.
pub fn verify_backup(dir: &Path, id: &str) -> Check {
    use Verdict::{Fail, Ok};
    let fail = |e: String| Check::new("backup", Fail, vec![("id", json!(id)), ("error", json!(e))]);
    let expected = match folder_info(dir) {
        Err(e) => return fail(e),
        Result::Ok(info) => info.workspace_id,
    };
    let path = match folder::backup_path(dir, id) {
        Err(e) => return fail(e.to_string()),
        Result::Ok(path) => path,
    };
    let store = match SqliteStore::read(&path, Some(dir.join("assets"))) {
        Err(e) => return fail(e.to_string()),
        Result::Ok(store) => store,
    };
    match store.integrity() {
        Result::Ok(problems) if problems.is_empty() => {}
        Result::Ok(problems) => return fail(problems.join("; ")),
        Err(e) => return fail(e.to_string()),
    }
    let mut ws = match Workspace::open(store) {
        Err(e) => return fail(e.to_string()),
        Result::Ok(ws) => ws,
    };
    if ws.id() != expected {
        return fail(format!("a copy of workspace {}", ws.id()));
    }
    let docs = match ws.check_docs() {
        Err(e) => return fail(e.to_string()),
        Result::Ok(n) => n,
    };
    let assets = assets_check("backup", &mut ws);
    if assets.verdict == Fail {
        let mut facts = assets.facts;
        facts.insert("id", json!(id));
        return Check {
            check: "backup",
            verdict: Fail,
            facts,
        };
    }
    Check::new("backup", Ok, vec![("id", json!(id)), ("docs", json!(docs))])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sqlite::{create_folder, open_folder};
    use crate::value::Val;
    use crate::{Label, Op};
    use strata_model::{NodeId, NodeKind};

    fn temp_dir(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("strata-doctor-{name}-{}", NodeId::new().to_text()))
    }

    fn verdicts(checks: &[Check]) -> Vec<(&'static str, Verdict)> {
        checks.iter().map(|c| (c.check, c.verdict)).collect()
    }

    /// A folder with an asset node whose picture is in `assets/`.
    fn folder_with_a_picture(dir: &Path) -> String {
        let mut ws = create_folder(dir, "Доктор").expect("create");
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
        let sha = ws.put_asset(b"\x89PNG a picture").expect("asset");
        ws.apply(
            &[Op::SetAttr {
                id,
                key: "asset".to_owned(),
                value: Some(Val::str(sha.clone())),
            }],
            Label::new("t"),
        )
        .expect("its picture");
        sha
    }

    #[test]
    fn a_whole_folder_passes_and_says_what_it_lacks() {
        // 11 §4.1: every check passes; no copy yet is a warning, not an error.
        let dir = temp_dir("whole");
        folder_with_a_picture(&dir);
        let now = 1_762_600_000_000;
        let checks = doctor(&dir, now);
        use Verdict::{Ok, Warn};
        let got = verdicts(&checks);
        let space = got.iter().find(|(c, _)| *c == "space").map(|&(_, v)| v);
        assert!(matches!(space, Some(Ok | Warn)), "{got:?}");
        let rest: Vec<_> = got.into_iter().filter(|(c, _)| *c != "space").collect();
        assert_eq!(
            rest,
            [
                ("folder", Ok),
                ("lock", Ok),
                ("write", Ok),
                ("store", Ok),
                ("workspace", Ok),
                ("structure", Ok),
                ("interrupted", Ok),
                ("backups", Warn),
                ("assets", Ok),
            ]
        );
        let ws = checks
            .iter()
            .find(|c| c.check == "workspace")
            .expect("workspace");
        assert_eq!(ws.facts["nodes"], json!(2), "the root and the picture");
        // A copy today: no warning; three days on, one again.
        folder::back_up(&dir.join("store.sqlite")).expect("a copy");
        let day = folder::day_now() * DAY_MS;
        let fresh = doctor(&dir, day + 1);
        let backups = fresh
            .iter()
            .find(|c| c.check == "backups")
            .expect("backups");
        assert_eq!(backups.verdict, Ok);
        let late = doctor(&dir, day + 3 * DAY_MS + 1);
        assert_eq!(
            late.iter()
                .find(|c| c.check == "backups")
                .map(|c| c.verdict),
            Some(Warn)
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_folder_open_in_the_app_is_read_as_a_snapshot() {
        let dir = temp_dir("open");
        folder_with_a_picture(&dir);
        let ws = open_folder(&dir).expect("the app has it open");
        let checks = doctor(&dir, 0);
        let lock = checks.iter().find(|c| c.check == "lock").expect("lock");
        assert_eq!(lock.verdict, Verdict::Info);
        assert!(
            lock.facts["who"]
                .as_str()
                .is_some_and(|w| w.contains("pid"))
        );
        let store = checks.iter().find(|c| c.check == "store").expect("store");
        assert_eq!(store.verdict, Verdict::Ok);
        drop(ws);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_picture_and_a_broken_folder_are_errors() {
        let dir = temp_dir("broken");
        let sha = folder_with_a_picture(&dir);
        let file = dir
            .join("assets")
            .join(&sha[0..2])
            .join(&sha[2..4])
            .join(&sha);
        std::fs::remove_file(file).expect("the picture goes");
        let checks = doctor(&dir, 0);
        let assets = checks.iter().find(|c| c.check == "assets").expect("assets");
        assert_eq!(assets.verdict, Verdict::Fail);
        assert_eq!(assets.facts["first"], json!([sha]));
        // `strata.json` that is not: the folder fails, the rest is skipped.
        std::fs::write(dir.join("strata.json"), b"{").expect("spoil");
        let checks = doctor(&dir, 0);
        assert_eq!(checks[0].verdict, Verdict::Fail);
        assert!(checks[1..].iter().all(|c| c.verdict == Verdict::Skip));
        assert_eq!(checks.len(), 10);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_copy_is_verified_whole_or_named_broken() {
        // NFR-73: `strata backup verify`.
        let dir = temp_dir("verify");
        folder_with_a_picture(&dir);
        let day = folder::back_up(&dir.join("store.sqlite")).expect("a copy");
        let id = format!("store-{}", crate::backups::day_stamp(day));
        let good = verify_backup(&dir, &id);
        assert_eq!(good.verdict, Verdict::Ok, "{good:?}");
        assert!(good.facts["docs"].as_u64().is_some_and(|n| n >= 4));
        std::fs::write(dir.join("backups").join("store-20200101.sqlite"), b"junk").expect("junk");
        let bad = verify_backup(&dir, "store-20200101");
        assert_eq!(bad.verdict, Verdict::Fail);
        assert_eq!(verify_backup(&dir, "store-20200102").verdict, Verdict::Fail);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
