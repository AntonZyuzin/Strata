//! Normalization (09 §2.2) and the keyboard layouts (§2.4).

use unicode_normalization::UnicodeNormalization;

/// Word separators of 09 §2.2 step 5, quotes of both languages too.
fn is_separator(c: char) -> bool {
    c.is_whitespace()
        || matches!(
            c,
            '-' | '_'
                | '.'
                | '/'
                | '\\'
                | '|'
                | ':'
                | ';'
                | ','
                | '('
                | ')'
                | '['
                | ']'
                | '{'
                | '}'
                | '«'
                | '»'
                | '"'
                | '\''
                | '“'
                | '”'
                | '‘'
                | '’'
        )
}

/// The Combining Diacritical Marks block: Latin diacritics (§2.2 step 4).
fn is_latin_mark(c: char) -> bool {
    ('\u{300}'..='\u{36f}').contains(&c)
}

/// A letter or digit of plain ASCII or of the Russian alphabet: the text
/// normalization leaves as it is but for its case (`ё` aside).
fn plain(c: char) -> bool {
    c.is_ascii() || ('\u{410}'..='\u{44f}').contains(&c) || c == 'ё' || c == 'Ё'
}

/// 09 §2.2: NFC; word boundaries at camelCase and between letters and
/// digits; lower case; `ё` → `е`; Latin diacritics off, `й` kept; separators
/// to one space. «Боёвка» → `боевка`, `PointWrangle2` → `point wrangle 2`.
pub fn norm(s: &str) -> String {
    // Russian and English names, most of a workspace, need no Unicode tables.
    if s.chars().all(plain) {
        return norm_plain(s);
    }
    norm_unicode(s)
}

/// [`norm`] of ASCII and the Russian alphabet.
fn norm_plain(s: &str) -> String {
    let lower = |c: char| match c {
        'Ё' | 'ё' => 'е',
        'А'..='Я' => char::from_u32(c as u32 + 0x20).unwrap_or(c),
        c => c.to_ascii_lowercase(),
    };
    let upper = |c: char| c.is_ascii_uppercase() || ('А'..='Я').contains(&c) || c == 'Ё';
    let small = |c: char| c.is_ascii_lowercase() || ('а'..='я').contains(&c) || c == 'ё';
    let letter = |c: char| upper(c) || small(c);
    let mut out = String::with_capacity(s.len());
    let mut gap = true;
    let mut prev: Option<char> = None;
    for c in s.chars() {
        if is_separator(c) {
            if !gap {
                out.push(' ');
                gap = true;
            }
            prev = None;
            continue;
        }
        if let Some(p) = prev {
            let boundary = (small(p) && upper(c))
                || (letter(p) && c.is_ascii_digit())
                || (p.is_ascii_digit() && letter(c));
            if boundary && !gap {
                out.push(' ');
            }
        }
        out.push(lower(c));
        gap = false;
        prev = Some(c);
    }
    if out.ends_with(' ') {
        out.pop();
    }
    out
}

/// [`norm`] of any text, through Unicode's tables.
fn norm_unicode(s: &str) -> String {
    let mut split = String::with_capacity(s.len() + 4);
    let mut prev: Option<char> = None;
    for c in s.nfc() {
        if let Some(p) = prev {
            let boundary = (p.is_lowercase() && c.is_uppercase())
                || (p.is_alphabetic() && c.is_numeric())
                || (p.is_numeric() && c.is_alphabetic());
            if boundary {
                split.push(' ');
            }
        }
        split.push(c);
        prev = Some(c);
    }
    let lower: String = split
        .chars()
        .flat_map(char::to_lowercase)
        .map(|c| if c == 'ё' { 'е' } else { c })
        .collect();
    // й keeps its breve: it belongs to the letter, it is no diacritic.
    let mut bare = String::with_capacity(lower.len());
    let mut base = None;
    for c in lower.nfd() {
        if is_latin_mark(c) {
            if base == Some('и') && c == '\u{306}' {
                bare.push(c);
            }
            continue;
        }
        base = Some(c);
        bare.push(c);
    }
    let mut out = String::with_capacity(bare.len());
    let mut gap = true;
    for c in bare.nfc() {
        if is_separator(c) {
            if !gap {
                out.push(' ');
                gap = true;
            }
        } else {
            out.push(c);
            gap = false;
        }
    }
    if out.ends_with(' ') {
        out.pop();
    }
    out
}

/// The first letters of a normalized name's words (§2.2 step 7): «План встреч» → `пв`.
pub fn initials(normalized: &str) -> String {
    normalized
        .split(' ')
        .filter_map(|w| w.chars().next())
        .collect()
}

const QWERTY: &str = "qwertyuiop[]asdfghjkl;'zxcvbnm,.`";
const JCUKEN: &str = "йцукенгшщзхъфывапролджэячсмитьбюё";

/// Text typed in the other layout, QWERTY ↔ ЙЦУКЕН by the physical keys,
/// both ways (§2.4): `ghbdtn` → `привет`, `,jtdrf` → `боевка`.
pub fn switch_layout(s: &str) -> String {
    let q: Vec<char> = QWERTY.chars().collect();
    let j: Vec<char> = JCUKEN.chars().collect();
    s.chars()
        .flat_map(char::to_lowercase)
        .map(|c| {
            if let Some(i) = q.iter().position(|&x| x == c) {
                j[i]
            } else if let Some(i) = j.iter().position(|&x| x == c) {
                q[i]
            } else {
                c
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn case_yo_separators_and_diacritics_go_and_short_i_stays() {
        assert_eq!(norm("Ёлка_Новый-Год"), "елка новый год");
        assert_eq!(norm("Café  «Йод»"), "cafe йод");
        assert_eq!(norm("  Боёвка.  "), "боевка");
        // A decomposed ё is the same ё.
        assert_eq!(norm("Бое\u{308}вка"), "боевка");
        assert_eq!(norm("Й"), "й");
    }

    #[test]
    fn camel_case_and_digits_are_word_boundaries() {
        assert_eq!(norm("PointWrangle2"), "point wrangle 2");
        assert_eq!(norm("Звук3"), "звук 3");
        assert_eq!(norm("v2beta"), "v 2 beta");
        assert_eq!(initials(&norm("План встреч")), "пв");
    }

    #[test]
    fn plain_names_take_the_short_way_to_the_same_result() {
        for name in [
            "PointWrangle2",
            "Ёлка_Новый-Год",
            "  Боёвка.  ",
            "Звук3 «x»",
            "ABCdef",
            "Й",
            "v2beta",
            "a--b",
            "Задача №1",
        ] {
            assert_eq!(norm_plain(name), norm_unicode(name), "{name}");
        }
    }

    #[test]
    fn layouts_switch_both_ways() {
        assert_eq!(switch_layout("ghbdtn"), "привет");
        assert_eq!(switch_layout("lbpljr"), "диздок");
        assert_eq!(switch_layout(",jtdrf"), "боевка");
        assert_eq!(switch_layout("Привет"), "ghbdtn");
        assert_eq!(switch_layout("[]"), "хъ");
    }
}
