//! What a workspace folder keeps beside its `store.sqlite` (10 §3.1):
//! `.lock`, which keeps a second process out (§3.6), and `backups/`, a
//! snapshot of the store a day (§3.5).

use crate::store::StoreError;
use std::fs::{File, OpenOptions, TryLockError};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Daily snapshots kept, the newest first (10 §3.5).
const DAILY: usize = 7;
/// Weekly snapshots kept after them: the newest of each older week.
const WEEKLY: usize = 4;
/// A snapshot under way is written under this suffix and renamed when whole.
const PART: &str = ".part";

fn io(e: impl std::fmt::Display) -> StoreError {
    StoreError::Io(e.to_string())
}

/// `.lock` held by this process (10 §3.6): the system's lock on the file,
/// so a second process is refused, and a process that dies — killed, the
/// power cut — leaves no stale lock behind: the system lets it go. The file
/// says who holds it, for the one refused.
#[derive(Debug)]
pub struct FolderLock {
    _file: File,
}

impl FolderLock {
    pub fn take(dir: &Path) -> Result<Self, StoreError> {
        std::fs::create_dir_all(dir).map_err(io)?;
        let path = dir.join(".lock");
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)
            .map_err(io)?;
        match file.try_lock() {
            Ok(()) => {}
            Err(TryLockError::WouldBlock) => {
                // Where the system lets one read a locked file, it says who holds it.
                let who = std::fs::read_to_string(&path).unwrap_or_default();
                return Err(StoreError::Locked(
                    who.lines().collect::<Vec<_>>().join(", "),
                ));
            }
            Err(TryLockError::Error(e)) => return Err(io(e)),
        }
        let host = std::env::var("COMPUTERNAME")
            .or_else(|_| std::env::var("HOSTNAME"))
            .unwrap_or_default();
        let said = format!(
            "pid {}\nhost {host}\nopened {}\n",
            std::process::id(),
            unix_ms()
        );
        file.set_len(0).map_err(io)?;
        file.write_all(said.as_bytes()).map_err(io)?;
        file.sync_all().map_err(io)?;
        Ok(Self { _file: file })
    }
}

fn unix_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Days since 1970-01-01, UTC.
fn today() -> i64 {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    (secs / 86_400) as i64
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
    Some(era * 146_097 + doe - 719_468)
}

/// The snapshots of `backups/`: (day, path), the newest first.
fn snapshots(dir: &Path) -> Vec<(i64, PathBuf)> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<(i64, PathBuf)> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().into_string().ok()?;
            let stamp = name.strip_prefix("store-")?.strip_suffix(".sqlite")?;
            Some((days_of(stamp)?, e.path()))
        })
        .collect();
    out.sort_by_key(|(day, _)| std::cmp::Reverse(*day));
    out
}

/// The snapshots to let go (10 §3.5): all but the 7 newest days and,
/// before them, the newest of each of 4 weeks.
pub fn expired(days: &[i64]) -> Vec<i64> {
    let mut sorted = days.to_vec();
    sorted.sort_unstable_by(|a, b| b.cmp(a));
    sorted.dedup();
    let mut weeks: Vec<i64> = Vec::new();
    let mut out = Vec::new();
    for (i, &day) in sorted.iter().enumerate() {
        if i < DAILY {
            continue;
        }
        let week = day.div_euclid(7);
        if weeks.len() < WEEKLY && !weeks.contains(&week) {
            weeks.push(week);
        } else {
            out.push(day);
        }
    }
    out
}

/// Today's snapshot of `store`, unless `backups/` has it (10 §3.5): taken
/// online with `VACUUM INTO` over a connection of its own, written aside and
/// renamed when whole, so a crash leaves no half snapshot for the day; the
/// old ones go by [`expired`]. Returns the day it is done for.
pub fn back_up(store: &Path) -> Result<i64, StoreError> {
    // One at a time in this process: the folder's lock keeps others out.
    static ONE: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _one = ONE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let day = today();
    let Some(folder) = store.parent() else {
        return Err(io("a store with no folder"));
    };
    let dir = folder.join("backups");
    std::fs::create_dir_all(&dir).map_err(io)?;
    // What a crash left half written.
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            if e.file_name().to_string_lossy().ends_with(PART) {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    let target = dir.join(format!("store-{}.sqlite", day_stamp(day)));
    if !target.exists() {
        let part = dir.join(format!("store-{}.sqlite{PART}", day_stamp(day)));
        let db = rusqlite::Connection::open(store).map_err(io)?;
        db.execute("VACUUM INTO ?1", [part.to_string_lossy().as_ref()])
            .map_err(io)?;
        drop(db);
        std::fs::rename(&part, &target).map_err(io)?;
    }
    let all = snapshots(&dir);
    let gone = expired(&all.iter().map(|(d, _)| *d).collect::<Vec<_>>());
    for (d, path) in all {
        if gone.contains(&d) {
            let _ = std::fs::remove_file(path);
        }
    }
    Ok(day)
}

/// Today, for the store to know when a day has passed since its snapshot.
pub fn day_now() -> i64 {
    today()
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
    }

    #[test]
    fn seven_days_and_four_weeks_stay() {
        // 60 days of snapshots, every day.
        let days: Vec<i64> = (20_000..20_060).collect();
        let gone = expired(&days);
        let kept: Vec<i64> = days.iter().copied().filter(|d| !gone.contains(d)).collect();
        assert_eq!(kept.len(), DAILY + WEEKLY, "{kept:?}");
        // The 7 newest days…
        for d in 20_053..20_060 {
            assert!(kept.contains(&d), "{d}");
        }
        // …then one a week, each of another week.
        let older: Vec<i64> = kept.iter().copied().filter(|&d| d < 20_053).collect();
        let weeks: std::collections::BTreeSet<i64> =
            older.iter().map(|d| d.div_euclid(7)).collect();
        assert_eq!(weeks.len(), WEEKLY);
        // Fewer than that: all stay.
        assert!(expired(&days[..8]).is_empty());
    }
}
