//! NFR-77: what breaks rules 3, 5 and 6 of 05 §14 — made at the key level,
//! as a bug of an import or a migration could leave it — reconciled as the
//! table of 10 §8.5 says: one changeset of the system, or inside the import
//! that brought it.

use super::{create, ws};
use crate::value::Val;
use crate::vault::{Vault, VaultFile};
use crate::{ImportOptions, Label, MemoryStore, Op, Workspace};
use strata_model::{ChangesetOrigin, EdgeKey, NodeId, NodeKind};

type W = Workspace<MemoryStore>;

/// The tests' clock (`super::ws`).
const T: i64 = 1_760_000_000_000;

fn apply(w: &mut W, op: Op) {
    w.apply(&[op], Label::new("t.op")).expect("the step");
}

/// Node `id` placed in `net`, made at `at`, the rules aside.
fn place_raw(w: &mut W, net: &str, id: &str, at: i64) {
    let value = Val::map([("at", Val::Int(at))]);
    w.set_raw(id, "placement", &format!("{net}/{id}"), Some(value))
        .expect("a raw placement");
}

fn unplace_raw(w: &mut W, net: &str, id: &str) {
    w.set_raw(id, "placement", &format!("{net}/{id}"), None)
        .expect("a raw unplacement");
}

/// The fixes of a reconcile: what, whose, in which network.
fn fixes(w: &mut W) -> Vec<(&'static str, String, Option<String>)> {
    w.reconcile()
        .expect("the reconcile")
        .into_iter()
        .map(|f| (f.fix, f.node, f.net))
        .collect()
}

fn parent(w: &W, id: &str) -> Option<String> {
    w.tree()
        .into_iter()
        .find(|i| i.id == id)
        .and_then(|i| i.parent)
}

fn batch(w: &W, id: &str) -> Option<String> {
    w.raw(id, "trashBatch", id)
        .and_then(|v| v.as_str().map(str::to_owned))
}

fn trashed(w: &W, id: &str) -> bool {
    w.raw(id, "trashedAt", id).is_some()
}

fn edge(a: &str, b: &str) -> String {
    let id = |s: &str| NodeId::parse(s).expect("an id");
    EdgeKey::between(id(a), id(b)).to_text()
}

#[test]
fn a_whole_workspace_is_left_as_it_is() {
    let mut w = ws();
    let root = w.root();
    let net = create(&mut w, &root, NodeKind::Network, "Папка");
    let note = create(&mut w, &net, NodeKind::Note, "Заметка");
    apply(
        &mut w,
        Op::Connect {
            from: note,
            to: net,
        },
    );
    let before = w.journal(None, 100).expect("journal").entries.len();
    assert!(w.reconcile().expect("the reconcile").is_empty());
    assert_eq!(w.journal(None, 100).expect("journal").entries.len(), before);
    assert!(w.history().undo.is_some(), "undo stays");
}

#[test]
fn the_newest_placement_on_a_cycle_goes() {
    // 05 §14 rule 5, 10 §8.5: «X положили в Y, а Y — в X» — the one placed
    // last goes, whichever of the two it is.
    for a_in_b_later in [true, false] {
        let mut w = ws();
        let root = w.root();
        let a = create(&mut w, &root, NodeKind::Network, "А");
        let b = create(&mut w, &root, NodeKind::Project, "Б");
        apply(
            &mut w,
            Op::Place {
                id: b.clone(),
                net: a.clone(),
                x: 0.0,
                y: 0.0,
            },
        );
        place_raw(&mut w, &b, &a, if a_in_b_later { T + 1 } else { T - 1 });
        assert!(
            w.broken_rules().iter().any(|l| l.contains("inside itself")),
            "{:?}",
            w.broken_rules()
        );
        let (child, net) = if a_in_b_later { (&a, &b) } else { (&b, &a) };
        assert_eq!(
            fixes(&mut w),
            vec![("cycle", child.clone(), Some(net.clone()))]
        );
        assert!(w.broken_rules().is_empty(), "{:?}", w.broken_rules());
        assert!(
            w.raw(child, "placement", &format!("{net}/{child}"))
                .is_none()
        );
        // The other placement and the primaries stay.
        assert!(w.raw(net, "placement", &format!("{child}/{net}")).is_some());
        assert_eq!(parent(&w, &a).as_deref(), Some(root.as_str()));
        assert_eq!(parent(&w, &b).as_deref(), Some(root.as_str()));
    }
}

#[test]
fn a_network_placed_in_itself_comes_out() {
    let mut w = ws();
    let root = w.root();
    let a = create(&mut w, &root, NodeKind::Network, "Сама в себе");
    place_raw(&mut w, &a, &a, T + 1);
    assert_eq!(fixes(&mut w), vec![("cycle", a.clone(), Some(a.clone()))]);
    assert!(w.broken_rules().is_empty(), "{:?}", w.broken_rules());
    assert_eq!(parent(&w, &a).as_deref(), Some(root.as_str()));
}

