//! Import of an Obsidian vault (13 §2–3): one test per rule, on V-synth's
//! vault (`packages/editor/src/vsynth-vault.ts`, here as JSON).

use crate::vault::{Vault, VaultFile};
use crate::{ImportItem, ImportOptions, ImportReport, MemoryStore, Store, Workspace};
use loro::{LoroDoc, LoroValue, ValueOrContainer};
use std::collections::BTreeMap;
use strata_model::{ChangesetOrigin, NodeKind};

fn vsynth() -> Vault {
    let files: Vec<VaultFile> =
        serde_json::from_str(include_str!("vsynth-vault.json")).expect("the corpus");
    Vault::from_files("V-synth", files)
}

fn original(path: &str) -> Vec<u8> {
    vsynth()
        .files
        .into_iter()
        .find(|f| f.path == path)
        .map(|f| f.bytes)
        .unwrap_or_else(|| panic!("no {path} in the corpus"))
}

fn options() -> ImportOptions {
    ImportOptions {
        unlinked: "Вложения без ссылок".to_owned(),
        text: "текст".to_owned(),
        ..ImportOptions::default()
    }
}

fn imported() -> (Workspace<MemoryStore>, ImportReport) {
    let mut w = super::ws();
    let report = w
        .import_vault(vsynth(), None, &options())
        .expect("the import");
    (w, report)
}

/// The live nodes named `name`: (id, kind, parent's name).
fn named(w: &Workspace<MemoryStore>, name: &str) -> Vec<(String, NodeKind, String)> {
    let tree = w.tree();
    let name_of = |id: &Option<String>| {
        tree.iter()
            .find(|t| Some(&t.id) == id.as_ref())
            .map(|t| t.name.clone())
            .unwrap_or_default()
    };
    tree.iter()
        .filter(|t| t.name == name)
        .map(|t| (t.id.clone(), t.kind, name_of(&t.parent)))
        .collect()
}

fn id(w: &Workspace<MemoryStore>, name: &str, parent: &str) -> String {
    named(w, name)
        .into_iter()
        .find(|(_, _, p)| p == parent)
        .map(|(id, ..)| id)
        .unwrap_or_else(|| panic!("no {name} in {parent}"))
}

fn lines<'a>(report: &'a ImportReport, code: &str) -> Vec<&'a ImportItem> {
    report.items.iter().filter(|i| i.code == code).collect()
}

/// A map of the index shards, merged: key → value.
fn index_map(w: &Workspace<MemoryStore>, map: &str) -> BTreeMap<String, LoroValue> {
    let mut out = BTreeMap::new();
    for (doc, bytes) in w.snapshots().expect("snapshots") {
        if !doc.starts_with("index/") {
            continue;
        }
        let d = LoroDoc::new();
        d.import(&bytes).expect("a shard");
        if let LoroValue::Map(m) = d.get_map(map).get_value() {
            out.extend(m.iter().map(|(k, v)| (k.clone(), v.clone())));
        }
    }
    out
}

fn doc(w: &Workspace<MemoryStore>, id: &str) -> LoroDoc {
    let d = LoroDoc::new();
    if let Some((_, bytes)) = w
        .snapshots()
        .expect("snapshots")
        .into_iter()
        .find(|(doc, _)| doc == id)
    {
        d.import(&bytes).expect("a document");
    }
    d
}

fn meta(d: &LoroDoc, key: &str) -> Option<LoroValue> {
    match d.get_map("meta").get(key)? {
        ValueOrContainer::Value(v) => Some(v),
        ValueOrContainer::Container(_) => None,
    }
}

/// The wire `from → to` and its origins.
fn origins(w: &Workspace<MemoryStore>, from: &str, to: &str) -> Vec<String> {
    let edges = index_map(w, "edge");
    let key = edges.iter().find_map(|(k, v)| {
        let LoroValue::Map(m) = v else { return None };
        let end = |e: &str| m.get(e).and_then(|v| v.as_string().map(|s| s.to_string()));
        (end("from").as_deref() == Some(from) && end("to").as_deref() == Some(to))
            .then(|| k.clone())
    });
    let Some(key) = key else { return Vec::new() };
    index_map(w, "edgeOrigin")
        .keys()
        .filter_map(|k| k.strip_prefix(&format!("{key}|")).map(str::to_owned))
        .collect()
}

#[test]
fn import_folders_become_networks_and_the_vault_comes_into_the_root() {
    let (w, report) = imported();
    let networks: Vec<(String, String)> = w
        .tree()
        .iter()
        .filter(|t| t.kind == NodeKind::Network && t.parent.is_some())
        .map(|t| {
            let parent = w
                .tree()
                .into_iter()
                .find(|p| Some(&p.id) == t.parent.as_ref())
                .map(|p| p.name)
                .unwrap_or_default();
            (t.name.clone(), parent)
        })
        .collect();
    for (name, parent) in [
        ("Проекты", "Корень"),
        ("Игра", "Проекты"),
        ("Комикс", "Проекты"),
        ("Заметки", "Корень"),
        ("Регистр", "Корень"),
        ("Шаблоны", "Корень"),
        ("Вложенный vault", "Корень"),
        ("Вложения без ссылок", "Корень"),
        // Canvases are networks of their folders (13 §2.7.1).
        ("План", "Корень"),
        ("Цикл", "Корень"),
    ] {
        assert!(
            networks.contains(&(name.to_owned(), parent.to_owned())),
            "{name} in {parent}: {networks:?}"
        );
    }
    // A filtered folder is not read; a folder whose files all went to their notes is not made.
    assert!(named(&w, "Черновики").is_empty());
    assert!(named(&w, "Вложения").is_empty());
    assert_eq!(report.net, w.root());
    assert_eq!(report.counts.folders, 8);
    assert_eq!(report.counts.canvases, 3);
}

