//! Paths (05 §9.3, 09 §4.2–4.5): what a path names, by any placement.

use super::{create, op, place, ws};
use crate::vault::{Vault, VaultFile};
use crate::{ImportOptions, MemoryStore, Op, Resolved, Workspace};
use strata_model::NodeKind;

/// The names along each way a resolution found.
fn ways(r: &Resolved) -> Vec<Vec<String>> {
    r.found
        .iter()
        .map(|h| h.path.iter().map(|(_, name)| name.clone()).collect())
        .collect()
}

fn ids(r: &Resolved) -> Vec<Vec<String>> {
    r.found
        .iter()
        .map(|h| h.path.iter().map(|(id, _)| id.clone()).collect())
        .collect()
}

/// root ─ Проекты ─ Игра ─ Боёвка (a note)
///      └ Фильм ─ Игра (an appearance)
struct Space {
    w: Workspace<MemoryStore>,
    root: String,
    projects: String,
    film: String,
    game: String,
    combat: String,
}

fn space() -> Space {
    let mut w = ws();
    w.set_clock(super::ticking);
    let root = w.root();
    let projects = create(&mut w, &root, NodeKind::Network, "Проекты");
    let film = create(&mut w, &root, NodeKind::Network, "Фильм");
    let game = create(&mut w, &projects, NodeKind::Network, "Игра");
    let combat = create(&mut w, &game, NodeKind::Note, "Боёвка");
    place(&mut w, &game, &film).expect("an appearance");
    Space {
        w,
        root,
        projects,
        film,
        game,
        combat,
    }
}

#[test]
fn a_path_names_a_node_by_any_placement_whatever_the_case_and_yo() {
    let s = space();
    let r = s.w.resolve_path("/проекты/ИГРА/боевка", &[]);
    assert_eq!(r.missing, None);
    assert_eq!(ways(&r), vec![vec!["Корень", "Проекты", "Игра", "Боёвка"]]);
    assert_eq!(r.found[0].kind, NodeKind::Note);
    assert!(r.found[0].primary);
    // Through the appearance: the same node, the way that names it.
    let r = s.w.resolve_path("/Фильм/Игра/Боёвка", &[]);
    assert_eq!(
        ids(&r),
        vec![vec![
            s.root.clone(),
            s.film.clone(),
            s.game.clone(),
            s.combat.clone()
        ]]
    );
    let r = s.w.resolve_path("/Фильм/Игра", &[]);
    assert!(!r.found[0].primary, "Игра lies in «Фильм» as an appearance");
    // The root alone.
    assert_eq!(ways(&s.w.resolve_path("/", &[])), vec![vec!["Корень"]]);
}

#[test]
fn a_relative_path_goes_from_the_entry_path_and_dot_dot_back_along_it() {
    let s = space();
    // In «Игра», come to from «Фильм» (05 §9.3).
    let base = vec![s.root.clone(), s.film.clone(), s.game.clone()];
    let names = |text: &str| ways(&s.w.resolve_path(text, &base));
    assert_eq!(names(".."), vec![vec!["Корень", "Фильм"]]);
    assert_eq!(names("../.."), vec![vec!["Корень"]]);
    assert_eq!(
        names("../../.."),
        vec![vec!["Корень"]],
        "nothing above the root"
    );
    assert_eq!(
        names("./Боёвка"),
        vec![vec!["Корень", "Фильм", "Игра", "Боёвка"]]
    );
    assert_eq!(names("Боёвка"), names("./Боёвка"));
    assert_eq!(names("../../Проекты"), vec![vec!["Корень", "Проекты"]]);
    assert_eq!(names("."), vec![vec!["Корень", "Фильм", "Игра"]]);
}

