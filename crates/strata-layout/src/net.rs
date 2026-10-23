//! `L` on a network (06 §9, spike 10): the input every 2D layout shares, the
//! choice of wires, components, packing, pinned nodes and the last pass that
//! keeps bubbles apart.
//!
//! - Wires drawn by hand or imported lead; a wire only from text counts when
//!   one of its ends has no other wire (☑ Q-13-3).
//! - Each connected part is laid out alone; the layered and radial layouts
//!   then pack the parts in rows. The force layout starts from the radial one
//!   and keeps all parts in one field.
//! - The centre of the laid-out nodes stays where it was (06 §9.1); with
//!   pinned nodes, the layout is moved to fit them as well as it can, and
//!   they stay exactly where they are.
//! - Bubbles never overlap: a last pass pushes apart any pair closer than the
//!   sum of their radii and the gap.

use crate::{force2d, layered, radial};

/// A network to lay out: nodes by index, positions `[x, y]` per node.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Net {
    /// Where the nodes are now: the force layout starts here, the others take
    /// their first order from it, pinned nodes stay.
    pub pos: Vec<f32>,
    /// Bubble radius per node, world units.
    pub radius: Vec<f32>,
    /// Pinned nodes (06 §9.1): they do not move and anchor the rest.
    pub pinned: Vec<bool>,
    /// Wires `[from, to]`.
    pub edges: Vec<[u32; 2]>,
    /// Per wire: it comes only from text (origin `text`), the second priority.
    pub text: Vec<bool>,
}

/// The algorithm of `L`, by the network's direction (06 §9.2).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// Top to bottom: a layered DAG (Sugiyama).
    Layered,
    /// From the centre: a radial tree.
    Radial,
    /// Free: forces with constraints.
    Force,
}

/// Distances of a layout, world units.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Spacing {
    /// Between two bubbles side by side.
    pub gap: f32,
    /// Between layers, rings, and along a wire in the force layout.
    pub layer: f32,
}

/// A wire the layout uses, local to a part.
pub(crate) type Edge = [usize; 2];

/// One connected part: its nodes (indices into the net) and wires between them
/// as indices into `nodes`.
#[derive(Debug)]
pub(crate) struct Part {
    pub nodes: Vec<usize>,
    pub edges: Vec<Edge>,
}

/// Lays out `net` with `kind`; returns `[x, y]` per node.
///
/// # Panics
///
/// When the arrays of `net` differ in length or a wire names a node that
/// does not exist.
pub fn layout(net: &Net, kind: Kind, sp: Spacing) -> Vec<f32> {
    let n = net.radius.len();
    assert_eq!(net.pos.len(), n * 2, "two coordinates per node");
    assert_eq!(net.pinned.len(), n, "a pinned flag per node");
    assert_eq!(net.text.len(), net.edges.len(), "an origin per wire");
    assert!(
        net.edges.iter().flatten().all(|&i| (i as usize) < n),
        "wires between existing nodes"
    );
    if n <= 1 {
        return net.pos.clone();
    }
    let edges = used_edges(net);
    let mut out = match kind {
        Kind::Layered | Kind::Radial => structured(net, &edges, kind, sp),
        Kind::Force => {
            // A fixed start where wired nodes are already near (06 §9.2: «фиксированное
            // зерно»): from random places, forces cool down before clusters part.
            let start = Net {
                pos: structured(net, &edges, Kind::Radial, sp),
                ..net.clone()
            };
            force2d::layout(&start, &edges, sp)
        }
    };
    anchor(net, &mut out);
    separate(&mut out, &net.radius, &net.pinned, sp.gap, 50);
    out
}

/// The layered or radial layout of every part, packed and anchored.
fn structured(net: &Net, edges: &[Edge], kind: Kind, sp: Spacing) -> Vec<f32> {
    let parts = parts(net.radius.len(), edges);
    let placed: Vec<Vec<[f32; 2]>> = parts
        .iter()
        .map(|p| match kind {
            Kind::Layered => layered::layout(net, p, sp),
            _ => radial::layout(net, p, sp),
        })
        .collect();
    let mut out = pack(net, &parts, &placed, sp);
    anchor(net, &mut out);
    out
}

/// Wires the layout follows (☑ Q-13-3): every manual or imported wire, and a
/// text wire when one of its ends has no manual wire. No loops, no repeats.
pub(crate) fn used_edges(net: &Net) -> Vec<Edge> {
    let n = net.radius.len();
    let mut manual = vec![false; n];
    for (e, &[a, b]) in net.edges.iter().enumerate() {
        if !net.text[e] && a != b {
            manual[a as usize] = true;
            manual[b as usize] = true;
        }
    }
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for (e, &[a, b]) in net.edges.iter().enumerate() {
        let (a, b) = (a as usize, b as usize);
        if a == b || (net.text[e] && manual[a] && manual[b]) {
            continue;
        }
        if seen.insert((a, b)) {
            out.push([a, b]);
        }
    }
    out
}

