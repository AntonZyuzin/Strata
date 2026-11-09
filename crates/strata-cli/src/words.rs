//! The words of `strata`'s lines in the system's language (11 §4): Russian
//! or English, as the client's interface (✅ R2: Q-07-1). `--json` gives the
//! facts themselves and is the same in every language.

use serde_json::Value;
use strata_core::backups::{Backup, BackupKind, DAY_MS, day_stamp};
use strata_core::doctor::{Check, Verdict};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lang {
    Ru,
    En,
}

impl Lang {
    /// Russian for a `ru` locale of the system, English otherwise.
    pub fn of_system() -> Self {
        match sys_locale::get_locale() {
            Some(l) if l.to_lowercase().starts_with("ru") => Lang::Ru,
            _ => Lang::En,
        }
    }

    fn pick(self, ru: &'static str, en: &'static str) -> &'static str {
        match self {
            Lang::Ru => ru,
            Lang::En => en,
        }
    }
}

/// A verdict's mark, the same in both languages (11 §4).
pub fn mark(v: Verdict) -> &'static str {
    match v {
        Verdict::Ok => "[OK]  ",
        Verdict::Info => "[INFO]",
        Verdict::Warn => "[WARN]",
        Verdict::Fail => "[FAIL]",
        Verdict::Skip => "[SKIP]",
    }
}

fn text(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(v) => v.to_string(),
        None => String::new(),
    }
}

/// Bytes in GB, MB or KB, a decimal comma in Russian.
pub fn size(lang: Lang, bytes: u64) -> String {
    let (n, unit) = match bytes {
        b if b >= 1 << 30 => (b as f64 / f64::from(1u32 << 30), lang.pick("ГБ", "GB")),
        b if b >= 1 << 20 => (b as f64 / f64::from(1u32 << 20), lang.pick("МБ", "MB")),
        b => (b as f64 / 1024.0, lang.pick("КБ", "KB")),
    };
    let n = if n >= 10.0 {
        format!("{n:.0}")
    } else {
        format!("{n:.1}")
    };
    let n = if lang == Lang::Ru {
        n.replace('.', ",")
    } else {
        n
    };
    format!("{n} {unit}")
}

/// A day as the language writes it: `08.11.2026`, `2026-11-08`.
fn day(lang: Lang, ms: i64) -> String {
    let s = day_stamp(ms.div_euclid(DAY_MS));
    let (y, m, d) = (&s[0..4], &s[4..6], &s[6..8]);
    match lang {
        Lang::Ru => format!("{d}.{m}.{y}"),
        Lang::En => format!("{y}-{m}-{d}"),
    }
}

/// A moment in UTC: the day and `HH:MM`.
fn moment(lang: Lang, ms: i64) -> String {
    let minutes = ms.rem_euclid(DAY_MS) / 60_000;
    format!(
        "{} {:02}:{:02} UTC",
        day(lang, ms),
        minutes / 60,
        minutes % 60
    )
}

/// A copy as `backup list` names it.
pub fn backup_line(lang: Lang, b: &Backup) -> String {
    match b.kind {
        BackupKind::Day => format!(
            "{}  {} {}",
            b.id,
            lang.pick("Копия за", "Backup of"),
            day(lang, b.at)
        ),
        BackupKind::Replaced => format!(
            "{}  {} {}",
            b.id,
            lang.pick("До восстановления", "Before restoring,"),
            moment(lang, b.at)
        ),
    }
}

/// The first problems a check found, and how many more there are.
fn problems(lang: Lang, c: &Check) -> String {
    listed(lang, c, "count", "first")
}

/// The first of the problems under `first`, `count` of them in all.
fn listed(lang: Lang, c: &Check, count: &str, first: &str) -> String {
    let count = c.facts.get(count).and_then(Value::as_u64).unwrap_or(0);
    let first: Vec<String> = c
        .facts
        .get(first)
        .and_then(Value::as_array)
        .map(|a| a.iter().map(|v| text(Some(v))).collect())
        .unwrap_or_default();
    let more = count.saturating_sub(first.len() as u64);
    let mut out = first.join("; ");
    if more > 0 {
        out.push_str(&format!(" {} {more}", lang.pick("и ещё", "and")));
        if lang == Lang::En {
            out.push_str(" more");
        }
    }
    out
}

