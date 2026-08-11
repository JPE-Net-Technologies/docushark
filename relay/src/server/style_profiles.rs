//! Per-workspace style-profile registry (`style-profiles.json`).
//!
//! A style profile is a named bag of style values the editor applies to shapes.
//! Profiles are **client-authoritative**: the editor owns them, PUTs the whole
//! set, and the relay stores them so a second device can pull them down. This
//! mirrors the collection-definitions registry (`collections.json`) — same
//! version-wrapper file shape, same optimistic-concurrency handshake, same
//! atomic-write + R2-mirror durability path.
//!
//! **The style bag is deliberately opaque.** `properties` is stored as a
//! verbatim JSON object and never interpreted here. The editor's property set
//! grows every time a new style facet is added (`src/store/styleProfile/`), and
//! a mirrored schema would need a matching relay change each time — a standing
//! drift risk for zero benefit, because the relay makes no decisions from these
//! values. Size is bounded instead of shape: that is the constraint that
//! actually matters for a storage-metered artifact.
//!
//! This module is pure data + validation. The store-coupled accessors live on
//! `DocumentStore` in `documents.rs`, beside their collections siblings.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;

/// One saved style profile. `properties` is an opaque JSON object owned by the
/// editor (see the module note); everything else is registry bookkeeping.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StyleProfileDef {
    pub id: String,
    pub name: String,
    /// Opaque style bag. Stored and returned verbatim.
    pub properties: serde_json::Value,
    pub created_at: u64,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub favorite: bool,
    /// Collections this profile is scoped to. Empty = available workspace-wide.
    /// Ids are not validated against the collection registry: a profile may
    /// legitimately outlive a collection, and a dangling id degrades to "shows
    /// under All" rather than to an error.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub collection_ids: Vec<String>,
}

/// In-memory per-workspace registry: the profiles, a monotonic version bumped
/// on every accepted write (backing the optimistic-concurrency check), and the
/// serialized size of the last persisted file — the workspace's contribution to
/// the `config` share of the storage meter, cached so reads stay O(1).
#[derive(Debug, Clone, Default)]
pub struct StyleProfilesRegistry {
    pub version: u64,
    pub profiles: Vec<StyleProfileDef>,
    pub bytes: u64,
}

/// On-disk shape of `style-profiles.json`: a version wrapper around the set.
/// Unlike `collections.json` there is no legacy bare-array form to accept —
/// this file is versioned from its first write.
#[derive(Debug, Serialize, Deserialize)]
pub struct StyleProfilesFile {
    pub version: u64,
    pub profiles: Vec<StyleProfileDef>,
}

/// Parse `style-profiles.json` content. `None` when it doesn't parse; callers
/// treat that as "leave the in-memory entry alone" — the set is
/// client-authoritative and re-pushed on the next mutation.
pub fn parse_style_profiles_file(data: &str) -> Option<StyleProfilesRegistry> {
    let file = serde_json::from_str::<StyleProfilesFile>(data).ok()?;
    Some(StyleProfilesRegistry {
        version: file.version,
        profiles: file.profiles,
        bytes: data.len() as u64,
    })
}

/// Result of a registry write attempt — mirrors `SetCollectionsOutcome` so the
/// handler maps a conflict to the same 409 wire shape.
#[derive(Debug)]
pub enum SetStyleProfilesOutcome {
    /// The write landed; `version` is the new registry version.
    Updated { version: u64 },
    /// `expectedVersion` didn't match — nothing was written. Carries the current
    /// state so the client can rebase without another GET.
    VersionConflict {
        current_version: u64,
        current: Vec<StyleProfileDef>,
    },
}

/// Registry caps. Generous for interactive use; they bound the sidecar file
/// rather than police how anyone works.
pub const MAX_STYLE_PROFILES_PER_WORKSPACE: usize = 500;
pub const MAX_STYLE_PROFILE_NAME_LEN: usize = 120;
pub const MAX_STYLE_PROFILE_ID_LEN: usize = 64;
pub const MAX_STYLE_PROFILE_COLLECTION_IDS: usize = 64;
/// Per-profile ceiling on the serialized opaque bag. A profile is a flat set of
/// roughly twenty scalars (well under 1 KiB); this leaves generous headroom for
/// multi-icon configurations while keeping one profile from becoming a blob
/// store that bypasses the blob path's own accounting.
pub const MAX_STYLE_PROFILE_PROPERTIES_BYTES: usize = 16 * 1024;

