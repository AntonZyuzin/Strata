//! Dots on wires (05 §9.2, 06 §6.6): a wire's route through the network's
//! dots, one source per dot, an unpinned dot no wire goes through goes.

use super::{Editor, create, op, place, ws};
use crate::{Label, MemoryStore, Op, ViewDot, Workspace};
use strata_model::{DotId, NodeKind};

fn connect(w: &mut Workspace<MemoryStore>, from: &str, to: &str) {
    op(
        w,
        Op::Connect {
            from: from.to_owned(),
            to: to.to_owned(),
        },
    )
    .expect("connect");
}

fn put_dot(net: &str, id: &str, x: f64, y: f64, pinned: bool) -> Op {
    Op::PutDot {
        net: net.to_owned(),
        id: id.to_owned(),
        x,
        y,
        pinned,
    }
}

fn route(net: &str, from: &str, to: &str, dots: &[&str]) -> Op {
    Op::SetRoute {
        net: net.to_owned(),
        from: from.to_owned(),
        to: to.to_owned(),
        dots: dots.iter().map(|d| (*d).to_owned()).collect(),
    }
}

/// The routes of the network's wires, `(from, to, dots)`, and its dots.
type Seen = (Vec<(String, String, Vec<String>)>, Vec<ViewDot>);

fn seen(w: &mut Workspace<MemoryStore>, net: &str) -> Seen {
    let v = w.network_view(net).expect("view");
    let routes = v
        .edges
        .into_iter()
        .map(|e| (e.from, e.to, e.dots))
        .collect();
    (routes, v.dots)
}

/// A, B, C in the root, A → B; the root's id with them.
fn three(w: &mut Workspace<MemoryStore>) -> (String, String, String, String) {
    let root = w.root();
    let a = create(w, &root, NodeKind::Note, "A");
    let b = create(w, &root, NodeKind::Note, "B");
    let c = create(w, &root, NodeKind::Note, "C");
    connect(w, &a, &b);
    (root, a, b, c)
}

/// The branch of 06 §6.5 «б»: a dot on A → B and a new wire A → C through it.
fn branch(root: &str, a: &str, b: &str, c: &str, dot: &str) -> Vec<Op> {
    vec![
        put_dot(root, dot, 50.0, 60.0, false),
        route(root, a, b, &[dot]),
        Op::Connect {
            from: a.to_owned(),
            to: c.to_owned(),
        },
        route(root, a, c, &[dot]),
    ]
}

#[test]
fn a_branch_through_a_dot_is_one_step_of_undo() {
    let mut w = ws();
    let (root, a, b, c) = three(&mut w);
    let d = DotId::new().to_text();
    w.apply(&branch(&root, &a, &b, &c, &d), Label::new("t"))
        .expect("branch");
    let (routes, dots) = seen(&mut w, &root);
    let mut want = vec![
        (a.clone(), b.clone(), vec![d.clone()]),
        (a.clone(), c.clone(), vec![d.clone()]),
    ];
    want.sort();
    let mut routes = routes;
    routes.sort();
    assert_eq!(routes, want);
    assert_eq!(
        dots,
        vec![ViewDot {
            id: d.clone(),
            x: 50.0,
            y: 60.0,
            pinned: false
        }]
    );
    // One step: undo takes the dot, the route and the new wire away.
    w.undo().expect("undo");
    let (routes, dots) = seen(&mut w, &root);
    assert_eq!(routes, vec![(a.clone(), b.clone(), vec![])]);
    assert!(dots.is_empty());
    w.redo().expect("redo");
    assert_eq!(seen(&mut w, &root).1.len(), 1);
}

#[test]
fn a_dot_has_one_source() {
    // 06 §6.6: every wire through a dot comes from one source.
    let mut w = ws();
    let (root, a, b, c) = three(&mut w);
    let d = DotId::new().to_text();
    w.apply(&branch(&root, &a, &b, &c, &d), Label::new("t"))
        .expect("branch");
    connect(&mut w, &b, &c);
    let before = seen(&mut w, &root);
    let err = op(&mut w, route(&root, &b, &c, &[&d])).expect_err("two sources");
    assert!(err.to_string().contains("one source"), "{err}");
    assert_eq!(seen(&mut w, &root), before, "a refused step writes nothing");
}