#[test]
fn import_keeps_a_notes_body_byte_for_byte() {
    // 13 §7.1: the text without its frontmatter, BOM and line breaks to
    // `meta`; written back, the file is the same bytes.
    let (w, _) = imported();
    let mut checked = 0;
    for f in vsynth()
        .files
        .iter()
        .filter(|f| f.path.starts_with("Заметки/"))
    {
        let name = f
            .path
            .trim_start_matches("Заметки/")
            .trim_end_matches(".md");
        let note = id(&w, name, "Заметки");
        let d = doc(&w, &format!("content/{note}"));
        let text = d.get_text("text").to_string();
        let bom = meta(&d, "bom") == Some(LoroValue::Bool(true));
        let eol = meta(&d, "eol").and_then(|v| v.as_string().map(|s| s.to_string()));
        let front = meta(&d, "frontmatter")
            .and_then(|v| v.as_string().map(|s| s.to_string()))
            .unwrap_or_default();
        let mut back = format!("{front}{text}");
        if eol.as_deref() == Some("crlf") {
            back = back.replace('\n', "\r\n");
        }
        if bom {
            back.insert(0, '\u{feff}');
        }
        assert_eq!(back.as_bytes(), f.bytes.as_slice(), "{}", f.path);
        checked += 1;
    }
    assert_eq!(checked, 10);
    // The frontmatter is not in the text: its values are attributes.
    let dizdok = id(&w, "Диздок", "Игра");
    let text = doc(&w, &format!("content/{dizdok}"))
        .get_text("text")
        .to_string();
    assert!(text.starts_with("## Цели"), "{text}");
}

#[test]
fn import_properties_become_tags_aliases_and_attributes() {
    // 13 §2.3–2.4.
    let (w, report) = imported();
    let dizdok = id(&w, "Диздок", "Игра");
    let d = w.node_details(&dizdok).expect("details");
    assert_eq!(d.kind, NodeKind::Note);
    // `tag: Игра` is the same tag as «игра»: its first spelling stays.
    assert_eq!(d.tags, vec!["idea/2026", "игра"]);
    assert_eq!(d.aliases, vec!["Сценарий"]);
    let props: BTreeMap<String, crate::value::Val> =
        d.props.into_iter().map(|p| (p.key, p.value)).collect();
    use crate::value::Val;
    assert_eq!(props.get("rating"), Some(&Val::Int(5)));
    assert_eq!(props.get("when"), Some(&Val::str("2026-10-28")));
    assert_eq!(props.get("source"), Some(&Val::str("[[Входящие]]")));
    // Not a checkbox: kept as text, a line of the report (types.json).
    assert_eq!(props.get("reviewed"), Some(&Val::str("yes")));
    assert!(
        lines(&report, "typeMismatch")
            .iter()
            .any(|i| i.detail == "reviewed: checkbox")
    );
    // A nested object: its text, and a line.
    assert_eq!(props.get("nested"), Some(&Val::str("{a: 1}")));
    assert_eq!(lines(&report, "nested").len(), 1);
    // `cssclasses` lives in the frontmatter's form only; `created` is when it was made.
    assert!(!props.contains_key("cssclasses") && !props.contains_key("created"));
    let created = index_map(&w, "createdAt");
    assert_eq!(
        created.get(&dizdok).and_then(|v| v.as_i64().copied()),
        Some(1_709_251_200_000)
    );
    // A link in a property is a wire `import` (☑ Q-13-11).
    let inbox = id(&w, "Входящие", "Корень");
    assert_eq!(origins(&w, &dizdok, &inbox), vec!["import"]);
    // JSON frontmatter is YAML.
    let json = w.node_details(&id(&w, "JSON", "Корень")).expect("json");
    assert_eq!(json.tags, vec!["json"]);
}

#[test]
fn import_a_note_with_a_tasks_fields_is_a_task() {
    // 13 §2.1, §2.3: status, deadline, priority, people.
    let (w, _) = imported();
    let task = id(&w, "Задача сборки", "Игра");
    let d = w.node_details(&task).expect("details");
    assert_eq!(d.kind, NodeKind::Task);
    assert_eq!(d.attrs.status.as_deref(), Some("doing"));
    assert_eq!(d.attrs.deadline.as_deref(), Some("2026-11-15"));
    assert_eq!(d.attrs.priority.as_deref(), Some("high"));
    let people: Vec<String> = w
        .people()
        .into_iter()
        .filter(|p| d.attrs.assignees.contains(&p.id))
        .map(|p| p.name)
        .collect();
    assert_eq!(people.len(), 2);
    assert!(people.contains(&"Анна".to_owned()) && people.contains(&"Борис".to_owned()));
    // The body is the task's description.
    let text = doc(&w, &format!("content/{task}"))
        .get_text("text")
        .to_string();
    assert_eq!(text, "Собрать билд.\n");
}

