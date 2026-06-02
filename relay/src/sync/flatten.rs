//! Flatten an authoritative `Y.Doc` back to the persisted JSON snapshot (JP-36).
//!
//! Inverse of [`super::hydration::json_to_ydoc`]. The Y.Doc is a flat,
//! **active-page-only** surface (`shapes` map + `shapeOrder` array), so we
//! merge those two collections back into the page they were hydrated from
//! (`pages[page_id]`), leaving every other page and all top-level fields
//! untouched. We deliberately do **not** write `name` or other metadata —
//! renames persist via the existing REST path, and clobbering `name` with a
//! possibly-stale Y.Doc `metadata.title` would lose edits.
//!
//! Durability is the relay's job here, but the JSON stays the source format:
//! this is what gets written to disk and served on the next load.

use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Map as JsonMap, Value};
use yrs::types::ToJson;
use yrs::{Any, Doc, Transact};

/// Merge the Y.Doc's `shapes` + `shapeOrder` into `json["pages"][page_id]` and
/// bump `json["modifiedAt"]`. Returns `false` (writing nothing) if the target
/// page object is absent — the caller treats that as a divergence and skips.
pub fn flatten_into(doc: &Doc, page_id: &str, json: &mut Value) -> bool {
    // Grab the shared-type handles *before* opening a read txn — calling
    // `get_or_insert_*` while a txn is live deadlocks.
    let shapes = doc.get_or_insert_map("shapes");
    let shape_order = doc.get_or_insert_array("shapeOrder");

    let (shapes_any, order_any) = {
        let txn = doc.transact();
        (shapes.to_json(&txn), shape_order.to_json(&txn))
    };

    // Merge into the existing page object so the page's own id/name/timestamps
    // survive. Bail (write nothing) if the page is gone.
    {
        let Some(pages) = json.get_mut("pages").and_then(Value::as_object_mut) else {
            return false;
        };
        let Some(page) = pages.get_mut(page_id).and_then(Value::as_object_mut) else {
            return false;
        };
        page.insert("shapes".to_string(), any_to_json(&shapes_any));
        page.insert("shapeOrder".to_string(), any_to_json(&order_any));
    }

    if let Some(obj) = json.as_object_mut() {
        obj.insert("modifiedAt".to_string(), Value::from(now_ms()));
    }
    true
}

/// Convert a yrs `Any` into a `serde_json::Value` — the inverse of
/// `hydration::json_to_any`. Integral numbers are emitted as JSON integers so
/// a shape's `x: 10` round-trips as `10` rather than `10.0`.
fn any_to_json(any: &Any) -> Value {
    match any {
        Any::Null | Any::Undefined => Value::Null,
        Any::Bool(b) => Value::Bool(*b),
        Any::Number(n) => number_to_json(*n),
        Any::BigInt(i) => Value::from(*i),
        Any::String(s) => Value::String(s.to_string()),
        Any::Buffer(bytes) => Value::Array(bytes.iter().map(|b| Value::from(*b)).collect()),
        Any::Array(items) => Value::Array(items.iter().map(any_to_json).collect()),
        Any::Map(map) => {
            let obj: JsonMap<String, Value> = map
                .iter()
                .map(|(k, v)| (k.clone(), any_to_json(v)))
                .collect();
            Value::Object(obj)
        }
    }
}

/// Yjs numbers are all `f64`; emit whole values as JSON integers so they match
/// how the client/JSON stored them, falling back to a float otherwise.
fn number_to_json(n: f64) -> Value {
    if n.is_finite() && n.fract() == 0.0 && n >= i64::MIN as f64 && n <= i64::MAX as f64 {
        Value::from(n as i64)
    } else {
        serde_json::Number::from_f64(n)
            .map(Value::Number)
            .unwrap_or(Value::Null)
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::hydration::json_to_ydoc;
    use serde_json::json;
    use yrs::{Any, Array, Doc, Map, Transact};

    fn multi_page() -> Value {
        json!({
            "id": "doc-1", "name": "Doc", "activePageId": "p1",
            "createdAt": 1, "modifiedAt": 2, "pageOrder": ["p1", "p2"],
            "pages": {
                "p1": {"id": "p1", "name": "One", "shapes": {"s1": {"id": "s1"}}, "shapeOrder": ["s1"]},
                "p2": {"id": "p2", "name": "Two", "shapes": {"s9": {"id": "s9"}}, "shapeOrder": ["s9"]}
            }
        })
    }

    #[test]
    fn flattens_active_page_preserving_others() {
        let doc = Doc::new();
        json_to_ydoc(&multi_page(), &doc);

        // Mutate the live Y.Doc: add a shape with an integer coordinate.
        let shapes = doc.get_or_insert_map("shapes");
        let order = doc.get_or_insert_array("shapeOrder");
        {
            let mut txn = doc.transact_mut();
            let shape = Any::Map(std::sync::Arc::new(std::collections::HashMap::from([
                ("id".to_string(), Any::String("s2".into())),
                ("x".to_string(), Any::Number(10.0)),
            ])));
            shapes.insert(&mut txn, "s2", shape);
            order.push_back(&mut txn, Any::String("s2".into()));
        }

        let mut json = multi_page();
        assert!(flatten_into(&doc, "p1", &mut json));

        let p1 = &json["pages"]["p1"];
        assert!(p1["shapes"].get("s1").is_some(), "kept original shape");
        assert!(p1["shapes"].get("s2").is_some(), "added shape persisted");
        // Integer coordinate round-trips as an integer, not 10.0.
        assert_eq!(p1["shapes"]["s2"]["x"], json!(10));
        assert_eq!(p1["shapeOrder"], json!(["s1", "s2"]));
        assert_eq!(p1["name"], json!("One"), "page's own fields survive");

        // Other page untouched; modifiedAt bumped past the original.
        assert_eq!(json["pages"]["p2"]["shapes"]["s9"]["id"], json!("s9"));
        assert!(json["modifiedAt"].as_u64().unwrap() > 2);
    }

    #[test]
    fn missing_page_skips() {
        let doc = Doc::new();
        json_to_ydoc(&multi_page(), &doc);
        let mut json = multi_page();
        assert!(!flatten_into(&doc, "does-not-exist", &mut json));
        // Nothing written.
        assert_eq!(json["pages"]["p1"]["shapeOrder"], json!(["s1"]));
    }
}
