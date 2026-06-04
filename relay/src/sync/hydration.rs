//! Hydrate an authoritative `Y.Doc` from a persisted JSON snapshot (JP-34).
//!
//! The relay Y.Doc must byte-match the client's `YjsDocument`
//! (`src/collaboration/YjsDocument.ts`): a flat, **active-page-only** surface
//! of three shared types —
//!   * `shapes`     — `Y.Map`, each shape stored as a whole JSON value
//!                    (the client does `shapes.set(id, plainObject)`, i.e. a
//!                    JSON/`Any` value, *not* a nested `Y.Map`);
//!   * `shapeOrder` — `Y.Array` of shape-id strings (z-order);
//!   * `metadata`   — `Y.Map` of `{ title, createdAt, updatedAt }`.
//!
//! The persisted document is multi-page; we hydrate the active page
//! (`pages[activePageId]`). Missing/empty pages hydrate an empty doc — never
//! panic on a malformed or partial snapshot.
//!
//! The inverse (Y.Doc → JSON snapshot) is **JP-36** and is intentionally not
//! implemented here.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::Value;
use yrs::{Any, Array, Doc, Map, Transact};

/// Populate `doc`'s `shapes` / `shapeOrder` / `metadata` shared types from the
/// active page of a persisted document JSON body.
pub fn json_to_ydoc(doc_json: &Value, doc: &Doc) {
    let shapes = doc.get_or_insert_map("shapes");
    let shape_order = doc.get_or_insert_array("shapeOrder");
    let metadata = doc.get_or_insert_map("metadata");

    let mut txn = doc.transact_mut();

    // Locate the active page; tolerate any missing piece by hydrating empty.
    let active_page = doc_json
        .get("activePageId")
        .and_then(Value::as_str)
        .zip(doc_json.get("pages").and_then(Value::as_object))
        .and_then(|(active, pages)| pages.get(active));

    if let Some(page) = active_page {
        if let Some(page_shapes) = page.get("shapes").and_then(Value::as_object) {
            for (id, shape) in page_shapes {
                shapes.insert(&mut txn, id.clone(), json_to_any(shape));
            }
        }
        if let Some(order) = page.get("shapeOrder").and_then(Value::as_array) {
            for id in order.iter().filter_map(Value::as_str) {
                shape_order.push_back(&mut txn, Any::String(id.into()));
            }
        }
    }

    // Metadata mirrors YjsDocumentMetadata { title, createdAt, updatedAt }.
    if let Some(name) = doc_json.get("name").and_then(Value::as_str) {
        metadata.insert(&mut txn, "title", Any::String(name.into()));
    }
    if let Some(created) = doc_json.get("createdAt").and_then(Value::as_u64) {
        metadata.insert(&mut txn, "createdAt", Any::Number(created as f64));
    }
    // The client's `updatedAt` corresponds to the document's `modifiedAt`.
    if let Some(modified) = doc_json.get("modifiedAt").and_then(Value::as_u64) {
        metadata.insert(&mut txn, "updatedAt", Any::Number(modified as f64));
    }
}

/// Count the shapes on a persisted document's **active page** — the same flat
/// surface [`json_to_ydoc`] hydrates into the `shapes` map, so it's directly
/// comparable with a `Y.Doc`'s `shapes.len()` (JP-180 poison detection).
/// Returns 0 for any missing/malformed piece (no active id, no pages, no shapes
/// object) — never panics.
pub fn active_page_shape_count(doc_json: &Value) -> usize {
    doc_json
        .get("activePageId")
        .and_then(Value::as_str)
        .zip(doc_json.get("pages").and_then(Value::as_object))
        .and_then(|(active, pages)| pages.get(active))
        .and_then(|page| page.get("shapes"))
        .and_then(Value::as_object)
        .map_or(0, serde_json::Map::len)
}

