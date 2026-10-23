//! WASM bindings of `strata-layout` for the UI (15 §2.6): the star map's force
//! layout runs in a worker (08 §3.1), and so does `L` on a network (06 §9.2).
//! Arrays cross the boundary as typed arrays; positions can be read without a
//! copy through `positions_ptr` and the module's memory.

use strata_layout::{Force3d, Kind, Net, Params, Spacing, Springs};
use wasm_bindgen::prelude::*;

/// The force layout of 08 §3.2 over `n` bodies.
#[wasm_bindgen]
#[derive(Debug)]
pub struct Physics3d {
    inner: Force3d,
}

#[wasm_bindgen]
impl Physics3d {
    /// `pos`: 3 floats per body; springs as parallel arrays; the model's settings.
    #[wasm_bindgen(constructor)]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        pos: Vec<f32>,
        mass: Vec<f32>,
        spring_a: Vec<u32>,
        spring_b: Vec<u32>,
        spring_length: Vec<f32>,
        spring_k: Vec<f32>,
        repulsion: f32,
        theta: f32,
        centre: f32,
        decay: f32,
        max_step: f32,
    ) -> Physics3d {
        let springs = Springs {
            a: spring_a,
            b: spring_b,
            length: spring_length,
            k: spring_k,
        };
        let params = Params {
            repulsion,
            theta,
            centre,
            decay,
            max_step,
        };
        Physics3d {
            inner: Force3d::new(pos, mass, springs, params),
        }
    }

    /// Number of bodies.
    pub fn len(&self) -> usize {
        self.inner.len()
    }

    /// Whether there are no bodies.
    #[wasm_bindgen(js_name = isEmpty)]
    pub fn is_empty(&self) -> bool {
        self.inner.is_empty()
    }

    /// One tick at cooling `alpha`.
    pub fn tick(&mut self, alpha: f32) {
        self.inner.tick(alpha);
    }

    /// A full layout: `ticks` ticks while alpha cools from 1 to `alpha_min`.
    pub fn run(&mut self, ticks: u32, alpha_min: f32) {
        self.inner.run(ticks, alpha_min);
    }

    /// A copy of the positions.
    pub fn positions(&self) -> Vec<f32> {
        self.inner.positions().to_vec()
    }

    /// Address of the positions in the module's memory: a view without a copy,
    /// valid until the next call that may grow the memory.
    #[wasm_bindgen(js_name = positionsPtr)]
    pub fn positions_ptr(&self) -> *const f32 {
        self.inner.positions().as_ptr()
    }

    /// Moves body `i` (a pinned body, a drag in 3D).
    #[wasm_bindgen(js_name = setPosition)]
    pub fn set_position(&mut self, i: usize, x: f32, y: f32, z: f32) {
        let p = self.inner.positions_mut();
        p[i * 3] = x;
        p[i * 3 + 1] = y;
        p[i * 3 + 2] = z;
    }
}

/// `L` on a network (06 §9.2): `kind` 0 layered, 1 radial, 2 force; positions
/// `[x, y]` per node; wires as parallel arrays, `text` 1 for a wire only from
/// text (☑ Q-13-3). Returns `[x, y]` per node; the caller checks the arrays.
#[wasm_bindgen(js_name = layoutNet)]
#[allow(clippy::too_many_arguments)]
pub fn layout_net(
    kind: u8,
    pos: Vec<f32>,
    radius: Vec<f32>,
    pinned: Vec<u8>,
    from: Vec<u32>,
    to: Vec<u32>,
    text: Vec<u8>,
    gap: f32,
    layer: f32,
) -> Vec<f32> {
    let net = Net {
        pos,
        radius,
        pinned: pinned.iter().map(|&p| p != 0).collect(),
        edges: from.iter().zip(&to).map(|(&a, &b)| [a, b]).collect(),
        text: text.iter().map(|&t| t != 0).collect(),
    };
    let kind = match kind {
        0 => Kind::Layered,
        1 => Kind::Radial,
        _ => Kind::Force,
    };
    strata_layout::layout(&net, kind, Spacing { gap, layer })
}
