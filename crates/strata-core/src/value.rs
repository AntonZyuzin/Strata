//! Values of CRDT keys as the core keeps them in changesets (05 §11,
//! 10 §9.1): what a key held before an operation and after it. A plain
//! enum, so changesets serialize without depending on Loro's types.

use loro::LoroValue;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Val {
    Bool(bool),
    Int(i64),
    Float(f64),
    Str(String),
    List(Vec<Val>),
    Map(BTreeMap<String, Val>),
}

impl Val {
    pub fn str(s: impl Into<String>) -> Self {
        Self::Str(s.into())
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Self::Str(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Self::Float(f) => Some(*f),
            Self::Int(i) => Some(*i as f64),
            _ => None,
        }
    }

    pub fn as_i64(&self) -> Option<i64> {
        match self {
            Self::Int(i) => Some(*i),
            _ => None,
        }
    }

    pub fn get(&self, key: &str) -> Option<&Val> {
        match self {
            Self::Map(m) => m.get(key),
            _ => None,
        }
    }

    pub fn map<const N: usize>(pairs: [(&str, Val); N]) -> Self {
        Self::Map(pairs.into_iter().map(|(k, v)| (k.to_owned(), v)).collect())
    }
}

impl From<Val> for LoroValue {
    fn from(v: Val) -> Self {
        match v {
            Val::Bool(b) => LoroValue::Bool(b),
            Val::Int(i) => LoroValue::I64(i),
            Val::Float(f) => LoroValue::Double(f),
            Val::Str(s) => LoroValue::from(s),
            Val::List(l) => LoroValue::from(l.into_iter().map(LoroValue::from).collect::<Vec<_>>()),
            Val::Map(m) => LoroValue::from(
                m.into_iter()
                    .map(|(k, v)| (k, LoroValue::from(v)))
                    .collect::<std::collections::HashMap<_, _>>(),
            ),
        }
    }
}

impl Val {
    /// A Loro value as a `Val`; `None` for null and for containers.
    pub fn from_loro(v: &LoroValue) -> Option<Self> {
        Some(match v {
            LoroValue::Null | LoroValue::Container(_) | LoroValue::Binary(_) => return None,
            LoroValue::Bool(b) => Self::Bool(*b),
            LoroValue::I64(i) => Self::Int(*i),
            LoroValue::Double(f) => Self::Float(*f),
            LoroValue::String(s) => Self::Str(s.to_string()),
            LoroValue::List(l) => Self::List(l.iter().filter_map(Self::from_loro).collect()),
            LoroValue::Map(m) => Self::Map(
                m.iter()
                    .filter_map(|(k, v)| Self::from_loro(v).map(|v| (k.clone(), v)))
                    .collect(),
            ),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn values_survive_loro_and_json() {
        let v = Val::map([
            ("from", Val::str("A")),
            ("at", Val::Int(42)),
            ("pos", Val::List(vec![Val::Float(1.5), Val::Float(-2.0)])),
            ("on", Val::Bool(true)),
        ]);
        let back = Val::from_loro(&LoroValue::from(v.clone())).expect("a value");
        assert_eq!(back, v);
        let json = serde_json::to_string(&v).expect("json");
        assert_eq!(serde_json::from_str::<Val>(&json).expect("parse"), v);
    }
}
