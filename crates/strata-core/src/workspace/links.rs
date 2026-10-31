//! A note's `[[links]]` as its wires (05 §8.2 rule 4) and ghosts (05 §8.5).
//! A link finds its node by the rule of 13 §3.5, the same for import and for
//! the workspace after it: a wire keeps its node while the node still answers
//! the link; a path names its node from the root, then from the note's
//! folder; a name shared by several nodes goes to the nearest by the tree,
//! then the shortest path, then the oldest. A link to no node is a wire to a
//! ghost: no `to`, the name `X` as `ghost`, the key `h(from ‖ "?" ‖
//! linkKey(X))` (10 §2.5). A ghost resolves as soon as a node answers it:
//! its wire goes and `from → X` comes with the same origins, in one system
//! changeset (05 §11). The networks keep no route or `hidden` per wire yet,
//! so there is nothing of them to carry to the new key.
//!
//! A rename rewrites the links that named the node, `[[Старое]]` →
//! `[[Новое]]`, with point edits in the texts (13 §6.5, ☑ Q-10-9): which
//! links named it is the rule above with the names as they were.

use super::{Changeset, Store, Val, Workspace, Writes, engine, invalid, load, read};
use crate::changeset::Label;
use crate::workspace::Result;
use loro::{ExportMode, LoroValue, ValueOrContainer};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use strata_markdown::link_key;
use strata_model::{ChangesetOrigin, EdgeKey, NodeId, NodeKind, now_ms};

/// Fields whose change can make a link find another node, or none (13 §3.5).
const NAMING: [&str; 4] = ["name", "kind", "trashedAt", "primaryNet"];
/// Origins of a wire (10 §2.3).
const ORIGINS: [&str; 3] = ["text", "manual", "import"];
/// A name with these breaks a link (13 §3.4): no link is rewritten to it.
const BREAKS_LINKS: [char; 5] = ['[', ']', '|', '#', '^'];

/// Names of nodes as they were before a step, by node; empty — as they are.
type Before = HashMap<NodeId, String>;

/// The parts of a link key between `/`: a path's networks and the name last.
pub(super) fn segments(key: &str) -> Vec<String> {
    key.split('/')
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
}

/// The path of a Markdown link `[text](path#anchor "title")` within the
/// link's text: its offset, its length, and whether it is in `<…>` (where
/// spaces are written as they are).
fn markdown_path(link: &str) -> Option<(usize, usize, bool)> {
    let open = link.rfind("](")? + 2;
    let rest = link.get(open..link.len().checked_sub(1)?)?;
    let (start, path, angle) = match rest.strip_prefix('<') {
        Some(inner) => (open + 1, &inner[..inner.find('>')?], true),
        None => (
            open,
            &rest[..rest.find(char::is_whitespace).unwrap_or(rest.len())],
            false,
        ),
    };
    Some((start, path.find('#').unwrap_or(path.len()), angle))
}

/// Where a link's target is written in `text`: its byte offset, the target
/// as written (`%20` and all in a Markdown link) and whether a name put
/// there is to be percent-encoded; none for a Markdown link whose path is
/// not found.
fn target_span<'t>(text: &'t str, link: &strata_markdown::Link) -> Option<(usize, &'t str, bool)> {
    let start = link.range.start;
    match link
        .markdown
        .then(|| markdown_path(&text[link.range.clone()]))
    {
        Some(Some((at, len, angle))) => {
            Some((start + at, &text[start + at..start + at + len], !angle))
        }
        Some(None) => None,
        None => {
            let target = link.target.as_str();
            let at = text[link.range.clone()].find(target)?;
            Some((
                start + at,
                &text[start + at..start + at + target.len()],
                false,
            ))
        }
    }
}

/// The nodes a link may name, the nearest first, and the one its wire holds.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct LinkTargets {
    pub targets: Vec<LinkTarget>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chosen: Option<String>,
}

/// A node a link may name, with its path from below the root.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct LinkTarget {
    pub id: String,
    pub path: String,
}

/// What a link names.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Target {
    Node(NodeId),
    Ghost,
}

/// What a link may name: the node its wire holds (13 §3.5 «залипание»), or
/// the nodes that answer it — more than one is an ambiguous link.
pub(super) enum Found {
    Held(NodeId),
    Some(Vec<NodeId>),
}

