//! Citation / reference-library support for the MCP surface (JP-89 slice 6).
//!
//! A document carries a top-level `references` library — CSL-JSON items keyed
//! by id plus an explicit `itemOrder`, mirroring the TS `ReferenceLibrary`
//! (`src/types/Citation.ts`). It is an ordinary unknown-to-the-Y.Doc top-level
//! field, so it round-trips durably through the snapshot flatten with **zero**
//! relay sync changes (same property the prose-page metadata relies on).
//!
//! This module is split in two halves:
//!   - **pure JSON helpers** (`list_references_json`, `add_references_in_place`)
//!     used by the synchronous `tools::dispatch` under `mutate_with_retry`;
//!   - an **async** `resolve_doi_to_csl` network call (content-negotiation
//!     against `doi.org`), invoked from the async transport layer *before*
//!     dispatch so the sync tool path stays network-free.
//!
//! Formatting (CSL → APA/MLA/… strings) deliberately stays client-side in the
//! editor's lazy citation-js chunk — the relay only ever stores and returns
//! CSL-JSON, never a formatted bibliography. Keeping a CSL engine out of the
//! Rust relay mirrors the SigV4-not-aws-sdk call (MSRV / build-cost).

use std::sync::OnceLock;
use std::time::Duration;

use serde_json::{json, Value};

/// CSL-JSON content type for DOI content negotiation against `doi.org`, which
/// transparently routes to the registration agency (Crossref / DataCite / …).
const CSL_JSON_DOI_ACCEPT: &str = "application/vnd.citationstyles.csl+json";

/// Default CSL item `type` when an ingested item omits one (matches the TS
/// `normalizeItem` fallback).
const DEFAULT_CSL_TYPE: &str = "document";

/// Outcome of an `add_references_in_place` call.
#[derive(Debug)]
pub struct AddOutcome {
    /// Ids of the references actually inserted, in input order.
    pub added: Vec<String>,
    /// Count of incoming items skipped as duplicates (by DOI or id).
    pub duplicates: usize,
}

/// Strip the common DOI prefixes to a bare `10.xxxx/...` form. Mirrors the TS
/// `normalizeDoi` so the relay and editor accept the same shapes.
pub fn normalize_doi(input: &str) -> String {
    let mut s = input.trim();
    // Order matters: URL form, then the `doi:` / `info:doi/` schemes.
    for prefix in ["https://dx.doi.org/", "https://doi.org/", "http://dx.doi.org/", "http://doi.org/"]
    {
        if let Some(rest) = strip_prefix_ci(s, prefix) {
            s = rest;
            break;
        }
    }
    if let Some(rest) = strip_prefix_ci(s, "doi:") {
        s = rest.trim_start();
    } else if let Some(rest) = strip_prefix_ci(s, "info:doi/") {
        s = rest;
    }
    s.trim().to_string()
}

/// Case-insensitive prefix strip.
fn strip_prefix_ci<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    if s.len() >= prefix.len() && s[..prefix.len()].eq_ignore_ascii_case(prefix) {
        Some(&s[prefix.len()..])
    } else {
        None
    }
}

/// A bare DOI looks like `10.<4-9 digits>/<suffix>`. Mirrors the TS guard
/// `^10\.\d{4,9}\//` without pulling in a regex dependency.
pub fn is_valid_doi(bare: &str) -> bool {
    let rest = match bare.strip_prefix("10.") {
        Some(r) => r,
        None => return false,
    };
    let slash = match rest.find('/') {
        Some(i) => i,
        None => return false,
    };
    let registrant = &rest[..slash];
    let suffix = &rest[slash + 1..];
    (4..=9).contains(&registrant.len())
        && registrant.bytes().all(|b| b.is_ascii_digit())
        && !suffix.is_empty()
}

/// Lower-cased DOI for an item, or `None` when absent — DOIs are
/// case-insensitive, matching the TS `doiKey`.
fn doi_key(item: &Value) -> Option<String> {
    item.get("DOI")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_ascii_lowercase())
}

/// Coerce a raw value into a minimally-valid CSL item: must be a JSON object;
/// `id` is set (using `fallback_id` when missing/blank) and `type` defaults to
/// `"document"`. Returns `None` for non-objects. Mirrors the TS `normalizeItem`.
pub fn normalize_item(value: Value, fallback_id: &str) -> Option<Value> {
    let mut obj = match value {
        Value::Object(o) => o,
        _ => return None,
    };
    let has_id = obj
        .get("id")
        .and_then(|v| v.as_str())
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    if !has_id {
        obj.insert("id".into(), json!(fallback_id));
    }
    if !obj.contains_key("type") {
        obj.insert("type".into(), json!(DEFAULT_CSL_TYPE));
    }
    Some(Value::Object(obj))
}

