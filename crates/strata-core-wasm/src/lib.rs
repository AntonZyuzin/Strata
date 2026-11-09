//! The core in the browser (15 §5.4): the same `strata_core::api` calls the
//! desktop answers over Tauri IPC, on a workspace whose store lives in
//! memory. The page keeps the store's bytes (IndexedDB) and opens them again.

use strata_core::backups::{Backup, BackupKind};
use strata_core::{MemoryStore, Workspace};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
extern "C" {
    /// `console.error`: where a panic says what it was.
    #[wasm_bindgen(js_namespace = console, js_name = error)]
    fn console_error(message: &str);
}

/// The core's panics, said in the console before WASM traps: alone, the
/// page sees only «unreachable» (WebKit: «Unreachable code should not be
/// executed») and never why. Run once, as the module loads.
#[wasm_bindgen(start)]
pub fn start() {
    std::panic::set_hook(Box::new(|info| {
        console_error(&format!("strata-core panicked: {info}"));
    }));
}

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
        let mut ws = Workspace::open(store).map_err(|e| JsError::new(&e.to_string()))?;
        // The trash's term (05 §11, 10 §10.4); a purge that fails changes nothing.
        let _ = ws.purge_expired();
        Ok(Core { ws })
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

    /// The store's writes so far ([`MemoryStore::revision`]): the page keeps
    /// [`Core::bytes`] after a call that moved it.
    pub fn revision(&self) -> f64 {
        // Exact in a JS number far beyond any session's writes (2^53).
        self.ws.store().revision() as f64
    }

    /// The workspace as `.strata.zip` (10 §3.5).
    #[wasm_bindgen(js_name = exportArchive)]
    pub fn export_archive(&self) -> Result<Vec<u8>, JsError> {
        strata_core::archive::export(&self.ws).map_err(|e| JsError::new(&e.to_string()))
    }

    /// The workspace id of an archive, to tell whether this browser has it.
    #[wasm_bindgen(js_name = archiveId)]
    pub fn archive_id(bytes: &[u8]) -> Result<String, JsError> {
        strata_core::archive::unpack(bytes)
            .map(|u| u.info.workspace_id)
            .map_err(|e| JsError::new(&e.to_string()))
    }

    /// A copy of a store, of `kind` (`day` or `replaced`) at `now` (unix
    /// ms), added to `backups` (10 §3.5): `{ backups, added, gone }` as JSON —
    /// the page keeps its copies by the rules of the desktop's folder.
    #[wasm_bindgen(js_name = addBackup)]
    pub fn add_backup(backups: &str, kind: &str, now: f64) -> Result<String, JsError> {
        let list: Vec<Backup> = serde_json::from_str(backups)?;
        let kind: BackupKind = serde_json::from_value(kind.into())?;
        // Unix ms are whole and far below 2^53: the cast loses nothing.
        let added = strata_core::backups::add(&list, kind, now as i64);
        Ok(serde_json::to_string(&added)?)
    }

    /// An archive as a workspace; `copy` gives it a new id (10 §3.6).
    #[wasm_bindgen(js_name = importArchive)]
    pub fn import_archive(bytes: &[u8], copy: bool) -> Result<Core, JsError> {
        let unpacked =
            strata_core::archive::unpack(bytes).map_err(|e| JsError::new(&e.to_string()))?;
        strata_core::archive::import(&unpacked, MemoryStore::default(), copy)
            .map(|ws| Core { ws })
            .map_err(|e| JsError::new(&e.to_string()))
    }
}
