//! `strata` — one binary for the server, the headless core, the MCP launcher
//! and diagnostics (15 §2.2). Subcommands arrive with their roadmap stages:
//! for a workspace folder, `doctor` and `backup` (11 §4.1).

mod words;

use clap::{Parser, Subcommand};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use strata_core::doctor::{self, Check, Verdict};
use strata_core::store::StoreError;
use strata_core::{CoreError, folder};
use strata_model::NodeId;
use words::Lang;

#[derive(Debug, Parser)]
#[command(
    name = "strata",
    version,
    about = "Gexogon — node-based notes and projects"
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Print build information.
    Info,
    /// Generate a new node id (UUIDv7, Crockford base32).
    NewId,
    /// Convert an id between its UUID and base32 forms.
    Id {
        /// Id as 26 base32 characters or a UUID.
        value: String,
    },
    /// Check a workspace folder: its files, store, rules and copies.
    Doctor {
        /// The workspace folder (the one with strata.json).
        folder: PathBuf,
        /// The facts as JSON, the same in every language.
        #[arg(long)]
        json: bool,
    },
    /// A workspace folder's copies and archive.
    Backup {
        #[command(subcommand)]
        action: Backup,
    },
}

#[derive(Debug, Subcommand)]
enum Backup {
    /// The workspace as a .strata.zip archive.
    Create {
        folder: PathBuf,
        /// The archive's file; by default <folder name>-YYYYMMDD.strata.zip here.
        #[arg(short, long)]
        out: Option<PathBuf>,
    },
    /// The folder's copies, the newest first.
    List {
        folder: PathBuf,
        #[arg(long)]
        json: bool,
    },
    /// Check every copy, or one: whole, every document opens, the same workspace.
    Verify {
        folder: PathBuf,
        /// A copy's name, as `list` shows it.
        id: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// The folder's store becomes copy ID; the store as it was is kept as a copy.
    Restore { folder: PathBuf, id: String },
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let lang = Lang::of_system();
    match cli.command.unwrap_or(Command::Info) {
        Command::Info => println!("{}", strata_core::build_info()),
        Command::NewId => println!("{}", NodeId::new()),
        Command::Id { value } => match NodeId::parse(&value) {
            Ok(id) => {
                let uuid = uuid_text(id.as_bytes());
                println!("base32: {id}\nuuid:   {uuid}");
            }
            Err(e) => {
                eprintln!("error: {e}");
                return ExitCode::FAILURE;
            }
        },
        Command::Doctor { folder, json } => return doctor(lang, &folder, json),
        Command::Backup { action } => return backup(lang, action),
    }
    ExitCode::SUCCESS
}

/// Now, unix ms.
fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

/// Failure when any check failed: warnings pass (11 §4.1).
fn verdict(checks: &[Check]) -> ExitCode {
    if checks.iter().any(|c| c.verdict == Verdict::Fail) {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
}

fn print_checks(lang: Lang, checks: &[Check]) {
    for c in checks {
        println!("{} {}", words::mark(c.verdict), words::check_line(lang, c));
    }
}

fn json(value: &impl serde::Serialize) {
    println!(
        "{}",
        serde_json::to_string_pretty(value).unwrap_or_else(|e| format!("{{\"error\":\"{e}\"}}"))
    );
}

fn doctor(lang: Lang, dir: &Path, as_json: bool) -> ExitCode {
    let checks = doctor::doctor(dir, now());
    if as_json {
        json(&serde_json::json!({ "core": strata_core::VERSION, "checks": checks }));
    } else {
        println!("{} · {}", strata_core::build_info(), dir.display());
        print_checks(lang, &checks);
    }
    verdict(&checks)
}

fn backup(lang: Lang, action: Backup) -> ExitCode {
    match action {
        Backup::Create { folder: dir, out } => create(lang, &dir, out),
        Backup::List {
            folder: dir,
            json: as_json,
        } => {
            let list = folder::list(&dir);
            if as_json {
                json(&list);
            } else if list.is_empty() {
                println!("{}", words::no_backups(lang));
            } else {
                for b in &list {
                    println!("{}", words::backup_line(lang, b));
                }
            }
            ExitCode::SUCCESS
        }
        Backup::Verify {
            folder: dir,
            id,
            json: as_json,
        } => {
            let ids: Vec<String> = match id {
                Some(id) => vec![id],
                None => folder::list(&dir).into_iter().map(|b| b.id).collect(),
            };
            let checks: Vec<Check> = ids
                .iter()
                .map(|id| doctor::verify_backup(&dir, id))
                .collect();
            if as_json {
                json(&checks);
            } else if checks.is_empty() {
                println!("{}", words::no_backups(lang));
            } else {
                print_checks(lang, &checks);
            }
            verdict(&checks)
        }
        Backup::Restore { folder: dir, id } => match strata_core::sqlite::restore_folder(&dir, &id)
        {
            Ok(()) => {
                println!("{}", words::restored(lang, &id));
                ExitCode::SUCCESS
            }
            Err(CoreError::Store(StoreError::Locked(who))) => {
                eprintln!("{}", words::locked(lang, &who));
                ExitCode::FAILURE
            }
            Err(e) => {
                eprintln!("error: {e}");
                ExitCode::FAILURE
            }
        },
    }
}

/// `backup create`: the archive of 10 §3.5 from one snapshot of the store,
/// whether the app has the folder open or not (11 §4.1).
fn create(lang: Lang, dir: &Path, out: Option<PathBuf>) -> ExitCode {
    let made =
        strata_core::sqlite::SqliteStore::read(&dir.join("store.sqlite"), Some(dir.join("assets")))
            .map_err(CoreError::from)
            .and_then(strata_core::Workspace::open)
            .and_then(|ws| strata_core::archive::export(&ws));
    let bytes = match made {
        Ok(bytes) => bytes,
        Err(e) => {
            eprintln!("error: {e}");
            return ExitCode::FAILURE;
        }
    };
    let path = out.unwrap_or_else(|| {
        let name = dir
            .file_name()
            .map(|n| n.to_string_lossy().trim_end_matches(".strata").to_owned())
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| "workspace".to_owned());
        let stamp = strata_core::backups::day_stamp(folder::day_now());
        PathBuf::from(format!("{name}-{stamp}.strata.zip"))
    });
    if let Err(e) = std::fs::write(&path, &bytes) {
        eprintln!("error: {}: {e}", path.display());
        return ExitCode::FAILURE;
    }
    println!(
        "{}",
        words::archived(lang, &path.display().to_string(), bytes.len() as u64)
    );
    ExitCode::SUCCESS
}

fn uuid_text(b: &[u8; 16]) -> String {
    let hex: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}
