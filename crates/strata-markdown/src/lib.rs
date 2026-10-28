//! What Strata reads from a note's Markdown without changing it (15 §2,
//! 13 §7.1): `[[links]]` and `![[embeds]]` for wires with origin `text`
//! (05 §8.2 rule 4), `#tags`, and the properties of the YAML frontmatter.
//! The text itself is the source and is never rewritten.
//!
//! Spike 11 chose the parsers (15 §2.6): `pulldown-cmark` for CommonMark with
//! Obsidian-style wikilinks and the YAML metadata block, `saphyr` for YAML 1.2.
//! Code, inline code and the frontmatter hold no links and no tags.

use pulldown_cmark::{CowStr, Event, LinkType, Options, Parser, Tag, TagEnd};
use saphyr::{LoadableYamlNode, Yaml};
use std::ops::Range;
use unicode_normalization::{IsNormalized, UnicodeNormalization, is_nfc_quick};

/// One `[[link]]` or `![[embed]]`, or a Markdown link to a file of the
/// vault, `[text](Папка/X%20Y.md)` (13 §2.5).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Link {
    /// The note it names, without `#heading`, `#^block` and `|alias`; a
    /// Markdown link's path decoded (`%20` → space).
    pub target: String,
    /// `#heading` or `#^block` after the name, without the `#`.
    pub anchor: Option<String>,
    /// The text after `|`, if any.
    pub alias: Option<String>,
    pub embed: bool,
    /// Bytes of the whole `[[…]]` or `[…](…)` in the text.
    pub range: Range<usize>,
    /// `[text](path)` rather than `[[…]]`: its path is written encoded.
    pub markdown: bool,
}

/// A frontmatter property: a scalar as text, a list as texts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Property {
    Text(String),
    List(Vec<String>),
}

/// What a note says about itself and its neighbours.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Scan {
    pub links: Vec<Link>,
    /// Tags from the text and from the `tags` property, without `#`, in order of appearance.
    pub tags: Vec<String>,
    /// Frontmatter properties in their order; empty without frontmatter.
    pub properties: Vec<(String, Property)>,
    /// The frontmatter is not valid YAML: it stays as text, nothing is read from it.
    pub broken_frontmatter: bool,
}

fn options() -> Options {
    Options::ENABLE_WIKILINKS
        | Options::ENABLE_YAML_STYLE_METADATA_BLOCKS
        | Options::ENABLE_TABLES
        | Options::ENABLE_FOOTNOTES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_MATH
        | Options::ENABLE_GFM
}

/// Reads links, tags and properties from a note's text.
pub fn scan(text: &str) -> Scan {
    let mut out = Scan::default();
    let mut code = 0usize;
    let mut meta: Option<String> = None;
    let mut in_meta = false;
    // An open wikilink: its start, embed flag, destination, the label so far.
    let mut open: Option<(usize, bool, String, String, bool)> = None;
    // An open Markdown link to a file of the vault: its start, embed flag, path.
    let mut file: Option<(usize, bool, String)> = None;
    for (event, range) in Parser::new_ext(text, options()).into_offset_iter() {
        match event {
            Event::Start(Tag::MetadataBlock(_)) => {
                in_meta = true;
                meta = Some(String::new());
            }
            Event::End(TagEnd::MetadataBlock(_)) => in_meta = false,
            Event::Start(Tag::CodeBlock(_)) => code += 1,
            Event::End(TagEnd::CodeBlock) => code = code.saturating_sub(1),
            Event::Start(Tag::Link {
                link_type: LinkType::WikiLink { has_pothole },
                dest_url,
                ..
            }) => {
                open = Some((
                    range.start,
                    false,
                    dest_url.into_string(),
                    String::new(),
                    has_pothole,
                ))
            }
            Event::Start(Tag::Image {
                link_type: LinkType::WikiLink { has_pothole },
                dest_url,
                ..
            }) => {
                open = Some((
                    range.start,
                    true,
                    dest_url.into_string(),
                    String::new(),
                    has_pothole,
                ))
            }
            Event::Start(Tag::Link {
                link_type: LinkType::Inline,
                dest_url,
                ..
            }) if local(&dest_url) => file = Some((range.start, false, dest_url.into_string())),
            Event::Start(Tag::Image {
                link_type: LinkType::Inline,
                dest_url,
                ..
            }) if local(&dest_url) => file = Some((range.start, true, dest_url.into_string())),
            Event::End(TagEnd::Link | TagEnd::Image) => {
                if let Some((start, embed, dest, label, pothole)) = open.take() {
                    out.links.push(link(
                        &dest,
                        pothole.then_some(label),
                        embed,
                        start..range.end,
                    ));
                } else if let Some((start, embed, dest)) = file.take() {
                    let mut l = link(&percent_decode(&dest), None, embed, start..range.end);
                    l.markdown = true;
                    out.links.push(l);
                }
            }
            Event::Text(t) => {
                if in_meta {
                    if let Some(m) = meta.as_mut() {
                        m.push_str(&t);
                    }
                } else if let Some(o) = open.as_mut() {
                    o.3.push_str(&t);
                } else if code == 0 {
                    tags_in(&t, &mut out.tags);
                }
            }
            _ => {}
        }
    }
    if let Some(m) = meta {
        read_properties(&m, &mut out);
    }
    out
}

