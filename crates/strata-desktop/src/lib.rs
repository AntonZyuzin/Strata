//! Desktop shell (ADR-0004): one TypeScript SPA talking to the Rust core over
//! Tauri IPC. `home` takes the home screen's calls (`strata_core::home`:
//! the workspaces of this device, ✅ Q-16-12; the tabs' workspaces stay in
//! memory with their undo, `home::Desk`), `core` the calls for the workspace
//! on the canvas (`strata_core::api`); `preview` fetches a link asset's preview
//! (ADR-0012); `build_info` feeds «О программе» and the benchmark. An import
//! of a vault runs on a thread of its own and tells the UI each batch as an
//! `import` event (13 §3.3). `update_check` and `update_install` take a signed
//! update (NFR-89) — in a build with the update key only, and asked by the UI
//! only with the person's consent (NFR-94).

use serde::Serialize;
use std::sync::Mutex;
use strata_core::home::{Desk, Home};
use sysinfo::{CpuRefreshKind, MemoryRefreshKind, RefreshKind, System};
use tauri::{Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;

/// The update channel's public key (NFR-89, R4 §1.5): baked in by the release
/// workflow from the owner's key pair, whose private half never leaves the
/// owner's machine and CI's secrets. A build without it has no updater at all
/// and never asks the network for one (NFR-94).
const UPDATER_PUBKEY: Option<&str> = option_env!("STRATA_UPDATER_PUBKEY");

/// This build can update itself: its key is baked in.
fn update_key() -> Option<&'static str> {
    UPDATER_PUBKEY.filter(|k| !k.trim().is_empty())
}

/// The home screen's list and the workspaces open in tabs.
#[derive(Debug)]
struct App {
    home: Home,
    desk: Desk,
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
    /// It has an update channel (NFR-89): the UI may ask whether to use it.
    updates: bool,
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
        updates: update_key().is_some(),
    }
}

/// An update the channel offers: its version, the one running, its notes.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateInfo {
    version: String,
    current: String,
    notes: Option<String>,
}

/// Asks the channel for a newer version (NFR-94: the UI calls it only with
/// the person's consent). None — none newer, or no channel in this build.
#[tauri::command]
async fn update_check(app: tauri::AppHandle) -> Result<Option<UpdateInfo>, String> {
    if update_key().is_none() {
        return Ok(None);
    }
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;
    Ok(update.map(|u| UpdateInfo {
        version: u.version,
        current: u.current_version,
        notes: u.body,
    }))
}

/// Downloads the newer version, installs it and starts it. The plugin checks
/// the artifact's signature against the key, and the version signed against
/// the one announced, before anything is installed (NFR-89).
#[tauri::command]
async fn update_install(app: tauri::AppHandle) -> Result<(), String> {
    if update_key().is_none() {
        return Err("this build has no update channel".to_owned());
    }
    let updater = app.updater().map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Ok(());
    };
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    app.restart();
}

/// One call of the core as JSON (15 §2.5) for the workspace on the canvas: the same
/// requests the browser build answers in WASM.
#[tauri::command]
fn core(state: tauri::State<'_, Core>, request: String) -> String {
    let mut guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
    match guard.as_mut() {
        Ok(app) => match app.desk.current_mut() {
            Some(ws) => strata_core::api::call(ws, &request),
            None => error("no workspace is open"),
        },
        Err(e) => error(e),
    }
}

/// One call of the home screen as JSON. A removed workspace's folder goes
/// to the system trash, so it can be brought back by hand. An import the
/// call started goes on on a thread of its own (13 §3.3).
#[tauri::command]
fn home(handle: tauri::AppHandle, state: tauri::State<'_, Core>, request: String) -> String {
    let mut guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
    let (answer, started) = match guard.as_mut() {
        Ok(app) => {
            let answer = strata_core::home::call(&mut app.home, &mut app.desk, &request, &|p| {
                trash::delete(p).map_err(|e| e.to_string())
            });
            (answer, app.desk.take_imports())
        }
        Err(e) => (error(e), Vec::new()),
    };
    drop(guard);
    for task in started {
        let handle = handle.clone();
        std::thread::spawn(move || import(&handle, task));
    }
    answer
}

