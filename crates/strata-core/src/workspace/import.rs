//! Import of an Obsidian vault (13 §2–3, scenario S1 of 04): folders become
//! networks, `.md` notes, tasks or lists, `.canvas` networks with their
//! layout, Excalidraw drawings boards, other files assets by their SHA-256.
//! Properties become attributes, tags and aliases; `[[links]]` become text
//! wires or ghosts by the rule of 13 §3.5, the same the workspace follows
//! after the import.
//!
//! The whole import is one changeset with the origin `import` and one step
//! of undo (13 §1.4 item 3), its text wires in it (§3.1 step 7): undoing
//! it leaves none behind. It is planned here, on a shadow of the workspace,
//! and written in batches by `importing.rs` (§3.3). The vault is only read
//! (item 1). Every loss is a line of the report (item 2, §3.6).

use super::{
    LIST_ITEMS, Result, STATUSES, Store, Val, Workspace, Writes, engine, invalid, is_date, is_when,
    links::{Found, segments},
};
use crate::changeset::{KeyWrite, Label};
use crate::ops::Op;
use crate::vault::{self, Canvas, Colour, Config, Drawing, Vault, VaultFile};
use loro::{ExportMode, LoroDoc, LoroValue};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use strata_layout::{Kind as LayoutKind, Net as LayoutNet, Spacing};
use strata_markdown::{Checklist, Value, link_key};
use strata_model::{EdgeKey, NodeId, NodeKind};

/// The choices of the import window (13 §3.2) the MVP has.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ImportOptions {
    /// A note of `- [ ]` items only becomes a list (13 §2.2).
    pub checklists: bool,
    /// A note with a task's fields in its frontmatter becomes a task (13 §2.1).
    pub tasks: bool,
    /// The network of attachments no note embeds (13 §2.6), in the UI's
    /// language at the time of the import (13 §3.6).
    pub unlinked: String,
    /// The word after a drawing's name for the note of its text (13 §2.8).
    pub text: String,
}

impl Default for ImportOptions {
    fn default() -> Self {
        Self {
            checklists: true,
            tasks: true,
            unlinked: "Unlinked attachments".to_owned(),
            text: "text".to_owned(),
        }
    }
}

/// What came in (13 §3.6, S1 step 7).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImportCounts {
    pub notes: u32,
    pub tasks: u32,
    pub lists: u32,
    pub boards: u32,
    /// Networks made of folders.
    pub folders: u32,
    /// Networks made of `.canvas` files.
    pub canvases: u32,
    pub assets: u32,
    /// Wires the import made: from links in text, properties, canvases, Tasks.
    pub wires: u32,
    pub ghosts: u32,
    /// Files left out: dot folders, `userIgnoreFilters`, symbolic links.
    pub skipped: u32,
}

/// A line of the report (13 §3.6): its section, how serious, the file, the
/// node it leads to, what happened as a message code of `@strata/i18n`
/// (`import.item.<code>`) and its detail.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImportItem {
    /// `ghost`, `ambiguous`, `unsupported`, `renamed`, `property`, `canvas`, `skipped`.
    pub section: String,
    /// `info`, `warn` or `error`: icons, never red (07).
    pub severity: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node: Option<String>,
    pub code: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub detail: String,
    /// A link's target as written, for the row's actions: a ghost's name, an
    /// ambiguous link's name (13 §3.6).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link: Option<String>,
    /// The node the row's action binds the link to: the owner of the alias a
    /// ghost matches, the node an ambiguous link went to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
}

/// The report of an import (13 §3.6).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImportReport {
    /// The network the vault came into.
    pub net: String,
    pub counts: ImportCounts,
    pub items: Vec<ImportItem>,
}

impl ImportReport {
    fn add(&mut self, section: &str, severity: &str, path: &str, code: &str, detail: String) {
        self.items.push(ImportItem {
            section: section.to_owned(),
            severity: severity.to_owned(),
            path: path.to_owned(),
            node: None,
            code: code.to_owned(),
            detail,
            link: None,
            target: None,
        });
    }

    /// The last line's link and the node its action binds it to.
    fn with_link(&mut self, link: &str, target: Option<NodeId>) {
        if let Some(last) = self.items.last_mut() {
            last.link = Some(link.to_owned());
            last.target = target.map(|t| t.to_text());
        }
    }

    fn at(
        &mut self,
        node: NodeId,
        section: &str,
        severity: &str,
        path: &str,
        code: &str,
        detail: String,
    ) {
        self.add(section, severity, path, code, detail);
        if let Some(last) = self.items.last_mut() {
            last.node = Some(node.to_text());
        }
    }
}

/// What a file of the vault becomes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Role {
    Note,
    Task,
    List,
    Board,
    Canvas,
    Asset,
}

impl Role {
    fn kind(self) -> NodeKind {
        match self {
            Self::Note => NodeKind::Note,
            Self::Task => NodeKind::Task,
            Self::List => NodeKind::Checklist,
            Self::Board => NodeKind::Board,
            Self::Canvas => NodeKind::Network,
            Self::Asset => NodeKind::Asset,
        }
    }
}

/// A file of the vault on its way to a node.
struct Entry {
    /// The path as the disk gave it.
    raw: String,
    /// The path in NFC.
    path: String,
    /// Its folder in NFC; `""` is the vault's root.
    folder: String,
    name: String,
    role: Role,
    id: NodeId,
    /// The network of its primary placement.
    net: NodeId,
    /// Markdown of a note or task, without its frontmatter.
    text: Option<String>,
    /// What writing the file back needs (13 §7.1): BOM, line breaks, frontmatter.
    meta: Vec<(&'static str, LoroValue)>,
    list: Option<Checklist>,
    drawing: Option<Drawing>,
    canvas: Option<Canvas>,
    /// A canvas `X/X.canvas`: the layout of folder `X` itself (13 §2.7.1).
    layout: bool,
    props: Vec<(String, Value)>,
    /// The file's type, for an asset; its SHA-256 comes as its batch copies
    /// its bytes (13 §3.3).
    mime: Option<&'static str>,
    /// Link keys of what it embeds, by path segments (13 §2.6).
    embeds: Vec<Vec<String>>,
}

/// A node the import makes of no file: a card of a canvas, a drawing's text.
struct Card {
    id: NodeId,
    kind: NodeKind,
    name: String,
    net: NodeId,
    pos: (f64, f64),
    text: Option<String>,
    url: Option<String>,
    path: String,
}

/// Keys of 05 §6.1 a frontmatter names in its words (13 §2.3).
const STATUS: [&str; 2] = ["status", "статус"];
const DEADLINE: [&str; 4] = ["due", "deadline", "дедлайн", "срок"];
const START: [&str; 2] = ["start", "начало"];
const PRIORITY: [&str; 2] = ["priority", "приоритет"];
const ASSIGNEES: [&str; 3] = ["assignees", "assignee", "ответственные"];
/// Keys that stay in the frontmatter's form only (13 §2.3).
const FORM_ONLY: [&str; 6] = [
    "cssclasses",
    "cssclass",
    "publish",
    "permalink",
    "kanban-plugin",
    "updated",
];
/// A name with these cannot be linked to (13 §3.4, R2 §2).
const UNLINKABLE: [&str; 7] = ["#", "|", "^", ":", "%%", "[[", "]]"];
/// The distance between bubbles of a network laid out in a grid.
const STEP: f64 = 160.0;

fn is_one_of(key: &str, keys: &[&str]) -> bool {
    let k = key.to_lowercase();
    keys.contains(&k.as_str())
}

fn nfc(s: &str) -> String {
    strata_markdown::nfc(s)
}

/// A name as a node keeps it: control characters and edge spaces off (13 §3.4).
fn clean(name: &str) -> String {
    name.chars()
        .filter(|c| !c.is_control())
        .collect::<String>()
        .trim()
        .to_owned()
}

/// A status in the words of a vault (13 §2.3) as one of 05 §6.1.
fn status_of(v: &str) -> Option<&'static str> {
    let v = v.trim().to_lowercase().replace(['_', '-'], " ");
    let s = match v.as_str() {
        "inbox" | "backlog" | "входящие" | "new" => "inbox",
        "todo" | "to do" | "open" | "planned" | "к работе" | "сделать" => "todo",
        "doing" | "in progress" | "wip" | "active" | "started" | "в работе" => "doing",
        "review" | "in review" | "на проверке" => "review",
        "done" | "complete" | "completed" | "closed" | "готово" | "сделано" => "done",
        "cancelled" | "canceled" | "dropped" | "отменено" => "cancelled",
        _ => return None,
    };
    STATUSES.contains(&s).then_some(s)
}

/// A priority in the words of a vault (13 §2.3).
fn priority_of(v: &str) -> Option<&'static str> {
    Some(match v.trim().to_lowercase().as_str() {
        "lowest" | "low" | "низкий" => "low",
        "medium" | "normal" | "средний" => "medium",
        "high" | "высокий" => "high",
        "highest" | "urgent" | "срочный" => "urgent",
        _ => return None,
    })
}

