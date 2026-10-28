//! The model's rules on the core (CLAUDE.md: every rule of 05 has a test).

use crate::{Label, MemoryStore, Op, Store, Workspace};
use strata_model::{NodeId, NodeKind};

fn ws() -> Workspace<MemoryStore> {
    let mut w = Workspace::create(MemoryStore::default(), "Корень").expect("create");
    w.set_clock(|| 1_760_000_000_000);
    w
}

fn create(w: &mut Workspace<MemoryStore>, net: &str, kind: NodeKind, name: &str) -> String {
    let id = NodeId::new().to_text();
    w.apply(
        &[Op::CreateNode {
            id: Some(id.clone()),
            kind,
            name: name.to_owned(),
            net: net.to_owned(),
            x: 10.0,
            y: 20.0,
        }],
        Label::new("t.create"),
    )
    .expect("create a node");
    id
}

fn names(w: &mut Workspace<MemoryStore>, net: &str) -> Vec<String> {
    let mut v: Vec<String> = w
        .network_view(net)
        .expect("view")
        .nodes
        .into_iter()
        .map(|n| n.name)
        .collect();
    v.sort();
    v
}

#[test]
fn a_new_workspace_has_an_empty_root_network() {
    let mut w = ws();
    let root = w.root();
    let v = w.network_view(&root).expect("view");
    assert_eq!(v.name, "Корень");
    assert!(v.nodes.is_empty() && v.edges.is_empty());
    assert_eq!(v.path, vec![(root.clone(), "Корень".to_owned())]);
    assert_eq!(
        w.history().undo,
        None,
        "creating the workspace is no step of undo"
    );
}

#[test]
fn a_gesture_of_several_ops_is_one_step_of_undo() {
    let mut w = ws();
    let root = w.root();
    let (a, b) = (NodeId::new().to_text(), NodeId::new().to_text());
    let mk = |id: &str, name: &str| Op::CreateNode {
        id: Some(id.to_owned()),
        kind: NodeKind::Note,
        name: name.to_owned(),
        net: root.clone(),
        x: 0.0,
        y: 0.0,
    };
    w.apply(
        &[
            mk(&a, "Первая"),
            mk(&b, "Вторая"),
            Op::Connect {
                from: a.clone(),
                to: b.clone(),
            },
        ],
        Label::new("t.chain"),
    )
    .expect("apply");
    let v = w.network_view(&root).expect("view");
    assert_eq!(v.nodes.len(), 2);
    assert_eq!(v.edges.len(), 1);
    assert_eq!(w.history().undo.map(|l| l.key), Some("t.chain".to_owned()));

    w.undo().expect("undo");
    assert!(names(&mut w, &root).is_empty());
    assert_eq!(w.history().redo.map(|l| l.key), Some("t.chain".to_owned()));
    w.redo().expect("redo");
    assert_eq!(names(&mut w, &root), vec!["Вторая", "Первая"]);
    assert_eq!(w.network_view(&root).expect("view").edges.len(), 1);
}

#[test]
fn wires_follow_the_rules_of_05_8() {
    let mut w = ws();
    let root = w.root();
    let a = create(&mut w, &root, NodeKind::Note, "A");
    let b = create(&mut w, &root, NodeKind::Note, "B");
    let steps = w.store().changesets().expect("changesets").len();
    // No loop on one node; no wire to a node that does not exist.
    assert!(
        w.apply(
            &[Op::Connect {
                from: a.clone(),
                to: a.clone()
            }],
            Label::new("t")
        )
        .is_err()
    );
    let ghost = NodeId::new().to_text();
    assert!(
        w.apply(
            &[Op::Connect {
                from: a.clone(),
                to: ghost
            }],
            Label::new("t")
        )
        .is_err()
    );
    assert_eq!(
        w.store().changesets().expect("changesets").len(),
        steps,
        "nothing written"
    );
    // One wire per ordered pair: connecting twice keeps one.
    for _ in 0..2 {
        w.apply(
            &[Op::Connect {
                from: a.clone(),
                to: b.clone(),
            }],
            Label::new("t"),
        )
        .expect("connect");
    }
    // A cycle is allowed (05 §8.2 rule 3).
    w.apply(
        &[Op::Connect {
            from: b.clone(),
            to: a.clone(),
        }],
        Label::new("t"),
    )
    .expect("back");
    assert_eq!(w.network_view(&root).expect("view").edges.len(), 2);
    w.apply(
        &[Op::Disconnect {
            from: a.clone(),
            to: b.clone(),
        }],
        Label::new("t"),
    )
    .expect("cut");
    let v = w.network_view(&root).expect("view");
    assert_eq!(v.edges.len(), 1);
    assert_eq!(
        (v.edges[0].from.as_str(), v.edges[0].to.as_str()),
        (b.as_str(), a.as_str())
    );
}

#[test]
fn a_failed_list_writes_nothing() {
    let mut w = ws();
    let root = w.root();
    let id = NodeId::new().to_text();
    let res = w.apply(
        &[
            Op::CreateNode {
                id: Some(id.clone()),
                kind: NodeKind::Note,
                name: "Будет".to_owned(),
                net: root.clone(),
                x: 0.0,
                y: 0.0,
            },
            Op::Rename {
                id: NodeId::new().to_text(),
                name: "Нет такой".to_owned(),
            },
        ],
        Label::new("t"),
    );
    assert!(res.is_err());
    assert!(names(&mut w, &root).is_empty());
    assert_eq!(w.history().undo, None);
}

#[test]
fn nodes_live_in_networks_and_the_path_leads_home() {
    let mut w = ws();
    let root = w.root();
    let project = create(&mut w, &root, NodeKind::Network, "Проект");
    let note = create(&mut w, &project, NodeKind::Note, "Заметка");
    assert_eq!(names(&mut w, &root), vec!["Проект"]);
    assert_eq!(names(&mut w, &project), vec!["Заметка"]);
    let v = w.network_view(&project).expect("view");
    let path: Vec<&str> = v.path.iter().map(|(_, n)| n.as_str()).collect();
    assert_eq!(path, vec!["Корень", "Проект"]);
    // Only a network takes nodes.
    assert!(
        w.apply(
            &[Op::CreateNode {
                id: None,
                kind: NodeKind::Note,
                name: "x".to_owned(),
                net: note,
                x: 0.0,
                y: 0.0,
            }],
            Label::new("t"),
        )
        .is_err()
    );
}