/// What a note's text asks for by the rule of 13 §3.5.
#[derive(Default)]
pub(super) struct Asked {
    /// The nodes it links to; none to itself (05 §8.2 rule 2).
    pub(super) want: BTreeSet<NodeId>,
    /// Ghosts: link key → the name as first written.
    pub(super) ghosts: BTreeMap<String, String>,
    /// Link key → the node it found.
    pub(super) resolved: HashMap<String, NodeId>,
    /// Links several nodes answer, once each: the link as written, the
    /// node it went to and how many answered (13 §3.6 «Неоднозначная ссылка»).
    pub(super) ambiguous: Vec<(String, NodeId, usize)>,
}

/// The wires and ghosts a note has, by the edges of its shard.
#[derive(Default)]
pub(super) struct Outgoing {
    /// Wires with the origin `text`: target → wire key.
    pub(super) wires: BTreeMap<NodeId, String>,
    /// Ghosts: link key → (wire key, the name as written).
    pub(super) ghosts: BTreeMap<String, (String, String)>,
}

impl<S: Store> Workspace<S> {
    /// Live nodes by the link key of their name (13 §3.4).
    pub(super) fn link_names(&self) -> HashMap<String, Vec<NodeId>> {
        let mut out: HashMap<String, Vec<NodeId>> = HashMap::new();
        for shard in self.index_shards() {
            let LoroValue::Map(names) = shard.get_map("name").get_value() else {
                continue;
            };
            for (id, name) in names.iter() {
                let (Ok(n), Some(name)) = (NodeId::parse(id), name.as_string()) else {
                    continue;
                };
                if self.alive(n) {
                    out.entry(link_key(name)).or_default().push(n);
                }
            }
        }
        out
    }

    /// A live note is here that is not one of `done`.
    fn notes_besides(&self, done: &BTreeSet<NodeId>) -> bool {
        let mut found = false;
        for shard in self.index_shards() {
            shard.get_map("kind").for_each(|id, v| {
                if found {
                    return;
                }
                let note = matches!(&v, ValueOrContainer::Value(LoroValue::String(k)) if k.as_str() == "note");
                if note && let Ok(n) = NodeId::parse(id) {
                    found = !done.contains(&n) && self.alive(n);
                }
            });
            if found {
                break;
            }
        }
        found
    }

    fn name_as(&self, n: NodeId, was: &Before) -> String {
        was.get(&n).cloned().unwrap_or_else(|| self.name(n))
    }

    /// Link keys of a node's canonical path, its own name last and the root
    /// left out (05 §9.3): `/Проекты/Игра` is `["проекты", "игра"]`.
    fn path_keys(&self, n: NodeId, was: &Before) -> Vec<String> {
        let mut out: Vec<String> = self
            .ancestors(n)
            .into_iter()
            .rev()
            .filter(|a| *a != self.root)
            .map(|a| link_key(&self.name_as(a, was)))
            .collect();
        out.push(link_key(&self.name_as(n, was)));
        out
    }

    /// The node a link of `src` names, by 13 §3.5. `segs` are the parts of
    /// the link's key between `/`; `held` are the nodes `src` has text wires
    /// to, in the trash too (05 §14 rule 6: such a wire stays, hidden).
    fn resolve(
        &self,
        src: NodeId,
        segs: &[String],
        held: &BTreeSet<NodeId>,
        names: &HashMap<String, Vec<NodeId>>,
        was: &Before,
    ) -> Target {
        match self.candidates(src, segs, held, names, was) {
            Found::Held(n) => Target::Node(n),
            Found::Some(found) => match found.len() {
                0 => Target::Ghost,
                1 => Target::Node(found[0]),
                _ => Target::Node(self.nearest(src, &found)),
            },
        }
    }