#[test]
fn import_a_pure_checklist_is_a_list() {
    // 13 §2.2: the items as the list's tree, the marker and indent to `meta`.
    let (mut w, _) = imported();
    let list = id(&w, "Покупки", "Проекты");
    let projects = id(&w, "Проекты", "Корень");
    let view = w.network_view(&projects).expect("view");
    let node = view.nodes.iter().find(|n| n.id == list).expect("the list");
    assert_eq!(node.kind, NodeKind::Checklist);
    let fold = node.fold.clone().expect("a fold");
    assert_eq!((fold.done, fold.total), (1, 3));
    let d = doc(&w, &format!("content/{list}"));
    assert_eq!(meta(&d, "marker"), Some(LoroValue::from("-")));
    assert_eq!(meta(&d, "indent"), Some(LoroValue::from("  ")));
    // A note with a heading is a note, its items text.
    let deeds = id(&w, "Дела", "Проекты");
    assert_eq!(w.node_details(&deeds).expect("deeds").kind, NodeKind::Note);
}

#[test]
fn import_links_become_wires_and_ghosts_by_13_3_5() {
    let (w, report) = imported();
    let inbox = id(&w, "Входящие", "Корень");
    let outputs: Vec<String> = w
        .node_details(&inbox)
        .expect("details")
        .outputs
        .into_iter()
        .map(|l| l.name)
        .collect();
    // A path, an embed, a Markdown link, `.canvas` and `.excalidraw`, an NFD name.
    for name in ["Диздок", "схема.png", "План", "Рисунок", "Идей"] {
        assert!(outputs.contains(&name.to_owned()), "{name}: {outputs:?}");
    }
    // The link and the canvas's edge are one wire with two origins (05 §8.2 rule 5).
    let game = id(&w, "Диздок", "Игра");
    assert_eq!(origins(&w, &inbox, &game), vec!["import", "text"]);
    // [[Диздок]] names two: the nearest wins, and the report says so.
    let ambiguous = lines(&report, "ambiguous");
    assert!(
        ambiguous
            .iter()
            .any(|i| i.detail.starts_with("[[Диздок]] →") && i.detail.ends_with("(2)")),
        "{ambiguous:?}"
    );
    // A link to no file is a ghost; one that an alias answers says whose.
    let view = {
        let mut w = w;
        let root = w.root();
        w.network_view(&root).expect("view")
    };
    let ghosts: Vec<&str> = view
        .ghosts
        .iter()
        .filter(|g| g.from == inbox)
        .map(|g| g.name.as_str())
        .collect();
    assert!(ghosts.contains(&"Несуществующая") && ghosts.contains(&"Сценарий"));
    assert!(
        lines(&report, "ghostAlias")
            .iter()
            .any(|i| i.detail == "[[Сценарий]] → Диздок")
    );
    assert!(
        lines(&report, "ghost")
            .iter()
            .any(|i| i.detail == "[[Несуществующая]]")
    );
    assert!(report.counts.ghosts >= 2 && report.counts.wires > 5);
}

#[test]
fn import_attachments_are_assets_by_sha256_beside_their_embedder() {
    // 13 §2.6: `attachmentFolderPath: Вложения` is shared.
    let (w, _) = imported();
    let png = original("Вложения/схема.png");
    use sha2::Digest;
    let sha: String = sha2::Sha256::digest(&png)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let scheme = id(&w, "схема.png", "Корень");
    let d = w.node_details(&scheme).expect("details");
    assert_eq!(d.kind, NodeKind::Asset);
    assert_eq!(d.attrs.asset.as_deref(), Some(sha.as_str()));
    assert_eq!(d.attrs.mime.as_deref(), Some("image/png"));
    assert_eq!(w.asset(&sha).expect("asset"), Some(png));
    // Where the first note embedding it lies; no note — a network of their own.
    assert_eq!(named(&w, "фото.jpg")[0].2, "Игра");
    assert_eq!(named(&w, "лишний.pdf")[0].2, "Вложения без ссылок");
    assert_eq!(named(&w, "данные.base")[0].2, "Вложения без ссылок");
}

