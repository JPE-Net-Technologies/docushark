//! MCP icon catalog (JP-342).
//!
//! Powers `docushark_list_icons`. Agents need valid icon IDs to set on shapes
//! (`iconId`), but the icon library is client-side (TS modules + cloud
//! manifests). The catalog here is **metadata only** — id, name, category, no
//! SVG; the relay never renders icons, the client resolves `iconId` → SVG.
//!
//! The JSON is generated from the client sources by `scripts/gen-icon-catalog.ts`
//! and embedded at compile time via `include_str!` — no runtime file/network
//! dependency. The `query`/`category` filter only ever *matches against* the
//! fixed embedded table, so there's no path-traversal or disk surface.
//! `catalog_drift` (test module) keeps the committed JSON in lockstep with the
//! generator output.

use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::LazyLock;

const CATALOG_JSON: &str = include_str!("icons/catalog.json");

/// One catalog entry. Mirrors the objects emitted by `gen-icon-catalog.ts`.
#[derive(Debug, Deserialize)]
pub struct IconEntry {
    pub id: String,
    pub name: String,
    pub category: String,
}

#[derive(Debug, Deserialize)]
struct Catalog {
    icons: Vec<IconEntry>,
}

static CATALOG: LazyLock<Vec<IconEntry>> = LazyLock::new(|| {
    let parsed: Catalog =
        serde_json::from_str(CATALOG_JSON).expect("embedded icon catalog must be valid JSON");
    parsed.icons
});

/// Default page size for a single `list_icons` call.
pub const DEFAULT_LIMIT: usize = 50;
/// Hard cap — the cloud sets are ~1100 icons, so an unfiltered call must never
/// flood the response.
pub const MAX_LIMIT: usize = 200;

/// Filter the catalog by an optional case-insensitive substring `query` (matched
/// against id + name) and an optional exact `category`, returning at most
/// `limit` (clamped to `MAX_LIMIT`) entries plus the total match count so an
/// agent knows to narrow its search.
pub fn list(query: Option<&str>, category: Option<&str>, limit: usize) -> Value {
    let limit = limit.clamp(1, MAX_LIMIT);
    let q = query
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty());

    let matched: Vec<&IconEntry> = CATALOG
        .iter()
        .filter(|i| category.is_none_or(|c| i.category == c))
        .filter(|i| {
            q.as_ref().is_none_or(|q| {
                i.id.to_lowercase().contains(q) || i.name.to_lowercase().contains(q)
            })
        })
        .collect();

    let total = matched.len();
    let icons: Vec<Value> = matched
        .iter()
        .take(limit)
        .map(|i| json!({ "id": i.id, "name": i.name, "category": i.category }))
        .collect();
    let returned = icons.len();

    json!({
        "icons": icons,
        "returned": returned,
        "total": total,
        "truncated": total > returned,
        "categories": categories(),
        "hint": "Set an icon on a shape via add_shape/update_shape: \
                 { iconId: \"<id>\", iconDisplayMode: \"icon-only\" }.",
    })
}

/// Distinct categories present in the catalog, sorted — lets an agent narrow a
/// search (e.g. `category: \"cloud-aws\"`).
pub fn categories() -> Vec<String> {
    let mut cats: Vec<String> = CATALOG.iter().map(|i| i.category.clone()).collect();
    cats.sort();
    cats.dedup();
    cats
}

/// Whether `id` is a known icon.
pub fn contains(id: &str) -> bool {
    CATALOG.iter().any(|i| i.id == id)
}

/// Number of icons in the catalog.
pub fn count() -> usize {
    CATALOG.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_parses_and_is_nonempty() {
        assert!(count() > 500, "catalog should hold the full icon set");
        // Every entry has the three fields and a builtin: id.
        for icon in CATALOG.iter() {
            assert!(icon.id.starts_with("builtin:"), "bad id: {}", icon.id);
            assert!(!icon.name.is_empty());
            assert!(!icon.category.is_empty());
        }
    }

    #[test]
    fn filters_by_query_and_category_and_caps_results() {
        // Category filter narrows to that set only.
        let aws = list(None, Some("cloud-aws"), MAX_LIMIT);
        assert!(aws["total"].as_u64().unwrap() > 0);
        for i in aws["icons"].as_array().unwrap() {
            assert_eq!(i["category"], "cloud-aws");
        }

        // Limit caps the returned slice but reports the true total.
        let capped = list(None, Some("cloud-aws"), 5);
        assert_eq!(capped["returned"].as_u64().unwrap(), 5);
        assert!(capped["total"].as_u64().unwrap() >= 5);
        assert_eq!(capped["truncated"], json!(true));

        // Query matches id/name case-insensitively.
        let q = list(Some("ARROW"), None, MAX_LIMIT);
        for i in q["icons"].as_array().unwrap() {
            let hay = format!(
                "{} {}",
                i["id"].as_str().unwrap().to_lowercase(),
                i["name"].as_str().unwrap().to_lowercase()
            );
            assert!(hay.contains("arrow"));
        }
    }

    #[test]
    fn empty_query_is_ignored_not_zero_results() {
        let blank = list(Some("   "), None, 10);
        assert!(blank["total"].as_u64().unwrap() > 0);
    }

    #[test]
    fn contains_known_and_rejects_unknown() {
        let first = &CATALOG[0].id;
        assert!(contains(first));
        assert!(!contains("builtin:definitely-not-an-icon-xyz"));
        // No filesystem surface: a traversal-looking id is just a miss.
        assert!(!contains("../../../../etc/passwd"));
    }
}