    /// The nodes a link of `src` may name (13 §3.5 steps 1–2), or the one
    /// its wire holds already. A link to `X.canvas` or `X.excalidraw` names
    /// the network or the board the import made of that file: its name has
    /// no extension (13 §2.5, §3.4).
    pub(super) fn candidates(
        &self,
        src: NodeId,
        segs: &[String],
        held: &BTreeSet<NodeId>,
        names: &HashMap<String, Vec<NodeId>>,
        was: &Before,
    ) -> Found {
        let Some(last) = segs.last() else {
            return Found::Some(Vec::new());
        };
        // A bare name — most links — is answered by the name alone: no walk
        // up the tree for its path.
        let bare_name = segs.len() == 1;
        let answers = |n: NodeId| {
            if bare_name {
                link_key(&self.name_as(n, was)) == *last
            } else {
                self.path_keys(n, was).ends_with(segs)
            }
        };
        // Sticking (13 §3.5): a new node with the name takes no link over.
        if let Some(&n) = held.iter().find(|&&n| self.kind(n).is_some() && answers(n)) {
            return Found::Held(n);
        }
        // `names` is keyed by the names' link keys: its nodes answer a bare name.
        let mut found: Vec<NodeId> = names
            .get(last)
            .map(|c| {
                c.iter()
                    .copied()
                    .filter(|&n| bare_name || answers(n))
                    .collect()
            })
            .unwrap_or_default();
        if found.is_empty() {
            for (ext, canvas) in [(".canvas", true), (".excalidraw", false)] {
                let Some(stem) = last.strip_suffix(ext).filter(|s| !s.is_empty()) else {
                    continue;
                };
                let mut bare = segs.to_vec();
                if let Some(l) = bare.last_mut() {
                    *l = stem.to_owned();
                }
                let fits = |n: NodeId| match self.kind(n) {
                    Some(k) if canvas => k.has_canvas(),
                    Some(k) => k == NodeKind::Board,
                    None => false,
                };
                if let Some(&n) = held
                    .iter()
                    .find(|&&n| fits(n) && self.path_keys(n, was).ends_with(&bare))
                {
                    return Found::Held(n);
                }
                return match self.candidates(src, &bare, &BTreeSet::new(), names, was) {
                    Found::Some(f) => Found::Some(f.into_iter().filter(|&n| fits(n)).collect()),
                    held => held,
                };
            }
        }
        if segs.len() > 1 && found.len() > 1 {
            // A path: from the root exactly, then from the note's folder.
            let mut here: Vec<String> = self.path_keys(src, was);
            here.pop();
            here.extend(segs.iter().cloned());
            for whole in [segs.to_vec(), here] {
                let exact: Vec<NodeId> = found
                    .iter()
                    .copied()
                    .filter(|&n| self.path_keys(n, was) == whole)
                    .collect();
                if !exact.is_empty() {
                    found = exact;
                    break;
                }
            }
        }
        Found::Some(found)
    }

    /// Of several nodes with one name, the nearest to `src` by the tree (the
    /// deeper common network), then the shorter path, then the older (13 §3.5).
    pub(super) fn nearest(&self, src: NodeId, found: &[NodeId]) -> NodeId {
        self.by_nearness(src, found)[0]
    }

    /// `found` in the order of [`Self::nearest`], the nearest first.
    fn by_nearness(&self, src: NodeId, found: &[NodeId]) -> Vec<NodeId> {
        let chain = |n: NodeId| -> Vec<NodeId> { self.ancestors(n).into_iter().rev().collect() };
        let mine = chain(src);
        let created = |n: NodeId| {
            self.field(n, "createdAt")
                .and_then(|v| v.as_i64())
                .unwrap_or(i64::MAX)
        };
        let mut best: Vec<(std::cmp::Reverse<usize>, usize, i64, NodeId)> = found
            .iter()
            .map(|&n| {
                let up = chain(n);
                let common = mine.iter().zip(&up).take_while(|(a, b)| a == b).count();
                (std::cmp::Reverse(common), up.len(), created(n), n)
            })
            .collect();
        best.sort();
        best.into_iter().map(|b| b.3).collect()
    }

    /// The nodes a link of `note` may name (13 §3.5 steps 1–2), the nearest
    /// first, and the one its wire holds now: the report's «Выбрать цель»
    /// (13 §3.6). `link` is the target as written in the text.
    pub fn link_targets(&self, note: &str, link: &str) -> Result<LinkTargets> {
        let src = self.live(note)?;
        let segs = segments(&link_key(link));
        let names = self.link_names();
        let found = match self.candidates(src, &segs, &BTreeSet::new(), &names, &Before::new()) {
            Found::Some(f) => f,
            Found::Held(n) => vec![n],
        };
        let found: Vec<NodeId> = found.into_iter().filter(|&n| n != src).collect();
        let held: BTreeSet<NodeId> = self
            .outgoing_many(&BTreeSet::from([src]))
            .remove(&src)
            .unwrap_or_default()
            .wires
            .into_keys()
            .collect();
        let chosen = found.iter().copied().find(|n| held.contains(n));
        Ok(LinkTargets {
            targets: self
                .by_nearness(src, &found)
                .into_iter()
                .map(|n| LinkTarget {
                    id: n.to_text(),
                    path: self.path_parts(n).join("/"),
                })
                .collect(),
            chosen: chosen.map(|n| n.to_text()),
        })
    }

