//! Property tests of the model's invariants (05 §14, NFR-124): random
//! sequences of the domain's operations — the refused ones too — with undo
//! and redo, and the trash's purge (10 §10.4). After every step the invariants hold, and a refused step leaves
//! the workspace as it was (a changeset is all or nothing, NFR-71).
//!
//! Merges are not here yet: the core reconciles the invariants after a merge
//! with the sync of stage 2 (10 §8.5), and the merges come with it.
//!
//! `STRATA_PROPS=<n>` sets how many scenarios run, `STRATA_PROPS_SEED=<s>`
//! the first seed; a failure names the seed and the steps that led to it.
//! CI runs NFR-124's 10 000 in release; plain `cargo test` runs a few.

use super::{Editor, create, text_of, ws};
use crate::{Label, MemoryStore, Op, Workspace};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use strata_model::{NodeId, NodeKind};

/// Scenarios of a plain `cargo test`; CI asks for 10 000 (NFR-124).
const DEFAULT_SCENARIOS: u64 = 60;
/// Steps of one scenario.
const STEPS: usize = 30;

/// SplitMix64: a small, fixed generator, so a seed replays its scenario.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    fn below(&mut self, n: usize) -> usize {
        // n is small: the modulo's bias does not matter here.
        (self.next() % n.max(1) as u64) as usize
    }

    fn pick<T: Clone>(&mut self, v: &[T]) -> Option<T> {
        (!v.is_empty()).then(|| v[self.below(v.len())].clone())
    }

    fn coord(&mut self) -> f64 {
        self.below(800) as f64
    }
}

const KINDS: [NodeKind; 6] = [
    NodeKind::Network,
    NodeKind::Project,
    NodeKind::Task,
    NodeKind::Note,
    NodeKind::Board,
    NodeKind::Checklist,
];

fn has_canvas(k: NodeKind) -> bool {
    matches!(k, NodeKind::Network | NodeKind::Project)
}

/// What the workspace holds, as its readers see it: for a refused step,
/// before and after must be the same.
#[derive(Debug, PartialEq)]
struct Seen {
    tree: Vec<crate::TreeItem>,
    wires: Vec<crate::WireEnds>,
    trash: Vec<String>,
}

fn seen(w: &Workspace<MemoryStore>) -> Seen {
    let mut tree = w.tree();
    tree.sort_by(|a, b| a.id.cmp(&b.id));
    let mut trash: Vec<String> = w.trash().into_iter().map(|t| t.id).collect();
    trash.sort();
    Seen {
        tree,
        wires: w.wires(),
        trash,
    }
}

/// The names `[[…]]` of a text, as written (13 §3.4 reads them; the
/// scenarios use plain names, unique in the workspace).
fn linked(text: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let mut rest = text;
    while let Some(at) = rest.find("[[") {
        rest = &rest[at + 2..];
        let Some(end) = rest.find("]]") else { break };
        out.insert(rest[..end].to_owned());
        rest = &rest[end + 2..];
    }
    out
}

/// The kinds a node may go between (05 §14 rule 2, §4.2).
fn kind_change_allowed(from: NodeKind, to: NodeKind) -> bool {
    use NodeKind::{Network, Project, Task};
    from == to
        || matches!(
            (from, to),
            (Task, Project) | (Project, Task) | (Network, Project) | (Project, Network)
        )
}

/// The scenario's memory across steps: what rule 2 compares with, which
/// ids have been seen (rule 1).
#[derive(Default)]
struct Model {
    kinds: HashMap<String, NodeKind>,
    ids: BTreeSet<String>,
    names: u64,
}

impl Model {
    fn fresh_name(&mut self) -> String {
        self.names += 1;
        format!("N{}", self.names)
    }
}

