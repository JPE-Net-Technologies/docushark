//! Document Fields — pure JSON helpers for the MCP `set_fields` / `list_fields`
//! tools (Phase 3c). Mirrors `citations.rs`: the cold (non-resident) write/read
//! paths operate directly on the document JSON, while the resident path goes
//! through the live `Y.Doc` (`DocHandle::insert_fields` / `fields_json`).
//!
//! Storage shape (the v1 client + MCP wire contract):
//! `doc["fields"] = { "fields": { "<name>": {"name": "<name>", "value": "<value>"} },
//!                    "order": ["<name>", …] }`.
//!
//! Keep this free of network / serde-struct coupling — plain `serde_json::Value`
//! mutation so it's safe to replay under `mutate_with_retry`.

use serde_json::{json, Value};

/// One field to set (upsert), as supplied by the `set_fields` tool.
pub struct FieldSet {
    pub name: String,
    pub value: String,
}

/// The names written by a `set_fields` call + how many were newly created.
pub struct SetOutcome {
    /// Names written (added or updated), in input order.
    pub set: Vec<String>,
    /// Of those, the names that did not previously exist.
    pub added: Vec<String>,
}

/// The doc's `fields` library as a mutable object, creating an empty one
/// (`{fields:{}, order:[]}`) if absent or malformed. Mirrors `references_mut`.
fn fields_mut(doc: &mut Value) -> Result<&mut serde_json::Map<String, Value>, String> {
    let root = doc.as_object_mut().ok_or("Document is not an object")?;
    let entry = root.entry("fields").or_insert_with(|| json!({"fields": {}, "order": []}));
    // Repair a malformed value rather than fail the whole write.
    if !entry.is_object() {
        *entry = json!({"fields": {}, "order": []});
    }
    let lib = entry.as_object_mut().unwrap();
    if !lib.get("fields").map(Value::is_object).unwrap_or(false) {
        lib.insert("fields".into(), json!({}));
    }
    if !lib.get("order").map(Value::is_array).unwrap_or(false) {
        lib.insert("order".into(), json!([]));
    }
    Ok(lib)
}

/// Upsert `incoming` fields into the doc's JSON `fields` library (the cold /
/// non-resident path); new names are appended to `order`. Pure: safe to replay
/// under `mutate_with_retry`. Re-setting an existing name updates its value in
/// place with no duplicate `order` entry.
pub fn set_fields_in_place(doc: &mut Value, incoming: &[FieldSet]) -> Result<SetOutcome, String> {
    let lib = fields_mut(doc)?;

    // Snapshot the existing names so we can report which were newly added and
    // avoid duplicate order entries (borrow the map sections one at a time).
    let existing: std::collections::HashSet<String> = lib
        .get("fields")
        .and_then(Value::as_object)
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default();

    let items = lib.get_mut("fields").and_then(Value::as_object_mut).unwrap();
    let mut set = Vec::with_capacity(incoming.len());
    let mut added = Vec::new();
    for f in incoming {
        items.insert(f.name.clone(), json!({"name": f.name, "value": f.value}));
        set.push(f.name.clone());
        if !existing.contains(&f.name) {
            added.push(f.name.clone());
        }
    }

    let order = lib.get_mut("order").and_then(Value::as_array_mut).unwrap();
    let in_order: std::collections::HashSet<String> =
        order.iter().filter_map(Value::as_str).map(str::to_string).collect();
    for name in &added {
        if !in_order.contains(name) {
            order.push(json!(name));
        }
    }

    Ok(SetOutcome { set, added })
}

