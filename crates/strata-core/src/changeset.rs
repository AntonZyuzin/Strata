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

/// A span of a content document's text an operation replaced, by value
/// (10 §9.1 `contentSpans`): reverting writes `before` back where `after`
/// still stands, as a key's value is written back. Edits of one changeset
/// revert in the reverse order they were made: each `at` is a UTF-8 byte
/// offset in the text as it was when that edit was made.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TextEdit {
    /// `content/<id>`.
    pub doc: String,
    pub at: usize,
    pub before: String,
    pub after: String,
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
    /// Texts it edited: the core's own fixes of links (13 §3.5), not an
    /// editor's typing, which has its own undo (05 §11).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub texts: Vec<TextEdit>,
}

/// Keys a revert skipped: someone changed them after the changeset.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct RevertReport {
    pub skipped: Vec<KeyWrite>,
}