/// A date or date-time of Obsidian as 05 §6.1 keeps it: `YYYY-MM-DD` or
/// `YYYY-MM-DDTHH:MM`; seconds are dropped.
fn when_of(v: &str) -> Option<String> {
    let v = v.trim().replacen(' ', "T", 1);
    if is_date(&v) {
        return Some(v);
    }
    let short = v.get(..16)?;
    is_when(short).then(|| short.to_owned())
}

/// Milliseconds since the epoch of a day, `YYYY-MM-DD`, at UTC midnight.
fn day_ms(day: &str) -> Option<i64> {
    if !is_date(day.get(..10)?) {
        return None;
    }
    let num = |r: std::ops::Range<usize>| day.get(r).and_then(|x| x.parse::<i64>().ok());
    let (y, m, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    // Days from the civil date (Howard Hinnant's algorithm).
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some((era * 146_097 + doe - 719_468) * 86_400_000)
}

/// A file's type by its extension (05 §4.4); none — the UI reads its bytes.
fn mime_of(name: &str) -> Option<&'static str> {
    let ext = name.rsplit_once('.')?.1.to_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        "heic" => "image/heic",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "m4a" => "audio/mp4",
        "flac" => "audio/flac",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "pdf" => "application/pdf",
        "txt" => "text/plain",
        "json" => "application/json",
        "csv" => "text/csv",
        _ => return None,
    })
}

/// `[[X]]` as a whole value of a property (13 §2.3): `X`.
fn property_link(s: &str) -> Option<String> {
    let inner = s.trim().strip_prefix("[[")?.strip_suffix("]]")?;
    let target = inner.split('|').next()?.split('#').next()?.trim();
    (!target.is_empty()).then(|| target.to_owned())
}

/// Position `i` of `n` in a grid.
fn grid(i: usize, n: usize) -> (f64, f64) {
    let cols = ((n as f64).sqrt().ceil() as usize).max(1);
    ((i % cols) as f64 * STEP, (i / cols) as f64 * STEP)
}

/// What the import placed in one network (06 §9.3): where its grid began —
/// the free corner beside what the network held — and each node.
struct Laying {
    net: NodeId,
    corner: (f64, f64),
    nodes: Vec<Laid>,
}

/// A node the import placed: where it stands, and whether a canvas put it there.
struct Laid {
    id: NodeId,
    at: (f64, f64),
    pinned: bool,
}

/// A bubble's radius for `L`: folders and projects M, 48 across; the rest S, 32 (07 §4.2).
fn radius(kind: Option<NodeKind>) -> f32 {
    match kind {
        Some(NodeKind::Network | NodeKind::Project) => 24.0,
        _ => 16.0,
    }
}

/// A wire's ends as its record has them; none for a ghost's.
fn ends(v: &Val) -> Option<(NodeId, NodeId)> {
    let end = |k: &str| {
        v.get(k)
            .and_then(Val::as_str)
            .and_then(|s| NodeId::parse(s).ok())
    };
    Some((end("from")?, end("to")?))
}

/// A JSON value as a Loro value: an Excalidraw element kept whole.
fn loro_of(v: &serde_json::Value) -> LoroValue {
    match v {
        serde_json::Value::Null => LoroValue::Null,
        serde_json::Value::Bool(b) => LoroValue::Bool(*b),
        serde_json::Value::Number(n) => match n.as_i64() {
            Some(i) => LoroValue::I64(i),
            None => LoroValue::Double(n.as_f64().unwrap_or(0.0)),
        },
        serde_json::Value::String(s) => LoroValue::from(s.as_str()),
        serde_json::Value::Array(a) => LoroValue::from(a.iter().map(loro_of).collect::<Vec<_>>()),
        serde_json::Value::Object(o) => LoroValue::from(
            o.iter()
                .map(|(k, v)| (k.clone(), loro_of(v)))
                .collect::<HashMap<_, _>>(),
        ),
    }
}

/// A property as an attribute's value (05 §6.2); none for an empty one.
fn val_of(v: &Value) -> Option<Val> {
    Some(match v {
        Value::Null => return None,
        Value::Bool(b) => Val::Bool(*b),
        Value::Int(i) => Val::Int(*i),
        Value::Float(f) => Val::Float(*f),
        Value::Text(s) | Value::Nested(s) => Val::Str(s.clone()),
        Value::List(l) => Val::List(l.iter().filter_map(val_of).collect()),
    })
}

/// Whether a value fits the type `types.json` gives its key (13 §2.3).
fn fits(kind: &str, v: &Value) -> bool {
    match (kind, v) {
        (_, Value::Null) => true,
        ("number", Value::Int(_) | Value::Float(_)) => true,
        ("number", _) => false,
        ("checkbox", Value::Bool(_)) => true,
        ("checkbox", _) => false,
        ("date", Value::Text(s)) => is_date(s.trim()),
        ("datetime", Value::Text(s)) => when_of(s).is_some(),
        ("date" | "datetime", _) => false,
        ("multitext" | "tags" | "aliases", Value::List(_) | Value::Text(_)) => true,
        ("multitext" | "tags" | "aliases", _) => false,
        ("text", Value::List(_) | Value::Nested(_)) => false,
        _ => true,
    }
}

/// The texts of a `tags` property: a list, or words split by commas and spaces.
fn tag_texts(v: &Value) -> Vec<String> {
    let texts = match v {
        Value::Text(t) => t
            .split([',', ' '])
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect(),
        other => other.texts(),
    };
    texts
        .into_iter()
        .map(|t| t.trim().trim_start_matches('#').to_owned())
        .filter(|t| !t.is_empty())
        .collect()
}

/// Line breaks of a file (13 §7.1, as `packages/editor/src/source.ts`):
/// all `\r\n` — `crlf`, taken out of the text; none — `lf`; mixed — `raw`,
/// kept in the text as they are.
fn line_breaks(s: &str) -> (&'static str, String) {
    let crlf = s.matches("\r\n").count();
    let lf = s.matches('\n').count();
    let cr = s.matches('\r').count();
    if crlf == 0 && cr == 0 {
        ("lf", s.to_owned())
    } else if crlf == lf && crlf == cr {
        ("crlf", s.replace("\r\n", "\n"))
    } else {
        ("raw", s.to_owned())
    }
}

/// Syntax of plugins Strata keeps as text and does not run (13 §2.9).
fn unsupported(text: &str) -> Vec<&'static str> {
    let mut out = Vec::new();
    for (mark, code) in [
        ("```dataviewjs", "dataviewjs"),
        ("```dataview", "dataview"),
        ("```query", "query"),
        ("```tasks", "tasksQuery"),
        ("<%", "templater"),
    ] {
        let found = text.lines().any(|l| {
            let l = l.trim_start();
            if mark.starts_with("```") {
                l.strip_prefix(mark)
                    .is_some_and(|rest| rest.trim().is_empty())
            } else {
                l.contains(mark)
            }
        });
        if found {
            out.push(code);
        }
    }
    out
}

