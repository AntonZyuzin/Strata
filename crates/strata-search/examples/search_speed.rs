//! The name search on the synthetic workspace W-100k (09 §2.6, 14 §1.3):
//! the index's build, then queries of every stage, p50 and p95 per query.
//! Budget: ≤ 16 ms p95 for one keystroke.
//!
//!   cargo run --release -p strata-search --example search_speed

use std::time::Instant;
use strata_model::NodeKind;
use strata_search::{Context, Index, Item};

fn main() {
    let words = [
        "сцена",
        "шейдер",
        "боевка",
        "анимация",
        "звук",
        "доска",
        "план",
        "встреча",
        "point",
        "wrangle",
        "level",
        "design",
        "удар",
        "свет",
        "вода",
        "лес",
        "мельница",
        "туман",
        "задача",
        "референсы",
        "мудборд",
        "диздок",
        "персонаж",
        "локация",
        "уровень",
        "босс",
        "музыка",
    ];
    let n = 100_000;
    let items: Vec<Item> = (0..n)
        .map(|i| Item {
            id: format!("n{i}"),
            name: format!(
                "{} {} {}",
                words[i % words.len()],
                words[(i / 7) % words.len()],
                i % 1000
            ),
            kind: NodeKind::Note,
            parent: None,
            status: None,
            flags: Vec::new(),
            aliases: Vec::new(),
        })
        .collect();
    let t = Instant::now();
    let index = Index::new(items);
    println!(
        "build of {n} names: {:.0} ms",
        t.elapsed().as_secs_f64() * 1e3
    );
    let ctx = Context {
        limit: Some(50),
        ..Context::default()
    };
    for q in [
        "с",
        "сц",
        "сцена",
        "сцена шейдер",
        "шш",
        "ена",
        "мельнциа",
        "персонаж босс 12",
        ",jtdrf",
        "референсы мудборд",
    ] {
        let mut times: Vec<f64> = (0..20)
            .map(|_| {
                let t = Instant::now();
                std::hint::black_box(index.query(q, &ctx));
                t.elapsed().as_secs_f64() * 1e3
            })
            .collect();
        times.sort_by(f64::total_cmp);
        println!(
            "{q:>20}: p50 {:6.2} ms, p95 {:6.2} ms",
            times[times.len() / 2],
            times[times.len() * 95 / 100]
        );
    }
}