/// The link key of 13 §3.4: `casefold(NFC(s))` without `.md`, by which a
/// `[[link]]` finds its node and a wire to a ghost gets its key (05 §8.5,
/// 10 §2.5). Not search's `norm()`: «ё» stays apart from «е» and separators
/// stay as they are, or «Ёлка» and «Елка» would be one note. Full case
/// folding of Unicode (`caseless`), so «Straße» and «STRASSE» are one key.
pub fn link_key(s: &str) -> String {
    let s = s.trim();
    let mut key = if s.is_ascii() {
        s.to_ascii_lowercase()
    } else if is_nfc_quick(s.chars()) == IsNormalized::Yes {
        caseless::default_case_fold_str(s)
    } else {
        caseless::default_case_fold_str(&s.nfc().collect::<String>())
    };
    if let Some(stem) = key.strip_suffix(".md") {
        key.truncate(stem.len());
    }
    key
}

/// `s` in NFC (13 §3.4): names of files from macOS come in NFD.
pub fn nfc(s: &str) -> String {
    if is_nfc_quick(s.chars()) == IsNormalized::Yes {
        s.to_owned()
    } else {
        s.nfc().collect()
    }
}

fn link(dest: &str, alias: Option<String>, embed: bool, range: Range<usize>) -> Link {
    let (target, anchor) = match dest.split_once('#') {
        Some((t, a)) => (t, Some(a.to_owned())),
        None => (dest, None),
    };
    Link {
        target: target.trim().to_owned(),
        anchor,
        alias,
        embed,
        range,
        markdown: false,
    }
}

/// A Markdown link's destination is a file of the vault: no scheme
/// (`https:`, `mailto:`, `obsidian:`), not a bare `#anchor`.
fn local(dest: &str) -> bool {
    let d = dest.trim();
    if d.is_empty() || d.starts_with('#') || d.starts_with("//") {
        return false;
    }
    let scheme = d.split_once(':').is_some_and(|(s, _)| {
        !s.is_empty()
            && s.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
    });
    !scheme
}

/// `%20` → space, as a URL path is written; bytes that are no UTF-8 stay as they came.
pub fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let hex = |c: u8| (c as char).to_digit(16);
        if b[i] == b'%' {
            if let (Some(h), Some(l)) = (
                b.get(i + 1).and_then(|&c| hex(c)),
                b.get(i + 2).and_then(|&c| hex(c)),
            ) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| s.to_owned())
}

/// `%`-encodes what a Markdown link's path cannot hold as it is: spaces,
/// brackets, `%`, `#`, `?` (13 §2.5); letters of any script stay.
pub fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            ' ' | '(' | ')' | '<' | '>' | '%' | '#' | '?' | '[' | ']' | '^' | '|' => {
                let mut buf = [0u8; 4];
                for b in c.encode_utf8(&mut buf).bytes() {
                    out.push_str(&format!("%{b:02X}"));
                }
            }
            _ => out.push(c),
        }
    }
    out
}

