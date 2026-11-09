//! The format corpus (NFR-78, 10 §13; `corpus/README.md`): a workspace as
//! a version wrote it, kept in `corpus/<date>/` and opened by every later
//! version — the desktop's folder, the browser's store and `.strata.zip` —
//! with the same answers to the API and the same value in every document.
//!
//! The TS half (`packages/backend/src/corpus.test.ts`) makes the workspace
//! and writes `browser.json`, `workspace.strata.zip` and `content.json`;
//! `STRATA_CORPUS_WRITE=<date> cargo test -p strata-core --test corpus`
//! then makes the folder from the archive, as the desktop imports one, and
//! writes `facts.json`. Every run checks every entry.

use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};
use strata_core::doctor::{self, Verdict};
use strata_core::sqlite::{self, SqliteStore};
use strata_core::{MemoryStore, Store, Workspace, api, archive};

const CORPUS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../corpus");

/// One call of the API as a client makes it, its answer as JSON.
fn ask<S: Store>(ws: &mut Workspace<S>, request: &Value) -> Value {
    serde_json::from_str(&api::call(ws, &request.to_string())).expect("the API answers JSON")
}

fn list<'a>(answer: &'a Value, key: &str) -> &'a [Value] {
    answer
        .get(key)
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

fn text(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::to_owned)
}

/// The calls whose answers the corpus keeps: what a client reads of the
/// workspace — its tree, every node, every network's view, the wires, the
/// trash, the people, the journal with each changeset's nodes, the assets.
fn requests<S: Store>(ws: &mut Workspace<S>) -> Vec<Value> {
    let mut out = vec![
        json!({"call": "workspace"}),
        json!({"call": "tree"}),
        json!({"call": "wires"}),
        json!({"call": "trash"}),
        json!({"call": "people"}),
        json!({"call": "ownIcons"}),
        json!({"call": "journal", "limit": 10_000}),
    ];
    let root = text(&ask(ws, &out[0]), "root").expect("the root");
    out.push(json!({"call": "view", "net": root}));
    let tree = ask(ws, &json!({"call": "tree"}));
    let mut assets = std::collections::BTreeSet::new();
    for item in list(&tree, "items") {
        let Some(id) = text(item, "id") else { continue };
        out.push(json!({"call": "node", "id": id}));
        if matches!(text(item, "kind").as_deref(), Some("network" | "project")) {
            out.push(json!({"call": "view", "net": id}));
        }
        assets.extend(text(item, "asset"));
    }
    let journal = ask(ws, &json!({"call": "journal", "limit": 10_000}));
    let entries = journal
        .get("journal")
        .map_or(&[][..], |j| list(j, "entries"));
    for entry in entries {
        if let Some(id) = text(entry, "id") {
            out.push(json!({"call": "changesetNodes", "id": id}));
        }
    }
    for sha in assets {
        out.push(json!({"call": "asset", "sha": sha}));
    }
    out
}

/// Every document as stored, as one value: what a later version must read the same.
fn docs<S: Store>(ws: &Workspace<S>) -> Map<String, Value> {
    let store = ws.store();
    let mut out = Map::new();
    for id in store.doc_ids().expect("the store lists its documents") {
        let stored = store
            .load(&id)
            .expect("a document loads")
            .expect("a listed document is there");
        let doc = loro::LoroDoc::new();
        for bytes in stored.snapshot.iter().chain(&stored.updates) {
            doc.import(bytes)
                .unwrap_or_else(|e| panic!("{id} does not import: {e}"));
        }
        let mut value = serde_json::to_value(doc.get_deep_value()).expect("a value as JSON");
        // A root container that holds nothing is one never written: a
        // snapshot keeps the empty root, a chain of updates has none.
        if let Value::Object(roots) = &mut value {
            roots.retain(|_, v| match v {
                Value::Object(m) => !m.is_empty(),
                Value::Array(l) => !l.is_empty(),
                Value::String(t) => !t.is_empty(),
                _ => true,
            });
        }
        out.insert(id, value);
    }
    out
}

/// What this version reads of a workspace, as `facts.json` keeps it.
fn facts<S: Store>(ws: &mut Workspace<S>) -> Value {
    let answers: Vec<Value> = requests(ws)
        .into_iter()
        .map(|request| {
            let answer = ask(ws, &request);
            json!({"request": request, "answer": answer})
        })
        .collect();
    json!({
        "app": strata_core::VERSION,
        "formatVersion": sqlite::FORMAT_VERSION,
        "archiveVersion": archive::ARCHIVE_VERSION,
        "requests": answers,
        "docs": docs(ws),
    })
}