#[test]
fn moves_rename_and_the_view_follow() {
    let mut w = ws();
    let root = w.root();
    let a = create(&mut w, &root, NodeKind::Note, "A");
    w.apply(
        &[
            Op::Move {
                net: root.clone(),
                id: a.clone(),
                x: 300.0,
                y: -40.5,
            },
            Op::Rename {
                id: a.clone(),
                name: "  Новое имя ".to_owned(),
            },
        ],
        Label::new("t"),
    )
    .expect("apply");
    let v = w.network_view(&root).expect("view");
    assert_eq!((v.nodes[0].x, v.nodes[0].y), (300.0, -40.5));
    assert_eq!(v.nodes[0].name, "Новое имя");
    w.undo().expect("undo");
    let v = w.network_view(&root).expect("view");
    assert_eq!(
        (v.nodes[0].x, v.nodes[0].y, v.nodes[0].name.as_str()),
        (10.0, 20.0, "A")
    );
}

#[test]
fn the_trash_hides_and_gives_back() {
    let mut w = ws();
    let root = w.root();
    let a = create(&mut w, &root, NodeKind::Note, "A");
    let b = create(&mut w, &root, NodeKind::Board, "B");
    w.apply(
        &[Op::Connect {
            from: a.clone(),
            to: b.clone(),
        }],
        Label::new("t"),
    )
    .expect("connect");
    w.apply(
        &[Op::Trash {
            ids: vec![b.clone()],
        }],
        Label::new("t.trash"),
    )
    .expect("trash");
    let v = w.network_view(&root).expect("view");
    assert_eq!(v.nodes.len(), 1);
    assert!(
        v.edges.is_empty(),
        "a wire to a node in the trash is hidden (05 §14 item 6)"
    );
    let trash = w.trash();
    assert_eq!(trash.len(), 1);
    assert_eq!(
        (trash[0].id.as_str(), trash[0].name.as_str()),
        (b.as_str(), "B")
    );
    // The root stays; a node in the trash takes no wires.
    assert!(
        w.apply(
            &[Op::Trash {
                ids: vec![root.clone()]
            }],
            Label::new("t")
        )
        .is_err()
    );
    assert!(
        w.apply(
            &[Op::Connect {
                from: a.clone(),
                to: b.clone()
            }],
            Label::new("t")
        )
        .is_err(),
        "a node in the trash takes no new wires"
    );
    w.apply(
        &[Op::Restore {
            ids: vec![b.clone()],
        }],
        Label::new("t.restore"),
    )
    .expect("restore");
    let v = w.network_view(&root).expect("view");
    assert_eq!(v.nodes.len(), 2);
    assert_eq!(v.edges.len(), 1, "everything back in place (05 §11)");
    assert!(w.trash().is_empty());
}

#[test]
fn undo_skips_a_key_changed_since_and_says_so() {
    let mut w = ws();
    let root = w.root();
    let a = create(&mut w, &root, NodeKind::Note, "A");
    w.apply(
        &[Op::Rename {
            id: a.clone(),
            name: "B".to_owned(),
        }],
        Label::new("t1"),
    )
    .expect("b");
    w.apply(
        &[Op::Move {
            net: root.clone(),
            id: a.clone(),
            x: 1.0,
            y: 1.0,
        }],
        Label::new("t2"),
    )
    .expect("move");
    // Undo the move, then the rename: both clean.
    assert!(w.undo().expect("undo").expect("a step").skipped.is_empty());
    assert!(w.undo().expect("undo").expect("a step").skipped.is_empty());
    assert_eq!(names(&mut w, &root), vec!["A"]);
}

#[test]
fn a_workspace_opens_again_from_its_store() {
    let mut w = ws();
    let root = w.root();
    let a = create(&mut w, &root, NodeKind::Note, "A");
    let b = create(&mut w, &root, NodeKind::Note, "B");
    w.apply(&[Op::Connect { from: a, to: b }], Label::new("t"))
        .expect("connect");
    let before = w.network_view(&root).expect("view");
    let id = w.id().to_owned();
    let store = w.into_store();
    let mut again = Workspace::open(store).expect("open");
    assert_eq!(again.id(), id);
    assert_eq!(again.root(), root);
    assert_eq!(again.network_view(&root).expect("view"), before);
    assert_eq!(again.history().undo, None, "undo belongs to the session");
}

#[test]
fn build_info_mentions_version() {
    assert!(crate::build_info().contains(crate::VERSION));
}

#[test]
fn the_rest_of_a_gesture_joins_its_step() {
    let mut w = ws();
    let root = w.root();
    let a = create(&mut w, &root, NodeKind::Note, "Без имени");
    let mut label = Label::new("t.named");
    label.params.insert("name".into(), "Имя".into());
    w.amend(
        &[Op::Rename {
            id: a.clone(),
            name: "Имя".to_owned(),
        }],
        label,
    )
    .expect("amend");
    assert_eq!(names(&mut w, &root), vec!["Имя"]);
    assert_eq!(w.history().undo.map(|l| l.key), Some("t.named".to_owned()));
    // One undo takes the node and its name away together.
    w.undo().expect("undo");
    assert!(names(&mut w, &root).is_empty());
    assert_eq!(w.history().undo, None);
    w.redo().expect("redo");
    assert_eq!(names(&mut w, &root), vec!["Имя"]);
    // Only a new label: the step keeps its writes.
    w.amend(&[], Label::new("t.relabel")).expect("relabel");
    assert_eq!(
        w.history().undo.map(|l| l.key),
        Some("t.relabel".to_owned())
    );
}

#[test]
fn a_cancelled_gesture_leaves_no_step() {
    let mut w = ws();
    let root = w.root();
    create(&mut w, &root, NodeKind::Note, "A");
    w.cancel().expect("cancel");
    assert!(names(&mut w, &root).is_empty());
    assert_eq!(
        w.history(),
        crate::History::default(),
        "nothing to redo either"
    );
}

/// The editor's side of a note: its own Loro document, sending updates.
struct Editor {
    doc: loro::LoroDoc,
    sent: loro::VersionVector,
}

impl Editor {
    fn open(w: &mut Workspace<MemoryStore>, note: &str) -> Self {
        let doc = loro::LoroDoc::new();
        doc.import(
            &w.doc_snapshot(&format!("content/{note}"))
                .expect("snapshot"),
        )
        .expect("import");
        let sent = doc.oplog_vv();
        Self { doc, sent }
    }

