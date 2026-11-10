//! Document settings (DSK-246): the Y.Doc `settings` map and the persisted
//! JSON `settings` object.
//!
//! Every key is carried, known to this build or not, so a new per-document
//! setting (the document font, a page size) needs no relay release. Mirrors
//! `src/collaboration/YjsDocument.ts`: one JSON value per setting, merged per
//! key. Clients write this map, so what the relay keeps is capped at
//! [`MAX_SETTINGS`] keys of at most [`MAX_SETTING_BYTES`] serialized bytes
//! each; anything beyond is dropped and logged.

use serde_json::{Map as JsonMap, Value};
use yrs::types::ToJson;
use yrs::{Doc, Map, Transact};

use super::flatten::any_to_json;
use super::hydration::json_to_any;

/// The most settings a document keeps.
pub(crate) const MAX_SETTINGS: usize = 64;
/// The largest a setting's value may be, serialized as JSON.
pub(crate) const MAX_SETTING_BYTES: usize = 8 * 1024;

/// `settings` within the caps. Oversized values, and keys past the count, are
/// dropped and logged.
fn capped(settings: &JsonMap<String, Value>) -> JsonMap<String, Value> {
    let mut kept = JsonMap::new();
    let mut dropped = 0usize;
    for (key, value) in settings {
        let size = serde_json::to_string(value).map_or(usize::MAX, |s| s.len());
        if kept.len() >= MAX_SETTINGS || size > MAX_SETTING_BYTES {
            dropped += 1;
            continue;
        }
        kept.insert(key.clone(), value.clone());
    }
    if dropped > 0 {
        log::warn!(
            "document settings over the cap: dropped {dropped} of {} (at most {MAX_SETTINGS} keys of {MAX_SETTING_BYTES} bytes)",
            settings.len()
        );
    }
    kept
}

/// Seed the `settings` map from a persisted document's `settings` object.
///
/// **Idempotent — only seeds an EMPTY map**, like the reference and field
/// libraries (`json_fields_to_ydoc`): a populated map means a binary sidecar
/// already carries the settings, and an older sidecar without them gets them
/// from JSON.
pub fn json_settings_to_ydoc(doc_json: &Value, doc: &Doc) {
    // Grab the handle before opening a txn (`get_or_insert_*` inside one deadlocks).
    let settings = doc.get_or_insert_map("settings");
    let mut txn = doc.transact_mut();
    if settings.len(&txn) > 0 {
        return;
    }
    let Some(stored) = doc_json.get("settings").and_then(Value::as_object) else {
        return;
    };
    for (key, value) in capped(stored) {
        settings.insert(&mut txn, key, json_to_any(&value));
    }
}

/// Project the live `settings` map into `json["settings"]`, every key. Never
/// adds `settings` to a document that never had one; an emptied map writes
/// `{}` (every setting removed).
pub fn project_settings_into(doc: &Doc, json: &mut Value) {
    let settings = doc.get_or_insert_map("settings");
    let live = {
        let txn = doc.transact();
        any_to_json(&settings.to_json(&txn))
    };
    let live = live.as_object().cloned().unwrap_or_default();
    if live.is_empty() && json.get("settings").is_none() {
        return;
    }
    if let Some(obj) = json.as_object_mut() {
        obj.insert("settings".to_string(), Value::Object(capped(&live)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn hydrated(body: &Value) -> Doc {
        let doc = Doc::new();
        json_settings_to_ydoc(body, &doc);
        doc
    }

    #[test]
    fn round_trips_every_key_including_unknown_ones() {
        let settings = json!({
            "font": "'Source Serif 4', serif",
            "fromANewerBuild": { "nested": [1, true, null, "x"] },
        });
        let doc = hydrated(&json!({ "settings": settings }));
        let mut out = json!({ "name": "Doc" });
        project_settings_into(&doc, &mut out);
        assert_eq!(out["settings"], settings);
    }

    #[test]
    fn never_adds_settings_to_a_document_without_them() {
        let doc = hydrated(&json!({ "name": "Doc" }));
        let mut out = json!({ "name": "Doc" });
        project_settings_into(&doc, &mut out);
        assert!(out.get("settings").is_none(), "no settings field invented: {out}");
    }

    #[test]
    fn an_emptied_map_writes_an_empty_object() {
        let doc = hydrated(&json!({ "settings": { "font": "Inter, sans-serif" } }));
        {
            let settings = doc.get_or_insert_map("settings");
            let mut txn = doc.transact_mut();
            settings.remove(&mut txn, "font");
        }
        let mut out = json!({ "settings": { "font": "Inter, sans-serif" } });
        project_settings_into(&doc, &mut out);
        assert_eq!(out["settings"], json!({}));
    }

    #[test]
    fn seeds_only_an_empty_map() {
        let doc = hydrated(&json!({ "settings": { "font": "Live, serif" } }));
        json_settings_to_ydoc(&json!({ "settings": { "font": "Stale, serif", "extra": 1 } }), &doc);
        let mut out = json!({});
        project_settings_into(&doc, &mut out);
        assert_eq!(out["settings"], json!({ "font": "Live, serif" }));
    }

    #[test]
    fn ignores_settings_that_are_not_an_object() {
        let doc = hydrated(&json!({ "settings": ["font"] }));
        assert_eq!(doc.get_or_insert_map("settings").len(&doc.transact()), 0);
    }

    #[test]
    fn caps_the_number_of_settings() {
        let many: JsonMap<String, Value> = (0..MAX_SETTINGS + 5).map(|i| (format!("k{i:03}"), json!(i))).collect();
        let doc = hydrated(&json!({ "settings": many }));
        let mut out = json!({});
        project_settings_into(&doc, &mut out);
        assert_eq!(out["settings"].as_object().map(JsonMap::len), Some(MAX_SETTINGS));
    }

    #[test]
    fn drops_an_oversized_value_and_keeps_the_rest() {
        let doc = hydrated(&json!({
            "settings": { "font": "Inter, sans-serif", "huge": "x".repeat(MAX_SETTING_BYTES) },
        }));
        let mut out = json!({});
        project_settings_into(&doc, &mut out);
        assert_eq!(out["settings"], json!({ "font": "Inter, sans-serif" }));
    }
}
