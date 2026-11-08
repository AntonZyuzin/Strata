//! The copies of a workspace's store (10 §3.5) — a day's, and the store as
//! it was before a restore — and which of them stay. Pure: the desktop keeps
//! them as files in the folder's `backups/` (`folder.rs`), the browser build
//! on its shelf; both name and keep them by these rules.

use serde::{Deserialize, Serialize};
use std::cmp::Reverse;

pub const DAY_MS: i64 = 86_400_000;
/// Days whose copies stay, the newest first.
const DAILY: usize = 7;
/// Weeks before them whose newest copy stays.
const WEEKLY: usize = 4;
/// Copies of the store as it was before a restore that stay, the newest.
const REPLACED: usize = 3;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BackupKind {
    /// The day's copy, `store-YYYYMMDD`.
    Day,
    /// The store as it was before a restore, `replaced-<unix ms>`.
    Replaced,
}

/// A copy of the store (10 §3.5).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Backup {
    /// Its name, `store-YYYYMMDD` or `replaced-<unix ms>`: what a restore asks for.
    pub id: String,
    /// When: the day's midnight (UTC), or the moment of the restore; unix ms.
    pub at: i64,
    pub kind: BackupKind,
}

impl Backup {
    /// The copy named `id`; None — not a copy's name.
    pub fn parse(id: &str) -> Option<Self> {
        if let Some(stamp) = id.strip_prefix("store-") {
            return Some(Self::day(days_of(stamp)?));
        }
        let ms = id.strip_prefix("replaced-")?;
        if ms.is_empty() || !ms.bytes().all(|c| c.is_ascii_digit()) {
            return None;
        }
        Some(Self::replaced(ms.parse().ok()?))
    }

    fn day(days: i64) -> Self {
        Self {
            id: format!("store-{}", day_stamp(days)),
            at: days * DAY_MS,
            kind: BackupKind::Day,
        }
    }

    fn replaced(at: i64) -> Self {
        Self {
            id: format!("replaced-{at}"),
            at,
            kind: BackupKind::Replaced,
        }
    }
}

/// What adding a copy comes to.
#[derive(Debug, PartialEq, Serialize, Deserialize)]
pub struct Added {
    /// The copies after it, the newest first.
    pub backups: Vec<Backup>,
    /// The copy to write; None — the day has its copy.
    pub added: Option<Backup>,
    /// The copies to let go.
    pub gone: Vec<String>,
}

/// A copy of `kind` at `now` (unix ms) added to `backups`: a day's only if
/// the day has none; one from before a restore always, the newest of its
/// kind under a name of its own; the old ones then go by [`expired`].
pub fn add(backups: &[Backup], kind: BackupKind, now: i64) -> Added {
    let mut all = backups.to_vec();
    let mut added = match kind {
        BackupKind::Day => {
            let day = Backup::day(now.div_euclid(DAY_MS));
            (!all.iter().any(|b| b.id == day.id)).then_some(day)
        }
        BackupKind::Replaced => {
            // The newest of its kind, whatever the clock says: one more than the last.
            let after = all
                .iter()
                .filter(|b| b.kind == BackupKind::Replaced)
                .map(|b| b.at + 1)
                .max()
                .unwrap_or(now);
            Some(Backup::replaced(now.max(after)))
        }
    };
    all.extend(added.clone());
    let mut gone = expired(&all);
    // A clock set back could make the new copy the oldest: it is not made.
    if let Some(b) = &added
        && gone.contains(&b.id)
    {
        gone.retain(|id| *id != b.id);
        all.retain(|x| x.id != b.id);
        added = None;
    }
    all.retain(|b| !gone.contains(&b.id));
    all.sort_by_key(|b| Reverse(b.at));
    Added {
        backups: all,
        added,
        gone,
    }
}

/// The copies to let go (10 §3.5): of the days', all but the 7 newest days
/// and, before them, the newest of each of 4 weeks; of those from before a
/// restore, all but the 3 newest.
pub fn expired(backups: &[Backup]) -> Vec<String> {
    let newest = |kind: BackupKind| {
        let mut of: Vec<&Backup> = backups.iter().filter(|b| b.kind == kind).collect();
        of.sort_by_key(|b| Reverse(b.at));
        of
    };
    let mut weeks: Vec<i64> = Vec::new();
    let mut out = Vec::new();
    for (i, b) in newest(BackupKind::Day).into_iter().enumerate() {
        if i < DAILY {
            continue;
        }
        let week = b.at.div_euclid(DAY_MS).div_euclid(7);
        if weeks.len() < WEEKLY && !weeks.contains(&week) {
            weeks.push(week);
        } else {
            out.push(b.id.clone());
        }
    }
    out.extend(
        newest(BackupKind::Replaced)
            .into_iter()
            .skip(REPLACED)
            .map(|b| b.id.clone()),
    );
    out
}

