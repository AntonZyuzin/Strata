//! The names of a workspace and their ranking (09 §2.5–2.6).

use crate::find::Find;
use crate::norm::{initials, norm, switch_layout};
use crate::stage::{Asked, prefix_distance, score, stage_of, typo_stage, typos_allowed};
use serde::Deserialize;
use std::collections::{BTreeMap, HashMap};
use std::hash::{BuildHasherDefault, Hasher};
use strata_model::{Flag, NodeKind};

/// The index's own tables hash small keys — trigrams, numbers — with
/// FxHash's mix (rustc's): far cheaper than SipHash, and the names are the
/// device's own, so flooding is no concern.
#[derive(Clone, Copy, Debug, Default)]
struct Fx(u64);

impl Fx {
    fn add(&mut self, w: u64) {
        self.0 = (self.0.rotate_left(5) ^ w).wrapping_mul(0x51_7c_c1_b7_27_22_0a_95);
    }
}

impl Hasher for Fx {
    fn finish(&self) -> u64 {
        self.0
    }

    fn write(&mut self, bytes: &[u8]) {
        for chunk in bytes.chunks(8) {
            let mut b = [0u8; 8];
            b[..chunk.len()].copy_from_slice(chunk);
            self.add(u64::from_le_bytes(b));
        }
    }

    fn write_u32(&mut self, i: u32) {
        self.add(u64::from(i));
    }

    fn write_u64(&mut self, i: u64) {
        self.add(i);
    }

    fn write_usize(&mut self, i: usize) {
        self.add(i as u64);
    }
}

type Fast<K, V> = HashMap<K, V, BuildHasherDefault<Fx>>;

/// A node as the index reads it: the core's tree item, its other fields ignored.
#[derive(Clone, Debug, Deserialize)]
pub struct Item {
    pub id: String,
    pub name: String,
    pub kind: NodeKind,
    /// The network of its primary placement; none for the root.
    #[serde(default)]
    pub parent: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub flags: Vec<Flag>,
    /// Its other names (05 §6.1 `aliases`): they rank 50 below the name.
    #[serde(default)]
    pub aliases: Vec<String>,
}

impl Item {
    /// A final status or the flag «Пауза»: ranked lower (§2.5).
    fn inactive(&self) -> bool {
        matches!(self.status.as_deref(), Some("done" | "cancelled"))
            || self.flags.contains(&Flag::Pause)
    }
}

/// This device's visits of a node (05 §13): when it was last opened, in
/// milliseconds since the epoch, and how often in the last 30 days.
#[derive(Clone, Copy, Debug, Default, Deserialize)]
pub struct Visit {
    pub at: i64,
    pub count: u32,
}

/// Where a query looks.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum Scope {
    /// The whole workspace (`Ctrl+O`).
    #[default]
    All,
    /// The nodes placed in a network: those of the canvas (`Ctrl+F`, the Tab menu).
    In { net: String },
    /// Everything under a node, at any depth (`Ctrl+F` with «поддерево», the star map's cluster).
    Under { net: String },
}

/// What the ranking knows besides the names (§2.5).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct Context {
    /// At most this many results; 50 by default (09 §3.4).
    pub limit: Option<usize>,
    pub scope: Scope,
    /// The network on the canvas: nodes placed in it rank 80 higher, in its
    /// parent, child or sibling networks 50.
    pub here: Option<String>,
    /// This device's visits, by node id.
    pub visits: HashMap<String, Visit>,
    /// Now, for the visits' age.
    pub now: i64,
}

/// A searchable text of a node: its name or one of its aliases.
#[derive(Debug)]
struct Rec {
    node: u32,
    norm: String,
    initials: String,
    /// Its words, as numbers in the sorted words.
    words: Vec<u32>,
    alias: bool,
}

/// Token checks of the typo stage at most (§2.6).
const TYPO_CHECKS: usize = 50_000;
const DAY_MS: f64 = 86_400_000.0;
/// Pads a word's start for its trigrams: a prefix keeps its first ones.
const START: char = '\u{2}';