    /// The names of a node's canonical path from below the root, its own last.
    fn path_parts(&self, n: NodeId) -> Vec<String> {
        let mut parts: Vec<String> = self
            .ancestors(n)
            .into_iter()
            .rev()
            .filter(|a| *a != self.root)
            .map(|a| self.name(a))
            .collect();
        parts.push(self.name(n));
        parts
    }

    /// The shortest path that names `to` alone from `src` by 13 §3.5: its
    /// name, else with its networks one by one from below, else the whole
    /// path — as Obsidian writes a link to a name several notes share (R2 §2).
    fn unique_path(&self, src: NodeId, to: NodeId, names: &HashMap<String, Vec<NodeId>>) -> String {
        let parts = self.path_parts(to);
        for n in 1..=parts.len() {
            let tail = &parts[parts.len() - n..];
            let segs: Vec<String> = tail.iter().map(|p| link_key(p)).collect();
            let one = matches!(
                self.candidates(src, &segs, &BTreeSet::new(), names, &Before::new()),
                Found::Some(f) if f == [to]
            );
            if one {
                return tail.join("/");
            }
        }
        parts.join("/")
    }

    /// The report's «Выбрать цель» and «Привязать» (13 §3.5 «Исправление»,
    /// §3.6, S1 step 8): `note`'s links to `link` are written as the
    /// shortest path that names `target` alone — `[[Проекты/Игра/Диздок]]` —
    /// anchors and texts kept; with `alias`, what was written stays as the
    /// text: `[[Сценарий|Сценарий v2]]`. The text and the wire it makes are
    /// one step of undo: undone, both are as they were.
    pub fn pin_link(
        &mut self,
        note: &str,
        link: &str,
        target: &str,
        alias: bool,
    ) -> Result<Changeset> {
        let src = self.live(note)?;
        let to = self.live(target)?;
        if src == to {
            return Err(invalid("a note does not link to itself"));
        }
        let doc = format!("content/{}", src.to_text());
        self.ensure_doc(&doc)?;
        let text = self.docs[&doc].get_text("text").to_string();
        let names = self.link_names();
        let path = self.unique_path(src, to, &names);
        if path.contains(BREAKS_LINKS) {
            return Err(invalid(format!("no link can name {path} (13 §3.4)")));
        }
        let key = link_key(link);
        // (byte position, what is there, what it becomes), last first.
        let mut edits: Vec<(usize, String, String)> = Vec::new();
        for l in strata_markdown::scan(&text).links {
            if link_key(&l.target) != key {
                continue;
            }
            let Some((at, written, encode)) = target_span(&text, &l) else {
                continue;
            };
            let name = if encode {
                strata_markdown::percent_encode(&path)
            } else {
                path.clone()
            };
            let md = written
                .get(written.len().saturating_sub(3)..)
                .filter(|e| e.eq_ignore_ascii_case(".md"))
                .unwrap_or_default();
            if alias && !l.markdown && l.alias.is_none() {
                // Before `]]`: the text after `|` is what was written.
                edits.push((l.range.end - 2, String::new(), format!("|{}", l.target)));
            }
            edits.push((at, written.to_owned(), format!("{name}{md}")));
        }
        if edits.is_empty() {
            return Err(invalid(format!("no link [[{link}]] in the note")));
        }
        edits.sort_by_key(|e| std::cmp::Reverse(e.0));
        let mut fixed = text.clone();
        for (at, before, after) in &edits {
            fixed.replace_range(*at..*at + before.len(), after);
        }
        // The wires the fixed text makes, written with it (05 §8.2 rule 4).
        let (wires, _) = self.links_plan(&[(src, fixed.as_str())], now_ms());
        let mut label = Label::new("core.change.pinLink");
        label.params.insert("link".into(), link.into());
        label.params.insert("path".into(), path.into());
        let cs = self.write(ChangesetOrigin::User, label, |tx| {
            for (at, before, after) in &edits {
                if !tx.splice(&doc, *at, before, after)? {
                    return Err(invalid("the text changed under the fix"));
                }
            }
            for (d, map, key, value) in wires {
                tx.set(&d, &map, &key, value)?;
            }
            Ok(())
        })?;
        self.undo.push(cs.clone());
        self.redo.clear();
        Ok(cs)
    }