/// The doc's `references` library as a mutable object, creating an empty one
/// (`{items:{}, itemOrder:[]}`) if absent or malformed.
fn references_mut(doc: &mut Value) -> Result<&mut serde_json::Map<String, Value>, String> {
    let root = doc.as_object_mut().ok_or("Document is not an object")?;
    let entry = root
        .entry("references")
        .or_insert_with(|| json!({"items": {}, "itemOrder": []}));
    // Repair a malformed value rather than fail the whole write.
    if !entry.is_object() {
        *entry = json!({"items": {}, "itemOrder": []});
    }
    let refs = entry.as_object_mut().unwrap();
    if !refs.get("items").map(Value::is_object).unwrap_or(false) {
        refs.insert("items".into(), json!({}));
    }
    if !refs.get("itemOrder").map(Value::is_array).unwrap_or(false) {
        refs.insert("itemOrder".into(), json!([]));
    }
    Ok(refs)
}

/// The normalized items to add (after dedup) + how many were skipped.
pub struct AdditionPlan {
    /// `(id, normalized CSL item)` pairs to insert, in input order.
    pub added: Vec<(String, Value)>,
    /// Incoming items skipped as duplicates (by DOI then id).
    pub duplicates: usize,
}

/// Decide which of `incoming` to add to a library whose current items are
/// `existing` (id → CSLItem). Dedups by DOI (case-insensitive) then by id —
/// against `existing` *and* earlier items in the same batch. Pure; shared by the
/// JSON (cold) and live-Y.Doc (resident) write paths so they dedup identically.
/// Mirrors the TS `dedupeReferences`.
pub fn plan_additions(
    existing: &serde_json::Map<String, Value>,
    incoming: &[Value],
) -> Result<AdditionPlan, String> {
    let mut seen_dois: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut seen_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    for (id, item) in existing {
        seen_ids.insert(id.clone());
        if let Some(doi) = doi_key(item) {
            seen_dois.insert(doi);
        }
    }

    let mut added: Vec<(String, Value)> = Vec::new();
    let mut duplicates = 0usize;
    for raw in incoming {
        let item =
            normalize_item(raw.clone(), "").ok_or("a reference was not a CSL-JSON object")?;
        let id = item
            .get("id")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .filter(|s| !s.trim().is_empty())
            .ok_or("a reference is missing an 'id'")?;
        let doi = doi_key(&item);

        let is_dup = doi.as_ref().is_some_and(|d| seen_dois.contains(d)) || seen_ids.contains(&id);
        if is_dup {
            duplicates += 1;
            continue;
        }
        seen_ids.insert(id.clone());
        if let Some(d) = doi {
            seen_dois.insert(d);
        }
        added.push((id, item));
    }
    Ok(AdditionPlan { added, duplicates })
}

