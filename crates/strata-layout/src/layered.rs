//! Top to bottom: a layered DAG after Sugiyama (06 §9.2).
//!
//! 1. Cycles (allowed, 05 §8.2) are broken by turning the back wires of a
//!    depth-first walk; the walk starts from the sources, then from the
//!    top-left node, so the turned wires are the ones that close a cycle.
//! 2. Layers by the longest path from the sources; a source is then pulled
//!    down to just above its nearest child, so it does not hang far above it.
//! 3. A wire over several layers gets a chain of thin virtual nodes, one per
//!    layer it crosses.
//! 4. The order in a layer starts from the nodes' x now, then barycentric
//!    sweeps down and up (8 of them); the order with the fewest crossings wins.
//! 5. x: each layer in turn takes the mean x of its neighbours, kept in order
//!    and apart by the exact least-squares fit (pool adjacent violators);
//!    sweeps down, up, then both ways.
//! 6. y: layer by layer, the tallest bubble of each and the layer gap apart.

use crate::net::{Edge, Net, Part, Spacing};

const SWEEPS: usize = 8;

pub(crate) fn layout(net: &Net, part: &Part, sp: Spacing) -> Vec<[f32; 2]> {
    let m = part.nodes.len();
    if m == 1 {
        return vec![[0.0, 0.0]];
    }
    let at = |k: usize| {
        let i = part.nodes[k];
        [net.pos[i * 2], net.pos[i * 2 + 1]]
    };
    let dag = acyclic(m, &part.edges, &at);
    let layer = layers(m, &dag);

    // Real nodes first, then virtual ones; `width` is the bubble's diameter.
    let mut node_layer = layer.clone();
    let mut width: Vec<f32> = part.nodes.iter().map(|&i| 2.0 * net.radius[i]).collect();
    let mut hint: Vec<f32> = (0..m).map(|k| at(k)[0]).collect();
    let mut links: Vec<Edge> = Vec::new();
    for &[a, b] in &dag {
        let span = layer[b] - layer[a];
        let mut prev = a;
        for s in 1..span {
            let v = node_layer.len();
            node_layer.push(layer[a] + s);
            width.push(sp.gap * 0.5);
            let t = s as f32 / span as f32;
            hint.push(hint[a] * (1.0 - t) + hint[b] * t);
            links.push([prev, v]);
            prev = v;
        }
        links.push([prev, b]);
    }
    let total = node_layer.len();
    let depth = node_layer.iter().copied().max().unwrap_or(0) + 1;
    let mut up: Vec<Vec<usize>> = vec![Vec::new(); total];
    let mut down: Vec<Vec<usize>> = vec![Vec::new(); total];
    for &[a, b] in &links {
        down[a].push(b);
        up[b].push(a);
    }

    // First order: by x now; ties by index.
    let mut rows: Vec<Vec<usize>> = vec![Vec::new(); depth];
    for v in 0..total {
        rows[node_layer[v]].push(v);
    }
    for row in &mut rows {
        row.sort_by(|&a, &b| hint[a].total_cmp(&hint[b]).then(a.cmp(&b)));
    }
    order(&mut rows, &up, &down, total);

    // x by the order, then pulled to the neighbours.
    let mut x = vec![0.0f32; total];
    for row in &rows {
        let mut cursor = 0.0;
        for (k, &v) in row.iter().enumerate() {
            if k > 0 {
                cursor += (width[row[k - 1]] + width[v]) / 2.0 + sp.gap;
            }
            x[v] = cursor;
        }
        let mid = cursor / 2.0;
        for &v in row {
            x[v] -= mid;
        }
    }
    // A sweep: downward or not, the neighbours to follow, and more to follow too.
    type Sweep<'a> = (bool, &'a [Vec<usize>], &'a [Vec<usize>]);
    let plan: [Sweep; 6] = [
        (true, &up, &[]),
        (false, &down, &[]),
        (true, &up, &[]),
        (false, &down, &[]),
        (true, &up, &down),
        (false, &down, &up),
    ];
    for (downward, first, second) in plan {
        let layers: Vec<usize> = if downward {
            (0..depth).collect()
        } else {
            (0..depth).rev().collect()
        };
        for l in layers {
            let row = &rows[l];
            let target: Vec<f32> = row
                .iter()
                .map(|&v| {
                    let ns = first[v].iter().chain(second.get(v).into_iter().flatten());
                    let (sum, count) = ns.fold((0.0f32, 0usize), |(s, c), &u| (s + x[u], c + 1));
                    if count == 0 { x[v] } else { sum / count as f32 }
                })
                .collect();
            let gaps: Vec<f32> = row
                .windows(2)
                .map(|w| (width[w[0]] + width[w[1]]) / 2.0 + sp.gap)
                .collect();
            for (v, nx) in row.iter().zip(fit_in_order(&target, &gaps)) {
                x[*v] = nx;
            }
        }
    }

    // y: layers the height of their tallest bubble apart.
    let mut half = vec![0.0f32; depth];
    for v in 0..m {
        half[node_layer[v]] = half[node_layer[v]].max(width[v] / 2.0);
    }
    let mut y = vec![0.0f32; depth];
    for l in 1..depth {
        y[l] = y[l - 1] + half[l - 1] + half[l] + sp.layer;
    }
    (0..m).map(|v| [x[v], y[node_layer[v]]]).collect()
}

