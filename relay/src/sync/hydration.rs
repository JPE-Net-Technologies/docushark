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
        // JP-330 once-gate (mirrors `json_references_to_ydoc`/`json_fields_to_ydoc`):
        // only seed shapes + order into an EMPTY surface. Re-hydrating a populated
        // Y.Doc would otherwise `push_back` the whole `shapeOrder` again — the
        // shapes map dedupes by key, but the `shapeOrder` Y.Array (a sequence)
        // does not, so it doubles.
        if shapes.len(&txn) == 0 {
            let page_shapes = page.get("shapes").and_then(Value::as_object);
            if let Some(ps) = page_shapes {
                for (id, shape) in ps {
                    shapes.insert(&mut txn, id.clone(), json_to_any(shape));
                }
            }
            if let Some(order) = page.get("shapeOrder").and_then(Value::as_array) {
                // Dedupe + orphan-drop the source too, so an already-doubled
                // source JSON / binary sidecar hydrates clean.
                let present = |id: &str| page_shapes.is_some_and(|m| m.contains_key(id));
                for id in super::dedupe_order(order.iter().filter_map(Value::as_str), present) {
                    shape_order.push_back(&mut txn, Any::String(id.as_str().into()));
                }
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
        // Self-heal on hydration (JP-328): validate + normalize the parsed tree
        // before seeding, so a doc whose stored prose carries a malformed node
        // (e.g. an older, pre-gate write) comes back renderable instead of
        // crashing the editor — no manual snapshot surgery needed.
        let (blocks, fixes) =
            super::prose_validate::sanitize_blocks(super::prose_parse::html_to_blocks(content));
        if !fixes.is_empty() {
            log::info!(
                "prose_validate self-healed {} defect(s) hydrating prose:{id}: {fixes:?}",
                fixes.len()
            );
        }
        // An "empty" page serializes to the placeholder `<p></p>` (the editor's
        // never-truly-empty invariant). Seeding that would leave a spurious empty
        // paragraph that the editor's first real edit then appends after — an
        // empty page must hydrate to an **empty fragment**, matching what a live
        // editor holds. So skip content with no text and no embeds.
        if !blocks.iter().any(block_has_substance) {
            continue;
        }
        // Idempotent backstop (JP-284): only seed an EMPTY fragment. The JSON
        // rebuild path passes a fresh Doc (every fragment empty → seeds all); the
        // binary-hydration backstop may already carry prose for this page, and
        // re-seeding a populated fragment would clobber a live-edited / sidecar-
        // restored lineage. (`get_or_insert_*` transacts, so check `len` under
        // its own read txn — nesting a live txn deadlocks.)
        let frag = doc.get_or_insert_xml_fragment(format!("prose:{id}").as_str());
        if frag.len(&doc.transact()) > 0 {
            continue;
        }
        // Deterministic seed (JP-319): identical content yields byte-identical
        // CRDT items, so a later rehydrate — or a client carrying the prior
        // bootstrap in y-indexeddb — DEDUPES on merge instead of doubling the
        // page (CRDT lineage churn). Replaces the previous random-clientID build.
        super::seed_prose_deterministic(doc, id, &blocks);
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

    let items = lib.get("items").and_then(Value::as_object);
    if let Some(items) = items {
        for (id, item) in items {
            references.insert(&mut txn, id.clone(), json_to_any(item));
        }
    }
    if let Some(order) = lib.get("itemOrder").and_then(Value::as_array) {
        // JP-337: dedupe-keep-first + drop orphans (mirrors `json_to_ydoc` shapes).
        // `referenceOrder` is a Y.Array with no LWW semantics, so an already-doubled
        // source `itemOrder` would otherwise hydrate doubled.
        let present = |id: &str| items.is_some_and(|m| m.contains_key(id));
        for id in super::dedupe_order(order.iter().filter_map(Value::as_str), present) {
            reference_order.push_back(&mut txn, Any::String(id.as_str().into()));
        }
    }
    if let Some(style) = lib.get("style").and_then(Value::as_str) {
        metadata.insert(&mut txn, "citationStyle", Any::String(style.into()));
    }
}

/// Seed the `fields` `Y.Map` (name → Field JSON) + `fieldOrder` `Y.Array` from a
/// persisted document's top-level `fields` library (Phase 3c). The relay owns the
/// library in the authoritative `Y.Doc` so MCP and editor field edits converge
/// **per item** (a `Y.Map` merge) instead of clobbering a whole field at a time.
///
/// JSON shape is `doc["fields"] = { fields: {name→{name,value}}, order: [...] }`
/// (the v1 client shape). **Idempotent — only seeds an EMPTY map** (mirrors
/// [`json_references_to_ydoc`] / the prose backstop): a populated map means the
/// sidecar is authoritative, so leave it; an older sidecar with no `fields` map
/// gets it backfilled from JSON.
pub fn json_fields_to_ydoc(doc_json: &Value, doc: &Doc) {
    let fields = doc.get_or_insert_map("fields");
    let field_order = doc.get_or_insert_array("fieldOrder");

    let mut txn = doc.transact_mut();

    if fields.len(&txn) > 0 {
        return;
    }

    let Some(lib) = doc_json.get("fields").and_then(Value::as_object) else {
        return;
    };

    let items = lib.get("fields").and_then(Value::as_object);
    if let Some(items) = items {
        for (name, field) in items {
            fields.insert(&mut txn, name.clone(), json_to_any(field));
        }
    }
    if let Some(order) = lib.get("order").and_then(Value::as_array) {
        // JP-337: dedupe-keep-first + drop orphans (mirrors `json_to_ydoc` shapes).
        // `fieldOrder` is a Y.Array with no LWW semantics, so an already-doubled
        // source `order` would otherwise hydrate doubled (set_fields 9 → 18).
        let present = |name: &str| items.is_some_and(|m| m.contains_key(name));
        for name in super::dedupe_order(order.iter().filter_map(Value::as_str), present) {
            field_order.push_back(&mut txn, Any::String(name.as_str().into()));
        }
    }
}

/// Seed the `prosePages` `Y.Map` (id → page metadata) + `prosePageOrder`
/// `Y.Array` from a persisted document's `richTextPages.{pages,pageOrder}`
/// (JP-339). The relay owns the prose page LIST in the authoritative `Y.Doc` so
/// MCP and editor tab edits (add/rename/reorder/delete) converge **per item** and
/// surface live — no reload (which was the JP-338 dup trigger).
///
/// Metadata ONLY — the per-page `content` is **stripped** here; it lives in the
/// `prose:<id>` fragment ([`json_prose_to_ydoc`]) and must not be double-owned.
///
/// **Idempotent — only seeds an EMPTY map** (mirrors [`json_fields_to_ydoc`] /
/// [`json_references_to_ydoc`]): a populated map means the sidecar is
/// authoritative, so leave it; an older sidecar with no `prosePages` map gets it
/// backfilled from JSON. The order is deduped (JP-337) so an already-doubled
/// source `pageOrder` hydrates clean.
pub fn json_prose_pages_to_ydoc(doc_json: &Value, doc: &Doc) {
    let prose_pages = doc.get_or_insert_map("prosePages");
    let prose_page_order = doc.get_or_insert_array("prosePageOrder");

    let mut txn = doc.transact_mut();

    if prose_pages.len(&txn) > 0 {
        return;
    }

    let Some(rtp) = doc_json.get("richTextPages") else {
        return;
    };
    let pages = rtp.get("pages").and_then(Value::as_object);
    if let Some(pages) = pages {
        for (id, page) in pages {
            prose_pages.insert(&mut txn, id.clone(), prose_page_meta_any(id, page));
        }
    }
    if let Some(order) = rtp.get("pageOrder").and_then(Value::as_array) {
        let present = |id: &str| pages.is_some_and(|m| m.contains_key(id));
        for id in super::dedupe_order(order.iter().filter_map(Value::as_str), present) {
            prose_page_order.push_back(&mut txn, Any::String(id.as_str().into()));
        }
    }
}

/// Build the CRDT `Any::Map` for one prose page's metadata — every field of the
/// stored page object EXCEPT `content` (which is owned by the `prose:<id>`
/// fragment). Guarantees an `id`. Mirrors the client's `ProsePageMeta`.
pub(super) fn prose_page_meta_any(id: &str, page: &Value) -> Any {
    let mut map: HashMap<String, Any> = HashMap::new();
    if let Some(obj) = page.as_object() {
        for (k, v) in obj {
            if k == "content" {
                continue;
            }
            map.insert(k.clone(), json_to_any(v));
        }
    }
    map.entry("id".to_string())
        .or_insert_with(|| Any::String(id.into()));
    Any::Map(Arc::new(map))
}

/// Seed the `canvasPages` `Y.Map` (id → page metadata) + `canvasPageOrder`
/// `Y.Array` from a persisted document's top-level `pages` + `pageOrder`
/// (JP-339). The relay owns the canvas page LIST in the authoritative `Y.Doc` so
/// MCP and editor tab edits (add/rename/reorder/delete) converge **per item** and
/// surface live — no reload.
///
/// Metadata ONLY — `shapes`/`shapeOrder` are **stripped**; only the active page's
/// shapes live in the Y.Doc `shapes` surface ([`json_to_ydoc`]), and a non-active
/// page's shapes stay in JSON (the JP-34 active-page-only limitation). The page
/// list must not double-own them.
///
/// **Idempotent — only seeds an EMPTY map** (mirrors [`json_fields_to_ydoc`]).
/// The order is deduped (JP-337).
pub fn json_canvas_pages_to_ydoc(doc_json: &Value, doc: &Doc) {
    let canvas_pages = doc.get_or_insert_map("canvasPages");
    let canvas_page_order = doc.get_or_insert_array("canvasPageOrder");

    let mut txn = doc.transact_mut();

    if canvas_pages.len(&txn) > 0 {
        return;
    }

    let pages = doc_json.get("pages").and_then(Value::as_object);
    if let Some(pages) = pages {
        for (id, page) in pages {
            canvas_pages.insert(&mut txn, id.clone(), canvas_page_meta_any(id, page));
        }
    }
    if let Some(order) = doc_json.get("pageOrder").and_then(Value::as_array) {
        let present = |id: &str| pages.is_some_and(|m| m.contains_key(id));
        for id in super::dedupe_order(order.iter().filter_map(Value::as_str), present) {
            canvas_page_order.push_back(&mut txn, Any::String(id.as_str().into()));
        }
    }
}

/// Build the CRDT `Any::Map` for one canvas page's metadata — every field of the
/// stored page object EXCEPT `shapes`/`shapeOrder` (owned by the active-page
/// `shapes` surface / the JSON snapshot). Guarantees an `id`. Mirrors the
/// client's `CanvasPageMeta`.
pub(super) fn canvas_page_meta_any(id: &str, page: &Value) -> Any {
    let mut map: HashMap<String, Any> = HashMap::new();
    if let Some(obj) = page.as_object() {
        for (k, v) in obj {
            if k == "shapes" || k == "shapeOrder" {
                continue;
            }
            map.insert(k.clone(), json_to_any(v));
        }
    }
    map.entry("id".to_string())
        .or_insert_with(|| Any::String(id.into()));
    Any::Map(Arc::new(map))
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
        "image" | "horizontalRule" | "citationInline" | "bibliography" | "fieldRef"
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
    fn jp328_json_prose_to_ydoc_self_heals_malformed_content() {
        // The hydration self-heal arm of the JP-328 gate: a doc whose stored
        // `richTextPages` HTML carries a malformed node (a src-less <img> atom,
        // which crashes the client's NodeView reconciliation) must hydrate to a
        // SANE fragment — the cold/JSON path heals on load, not just new writes.
        let doc = Doc::new();
        super::json_prose_to_ydoc(
            &json!({
                "id": "d",
                "richTextPages": {
                    "pageOrder": ["rt1"],
                    "pages": { "rt1": {"content": "<p>before<img>after</p>"} }
                }
            }),
            &doc,
        );
        let f1 = doc.get_or_insert_xml_fragment("prose:rt1");
        let txn = doc.transact();
        let html = super::super::prose_html::fragment_to_html(&f1, &txn);
        assert!(
            !html.contains("<img"),
            "hydration must drop the src-less image atom, got: {html}"
        );
        assert!(html.contains("beforeafter"), "surrounding text must survive: {html}");
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

    /// JP-337: an already-doubled `itemOrder` (`[a,b,a,b]`) plus an orphan must
    /// hydrate to a deduped keep-first `referenceOrder` — not double the array.
    #[test]
    fn json_references_to_ydoc_dedupes_doubled_order() {
        let doc = Doc::new();
        json_references_to_ydoc(
            &json!({
                "references": {
                    "items": {"knuth1997": {"id": "knuth1997"}, "shannon": {"id": "shannon"}},
                    "itemOrder": ["knuth1997", "shannon", "knuth1997", "shannon", "ghost"]
                }
            }),
            &doc,
        );
        let order = doc.get_or_insert_array("referenceOrder");
        let txn = doc.transact();
        assert_eq!(order.len(&txn), 2, "doubled order + orphan hydrates to 2");
    }

    fn fields_json() -> Value {
        json!({
            "id": "d",
            "fields": {
                "fields": {
                    "Company": {"name": "Company", "value": "Acme"},
                    "Version": {"name": "Version", "value": "2.0"}
                },
                "order": ["Company", "Version"]
            }
        })
    }

    #[test]
    fn json_fields_to_ydoc_seeds_map_and_order() {
        let doc = Doc::new();
        super::json_fields_to_ydoc(&fields_json(), &doc);
        let fields = doc.get_or_insert_map("fields");
        let order = doc.get_or_insert_array("fieldOrder");
        let txn = doc.transact();
        assert_eq!(fields.len(&txn), 2);
        assert!(fields.contains_key(&txn, "Company"));
        assert_eq!(order.len(&txn), 2);
    }

    /// JP-337: an already-doubled `order` (the persisted set_fields 9 → 18 shape)
    /// plus an orphan hydrates to a deduped keep-first `fieldOrder`.
    #[test]
    fn json_fields_to_ydoc_dedupes_doubled_order() {
        let doc = Doc::new();
        super::json_fields_to_ydoc(
            &json!({
                "fields": {
                    "fields": {"Company": {"name": "Company", "value": "Acme"}, "Version": {"name": "Version", "value": "2.0"}},
                    "order": ["Company", "Version", "Company", "Version", "ghost"]
                }
            }),
            &doc,
        );
        let order = doc.get_or_insert_array("fieldOrder");
        let txn = doc.transact();
        assert_eq!(order.len(&txn), 2, "doubled order + orphan hydrates to 2");
    }

    #[test]
    fn json_fields_to_ydoc_is_idempotent_only_seeds_empty() {
        let doc = Doc::new();
        super::json_fields_to_ydoc(&fields_json(), &doc);
        super::json_fields_to_ydoc(
            &json!({"fields": {"fields": {"Other": {"name": "Other", "value": "x"}}, "order": ["Other"]}}),
            &doc,
        );
        let fields = doc.get_or_insert_map("fields");
        let txn = doc.transact();
        assert_eq!(fields.len(&txn), 2, "second seed must be a no-op on a populated map");
        assert!(!fields.contains_key(&txn, "Other"));
    }

    #[test]
    fn json_fields_to_ydoc_noop_without_fields() {
        let doc = Doc::new();
        super::json_fields_to_ydoc(&json!({"id": "d"}), &doc);
        let fields = doc.get_or_insert_map("fields");
        assert_eq!(fields.len(&doc.transact()), 0);
    }

    // ---- JP-339: prose page-list seeding ----

    fn prose_pages_json() -> Value {
        json!({
            "id": "d",
            "richTextPages": {
                "pageOrder": ["rt-page-1", "rt-2"],
                "pages": {
                    "rt-page-1": {"id": "rt-page-1", "name": "Page 1", "order": 0,
                                  "content": "<p>hello</p>", "createdAt": 1, "modifiedAt": 2},
                    "rt-2": {"id": "rt-2", "name": "Notes", "color": "#abc", "order": 1,
                             "content": "<p>notes</p>", "createdAt": 3, "modifiedAt": 4}
                }
            }
        })
    }

    #[test]
    fn json_prose_pages_to_ydoc_seeds_metadata_and_order_without_content() {
        let doc = Doc::new();
        super::json_prose_pages_to_ydoc(&prose_pages_json(), &doc);
        let pages = doc.get_or_insert_map("prosePages");
        let order = doc.get_or_insert_array("prosePageOrder");
        let txn = doc.transact();
        assert_eq!(pages.len(&txn), 2);
        assert_eq!(order.len(&txn), 2);
        // Metadata is present; content is stripped (it lives in the fragment).
        let Some(yrs::Out::Any(Any::Map(meta))) = pages.get(&txn, "rt-2") else {
            panic!("rt-2 meta missing");
        };
        assert!(matches!(meta.get("name"), Some(Any::String(s)) if s.as_ref() == "Notes"));
        assert!(matches!(meta.get("color"), Some(Any::String(s)) if s.as_ref() == "#abc"));
        assert!(meta.get("content").is_none(), "content must NOT be in the page-list meta");
    }

    #[test]
    fn json_prose_pages_to_ydoc_is_idempotent_only_seeds_empty() {
        let doc = Doc::new();
        super::json_prose_pages_to_ydoc(&prose_pages_json(), &doc);
        // Re-run with a different list — a populated map must not be re-seeded.
        super::json_prose_pages_to_ydoc(
            &json!({"richTextPages": {"pageOrder": ["x"], "pages": {"x": {"id": "x", "name": "X"}}}}),
            &doc,
        );
        let pages = doc.get_or_insert_map("prosePages");
        let txn = doc.transact();
        assert_eq!(pages.len(&txn), 2, "second seed must no-op on a populated map");
        assert!(!pages.contains_key(&txn, "x"));
    }

    #[test]
    fn json_prose_pages_to_ydoc_dedupes_doubled_order() {
        let doc = Doc::new();
        super::json_prose_pages_to_ydoc(
            &json!({
                "richTextPages": {
                    "pageOrder": ["rt-page-1", "rt-2", "rt-page-1", "rt-2", "ghost"],
                    "pages": {
                        "rt-page-1": {"id": "rt-page-1", "name": "Page 1"},
                        "rt-2": {"id": "rt-2", "name": "Notes"}
                    }
                }
            }),
            &doc,
        );
        let order = doc.get_or_insert_array("prosePageOrder");
        assert_eq!(order.len(&doc.transact()), 2, "doubled order + orphan hydrates to 2");
    }

    #[test]
    fn json_prose_pages_to_ydoc_noop_without_richtextpages() {
        let doc = Doc::new();
        super::json_prose_pages_to_ydoc(&json!({"id": "d", "name": "x"}), &doc);
        let pages = doc.get_or_insert_map("prosePages");
        assert_eq!(pages.len(&doc.transact()), 0);
    }

    // ---- JP-339: canvas page-list seeding ----

    fn canvas_pages_json() -> Value {
        json!({
            "id": "d",
            "activePageId": "p1",
            "pageOrder": ["p1", "p2"],
            "pages": {
                "p1": {"id": "p1", "name": "Page 1", "shapes": {"s1": {"id": "s1"}},
                       "shapeOrder": ["s1"], "createdAt": 1, "modifiedAt": 2},
                "p2": {"id": "p2", "name": "Diagram", "shapes": {}, "shapeOrder": [],
                       "createdAt": 3, "modifiedAt": 4}
            }
        })
    }

    #[test]
    fn json_canvas_pages_to_ydoc_seeds_metadata_and_order_without_shapes() {
        let doc = Doc::new();
        super::json_canvas_pages_to_ydoc(&canvas_pages_json(), &doc);
        let pages = doc.get_or_insert_map("canvasPages");
        let order = doc.get_or_insert_array("canvasPageOrder");
        let txn = doc.transact();
        assert_eq!(pages.len(&txn), 2);
        assert_eq!(order.len(&txn), 2);
        let Some(yrs::Out::Any(Any::Map(meta))) = pages.get(&txn, "p1") else {
            panic!("p1 meta missing");
        };
        assert!(matches!(meta.get("name"), Some(Any::String(s)) if s.as_ref() == "Page 1"));
        assert!(meta.get("shapes").is_none(), "shapes must NOT be in the page-list meta");
        assert!(meta.get("shapeOrder").is_none(), "shapeOrder must NOT be in the meta");
    }

    #[test]
    fn json_canvas_pages_to_ydoc_is_idempotent_only_seeds_empty() {
        let doc = Doc::new();
        super::json_canvas_pages_to_ydoc(&canvas_pages_json(), &doc);
        super::json_canvas_pages_to_ydoc(
            &json!({"pageOrder": ["x"], "pages": {"x": {"id": "x", "name": "X"}}}),
            &doc,
        );
        let pages = doc.get_or_insert_map("canvasPages");
        let txn = doc.transact();
        assert_eq!(pages.len(&txn), 2, "second seed must no-op on a populated map");
        assert!(!pages.contains_key(&txn, "x"));
    }

    #[test]
    fn json_canvas_pages_to_ydoc_dedupes_doubled_order() {
        let doc = Doc::new();
        super::json_canvas_pages_to_ydoc(
            &json!({
                "pageOrder": ["p1", "p2", "p1", "p2", "ghost"],
                "pages": {"p1": {"id": "p1", "name": "Page 1"}, "p2": {"id": "p2", "name": "Two"}}
            }),
            &doc,
        );
        let order = doc.get_or_insert_array("canvasPageOrder");
        assert_eq!(order.len(&doc.transact()), 2, "doubled order + orphan hydrates to 2");
    }

    #[test]
    fn json_canvas_pages_to_ydoc_noop_without_pages() {
        let doc = Doc::new();
        super::json_canvas_pages_to_ydoc(&json!({"id": "d", "name": "x"}), &doc);
        let pages = doc.get_or_insert_map("canvasPages");
        assert_eq!(pages.len(&doc.transact()), 0);
    }

    // ---- JP-330 forensic repro: shapeOrder doubling ------------------------

    fn ordered_doc() -> Value {
        json!({
            "id": "d", "activePageId": "p1", "pageOrder": ["p1"],
            "pages": {"p1": {"id": "p1",
                "shapes": {
                    "s1": {"id": "s1"}, "s2": {"id": "s2"}, "s3": {"id": "s3"},
                    "s4": {"id": "s4"}, "s5": {"id": "s5"}
                },
                "shapeOrder": ["s1", "s2", "s3", "s4", "s5"]
            }}
        })
    }

    fn read_order(doc: &Doc) -> Vec<String> {
        use yrs::types::ToJson;
        let order = doc.get_or_insert_array("shapeOrder");
        let txn = doc.transact();
        match order.to_json(&txn) {
            Any::Array(arr) => arr
                .iter()
                .map(|a| match a {
                    Any::String(s) => s.to_string(),
                    _ => String::new(),
                })
                .collect(),
            _ => vec![],
        }
    }

    /// Trigger A is now fixed by the once-gate: re-hydrating a populated Y.Doc
    /// is a no-op for shapes + order (mirrors `json_references_to_ydoc`), so the
    /// order stays unique instead of doubling.
    #[test]
    fn jp330_rehydration_no_longer_doubles() {
        let doc = Doc::new();
        json_to_ydoc(&ordered_doc(), &doc);
        json_to_ydoc(&ordered_doc(), &doc); // second seed: must no-op

        let shapes = doc.get_or_insert_map("shapes");
        assert_eq!(shapes.len(&doc.transact()), 5);
        assert_eq!(read_order(&doc), ["s1", "s2", "s3", "s4", "s5"], "no doubling");
    }

    /// An already-corrupted source (its persisted `shapeOrder` is doubled, like
    /// the captured snapshot) hydrates clean — the seed dedupes the source.
    #[test]
    fn jp330_doubled_source_json_hydrates_clean() {
        let mut src = ordered_doc();
        src["pages"]["p1"]["shapeOrder"] =
            json!(["s1", "s2", "s3", "s4", "s5", "s1", "s2", "s3", "s4", "s5", "ghost"]);
        let doc = Doc::new();
        json_to_ydoc(&src, &doc);
        assert_eq!(
            read_order(&doc),
            ["s1", "s2", "s3", "s4", "s5"],
            "deduped + orphan ('ghost') dropped on seed"
        );
    }

    /// Trigger B (dual-origin merge) still doubles the LIVE in-memory array — we
    /// deliberately don't prevent the merge (deferred). What matters is that no
    /// consumer surfaces the dupes: `flatten` (persist) self-heals
    /// (see `flatten::tests::jp330_flatten_dedupes_doubled_order`) and the agent
    /// read / client render dedupe. This test pins the deferred behavior so a
    /// future "prevent at source" change has a clear before/after.
    #[test]
    fn jp330_dual_origin_merge_still_doubles_live_array() {
        use yrs::updates::decoder::Decode;
        use yrs::{ReadTxn, StateVector, Update};

        let a = Doc::new();
        json_to_ydoc(&ordered_doc(), &a);
        let b = Doc::new();
        json_to_ydoc(&ordered_doc(), &b);

        let update = b.transact().encode_state_as_update_v1(&StateVector::default());
        a.transact_mut()
            .apply_update(Update::decode_v1(&update).expect("decode"))
            .expect("apply");

        assert_eq!(a.get_or_insert_map("shapes").len(&a.transact()), 5, "map LWW");
        assert_eq!(read_order(&a).len(), 10, "live array doubles (deferred: tolerated on read)");
    }
}