#[test]
fn import_a_canvas_is_a_network_with_its_layout() {
    // 13 §2.7.
    let (mut w, report) = imported();
    let plan = id(&w, "План", "Корень");
    let view = w.network_view(&plan).expect("view");
    let at = |name: &str| {
        view.nodes
            .iter()
            .find(|n| n.name == name)
            .unwrap_or_else(|| panic!("{name} in План"))
            .clone()
    };
    // Files appear here, their primaries stay in their folders (05 §5).
    let inbox = at("Входящие");
    assert!(inbox.appearance);
    // k = 120 / the median distance to the nearest card (600): 0.2.
    assert!(
        (inbox.x - 40.0).abs() < 1e-6 && (inbox.y - 20.0).abs() < 1e-6,
        "{inbox:?}"
    );
    assert!(at("Диздок").appearance);
    // A text card is a note here; a link card a link asset (13 §3.9).
    let idea = at("Идея");
    assert_eq!(idea.kind, NodeKind::Note);
    assert!(!idea.appearance);
    let link = at("example.com");
    assert_eq!(link.attrs.url.as_deref(), Some("https://example.com/page"));
    // Edges are wires `import`; `fromEnd: arrow` alone turns one around.
    let game = id(&w, "Диздок", "Игра");
    assert!(origins(&w, &inbox.id, &game).contains(&"import".to_owned()));
    let labels = index_map(&w, "edgeLabel");
    assert!(
        labels
            .values()
            .any(|v| v.as_string().is_some_and(|s| s.as_str() == "ведёт"))
    );
    assert_eq!(origins(&w, &idea.id, &link.id), vec!["import"]);
    // A group is a box of the network with its members (drawn from 1.3).
    let net = doc(&w, &format!("net/{plan}"));
    let LoroValue::Map(boxes) = net.get_map("box").get_value() else {
        panic!("boxes");
    };
    assert_eq!(boxes.len(), 1);
    let LoroValue::Map(members) = net.get_map("boxMember").get_value() else {
        panic!("members");
    };
    assert_eq!(members.len(), 2);
    // Colours: cyan stays, red — the colour of deadlines — goes.
    assert_eq!(inbox.attrs.color, Some(1));
    assert_eq!(at("Диздок").attrs.color, None);
    for code in [
        "subpath",
        "duplicateCard",
        "edgeToGroup",
        "missingFile",
        "deadlineColors",
        "groups",
        "groupBackground",
        "advancedCanvas",
    ] {
        assert_eq!(lines(&report, code).len(), 1, "{code}");
    }
    // План holds Цикл, Цикл would hold План: that placement goes (05 §5 rule 4).
    assert!(at("Цикл").appearance);
    let cycle = id(&w, "Цикл", "Корень");
    assert!(w.network_view(&cycle).expect("Цикл").nodes.is_empty());
    assert_eq!(lines(&report, "cycle").len(), 1);
}

#[test]
fn import_a_folders_own_canvas_lays_the_folder_out() {
    // `Проекты/Проекты.canvas` is the layout of `Проекты` (13 §2.7.1).
    let (mut w, _) = imported();
    let projects = id(&w, "Проекты", "Корень");
    assert!(
        named(&w, "Проекты")
            .iter()
            .all(|(_, _, parent)| parent == "Корень")
    );
    let view = w.network_view(&projects).expect("view");
    let at = |name: &str| {
        let n = view.nodes.iter().find(|n| n.name == name).expect(name);
        (n.x, n.y)
    };
    // k = 120 / 800: centres (200, 100) and (1000, 100).
    let (x, y) = at("Покупки");
    assert!(
        (x - 30.0).abs() < 1e-6 && (y - 15.0).abs() < 1e-6,
        "{x} {y}"
    );
    let (x, _) = at("Дела");
    assert!((x - 150.0).abs() < 1e-6);
}

#[test]
fn import_drawings_become_boards() {
    // 13 §2.8: packed and plain, their pictures, links and text.
    let (w, report) = imported();
    let drawing = id(&w, "Рисунок", "Корень");
    assert_eq!(named(&w, "Рисунок")[0].1, NodeKind::Board);
    let d = doc(&w, &format!("content/{drawing}"));
    let LoroValue::Map(elements) = d.get_map("elements").get_value() else {
        panic!("elements");
    };
    assert!(elements.contains_key("txt1") && elements.contains_key("img1"));
    let LoroValue::Map(files) = d.get_map("files").get_value() else {
        panic!("files");
    };
    let file = files.get("f00d1").expect("the picture");
    let LoroValue::Map(file) = file else {
        panic!("a file")
    };
    assert!(
        file.get("dataURL")
            .and_then(|v| v.as_string())
            .is_some_and(|s| s.starts_with("data:image/png;base64,"))
    );
    // Its link is a wire; the text above it, a note beside it.
    let inbox = id(&w, "Входящие", "Корень");
    assert_eq!(origins(&w, &drawing, &inbox), vec!["import"]);
    let words = id(&w, "Рисунок — текст", "Корень");
    assert_eq!(origins(&w, &drawing, &words), vec!["import"]);
    assert_eq!(
        doc(&w, &format!("content/{words}"))
            .get_text("text")
            .to_string(),
        "Подпись к рисунку."
    );
    let plain = id(&w, "Без сжатия", "Корень");
    let deeds = id(&w, "Дела", "Проекты");
    assert_eq!(origins(&w, &plain, &deeds), vec!["import"]);
    assert_eq!(named(&w, "Старый")[0].1, NodeKind::Board);
    assert!(
        lines(&report, "ghostProperty")
            .iter()
            .any(|i| i.detail == "[[Нигде]]")
    );
    // «Local Font» of the plugin's fork becomes the default font (R5 §6).
    assert_eq!(lines(&report, "localFont").len(), 2);
}