/// An import's long part (13 §3.3): the vault read and planned off the
/// core's lock, each batch written under it; every step reaches the UI as
/// an `import` event.
fn import(handle: &tauri::AppHandle, task: strata_core::home::ImportTask) {
    let state = handle.state::<Core>();
    strata_core::home::run_import(
        task,
        &|f| {
            let mut guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
            if let Ok(app) = guard.as_mut() {
                f(&mut app.home, &mut app.desk);
            }
        },
        &|event| {
            let _ = handle.emit("import", event);
        },
    );
}

/// A link asset's preview (05 §4.4, ✅ Q-13-16, ADR-0012): the link is read
/// from the core, the page fetched off the core's lock and the main thread,
/// and the result written back as a step of the system. True when the node
/// changed; false when it is no link, or the workspace or its link changed
/// while the page loaded.
#[tauri::command]
async fn preview(state: tauri::State<'_, Core>, id: String) -> Result<bool, String> {
    let (workspace, url) = {
        let guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
        match guard.as_ref() {
            Ok(app) => match app.desk.current() {
                Some(ws) => (
                    ws.id().to_owned(),
                    ws.link_of(&id).map_err(|e| e.to_string())?,
                ),
                None => return Err("no workspace is open".to_owned()),
            },
            Err(e) => return Err(e.clone()),
        }
    };
    let Some(url) = url else { return Ok(false) };
    let link = url.clone();
    let fetched = tauri::async_runtime::spawn_blocking(move || strata_core::preview::fetch(&link))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    // The workspace that asked, on the canvas or in a tab behind it by now.
    let mut guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
    match guard
        .as_mut()
        .ok()
        .and_then(|app| app.desk.get_mut(&workspace))
    {
        Some(ws) => ws
            .apply_preview(
                &id,
                &url,
                fetched.title.as_deref(),
                fetched.picture.as_deref(),
            )
            .map_err(|e| e.to_string()),
        None => Ok(false),
    }
}

