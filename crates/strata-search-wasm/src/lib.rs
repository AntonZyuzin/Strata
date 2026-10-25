//! WASM bindings of `strata-search` (09 §2.7): the UI's search worker holds
//! the names of the open workspace and answers the Tab menu, `Ctrl+O`,
//! `Ctrl+F`, the «Ноды» filter and the star map's search. Items and contexts
//! cross as JSON (the core's tree items as they are); answers are node
//! numbers in the items' order.

use serde::Serialize;
use strata_search::{Context, Find, Index, Item, Scope};
use wasm_bindgen::prelude::*;

/// The names of one workspace, or of one canvas.
#[wasm_bindgen]
#[derive(Debug)]
pub struct Names {
    index: Index,
}

#[derive(Serialize)]
struct Found {
    nodes: Vec<u32>,
    /// Filters the query has that `Ctrl+F` does not know: left out.
    unknown: Vec<String>,
    /// The query's text without filters, for the fuzzy line (§3.3).
    text: String,
}

fn bad(e: serde_json::Error) -> JsError {
    JsError::new(&e.to_string())
}

#[wasm_bindgen]
impl Names {
    /// `items`: a JSON array of tree items (`id`, `name`, `kind`, `parent`,
    /// `status`, `flags`, `aliases`).
    #[wasm_bindgen(constructor)]
    pub fn new(items: &str) -> Result<Names, JsError> {
        let items: Vec<Item> = serde_json::from_str(items).map_err(bad)?;
        Ok(Names {
            index: Index::new(items),
        })
    }

    pub fn len(&self) -> usize {
        self.index.len()
    }

    #[wasm_bindgen(js_name = isEmpty)]
    pub fn is_empty(&self) -> bool {
        self.index.is_empty()
    }

    /// Ranked by name (§2.3, §2.5); `context` — JSON of `limit`, `scope`,
    /// `here`, `visits`, `now`.
    pub fn query(&self, query: &str, context: &str) -> Result<Vec<u32>, JsError> {
        let ctx: Context = serde_json::from_str(context).map_err(bad)?;
        Ok(self.index.query(query, &ctx))
    }

    /// `Ctrl+F` (§3.3): JSON of `nodes`, `unknown`, `text`; `scope` — JSON.
    pub fn find(&self, query: &str, case: bool, scope: &str) -> Result<String, JsError> {
        let scope: Scope = serde_json::from_str(scope).map_err(bad)?;
        let find = Find::parse(query);
        let found = Found {
            nodes: self.index.find(&find, case, &scope),
            text: find.text(),
            unknown: find.unknown,
        };
        serde_json::to_string(&found).map_err(bad)
    }
}

/// A short list by name only — the Tab menu's kinds and templates: pairs of
/// an index into `names` and its score, best first; 1000 — the name exactly.
#[wasm_bindgen(js_name = rankNames)]
pub fn rank_names(query: &str, names: Vec<String>, limit: usize) -> Vec<i32> {
    strata_search::rank_names(query, &names, limit)
        .into_iter()
        .flat_map(|(i, s)| [i as i32, s])
        .collect()
}

/// The normalization of 09 §2.2.
#[wasm_bindgen]
pub fn norm(s: &str) -> String {
    strata_search::norm(s)
}
