//! The stages of matching (09 §2.3): a normalized query against a
//! normalized name, then both keyboard layouts (§2.4).

use crate::norm::{initials, norm, switch_layout};

/// The optimal string alignment distance — Damerau–Levenshtein with
/// adjacent transpositions (§2.3, «Опечатки») — from `a` to the nearest
/// prefix of `b` within `max` letters of `a`'s length; `max + 1` when farther.
pub(crate) fn prefix_distance(a: &[char], b: &[char], max: usize) -> usize {
    let b = &b[..b.len().min(a.len() + max)];
    if a.len() > b.len() + max {
        return max + 1;
    }
    let w = b.len() + 1;
    let mut d = vec![0usize; (a.len() + 1) * w];
    for (j, cell) in d.iter_mut().take(w).enumerate() {
        *cell = j;
    }
    for i in 1..=a.len() {
        d[i * w] = i;
        for j in 1..=b.len() {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            let mut v = (d[(i - 1) * w + j] + 1)
                .min(d[i * w + j - 1] + 1)
                .min(d[(i - 1) * w + j - 1] + cost);
            if i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1] {
                v = v.min(d[(i - 2) * w + j - 2] + 1);
            }
            d[i * w + j] = v;
        }
    }
    let last = &d[a.len() * w..];
    let from = a.len().saturating_sub(max);
    last.iter()
        .skip(from)
        .copied()
        .min()
        .unwrap_or(max + 1)
        .min(max + 1)
}

/// How many typos a query word may carry (§2.3): one at 4–7 letters, two from 8.
pub(crate) fn typos_allowed(len: usize) -> usize {
    match len {
        0..=3 => 0,
        4..=7 => 1,
        _ => 2,
    }
}

/// A normalized query taken apart once for every name it meets.
#[derive(Debug)]
pub(crate) struct Asked {
    pub q: String,
    /// Its letters without the spaces: against the initials.
    pub compact: String,
    pub words: Vec<String>,
    /// The words' letters, for typos.
    pub letters: Vec<Vec<char>>,
    /// Its length in letters.
    pub len: usize,
}

impl Asked {
    pub fn new(q: &str) -> Asked {
        let words: Vec<String> = q.split(' ').map(str::to_owned).collect();
        Asked {
            q: q.to_owned(),
            compact: q.chars().filter(|&c| c != ' ').collect(),
            letters: words.iter().map(|w| w.chars().collect()).collect(),
            words,
            len: q.chars().count(),
        }
    }
}

/// The stage of a normalized query against a normalized name (§2.3):
/// exact 1000, prefix 800, initials 700, word prefixes in order 600, words in
/// any order 500, substring 400, typos 300 − 100 × distance; `None` when
/// nothing matches. A query of 1–2 letters matches by prefix and initials only.
pub fn stage(q: &str, name: &str) -> Option<i32> {
    let a = Asked::new(q);
    stage_of(&a, name, &initials(name)).or_else(|| {
        if a.len <= 2 {
            return None;
        }
        let words: Vec<Vec<char>> = name.split(' ').map(|w| w.chars().collect()).collect();
        typo_stage(a.letters.iter().map(|w| {
            let max = typos_allowed(w.len());
            words
                .iter()
                .map(|x| prefix_distance(w, x, max))
                .min()
                .filter(|&d| d <= max)
        }))
    })
}

/// The typo stage from each query word's distance to its nearest word of
/// the name, `None` for a word with none near (§2.3): 300 − 100 × the worst.
/// Every word a prefix as it is was a stage above.
pub(crate) fn typo_stage(distances: impl Iterator<Item = Option<usize>>) -> Option<i32> {
    let mut worst = 0;
    for d in distances {
        worst = worst.max(d?);
    }
    (worst > 0).then(|| 300 - 100 * worst as i32)
}

/// The stages above typos (1000 … 400) with the query taken apart and the
/// name's initials at hand.
pub(crate) fn stage_of(a: &Asked, name: &str, initials: &str) -> Option<i32> {
    let q = a.q.as_str();
    if q.is_empty() || name.is_empty() {
        return None;
    }
    if name == q {
        return Some(1000);
    }
    if name.starts_with(q) {
        return Some(800);
    }
    if a.len >= 2 && initials.starts_with(&a.compact) {
        return Some(700);
    }
    if a.len <= 2 {
        return None;
    }
    let mut words = name.split(' ');
    if a.words
        .iter()
        .all(|w| words.any(|x| x.starts_with(w.as_str())))
    {
        return Some(600);
    }
    if a.words
        .iter()
        .all(|w| name.split(' ').any(|x| x.starts_with(w.as_str())))
    {
        return Some(500);
    }
    if name.contains(q) {
        return Some(400);
    }
    None
}

/// The best stage of a query against a name over both layouts, the other
/// layout 20 lower (§2.3, «Исправление раскладки»).
pub fn score(query: &str, name: &str) -> Option<i32> {
    let n = norm(name);
    let direct = stage(&norm(query), &n);
    let swapped = stage(&norm(&switch_layout(query)), &n).map(|s| s - 20);
    direct.max(swapped)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_stages_of_09_2_3() {
        assert_eq!(stage("сцена", "сцена"), Some(1000));
        assert_eq!(stage("сце", "сцена 12"), Some(800));
        assert_eq!(stage("дд", "дизайн документ"), Some(700));
        assert_eq!(stage("пв", "план встреч"), Some(700));
        assert_eq!(stage("pw", "point wrangle"), Some(700));
        assert_eq!(stage("диз док", "дизайн документ"), Some(600));
        assert_eq!(stage("пла вст", "план встреч"), Some(600));
        assert_eq!(stage("wran", "point wrangle"), Some(600));
        assert_eq!(stage("док диз", "дизайн документ"), Some(500));
        assert_eq!(stage("встреч план", "план встреч"), Some(500));
        assert_eq!(stage("ена", "сцена"), Some(400));
        assert_eq!(stage("здок", "диздок"), Some(400));
        assert_eq!(stage("шейдр", "шейдер"), Some(200));
        assert_eq!(stage("боевак", "боевка"), Some(200));
    }

    #[test]
    fn short_queries_match_by_prefix_and_initials_only() {
        assert_eq!(stage("ц", "сцена"), None);
        assert_eq!(stage("це", "сцена"), None);
        assert_eq!(stage("с", "сцена"), Some(800));
    }

    #[test]
    fn typos_by_word_length() {
        // Three letters take no typo; four to seven take one; eight and more two.
        assert_eq!(stage("кот", "кит"), None);
        assert_eq!(stage("анимаця", "анимация"), Some(200));
        assert_eq!(stage("анимацяи", "анимация"), Some(200));
        assert_eq!(stage("онимацяи", "анимация"), Some(100));
        assert_eq!(stage("шдейр", "шейдер"), None);
        // A typo in a word's prefix: «анимаци» for «анимациями».
        assert_eq!(stage("анимцаи", "анимациями удара"), Some(200));
        // A short word of a longer query must be a prefix as it is.
        assert_eq!(stage("боевак уд", "боевка удара"), Some(200));
        assert_eq!(stage("боевак ит", "боевка удара"), None);
    }

    #[test]
    fn the_other_layout_is_twenty_lower() {
        assert_eq!(score("ljcrf", "Доска"), Some(980));
        assert_eq!(score("lbpljr", "Диздок"), Some(980));
        assert_eq!(score(",jtdrf", "Боёвка"), Some(980));
        assert_eq!(score("Доска", "Доска"), Some(1000));
        assert_eq!(score("Цель", "Боёвка"), None);
    }
}