/// What a check's line says, after its mark.
pub fn check_line(lang: Lang, c: &Check) -> String {
    let f = |k: &str| text(c.facts.get(k));
    let n = |k: &str| c.facts.get(k).and_then(Value::as_u64).unwrap_or(0);
    let error = c.facts.contains_key("error");
    let name = match c.check {
        "folder" => lang.pick("Папка", "Folder"),
        "lock" => lang.pick("Лок", "Lock"),
        "space" => lang.pick("Место", "Space"),
        "write" => lang.pick("Запись", "Writing"),
        "store" => lang.pick("Хранилище", "Store"),
        "workspace" => lang.pick("Пространство", "Workspace"),
        "structure" => lang.pick("Структура", "Structure"),
        "interrupted" => lang.pick("Прерванное", "Interrupted"),
        "backups" => lang.pick("Копии", "Backups"),
        "assets" => lang.pick("Ассеты", "Assets"),
        "backup" => lang.pick("Копия", "Backup"),
        other => other,
    };
    use Verdict::{Info, Ok, Skip, Warn};
    let what = match (c.check, c.verdict) {
        (_, Skip) => lang.pick("пропущено", "skipped").to_owned(),
        (_, _) if error && c.check != "backup" => {
            format!("{} ({})", lang.pick("не вышло", "failed"), f("error"))
        }
        ("folder", Ok) => format!(
            "{} {}, {} {}",
            lang.pick("пространство", "workspace"),
            f("id"),
            lang.pick("формат", "format"),
            f("format")
        ),
        ("folder", _) => format!(
            "{} {} {} {}",
            lang.pick("формат", "format"),
            f("format"),
            lang.pick(
                "новее, чем понимает это приложение:",
                "is newer than this app reads:"
            ),
            f("supported")
        ),
        ("lock", Ok) => lang.pick("папка свободна", "the folder is free").to_owned(),
        ("lock", Info) => format!(
            "{} ({})",
            lang.pick(
                "папка открыта в приложении",
                "the folder is open in the app"
            ),
            f("who")
        ),
        ("space", v) => format!(
            "{} {} {} {}",
            if v == Warn {
                lang.pick("свободно только", "only")
            } else {
                lang.pick("свободно", "")
            },
            size(lang, n("free")),
            lang.pick("из", "free of"),
            size(lang, n("total"))
        )
        .trim()
        .to_owned(),
        ("write", Ok) => lang
            .pick("в папку пишется", "the folder takes writes")
            .to_owned(),
        ("store", Ok) => "integrity_check — ok".to_owned(),
        ("store", _) => format!(
            "{}: {}",
            lang.pick("повреждено", "damaged"),
            problems(lang, c)
        ),
        ("workspace", Ok) => format!(
            "{} {}, {} {}, {} {}",
            n("nodes"),
            lang.pick("нод", "nodes"),
            n("changesets"),
            lang.pick("наборов изменений", "changesets"),
            lang.pick("схема", "schema"),
            f("schema")
        ),
        ("workspace", _) if f("id") != f("expected") => format!(
            "ID {} {} ({})",
            f("id"),
            lang.pick("не совпадает со strata.json", "differs from strata.json"),
            f("expected")
        ),
        ("workspace", _) => format!(
            "{} {} {} {}",
            lang.pick("схема", "schema"),
            f("schema"),
            lang.pick(
                "новее, чем понимает это приложение:",
                "is newer than this app reads:"
            ),
            f("supported")
        ),
        ("structure", Ok) => lang
            .pick("правила 05 §14 соблюдены", "the rules of 05 §14 hold")
            .to_owned(),
        ("structure", _) => format!(
            "{} {}: {}",
            lang.pick("нарушений —", "broken rules:"),
            n("count"),
            problems(lang, c)
        ),
        ("interrupted", Ok) => lang.pick("нет", "none").to_owned(),
        ("interrupted", _) => {
            let task = if f("task") == "core.change.import" {
                format!("{} «{}»", lang.pick("импорт", "the import of"), f("name"))
            } else {
                lang.pick("долгий набор", "a long changeset").to_owned()
            };
            format!(
                "{task} {}",
                lang.pick(
                    "не закончен: откройте пространство и выберите «Откатить» или «Оставить»",
                    "did not end: open the workspace and choose «Revert» or «Keep»"
                )
            )
        }
        ("backups", Ok) => format!(
            "{} {}, {} {}",
            n("count"),
            lang.pick("шт.", "copies"),
            lang.pick("последняя —", "the newest"),
            f("newest")
        ),
        ("backups", Warn) if !c.facts.contains_key("newest") => lang
            .pick(
                "пока нет: копия делается, когда пространство открыто",
                "none yet: a copy is made while the workspace is open",
            )
            .to_owned(),
        ("backups", _) => format!(
            "{} {} {} ({})",
            lang.pick("последняя —", "the newest is"),
            n("days"),
            lang.pick("дн. назад", "days old"),
            f("newest")
        ),
        ("assets", Ok) => format!("{} {}", n("count"), lang.pick("на месте", "in place")),
        ("assets", _) => broken_assets(lang, c),
        ("backup", Ok) => format!(
            "{}: {}, {} {}",
            f("id"),
            lang.pick("цела", "whole"),
            lang.pick("документов —", "documents:"),
            n("docs")
        ),
        ("backup", _) if error => format!("{}: {}", f("id"), f("error")),
        ("backup", _) => format!("{}: {}", f("id"), broken_assets(lang, c)),
        (_, v) => format!("{v:?}"),
    };
    format!("{name}: {what}")
}