#[test]
fn an_entry_path_that_no_longer_holds_gives_way_to_the_canonical_one() {
    let mut s = space();
    let base = vec![s.root.clone(), s.film.clone(), s.game.clone()];
    op(
        &mut s.w,
        Op::Unplace {
            id: s.game.clone(),
            net: s.film.clone(),
        },
    )
    .expect("away from «Фильм»");
    assert_eq!(
        ways(&s.w.resolve_path("..", &base)),
        vec![vec!["Корень", "Проекты"]]
    );
    // An id that names nothing: from the root.
    assert_eq!(
        ways(&s.w.resolve_path("Фильм", &["no such id".to_owned()])),
        vec![vec!["Корень", "Фильм"]]
    );
}

#[test]
fn a_name_two_nodes_share_offers_both_the_primary_first() {
    let mut s = space();
    let refs = create(&mut s.w, &s.projects, NodeKind::Network, "Референсы");
    let other = create(&mut s.w, &s.film, NodeKind::Network, "Референсы");
    place(&mut s.w, &other, &s.projects).expect("an appearance of the other");
    let r = s.w.resolve_path("/Проекты/Референсы", &[]);
    assert_eq!(r.found.len(), 2, "05 §9.3: names need not be unique");
    let last: Vec<(String, bool)> = r
        .found
        .iter()
        .map(|h| (h.path.last().expect("a way").0.clone(), h.primary))
        .collect();
    assert_eq!(last, vec![(refs, true), (other, false)]);
}

#[test]
fn a_segment_that_names_nothing_says_which_and_offers_the_nearest_names() {
    let mut s = space();
    create(&mut s.w, &s.projects, NodeKind::Network, "Графика");
    let r = s.w.resolve_path("/Проекты/Игр/Боёвка", &[]);
    assert!(r.found.is_empty());
    let missing = r.missing.expect("a segment named nothing");
    assert_eq!(missing.at, 1);
    let near: Vec<&str> = missing
        .near
        .iter()
        .map(|h| h.path.last().expect("a way").1.as_str())
        .collect();
    assert_eq!(near.first(), Some(&"Игра"));
    assert!(!near.contains(&"Боёвка"), "only what lies in «Проекты»");
}

#[test]
fn a_node_in_the_trash_is_named_by_no_path() {
    let mut s = space();
    op(
        &mut s.w,
        Op::Trash {
            ids: vec![s.combat.clone()],
        },
    )
    .expect("to the trash");
    let r = s.w.resolve_path("/Проекты/Игра/Боёвка", &[]);
    assert!(r.found.is_empty());
    assert_eq!(r.missing.map(|m| m.at), Some(2));
}

#[test]
fn a_slash_in_a_name_is_written_escaped() {
    let mut s = space();
    let root = s.root.clone();
    let id = create(&mut s.w, &root, NodeKind::Network, "Вход/выход");
    let r = s.w.resolve_path(r"/Вход\/выход", &[]);
    assert_eq!(ids(&r), vec![vec![root, id]]);
    assert_eq!(
        crate::path_text(&["Вход/выход".to_owned()]),
        r"/Вход\/выход"
    );
}

#[test]
fn a_segment_names_a_node_by_its_aliases_too() {
    let mut w = ws();
    let files = vec![VaultFile::new(
        "Игра/Боёвка.md",
        b"---\naliases: [Combat]\n---\n\nText\n".to_vec(),
    )];
    let options = ImportOptions {
        unlinked: "Вложения без ссылок".to_owned(),
        text: "текст".to_owned(),
        ..ImportOptions::default()
    };
    w.import_vault(Vault::from_files("V", files), None, &options)
        .expect("the import");
    // The vault's folders come into the root (13 §3).
    let r = w.resolve_path("/Игра/combat", &[]);
    assert_eq!(ways(&r), vec![vec!["Корень", "Игра", "Боёвка"]]);
}

#[test]
fn the_tree_says_where_a_node_also_appears() {
    let s = space();
    let tree = s.w.tree();
    let item = |id: &str| tree.iter().find(|t| t.id == id).expect("in the tree");
    assert_eq!(item(&s.game).parent.as_deref(), Some(s.projects.as_str()));
    assert_eq!(item(&s.game).appears, vec![s.film.clone()]);
    assert!(item(&s.combat).appears.is_empty());
}
