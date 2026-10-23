//! Rough native speed of `L` (NFR-08: ≤ 200 ms on 500 nodes, ≤ 2 s on
//! 5 000, in the worker): a DAG, a tree and a random graph, 1.5 wires per
//! node. The comparable numbers come from WASM in the benchmark; this is a
//! quick check while tuning.
//!
//!   cargo run --release -p strata-layout --example layout2d_speed

use std::time::Instant;
use strata_layout::{Kind, Net, Spacing, layout};

fn net(n: usize, shape: u8, seed: u32) -> Net {
    let mut s = seed;
    let mut rnd = move || {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        s as f32 / u32::MAX as f32
    };
    let side = (n as f32).sqrt() * 80.0;
    let pos = (0..n * 2).map(|_| rnd() * side).collect();
    let radius = (0..n)
        .map(|_| [12.0, 18.0, 30.0][(rnd() * 3.0) as usize % 3])
        .collect();
    let mut edges = Vec::new();
    match shape {
        0 => {
            for b in 1..n {
                edges.push([(rnd() * b as f32) as u32, b as u32]);
                if rnd() < 0.5 {
                    edges.push([(rnd() * b as f32) as u32, b as u32]);
                }
            }
        }
        1 => {
            for b in 1..n {
                edges.push([((rnd() * rnd()) * b as f32) as u32, b as u32]);
            }
        }
        _ => {
            for _ in 0..n * 3 / 2 {
                edges.push([
                    ((rnd() * n as f32) as usize % n) as u32,
                    ((rnd() * n as f32) as usize % n) as u32,
                ]);
            }
        }
    }
    let text = vec![false; edges.len()];
    Net {
        pos,
        radius,
        pinned: vec![false; n],
        edges,
        text,
    }
}

fn main() {
    let sp = Spacing {
        gap: 24.0,
        layer: 80.0,
    };
    for n in [500, 5_000] {
        for (shape, name) in [(0u8, "dag"), (1, "tree"), (2, "mesh")] {
            let g = net(n, shape, 7 + u32::from(shape));
            for kind in [Kind::Layered, Kind::Radial, Kind::Force] {
                let t = Instant::now();
                let out = layout(&g, kind, sp);
                let ms = t.elapsed().as_secs_f64() * 1000.0;
                assert_eq!(out.len(), n * 2);
                println!("{n:>5} {name:<4} {kind:?}: {ms:.1} ms");
            }
        }
    }
}
