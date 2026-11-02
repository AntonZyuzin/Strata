//! Paths (05 §9.3, 09 §4): a path's text and what it names. A path runs
//! through any placements, not the primary ones only (09 §4.2): `/A/B/C` is
//! right when C lies in B and B in A. One resolution for the path bar, the
//! path mode of `Ctrl+O`, the palette and MCP (09 §4.4).

use super::{Store, Workspace};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use strata_model::{NodeId, NodeKind};
use strata_search::{norm, rank_names};

/// How many names a segment that names nothing is offered instead (09 §4.4).
const HINTS: usize = 8;

/// A path as written (09 §4.2): from the root when it starts with `/`, else
/// from the network one is in; its segments unescaped.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PathText {
    pub absolute: bool,
    pub segments: Vec<String>,
}

/// Reads a path (09 §4.2): segments between `/`, `\/` a slash of a name and
/// `\\` its backslash; a backslash before anything else is itself. Empty
/// segments — `//`, a `/` at the end — name nothing and are skipped.
pub fn parse_path(text: &str) -> PathText {
    let text = text.trim();
    let mut segments = Vec::new();
    let mut seg = String::new();
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\\' => match chars.peek() {
                Some(&next @ ('/' | '\\')) => {
                    seg.push(next);
                    chars.next();
                }
                _ => seg.push('\\'),
            },
            '/' => {
                if !seg.trim().is_empty() {
                    segments.push(std::mem::take(&mut seg));
                }
                seg.clear();
            }
            c => seg.push(c),
        }
    }
    if !seg.trim().is_empty() {
        segments.push(seg);
    }
    PathText {
        absolute: text.starts_with('/'),
        segments,
    }
}

/// A name as a segment of a path (09 §4.2): its `\` as `\\`, its `/` as `\/`.
pub fn escape_segment(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for c in name.chars() {
        if matches!(c, '/' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// The text of a path from the root (09 §4.2): `/` and the names under the
/// root, escaped; the root alone is `/`.
pub fn path_text(names: &[String]) -> String {
    if names.is_empty() {
        return "/".to_owned();
    }
    names
        .iter()
        .map(|n| format!("/{}", escape_segment(n)))
        .collect()
}

/// A node a path names, with the way to it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PathHit {
    /// From the root to the node, both included, `[id, name]`: the way the
    /// path went — its entry path (05 §9.3).
    pub path: Vec<(String, String)>,
    pub kind: NodeKind,
    /// Its placement in the network before it on the way is its primary one
    /// (05 §5); the root's is.
    pub primary: bool,
}

/// A segment that named nothing (09 §4.4).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PathMissing {
    /// Which segment, from 0, as [`parse_path`] reads them.
    pub at: usize,
    /// The names nearest to it among the nodes where the path had got, the
    /// nearest first (09 §2.3).
    pub near: Vec<PathHit>,
}

/// What a path names (09 §4.4): one node — go there; several — a choice
/// (09 §4.5); none — `missing` says where it stopped.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Resolved {
    pub found: Vec<PathHit>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub missing: Option<PathMissing>,
}

impl<S: Store> Workspace<S> {
    /// Resolves `text` by 09 §4.4 from `base`, the entry path of the network
    /// one is in (ids from the root): `..` goes up the way one came. A base
    /// that no longer holds — a placement on it was taken away — gives way to
    /// its last network's canonical path, and a base that names nothing alive
    /// to the root. Segments compare by `norm()` (09 §2.2) with the name and
    /// the aliases (05 §6.1).
    pub fn resolve_path(&self, text: &str, base: &[String]) -> Resolved {
        let path = parse_path(text);
        let children = self.children();
        let start = if path.absolute {
            vec![self.root]
        } else {
            self.entry_or_canonical(base, &children)
        };
        let mut set: Vec<Vec<NodeId>> = vec![start];
        for (at, seg) in path.segments.iter().enumerate() {
            match seg.trim() {
                "." => continue,
                ".." => {
                    // The way one came; the root has no way further up.
                    for way in &mut set {
                        if way.len() > 1 {
                            way.pop();
                        }
                    }
                    set = self.distinct(set);
                    continue;
                }
                _ => {}
            }
            let want = norm(seg);
            let mut next = Vec::new();
            for way in &set {
                for child in self.live_children(&children, way) {
                    let named = norm(&self.name(child)) == want
                        || self
                            .set_of(child, "aliases")
                            .iter()
                            .any(|a| norm(a) == want);
                    if named {
                        let mut further = way.clone();
                        further.push(child);
                        next.push(further);
                    }
                }
            }
            if next.is_empty() {
                let kids: Vec<Vec<NodeId>> = set
                    .iter()
                    .flat_map(|way| {
                        self.live_children(&children, way).map(move |child| {
                            let mut further = way.clone();
                            further.push(child);
                            further
                        })
                    })
                    .collect();
                let kids = self.distinct(kids);
                let names: Vec<String> = kids
                    .iter()
                    .map(|way| self.name(*way.last().unwrap_or(&self.root)))
                    .collect();
                let near = rank_names(seg, &names, HINTS)
                    .into_iter()
                    .filter_map(|(i, _)| kids.get(i as usize))
                    .map(|way| self.hit(way))
                    .collect();
                return Resolved {
                    found: Vec::new(),
                    missing: Some(PathMissing { at, near }),
                };
            }
            set = self.distinct(next);
        }
        Resolved {
            found: set.iter().map(|way| self.hit(way)).collect(),
            missing: None,
        }
    }

