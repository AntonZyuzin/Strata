//! `.strata.zip` (10 §3.5): a workspace as one file — to keep, to move to
//! another device, or from the browser to the desktop and back. It does not
//! depend on the store: every document as a Loro snapshot and the changeset
//! journal, so a workspace folder and the browser's store read the same file.
//!
//! ```text
//! strata.json          workspaceId, formatVersion, name, exportedAt
//! docs/<doc id>.loro   manifest, sys, index/0/<k>, net/<id>, content/<id>
//! assets/<sha256>      pictures and files (10 §11)
//! changesets.jsonl     the journal, oldest first
//! ```

use crate::changeset::Changeset;
use crate::store::Store;
use crate::workspace::{CoreError, Result, Workspace};
use serde::{Deserialize, Serialize};
use std::io::{Cursor, Read, Write};
use strata_model::now_ms;
use zip::write::SimpleFileOptions;

/// Version of the archive's layout.
pub const ARCHIVE_VERSION: u32 = 1;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveInfo {
    pub workspace_id: String,
    pub format_version: u32,
    pub name: String,
    pub exported_at: i64,
}

/// An archive read into memory.
#[derive(Debug)]
pub struct Unpacked {
    pub info: ArchiveInfo,
    pub docs: Vec<(String, Vec<u8>)>,
    pub assets: Vec<(String, Vec<u8>)>,
    pub changesets: Vec<Changeset>,
}

fn bad(e: impl std::fmt::Display) -> CoreError {
    CoreError::Invalid(format!("not a Strata archive: {e}"))
}

/// A document id as it may appear in an archive: `manifest`, `sys`,
/// `index/0/3`, `net/<id>`, `content/<id>` — no way out of `docs/`.
fn doc_id_ok(id: &str) -> bool {
    !id.is_empty()
        && id
            .split('/')
            .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_alphanumeric()))
}

/// The workspace as `.strata.zip` bytes.
pub fn export<S: Store>(ws: &Workspace<S>) -> Result<Vec<u8>> {
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let info = ArchiveInfo {
        workspace_id: ws.id().to_owned(),
        format_version: ARCHIVE_VERSION,
        name: ws.root_name(),
        exported_at: now_ms(),
    };
    zip.start_file("strata.json", opts).map_err(bad)?;
    zip.write_all(&serde_json::to_vec_pretty(&info).map_err(bad)?)
        .map_err(bad)?;
    for (id, bytes) in ws.snapshots()? {
        zip.start_file(format!("docs/{id}.loro"), opts)
            .map_err(bad)?;
        zip.write_all(&bytes).map_err(bad)?;
    }
    // Pictures are compressed already: stored as they are.
    let stored = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    for sha in ws.store().asset_ids()? {
        if let Some(bytes) = ws.store().asset(&sha)? {
            zip.start_file(format!("assets/{sha}"), stored)
                .map_err(bad)?;
            zip.write_all(&bytes).map_err(bad)?;
        }
    }
    zip.start_file("changesets.jsonl", opts).map_err(bad)?;
    for c in ws.store().changesets()? {
        zip.write_all(&serde_json::to_vec(&c).map_err(bad)?)
            .map_err(bad)?;
        zip.write_all(b"\n").map_err(bad)?;
    }
    Ok(zip.finish().map_err(bad)?.into_inner())
}

/// Reads an archive; refuses one of a newer format or with odd entries.
pub fn unpack(bytes: &[u8]) -> Result<Unpacked> {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).map_err(bad)?;
    let mut info = None;
    let mut docs = Vec::new();
    let mut assets = Vec::new();
    let mut changesets = Vec::new();
    for i in 0..zip.len() {
        let mut f = zip.by_index(i).map_err(bad)?;
        if f.is_dir() {
            continue;
        }
        let name = f.name().to_owned();
        let mut data = Vec::new();
        f.read_to_end(&mut data).map_err(bad)?;
        if name == "strata.json" {
            info = Some(serde_json::from_slice::<ArchiveInfo>(&data).map_err(bad)?);
        } else if name == "changesets.jsonl" {
            for line in data.split(|&b| b == b'\n').filter(|l| !l.is_empty()) {
                changesets.push(serde_json::from_slice(line).map_err(bad)?);
            }
        } else if let Some(id) = name
            .strip_prefix("docs/")
            .and_then(|n| n.strip_suffix(".loro"))
        {
            if !doc_id_ok(id) {
                return Err(bad(format!("entry {name}")));
            }
            docs.push((id.to_owned(), data));
        } else if let Some(sha) = name.strip_prefix("assets/") {
            if sha.len() != 64 || !sha.bytes().all(|c| c.is_ascii_hexdigit()) {
                return Err(bad(format!("entry {name}")));
            }
            assets.push((sha.to_owned(), data));
        }
    }
    let info = info.ok_or_else(|| bad("no strata.json"))?;
    if info.format_version > ARCHIVE_VERSION {
        return Err(CoreError::Invalid(format!(
            "the archive's format {} is newer than this app's {ARCHIVE_VERSION}",
            info.format_version
        )));
    }
    Ok(Unpacked {
        info,
        docs,
        assets,
        changesets,
    })
}

