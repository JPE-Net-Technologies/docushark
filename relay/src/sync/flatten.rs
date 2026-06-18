//! Flatten an authoritative `Y.Doc` back to the persisted JSON snapshot (JP-36).
//!
//! Inverse of [`super::hydration::json_to_ydoc`]. The Y.Doc is a flat,
//! **active-page-only** surface (`shapes` map + `shapeOrder` array), so we
//! merge those two collections back into the page they were hydrated from
//! (`pages[page_id]`), leaving every other page untouched.
//!
//! Document **`name`** is also written back from the Y.Doc `metadata.title`
//! (CRDT-native rename): renames now propagate through the CRDT like shapes, so
//! the relay must flatten them. To avoid clobbering an out-of-band REST rename
//! (which bumps `modifiedAt` without touching the Y.Doc) with a stale
//! `metadata.title`, we only adopt the title when its `metadata.updatedAt` is at
//! least as new as the stored `modifiedAt`. All other top-level fields are left
//! untouched.
//!
//! Durability is the relay's job here, but the JSON stays the source format:
//! this is what gets written to disk and served on the next load.

use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Map as JsonMap, Value};
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
    let metadata = doc.get_or_insert_map("metadata");

    let (shapes_any, order_any, meta_any) = {
        let txn = doc.transact();
        (
            shapes.to_json(&txn),
            shape_order.to_json(&txn),
            metadata.to_json(&txn),
        )
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
        // JP-330: dedupe-keep-first + drop orphans so a live array doubled by a
        // dual-origin merge persists clean — the stored doc self-heals here.
        let present = |id: &str| match &shapes_any {
            Any::Map(m) => m.contains_key(id),
            _ => false,
        };
        let order_ids = match &order_any {
            Any::Array(arr) => arr
                .iter()
                .filter_map(|a| match a {
                    Any::String(s) => Some(s.as_ref()),
                    _ => None,
                })
                .collect::<Vec<&str>>(),
            _ => Vec::new(),
        };
        let deduped = super::dedupe_order(order_ids, present);
        page.insert(
            "shapeOrder".to_string(),
            Value::Array(deduped.into_iter().map(Value::String).collect()),
        );
    }

    // CRDT-native rename: adopt `metadata.title` as the document `name`, but
    // only when its `updatedAt` is at least as fresh as the currently-stored
    // `modifiedAt`. A REST rename bumps `modifiedAt` (now) without touching the
    // Y.Doc, so a stale title (older `updatedAt`) is left alone; a CRDT rename
    // bumps `updatedAt` past the last persisted write and wins. Read the stored
    // `modifiedAt` BEFORE we overwrite it below.
    let stored_modified = json.get("modifiedAt").and_then(Value::as_u64).unwrap_or(0);
    let (meta_title, meta_updated) = metadata_title_and_updated(&meta_any);
    if let Some(title) = meta_title {
        if !title.is_empty() && meta_updated.unwrap_or(0) >= stored_modified {
            if let Some(obj) = json.as_object_mut() {
                obj.insert("name".to_string(), Value::String(title));
            }
        }
    }

    if let Some(obj) = json.as_object_mut() {
        obj.insert("modifiedAt".to_string(), Value::from(now_ms()));
    }
    true
}

/// Extract `(title, updatedAt)` from the Y.Doc `metadata` map's JSON form.
/// `updatedAt` is a Yjs number (`f64` ms) coerced to `u64` for comparison with
/// the JSON `modifiedAt`.
fn metadata_title_and_updated(meta_any: &Any) -> (Option<String>, Option<u64>) {
    let Any::Map(map) = meta_any else {
        return (None, None);
    };
    let title = match map.get("title") {
        Some(Any::String(s)) => Some(s.to_string()),
        _ => None,
    };
    let updated = match map.get("updatedAt") {
        Some(Any::Number(n)) if n.is_finite() && *n >= 0.0 => Some(*n as u64),
        _ => None,
    };
    (title, updated)
}