/// Build the `list_fields` result payload from raw library parts (the fields map
/// + display order). Shared by the cold JSON and resident live read paths.
pub fn list_payload(items: &serde_json::Map<String, Value>, order: &[String]) -> Value {
    let ordered: Vec<Value> = if order.is_empty() {
        items.values().cloned().collect()
    } else {
        // JP-337: dedupe-keep-first so a resident doc whose live `fieldOrder` is
        // already doubled (a dual-origin merge that hasn't re-flattened yet) still
        // reports each field once. `dedupe_order`'s `present` predicate also drops
        // orphans, matching the `items.get` filter below.
        crate::sync::dedupe_order(order.iter().map(String::as_str), |name| items.contains_key(name))
            .iter()
            .filter_map(|name| items.get(name).cloned())
            .collect()
    };
    json!({
        "fields": ordered,
        "count": ordered.len(),
    })
}

/// Read the doc's JSON field library as a result payload (the cold /
/// non-resident path): the fields in `order`, plus a count. Tolerant of a
/// missing/empty library.
pub fn list_fields_json(doc: &Value) -> Value {
    let lib = doc.get("fields");
    let empty = serde_json::Map::new();
    let items = lib.and_then(|l| l.get("fields")).and_then(Value::as_object).unwrap_or(&empty);
    let order: Vec<String> = lib
        .and_then(|l| l.get("order"))
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default();
    list_payload(items, &order)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(name: &str, value: &str) -> FieldSet {
        FieldSet { name: name.to_string(), value: value.to_string() }
    }

    #[test]
    fn set_fields_creates_library_and_appends_order() {
        let mut doc = json!({"id": "d"});
        let out = set_fields_in_place(&mut doc, &[set("Company", "Acme"), set("Version", "2.0")]).unwrap();
        assert_eq!(out.set, vec!["Company", "Version"]);
        assert_eq!(out.added, vec!["Company", "Version"]);
        assert_eq!(doc["fields"]["fields"]["Company"]["value"], "Acme");
        assert_eq!(doc["fields"]["order"], json!(["Company", "Version"]));
    }

    #[test]
    fn set_fields_updates_value_without_duplicating_order() {
        let mut doc = json!({"id": "d", "fields": {"fields": {"Company": {"name": "Company", "value": "Acme"}}, "order": ["Company"]}});
        let out = set_fields_in_place(&mut doc, &[set("Company", "Globex")]).unwrap();
        assert_eq!(out.added, Vec::<String>::new());
        assert_eq!(doc["fields"]["fields"]["Company"]["value"], "Globex");
        assert_eq!(doc["fields"]["order"], json!(["Company"]));
    }

    #[test]
    fn set_fields_repairs_a_malformed_library() {
        let mut doc = json!({"id": "d", "fields": "garbage"});
        set_fields_in_place(&mut doc, &[set("A", "1")]).unwrap();
        assert_eq!(doc["fields"]["fields"]["A"]["value"], "1");
        assert_eq!(doc["fields"]["order"], json!(["A"]));
    }

    #[test]
    fn list_fields_returns_ordered_payload() {
        let doc = json!({"id": "d", "fields": {"fields": {"B": {"name": "B", "value": "2"}, "A": {"name": "A", "value": "1"}}, "order": ["A", "B"]}});
        let payload = list_fields_json(&doc);
        assert_eq!(payload["count"], 2);
        assert_eq!(payload["fields"][0]["name"], "A");
        assert_eq!(payload["fields"][1]["name"], "B");
    }

    #[test]
    fn list_fields_dedupes_a_doubled_order() {
        // JP-337: a resident doc whose live fieldOrder is already doubled
        // (`[A,B,A,B]`) must still report each field once.
        let doc = json!({"id": "d", "fields": {
            "fields": {"A": {"name": "A", "value": "1"}, "B": {"name": "B", "value": "2"}},
            "order": ["A", "B", "A", "B"]
        }});
        let payload = list_fields_json(&doc);
        assert_eq!(payload["count"], 2, "doubled order reports each field once");
        assert_eq!(payload["fields"][0]["name"], "A");
        assert_eq!(payload["fields"][1]["name"], "B");
    }

    #[test]
    fn list_fields_tolerates_missing_library() {
        let payload = list_fields_json(&json!({"id": "d"}));
        assert_eq!(payload["count"], 0);
        assert_eq!(payload["fields"], json!([]));
    }
}