    fn type_text(&mut self, w: &mut Workspace<MemoryStore>, note: &str, text: &str) -> bool {
        let t = self.doc.get_text("text");
        t.delete(0, t.len_unicode()).expect("clear");
        t.insert(0, text).expect("type");
        self.doc.commit();
        let update = self
            .doc
            .export(loro::ExportMode::updates(&self.sent))
            .expect("export");
        self.sent = self.doc.oplog_vv();
        w.doc_push(&format!("content/{note}"), &update)
            .expect("push")
    }
}

#[test]
fn links_in_a_note_become_its_text_wires() {
    let mut w = ws();
    let root = w.root();
    let note = create(&mut w, &root, NodeKind::Note, "Заметка");
    let board = create(&mut w, &root, NodeKind::Board, "Доска идей");
    let steps = w.history();
    let mut ed = Editor::open(&mut w, &note);

    assert!(ed.type_text(&mut w, &note, "См. [[доска идей]] и [[Нет такой]]"));
    let v = w.network_view(&root).expect("view");
    assert_eq!(v.edges.len(), 1);
    let e = &v.edges[0];
    assert_eq!(
        (e.from.as_str(), e.to.as_str(), e.text, e.manual),
        (note.as_str(), board.as_str(), true, false)
    );
    assert_eq!(w.history(), steps, "typing is no step of the canvas's undo");

    // The same text again changes nothing.
    assert!(!ed.type_text(&mut w, &note, "См. [[Доска идей]] и [[Нет такой]]"));

    // A wire drawn by hand outlives its link (05 §8.2 rule 5).
    w.apply(
        &[Op::Connect {
            from: note.clone(),
            to: board.clone(),
        }],
        Label::new("t"),
    )
    .expect("connect");
    assert!(ed.type_text(&mut w, &note, "Без ссылок"));
    let v = w.network_view(&root).expect("view");
    assert_eq!(
        (v.edges.len(), v.edges[0].text, v.edges[0].manual),
        (1, false, true)
    );
    w.apply(
        &[Op::Disconnect {
            from: note.clone(),
            to: board,
        }],
        Label::new("t"),
    )
    .expect("cut");
    assert!(w.network_view(&root).expect("view").edges.is_empty());

    // The text is in the core: a second editor opens it.
    let again = Editor::open(&mut w, &note);
    assert_eq!(again.doc.get_text("text").to_string(), "Без ссылок");
}

#[test]
fn a_list_rolls_up_its_ticked_items_at_any_depth() {
    // A list's items are a tree in its content document (05 §4.2, 10 §2.4);
    // the bubble and the panel show the ticked of all (05 §6.4).
    let mut w = ws();
    let root = w.root();
    let list = create(&mut w, &root, NodeKind::Checklist, "Покупки");
    let fold = |w: &mut Workspace<MemoryStore>| {
        let v = w.network_view(&root).expect("view");
        let n = v.nodes.iter().find(|n| n.id == list).expect("the list");
        n.fold.clone().map(|f| (f.done, f.total, f.nearest))
    };
    assert_eq!(fold(&mut w), Some((0, 0, None)), "an empty list");

    let ed = Editor::open(&mut w, &list);
    let tree = ed.doc.get_tree(crate::workspace::LIST_ITEMS);
    let item = |parent: Option<loro::TreeID>, text: &str, done: bool| {
        let id = tree.create(parent).expect("item");
        let meta = tree.get_meta(id).expect("meta");
        meta.insert("done", done).expect("done");
        meta.insert("text", text).expect("text");
        id
    };
    let bread = item(None, "Хлеб", true);
    item(Some(bread), "Белый", true);
    let milk = item(Some(bread), "Ржаной", false);
    item(None, "Молоко", false);
    tree.delete(milk).expect("delete");
    ed.doc.commit();
    let steps = w.history();
    let update = ed
        .doc
        .export(loro::ExportMode::all_updates())
        .expect("export");
    assert!(
        !w.doc_push(&format!("content/{list}"), &update)
            .expect("push")
    );
    assert_eq!(
        w.history(),
        steps,
        "ticking is no step of the canvas's undo"
    );
    // A deleted item does not count; a nested one does.
    assert_eq!(fold(&mut w), Some((2, 3, None)));
    let d = w.node_details(&list).expect("details");
    assert_eq!(d.fold.map(|f| (f.done, f.total)), Some((2, 3)));

    // From the store too, after the workspace opens again.
    let mut again = Workspace::open(w.into_store()).expect("open");
    let d = again.node_details(&list).expect("details");
    assert_eq!(d.fold.map(|f| (f.done, f.total)), Some((2, 3)));
    let v = again.network_view(&root).expect("view");
    assert_eq!(v.nodes[0].fold.as_ref().map(|f| f.total), Some(3));

    // A note shows no roll-up.
    let note = create(&mut again, &root, NodeKind::Note, "Заметка");
    assert_eq!(again.node_details(&note).expect("details").fold, None);
}

#[test]
fn every_node_has_a_content_document() {
    // A folder's description is its content document (05 §4.2, ADR-0010).
    let mut w = ws();
    let root = w.root();
    assert!(w.doc_snapshot(&format!("content/{root}")).is_ok());
    assert!(w.doc_snapshot("net/whatever").is_err());
    assert!(
        w.doc_snapshot(&format!("content/{}", NodeId::new().to_text()))
            .is_err()
    );
}

#[test]
fn the_browser_keeps_a_workspace_as_bytes() {
    let mut w = ws();
    let root = w.root();
    let note = create(&mut w, &root, NodeKind::Note, "Заметка");
    create(&mut w, &root, NodeKind::Note, "Цель");
    let mut ed = Editor::open(&mut w, &note);
    ed.type_text(&mut w, &note, "[[Цель]]");
    let before = w.network_view(&root).expect("view");
    let bytes = w.into_store().to_bytes();
    let mut again = Workspace::open(MemoryStore::from_bytes(&bytes).expect("bytes")).expect("open");
    assert_eq!(again.network_view(&root).expect("view"), before);
    let ed = Editor::open(&mut again, &note);
    assert_eq!(ed.doc.get_text("text").to_string(), "[[Цель]]");
}

fn set(
    w: &mut Workspace<MemoryStore>,
    id: &str,
    key: &str,
    value: Option<crate::value::Val>,
) -> crate::workspace::Result<crate::Changeset> {
    w.apply(
        &[Op::SetAttr {
            id: id.to_owned(),
            key: key.to_owned(),
            value,
        }],
        Label::new("t.attr"),
    )
}