/// The wires with every back wire of a depth-first walk turned around.
fn acyclic(m: usize, edges: &[Edge], at: &dyn Fn(usize) -> [f32; 2]) -> Vec<Edge> {
    let mut out_adj: Vec<Vec<usize>> = vec![Vec::new(); m];
    for &[a, b] in edges {
        out_adj[a].push(b);
    }
    let key = |k: usize| {
        let p = at(k);
        (p[1], p[0])
    };
    for adj in &mut out_adj {
        adj.sort_by(|&a, &b| {
            key(a)
                .0
                .total_cmp(&key(b).0)
                .then(key(a).1.total_cmp(&key(b).1))
        });
    }
    // Sources first, so the wires that close a cycle are the ones turned.
    let mut indeg = vec![0usize; m];
    for &[_, b] in edges {
        indeg[b] += 1;
    }
    let mut starts: Vec<usize> = (0..m).collect();
    starts.sort_by(|&a, &b| {
        (indeg[a] > 0)
            .cmp(&(indeg[b] > 0))
            .then(key(a).0.total_cmp(&key(b).0))
            .then(key(a).1.total_cmp(&key(b).1))
    });
    // 0 new, 1 on the walk's path, 2 done.
    let mut state = vec![0u8; m];
    let mut back = std::collections::HashSet::new();
    for s in starts {
        if state[s] != 0 {
            continue;
        }
        let mut stack = vec![(s, 0usize)];
        state[s] = 1;
        while let Some(top) = stack.last_mut() {
            let (v, next) = *top;
            if next < out_adj[v].len() {
                top.1 += 1;
                let w = out_adj[v][next];
                match state[w] {
                    0 => {
                        state[w] = 1;
                        stack.push((w, 0));
                    }
                    1 => {
                        back.insert((v, w));
                    }
                    _ => {}
                }
            } else {
                state[v] = 2;
                stack.pop();
            }
        }
    }
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::with_capacity(edges.len());
    for &[a, b] in edges {
        let e = if back.contains(&(a, b)) {
            [b, a]
        } else {
            [a, b]
        };
        // A wire and its turned twin would be one wire both ways.
        if seen.insert(e) {
            out.push(e);
        }
    }
    out
}