/// The names of a workspace (09 §2.6): words sorted for prefixes, the
/// initials, trigrams of the names for substrings and of the words for
/// typos. Built from the core's tree; rebuilt when it changes.
#[derive(Debug, Default)]
pub struct Index {
    items: Vec<Item>,
    /// Normalized names: the order of equal scores.
    names: Vec<String>,
    /// Names' lengths in letters: shorter first (§2.5).
    lengths: Vec<u32>,
    parent: Vec<Option<u32>>,
    by_id: HashMap<String, u32>,
    recs: Vec<Rec>,
    /// Records by their text, for prefixes of the whole name.
    by_text: Vec<u32>,
    /// Records by their initials.
    by_initials: Vec<u32>,
    /// Every word of every record, sorted, with its records.
    tokens: Vec<String>,
    token_letters: Vec<Vec<char>>,
    token_recs: Vec<Vec<u32>>,
    trigrams: Fast<[char; 3], Vec<u32>>,
    word_trigrams: Fast<[char; 3], Vec<u32>>,
}

fn trigrams(chars: &[char]) -> impl Iterator<Item = [char; 3]> + '_ {
    chars.windows(3).map(|w| [w[0], w[1], w[2]])
}

impl Index {
    pub fn new(items: Vec<Item>) -> Self {
        let by_id: HashMap<String, u32> = items
            .iter()
            .enumerate()
            .map(|(i, it)| (it.id.clone(), i as u32))
            .collect();
        let parent = items
            .iter()
            .map(|it| it.parent.as_ref().and_then(|p| by_id.get(p).copied()))
            .collect();
        let names: Vec<String> = items.iter().map(|it| norm(&it.name)).collect();
        let mut recs = Vec::new();
        for (i, it) in items.iter().enumerate() {
            let node = i as u32;
            recs.push(Rec {
                node,
                norm: names[i].clone(),
                initials: initials(&names[i]),
                words: Vec::new(),
                alias: false,
            });
            for a in &it.aliases {
                let text = norm(a);
                recs.push(Rec {
                    node,
                    initials: initials(&text),
                    words: Vec::new(),
                    norm: text,
                    alias: true,
                });
            }
        }
        recs.retain(|r| !r.norm.is_empty());
        let mut words: BTreeMap<&str, Vec<u32>> = BTreeMap::new();
        let mut tri: Fast<[char; 3], Vec<u32>> = Fast::default();
        let mut grams: Vec<[char; 3]> = Vec::new();
        for (r, rec) in recs.iter().enumerate() {
            let r = r as u32;
            for w in rec.norm.split(' ') {
                let list = words.entry(w).or_default();
                if list.last() != Some(&r) {
                    list.push(r);
                }
            }
            let chars: Vec<char> = rec.norm.chars().collect();
            grams.clear();
            grams.extend(trigrams(&chars));
            grams.sort_unstable();
            grams.dedup();
            for &t in &grams {
                tri.entry(t).or_default().push(r);
            }
        }
        let mut by_text: Vec<u32> = (0..recs.len() as u32).collect();
        by_text.sort_unstable_by(|&a, &b| {
            recs[a as usize]
                .norm
                .cmp(&recs[b as usize].norm)
                .then(a.cmp(&b))
        });
        let mut by_initials: Vec<u32> = (0..recs.len() as u32).collect();
        by_initials.sort_unstable_by(|&a, &b| {
            recs[a as usize]
                .initials
                .cmp(&recs[b as usize].initials)
                .then(a.cmp(&b))
        });
        let tokens: Vec<String> = words.keys().map(|w| (*w).to_owned()).collect();
        let token_letters = tokens.iter().map(|t| t.chars().collect()).collect();
        let token_recs: Vec<Vec<u32>> = words.into_values().collect();
        for (t, list) in token_recs.iter().enumerate() {
            for &r in list {
                recs[r as usize].words.push(t as u32);
            }
        }
        let mut word_tri: Fast<[char; 3], Vec<u32>> = Fast::default();
        for (t, w) in tokens.iter().enumerate() {
            let padded: Vec<char> = std::iter::once(START).chain(w.chars()).collect();
            grams.clear();
            grams.extend(trigrams(&padded));
            grams.sort_unstable();
            grams.dedup();
            for &g in &grams {
                word_tri.entry(g).or_default().push(t as u32);
            }
        }
        let lengths = items
            .iter()
            .map(|it| it.name.chars().count() as u32)
            .collect();
        Index {
            items,
            names,
            lengths,
            parent,
            by_id,
            recs,
            by_text,
            by_initials,
            tokens,
            token_letters,
            token_recs,
            trigrams: tri,
            word_trigrams: word_tri,
        }
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    pub fn item(&self, node: u32) -> Option<&Item> {
        self.items.get(node as usize)
    }

    /// The nodes whose names match `query`, best first (§2.3, §2.5): node
    /// numbers in the order of the items the index was built from.
    pub fn query(&self, query: &str, ctx: &Context) -> Vec<u32> {
        let inside = self.scope(&ctx.scope);
        let direct = norm(query);
        let other = norm(&switch_layout(query));
        let mut best: Fast<u32, i32> = Fast::default();
        for (q, offset) in [(&direct, 0), (&other, -20)] {
            if q.is_empty() || (offset != 0 && *q == direct) {
                continue;
            }
            let asked = Asked::new(q);
            let near = self.near(&asked);
            for r in self.candidates(&asked, &near) {
                let rec = &self.recs[r as usize];
                if !inside(rec.node) {
                    continue;
                }
                let found = stage_of(&asked, &rec.norm, &rec.initials).or_else(|| {
                    // Distances to the words near each query word are known already.
                    let nearest = |w: &Fast<u32, usize>| {
                        rec.words.iter().filter_map(|t| w.get(t).copied()).min()
                    };
                    (asked.len > 2)
                        .then(|| typo_stage(near.iter().map(nearest)))
                        .flatten()
                });
                if let Some(s) = found {
                    let s = s + offset - if rec.alias { 50 } else { 0 };
                    let slot = best.entry(rec.node).or_insert(s);
                    *slot = (*slot).max(s);
                }
            }
        }
        let signals = self.signals(query.chars().count(), ctx);
        let mut ranked: Vec<(i32, u32)> =
            best.into_iter().map(|(n, s)| (s + signals(n), n)).collect();
        let order = |a: &(i32, u32), b: &(i32, u32)| {
            b.0.cmp(&a.0)
                .then_with(|| self.names[a.1 as usize].cmp(&self.names[b.1 as usize]))
                .then_with(|| {
                    self.items[a.1 as usize]
                        .id
                        .cmp(&self.items[b.1 as usize].id)
                })
        };
        // The first `limit` only are sorted (§2.6: a partial sort).
        let limit = ctx.limit.unwrap_or(50);
        if ranked.len() > limit && limit > 0 {
            ranked.select_nth_unstable_by(limit - 1, order);
            ranked.truncate(limit);
        }
        ranked.sort_unstable_by(order);
        ranked.truncate(limit);
        ranked.into_iter().map(|(_, n)| n).collect()
    }

    /// The nodes in `scope` that `find` matches (09 §3.3), in the items' order.
    pub fn find(&self, find: &Find, case: bool, scope: &Scope) -> Vec<u32> {
        let inside = self.scope(scope);
        (0..self.items.len() as u32)
            .filter(|&n| {
                inside(n)
                    && find.matches_named(&self.items[n as usize], &self.names[n as usize], case)
            })
            .collect()
    }

    /// Records that may match at some stage, each once (§2.6): a superset,
    /// the stage checks each. Every list is narrowed by every word of the query.
    fn candidates(&self, a: &Asked, near: &[Fast<u32, usize>]) -> Vec<u32> {
        let mut seen = vec![false; self.recs.len()];
        let mut out = Vec::new();
        let mut add = |r: u32, out: &mut Vec<u32>| {
            if !std::mem::replace(&mut seen[r as usize], true) {
                out.push(r);
            }
        };
        // Exact and prefix: the whole text begins with the query.
        let from = self
            .by_text
            .partition_point(|&r| self.recs[r as usize].norm.as_str() < a.q.as_str());
        for &r in &self.by_text[from..] {
            if !self.recs[r as usize].norm.starts_with(&a.q) {
                break;
            }
            add(r, &mut out);
        }
        if a.len >= 2 {
            let from = self
                .by_initials
                .partition_point(|&r| self.recs[r as usize].initials.as_str() < a.compact.as_str());
            for &r in &self.by_initials[from..] {
                if !self.recs[r as usize].initials.starts_with(&a.compact) {
                    break;
                }
                add(r, &mut out);
            }
        }
        if a.len <= 2 {
            return out;
        }
        // Word prefixes: each word of the query begins a word of the record.
        let prefixes: Vec<Vec<u32>> = a.words.iter().map(|w| self.prefix_tokens(w)).collect();
        for r in self.with_every(&prefixes) {
            add(r, &mut out);
        }
        // A substring holds every trigram of the query: the rarest one's records.
        let letters: Vec<char> = a.q.chars().collect();
        let rarest = trigrams(&letters)
            .map(|t| self.trigrams.get(&t).map_or(&[][..], Vec::as_slice))
            .min_by_key(|l| l.len());
        for &r in rarest.unwrap_or(&[]) {
            if self.recs[r as usize].norm.contains(&a.q) {
                add(r, &mut out);
            }
        }
        // Typos: each word near a word of the record, a short one its prefix.
        let near: Vec<Vec<u32>> = near.iter().map(|m| m.keys().copied().collect()).collect();
        for r in self.with_every(&near) {
            add(r, &mut out);
        }
        out
    }

    /// For each query word, the words near it with their distances (§2.3,
    /// «Опечатки»): within its typos by their prefixes, a short word's
    /// prefixes as they are. Empty for a query of 1–2 letters.
    fn near(&self, a: &Asked) -> Vec<Fast<u32, usize>> {
        if a.len <= 2 {
            return Vec::new();
        }
        a.letters
            .iter()
            .zip(&a.words)
            .map(|(l, w)| match typos_allowed(l.len()) {
                0 => self.prefix_tokens(w).into_iter().map(|t| (t, 0)).collect(),
                max => self.near_tokens(l, max),
            })
            .collect()
    }

    /// The words that begin with `w`: neighbours in the sorted list.
    fn prefix_tokens(&self, w: &str) -> Vec<u32> {
        let from = self.tokens.partition_point(|t| t.as_str() < w);
        (from..self.tokens.len())
            .take_while(|&t| self.tokens[t].starts_with(w))
            .map(|t| t as u32)
            .collect()
    }

    /// The records that have, for every list, a word of it.
    fn with_every(&self, lists: &[Vec<u32>]) -> Vec<u32> {
        let Some((first, rest)) = lists.split_first() else {
            return Vec::new();
        };
        let mut hits = vec![0u16; self.recs.len()];
        let mut start: Vec<u32> = Vec::new();
        for &t in first {
            for &r in &self.token_recs[t as usize] {
                if hits[r as usize] == 0 {
                    hits[r as usize] = 1;
                    start.push(r);
                }
            }
        }
        for (i, list) in rest.iter().enumerate() {
            let (had, now) = (i as u16 + 1, i as u16 + 2);
            for &t in list {
                for &r in &self.token_recs[t as usize] {
                    if hits[r as usize] == had {
                        hits[r as usize] = now;
                    }
                }
            }
        }
        let all = lists.len() as u16;
        start.retain(|&r| hits[r as usize] == all);
        start
    }

    /// Words within `max` typos of `w` by their prefixes (§2.6): those that
    /// share enough trigrams, checked by the distance itself.
    fn near_tokens(&self, w: &[char], max: usize) -> Fast<u32, usize> {
        let padded: Vec<char> = std::iter::once(START).chain(w.iter().copied()).collect();
        // A typo changes at most four trigrams: three, a swap of two letters four.
        let need = (w.len() as i64 - 1) - 4 * max as i64;
        let pool: Vec<u32> = if need <= 0 {
            (0..self.tokens.len() as u32).collect()
        } else {
            let mut shared: Fast<u32, i64> = Fast::default();
            let mut grams: Vec<[char; 3]> = trigrams(&padded).collect();
            grams.sort_unstable();
            grams.dedup();
            for g in grams {
                for &t in self.word_trigrams.get(&g).map_or(&[][..], Vec::as_slice) {
                    *shared.entry(t).or_default() += 1;
                }
            }
            shared
                .into_iter()
                .filter(|&(_, n)| n >= need)
                .map(|(t, _)| t)
                .collect()
        };
        pool.into_iter()
            .take(TYPO_CHECKS)
            .filter_map(|t| {
                let d = prefix_distance(w, &self.token_letters[t as usize], max);
                (d <= max).then_some((t, d))
            })
            .collect()
    }

    /// Whether a node is in `scope`: by its parents' ids, so a canvas's
    /// collection need not hold its own network.
    fn scope<'a>(&'a self, scope: &'a Scope) -> impl Fn(u32) -> bool + 'a {
        let (net, deep) = match scope {
            Scope::All => (None, false),
            Scope::In { net } => (Some(net.as_str()), false),
            Scope::Under { net } => (Some(net.as_str()), true),
        };
        move |n: u32| {
            let Some(net) = net else {
                return true;
            };
            let mut at = n;
            for _ in 0..64 {
                match self.items[at as usize].parent.as_deref() {
                    Some(p) if p == net => return true,
                    Some(p) if deep => match self.by_id.get(p) {
                        Some(&i) => at = i,
                        None => return false,
                    },
                    _ => return false,
                }
            }
            false
        }
    }

    /// The signals of §2.5 besides the stage, for a query of `asked` letters.
    fn signals<'a>(&'a self, asked: usize, ctx: &'a Context) -> impl Fn(u32) -> i32 + 'a {
        let up = |x: u32| self.parent[x as usize];
        let here = ctx.here.as_ref().and_then(|h| self.by_id.get(h).copied());
        let above = here.and_then(up);
        move |n: u32| {
            let item = &self.items[n as usize];
            let mut s = 0.0;
            if let Some(v) = ctx.visits.get(&item.id) {
                let days = ((ctx.now - v.at) as f64 / DAY_MS).max(0.0);
                s += 150.0 * 0.5f64.powf(days / 7.0);
                s += (20.0 * (1.0 + f64::from(v.count)).log2()).min(100.0);
            }
            if let Some(h) = here {
                match up(n) {
                    Some(p) if p == h => s += 80.0,
                    // The parent, a child or a sibling of the network on the canvas.
                    Some(p)
                        if Some(p) == above
                            || up(p) == Some(h)
                            || (above.is_some() && up(p) == above) =>
                    {
                        s += 50.0
                    }
                    _ => {}
                }
            }
            if item.flags.contains(&Flag::Key) {
                s += 40.0;
            }
            if item.inactive() {
                s -= 60.0;
            }
            let longer = (self.lengths[n as usize] as usize)
                .saturating_sub(asked)
                .min(30);
            s as i32 - longer as i32
        }
    }
}

/// A short list ranked by the stage and the length only (§2.5 without the
/// node's signals): the kinds and templates of the Tab menu. Indices into
/// `names` with their scores, best first; 1000 is the name exactly.
pub fn rank_names(query: &str, names: &[String], limit: usize) -> Vec<(u32, i32)> {
    let asked = query.chars().count();
    let mut ranked: Vec<(i32, String, u32)> = names
        .iter()
        .enumerate()
        .filter_map(|(i, n)| {
            let s = score(query, n)?;
            let longer = n.chars().count().saturating_sub(asked).min(30) as i32;
            Some((s - longer, norm(n), i as u32))
        })
        .collect();
    ranked.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    ranked.truncate(limit);
    ranked.into_iter().map(|(s, _, i)| (i, s)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str, name: &str, kind: NodeKind, parent: Option<&str>) -> Item {
        Item {
            id: id.to_owned(),
            name: name.to_owned(),
            kind,
            parent: parent.map(str::to_owned),
            status: None,
            flags: Vec::new(),
            aliases: Vec::new(),
        }
    }

    /// root ─ Игра ─ Боёвка, Анимации удара
    ///      │      └ Арт ─ Шейдер воды
    ///      ├ Шейдер, Сцена с шейдером, Диздок
    ///      └ Музыка ─ Звук 3
    fn space() -> Index {
        use NodeKind::*;
        Index::new(vec![
            item("root", "Корень", Network, None),
            item("game", "Игра", Project, Some("root")),
            item("fight", "Боёвка", Task, Some("game")),
            item("anim", "Анимации удара", Task, Some("game")),
            item("art", "Арт", Network, Some("game")),
            item("water", "Шейдер воды", Note, Some("art")),
            item("shader", "Шейдер", Note, Some("root")),
            item("scene", "Сцена с шейдером", Board, Some("root")),
            item("doc", "Диздок", Note, Some("root")),
            item("music", "Музыка", Network, Some("root")),
            item("sound", "Звук 3", Asset, Some("music")),
        ])
    }

    fn ids(ix: &Index, q: &str, ctx: &Context) -> Vec<String> {
        ix.query(q, ctx)
            .into_iter()
            .map(|n| ix.item(n).expect("item").id.clone())
            .collect()
    }

    #[test]
    fn better_stages_and_shorter_names_first() {
        let ix = space();
        let all = Context::default();
        assert_eq!(ids(&ix, "шейдер", &all), vec!["shader", "water", "scene"]);
        assert_eq!(ids(&ix, "боевка", &all), vec!["fight"]);
        assert_eq!(ids(&ix, "здок", &all), vec!["doc"], "a substring");
        assert_eq!(
            ids(&ix, "шйедер", &all),
            vec!["shader", "water", "scene"],
            "a typo, by the words' prefixes"
        );
        assert_eq!(
            ids(&ix, "ае", &all),
            Vec::<String>::new(),
            "two letters: prefix and initials only"
        );
        assert_eq!(ids(&ix, "ау", &all), vec!["anim"], "initials");
    }

    #[test]
    fn the_other_layout_finds_too() {
        let ix = space();
        assert_eq!(ids(&ix, ",jtdrf", &Context::default()), vec!["fight"]);
        assert_eq!(ids(&ix, "lbpljr", &Context::default()), vec!["doc"]);
    }

    #[test]
    fn scopes_take_a_network_or_everything_under_it() {
        let ix = space();
        let at = |scope: Scope| Context {
            scope,
            ..Context::default()
        };
        let here = at(Scope::In {
            net: "game".to_owned(),
        });
        assert_eq!(ids(&ix, "шейдер", &here), Vec::<String>::new());
        let under = at(Scope::Under {
            net: "game".to_owned(),
        });
        assert_eq!(ids(&ix, "шейдер", &under), vec!["water"]);
        let none = at(Scope::In {
            net: "gone".to_owned(),
        });
        assert!(
            ids(&ix, "шейдер", &none).is_empty(),
            "an unknown network holds nothing"
        );
        // A canvas's collection: its nodes, not its network.
        let canvas = Index::new(vec![item("a", "Шейдер", NodeKind::Note, Some("net"))]);
        let inside = at(Scope::In {
            net: "net".to_owned(),
        });
        assert_eq!(ids(&canvas, "шейдер", &inside), vec!["a"]);
        let under = at(Scope::Under {
            net: "net".to_owned(),
        });
        assert_eq!(ids(&canvas, "шейдер", &under), vec!["a"]);
    }

    #[test]
    fn closeness_key_pause_and_visits_move_the_order() {
        use NodeKind::*;
        let mut a = item("a", "Звук", Note, Some("far"));
        let b = item("b", "Звук", Note, Some("here"));
        let c = item("c", "Звук", Note, Some("sib"));
        let ix = |a: Item| {
            Index::new(vec![
                item("root", "Корень", Network, None),
                item("here", "Тут", Network, Some("root")),
                item("sib", "Рядом", Network, Some("root")),
                item("far", "Далеко", Network, Some("sib")),
                a,
                b.clone(),
                c.clone(),
            ])
        };
        let ctx = Context {
            here: Some("here".to_owned()),
            ..Context::default()
        };
        // Placed here +80, in a sibling network +50, further nothing.
        assert_eq!(ids(&ix(a.clone()), "звук", &ctx), vec!["b", "c", "a"]);
        a.flags = vec![Flag::Key];
        a.status = None;
        let mut visited = ctx.clone();
        visited.now = 10 * 86_400_000;
        visited.visits.insert(
            "a".to_owned(),
            Visit {
                at: 10 * 86_400_000,
                count: 3,
            },
        );
        // Key +40, opened today +150 and three times +40: above all.
        assert_eq!(ids(&ix(a.clone()), "звук", &visited), vec!["a", "b", "c"]);
        let mut done = item("b", "Звук", Note, Some("here"));
        done.status = Some("done".to_owned());
        let index = Index::new(vec![
            item("root", "Корень", Network, None),
            item("here", "Тут", Network, Some("root")),
            done,
            item("x", "Звук", Note, Some("root")),
        ]);
        assert_eq!(
            ids(&index, "звук", &ctx),
            vec!["x", "b"],
            "a final status −60 outweighs being here (+80) and the parent's +50"
        );
    }

    #[test]
    fn aliases_rank_fifty_below_the_name() {
        use NodeKind::*;
        let mut ref_ = item("r", "Референсы", Board, None);
        ref_.aliases = vec!["Мудборд".to_owned()];
        let ix = Index::new(vec![ref_, item("m", "Мудборд старый", Board, None)]);
        // The alias is exact (1000 − 50); the other a prefix (800), its name longer.
        assert_eq!(ids(&ix, "мудборд", &Context::default()), vec!["r", "m"]);
    }

    #[test]
    fn find_takes_its_scope() {
        let ix = space();
        let f = Find::parse("@задача");
        let net = Scope::In {
            net: "game".to_owned(),
        };
        let found: Vec<&str> = ix
            .find(&f, false, &net)
            .into_iter()
            .map(|n| ix.item(n).expect("item").id.as_str())
            .collect();
        assert_eq!(found, vec!["fight", "anim"]);
    }

    #[test]
    fn short_lists_rank_by_name_alone() {
        let names: Vec<String> = ["Шейдер воды", "Шейдер", "Сцена с шейдером", "Доска"]
            .map(str::to_owned)
            .to_vec();
        let order = |q: &str| -> Vec<u32> {
            rank_names(q, &names, 3)
                .into_iter()
                .map(|(i, _)| i)
                .collect()
        };
        assert_eq!(order("шейдер"), vec![1, 0, 2]);
        assert_eq!(order("ljcrf"), vec![3]);
        assert_eq!(
            rank_names("шейдер", &names, 1),
            vec![(1, 1000)],
            "1000: the name exactly"
        );
    }

    /// Many names, a typo among them; the budget of §2.6 on 100 000 names
    /// (≤ 16 ms p95) is the example `search_speed`'s, on a release build.
    #[test]
    fn many_names_build_and_answer() {
        let words = [
            "сцена",
            "шейдер",
            "боевка",
            "анимация",
            "звук",
            "доска",
            "план",
            "встреча",
            "point",
            "wrangle",
            "level",
            "design",
            "удар",
            "свет",
            "вода",
            "лес",
            "мельница",
            "туман",
        ];
        let items: Vec<Item> = (0..20_000)
            .map(|i| {
                let name = format!(
                    "{} {} {}",
                    words[i % words.len()],
                    words[(i / 7) % words.len()],
                    i
                );
                item(&format!("n{i}"), &name, NodeKind::Note, None)
            })
            .collect();
        let ix = Index::new(items);
        let ctx = Context {
            limit: Some(12),
            ..Context::default()
        };
        assert_eq!(ix.query("мельница туман", &ctx).len(), 12);
        assert!(!ix.query("мельнциа", &ctx).is_empty(), "a typo");
    }
}