#[test]
fn attributes_take_only_the_values_of_05_6() {
    use crate::value::Val;
    let mut w = ws();
    let root = w.root();
    let a = create(&mut w, &root, NodeKind::Task, "A");
    set(&mut w, &a, "status", Some(Val::str("doing"))).expect("status");
    set(&mut w, &a, "deadline", Some(Val::str("2026-02-28"))).expect("deadline");
    set(&mut w, &a, "start", Some(Val::str("2024-02-29"))).expect("leap day");
    // A time of day too, as Obsidian's datetime (05 §6.1).
    set(&mut w, &a, "start", Some(Val::str("2024-02-29T09:05"))).expect("a day and a time");
    set(&mut w, &a, "start", Some(Val::str("2024-02-29"))).expect("the day alone again");
    set(&mut w, &a, "priority", Some(Val::str("urgent"))).expect("priority");
    set(&mut w, &a, "color", Some(Val::Int(7))).expect("colour");
    for (key, bad) in [
        ("status", Val::str("someday")),
        ("deadline", Val::str("2026-02-30")),
        ("deadline", Val::str("30.10.2026")),
        ("deadline", Val::str("2026-02-28T24:00")),
        ("deadline", Val::str("2026-02-28T9:05")),
        ("deadline", Val::str("2026-02-30T10:00")),
        ("start", Val::str("2026-02-28T10:00:00")),
        ("priority", Val::Int(3)),
        ("color", Val::Int(8)),
        ("weather", Val::str("sunny")),
    ] {
        assert!(
            set(&mut w, &a, key, Some(bad.clone())).is_err(),
            "{key} = {bad:?}"
        );
    }
    let n = &w.network_view(&root).expect("view").nodes[0];
    assert_eq!(n.attrs.status.as_deref(), Some("doing"));
    assert_eq!(n.attrs.deadline.as_deref(), Some("2026-02-28"));
    assert_eq!(n.attrs.priority.as_deref(), Some("urgent"));
    assert_eq!(n.attrs.color, Some(7));
    // Cleared, and back with undo.
    set(&mut w, &a, "status", None).expect("clear");
    assert_eq!(
        w.network_view(&root).expect("view").nodes[0].attrs.status,
        None
    );
    w.undo().expect("undo");
    assert_eq!(
        w.network_view(&root).expect("view").nodes[0]
            .attrs
            .status
            .as_deref(),
        Some("doing")
    );
}

#[test]
fn people_are_assigned_and_only_people_of_the_workspace() {
    let mut w = ws();
    let root = w.root();
    let a = create(&mut w, &root, NodeKind::Task, "A");
    let anton = NodeId::new().to_text();
    w.apply(
        &[Op::AddPerson {
            id: Some(anton.clone()),
            name: " Антон ".to_owned(),
            color: Some(3),
        }],
        Label::new("t.person"),
    )
    .expect("person");
    let assign = |w: &mut Workspace<MemoryStore>, person: &str, on: bool| {
        w.apply(
            &[Op::Assign {
                id: a.clone(),
                person: person.to_owned(),
                on,
            }],
            Label::new("t.assign"),
        )
    };
    assign(&mut w, &anton, true).expect("assign");
    assert!(
        assign(&mut w, &NodeId::new().to_text(), true).is_err(),
        "a stranger"
    );
    assert_eq!(
        w.network_view(&root).expect("view").nodes[0]
            .attrs
            .assignees,
        vec![anton.clone()]
    );
    assert_eq!(
        w.people(),
        vec![crate::Person {
            id: anton.clone(),
            name: "Антон".to_owned(),
            color: 3
        }]
    );
    assign(&mut w, &anton, false).expect("unassign");
    assert!(
        w.network_view(&root).expect("view").nodes[0]
            .attrs
            .assignees
            .is_empty()
    );
}

#[test]
fn task_fields_belong_to_tasks_and_projects() {
    use crate::value::Val;
    // ADR-0010: status, priority, dates and assignees are a task's fields.
    let mut w = ws();
    let root = w.root();
    let task = create(&mut w, &root, NodeKind::Task, "Боёвка");
    let project = create(&mut w, &root, NodeKind::Project, "Срез");
    let note = create(&mut w, &root, NodeKind::Note, "Заметка");
    let folder = create(&mut w, &root, NodeKind::Network, "Папка");
    for id in [&task, &project] {
        set(&mut w, id, "status", Some(Val::str("doing"))).expect("status");
        set(&mut w, id, "priority", Some(Val::str("high"))).expect("priority");
        set(&mut w, id, "deadline", Some(Val::str("2026-11-01"))).expect("deadline");
    }
    for id in [&note, &folder] {
        assert!(set(&mut w, id, "status", Some(Val::str("doing"))).is_err());
        assert!(set(&mut w, id, "deadline", Some(Val::str("2026-11-01"))).is_err());
        // Colour is everyone's.
        set(&mut w, id, "color", Some(Val::Int(2))).expect("colour");
        // A field left from before ADR-0010 can still be cleared.
        set(&mut w, id, "status", None).expect("clearing is open to any kind");
        set(&mut w, id, "deadline", None).expect("clearing is open to any kind");
    }
    assert!(set(&mut w, &task, "url", None).is_ok());
    w.apply(
        &[Op::AddPerson {
            id: Some("p1".to_owned()),
            name: "Иван".to_owned(),
            color: None,
        }],
        Label::new("t.person"),
    )
    .expect("person");
    let assign = |id: &str| Op::Assign {
        id: id.to_owned(),
        person: "p1".to_owned(),
        on: true,
    };
    w.apply(&[assign(&task)], Label::new("t"))
        .expect("a task's assignee");
    assert!(w.apply(&[assign(&note)], Label::new("t")).is_err());
    let unassign = Op::Assign {
        id: note.clone(),
        person: "p1".to_owned(),
        on: false,
    };
    assert!(w.apply(&[unassign], Label::new("t")).is_ok());
    // An asset's fields are an asset's.
    assert!(set(&mut w, &task, "url", Some(Val::str("https://example.org"))).is_err());
    // «Ноды» show the deadline's state (Q-07-22): the tree carries it.
    let row = w
        .tree()
        .into_iter()
        .find(|i| i.id == task)
        .expect("in the tree");
    assert_eq!(row.deadline.as_deref(), Some("2026-11-01"));
    // The description is the node's own content document (05 §4.2).
    assert!(w.doc_snapshot(&format!("content/{task}")).is_ok());
    assert!(w.doc_snapshot(&format!("content/{folder}")).is_ok());
}