/// Layer per node: the longest path from a source, then sources pulled down
/// to just above their nearest child.
fn layers(m: usize, dag: &[Edge]) -> Vec<usize> {
    let mut indeg = vec![0usize; m];
    let mut out_adj: Vec<Vec<usize>> = vec![Vec::new(); m];
    for &[a, b] in dag {
        indeg[b] += 1;
        out_adj[a].push(b);
    }
    let mut queue: std::collections::VecDeque<usize> = (0..m).filter(|&v| indeg[v] == 0).collect();
    let mut topo = Vec::with_capacity(m);
    let mut layer = vec![0usize; m];
    let mut left = indeg.clone();
    while let Some(v) = queue.pop_front() {
        topo.push(v);
        for &w in &out_adj[v] {
            layer[w] = layer[w].max(layer[v] + 1);
            left[w] -= 1;
            if left[w] == 0 {
                queue.push_back(w);
            }
        }
    }
    for &v in topo.iter().rev() {
        if indeg[v] == 0 && !out_adj[v].is_empty() {
            let nearest = out_adj[v].iter().map(|&w| layer[w]).min().unwrap_or(1);
            layer[v] = nearest.saturating_sub(1);
        }
    }
    layer
}

/// Barycentric sweeps; keeps the order with the fewest crossings.
fn order(rows: &mut [Vec<usize>], up: &[Vec<usize>], down: &[Vec<usize>], total: usize) {
    let mut place = vec![0usize; total];
    let index = |rows: &[Vec<usize>], place: &mut [usize]| {
        for row in rows {
            for (k, &v) in row.iter().enumerate() {
                place[v] = k;
            }
        }
    };
    index(rows, &mut place);
    let mut best = rows.to_vec();
    let mut best_cross = crossings(rows, down, &place);
    for sweep in 0..SWEEPS {
        let downward = sweep % 2 == 0;
        let ls: Vec<usize> = if downward {
            (1..rows.len()).collect()
        } else {
            (0..rows.len().saturating_sub(1)).rev().collect()
        };
        for l in ls {
            let nb = if downward { up } else { down };
            let bary: Vec<(usize, f32)> = rows[l]
                .iter()
                .map(|&v| {
                    let ns = &nb[v];
                    let b = if ns.is_empty() {
                        place[v] as f32
                    } else {
                        ns.iter().map(|&u| place[u] as f32).sum::<f32>() / ns.len() as f32
                    };
                    (v, b)
                })
                .collect();
            let mut sorted = bary;
            sorted.sort_by(|a, b| a.1.total_cmp(&b.1).then(place[a.0].cmp(&place[b.0])));
            rows[l] = sorted.into_iter().map(|(v, _)| v).collect();
            for (k, &v) in rows[l].iter().enumerate() {
                place[v] = k;
            }
        }
        let c = crossings(rows, down, &place);
        if c < best_cross {
            best_cross = c;
            best = rows.to_vec();
        }
    }
    rows.clone_from_slice(&best);
}

/// Wire crossings between consecutive layers: inversions of the lower ends
/// when the wires are sorted by their upper ends (a Fenwick tree).
fn crossings(rows: &[Vec<usize>], down: &[Vec<usize>], place: &[usize]) -> usize {
    let mut total = 0;
    for l in 0..rows.len().saturating_sub(1) {
        let mut ends: Vec<(usize, usize)> = Vec::new();
        for &v in &rows[l] {
            for &w in &down[v] {
                ends.push((place[v], place[w]));
            }
        }
        ends.sort_unstable();
        let size = rows[l + 1].len() + 1;
        let mut tree = vec![0usize; size + 1];
        for (seen, &(_, b)) in ends.iter().enumerate() {
            // Wires seen so far whose lower end lies right of b cross this one.
            let mut i = b + 1;
            let mut not_greater = 0;
            while i > 0 {
                not_greater += tree[i];
                i -= i & i.wrapping_neg();
            }
            total += seen - not_greater;
            let mut i = b + 1;
            while i <= size {
                tree[i] += 1;
                i += i & i.wrapping_neg();
            }
        }
    }
    total
}