/// Validate + heal an incoming profile set. Duplicate ids are deduped
/// keep-first (a heal for client bugs, matching `dedupe_order`'s posture
/// elsewhere); structural violations are rejected with a technical message the
/// handler surfaces as a 400.
pub fn sanitize_style_profiles(
    profiles: Vec<StyleProfileDef>,
) -> Result<Vec<StyleProfileDef>, String> {
    let mut seen = HashSet::new();
    let mut out = Vec::with_capacity(profiles.len());
    for profile in profiles {
        if !seen.insert(profile.id.clone()) {
            continue;
        }
        if profile.id.is_empty() || profile.id.len() > MAX_STYLE_PROFILE_ID_LEN {
            return Err(format!(
                "style profile id must be 1..={} bytes",
                MAX_STYLE_PROFILE_ID_LEN
            ));
        }
        if profile.name.trim().is_empty()
            || profile.name.chars().count() > MAX_STYLE_PROFILE_NAME_LEN
        {
            return Err(format!(
                "style profile name must be non-empty and at most {} characters",
                MAX_STYLE_PROFILE_NAME_LEN
            ));
        }
        if !profile.properties.is_object() {
            return Err("style profile properties must be a JSON object".to_string());
        }
        let properties_len = serde_json::to_string(&profile.properties)
            .map(|s| s.len())
            .unwrap_or(usize::MAX);
        if properties_len > MAX_STYLE_PROFILE_PROPERTIES_BYTES {
            return Err(format!(
                "style profile properties exceed {} bytes",
                MAX_STYLE_PROFILE_PROPERTIES_BYTES
            ));
        }
        if profile.collection_ids.len() > MAX_STYLE_PROFILE_COLLECTION_IDS {
            return Err(format!(
                "style profile references more than {} collections",
                MAX_STYLE_PROFILE_COLLECTION_IDS
            ));
        }
        if profile
            .collection_ids
            .iter()
            .any(|id| id.is_empty() || id.len() > MAX_STYLE_PROFILE_ID_LEN)
        {
            return Err(format!(
                "style profile collection id must be 1..={} bytes",
                MAX_STYLE_PROFILE_ID_LEN
            ));
        }
        out.push(profile);
    }
    if out.len() > MAX_STYLE_PROFILES_PER_WORKSPACE {
        return Err(format!(
            "workspace exceeds {} style profiles",
            MAX_STYLE_PROFILES_PER_WORKSPACE
        ));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn def(id: &str, name: &str) -> StyleProfileDef {
        StyleProfileDef {
            id: id.to_string(),
            name: name.to_string(),
            properties: json!({ "fill": "#4a90d9", "strokeWidth": 2 }),
            created_at: 1,
            favorite: false,
            collection_ids: vec![],
        }
    }

    #[test]
    fn round_trips_through_the_file_shape() {
        let file = StyleProfilesFile {
            version: 3,
            profiles: vec![def("a", "Dark Neon")],
        };
        let json = serde_json::to_string(&file).unwrap();
        let parsed = parse_style_profiles_file(&json).expect("parses");
        assert_eq!(parsed.version, 3);
        assert_eq!(parsed.profiles.len(), 1);
        assert_eq!(parsed.bytes, json.len() as u64);
    }

    #[test]
    fn preserves_unknown_property_keys_verbatim() {
        // The bag is opaque: a facet the relay has never heard of must survive a
        // store/load cycle untouched, or adding an editor facet silently drops
        // user data on the next sync.
        let mut profile = def("a", "Dark Neon");
        profile.properties = json!({ "somethingInventedLater": { "nested": [1, 2] } });
        let json = serde_json::to_string(&StyleProfilesFile {
            version: 1,
            profiles: vec![profile.clone()],
        })
        .unwrap();
        let parsed = parse_style_profiles_file(&json).expect("parses");
        assert_eq!(parsed.profiles[0].properties, profile.properties);
    }

    #[test]
    fn rejects_a_malformed_file() {
        assert!(parse_style_profiles_file("not json").is_none());
        // A bare array is the *collections* legacy shape, not ours.
        assert!(parse_style_profiles_file("[]").is_none());
    }

    #[test]
    fn dedupes_duplicate_ids_keep_first() {
        let out = sanitize_style_profiles(vec![def("a", "First"), def("a", "Second")]).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].name, "First");
    }

    #[test]
    fn rejects_structural_violations() {
        assert!(sanitize_style_profiles(vec![def("", "Nameless id")]).is_err());
        assert!(sanitize_style_profiles(vec![def("a", "   ")]).is_err());

        let mut non_object = def("a", "Bag");
        non_object.properties = json!("a string, not an object");
        assert!(sanitize_style_profiles(vec![non_object]).is_err());

        let mut oversized = def("a", "Bag");
        oversized.properties = json!({ "blob": "x".repeat(MAX_STYLE_PROFILE_PROPERTIES_BYTES) });
        assert!(sanitize_style_profiles(vec![oversized]).is_err());

        let mut too_many_collections = def("a", "Bag");
        too_many_collections.collection_ids =
            (0..=MAX_STYLE_PROFILE_COLLECTION_IDS).map(|i| i.to_string()).collect();
        assert!(sanitize_style_profiles(vec![too_many_collections]).is_err());
    }

    #[test]
    fn rejects_an_oversized_set() {
        let profiles = (0..=MAX_STYLE_PROFILES_PER_WORKSPACE)
            .map(|i| def(&i.to_string(), "Profile"))
            .collect();
        assert!(sanitize_style_profiles(profiles).is_err());
    }
}