impl<S: Store> Workspace<S> {
    /// A vault into network `target`, planned on a shadow of the workspace
    /// (13 §3.3): every key the import writes, its content documents and
    /// assets by batch, the report (13 §3.6). Nothing reaches a store.
    pub(super) fn plan_vault(
        &mut self,
        vault: &Vault,
        target: NodeId,
        options: &ImportOptions,
    ) -> Result<Plan> {
        let cfg = vault::config(&vault.files);
        let mut report = ImportReport {
            net: target.to_text(),
            ..ImportReport::default()
        };
        for link in &vault.symlinks {
            report.add("skipped", "info", link, "symlink", String::new());
            report.counts.skipped += 1;
        }
        // No config folder: a vault never opened in Obsidian, or a browser
        // that leaves dot folders out of a picked folder (Safari).
        if !vault
            .files
            .iter()
            .any(|f| f.path == format!("{}/app.json", cfg.dir))
        {
            report.add("skipped", "info", &cfg.dir, "noConfig", String::new());
        }
        let types = self.types(&vault.files, &cfg);
        let mut entries = self.read_entries(vault, &cfg, options, target, &mut report);
        if entries.is_empty() && vault.files.is_empty() {
            return Err(invalid("the folder has no files"));
        }

        // Folders → networks (13 §2.1); a canvas `X/X.canvas` lays out `X`.
        let mut folders: BTreeMap<String, NodeId> = BTreeMap::new();
        folders.insert(String::new(), target);
        for e in entries.iter_mut() {
            if e.role == Role::Canvas {
                let own = e.folder.rsplit('/').next().unwrap_or_default();
                let root_name = nfc(vault.name.trim());
                let named_by_folder = if e.folder.is_empty() {
                    !root_name.is_empty() && link_key(&root_name) == link_key(&e.name)
                } else {
                    link_key(own) == link_key(&e.name)
                };
                e.layout = named_by_folder;
            }
        }
        self.place_attachments(&mut entries, &cfg, options, &mut folders);
        for e in &entries {
            let mut at = e.folder.as_str();
            while !at.is_empty() && !folders.contains_key(at) {
                folders.insert(at.to_owned(), NodeId::new());
                at = at.rsplit_once('/').map_or("", |(p, _)| p);
            }
        }
        // Where each entry lies: its folder's network unless decided already.
        let nets: HashMap<String, NodeId> = folders.iter().map(|(k, v)| (k.clone(), *v)).collect();
        for e in entries.iter_mut() {
            if e.net == target && !e.folder.is_empty() {
                e.net = nets[&e.folder];
            }
            if e.layout {
                // The canvas is its folder's layout: it makes no network of its own.
                let (was, now) = (e.id.to_text(), nets[&e.folder]);
                for item in report
                    .items
                    .iter_mut()
                    .filter(|i| i.node.as_deref() == Some(&was))
                {
                    item.node = Some(now.to_text());
                }
                e.id = now;
            }
        }
        report.counts.folders = (folders.len() - 1) as u32;

        // Cards of the canvases, appearances, boxes and wires between cards.
        let by_path: HashMap<String, usize> = entries
            .iter()
            .enumerate()
            .map(|(i, e)| (e.path.clone(), i))
            .collect();
        let mut cards: Vec<Card> = Vec::new();
        let mut appear: Vec<(NodeId, NodeId, f64, f64)> = Vec::new();
        let mut layout: HashMap<(NodeId, NodeId), (f64, f64)> = HashMap::new();
        let mut raw: Writes = Vec::new();
        let mut colors: HashMap<NodeId, HashMap<i64, u32>> = HashMap::new();
        let ts = (self.clock)();
        self.lay_canvases(
            &entries,
            &by_path,
            &mut cards,
            &mut appear,
            &mut layout,
            &mut raw,
            &mut colors,
            ts,
            &mut report,
        );
        // A drawing's text above it: a note beside the board (13 §2.8).
        for e in &entries {
            let Some(d) = e.drawing.as_ref().filter(|d| !d.text.trim().is_empty()) else {
                continue;
            };
            let id = NodeId::new();
            cards.push(Card {
                id,
                kind: NodeKind::Note,
                name: format!("{} — {}", e.name, options.text),
                net: e.net,
                pos: (0.0, 0.0),
                text: Some(d.text.clone()),
                url: None,
                path: e.raw.clone(),
            });
            self.import_wire(&mut raw, e.id, id, None, ts);
            report.at(
                e.id,
                "unsupported",
                "info",
                &e.raw,
                "drawingText",
                String::new(),
            );
        }

        // Positions: a canvas's own; a grid by name for the rest (13 §3.1 step 8).
        let mut members: BTreeMap<NodeId, Vec<(u8, String, NodeId)>> = BTreeMap::new();
        for (path, &id) in &folders {
            if path.is_empty() {
                continue;
            }
            let parent = nets[path.rsplit_once('/').map_or("", |(p, _)| p)];
            let name = path.rsplit('/').next().unwrap_or_default();
            members
                .entry(parent)
                .or_default()
                .push((0, link_key(name), id));
        }
        for e in &entries {
            if !e.layout {
                let rank = u8::from(e.role != Role::Canvas);
                members
                    .entry(e.net)
                    .or_default()
                    .push((rank, link_key(&e.name), e.id));
            }
        }
        for c in cards.iter().filter(|c| c.pos == (0.0, 0.0)) {
            members
                .entry(c.net)
                .or_default()
                .push((2, link_key(&c.name), c.id));
        }
        let mut pos: HashMap<NodeId, (f64, f64)> = HashMap::new();
        let mut laying: Vec<Laying> = Vec::new();
        for (net, list) in members.iter_mut() {
            list.sort();
            // Beside what the network holds already; `L` comes in the step.
            let (dx, dy) = self.free_corner(*net);
            let mut lay = Laying {
                net: *net,
                corner: (dx, dy),
                nodes: Vec::with_capacity(list.len()),
            };
            for (i, (_, _, id)) in list.iter().enumerate() {
                let canvas = layout.get(&(*net, *id)).copied();
                let p = canvas.unwrap_or_else(|| {
                    let (x, y) = grid(i, list.len());
                    (x + dx, y + dy)
                });
                pos.insert(*id, p);
                lay.nodes.push(Laid {
                    id: *id,
                    at: p,
                    pinned: canvas.is_some(),
                });
            }
            laying.push(lay);
        }
        for c in &cards {
            if c.pos != (0.0, 0.0) {
                pos.insert(c.id, c.pos);
            }
        }

        // The operations: networks first, parents before children.
        let mut ops: Vec<Op> = Vec::new();
        let mut order: Vec<(&String, &NodeId)> =
            folders.iter().filter(|(p, _)| !p.is_empty()).collect();
        order.sort_by_key(|(p, _)| (p.matches('/').count(), (*p).clone()));
        for (path, id) in order {
            let parent = nets[path.rsplit_once('/').map_or("", |(p, _)| p)];
            let name = clean(path.rsplit('/').next().unwrap_or_default());
            let (x, y) = pos.get(id).copied().unwrap_or_default();
            ops.push(Op::CreateNode {
                id: Some(id.to_text()),
                kind: NodeKind::Network,
                name,
                net: parent.to_text(),
                x,
                y,
            });
        }
        // Canvases next: their cards and appearances go into them.
        let mut sorted: Vec<&Entry> = entries.iter().filter(|e| !e.layout).collect();
        sorted.sort_by_key(|e| (e.role != Role::Canvas, e.path.clone()));
        for e in sorted {
            let (x, y) = pos.get(&e.id).copied().unwrap_or_default();
            ops.push(Op::CreateNode {
                id: Some(e.id.to_text()),
                kind: e.role.kind(),
                name: e.name.clone(),
                net: e.net.to_text(),
                x,
                y,
            });
            if let Some(m) = e.mime.filter(|_| e.role == Role::Asset) {
                ops.push(Op::SetAttr {
                    id: e.id.to_text(),
                    key: "mime".to_owned(),
                    value: Some(Val::str(m)),
                });
            }
        }
        for c in &cards {
            let (x, y) = pos.get(&c.id).copied().unwrap_or_default();
            ops.push(Op::CreateNode {
                id: Some(c.id.to_text()),
                kind: c.kind,
                name: c.name.clone(),
                net: c.net.to_text(),
                x,
                y,
            });
            if let Some(url) = &c.url {
                ops.push(Op::SetAttr {
                    id: c.id.to_text(),
                    key: "url".to_owned(),
                    value: Some(Val::str(url.clone())),
                });
            }
        }
        for &(id, net, x, y) in &appear {
            ops.push(Op::Place {
                id: id.to_text(),
                net: net.to_text(),
                x,
                y,
            });
        }
        // A node's colour: the commonest of its cards; none on a tie (13 §2.7.2).
        for (id, tally) in &colors {
            let best = tally.values().max().copied().unwrap_or(0);
            let top: Vec<i64> = tally
                .iter()
                .filter(|(_, n)| **n == best)
                .map(|(c, _)| *c)
                .collect();
            if let [c] = top.as_slice() {
                ops.push(Op::SetAttr {
                    id: id.to_text(),
                    key: "color".to_owned(),
                    value: Some(Val::Int(*c)),
                });
            }
        }
        // Properties: the task's fields, people, tags, aliases, the rest (13 §2.3).
        let mut people = self.people_by_name();
        let mut links: Vec<(NodeId, String, String)> = Vec::new();
        for e in &entries {
            self.properties(
                e,
                &types,
                &mut ops,
                &mut raw,
                &mut people,
                &mut links,
                &mut report,
            );
        }
        // Tasks' dependencies (13 §2.9.1): `🆔 a1` … `⛔ a1`, between nodes.
        let mut ids: HashMap<String, NodeId> = HashMap::new();
        let mut deps: Vec<(NodeId, String)> = Vec::new();
        for e in &entries {
            let Some(text) = &e.text else { continue };
            for item in strata_markdown::task_items(text) {
                if let Some(id) = item.id {
                    ids.entry(id).or_insert(e.id);
                }
                deps.extend(item.depends_on.into_iter().map(|d| (e.id, d)));
            }
        }
        for (to, dep) in deps {
            if let Some(&from) = ids.get(&dep).filter(|&&f| f != to) {
                self.import_wire(&mut raw, from, to, None, ts);
            }
        }
        // A drawing's links (13 §2.8), found as text's are.
        for e in &entries {
            for target in e.drawing.iter().flat_map(drawing_links) {
                links.push((e.id, target, e.raw.clone()));
            }
        }

        // Every key the import writes, on this shadow: networks and nodes
        // first, then what is found among them by the rule of 13 §3.5
        // (§3.1 step 7). The assets' bytes come with their batches.
        for op in &ops {
            if let Op::CreateNode { net, .. } | Op::Place { net, .. } = op {
                self.ensure_doc(&format!("net/{net}"))?;
            }
        }
        for (doc, ..) in &raw {
            self.ensure_doc(doc)?;
        }
        let mut first = self.plan(&ops)?;
        first.extend(raw);
        // The wires `L` reads (☑ Q-13-3): (from, to) → only from text.
        let mut wires: BTreeMap<(NodeId, NodeId), bool> = BTreeMap::new();
        for (_, map, _, v) in &first {
            if map == "edge"
                && let Some((a, b)) = v.as_ref().and_then(ends)
            {
                wires.insert((a, b), false);
            }
        }
        let notes: Vec<(NodeId, &str)> = entries
            .iter()
            .filter(|e| e.role == Role::Note)
            .filter_map(|e| Some((e.id, e.text.as_deref()?)))
            .chain(
                cards
                    .iter()
                    .filter(|c| c.kind == NodeKind::Note)
                    .filter_map(|c| Some((c.id, c.text.as_deref()?))),
            )
            .collect();
        let mut unresolved: Vec<(NodeId, String, String)> = Vec::new();
        let mut asks = Vec::new();
        let writes = self.apply_two(first, |ws| {
            // Links of properties and drawings, among the nodes just made.
            let names = ws.link_names();
            let mut out: Writes = Vec::new();
            for (from, target, path) in &links {
                let segs = segments(&link_key(target));
                let to =
                    match ws.candidates(*from, &segs, &BTreeSet::new(), &names, &HashMap::new()) {
                        Found::Some(f) if f.is_empty() => {
                            unresolved.push((*from, target.clone(), path.clone()));
                            continue;
                        }
                        Found::Some(f) if f.len() == 1 => f[0],
                        Found::Some(f) => ws.nearest(*from, &f),
                        Found::Held(to) => to,
                    };
                if to != *from {
                    ws.import_wire(&mut out, *from, to, None, ts);
                    wires.insert((*from, to), false);
                }
            }
            // The notes' text wires and ghosts, as the core keeps them after
            // any edit (05 §8.2 rule 4, §8.5), in this same step.
            let (text, asked) = ws.links_plan(&notes, ts);
            for (&(note, _), a) in notes.iter().zip(&asked) {
                for &to in &a.want {
                    wires.entry((note, to)).or_insert(true);
                }
            }
            out.extend(text);
            asks = asked;
            // `L` once, in this same step (06 §9.3, ☑ Q-13-19).
            out.extend(ws.lay_out(&laying, &wires));
            Ok(out)
        })?;

        // The report: what came in, ghosts and ambiguous links (13 §3.6).
        report.counts.ghosts += unresolved.len() as u32;
        for (from, target, path) in unresolved {
            report.at(
                from,
                "ghost",
                "warn",
                &path,
                "ghostProperty",
                format!("[[{target}]]"),
            );
        }
        report.counts.wires += writes
            .iter()
            .filter(|w| w.map == "edgeOrigin" && w.key.ends_with("|import"))
            .count() as u32;
        let paths: HashMap<NodeId, String> = entries
            .iter()
            .map(|e| (e.id, e.raw.clone()))
            .chain(cards.iter().map(|c| (c.id, c.path.clone())))
            .collect();
        let mut aliases: HashMap<String, (String, NodeId)> = HashMap::new();
        for e in &entries {
            for (k, v) in &e.props {
                if is_one_of(k, &["aliases", "alias"]) {
                    for a in v.texts() {
                        aliases
                            .entry(link_key(&a))
                            .or_insert_with(|| (e.name.clone(), e.id));
                    }
                }
            }
        }
        let imported: BTreeSet<NodeId> = notes.iter().map(|&(n, _)| n).collect();
        for (&(note, _), a) in notes.iter().zip(&asks) {
            let path = paths.get(&note).cloned().unwrap_or_default();
            report.counts.wires += a.want.len() as u32;
            report.counts.ghosts += a.ghosts.len() as u32;
            for (k, name) in &a.ghosts {
                match aliases.get(k) {
                    Some((owner, id)) => {
                        report.at(
                            note,
                            "ghost",
                            "info",
                            &path,
                            "ghostAlias",
                            format!("[[{name}]] → {owner}"),
                        );
                        report.with_link(name, Some(*id));
                    }
                    None => {
                        report.at(note, "ghost", "info", &path, "ghost", format!("[[{name}]]"));
                        report.with_link(name, None);
                    }
                }
            }
            for (target, chosen, count) in &a.ambiguous {
                report.at(
                    note,
                    "ambiguous",
                    "warn",
                    &path,
                    "ambiguous",
                    format!("[[{target}]] → {} ({count})", self.path_text(*chosen)),
                );
                report.with_link(target, Some(*chosen));
            }
        }
        for e in &entries {
            match e.role {
                Role::Note => report.counts.notes += 1,
                Role::Task => report.counts.tasks += 1,
                Role::List => report.counts.lists += 1,
                Role::Board => report.counts.boards += 1,
                Role::Canvas => report.counts.canvases += 1,
                Role::Asset => report.counts.assets += 1,
            }
        }
        for c in &cards {
            match c.kind {
                NodeKind::Asset => report.counts.assets += 1,
                _ => report.counts.notes += 1,
            }
        }

        // Batches (13 §3.3): the networks and what the canvases bring first,
        // then the files network by network, `BATCH_FILES` a batch.
        let mut rank: HashMap<NodeId, usize> = HashMap::new();
        let mut files: Vec<u32> = vec![0];
        for id in folders.values() {
            rank.insert(*id, 0);
        }
        for e in entries.iter().filter(|e| e.role == Role::Canvas) {
            rank.insert(e.id, 0);
            files[0] += 1;
        }
        for c in &cards {
            rank.insert(c.id, 0);
        }
        let mut order: Vec<&Entry> = entries.iter().filter(|e| e.role != Role::Canvas).collect();
        order.sort_by(|a, b| (&a.folder, &a.path).cmp(&(&b.folder, &b.path)));
        let size = batch_files().max(1);
        for (i, e) in order.iter().enumerate() {
            let b = 1 + i / size;
            rank.insert(e.id, b);
            if files.len() <= b {
                files.push(0);
            }
            files[b] += 1;
        }
        let batches = files.len();
        let mut contents: Vec<Vec<Content>> = (0..batches).map(|_| Vec::new()).collect();
        let mut assets: Vec<Vec<(NodeId, String)>> = (0..batches).map(|_| Vec::new()).collect();
        for e in entries {
            let b = rank.get(&e.id).copied().unwrap_or(0);
            if e.role == Role::Asset {
                assets[b].push((e.id, e.raw.clone()));
            }
            let c = Content {
                node: e.id,
                text: e.text,
                meta: e.meta,
                list: e.list,
                drawing: e.drawing,
            };
            if !c.is_empty() {
                contents[b].push(c);
            }
        }
        for c in cards {
            if let Some(text) = c.text {
                contents[0].push(Content {
                    node: c.id,
                    text: Some(text),
                    meta: Vec::new(),
                    list: None,
                    drawing: None,
                });
            }
        }
        let label = {
            let mut l = Label::new("core.change.import");
            l.params.insert("name".into(), vault.name.clone().into());
            l
        };
        Ok(Plan {
            label,
            writes: by_batch(writes, &rank, batches),
            files,
            contents,
            assets,
            report,
            notes: imported,
            config: cfg,
        })
    }

