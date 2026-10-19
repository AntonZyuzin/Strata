//! Identifiers (05 §4.1, 10 §2.5).
//!
//! Every entity id is a UUIDv7: 16 bytes, time-ordered, generated offline.
//! The single text form is 26 characters of Crockford base32 (the ULID
//! alphabet); UUID text with hyphens is accepted on input.

use std::fmt;
use std::marker::PhantomData;
use std::str::FromStr;

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use thiserror::Error;

/// Crockford base32 alphabet (no I, L, O, U).
const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// Length of the canonical text form.
pub const TEXT_LEN: usize = 26;

/// Encodes 16 bytes as 26 Crockford base32 characters (big-endian, like ULID).
pub fn encode_base32(bytes: &[u8; 16]) -> String {
    let value = u128::from_be_bytes(*bytes);
    let mut out = String::with_capacity(TEXT_LEN);
    for i in 0..TEXT_LEN {
        let shift = 125 - 5 * i as u32;
        let digit = ((value >> shift) & 0x1f) as usize;
        out.push(ALPHABET[digit] as char);
    }
    out
}

fn decode_digit(c: u8) -> Option<u8> {
    let c = c.to_ascii_uppercase();
    let v = match c {
        b'0' | b'O' => 0,
        b'1' | b'I' | b'L' => 1,
        b'2'..=b'9' => c - b'0',
        b'A'..=b'H' => c - b'A' + 10,
        b'J' | b'K' => c - b'J' + 18,
        b'M' | b'N' => c - b'M' + 20,
        b'P'..=b'T' => c - b'P' + 22,
        b'V'..=b'Z' => c - b'V' + 27,
        _ => return None,
    };
    Some(v)
}

/// Decodes 26 Crockford base32 characters into 16 bytes.
pub fn decode_base32(text: &str) -> Result<[u8; 16], IdParseError> {
    let raw = text.as_bytes();
    if raw.len() != TEXT_LEN {
        return Err(IdParseError::Length(raw.len()));
    }
    let mut value: u128 = 0;
    for (i, &c) in raw.iter().enumerate() {
        let d = decode_digit(c).ok_or(IdParseError::Character(c as char))?;
        if i == 0 && d > 7 {
            // 26 × 5 = 130 bits; the first digit may carry only 3 bits.
            return Err(IdParseError::Overflow);
        }
        value = (value << 5) | u128::from(d);
    }
    Ok(value.to_be_bytes())
}

/// Error returned when an id cannot be parsed.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum IdParseError {
    #[error("id must be 26 base32 characters or a UUID, got {0} characters")]
    Length(usize),
    #[error("invalid character {0:?} in id")]
    Character(char),
    #[error("id is out of the 128-bit range")]
    Overflow,
    #[error("invalid UUID: {0}")]
    Uuid(String),
}

/// A typed 16-byte identifier. `T` is a zero-sized marker for the entity.
pub struct Id<T> {
    bytes: [u8; 16],
    _marker: PhantomData<fn() -> T>,
}

impl<T> Id<T> {
    /// A new UUIDv7 for the current time.
    pub fn new() -> Self {
        Self::from_bytes(*uuid::Uuid::now_v7().as_bytes())
    }

    pub const fn from_bytes(bytes: [u8; 16]) -> Self {
        Self {
            bytes,
            _marker: PhantomData,
        }
    }

    pub const fn as_bytes(&self) -> &[u8; 16] {
        &self.bytes
    }

    /// Canonical text form: 26 Crockford base32 characters.
    pub fn to_text(&self) -> String {
        encode_base32(&self.bytes)
    }

    /// Accepts the canonical form (any case, Crockford aliases) or a UUID
    /// (hyphenated, simple, braced or URN).
    pub fn parse(text: &str) -> Result<Self, IdParseError> {
        let text = text.trim();
        if text.len() == TEXT_LEN {
            return decode_base32(text).map(Self::from_bytes);
        }
        uuid::Uuid::try_parse(text)
            .map(|u| Self::from_bytes(*u.as_bytes()))
            .map_err(|e| match text.len() {
                32 | 36 | 38 | 45 => IdParseError::Uuid(e.to_string()),
                n => IdParseError::Length(n),
            })
    }
}

impl<T> Default for Id<T> {
    fn default() -> Self {
        Self::new()
    }
}

