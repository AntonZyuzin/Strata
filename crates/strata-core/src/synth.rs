//! V-10k (14 §1.3): the synthetic vault the import is measured on — 10 000
//! notes, about 50 MB of text, with links, properties, tags and tasks in
//! V-synth's proportions, in a tree of folders, with canvases and drawings;
//! pictures in the attachments only when asked for (NFR-42). Deterministic
//! by seed: no owner's vault is needed (✅ Q-14-6). The example
//! `import_speed` and the benchmark's `import` scenario read it (14 §6).

use crate::vault::{Vault, VaultFile};

/// What to make.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Spec {
    pub notes: usize,
    pub seed: u64,
    /// Pictures in `Вложения`, each embedded by a note.
    pub pictures: usize,
    /// The bytes of one picture.
    pub picture_bytes: usize,
}

impl Spec {
    /// V-10k without attachments: the case of NFR-40.
    pub const V10K: Self = Self {
        notes: 10_000,
        seed: 10,
        pictures: 0,
        picture_bytes: 0,
    };
}

/// xorshift64*: the same vault on every machine.
struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        Self(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1)
    }

    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }

    fn chance(&mut self, p: f64) -> bool {
        ((self.next() >> 11) as f64 / (1u64 << 53) as f64) < p
    }

    fn pick<'a>(&mut self, of: &[&'a str]) -> &'a str {
        of[self.below(of.len())]
    }
}

const WORDS: &[&str] = &[
    "сцена",
    "шейдер",
    "анимация",
    "звук",
    "план",
    "встреча",
    "удар",
    "свет",
    "вода",
    "лес",
    "мельница",
    "туман",
    "референсы",
    "мудборд",
    "персонаж",
    "локация",
    "уровень",
    "босс",
    "музыка",
    "идея",
    "черновик",
    "заметка",
    "история",
    "карта",
    "point",
    "wrangle",
    "level",
    "design",
    "render",
    "pipeline",
    "review",
    "sprint",
];

const FILLER: &[&str] = &[
    "и",
    "в",
    "на",
    "что",
    "как",
    "для",
    "проект",
    "нужно",
    "проверить",
    "сделать",
    "потом",
    "вместе",
    "решение",
    "вариант",
    "данные",
    "команда",
    "сроки",
    "время",
    "сеть",
    "нода",
    "нить",
    "текст",
    "the",
    "of",
    "with",
    "frame",
    "budget",
    "node",
    "graph",
];

/// Blocks of V-synth (`packages/editor/src/vsynth.ts`): every syntax the
/// import keeps byte for byte, among the paragraphs.
const BLOCKS: &[&str] = &[
    "Абзац с *курсивом*, ~~зачёркнутым~~, `кодом` и ==выделением==.",
    "Комментарий %%не для чтения%% в строке.",
    "Строка с якорем блока ^block-1",
    "1. первый\n2. второй",
    "> [!note] Выноска\n> Текст выноски.",
    "> Обычная цитата",
    "Сноска[^1].\n\n[^1]: Текст сноски.",
    "Формула $e^{i\\pi} + 1 = 0$ и блок:\n\n$$\n\\int_0^1 x\\,dx\n$$",
    "```js\nconst link = \"[[не ссылка]]\";\n```",
    "<div class=\"custom\">HTML</div>",
    "Неразрывный пробел, эмодзи 👩‍💻 и й из двух знаков: й.",
    "[Внешняя](https://example.com) и <https://example.org>.",
];

const AREAS: &[&str] = &[
    "Проекты",
    "Работа",
    "Личное",
    "Исследования",
    "Встречи",
    "Архив",
    "Идеи",
    "Projects",
];