#[test]
fn a_placement_in_a_node_with_no_canvas_goes_and_the_primary_falls_to_the_oldest() {
    // 05 §14 rule 3: a node lies in networks only — a task has no canvas
    // (ADR-0010).
    let mut w = ws();
    let root = w.root();
    let task = create(&mut w, &root, NodeKind::Task, "Задача");
    let note = create(&mut w, &root, NodeKind::Note, "Заметка");
    place_raw(&mut w, &task, &note, T + 1);
    w.set_raw(&note, "primaryNet", &note, Some(Val::str(task.clone())))
        .expect("a raw primary");
    assert!(
        w.broken_rules().iter().any(|l| l.contains("has no canvas")),
        "{:?}",
        w.broken_rules()
    );
    assert_eq!(
        fixes(&mut w),
        vec![("canvas", note.clone(), Some(task.clone()))]
    );
    assert!(w.broken_rules().is_empty(), "{:?}", w.broken_rules());
    assert_eq!(
        w.raw(&note, "primaryNet", &note),
        Some(Val::str(root.clone()))
    );
    // A node lying only there goes to the trash too, and comes back to
    // the root (05 §11).
    let lone = create(&mut w, &root, NodeKind::Note, "Одна");
    unplace_raw(&mut w, &root, &lone);
    place_raw(&mut w, &task, &lone, T + 1);
    assert_eq!(
        fixes(&mut w),
        vec![
            ("canvas", lone.clone(), Some(task.clone())),
            ("trash", lone.clone(), None),
        ]
    );
    assert!(w.broken_rules().is_empty(), "{:?}", w.broken_rules());
    apply(
        &mut w,
        Op::Restore {
            ids: vec![lone.clone()],
        },
    );
    assert_eq!(parent(&w, &lone).as_deref(), Some(root.as_str()));
}

#[test]
fn a_node_lying_nowhere_goes_to_the_trash_and_comes_back_to_the_root() {
    // 05 §14 rule 3, 10 §8.5: «двое параллельно убрали два последних
    // размещения» — the node goes as the removal of its last one sends it.
    let mut w = ws();
    let root = w.root();
    let note = create(&mut w, &root, NodeKind::Note, "Потерянная");
    unplace_raw(&mut w, &root, &note);
    assert!(
        w.broken_rules().iter().any(|l| l.contains("lies nowhere")),
        "{:?}",
        w.broken_rules()
    );
    assert_eq!(fixes(&mut w), vec![("trash", note.clone(), None)]);
    assert!(w.broken_rules().is_empty(), "{:?}", w.broken_rules());
    assert!(w.trash().iter().any(|t| t.id == note));
    assert!(batch(&w, &note).is_some_and(|b| !b.is_empty()));
    apply(
        &mut w,
        Op::Restore {
            ids: vec![note.clone()],
        },
    );
    assert_eq!(parent(&w, &note).as_deref(), Some(root.as_str()));
}

#[test]
fn a_node_left_in_a_network_in_the_trash_goes_with_its_batch() {
    // 10 §8.5, «сеть в корзине»: as the cascade would have taken it — the
    // network's batch, so the network brings it back.
    let mut w = ws();
    let root = w.root();
    let net = create(&mut w, &root, NodeKind::Network, "Папка");
    let note = create(&mut w, &net, NodeKind::Note, "Внутри");
    apply(
        &mut w,
        Op::Trash {
            ids: vec![net.clone()],
        },
    );
    // The bug: the note out of the trash, its network still in it.
    w.set_raw(&note, "trashedAt", &note, None).expect("raw");
    w.set_raw(&note, "trashBatch", &note, None).expect("raw");
    assert!(!w.broken_rules().is_empty());
    assert_eq!(fixes(&mut w), vec![("trash", note.clone(), None)]);
    assert!(w.broken_rules().is_empty(), "{:?}", w.broken_rules());
    assert_eq!(batch(&w, &note), batch(&w, &net));
    apply(
        &mut w,
        Op::Restore {
            ids: vec![net.clone()],
        },
    );
    assert_eq!(parent(&w, &net).as_deref(), Some(root.as_str()));
    assert_eq!(parent(&w, &note).as_deref(), Some(net.as_str()));
}

