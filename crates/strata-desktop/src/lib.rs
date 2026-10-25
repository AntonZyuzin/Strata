//! Desktop shell (ADR-0004): one TypeScript SPA talking to the Rust core over
//! Tauri IPC. `home` takes the home screen's calls (`strata_core::home`:
//! the workspaces of this device, ✅ Q-16-12), `core` the calls for the open
//! workspace (`strata_core::api`); `build_info` feeds «О программе» and the
//! benchmark.

use serde::Serialize;
use std::sync::Mutex;
use strata_core::Workspace;
use strata_core::home::Home;
use strata_core::sqlite::SqliteStore;
use sysinfo::{CpuRefreshKind, MemoryRefreshKind, RefreshKind, System};
use tauri::Manager;

/// The home screen's list and the open workspace, if any.
#[derive(Debug)]
struct App {
    home: Home,
    current: Option<Workspace<SqliteStore>>,
}

/// The app, or why its data folder could not be found.
struct Core(Mutex<Result<App, String>>);

fn error(message: &str) -> String {
    serde_json::json!({ "type": "error", "message": message, "invalid": false }).to_string()
}

#[derive(Debug, Serialize)]
struct BuildInfo {
    core: String,
    shell: String,
    /// WKWebView, WebView2 or WebKitGTK version.
    webview: Option<String>,
    machine: Machine,
}

/// What the benchmark report needs about the machine (14 §1.2): the WebView
/// hides the CPU model and freezes the OS version in its user agent.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Machine {
    os: Option<String>,
    arch: String,
    cpu: Option<String>,
    physical_cores: Option<usize>,
    logical_cores: usize,
    memory_gib: f64,
}

fn machine() -> Machine {
    let sys = System::new_with_specifics(
        RefreshKind::nothing()
            .with_cpu(CpuRefreshKind::nothing())
            .with_memory(MemoryRefreshKind::nothing().with_ram()),
    );
    Machine {
        os: System::long_os_version(),
        arch: System::cpu_arch(),
        cpu: sys.cpus().first().map(|c| c.brand().trim().to_owned()),
        physical_cores: System::physical_core_count(),
        logical_cores: sys.cpus().len(),
        memory_gib: (sys.total_memory() as f64 / f64::from(1u32 << 30) * 10.0).round() / 10.0,
    }
}

#[tauri::command]
fn build_info() -> BuildInfo {
    BuildInfo {
        core: strata_core::build_info(),
        shell: format!("tauri {}", tauri::VERSION),
        webview: tauri::webview_version().ok(),
        machine: machine(),
    }
}

/// One call of the core as JSON (15 §2.5) for the open workspace: the same
/// requests the browser build answers in WASM.
#[tauri::command]
fn core(state: tauri::State<'_, Core>, request: String) -> String {
    let mut guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
    match guard.as_mut() {
        Ok(App {
            current: Some(ws), ..
        }) => strata_core::api::call(ws, &request),
        Ok(_) => error("no workspace is open"),
        Err(e) => error(e),
    }
}

/// One call of the home screen as JSON. A removed workspace's folder goes
/// to the system trash, so it can be brought back by hand.
#[tauri::command]
fn home(state: tauri::State<'_, Core>, request: String) -> String {
    let mut guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
    match guard.as_mut() {
        Ok(app) => strata_core::home::call(&mut app.home, &mut app.current, &request, &|p| {
            trash::delete(p).map_err(|e| e.to_string())
        }),
        Err(e) => error(e),
    }
}

/// Starts the desktop application.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // The home list lives in the app's data folder; the app starts
            // on the home screen with no workspace open.
            let loaded = app
                .path()
                .app_data_dir()
                .map_err(|e| e.to_string())
                .map(|dir| App {
                    home: Home::load(&dir),
                    current: None,
                });
            app.manage(Core(Mutex::new(loaded)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![build_info, core, home])
        .run(tauri::generate_context!())
        .expect("failed to run the Gexogon desktop shell");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn machine_info_is_filled() {
        let m = machine();
        assert!(!m.arch.is_empty());
        assert!(m.logical_cores > 0);
        assert!(m.memory_gib > 0.0);
        let json = serde_json::to_value(&m).unwrap();
        assert!(
            json.get("logicalCores").is_some(),
            "camelCase for the TS side"
        );
    }
}
