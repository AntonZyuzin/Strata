//! «История изменений» (06 §1.2, 10 §9.3–9.4): the journal's rows, the
//! revert of any changeset as a step of undo, what may not be reverted, the
//! depth of undo.

use super::{create, names, ws};
use crate::workspace::UNDO_DEPTH;
use crate::{Label, MemoryStore, Op, Workspace};
use strata_model::NodeKind;

fn rename(w: &mut Workspace<MemoryStore>, id: &str, name: &str, label: &str) {
    w.apply(
        &[Op::Rename {
            id: id.to_owned(),
            name: name.to_owned(),
        }],
        Label::new(label),
    )
    .expect("rename");
}

/// The journal's row of the changeset labelled `key`, the newest such.
fn row(w: &Workspace<MemoryStore>, key: &str) -> crate::JournalEntry {
    w.journal(None, 1000)
        .expect("journal")
        .entries
        .into_iter()
        .find(|e| e.label.key == key)
        .expect("a row")
}

#[test]
fn the_journal_lists_every_changeset_the_newest_first_and_who_took_what_back() {
    let mut w = ws();
    let root = w.root();
    let a = create(&mut w, &root, NodeKind::Note, "А");
    rename(&mut w, &a, "Б", "t.rename");
    w.undo().expect("undo").expect("a step");
    w.redo().expect("redo").expect("a step");
    let j = w.journal(None, 100).expect("journal");
    let keys: Vec<&str> = j.entries.iter().map(|e| e.label.key.as_str()).collect();
    // The redo, the undo, the rename, the node, the workspace's own.
    assert_eq!(keys[..4], ["t.rename", "t.rename", "t.rename", "t.create"]);
    assert_eq!(j.entries.len(), 5, "{keys:?}");
    let [redo, undo, renamed, ..] = &j.entries[..] else {
        panic!("rows")
    };
    // A revert says what it reverts, as the store keeps it.
    use crate::JournalKind::{Redo, Step, Undo};
    assert_eq!((redo.kind, undo.kind, renamed.kind), (Redo, Undo, Step));
    assert_eq!(redo.reverts.as_ref().map(|r| &r.id), Some(&undo.id));
    assert_eq!(undo.reverts.as_ref().map(|r| &r.id), Some(&renamed.id));
    // Undone and redone: the undo is taken back, the rename stands.
    assert_eq!(undo.reverted_by.as_ref().map(|r| &r.id), Some(&redo.id));
    assert_eq!(undo.fixed.as_deref(), Some("reverted"));
    assert_eq!(
        (renamed.reverted_by.as_ref(), renamed.fixed.as_ref()),
        (None, None)
    );
    assert!(j.entries.iter().all(|e| e.ts > 0));
    // Pages: two rows, then the rest after the second.
    let first = w.journal(None, 2).expect("page");
    assert!(first.more);
    let rest = w.journal(Some(&first.entries[1].id), 100).expect("rest");
    assert_eq!(rest.entries.len(), 3);
    assert!(!rest.more);
    assert!(w.journal(Some("nope"), 10).is_err());
}

