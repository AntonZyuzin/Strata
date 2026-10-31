//! The core's calls as JSON (15 §2.5 `Backend`): one entry point for every
//! shell. The desktop passes it through a Tauri command, the browser build
//! through WASM; the UI sends the same requests to both (15 §1.4 principle 3).

use crate::changeset::{Label, RevertReport};
use crate::ops::Op;
use crate::store::Store;
use crate::vault::{Vault, VaultFile};
use crate::workspace::{
    Edited, ExternalWire, History, ImportOptions, ImportProgress, NetworkView, NodeDetails, Person,
    Placeable, TrashItem, TrashPreview, TreeItem, WireEnds, Workspace,
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
    /// Copies of nodes in `net`, each at its point, everything inside them
    /// too: `Ctrl+C` → `Ctrl+V` (06 §12.1). One step of undo.
    CopyNodes {
        nodes: Vec<CopyAt>,
        net: String,
        label: Label,
    },
    /// Which of `ids` network `net` may not hold, and which lie in it
    /// already (05 §5 rules 3–4): «⊘» before a drop or a paste.
    Placeable {
        net: String,
        ids: Vec<String>,
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
    /// gives. The import is planned; its batches follow by `importStep`
    /// (13 §3.3), and the workspace takes no other change till its end.
    ImportVault {
        name: String,
        files: Vec<VaultFile>,
        #[serde(default)]
        net: Option<String>,
        #[serde(default)]
        options: ImportOptions,
    },
    /// The import's next batch; the last one gives the report.
    ImportStep,
    /// The import stops and is taken back whole.
    ImportCancel,
    /// Where an import stands, if one is under way.
    ImportProgress,
    /// A long task the app left in the middle (10 §3.3, NFR-71).
    Interrupted,
    /// «Оставить» (`keep`) or «Откатить» what that task wrote.
    SettleInterrupted {
        keep: bool,
    },
}

/// A node to copy and where its copy goes.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CopyAt {
    pub id: String,
    pub x: f64,
    pub y: f64,
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
    /// The copies are made: their ids in the order asked, the undo and redo
    /// steps after them.
    CopiedMany {
        ids: Vec<String>,
        history: History,
    },
    Placeable {
        placeable: Placeable,
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
    /// Where the import stands (13 §3.3): none when there is none; its
    /// report (13 §3.6) once the last batch is in. The undo and redo steps.
    Importing {
        progress: Option<ImportProgress>,
        history: History,
    },
    /// The long task the app left in the middle, if any.
    Interrupted {
        label: Option<Label>,
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
        Request::CopyNodes { nodes, net, label } => {
            let from: Vec<(String, f64, f64)> =
                nodes.into_iter().map(|n| (n.id, n.x, n.y)).collect();
            ws.copy_nodes(&from, &net, &[], label)
                .map(|ids| Response::CopiedMany {
                    ids,
                    history: ws.history(),
                })
        }
        Request::Placeable { net, ids } => ws
            .placeable(&net, &ids)
            .map(|placeable| Response::Placeable { placeable }),
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
        } => ws.import_start(net.as_deref()).and_then(|shadow| {
            let planned = shadow.plan(Vault::from_files(&name, files), &options);
            match planned {
                Ok(p) => ws.import_begin(p).map(|p| importing(ws, Some(p))),
                Err(e) => {
                    ws.import_cancel()?;
                    Err(e)
                }
            }
        }),
        Request::ImportStep => ws.import_step().map(|p| importing(ws, Some(p))),
        Request::ImportCancel => ws.import_cancel().map(|()| Response::History {
            history: ws.history(),
        }),
        Request::ImportProgress => Ok(importing(ws, ws.import_progress())),
        Request::Interrupted => Ok(Response::Interrupted {
            label: ws.interrupted(),
        }),
        Request::SettleInterrupted { keep } => {
            ws.settle_interrupted(keep).map(|()| Response::History {
                history: ws.history(),
            })
        }
    };
    result.unwrap_or_else(|e| Response::Error {
        invalid: matches!(e, crate::CoreError::Invalid(_)),
        message: e.to_string(),
    })
}