    /// The text wires and ghosts that leave each of `notes`, in one pass over
    /// the wires of their shards: a wire is kept in its `from`'s shard
    /// (10 §2.3), and a pass a note would cost an import's thousands of
    /// notes N × wires.
    pub(super) fn outgoing_many(&self, notes: &BTreeSet<NodeId>) -> HashMap<NodeId, Outgoing> {
        let mut out: HashMap<NodeId, Outgoing> =
            notes.iter().map(|&n| (n, Outgoing::default())).collect();
        let shards: BTreeSet<String> = notes.iter().map(|&n| self.index_doc(n)).collect();
        for doc in shards {
            let Some(index) = self.docs.get(&doc) else {
                continue;
            };
            index.get_map("edge").for_each(|key, v| {
                let ValueOrContainer::Value(LoroValue::Map(ends)) = v else {
                    return;
                };
                let end = |k: &str| ends.get(k).and_then(LoroValue::as_string);
                let Some(o) = end("from")
                    .and_then(|f| NodeId::parse(f).ok())
                    .and_then(|f| out.get_mut(&f))
                else {
                    return;
                };
                if let Some(x) = end("ghost") {
                    o.ghosts
                        .insert(link_key(x), (key.to_owned(), x.to_string()));
                } else if let Some(to) = end("to").and_then(|t| NodeId::parse(t).ok()) {
                    if read(index, "edgeOrigin", &format!("{key}|text")).is_some() {
                        o.wires.insert(to, key.to_owned());
                    }
                }
            });
        }
        out
    }

    /// What `note`'s `text` links to by the rule of 13 §3.5: nodes, and
    /// ghosts by key with the name as first written. `held` — the nodes its
    /// text wires reach now: a link that still fits one keeps it.
    pub(super) fn asked(
        &self,
        note: NodeId,
        text: &str,
        held: &BTreeSet<NodeId>,
        names: &HashMap<String, Vec<NodeId>>,
    ) -> Asked {
        let mut out = Asked::default();
        let mut seen: HashSet<String> = HashSet::new();
        for link in strata_markdown::scan(text).links {
            let k = link_key(&link.target);
            let segs = segments(&k);
            if segs.is_empty() {
                continue;
            }
            let target = match self.candidates(note, &segs, held, names, &Before::new()) {
                Found::Held(n) => Target::Node(n),
                Found::Some(found) => match found.len() {
                    0 => Target::Ghost,
                    1 => Target::Node(found[0]),
                    count => {
                        let n = self.nearest(note, &found);
                        if seen.insert(k.clone()) {
                            out.ambiguous.push((link.target.clone(), n, count));
                        }
                        Target::Node(n)
                    }
                },
            };
            match target {
                // A link to itself makes no wire (05 §8.2 rule 2).
                Target::Node(n) if n == note => {}
                Target::Node(n) => {
                    out.want.insert(n);
                    out.resolved.insert(k, n);
                }
                Target::Ghost => {
                    out.ghosts.entry(k).or_insert_with(|| link.target.clone());
                }
            }
        }
        out
    }

    /// The notes' wires and ghosts follow their `[[links]]` (05 §8.2 rule 4,
    /// §8.5): a link to a node adds the origin `text` to the wire, a link
    /// gone takes it away, a wire with no origin left goes; a link to no node
    /// is a ghost, and a ghost whose link now finds a node resolves. One
    /// system changeset for all the notes, outside undo (05 §11). A note in
    /// the trash keeps what it has: its wires are hidden with it.
    pub(super) fn relink(&mut self, notes: &BTreeSet<NodeId>) -> Result<Option<Changeset>> {
        let notes: Vec<NodeId> = notes
            .iter()
            .copied()
            .filter(|&n| self.alive(n) && self.kind(n) == Some(NodeKind::Note))
            .collect();
        let mut texts = Vec::with_capacity(notes.len());
        for &note in &notes {
            let doc = format!("content/{}", note.to_text());
            self.ensure_doc(&doc)?;
            texts.push(self.docs[&doc].get_text("text").to_string());
        }
        let pairs: Vec<(NodeId, &str)> = notes
            .iter()
            .copied()
            .zip(texts.iter().map(String::as_str))
            .collect();
        let (plan, _) = self.links_plan(&pairs, now_ms());
        if plan.is_empty() {
            return Ok(None);
        }
        self.write(
            ChangesetOrigin::System,
            Label::new("core.change.links"),
            |tx| {
                for (doc, map, key, value) in plan {
                    tx.set(&doc, &map, &key, value)?;
                }
                Ok(())
            },
        )
        .map(|c| Some(c).filter(|c| !c.writes.is_empty()))
    }

