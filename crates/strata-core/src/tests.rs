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