    /// `types.json` of the config folder (R2 §1): key → type.
    fn types(&self, files: &[VaultFile], cfg: &Config) -> HashMap<String, String> {
        #[derive(Deserialize, Default)]
        struct Types {
            #[serde(default)]
            types: HashMap<String, String>,
        }
        files
            .iter()
            .find(|f| f.path == format!("{}/types.json", cfg.dir))
            .and_then(|f| serde_json::from_slice::<Types>(&f.bytes).ok())
            .unwrap_or_default()
            .types
    }

    /// The files of the vault as entries: what each becomes (13 §2.1), its
    /// name (13 §3.4), its text and frontmatter; what is left out — to the report.
    fn read_entries(
        &mut self,
        vault: &Vault,
        cfg: &Config,
        options: &ImportOptions,
        target: NodeId,
        report: &mut ImportReport,
    ) -> Vec<Entry> {
        let mut out: Vec<Entry> = Vec::new();
        let mut dots = 0u32;
        let mut ignored: BTreeMap<String, u32> = BTreeMap::new();
        let mut files: Vec<&VaultFile> = vault.files.iter().collect();
        files.sort_by(|a, b| a.path.cmp(&b.path));
        // Folders with a config folder of their own: vaults inside the vault.
        let nested: BTreeSet<String> = files
            .iter()
            .filter_map(|f| f.path.strip_suffix("/app.json"))
            .filter_map(|d| d.rsplit_once('/'))
            .filter(|(parent, dot)| {
                dot.starts_with('.') && !parent.split('/').any(|c| c.starts_with('.'))
            })
            .map(|(parent, _)| parent.to_owned())
            .collect();
        for n in &nested {
            report.add("skipped", "info", n, "nestedVault", String::new());
        }
        for f in files {
            let path = f.path.trim_start_matches('/');
            let parts: Vec<&str> = path.split('/').collect();
            if parts.iter().any(|p| p.starts_with('.')) {
                if !path.starts_with(&format!("{}/", cfg.dir)) {
                    dots += 1;
                }
                continue;
            }
            if let Some(filter) = vault::ignored_by(path, &cfg.ignore) {
                *ignored.entry(filter.to_owned()).or_default() += 1;
                continue;
            }
            let file = parts.last().copied().unwrap_or_default();
            let raw_folder = parts[..parts.len() - 1].join("/");
            let folder = raw_folder
                .split('/')
                .filter(|s| !s.is_empty())
                .map(|s| clean(&nfc(s)))
                .collect::<Vec<_>>()
                .join("/");
            let (stem, role) = if let Some(s) = strip_ci(file, ".excalidraw.md") {
                (s, Role::Board)
            } else if let Some(s) = strip_ci(file, ".md") {
                (s, Role::Note)
            } else if let Some(s) = strip_ci(file, ".canvas") {
                (s, Role::Canvas)
            } else if let Some(s) = strip_ci(file, ".excalidraw") {
                (s, Role::Board)
            } else {
                (file, Role::Asset)
            };
            let mut e = Entry {
                raw: path.to_owned(),
                path: format!(
                    "{}{}",
                    if folder.is_empty() {
                        String::new()
                    } else {
                        format!("{folder}/")
                    },
                    clean(&nfc(file))
                ),
                folder,
                name: clean(&nfc(stem)),
                role,
                id: NodeId::new(),
                net: target,
                text: None,
                meta: Vec::new(),
                list: None,
                drawing: None,
                canvas: None,
                layout: false,
                props: Vec::new(),
                mime: None,
                embeds: Vec::new(),
            };
            // Names (13 §3.4): NFC, edges trimmed, what breaks links.
            if nfc(stem) != stem {
                report.at(e.id, "renamed", "info", path, "nfc", e.name.clone());
            }
            if clean(&nfc(stem)) != nfc(stem) {
                report.at(e.id, "renamed", "info", path, "trimmed", e.name.clone());
            }
            if UNLINKABLE.iter().any(|c| e.name.contains(c)) {
                report.at(e.id, "renamed", "warn", path, "unlinkable", e.name.clone());
            }
            if e.name.is_empty() {
                e.name = clean(&nfc(file));
            }
            let md =
                matches!(role, Role::Note | Role::Board) && file.to_lowercase().ends_with(".md");
            if md {
                match std::str::from_utf8(&f.bytes) {
                    Ok(s) => self.read_markdown(&mut e, s, options, report),
                    Err(_) => {
                        // Not UTF-8: the bytes as an asset, unedited (13 §2.1).
                        report.at(e.id, "skipped", "warn", path, "notUtf8", String::new());
                        e.role = Role::Asset;
                        e.name = clean(&nfc(file));
                    }
                }
            } else if role == Role::Board {
                match vault::excalidraw_json(&f.bytes) {
                    Some(d) => e.drawing = Some(d),
                    None => {
                        report.at(
                            e.id,
                            "unsupported",
                            "warn",
                            path,
                            "drawingBroken",
                            String::new(),
                        );
                        e.role = Role::Asset;
                        e.name = clean(&nfc(file));
                    }
                }
            } else if role == Role::Canvas {
                match Canvas::parse(&f.bytes) {
                    Some(c) => e.canvas = Some(c),
                    None => {
                        report.at(e.id, "canvas", "warn", path, "canvasBroken", String::new());
                        e.role = Role::Asset;
                        e.name = clean(&nfc(file));
                    }
                }
            }
            if e.role == Role::Asset {
                e.name = clean(&nfc(file));
                e.mime = mime_of(file);
            }
            out.push(e);
        }
        if dots > 0 {
            report.add("skipped", "info", "", "dotFiles", dots.to_string());
            report.counts.skipped += dots;
        }
        for (filter, n) in ignored {
            report.add("skipped", "info", &filter, "ignored", n.to_string());
            report.counts.skipped += n;
        }
        // Two names a link cannot tell apart in one folder (13 §3.4).
        let mut seen: HashMap<(String, String), &str> = HashMap::new();
        for e in &out {
            let key = (e.folder.clone(), link_key(&e.name));
            if let Some(other) = seen.get(&key) {
                report.at(
                    e.id,
                    "renamed",
                    "warn",
                    &e.raw,
                    "caseConflict",
                    (*other).to_owned(),
                );
            } else {
                seen.insert(key, &e.raw);
            }
        }
        out
    }

