//! The core's calls as JSON (15 §2.5 `Backend`): one entry point for every
//! shell. The desktop passes it through a Tauri command, the browser build
//! through WASM; the UI sends the same requests to both (15 §1.4 principle 3).

use crate::changeset::{Label, RevertReport};
use crate::ops::Op;
use crate::store::Store;
use crate::workspace::{History, NetworkView, TrashItem, Workspace};
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
    /// Operations as one changeset, one step of undo.
    Apply {
        ops: Vec<Op>,
        label: Label,
    },
    Undo,
    Redo,
    History,
    Trash,
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
    /// The step was taken; the undo and redo steps after it.
    Applied {
        changeset: String,
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
        Request::Apply { ops, label } => ws.apply(&ops, label).map(|c| Response::Applied {
            changeset: c.id,
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
