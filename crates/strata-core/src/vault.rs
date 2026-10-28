//! A vault of Obsidian as files (13 §2–3): its paths and bytes, the settings
//! of its config folder, and the formats the import reads besides Markdown —
//! JSON Canvas 1.0 (R2 §5) and the Excalidraw plugin's drawings (R2 §7,
//! R5 §12). Formats are read by their descriptions, not by the plugins'
//! code (13 §1.4 item 5, §8). Nothing here writes: the vault only is read
//! (13 §1.4 item 1).
//!
//! The desktop reads the folder from disk ([`Vault::read`]); a browser hands
//! the files of `<input webkitdirectory>` to the core, so both import the
//! same [`Vault`].

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// One file of the vault: its path from the vault's folder, `/` between
/// folders, as the disk gives it (NFD on macOS, 13 §3.4).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct VaultFile {
    pub path: String,
    #[serde(with = "b64")]
    pub bytes: Vec<u8>,
}

mod b64 {
    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(bytes: &[u8], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&STANDARD.encode(bytes))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
        let s = String::deserialize(d)?;
        STANDARD.decode(s).map_err(serde::de::Error::custom)
    }
}

/// The files of a vault and what the reader passed by.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Vault {
    /// The vault's folder name: the new workspace's or network's name.
    pub name: String,
    pub files: Vec<VaultFile>,
    /// Symbolic links the reader did not follow (13 §2.1): Obsidian does not
    /// watch them either.
    pub symlinks: Vec<String>,
}

impl Vault {
    /// A vault from files handed over: a browser's folder picker.
    pub fn from_files(name: &str, files: Vec<VaultFile>) -> Self {
        Self {
            name: name.to_owned(),
            files,
            symlinks: Vec::new(),
        }
    }

    /// The vault at `root` on disk: every file, symbolic links not followed.
    /// `.trash` is not read at all; other dot folders are, for the config.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn read(root: &std::path::Path) -> std::io::Result<Self> {
        let name = root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let mut vault = Self {
            name,
            ..Self::default()
        };
        let mut stack = vec![(root.to_owned(), String::new())];
        while let Some((dir, prefix)) = stack.pop() {
            let mut entries: Vec<_> = std::fs::read_dir(&dir)?.collect::<Result<_, _>>()?;
            entries.sort_by_key(|e| e.file_name());
            for e in entries {
                let file = e.file_name().to_string_lossy().into_owned();
                let path = if prefix.is_empty() {
                    file.clone()
                } else {
                    format!("{prefix}/{file}")
                };
                let kind = e.file_type()?;
                if kind.is_symlink() {
                    vault.symlinks.push(path);
                } else if kind.is_dir() {
                    if !(prefix.is_empty() && file == ".trash") {
                        stack.push((e.path(), path));
                    }
                } else if kind.is_file() {
                    vault.files.push(VaultFile {
                        path,
                        bytes: std::fs::read(e.path())?,
                    });
                }
            }
        }
        vault.files.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(vault)
    }
}

/// What the import reads of the config folder (R2 §1): the folder is any
/// dot folder with `app.json`, `.obsidian` by default.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Config {
    /// The config folder, `.obsidian` when the vault has none.
    pub dir: String,
    /// `attachmentFolderPath`: `/` the vault's root (Obsidian's default),
    /// `./` or `./sub` beside the note, else a folder of the vault.
    pub attachments: String,
    /// `userIgnoreFilters`: paths whose files Obsidian does not index.
    pub ignore: Vec<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct AppJson {
    #[serde(default)]
    attachment_folder_path: Option<String>,
    #[serde(default)]
    user_ignore_filters: Vec<String>,
}

