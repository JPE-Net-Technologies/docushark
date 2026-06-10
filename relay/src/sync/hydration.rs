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
use yrs::{Any, Array, Doc, Map, Transact, XmlFragment};

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

/// Seed the live `prose:<id>` `Y.XmlFragment`s from a persisted document's
/// `richTextPages[*].content` HTML (JP-239 follow-up).
///
/// [`json_to_ydoc`] hydrates only the shape surface — prose lives in its own
/// per-page fragments. A document whose prose exists **only in JSON** (e.g. one
/// an MCP agent authored cold and never opened in an editor) therefore hydrated
/// with empty fragments, and a joining editor — which trusts the relay's
/// authoritative `Y.Doc` (JP-34) — rendered blank even though `richTextPages`
/// held the text. Seeding here folds that cold-authored prose into the
/// authoritative state the editor syncs on join.
///
/// **Idempotent — only fills EMPTY fragments.** Both hydration paths call this:
/// the JSON rebuild (a fresh Doc, all fragments empty → seeds all) and, as a
/// backstop (JP-284), the binary-sidecar path. A binary sidecar normally already
/// carries authoritative prose; the per-fragment emptiness check means re-running
/// it there never double-seeds — it only fills a page whose fragment is empty
/// while `richTextPages` has prose (an inconsistent sidecar), so the relay is the
/// single, guaranteed prose seeder. The relay is the single hydrator (JP-34), so
/// the fresh CRDT identity minted here can't diverge across seeders. Uses the
/// same HTML→PM builder as the MCP prose write (JP-238), so the seeded fragment
/// matches what a `set_prose` would have produced.
pub fn json_prose_to_ydoc(doc_json: &Value, doc: &Doc) {
    let Some(pages) = doc_json
        .get("richTextPages")
        .and_then(|r| r.get("pages"))
        .and_then(Value::as_object)
    else {
        return;
    };
    for (id, page) in pages {
        let content = page.get("content").and_then(Value::as_str).unwrap_or("");
        if content.trim().is_empty() {
            continue;
        }
        let blocks = super::prose_parse::html_to_blocks(content);
        // An "empty" page serializes to the placeholder `<p></p>` (the editor's
        // never-truly-empty invariant). Seeding that would leave a spurious empty
        // paragraph that the editor's first real edit then appends after — an
        // empty page must hydrate to an **empty fragment**, matching what a live
        // editor holds. So skip content with no text and no embeds.
        if !blocks.iter().any(block_has_substance) {
            continue;
        }
        // Grab the fragment handle before opening the txn (`get_or_insert_*`
        // transacts; nesting deadlocks).
        let frag = doc.get_or_insert_xml_fragment(format!("prose:{id}").as_str());
        let mut txn = doc.transact_mut();
        // Idempotent backstop (JP-284): only seed an EMPTY fragment. The JSON
        // rebuild path passes a fresh Doc (every fragment empty → seeds all); the
        // binary-hydration backstop may already carry prose for this page, and
        // re-seeding a populated fragment would duplicate it (the JP-282 failure
        // mode). This makes the relay the single, safe prose seeder on both paths.
        if frag.len(&txn) > 0 {
            continue;
        }
        for node in &blocks {
            super::build_prose_node(&frag, &mut txn, node);
        }
    }
}

/// Seed the `references` `Y.Map` (id → CSLItem JSON) + `referenceOrder`
/// `Y.Array` + active citation `style` (in `metadata`) from a persisted
/// document's top-level `references` library (JP-89).
///
/// Like [`json_prose_to_ydoc`], the relay owns the library in the authoritative
/// `Y.Doc` so MCP and editor reference edits converge **per item** (a `Y.Map`
/// merge) instead of clobbering each other a whole field at a time.
///
/// **Idempotent — only seeds an EMPTY map.** Both hydration paths call it: the
/// JSON rebuild (a fresh `Doc` → seeds) and, as a backstop, the binary-sidecar
/// path. A binary sidecar predating this feature carries no `references` map; the
/// emptiness check backfills it from JSON there — guarding the binary-hydration
/// **references wipe** — while never double-seeding a sidecar that already holds
/// the library. Mirrors the JP-284 prose backstop exactly.
pub fn json_references_to_ydoc(doc_json: &Value, doc: &Doc) {
    let references = doc.get_or_insert_map("references");
    let reference_order = doc.get_or_insert_array("referenceOrder");
    let metadata = doc.get_or_insert_map("metadata");

    let mut txn = doc.transact_mut();

    // Idempotent backstop: only seed an empty map (mirrors json_prose_to_ydoc's
    // per-fragment emptiness check). A populated map → the sidecar is
    // authoritative; leave it.
    if references.len(&txn) > 0 {
        return;
    }

    let Some(lib) = doc_json.get("references").and_then(Value::as_object) else {
        return;
    };

    if let Some(items) = lib.get("items").and_then(Value::as_object) {
        for (id, item) in items {
            references.insert(&mut txn, id.clone(), json_to_any(item));
        }
    }
    if let Some(order) = lib.get("itemOrder").and_then(Value::as_array) {
        for id in order.iter().filter_map(Value::as_str) {
            reference_order.push_back(&mut txn, Any::String(id.into()));
        }
    }
    if let Some(style) = lib.get("style").and_then(Value::as_str) {
        metadata.insert(&mut txn, "citationStyle", Any::String(style.into()));
    }
}

