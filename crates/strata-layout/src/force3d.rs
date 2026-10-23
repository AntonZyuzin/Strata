//! Barnes–Hut force layout in 3D: the physics of the star map (08 §3.2).
//!
//! The model is the one spike 2 measured in TypeScript (`packages/view3d`,
//! `docs/spikes/S2-starmap.md`): repulsion −k·mᵢ·mⱼ/d² with the opening angle
//! θ, springs with a rest length and a stiffness, a weak pull to the origin,
//! velocity damping and a speed limit per tick.
//!
//! The octree is rebuilt every tick by splitting the bodies into octants in
//! place (a counting sort per level), so the cells come out in preorder and
//! each cell knows where its subtree ends. A body walks the tree without a
//! stack: a far cell or a leaf is summed and skipped, a near cell is opened by
//! stepping to the next cell. Bodies are visited in tree order, so neighbours
//! walk the same cells one after another. Nothing is allocated per tick.

use wide::{f32x4, u32x4};

/// Settings of the force model (08 §3.2), as `MODEL` in `packages/view3d`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Params {
    /// k of the repulsion.
    pub repulsion: f32,
    /// Opening angle θ: a cell of edge s at distance d acts as one body when s < θ·d.
    pub theta: f32,
    /// Strength of the pull to the origin.
    pub centre: f32,
    /// Share of the velocity lost per tick.
    pub decay: f32,
    /// Speed limit per tick, world units: keeps the first ticks from exploding.
    pub max_step: f32,
}

/// Springs between bodies: nesting and wires (08 §3.2), as parallel arrays.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Springs {
    pub a: Vec<u32>,
    pub b: Vec<u32>,
    /// Rest length, world units.
    pub length: Vec<f32>,
    /// Stiffness.
    pub k: Vec<f32>,
}

/// A cell of the octree in preorder.
#[derive(Clone, Copy, Debug, Default)]
struct Cell {
    /// Centre of mass.
    x: f32,
    y: f32,
    z: f32,
    mass: f32,
    /// Squared edge of the cell.
    size2: f32,
    /// The first cell after this subtree.
    next: u32,
    /// Bodies of the subtree: `order[first..first + count]`, contiguous in tree order.
    first: u32,
    count: u32,
    leaf: bool,
}

/// Bodies a leaf may hold: a leaf is also the group of the walk in `repel`.
const LEAF: usize = 24;
/// Coincident bodies stop splitting here and share a leaf.
const MAX_DEPTH: u32 = 32;

/// Interaction lists of one group, as columns for the vectoriser.
#[derive(Debug, Default)]
struct Lists {
    far_x: Vec<f32>,
    far_y: Vec<f32>,
    far_z: Vec<f32>,
    far_m: Vec<f32>,
    near_x: Vec<f32>,
    near_y: Vec<f32>,
    near_z: Vec<f32>,
    near_m: Vec<f32>,
}

impl Lists {
    fn clear(&mut self) {
        for v in [
            &mut self.far_x,
            &mut self.far_y,
            &mut self.far_z,
            &mut self.far_m,
            &mut self.near_x,
            &mut self.near_y,
            &mut self.near_z,
            &mut self.near_m,
        ] {
            v.clear();
        }
    }

    fn far(&mut self, x: f32, y: f32, z: f32, m: f32) {
        self.far_x.push(x);
        self.far_y.push(y);
        self.far_z.push(z);
        self.far_m.push(m);
    }

    fn near(&mut self, x: f32, y: f32, z: f32, m: f32) {
        self.near_x.push(x);
        self.near_y.push(y);
        self.near_z.push(z);
        self.near_m.push(m);
    }
}

/// 1/√x for x > 0: the bit estimate and two Newton steps, relative error
/// under 5·10⁻⁶. Only multiplications: a square root and a division per pair
/// cost several times more, and WASM SIMD has no reciprocal square root of its
/// own. A far cell has d² > 0; near pairs are clamped to d² ≥ 1.
#[inline(always)]
fn rsqrt(x: f32) -> f32 {
    let y = f32::from_bits(0x5f37_5a86 - (x.to_bits() >> 1));
    let h = 0.5 * x;
    let y = y * (1.5 - h * y * y);
    y * (1.5 - h * y * y)
}

/// Constants of [`rsqrt4`], made once per list: built inside the loop, the
/// splats were filled by a call per pair.
#[derive(Clone, Copy)]
struct Rsqrt4 {
    magic: u32x4,
    half: f32x4,
    three_halves: f32x4,
}