    /// A Markdown file's text: BOM and line breaks to `meta`, its
    /// frontmatter's properties, its kind (13 §2.1–2.3, §7.1).
    fn read_markdown(
        &self,
        e: &mut Entry,
        s: &str,
        options: &ImportOptions,
        report: &mut ImportReport,
    ) {
        let bom = s.starts_with('\u{feff}');
        let s = s.strip_prefix('\u{feff}').unwrap_or(s);
        let (eol, text) = line_breaks(s);
        let mut body = text.as_str();
        e.meta.push(("schema", LoroValue::I64(1)));
        e.meta.push(("bom", LoroValue::Bool(bom)));
        e.meta.push(("eol", LoroValue::from(eol)));
        if let Some(f) = strata_markdown::frontmatter(&text) {
            match strata_markdown::properties(f.yaml) {
                Some(props) => {
                    // Its form, delimiters and all (13 §2.3): written back as it was.
                    e.meta
                        .push(("frontmatter", LoroValue::from(&text[f.range.clone()])));
                    body = &text[f.range.end..];
                    e.props = props;
                }
                None => {
                    // Broken YAML stays in the text: nothing is lost (13 §2.3).
                    report.at(
                        e.id,
                        "property",
                        "warn",
                        &e.raw,
                        "brokenYaml",
                        String::new(),
                    );
                }
            }
        }
        let has = |keys: &[&str]| e.props.iter().any(|(k, _)| is_one_of(k, keys));
        if e.role == Role::Board || has(&["excalidraw-plugin"]) {
            match vault::excalidraw_md(&text) {
                Some(d) => {
                    if d.local_font > 0 {
                        report.at(
                            e.id,
                            "unsupported",
                            "info",
                            &e.raw,
                            "localFont",
                            d.local_font.to_string(),
                        );
                    }
                    e.embeds = d
                        .files
                        .iter()
                        .map(|(_, p)| segments(&link_key(p)))
                        .collect();
                    e.drawing = Some(d);
                    e.role = Role::Board;
                    if strip_ci(&e.name, ".excalidraw").is_some() {
                        e.name = strip_ci(&e.name, ".excalidraw")
                            .unwrap_or_default()
                            .to_owned();
                    }
                    e.meta.clear();
                    return;
                }
                None => {
                    report.at(
                        e.id,
                        "unsupported",
                        "warn",
                        &e.raw,
                        "drawingBroken",
                        String::new(),
                    );
                    e.role = Role::Note;
                }
            }
        }
        if has(&["kanban-plugin"]) {
            report.at(e.id, "unsupported", "info", &e.raw, "kanban", String::new());
        }
        for code in unsupported(body) {
            report.at(e.id, "unsupported", "info", &e.raw, code, String::new());
        }
        let task_keys = [
            &STATUS[..],
            &DEADLINE[..],
            &START[..],
            &PRIORITY[..],
            &ASSIGNEES[..],
        ];
        if options.checklists {
            if let Some(list) = strata_markdown::checklist(body) {
                e.role = Role::List;
                e.meta
                    .push(("marker", LoroValue::from(list.marker.to_string())));
                e.meta
                    .push(("indent", LoroValue::from(list.indent.as_str())));
                e.meta
                    .push(("done", LoroValue::from(list.done.to_string())));
                e.list = Some(list);
                return;
            }
        }
        if options.tasks && task_keys.iter().any(|k| has(k)) {
            e.role = Role::Task;
        }
        e.embeds = strata_markdown::scan(body)
            .links
            .into_iter()
            .filter(|l| l.embed)
            .map(|l| segments(&link_key(&l.target)))
            .collect();
        e.text = Some(body.to_owned());
    }

    /// Attachments in a shared folder (13 §2.6, `attachmentFolderPath`) lie
    /// where the note that first embeds them lies; those no note embeds, in
    /// a network of their own. Beside the notes (`./`) they stay in their folders.
    fn place_attachments(
        &self,
        entries: &mut [Entry],
        cfg: &Config,
        options: &ImportOptions,
        folders: &mut BTreeMap<String, NodeId>,
    ) {
        let a = cfg.attachments.trim();
        if a == "." || a.starts_with("./") {
            return;
        }
        let shared = nfc(a.trim_matches('/'));
        let inside = |folder: &str| {
            shared.is_empty() && folder.is_empty()
                || !shared.is_empty()
                    && (folder == shared || folder.starts_with(&format!("{shared}/")))
        };
        let keys = |path: &str| -> Vec<String> { path.split('/').map(link_key).collect() };
        // The first embedder by path: its folder.
        let mut embedders: Vec<(String, Vec<Vec<String>>)> = entries
            .iter()
            .filter(|e| !e.embeds.is_empty())
            .map(|e| (e.path.clone(), e.embeds.clone()))
            .collect();
        embedders.sort();
        let folder_of: HashMap<String, String> = entries
            .iter()
            .map(|e| (e.path.clone(), e.folder.clone()))
            .collect();
        let mut unlinked: Option<NodeId> = None;
        for e in entries.iter_mut() {
            if e.role != Role::Asset || !inside(&e.folder) {
                continue;
            }
            let mine = keys(&e.path);
            let by = embedders.iter().find(|(_, embeds)| {
                embeds
                    .iter()
                    .any(|segs| !segs.is_empty() && mine.ends_with(segs))
            });
            match by {
                Some((path, _)) => {
                    let folder = folder_of[path].clone();
                    if folder != e.folder {
                        e.folder = folder;
                    }
                }
                None if shared.is_empty() => {}
                None => {
                    let net = *unlinked.get_or_insert_with(NodeId::new);
                    let name = clean(&options.unlinked);
                    folders.entry(name.clone()).or_insert(net);
                    e.folder = name;
                }
            }
        }
    }