/// Upsert `incoming` CSL items into the doc's JSON `references` library (the
/// cold / non-resident path), deduping via [`plan_additions`]; new ids are
/// appended to `itemOrder`. Pure: safe to replay under `mutate_with_retry`.
pub fn add_references_in_place(doc: &mut Value, incoming: &[Value]) -> Result<AddOutcome, String> {
    let existing = doc
        .get("references")
        .and_then(|r| r.get("items"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let plan = plan_additions(&existing, incoming)?;

    let refs = references_mut(doc)?;
    let items = refs.get_mut("items").and_then(Value::as_object_mut).unwrap();
    for (id, item) in &plan.added {
        items.insert(id.clone(), item.clone());
    }
    let order = refs.get_mut("itemOrder").and_then(Value::as_array_mut).unwrap();
    // JP-337: never append an id already present in `itemOrder` (mirrors
    // `set_fields_in_place`). `plan_additions` only yields genuinely-new ids, but
    // guard anyway so a re-run can't grow a duplicate order entry.
    let in_order: std::collections::HashSet<String> =
        order.iter().filter_map(Value::as_str).map(str::to_string).collect();
    for (id, _) in &plan.added {
        if !in_order.contains(id) {
            order.push(json!(id.clone()));
        }
    }

    Ok(AddOutcome {
        added: plan.added.into_iter().map(|(id, _)| id).collect(),
        duplicates: plan.duplicates,
    })
}

/// Build the `list_references` result payload from raw library parts (items map,
/// display order, optional style). Shared by the cold JSON and resident live
/// read paths.
pub fn list_payload(
    items: &serde_json::Map<String, Value>,
    order: &[String],
    style: Option<&str>,
) -> Value {
    let ordered: Vec<Value> = if order.is_empty() {
        items.values().cloned().collect()
    } else {
        // JP-337: dedupe-keep-first so a resident doc whose live `referenceOrder`
        // is already doubled still reports each reference once (mirrors fields).
        crate::sync::dedupe_order(order.iter().map(String::as_str), |id| items.contains_key(id))
            .iter()
            .filter_map(|id| items.get(id).cloned())
            .collect()
    };
    json!({
        "references": ordered,
        "style": style.map(|s| Value::String(s.to_string())).unwrap_or(Value::Null),
        "count": ordered.len(),
    })
}

/// Read the doc's JSON reference library as a result payload (the cold /
/// non-resident path): the CSL items in `itemOrder`, the active `style` (or
/// null), and a count. Tolerant of a missing/empty library.
pub fn list_references_json(doc: &Value) -> Value {
    let refs = doc.get("references");
    let empty = serde_json::Map::new();
    let items = refs.and_then(|r| r.get("items")).and_then(Value::as_object).unwrap_or(&empty);
    let order: Vec<String> = refs
        .and_then(|r| r.get("itemOrder"))
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default();
    let style = refs.and_then(|r| r.get("style")).and_then(Value::as_str);
    list_payload(items, &order, style)
}

/// Shared HTTP client for DOI lookups. Built once; reused across calls.
fn doi_http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .user_agent("docushark-relay (+https://docushark.app)")
            .build()
            .expect("failed to build DOI HTTP client")
    })
}