/// The vault's settings: of the dot folders at its root with `app.json`,
/// `.obsidian` first, else the first by name (13 §3.1 step 1).
pub fn config(files: &[VaultFile]) -> Config {
    let dirs: Vec<&str> = files
        .iter()
        .filter_map(|f| f.path.strip_suffix("/app.json"))
        .filter(|d| d.starts_with('.') && !d.contains('/'))
        .collect();
    let dir = if dirs.contains(&".obsidian") {
        ".obsidian"
    } else {
        dirs.iter().min().copied().unwrap_or(".obsidian")
    };
    let app: AppJson = files
        .iter()
        .find(|f| f.path == format!("{dir}/app.json"))
        .and_then(|f| serde_json::from_slice(&f.bytes).ok())
        .unwrap_or_default();
    Config {
        dir: dir.to_owned(),
        attachments: app
            .attachment_folder_path
            .map(|p| p.trim().to_owned())
            .filter(|p| !p.is_empty())
            .unwrap_or_else(|| "/".to_owned()),
        ignore: app
            .user_ignore_filters
            .into_iter()
            .map(|f| f.trim().to_owned())
            .filter(|f| !f.is_empty())
            .collect(),
    }
}

/// The filter of `userIgnoreFilters` that hides `path`, if any: a filter is
/// a path from the vault's root, a folder or a file. Obsidian also takes
/// `/regular expressions/`; those are matched as plain text inside the path.
pub fn ignored_by<'a>(path: &str, filters: &'a [String]) -> Option<&'a str> {
    filters.iter().map(String::as_str).find(|f| {
        if let Some(re) = f.strip_prefix('/').and_then(|r| r.strip_suffix('/')) {
            return !re.is_empty() && path.contains(re);
        }
        let f = f.trim_start_matches('/');
        let folder = f.trim_end_matches('/');
        path == f || path.starts_with(&format!("{folder}/"))
    })
}

/// A JSON Canvas 1.0 file (R2 §5).
#[derive(Clone, Debug, Default, Deserialize)]
pub struct Canvas {
    #[serde(default)]
    pub nodes: Vec<CanvasNode>,
    #[serde(default)]
    pub edges: Vec<CanvasEdge>,
}

/// The keys of JSON Canvas 1.0; any other is a plugin's, Advanced Canvas's.
const CANVAS_NODE_KEYS: [&str; 13] = [
    "id",
    "type",
    "x",
    "y",
    "width",
    "height",
    "color",
    "text",
    "file",
    "subpath",
    "url",
    "label",
    "background",
];
const CANVAS_EDGE_KEYS: [&str; 9] = [
    "id", "fromNode", "fromSide", "fromEnd", "toNode", "toSide", "toEnd", "color", "label",
];