    /// Canvases (13 §2.7): cards become placements, notes and link assets;
    /// groups — boxes of the network (drawn from 1.3); edges — wires `import`.
    #[allow(clippy::too_many_arguments)]
    fn lay_canvases(
        &self,
        entries: &[Entry],
        by_path: &HashMap<String, usize>,
        cards: &mut Vec<Card>,
        appear: &mut Vec<(NodeId, NodeId, f64, f64)>,
        layout: &mut HashMap<(NodeId, NodeId), (f64, f64)>,
        raw: &mut Writes,
        colors: &mut HashMap<NodeId, HashMap<i64, u32>>,
        ts: i64,
        report: &mut ImportReport,
    ) {
        // Networks inside networks, for cycles (05 §5 rule 4): primaries first.
        let mut holds: HashMap<NodeId, HashSet<NodeId>> = HashMap::new();
        for e in entries {
            if e.role == Role::Canvas && !e.layout {
                holds.entry(e.net).or_default().insert(e.id);
            }
        }
        let reaches =
            |holds: &HashMap<NodeId, HashSet<NodeId>>, from: NodeId, to: NodeId| -> bool {
                let mut stack = vec![from];
                let mut seen = HashSet::new();
                while let Some(n) = stack.pop() {
                    if n == to {
                        return true;
                    }
                    if seen.insert(n) {
                        stack.extend(holds.get(&n).into_iter().flatten().copied());
                    }
                }
                false
            };
        for e in entries.iter().filter(|e| e.role == Role::Canvas) {
            let Some(canvas) = &e.canvas else { continue };
            let net = e.id;
            let k = canvas.scale();
            let foreign = canvas.foreign_keys();
            if foreign > 0 {
                report.at(
                    net,
                    "unsupported",
                    "info",
                    &e.raw,
                    "advancedCanvas",
                    foreign.to_string(),
                );
            }
            let mut card_of: HashMap<&str, NodeId> = HashMap::new();
            let mut placed: HashSet<NodeId> = HashSet::new();
            let mut deadline_colors = false;
            for c in &canvas.nodes {
                let (cx, cy) = c.center();
                let at = (cx * k, cy * k);
                let node = match c.kind.as_str() {
                    "file" => {
                        let file = c
                            .file
                            .as_deref()
                            .unwrap_or_default()
                            .trim_start_matches('/');
                        let Some(&i) = by_path.get(&nfc(file)) else {
                            report.at(
                                net,
                                "canvas",
                                "warn",
                                &e.raw,
                                "missingFile",
                                file.to_owned(),
                            );
                            continue;
                        };
                        let t = &entries[i];
                        let id = t.id;
                        if c.subpath.as_deref().is_some_and(|s| !s.is_empty()) {
                            report.at(
                                net,
                                "canvas",
                                "info",
                                &e.raw,
                                "subpath",
                                format!("{file}{}", c.subpath.as_deref().unwrap_or_default()),
                            );
                        }
                        if !placed.insert(id) {
                            report.at(
                                net,
                                "canvas",
                                "info",
                                &e.raw,
                                "duplicateCard",
                                file.to_owned(),
                            );
                            card_of.insert(&c.id, id);
                            continue;
                        }
                        if id == net {
                            report.at(net, "canvas", "warn", &e.raw, "cycle", file.to_owned());
                            continue;
                        }
                        if t.net == net {
                            // It lives here already: the canvas gives its position.
                            layout.insert((net, id), at);
                        } else {
                            let network = t.role == Role::Canvas
                                || entries.iter().any(|x| x.layout && x.id == id);
                            if network && reaches(&holds, id, net) {
                                report.at(net, "canvas", "warn", &e.raw, "cycle", file.to_owned());
                                continue;
                            }
                            if network {
                                holds.entry(net).or_default().insert(id);
                            }
                            appear.push((id, net, at.0, at.1));
                        }
                        id
                    }
                    "text" => {
                        let text = c.text.clone().unwrap_or_default();
                        let id = NodeId::new();
                        cards.push(Card {
                            id,
                            kind: NodeKind::Note,
                            name: card_name(&text),
                            net,
                            pos: at,
                            text: Some(text),
                            url: None,
                            path: e.raw.clone(),
                        });
                        id
                    }
                    "link" => {
                        let url = c.url.clone().unwrap_or_default();
                        let id = NodeId::new();
                        cards.push(Card {
                            id,
                            kind: NodeKind::Asset,
                            name: host_of(&url),
                            net,
                            pos: at,
                            text: None,
                            url: (!url.is_empty()).then_some(url),
                            path: e.raw.clone(),
                        });
                        id
                    }
                    _ => continue,
                };
                card_of.insert(&c.id, node);
                if let Some(color) = &c.color {
                    match vault::palette_color(color) {
                        Colour::Palette(i) => {
                            *colors.entry(node).or_default().entry(i).or_default() += 1
                        }
                        Colour::None => {}
                        Colour::Deadline => deadline_colors = true,
                    }
                }
            }
            if deadline_colors {
                report.at(
                    net,
                    "canvas",
                    "info",
                    &e.raw,
                    "deadlineColors",
                    String::new(),
                );
            }
            // Groups: boxes of the network, members by the centres of their cards.
            let groups: Vec<_> = canvas.nodes.iter().filter(|c| c.kind == "group").collect();
            if !groups.is_empty() {
                report.at(
                    net,
                    "canvas",
                    "info",
                    &e.raw,
                    "groups",
                    groups.len().to_string(),
                );
            }
            let doc = format!("net/{}", net.to_text());
            for g in &groups {
                let id = NodeId::new().to_text();
                let color = g
                    .color
                    .as_deref()
                    .and_then(|c| match vault::palette_color(c) {
                        Colour::Palette(i) => Some(i),
                        _ => None,
                    });
                let mut b = vec![
                    (
                        "rect",
                        Val::List(vec![
                            Val::Float(g.x * k),
                            Val::Float(g.y * k),
                            Val::Float(g.width * k),
                            Val::Float(g.height * k),
                        ]),
                    ),
                    ("title", Val::str(g.label.clone().unwrap_or_default())),
                ];
                if let Some(c) = color {
                    b.push(("color", Val::Int(c)));
                }
                raw.push((
                    doc.clone(),
                    "box".to_owned(),
                    id.clone(),
                    Some(Val::Map(
                        b.into_iter().map(|(k, v)| (k.to_owned(), v)).collect(),
                    )),
                ));
                if g.background.as_deref().is_some_and(|s| !s.is_empty()) {
                    report.at(
                        net,
                        "canvas",
                        "info",
                        &e.raw,
                        "groupBackground",
                        g.label.clone().unwrap_or_default(),
                    );
                }
                for c in canvas.nodes.iter().filter(|c| c.kind != "group") {
                    let (cx, cy) = c.center();
                    let inside =
                        cx >= g.x && cx <= g.x + g.width && cy >= g.y && cy <= g.y + g.height;
                    if let Some(node) = card_of.get(c.id.as_str()).filter(|_| inside) {
                        raw.push((
                            doc.clone(),
                            "boxMember".to_owned(),
                            format!("{id}|{}", node.to_text()),
                            Some(Val::Int(1)),
                        ));
                    }
                }
            }
            for edge in &canvas.edges {
                let group = |id: &str| groups.iter().any(|g| g.id == id);
                if group(&edge.from_node) || group(&edge.to_node) {
                    report.at(
                        net,
                        "canvas",
                        "info",
                        &e.raw,
                        "edgeToGroup",
                        edge.label.clone().unwrap_or_default(),
                    );
                    continue;
                }
                let (Some(&a), Some(&b)) = (
                    card_of.get(edge.from_node.as_str()),
                    card_of.get(edge.to_node.as_str()),
                ) else {
                    continue;
                };
                let (from, to) = if edge.reversed() { (b, a) } else { (a, b) };
                if from != to {
                    self.import_wire(raw, from, to, edge.label.as_deref(), ts);
                }
            }
        }
    }

    /// A wire with the origin `import` (05 §8.1), its label if any.
    fn import_wire(
        &self,
        out: &mut Writes,
        from: NodeId,
        to: NodeId,
        label: Option<&str>,
        ts: i64,
    ) {
        let key = EdgeKey::between(from, to).to_text();
        let index = self.index_doc(from);
        out.push((
            index.clone(),
            "edge".to_owned(),
            key.clone(),
            Some(Val::map([
                ("from", Val::str(from.to_text())),
                ("to", Val::str(to.to_text())),
            ])),
        ));
        out.push((
            index.clone(),
            "edgeOrigin".to_owned(),
            format!("{key}|import"),
            Some(Val::map([("at", Val::Int(ts))])),
        ));
        if let Some(l) = label.map(str::trim).filter(|l| !l.is_empty()) {
            out.push((index, "edgeLabel".to_owned(), key, Some(Val::str(l))));
        }
    }

    /// People of the workspace by the link key of their names.
    fn people_by_name(&self) -> HashMap<String, String> {
        self.people()
            .into_iter()
            .map(|p| (link_key(&p.name), p.id))
            .collect()
    }