#[test]
fn one_dives_into_folders_and_projects_not_tasks() {
    let mut w = ws();
    let root = w.root();
    let task = create(&mut w, &root, NodeKind::Task, "Задача");
    let project = create(&mut w, &root, NodeKind::Project, "Проект");
    create(&mut w, &project, NodeKind::Task, "Внутри проекта");
    let into_task = w.apply(
        &[Op::CreateNode {
            id: None,
            kind: NodeKind::Note,
            name: "Нельзя".to_owned(),
            net: task.clone(),
            x: 0.0,
            y: 0.0,
        }],
        Label::new("t"),
    );
    assert!(into_task.is_err(), "a task has no canvas (ADR-0010)");
    assert!(w.network_view(&project).is_ok());
    assert!(w.network_view(&task).is_err());
}

#[test]
fn subtasks_are_the_tasks_a_task_wires_to() {
    use crate::value::Val;
    let mut w = ws();
    let root = w.root();
    let task = create(&mut w, &root, NodeKind::Task, "Боёвка");
    let anim = create(&mut w, &root, NodeKind::Task, "Анимации");
    let hit = create(&mut w, &root, NodeKind::Task, "Хитбоксы");
    let deep = create(&mut w, &root, NodeKind::Task, "Глубже");
    let spec = create(&mut w, &root, NodeKind::Note, "Спецификация");
    let wire = |from: &str, to: &str| Op::Connect {
        from: from.to_owned(),
        to: to.to_owned(),
    };
    w.apply(
        &[
            wire(&task, &anim),
            wire(&task, &hit),
            wire(&hit, &deep),
            // A cycle and a second parent: each subtask counts once.
            wire(&deep, &task),
            wire(&anim, &deep),
            // A note is a material, not a subtask.
            wire(&task, &spec),
        ],
        Label::new("t.wires"),
    )
    .expect("wires");
    set(&mut w, &anim, "status", Some(Val::str("done"))).expect("done");
    set(&mut w, &anim, "deadline", Some(Val::str("2026-10-01"))).expect("d0");
    set(&mut w, &hit, "deadline", Some(Val::str("2026-11-03"))).expect("d1");
    set(&mut w, &deep, "deadline", Some(Val::str("2026-11-01"))).expect("d2");

    let view = w.network_view(&root).expect("view");
    let fold_of = |id: &str| {
        view.nodes
            .iter()
            .find(|n| n.id == id)
            .and_then(|n| n.fold.clone())
            .expect("a task has a fold")
    };
    let f = fold_of(&task);
    assert_eq!((f.done, f.total), (1, 3), "the whole depth, each once");
    assert_eq!(
        f.nearest.as_deref(),
        Some("2026-11-01"),
        "a finished one's deadline does not count"
    );
    let f = fold_of(&hit);
    assert_eq!(
        (f.done, f.total),
        (1, 3),
        "through the cycle back to the top and down again"
    );

    // The checklist preview: subtasks by wires, each node once.
    let d = w.node_details(&task).expect("details");
    let names: Vec<(&str, Vec<&str>)> = d
        .subtasks
        .iter()
        .map(|r| {
            (
                r.name.as_str(),
                r.rows.iter().map(|c| c.name.as_str()).collect(),
            )
        })
        .collect();
    assert_eq!(
        names,
        vec![("Анимации", vec!["Глубже"]), ("Хитбоксы", vec![])],
        "creation order; «Глубже» once, under its first parent"
    );
    assert!(
        d.outputs.iter().any(|l| l.name == "Спецификация"),
        "materials are the wires out to other kinds"
    );
    assert!(w.node_details(&spec).expect("note").subtasks.is_empty());
}

#[test]
fn a_project_rolls_up_the_tasks_inside_and_their_subtasks() {
    use crate::value::Val;
    let mut w = ws();
    let root = w.root();
    let project = create(&mut w, &root, NodeKind::Project, "Срез");
    let a = create(&mut w, &project, NodeKind::Task, "Боёвка");
    let b = create(&mut w, &project, NodeKind::Task, "Анимации");
    let folder = create(&mut w, &project, NodeKind::Network, "Арт");
    let c = create(&mut w, &folder, NodeKind::Task, "Свет");
    create(&mut w, &project, NodeKind::Network, "Пустая папка");
    // Subtask by a wire, placed elsewhere.
    let far = create(&mut w, &root, NodeKind::Task, "Снаружи");
    w.apply(
        &[
            Op::Connect {
                from: a.clone(),
                to: b.clone(),
            },
            Op::Connect {
                from: a.clone(),
                to: far.clone(),
            },
        ],
        Label::new("t.wires"),
    )
    .expect("wires");
    set(&mut w, &c, "status", Some(Val::str("done"))).expect("done");

    let d = w.node_details(&project).expect("details");
    let fold = d.fold.clone().expect("a project has a fold");
    assert_eq!(
        (fold.done, fold.total),
        (1, 4),
        "inside at any depth, and by wires"
    );
    // The preview: tasks inside that are nobody's subtask here; folders with tasks.
    let rows: Vec<(&str, Vec<&str>)> = d
        .subtasks
        .iter()
        .map(|r| {
            (
                r.name.as_str(),
                r.rows.iter().map(|c| c.name.as_str()).collect(),
            )
        })
        .collect();
    assert_eq!(
        rows,
        vec![
            ("Боёвка", vec!["Анимации", "Снаружи"]),
            ("Арт", vec!["Свет"]),
        ]
    );
    // A folder's own roll-up counts the tasks inside too.
    let outside = w.network_view(&project).expect("view");
    let art = outside
        .nodes
        .iter()
        .find(|n| n.id == folder)
        .expect("folder");
    assert_eq!(art.fold.as_ref().map(|f| (f.done, f.total)), Some((1, 1)));
}