    /// The writes that make the notes' wires, ghosts and `itemsDue` follow
    /// their texts as they are now — [`Self::relink`]'s, and an import's for
    /// the notes it brings, in its own step (13 §3.1 step 7) — and what each
    /// text asked for, in the order of `notes`.
    pub(super) fn links_plan(&self, notes: &[(NodeId, &str)], ts: i64) -> (Writes, Vec<Asked>) {
        let names = self.link_names();
        let mut outgoing = self.outgoing_many(&notes.iter().map(|&(n, _)| n).collect());
        let at = || Some(Val::map([("at", Val::Int(ts))]));
        let mut plan: Writes = Vec::new();
        let mut asks: Vec<Asked> = Vec::with_capacity(notes.len());
        for &(note, text) in notes {
            let index = self.index_doc(note);
            let from = note.to_text();
            // The nearest open deadline of the note's Tasks items (13 §2.9.1,
            // ☑ Q-13-10): derived from the text, as its wires are.
            let due = strata_markdown::task_items(text)
                .into_iter()
                .filter(strata_markdown::TaskItem::open)
                .filter_map(|i| i.due)
                .min()
                .map(Val::Str);
            if read(&self.docs[&index], "itemsDue", &from) != due {
                plan.push((index.clone(), "itemsDue".to_owned(), from.clone(), due));
            }
            let have = outgoing.remove(&note).unwrap_or_default();
            let held: BTreeSet<NodeId> = have.wires.keys().copied().collect();
            let asked = self.asked(note, text, &held, &names);
            let (want, ghosts, resolved) = (&asked.want, &asked.ghosts, &asked.resolved);
            let origins = |key: &str| -> Vec<&'static str> {
                ORIGINS
                    .into_iter()
                    .filter(|o| {
                        read(&self.docs[&index], "edgeOrigin", &format!("{key}|{o}")).is_some()
                    })
                    .collect()
            };
            // Origins a resolved ghost hands to its new wire, besides `text`.
            let mut carried: BTreeMap<NodeId, Vec<&str>> = BTreeMap::new();
            for (k, (key, _)) in &have.ghosts {
                if ghosts.contains_key(k) {
                    continue;
                }
                let held_by = origins(key);
                let mut left = held_by.len();
                for o in held_by {
                    match resolved.get(k) {
                        Some(&n) => carried.entry(n).or_default().push(o),
                        None if o != "text" => continue,
                        None => {}
                    }
                    plan.push((
                        index.clone(),
                        "edgeOrigin".to_owned(),
                        format!("{key}|{o}"),
                        None,
                    ));
                    left -= 1;
                }
                if left == 0 {
                    plan.push((index.clone(), "edge".to_owned(), key.clone(), None));
                }
            }
            for (k, x) in ghosts {
                let key = EdgeKey::to_ghost(note, k).to_text();
                let ends = Val::map([
                    ("from", Val::str(from.clone())),
                    ("ghost", Val::str(x.clone())),
                ]);
                match have.ghosts.get(k) {
                    // The name as the text spells it now.
                    Some((_, was)) if was != x => {
                        plan.push((index.clone(), "edge".to_owned(), key, Some(ends)))
                    }
                    Some(_) => {}
                    None => {
                        plan.push((
                            index.clone(),
                            "edgeOrigin".to_owned(),
                            format!("{key}|text"),
                            at(),
                        ));
                        plan.push((index.clone(), "edge".to_owned(), key, Some(ends)));
                    }
                }
            }
            for &to in want {
                let key = EdgeKey::between(note, to).to_text();
                if !have.wires.contains_key(&to) {
                    let ends = Val::map([
                        ("from", Val::str(from.clone())),
                        ("to", Val::str(to.to_text())),
                    ]);
                    plan.push((
                        index.clone(),
                        "edgeOrigin".to_owned(),
                        format!("{key}|text"),
                        at(),
                    ));
                    plan.push((index.clone(), "edge".to_owned(), key.clone(), Some(ends)));
                }
                for o in carried
                    .get(&to)
                    .into_iter()
                    .flatten()
                    .filter(|o| **o != "text")
                {
                    plan.push((
                        index.clone(),
                        "edgeOrigin".to_owned(),
                        format!("{key}|{o}"),
                        at(),
                    ));
                }
            }
            for (to, key) in &have.wires {
                if want.contains(to) {
                    continue;
                }
                plan.push((
                    index.clone(),
                    "edgeOrigin".to_owned(),
                    format!("{key}|text"),
                    None,
                ));
                // The wire lives while it has an origin (10 §2.3).
                if origins(key).iter().all(|o| *o == "text") {
                    plan.push((index.clone(), "edge".to_owned(), key.clone(), None));
                }
            }
            asks.push(asked);
        }
        (plan, asks)
    }

    /// `[[Старое]]` → `[[Новое]]` in the notes whose links named a node the
    /// step renamed (13 §6.5, ☑ Q-10-9). Which links named it is 13 §3.5
    /// with the names before the step; a path keeps its networks and an
    /// `.md` stays. Point edits of the texts, stored as the editors' are,
    /// outside undo (15 §3.4): undoing the rename renames back, and the
    /// links follow it again. A name that breaks links (13 §3.4) is not
    /// written into them: they become ghosts.
    fn rewrite_links(&mut self, step: &Changeset) -> Result<()> {
        let mut was = Before::new();
        let mut now: HashMap<NodeId, String> = HashMap::new();
        for w in &step.writes {
            if !w.doc.starts_with("index/") || w.map != "name" {
                continue;
            }
            let (Some(before), Some(after)) = (
                w.before.as_ref().and_then(Val::as_str),
                w.after.as_ref().and_then(Val::as_str),
            ) else {
                continue;
            };
            let Ok(n) = NodeId::parse(&w.key) else {
                continue;
            };
            was.entry(n).or_insert_with(|| before.to_owned());
            now.insert(n, after.to_owned());
        }
        was.retain(|n, before| self.alive(*n) && now.get(n).is_some_and(|a| a != before));
        if was.is_empty() {
            return Ok(());
        }
        let mut notes = BTreeSet::new();
        for shard in self.index_shards() {
            let LoroValue::Map(edges) = shard.get_map("edge").get_value() else {
                continue;
            };
            for (key, v) in edges.iter() {
                let Some(v) = Val::from_loro(v) else { continue };
                let end = |k: &str| {
                    v.get(k)
                        .and_then(Val::as_str)
                        .and_then(|s| NodeId::parse(s).ok())
                };
                let (Some(from), Some(to)) = (end("from"), end("to")) else {
                    continue;
                };
                if was.contains_key(&to)
                    && read(shard, "edgeOrigin", &format!("{key}|text")).is_some()
                {
                    notes.insert(from);
                }
            }
        }
        // Live names as they were before the step.
        let mut names = self.link_names();
        for (n, before) in &was {
            if let Some(list) = names.get_mut(&link_key(&self.name(*n))) {
                list.retain(|m| m != n);
            }
            names.entry(link_key(before)).or_default().push(*n);
        }
        let mut outgoing = self.outgoing_many(&notes);
        for note in notes {
            if !self.alive(note) || self.kind(note) != Some(NodeKind::Note) {
                continue;
            }
            let doc = format!("content/{}", note.to_text());
            self.ensure_doc(&doc)?;
            let text = self.docs[&doc].get_text("text").to_string();
            let held: BTreeSet<NodeId> = outgoing
                .remove(&note)
                .unwrap_or_default()
                .wires
                .into_keys()
                .collect();
            // (byte position, length, the target as it is to be written)
            let mut edits: Vec<(usize, usize, String)> = Vec::new();
            for link in strata_markdown::scan(&text).links {
                let segs = segments(&link_key(&link.target));
                let Target::Node(n) = self.resolve(note, &segs, &held, &names, &was) else {
                    continue;
                };
                let Some(name) = now.get(&n).filter(|_| was.contains_key(&n)) else {
                    continue;
                };
                if name.contains(BREAKS_LINKS) {
                    continue;
                }
                // A Markdown link's path as written, `%20` and all (13 §2.5).
                let Some((at, target, encode)) = target_span(&text, &link) else {
                    continue;
                };
                let name = if encode {
                    strata_markdown::percent_encode(name)
                } else {
                    name.clone()
                };
                let (head, last) = match target.rfind('/') {
                    Some(i) => (&target[..=i], &target[i + 1..]),
                    None => ("", target),
                };
                let md = last
                    .get(last.len().saturating_sub(3)..)
                    .filter(|e| e.eq_ignore_ascii_case(".md"))
                    .unwrap_or_default();
                let written = format!("{head}{name}{md}");
                if written != target {
                    edits.push((at, target.len(), written));
                }
            }
            if edits.is_empty() {
                continue;
            }
            let d = &self.docs[&doc];
            let vv = d.oplog_vv();
            let t = d.get_text("text");
            for (at, len, written) in edits.iter().rev() {
                t.delete_utf8(*at, *len).map_err(engine)?;
                t.insert_utf8(*at, written).map_err(engine)?;
            }
            d.commit();
            let bytes = d.export(ExportMode::updates(&vv)).map_err(engine)?;
            if let Err(e) = self.store.append(&doc, &bytes, now_ms()) {
                // Memory goes back to what the store holds (10 §3.3).
                let d = load(&self.store, &doc)?.unwrap_or_default();
                self.docs.insert(doc, d);
                return Err(e.into());
            }
            self.note_edit(&doc);
        }
        Ok(())
    }

    /// After a step that named, made, removed, trashed, restored or moved
    /// nodes, the links it may change find their nodes again: ghosts that a
    /// new name answers resolve (05 §8.5), and a wire whose node no longer
    /// answers its link becomes a ghost (13 §3.5). Undo and redo too, since
    /// the text wires of 05 §11 are the system's, outside the step.
    pub(super) fn links_after(
        &mut self,
        step: &Changeset,
        rewrite: bool,
    ) -> Result<Option<Changeset>> {
        self.links_after_but(step, rewrite, &BTreeSet::new())
    }

    /// [`Self::links_after`] for every note but `done`: an import's notes,
    /// whose wires its own step made (13 §3.1 step 7).
    pub(super) fn links_after_but(
        &mut self,
        step: &Changeset,
        rewrite: bool,
        done: &BTreeSet<NodeId>,
    ) -> Result<Option<Changeset>> {
        if rewrite {
            self.rewrite_links(step)?;
        }
        // A workspace with no note besides `done` — a new one an import
        // filled — has nothing to look for: no pass over its wires.
        if !done.is_empty() && !self.notes_besides(done) {
            return Ok(None);
        }
        let mut changed: BTreeSet<NodeId> = BTreeSet::new();
        let mut paths = false;
        for w in &step.writes {
            if !w.doc.starts_with("index/") || !NAMING.contains(&w.map.as_str()) {
                continue;
            }
            let Ok(n) = NodeId::parse(&w.key) else {
                continue;
            };
            changed.insert(n);
            // A network's name and a node's place are the paths below them.
            let canvas = |v: &Option<Val>| {
                v.as_ref()
                    .and_then(Val::as_str)
                    .and_then(|s| {
                        serde_json::from_value::<NodeKind>(serde_json::Value::String(s.to_owned()))
                            .ok()
                    })
                    .is_some_and(NodeKind::has_canvas)
            };
            paths |= w.map == "primaryNet"
                || self.kind(n).is_some_and(NodeKind::has_canvas)
                || (w.map == "kind" && (canvas(&w.before) || canvas(&w.after)));
        }
        if changed.is_empty() {
            return Ok(None);
        }
        let keys: HashSet<String> = changed
            .iter()
            .filter(|&&n| self.alive(n))
            .map(|&n| link_key(&self.name(n)))
            .collect();
        // Text wires into the nodes changed, and into everything below them
        // when a path changed.
        let mut into = changed.clone();
        if paths {
            let children = self.children();
            let mut stack: Vec<NodeId> = changed.iter().copied().collect();
            while let Some(n) = stack.pop() {
                for &c in children.get(&n).into_iter().flatten() {
                    if into.insert(c) {
                        stack.push(c);
                    }
                }
            }
        }
        let mut notes: BTreeSet<NodeId> = changed
            .iter()
            .copied()
            .filter(|&n| self.kind(n) == Some(NodeKind::Note))
            .collect();
        for shard in self.index_shards() {
            let LoroValue::Map(edges) = shard.get_map("edge").get_value() else {
                continue;
            };
            for (key, v) in edges.iter() {
                let Some(v) = Val::from_loro(v) else { continue };
                let Some(from) = v
                    .get("from")
                    .and_then(Val::as_str)
                    .and_then(|s| NodeId::parse(s).ok())
                else {
                    continue;
                };
                if let Some(x) = v.get("ghost").and_then(Val::as_str) {
                    let k = link_key(x);
                    let last = k.rsplit('/').find(|s| !s.is_empty()).unwrap_or_default();
                    if keys.contains(last) || (paths && k.contains('/')) {
                        notes.insert(from);
                    }
                } else if let Some(to) = v
                    .get("to")
                    .and_then(Val::as_str)
                    .and_then(|s| NodeId::parse(s).ok())
                {
                    if into.contains(&to)
                        && read(shard, "edgeOrigin", &format!("{key}|text")).is_some()
                    {
                        notes.insert(from);
                    }
                }
            }
        }
        notes.retain(|n| !done.contains(n));
        self.relink(&notes)
    }
}
