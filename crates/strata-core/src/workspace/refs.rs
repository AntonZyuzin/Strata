//! Which assets the workspace refers to (10 §11): an asset node's file,
//! one's own icon (07 §6.6), an uploaded background (07 §7.1). `strata
//! doctor` and `strata backup verify` look for them in `assets/` (11 §4.1);
//! the garbage collection of assets will count them (10 §11.4).

use super::{Result, Store, Val, Workspace, is_sha256, read, uploaded_icon};
use loro::LoroValue;
use std::collections::BTreeSet;

impl<S: Store> Workspace<S> {
    /// The SHA-256 of every asset the workspace refers to, the trash's too:
    /// a node in the trash comes back with its files.
    pub fn referenced_assets(&mut self) -> Result<BTreeSet<String>> {
        let mut out = BTreeSet::new();
        for shard in self.index_shards() {
            let LoroValue::Map(attrs) = shard.get_map("attr").get_value() else {
                continue;
            };
            for (key, v) in attrs.iter() {
                let Some(text) = Val::from_loro(v).and_then(|v| v.as_str().map(str::to_owned))
                else {
                    continue;
                };
                if key.ends_with("|asset") && is_sha256(&text) {
                    out.insert(text);
                } else if key.ends_with("|icon")
                    && let Some(sha) = uploaded_icon(&text)
                {
                    out.insert(sha.to_owned());
                }
            }
        }
        // Backgrounds, the workspace's in the root's network document.
        let nets: Vec<String> = self
            .store
            .doc_ids()?
            .into_iter()
            .filter(|d| d.starts_with("net/"))
            .collect();
        for net in nets {
            self.ensure_doc(&net)?;
            let source = read(&self.docs[&net], "settings", "background")
                .and_then(|v| v.get("source").and_then(Val::as_str).map(str::to_owned));
            if let Some(sha) = source.as_deref().and_then(|s| s.strip_prefix("asset:"))
                && is_sha256(sha)
            {
                out.insert(sha.to_owned());
            }
        }
        Ok(out)
    }
}