#[derive(Clone, Debug, Default, Deserialize)]
pub struct CanvasNode {
    #[serde(default)]
    pub id: String,
    /// `text`, `file`, `link` or `group`.
    #[serde(rename = "type", default)]
    pub kind: String,
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
    #[serde(default)]
    pub width: f64,
    #[serde(default)]
    pub height: f64,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub file: Option<String>,
    #[serde(default)]
    pub subpath: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub background: Option<String>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

impl CanvasNode {
    pub fn center(&self) -> (f64, f64) {
        (self.x + self.width / 2.0, self.y + self.height / 2.0)
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasEdge {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub from_node: String,
    #[serde(default)]
    pub to_node: String,
    #[serde(default)]
    pub from_end: Option<String>,
    #[serde(default)]
    pub to_end: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

impl CanvasEdge {
    /// The wire's way (13 §2.7.1): an arrow on `from` only turns it around;
    /// both or none — `from → to`. JSON Canvas puts one on `to` by default.
    pub fn reversed(&self) -> bool {
        let arrow =
            |e: &Option<String>, default: bool| e.as_deref().map_or(default, |s| s == "arrow");
        arrow(&self.from_end, false) && !arrow(&self.to_end, true)
    }
}

impl Canvas {
    pub fn parse(bytes: &[u8]) -> Option<Self> {
        let text = std::str::from_utf8(bytes).ok()?;
        let text = text.strip_prefix('\u{feff}').unwrap_or(text);
        if text.trim().is_empty() {
            return Some(Self::default());
        }
        serde_json::from_str(text).ok()
    }

    /// Keys of plugins (Advanced Canvas, R2 §5): the import leaves them out.
    pub fn foreign_keys(&self) -> usize {
        let nodes = self
            .nodes
            .iter()
            .flat_map(|n| n.extra.keys())
            .filter(|k| !CANVAS_NODE_KEYS.contains(&k.as_str()))
            .count();
        let edges = self
            .edges
            .iter()
            .flat_map(|e| e.extra.keys())
            .filter(|k| !CANVAS_EDGE_KEYS.contains(&k.as_str()))
            .count();
        nodes + edges
    }

    /// `k` of 13 §2.7.2: cards of Canvas are many times larger than bubbles,
    /// so positions shrink until the median distance to the nearest
    /// neighbour is about 120, never more than they are.
    pub fn scale(&self) -> f64 {
        let centers: Vec<(f64, f64)> = self
            .nodes
            .iter()
            .filter(|n| n.kind != "group")
            .map(CanvasNode::center)
            .collect();
        if centers.len() < 2 {
            return 1.0;
        }
        let mut nearest: Vec<f64> = centers
            .iter()
            .enumerate()
            .map(|(i, a)| {
                centers
                    .iter()
                    .enumerate()
                    .filter(|(j, _)| *j != i)
                    .map(|(_, b)| ((a.0 - b.0).powi(2) + (a.1 - b.1).powi(2)).sqrt())
                    .fold(f64::INFINITY, f64::min)
            })
            .collect();
        nearest.sort_by(f64::total_cmp);
        let median = nearest[nearest.len() / 2];
        if median <= 0.0 {
            return 1.0;
        }
        (120.0 / median).clamp(0.1, 1.0)
    }
}

/// A colour of Canvas as a colour of the people palette (13 §2.7.2, 07
/// §2.2): the presets green, cyan, purple; a hex by the nearest hue. Red,
/// orange and yellow are the colours of deadlines (☑ Q-05-8): none, and the
/// answer says so.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Colour {
    None,
    Palette(i64),
    /// Red, orange or yellow: taken off.
    Deadline,
}

pub fn palette_color(c: &str) -> Colour {
    match c.trim() {
        "" => Colour::None,
        "1" | "2" | "3" => Colour::Deadline,
        "4" => Colour::Palette(0),
        "5" => Colour::Palette(1),
        "6" => Colour::Palette(4),
        hex => {
            let Some(h) = hue(hex) else {
                return Colour::None;
            };
            if !(60.0..345.0).contains(&h) {
                return Colour::Deadline;
            }
            // The people palette (design tokens `people`): its hues, grey left out.
            const HUES: [(i64, f64); 7] = [
                (0, 138.0),
                (1, 175.0),
                (2, 193.0),
                (3, 217.0),
                (4, 263.0),
                (5, 292.0),
                (6, 325.0),
            ];
            let dist = |a: f64| (a - h).abs().min(360.0 - (a - h).abs());
            HUES.iter()
                .min_by(|a, b| dist(a.1).total_cmp(&dist(b.1)))
                .map_or(Colour::None, |&(i, _)| Colour::Palette(i))
        }
    }
}

/// The hue of `#rrggbb` or `#rgb`, in degrees; none for grey and for what is no hex.
fn hue(hex: &str) -> Option<f64> {
    let h = hex.strip_prefix('#')?;
    let (r, g, b) = match h.len() {
        6 => (
            u8::from_str_radix(&h[0..2], 16).ok()?,
            u8::from_str_radix(&h[2..4], 16).ok()?,
            u8::from_str_radix(&h[4..6], 16).ok()?,
        ),
        3 => {
            let d = |i: usize| u8::from_str_radix(&h[i..=i], 16).ok().map(|v| v * 17);
            (d(0)?, d(1)?, d(2)?)
        }
        _ => return None,
    };
    let (r, g, b) = (f64::from(r), f64::from(g), f64::from(b));
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let d = max - min;
    if d < 1.0 {
        return None;
    }
    let h = if max == r {
        60.0 * (((g - b) / d) % 6.0)
    } else if max == g {
        60.0 * ((b - r) / d + 2.0)
    } else {
        60.0 * ((r - g) / d + 4.0)
    };
    Some(if h < 0.0 { h + 360.0 } else { h })
}

/// A drawing of the Excalidraw plugin (R2 §7, R5 §12), `.excalidraw.md`
/// or the old plain `.excalidraw`.
#[derive(Clone, Debug, PartialEq)]
pub struct Drawing {
    /// The scene's elements as they are.
    pub elements: Vec<serde_json::Value>,
    /// `## Embedded Files`: Excalidraw's file id → the file's path or link.
    pub files: Vec<(String, String)>,
    /// Markdown above `# Excalidraw Data`, its frontmatter and the plugin's
    /// warning taken off; blank when there is none.
    pub text: String,
    /// Elements in the font slot of the plugin's fork, «Local Font» (R5 §6).
    pub local_font: usize,
}

/// A plain `.excalidraw` file: the scene as JSON.
pub fn excalidraw_json(bytes: &[u8]) -> Option<Drawing> {
    let scene: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    Some(drawing(scene, Vec::new(), String::new()))
}

fn drawing(scene: serde_json::Value, files: Vec<(String, String)>, text: String) -> Drawing {
    let elements = scene
        .get("elements")
        .and_then(|e| e.as_array())
        .cloned()
        .unwrap_or_default();
    let local_font = elements
        .iter()
        .filter(|e| e.get("fontFamily").and_then(serde_json::Value::as_i64) == Some(4))
        .count();
    Drawing {
        elements,
        files,
        text,
        local_font,
    }
}

/// An `.excalidraw.md` file's text (its frontmatter included): the scene in
/// a ` ```compressed-json ` block (LZString, base64, broken into lines) or a
/// ` ```json ` one, the embedded files, the Markdown above the drawing.
/// `## Text Elements` is a derived copy and is not read.
pub fn excalidraw_md(text: &str) -> Option<Drawing> {
    let (above, data) = match text.find("# Excalidraw Data") {
        Some(i) => (&text[..i], &text[i..]),
        None => ("", text),
    };
    let fence = |tag: &str| -> Option<String> {
        let start = data
            .find(&format!("```{tag}\n"))
            .or_else(|| data.find(&format!("```{tag}\r\n")))?;
        let body = &data[start..];
        let body = &body[body.find('\n')? + 1..];
        let end = body.find("```")?;
        Some(body[..end].to_owned())
    };
    let scene: serde_json::Value = if let Some(packed) = fence("compressed-json") {
        let joined: String = packed.chars().filter(|c| !c.is_whitespace()).collect();
        serde_json::from_str(&lz_decompress_base64(&joined)?).ok()?
    } else {
        serde_json::from_str(&fence("json")?).ok()?
    };
    let mut files = Vec::new();
    if let Some(i) = data.find("## Embedded Files") {
        for line in data[i..].lines().skip(1) {
            let line = line.trim();
            if line.starts_with('#') || line.starts_with("%%") {
                break;
            }
            let Some((id, link)) = line.split_once(": ") else {
                continue;
            };
            let link = link.trim();
            let link = link
                .strip_prefix("[[")
                .and_then(|l| l.strip_suffix("]]"))
                .unwrap_or(link);
            let link = link.split('|').next().unwrap_or(link).trim();
            if !id.is_empty() && !link.is_empty() {
                files.push((id.trim().to_owned(), link.to_owned()));
            }
        }
    }
    let body = strata_markdown::frontmatter(above).map_or(above, |f| &above[f.range.end..]);
    let mut kept: Vec<&str> = body
        .lines()
        .filter(|l| !(l.trim_start().starts_with("==⚠") && l.contains("EXCALIDRAW VIEW")))
        .collect();
    while kept.last().is_some_and(|l| l.trim().is_empty()) {
        kept.pop();
    }
    while kept.first().is_some_and(|l| l.trim().is_empty()) {
        kept.remove(0);
    }
    Some(drawing(scene, files, kept.join("\n")))
}

/// LZString's `decompressFromBase64` (lz-string 1.5.0, R2 §7): the
/// Excalidraw plugin packs its scenes so. The crate `lz-str` (spike 11).
pub fn lz_decompress_base64(input: &str) -> Option<String> {
    if input.is_empty() {
        return None;
    }
    lz_str::decompress_from_base64(input).map(|text| String::from_utf16_lossy(&text))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(path: &str, text: &str) -> VaultFile {
        VaultFile {
            path: path.to_owned(),
            bytes: text.as_bytes().to_vec(),
        }
    }

    #[test]
    fn the_config_folder_is_any_dot_folder_with_app_json() {
        let files = vec![
            file(
                ".config/app.json",
                r#"{"attachmentFolderPath":"Files","userIgnoreFilters":["Archive/","/tmp/"]}"#,
            ),
            file("Note.md", "x"),
        ];
        let c = config(&files);
        assert_eq!(c.dir, ".config");
        assert_eq!(c.attachments, "Files");
        assert_eq!(ignored_by("Archive/old.md", &c.ignore), Some("Archive/"));
        assert_eq!(ignored_by("a/tmp/b.md", &c.ignore), Some("/tmp/"));
        assert_eq!(ignored_by("Archived.md", &c.ignore), None);
        assert_eq!(config(&[]).attachments, "/");
    }

    #[test]
    fn lz_string_unpacks_what_it_packed() {
        for s in [
            "a",
            "hello hello hello",
            r#"{"type":"excalidraw","version":2,"elements":[{"id":"e1","text":"Привет, [[Заметка]] 👩‍💻"}]}"#,
            &"абвгд abcde ".repeat(200),
        ] {
            let packed = lz_str::compress_to_base64(s);
            assert_eq!(
                lz_decompress_base64(&packed).as_deref(),
                Some(s),
                "{packed}"
            );
        }
        assert_eq!(lz_decompress_base64(""), None);
    }

    #[test]
    fn colours_of_deadlines_are_taken_off() {
        assert_eq!(palette_color("1"), Colour::Deadline);
        assert_eq!(palette_color("4"), Colour::Palette(0));
        assert_eq!(palette_color("6"), Colour::Palette(4));
        assert_eq!(palette_color("#ff0000"), Colour::Deadline);
        assert_eq!(palette_color("#2ec4b6"), Colour::Palette(1));
        assert_eq!(palette_color("#808080"), Colour::None);
    }

    #[test]
    fn a_drawing_of_the_plugin() {
        let md = "---\nexcalidraw-plugin: parsed\n---\n==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠==\n\nSome words [[Note]]\n\n# Excalidraw Data\n\n## Text Elements\nHi ^a\n\n%%\n## Embedded Files\nabc123: [[pic.png]]\n\n## Drawing\n```json\n{\"type\":\"excalidraw\",\"elements\":[{\"id\":\"e1\",\"type\":\"text\",\"fontFamily\":4}]}\n```\n%%\n";
        let d = excalidraw_md(md).expect("a drawing");
        assert_eq!(d.elements.len(), 1);
        assert_eq!(d.files, vec![("abc123".to_owned(), "pic.png".to_owned())]);
        assert_eq!(d.text, "Some words [[Note]]");
        assert_eq!(d.local_font, 1);
        assert!(excalidraw_md("# Excalidraw Data\nnothing").is_none());
    }

    #[test]
    fn canvas_scale_and_arrows() {
        let c: Canvas = serde_json::from_str(
            r#"{"nodes":[{"id":"a","type":"text","x":0,"y":0,"width":400,"height":200,"text":"A"},
                         {"id":"b","type":"text","x":1200,"y":0,"width":400,"height":200,"text":"B","styleAttributes":{}}],
                "edges":[{"id":"e","fromNode":"a","toNode":"b","fromEnd":"arrow","toEnd":"none"}]}"#,
        )
        .expect("canvas");
        assert!((c.scale() - 0.1).abs() < 1e-9);
        assert!(c.edges[0].reversed());
        assert_eq!(c.foreign_keys(), 1);
    }
}
