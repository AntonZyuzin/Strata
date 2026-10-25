//! Name search (09 §2): one engine for the Tab menu, `Ctrl+O`, `Ctrl+F`,
//! the «Ноды» filter and the star map's search in a worker of the UI (WASM,
//! `strata-search-wasm`), and natively for MCP `search_nodes` later (12).
//! Names only, never content (✅ G1); no IO.
//!
//! - [`norm`] — the one normalization of names, aliases, queries (§2.2);
//! - [`stage`], [`score`] — the stages of matching, both keyboard layouts (§2.3–2.4);
//! - [`Index`] — the names of a workspace, ranked with the signals of §2.5;
//! - [`Find`] — Houdini Find's syntax of `Ctrl+F` (§3.3).

mod find;
mod index;
mod norm;
mod stage;

pub use find::Find;
pub use index::{Context, Index, Item, Scope, Visit, rank_names};
pub use norm::{initials, norm, switch_layout};
pub use stage::{score, stage};