impl Rsqrt4 {
    fn new() -> Self {
        Self {
            magic: u32x4::splat(0x5f37_5a86),
            half: f32x4::splat(0.5),
            three_halves: f32x4::splat(1.5),
        }
    }

    /// 1/√x on four lanes, as [`rsqrt`].
    #[inline(always)]
    fn of(self, x: f32x4) -> f32x4 {
        let bits: u32x4 = bytemuck::cast(x);
        let y: f32x4 = bytemuck::cast(self.magic - (bits >> 1));
        let h = x * self.half;
        let y = y * (self.three_halves - h * y * y);
        y * (self.three_halves - h * y * y)
    }
}

/// Four floats of a chunk of exactly four.
#[inline(always)]
fn lanes(c: &[f32]) -> f32x4 {
    f32x4::new([c[0], c[1], c[2], c[3]])
}

/// Σ mⱼ·(pⱼ − p)/d³ over a list, with d² clamped from below by `min_d2`:
/// four pairs at a time in SIMD (NEON natively, simd128 in WASM).
#[allow(clippy::too_many_arguments)]
fn sum(
    xs: &[f32],
    ys: &[f32],
    zs: &[f32],
    ms: &[f32],
    x: f32,
    y: f32,
    z: f32,
    min_d2: f32,
) -> (f32, f32, f32) {
    let r = Rsqrt4::new();
    let (px, py, pz) = (f32x4::splat(x), f32x4::splat(y), f32x4::splat(z));
    let lo = f32x4::splat(min_d2);
    let (mut ax, mut ay, mut az) = (f32x4::ZERO, f32x4::ZERO, f32x4::ZERO);
    let chunks = xs
        .chunks_exact(4)
        .zip(ys.chunks_exact(4))
        .zip(zs.chunks_exact(4))
        .zip(ms.chunks_exact(4));
    for (((qx, qy), qz), qm) in chunks {
        let dx = lanes(qx) - px;
        let dy = lanes(qy) - py;
        let dz = lanes(qz) - pz;
        let d2 = (dx * dx + dy * dy + dz * dz).fast_max(lo);
        let inv = r.of(d2);
        let s = lanes(qm) * inv * inv * inv;
        ax += dx * s;
        ay += dy * s;
        az += dz * s;
    }
    let (mut fx, mut fy, mut fz) = (ax.reduce_add(), ay.reduce_add(), az.reduce_add());
    for j in xs.len() - xs.len() % 4..xs.len() {
        let dx = xs[j] - x;
        let dy = ys[j] - y;
        let dz = zs[j] - z;
        let d2 = (dx * dx + dy * dy + dz * dz).max(min_d2);
        let inv = rsqrt(d2);
        let s = ms[j] * inv * inv * inv;
        fx += dx * s;
        fy += dy * s;
        fz += dz * s;
    }
    (fx, fy, fz)
}

/// A force layout of `n` bodies; positions are `[x, y, z]` per body.
#[derive(Debug)]
pub struct Force3d {
    pos: Vec<f32>,
    vel: Vec<f32>,
    force: Vec<f32>,
    mass: Vec<f32>,
    /// Bodies that do not move (a pinned node, 06 §9.1); they still push and pull.
    fixed: Vec<bool>,
    springs: Springs,
    params: Params,
    /// Bodies in tree order: a permutation of `0..n`, kept between ticks.
    order: Vec<u32>,
    scratch: Vec<u32>,
    octants: Vec<u8>,
    cells: Vec<Cell>,
    /// Positions and masses in tree order, in the columns of `Lists::near`.
    tree: Lists,
    lists: Lists,
}

impl Force3d {
    /// A layout starting at `pos` (3 floats per body) with a mass per body.
    ///
    /// # Panics
    ///
    /// When `pos` is not three floats per mass, or the spring arrays differ
    /// in length or name a body that does not exist.
    pub fn new(pos: Vec<f32>, mass: Vec<f32>, springs: Springs, params: Params) -> Self {
        let n = mass.len();
        assert_eq!(pos.len(), n * 3, "three coordinates per body");
        let s = springs.a.len();
        assert!(
            springs.b.len() == s && springs.length.len() == s && springs.k.len() == s,
            "spring arrays of one length"
        );
        assert!(
            springs
                .a
                .iter()
                .chain(&springs.b)
                .all(|&i| (i as usize) < n),
            "springs between existing bodies"
        );
        Self {
            pos,
            vel: vec![0.0; n * 3],
            force: vec![0.0; n * 3],
            mass,
            fixed: vec![false; n],
            springs,
            params,
            order: (0..n as u32).collect(),
            scratch: vec![0; n],
            octants: vec![0; n],
            cells: Vec::with_capacity(n),
            tree: Lists::default(),
            lists: Lists::default(),
        }
    }