impl<T> Clone for Id<T> {
    fn clone(&self) -> Self {
        *self
    }
}
impl<T> Copy for Id<T> {}

impl<T> PartialEq for Id<T> {
    fn eq(&self, other: &Self) -> bool {
        self.bytes == other.bytes
    }
}
impl<T> Eq for Id<T> {}

impl<T> PartialOrd for Id<T> {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}
impl<T> Ord for Id<T> {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.bytes.cmp(&other.bytes)
    }
}

impl<T> std::hash::Hash for Id<T> {
    fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
        self.bytes.hash(state);
    }
}

impl<T> fmt::Display for Id<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_text())
    }
}

impl<T> fmt::Debug for Id<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{}({})",
            std::any::type_name::<T>()
                .rsplit("::")
                .next()
                .unwrap_or("Id"),
            self
        )
    }
}

impl<T> FromStr for Id<T> {
    type Err = IdParseError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::parse(s)
    }
}

impl<T> Serialize for Id<T> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_text())
    }
}

impl<'de, T> Deserialize<'de> for Id<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let s = String::deserialize(deserializer)?;
        Self::parse(&s).map_err(serde::de::Error::custom)
    }
}

macro_rules! id_kind {
    ($($(#[$doc:meta])* $marker:ident => $alias:ident;)*) => {$(
        $(#[$doc])*
        #[derive(Debug)]
        pub enum $marker {}
        $(#[$doc])*
        pub type $alias = Id<$marker>;
    )*};
}

id_kind! {
    /// A node (05 §4).
    Node => NodeId;
    /// A workspace (05 §3).
    Workspace => WorkspaceId;
    /// A changeset (05 §11, 10 §9.1).
    Changeset => ChangesetId;
    /// A dot on a wire (05 §9.2).
    Dot => DotId;
    /// A network box (05 §9.2).
    NetworkBox => NetworkBoxId;
    /// A sticky note (05 §9.2).
    StickyNote => StickyNoteId;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base32_roundtrip_edges() {
        for bytes in [[0u8; 16], [0xff; 16], {
            let mut b = [0u8; 16];
            b[15] = 1;
            b
        }] {
            let text = encode_base32(&bytes);
            assert_eq!(text.len(), TEXT_LEN);
            assert_eq!(decode_base32(&text).unwrap(), bytes);
        }
        assert_eq!(encode_base32(&[0xff; 16]), "7ZZZZZZZZZZZZZZZZZZZZZZZZZ");
        assert_eq!(encode_base32(&[0; 16]), "00000000000000000000000000");
    }

    #[test]
    fn new_ids_roundtrip_and_sort_by_time() {
        let a = NodeId::new();
        let b = NodeId::new();
        assert_eq!(NodeId::parse(&a.to_text()).unwrap(), a);
        assert!(a <= b, "UUIDv7 must be time-ordered");
        assert!(a.to_text() <= b.to_text(), "text form must sort like bytes");
    }

    #[test]
    fn accepts_uuid_and_crockford_aliases() {
        let id = NodeId::parse("0192f3a4-7c1e-7b2a-9d40-5e6f7a8b9c0d").unwrap();
        let text = id.to_text();
        assert_eq!(NodeId::parse(&text.to_lowercase()).unwrap(), id);
        let aliased = text.replace('0', "O").replace('1', "l");
        assert_eq!(NodeId::parse(&aliased).unwrap(), id);
        assert_eq!(
            NodeId::parse("0192f3a47c1e7b2a9d405e6f7a8b9c0d").unwrap(),
            id
        );
    }

    #[test]
    fn rejects_bad_input() {
        assert_eq!(NodeId::parse("abc"), Err(IdParseError::Length(3)));
        assert_eq!(
            NodeId::parse("8ZZZZZZZZZZZZZZZZZZZZZZZZZ"),
            Err(IdParseError::Overflow)
        );
        assert!(matches!(
            NodeId::parse("0000000000000000000000000U"),
            Err(IdParseError::Character('U'))
        ));
    }

    #[test]
    fn serde_uses_text_form() {
        let id = NodeId::parse("0192f3a4-7c1e-7b2a-9d40-5e6f7a8b9c0d").unwrap();
        let json = serde_json::to_string(&id).unwrap();
        assert_eq!(json, format!("\"{}\"", id.to_text()));
        let back: NodeId = serde_json::from_str(&json).unwrap();
        assert_eq!(back, id);
    }
}