/// Positions as close to `target` as least squares allow, in order and at
/// least `gaps[k]` between neighbours k and k + 1: pool adjacent violators on
/// the targets with the gaps taken out.
pub(crate) fn fit_in_order(target: &[f32], gaps: &[f32]) -> Vec<f32> {
    let n = target.len();
    let mut offset = vec![0.0f32; n];
    for k in 1..n {
        offset[k] = offset[k - 1] + gaps[k - 1];
    }
    // Blocks of (mean, count) over target − offset, non-decreasing.
    let mut blocks: Vec<(f32, usize)> = Vec::with_capacity(n);
    for k in 0..n {
        blocks.push((target[k] - offset[k], 1));
        while blocks.len() > 1 {
            let (m1, c1) = blocks[blocks.len() - 1];
            let (m0, c0) = blocks[blocks.len() - 2];
            if m0 <= m1 {
                break;
            }
            blocks.pop();
            let c = c0 + c1;
            *blocks.last_mut().expect("two blocks") =
                ((m0 * c0 as f32 + m1 * c1 as f32) / c as f32, c);
        }
    }
    let mut out = Vec::with_capacity(n);
    for (mean, count) in blocks {
        for _ in 0..count {
            let k = out.len();
            out.push(mean + offset[k]);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::tests::{SP, dag};
    use crate::net::{Kind, layout as run, parts, used_edges};

    #[test]
    fn the_fit_keeps_order_and_gaps_and_is_exact_when_it_can_be() {
        assert_eq!(
            fit_in_order(&[0.0, 100.0, 300.0], &[50.0, 50.0]),
            vec![0.0, 100.0, 300.0]
        );
        // Two targets on one spot share it: 10 apart around the mean.
        assert_eq!(fit_in_order(&[5.0, 5.0], &[10.0]), vec![0.0, 10.0]);
        let x = fit_in_order(&[30.0, 0.0, 10.0, -20.0], &[10.0, 10.0, 10.0]);
        for k in 0..3 {
            assert!(x[k + 1] - x[k] >= 10.0 - 1e-4, "{x:?}");
        }
    }

    #[test]
    fn crossings_are_counted() {
        // Two wires 0→3 and 1→2 cross; 0→2 and 1→3 do not.
        let rows = vec![vec![0, 1], vec![2, 3]];
        let place = vec![0, 1, 0, 1];
        let cross = vec![vec![3], vec![2], vec![], vec![]];
        let straight = vec![vec![2], vec![3], vec![], vec![]];
        assert_eq!(crossings(&rows, &cross, &place), 1);
        assert_eq!(crossings(&rows, &straight, &place), 0);
    }

    #[test]
    fn cycles_are_broken_and_wires_point_down() {
        let net = dag(400, 9);
        let out = run(&net, Kind::Layered, SP);
        let edges = used_edges(&net);
        let down = edges
            .iter()
            .filter(|&&[a, b]| out[b * 2 + 1] > out[a * 2 + 1])
            .count();
        // The dag has a few back wires (cycles): only those may point up.
        assert!(
            down * 100 >= edges.len() * 97,
            "{down} of {} point down",
            edges.len()
        );
    }

    #[test]
    fn sweeps_cut_crossings_of_a_shuffled_tree() {
        // A binary tree whose leaves start in a shuffled order.
        let mut net = crate::net::tests::scattered(63, 4);
        net.edges = (1..63u32).map(|b| [(b - 1) / 2, b]).collect();
        net.text = vec![false; net.edges.len()];
        let out = run(&net, Kind::Layered, SP);
        let p = &parts(63, &used_edges(&net))[0];
        // A tree laid out well has no crossings: every subtree in its own span.
        for &[a, b] in &p.edges {
            for &[c, d] in &p.edges {
                let (xa, xb, xc, xd) = (out[a * 2], out[b * 2], out[c * 2], out[d * 2]);
                if out[a * 2 + 1] == out[c * 2 + 1] && a != c {
                    assert!((xa < xc) == (xb <= xd) || xb == xd, "crossing");
                }
            }
        }
    }
}