/// 05 §14 on what the workspace holds now.
fn check(w: &mut Workspace<MemoryStore>, m: &mut Model) -> Result<(), String> {
    let root = w.root();
    let tree = w.tree();
    let trash = w.trash();
    let by: BTreeMap<&str, &crate::TreeItem> = tree.iter().map(|i| (i.id.as_str(), i)).collect();
    if by.len() != tree.len() {
        return Err("a node is twice in the tree".into());
    }
    for t in &trash {
        if by.contains_key(t.id.as_str()) {
            return Err(format!("{} is in the trash and alive", t.name));
        }
    }
    // Rule 3, what the tree does not show: a node it leaves out — one that
    // lies nowhere — is not alive; it is in the trash, gone, or not made.
    for id in &m.ids {
        if !by.contains_key(id.as_str())
            && !trash.iter().any(|t| t.id == *id)
            && w.node_details(id).is_ok()
        {
            return Err(format!("{id} is alive and lies nowhere"));
        }
    }
    if !by.contains_key(root.as_str()) {
        return Err("the root is gone".into());
    }
    // Rule 1: ids are never reused — every id here was made by a step, and
    // the root is the root.
    for id in tree
        .iter()
        .map(|i| &i.id)
        .chain(trash.iter().map(|t| &t.id))
    {
        if *id != root && !m.ids.contains(id) {
            return Err(format!("an id no step made: {id}"));
        }
    }
    // Rule 2: a kind changes only between task and project, folder and project.
    for i in tree.iter() {
        if let Some(&was) = m.kinds.get(&i.id)
            && !kind_change_allowed(was, i.kind)
        {
            return Err(format!("{} went from {was:?} to {:?}", i.name, i.kind));
        }
        m.kinds.insert(i.id.clone(), i.kind);
    }
    // Rules 3 and 4: one primary placement in a live network with a canvas,
    // the other placements each once, none in the primary's network.
    let mut children: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for i in &tree {
        if i.id == root {
            if i.parent.is_some() {
                return Err("the root lies somewhere".into());
            }
            continue;
        }
        let Some(p) = i.parent.as_deref() else {
            return Err(format!("{} has no primary placement", i.name));
        };
        let mut nets = vec![p];
        let mut once = BTreeSet::from([p]);
        for a in &i.appears {
            if !once.insert(a.as_str()) {
                return Err(format!("{} lies in a network twice", i.name));
            }
            nets.push(a);
        }
        for n in nets {
            match by.get(n) {
                Some(net) if has_canvas(net.kind) => {}
                Some(net) => return Err(format!("{} lies in {}, no network", i.name, net.name)),
                None => return Err(format!("{} lies in a network not alive", i.name)),
            }
            if has_canvas(i.kind) {
                children.entry(n).or_default().push(i.id.as_str());
            }
        }
    }
    // Rule 5: the nesting of networks has no cycle.
    fn cyclic<'a>(
        at: &'a str,
        children: &BTreeMap<&'a str, Vec<&'a str>>,
        path: &mut BTreeSet<&'a str>,
        done: &mut BTreeSet<&'a str>,
    ) -> bool {
        if done.contains(at) {
            return false;
        }
        if !path.insert(at) {
            return true;
        }
        let found = children
            .get(at)
            .is_some_and(|kids| kids.iter().any(|k| cyclic(k, children, path, done)));
        path.remove(at);
        done.insert(at);
        found
    }
    let mut done = BTreeSet::new();
    for i in &tree {
        if has_canvas(i.kind) && cyclic(&i.id, &children, &mut BTreeSet::new(), &mut done) {
            return Err(format!("{} lies inside itself", i.name));
        }
    }
    // Rule 6: a wire joins two nodes, one wire an ordered pair.
    let wires = w.wires();
    let mut pairs = BTreeSet::new();
    for e in &wires {
        if e.from == e.to {
            return Err(format!("a wire from {} to itself", e.from));
        }
        if !by.contains_key(e.from.as_str()) || !by.contains_key(e.to.as_str()) {
            return Err("a shown wire with an end not alive".into());
        }
        if !pairs.insert((e.from.as_str(), e.to.as_str())) {
            return Err("two wires of one ordered pair".into());
        }
    }
    // Rule 7: a note's `[[X]]` to a live node is its wire to it.
    let named: BTreeMap<&str, &str> = tree
        .iter()
        .map(|i| (i.name.as_str(), i.id.as_str()))
        .collect();
    let notes: Vec<(String, String)> = tree
        .iter()
        .filter(|i| i.kind == NodeKind::Note)
        .map(|i| (i.id.clone(), i.name.clone()))
        .collect();
    for (note, name) in notes {
        for x in linked(&text_of(w, &note)) {
            let Some(&to) = named.get(x.as_str()) else {
                continue;
            };
            if to != note && !pairs.contains(&(note.as_str(), to)) {
                return Err(format!("{name} links [[{x}]] and has no wire to it"));
            }
        }
    }
    Ok(())
}