#[test]
fn import_tasks_items_light_their_note_and_wire_their_dependencies() {
    // 13 §2.9.1, ☑ Q-13-10: the nearest open deadline of the items, a roll-up's light.
    let (mut w, _) = imported();
    let projects = id(&w, "Проекты", "Корень");
    let deeds = id(&w, "Дела", "Проекты");
    let view = w.network_view(&projects).expect("view");
    let node = view.nodes.iter().find(|n| n.id == deeds).expect("Дела");
    let fold = node.fold.clone().expect("a fold");
    assert_eq!(fold.nearest.as_deref(), Some("2026-10-30"));
    assert_eq!(fold.total, 0, "items are no progress of a note");
    // `🆔 call1` … `⛔ call1`: the wire «Дела → Связи».
    let after = id(&w, "Связи", "Проекты");
    assert_eq!(origins(&w, &deeds, &after), vec!["import"]);
}

#[test]
fn import_keeps_unsupported_syntax_and_broken_yaml_as_text() {
    // 13 §2.3, §2.9, §3.6.
    let (w, report) = imported();
    for (code, path) in [
        ("kanban", "Kanban.md"),
        ("templater", "Шаблоны/Templater.md"),
        ("dataview", "Запросы.md"),
        ("brokenYaml", "Битый.md"),
    ] {
        assert!(
            lines(&report, code).iter().any(|i| i.path == path),
            "{code}: {:?}",
            lines(&report, code)
        );
    }
    let broken = id(&w, "Битый", "Корень");
    let text = doc(&w, &format!("content/{broken}"))
        .get_text("text")
        .to_string();
    assert!(text.starts_with("---\ntitle: [unclosed\n---\n"));
    assert_eq!(named(&w, "Kanban")[0].1, NodeKind::Note);
}

#[test]
fn import_names_are_nfc_and_trimmed_and_the_report_says_so() {
    // 13 §3.4.
    let (w, report) = imported();
    assert_eq!(named(&w, "Идей").len(), 1, "NFD → NFC");
    assert_eq!(named(&w, "Пробелы").len(), 1);
    assert_eq!(named(&w, "Нельзя#ссылаться").len(), 1);
    assert_eq!(named(&w, "Note").len() + named(&w, "note").len(), 2);
    for code in ["nfc", "trimmed", "unlinkable", "caseConflict"] {
        assert_eq!(lines(&report, code).len(), 1, "{code}");
    }
    // Not UTF-8: an asset with its bytes.
    assert_eq!(named(&w, "cp1251.md")[0].1, NodeKind::Asset);
    assert_eq!(lines(&report, "notUtf8").len(), 1);
}

#[test]
fn import_leaves_out_dot_folders_and_filtered_files_and_says_so() {
    // 13 §2.1: `.trash`, dot files, `userIgnoreFilters`, a nested vault's config.
    let (_, report) = imported();
    let dots = lines(&report, "dotFiles");
    assert_eq!(dots.len(), 1);
    assert_eq!(dots[0].detail, "3");
    let ignored = lines(&report, "ignored");
    assert_eq!(
        (ignored[0].path.as_str(), ignored[0].detail.as_str()),
        ("Черновики/", "1")
    );
    assert_eq!(lines(&report, "nestedVault")[0].path, "Вложенный vault");
    assert_eq!(report.counts.skipped, 4);
}

#[test]
fn import_is_one_changeset_and_one_step_of_undo() {
    // 13 §1.4 item 3: the origin `import`; undo takes the whole vault back.
    let (mut w, report) = imported();
    let journal = w.store().changesets().expect("journal");
    let imports: Vec<_> = journal
        .iter()
        .filter(|c| c.origin == ChangesetOrigin::Import)
        .collect();
    assert_eq!(imports.len(), 1);
    assert_eq!(imports[0].label.key, "core.change.import");
    assert_eq!(
        w.history().undo.map(|l| l.key).as_deref(),
        Some("core.change.import")
    );
    let before = w.tree().len();
    assert!(before > 50);
    w.undo().expect("undo");
    assert_eq!(w.tree().len(), 1, "the root only");
    assert!(w.wires().is_empty());
    assert_eq!(w.history().undo, None);
    w.redo().expect("redo");
    assert_eq!(w.tree().len(), before);
    let inbox = id(&w, "Входящие", "Корень");
    assert!(!w.node_details(&inbox).expect("back").outputs.is_empty());
    assert!(report.counts.notes > 20 && report.counts.assets >= 6 && report.counts.boards == 3);
}

