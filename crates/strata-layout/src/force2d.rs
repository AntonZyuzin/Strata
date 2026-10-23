//! Free: forces with constraints (06 §9.2), on the star map's Barnes–Hut
//! engine with every body on one plane.
//!
//! Repulsion grows with the bubble, a wire is a spring the length of both
//! radii and the layer gap, pinned nodes are fixed bodies, a weak pull keeps
//! the parts together. It starts from the radial layout (`net`), 300 ticks,
//! no randomness but a fixed nudge for nodes on one spot: the same network
//! gives the same layout. The overlap pass in `net` finishes it.

use crate::force3d::{Force3d, Params, Springs};
use crate::net::{Edge, Net, Spacing};

const TICKS: u32 = 300;

pub(crate) fn layout(net: &Net, edges: &[Edge], sp: Spacing) -> Vec<f32> {
    let n = net.radius.len();
    if n == 1 {
        return net.pos.clone();
    }
    // Around the origin: the engine's centring pulls to it.
    let (mut cx, mut cy) = (0.0f64, 0.0f64);
    for p in net.pos.chunks_exact(2) {
        cx += f64::from(p[0]);
        cy += f64::from(p[1]);
    }
    let (cx, cy) = ((cx / n as f64) as f32, (cy / n as f64) as f32);
    let mean_r = net.radius.iter().sum::<f32>() / n as f32;
    let mut pos = Vec::with_capacity(n * 3);
    let mut seen = std::collections::HashSet::new();
    for i in 0..n {
        let (mut x, mut y) = (net.pos[i * 2] - cx, net.pos[i * 2 + 1] - cy);
        // Nodes on one spot would feel no force between them: a fixed nudge.
        if !seen.insert((x.to_bits(), y.to_bits())) {
            let a = i as f32 * 2.399_963;
            x += a.cos() * mean_r;
            y += a.sin() * mean_r;
        }
        pos.extend_from_slice(&[x, y, 0.0]);
    }
    let mass: Vec<f32> = net.radius.iter().map(|r| r / mean_r).collect();
    let springs = Springs {
        a: edges.iter().map(|e| e[0] as u32).collect(),
        b: edges.iter().map(|e| e[1] as u32).collect(),
        length: edges
            .iter()
            .map(|e| net.radius[e[0]] + net.radius[e[1]] + sp.layer)
            .collect(),
        k: vec![0.06; edges.len()],
    };
    // Repulsion of two mean bubbles balances a stretched wire about one wire apart.
    let reach = 2.0 * mean_r + sp.layer;
    let params = Params {
        repulsion: reach * reach * 1.0,
        theta: 0.8,
        centre: 0.002,
        decay: 0.4,
        max_step: reach,
    };
    let mut f = Force3d::new(pos, mass, springs, params);
    for i in 0..n {
        if net.pinned[i] {
            f.set_fixed(i, true);
        }
    }
    f.run(TICKS, 0.001);
    f.positions()
        .chunks_exact(3)
        .flat_map(|p| [p[0] + cx, p[1] + cy])
        .collect()
}

#[cfg(test)]
mod tests {
    use crate::net::tests::{SP, mesh};
    use crate::net::{Kind, layout, used_edges};

    #[test]
    fn wires_end_up_about_their_length() {
        let net = mesh(300, 31);
        let out = layout(&net, Kind::Force, SP);
        let edges = used_edges(&net);
        let mut lengths: Vec<f32> = edges
            .iter()
            .map(|&[a, b]| {
                ((out[a * 2] - out[b * 2]).powi(2) + (out[a * 2 + 1] - out[b * 2 + 1]).powi(2))
                    .sqrt()
            })
            .collect();
        lengths.sort_by(f32::total_cmp);
        let median = lengths[lengths.len() / 2];
        // Rest length 2·r̄ + layer ≈ 120: the median wire is within a few of it.
        assert!(median > 60.0 && median < 400.0, "median wire {median}");
    }
}
