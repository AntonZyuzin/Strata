//! The core's calls as JSON (15 §2.5 `Backend`): one entry point for every
//! shell. The desktop passes it through a Tauri command, the browser build
//! through WASM; the UI sends the same requests to both (15 §1.4 principle 3).

use crate::changeset::{Label, RevertReport};
use crate::ops::Op;
use crate::store::Store;
use crate::vault::{Vault, VaultFile};
use crate::workspace::{
    Edited, ExternalWire, History, ImportOptions, ImportReport, NetworkView, NodeDetails, Person,
    TrashItem, TrashPreview, TreeItem, WireEnds, Workspace,
};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "call", rename_all = "camelCase")]
pub enum Request {
    /// The workspace's id and root network.
    Workspace,
    /// A network for the canvas.
    View {
        net: String,
    },
    /// Operations as one changeset, one step of undo; with `amend`, added
    /// to the last step (the rest of a gesture).
    Apply {
        ops: Vec<Op>,
        label: Label,
        #[serde(default)]
        amend: bool,
    },
    /// A copy of a node at (x, y) in `net`, everything inside it too: a
    /// template chosen in the Tab menu (05 §7); `inputs` wire into it. One
    /// step of undo.
    CopyNode {
        from: String,
        net: String,
        x: f64,
        y: f64,
        #[serde(default)]
        inputs: Vec<String>,
        label: Label,
    },
    Undo,
    Redo,
    /// The last step reverted and forgotten: a gesture cancelled with Esc.
    Cancel,
    History,
    Trash,
    /// What trashing `ids` would take, without taking it (06 §12.3).
    TrashPreview {
        ids: Vec<String>,
    },
    /// A content document for an editor (`content/<id>`).
    OpenDoc {
        doc: String,
    },
    /// An editor's updates of a content document, in base64.
    PushDoc {
        doc: String,
        update: String,
    },
    /// What a content document has that an editor at `since` — its Loro
    /// version vector, encoded, in base64 — has not: the core's own edits.
    PullDoc {
        doc: String,
        since: String,
    },
    /// The content documents the core changed after its edit `since`: the
    /// links a rename rewrote (13 §6.5).
    Edited {
        since: u64,
    },
    /// One node for the properties panel.
    Node {
        id: String,
    },
    /// Every network for the «Структура» tree.
    Tree,
    /// Every live wire, for the star map (08 §10).
    Wires,
    /// The wires of `id` in `net` to nodes not placed there: «↗N» (05 §8.3).
    External {
        net: String,
        id: String,
    },
    People,
    /// A picture or a file, in base64; answers its SHA-256.
    PutAsset {
        bytes: String,
    },
    Asset {
        sha: String,
    },
    /// A vault of Obsidian (13 §2–3) into network `net`, the root when
    /// none: its files, bytes in base64 — what a browser's folder picker
    /// gives. One step of undo; the report back.
    ImportVault {
        name: String,
        files: Vec<VaultFile>,
        #[serde(default)]
        net: Option<String>,
        #[serde(default)]
        options: ImportOptions,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Response {
    Workspace {
        id: String,
        root: String,
    },
    View {
        view: NetworkView,
    },
    /// The step was taken; the undo and redo steps after it. No changeset
    /// when an amend only renamed the step.
    Applied {
        changeset: Option<String>,
        history: History,
    },
    /// The copy is made: its id, the undo and redo steps after it.
    Copied {
        id: String,
        history: History,
    },
    /// An undo or redo: `None` when there was nothing to undo or redo.
    Reverted {
        report: Option<RevertReport>,
        history: History,
    },
    History {
        history: History,
    },
    Trash {
        items: Vec<TrashItem>,
    },
    TrashPreview {
        preview: TrashPreview,
    },
    /// A content document as a Loro snapshot in base64.
    Doc {
        doc: String,
        snapshot: String,
    },
    /// The updates are stored; `wires` when the note's text wires changed.
    Pushed {
        wires: bool,
    },
    /// Updates of a content document for an editor, in base64; empty — none.
    Updates {
        doc: String,
        update: String,
    },
    Edited {
        edited: Edited,
    },
    Node {
        node: Box<NodeDetails>,
    },
    Tree {
        items: Vec<TreeItem>,
    },
    Wires {
        wires: Vec<WireEnds>,
    },
    External {
        wires: Vec<ExternalWire>,
    },
    People {
        people: Vec<Person>,
    },
    /// An asset: its id, and its bytes in base64 when asked for.
    Asset {
        sha: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        bytes: Option<String>,
    },
    /// The vault came in: the report (13 §3.6), the undo and redo steps after it.
    Imported {
        report: ImportReport,
        history: History,
    },
    /// The call failed; `invalid` when the model refused it (nothing was written).
    Error {
        message: String,
        invalid: bool,
    },
}

pub fn handle<S: Store>(ws: &mut Workspace<S>, request: Request) -> Response {
    let result = match request {
        Request::Workspace => Ok(Response::Workspace {
            id: ws.id().to_owned(),
            root: ws.root(),
        }),
        Request::View { net } => ws.network_view(&net).map(|view| Response::View { view }),
        Request::Apply { ops, label, amend } => {
            let done = if amend {
                ws.amend(&ops, label)
            } else {
                ws.apply(&ops, label).map(Some)
            };
            done.map(|c| Response::Applied {
                changeset: c.map(|c| c.id),
                history: ws.history(),
            })
        }
        Request::CopyNode {
            from,
            net,
            x,
            y,
            inputs,
            label,
        } => ws
            .copy_node(&from, &net, (x, y), &inputs, label)
            .map(|id| Response::Copied {
                id,
                history: ws.history(),
            }),
        Request::Undo => ws.undo().map(|report| Response::Reverted {
            report,
            history: ws.history(),
        }),
        Request::Redo => ws.redo().map(|report| Response::Reverted {
            report,
            history: ws.history(),
        }),
        Request::Cancel => ws.cancel().map(|report| Response::Reverted {
            report,
            history: ws.history(),
        }),
        Request::OpenDoc { doc } => ws.doc_snapshot(&doc).map(|bytes| Response::Doc {
            doc,
            snapshot: B64.encode(bytes),
        }),
        Request::PushDoc { doc, update } => match B64.decode(update) {
            Ok(bytes) => ws
                .doc_push(&doc, &bytes)
                .map(|wires| Response::Pushed { wires }),
            Err(e) => Err(crate::CoreError::Invalid(format!("update: {e}"))),
        },
        Request::PullDoc { doc, since } => match B64.decode(since) {
            Ok(vv) => ws.doc_updates(&doc, &vv).map(|bytes| Response::Updates {
                doc,
                update: B64.encode(bytes),
            }),
            Err(e) => Err(crate::CoreError::Invalid(format!("since: {e}"))),
        },
        Request::Edited { since } => Ok(Response::Edited {
            edited: ws.edited(since),
        }),
        Request::Node { id } => ws.node_details(&id).map(|node| Response::Node {
            node: Box::new(node),
        }),
        Request::Tree => Ok(Response::Tree { items: ws.tree() }),
        Request::Wires => Ok(Response::Wires { wires: ws.wires() }),
        Request::External { net, id } => ws
            .external_wires(&net, &id)
            .map(|wires| Response::External { wires }),
        Request::People => Ok(Response::People {
            people: ws.people(),
        }),
        Request::PutAsset { bytes } => match B64.decode(bytes) {
            Ok(b) => ws
                .put_asset(&b)
                .map(|sha| Response::Asset { sha, bytes: None }),
            Err(e) => Err(crate::CoreError::Invalid(format!("bytes: {e}"))),
        },
        Request::Asset { sha } => ws.asset(&sha).and_then(|b| match b {
            Some(b) => Ok(Response::Asset {
                sha,
                bytes: Some(B64.encode(b)),
            }),
            None => Err(crate::CoreError::Invalid(format!("no asset {sha}"))),
        }),
        Request::History => Ok(Response::History {
            history: ws.history(),
        }),
        Request::Trash => Ok(Response::Trash { items: ws.trash() }),
        Request::TrashPreview { ids } => ws
            .trash_preview(&ids)
            .map(|preview| Response::TrashPreview { preview }),
        Request::ImportVault {
            name,
            files,
            net,
            options,
        } => ws
            .import_vault(&Vault::from_files(&name, files), net.as_deref(), &options)
            .map(|report| Response::Imported {
                report,
                history: ws.history(),
            }),
    };
    result.unwrap_or_else(|e| Response::Error {
        invalid: matches!(e, crate::CoreError::Invalid(_)),
        message: e.to_string(),
    })
}

/// [`handle`] on JSON: a request in, a response out; a request that does
/// not parse is an error response, not a panic.
pub fn call<S: Store>(ws: &mut Workspace<S>, json: &str) -> String {
    let response = match serde_json::from_str::<Request>(json) {
        Ok(r) => handle(ws, r),
        Err(e) => Response::Error {
            message: format!("bad request: {e}"),
            invalid: true,
        },
    };
    serde_json::to_string(&response).unwrap_or_else(|e| {
        format!(r#"{{"type":"error","message":"response: {e}","invalid":false}}"#)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::MemoryStore;
    use serde_json::{Value, json};

    fn ask(ws: &mut Workspace<MemoryStore>, v: Value) -> Value {
        serde_json::from_str(&call(ws, &v.to_string())).expect("json")
    }

    #[test]
    fn the_ui_speaks_json_to_the_core() {
        let mut ws = Workspace::create(MemoryStore::default(), "Root").expect("create");
        let w = ask(&mut ws, json!({ "call": "workspace" }));
        let root = w["root"].as_str().expect("root").to_owned();
        let a = strata_model::NodeId::new().to_text();
        let applied = ask(
            &mut ws,
            json!({ "call": "apply", "label": { "key": "proto.change.create", "params": { "name": "A" } },
                    "ops": [{ "op": "createNode", "id": a, "kind": "note", "name": "A", "net": root, "x": 1, "y": 2 }] }),
        );
        assert_eq!(applied["type"], "applied");
        assert_eq!(applied["history"]["undo"]["params"]["name"], "A");
        let view = ask(&mut ws, json!({ "call": "view", "net": root }));
        assert_eq!(view["view"]["nodes"][0]["name"], "A");
        assert_eq!(view["view"]["nodes"][0]["kind"], "note");
        let undone = ask(&mut ws, json!({ "call": "undo" }));
        assert_eq!(undone["type"], "reverted");
        assert_eq!(undone["history"]["redo"]["key"], "proto.change.create");
    }

    #[test]
    fn an_editor_pulls_what_the_core_edited() {
        // 15 §3.4: `edited` names the documents, `pullDoc` gives the updates
        // an editor at its version vector has not seen.
        let mut ws = Workspace::create(MemoryStore::default(), "Root").expect("create");
        let root = ws.root();
        let note = strata_model::NodeId::new().to_text();
        ask(
            &mut ws,
            json!({ "call": "apply", "label": { "key": "t" },
                    "ops": [{ "op": "createNode", "id": note, "kind": "note", "name": "A", "net": root, "x": 0, "y": 0 }] }),
        );
        let doc = format!("content/{note}");
        let edited = ask(&mut ws, json!({ "call": "edited", "since": 0 }));
        assert_eq!(edited["edited"], json!({ "seq": 0, "docs": [] }));
        let editor = loro::LoroDoc::new();
        let since = B64.encode(editor.oplog_vv().encode());
        let pulled = ask(
            &mut ws,
            json!({ "call": "pullDoc", "doc": doc, "since": since }),
        );
        assert_eq!(pulled["type"], "updates");
        let bytes = B64
            .decode(pulled["update"].as_str().expect("update"))
            .expect("base64");
        if !bytes.is_empty() {
            editor.import(&bytes).expect("import");
        }
        let bad = ask(
            &mut ws,
            json!({ "call": "pullDoc", "doc": doc, "since": "!" }),
        );
        assert_eq!(bad["invalid"], true);
    }

    #[test]
    fn a_vault_comes_in_through_json() {
        // 13 §3: the browser's files, bytes in base64; one step of undo.
        let mut ws = Workspace::create(MemoryStore::default(), "Root").expect("create");
        let b64 = |s: &str| B64.encode(s.as_bytes());
        let answer = ask(
            &mut ws,
            json!({ "call": "importVault", "name": "Vault", "options": { "unlinked": "Без ссылок" },
                    "files": [{ "path": "A.md", "bytes": b64("[[B]] [[C]]\n") },
                              { "path": "Folder/B.md", "bytes": b64("---\ntags: [x]\n---\nB\n") }] }),
        );
        assert_eq!(answer["type"], "imported", "{answer}");
        assert_eq!(answer["report"]["counts"]["notes"], 2);
        assert_eq!(answer["report"]["counts"]["folders"], 1);
        let codes: Vec<&str> = answer["report"]["items"]
            .as_array()
            .expect("items")
            .iter()
            .filter_map(|i| i["code"].as_str())
            .collect();
        assert_eq!(codes, vec!["noConfig", "ghost"]);
        assert_eq!(answer["history"]["undo"]["key"], "core.change.import");
        let bad = ask(
            &mut ws,
            json!({ "call": "importVault", "name": "x", "files": [{ "path": "a", "bytes": "!" }] }),
        );
        assert_eq!(bad["type"], "error");
    }

    #[test]
    fn errors_come_back_as_answers() {
        let mut ws = Workspace::create(MemoryStore::default(), "Root").expect("create");
        let bad = ask(&mut ws, json!({ "call": "nope" }));
        assert_eq!(bad["type"], "error");
        let refused = ask(
            &mut ws,
            json!({ "call": "apply", "label": { "key": "x" }, "ops": [{ "op": "rename", "id": "0", "name": "x" }] }),
        );
        assert_eq!(
            (refused["type"].as_str(), refused["invalid"].as_bool()),
            (Some("error"), Some(true))
        );
    }
}