/// Obsidian tags: `#` after a space or the line start, letters, digits and
/// `_ - /` of any script, at least one of them not a digit.
fn tags_in(text: &CowStr, out: &mut Vec<String>) {
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '#' && (i == 0 || chars[i - 1].is_whitespace()) {
            let mut j = i + 1;
            while j < chars.len() && (chars[j].is_alphanumeric() || "_-/".contains(chars[j])) {
                j += 1;
            }
            let tag: String = chars[i + 1..j].iter().collect();
            if !tag.is_empty() && !tag.chars().all(|c| c.is_ascii_digit() || c == '/') {
                out.push(tag);
            }
            i = j;
        } else {
            i += 1;
        }
    }
}

fn scalar(y: &Yaml) -> Option<String> {
    match y {
        Yaml::Value(s) => Some(match s {
            saphyr::Scalar::String(s) => s.to_string(),
            saphyr::Scalar::Integer(i) => i.to_string(),
            saphyr::Scalar::FloatingPoint(f) => f.to_string(),
            saphyr::Scalar::Boolean(b) => b.to_string(),
            saphyr::Scalar::Null => String::new(),
        }),
        Yaml::Representation(s, _, _) => Some(s.to_string()),
        _ => None,
    }
}

fn read_properties(source: &str, out: &mut Scan) {
    let Ok(docs) = Yaml::load_from_str(source) else {
        out.broken_frontmatter = true;
        return;
    };
    let Some(Yaml::Mapping(map)) = docs.into_iter().next() else {
        return;
    };
    for (k, v) in map.iter() {
        let Some(key) = scalar(k) else { continue };
        let value = match v {
            Yaml::Sequence(items) => Property::List(items.iter().filter_map(scalar).collect()),
            other => Property::Text(scalar(other).unwrap_or_default()),
        };
        if key == "tags" {
            let list = match &value {
                Property::List(l) => l.clone(),
                Property::Text(t) => t
                    .split([',', ' '])
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
                    .collect(),
            };
            out.tags.extend(
                list.into_iter()
                    .map(|t| t.trim_start_matches('#').to_owned()),
            );
        }
        out.properties.push((key, value));
    }
}

/// A note's frontmatter (13 §2.3): `---` on the first line, YAML, then a
/// line `---` or `...`. `range` is the whole block with its delimiters and
/// the line break after them: the body is what follows, byte for byte.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Frontmatter<'a> {
    pub yaml: &'a str,
    pub range: Range<usize>,
}

/// The frontmatter at the start of `text` (a BOM already taken off), if any.
pub fn frontmatter(text: &str) -> Option<Frontmatter<'_>> {
    let first = text.find('\n')?;
    if text[..first].trim_end_matches('\r') != "---" {
        return None;
    }
    let mut at = first + 1;
    while at <= text.len() {
        let end = text[at..].find('\n').map_or(text.len(), |i| at + i);
        let line = text[at..end].trim_end_matches('\r');
        if line == "---" || line == "..." {
            let next = (end + 1).min(text.len());
            return Some(Frontmatter {
                yaml: &text[first + 1..at],
                range: 0..next,
            });
        }
        if end == text.len() {
            break;
        }
        at = end + 1;
    }
    None
}

/// A property's value as YAML types it (13 §2.3): Obsidian's properties are
/// flat, so a mapping is kept as its text.
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Int(i64),
    Float(f64),
    Text(String),
    List(Vec<Value>),
    /// A nested mapping, written back as flow YAML: Obsidian has none (R2 §3).
    Nested(String),
}

impl Value {
    /// The value as one line of text.
    pub fn text(&self) -> String {
        match self {
            Self::Null => String::new(),
            Self::Bool(b) => b.to_string(),
            Self::Int(i) => i.to_string(),
            Self::Float(f) => f.to_string(),
            Self::Text(s) | Self::Nested(s) => s.clone(),
            Self::List(l) => l.iter().map(Self::text).collect::<Vec<_>>().join(", "),
        }
    }