/// Assets missing and assets damaged (NFR-72), each part when there is one.
fn broken_assets(lang: Lang, c: &Check) -> String {
    let n = |k: &str| c.facts.get(k).and_then(Value::as_u64).unwrap_or(0);
    let mut parts = Vec::new();
    if n("count") > 0 {
        parts.push(format!(
            "{} {}: {}",
            lang.pick("нет файлов —", "missing files:"),
            n("count"),
            listed(lang, c, "count", "first")
        ));
    }
    if n("damaged") > 0 {
        parts.push(format!(
            "{} {}: {}",
            lang.pick("повреждены —", "damaged files:"),
            n("damaged"),
            listed(lang, c, "damaged", "damagedFirst")
        ));
    }
    parts.join("; ")
}

/// A line for each outcome of `backup create` and `backup restore`.
pub fn archived(lang: Lang, path: &str, bytes: u64) -> String {
    format!(
        "{} {path} ({})",
        lang.pick("Архив:", "Archive:"),
        size(lang, bytes)
    )
}

pub fn restored(lang: Lang, id: &str) -> String {
    format!(
        "{} {id}; {}",
        lang.pick(
            "Папка восстановлена из копии",
            "The folder is restored from"
        ),
        lang.pick(
            "прежнее хранилище — копия «До восстановления»",
            "the store as it was is a “Before restoring” copy"
        )
    )
}

pub fn locked(lang: Lang, who: &str) -> String {
    format!(
        "{} ({who}): {}",
        lang.pick(
            "Папка открыта в приложении",
            "The folder is open in the app"
        ),
        lang.pick(
            "закройте её вкладку и повторите",
            "close its tab and try again"
        )
    )
}

pub fn no_backups(lang: Lang) -> &'static str {
    lang.pick("Копий пока нет", "No backups yet")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::BTreeMap;

    #[test]
    fn missing_and_damaged_assets_are_named_apart() {
        // NFR-72: a file whose SHA-256 is not its name is damaged, not missing.
        let facts: BTreeMap<&'static str, Value> = BTreeMap::from([
            ("count", json!(1)),
            ("first", json!(["a1"])),
            ("damaged", json!(2)),
            ("damagedFirst", json!(["b2", "c3"])),
        ]);
        let c = Check {
            check: "assets",
            verdict: Verdict::Fail,
            facts,
        };
        assert_eq!(
            check_line(Lang::Ru, &c),
            "Ассеты: нет файлов — 1: a1; повреждены — 2: b2; c3"
        );
        assert_eq!(
            check_line(Lang::En, &c),
            "Assets: missing files: 1: a1; damaged files: 2: b2; c3"
        );
        let only_damaged = Check {
            check: "assets",
            verdict: Verdict::Fail,
            facts: BTreeMap::from([
                ("count", json!(0)),
                ("first", json!([])),
                ("damaged", json!(1)),
                ("damagedFirst", json!(["b2"])),
            ]),
        };
        assert_eq!(
            check_line(Lang::Ru, &only_damaged),
            "Ассеты: повреждены — 1: b2"
        );
    }
}