    /// `base` while each network on it lies in the one before, from the
    /// root; else the canonical path of its last network, else the root.
    fn entry_or_canonical(
        &self,
        base: &[String],
        children: &HashMap<NodeId, Vec<NodeId>>,
    ) -> Vec<NodeId> {
        let ids: Vec<NodeId> = base
            .iter()
            .filter_map(|id| NodeId::parse(id).ok())
            .collect();
        let holds = ids.len() == base.len()
            && ids.first() == Some(&self.root)
            && ids.iter().all(|&n| self.alive(n))
            && ids
                .windows(2)
                .all(|w| children.get(&w[0]).is_some_and(|c| c.contains(&w[1])));
        if holds {
            return ids;
        }
        match ids.last() {
            Some(&last)
                if self.alive(last) && (last == self.root || self.primary_of(last).is_some()) =>
            {
                let mut way: Vec<NodeId> = self.ancestors(last).into_iter().rev().collect();
                way.push(last);
                way
            }
            _ => vec![self.root],
        }
    }

    /// The live nodes placed in the last network of `way`, by id: the
    /// oldest first, as ids of UUIDv7 go.
    fn live_children<'a>(
        &'a self,
        children: &'a HashMap<NodeId, Vec<NodeId>>,
        way: &[NodeId],
    ) -> impl Iterator<Item = NodeId> + 'a {
        let at = way.last().copied().unwrap_or(self.root);
        let mut kids: Vec<NodeId> = children
            .get(&at)
            .map(|c| c.iter().copied().filter(|&n| self.alive(n)).collect())
            .unwrap_or_default();
        kids.sort();
        kids.into_iter()
    }

    /// One way to each node, the one with the fewest appearances on it —
    /// the canonical path when it is among them — then by the ids on it.
    fn distinct(&self, mut ways: Vec<Vec<NodeId>>) -> Vec<Vec<NodeId>> {
        let detours = |way: &[NodeId]| {
            way.windows(2)
                .filter(|w| self.primary_of(w[1]) != Some(w[0]))
                .count()
        };
        let mut keyed: Vec<(usize, Vec<NodeId>)> =
            ways.drain(..).map(|w| (detours(&w), w)).collect();
        keyed.sort();
        let mut seen = HashSet::new();
        let mut out: Vec<Vec<NodeId>> = keyed
            .into_iter()
            .filter(|(_, w)| seen.insert(w.last().copied()))
            .map(|(_, w)| w)
            .collect();
        // The primaries first, then the oldest (09 §4.5): ids of UUIDv7 keep time.
        out.sort_by_key(|w| (!self.last_primary(w), w.last().copied()));
        out
    }

    fn last_primary(&self, way: &[NodeId]) -> bool {
        match way {
            [.., before, last] => self.primary_of(*last) == Some(*before),
            _ => true,
        }
    }

    fn hit(&self, way: &[NodeId]) -> PathHit {
        let last = way.last().copied().unwrap_or(self.root);
        PathHit {
            path: way.iter().map(|&n| (n.to_text(), self.name(n))).collect(),
            kind: self.kind(last).unwrap_or(NodeKind::Network),
            primary: self.last_primary(way),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_path_reads_its_escapes_and_skips_empty_segments() {
        assert_eq!(
            parse_path("/Проекты/Игра/Боёвка"),
            PathText {
                absolute: true,
                segments: vec!["Проекты".into(), "Игра".into(), "Боёвка".into()],
            }
        );
        assert_eq!(
            parse_path(r"/A\/B/C\\D/"),
            PathText {
                absolute: true,
                segments: vec!["A/B".into(), r"C\D".into()],
            }
        );
        assert_eq!(
            parse_path(r"../Арт\x//  "),
            PathText {
                absolute: false,
                segments: vec!["..".into(), r"Арт\x".into()],
            }
        );
        assert_eq!(
            parse_path("/"),
            PathText {
                absolute: true,
                segments: vec![],
            }
        );
    }

    #[test]
    fn a_name_escapes_back_to_the_same_segment() {
        for name in ["Проекты", "A/B", r"C\D", r"\/", "Спринт 3"] {
            let text = path_text(&[name.to_owned(), "x".to_owned()]);
            assert_eq!(
                parse_path(&text).segments,
                vec![name.to_owned(), "x".to_owned()]
            );
        }
        assert_eq!(path_text(&[]), "/");
        assert_eq!(path_text(&["A/B".to_owned()]), r"/A\/B");
    }
}