    /// Texts of a list, or the one text of a scalar; none for null.
    pub fn texts(&self) -> Vec<String> {
        match self {
            Self::Null => Vec::new(),
            Self::List(l) => l.iter().flat_map(Self::texts).collect(),
            other => vec![other.text()],
        }
    }
}

fn typed(y: &Yaml) -> Value {
    match y {
        Yaml::Value(s) => match s {
            saphyr::Scalar::String(s) => Value::Text(s.to_string()),
            saphyr::Scalar::Integer(i) => Value::Int(*i),
            saphyr::Scalar::FloatingPoint(f) => Value::Float(**f),
            saphyr::Scalar::Boolean(b) => Value::Bool(*b),
            saphyr::Scalar::Null => Value::Null,
        },
        Yaml::Representation(s, _, _) => Value::Text(s.to_string()),
        Yaml::Sequence(items) => Value::List(items.iter().map(typed).collect()),
        Yaml::Mapping(_) => Value::Nested(flow(y)),
        _ => Value::Null,
    }
}

/// A YAML node as flow YAML, `{a: 1, b: [x, y]}`.
fn flow(y: &Yaml) -> String {
    match y {
        Yaml::Mapping(m) => format!(
            "{{{}}}",
            m.iter()
                .map(|(k, v)| format!("{}: {}", flow(k), flow(v)))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        Yaml::Sequence(s) => format!("[{}]", s.iter().map(flow).collect::<Vec<_>>().join(", ")),
        other => scalar(other).unwrap_or_default(),
    }
}

/// Typed properties of a frontmatter's YAML in their order; `None` when
/// the YAML does not parse (13 §2.3 «Битый YAML») or is not a mapping.
pub fn properties(yaml: &str) -> Option<Vec<(String, Value)>> {
    let docs = Yaml::load_from_str(yaml).ok()?;
    match docs.into_iter().next() {
        None => Some(Vec::new()),
        Some(Yaml::Mapping(map)) => Some(
            map.iter()
                .filter_map(|(k, v)| scalar(k).map(|k| (k, typed(v))))
                .collect(),
        ),
        Some(Yaml::Value(saphyr::Scalar::Null)) => Some(Vec::new()),
        Some(_) => None,
    }
}

/// One item of the Tasks plugin (13 §2.9.1, R2 §7): `- [ ] text 📅 date`.
/// The text stays in its note; these are what the core reads of it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TaskItem {
    /// The character between the brackets: ` ` open, `x` done, `-` cancelled, or one of the vault's own.
    pub status: char,
    /// `YYYY-MM-DD` after `📅` or in `[due:: …]`.
    pub due: Option<String>,
    pub scheduled: Option<String>,
    pub start: Option<String>,
    /// `lowest`, `low`, `medium`, `high`, `highest`.
    pub priority: Option<&'static str>,
    /// `🆔 a1` or `[id:: a1]`.
    pub id: Option<String>,
    /// `⛔ a1,b2` or `[dependsOn:: a1,b2]`.
    pub depends_on: Vec<String>,
    /// Bytes of the whole line.
    pub line: Range<usize>,
}

impl TaskItem {
    /// Not done and not cancelled.
    pub fn open(&self) -> bool {
        !matches!(self.status, 'x' | 'X' | '-')
    }
}

/// Byte ranges of fenced and indented code: they hold no tasks.
fn code_ranges(text: &str) -> Vec<Range<usize>> {
    let mut out = Vec::new();
    let mut start = None;
    for (event, range) in Parser::new_ext(text, options()).into_offset_iter() {
        match event {
            Event::Start(Tag::CodeBlock(_)) => start = Some(range.start),
            Event::End(TagEnd::CodeBlock) => {
                if let Some(s) = start.take() {
                    out.push(s..range.end);
                }
            }
            _ => {}
        }
    }
    out
}

/// The date that follows a Tasks emoji: spaces, NBSP and variation
/// selectors before it are skipped (R2 §7: they break the emoji otherwise).
fn date_after(s: &str) -> Option<String> {
    let s = s.trim_start_matches(|c: char| {
        c == '\u{fe0f}' || c == '\u{fe0e}' || c == '\u{a0}' || c.is_whitespace()
    });
    let d = s.get(..10)?;
    let ok = d.bytes().enumerate().all(|(i, b)| match i {
        4 | 7 => b == b'-',
        _ => b.is_ascii_digit(),
    });
    ok.then(|| d.to_owned())
}