/// Whether a parsed prose block carries real content — any non-whitespace text,
/// or an embed (image / horizontal rule). A bare/empty paragraph (the empty-page
/// placeholder) has none, so it isn't seeded.
fn block_has_substance(node: &super::prose_parse::PmNode) -> bool {
    use super::prose_parse::PmChild;
    // Embeds + custom prose-helper atoms (JP-89) are substantial even with no
    // text — a citation-only paragraph or a bibliography block must seed, not be
    // mistaken for the empty-page placeholder.
    if matches!(
        node.node_type.as_str(),
        "image" | "horizontalRule" | "citationInline" | "bibliography"
    ) {
        return true;
    }
    node.children.iter().any(|child| match child {
        PmChild::Text { text, .. } => !text.trim().is_empty(),
        PmChild::Node(inner) => block_has_substance(inner),
    })
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
    use super::{active_page_shape_count, json_references_to_ydoc, json_to_ydoc};
    use serde_json::{json, Value};
    use yrs::{Any, Array, Doc, Map, Transact};

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
    fn json_prose_to_ydoc_seeds_fragments_from_richtextpages() {
        use yrs::XmlFragment;
        let doc = Doc::new();
        super::json_prose_to_ydoc(
            &json!({
                "id": "d",
                "richTextPages": {
                    "pageOrder": ["rt1", "rt2", "rt3"],
                    "pages": {
                        "rt1": {"content": "<p>hello</p><p>world</p>"},
                        "rt2": {"content": ""},
                        "rt3": {"content": "<p></p>"}
                    }
                }
            }),
            &doc,
        );
        let f1 = doc.get_or_insert_xml_fragment("prose:rt1");
        let f2 = doc.get_or_insert_xml_fragment("prose:rt2");
        let f3 = doc.get_or_insert_xml_fragment("prose:rt3");
        let txn = doc.transact();
        // Seeded fragment round-trips to the source HTML via the read serializer.
        assert_eq!(
            super::super::prose_html::fragment_to_html(&f1, &txn),
            "<p>hello</p><p>world</p>"
        );
        // Empty content is not seeded (no spurious empty fragment).
        assert_eq!(f2.len(&txn), 0);
        // The empty-page placeholder `<p></p>` is not seeded either — an empty
        // page must hydrate to an empty fragment, not a stray paragraph.
        assert_eq!(f3.len(&txn), 0);
    }

    #[test]
    fn json_prose_to_ydoc_is_idempotent_only_fills_empty_fragments() {
        // JP-284 backstop invariant: re-running the seeder must NOT duplicate a
        // page whose fragment already has content (the binary-hydration backstop
        // calls it over an already-prose-bearing Doc). It only fills empties.
        let snapshot = json!({
            "id": "d",
            "richTextPages": {
                "pageOrder": ["rt1"],
                "pages": { "rt1": {"content": "<p>hello</p><p>world</p>"} }
            }
        });
        let doc = Doc::new();
        super::json_prose_to_ydoc(&snapshot, &doc); // seeds the empty fragment
        super::json_prose_to_ydoc(&snapshot, &doc); // second pass: fragment non-empty → no-op
        let f1 = doc.get_or_insert_xml_fragment("prose:rt1");
        let txn = doc.transact();
        assert_eq!(
            super::super::prose_html::fragment_to_html(&f1, &txn),
            "<p>hello</p><p>world</p>",
            "re-seeding a populated fragment must not duplicate"
        );
    }

    #[test]
    fn json_prose_to_ydoc_noop_without_richtextpages() {
        use yrs::ReadTxn;
        let doc = Doc::new();
        super::json_prose_to_ydoc(&json!({"id": "d", "name": "x"}), &doc);
        // No prose roots created.
        let txn = doc.transact();
        assert_eq!(
            txn.root_refs().filter(|(n, _)| n.starts_with("prose:")).count(),
            0
        );
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

    // ---- JP-89: reference library seeding ----

    fn lib_json() -> Value {
        json!({
            "id": "d", "name": "x",
            "references": {
                "items": {
                    "knuth1997": {"id": "knuth1997", "type": "book", "DOI": "10.5555/aocp"},
                    "shannon": {"id": "shannon", "type": "article-journal"}
                },
                "itemOrder": ["knuth1997", "shannon"],
                "style": "mla"
            }
        })
    }

    #[test]
    fn json_references_to_ydoc_seeds_map_order_style() {
        let doc = Doc::new();
        json_references_to_ydoc(&lib_json(), &doc);
        let refs = doc.get_or_insert_map("references");
        let order = doc.get_or_insert_array("referenceOrder");
        let meta = doc.get_or_insert_map("metadata");
        let txn = doc.transact();
        assert_eq!(refs.len(&txn), 2);
        assert!(refs.contains_key(&txn, "knuth1997"));
        assert_eq!(order.len(&txn), 2);
        assert!(matches!(meta.get(&txn, "citationStyle"), Some(yrs::Out::Any(Any::String(s))) if s.as_ref() == "mla"));
    }

    #[test]
    fn json_references_to_ydoc_is_idempotent_only_seeds_empty() {
        let doc = Doc::new();
        json_references_to_ydoc(&lib_json(), &doc);
        // Re-run with a DIFFERENT library — a populated map must not be re-seeded.
        json_references_to_ydoc(
            &json!({"references": {"items": {"other": {"id": "other"}}, "itemOrder": ["other"]}}),
            &doc,
        );
        let refs = doc.get_or_insert_map("references");
        let txn = doc.transact();
        assert_eq!(refs.len(&txn), 2, "second seed must be a no-op on a populated map");
        assert!(!refs.contains_key(&txn, "other"));
    }

    #[test]
    fn json_references_to_ydoc_noop_without_references() {
        let doc = Doc::new();
        json_references_to_ydoc(&json!({"id": "d"}), &doc);
        let refs = doc.get_or_insert_map("references");
        assert_eq!(refs.len(&doc.transact()), 0);
    }
}
