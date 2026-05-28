//! In-memory JTI revocation set (JP-77).
//!
//! Backs the `POST /api/v1/internal/revoke` push transport and the
//! `revocation_polling_url` GET fallback documented at
//! `relay/docs/api/revocation.md`. Per spec the set is capped at 1M
//! entries; on overflow, the oldest revocation by `revoked_at` is
//! evicted.

use std::sync::Arc;

use chrono::{DateTime, Utc};
use dashmap::DashMap;
use serde::{Deserialize, Serialize};

const MAX_ENTRIES: usize = 1_000_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Revocation {
    pub jti: String,
    pub revoked_at: DateTime<Utc>,
}

#[derive(Clone, Default)]
pub struct RevocationSet {
    inner: Arc<DashMap<String, DateTime<Utc>>>,
}

impl RevocationSet {
    pub fn new() -> Self {
        Self::default()
    }

    /// Apply a batch atomically by `jti`. Newer `revoked_at` values
    /// replace older ones; duplicates are silently merged.
    pub fn revoke_many(&self, items: &[Revocation]) {
        for r in items {
            self.inner.insert(r.jti.clone(), r.revoked_at);
        }
        self.enforce_cap();
    }

    pub fn is_revoked(&self, jti: &str) -> bool {
        self.inner.contains_key(jti)
    }

    pub fn len(&self) -> usize {
        self.inner.len()
    }

    pub fn is_empty(&self) -> bool {
        self.inner.is_empty()
    }

    /// Return all revocations newer than `since`, sorted ascending.
    /// Used by tests + the optional internal mirror endpoint.
    pub fn since(&self, since: DateTime<Utc>) -> Vec<Revocation> {
        let mut out: Vec<Revocation> = self
            .inner
            .iter()
            .filter_map(|e| {
                let ts = *e.value();
                if ts > since {
                    Some(Revocation { jti: e.key().clone(), revoked_at: ts })
                } else {
                    None
                }
            })
            .collect();
        out.sort_by_key(|r| r.revoked_at);
        out
    }

    fn enforce_cap(&self) {
        let overflow = self.inner.len().saturating_sub(MAX_ENTRIES);
        if overflow == 0 {
            return;
        }
        let mut by_age: Vec<(String, DateTime<Utc>)> = self
            .inner
            .iter()
            .map(|e| (e.key().clone(), *e.value()))
            .collect();
        by_age.sort_by_key(|(_, ts)| *ts);
        for (jti, _) in by_age.into_iter().take(overflow) {
            self.inner.remove(&jti);
        }
        log::warn!(
            "revocation set hit {} cap; evicted {} oldest entries",
            MAX_ENTRIES,
            overflow
        );
    }
}

/// Body shape for the push endpoint + polling response.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RevocationBatch {
    pub revocations: Vec<Revocation>,
    /// Polling responses populate this with the highest `revoked_at`
    /// observed; push requests omit it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_since: Option<DateTime<Utc>>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rev(jti: &str, at: &str) -> Revocation {
        Revocation {
            jti: jti.to_string(),
            revoked_at: DateTime::parse_from_rfc3339(at).unwrap().with_timezone(&Utc),
        }
    }

    #[test]
    fn revoke_and_check() {
        let set = RevocationSet::new();
        set.revoke_many(&[rev("tok_a", "2026-05-25T00:00:00Z")]);
        assert!(set.is_revoked("tok_a"));
        assert!(!set.is_revoked("tok_b"));
    }

    #[test]
    fn since_filters_and_sorts() {
        let set = RevocationSet::new();
        set.revoke_many(&[
            rev("tok_b", "2026-05-25T00:00:02Z"),
            rev("tok_a", "2026-05-25T00:00:01Z"),
            rev("tok_c", "2026-05-25T00:00:03Z"),
        ]);
        let after = set.since(
            DateTime::parse_from_rfc3339("2026-05-25T00:00:01Z")
                .unwrap()
                .with_timezone(&Utc),
        );
        let jtis: Vec<_> = after.iter().map(|r| r.jti.as_str()).collect();
        assert_eq!(jtis, ["tok_b", "tok_c"]);
    }

    #[test]
    fn revoke_is_idempotent() {
        let set = RevocationSet::new();
        let r = rev("tok_a", "2026-05-25T00:00:00Z");
        set.revoke_many(&[r.clone(), r.clone()]);
        assert_eq!(set.len(), 1);
    }
}
