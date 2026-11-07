use std::{env, fs, path::PathBuf};

fn main() {
    let mut attributes = tauri_build::Attributes::new();
    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        // The app manifest — Common Controls v6, which the dialogs import
        // from — goes into every target that links, the shell's unit tests
        // too: without it their binary does not start
        // (STATUS_ENTRYPOINT_NOT_FOUND). tauri-build puts it into the app
        // alone, so its own is left out and this one is linked everywhere.
        attributes = attributes
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
        let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("cargo sets it"))
            .join("windows")
            .join("app.manifest");
        println!("cargo:rerun-if-changed={}", manifest.display());
        let rc = PathBuf::from(env::var("OUT_DIR").expect("cargo sets it")).join("manifest.rc");
        // Resource 1 of type 24 (RT_MANIFEST): the manifest of an executable.
        let path = manifest.display().to_string().replace('\\', "\\\\");
        fs::write(&rc, format!("1 24 \"{path}\"\n")).expect("OUT_DIR is writable");
        embed_resource::compile_for_everything(&rc, embed_resource::NONE)
            .manifest_required()
            .expect("the app manifest compiles");
    }
    tauri_build::try_build(attributes).expect("tauri-build");
}