#[test]
fn a_project_preview_shows_what_its_roll_up_counts() {
    let mut w = ws();
    let root = w.root();
    let project = create(&mut w, &root, NodeKind::Project, "Срез");
    // A cycle of wires with no root inside the project.
    let a = create(&mut w, &project, NodeKind::Task, "Сценарий");
    let b = create(&mut w, &project, NodeKind::Task, "Раскадровка");
    // A folder with a task, wired from a task: a material, still a row.
    let lead = create(&mut w, &project, NodeKind::Task, "Арт-дирекция");
    let folder = create(&mut w, &project, NodeKind::Network, "Арт");
    create(&mut w, &folder, NodeKind::Task, "Свет");
    let wire = |from: &str, to: &str| Op::Connect {
        from: from.to_owned(),
        to: to.to_owned(),
    };
    w.apply(
        &[wire(&a, &b), wire(&b, &a), wire(&lead, &folder)],
        Label::new("t.wires"),
    )
    .expect("wires");

    let d = w.node_details(&project).expect("details");
    let fold = d.fold.clone().expect("a project has a fold");
    assert_eq!(fold.total, 4, "the roll-up counts every task");
    let rows: Vec<(&str, Vec<&str>)> = d
        .subtasks
        .iter()
        .map(|r| {
            (
                r.name.as_str(),
                r.rows.iter().map(|c| c.name.as_str()).collect(),
            )
        })
        .collect();
    assert_eq!(
        rows,
        vec![
            ("Арт-дирекция", vec![]),
            ("Арт", vec!["Свет"]),
            ("Сценарий", vec!["Раскадровка"]),
        ],
        "a folder a task wires to stays; a cycle shows from its first task"
    );
    fn tasks(rows: &[crate::workspace::TaskRow]) -> u32 {
        rows.iter()
            .map(|r| u32::from(r.kind.is_task()) + tasks(&r.rows))
            .sum()
    }
    assert_eq!(tasks(&d.subtasks), fold.total, "each counted task once");
}

#[test]
fn dependencies_are_the_wires_in_and_out() {
    let mut w = ws();
    let root = w.root();
    let a = create(&mut w, &root, NodeKind::Note, "Прототип");
    let b = create(&mut w, &root, NodeKind::Note, "Боёвка");
    let c = create(&mut w, &root, NodeKind::Note, "Плейтест");
    w.apply(
        &[
            Op::Connect {
                from: a.clone(),
                to: b.clone(),
            },
            Op::Connect {
                from: b.clone(),
                to: c.clone(),
            },
        ],
        Label::new("t"),
    )
    .expect("wires");
    let d = w.node_details(&b).expect("details");
    assert_eq!(
        d.inputs.iter().map(|l| l.name.as_str()).collect::<Vec<_>>(),
        vec!["Прототип"]
    );
    assert_eq!(
        d.outputs
            .iter()
            .map(|l| l.name.as_str())
            .collect::<Vec<_>>(),
        vec!["Плейтест"]
    );
}

#[test]
fn a_picture_is_an_asset_by_its_hash_and_travels_in_the_archive() {
    use crate::value::Val;
    let mut w = ws();
    let root = w.root();
    let media = create(&mut w, &root, NodeKind::Asset, "Скетч");
    let png = b"\x89PNG not really".to_vec();
    let sha = w.put_asset(&png).expect("asset");
    assert_eq!(sha.len(), 64);
    assert_eq!(
        w.put_asset(&png).expect("again"),
        sha,
        "the same bytes, the same id"
    );
    set(&mut w, &media, "asset", Some(Val::str(sha.clone()))).expect("picture");
    assert!(set(&mut w, &media, "asset", Some(Val::str("not-a-hash"))).is_err());
    set(&mut w, &media, "mime", Some(Val::str("image/png"))).expect("type");
    assert!(set(&mut w, &media, "mime", Some(Val::str("png"))).is_err());
    set(
        &mut w,
        &media,
        "url",
        Some(Val::str("https://example.org/a b")),
    )
    .unwrap_err();
    set(
        &mut w,
        &media,
        "url",
        Some(Val::str("https://example.org/a")),
    )
    .expect("link");
    set(&mut w, &media, "icon", Some(Val::str("filetype-video"))).expect("icon");
    assert!(set(&mut w, &media, "icon", Some(Val::str("../x"))).is_err());
    let d = w.node_details(&media).expect("details");
    assert_eq!(d.attrs.mime.as_deref(), Some("image/png"));
    assert_eq!(d.attrs.icon.as_deref(), Some("filetype-video"));
    assert_eq!(w.asset(&sha).expect("read"), Some(png.clone()));

    let zip = crate::archive::export(&w).expect("export");
    let unpacked = crate::archive::unpack(&zip).expect("unpack");
    let again = crate::archive::import(&unpacked, MemoryStore::default(), false).expect("import");
    assert_eq!(again.asset(&sha).expect("read"), Some(png));
    // And through the browser's bytes.
    let back =
        Workspace::open(MemoryStore::from_bytes(&again.into_store().to_bytes()).expect("bytes"))
            .expect("open");
    assert!(back.asset(&sha).expect("read").is_some());
}

#[test]
fn the_star_map_reads_every_live_wire() {
    let mut w = ws();
    let root = w.root();
    let folder = create(&mut w, &root, NodeKind::Network, "Арт");
    let a = create(&mut w, &root, NodeKind::Note, "Идея");
    let b = create(&mut w, &folder, NodeKind::Note, "Эскиз");
    let c = create(&mut w, &folder, NodeKind::Note, "Черновик");
    let wire = |from: &str, to: &str| Op::Connect {
        from: from.to_owned(),
        to: to.to_owned(),
    };
    w.apply(&[wire(&a, &b), wire(&b, &c)], Label::new("t.wires"))
        .expect("wires");
    let ends = |w: &Workspace<MemoryStore>| -> Vec<(String, String)> {
        w.wires().into_iter().map(|e| (e.from, e.to)).collect()
    };
    let mut all = vec![(a.clone(), b.clone()), (b.clone(), c.clone())];
    all.sort();
    assert_eq!(ends(&w), all, "across networks, from every network");
    w.apply(
        &[Op::Trash {
            ids: vec![c.clone()],
        }],
        Label::new("t.trash"),
    )
    .expect("trash");
    assert_eq!(
        ends(&w),
        vec![(a.clone(), b.clone())],
        "a wire of a node in the trash stays hidden"
    );
}