/// Project live prose pages (`(page_id, html)`, from the Y.Doc `prose:*`
/// fragments) into `json["richTextPages"]` (JP-201 Slice 3). A **read
/// projection only**: it overlays each live page's `content` (creating the
/// `richTextPages` structure + a default entry for a live-only page) and
/// preserves any existing `name`/`order` (that metadata isn't CRDT-synced).
/// This write projection pairs with [`super::hydration::json_prose_to_ydoc`],
/// which seeds the Y.Doc *from* `richTextPages` on a JSON rebuild — so prose
/// survives a full evict/rehydrate cycle even without a binary sidecar (the
/// sidecar is still preferred when present, preserving CRDT identity).
///
/// No-op when there's no live prose, so a shape-only flatten leaves any
/// existing (e.g. MCP-authored) `richTextPages` untouched.
pub fn project_prose_into(pages: &[(String, String)], json: &mut Value) {
    if pages.is_empty() {
        return;
    }
    let now = now_ms();
    let Some(obj) = json.as_object_mut() else {
        return;
    };
    let rtp = obj
        .entry("richTextPages")
        .or_insert_with(|| json!({"pages": {}, "pageOrder": []}));
    let Some(rtp) = rtp.as_object_mut() else {
        return;
    };

    // Content overlay (create a default entry for a live-only page).
    let pages_map = rtp.entry("pages").or_insert_with(|| json!({}));
    if let Some(pages_map) = pages_map.as_object_mut() {
        for (i, (id, html)) in pages.iter().enumerate() {
            let page = pages_map
                .entry(id.clone())
                .or_insert_with(|| json!({"id": id, "name": "Untitled", "order": i, "createdAt": now}));
            if let Some(page) = page.as_object_mut() {
                page.entry("id").or_insert_with(|| Value::String(id.clone()));
                page.insert("content".to_string(), Value::String(html.clone()));
                page.insert("modifiedAt".to_string(), Value::from(now));
            }
        }
    }

    // Ensure each live page id appears in `pageOrder` (append unknowns; keep the
    // existing order — names/order are owned by the client, best-effort here).
    let order = rtp.entry("pageOrder").or_insert_with(|| json!([]));
    if let Some(order) = order.as_array_mut() {
        for (id, _) in pages {
            if !order.iter().any(|v| v.as_str() == Some(id.as_str())) {
                order.push(Value::String(id.clone()));
            }
        }
    }
}

/// Project the live reference library — `references` `Y.Map` (id → CSLItem) +
/// `referenceOrder` `Y.Array` + `metadata.citationStyle` — into
/// `json["references"] = {items, itemOrder, style}` (JP-89). The write
/// projection paired with [`super::hydration::json_references_to_ydoc`]: the
/// relay owns the library in the authoritative `Y.Doc`, so every flatten
/// re-asserts the merged set. An empty map writes an empty library (a real
/// "all deleted"), **except** we never synthesize a `references` field for a doc
/// that never had one (pre-JP-89 back-compat).
pub fn project_references_into(doc: &Doc, json: &mut Value) {
    let references = doc.get_or_insert_map("references");
    let reference_order = doc.get_or_insert_array("referenceOrder");
    let metadata = doc.get_or_insert_map("metadata");

    let (refs_any, order_any, meta_any) = {
        let txn = doc.transact();
        (references.to_json(&txn), reference_order.to_json(&txn), metadata.to_json(&txn))
    };

    let items = any_to_json(&refs_any);
    let is_empty = items.as_object().map(JsonMap::is_empty).unwrap_or(true);
    // Back-compat: leave a doc that never had a library without one.
    if is_empty && json.get("references").is_none() {
        return;
    }

    let style = match &meta_any {
        Any::Map(m) => match m.get("citationStyle") {
            Some(Any::String(s)) => Some(s.to_string()),
            _ => None,
        },
        _ => None,
    };

    if let Some(obj) = json.as_object_mut() {
        let mut lib = JsonMap::new();
        lib.insert("items".to_string(), items);
        lib.insert("itemOrder".to_string(), any_to_json(&order_any));
        if let Some(style) = style {
            lib.insert("style".to_string(), Value::String(style));
        }
        obj.insert("references".to_string(), Value::Object(lib));
    }
}

/// Project the live field library — `fields` `Y.Map` (name → Field) +
/// `fieldOrder` `Y.Array` — into `json["fields"] = {fields, order}` (Phase 3c).
/// The write projection paired with [`super::hydration::json_fields_to_ydoc`]:
/// the relay owns the library in the authoritative `Y.Doc`, so every flatten
/// re-asserts the merged set. An empty map writes an empty library (a real "all
/// deleted"), **except** we never synthesize a `fields` field for a doc that
/// never had one (back-compat for pre-Phase-3 documents).
pub fn project_fields_into(doc: &Doc, json: &mut Value) {
    let fields = doc.get_or_insert_map("fields");
    let field_order = doc.get_or_insert_array("fieldOrder");

    let (fields_any, order_any) = {
        let txn = doc.transact();
        (fields.to_json(&txn), field_order.to_json(&txn))
    };

    let items = any_to_json(&fields_any);
    let is_empty = items.as_object().map(JsonMap::is_empty).unwrap_or(true);
    // Back-compat: leave a doc that never had a library without one.
    if is_empty && json.get("fields").is_none() {
        return;
    }

    if let Some(obj) = json.as_object_mut() {
        let mut lib = JsonMap::new();
        lib.insert("fields".to_string(), items);
        lib.insert("order".to_string(), any_to_json(&order_any));
        obj.insert("fields".to_string(), Value::Object(lib));
    }
}