#[test]
fn a_network_sent_to_the_trash_takes_what_lies_only_inside_it() {
    let mut w = ws();
    let root = w.root();
    let net = create(&mut w, &root, NodeKind::Network, "Сеть");
    let inner = create(&mut w, &net, NodeKind::Note, "Только тут");
    let both = create(&mut w, &net, NodeKind::Note, "И там");
    apply(
        &mut w,
        Op::Place {
            id: both.clone(),
            net: root.clone(),
            x: 0.0,
            y: 0.0,
        },
    );
    unplace_raw(&mut w, &root, &net);
    assert_eq!(
        fixes(&mut w),
        vec![("trash", net.clone(), None), ("trash", inner.clone(), None)]
    );
    assert!(w.broken_rules().is_empty(), "{:?}", w.broken_rules());
    assert_eq!(batch(&w, &inner), batch(&w, &net));
    // A node living elsewhere too stays, its placement inside kept for the
    // network's way back (05 §11).
    assert!(!trashed(&w, &both));
    assert_eq!(parent(&w, &both).as_deref(), Some(root.as_str()));
    apply(
        &mut w,
        Op::Restore {
            ids: vec![net.clone()],
        },
    );
    assert_eq!(parent(&w, &net).as_deref(), Some(root.as_str()));
    assert_eq!(parent(&w, &inner).as_deref(), Some(net.as_str()));
    assert_eq!(parent(&w, &both).as_deref(), Some(net.as_str()));
}

#[test]
fn a_wire_that_joins_no_two_nodes_goes_with_its_origins_and_a_ghosts_stays() {
    // 05 §14 rule 6: a wire joins two different nodes, or a node and a
    // ghost (05 §8.5).
    let mut w = ws();
    let root = w.root();
    let a = create(&mut w, &root, NodeKind::Note, "А");
    let b = create(&mut w, &root, NodeKind::Note, "Б");
    apply(
        &mut w,
        Op::Connect {
            from: a.clone(),
            to: b.clone(),
        },
    );
    let ab = edge(&a, &b);
    w.set_raw(&a, "edgeLabel", &ab, Some(Val::str("подпись")))
        .expect("raw");
    // A ghost's wire has no `to`.
    let ghost = Val::map([("from", Val::str(a.clone())), ("ghost", Val::str("Нет"))]);
    w.set_raw(&a, "edge", "ghost-wire", Some(ghost))
        .expect("raw");
    assert!(w.broken_rules().is_empty(), "{:?}", w.broken_rules());
    // Node Б gone without a trace of its node: no kind.
    w.set_raw(&b, "kind", &b, None).expect("raw");
    assert!(
        w.broken_rules().iter().any(|l| l.contains("no node")),
        "{:?}",
        w.broken_rules()
    );
    assert_eq!(fixes(&mut w), vec![("wire", a.clone(), None)]);
    assert!(w.broken_rules().is_empty(), "{:?}", w.broken_rules());
    assert!(w.raw(&a, "edge", &ab).is_none());
    assert!(w.raw(&a, "edgeOrigin", &format!("{ab}|manual")).is_none());
    assert!(w.raw(&a, "edgeLabel", &ab).is_none());
    assert!(w.raw(&a, "edge", "ghost-wire").is_some());
    // One node at both ends.
    let aa = edge(&a, &a);
    let looped = Val::map([("from", Val::str(a.clone())), ("to", Val::str(a.clone()))]);
    w.set_raw(&a, "edge", &aa, Some(looped)).expect("raw");
    assert!(
        w.broken_rules().iter().any(|l| l.contains("with itself")),
        "{:?}",
        w.broken_rules()
    );
    assert_eq!(fixes(&mut w), vec![("wire", a.clone(), None)]);
    assert!(w.broken_rules().is_empty(), "{:?}", w.broken_rules());
}

#[test]
fn the_root_comes_back_from_the_trash_and_lies_in_no_network() {
    // 05 §3: the root is the workspace — not in the trash, in no network.
    let mut w = ws();
    let root = w.root();
    let net = create(&mut w, &root, NodeKind::Network, "Сеть");
    w.set_raw(&root, "trashedAt", &root, Some(Val::Int(T)))
        .expect("raw");
    place_raw(&mut w, &net, &root, T + 1);
    let broken = w.broken_rules();
    assert!(broken.iter().any(|l| l == "the root is gone"), "{broken:?}");
    assert!(
        broken.iter().any(|l| l.starts_with("the root lies in")),
        "{broken:?}"
    );
    assert_eq!(
        fixes(&mut w),
        vec![
            ("root", root.clone(), None),
            ("cycle", root.clone(), Some(net.clone())),
        ]
    );
    assert!(w.broken_rules().is_empty(), "{:?}", w.broken_rules());
    assert_eq!(parent(&w, &root), None);
    assert_eq!(parent(&w, &net).as_deref(), Some(root.as_str()));
}