/// The vault: notes in folders, a config folder, canvases, drawings and,
/// when asked, pictures.
pub fn vault(spec: Spec) -> Vault {
    let mut r = Rng::new(spec.seed);
    let mut files: Vec<VaultFile> = Vec::new();
    files.push(VaultFile::new(
        ".obsidian/app.json".to_owned(),
        r#"{"attachmentFolderPath": "Вложения"}"#.as_bytes().to_vec(),
    ));
    files.push(VaultFile::new(
        ".obsidian/community-plugins.json".to_owned(),
        br#"["obsidian-tasks-plugin", "obsidian-excalidraw-plugin"]"#.to_vec(),
    ));

    // Folders: areas, their topics, a third level under some.
    let mut folders: Vec<String> = vec![String::new()];
    for area in AREAS {
        folders.push((*area).to_owned());
        for t in 0..(4 + r.below(4)) {
            let topic = format!("{area}/{} {t}", cap(r.pick(WORDS)));
            folders.push(topic.clone());
            if r.chance(0.4) {
                for s in 0..(1 + r.below(3)) {
                    folders.push(format!("{topic}/{} {s}", cap(r.pick(WORDS))));
                }
            }
        }
    }

    let path_of = |name: &str, folder: usize| -> String {
        if folders[folder].is_empty() {
            format!("{name}.md")
        } else {
            format!("{}/{name}.md", folders[folder])
        }
    };
    // Names first: links point at them. About 2 % repeat an earlier name in
    // another folder — ambiguous links (13 §3.5).
    let mut names: Vec<(String, usize)> = Vec::with_capacity(spec.notes);
    let mut paths: std::collections::HashSet<String> = std::collections::HashSet::new();
    for i in 0..spec.notes {
        let mut folder = if r.chance(0.02) {
            0
        } else {
            1 + r.below(folders.len() - 1)
        };
        let name = if i > 50 && r.chance(0.02) {
            names[r.below(i)].0.clone()
        } else {
            format!("{} {} {i}", cap(r.pick(WORDS)), r.pick(WORDS))
        };
        while !paths.insert(path_of(&name, folder)) {
            folder = 1 + r.below(folders.len() - 1);
        }
        names.push((name, folder));
    }

    let pictures: Vec<String> = (0..spec.pictures)
        .map(|i| format!("картинка {i}.png"))
        .collect();
    for (i, (name, folder)) in names.iter().enumerate() {
        let mut text = String::with_capacity(6 * 1024);
        let task = r.chance(0.08);
        if task {
            text.push_str(&format!(
                "---\nstatus: {}\ndue: 2026-{:02}-{:02}\npriority: {}\ntags: [задача]\n---\n",
                r.pick(&["todo", "in-progress", "done"]),
                1 + r.below(12),
                1 + r.below(28),
                r.pick(&["high", "medium", "low"]),
            ));
        } else if r.chance(0.6) {
            text.push_str(&format!(
                "---\ntags: [{}, idea/2026]\naliases:\n  - {} {i}\nrating: {}\nreviewed: {}\n---\n",
                r.pick(WORDS),
                cap(r.pick(FILLER)),
                1 + r.below(5),
                r.chance(0.5),
            ));
        }
        if !task && r.chance(0.03) {
            // A pure checklist: a list (13 §2.2).
            for k in 0..(3 + r.below(12)) {
                let done = if r.chance(0.3) { "x" } else { " " };
                text.push_str(&format!("- [{done}] {} {k}\n", cap(r.pick(FILLER))));
            }
            files.push(VaultFile::new(path_of(name, *folder), text.into_bytes()));
            continue;
        }
        text.push_str(&format!("# {name}\n\n"));
        // About 5 KB a note: paragraphs with links, tags and V-synth's blocks.
        let size = 2_500 + r.below(5_000);
        while text.len() < size {
            for w in 0..(25 + r.below(60)) {
                if w > 0 {
                    text.push(' ');
                }
                if r.chance(0.04) {
                    link(&mut r, &mut text, &names, &folders, i);
                } else if r.chance(0.01) {
                    text.push_str(&format!("#{}", r.pick(WORDS)));
                } else {
                    text.push_str(r.pick(FILLER));
                }
            }
            text.push_str(".\n\n");
            if r.chance(0.25) {
                text.push_str(r.pick(BLOCKS));
                text.push_str("\n\n");
            }
            if task && r.chance(0.3) {
                text.push_str(&format!(
                    "- [ ] {} 📅 2026-{:02}-{:02}\n\n",
                    cap(r.pick(FILLER)),
                    1 + r.below(12),
                    1 + r.below(28),
                ));
            }
            if !pictures.is_empty() && r.chance(0.3) {
                text.push_str(&format!("![[{}]]\n\n", pictures[r.below(pictures.len())]));
            }
        }
        files.push(VaultFile::new(path_of(name, *folder), text.into_bytes()));
    }

    // Canvases (13 §2.7): file cards on notes, a text card, edges.
    for c in 0..(spec.notes / 500).max(1) {
        let folder = 1 + r.below(folders.len() - 1);
        let mut nodes = Vec::new();
        let mut edges = Vec::new();
        let n = 10 + r.below(20);
        for k in 0..n {
            let (name, f) = &names[r.below(names.len())];
            nodes.push(serde_json::json!({
                "id": format!("c{c}n{k}"),
                "type": "file",
                "file": path_of(name, *f),
                "x": (k % 6) as i64 * 300,
                "y": (k / 6) as i64 * 200,
                "width": 250,
                "height": 140,
            }));
            if k > 0 && r.chance(0.6) {
                edges.push(serde_json::json!({
                    "id": format!("c{c}e{k}"),
                    "fromNode": format!("c{c}n{}", r.below(k)),
                    "toNode": format!("c{c}n{k}"),
                }));
            }
        }
        nodes.push(serde_json::json!({
            "id": format!("c{c}t"), "type": "text", "text": "Заметка на канвасе",
            "x": 0, "y": -240, "width": 250, "height": 100,
        }));
        let at = &folders[folder];
        files.push(VaultFile::new(
            format!("{at}/Канвас {c}.canvas"),
            serde_json::to_vec(&serde_json::json!({ "nodes": nodes, "edges": edges }))
                .unwrap_or_default(),
        ));
    }

    // Drawings of the Excalidraw plugin (13 §2.8), packed and not.
    for d in 0..(spec.notes / 1000).max(1) {
        let (name, _) = &names[r.below(names.len())];
        let scene = serde_json::json!({
            "type": "excalidraw", "version": 2, "source": "https://excalidraw.com",
            "elements": [{
                "id": "t1", "type": "text", "x": 10, "y": 20, "width": 200, "height": 25,
                "text": format!("См. [[{name}]]"), "originalText": format!("См. [[{name}]]"),
                "fontFamily": 5, "version": 3, "versionNonce": 11, "isDeleted": false,
                "index": "a0", "link": null,
            }],
        });
        let json = scene.to_string();
        let block = if d % 2 == 0 {
            let packed = lz_str::compress_to_base64(&json);
            let lines: Vec<String> = packed
                .as_bytes()
                .chunks(256)
                .map(|c| String::from_utf8_lossy(c).into_owned())
                .collect();
            format!("```compressed-json\n{}\n```", lines.join("\n"))
        } else {
            format!("```json\n{json}\n```")
        };
        let folder = &folders[1 + r.below(folders.len() - 1)];
        files.push(VaultFile::new(
            format!("{folder}/Рисунок {d}.excalidraw.md"),
            format!(
                "---\nexcalidraw-plugin: parsed\n---\n# Excalidraw Data\n\n## Drawing\n{block}\n%%\n"
            )
            .into_bytes(),
        ));
    }

    // Pictures: bytes of their own, so every one is an asset of its own.
    for (i, p) in pictures.iter().enumerate() {
        let mut bytes = Vec::with_capacity(spec.picture_bytes);
        bytes.extend_from_slice(b"\x89PNG\r\n\x1a\n");
        let mut x = Rng::new(spec.seed ^ (i as u64 + 1));
        while bytes.len() < spec.picture_bytes {
            bytes.extend_from_slice(&x.next().to_le_bytes());
        }
        bytes.truncate(spec.picture_bytes.max(8));
        files.push(VaultFile::new(format!("Вложения/{p}"), bytes));
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Vault::from_files("V-10k", files)
}

/// A link of V-synth's kinds to one of the notes, now and then to none.
fn link(r: &mut Rng, text: &mut String, names: &[(String, usize)], folders: &[String], me: usize) {
    if r.chance(0.03) {
        // A ghost (05 §8.5).
        text.push_str(&format!("[[Нет такой {}]]", r.below(500)));
        return;
    }
    let mut at = r.below(names.len());
    if at == me {
        at = (at + 1) % names.len();
    }
    let (name, folder) = &names[at];
    match r.below(20) {
        0 => text.push_str(&format!("[[{name}|кратко]]")),
        1 => text.push_str(&format!("[[{name}#Раздел]]")),
        2 if !folders[*folder].is_empty() => {
            text.push_str(&format!("[[{}/{name}]]", folders[*folder]));
        }
        3 => text.push_str(&format!("![[{name}]]")),
        4 => text.push_str(&format!(
            "[{}]({}.md)",
            r.pick(FILLER),
            name.replace(' ', "%20")
        )),
        _ => text.push_str(&format!("[[{name}]]")),
    }
}

fn cap(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().chain(c).collect(),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn v10k_is_the_same_vault_every_time_and_of_its_size() {
        let a = vault(Spec {
            notes: 300,
            ..Spec::V10K
        });
        let b = vault(Spec {
            notes: 300,
            ..Spec::V10K
        });
        assert_eq!(a, b);
        let notes = a
            .files
            .iter()
            .filter(|f| f.path.ends_with(".md") && !f.path.ends_with(".excalidraw.md"))
            .count();
        assert_eq!(notes, 300);
        // About 5 KB of text a note (14 §1.3: 10 000 notes ≈ 50 MB).
        let bytes: usize = a.files.iter().map(|f| f.bytes.len()).sum();
        assert!((300 * 3_500..300 * 7_000).contains(&bytes), "{bytes}");
        assert!(a.files.iter().any(|f| f.path.ends_with(".canvas")));
        assert!(a.files.iter().any(|f| f.path.ends_with(".excalidraw.md")));
    }

    #[test]
    fn pictures_come_only_when_asked_each_of_its_own_bytes() {
        let v = vault(Spec {
            notes: 100,
            pictures: 3,
            picture_bytes: 1000,
            ..Spec::V10K
        });
        let pics: Vec<&VaultFile> = v
            .files
            .iter()
            .filter(|f| f.path.starts_with("Вложения/"))
            .collect();
        assert_eq!(pics.len(), 3);
        assert!(pics.iter().all(|p| p.bytes.len() == 1000));
        assert_ne!(pics[0].bytes, pics[1].bytes);
    }
}
