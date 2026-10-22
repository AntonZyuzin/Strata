//! Rough native speed of the star map layout: a clustered cloud of 20 000
//! bodies with 30 000 springs, 300 ticks (NFR-16), then 5 000 bodies (NFR-17).
//! The comparable numbers come from the WASM run in the bench harness
//! (`docs/spikes/S2-starmap.md`); this is a quick check while tuning.
//!
//!   cargo run --release -p strata-layout --example force3d_speed

use std::time::Instant;
use strata_layout::{Force3d, Params, Springs};

fn main() {
    for (n, springs, ticks) in [(20_000, 30_000, 300), (5_000, 7_500, 60)] {
        let mut s = 12345u32;
        let mut rnd = || {
            s ^= s << 13;
            s ^= s >> 17;
            s ^= s << 5;
            s as f32 / u32::MAX as f32
        };
        // Clusters of uneven size, as the hierarchy of 08 §3.3 places them.
        let clusters = 200;
        let centres: Vec<[f32; 3]> = (0..clusters)
            .map(|_| {
                [
                    (rnd() - 0.5) * 4000.0,
                    (rnd() - 0.5) * 4000.0,
                    (rnd() - 0.5) * 4000.0,
                ]
            })
            .collect();
        let mut pos = Vec::with_capacity(n * 3);
        for _ in 0..n {
            let c = centres[((rnd() * rnd()) * clusters as f32) as usize % clusters];
            for ca in c {
                pos.push(ca + (rnd() - 0.5) * 300.0);
            }
        }
        let mut sp = Springs::default();
        for _ in 0..springs {
            let a = (rnd() * n as f32) as u32 % n as u32;
            let b = (rnd() * n as f32) as u32 % n as u32;
            if a == b {
                continue;
            }
            sp.a.push(a);
            sp.b.push(b);
            sp.length.push(60.0);
            sp.k.push(0.02);
        }
        let params = Params {
            repulsion: 30.0,
            theta: 0.8,
            centre: 0.001,
            decay: 0.4,
            max_step: 50.0,
        };
        let mut sim = Force3d::new(pos, vec![1.0; n], sp, params);
        let t0 = Instant::now();
        let mut times = Vec::with_capacity(ticks);
        let decay = 0.001f32.powf(1.0 / ticks as f32);
        let mut alpha = 1.0;
        for _ in 0..ticks {
            let t = Instant::now();
            sim.tick(alpha);
            times.push(t.elapsed().as_secs_f64() * 1000.0);
            alpha *= decay;
        }
        times.sort_by(f64::total_cmp);
        println!(
            "{n} bodies, {ticks} ticks: total {:.2} s, tick mean {:.2} ms, p95 {:.2} ms",
            t0.elapsed().as_secs_f64(),
            times.iter().sum::<f64>() / ticks as f64,
            times[ticks * 95 / 100]
        );
    }
}