/// One random step: the ops it tried, as a line of the failure's report.
fn step(w: &mut Workspace<MemoryStore>, m: &mut Model, rng: &mut Rng) -> String {
    let tree = w.tree();
    let root = w.root();
    let live: Vec<String> = tree
        .iter()
        .filter(|i| i.id != root)
        .map(|i| i.id.clone())
        .collect();
    let nets: Vec<String> = tree
        .iter()
        .filter(|i| has_canvas(i.kind))
        .map(|i| i.id.clone())
        .collect();
    let places = |id: &str| -> Vec<String> {
        tree.iter()
            .find(|i| i.id == id)
            .map(|i| i.parent.iter().chain(i.appears.iter()).cloned().collect())
            .unwrap_or_default()
    };
    let label = Label::new("props.step");
    let ops: Vec<Op> = match rng.below(17) {
        0..=2 => {
            let id = NodeId::new().to_text();
            m.ids.insert(id.clone());
            vec![Op::CreateNode {
                id: Some(id),
                kind: KINDS[rng.below(KINDS.len())],
                name: m.fresh_name(),
                net: rng.pick(&nets).unwrap_or(root.clone()),
                x: rng.coord(),
                y: rng.coord(),
            }]
        }
        3 => match rng.pick(&live) {
            Some(id) => vec![Op::Rename {
                id,
                name: m.fresh_name(),
            }],
            None => vec![],
        },
        4 => match (rng.pick(&live), rng.pick(&live)) {
            (Some(from), Some(to)) => vec![Op::Connect { from, to }],
            _ => vec![],
        },
        5 => match rng.pick(&w.wires()) {
            Some(e) => vec![Op::Disconnect {
                from: e.from,
                to: e.to,
            }],
            None => vec![],
        },
        6 => match (rng.pick(&live), rng.pick(&nets)) {
            (Some(id), Some(net)) => vec![Op::Place {
                id,
                net,
                x: rng.coord(),
                y: rng.coord(),
            }],
            _ => vec![],
        },
        7 => match rng.pick(&live) {
            Some(id) => match rng.pick(&places(&id)) {
                Some(net) => vec![Op::Unplace { id, net }],
                None => vec![],
            },
            None => vec![],
        },
        8 => match rng.pick(&live) {
            Some(id) => match rng.pick(&places(&id)) {
                Some(net) => vec![Op::SetPrimary { id, net }],
                None => vec![],
            },
            None => vec![],
        },
        9 => match (rng.pick(&live), rng.pick(&nets)) {
            (Some(id), Some(to)) => match rng.pick(&places(&id)) {
                Some(from) => vec![Op::Relocate {
                    id,
                    from,
                    to,
                    x: rng.coord(),
                    y: rng.coord(),
                }],
                None => vec![],
            },
            _ => vec![],
        },
        10 => match rng.pick(&live) {
            Some(id) => vec![Op::Trash { ids: vec![id] }],
            None => vec![],
        },
        11 => match rng.pick(&w.trash()) {
            Some(t) => vec![Op::Restore { ids: vec![t.id] }],
            None => vec![],
        },
        12 => match rng.pick(&live) {
            Some(id) => vec![Op::SetKind {
                id,
                kind: KINDS[rng.below(KINDS.len())],
            }],
            None => vec![],
        },
        13 => {
            // A note's text links some names, one maybe to no node (a ghost).
            let notes: Vec<String> = tree
                .iter()
                .filter(|i| i.kind == NodeKind::Note)
                .map(|i| i.id.clone())
                .collect();
            let Some(note) = rng.pick(&notes) else {
                return "type: no note".into();
            };
            let names: Vec<String> = tree.iter().map(|i| i.name.clone()).collect();
            let mut text = String::from("См.");
            for _ in 0..1 + rng.below(3) {
                let name = if rng.below(4) == 0 {
                    format!("Нет{}", rng.below(5))
                } else {
                    rng.pick(&names).unwrap_or_default()
                };
                text.push_str(&format!(" [[{name}]]"));
            }
            let mut ed = Editor::open(w, &note);
            ed.type_text(w, &note, &text);
            return format!("type {note}: {text}");
        }
        14 => {
            // The trash's term passed for a node and its step (10 §10.4).
            let Some(t) = rng.pick(&w.trash()) else {
                return "purge: an empty trash".into();
            };
            return match w.purge_now(&t.id) {
                Ok(gone) => format!("purge {}: {} gone", t.id, gone.len()),
                Err(e) => format!("purge {}: REFUSED BUT CHANGED? ({e})", t.id),
            };
        }
        15 => {
            // «Откатить» any changeset of the journal (10 §9.3): taken back,
            // skipped key by key, or refused — a later change stands on it.
            let rows = w
                .journal(None, usize::MAX)
                .map(|j| j.entries)
                .unwrap_or_default();
            let Some(r) = rng.pick(&rows) else {
                return "revert: an empty journal".into();
            };
            let before = seen(w);
            return match w.revert_changeset(&r.id) {
                Ok(report) => format!(
                    "revert {} ({}): {} skipped",
                    r.id,
                    r.label.key,
                    report.skipped.len()
                ),
                Err(e) if seen(w) != before => {
                    format!("revert {}: REFUSED BUT CHANGED ({e})", r.id)
                }
                Err(e) => format!("revert {} ({}): refused ({e})", r.id, r.label.key),
            };
        }
        _ => {
            let undo = rng.below(2) == 0;
            let r = if undo { w.undo() } else { w.redo() };
            return format!("{}: {}", if undo { "undo" } else { "redo" }, r.is_ok());
        }
    };
    if ops.is_empty() {
        return "nothing to do".into();
    }
    let before = seen(w);
    match w.apply(&ops, label) {
        Ok(_) => format!("{ops:?}: done"),
        Err(e) => {
            let after = seen(w);
            if before != after {
                // Reported by the caller's check as a broken step.
                return format!("{ops:?}: REFUSED BUT CHANGED ({e})");
            }
            format!("{ops:?}: refused ({e})")
        }
    }
}

