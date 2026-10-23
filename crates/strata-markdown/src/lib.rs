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

/// One `[[link]]` or `![[embed]]`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Link {
    /// The note it names, without `#heading`, `#^block` and `|alias`.
    pub target: String,
    /// `#heading` or `#^block` after the name, without the `#`.
    pub anchor: Option<String>,
    /// The text after `|`, if any.
    pub alias: Option<String>,
    pub embed: bool,
    /// Bytes of the whole `[[…]]` in the text.
    pub range: Range<usize>,
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
            Event::End(TagEnd::Link | TagEnd::Image) => {
                if let Some((start, embed, dest, label, pothole)) = open.take() {
                    out.links.push(link(
                        &dest,
                        pothole.then_some(label),
                        embed,
                        start..range.end,
                    ));
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
    }
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