/// Connected parts, wires as undirected, largest first; ties by first node.
pub(crate) fn parts(n: usize, edges: &[Edge]) -> Vec<Part> {
    let mut root: Vec<usize> = (0..n).collect();
    fn find(root: &mut [usize], mut i: usize) -> usize {
        while root[i] != i {
            root[i] = root[root[i]];
            i = root[i];
        }
        i
    }
    for &[a, b] in edges {
        let (ra, rb) = (find(&mut root, a), find(&mut root, b));
        if ra != rb {
            root[ra.max(rb)] = ra.min(rb);
        }
    }
    let mut index = vec![usize::MAX; n];
    let mut parts: Vec<Part> = Vec::new();
    let mut local = vec![0usize; n];
    for (i, slot) in local.iter_mut().enumerate() {
        let r = find(&mut root, i);
        if index[r] == usize::MAX {
            index[r] = parts.len();
            parts.push(Part {
                nodes: Vec::new(),
                edges: Vec::new(),
            });
        }
        let p = &mut parts[index[r]];
        *slot = p.nodes.len();
        p.nodes.push(i);
    }
    for &[a, b] in edges {
        let r = find(&mut root, a);
        parts[index[r]].edges.push([local[a], local[b]]);
    }
    parts.sort_by_key(|p| std::cmp::Reverse(p.nodes.len()));
    parts
}

/// Bounding box of a placed part with radii: `[min x, min y, max x, max y]`.
fn bounds(net: &Net, part: &Part, at: &[[f32; 2]]) -> [f32; 4] {
    let mut b = [
        f32::INFINITY,
        f32::INFINITY,
        f32::NEG_INFINITY,
        f32::NEG_INFINITY,
    ];
    for (k, &i) in part.nodes.iter().enumerate() {
        let r = net.radius[i];
        b[0] = b[0].min(at[k][0] - r);
        b[1] = b[1].min(at[k][1] - r);
        b[2] = b[2].max(at[k][0] + r);
        b[3] = b[3].max(at[k][1] + r);
    }
    b
}

/// Parts in rows, largest first, each row as wide as the square root of the
/// total area allows; returns `[x, y]` per node of the net.
fn pack(net: &Net, parts: &[Part], placed: &[Vec<[f32; 2]>], sp: Spacing) -> Vec<f32> {
    let boxes: Vec<[f32; 4]> = parts
        .iter()
        .zip(placed)
        .map(|(p, at)| bounds(net, p, at))
        .collect();
    let area: f32 = boxes
        .iter()
        .map(|b| (b[2] - b[0] + sp.layer) * (b[3] - b[1] + sp.layer))
        .sum();
    let widest = boxes.iter().map(|b| b[2] - b[0]).fold(0.0, f32::max);
    let row_width = widest.max(area.sqrt() * 1.6);
    let mut out = vec![0.0; net.radius.len() * 2];
    let (mut x, mut y, mut row_height) = (0.0f32, 0.0f32, 0.0f32);
    for ((part, at), b) in parts.iter().zip(placed).zip(&boxes) {
        let (w, h) = (b[2] - b[0], b[3] - b[1]);
        if x > 0.0 && x + w > row_width {
            x = 0.0;
            y += row_height + sp.layer;
            row_height = 0.0;
        }
        for (k, &i) in part.nodes.iter().enumerate() {
            out[i * 2] = at[k][0] - b[0] + x;
            out[i * 2 + 1] = at[k][1] - b[1] + y;
        }
        x += w + sp.layer;
        row_height = row_height.max(h);
    }
    out
}

/// Moves the layout so its centre stays where the nodes' centre was, or,
/// with pinned nodes, so they move as little as possible; then puts the
/// pinned nodes back exactly.
fn anchor(net: &Net, out: &mut [f32]) {
    let n = net.radius.len();
    let pinned: Vec<usize> = (0..n).filter(|&i| net.pinned[i]).collect();
    let refs: Vec<usize> = if pinned.is_empty() {
        (0..n).collect()
    } else {
        pinned.clone()
    };
    let (mut dx, mut dy) = (0.0f64, 0.0f64);
    for &i in &refs {
        dx += f64::from(net.pos[i * 2] - out[i * 2]);
        dy += f64::from(net.pos[i * 2 + 1] - out[i * 2 + 1]);
    }
    let k = refs.len() as f64;
    let (dx, dy) = ((dx / k) as f32, (dy / k) as f32);
    for p in out.chunks_exact_mut(2) {
        p[0] += dx;
        p[1] += dy;
    }
    for &i in &pinned {
        out[i * 2] = net.pos[i * 2];
        out[i * 2 + 1] = net.pos[i * 2 + 1];
    }
}

