//! Layouts of Strata, pure and without IO: the same code runs natively in the
//! core and as WASM in a worker of the UI (15 §2.6, ☑ Q-06-9).
//!
//! - [`force3d`]: the star map's force layout (08 §3.2): Barnes–Hut repulsion,
//!   springs, centring, damping. Spike 2 chose it over d3-force-3d and ngraph
//!   (`docs/spikes/S2-starmap.md`, ADR-0005).

pub mod force3d;

pub use force3d::{Force3d, Params, Springs};