#[test]
fn any_changeset_is_reverted_as_a_step_of_undo_and_a_key_changed_since_is_skipped() {
    // 10 §9.3: the old value goes back where the key holds the new one; the
    // revert is a new changeset of the user, one step of undo (05 §11).
    let mut w = ws();
    let root = w.root();
    let a = create(&mut w, &root, NodeKind::Note, "А");
    let b = create(&mut w, &root, NodeKind::Note, "Б");
    rename(&mut w, &a, "А2", "t.renameA");
    rename(&mut w, &b, "Б2", "t.renameB");
    let ra = row(&w, "t.renameA");
    // Two steps back, taken back alone: Б keeps its name.
    let report = w.revert_changeset(&ra.id).expect("revert");
    assert!(report.skipped.is_empty());
    assert_eq!(names(&mut w, &root), ["А", "Б2"]);
    let step = w.history().undo.expect("a step of undo");
    assert_eq!(step.key, "core.change.revert");
    assert_eq!(step.params["of"]["key"], "t.renameA");
    let revert = row(&w, "core.change.revert");
    assert_eq!(revert.kind, crate::JournalKind::Revert);
    assert_eq!(revert.reverts.as_ref().map(|r| &r.id), Some(&ra.id));
    assert_eq!(revert.origin, strata_model::ChangesetOrigin::User);
    // Taken back: the row says by whom, and it is not reverted twice.
    let ra = row(&w, "t.renameA");
    assert_eq!(ra.reverted_by.as_ref().map(|r| &r.id), Some(&revert.id));
    assert_eq!(ra.fixed.as_deref(), Some("reverted"));
    assert!(w.revert_changeset(&ra.id).is_err());
    // `Ctrl+Z` takes the revert back — an undo of it, not a revert; the
    // rename may be reverted again.
    w.undo().expect("undo").expect("the revert");
    let rows = w.journal(None, 1).expect("journal").entries;
    assert_eq!(rows[0].kind, crate::JournalKind::Undo);
    assert_eq!(names(&mut w, &root), ["А2", "Б2"]);
    assert_eq!(row(&w, "t.renameA").fixed, None);
    // A key changed since stays as it is and is reported.
    rename(&mut w, &a, "А3", "t.renameA3");
    let report = w.revert_changeset(&ra.id).expect("revert");
    assert!(!report.skipped.is_empty());
    assert_eq!(names(&mut w, &root), ["А3", "Б2"]);
    // Nothing was left to take back: no step, no revert in the journal.
    assert!(report.nothing);
    assert_eq!(row(&w, "t.renameA").fixed, None);
    assert_eq!(
        w.history().undo.map(|l| l.key),
        Some("t.renameA3".to_owned())
    );
}

#[test]
fn a_revert_takes_back_another_origin_and_shows_the_nodes_it_touched() {
    // 10 §9.4: locally the one person reverts any changeset — a wire, a move,
    // a trashing; «Показать» goes to the live nodes it touched.
    let mut w = ws();
    let root = w.root();
    let a = create(&mut w, &root, NodeKind::Note, "А");
    let b = create(&mut w, &root, NodeKind::Note, "Б");
    w.apply(
        &[Op::Connect {
            from: a.clone(),
            to: b.clone(),
        }],
        Label::new("t.connect"),
    )
    .expect("a wire");
    let wire = row(&w, "t.connect");
    assert_eq!(
        w.changeset_nodes(&wire.id).expect("nodes"),
        [a.clone(), b.clone()]
    );
    let made = row(&w, "t.create");
    assert_eq!(
        w.changeset_nodes(&made.id).expect("nodes"),
        std::slice::from_ref(&b)
    );
    w.apply(
        &[Op::Trash {
            ids: vec![b.clone()],
        }],
        Label::new("t.trash"),
    )
    .expect("trash");
    // A node in the trash is not shown.
    assert_eq!(
        w.changeset_nodes(&wire.id).expect("nodes"),
        std::slice::from_ref(&a)
    );
    // The trashing taken back from the journal: Б and its wire come back.
    let trashed = row(&w, "t.trash");
    w.revert_changeset(&trashed.id).expect("revert");
    assert_eq!(names(&mut w, &root), ["А", "Б"]);
    assert_eq!(w.network_view(&root).expect("view").edges.len(), 1);
    assert!(w.changeset_nodes("nope").is_err());
}

