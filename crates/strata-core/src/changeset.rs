//! Changesets (05 §11, 10 §9.1): every operation is recorded with its
//! author, time and origin, and with the value of every key it touched
//! before and after. Reverting writes the old value back where the key still
//! holds the new one, and skips (and reports) a key someone changed since.

use crate::value::Val;
use serde::{Deserialize, Serialize};
use strata_model::ChangesetOrigin;

/// One key written by an operation: document, map, key, before and after.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct KeyWrite {
    pub doc: String,
    pub map: String,
    pub key: String,
    pub before: Option<Val>,
    pub after: Option<Val>,
}

/// What the UI shows for a step: a message key of `@strata/i18n` and its
/// parameters, as the prototype's `ChangeLabel`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Label {
    pub key: String,
    #[serde(default, skip_serializing_if = "serde_json::Map::is_empty")]
    pub params: serde_json::Map<String, serde_json::Value>,
}

impl Label {
    pub fn new(key: &str) -> Self {
        Self {
            key: key.to_owned(),
            params: serde_json::Map::new(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Changeset {
    /// UUIDv7, text form.
    pub id: String,
    /// Milliseconds since the Unix epoch.
    pub ts: i64,
    pub origin: ChangesetOrigin,
    pub label: Label,
    /// The changeset this one reverts (an undo), if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reverts: Option<String>,
    pub writes: Vec<KeyWrite>,
}

/// Keys a revert skipped: someone changed them after the changeset.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct RevertReport {
    pub skipped: Vec<KeyWrite>,
}