/// Whether `got` holds all of `want`: an object every key of `want`, with a
/// value that holds its own; a list as many items, each holding its own —
/// matched by id where items have one, as a later version may order them
/// otherwise; anything else equal. A later version may answer more, not less.
fn holds(want: &Value, got: &Value, at: &str, out: &mut Vec<String>) {
    let id = |v: &Value| text(v, "id");
    match (want, got) {
        (Value::Object(w), Value::Object(g)) => {
            for (k, wv) in w {
                match g.get(k) {
                    Some(gv) => holds(wv, gv, &format!("{at}.{k}"), out),
                    None => out.push(format!("{at}.{k}: missing")),
                }
            }
        }
        (Value::Array(w), Value::Array(g)) if w.len() != g.len() => {
            out.push(format!("{at}: {} items, not {}", g.len(), w.len()));
        }
        (Value::Array(w), Value::Array(g)) if w.iter().all(|v| id(v).is_some()) => {
            for wv in w {
                let key = id(wv).unwrap_or_default();
                match g.iter().find(|gv| id(gv).as_deref() == Some(key.as_str())) {
                    Some(gv) => holds(wv, gv, &format!("{at}[{key}]"), out),
                    None => out.push(format!("{at}[{key}]: missing")),
                }
            }
        }
        (Value::Array(w), Value::Array(g)) => {
            for (i, (wv, gv)) in w.iter().zip(g).enumerate() {
                holds(wv, gv, &format!("{at}[{i}]"), out);
            }
        }
        _ if want == got => {}
        _ => out.push(format!("{at}: {got} instead of {want}")),
    }
}

/// Where two values differ at all: a key on one side only, a list of
/// another length, another value. A document is read exactly as it was.
fn differs(want: &Value, got: &Value, at: &str, out: &mut Vec<String>) {
    match (want, got) {
        (Value::Object(w), Value::Object(g)) => {
            for (k, wv) in w {
                match g.get(k) {
                    Some(gv) => differs(wv, gv, &format!("{at}.{k}"), out),
                    None => out.push(format!("{at}.{k}: missing")),
                }
            }
            for k in g.keys().filter(|k| !w.contains_key(*k)) {
                out.push(format!("{at}.{k}: not there before"));
            }
        }
        (Value::Array(w), Value::Array(g)) if w.len() == g.len() => {
            for (i, (wv, gv)) in w.iter().zip(g).enumerate() {
                differs(wv, gv, &format!("{at}[{i}]"), out);
            }
        }
        _ if want == got => {}
        _ => out.push(format!("{at}: {got} instead of {want}")),
    }
}