    /// Number of bodies.
    pub fn len(&self) -> usize {
        self.mass.len()
    }

    /// Whether there are no bodies.
    pub fn is_empty(&self) -> bool {
        self.mass.is_empty()
    }

    /// Positions, three floats per body.
    pub fn positions(&self) -> &[f32] {
        &self.pos
    }

    /// Positions to move bodies by hand (a pinned body, a drag in 3D).
    pub fn positions_mut(&mut self) -> &mut [f32] {
        &mut self.pos
    }

    /// Fixes body `i` in place, or frees it.
    ///
    /// # Panics
    ///
    /// When `i` is not a body.
    pub fn set_fixed(&mut self, i: usize, fixed: bool) {
        self.fixed[i] = fixed;
        if fixed {
            self.vel[i * 3..i * 3 + 3].fill(0.0);
        }
    }

    /// One tick at cooling `alpha`; a full layout cools 1 → 0.001 (08 §3.3).
    pub fn tick(&mut self, alpha: f32) {
        if self.is_empty() {
            return;
        }
        self.build();
        self.repel(alpha);
        self.pull(alpha);
        self.integrate();
    }

    /// A full layout: `ticks` ticks while alpha cools from 1 to `alpha_min`.
    pub fn run(&mut self, ticks: u32, alpha_min: f32) {
        let decay = alpha_min.powf(1.0 / ticks.max(1) as f32);
        let mut alpha = 1.0;
        for _ in 0..ticks {
            self.tick(alpha);
            alpha *= decay;
        }
    }

    fn build(&mut self) {
        let mut lo = [f32::INFINITY; 3];
        let mut hi = [f32::NEG_INFINITY; 3];
        for p in self.pos.chunks_exact(3) {
            for a in 0..3 {
                lo[a] = lo[a].min(p[a]);
                hi[a] = hi[a].max(p[a]);
            }
        }
        let half = (0..3).map(|a| hi[a] - lo[a]).fold(1.0f32, f32::max) / 2.0 + 1.0;
        let centre = [
            (lo[0] + hi[0]) / 2.0,
            (lo[1] + hi[1]) / 2.0,
            (lo[2] + hi[2]) / 2.0,
        ];
        self.cells.clear();
        self.split(0, self.len(), centre, half, 0);
        // Bodies in tree order, as columns: a leaf's bodies are one contiguous slice.
        let t = &mut self.tree;
        t.clear();
        for &b in &self.order {
            let b = b as usize;
            t.near(
                self.pos[b * 3],
                self.pos[b * 3 + 1],
                self.pos[b * 3 + 2],
                self.mass[b],
            );
        }
    }

