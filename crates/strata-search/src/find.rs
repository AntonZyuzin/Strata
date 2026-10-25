//! Houdini Find's syntax for `Ctrl+F` (09 §3.3): a word is a substring of
//! the name, `*` and `?` mask the whole name, quotes ask for the name as it
//! is, `@вид` and `+флаг` filter, `-` excludes. Every term must hold. The
//! words of the syntax are Russian and English whatever the interface's
//! language (§2.8).

use crate::index::Item;
use crate::norm::norm;
use strata_model::{Flag, NodeKind};

#[derive(Clone, Debug, PartialEq)]
enum Text {
    /// A part of the name: as typed, and normalized once.
    Part(String, String),
    /// The whole name: as typed, and normalized.
    Whole(String, String),
    /// The whole name by a mask of `*` and `?`: folded with the case and without.
    Mask { cased: Vec<char>, folded: Vec<char> },
}

#[derive(Clone, Debug, PartialEq)]
enum Term {
    Text { text: Text, not: bool },
    Kind { kind: NodeKind, not: bool },
    Flag { flag: Flag, not: bool },
}

/// A parsed `Ctrl+F` query.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Find {
    terms: Vec<Term>,
    /// Terms it did not understand (`@` of no kind, `+` of no flag): left out.
    pub unknown: Vec<String>,
}

/// The kinds by their words (§3.6): both languages, the old names too.
fn kind_of(word: &str) -> Option<NodeKind> {
    Some(match norm(word).as_str() {
        "папка" | "folder" | "сеть" | "network" => NodeKind::Network,
        "проект" | "project" => NodeKind::Project,
        "задача" | "task" => NodeKind::Task,
        "заметка" | "note" => NodeKind::Note,
        "доска" | "board" => NodeKind::Board,
        "список" | "checklist" | "list" => NodeKind::Checklist,
        "ассет" | "asset" | "медиа" | "media" => NodeKind::Asset,
        _ => return None,
    })
}

/// The flags by their words (§3.6).
fn flag_of(word: &str) -> Option<Flag> {
    Some(match norm(word).as_str() {
        "ключевая" | "key" => Flag::Key,
        "пауза" | "pause" => Flag::Pause,
        "шаблон" | "template" => Flag::Template,
        "noai" => Flag::HideAi,
        "замок" | "lock" => Flag::Lock,
        _ => return None,
    })
}

/// The query's words: spaces split them, quotes hold a phrase with its spaces.
fn words(q: &str) -> Vec<(String, bool)> {
    let mut out = Vec::new();
    let mut word = String::new();
    let mut quoted = false;
    let mut open = false;
    for c in q.chars() {
        match c {
            '"' => {
                if open {
                    out.push((std::mem::take(&mut word), true));
                    quoted = false;
                } else {
                    quoted = true;
                }
                open = !open;
            }
            c if c.is_whitespace() && !open => {
                if !word.is_empty() {
                    out.push((std::mem::take(&mut word), quoted));
                }
                quoted = false;
            }
            c => word.push(c),
        }
    }
    if !word.is_empty() {
        out.push((word, quoted));
    }
    out
}

/// The name for comparing: `ё` = `е` always (§3.3), the case only when asked.
fn fold(s: &str, case: bool) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            'ё' => out.push('е'),
            'Ё' => out.push(if case { 'Е' } else { 'е' }),
            c if case => out.push(c),
            c => out.extend(c.to_lowercase()),
        }
    }
    out
}

/// `*` — any letters, `?` — one.
fn masked(mask: &[char], name: &[char]) -> bool {
    let (mut m, mut n) = (0, 0);
    let (mut star, mut back) = (None, 0);
    while n < name.len() {
        if m < mask.len() && (mask[m] == '?' || mask[m] == name[n]) {
            m += 1;
            n += 1;
        } else if m < mask.len() && mask[m] == '*' {
            star = Some(m);
            back = n;
            m += 1;
        } else if let Some(s) = star {
            m = s + 1;
            back += 1;
            n = back;
        } else {
            return false;
        }
    }
    mask[m..].iter().all(|&c| c == '*')
}

impl Find {
    pub fn parse(q: &str) -> Find {
        let mut find = Find::default();
        for (word, quoted) in words(q) {
            let (not, rest) = match word.strip_prefix('-') {
                Some(r) if !r.is_empty() && !quoted => (true, r.to_owned()),
                _ => (false, word.clone()),
            };
            // A quoted phrase is text: `-"пауза"` is a word, not the flag.
            if quoted {
                let (text, not) = match word.strip_prefix('-') {
                    Some(part) => (Text::Part(part.to_owned(), norm(part)), true),
                    None => (Text::Whole(word.clone(), norm(&word)), false),
                };
                find.terms.push(Term::Text { text, not });
                continue;
            }
            if let Some(k) = rest.strip_prefix('@') {
                match kind_of(k) {
                    Some(kind) => find.terms.push(Term::Kind { kind, not }),
                    // A person, in 1.4 (§3.6).
                    None => find.unknown.push(word.clone()),
                }
                continue;
            }
            if let Some(f) = rest.strip_prefix('+') {
                match flag_of(f) {
                    Some(flag) => find.terms.push(Term::Flag { flag, not }),
                    None => find.unknown.push(word.clone()),
                }
                continue;
            }
            // `-пауза`: a flag's name after `-` is the flag (§3.6).
            if not {
                if let Some(flag) = flag_of(&rest) {
                    find.terms.push(Term::Flag { flag, not });
                    continue;
                }
            }
            let text = if rest.contains(['*', '?']) {
                Text::Mask {
                    cased: fold(&rest, true).chars().collect(),
                    folded: fold(&rest, false).chars().collect(),
                }
            } else {
                Text::Part(rest.clone(), norm(&rest))
            };
            find.terms.push(Term::Text { text, not });
        }
        find
    }