#[test]
fn a_kind_changes_between_task_project_and_folder_only() {
    use crate::value::Val;
    let mut w = ws();
    let root = w.root();
    let task = create(&mut w, &root, NodeKind::Task, "Боёвка");
    let note = create(&mut w, &root, NodeKind::Note, "Заметка");
    let set_kind = |id: &str, kind: NodeKind| Op::SetKind {
        id: id.to_owned(),
        kind,
    };
    // A task becomes a project: one dives into it now (05 §4.2).
    w.apply(&[set_kind(&task, NodeKind::Project)], Label::new("t.kind"))
        .expect("task → project");
    create(&mut w, &task, NodeKind::Task, "Внутри");
    assert!(w.network_view(&task).is_ok());
    // A project with something inside stays a project.
    assert!(
        w.apply(&[set_kind(&task, NodeKind::Task)], Label::new("t"))
            .is_err()
    );
    // A project becomes a folder: its task fields go in the same step.
    set(&mut w, &task, "status", Some(Val::str("doing"))).expect("status");
    w.apply(&[set_kind(&task, NodeKind::Network)], Label::new("t.kind"))
        .expect("project → folder");
    let d = w.node_details(&task).expect("details");
    assert_eq!(d.kind, NodeKind::Network);
    assert_eq!(d.attrs.status, None);
    // Undo brings the project and its status back.
    w.undo().expect("undo");
    let d = w.node_details(&task).expect("details");
    assert_eq!(d.kind, NodeKind::Project);
    assert_eq!(d.attrs.status.as_deref(), Some("doing"));
    // Other kinds and the root keep theirs.
    assert!(
        w.apply(&[set_kind(&note, NodeKind::Task)], Label::new("t"))
            .is_err()
    );
    assert!(
        w.apply(&[set_kind(&root, NodeKind::Project)], Label::new("t"))
            .is_err()
    );
}

#[test]
fn a_network_keeps_its_wire_style_one_step_of_undo() {
    use crate::WireStyle;
    let mut w = ws();
    let root = w.root();
    assert_eq!(
        w.network_view(&root).expect("view").wire_style,
        None,
        "a network draws Bézier wires until it is told otherwise (06 §6.2)"
    );
    let folder = create(&mut w, &root, NodeKind::Network, "Папка");
    let style = |w: &mut Workspace<MemoryStore>, net: &str, s: Option<WireStyle>| {
        w.apply(
            &[Op::SetWireStyle {
                net: net.to_owned(),
                style: s,
            }],
            Label::new("t.style"),
        )
    };
    style(&mut w, &root, Some(WireStyle::Straight)).expect("straight");
    assert_eq!(
        w.network_view(&root).expect("view").wire_style,
        Some(WireStyle::Straight)
    );
    assert_eq!(
        w.network_view(&folder).expect("view").wire_style,
        None,
        "the style is the network's own (05 §9.2): the folder inside keeps its"
    );
    style(&mut w, &root, Some(WireStyle::Kinetic)).expect("kinetic");
    w.undo().expect("undo");
    assert_eq!(
        w.network_view(&root).expect("view").wire_style,
        Some(WireStyle::Straight),
        "a change of style is one step of undo"
    );
    style(&mut w, &root, None).expect("clear");
    assert_eq!(w.network_view(&root).expect("view").wire_style, None);
    let note = create(&mut w, &root, NodeKind::Note, "Заметка");
    assert!(
        style(&mut w, &note, Some(WireStyle::Bezier)).is_err(),
        "only a folder or a project has a network to style"
    );
    style(&mut w, &folder, Some(WireStyle::Kinetic)).expect("kinetic");
    let mut again = Workspace::open(w.into_store()).expect("open");
    assert_eq!(
        again.network_view(&folder).expect("view").wire_style,
        Some(WireStyle::Kinetic),
        "the style is written with its network's document"
    );
}

#[test]
fn a_link_preview_is_the_systems_step_and_names_only_an_unnamed_link() {
    use crate::value::Val;
    let mut w = ws();
    let root = w.root();
    let url = "https://www.example.org/mill?x=1";
    let link = create(&mut w, &root, NodeKind::Asset, "www.example.org");
    set(&mut w, &link, "url", Some(Val::str(url))).expect("link");
    let steps = w.history();
    assert_eq!(w.link_of(&link).expect("link of"), Some(url.to_owned()));
    let picture = b"\x89PNG preview".to_vec();
    assert!(
        w.apply_preview(&link, url, Some("  Старая   мельница\n"), Some(&picture))
            .expect("preview")
    );
    let d = w.node_details(&link).expect("details");
    assert_eq!(
        d.name, "Старая мельница",
        "a link named by its host takes the page's title"
    );
    let sha = d.attrs.preview.expect("a preview");
    assert_eq!(w.asset(&sha).expect("asset"), Some(picture.clone()));
    assert_eq!(
        w.history(),
        steps,
        "the preview is derived: no step of the user's undo (05 §11)"
    );
    assert!(
        !w.apply_preview(&link, url, Some("Старая мельница"), Some(&picture))
            .expect("again"),
        "the same preview again changes nothing"
    );

    // A name the user gave stays.
    w.apply(
        &[Op::Rename {
            id: link.clone(),
            name: "Референс".to_owned(),
        }],
        Label::new("t.rename"),
    )
    .expect("rename");
    w.apply_preview(&link, url, Some("Другой заголовок"), None)
        .expect("title only");
    assert_eq!(w.node_details(&link).expect("details").name, "Референс");

    // A preview late for a link changed meanwhile is dropped; a new link drops the old preview.
    let other = "https://example.com/";
    set(&mut w, &link, "url", Some(Val::str(other))).expect("another link");
    assert_eq!(w.node_details(&link).expect("details").attrs.preview, None);
    assert!(
        !w.apply_preview(&link, url, Some("Поздно"), Some(&picture))
            .expect("late")
    );
    w.undo().expect("undo");
    assert_eq!(
        w.node_details(&link).expect("details").attrs.preview,
        Some(sha),
        "undo of the new link brings its preview back"
    );

    // Only a link asset has a preview.
    let note = create(&mut w, &root, NodeKind::Note, "Заметка");
    assert!(!w.apply_preview(&note, url, Some("x"), None).expect("note"));
    assert!(set(&mut w, &note, "preview", Some(Val::str("0".repeat(64)))).is_err());
    let bare = create(&mut w, &root, NodeKind::Asset, "");
    set(&mut w, &bare, "url", Some(Val::str("http://[::1]:8080/a"))).expect("v6");
    w.apply_preview(&bare, "http://[::1]:8080/a", Some("Локально"), None)
        .expect("v6 preview");
    assert_eq!(w.node_details(&bare).expect("details").name, "Локально");
}

fn place(w: &mut Workspace<MemoryStore>, id: &str, net: &str) -> crate::workspace::Result<()> {
    w.apply(
        &[Op::Place {
            id: id.to_owned(),
            net: net.to_owned(),
            x: 300.0,
            y: 40.0,
        }],
        Label::new("t.place"),
    )
    .map(|_| ())
}