    /// A file's properties (13 §2.3): a task's fields, its people, tags,
    /// aliases and user attributes; links in them — for wires `import`.
    #[allow(clippy::too_many_arguments)]
    fn properties(
        &self,
        e: &Entry,
        types: &HashMap<String, String>,
        ops: &mut Vec<Op>,
        raw: &mut Writes,
        people: &mut HashMap<String, String>,
        links: &mut Vec<(NodeId, String, String)>,
        report: &mut ImportReport,
    ) {
        let id = e.id.to_text();
        let index = self.index_doc(e.id);
        let task = e.role == Role::Task;
        let mut tags: Vec<String> = Vec::new();
        let mut aliases: Vec<String> = Vec::new();
        for (key, value) in &e.props {
            let lower = key.to_lowercase();
            let attr = |k: &str, v: String| Op::SetAttr {
                id: id.clone(),
                key: k.to_owned(),
                value: Some(Val::Str(v)),
            };
            if task && is_one_of(key, &STATUS) {
                match status_of(&value.text()) {
                    Some(s) => {
                        ops.push(attr("status", s.to_owned()));
                        continue;
                    }
                    None => report.at(
                        e.id,
                        "property",
                        "info",
                        &e.raw,
                        "unknownStatus",
                        value.text(),
                    ),
                }
            } else if task && (is_one_of(key, &DEADLINE) || is_one_of(key, &START)) {
                let field = if is_one_of(key, &START) {
                    "start"
                } else {
                    "deadline"
                };
                match when_of(&value.text()) {
                    Some(w) => {
                        ops.push(attr(field, w));
                        continue;
                    }
                    None => report.at(
                        e.id,
                        "property",
                        "warn",
                        &e.raw,
                        "typeMismatch",
                        format!("{key}: {}", value.text()),
                    ),
                }
            } else if task && is_one_of(key, &PRIORITY) {
                match priority_of(&value.text()) {
                    Some(p) => {
                        ops.push(attr("priority", p.to_owned()));
                        continue;
                    }
                    None => report.at(
                        e.id,
                        "property",
                        "info",
                        &e.raw,
                        "typeMismatch",
                        format!("{key}: {}", value.text()),
                    ),
                }
            } else if task && is_one_of(key, &ASSIGNEES) {
                for name in value.texts() {
                    let name = property_link(&name).unwrap_or(name);
                    let name = name.trim().to_owned();
                    if name.is_empty() {
                        continue;
                    }
                    let person = match people.get(&link_key(&name)) {
                        Some(p) => p.clone(),
                        None => {
                            // A local person by the name (05 §10).
                            let p = NodeId::new().to_text();
                            ops.push(Op::AddPerson {
                                id: Some(p.clone()),
                                name: name.clone(),
                                color: None,
                            });
                            people.insert(link_key(&name), p.clone());
                            p
                        }
                    };
                    ops.push(Op::Assign {
                        id: id.clone(),
                        person,
                        on: true,
                    });
                }
                continue;
            }
            if lower == "tags" || lower == "tag" {
                tags.extend(tag_texts(value));
                continue;
            }
            if lower == "aliases" || lower == "alias" {
                aliases.extend(value.texts().into_iter().map(|a| a.trim().to_owned()));
                continue;
            }
            if lower == "created" {
                if let Some(ms) = day_ms(&value.text()) {
                    raw.push((
                        index.clone(),
                        "createdAt".to_owned(),
                        id.clone(),
                        Some(Val::Int(ms)),
                    ));
                }
                continue;
            }
            if FORM_ONLY.contains(&lower.as_str()) || lower.starts_with("excalidraw-") {
                continue;
            }
            // A user attribute (05 §6.2): its type by `types.json`, else by its value.
            let mut v = value.clone();
            if let Value::Nested(_) = v {
                report.at(e.id, "property", "info", &e.raw, "nested", key.clone());
            }
            if let Some(kind) = types.get(key) {
                if !fits(kind, &v) {
                    report.at(
                        e.id,
                        "property",
                        "info",
                        &e.raw,
                        "typeMismatch",
                        format!("{key}: {kind}"),
                    );
                    v = Value::Text(v.text());
                }
            }
            for t in v.texts() {
                if let Some(target) = property_link(&t) {
                    links.push((e.id, target, e.raw.clone()));
                }
            }
            if let Some(val) = val_of(&v) {
                raw.push((
                    index.clone(),
                    "prop".to_owned(),
                    format!("{id}|{key}"),
                    Some(val),
                ));
            }
        }
        // Tags and aliases: the first spelling of each (13 §2.4).
        for (key, list) in [("tags", tags), ("aliases", aliases)] {
            let mut seen = HashSet::new();
            for v in list {
                if !v.is_empty() && seen.insert(v.to_lowercase()) {
                    raw.push((
                        index.clone(),
                        "set".to_owned(),
                        format!("{id}|{key}|{v}"),
                        Some(Val::Int(1)),
                    ));
                }
            }
        }
    }

    /// `L` once on what the import placed without a canvas's coordinates
    /// (06 §9.3, 13 §3.1 step 8, ☑ Q-13-19): per network, the layered layout
    /// of `strata-layout` over the wires among the imported nodes — those of
    /// canvases and properties first, those only from text second (☑ Q-13-3);
    /// a node a canvas placed stays where it put it. A network with nothing
    /// of a canvas keeps its grid's corner, clear of what it held. `wires`
    /// are the import's own: (from, to) → only from text. Positions come
    /// back as key writes for the import's own changeset.
    fn lay_out(&self, laying: &[Laying], wires: &BTreeMap<(NodeId, NodeId), bool>) -> Writes {
        // Each node's network and place in it: one pass over the wires.
        let mut at: HashMap<NodeId, (usize, usize)> = HashMap::new();
        for (l, lay) in laying.iter().enumerate() {
            for (i, n) in lay.nodes.iter().enumerate() {
                at.insert(n.id, (l, i));
            }
        }
        let mut edges: Vec<Vec<([u32; 2], bool)>> = laying.iter().map(|_| Vec::new()).collect();
        for (&(a, b), &text) in wires {
            if let (Some(&(la, i)), Some(&(lb, j))) = (at.get(&a), at.get(&b))
                && la == lb
            {
                edges[la].push(([i as u32, j as u32], text));
            }
        }
        let mut out = Writes::new();
        for (lay, edges) in laying.iter().zip(edges) {
            if lay.nodes.iter().filter(|n| !n.pinned).count() < 2 {
                continue;
            }
            let mut net = LayoutNet::default();
            for n in &lay.nodes {
                net.pos.extend([n.at.0 as f32, n.at.1 as f32]);
                net.radius.push(radius(self.kind(n.id)));
                net.pinned.push(n.pinned);
            }
            for (e, text) in edges {
                net.edges.push(e);
                net.text.push(text);
            }
            let at = strata_layout::layout(&net, LayoutKind::Layered, Spacing::DEFAULT);
            // Nothing of a canvas: the layout starts where the grid did.
            let (mut sx, mut sy) = (0.0, 0.0);
            if !lay.nodes.iter().any(|n| n.pinned) {
                let min = |k: usize| {
                    at.iter()
                        .skip(k)
                        .step_by(2)
                        .fold(f32::INFINITY, |m, &v| m.min(v))
                };
                sx = lay.corner.0 - f64::from(min(0));
                sy = lay.corner.1 - f64::from(min(1));
            }
            for (i, n) in lay.nodes.iter().enumerate().filter(|(_, n)| !n.pinned) {
                let x = f64::from(at[2 * i]) + sx;
                let y = f64::from(at[2 * i + 1]) + sy;
                out.push((
                    format!("net/{}", lay.net.to_text()),
                    "pos".to_owned(),
                    n.id.to_text(),
                    Some(Val::List(vec![Val::Float(x), Val::Float(y)])),
                ));
            }
        }
        out
    }

    /// The lowest free row below what a network holds: imported nodes go
    /// there, not over what is there (13 §3.1 step 8).
    fn free_corner(&self, net: NodeId) -> (f64, f64) {
        let Some(doc) = self.docs.get(&format!("net/{}", net.to_text())) else {
            return (0.0, 0.0);
        };
        let LoroValue::Map(all) = doc.get_map("pos").get_value() else {
            return (0.0, 0.0);
        };
        let mut bottom: Option<f64> = None;
        let mut left: Option<f64> = None;
        for v in all.values() {
            if let Some(Val::List(p)) = Val::from_loro(v) {
                let (x, y) = (
                    p.first().and_then(Val::as_f64).unwrap_or(0.0),
                    p.get(1).and_then(Val::as_f64).unwrap_or(0.0),
                );
                bottom = Some(bottom.map_or(y, |b: f64| b.max(y)));
                left = Some(left.map_or(x, |l: f64| l.min(x)));
            }
        }
        match (left, bottom) {
            (Some(x), Some(y)) => (x, y + 2.0 * STEP),
            _ => (0.0, 0.0),
        }
    }

    /// A node's canonical path, `/Проекты/Игра/Референсы` (05 §9.3).
    fn path_text(&self, n: NodeId) -> String {
        let mut parts: Vec<String> = self
            .ancestors(n)
            .into_iter()
            .rev()
            .filter(|a| *a != self.root)
            .map(|a| self.name(a))
            .collect();
        parts.push(self.name(n));
        format!("/{}", parts.join("/"))
    }
}

/// Files a batch of an import brings at most (13 §3.3): each batch is one
/// transaction of the store.
pub(super) const BATCH_FILES: usize = 500;