#[test]
fn import_into_a_network_goes_below_what_is_there() {
    // 13 §3.2 `target: network`; nothing is laid over what the network holds.
    let mut w = super::ws();
    let root = w.root();
    super::create(&mut w, &root, NodeKind::Note, "Была");
    w.import_vault(vsynth(), Some(&root), &options())
        .expect("import");
    let view = w.network_view(&root).expect("view");
    let was = view.nodes.iter().find(|n| n.name == "Была").expect("Была");
    for n in view
        .nodes
        .iter()
        .filter(|n| n.name != "Была" && !n.appearance)
    {
        assert!(n.y >= was.y + 300.0, "{} at {}", n.name, n.y);
    }
    assert!(
        w.import_vault(Vault::from_files("x", Vec::new()), None, &options())
            .is_err()
    );
}

#[cfg(unix)]
#[test]
fn a_vault_is_read_from_disk_without_following_links() {
    // 13 §2.1, R2 §1: symbolic links are not followed; `.trash` is not read.
    let dir = std::env::temp_dir().join(format!(
        "strata-vault-{}",
        strata_model::NodeId::new().to_text()
    ));
    std::fs::create_dir_all(dir.join(".trash")).expect("dir");
    std::fs::create_dir_all(dir.join("Папка")).expect("dir");
    std::fs::write(dir.join("Папка/Заметка.md"), "[[Другая]]\n").expect("write");
    std::fs::write(dir.join(".trash/Старая.md"), "x").expect("write");
    std::os::unix::fs::symlink(dir.join("Папка"), dir.join("Ссылка")).expect("symlink");
    let vault = Vault::read(&dir).expect("read");
    let paths: Vec<&str> = vault.files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(paths, vec!["Папка/Заметка.md"]);
    assert_eq!(vault.symlinks, vec!["Ссылка"]);
    let mut w = super::ws();
    let report = w.import_vault(vault, None, &options()).expect("import");
    assert_eq!(lines(&report, "symlink").len(), 1);
    assert_eq!(id(&w, "Заметка", "Папка").len(), 26);
    std::fs::remove_dir_all(&dir).expect("clean up");
}

#[test]
fn import_lays_a_folder_out_by_l_once_in_its_step() {
    // 06 §9.3, 13 §3.1 step 8, ☑ Q-13-19: a folder without a canvas is laid
    // out by `L` (layered, top to bottom) along the wires its notes' links
    // make, not left in a grid by name; the moves are the import's step.
    let file = |path: &str, text: &str| VaultFile::new(path, text.as_bytes().to_vec());
    let vault = Vault::from_files(
        "Цепочка",
        vec![
            file("Сеть/А.md", "Дальше [[Б]]\n"),
            file("Сеть/Б.md", "Дальше [[В]]\n"),
            file("Сеть/В.md", "Конец\n"),
            file("Сеть/Г.md", "Сам по себе\n"),
        ],
    );
    let mut w = super::ws();
    w.import_vault(vault, None, &options()).expect("the import");
    let net = id(&w, "Сеть", "Корень");
    let view = w.network_view(&net).expect("view");
    let at = |name: &str| {
        let n = view.nodes.iter().find(|n| n.name == name).expect(name);
        (n.x, n.y)
    };
    // А → Б → В: three layers down; by name in a grid А and Б would share a row.
    let (a, b, c) = (at("А"), at("Б"), at("В"));
    assert!(a.1 < b.1 && b.1 < c.1, "{a:?} {b:?} {c:?}");
    // No two bubbles of 32 closer than the gap of `L` (24).
    let all: Vec<(f64, f64)> = view.nodes.iter().map(|n| (n.x, n.y)).collect();
    for (i, p) in all.iter().enumerate() {
        for q in &all[i + 1..] {
            assert!(
                (p.0 - q.0).hypot(p.1 - q.1) >= 32.0 + 24.0 - 1e-3,
                "{p:?} {q:?}"
            );
        }
    }
    // The text wires are there, and one undo takes the vault and its layout back.
    assert_eq!(
        origins(&w, &id(&w, "А", "Сеть"), &id(&w, "Б", "Сеть")),
        vec!["text"]
    );
    assert_eq!(
        w.history().undo.map(|l| l.key).as_deref(),
        Some("core.change.import")
    );
    w.undo().expect("undo");
    assert_eq!(w.tree().len(), 1, "the root only");
}

/// Batches of `n` files for one test: V-synth's few dozen files go in several.
struct Batches(usize);

impl Batches {
    fn of(n: usize) -> Self {
        let was = crate::workspace::TEST_BATCH.with(|b| b.replace(n));
        Self(was)
    }
}

impl Drop for Batches {
    fn drop(&mut self) {
        crate::workspace::TEST_BATCH.with(|b| b.set(self.0));
    }
}

fn begun<S: Store>(w: &mut Workspace<S>, vault: Vault) -> crate::ImportProgress {
    let shadow = w.import_start(None).expect("start");
    let planned = shadow.plan(vault, &options()).expect("plan");
    w.import_begin(planned).expect("begin")
}

