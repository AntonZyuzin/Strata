//! The core in the browser (15 §5.4): the same `strata_core::api` calls the
//! desktop answers over Tauri IPC, on a workspace whose store lives in
//! memory. The page keeps the store's bytes (IndexedDB) and opens them again.

use strata_core::{MemoryStore, Workspace};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
#[derive(Debug)]
pub struct Core {
    ws: Workspace<MemoryStore>,
}

#[wasm_bindgen]
impl Core {
    /// A new workspace whose root network is called `root_name`.
    pub fn create(root_name: &str) -> Result<Core, JsError> {
        Workspace::create(MemoryStore::default(), root_name)
            .map(|ws| Core { ws })
            .map_err(|e| JsError::new(&e.to_string()))
    }

    /// A workspace from the bytes of [`Core::bytes`].
    pub fn open(bytes: &[u8]) -> Result<Core, JsError> {
        let store = MemoryStore::from_bytes(bytes).map_err(|e| JsError::new(&e.to_string()))?;
        Workspace::open(store)
            .map(|ws| Core { ws })
            .map_err(|e| JsError::new(&e.to_string()))
    }

    /// One call as JSON, as `strata_core::api::call`.
    pub fn call(&mut self, request: &str) -> String {
        strata_core::api::call(&mut self.ws, request)
    }

    pub fn id(&self) -> String {
        self.ws.id().to_owned()
    }

    pub fn root(&self) -> String {
        self.ws.root()
    }

    #[wasm_bindgen(js_name = rootName)]
    pub fn root_name(&self) -> String {
        self.ws.root_name()
    }

    /// The whole store, for the page to keep.
    pub fn bytes(&self) -> Vec<u8> {
        self.ws.store().to_bytes()
    }
}
