//! From the centre: a radial tree (06 §9.2).
//!
//! - Roots are the nodes without inputs in the part; a part that is all
//!   cycles takes the node with the most outputs. Several roots sit on the
//!   first ring around an empty centre.
//! - The tree is a breadth-first walk from the roots over wires both ways;
//!   wires outside it are drawn as they are.
//! - Rings: each ring is the tallest bubble of both and the layer gap further
//!   out than the last.
//! - Angles: a node needs the angle its bubble and the gap take on its ring;
//!   a subtree needs the larger of its root's need and its children's sum.
//!   If the whole tree needs more than a turn, every ring grows until it fits;
//!   the spare angle goes to subtrees by their size (06 §9.2: «сектор
//!   пропорционален размеру поддерева»). Subtrees get disjoint wedges, so no
//!   two bubbles on a ring overlap.

use crate::net::{Net, Part, Spacing};
use std::f32::consts::{FRAC_PI_2, TAU};

pub(crate) fn layout(net: &Net, part: &Part, sp: Spacing) -> Vec<[f32; 2]> {
    let m = part.nodes.len();
    if m == 1 {
        return vec![[0.0, 0.0]];
    }
    let radius = |k: usize| net.radius[part.nodes[k]];
    let x = |k: usize| net.pos[part.nodes[k] * 2];

    let mut indeg = vec![0usize; m];
    let mut outdeg = vec![0usize; m];
    let mut adj: Vec<Vec<usize>> = vec![Vec::new(); m];
    for &[a, b] in &part.edges {
        indeg[b] += 1;
        outdeg[a] += 1;
        adj[a].push(b);
        adj[b].push(a);
    }
    for list in &mut adj {
        list.sort_by(|&a, &b| x(a).total_cmp(&x(b)).then(a.cmp(&b)));
    }
    let mut roots: Vec<usize> = (0..m).filter(|&k| indeg[k] == 0).collect();
    if roots.is_empty() {
        let top = (0..m)
            .max_by(|&a, &b| outdeg[a].cmp(&outdeg[b]).then(b.cmp(&a)))
            .unwrap_or(0);
        roots.push(top);
    }
    roots.sort_by(|&a, &b| x(a).total_cmp(&x(b)).then(a.cmp(&b)));

    // The tree: node m is the empty centre when there are several roots.
    let centre = if roots.len() > 1 { m } else { roots[0] };
    let total = m + usize::from(roots.len() > 1);
    let mut children: Vec<Vec<usize>> = vec![Vec::new(); total];
    let mut depth = vec![usize::MAX; total];
    let mut queue = std::collections::VecDeque::new();
    depth[centre] = 0;
    if centre == m {
        for &r in &roots {
            depth[r] = 1;
            children[m].push(r);
            queue.push_back(r);
        }
    } else {
        queue.push_back(centre);
    }
    let mut walk = vec![centre];
    while let Some(v) = queue.pop_front() {
        if v != centre {
            walk.push(v);
        }
        for &w in &adj[v] {
            if depth[w] == usize::MAX {
                depth[w] = depth[v] + 1;
                children[v].push(w);
                queue.push_back(w);
            }
        }
    }

    // Rings.
    let rings = depth.iter().copied().max().unwrap_or(0) + 1;
    let mut tallest = vec![0.0f32; rings];
    for k in 0..m {
        tallest[depth[k]] = tallest[depth[k]].max(radius(k));
    }
    let mut ring = vec![0.0f32; rings];
    for d in 1..rings {
        ring[d] = ring[d - 1] + tallest[d - 1] + tallest[d] + sp.layer;
    }

    // Angles needed, bottom-up (the walk is breadth-first: reverse it).
    let own = |k: usize, ring: &[f32]| {
        if k == centre {
            0.0
        } else {
            (2.0 * radius(k) + sp.gap) / ring[depth[k]]
        }
    };
    let mut size = vec![1usize; total];
    let mut need = vec![0.0f32; total];
    for &v in walk.iter().rev() {
        let sum: f32 = children[v].iter().map(|&c| need[c]).sum();
        size[v] += children[v].iter().map(|&c| size[c]).sum::<usize>();
        need[v] = own(v, &ring).max(sum);
    }
    let whole = need[centre];
    if whole > TAU {
        // Every ring further out by the same factor: every need shrinks by it.
        let grow = whole / TAU * 1.0001;
        for r in &mut ring {
            *r *= grow;
        }
        for n in &mut need {
            *n /= grow;
        }
    }

    // Wedges, top-down: each child gets its need and a share of the spare.
    let mut start = vec![0.0f32; total];
    let mut span = vec![0.0f32; total];
    start[centre] = -FRAC_PI_2;
    span[centre] = TAU;
    for &v in &walk {
        let kids = &children[v];
        if kids.is_empty() {
            continue;
        }
        let sum_need: f32 = kids.iter().map(|&c| need[c]).sum();
        let sum_size: usize = kids.iter().map(|&c| size[c]).sum();
        let spare = (span[v] - sum_need).max(0.0);
        let mut a = start[v];
        for &c in kids {
            let s = need[c] + spare * size[c] as f32 / sum_size as f32;
            start[c] = a;
            span[c] = s;
            a += s;
        }
    }
    (0..m)
        .map(|k| {
            if k == centre {
                return [0.0, 0.0];
            }
            let a = start[k] + span[k] / 2.0;
            let r = ring[depth[k]];
            [r * a.cos(), r * a.sin()]
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use crate::net::tests::{SP, min_rim_gap, tree};
    use crate::net::{Kind, layout};

    #[test]
    fn a_tree_fans_out_from_its_root_without_overlaps() {
        let net = tree(500, 21);
        let out = layout(&net, Kind::Radial, SP);
        // Node 0 is the only root: its children are on the first ring around it.
        let d =
            |i: usize| ((out[i * 2] - out[0]).powi(2) + (out[i * 2 + 1] - out[1]).powi(2)).sqrt();
        let child = net
            .edges
            .iter()
            .find(|e| e[0] == 0)
            .map(|e| e[1] as usize)
            .unwrap();
        let grandchild = net
            .edges
            .iter()
            .find(|e| e[0] as usize == child)
            .map(|e| e[1] as usize);
        if let Some(g) = grandchild {
            assert!(
                d(g) > d(child),
                "a grandchild is further out than its parent"
            );
        }
        assert!(min_rim_gap(&out, &net.radius) >= SP.gap * 0.99);
    }
}