/// A workspace of the corpus read by this version against what its version read.
fn check<S: Store>(entry: &str, store: &str, ws: &mut Workspace<S>, want: &Value) {
    let mut wrong = Vec::new();
    for pair in list(want, "requests") {
        let request = &pair["request"];
        let got = ask(ws, request);
        holds(&pair["answer"], &got, &request.to_string(), &mut wrong);
    }
    let got = docs(ws);
    let Some(want_docs) = want.get("docs").and_then(Value::as_object) else {
        panic!("{entry}: facts.json has no documents");
    };
    for (id, value) in want_docs {
        match got.get(id) {
            Some(v) => differs(value, v, &format!("document {id}"), &mut wrong),
            None => wrong.push(format!("document {id}: missing")),
        }
    }
    assert!(
        wrong.is_empty(),
        "corpus/{entry}, {store}: {} differences, the first:\n{}",
        wrong.len(),
        wrong
            .iter()
            .take(20)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).expect("a folder");
    for e in std::fs::read_dir(from).expect("a folder to copy") {
        let e = e.expect("an entry");
        let target = to.join(e.file_name());
        if e.file_type().expect("its type").is_dir() {
            copy_dir(&e.path(), &target);
        } else {
            std::fs::copy(e.path(), &target).expect("a file copied");
        }
    }
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("strata-corpus-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

/// The entries the core's half was written for.
fn entries() -> Vec<(String, PathBuf)> {
    let Ok(dirs) = std::fs::read_dir(CORPUS) else {
        return Vec::new();
    };
    let mut out: Vec<(String, PathBuf)> = dirs
        .filter_map(Result::ok)
        .filter(|e| e.path().join("facts.json").is_file())
        .map(|e| (e.file_name().to_string_lossy().into_owned(), e.path()))
        .collect();
    out.sort();
    out
}

/// `STRATA_CORPUS_WRITE=<date>`: the folder and `facts.json` of the entry
/// the TS half wrote. An entry once written is never changed.
#[test]
fn write_this_version() {
    let Ok(entry) = std::env::var("STRATA_CORPUS_WRITE") else {
        return;
    };
    let dir = Path::new(CORPUS).join(&entry);
    assert!(
        dir.join("workspace.strata.zip").is_file(),
        "corpus/{entry}: the TS half first (packages/backend/src/corpus.test.ts)"
    );
    assert!(
        !dir.join("facts.json").exists() && !dir.join("folder").exists(),
        "corpus/{entry} is written: an entry is never changed, a new one is added"
    );
    let zip = std::fs::read(dir.join("workspace.strata.zip")).expect("the archive");
    let unpacked = archive::unpack(&zip).expect("the archive unpacks");
    let folder = dir.join("folder");
    let facts = {
        let mut ws = sqlite::import_folder(&folder, &unpacked, false).expect("the folder is made");
        facts(&mut ws)
    };
    // Last and whole: an entry with `facts.json` is a written one.
    let json = serde_json::to_string_pretty(&facts).expect("facts as JSON");
    let part = dir.join("facts.json.part");
    std::fs::write(&part, format!("{json}\n")).expect("facts written");
    std::fs::rename(&part, dir.join("facts.json")).expect("facts in place");
}

#[test]
fn every_entry_opens_in_every_store_with_what_it_held() {
    for (entry, dir) in entries() {
        let want: Value = serde_json::from_slice(
            &std::fs::read(dir.join("facts.json")).expect("facts.json reads"),
        )
        .expect("facts.json is JSON");

        // The desktop's folder, read as it lies (a copy: reading writes beside the store).
        let copy = scratch(&entry);
        copy_dir(&dir.join("folder"), &copy);
        {
            let store = SqliteStore::read(&copy.join("store.sqlite"), Some(copy.join("assets")))
                .expect("the folder's store opens");
            let mut ws = Workspace::open(store).expect("the folder's workspace opens");
            check(&entry, "folder", &mut ws, &want);
        }
        // As the app opens it: the format and the id checked, today's copy made.
        {
            let ws = sqlite::open_folder(&copy).expect("the app opens the folder");
            assert_eq!(
                Some(ws.id().to_owned()),
                text(&want["requests"][0]["answer"], "id")
            );
        }
        // `strata doctor`: the checks a user runs on a folder.
        for c in doctor::doctor(&copy, strata_core::model::now_ms()) {
            if matches!(
                c.check,
                "folder" | "store" | "workspace" | "structure" | "interrupted" | "assets"
            ) {
                assert_eq!(
                    c.verdict,
                    Verdict::Ok,
                    "corpus/{entry}: doctor's {}",
                    c.check
                );
            }
        }
        let _ = std::fs::remove_dir_all(&copy);

        // `.strata.zip`, into an empty store.
        let zip = std::fs::read(dir.join("workspace.strata.zip")).expect("the archive reads");
        let unpacked = archive::unpack(&zip).expect("the archive unpacks");
        let mut ws = archive::import(&unpacked, MemoryStore::default(), false)
            .expect("the archive comes in");
        check(&entry, "archive", &mut ws, &want);

        // The browser's store, as IndexedDB keeps it.
        let bytes = std::fs::read(dir.join("browser.json")).expect("browser.json reads");
        let store = MemoryStore::from_bytes(&bytes).expect("the browser's store reads");
        let mut ws = Workspace::open(store).expect("the browser's workspace opens");
        check(&entry, "browser", &mut ws, &want);
    }
}

#[test]
fn a_difference_is_found() {
    // The checker itself: an answer missing a field, another value, a list of another length.
    let want = json!({"items": [{"id": "a", "name": "А", "kind": "note"}], "n": 1});
    let mut wrong = Vec::new();
    holds(
        &want,
        &json!({"items": [{"id": "a", "name": "А", "kind": "note", "new": true}], "n": 1, "more": 2}),
        "",
        &mut wrong,
    );
    assert!(wrong.is_empty(), "{wrong:?}");
    holds(
        &want,
        &json!({"items": [{"id": "a", "name": "Б"}], "n": 1}),
        "",
        &mut wrong,
    );
    assert_eq!(wrong.len(), 2, "{wrong:?}");
    wrong.clear();
    holds(&want, &json!({"items": [], "n": 2}), "", &mut wrong);
    assert_eq!(wrong.len(), 2, "{wrong:?}");
}