/// Pushes apart every pair of bubbles closer than their radii and `gap`, on
/// a grid of cells; pinned bubbles do not move. Stops early when nothing
/// overlaps.
pub(crate) fn separate(pos: &mut [f32], radius: &[f32], pinned: &[bool], gap: f32, passes: u32) {
    let n = radius.len();
    if n < 2 {
        return;
    }
    let cell = 2.0 * radius.iter().fold(0.0f32, |m, &r| m.max(r)) + gap;
    let mut grid: std::collections::HashMap<(i32, i32), Vec<usize>> =
        std::collections::HashMap::new();
    for _ in 0..passes {
        grid.clear();
        for i in 0..n {
            let key = (
                (pos[i * 2] / cell).floor() as i32,
                (pos[i * 2 + 1] / cell).floor() as i32,
            );
            grid.entry(key).or_default().push(i);
        }
        let mut moved = false;
        let mut keys: Vec<(i32, i32)> = grid.keys().copied().collect();
        keys.sort_unstable();
        for (cx, cy) in keys {
            let here = grid[&(cx, cy)].clone();
            for ox in -1..=1 {
                for oy in -1..=1 {
                    let Some(there) = grid.get(&(cx + ox, cy + oy)) else {
                        continue;
                    };
                    for &i in &here {
                        for &j in there {
                            if j <= i {
                                continue;
                            }
                            moved |= push(pos, radius, pinned, gap, i, j);
                        }
                    }
                }
            }
        }
        if !moved {
            break;
        }
    }
}