#[test]
fn a_purge_is_not_reverted_and_no_revert_brings_back_a_node_gone_for_good() {
    // 10 §10.4: a node gone for good does not come back — not by reverting
    // the purge, nor by reverting a step from before it.
    let mut w = ws();
    let root = w.root();
    let a = create(&mut w, &root, NodeKind::Note, "А");
    let b = create(&mut w, &root, NodeKind::Note, "Б");
    w.apply(
        &[Op::Move {
            net: root.clone(),
            id: b.clone(),
            x: 100.0,
            y: 100.0,
        }],
        Label::new("t.move"),
    )
    .expect("move");
    w.apply(
        &[Op::Trash {
            ids: vec![b.clone()],
        }],
        Label::new("t.trash"),
    )
    .expect("trash");
    w.purge_now(&b).expect("purge");
    let purge = row(&w, "core.change.purge");
    assert_eq!(purge.fixed.as_deref(), Some("purge"));
    assert!(w.revert_changeset(&purge.id).is_err());
    // Nor the workspace's own making: the root stays.
    let made = row(&w, "core.change.create");
    assert_eq!(made.fixed.as_deref(), Some("workspace"));
    assert!(w.revert_changeset(&made.id).is_err());
    // The move and the trashing of Б: every key of theirs is skipped.
    for key in ["t.move", "t.trash"] {
        let r = row(&w, key);
        let report = w.revert_changeset(&r.id).expect("revert");
        assert!(!report.skipped.is_empty(), "{key}");
    }
    assert_eq!(names(&mut w, &root), ["А"]);
    assert!(w.trash().is_empty());
    // Б's own creation either — the newer of the two: its keys stay gone.
    let made = row(&w, "t.create");
    assert_eq!(
        w.changeset_nodes(&made.id).expect("nodes"),
        std::slice::from_ref(&root)
    );
    let report = w.revert_changeset(&made.id).expect("revert");
    assert!(!report.skipped.is_empty());
    assert_eq!(names(&mut w, &root), ["А"]);
    let _ = a;
}

#[test]
fn a_revert_a_later_change_stands_on_is_refused_and_writes_nothing() {
    // 05 §14, 10 §9.3: the network a note was made in since; the node a wire
    // was drawn to since; a node whose network went to the trash since.
    let mut w = ws();
    let root = w.root();
    let net = create(&mut w, &root, NodeKind::Network, "Сеть");
    let made_net = row(&w, "t.create");
    let inside = create(&mut w, &net, NodeKind::Note, "Внутри");
    let depends = |w: &mut Workspace<MemoryStore>, id: &str| {
        let before = w.journal(None, 1000).expect("journal").entries.len();
        let e = w.revert_changeset(id).expect_err("refused");
        assert_eq!(e.code(), Some("depends"), "{e}");
        assert_eq!(
            w.journal(None, 1000).expect("journal").entries.len(),
            before
        );
    };
    depends(&mut w, &made_net.id);
    assert_eq!(names(&mut w, &net), ["Внутри"]);
    // A wire to a node made earlier: its making cannot go back.
    let lone = create(&mut w, &root, NodeKind::Note, "Одна");
    let made_lone = row(&w, "t.create");
    w.apply(
        &[Op::Connect {
            from: inside.clone(),
            to: lone.clone(),
        }],
        Label::new("t.connect"),
    )
    .expect("a wire");
    depends(&mut w, &made_lone.id);
    // A note trashed, then its network: bringing the note back alone would
    // leave it in a network in the trash.
    w.apply(
        &[Op::Trash {
            ids: vec![inside.clone()],
        }],
        Label::new("t.trashNote"),
    )
    .expect("trash the note");
    w.apply(
        &[Op::Trash {
            ids: vec![net.clone()],
        }],
        Label::new("t.trashNet"),
    )
    .expect("trash the network");
    let note_trashed = row(&w, "t.trashNote");
    depends(&mut w, &note_trashed.id);
    // Its network back first: then the note may come back too.
    let net_trashed = row(&w, "t.trashNet");
    w.revert_changeset(&net_trashed.id)
        .expect("the network back");
    w.revert_changeset(&note_trashed.id).expect("the note back");
    assert_eq!(names(&mut w, &net), ["Внутри"]);
}

#[test]
fn undo_keeps_two_hundred_steps() {
    // 06 §1.2: the stack of graph commands is 200 deep; the oldest goes.
    let mut w = ws();
    let root = w.root();
    let a = create(&mut w, &root, NodeKind::Note, "0");
    for i in 1..=UNDO_DEPTH + 5 {
        rename(&mut w, &a, &i.to_string(), "t.rename");
    }
    let mut undone = 0;
    while w.undo().expect("undo").is_some() {
        undone += 1;
    }
    assert_eq!(undone, UNDO_DEPTH);
    // The name the 6th rename gave: the steps before it are let go.
    assert_eq!(names(&mut w, &root), ["5"]);
}
