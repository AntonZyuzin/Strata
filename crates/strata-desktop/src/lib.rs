//! Desktop shell (ADR-0004): one TypeScript SPA talking to the Rust core over
//! Tauri IPC. Commands grow with the roadmap; stage 0 exposes build info only.

use serde::Serialize;
use sysinfo::{CpuRefreshKind, MemoryRefreshKind, RefreshKind, System};

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

/// Starts the desktop application.
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![build_info])
        .run(tauri::generate_context!())
        .expect("failed to run the Strata desktop shell");
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