#[test]
fn import_writes_its_batches_as_parts_of_one_changeset() {
    // 13 §3.3, 10 §3.3: each batch is one transaction carrying the import's
    // changeset, `in-progress` until the last; the networks come first;
    // the workspace takes no other change meanwhile; one step of undo.
    let _b = Batches::of(4);
    let mut w = super::ws();
    let p = begun(&mut w, vsynth());
    assert_eq!(p.done, 0);
    assert!(p.total > 30, "{p:?}");
    let p = w.import_step().expect("the networks");
    assert_eq!(named(&w, "Игра").len(), 1);
    assert!(named(&w, "Диздок").is_empty());
    assert!(p.done < p.total && p.report.is_none());
    assert_eq!(w.store().unfinished().expect("journal").len(), 1);
    let root = w.root();
    let refused = w.apply(
        &[crate::Op::Rename {
            id: root,
            name: "Другое".to_owned(),
        }],
        crate::Label::new("x"),
    );
    assert!(matches!(refused, Err(crate::CoreError::Invalid(_))));
    let mut steps = 1;
    let report = loop {
        let p = w.import_step().expect("a batch");
        steps += 1;
        if let Some(r) = p.report {
            assert_eq!(p.done, p.total);
            break r;
        }
    };
    assert!(steps > 5, "{steps}");
    assert!(w.store().unfinished().expect("journal").is_empty());
    assert!(w.import_progress().is_none());
    let imports: Vec<_> = w
        .store()
        .changesets()
        .expect("journal")
        .into_iter()
        .filter(|c| c.origin == ChangesetOrigin::Import)
        .collect();
    assert_eq!(imports.len(), 1);
    assert!(report.counts.notes > 20);
    w.undo().expect("undo");
    assert_eq!(w.tree().len(), 1, "the root only");
}

#[test]
fn import_in_batches_lands_as_one_at_once() {
    // 13 §3.3: a wire comes with the later of its ends, a node's keys with
    // the node — the batches add up to the same workspace and report.
    let at_once = imported();
    let _b = Batches::of(3);
    let batched = imported();
    let names = |w: &Workspace<MemoryStore>| {
        let mut n: Vec<(String, NodeKind)> =
            w.tree().into_iter().map(|t| (t.name, t.kind)).collect();
        n.sort_by(|a, b| a.0.cmp(&b.0));
        n
    };
    assert_eq!(names(&at_once.0), names(&batched.0));
    assert_eq!(at_once.0.wires().len(), batched.0.wires().len());
    let codes = |r: &ImportReport| {
        let mut c: Vec<(String, String)> = r
            .items
            .iter()
            .map(|i| (i.code.clone(), i.detail.clone()))
            .collect();
        c.sort();
        c
    };
    assert_eq!(codes(&at_once.1), codes(&batched.1));
    assert_eq!(at_once.1.counts, batched.1.counts);
}

#[test]
fn a_cancelled_import_is_taken_back_whole() {
    // 13 §3.3 «Отмена»: what the batches wrote goes; the changeset is closed.
    let _b = Batches::of(4);
    let mut w = super::ws();
    begun(&mut w, vsynth());
    w.import_step().expect("the networks");
    w.import_step().expect("a batch");
    assert!(w.tree().len() > 5);
    w.import_cancel().expect("cancel");
    assert_eq!(w.tree().len(), 1, "the root only");
    assert!(w.import_progress().is_none());
    assert!(w.store().unfinished().expect("journal").is_empty());
    assert_eq!(w.history().undo, None);
    // The workspace takes changes again.
    let root = w.root();
    w.apply(
        &[crate::Op::Rename {
            id: root,
            name: "Снова".to_owned(),
        }],
        crate::Label::new("x"),
    )
    .expect("a change");
}

