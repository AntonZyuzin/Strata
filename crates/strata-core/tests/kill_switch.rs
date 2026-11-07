//! The kill switch (NFR-69, NFR-71): a writer process applies changesets
//! to a workspace folder and says which ones the core confirmed; it is
//! killed (`kill -9`) at a random moment, the folder is opened again, and
//! every confirmed changeset is there — whole, as is every other: a
//! changeset is all of its ops or none.
//!
//! The writer is this test binary run again with `STRATA_KILL_CHILD` set.
//! `STRATA_KILL_ROUNDS=<n>` sets how many kills (NFR-69: 1 000, in a
//! release step of CI), `STRATA_KILL_SEED` the generator's seed. A power
//! cut in a VM, the other half of NFR-69, is the owner's to run (16 §4.9).

use std::collections::BTreeSet;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use strata_core::model::{NodeId, NodeKind};
use strata_core::sqlite::{create_folder, open_folder};
use strata_core::{Label, Op};

/// Kills of a plain `cargo test`; CI asks for 1 000 (NFR-69).
const DEFAULT_ROUNDS: u64 = 12;
/// Nodes one changeset makes: all of them are there, or none (NFR-71).
const GROUP: usize = 3;
/// Kills one folder takes before a fresh one: it stays small to open.
const ROUNDS_PER_FOLDER: u64 = 20;
/// A confirmation's line starts so: the test harness writes its own lines too.
const CONFIRMED: &str = "confirmed ";

/// SplitMix64, as the property tests: a seed replays its kills.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
}

fn env_u64(key: &str, default: u64) -> u64 {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

/// The writer: changesets of `GROUP` new nodes, one after another; each
/// confirmed one is a line of their ids on stdout. It writes until killed.
fn write_until_killed(dir: &Path) -> ! {
    let mut w = open_folder(dir).expect("the writer opens the folder");
    let root = w.root();
    let mut out = std::io::stdout().lock();
    loop {
        let ids: Vec<String> = (0..GROUP).map(|_| NodeId::new().to_text()).collect();
        let ops: Vec<Op> = ids
            .iter()
            .enumerate()
            .map(|(i, id)| Op::CreateNode {
                id: Some(id.clone()),
                kind: NodeKind::Note,
                name: format!("{id}-{i}"),
                net: root.clone(),
                x: i as f64,
                y: 0.0,
            })
            .collect();
        w.apply(&ops, Label::new("kill.write"))
            .expect("the writer's changeset");
        // Confirmed: the core returned. The line says so.
        writeln!(out, "{CONFIRMED}{}", ids.join(" ")).expect("stdout");
        out.flush().expect("stdout");
    }
}

/// The lines the writer finished, read while it runs and after it died:
/// a line cut by the kill is no confirmation.
fn spawn_writer(dir: &Path) -> (Child, mpsc::Receiver<String>) {
    let mut child = Command::new(std::env::current_exe().expect("the test binary"))
        .args([
            "--exact",
            "a_killed_writer_loses_no_confirmed_changeset",
            "--nocapture",
        ])
        .env("STRATA_KILL_CHILD", dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("the writer starts");
    let stdout = child.stdout.take().expect("its stdout");
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        // `read_line` keeps a cut line without its newline: not sent.
        while reader.read_line(&mut line).unwrap_or(0) > 0 {
            if let Some(ids) = line
                .strip_suffix('\n')
                .and_then(|l| l.strip_prefix(CONFIRMED))
            {
                let _ = tx.send(ids.to_owned());
            }
            line.clear();
        }
    });
    (child, rx)
}

#[test]
fn a_killed_writer_loses_no_confirmed_changeset() {
    if let Some(dir) = std::env::var_os("STRATA_KILL_CHILD") {
        write_until_killed(Path::new(&dir));
    }
    let rounds = env_u64("STRATA_KILL_ROUNDS", DEFAULT_ROUNDS);
    let mut rng = Rng(env_u64("STRATA_KILL_SEED", 1));
    let tmp = std::env::temp_dir().join(format!("strata-kill-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).expect("a folder for the workspace");
    let mut dir = tmp.join("ws");
    let mut confirmed: Vec<Vec<String>> = Vec::new();
    for round in 0..rounds {
        if round % ROUNDS_PER_FOLDER == 0 {
            dir = tmp.join(format!("ws{round}"));
            drop(create_folder(&dir, "Корень").expect("the workspace"));
            confirmed.clear();
        }
        let (mut child, lines) = spawn_writer(&dir);
        // The writer's first confirmation, then a random while more: the
        // kill falls anywhere in a changeset's life, its commit included.
        let started = Instant::now();
        let first = lines.recv_timeout(Duration::from_secs(30));
        let wait = Duration::from_micros(rng.next() % 40_000);
        std::thread::sleep(wait);
        child.kill().expect("kill -9");
        child.wait().expect("the writer is gone");
        let mut now: Vec<String> = first.into_iter().collect();
        now.extend(lines.iter());
        assert!(
            !now.is_empty() || started.elapsed() > Duration::from_secs(29),
            "round {round}: the writer confirmed nothing"
        );
        confirmed.extend(
            now.iter()
                .map(|l| l.split(' ').map(str::to_owned).collect()),
        );
        // Open again: every confirmed changeset whole (NFR-69); every
        // changeset whole or absent (NFR-71).
        let w = open_folder(&dir).unwrap_or_else(|e| panic!("round {round}: opens again: {e}"));
        let alive: BTreeSet<String> = w.tree().into_iter().map(|i| i.id).collect();
        for group in &confirmed {
            for id in group {
                assert!(
                    alive.contains(id),
                    "round {round}: a confirmed node is lost: {id} (of {} confirmed changesets)",
                    confirmed.len()
                );
            }
        }
        let made: BTreeSet<&String> = confirmed.iter().flatten().collect();
        let extra = alive.len() - 1 - made.len();
        assert!(
            extra.is_multiple_of(GROUP),
            "round {round}: an unconfirmed changeset is there in part ({extra} nodes)"
        );
    }
    let _ = std::fs::remove_dir_all(&tmp);
}