#[cfg(test)]
thread_local! {
    /// Tests write V-synth's few dozen files in batches of a few.
    pub(crate) static TEST_BATCH: std::cell::Cell<usize> = const { std::cell::Cell::new(BATCH_FILES) };
}

fn batch_files() -> usize {
    #[cfg(test)]
    return TEST_BATCH.with(std::cell::Cell::get);
    #[cfg(not(test))]
    BATCH_FILES
}

/// An import planned on a shadow (13 §3.3), batch by batch: batch 0 holds
/// the networks — folders and canvases — and what the canvases bring, the
/// next ones the files network by network.
pub(super) struct Plan {
    pub(super) label: Label,
    /// The keys each batch writes, in order.
    pub(super) writes: Vec<Vec<KeyWrite>>,
    /// Vault files each batch brings: the progress «1 840 из 3 200».
    pub(super) files: Vec<u32>,
    pub(super) contents: Vec<Vec<Content>>,
    /// Assets each batch copies: the node and its file's path in the vault.
    pub(super) assets: Vec<Vec<(NodeId, String)>>,
    pub(super) report: ImportReport,
    /// The notes the import brings: their wires are its own (step 7).
    pub(super) notes: BTreeSet<NodeId>,
    pub(super) config: Config,
}

/// A content document an import writes (10 §2.4).
pub(super) struct Content {
    pub(super) node: NodeId,
    text: Option<String>,
    meta: Vec<(&'static str, LoroValue)>,
    list: Option<Checklist>,
    drawing: Option<Drawing>,
}

impl Content {
    fn is_empty(&self) -> bool {
        self.text.is_none() && self.list.is_none() && self.drawing.is_none() && self.meta.is_empty()
    }

    /// The document as a snapshot, as an editor would push it (15 §3.4):
    /// the text, its `meta`, a list's items, a drawing's elements and the
    /// pictures it embeds, read from the vault.
    pub(super) fn snapshot(&self, vault: &Vault, cfg: &Config) -> Result<Vec<u8>> {
        let doc = LoroDoc::new();
        if let Some(text) = &self.text {
            doc.get_text("text").insert(0, text).map_err(engine)?;
        }
        let m = doc.get_map("meta");
        for (k, v) in &self.meta {
            m.insert(k, v.clone()).map_err(engine)?;
        }
        if let Some(list) = &self.list {
            let tree = doc.get_tree(LIST_ITEMS);
            tree.enable_fractional_index(0);
            let mut parents: Vec<loro::TreeID> = Vec::new();
            for (depth, done, text) in &list.items {
                parents.truncate(*depth);
                let id = tree.create(parents.last().copied()).map_err(engine)?;
                let data = tree.get_meta(id).map_err(engine)?;
                data.insert("done", *done).map_err(engine)?;
                let t = data.ensure_mergeable_text("text").map_err(engine)?;
                t.insert(0, text).map_err(engine)?;
                parents.push(id);
            }
        }
        if let Some(d) = &self.drawing {
            let elements = doc.get_map("elements");
            for el in &d.elements {
                if let Some(id) = el.get("id").and_then(serde_json::Value::as_str) {
                    elements.insert(id, loro_of(el)).map_err(engine)?;
                }
            }
            // Pictures of the drawing as Excalidraw keeps them (10 §2.4).
            let files = doc.get_map("files");
            for (fid, link) in &d.files {
                let Some(f) = find_file(vault, cfg, link) else {
                    continue;
                };
                use base64::Engine as _;
                let bytes = vault.bytes_of(f).map_err(|e| invalid(e.to_string()))?;
                let mime = mime_of(&f.path).unwrap_or("application/octet-stream");
                let url = format!(
                    "data:{mime};base64,{}",
                    base64::engine::general_purpose::STANDARD.encode(&bytes)
                );
                let file = serde_json::json!({ "id": fid, "mimeType": mime, "dataURL": url, "created": 0 });
                files.insert(fid, loro_of(&file)).map_err(engine)?;
            }
        }
        doc.commit();
        doc.export(ExportMode::Snapshot).map_err(engine)
    }
}

/// The import's keys by batch (13 §3.3): a node's keys go with the node — its
/// fields, placements, position, properties; a wire with the later of its
/// ends, so it never comes before a node it joins; a network's own keys
/// with the network; the rest — the people — with batch 0. A key written
/// twice keeps its last value only.
fn by_batch(
    writes: Vec<KeyWrite>,
    rank: &HashMap<NodeId, usize>,
    batches: usize,
) -> Vec<Vec<KeyWrite>> {
    let of = |id: &str| {
        NodeId::parse(id)
            .ok()
            .and_then(|n| rank.get(&n))
            .copied()
            .unwrap_or(0)
    };
    let mut wire: HashMap<&str, usize> = HashMap::new();
    for w in &writes {
        if w.map == "edge" && w.doc.starts_with("index/") {
            let ends = w.after.as_ref().or(w.before.as_ref());
            let end = |k: &str| {
                ends.and_then(|v| v.get(k))
                    .and_then(Val::as_str)
                    .map_or(0, of)
            };
            wire.insert(&w.key, end("from").max(end("to")));
        }
    }
    let mut out: Vec<Vec<KeyWrite>> = (0..batches.max(1)).map(|_| Vec::new()).collect();
    let mut last: HashMap<(String, String, String), (usize, usize)> = HashMap::new();
    let mut placed: Vec<(usize, KeyWrite)> = Vec::with_capacity(writes.len());
    for w in &writes {
        let b = if let Some(net) = w.doc.strip_prefix("net/") {
            if w.map == "pos" { of(&w.key) } else { of(net) }
        } else if w.doc.starts_with("index/") {
            match w.map.as_str() {
                "edge" | "edgeLabel" => wire.get(w.key.as_str()).copied().unwrap_or(0),
                "edgeOrigin" => {
                    let key = w.key.rsplit_once('|').map_or(w.key.as_str(), |(k, _)| k);
                    wire.get(key).copied().unwrap_or(0)
                }
                "placement" => of(w.key.split_once('/').map_or("", |(_, n)| n)),
                _ => of(w.key.split('|').next().unwrap_or_default()),
            }
        } else {
            0
        };
        placed.push((b.min(out.len() - 1), w.clone()));
    }
    drop(wire);
    for (i, (b, w)) in placed.iter().enumerate() {
        last.insert((w.doc.clone(), w.map.clone(), w.key.clone()), (*b, i));
    }
    for (i, (b, w)) in placed.into_iter().enumerate() {
        if last.get(&(w.doc.clone(), w.map.clone(), w.key.clone())) == Some(&(b, i)) {
            out[b].push(w);
        }
    }
    out
}

/// `file` without `suffix`, its case aside.
fn strip_ci<'a>(file: &'a str, suffix: &str) -> Option<&'a str> {
    let cut = file.len().checked_sub(suffix.len())?;
    let (stem, tail) = (file.get(..cut)?, file.get(cut..)?);
    (tail.eq_ignore_ascii_case(suffix) && !stem.is_empty()).then_some(stem)
}

/// The name of a text card's note (13 §2.7.1): its first heading, else its
/// first line, at most 80 characters.
fn card_name(text: &str) -> String {
    let line = text
        .lines()
        .find(|l| l.trim_start().starts_with('#'))
        .or_else(|| text.lines().find(|l| !l.trim().is_empty()))
        .unwrap_or_default();
    let name = line.trim().trim_start_matches('#').trim();
    clean(&name.chars().take(80).collect::<String>())
}

/// A link asset's name (13 §3.9): its host.
fn host_of(url: &str) -> String {
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    let host = rest.split(['/', '?', '#']).next().unwrap_or(rest);
    let host = host.rsplit_once('@').map_or(host, |(_, h)| h);
    if host.is_empty() {
        url.to_owned()
    } else {
        host.to_owned()
    }
}

/// `[[links]]` of a drawing (13 §2.8): in its texts and its elements' `link`.
fn drawing_links(d: &Drawing) -> Vec<String> {
    let mut out = Vec::new();
    for el in &d.elements {
        for field in ["text", "originalText", "rawText"] {
            if let Some(t) = el.get(field).and_then(serde_json::Value::as_str) {
                out.extend(strata_markdown::scan(t).links.into_iter().map(|l| l.target));
            }
        }
        if let Some(l) = el.get("link").and_then(serde_json::Value::as_str) {
            if let Some(t) = property_link(l) {
                out.push(t);
            }
        }
    }
    let mut seen = HashSet::new();
    out.retain(|t| seen.insert(link_key(t)));
    out
}

/// A file of the vault a drawing names: by its path, else by its name.
fn find_file<'a>(vault: &'a Vault, cfg: &Config, link: &str) -> Option<&'a VaultFile> {
    let want = link_key(link.trim_start_matches('/'));
    let not_config = |f: &&VaultFile| !f.path.starts_with(&format!("{}/", cfg.dir));
    vault
        .files
        .iter()
        .filter(not_config)
        .find(|f| link_key(&f.path) == want)
        .or_else(|| {
            vault
                .files
                .iter()
                .filter(not_config)
                .find(|f| link_key(f.path.rsplit('/').next().unwrap_or_default()) == want)
        })
}