#[test]
fn an_unpinned_dot_no_wire_goes_through_goes() {
    let mut w = ws();
    let (root, a, b, c) = three(&mut w);
    let d = DotId::new().to_text();
    w.apply(&branch(&root, &a, &b, &c, &d), Label::new("t"))
        .expect("branch");
    // One wire through it left: the dot stays.
    op(
        &mut w,
        Op::Disconnect {
            from: a.clone(),
            to: b.clone(),
        },
    )
    .expect("cut A → B");
    assert_eq!(seen(&mut w, &root).1.len(), 1);
    // The last: the dot goes with it, in the same step.
    op(
        &mut w,
        Op::Disconnect {
            from: a.clone(),
            to: c.clone(),
        },
    )
    .expect("cut A → C");
    let (routes, dots) = seen(&mut w, &root);
    assert!(routes.is_empty() && dots.is_empty());
    // Undo brings the wire back through its dot.
    w.undo().expect("undo");
    let (routes, dots) = seen(&mut w, &root);
    assert_eq!(routes, vec![(a.clone(), c.clone(), vec![d.clone()])]);
    assert_eq!(dots.len(), 1);
    // A route set to none leaves the dot with no wire: it goes too.
    op(&mut w, route(&root, &a, &c, &[])).expect("straight");
    assert!(seen(&mut w, &root).1.is_empty());
    // A dot made and named by no route goes at the end of its own step.
    let lone = DotId::new().to_text();
    op(&mut w, put_dot(&root, &lone, 1.0, 2.0, false)).expect("a lone dot");
    assert!(seen(&mut w, &root).1.is_empty());
}

#[test]
fn a_pinned_dot_stays_with_no_wire() {
    let mut w = ws();
    let (root, a, b, _) = three(&mut w);
    let d = DotId::new().to_text();
    w.apply(
        &[
            put_dot(&root, &d, 5.0, 5.0, true),
            route(&root, &a, &b, &[&d]),
        ],
        Label::new("t"),
    )
    .expect("a pinned dot on A → B");
    op(
        &mut w,
        Op::Disconnect {
            from: a.clone(),
            to: b.clone(),
        },
    )
    .expect("cut");
    let (routes, dots) = seen(&mut w, &root);
    assert!(routes.is_empty());
    assert_eq!(
        dots,
        vec![ViewDot {
            id: d.clone(),
            x: 5.0,
            y: 5.0,
            pinned: true
        }]
    );
    // Unpinned with no wire through it, it goes; moved, it is where it was put.
    op(&mut w, put_dot(&root, &d, 7.0, 8.0, false)).expect("unpin");
    assert!(seen(&mut w, &root).1.is_empty());
}

#[test]
fn removing_a_dot_straightens_its_wires_and_keeps_the_links() {
    let mut w = ws();
    let (root, a, b, c) = three(&mut w);
    let (d, e) = (DotId::new().to_text(), DotId::new().to_text());
    let mut ops = branch(&root, &a, &b, &c, &d);
    ops.push(put_dot(&root, &e, 70.0, 80.0, false));
    ops.push(route(&root, &a, &b, &[&d, &e]));
    w.apply(&ops, Label::new("t")).expect("two dots on A → B");
    op(
        &mut w,
        Op::RemoveDot {
            net: root.clone(),
            id: d.clone(),
        },
    )
    .expect("remove");
    let (mut routes, dots) = seen(&mut w, &root);
    routes.sort();
    let mut want = vec![
        (a.clone(), b.clone(), vec![e.clone()]),
        (a.clone(), c.clone(), vec![]),
    ];
    want.sort();
    assert_eq!(routes, want, "the links stay; A → C goes straight");
    assert_eq!(dots.iter().map(|d| d.id.as_str()).collect::<Vec<_>>(), [e]);
    assert!(
        op(
            &mut w,
            Op::RemoveDot {
                net: root.clone(),
                id: d,
            },
        )
        .is_err(),
        "a dot that is not"
    );
}