/// The word after an emoji or `::`, up to a space or `]`.
fn word_after(s: &str) -> String {
    s.trim_start_matches(|c: char| c == '\u{fe0f}' || c == '\u{a0}' || c.is_whitespace())
        .split(|c: char| c.is_whitespace() || c == ']')
        .next()
        .unwrap_or_default()
        .to_owned()
}

/// The items of the Tasks plugin in a note (13 §2.9.1): list items with a
/// checkbox, outside code; the emoji fields and Dataview's `[key:: value]`.
pub fn task_items(text: &str) -> Vec<TaskItem> {
    let code = code_ranges(text);
    let mut out = Vec::new();
    let mut at = 0;
    while at < text.len() {
        let end = text[at..].find('\n').map_or(text.len(), |i| at + i);
        let line = &text[at..end];
        if !code.iter().any(|r| r.contains(&at)) {
            if let Some(item) = task_line(line) {
                out.push(TaskItem {
                    line: at..end,
                    ..item
                });
            }
        }
        at = end + 1;
    }
    out
}

fn task_line(line: &str) -> Option<TaskItem> {
    let s = line.trim_start_matches([' ', '\t']);
    let s = s.trim_start_matches('>').trim_start();
    let rest = s
        .strip_prefix("- [")
        .or_else(|| s.strip_prefix("* ["))
        .or_else(|| s.strip_prefix("+ ["))
        .or_else(|| {
            let digits = s.find(|c: char| !c.is_ascii_digit())?;
            (digits > 0)
                .then(|| s[digits..].strip_prefix(". ["))
                .flatten()
        })?;
    let mut chars = rest.chars();
    let status = chars.next()?;
    let body = chars.as_str().strip_prefix("] ")?;
    let mut item = TaskItem {
        status,
        ..TaskItem::default()
    };
    let field = |emoji: &str| body.find(emoji).map(|i| &body[i + emoji.len()..]);
    item.due = field("📅").and_then(date_after);
    item.scheduled = field("⏳").and_then(date_after);
    item.start = field("🛫").and_then(date_after);
    for (emoji, p) in [
        ("⏬", "lowest"),
        ("🔽", "low"),
        ("🔼", "medium"),
        ("⏫", "high"),
        ("🔺", "highest"),
    ] {
        if body.contains(emoji) {
            item.priority = Some(p);
        }
    }
    item.id = field("🆔").map(word_after).filter(|w| !w.is_empty());
    if let Some(deps) = field("⛔").map(word_after) {
        item.depends_on = deps
            .split(',')
            .filter(|d| !d.is_empty())
            .map(str::to_owned)
            .collect();
    }
    // Dataview's format of the same fields (R2 §7).
    let mut rest = body;
    while let Some(i) = rest.find('[') {
        rest = &rest[i + 1..];
        let Some(close) = rest.find(']') else { break };
        let inner = &rest[..close];
        if let Some((k, v)) = inner.split_once("::") {
            let v = v.trim();
            match k.trim() {
                "due" => item.due = item.due.take().or_else(|| date_after(v)),
                "scheduled" => item.scheduled = item.scheduled.take().or_else(|| date_after(v)),
                "start" => item.start = item.start.take().or_else(|| date_after(v)),
                "priority" => {
                    item.priority = item.priority.or(match v {
                        "lowest" => Some("lowest"),
                        "low" => Some("low"),
                        "medium" => Some("medium"),
                        "high" => Some("high"),
                        "highest" => Some("highest"),
                        _ => None,
                    })
                }
                "id" if item.id.is_none() && !v.is_empty() => item.id = Some(v.to_owned()),
                "dependsOn" if item.depends_on.is_empty() => {
                    item.depends_on = v
                        .split(',')
                        .map(str::trim)
                        .filter(|d| !d.is_empty())
                        .map(str::to_owned)
                        .collect();
                }
                _ => {}
            }
        }
        rest = &rest[close..];
    }
    Some(item)
}