fn env_u64(key: &str, default: u64) -> u64 {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

#[test]
fn random_steps_keep_the_invariants_of_05_14() {
    let scenarios = env_u64("STRATA_PROPS", DEFAULT_SCENARIOS);
    let first = env_u64("STRATA_PROPS_SEED", 1);
    for seed in first..first + scenarios {
        let mut rng = Rng(seed);
        let mut w = ws();
        let mut m = Model::default();
        // A few nodes to start from: a folder with a note, a task in the root.
        let root = w.root();
        let folder = create(&mut w, &root, NodeKind::Network, "Папка");
        let note = create(&mut w, &folder, NodeKind::Note, "Заметка");
        let task = create(&mut w, &root, NodeKind::Task, "Задача");
        m.ids.extend([folder, note, task]);
        let mut log = Vec::new();
        for _ in 0..STEPS {
            let line = step(&mut w, &mut m, &mut rng);
            let broken = line.contains("REFUSED BUT CHANGED");
            log.push(line);
            if let Err(e) = check(&mut w, &mut m).and_then(|()| {
                if broken {
                    Err("a refused step changed the workspace (NFR-71)".into())
                } else {
                    Ok(())
                }
            }) {
                panic!(
                    "seed {seed}: {e}\nsteps:\n{}",
                    log.iter()
                        .enumerate()
                        .map(|(i, l)| format!("{:>3}. {l}", i + 1))
                        .collect::<Vec<_>>()
                        .join("\n")
                );
            }
        }
    }
}

#[test]
fn the_scenarios_replay_from_their_seed() {
    // A failure names its seed: the same seed must give the same steps.
    let run = |seed| {
        let mut rng = Rng(seed);
        (0..20).map(|_| rng.below(1000)).collect::<Vec<_>>()
    };
    assert_eq!(run(7), run(7));
    assert_ne!(run(7), run(8));
    assert_eq!(
        linked("См. [[А]] и [[Б]], [[не закрыта"),
        BTreeSet::from(["А".to_owned(), "Б".to_owned()])
    );
    assert!(kind_change_allowed(NodeKind::Task, NodeKind::Project));
    assert!(!kind_change_allowed(NodeKind::Note, NodeKind::Task));
}