#[test]
fn an_import_the_app_broke_off_waits_for_откатить_or_оставить() {
    // 10 §3.3, NFR-71: each batch is whole in the store; the changeset left
    // `in-progress` is found on the next opening.
    let _b = Batches::of(1);
    let file = |path: &str, text: &str| VaultFile::new(path, text.as_bytes().to_vec());
    let vault = || {
        Vault::from_files(
            "Обрыв",
            vec![file("А.md", "Ссылка на [[Б]]\n"), file("Б.md", "Б\n")],
        )
    };
    for keep in [false, true] {
        let dir = std::env::temp_dir().join(format!("strata-broken-{}-{keep}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut w = crate::sqlite::create_folder(&dir, "Обрыв").expect("folder");
        begun(&mut w, vault());
        w.import_step().expect("the networks");
        w.import_step().expect("А");
        drop(w);
        let mut w = crate::sqlite::open_folder(&dir).expect("open");
        assert_eq!(
            w.interrupted().map(|l| l.key).as_deref(),
            Some("core.change.import")
        );
        w.settle_interrupted(keep).expect("settle");
        assert_eq!(w.interrupted(), None);
        let mut names: Vec<String> = w.tree().into_iter().map(|t| t.name).collect();
        names.sort();
        if keep {
            // А stays; Б never came: its link is a ghost now (05 §8.5).
            assert_eq!(names, vec!["А", "Обрыв"]);
            let view = w.network_view(&w.root()).expect("view");
            assert_eq!(view.ghosts.len(), 1, "{:?}", view.ghosts);
        } else {
            assert_eq!(names, vec!["Обрыв"]);
        }
        drop(w);
        let w = crate::sqlite::open_folder(&dir).expect("open again");
        assert_eq!(w.interrupted(), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[test]
fn a_vaults_attachments_stay_on_disk_till_their_batch() {
    // 13 §3.3 «Память»: pictures are read when their batch copies them.
    let dir = std::env::temp_dir().join(format!("strata-lazy-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("dir");
    std::fs::write(dir.join("Заметка.md"), "![[фото.png]]\n").expect("note");
    let picture = b"\x89PNG\r\n\x1a\nnot really".to_vec();
    std::fs::write(dir.join("фото.png"), &picture).expect("picture");
    let vault = Vault::read(&dir).expect("read");
    let pic = vault
        .files
        .iter()
        .find(|f| f.path == "фото.png")
        .expect("listed");
    assert!(pic.bytes.is_empty() && pic.disk.is_some());
    let mut w = super::ws();
    w.import_vault(vault, None, &options()).expect("import");
    let id = id(&w, "фото.png", "Корень");
    let sha = w
        .node_details(&id)
        .expect("node")
        .attrs
        .asset
        .expect("asset");
    assert_eq!(w.asset(&sha).expect("bytes"), Some(picture));
    std::fs::remove_dir_all(&dir).expect("clean up");
}

fn text_of(w: &Workspace<MemoryStore>, id: &str) -> String {
    doc(w, &format!("content/{id}"))
        .get_text("text")
        .to_string()
}

fn wired(w: &Workspace<MemoryStore>, from: &str, to: &str) -> bool {
    w.wires().iter().any(|e| e.from == from && e.to == to)
}

#[test]
fn the_reports_choose_a_target_writes_the_shortest_path_in_one_step() {
    // 13 §3.5 «Исправление», §3.6, S1 step 8: «Входящие» has `[[Диздок]]`,
    // a name two notes share; the report offers both, the nearest first.
    let (mut w, report) = imported();
    let inbox = id(&w, "Входящие", "Корень");
    let game = id(&w, "Диздок", "Игра");
    let comic = id(&w, "Диздок", "Комикс");
    let row = report
        .items
        .iter()
        .find(|i| i.code == "ambiguous" && i.link.as_deref() == Some("Диздок"))
        .expect("the row");
    assert_eq!(row.node.as_deref(), Some(inbox.as_str()));
    let targets = w.link_targets(&inbox, "Диздок").expect("targets");
    let paths: Vec<&str> = targets.targets.iter().map(|t| t.path.as_str()).collect();
    assert_eq!(paths.len(), 2, "{paths:?}");
    assert!(paths.contains(&"Проекты/Игра/Диздок") && paths.contains(&"Проекты/Комикс/Диздок"));
    assert_eq!(targets.chosen.as_deref(), row.target.as_deref());
    let before = text_of(&w, &inbox);
    // Choose «Комикс»: the shortest path that names it alone.
    w.pin_link(&inbox, "Диздок", &comic, false).expect("pin");
    let after = text_of(&w, &inbox);
    assert!(after.contains("имя дважды: [[Комикс/Диздок]]."), "{after}");
    assert!(
        after.contains("[[Проекты/Игра/Диздок]]"),
        "the path link stays"
    );
    assert!(wired(&w, &inbox, &comic) && wired(&w, &inbox, &game));
    assert_eq!(
        w.history().undo.map(|l| l.key).as_deref(),
        Some("core.change.pinLink")
    );
    // One step: undone, the text and its wire are as they were.
    w.undo().expect("undo");
    assert_eq!(text_of(&w, &inbox), before);
    assert!(!wired(&w, &inbox, &comic));
    w.redo().expect("redo");
    assert_eq!(text_of(&w, &inbox), after);
    assert!(wired(&w, &inbox, &comic));
}

#[test]
fn the_reports_bind_keeps_what_was_written_as_the_links_text() {
    // 13 §2.4, §3.6: `[[Сценарий]]` names no note but an alias of «Диздок»;
    // «Привязать» writes `[[Игра/Диздок|Сценарий]]`: the ghost goes.
    let (mut w, report) = imported();
    let inbox = id(&w, "Входящие", "Корень");
    let row = report
        .items
        .iter()
        .find(|i| i.code == "ghostAlias" && i.link.as_deref() == Some("Сценарий"))
        .expect("the row");
    let owner = row.target.clone().expect("the alias's owner");
    let ghosts = |w: &mut Workspace<MemoryStore>| {
        let root = w.root();
        w.network_view(&root)
            .expect("view")
            .ghosts
            .iter()
            .filter(|g| g.name == "Сценарий")
            .count()
    };
    assert_eq!(ghosts(&mut w), 1);
    w.pin_link(&inbox, "Сценарий", &owner, true).expect("bind");
    let text = text_of(&w, &inbox);
    assert!(text.contains("Алиас: [[Игра/Диздок|Сценарий]]."), "{text}");
    assert_eq!(ghosts(&mut w), 0);
    assert!(wired(&w, &inbox, &owner));
    // A link not in the text is refused; nothing is written.
    assert!(w.pin_link(&inbox, "Нигде", &owner, false).is_err());
    w.undo().expect("undo");
    assert_eq!(ghosts(&mut w), 1);
}