/// Convert a `serde_json::Value` into a yrs `Any`. Shapes are stored as whole
/// `Any` values (matching the JS side), so this preserves nested objects and
/// arrays. JSON numbers become `f64` — Yjs has no plain integer type, and the
/// client reads them back as JS numbers regardless.
pub(crate) fn json_to_any(value: &Value) -> Any {
    match value {
        Value::Null => Any::Null,
        Value::Bool(b) => Any::Bool(*b),
        Value::Number(n) => Any::Number(n.as_f64().unwrap_or(0.0)),
        Value::String(s) => Any::String(s.as_str().into()),
        Value::Array(items) => {
            let converted: Vec<Any> = items.iter().map(json_to_any).collect();
            Any::Array(converted.into())
        }
        Value::Object(map) => {
            let converted: HashMap<String, Any> = map
                .iter()
                .map(|(k, v)| (k.clone(), json_to_any(v)))
                .collect();
            Any::Map(Arc::new(converted))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{active_page_shape_count, json_to_ydoc};
    use serde_json::{json, Value};
    use yrs::{Array, Doc, Map, Transact};

    #[test]
    fn active_page_shape_count_counts_active_page_only() {
        let doc = multi_page_doc(); // active page p1 has 2 shapes, p2 has 1
        assert_eq!(active_page_shape_count(&doc), 2);
    }

    #[test]
    fn active_page_shape_count_tolerates_malformed() {
        assert_eq!(active_page_shape_count(&json!({"id": "d"})), 0, "no pages");
        assert_eq!(
            active_page_shape_count(&json!({"activePageId": "p1", "pages": {}})),
            0,
            "active id with no matching page"
        );
        assert_eq!(
            active_page_shape_count(
                &json!({"activePageId": "p1", "pages": {"p1": {"shapeOrder": []}}})
            ),
            0,
            "page with no shapes object"
        );
    }

    fn multi_page_doc() -> Value {
        json!({
            "id": "doc-1",
            "name": "Sample",
            "createdAt": 1000,
            "modifiedAt": 2000,
            "pageOrder": ["p1", "p2"],
            "activePageId": "p1",
            "pages": {
                "p1": {
                    "id": "p1",
                    "shapes": {
                        "s1": {"id": "s1", "type": "rectangle", "x": 1.0, "y": 2.0},
                        "s2": {"id": "s2", "type": "ellipse"}
                    },
                    "shapeOrder": ["s1", "s2"]
                },
                "p2": {
                    "id": "p2",
                    "shapes": {"s9": {"id": "s9"}},
                    "shapeOrder": ["s9"]
                }
            }
        })
    }

    #[test]
    fn hydrates_active_page_only() {
        let doc = Doc::new();
        json_to_ydoc(&multi_page_doc(), &doc);

        let shapes = doc.get_or_insert_map("shapes");
        let order = doc.get_or_insert_array("shapeOrder");
        let meta = doc.get_or_insert_map("metadata");
        let txn = doc.transact();

        assert_eq!(shapes.len(&txn), 2, "only the active page's shapes");
        assert!(shapes.contains_key(&txn, "s1"));
        assert!(shapes.contains_key(&txn, "s2"));
        assert!(!shapes.contains_key(&txn, "s9"), "must not pull other pages");
        assert_eq!(order.len(&txn), 2);

        assert!(meta.contains_key(&txn, "title"));
        assert!(meta.contains_key(&txn, "createdAt"));
        assert!(meta.contains_key(&txn, "updatedAt"));
    }

    #[test]
    fn empty_active_page_hydrates_empty() {
        let doc = Doc::new();
        json_to_ydoc(
            &json!({"id": "d", "name": "x", "activePageId": "p1",
                    "pages": {"p1": {"shapes": {}, "shapeOrder": []}}}),
            &doc,
        );
        // Grab the shared-type handles before opening a read txn — calling
        // `get_or_insert_*` while a txn is live deadlocks (it transacts).
        let shapes = doc.get_or_insert_map("shapes");
        let order = doc.get_or_insert_array("shapeOrder");
        let txn = doc.transact();
        assert_eq!(shapes.len(&txn), 0);
        assert_eq!(order.len(&txn), 0);
    }

    #[test]
    fn tolerates_missing_pages_and_active_id() {
        // A malformed/partial snapshot must hydrate empty, never panic.
        let doc = Doc::new();
        json_to_ydoc(&json!({"id": "d", "name": "x"}), &doc);
        let shapes = doc.get_or_insert_map("shapes");
        let meta = doc.get_or_insert_map("metadata");
        let txn = doc.transact();
        assert_eq!(shapes.len(&txn), 0);
        // metadata still hydrated from the top-level fields.
        assert!(meta.contains_key(&txn, "title"));
    }
}