/// A file that is only a checklist (13 §2.2): what a list keeps, and what
/// writing it back needs to give the same bytes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Checklist {
    /// `(depth, done, text)` in order; the text whole, with Tasks fields and `^id`.
    pub items: Vec<(usize, bool, String)>,
    /// `-`, `*` or `+`.
    pub marker: char,
    /// A tab, two or four spaces.
    pub indent: String,
    /// `x` or `X`.
    pub done: char,
}

/// The body as a checklist by the strict rule of 13 §2.2: blank lines
/// around, items only — one marker, one indent unit, one letter for «done»,
/// statuses ` ` and that letter; anything else is a note.
pub fn checklist(body: &str) -> Option<Checklist> {
    let lines: Vec<&str> = body.split('\n').map(|l| l.trim_end_matches('\r')).collect();
    let first = lines.iter().position(|l| !l.trim().is_empty())?;
    let last = lines.iter().rposition(|l| !l.trim().is_empty())?;
    let mut marker = None;
    let mut done_letter = None;
    let mut unit: Option<String> = None;
    let mut items = Vec::new();
    for line in &lines[first..=last] {
        let lead = line.len() - line.trim_start_matches([' ', '\t']).len();
        let (pad, rest) = line.split_at(lead);
        let mut chars = rest.chars();
        let m = chars.next()?;
        if !matches!(m, '-' | '*' | '+') || *marker.get_or_insert(m) != m {
            return None;
        }
        let rest = chars.as_str().strip_prefix(" [")?;
        let mut chars = rest.chars();
        let status = chars.next()?;
        let text = chars.as_str().strip_prefix("] ")?;
        let done = match status {
            ' ' => false,
            'x' | 'X' if *done_letter.get_or_insert(status) == status => true,
            _ => return None,
        };
        let depth = if pad.is_empty() {
            0
        } else {
            // The first indent is the unit: an item steps in one level at a time.
            let u = unit.get_or_insert_with(|| pad.to_owned());
            if !matches!(u.as_str(), "\t" | "  " | "    ") || pad.len() % u.len() != 0 {
                return None;
            }
            if pad.chars().any(|c| !u.starts_with(c)) {
                return None;
            }
            pad.len() / u.len()
        };
        let prev = items
            .last()
            .map_or(0, |(d, _, _): &(usize, bool, String)| *d + 1);
        if depth > prev {
            return None;
        }
        items.push((depth, done, text.to_owned()));
    }
    Some(Checklist {
        items,
        marker: marker?,
        indent: unit.unwrap_or_else(|| "  ".to_owned()),
        done: done_letter.unwrap_or('x'),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn link_keys_fold_case_and_forms_but_keep_letters_apart() {
        // macOS gives «й» and «ё» as a letter and a combining mark (13 §3.4).
        assert_eq!(link_key("Идея Й"), link_key("иде\u{44f} \u{438}\u{306}"));
        assert_eq!(link_key("ЁЛКА"), "ёлка");
        assert_ne!(link_key("Ёлка"), link_key("Елка"));
        assert_eq!(link_key("Straße"), link_key("STRASSE"));
        assert_eq!(link_key(" Plan.md "), "plan");
        assert_eq!(link_key("Plan.MD"), "plan");
        assert_eq!(link_key("scan.png"), "scan.png");
        // Separators are kept: «a-b» and «a b» are two notes.
        assert_ne!(link_key("a-b"), link_key("a b"));
        assert_eq!(link_key("Проекты/Игра"), "проекты/игра");
    }

    fn targets(text: &str) -> Vec<(String, bool)> {
        scan(text)
            .links
            .into_iter()
            .map(|l| (l.target, l.embed))
            .collect()
    }

    #[test]
    fn wikilinks_embeds_aliases_and_anchors() {
        let text = "See [[Project plan]], [[Plan#Goals|the goals]] and ![[diagram.png]].\n\
                    A block: [[Notes#^abc123]]. Кириллица: [[Идея 12|идея]].";
        let s = scan(text);
        let got: Vec<(&str, Option<&str>, Option<&str>, bool)> = s
            .links
            .iter()
            .map(|l| {
                (
                    l.target.as_str(),
                    l.anchor.as_deref(),
                    l.alias.as_deref(),
                    l.embed,
                )
            })
            .collect();
        assert_eq!(
            got,
            vec![
                ("Project plan", None, None, false),
                ("Plan", Some("Goals"), Some("the goals"), false),
                ("diagram.png", None, None, true),
                ("Notes", Some("^abc123"), None, false),
                ("Идея 12", None, Some("идея"), false),
            ]
        );
        // Ranges cover the brackets: the text slice is the link as written.
        assert_eq!(&text[s.links[1].range.clone()], "[[Plan#Goals|the goals]]");
        assert_eq!(&text[s.links[2].range.clone()], "![[diagram.png]]");
    }

    #[test]
    fn code_holds_no_links_and_no_tags() {
        let text = "```\n[[Not a link]] #nottag\n```\n\nInline `[[no]] #no` and [[Yes]] #yes\n";
        assert_eq!(targets(text), vec![("Yes".to_owned(), false)]);
        assert_eq!(scan(text).tags, vec!["yes"]);
    }

    #[test]
    fn tags_follow_obsidian() {
        let s = scan("#work and #nested/tag, not#this, not #123, but #2024-plan and #задача\n");
        assert_eq!(s.tags, vec!["work", "nested/tag", "2024-plan", "задача"]);
    }

    #[test]
    fn frontmatter_properties_and_their_tags() {
        let text = "---\ntitle: Plan\ntags: [work, '#urgent']\nstatus: 3\naliases:\n  - P\n  - The plan\n---\n# Plan\n[[Other]]\n";
        let s = scan(text);
        assert_eq!(
            s.properties,
            vec![
                ("title".to_owned(), Property::Text("Plan".to_owned())),
                (
                    "tags".to_owned(),
                    Property::List(vec!["work".to_owned(), "#urgent".to_owned()])
                ),
                ("status".to_owned(), Property::Text("3".to_owned())),
                (
                    "aliases".to_owned(),
                    Property::List(vec!["P".to_owned(), "The plan".to_owned()])
                ),
            ]
        );
        assert_eq!(s.tags, vec!["work", "urgent"]);
        assert_eq!(targets(text), vec![("Other".to_owned(), false)]);
    }

    #[test]
    fn broken_frontmatter_is_kept_as_text() {
        let s = scan("---\ntitle: [unclosed\n---\n[[Still read]]\n");
        assert!(s.broken_frontmatter);
        assert!(s.properties.is_empty());
        assert_eq!(s.links.len(), 1);
    }

    #[test]
    fn callouts_footnotes_math_and_tables_do_not_hide_links() {
        let text = "> [!note] Title\n> With [[Link A]]\n\nText[^1] and $x^2$ and [[Link B]].\n\n\
                    [^1]: Footnote with [[Link C]].\n\n| a | b |\n|---|---|\n| [[Link D]] | 2 |\n";
        let got: Vec<String> = targets(text).into_iter().map(|(t, _)| t).collect();
        assert_eq!(got, vec!["Link A", "Link B", "Link C", "Link D"]);
    }

    #[test]
    fn markdown_links_to_files_of_the_vault() {
        let text = "[Plan](Folder/My%20Plan.md#Goals), ![pic](img.png), [web](https://x.org), [here](#top)\n";
        let s = scan(text);
        let got: Vec<(&str, bool, bool)> = s
            .links
            .iter()
            .map(|l| (l.target.as_str(), l.embed, l.markdown))
            .collect();
        assert_eq!(
            got,
            vec![("Folder/My Plan.md", false, true), ("img.png", true, true)]
        );
        assert_eq!(s.links[0].anchor.as_deref(), Some("Goals"));
        assert_eq!(percent_encode("My Plan (2)"), "My%20Plan%20%282%29");
        assert_eq!(percent_decode("%D0%98%D0%B4%D0%B5%D1%8F%20%XY"), "Идея %XY");
    }

    #[test]
    fn frontmatter_is_cut_off_byte_for_byte() {
        let text = "---\r\ntitle: A\r\n---\r\nBody\r\n";
        let f = frontmatter(text).expect("frontmatter");
        assert_eq!(f.yaml, "title: A\r\n");
        assert_eq!(&text[f.range.end..], "Body\r\n");
        assert!(frontmatter("No front\n---\n").is_none());
        assert!(frontmatter("---\nunclosed: yes\n").is_none());
        let empty = frontmatter("---\n---\n").expect("empty");
        assert_eq!(empty.yaml, "");
    }

    #[test]
    fn properties_keep_their_types() {
        let p = properties("n: 3\nf: 1.5\nb: true\nd: 2026-10-28\nl: [a, 2]\nnest:\n  a: 1\nz:\n")
            .expect("yaml");
        assert_eq!(
            p,
            vec![
                ("n".to_owned(), Value::Int(3)),
                ("f".to_owned(), Value::Float(1.5)),
                ("b".to_owned(), Value::Bool(true)),
                ("d".to_owned(), Value::Text("2026-10-28".to_owned())),
                (
                    "l".to_owned(),
                    Value::List(vec![Value::Text("a".to_owned()), Value::Int(2)])
                ),
                ("nest".to_owned(), Value::Nested("{a: 1}".to_owned())),
                ("z".to_owned(), Value::Null),
            ]
        );
        assert!(properties("a: [unclosed").is_none());
        assert_eq!(properties("").expect("empty"), vec![]);
    }

    #[test]
    fn tasks_fields_in_emoji_and_dataview() {
        // A NBSP and a variation selector before the date (R2 §7).
        let text = "- [ ] Draft 📅\u{a0}2026-11-01 ⏫ 🆔 a1\n\
                    - [x] Done ✅ 2026-10-20 📅 2026-10-19\n\
                    * [-] Dropped [due:: 2026-12-01] [dependsOn:: a1, b2]\n\
                    - [ ] Wait ⛔ a1,b2 🛫\u{fe0f} 2026-11-02\n\
                    ```\n- [ ] in code 📅 2026-01-01\n```\n\
                    - not a task 📅 2026-01-01\n";
        let items = task_items(text);
        assert_eq!(items.len(), 4);
        assert_eq!(items[0].due.as_deref(), Some("2026-11-01"));
        assert_eq!(items[0].priority, Some("high"));
        assert_eq!(items[0].id.as_deref(), Some("a1"));
        assert!(items[0].open() && !items[1].open() && !items[2].open());
        assert_eq!(items[2].due.as_deref(), Some("2026-12-01"));
        assert_eq!(items[2].depends_on, vec!["a1", "b2"]);
        assert_eq!(items[3].depends_on, vec!["a1", "b2"]);
        assert_eq!(items[3].start.as_deref(), Some("2026-11-02"));
        assert_eq!(
            &text[items[1].line.clone()],
            "- [x] Done ✅ 2026-10-20 📅 2026-10-19"
        );
    }

    #[test]
    fn a_checklist_by_the_strict_rule() {
        let list = checklist("\n- [ ] one\n  - [x] two ^id\n- [ ] three 📅 2026-11-01\n\n")
            .expect("a list");
        assert_eq!(
            list.items,
            vec![
                (0, false, "one".to_owned()),
                (1, true, "two ^id".to_owned()),
                (0, false, "three 📅 2026-11-01".to_owned()),
            ]
        );
        assert_eq!(
            (list.marker, list.indent.as_str(), list.done),
            ('-', "  ", 'x')
        );
        assert_eq!(
            checklist("\t- [X] a\n").map(|c| c.done),
            None,
            "a first item at depth 1"
        );
        for not in [
            "- [ ] a\n\n- [ ] b\n",
            "- [ ] a\n* [ ] b\n",
            "- [x] a\n- [X] b\n",
            "- [-] a\n",
            "# Title\n- [ ] a\n",
            "- [ ] a\n  continued\n",
            "- [ ] a\n    - [ ] too deep\n  - [ ] b\n   - [ ] odd\n",
            "",
        ] {
            assert!(checklist(not).is_none(), "{not:?} is a note");
        }
    }
}
