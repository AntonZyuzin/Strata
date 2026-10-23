//! The core's calls as JSON (15 §2.5 `Backend`): one entry point for every
//! shell. The desktop passes it through a Tauri command, the browser build
//! through WASM; the UI sends the same requests to both (15 §1.4 principle 3).

use crate::changeset::{Label, RevertReport};
use crate::ops::Op;
use crate::store::Store;
use crate::workspace::{History, NetworkView, NodeDetails, Person, TrashItem, TreeItem, Workspace};
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
    Undo,
    Redo,
    /// The last step reverted and forgotten: a gesture cancelled with Esc.
    Cancel,
    History,
    Trash,
    /// A content document for an editor (`content/<id>`).
    OpenDoc {
        doc: String,
    },
    /// An editor's updates of a content document, in base64.
    PushDoc {
        doc: String,
        update: String,
    },
    /// One node for the properties panel.
    Node {
        id: String,
    },
    /// Every network for the «Структура» tree.
    Tree,
    People,
    /// A picture or a file, in base64; answers its SHA-256.
    PutAsset {
        bytes: String,
    },
    Asset {
        sha: String,
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
    /// A content document as a Loro snapshot in base64.
    Doc {
        doc: String,
        snapshot: String,
    },
    /// The updates are stored; `wires` when the note's text wires changed.
    Pushed {
        wires: bool,
    },
    Node {
        node: Box<NodeDetails>,
    },
    Tree {
        items: Vec<TreeItem>,
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
        Request::Node { id } => ws.node_details(&id).map(|node| Response::Node {
            node: Box::new(node),
        }),
        Request::Tree => Ok(Response::Tree { items: ws.tree() }),
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