    /// Nothing to look for.
    pub fn is_empty(&self) -> bool {
        self.terms.is_empty()
    }

    /// The query's text without its filters, for the fuzzy line (§3.3).
    pub fn text(&self) -> String {
        self.terms
            .iter()
            .filter_map(|t| match t {
                Term::Text {
                    text: Text::Part(s, _) | Text::Whole(s, _),
                    not: false,
                } => Some(s.clone()),
                Term::Text {
                    text: Text::Mask { cased, .. },
                    not: false,
                } => Some(cased.iter().filter(|c| !matches!(c, '*' | '?')).collect()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join(" ")
    }

    /// Whether the node holds every term; `case` — «Aa»: the case counts.
    pub fn matches(&self, item: &Item, case: bool) -> bool {
        self.matches_named(item, &norm(&item.name), case)
    }

    /// [`Find::matches`] with the name normalized already (the index keeps it).
    pub(crate) fn matches_named(&self, item: &Item, named: &str, case: bool) -> bool {
        self.terms.iter().all(|t| match t {
            Term::Kind { kind, not } => (item.kind == *kind) != *not,
            Term::Flag { flag, not } => item.flags.contains(flag) != *not,
            Term::Text { text, not } => {
                let hit = match text {
                    Text::Part(p, _) if case => fold(&item.name, true).contains(&fold(p, true)),
                    Text::Part(_, p) => !p.is_empty() && named.contains(p.as_str()),
                    Text::Whole(w, _) if case => fold(&item.name, true) == fold(w, true),
                    Text::Whole(_, w) => named == w,
                    Text::Mask { cased, folded } => {
                        let name: Vec<char> = fold(&item.name, case).chars().collect();
                        masked(if case { cased } else { folded }, &name)
                    }
                };
                hit != *not
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(name: &str, kind: NodeKind, flags: &[Flag]) -> Item {
        Item {
            id: name.to_owned(),
            name: name.to_owned(),
            kind,
            parent: None,
            status: None,
            flags: flags.to_vec(),
            aliases: Vec::new(),
        }
    }

    fn hits<'a>(q: &str, case: bool, items: &'a [Item]) -> Vec<&'a str> {
        let f = Find::parse(q);
        items
            .iter()
            .filter(|i| f.matches(i, case))
            .map(|i| i.name.as_str())
            .collect()
    }

    fn sample() -> Vec<Item> {
        vec![
            item("Удар", NodeKind::Task, &[Flag::Key]),
            item("Анимации удара", NodeKind::Task, &[Flag::Pause]),
            item("Аниматик", NodeKind::Board, &[]),
            item("Спринт", NodeKind::Project, &[]),
            item("Сплинт", NodeKind::Note, &[Flag::Pause]),
            item("Ёлка", NodeKind::Note, &[]),
        ]
    }

    #[test]
    fn a_word_is_a_part_of_the_name_without_case_or_yo() {
        let s = sample();
        assert_eq!(hits("удар", false, &s), vec!["Удар", "Анимации удара"]);
        assert_eq!(hits("елка", false, &s), vec!["Ёлка"]);
        assert_eq!(hits("ЁЛ", false, &s), vec!["Ёлка"]);
    }

    #[test]
    fn masks_quotes_and_the_case() {
        let s = sample();
        assert_eq!(hits("аним*", false, &s), vec!["Анимации удара", "Аниматик"]);
        assert_eq!(hits("сп?инт", false, &s), vec!["Спринт", "Сплинт"]);
        assert_eq!(hits("\"Удар\"", false, &s), vec!["Удар"]);
        assert_eq!(
            hits("\"анимации удара\"", false, &s),
            vec!["Анимации удара"]
        );
        assert_eq!(hits("удар", true, &s), vec!["Анимации удара"]);
        assert_eq!(hits("Удар", true, &s), vec!["Удар"]);
        assert_eq!(
            hits("Елка", true, &s),
            vec!["Ёлка"],
            "ё = е with the case too"
        );
    }

    #[test]
    fn kinds_and_flags_in_both_languages() {
        let s = sample();
        assert_eq!(hits("@задача", false, &s), vec!["Удар", "Анимации удара"]);
        assert_eq!(hits("@task -+pause", false, &s), vec!["Удар"]);
        assert_eq!(hits("+ключевая", false, &s), vec!["Удар"]);
        assert_eq!(hits("-пауза @заметка", false, &s), vec!["Ёлка"]);
        assert_eq!(
            hits("@сеть", false, &s),
            Vec::<&str>::new(),
            "the folder's old name"
        );
        assert_eq!(hits("аним -удара", false, &s), vec!["Аниматик"]);
        assert_eq!(
            hits("-\"пауза\"", false, &s).len(),
            6,
            "quoted: a word, not the flag"
        );
    }

    #[test]
    fn unknown_filters_are_left_out_and_told() {
        let f = Find::parse("@аня +нечто удар");
        assert_eq!(f.unknown, vec!["@аня".to_owned(), "+нечто".to_owned()]);
        assert_eq!(
            hits("@аня удар", false, &sample()),
            vec!["Удар", "Анимации удара"]
        );
        assert_eq!(Find::parse("аним* \"Удар\" @задача").text(), "аним Удар");
        assert!(Find::parse("   ").is_empty());
    }
}