/// Resolve a single DOI to a CSL-JSON item via `doi.org` content negotiation.
/// Async (network); call this from the transport layer before the sync
/// dispatch. Mirrors the TS `resolveDoi`: never panics, returns a descriptive
/// `Err` on any failure.
pub async fn resolve_doi_to_csl(doi: &str) -> Result<Value, String> {
    let bare = normalize_doi(doi);
    if !is_valid_doi(&bare) {
        return Err(format!("Not a valid DOI: \"{}\"", doi));
    }

    let res = doi_http()
        .get(format!("https://doi.org/{}", bare))
        .header(reqwest::header::ACCEPT, CSL_JSON_DOI_ACCEPT)
        .send()
        .await
        .map_err(|e| format!("DOI lookup failed: {}", e))?;

    if res.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(format!("DOI not found: {}", bare));
    }
    if !res.status().is_success() {
        return Err(format!("DOI lookup failed (HTTP {})", res.status().as_u16()));
    }

    let body: Value = res
        .json()
        .await
        .map_err(|e| format!("DOI response was not JSON: {}", e))?;

    // doi.org CSL-JSON carries `DOI` but usually no `id`; key it off the DOI.
    let fallback_id = body
        .get("DOI")
        .and_then(Value::as_str)
        .unwrap_or(&bare)
        .to_string();
    normalize_item(body, &fallback_id).ok_or_else(|| "DOI response was not a CSL item".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_doi_strips_prefixes() {
        assert_eq!(normalize_doi("  10.1000/xyz  "), "10.1000/xyz");
        assert_eq!(normalize_doi("https://doi.org/10.1000/xyz"), "10.1000/xyz");
        assert_eq!(normalize_doi("HTTPS://DX.DOI.ORG/10.1000/xyz"), "10.1000/xyz");
        assert_eq!(normalize_doi("doi: 10.1000/xyz"), "10.1000/xyz");
        assert_eq!(normalize_doi("info:doi/10.1000/xyz"), "10.1000/xyz");
    }

    #[test]
    fn is_valid_doi_matches_shape() {
        assert!(is_valid_doi("10.1000/xyz"));
        assert!(is_valid_doi("10.12345678/abc.def"));
        assert!(!is_valid_doi("10.1/xyz")); // registrant too short
        assert!(!is_valid_doi("10.1000")); // no slash
        assert!(!is_valid_doi("10.1000/")); // empty suffix
        assert!(!is_valid_doi("notadoi"));
    }

    #[test]
    fn normalize_item_sets_id_and_type() {
        let it = normalize_item(json!({"title": "X"}), "fallback").unwrap();
        assert_eq!(it["id"], json!("fallback"));
        assert_eq!(it["type"], json!("document"));

        let it2 = normalize_item(json!({"id": "keep", "type": "book"}), "fb").unwrap();
        assert_eq!(it2["id"], json!("keep"));
        assert_eq!(it2["type"], json!("book"));

        assert!(normalize_item(json!("not-an-object"), "fb").is_none());
    }

    #[test]
    fn add_references_dedups_by_doi_and_id() {
        let mut doc = json!({"id": "d1"});
        let incoming = vec![
            json!({"id": "a", "DOI": "10.1/AAA", "type": "article-journal"}),
            json!({"id": "b", "DOI": "10.1/bbb"}),
            // duplicate DOI (different case) of "a" — should skip
            json!({"id": "c", "DOI": "10.1/aaa"}),
            // duplicate id of "a" — should skip
            json!({"id": "a", "DOI": "10.1/ddd"}),
        ];
        let out = add_references_in_place(&mut doc, &incoming).unwrap();
        assert_eq!(out.added, vec!["a", "b"]);
        assert_eq!(out.duplicates, 2);

        let refs = &doc["references"];
        assert_eq!(refs["itemOrder"], json!(["a", "b"]));
        assert!(refs["items"].get("a").is_some());
        assert!(refs["items"].get("b").is_some());
        assert_eq!(refs["items"].as_object().unwrap().len(), 2);
    }

    #[test]
    fn add_references_appends_to_existing_library() {
        let mut doc = json!({
            "references": {"items": {"x": {"id": "x", "DOI": "10.1/xxx"}}, "itemOrder": ["x"]}
        });
        let out =
            add_references_in_place(&mut doc, &[json!({"id": "y", "DOI": "10.1/yyy"})]).unwrap();
        assert_eq!(out.added, vec!["y"]);
        assert_eq!(doc["references"]["itemOrder"], json!(["x", "y"]));
    }

    #[test]
    fn add_references_generates_no_id_errors() {
        // An item with a blank id falls back to "" then errors — callers (the
        // DOI path) always supply an id, so this guards the items[] path.
        let mut doc = json!({});
        let err = add_references_in_place(&mut doc, &[json!({"title": "no id"})]).unwrap_err();
        assert!(err.contains("'id'"));
    }

    #[test]
    fn list_references_returns_ordered_items() {
        let doc = json!({
            "references": {
                "items": {"b": {"id": "b"}, "a": {"id": "a"}},
                "itemOrder": ["a", "b"],
                "style": "mla"
            }
        });
        let out = list_references_json(&doc);
        assert_eq!(out["count"], json!(2));
        assert_eq!(out["style"], json!("mla"));
        assert_eq!(out["references"][0]["id"], json!("a"));
        assert_eq!(out["references"][1]["id"], json!("b"));
    }

    #[test]
    fn list_references_empty_when_absent() {
        let out = list_references_json(&json!({"id": "d"}));
        assert_eq!(out["count"], json!(0));
        assert_eq!(out["references"], json!([]));
        assert_eq!(out["style"], Value::Null);
    }

    #[test]
    fn list_references_dedupes_a_doubled_order() {
        // JP-337: a resident doc whose live referenceOrder is already doubled
        // (`[a,b,a,b]`) must still report each reference once.
        let doc = json!({
            "references": {
                "items": {"a": {"id": "a"}, "b": {"id": "b"}},
                "itemOrder": ["a", "b", "a", "b"]
            }
        });
        let out = list_references_json(&doc);
        assert_eq!(out["count"], json!(2), "doubled order reports each reference once");
        assert_eq!(out["references"][0]["id"], json!("a"));
        assert_eq!(out["references"][1]["id"], json!("b"));
    }

    #[test]
    fn add_references_does_not_grow_a_duplicate_order_entry() {
        // JP-337: re-adding an existing id must not append a second order entry.
        let mut doc = json!({
            "references": {"items": {"a": {"id": "a"}}, "itemOrder": ["a"]}
        });
        add_references_in_place(&mut doc, &[json!({"id": "a", "type": "book"})]).unwrap();
        assert_eq!(doc["references"]["itemOrder"], json!(["a"]), "no duplicate order entry");
    }
}