fn unplace(w: &mut Workspace<MemoryStore>, id: &str, net: &str) {
    w.apply(
        &[Op::Unplace {
            id: id.to_owned(),
            net: net.to_owned(),
        }],
        Label::new("t.unplace"),
    )
    .expect("unplace");
}

fn places(w: &Workspace<MemoryStore>, id: &str) -> Vec<(String, bool)> {
    w.node_details(id)
        .expect("details")
        .places
        .into_iter()
        .map(|p| (p.name, p.primary))
        .collect()
}

#[test]
fn a_node_appears_in_another_network_with_its_own_place() {
    let mut w = ws();
    let root = w.root();
    let game = create(&mut w, &root, NodeKind::Network, "Игра");
    let film = create(&mut w, &root, NodeKind::Project, "Фильм");
    let refs = create(&mut w, &game, NodeKind::Note, "Референсы");
    place(&mut w, &refs, &film).expect("place");
    let here = |w: &mut Workspace<MemoryStore>, net: &str| {
        w.network_view(net)
            .expect("view")
            .nodes
            .into_iter()
            .find(|n| n.id == refs)
            .expect("placed there")
    };
    let (a, b) = (here(&mut w, &game), here(&mut w, &film));
    // One node, a position in each network (05 §5): the layout is the network's.
    assert_eq!(
        (a.x, a.y, a.places, a.appearance),
        (10.0, 20.0, Some(2), false)
    );
    assert_eq!(
        (b.x, b.y, b.places, b.appearance),
        (300.0, 40.0, Some(2), true)
    );
    assert_eq!(
        places(&w, &refs),
        vec![("Игра".to_owned(), true), ("Фильм".to_owned(), false)]
    );
    // Each row knows its network's kind, for its icon: a folder, a project.
    let kinds: Vec<NodeKind> = w
        .node_details(&refs)
        .expect("details")
        .places
        .into_iter()
        .map(|p| p.kind)
        .collect();
    assert_eq!(kinds, vec![NodeKind::Network, NodeKind::Project]);
    // The same node: renamed once, renamed everywhere.
    w.apply(
        &[Op::Rename {
            id: refs.clone(),
            name: "Мудборд".to_owned(),
        }],
        Label::new("t.rename"),
    )
    .expect("rename");
    assert_eq!(names(&mut w, &film), vec!["Мудборд"]);
    w.undo().expect("undo rename");
    w.undo().expect("undo place");
    assert!(
        names(&mut w, &film).is_empty(),
        "one step of undo takes it back"
    );
    assert_eq!(here(&mut w, &game).places, None);
}

#[test]
fn a_node_is_placed_in_a_network_once_and_never_inside_itself() {
    let mut w = ws();
    let root = w.root();
    let game = create(&mut w, &root, NodeKind::Network, "Игра");
    let level = create(&mut w, &game, NodeKind::Project, "Уровень");
    let note = create(&mut w, &game, NodeKind::Note, "Заметка");
    // Invariant 3: once per network.
    assert!(place(&mut w, &note, &game).is_err());
    // Invariant 4: not inside itself, not inside its own.
    assert!(place(&mut w, &game, &game).is_err());
    assert!(place(&mut w, &game, &level).is_err());
    // Not in a note; the root nowhere; nothing from the trash.
    assert!(place(&mut w, &level, &note).is_err());
    assert!(place(&mut w, &root, &level).is_err());
    w.apply(
        &[Op::Trash {
            ids: vec![note.clone()],
        }],
        Label::new("t.trash"),
    )
    .expect("trash");
    assert!(place(&mut w, &note, &level).is_err());
    // A sibling network may hold it.
    place(&mut w, &level, &root).expect("a project in the root as well");
}

#[test]
fn unplacing_keeps_the_node_elsewhere_and_the_last_one_trashes_it() {
    let mut w = ws();
    let root = w.root();
    let a = create(&mut w, &root, NodeKind::Network, "А");
    let b = create(&mut w, &root, NodeKind::Network, "Б");
    let c = create(&mut w, &root, NodeKind::Network, "В");
    w.set_clock(|| 1_760_000_000_100);
    let n = create(&mut w, &a, NodeKind::Note, "Нода");
    w.set_clock(|| 1_760_000_000_200);
    place(&mut w, &n, &c).expect("place in В");
    w.set_clock(|| 1_760_000_000_300);
    place(&mut w, &n, &b).expect("place in Б");
    // The primary placement gone, the oldest of the others is the home (05 §5).
    unplace(&mut w, &n, &a);
    assert!(names(&mut w, &a).is_empty());
    assert_eq!(
        places(&w, &n),
        vec![("В".to_owned(), true), ("Б".to_owned(), false)]
    );
    unplace(&mut w, &n, &b);
    assert_eq!(places(&w, &n), vec![("В".to_owned(), true)]);
    // The last placement: into the trash, from where it comes back whole.
    unplace(&mut w, &n, &c);
    assert!(names(&mut w, &c).is_empty());
    assert_eq!(w.trash().len(), 1);
    w.undo().expect("undo");
    assert_eq!(names(&mut w, &c), vec!["Нода"]);
    assert!(w.trash().is_empty());
    // Only where it is placed.
    assert!(
        w.apply(
            &[Op::Unplace {
                id: n.clone(),
                net: a.clone(),
            }],
            Label::new("t"),
        )
        .is_err()
    );
}

#[test]
fn the_primary_placement_moves_by_hand() {
    let mut w = ws();
    let root = w.root();
    let a = create(&mut w, &root, NodeKind::Network, "А");
    let b = create(&mut w, &root, NodeKind::Network, "Б");
    let n = create(&mut w, &a, NodeKind::Task, "Задача");
    place(&mut w, &n, &b).expect("place");
    let primary = |w: &mut Workspace<MemoryStore>, net: &str| {
        w.apply(
            &[Op::SetPrimary {
                id: n.clone(),
                net: net.to_owned(),
            }],
            Label::new("t.primary"),
        )
    };
    primary(&mut w, &b).expect("make Б the home");
    assert_eq!(w.node_details(&n).expect("details").parent, Some(b.clone()));
    let appears = |w: &mut Workspace<MemoryStore>, net: &str| {
        w.network_view(net).expect("view").nodes[0].appearance
    };
    assert!(appears(&mut w, &a) && !appears(&mut w, &b));
    // Only where it is placed; one step of undo.
    assert!(primary(&mut w, &root).is_err());
    w.undo().expect("undo");
    assert_eq!(w.node_details(&n).expect("details").parent, Some(a.clone()));
}