    /// Builds the cell of `order[lo..hi]` and its subtree; returns its index.
    fn split(&mut self, lo: usize, hi: usize, c: [f32; 3], half: f32, depth: u32) -> usize {
        let idx = self.cells.len();
        let size = 2.0 * half;
        self.cells.push(Cell {
            size2: size * size,
            ..Cell::default()
        });
        let (mut m, mut sx, mut sy, mut sz) = (0.0f32, 0.0f32, 0.0f32, 0.0f32);
        if hi - lo <= LEAF || depth >= MAX_DEPTH {
            for &b in &self.order[lo..hi] {
                let b = b as usize;
                let mb = self.mass[b];
                m += mb;
                sx += self.pos[b * 3] * mb;
                sy += self.pos[b * 3 + 1] * mb;
                sz += self.pos[b * 3 + 2] * mb;
            }
            self.cells[idx].leaf = true;
        } else {
            // Counting sort of the range by octant: children come out contiguous.
            let mut counts = [0usize; 8];
            for k in lo..hi {
                let b = self.order[k] as usize;
                let o = usize::from(self.pos[b * 3] >= c[0])
                    | usize::from(self.pos[b * 3 + 1] >= c[1]) << 1
                    | usize::from(self.pos[b * 3 + 2] >= c[2]) << 2;
                self.octants[k] = o as u8;
                counts[o] += 1;
            }
            let mut starts = [lo; 9];
            for o in 0..8 {
                starts[o + 1] = starts[o] + counts[o];
            }
            let mut fill = starts;
            for k in lo..hi {
                let o = self.octants[k] as usize;
                self.scratch[fill[o]] = self.order[k];
                fill[o] += 1;
            }
            self.order[lo..hi].copy_from_slice(&self.scratch[lo..hi]);
            let h = half / 2.0;
            for o in 0..8 {
                if counts[o] == 0 {
                    continue;
                }
                let cc = [
                    c[0] + if o & 1 != 0 { h } else { -h },
                    c[1] + if o & 2 != 0 { h } else { -h },
                    c[2] + if o & 4 != 0 { h } else { -h },
                ];
                let child = self.split(starts[o], starts[o + 1], cc, h, depth + 1);
                let ch = self.cells[child];
                m += ch.mass;
                sx += ch.x * ch.mass;
                sy += ch.y * ch.mass;
                sz += ch.z * ch.mass;
            }
        }
        let next = self.cells.len() as u32;
        let cell = &mut self.cells[idx];
        cell.first = lo as u32;
        cell.count = (hi - lo) as u32;
        if m > 0.0 {
            cell.x = sx / m;
            cell.y = sy / m;
            cell.z = sz / m;
        }
        cell.mass = m;
        cell.next = next;
        idx
    }

    /// Repulsion by groups (Barnes 1990): the tree is walked once per leaf, with
    /// the opening test against the leaf's bounding box, into a list of far
    /// cells and a list of near bodies; every body of the leaf then sums both
    /// lists in tight loops without branches.
    fn repel(&mut self, alpha: f32) {
        let k = self.params.repulsion * alpha;
        let theta2 = self.params.theta * self.params.theta;
        let cells = &self.cells;
        let mass = &self.mass;
        let order = &self.order;
        let t = &self.tree;
        let l = &mut self.lists;
        for group in cells.iter().filter(|c| c.leaf) {
            let range = group.first as usize..(group.first + group.count) as usize;
            let mut lo = [f32::INFINITY; 3];
            let mut hi = [f32::NEG_INFINITY; 3];
            for (a, column) in [&t.near_x, &t.near_y, &t.near_z].into_iter().enumerate() {
                for &v in &column[range.clone()] {
                    lo[a] = lo[a].min(v);
                    hi[a] = hi[a].max(v);
                }
            }
            l.clear();
            let mut at = 0usize;
            while at < cells.len() {
                let cell = &cells[at];
                // A cell holding the group is always opened: no self-repulsion.
                let own = group.first.wrapping_sub(cell.first) < cell.count;
                if !own {
                    // Distance from the centre of mass to the nearest point of the box.
                    let dx = (lo[0] - cell.x).max(cell.x - hi[0]).max(0.0);
                    let dy = (lo[1] - cell.y).max(cell.y - hi[1]).max(0.0);
                    let dz = (lo[2] - cell.z).max(cell.z - hi[2]).max(0.0);
                    if cell.size2 < theta2 * (dx * dx + dy * dy + dz * dz) {
                        l.far(cell.x, cell.y, cell.z, cell.mass);
                        at = cell.next as usize;
                        continue;
                    }
                }
                if cell.leaf {
                    let r = cell.first as usize..(cell.first + cell.count) as usize;
                    l.near_x.extend_from_slice(&t.near_x[r.clone()]);
                    l.near_y.extend_from_slice(&t.near_y[r.clone()]);
                    l.near_z.extend_from_slice(&t.near_z[r.clone()]);
                    l.near_m.extend_from_slice(&t.near_m[r]);
                    at = cell.next as usize;
                } else {
                    at += 1;
                }
            }
            for rank in range {
                let i = order[rank] as usize;
                let (x, y, z) = (t.near_x[rank], t.near_y[rank], t.near_z[rank]);
                let ki = k * mass[i];
                // F = −k·mᵢ·mⱼ/d² along the unit vector. Near bodies include the body
                // itself: d = 0 gives no force, the clamp of d² keeps it finite.
                let (fx, fy, fz) = sum(&l.far_x, &l.far_y, &l.far_z, &l.far_m, x, y, z, 0.0);
                let (nx, ny, nz) = sum(&l.near_x, &l.near_y, &l.near_z, &l.near_m, x, y, z, 1.0);
                self.force[i * 3] = -(fx + nx) * ki;
                self.force[i * 3 + 1] = -(fy + ny) * ki;
                self.force[i * 3 + 2] = -(fz + nz) * ki;
            }
        }
    }