/// Convert a yrs `Any` into a `serde_json::Value` — the inverse of
/// `hydration::json_to_any`. Integral numbers are emitted as JSON integers so
/// a shape's `x: 10` round-trips as `10` rather than `10.0`.
pub(crate) fn any_to_json(any: &Any) -> Value {
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

    /// JP-330 self-heal: a live `shapeOrder` doubled by a dual-origin merge
    /// flattens to a deduped (keep-first) order with orphans dropped, so the
    /// persisted JSON — the canonical stored copy — is always clean.
    #[test]
    fn jp330_flatten_dedupes_doubled_order() {
        let doc = Doc::new();
        let shapes = doc.get_or_insert_map("shapes");
        let order = doc.get_or_insert_array("shapeOrder");
        {
            let mut txn = doc.transact_mut();
            for id in ["s1", "s2"] {
                shapes.insert(
                    &mut txn,
                    id,
                    Any::Map(std::sync::Arc::new(std::collections::HashMap::from([(
                        "id".to_string(),
                        Any::String(id.into()),
                    )]))),
                );
            }
            // Doubled order + an orphan id with no backing shape.
            for id in ["s1", "s2", "s1", "s2", "ghost"] {
                order.push_back(&mut txn, Any::String(id.into()));
            }
        }

        let mut json = json!({"pages": {"p1": {"id": "p1", "name": "One"}}, "modifiedAt": 0});
        assert!(flatten_into(&doc, "p1", &mut json));
        assert_eq!(
            json["pages"]["p1"]["shapeOrder"],
            json!(["s1", "s2"]),
            "deduped keep-first; 'ghost' orphan dropped"
        );
    }

    #[test]
    fn crdt_rename_flattens_to_name() {
        let doc = Doc::new();
        json_to_ydoc(&multi_page(), &doc); // metadata.title="Doc", updatedAt=2

        // Simulate a CRDT rename: a fresher metadata.title + updatedAt.
        let metadata = doc.get_or_insert_map("metadata");
        {
            let mut txn = doc.transact_mut();
            metadata.insert(&mut txn, "title", Any::String("Renamed".into()));
            metadata.insert(&mut txn, "updatedAt", Any::Number(100.0));
        }

        let mut json = multi_page(); // name="Doc", modifiedAt=2
        assert!(flatten_into(&doc, "p1", &mut json));
        assert_eq!(json["name"], json!("Renamed"), "CRDT rename is flattened into name");
    }

    #[test]
    fn stale_title_does_not_clobber_rest_rename() {
        let doc = Doc::new();
        json_to_ydoc(&multi_page(), &doc); // metadata.title="Doc", updatedAt=2

        // The stored doc was renamed out-of-band (REST): a fresher modifiedAt
        // than the Y.Doc title's updatedAt. The stale CRDT title must not win.
        let mut json = multi_page();
        json["name"] = json!("RestName");
        json["modifiedAt"] = json!(1000);
        assert!(flatten_into(&doc, "p1", &mut json));
        assert_eq!(json["name"], json!("RestName"), "stale title did not clobber the REST rename");
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

    #[test]
    fn projects_prose_content_preserving_metadata() {
        let mut json = json!({
            "id": "d",
            "richTextPages": {
                "pageOrder": ["rt1"],
                "pages": {"rt1": {"id": "rt1", "name": "Page 1", "order": 0, "content": "<p></p>"}}
            }
        });
        project_prose_into(&[("rt1".to_string(), "<p>typed</p>".to_string())], &mut json);
        assert_eq!(json["richTextPages"]["pages"]["rt1"]["content"], "<p>typed</p>");
        assert_eq!(json["richTextPages"]["pages"]["rt1"]["name"], "Page 1", "name preserved");
        assert_eq!(json["richTextPages"]["pageOrder"], json!(["rt1"]));
    }

    #[test]
    fn projects_live_only_page_with_defaults() {
        let mut json = json!({"id": "d"}); // no richTextPages at all
        project_prose_into(&[("rtX".to_string(), "<p>new</p>".to_string())], &mut json);
        assert_eq!(json["richTextPages"]["pages"]["rtX"]["content"], "<p>new</p>");
        assert_eq!(json["richTextPages"]["pages"]["rtX"]["name"], "Untitled");
        assert_eq!(json["richTextPages"]["pageOrder"], json!(["rtX"]));
    }

    #[test]
    fn empty_prose_is_a_noop() {
        let mut json = json!({
            "id": "d",
            "richTextPages": {"pageOrder": ["rt1"], "pages": {"rt1": {"content": "<p>keep</p>"}}}
        });
        project_prose_into(&[], &mut json);
        assert_eq!(json["richTextPages"]["pages"]["rt1"]["content"], "<p>keep</p>");
    }

    // ---- JP-89: reference library projection ----

    fn doc_with_refs() -> Doc {
        use yrs::{Array, Map};
        let doc = Doc::new();
        let refs = doc.get_or_insert_map("references");
        let order = doc.get_or_insert_array("referenceOrder");
        let meta = doc.get_or_insert_map("metadata");
        let mut txn = doc.transact_mut();
        refs.insert(&mut txn, "knuth1997", super::super::hydration::json_to_any(&json!({"id": "knuth1997", "type": "book"})));
        order.push_back(&mut txn, Any::String("knuth1997".into()));
        meta.insert(&mut txn, "citationStyle", Any::String("chicago".into()));
        drop(txn);
        doc
    }

    #[test]
    fn project_references_round_trips_items_order_style() {
        let doc = doc_with_refs();
        let mut json = json!({"id": "d"});
        project_references_into(&doc, &mut json);
        assert_eq!(json["references"]["itemOrder"], json!(["knuth1997"]));
        assert_eq!(json["references"]["items"]["knuth1997"]["type"], json!("book"));
        assert_eq!(json["references"]["style"], json!("chicago"));
    }

    #[test]
    fn project_references_skips_synthesizing_for_pre_jp89_docs() {
        // Empty Y.Doc library + a doc that never had a `references` field → leave
        // it absent (back-compat), never write an empty library.
        let doc = Doc::new();
        let mut json = json!({"id": "d"});
        project_references_into(&doc, &mut json);
        assert!(json.get("references").is_none());
    }

    #[test]
    fn project_references_writes_empty_on_full_deletion() {
        // A doc that HAD a library, now emptied in the Y.Doc → write the empty set
        // (a real "all deleted"), not the stale JSON.
        let doc = Doc::new();
        let mut json = json!({"id": "d", "references": {"items": {"x": {"id": "x"}}, "itemOrder": ["x"]}});
        project_references_into(&doc, &mut json);
        assert_eq!(json["references"]["items"], json!({}));
        assert_eq!(json["references"]["itemOrder"], json!([]));
    }

    // ---- Phase 3c: field library projection ----

    fn doc_with_fields() -> Doc {
        use yrs::{Array, Map};
        let doc = Doc::new();
        let fields = doc.get_or_insert_map("fields");
        let order = doc.get_or_insert_array("fieldOrder");
        let mut txn = doc.transact_mut();
        fields.insert(&mut txn, "Company", super::super::hydration::json_to_any(&json!({"name": "Company", "value": "Acme"})));
        order.push_back(&mut txn, Any::String("Company".into()));
        drop(txn);
        doc
    }

    #[test]
    fn project_fields_round_trips_fields_and_order() {
        let doc = doc_with_fields();
        let mut json = json!({"id": "d"});
        project_fields_into(&doc, &mut json);
        assert_eq!(json["fields"]["order"], json!(["Company"]));
        assert_eq!(json["fields"]["fields"]["Company"]["value"], json!("Acme"));
    }

    #[test]
    fn project_fields_skips_synthesizing_for_pre_phase3_docs() {
        let doc = Doc::new();
        let mut json = json!({"id": "d"});
        project_fields_into(&doc, &mut json);
        assert!(json.get("fields").is_none());
    }

    #[test]
    fn project_fields_writes_empty_on_full_deletion() {
        let doc = Doc::new();
        let mut json = json!({"id": "d", "fields": {"fields": {"X": {"name": "X", "value": "1"}}, "order": ["X"]}});
        project_fields_into(&doc, &mut json);
        assert_eq!(json["fields"]["fields"], json!({}));
        assert_eq!(json["fields"]["order"], json!([]));
    }
}