/// Starts the desktop application.
pub fn run() {
    let mut builder = tauri::Builder::default().plugin(tauri_plugin_dialog::init());
    // The updater only with its key: no key, no channel (NFR-89, NFR-94).
    if let Some(key) = update_key() {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().pubkey(key).build());
    }
    builder
        .setup(|app| {
            // The home list lives in the app's data folder; the app starts
            // on the home screen with no workspace open.
            let loaded = app
                .path()
                .app_data_dir()
                .map_err(|e| e.to_string())
                .map(|dir| App {
                    home: Home::load(&dir),
                    desk: Desk::default(),
                });
            app.manage(Core(Mutex::new(loaded)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            build_info,
            core,
            home,
            preview,
            update_check,
            update_install
        ])
        .run(tauri::generate_context!())
        .expect("failed to run the Gexogon desktop shell");
}

#[cfg(test)]
mod update_tests {
    //! NFR-89's test with a tampered artifact: a channel on this machine
    //! announces an update signed with a test key; the updater takes the
    //! artifact as it was signed, and refuses it changed by a byte, signed for
    //! another version (a downgrade dressed as an upgrade) or by another key.

    use base64::Engine;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use tauri_plugin_updater::UpdaterExt;

    /// A key pair as Tauri writes them: base64 of minisign's key and signature files.
    struct Key(minisign::KeyPair);

    impl Key {
        fn new() -> Self {
            Self(minisign::KeyPair::generate_unencrypted_keypair().expect("a key pair"))
        }

        fn public(&self) -> String {
            let text = self.0.pk.to_box().expect("the key's box").into_string();
            base64::engine::general_purpose::STANDARD.encode(text)
        }

        /// The artifact's signature, the version in its trusted comment as the Tauri CLI puts it.
        fn sign(&self, data: &[u8], version: &str) -> String {
            let comment = format!("timestamp:1760000000\tfile:app.tar.gz\tversion:{version}");
            let sig = minisign::sign(Some(&self.0.pk), &self.0.sk, data, Some(&comment), None)
                .expect("a signature");
            base64::engine::general_purpose::STANDARD.encode(sig.into_string())
        }
    }

    /// Serves `latest.json` and `app.tar.gz` from `listener`, one connection at a time.
    fn serve(listener: TcpListener, latest: String, artifact: Vec<u8>) {
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let mut reader = BufReader::new(&stream);
                let mut line = String::new();
                if reader.read_line(&mut line).is_err() {
                    continue;
                }
                // The headers, up to the empty line.
                let mut header = String::new();
                while reader.read_line(&mut header).is_ok_and(|n| n > 2) {
                    header.clear();
                }
                let (kind, body) = if line.contains("latest.json") {
                    ("application/json", latest.as_bytes().to_vec())
                } else {
                    ("application/octet-stream", artifact.clone())
                };
                let mut out = &stream;
                let _ = write!(
                    out,
                    "HTTP/1.1 200 OK\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = out.write_all(&body);
            }
        });
    }

    /// What the updater makes of an artifact announced as 9.9.9 with `signature`.
    fn download(key: &str, signature: &str, artifact: Vec<u8>) -> Result<Vec<u8>, String> {
        let url = |port: u16, path: &str| format!("http://127.0.0.1:{port}/{path}");
        // The announcement names the artifact on the channel's own port.
        let listener = TcpListener::bind("127.0.0.1:0").expect("a port");
        let port = listener.local_addr().expect("its address").port();
        let platform =
            serde_json::json!({ "url": url(port, "app.tar.gz"), "signature": signature });
        let mut platforms = serde_json::Map::new();
        for target in ["linux", "darwin", "windows"] {
            for arch in ["x86_64", "aarch64", "i686", "armv7"] {
                platforms.insert(format!("{target}-{arch}"), platform.clone());
                platforms.insert(format!("{target}-{arch}-appimage"), platform.clone());
            }
        }
        let latest = serde_json::json!({ "version": "9.9.9", "platforms": platforms }).to_string();
        serve(listener, latest, artifact);

        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context.config_mut().plugins.0.insert(
            "updater".to_owned(),
            serde_json::json!({
                "pubkey": key,
                "endpoints": [],
                "requireSignedVersion": true,
                // A channel on this machine: plain HTTP, for the test only.
                "dangerousInsecureTransportProtocol": true,
            }),
        );
        let app = tauri::test::mock_builder()
            .plugin(tauri_plugin_updater::Builder::new().build())
            .build(context)
            .expect("the mock app");
        let endpoint = url(port, "latest.json").parse().expect("a URL");
        let updater = app
            .updater_builder()
            .endpoints(vec![endpoint])
            .map_err(|e| e.to_string())?
            .build()
            .map_err(|e| e.to_string())?;
        tauri::async_runtime::block_on(async move {
            let update = updater
                .check()
                .await
                .map_err(|e| e.to_string())?
                .ok_or("no update announced")?;
            update
                .download(|_, _| {}, || {})
                .await
                .map_err(|e| e.to_string())
        })
    }

    #[test]
    fn the_updater_takes_only_the_artifact_as_it_was_signed() {
        let key = Key::new();
        let data = b"Gexogon 9.9.9, the update".to_vec();
        let signature = key.sign(&data, "9.9.9");
        assert_eq!(
            download(&key.public(), &signature, data.clone()).as_deref(),
            Ok(data.as_slice()),
            "the genuine artifact"
        );
        // Refused, each for its own reason, by the plugin's checks (R4 §1.5).
        let refused = |artifact: Vec<u8>, signature: &str| {
            download(&key.public(), signature, artifact)
                .expect_err("refused")
                .to_lowercase()
        };
        let mut tampered = data.clone();
        tampered[0] ^= 1;
        assert!(
            refused(tampered, &signature).contains("signature verification failed"),
            "an artifact changed by a byte"
        );
        assert!(
            refused(data.clone(), &key.sign(&data, "1.0.0")).contains("signed for version 1.0.0"),
            "an artifact signed for another version: a downgrade dressed as an upgrade"
        );
        assert!(
            refused(data.clone(), &Key::new().sign(&data, "9.9.9")).contains("different key"),
            "an artifact signed by another key"
        );
    }

    #[test]
    fn the_shipped_channel_is_https_and_wants_the_signed_version() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json");
        let updater = &conf["plugins"]["updater"];
        assert_eq!(updater["requireSignedVersion"], true);
        assert!(updater["endpoints"].as_array().is_some_and(|e| {
            !e.is_empty()
                && e.iter()
                    .all(|u| u.as_str().is_some_and(|u| u.starts_with("https://")))
        }));
        assert!(updater.get("dangerousInsecureTransportProtocol").is_none());
        // The key comes at build time, never from the repository.
        assert_eq!(updater["pubkey"], "");
    }
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