#[test]
fn a_node_that_leaves_a_network_takes_its_routes_there() {
    let mut w = ws();
    let root = w.root();
    let folder = create(&mut w, &root, NodeKind::Network, "Папка");
    let a = create(&mut w, &folder, NodeKind::Note, "A");
    let b = create(&mut w, &folder, NodeKind::Note, "B");
    connect(&mut w, &a, &b);
    // Both appear in the root too: the wire is seen in both networks.
    place(&mut w, &a, &root).expect("A here");
    place(&mut w, &b, &root).expect("B here");
    let (d, e) = (DotId::new().to_text(), DotId::new().to_text());
    w.apply(
        &[
            put_dot(&folder, &d, 1.0, 1.0, false),
            route(&folder, &a, &b, &[&d]),
            put_dot(&root, &e, 2.0, 2.0, false),
            route(&root, &a, &b, &[&e]),
        ],
        Label::new("t"),
    )
    .expect("a dot in each");
    op(
        &mut w,
        Op::Unplace {
            id: b.clone(),
            net: root.clone(),
        },
    )
    .expect("B out of the root");
    let (routes, dots) = seen(&mut w, &root);
    assert!(
        routes.is_empty() && dots.is_empty(),
        "the root's route went"
    );
    let (routes, dots) = seen(&mut w, &folder);
    assert_eq!(routes, vec![(a.clone(), b.clone(), vec![d.clone()])]);
    assert_eq!(dots.len(), 1, "the folder keeps its own");
    w.undo().expect("undo");
    assert_eq!(seen(&mut w, &root).0, vec![(a, b, vec![e])]);
}

#[test]
fn a_route_needs_a_wire_seen_here_and_dots_that_are() {
    let mut w = ws();
    let (root, a, b, c) = three(&mut w);
    let folder = create(&mut w, &root, NodeKind::Network, "Папка");
    let d = DotId::new().to_text();
    op(&mut w, put_dot(&root, &d, 1.0, 1.0, true)).expect("a pinned dot");
    // No wire A → C.
    assert!(op(&mut w, route(&root, &a, &c, &[&d])).is_err());
    // A → B is not seen in the folder: neither end lies there.
    assert!(op(&mut w, route(&folder, &a, &b, &[&d])).is_err());
    // A dot that is not, a dot twice.
    let none = DotId::new().to_text();
    assert!(op(&mut w, route(&root, &a, &b, &[&none])).is_err());
    assert!(op(&mut w, route(&root, &a, &b, &[&d, &d])).is_err());
    // A dot's id is a dot's, its place a number, its network a canvas.
    assert!(op(&mut w, put_dot(&root, "no-id", 1.0, 1.0, false)).is_err());
    assert!(op(&mut w, put_dot(&root, &none, f64::NAN, 1.0, false)).is_err());
    assert!(op(&mut w, put_dot(&a, &none, 1.0, 1.0, false)).is_err());
    // The same through the dot that is: fine.
    op(&mut w, route(&root, &a, &b, &[&d])).expect("route");
}

#[test]
fn a_text_wire_that_goes_takes_its_route() {
    // 05 §8.2 rule 4: a link's wire lives while the text names it; its
    // route goes with it, and the dot no wire goes through.
    let mut w = ws();
    let root = w.root();
    let note = create(&mut w, &root, NodeKind::Note, "Заметка");
    let target = create(&mut w, &root, NodeKind::Note, "Цель");
    let mut ed = Editor::open(&mut w, &note);
    assert!(ed.type_text(&mut w, &note, "См. [[Цель]]"));
    let d = DotId::new().to_text();
    w.apply(
        &[
            put_dot(&root, &d, 3.0, 4.0, false),
            route(&root, &note, &target, &[&d]),
        ],
        Label::new("t"),
    )
    .expect("a dot on the link's wire");
    assert_eq!(seen(&mut w, &root).1.len(), 1);
    assert!(ed.type_text(&mut w, &note, "Без ссылок"));
    let (routes, dots) = seen(&mut w, &root);
    assert!(routes.is_empty() && dots.is_empty());
    // The link again: a straight wire, not the old route.
    assert!(ed.type_text(&mut w, &note, "См. [[Цель]] снова"));
    assert_eq!(seen(&mut w, &root).0, vec![(note, target, vec![])]);
}
