//! Desktop shell (ADR-0004): one TypeScript SPA talking to the Rust core over
//! Tauri IPC. Commands grow with the roadmap; stage 0 exposes build info only.

use serde::Serialize;

#[derive(Debug, Serialize)]
struct BuildInfo {
    core: String,
    shell: &'static str,
}

#[tauri::command]
fn build_info() -> BuildInfo {
    BuildInfo {
        core: strata_core::build_info(),
        shell: "tauri-2",
    }
}

/// Starts the desktop application.
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![build_info])
        .run(tauri::generate_context!())
        .expect("failed to run the Strata desktop shell");
}