#[test]
fn the_fix_is_one_changeset_of_the_system_and_undo_starts_after_it() {
    let mut w = ws();
    let root = w.root();
    let a = create(&mut w, &root, NodeKind::Note, "А");
    let b = create(&mut w, &root, NodeKind::Note, "Б");
    unplace_raw(&mut w, &root, &a);
    unplace_raw(&mut w, &root, &b);
    assert!(w.history().undo.is_some());
    let fixed = fixes(&mut w);
    assert_eq!(fixed.len(), 2, "{fixed:?}");
    let journal = w.journal(None, 1).expect("journal");
    let newest = &journal.entries[0];
    assert_eq!(newest.origin, ChangesetOrigin::System);
    assert_eq!(newest.label.key, "core.change.reconcile");
    // Undoing a step before it could break again what it fixed.
    assert!(w.history().undo.is_none());
    // Two nodes, two batches: each comes back alone.
    assert_ne!(batch(&w, &a), batch(&w, &b));
    apply(
        &mut w,
        Op::Restore {
            ids: vec![a.clone()],
        },
    );
    assert!(trashed(&w, &b));
}

#[test]
fn an_import_carries_its_fixes_and_undoing_it_takes_them_back() {
    // NFR-77 «после импорта»: the import's shadow is reconciled, the fixes
    // ride in its changeset and its report names them (13 §3.6).
    let mut w = ws();
    let root = w.root();
    let lost = create(&mut w, &root, NodeKind::Note, "Потерянная");
    unplace_raw(&mut w, &root, &lost);
    let vault = Vault::from_files(
        "Мини",
        vec![VaultFile::new(
            "Заметка.md",
            "# Заметка\n".as_bytes().to_vec(),
        )],
    );
    let report = w
        .import_vault(vault, None, &ImportOptions::default())
        .expect("the import");
    let fixed: Vec<_> = report
        .items
        .iter()
        .filter(|i| i.section == "fixed")
        .map(|i| (i.code.as_str(), i.detail.as_str(), i.node.is_some()))
        .collect();
    assert_eq!(fixed, vec![("fixTrash", "Потерянная", false)]);
    assert!(w.broken_rules().is_empty(), "{:?}", w.broken_rules());
    assert!(trashed(&w, &lost));
    let journal = w.journal(None, 1).expect("journal");
    assert_eq!(journal.entries[0].origin, ChangesetOrigin::Import);
    // Ctrl+Z: the import and its fixes go together.
    w.undo().expect("undo").expect("a step");
    assert!(!trashed(&w, &lost));
    assert!(w.broken_rules().iter().any(|l| l.contains("lies nowhere")));
}

#[test]
fn a_restore_brings_back_no_placement_that_would_close_a_cycle() {
    // 05 §14 rule 5 kept by legal steps alone: Д left the trash on its own
    // and A went into Д; Б coming back would bring Д into Б, inside A.
    let mut w = ws();
    let root = w.root();
    let a = create(&mut w, &root, NodeKind::Network, "А");
    let b = create(&mut w, &a, NodeKind::Network, "Б");
    let d = create(&mut w, &b, NodeKind::Network, "Д");
    apply(
        &mut w,
        Op::Trash {
            ids: vec![d.clone()],
        },
    );
    apply(
        &mut w,
        Op::Trash {
            ids: vec![b.clone()],
        },
    );
    apply(
        &mut w,
        Op::Restore {
            ids: vec![d.clone()],
        },
    );
    assert_eq!(parent(&w, &d).as_deref(), Some(root.as_str()));
    apply(
        &mut w,
        Op::Place {
            id: a.clone(),
            net: d.clone(),
            x: 0.0,
            y: 0.0,
        },
    );
    apply(
        &mut w,
        Op::Restore {
            ids: vec![b.clone()],
        },
    );
    assert!(w.broken_rules().is_empty(), "{:?}", w.broken_rules());
    // What comes back yields to what lives: Д stays out of Б, A in Д.
    assert_eq!(parent(&w, &b).as_deref(), Some(a.as_str()));
    assert!(w.raw(&d, "placement", &format!("{b}/{d}")).is_none());
    assert!(w.raw(&a, "placement", &format!("{d}/{a}")).is_some());
}

#[test]
fn a_batch_mark_left_on_a_node_out_of_the_trash_takes_nothing() {
    // A revert key by key can leave a batch's mark on a node out of the
    // trash (10 §9.3): a batch is what lies in the trash, so the purge and
    // a restore take only that (05 §5).
    let mut w = ws();
    let root = w.root();
    let out = create(&mut w, &root, NodeKind::Note, "Вышла");
    let inside = create(&mut w, &root, NodeKind::Note, "В корзине");
    apply(
        &mut w,
        Op::Trash {
            ids: vec![out.clone(), inside.clone()],
        },
    );
    w.set_raw(&out, "trashedAt", &out, None).expect("raw");
    assert_eq!(batch(&w, &out), batch(&w, &inside));
    assert_eq!(w.purge_now(&inside).expect("purge"), vec![inside.clone()]);
    assert_eq!(parent(&w, &out).as_deref(), Some(root.as_str()));
}