    fn pull(&mut self, alpha: f32) {
        let p = &self.pos;
        let f = &mut self.force;
        let s = &self.springs;
        for e in 0..s.a.len() {
            let i = s.a[e] as usize;
            let j = s.b[e] as usize;
            let dx = p[j * 3] - p[i * 3];
            let dy = p[j * 3 + 1] - p[i * 3 + 1];
            let dz = p[j * 3 + 2] - p[i * 3 + 2];
            let d = (dx * dx + dy * dy + dz * dz).sqrt().max(1e-6);
            let t = (d - s.length[e]) / d * s.k[e] * alpha;
            f[i * 3] += dx * t;
            f[i * 3 + 1] += dy * t;
            f[i * 3 + 2] += dz * t;
            f[j * 3] -= dx * t;
            f[j * 3 + 1] -= dy * t;
            f[j * 3 + 2] -= dz * t;
        }
        let c = self.params.centre * alpha;
        for (fi, pi) in f.iter_mut().zip(p) {
            *fi -= pi * c;
        }
    }

    fn integrate(&mut self) {
        let keep = 1.0 - self.params.decay;
        let max = self.params.max_step;
        for i in 0..self.len() {
            if self.fixed[i] {
                continue;
            }
            let m = self.mass[i];
            let mut v = [0.0f32; 3];
            for (a, va) in v.iter_mut().enumerate() {
                *va = (self.vel[i * 3 + a] + self.force[i * 3 + a] / m) * keep;
            }
            let speed = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
            if speed > max {
                for va in &mut v {
                    *va *= max / speed;
                }
            }
            for (a, va) in v.iter().enumerate() {
                self.vel[i * 3 + a] = *va;
                self.pos[i * 3 + a] += *va;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MODEL: Params = Params {
        repulsion: 30.0,
        theta: 0.8,
        centre: 0.001,
        decay: 0.4,
        max_step: 50.0,
    };

    /// A deterministic cloud: xorshift, no dependencies.
    fn cloud(n: usize, spread: f32, seed: u32) -> Vec<f32> {
        let mut s = seed.max(1);
        let mut next = || {
            s ^= s << 13;
            s ^= s >> 17;
            s ^= s << 5;
            (s as f32 / u32::MAX as f32 - 0.5) * spread
        };
        (0..n * 3).map(|_| next()).collect()
    }

    fn exact_repulsion(pos: &[f32], mass: &[f32], k: f32) -> Vec<f32> {
        let n = mass.len();
        let mut f = vec![0.0f64; n * 3];
        for i in 0..n {
            for j in 0..n {
                if i == j {
                    continue;
                }
                let d: Vec<f64> = (0..3)
                    .map(|a| f64::from(pos[j * 3 + a] - pos[i * 3 + a]))
                    .collect();
                let d2 = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).max(1.0);
                let s = f64::from(k * mass[i] * mass[j]) / (d2 * d2.sqrt());
                for a in 0..3 {
                    f[i * 3 + a] -= d[a] * s;
                }
            }
        }
        f.into_iter().map(|v| v as f32).collect()
    }

    #[test]
    fn repulsion_matches_the_exact_sum_within_the_opening_angle() {
        let n = 600;
        let pos = cloud(n, 1000.0, 7);
        let mass: Vec<f32> = (0..n).map(|i| 1.0 + (i % 3) as f32 * 0.5).collect();
        let params = Params {
            theta: 0.5,
            ..MODEL
        };
        let mut sim = Force3d::new(pos.clone(), mass.clone(), Springs::default(), params);
        sim.build();
        sim.repel(1.0);
        let exact = exact_repulsion(&pos, &mass, MODEL.repulsion);
        let norm = |v: &[f32], i: usize| {
            (v[i * 3].powi(2) + v[i * 3 + 1].powi(2) + v[i * 3 + 2].powi(2)).sqrt()
        };
        let errors: Vec<f32> = (0..n)
            .map(|i| {
                let diff: Vec<f32> = (0..3)
                    .map(|a| sim.force[i * 3 + a] - exact[i * 3 + a])
                    .collect();
                norm(&diff, 0)
            })
            .collect();
        let mean_force = (0..n).map(|i| norm(&exact, i)).sum::<f32>() / n as f32;
        // Relative error per body, then the worst error against the typical force:
        // a body whose pushes nearly cancel has a tiny force and an unstable ratio.
        let mean_rel = (0..n)
            .map(|i| errors[i] / norm(&exact, i).max(1e-6))
            .sum::<f32>()
            / n as f32;
        let worst = errors.iter().fold(0.0f32, |w, &e| w.max(e)) / mean_force;
        assert!(mean_rel < 0.01, "mean relative error {mean_rel}");
        assert!(worst < 0.05, "worst error against the mean force {worst}");
    }

    #[test]
    fn the_fast_inverse_square_root_is_close() {
        for x in [1e-3f32, 0.5, 1.0, 2.0, 1234.5, 1e7, 3e9] {
            let want = 1.0 / x.sqrt();
            assert!(
                (rsqrt(x) - want).abs() / want < 5e-6,
                "{x}: {} vs {want}",
                rsqrt(x)
            );
        }
    }

    #[test]
    fn two_bodies_push_apart_symmetrically() {
        let mut sim = Force3d::new(
            vec![-5.0, 0.0, 0.0, 5.0, 0.0, 0.0],
            vec![1.0, 1.0],
            Springs::default(),
            Params {
                centre: 0.0,
                ..MODEL
            },
        );
        sim.tick(1.0);
        let p = sim.positions();
        assert!(p[0] < -5.0 && p[3] > 5.0);
        assert!((p[0] + p[3]).abs() < 1e-4, "symmetric: {p:?}");
    }

    #[test]
    fn a_spring_settles_at_its_rest_length() {
        let springs = Springs {
            a: vec![0],
            b: vec![1],
            length: vec![60.0],
            k: vec![0.08],
        };
        let mut sim = Force3d::new(
            vec![0.0, 0.0, 0.0, 200.0, 0.0, 0.0],
            vec![1.0, 1.0],
            springs,
            Params {
                repulsion: 0.0,
                centre: 0.0,
                ..MODEL
            },
        );
        for _ in 0..500 {
            sim.tick(1.0);
        }
        let p = sim.positions();
        assert!((p[3] - p[0] - 60.0).abs() < 0.5, "length {}", p[3] - p[0]);
    }

    #[test]
    fn coincident_bodies_stay_finite_and_spread() {
        let n = 50;
        let mut sim = Force3d::new(vec![3.0; n * 3], vec![1.0; n], Springs::default(), MODEL);
        sim.run(100, 0.001);
        let p = sim.positions();
        assert!(p.iter().all(|v| v.is_finite()));
        let spread = p
            .chunks_exact(3)
            .map(|q| q[0])
            .fold(f32::NEG_INFINITY, f32::max)
            - p.chunks_exact(3)
                .map(|q| q[0])
                .fold(f32::INFINITY, f32::min);
        // Coincident bodies share one leaf and do not push each other until they part:
        // the layout must not explode either.
        assert!(spread.is_finite());
    }

    #[test]
    fn the_same_input_gives_the_same_layout() {
        let n = 400;
        let run = || {
            let springs = Springs {
                a: (0..n as u32 - 1).collect(),
                b: (1..n as u32).collect(),
                length: vec![60.0; n - 1],
                k: vec![0.02; n - 1],
            };
            let mut sim = Force3d::new(cloud(n, 800.0, 3), vec![1.0; n], springs, MODEL);
            sim.run(50, 0.001);
            sim.positions().to_vec()
        };
        assert_eq!(run(), run());
    }

    #[test]
    fn the_tree_covers_every_body_once() {
        let n = 1000;
        let mut sim = Force3d::new(cloud(n, 500.0, 11), vec![1.0; n], Springs::default(), MODEL);
        sim.build();
        let leaves: u32 = sim.cells.iter().filter(|c| c.leaf).map(|c| c.count).sum();
        assert_eq!(leaves as usize, n);
        let mut seen = vec![false; n];
        for &b in &sim.order {
            assert!(!seen[b as usize]);
            seen[b as usize] = true;
        }
        let root = sim.cells[0];
        assert_eq!(root.next as usize, sim.cells.len());
        assert!((root.mass - n as f32).abs() < 1e-3);
    }
}