/// `YYYYMMDD` of day `days` since 1970-01-01 (the civil calendar, UTC).
pub fn day_stamp(days: i64) -> String {
    // Howard Hinnant's `civil_from_days`.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}{m:02}{d:02}")
}

/// Day `YYYYMMDD` as days since 1970-01-01; None — not such a stamp.
fn days_of(stamp: &str) -> Option<i64> {
    if stamp.len() != 8 || !stamp.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let y: i64 = stamp[0..4].parse().ok()?;
    let m: i64 = stamp[4..6].parse().ok()?;
    let d: i64 = stamp[6..8].parse().ok()?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    // Howard Hinnant's `days_from_civil`.
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    // `20250231` is no day: the stamp of the day found must be the same.
    (day_stamp(days) == stamp).then_some(days)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn days_and_stamps_go_both_ways() {
        assert_eq!(day_stamp(0), "19700101");
        assert_eq!(day_stamp(20_362), "20251001");
        assert_eq!(day_stamp(20_400), "20251108");
        // A leap day.
        assert_eq!(day_stamp(19_782), "20240229");
        for days in [0, 59, 60, 365, 11_016, 19_000, 20_400, 21_000] {
            assert_eq!(days_of(&day_stamp(days)), Some(days), "{days}");
        }
        assert_eq!(days_of("2026111"), None);
        assert_eq!(days_of("20261301"), None);
        assert_eq!(days_of("2026-11-"), None);
        assert_eq!(days_of("20250231"), None, "no 31st of February");
    }

    #[test]
    fn names_are_read_back() {
        let day = Backup::parse("store-20251108").expect("a day's");
        assert_eq!((day.at, day.kind), (20_400 * DAY_MS, BackupKind::Day));
        let r = Backup::parse("replaced-1762600000000").expect("a replaced one");
        assert_eq!((r.at, r.kind), (1_762_600_000_000, BackupKind::Replaced));
        for bad in [
            "store-2025",
            "replaced-",
            "replaced-12a",
            "../store",
            "store.sqlite",
            "",
        ] {
            assert_eq!(Backup::parse(bad), None, "{bad}");
        }
    }

    #[test]
    fn seven_days_and_four_weeks_stay() {
        // 60 days of copies, a day each.
        let mut all: Vec<Backup> = Vec::new();
        for day in 20_000..20_060 {
            all = add(&all, BackupKind::Day, day * DAY_MS + 3_600_000).backups;
        }
        assert_eq!(all.len(), DAILY + WEEKLY, "{all:?}");
        // The 7 newest days…
        for (b, day) in all.iter().zip((20_053..20_060).rev()) {
            assert_eq!(b.at, day * DAY_MS);
        }
        // …then one a week, each of another week.
        let weeks: std::collections::BTreeSet<i64> = all[DAILY..]
            .iter()
            .map(|b| b.at.div_euclid(DAY_MS).div_euclid(7))
            .collect();
        assert_eq!(weeks.len(), WEEKLY);
        // The same day again: nothing to write, nothing goes.
        let again = add(&all, BackupKind::Day, 20_059 * DAY_MS + 7_200_000);
        assert_eq!((again.added, again.gone.len()), (None, 0));
        // Fewer than that: all stay.
        let few: Vec<Backup> = (0..8).map(|d| Backup::day(20_000 + d)).collect();
        assert!(expired(&few).is_empty());
    }

    #[test]
    fn three_from_before_a_restore_stay_under_names_of_their_own() {
        let mut all = vec![Backup::day(20_400)];
        let now = 20_400 * DAY_MS + 1_000;
        let mut names = Vec::new();
        for _ in 0..5 {
            let next = add(&all, BackupKind::Replaced, now);
            names.push(next.added.expect("always made").id);
            all = next.backups;
        }
        // One moment, five names: each its own.
        assert_eq!(
            names
                .iter()
                .collect::<std::collections::BTreeSet<_>>()
                .len(),
            5
        );
        let kept: Vec<&str> = all
            .iter()
            .filter(|b| b.kind == BackupKind::Replaced)
            .map(|b| b.id.as_str())
            .collect();
        assert_eq!(
            kept,
            [
                "replaced-1762560001004",
                "replaced-1762560001003",
                "replaced-1762560001002"
            ]
        );
        // The day's copy is not one of them.
        assert!(all.iter().any(|b| b.kind == BackupKind::Day));
    }

    #[test]
    fn a_clock_set_back_makes_no_copy_that_would_go_at_once() {
        let all: Vec<Backup> = (0..11).map(|d| Backup::day(20_400 + d * 7)).collect();
        let back = add(&all, BackupKind::Day, 10_000 * DAY_MS);
        assert_eq!(back.added, None);
        assert!(back.gone.is_empty(), "{:?}", back.gone);
        assert_eq!(back.backups.len(), all.len());
    }
}
