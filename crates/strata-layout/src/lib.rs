//! Layouts of Strata, pure and without IO: the same code runs natively in the
//! core and as WASM in a worker of the UI (15 §2.6, ☑ Q-06-9).
//!
//! - [`force3d`]: the star map's force layout (08 §3.2): Barnes–Hut repulsion,
//!   springs, centring, damping. Spike 2 chose it over d3-force-3d and ngraph
//!   (`docs/spikes/S2-starmap.md`, ADR-0005).
//! - [`net`]: `L` on a network (06 §9.2, spike 10): layered, radial and force
//!   layouts in 2D, with pinned nodes and no overlapping bubbles.

mod force2d;
pub mod force3d;
mod layered;
pub mod net;
mod radial;

pub use force3d::{Force3d, Params, Springs};
pub use net::{Kind, Net, Spacing, layout};
