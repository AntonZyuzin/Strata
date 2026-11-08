//! `strata doctor` and `strata backup` on real folders (11 §4.1): the
//! binary as a person runs it, in Russian and in English.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use strata_core::{Label, Op, folder, sqlite};
use strata_model::{NodeId, NodeKind};

fn temp_dir(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!("strata-cli-{name}-{}", NodeId::new().to_text()))
}

/// `strata` with `args` in the language of `locale`.
fn strata(locale: &str, args: &[&str], cwd: &Path) -> Output {
    Command::new(env!("CARGO_BIN_EXE_strata"))
        .args(args)
        .current_dir(cwd)
        .env("LC_ALL", locale)
        .env("LANG", locale)
        .output()
        .expect("strata runs")
}

fn stdout(o: &Output) -> String {
    String::from_utf8_lossy(&o.stdout).into_owned()
}

/// A workspace folder with a note in it, not open.
fn folder_with_a_note(dir: &Path) {
    let mut ws = sqlite::create_folder(dir, "Проект").expect("create");
    let root = ws.root();
    ws.apply(
        &[Op::CreateNode {
            id: None,
            kind: NodeKind::Note,
            name: "Заметка".to_owned(),
            net: root,
            x: 0.0,
            y: 0.0,
        }],
        Label::new("t"),
    )
    .expect("a note");
}

#[test]
fn doctor_checks_a_folder_in_the_systems_language_and_as_json() {
    let dir = temp_dir("doctor");
    folder_with_a_note(&dir);
    let d = dir.to_str().expect("path");
    let ru = strata("ru_RU.UTF-8", &["doctor", d], &dir);
    assert!(ru.status.success(), "{}", stdout(&ru));
    let text = stdout(&ru);
    assert!(
        text.contains("[OK]   Хранилище: integrity_check — ok"),
        "{text}"
    );
    assert!(
        text.contains("[OK]   Структура: правила 05 §14 соблюдены"),
        "{text}"
    );
    assert!(text.contains("[WARN] Копии: пока нет"), "{text}");
    let en = stdout(&strata("en_US.UTF-8", &["doctor", d], &dir));
    assert!(en.contains("[OK]   Workspace: 2 nodes"), "{en}");
    // JSON: the facts, whatever the language.
    let out = strata("ru_RU.UTF-8", &["doctor", d, "--json"], &dir);
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).expect("json");
    let checks = v["checks"].as_array().expect("checks");
    assert_eq!(checks.len(), 10);
    let store = checks
        .iter()
        .find(|c| c["check"] == "store")
        .expect("store");
    assert_eq!(store["verdict"], "ok");
    // A spoilt strata.json: an error, the code says so.
    std::fs::write(dir.join("strata.json"), b"{").expect("spoil");
    let bad = strata("ru_RU.UTF-8", &["doctor", d], &dir);
    assert_eq!(bad.status.code(), Some(1));
    assert!(stdout(&bad).contains("[FAIL] Папка"), "{}", stdout(&bad));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn backup_makes_an_archive_lists_verifies_and_restores_copies() {
    let dir = temp_dir("backup");
    folder_with_a_note(&dir);
    let d = dir.to_str().expect("path");
    let work = temp_dir("work");
    std::fs::create_dir_all(&work).expect("cwd");
    // An archive, by default named after the folder and the day.
    let made = strata("ru_RU.UTF-8", &["backup", "create", d], &work);
    assert!(
        made.status.success(),
        "{}",
        String::from_utf8_lossy(&made.stderr)
    );
    let zip = std::fs::read_dir(&work)
        .expect("cwd")
        .flatten()
        .find(|e| e.file_name().to_string_lossy().ends_with(".strata.zip"))
        .expect("an archive")
        .path();
    let unpacked =
        strata_core::archive::unpack(&std::fs::read(&zip).expect("bytes")).expect("an archive");
    assert_eq!(
        unpacked.info.workspace_id,
        sqlite::folder_id(&dir).expect("id")
    );
    assert!(stdout(&made).starts_with("Архив: "), "{}", stdout(&made));
    // No copy yet; then today's.
    let none = strata("en_US.UTF-8", &["backup", "list", d], &dir);
    assert_eq!(stdout(&none).trim(), "No backups yet");
    let day = folder::back_up(&dir.join("store.sqlite")).expect("a copy");
    let id = format!("store-{}", strata_core::backups::day_stamp(day));
    let list = stdout(&strata("ru_RU.UTF-8", &["backup", "list", d], &dir));
    assert!(list.starts_with(&format!("{id}  Копия за ")), "{list}");
    let verified = strata("ru_RU.UTF-8", &["backup", "verify", d], &dir);
    assert!(verified.status.success(), "{}", stdout(&verified));
    assert!(
        stdout(&verified).contains(&format!("[OK]   Копия: {id}: цела")),
        "{}",
        stdout(&verified)
    );
    // A folder the app has open is not restored.
    let open = sqlite::open_folder(&dir).expect("open");
    let refused = strata("ru_RU.UTF-8", &["backup", "restore", d, &id], &dir);
    assert_eq!(refused.status.code(), Some(1));
    assert!(
        String::from_utf8_lossy(&refused.stderr).contains("Папка открыта в приложении"),
        "{}",
        String::from_utf8_lossy(&refused.stderr)
    );
    drop(open);
    let restored = strata("en_US.UTF-8", &["backup", "restore", d, &id], &dir);
    assert!(
        restored.status.success(),
        "{}",
        String::from_utf8_lossy(&restored.stderr)
    );
    assert!(
        folder::list(&dir)
            .iter()
            .any(|b| b.id.starts_with("replaced-"))
    );
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&work);
}