/// An archive into an empty store, opened. `copy` gives the workspace a new
/// id: the device already has the original (10 §3.6).
pub fn import<S: Store>(unpacked: &Unpacked, mut store: S, copy: bool) -> Result<Workspace<S>> {
    store.restore(&unpacked.docs, &unpacked.changesets)?;
    for (sha, bytes) in &unpacked.assets {
        store.put_asset(sha, bytes)?;
    }
    let mut ws = Workspace::open(store)?;
    if ws.id() != unpacked.info.workspace_id {
        return Err(bad("strata.json and the documents disagree"));
    }
    if copy {
        ws.reidentify()?;
    }
    Ok(ws)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Label, MemoryStore, Op};
    use strata_model::{NodeId, NodeKind};

    fn sample() -> (Workspace<MemoryStore>, String, String) {
        let mut ws = Workspace::create(MemoryStore::default(), "Архив").expect("create");
        let root = ws.root();
        let (a, b) = (NodeId::new().to_text(), NodeId::new().to_text());
        let mk = |id: &str, kind, name: &str| Op::CreateNode {
            id: Some(id.to_owned()),
            kind,
            name: name.to_owned(),
            net: root.clone(),
            x: 3.0,
            y: 4.0,
        };
        ws.apply(
            &[
                mk(&a, NodeKind::Network, "Глава"),
                mk(&b, NodeKind::Note, "Заметка"),
                Op::Connect {
                    from: a.clone(),
                    to: b.clone(),
                },
            ],
            Label::new("t"),
        )
        .expect("apply");
        // A note's text lives in its content document.
        let doc = loro::LoroDoc::new();
        doc.get_text("text").insert(0, "Текст").expect("text");
        doc.commit();
        ws.doc_push(
            &format!("content/{b}"),
            &doc.export(loro::ExportMode::Snapshot).expect("snap"),
        )
        .expect("push");
        (ws, root, b)
    }

    #[test]
    fn an_archive_brings_the_whole_workspace_back() {
        let (mut ws, root, note) = sample();
        let before = ws.network_view(&root).expect("view");
        let bytes = export(&ws).expect("export");
        let unpacked = unpack(&bytes).expect("unpack");
        assert_eq!(unpacked.info.name, "Архив");
        assert_eq!(unpacked.info.workspace_id, ws.id());
        let mut again = import(&unpacked, MemoryStore::default(), false).expect("import");
        assert_eq!(again.id(), ws.id());
        assert_eq!(again.network_view(&root).expect("view"), before);
        let text = again.doc_snapshot(&format!("content/{note}")).expect("doc");
        let d = loro::LoroDoc::new();
        d.import(&text).expect("import");
        assert_eq!(d.get_text("text").to_string(), "Текст");
        assert_eq!(
            again.store().changesets().expect("journal").len(),
            ws.store().changesets().expect("journal").len()
        );
    }

    #[test]
    fn a_copy_gets_its_own_id_and_keeps_the_nodes() {
        let (mut ws, root, _) = sample();
        let unpacked = unpack(&export(&ws).expect("export")).expect("unpack");
        let mut copy = import(&unpacked, MemoryStore::default(), true).expect("import");
        assert_ne!(copy.id(), ws.id());
        assert_eq!(
            copy.network_view(&root).expect("view").nodes,
            ws.network_view(&root).expect("view").nodes
        );
        // The new id survives reopening.
        let id = copy.id().to_owned();
        let reopened = Workspace::open(copy.into_store()).expect("open");
        assert_eq!(reopened.id(), id);
    }

    #[test]
    fn strange_archives_are_refused() {
        assert!(unpack(b"not a zip").is_err());
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let opts = SimpleFileOptions::default();
        zip.start_file("strata.json", opts).expect("file");
        zip.write_all(br#"{"workspaceId":"x","formatVersion":1,"name":"x","exportedAt":0}"#)
            .expect("write");
        zip.start_file("docs/../evil.loro", opts).expect("file");
        zip.write_all(b"x").expect("write");
        let bytes = zip.finish().expect("finish").into_inner();
        assert!(unpack(&bytes).is_err());
        assert!(doc_id_ok("index/0/3") && doc_id_ok("content/01ABC") && !doc_id_ok("a//b"));
    }
}