/// Pushes `i` and `j` apart if they overlap; whether anything moved.
fn push(pos: &mut [f32], radius: &[f32], pinned: &[bool], gap: f32, i: usize, j: usize) -> bool {
    let want = radius[i] + radius[j] + gap;
    let mut dx = pos[j * 2] - pos[i * 2];
    let mut dy = pos[j * 2 + 1] - pos[i * 2 + 1];
    let d2 = dx * dx + dy * dy;
    if d2 >= want * want * 0.9999 || (pinned[i] && pinned[j]) {
        return false;
    }
    let mut d = d2.sqrt();
    if d < 1e-4 {
        // Coincident: a fixed direction from the pair's indices, so it is reproducible.
        let a = (i * 7919 + j * 104_729) as f32;
        dx = a.cos();
        dy = a.sin();
        d = 1.0;
    } else {
        dx /= d;
        dy /= d;
    }
    let shift = want - d;
    let (si, sj) = match (pinned[i], pinned[j]) {
        (true, _) => (0.0, shift),
        (_, true) => (shift, 0.0),
        _ => (shift / 2.0, shift / 2.0),
    };
    pos[i * 2] -= dx * si;
    pos[i * 2 + 1] -= dy * si;
    pos[j * 2] += dx * sj;
    pos[j * 2 + 1] += dy * sj;
    true
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A deterministic generator: xorshift, no dependencies.
    pub fn rng(seed: u32) -> impl FnMut() -> f32 {
        let mut s = seed.max(1);
        move || {
            s ^= s << 13;
            s ^= s >> 17;
            s ^= s << 5;
            s as f32 / u32::MAX as f32
        }
    }

    /// `n` nodes scattered over a square, radii 12–30 as S, M, L bubbles.
    pub fn scattered(n: usize, seed: u32) -> Net {
        let mut r = rng(seed);
        let side = (n as f32).sqrt() * 80.0;
        Net {
            pos: (0..n * 2).map(|_| r() * side).collect(),
            radius: (0..n)
                .map(|_| [12.0, 18.0, 30.0][(r() * 3.0) as usize % 3])
                .collect(),
            pinned: vec![false; n],
            edges: Vec::new(),
            text: Vec::new(),
        }
    }

    pub fn with_edges(mut net: Net, edges: Vec<[u32; 2]>) -> Net {
        net.text = vec![false; edges.len()];
        net.edges = edges;
        net
    }

    /// A layered DAG with some long wires and a few back wires (cycles).
    pub fn dag(n: usize, seed: u32) -> Net {
        let mut r = rng(seed);
        let mut edges = Vec::new();
        for b in 1..n {
            let a = (r() * b as f32) as usize;
            edges.push([a as u32, b as u32]);
            if r() < 0.3 {
                let c = (r() * b as f32) as usize;
                edges.push([c as u32, b as u32]);
            }
        }
        for _ in 0..n / 50 {
            let a = (r() * n as f32) as usize % n;
            let b = (r() * n as f32) as usize % n;
            edges.push([a.max(b) as u32, a.min(b) as u32]);
        }
        with_edges(scattered(n, seed + 1), edges)
    }

    /// A tree with a few cross wires.
    pub fn tree(n: usize, seed: u32) -> Net {
        let mut r = rng(seed);
        let mut edges = Vec::new();
        for b in 1..n {
            // Children of early nodes: a bushy tree, a few levels deep.
            let a = ((r() * r()) * b as f32) as usize;
            edges.push([a as u32, b as u32]);
        }
        with_edges(scattered(n, seed + 1), edges)
    }

    /// A random graph with 1.5 wires per node.
    pub fn mesh(n: usize, seed: u32) -> Net {
        let mut r = rng(seed);
        let edges = (0..n * 3 / 2)
            .map(|_| {
                [
                    ((r() * n as f32) as usize % n) as u32,
                    ((r() * n as f32) as usize % n) as u32,
                ]
            })
            .collect();
        with_edges(scattered(n, seed + 1), edges)
    }

    /// The closest pair of bubbles: the gap between their rims.
    pub fn min_rim_gap(pos: &[f32], radius: &[f32]) -> f32 {
        let n = radius.len();
        let mut best = f32::INFINITY;
        for i in 0..n {
            for j in i + 1..n {
                let d = ((pos[i * 2] - pos[j * 2]).powi(2)
                    + (pos[i * 2 + 1] - pos[j * 2 + 1]).powi(2))
                .sqrt();
                best = best.min(d - radius[i] - radius[j]);
            }
        }
        best
    }

    pub const SP: Spacing = Spacing {
        gap: 24.0,
        layer: 80.0,
    };

    #[test]
    fn text_wires_count_only_for_nodes_without_manual_ones() {
        let mut net = scattered(5, 1);
        net.edges = vec![[0, 1], [0, 1], [1, 2], [0, 2], [3, 4], [2, 3], [4, 4]];
        net.text = vec![false, true, false, true, true, true, false];
        // The text copy of 0→1 repeats it; 0→2 is text between two nodes with
        // manual wires; 3→4 and 2→3 reach nodes without them; a loop is no
        // wire and makes 4 no manual node.
        assert_eq!(used_edges(&net), vec![[0, 1], [1, 2], [3, 4], [2, 3]]);
    }

    #[test]
    fn parts_are_connected_and_largest_first() {
        let p = parts(6, &[[4, 5], [0, 1], [1, 2]]);
        let sizes: Vec<usize> = p.iter().map(|p| p.nodes.len()).collect();
        assert_eq!(sizes, vec![3, 2, 1]);
        assert_eq!(p[0].nodes, vec![0, 1, 2]);
        assert_eq!(p[0].edges, vec![[0, 1], [1, 2]]);
    }

    #[test]
    fn every_layout_keeps_bubbles_apart_and_pinned_nodes_still() {
        for kind in [Kind::Layered, Kind::Radial, Kind::Force] {
            for net in [dag(300, 3), tree(300, 5), mesh(300, 7)] {
                let mut net = net;
                net.pinned[10] = true;
                net.pinned[20] = true;
                let out = layout(&net, kind, SP);
                assert!(out.iter().all(|v| v.is_finite()), "{kind:?}: finite");
                let gap = min_rim_gap(&out, &net.radius);
                assert!(gap > SP.gap * 0.5, "{kind:?}: bubbles {gap} apart");
                for i in [10, 20] {
                    assert_eq!(out[i * 2], net.pos[i * 2], "{kind:?}: pinned x");
                    assert_eq!(out[i * 2 + 1], net.pos[i * 2 + 1], "{kind:?}: pinned y");
                }
            }
        }
    }

    #[test]
    fn the_centre_stays_and_the_result_is_reproducible() {
        for kind in [Kind::Layered, Kind::Radial, Kind::Force] {
            let net = mesh(200, 11);
            let a = layout(&net, kind, SP);
            let b = layout(&net, kind, SP);
            assert_eq!(a, b, "{kind:?}: same input, same layout");
            let centre = |p: &[f32]| {
                let n = p.len() as f32 / 2.0;
                (
                    p.chunks_exact(2).map(|c| c[0]).sum::<f32>() / n,
                    p.chunks_exact(2).map(|c| c[1]).sum::<f32>() / n,
                )
            };
            let (c0, c1) = (centre(&net.pos), centre(&a));
            // The overlap pass may nudge it by a little.
            assert!(
                (c0.0 - c1.0).abs() < 30.0 && (c0.1 - c1.1).abs() < 30.0,
                "{kind:?}: centre"
            );
        }
    }

    #[test]
    fn empty_and_single_nets() {
        let empty = Net::default();
        assert!(layout(&empty, Kind::Layered, SP).is_empty());
        let one = scattered(1, 2);
        for kind in [Kind::Layered, Kind::Radial, Kind::Force] {
            assert_eq!(layout(&one, kind, SP), one.pos, "{kind:?}");
        }
    }
}