fn importing<S: Store>(ws: &Workspace<S>, progress: Option<ImportProgress>) -> Response {
    Response::Importing {
        progress,
        history: ws.history(),
    }
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
    fn a_paste_and_a_drop_ask_the_core_first() {
        // 06 §12.1: `Ctrl+C` → `Ctrl+V` copies in one step; a drop asks
        // what the network may not hold (05 §5 rules 3–4).
        let mut ws = Workspace::create(MemoryStore::default(), "Root").expect("create");
        let root = ws.root();
        let net = strata_model::NodeId::new().to_text();
        let a = strata_model::NodeId::new().to_text();
        ask(
            &mut ws,
            json!({ "call": "apply", "label": { "key": "t" }, "ops": [
                { "op": "createNode", "id": net, "kind": "network", "name": "N", "net": root, "x": 0, "y": 0 },
                { "op": "createNode", "id": a, "kind": "note", "name": "A", "net": root, "x": 0, "y": 0 }] }),
        );
        let p = ask(
            &mut ws,
            json!({ "call": "placeable", "net": net, "ids": [net, a] }),
        );
        assert_eq!(p["type"], "placeable");
        assert_eq!(p["placeable"], json!({ "cycle": [net], "here": [] }));
        let c = ask(
            &mut ws,
            json!({ "call": "copyNodes", "net": net, "label": { "key": "t.copy" },
                    "nodes": [{ "id": a, "x": 5, "y": 6 }] }),
        );
        assert_eq!(c["type"], "copiedMany");
        assert_eq!(c["history"]["undo"]["key"], "t.copy");
        let id = c["ids"][0].as_str().expect("id");
        let view = ask(&mut ws, json!({ "call": "view", "net": net }));
        assert_eq!(view["view"]["nodes"][0]["id"], id);
        assert_eq!(view["view"]["nodes"][0]["x"], 5.0);
    }

    #[test]
    fn a_vault_comes_in_through_json_batch_by_batch() {
        // 13 §3, §3.3: the browser's files, bytes in base64; the import is
        // planned, then written by `importStep`; one step of undo.
        let mut ws = Workspace::create(MemoryStore::default(), "Root").expect("create");
        let b64 = |s: &str| B64.encode(s.as_bytes());
        let started = ask(
            &mut ws,
            json!({ "call": "importVault", "name": "Vault", "options": { "unlinked": "Без ссылок" },
                    "files": [{ "path": "A.md", "bytes": b64("[[B]] [[C]]\n") },
                              { "path": "Folder/B.md", "bytes": b64("---\ntags: [x]\n---\nB\n") }] }),
        );
        assert_eq!(started["type"], "importing", "{started}");
        assert_eq!(started["progress"]["done"], 0);
        assert_eq!(started["progress"]["total"], 2);
        // While it is written, the workspace takes no other change.
        let root = ws.root();
        let refused = ask(
            &mut ws,
            json!({ "call": "apply", "label": { "key": "x" },
                    "ops": [{ "op": "createNode", "kind": "note", "name": "X", "net": root, "x": 0, "y": 0 }] }),
        );
        assert_eq!(refused["type"], "error", "{refused}");
        let mut answer = ask(&mut ws, json!({ "call": "importStep" }));
        while answer["progress"]["report"].is_null() {
            assert_eq!(answer["type"], "importing", "{answer}");
            answer = ask(&mut ws, json!({ "call": "importStep" }));
        }
        let report = &answer["progress"]["report"];
        assert_eq!(answer["progress"]["done"], 2);
        assert_eq!(report["counts"]["notes"], 2);
        assert_eq!(report["counts"]["folders"], 1);
        let codes: Vec<&str> = report["items"]
            .as_array()
            .expect("items")
            .iter()
            .filter_map(|i| i["code"].as_str())
            .collect();
        assert_eq!(codes, vec!["noConfig", "ghost"]);
        assert_eq!(answer["history"]["undo"]["key"], "core.change.import");
        let idle = ask(&mut ws, json!({ "call": "importProgress" }));
        assert!(idle["progress"].is_null(), "{idle}");
        let bad = ask(
            &mut ws,
            json!({ "call": "importVault", "name": "x", "files": [{ "path": "a", "bytes": "!" }] }),
        );
        assert_eq!(bad["type"], "error");
        // A cancelled import takes back what its batches wrote.
        let before = ws.tree().len();
        ask(
            &mut ws,
            json!({ "call": "importVault", "name": "More",
                    "files": [{ "path": "C.md", "bytes": b64("C\n") }] }),
        );
        ask(&mut ws, json!({ "call": "importStep" }));
        let cancelled = ask(&mut ws, json!({ "call": "importCancel" }));
        assert_eq!(cancelled["type"], "history", "{cancelled}");
        assert_eq!(ws.tree().len(), before);
        assert_eq!(cancelled["history"]["undo"]["key"], "core.change.import");
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
