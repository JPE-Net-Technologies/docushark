//! Authoritative server-side Yjs CRDT (Phase 20.4 / JP-34).
//!
//! Holds one `Y.Doc` per *active* document. The relay is the source of
//! truth: on `JOIN_DOC` it hydrates the doc from the JSON snapshot and
//! answers the joining client's `SyncStep1` with authoritative state;
//! inbound SYNC frames are applied to the Y.Doc and rebroadcast to peers.
//! This removes whole-document last-write-wins and is the foundation for
//! JP-36 (Y.Doc → JSON persistence) and MCP write tools.
//!
//! **Persistence (JP-36):** the server flattens each dirty Y.Doc back to its
//! JSON snapshot on an interval, on last-client eviction, and on graceful
//! shutdown (`ServerState::snapshot_*` + `DocHandle::flatten_into`). Durability
//! no longer depends on a client REST save.
//!
//! **Concurrency:** `yrs::Doc` carries its own internal transaction lock and
//! is `Send + Sync`, so handles are shared via `Arc` with no extra `Mutex`.
//! Every decode/apply/encode is a short, fully synchronous critical section —
//! a transaction is **never** held across an `.await`.

mod binary;
mod flatten;
mod hydration;
mod prose_block;
mod prose_html;
mod prose_parse;
mod prose_schema;
mod prose_validate;
mod protocol;

/// Apply an anchored, block-level prose edit to a page's HTML off the live path
/// (the MCP cold path for a non-resident document). See [`prose_block`].
pub use prose_block::replace_block_in_html;

pub use prose_validate::ProseFix;

/// Validate + normalize prose HTML for the MCP write gate (JP-328): parse to
/// blocks, run the structural sanitizer, and return the scoped diff of fixes
/// (empty when clean). The build/seed paths sanitize independently, so this is
/// purely to surface "here's what was malformed and how it was healed" back to
/// the MCP author.
pub fn validate_prose_html(html: &str) -> Vec<ProseFix> {
    let (_blocks, fixes) = prose_validate::sanitize_blocks(prose_parse::html_to_blocks(html));
    fixes
}

pub use hydration::active_page_shape_count;
pub use protocol::{SyncError, SyncOutcome};

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};

use serde_json::Value;
use yrs::types::Attrs;
use yrs::types::ToJson;
use yrs::{
    Any, Array, Doc, Map, ReadTxn, Text, Transact, TransactionMut, Xml, XmlElementPrelim,
    XmlFragment, XmlFragmentRef, XmlTextPrelim,
};

use crate::server::protocol::{DocId, WorkspaceId};

/// Count entries in a `Y.Doc`'s `shapes` map — the active-page surface that
/// mirrors the client `YjsDocument`. Grab the map handle *before* opening the
/// read txn (`get_or_insert_map` transacts; nesting deadlocks).
fn doc_shape_count(doc: &Doc) -> usize {
    let shapes = doc.get_or_insert_map("shapes");
    shapes.len(&doc.transact()) as usize
}

/// True when a snapshot would drop a resident doc from N>0 shapes to 0 — the
/// signature of a tombstone poisoning (and, indistinguishably at the relay, a
/// genuine select-all+delete). JP-180 backs the prior state up into the
/// recovery store before persisting either way, so the zeroing is never
/// permanent and a real delete-all still goes through.
pub fn suspicious_zeroing(prior: usize, current: usize) -> bool {
    prior > 0 && current == 0
}

/// Count the `prose:<pageId>` roots that currently hold content (JP-189). Prose
/// pages bind to Tiptap's `Collaboration` extension as `Y.XmlFragment`s named
/// `prose:<pageId>`. A page is "non-empty" when its fragment has ≥1 child node —
/// Tiptap never leaves a page truly empty (it keeps an empty paragraph), so a
/// `prose:*` root at 0 length is an abnormal zeroing, not a user edit.
///
/// `root_refs` is used only for the **names**: a doc hydrated from a binary
/// update (`doc_from_update`) — or the live relay doc, whose prose roots only
/// ever arrive via applied client updates — hasn't *branded* its root type
/// kinds, so the `Out` value isn't reliably `YXmlFragment`. The name is always
/// present, though; we read each prose root through the typed getter, which
/// brands + exposes its length.
fn doc_prose_count(doc: &Doc) -> usize {
    let names: Vec<String> = {
        let txn = doc.transact();
        txn.root_refs()
            .map(|(name, _)| name)
            .filter(|name| name.starts_with("prose:"))
            .map(String::from)
            .collect()
    };
    names
        .iter()
        .filter(|name| doc.get_or_insert_xml_fragment(name.as_str()).len(&doc.transact()) > 0)
        .count()
}

/// Non-empty `prose:*` page count of a binary `Y.Doc` sidecar (JP-189), or
/// `None` if the blob can't be decoded. Used to read the *prior* persisted prose
/// state — unlike shapes, prose has no JSON reference (the relay only flattens
/// shapes), so the comparison baseline is the previous binary sidecar.
pub fn prose_count_in_binary(bytes: &[u8]) -> Option<usize> {
    let (_version, update) = binary::decode_header(bytes)?;
    let doc = binary::doc_from_update(update).ok()?;
    Some(doc_prose_count(&doc))
}

/// True when a snapshot would empty **≥2** prose pages at once (JP-189). A user
/// can only clear the one prose editor they're focused on, so multiple pages
/// going non-empty → empty in a single snapshot is structurally impossible from
/// a real edit — unambiguous poison. (Unlike shapes, where a select-all+delete
/// legitimately zeroes everything, so JP-180 can only back-up-and-still-persist;
/// here the signal is high enough to alarm on confidently.) A single page
/// emptying is left alone to avoid false positives on a genuine page clear/delete.
pub fn suspicious_prose_zeroing(prior: usize, current: usize) -> bool {
    prior.saturating_sub(current) >= 2
}

/// The authoritative Y.Doc for a single active document, plus the sync
/// operations over it.
pub struct DocHandle {
    doc: Doc,
    /// The page this doc was hydrated from (`activePageId`). Flattening writes
    /// the live shapes back into this page (JP-36). `None` when the snapshot
    /// had no active page — such a doc is never persisted.
    page_id: Option<String>,
    /// Set when an inbound update mutates the Y.Doc; cleared when the snapshot
    /// sweeper persists it. Gates the relay's JSON snapshots so unchanged docs
    /// aren't rewritten.
    dirty: AtomicBool,
}

impl DocHandle {
    /// Build a handle by hydrating a fresh `Doc`. Prefers the binary sidecar
    /// (`ydoc_bin`, JP-108) — which preserves CRDT identity + prose across
    /// evict/rehydrate — and falls back to JSON hydration (JP-34) when the
    /// binary is absent, stale, or corrupt.
    fn hydrate(doc_json: &Value, ydoc_bin: Option<&[u8]>, poison_guard: bool) -> Self {
        let page_id = doc_json
            .get("activePageId")
            .and_then(Value::as_str)
            .map(str::to_string);
        let (doc, poison_healed) = Self::hydrate_doc(doc_json, ydoc_bin, poison_guard);
        Self {
            doc,
            page_id,
            // Self-heal (JP-180): when the sanity check rejected a poisoned
            // binary sidecar and rebuilt from JSON, mark the handle dirty so the
            // next snapshot sweep overwrites the bad sidecar with the
            // JSON-correct state. Otherwise a fresh handle starts clean.
            dirty: AtomicBool::new(poison_healed),
        }
    }

    /// Choose the hydration source, returning `(doc, poison_healed)`. The binary
    /// is authoritative only when it's at least as new as the JSON body:
    /// `persist_snapshot` preserves `serverVersion` while MCP/REST writes bump
    /// it, so a binary tagged with an older version means an out-of-band JSON
    /// write landed after it — in which case we hydrate from JSON and let the
    /// next snapshot rewrite the binary.
    ///
    /// Poison sanity check (JP-180): even a *current* binary is rejected when it
    /// decodes to 0 shapes while the JSON snapshot still holds N>0 — the
    /// signature of a tombstone-zeroed sidecar. We log loud, rebuild from JSON
    /// instead of silently serving empty, and flag `poison_healed` so the caller
    /// rewrites the bad binary. A legitimate delete-all leaves *both* at 0, so
    /// this never fires on real empties.
    fn hydrate_doc(doc_json: &Value, ydoc_bin: Option<&[u8]>, poison_guard: bool) -> (Doc, bool) {
        let mut poison_healed = false;
        if let Some(bytes) = ydoc_bin {
            if let Some((bin_version, update)) = binary::decode_header(bytes) {
                let json_version = doc_json.get("serverVersion").and_then(Value::as_u64);
                let current = json_version.is_none_or(|jv| bin_version >= jv);
                if current {
                    match binary::doc_from_update(update) {
                        Ok(doc) => {
                            let json_shapes = hydration::active_page_shape_count(doc_json);
                            if poison_guard && doc_shape_count(&doc) == 0 && json_shapes > 0 {
                                log::error!(
                                    "poisoned binary Y.Doc sidecar (0 shapes, JSON snapshot has {json_shapes}); \
                                     rebuilding from JSON and rewriting the sidecar"
                                );
                                poison_healed = true;
                                // fall through to the JSON rebuild below
                            } else {
                                // Prose backstop (JP-284): the binary sidecar is
                                // authoritative for the prose it carries, but if a
                                // page's fragment is empty while `richTextPages`
                                // has prose (an inconsistent sidecar — there's a
                                // shape poison guard above but no prose one), fill
                                // it so the relay is the guaranteed sole seeder and
                                // the client never has to. Idempotent: never
                                // re-seeds a populated fragment.
                                hydration::json_prose_to_ydoc(doc_json, &doc);
                                // JP-89: same backstop for the reference library —
                                // an older sidecar with no `references` map gets it
                                // backfilled from JSON (idempotent; never wipes a
                                // populated map).
                                hydration::json_references_to_ydoc(doc_json, &doc);
                                // Phase 3c: same backstop for the field library.
                                hydration::json_fields_to_ydoc(doc_json, &doc);
                                // JP-339: same backstop for the prose page list
                                // (an older sidecar with no `prosePages` map gets
                                // it backfilled from `richTextPages`; idempotent).
                                hydration::json_prose_pages_to_ydoc(doc_json, &doc);
                                // JP-338 self-heal: collapse any prose fragment
                                // that hydrated as an exact `body+body` double
                                // (write-vs-hydrate lineage merge); dirty so the
                                // next snapshot rewrites the repaired state.
                                let healed = heal_doubled_prose_in(&doc);
                                return (doc, healed);
                            }
                        }
                        Err(e) => log::warn!(
                            "binary Y.Doc hydrate failed ({e}); falling back to JSON"
                        ),
                    }
                }
            }
        }
        let doc = Doc::new();
        hydration::json_to_ydoc(doc_json, &doc);
        // JP-239 follow-up: the binary sidecar (above) carries prose with CRDT
        // identity; the JSON rebuild doesn't, so seed the live prose fragments
        // from `richTextPages` here. Without this, cold-authored prose (MCP, never
        // opened in an editor) hydrates empty and a joining editor renders blank.
        hydration::json_prose_to_ydoc(doc_json, &doc);
        // JP-89: seed the reference library into the authoritative Y.Doc so MCP +
        // editor ref edits converge per item instead of whole-field clobbering.
        hydration::json_references_to_ydoc(doc_json, &doc);
        // Phase 3c: same for the field library.
        hydration::json_fields_to_ydoc(doc_json, &doc);
        // JP-339: seed the prose page LIST (tab metadata) so MCP/editor tab edits
        // converge per item and surface live — removing the reload that triggered
        // the JP-338 dup. Metadata only; content stays in the `prose:<id>` seed.
        hydration::json_prose_pages_to_ydoc(doc_json, &doc);
        // JP-338 self-heal: a doc whose persisted `richTextPages` content was
        // already doubled hydrates doubled (the deterministic seed faithfully
        // re-creates `body+body`); collapse it here so the live doc — and the
        // next snapshot — are single.
        let healed = heal_doubled_prose_in(&doc);
        (doc, poison_healed || healed)
    }

    /// Number of shapes currently in the live `Y.Doc` (active-page surface).
    /// Used by the JP-180 persist guard to detect an N→0 zeroing before it's
    /// written to disk.
    pub fn shape_count(&self) -> usize {
        doc_shape_count(&self.doc)
    }

    /// Number of non-empty `prose:*` pages currently in the live `Y.Doc`. Used
    /// by the JP-189 persist guard to detect a multi-page prose zeroing before
    /// it's written to disk.
    pub fn prose_count(&self) -> usize {
        doc_prose_count(&self.doc)
    }

    /// Serialize the live `prose:<page_id>` fragment to HTML (JP-201 resident
    /// read). `None` when the page has no prose root or it's empty — the caller
    /// then falls back to the JSON projection. Mirrors the editor's
    /// `editor.getHTML()` for the same page.
    pub fn prose_html(&self, page_id: &str) -> Option<String> {
        let name = format!("prose:{page_id}");
        // Grab the fragment handle before opening a txn (`get_or_insert_*`
        // transacts; nesting deadlocks), then read under a fresh txn.
        let frag = self.doc.get_or_insert_xml_fragment(name.as_str());
        let txn = self.doc.transact();
        if frag.len(&txn) == 0 {
            return None;
        }
        Some(prose_html::fragment_to_html(&frag, &txn))
    }

    /// Every non-empty prose page in the live Y.Doc as `(page_id, html)`, the id
    /// parsed from each `prose:<id>` root. Order is unspecified — the caller
    /// merges name/order from the JSON snapshot (that metadata isn't CRDT-synced).
    pub fn prose_pages(&self) -> Vec<(String, String)> {
        let names: Vec<String> = {
            let txn = self.doc.transact();
            txn.root_refs()
                .map(|(name, _)| name)
                .filter(|name| name.starts_with("prose:"))
                .map(String::from)
                .collect()
        };
        let mut pages = Vec::new();
        for name in names {
            let frag = self.doc.get_or_insert_xml_fragment(name.as_str());
            let txn = self.doc.transact();
            if frag.len(&txn) == 0 {
                continue;
            }
            let html = prose_html::fragment_to_html(&frag, &txn);
            let page_id = name.strip_prefix("prose:").unwrap_or(&name).to_string();
            pages.push((page_id, html));
        }
        pages
    }

    /// Encode the live `Y.Doc` as a binary sidecar blob tagged with
    /// `server_version` (JP-108). Captures the whole doc — every shared type,
    /// incl. prose — not just the active-page shapes the JSON flatten writes.
    pub fn encode_binary(&self, server_version: u64) -> Vec<u8> {
        binary::encode_snapshot(server_version, &self.doc)
    }

    /// Apply one inbound sync frame body (bytes *after* the `MESSAGE_SYNC`
    /// prefix) and report what to send back / broadcast. Marks the doc dirty
    /// when the frame actually changed state (an applied update → a broadcast).
    pub fn handle_sync_message(&self, body: &[u8]) -> Result<SyncOutcome, SyncError> {
        let outcome = protocol::process_sync_message(&self.doc, body)?;
        if outcome.broadcast.is_some() {
            self.dirty.store(true, Ordering::Relaxed);
        }
        Ok(outcome)
    }

    /// The relay-initiated `SyncStep1` frame to push authoritative state to a
    /// client that just joined.
    pub fn sync_step1_frame(&self) -> Vec<u8> {
        protocol::initial_sync_step1(&self.doc)
    }

    /// The page id to flatten into, if this doc has one.
    pub fn page_id(&self) -> Option<&str> {
        self.page_id.as_deref()
    }

    /// Atomically read-and-clear the dirty flag. Loss-safe: an apply landing
    /// during/after a snapshot re-sets `dirty`, so the next tick re-persists.
    pub fn take_dirty(&self) -> bool {
        self.dirty.swap(false, Ordering::Relaxed)
    }

    /// Re-mark dirty (used to retry after a failed snapshot write).
    pub fn mark_dirty(&self) {
        self.dirty.store(true, Ordering::Relaxed);
    }

    /// Flatten the live Y.Doc into `json`'s active page (JP-36). Returns
    /// `false` (writing nothing) if this doc has no page id or the page is
    /// absent in `json`.
    pub fn flatten_into(&self, json: &mut Value) -> bool {
        let Some(page_id) = &self.page_id else {
            return false;
        };
        if !flatten::flatten_into(&self.doc, page_id, json) {
            return false;
        }
        // JP-201 Slice 3: also project the live prose pages into
        // `richTextPages` so MCP/preview/cold readers see prose (which the
        // shape-only flatten above never wrote). Read projection only — restore
        // stays binary-sidecar based.
        flatten::project_prose_into(&self.prose_pages(), json);
        // JP-89: re-assert the reference library from the authoritative Y.Doc, so
        // a merged set (incl. live MCP/peer adds) is what persists.
        flatten::project_references_into(&self.doc, json);
        // Phase 3c: same for the field library (live MCP/peer field edits).
        flatten::project_fields_into(&self.doc, json);
        // JP-339: re-assert the prose page LIST from the authoritative Y.Doc.
        // After `project_prose_into` (content overlay) so content is preserved and
        // only tab metadata/order is merged; prunes pages deleted in the Y.Doc.
        flatten::project_prose_pages_into(&self.doc, json);
        true
    }

    // ---- MCP authoritative write surface (JP-35) ----
    //
    // These let the MCP write tools mutate the *live* Y.Doc directly when a
    // doc is resident, instead of rewriting the lagging JSON snapshot. Each
    // op validates against, and applies to, the active-page `shapes` map +
    // `shapeOrder` array in one transaction, returns the framed CRDT delta
    // for `broadcast_to_doc`, and marks the handle dirty so the JP-36 snapshot
    // sweeper persists it (no JSON write on this path). Mirrors how an inbound
    // SYNC frame mutates the doc — durability is snapshot-driven, identical to
    // a connected editor's own edits.

    /// True if a shape with `id` exists on the active-page surface.
    pub fn has_shape(&self, id: &str) -> bool {
        let shapes = self.doc.get_or_insert_map("shapes");
        shapes.contains_key(&self.doc.transact(), id)
    }

    /// Read a shape's whole JSON value from the active-page surface. `None`
    /// if absent (or, defensively, if the stored value isn't a plain JSON
    /// `Any` — every shape is stored that way, matching `YjsDocument`).
    pub fn get_shape_json(&self, id: &str) -> Option<Value> {
        let shapes = self.doc.get_or_insert_map("shapes");
        match shapes.get(&self.doc.transact(), id) {
            Some(yrs::Out::Any(any)) => Some(flatten::any_to_json(&any)),
            _ => None,
        }
    }

    /// Insert one or more new shapes (`id` + whole JSON value) and append
    /// their ids to `shapeOrder`, in a single transaction. Validates *all*
    /// ids are absent before mutating anything, so a duplicate id applies
    /// nothing. Returns the framed sync update to broadcast; marks dirty.
    pub fn insert_shapes(&self, items: &[(String, Value)]) -> Result<Vec<u8>, String> {
        let shapes = self.doc.get_or_insert_map("shapes");
        let order = self.doc.get_or_insert_array("shapeOrder");
        let mut txn = self.doc.transact_mut();
        let before = txn.before_state().clone();
        for (id, _) in items {
            if shapes.contains_key(&txn, id) {
                // No shape inserted yet → returning here commits nothing.
                return Err(format!("Shape id '{}' already exists on page", id));
            }
        }
        for (id, shape) in items {
            shapes.insert(&mut txn, id.clone(), hydration::json_to_any(shape));
            order.push_back(&mut txn, Any::String(id.clone().into()));
        }
        let update = txn.encode_state_as_update_v1(&before);
        drop(txn);
        self.dirty.store(true, Ordering::Relaxed);
        Ok(protocol::frame_update(update))
    }

    /// Overwrite an existing shape's whole JSON value (used by `update_shape`
    /// after the caller merges its patch). Errors (applying nothing) if `id`
    /// is absent. Returns the framed sync update to broadcast; marks dirty.
    pub fn overwrite_shape(&self, id: &str, shape: Value) -> Result<Vec<u8>, String> {
        let shapes = self.doc.get_or_insert_map("shapes");
        let mut txn = self.doc.transact_mut();
        let before = txn.before_state().clone();
        if !shapes.contains_key(&txn, id) {
            return Err(format!("Shape '{}' not found on page", id));
        }
        shapes.insert(&mut txn, id.to_string(), hydration::json_to_any(&shape));
        let update = txn.encode_state_as_update_v1(&before);
        drop(txn);
        self.dirty.store(true, Ordering::Relaxed);
        Ok(protocol::frame_update(update))
    }

    /// The active-page `shapes` map as a JSON object (id → whole shape value).
    /// Used by the MCP `delete_shape` cascade to find connectors referencing a
    /// doomed shape, and by `reorder`/diagnostics. Empty object if unset.
    pub fn shapes_json(&self) -> serde_json::Map<String, Value> {
        let shapes = self.doc.get_or_insert_map("shapes");
        let txn = self.doc.transact();
        match flatten::any_to_json(&shapes.to_json(&txn)) {
            Value::Object(m) => m,
            _ => serde_json::Map::new(),
        }
    }

    /// Remove `ids` from the active-page `shapes` map and `shapeOrder`, in one
    /// transaction. Ids that are absent are ignored. `shapeOrder` is rebuilt
    /// without the removed ids (order of survivors preserved). Returns the framed
    /// delta to broadcast; marks dirty. The caller computes the full id set
    /// (the target shape plus any connectors that reference it).
    pub fn delete_shapes(&self, ids: &[String]) -> Result<Vec<u8>, String> {
        let shapes = self.doc.get_or_insert_map("shapes");
        let order = self.doc.get_or_insert_array("shapeOrder");
        let drop_set: std::collections::HashSet<&str> = ids.iter().map(String::as_str).collect();
        let mut txn = self.doc.transact_mut();
        let before = txn.before_state().clone();
        for id in ids {
            shapes.remove(&mut txn, id.as_str());
        }
        // Rebuild shapeOrder without the removed ids (survivors keep their order).
        let kept: Vec<String> = order
            .iter(&txn)
            .filter_map(|o| match o {
                yrs::Out::Any(Any::String(s)) => Some(s.to_string()),
                _ => None,
            })
            .filter(|s| !drop_set.contains(s.as_str()))
            .collect();
        let len = order.len(&txn);
        if len > 0 {
            order.remove_range(&mut txn, 0, len);
        }
        for s in &kept {
            order.push_back(&mut txn, Any::String(s.as_str().into()));
        }
        let update = txn.encode_state_as_update_v1(&before);
        drop(txn);
        self.dirty.store(true, Ordering::Relaxed);
        Ok(protocol::frame_update(update))
    }

    // ---- Reference library (JP-89) — live Y.Doc surface ----

    /// The `references` `Y.Map` as a JSON object (id → CSLItem). Used by the MCP
    /// `add_reference` live path to dedup against the merged library and by
    /// `list_references` to read the resident library. Empty object if unset.
    pub fn references_json(&self) -> serde_json::Map<String, Value> {
        let references = self.doc.get_or_insert_map("references");
        let txn = self.doc.transact();
        match flatten::any_to_json(&references.to_json(&txn)) {
            Value::Object(m) => m,
            _ => serde_json::Map::new(),
        }
    }

    /// The `referenceOrder` array as a list of reference ids (display order).
    pub fn reference_order(&self) -> Vec<String> {
        let order = self.doc.get_or_insert_array("referenceOrder");
        let txn = self.doc.transact();
        order
            .iter(&txn)
            .filter_map(|o| match o {
                yrs::Out::Any(Any::String(s)) => Some(s.to_string()),
                _ => None,
            })
            .collect()
    }

    /// The active citation style from `metadata.citationStyle`, if set.
    pub fn citation_style(&self) -> Option<String> {
        let metadata = self.doc.get_or_insert_map("metadata");
        let txn = self.doc.transact();
        match metadata.get(&txn, "citationStyle") {
            Some(yrs::Out::Any(Any::String(s))) => Some(s.to_string()),
            _ => None,
        }
    }

    /// Insert reference(s) into the live `references` `Y.Map` and append any new
    /// ids to `referenceOrder`, in one transaction (INVARIANT A: strictly
    /// per-item `set` — never a whole-map rewrite, so a concurrent writer's
    /// not-yet-observed ref can't be wiped). An id already present is overwritten
    /// (LWW, same as a re-add) without a duplicate `referenceOrder` entry. Returns
    /// the framed CRDT delta to broadcast; marks dirty. The caller dedups against
    /// [`references_json`] before calling.
    pub fn insert_references(&self, items: &[(String, Value)]) -> Vec<u8> {
        let references = self.doc.get_or_insert_map("references");
        let order = self.doc.get_or_insert_array("referenceOrder");
        let mut txn = self.doc.transact_mut();
        let before = txn.before_state().clone();
        let existing: std::collections::HashSet<String> = order
            .iter(&txn)
            .filter_map(|o| match o {
                yrs::Out::Any(Any::String(s)) => Some(s.to_string()),
                _ => None,
            })
            .collect();
        for (id, item) in items {
            references.insert(&mut txn, id.clone(), hydration::json_to_any(item));
            if !existing.contains(id) {
                order.push_back(&mut txn, Any::String(id.clone().into()));
            }
        }
        let update = txn.encode_state_as_update_v1(&before);
        drop(txn);
        self.dirty.store(true, Ordering::Relaxed);
        protocol::frame_update(update)
    }

    /// The `fields` `Y.Map` as a JSON object (name → Field). Used by the MCP
    /// `set_fields` live path to read the merged library and by `list_fields` to
    /// read the resident library. Empty object if unset. (Phase 3c.)
    pub fn fields_json(&self) -> serde_json::Map<String, Value> {
        let fields = self.doc.get_or_insert_map("fields");
        let txn = self.doc.transact();
        match flatten::any_to_json(&fields.to_json(&txn)) {
            Value::Object(m) => m,
            _ => serde_json::Map::new(),
        }
    }

    /// The `fieldOrder` array as a list of field names (display order). (Phase 3c.)
    pub fn field_order(&self) -> Vec<String> {
        let order = self.doc.get_or_insert_array("fieldOrder");
        let txn = self.doc.transact();
        order
            .iter(&txn)
            .filter_map(|o| match o {
                yrs::Out::Any(Any::String(s)) => Some(s.to_string()),
                _ => None,
            })
            .collect()
    }

    /// Insert/update field(s) into the live `fields` `Y.Map` and append any new
    /// names to `fieldOrder`, in one transaction (INVARIANT A: strictly per-item
    /// `set` — never a whole-map rewrite, so a concurrent writer's not-yet-observed
    /// field can't be wiped). A name already present is overwritten (LWW — i.e.
    /// "edit a value") without a duplicate `fieldOrder` entry. Returns the framed
    /// CRDT delta to broadcast; marks dirty. (Phase 3c.)
    pub fn insert_fields(&self, items: &[(String, Value)]) -> Vec<u8> {
        let fields = self.doc.get_or_insert_map("fields");
        let order = self.doc.get_or_insert_array("fieldOrder");
        let mut txn = self.doc.transact_mut();
        let before = txn.before_state().clone();
        let existing: std::collections::HashSet<String> = order
            .iter(&txn)
            .filter_map(|o| match o {
                yrs::Out::Any(Any::String(s)) => Some(s.to_string()),
                _ => None,
            })
            .collect();
        for (name, field) in items {
            fields.insert(&mut txn, name.clone(), hydration::json_to_any(field));
            if !existing.contains(name) {
                order.push_back(&mut txn, Any::String(name.clone().into()));
            }
        }
        let update = txn.encode_state_as_update_v1(&before);
        drop(txn);
        self.dirty.store(true, Ordering::Relaxed);
        protocol::frame_update(update)
    }

    /// Clear the live `prose:<page_id>` fragment to empty (used by
    /// `delete_prose_page` so a resident editor's view of a removed page goes
    /// blank). Returns the framed delta; marks dirty. The page's removal from the
    /// (client-local, non-CRDT) prose page list is a separate JSON write.
    pub fn clear_prose(&self, page_id: &str) -> Vec<u8> {
        let name = format!("prose:{page_id}");
        let frag = self.doc.get_or_insert_xml_fragment(name.as_str());
        let mut txn = self.doc.transact_mut();
        let before = txn.before_state().clone();
        let len = frag.len(&txn);
        if len > 0 {
            frag.remove_range(&mut txn, 0, len);
        }
        let update = txn.encode_state_as_update_v1(&before);
        drop(txn);
        self.dirty.store(true, Ordering::Relaxed);
        protocol::frame_update(update)
    }

    /// The active-page z-order (`shapeOrder`) as a list of shape ids. Used by the
    /// MCP `reorder_shapes` tool to validate a requested order is a permutation
    /// of the current one before applying it.
    pub fn shape_order(&self) -> Vec<String> {
        let order = self.doc.get_or_insert_array("shapeOrder");
        let txn = self.doc.transact();
        order
            .iter(&txn)
            .filter_map(|o| match o {
                yrs::Out::Any(Any::String(s)) => Some(s.to_string()),
                _ => None,
            })
            .collect()
    }

    /// Replace `shapeOrder` with `order` (clear + repush, one txn). The caller is
    /// responsible for validating `order` is a permutation of the current ids
    /// (see the MCP `reorder_shapes` tool) — this just applies it. Returns the
    /// framed delta to broadcast; marks dirty.
    pub fn set_shape_order(&self, order: &[String]) -> Vec<u8> {
        let arr = self.doc.get_or_insert_array("shapeOrder");
        let mut txn = self.doc.transact_mut();
        let before = txn.before_state().clone();
        let len = arr.len(&txn);
        if len > 0 {
            arr.remove_range(&mut txn, 0, len);
        }
        for id in order {
            arr.push_back(&mut txn, Any::String(id.as_str().into()));
        }
        let update = txn.encode_state_as_update_v1(&before);
        drop(txn);
        self.dirty.store(true, Ordering::Relaxed);
        protocol::frame_update(update)
    }

    // ---- MCP prose page-LIST write surface (JP-339) ----
    //
    // The prose page list (tabs) lives in the authoritative Y.Doc as
    // `prosePages` (id → metadata Y.Map) + `prosePageOrder` (Y.Array), mirroring
    // the client's `YjsDocument`. These let the MCP page tools mutate the live
    // list when a doc is resident — broadcasting the delta so connected clients
    // see the tab add/rename/reorder/delete WITHOUT a reload (the JP-338 dup
    // trigger). Durability is snapshot-driven (the JP-36 flatten projects the
    // list back), identical to the prose-content write path.

    /// Set/replace one prose page's metadata in `prosePages` (+ append its id to
    /// `prosePageOrder` if new). `page_json` is the page's full stored object;
    /// `content` is stripped (it's owned by the `prose:<id>` fragment). Per-item
    /// (never a whole-map rewrite) so a concurrent writer's page isn't wiped.
    /// Returns the framed delta to broadcast; marks dirty.
    pub fn set_prose_page_meta(&self, page_id: &str, page_json: &Value) -> Vec<u8> {
        let pages = self.doc.get_or_insert_map("prosePages");
        let order = self.doc.get_or_insert_array("prosePageOrder");
        let mut txn = self.doc.transact_mut();
        let before = txn.before_state().clone();
        pages.insert(
            &mut txn,
            page_id.to_string(),
            hydration::prose_page_meta_any(page_id, page_json),
        );
        let already = order.iter(&txn).any(
            |o| matches!(o, yrs::Out::Any(Any::String(s)) if s.as_ref() == page_id),
        );
        if !already {
            order.push_back(&mut txn, Any::String(page_id.into()));
        }
        let update = txn.encode_state_as_update_v1(&before);
        drop(txn);
        self.dirty.store(true, Ordering::Relaxed);
        protocol::frame_update(update)
    }

    /// Remove one prose page from `prosePages` + `prosePageOrder` (a tab delete).
    /// The page's `prose:<id>` fragment is cleared separately via
    /// [`clear_prose`]. Returns the framed delta to broadcast; marks dirty.
    pub fn remove_prose_page(&self, page_id: &str) -> Vec<u8> {
        let pages = self.doc.get_or_insert_map("prosePages");
        let order = self.doc.get_or_insert_array("prosePageOrder");
        let mut txn = self.doc.transact_mut();
        let before = txn.before_state().clone();
        pages.remove(&mut txn, page_id);
        // Drop every occurrence from the order array (defensive against a
        // pre-doubled array), scanning back-to-front so indices stay valid.
        let ids: Vec<String> = order
            .iter(&txn)
            .filter_map(|o| match o {
                yrs::Out::Any(Any::String(s)) => Some(s.to_string()),
                _ => None,
            })
            .collect();
        for (i, id) in ids.iter().enumerate().rev() {
            if id == page_id {
                order.remove(&mut txn, i as u32);
            }
        }
        let update = txn.encode_state_as_update_v1(&before);
        drop(txn);
        self.dirty.store(true, Ordering::Relaxed);
        protocol::frame_update(update)
    }

    /// Replace `prosePageOrder` with `order` (clear + repush, one txn) — the tab
    /// reorder. Mirrors [`set_shape_order`]; the caller validates `order` is a
    /// permutation. Returns the framed delta to broadcast; marks dirty.
    pub fn set_prose_page_order(&self, order: &[String]) -> Vec<u8> {
        let arr = self.doc.get_or_insert_array("prosePageOrder");
        let mut txn = self.doc.transact_mut();
        let before = txn.before_state().clone();
        let len = arr.len(&txn);
        if len > 0 {
            arr.remove_range(&mut txn, 0, len);
        }
        for id in order {
            arr.push_back(&mut txn, Any::String(id.as_str().into()));
        }
        let update = txn.encode_state_as_update_v1(&before);
        drop(txn);
        self.dirty.store(true, Ordering::Relaxed);
        protocol::frame_update(update)
    }

    /// Replace a page's prose by rebuilding its `prose:<page_id>` fragment from
    /// `html` in a single transaction (JP-238). Whole-page replace: clear the
    /// fragment, parse the HTML to PM nodes ([`prose_parse`]), and rebuild —
    /// returns the framed CRDT delta to broadcast; marks dirty. The inverse of
    /// the [`prose_html`] read serializer (shared [`prose_schema`] mapping).
    ///
    /// One atomic txn ⇒ peers apply it as a single change (no transient-empty
    /// render) and the JP-189 prose-zeroing guard only sees the final state.
    /// Empty/whitespace `html` rebuilds a single empty paragraph — the editor's
    /// "a page is never truly empty" invariant.
    pub fn replace_prose(&self, page_id: &str, html: &str) -> Result<Vec<u8>, String> {
        let name = format!("prose:{page_id}");
        // Grab the fragment handle before opening the txn (`get_or_insert_*`
        // transacts; nesting deadlocks).
        let frag = self.doc.get_or_insert_xml_fragment(name.as_str());

        // Gate: validate + normalize before the tree reaches the Y.Doc (JP-328),
        // so a malformed node can't crash the client's NodeView reconciliation.
        let (mut blocks, fixes) = prose_validate::sanitize_blocks(prose_parse::html_to_blocks(html));
        if !fixes.is_empty() {
            log::info!(
                "prose_validate healed {} defect(s) seeding prose:{page_id}: {fixes:?}",
                fixes.len()
            );
        }
        if blocks.is_empty() {
            blocks.push(prose_parse::PmNode {
                node_type: "paragraph".to_string(),
                attrs: Vec::new(),
                children: Vec::new(),
            });
        }

        let mut txn = self.doc.transact_mut();
        let before = txn.before_state().clone();
        let len = frag.len(&txn);
        if len == 0 {
            // JP-338: FIRST seed of an empty fragment (a new `add_prose_page`, or
            // the first `set_prose` into the empty default page) — build the
            // **deterministic** lineage, identical to what a future re-hydration
            // (`json_prose_to_ydoc`) produces, so a client that caches this write
            // dedupes on merge instead of doubling. Safe only because the fragment
            // is empty (no prior FNV structs → no clock/tombstone collision); a
            // rewrite (`len > 0`) keeps the live build below.
            if let Some(update) = deterministic_seed_update(page_id, &blocks) {
                let _ = txn.apply_update(update);
            }
        } else {
            // Rewrite/edit of existing content — clear + live build (the live
            // client-id is correct here; the content already had a lineage).
            frag.remove_range(&mut txn, 0, len);
            for node in &blocks {
                build_prose_node(&frag, &mut txn, node);
            }
        }
        let update = txn.encode_state_as_update_v1(&before);
        drop(txn);
        self.dirty.store(true, Ordering::Relaxed);
        Ok(protocol::frame_update(update))
    }

    /// Anchored, block-level prose write (JP-239): replace only the top-level
    /// block(s) matching `anchor` (through `anchor_until`, if given) with
    /// `html`, in one transaction. Returns the framed CRDT delta to broadcast;
    /// marks dirty. An `Err` (no match / ambiguous / bad range) leaves the live
    /// fragment untouched — the delta touches only the changed blocks, so a
    /// concurrent edit elsewhere on the page is preserved. See [`prose_block`].
    pub fn replace_prose_block(
        &self,
        page_id: &str,
        anchor: &str,
        anchor_until: Option<&str>,
        html: &str,
    ) -> Result<Vec<u8>, String> {
        let name = format!("prose:{page_id}");
        let frag = self.doc.get_or_insert_xml_fragment(name.as_str());
        let mut txn = self.doc.transact_mut();
        let before = txn.before_state().clone();
        prose_block::replace_block_in_fragment(&frag, &mut txn, anchor, anchor_until, html)?;
        let update = txn.encode_state_as_update_v1(&before);
        drop(txn);
        self.dirty.store(true, Ordering::Relaxed);
        Ok(protocol::frame_update(update))
    }
}

/// Append one PM node (and its subtree) to `parent`. Generic over the parent
/// kind (`XmlFragmentRef` at the root, `XmlElementRef` when recursing).
fn build_prose_node<P: XmlFragment>(parent: &P, txn: &mut TransactionMut, node: &prose_parse::PmNode) {
    let el = parent.push_back(txn, XmlElementPrelim::empty(node.node_type.as_str()));
    for (k, v) in &node.attrs {
        el.insert_attribute(txn, k.as_str(), v.clone());
    }
    build_prose_children(&el, txn, &node.children);
}

fn build_prose_children<P: XmlFragment>(
    parent: &P,
    txn: &mut TransactionMut,
    children: &[prose_parse::PmChild],
) {
    for child in children {
        match child {
            prose_parse::PmChild::Text { text, marks } => {
                if text.is_empty() {
                    continue;
                }
                let xtext = parent.push_back(txn, XmlTextPrelim::new(text.as_str()));
                if !marks.is_empty() {
                    // Format the whole inserted run at once — `len()` is in the
                    // doc's offset unit, so we never miscompute multibyte ranges.
                    let run_len = xtext.len(&*txn);
                    if run_len > 0 {
                        xtext.format(txn, 0, run_len, marks_to_attrs(marks));
                    }
                }
            }
            prose_parse::PmChild::Node(node) => build_prose_node(parent, txn, node),
        }
    }
}

/// A per-page, content-independent **bootstrap** client-id for deterministic
/// prose seeding (JP-319). FNV-1a over the page id — stable across builds and
/// hosts (unlike `DefaultHasher`), so any relay or client that seeds the same
/// page produces byte-identical CRDT items.
///
/// This is **not** a live-edit client-id and does **not** reintroduce the JP-172
/// collision class: it authors only deterministic, never-yet-live bootstrap
/// content, scoped to a single page within a single doc (page ids are unique per
/// doc); live editors keep their random ids. Its sole job is to make a re-seed —
/// a later rehydrate, or a client that cached the prior bootstrap in y-indexeddb
/// — DEDUPE on merge instead of concatenating (the lineage-churn fix).
/// Keep-first dedupe of a `shapeOrder`-style id sequence, dropping ids for which
/// `present` is false (orphans). JP-330: `shapeOrder` is a CRDT `Y.Array` (a
/// sequence, not a set), so non-idempotent seeding (re-hydration) or a
/// dual-origin merge can leave it with the same id twice while the `shapes`
/// `Y.Map` stays unique. Every consumer that surfaces order — flatten (persist),
/// `get_page` (agent read), hydration (re-seed) — routes through this so the
/// rendered/served/stored order is canonical regardless of the live array.
pub(crate) fn dedupe_order<'a>(
    ids: impl IntoIterator<Item = &'a str>,
    present: impl Fn(&str) -> bool,
) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    ids.into_iter()
        .filter(|id| present(id) && seen.insert(id.to_string()))
        .map(|id| id.to_string())
        .collect()
}

fn deterministic_seed_client_id(page_id: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325; // FNV-1a 64-bit offset basis
    for b in page_id.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3); // FNV prime
    }
    // yrs `ClientID` is a 53-bit (JS-safe-integer) value — the top 11 bits must
    // be zero. Fold the hash into the low 53 bits.
    h & ((1u64 << 53) - 1)
}

/// Seed one prose page's `prose:<page_id>` fragment into `live`
/// **deterministically** (JP-319): build the blocks in a throwaway Doc whose
/// client-id is fixed by [`deterministic_seed_client_id`], encode it as an
/// update, and apply that to `live`. Because the seed's client-id + clocks +
/// content are fully determined by `(page_id, blocks)`, seeding identical
/// content always yields identical CRDT items — so when two independently-seeded
/// copies meet (a relay rehydrate vs a client's cached bootstrap) they dedupe
/// rather than doubling. Re-applying the same seed is a no-op.
fn seed_prose_deterministic(live: &Doc, page_id: &str, blocks: &[prose_parse::PmNode]) {
    if let Some(update) = deterministic_seed_update(page_id, blocks) {
        let _ = live.transact_mut().apply_update(update);
    }
}

/// Build the deterministic seed **update** for a page's prose (the shared core of
/// [`seed_prose_deterministic`]): author `blocks` in a throwaway `Doc` whose
/// client-id is fixed by [`deterministic_seed_client_id`], then encode the full
/// state as a v1 update. Applying it to an **empty** `prose:<page_id>` fragment —
/// on any relay or client — yields byte-identical CRDT items, so independent
/// seeders dedupe on merge instead of doubling. Returned (rather than applied) so
/// a caller (JP-338: `replace_prose`'s first-seed) can apply it inside its own
/// transaction and capture the delta to broadcast. `None` only on a malformed
/// (undecodable) update, which never happens for content we just built.
fn deterministic_seed_update(page_id: &str, blocks: &[prose_parse::PmNode]) -> Option<yrs::Update> {
    use yrs::updates::decoder::Decode;
    let seed = Doc::with_client_id(deterministic_seed_client_id(page_id));
    let frag = seed.get_or_insert_xml_fragment(format!("prose:{page_id}").as_str());
    {
        let mut txn = seed.transact_mut();
        for node in blocks {
            build_prose_node(&frag, &mut txn, node);
        }
    }
    let update = seed
        .transact()
        .encode_state_as_update_v1(&yrs::StateVector::default());
    yrs::Update::decode_v1(&update).ok()
}

/// JP-338 self-heal: if a `prose:<id>` fragment is the body concatenated **exactly
/// twice** — the write-vs-hydrate lineage-merge signature — drop the duplicate
/// half. Returns whether it collapsed.
///
/// **Strict**: fires only on an exact full-fragment 2× repetition — an even
/// top-level child count where the first half serializes byte-identically to the
/// second. Never a per-block dedup, so prose that legitimately repeats a paragraph
/// is left untouched. The delete is a normal CRDT op, so whoever runs it (relay on
/// hydrate, or a client after sync) propagates the repair to every peer.
pub(crate) fn collapse_doubled_prose(frag: &XmlFragmentRef, txn: &mut TransactionMut) -> bool {
    let n = frag.len(txn);
    // Require ≥2 blocks per half (n ≥ 4): the real bug doubles a whole multi-block
    // page body, while two identical *single* paragraphs (n == 2) are plausibly
    // intentional — never collapse those.
    if n < 4 || n % 2 != 0 {
        return false;
    }
    let half = n / 2;
    let first = prose_html::fragment_children_range_to_html(frag, txn, 0, half);
    if first.is_empty() {
        return false;
    }
    let second = prose_html::fragment_children_range_to_html(frag, txn, half, n);
    if first != second {
        return false;
    }
    frag.remove_range(txn, half, half);
    true
}

/// Collapse any doubled `prose:*` fragments in `doc` in place (JP-338 self-heal on
/// hydrate). Returns whether anything changed — the caller marks the handle dirty
/// so the next snapshot rewrites the repaired state. Repairs a doc whose persisted
/// `richTextPages` content was already doubled (it hydrates doubled, then heals).
fn heal_doubled_prose_in(doc: &Doc) -> bool {
    let names: Vec<String> = {
        let txn = doc.transact();
        txn.root_refs()
            .map(|(name, _)| name)
            .filter(|name| name.starts_with("prose:"))
            .map(String::from)
            .collect()
    };
    let mut healed = false;
    for name in names {
        let frag = doc.get_or_insert_xml_fragment(name.as_str());
        let mut txn = doc.transact_mut();
        if collapse_doubled_prose(&frag, &mut txn) {
            healed = true;
        }
    }
    healed
}

/// All of a run's marks as one Yjs formatting attribute set: boolean marks →
/// `true`, `link` → `{ href }` (matching the read side's `link_href`).
fn marks_to_attrs(marks: &[prose_parse::PmMark]) -> Attrs {
    let mut attrs = Attrs::new();
    for m in marks {
        let value = match &m.href {
            Some(href) => Any::Map(Arc::new(std::collections::HashMap::from([(
                "href".to_string(),
                Any::String(href.as_str().into()),
            )]))),
            None => Any::Bool(true),
        };
        attrs.insert(Arc::from(m.name.as_str()), value);
    }
    attrs
}

/// In-memory registry of active-document Y.Docs, keyed by `(workspace, doc)`.
///
/// Entries are pure caches: created on demand (hydrated from the snapshot)
/// and evicted by the WS server when no connected client references the doc.
/// Liveness is owned by the server's client table — this type holds no
/// refcount of its own, which keeps eviction race-free against the
/// connect/disconnect path.
#[derive(Default)]
pub struct DocRegistry {
    docs: RwLock<HashMap<(WorkspaceId, DocId), Arc<DocHandle>>>,
}

impl DocRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Return the handle for `(ws, doc_id)` if one is already resident.
    pub fn get(&self, ws: &WorkspaceId, doc_id: &DocId) -> Option<Arc<DocHandle>> {
        let key = (ws.clone(), doc_id.clone());
        self.docs.read().unwrap().get(&key).cloned()
    }

    /// Return the resident handle, or hydrate one from `doc_json` (preferring
    /// the binary sidecar `ydoc_bin` when current, JP-108) and insert it.
    /// Idempotent: concurrent callers share the first hydration.
    pub fn ensure(
        &self,
        ws: &WorkspaceId,
        doc_id: &DocId,
        doc_json: &Value,
        ydoc_bin: Option<&[u8]>,
        poison_guard: bool,
    ) -> Arc<DocHandle> {
        if let Some(handle) = self.get(ws, doc_id) {
            return handle;
        }
        let key = (ws.clone(), doc_id.clone());
        let mut docs = self.docs.write().unwrap();
        docs.entry(key)
            .or_insert_with(|| Arc::new(DocHandle::hydrate(doc_json, ydoc_bin, poison_guard)))
            .clone()
    }

    /// Drop the handle for `(ws, doc_id)`. Called by the server once the last
    /// client on the doc disconnects (the server snapshots it first, JP-36).
    pub fn evict(&self, ws: &WorkspaceId, doc_id: &DocId) {
        let key = (ws.clone(), doc_id.clone());
        self.docs.write().unwrap().remove(&key);
    }

    /// Snapshot of all resident `(key, handle)` pairs, cloned under the read
    /// lock so the caller can iterate (and do I/O) without holding it. Used by
    /// the JP-36 snapshot sweeper.
    pub fn entries(&self) -> Vec<((WorkspaceId, DocId), Arc<DocHandle>)> {
        self.docs
            .read()
            .unwrap()
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }

    /// Number of resident docs (diagnostics / tests).
    #[allow(dead_code)]
    pub fn len(&self) -> usize {
        self.docs.read().unwrap().len()
    }

    #[allow(dead_code)]
    pub fn is_empty(&self) -> bool {
        self.docs.read().unwrap().is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::{
        binary, collapse_doubled_prose, hydration, prose_html, DocHandle, DocRegistry,
        TransactionMut, XmlFragmentRef,
    };
    use serde_json::json;
    use std::sync::Arc;
    use yrs::{Any, Array, Doc, GetString, Map, ReadTxn, Text, Transact};

    use crate::server::protocol::{DocId, WorkspaceId};

    /// A JSON body with one shape on its active page, at `server_version`.
    fn json_body(server_version: u64) -> serde_json::Value {
        json!({
            "id": "d", "serverVersion": server_version, "activePageId": "p1",
            "pages": {"p1": {"shapes": {"s1": {"id": "s1"}}, "shapeOrder": ["s1"]}}
        })
    }

    /// A binary sidecar carrying a `prose:p1` text the JSON body never has, so
    /// tests can tell which source hydration chose.
    fn binary_with_prose(server_version: u64, text: &str) -> Vec<u8> {
        let doc = Doc::new();
        let prose = doc.get_or_insert_text("prose:p1");
        let shapes = doc.get_or_insert_map("shapes");
        let mut txn = doc.transact_mut();
        prose.insert(&mut txn, 0, text);
        // Carry the same shape `json_body` has so a *current* binary isn't a
        // false poison-guard trigger (0 binary shapes while JSON has N>0).
        shapes.insert(&mut txn, "s1", yrs::Any::String("rect".into()));
        drop(txn);
        binary::encode_snapshot(server_version, &doc)
    }

    /// A binary sidecar with `server_version` and **no shapes** (only prose) —
    /// the poison signature when paired with a JSON body that has shapes.
    fn poisoned_binary(server_version: u64) -> Vec<u8> {
        let doc = Doc::new();
        let prose = doc.get_or_insert_text("prose:p1");
        let mut txn = doc.transact_mut();
        prose.insert(&mut txn, 0, "orphan prose");
        drop(txn);
        binary::encode_snapshot(server_version, &doc)
    }

    /// A JSON body whose active page has no shapes, at `server_version`.
    fn empty_json_body(server_version: u64) -> serde_json::Value {
        json!({
            "id": "d", "serverVersion": server_version, "activePageId": "p1",
            "pages": {"p1": {"shapes": {}, "shapeOrder": []}}
        })
    }

    #[test]
    fn hydrate_prefers_binary_when_version_matches() {
        let handle =
            DocHandle::hydrate(&json_body(5), Some(&binary_with_prose(5, "from binary")), true);
        // Binary used → its prose is present (JSON hydration never creates it).
        let prose = handle.doc.get_or_insert_text("prose:p1");
        assert_eq!(prose.get_string(&handle.doc.transact()), "from binary");
    }

    #[test]
    fn hydrate_falls_back_to_json_when_binary_is_stale() {
        // Binary tagged v4, JSON body bumped to v7 by an out-of-band write.
        let handle =
            DocHandle::hydrate(&json_body(7), Some(&binary_with_prose(4, "stale")), true);
        let shapes = handle.doc.get_or_insert_map("shapes");
        let prose = handle.doc.get_or_insert_text("prose:p1");
        let txn = handle.doc.transact();
        assert!(shapes.contains_key(&txn, "s1"), "JSON shapes hydrated");
        assert_eq!(prose.get_string(&txn), "", "stale binary prose ignored");
    }

    #[test]
    fn hydrate_binary_backstop_fills_only_empty_prose_fragments() {
        use yrs::{Map, XmlElementPrelim, XmlFragment, XmlTextPrelim};
        // Binary sidecar: current version, has shapes (not poisoned), carries
        // prose for p1 — but NOT p2.
        let bin = {
            let doc = Doc::new();
            let shapes = doc.get_or_insert_map("shapes");
            let frag = doc.get_or_insert_xml_fragment("prose:p1");
            let mut txn = doc.transact_mut();
            shapes.insert(&mut txn, "s1", yrs::Any::String("rect".into()));
            let p = frag.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
            p.push_back(&mut txn, XmlTextPrelim::new("from binary"));
            drop(txn);
            binary::encode_snapshot(9, &doc)
        };
        // JSON at a lower version → the binary wins, but it has richTextPages for
        // BOTH pages.
        let json = json!({
            "id": "d", "serverVersion": 1, "activePageId": "p1",
            "pages": {"p1": {"shapes": {"s1": {"id": "s1"}}, "shapeOrder": ["s1"]}},
            "richTextPages": { "pageOrder": ["p1", "p2"], "pages": {
                "p1": {"content": "<p>should not override</p>"},
                "p2": {"content": "<p>backstop fill</p>"}
            }}
        });
        let handle = DocHandle::hydrate(&json, Some(&bin), true);
        // JP-284 backstop: p1 keeps the binary's prose (NOT overridden by
        // richTextPages); p2 — empty in the binary — is filled from richTextPages.
        assert_eq!(handle.prose_html("p1").as_deref(), Some("<p>from binary</p>"));
        assert_eq!(handle.prose_html("p2").as_deref(), Some("<p>backstop fill</p>"));
    }

    #[test]
    fn prose_html_serializes_live_fragment() {
        use yrs::{XmlElementPrelim, XmlFragment, XmlTextPrelim};
        // A binary sidecar whose `prose:p1` is a real XmlFragment (paragraph +
        // text) — the shape y-prosemirror produces, unlike the plain-text
        // `binary_with_prose` helper.
        let bin = {
            let doc = Doc::new();
            let frag = doc.get_or_insert_xml_fragment("prose:p1");
            {
                let mut txn = doc.transact_mut();
                let p = frag.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
                p.push_back(&mut txn, XmlTextPrelim::new("Live prose"));
            }
            binary::encode_snapshot(9, &doc)
        };
        // JSON at a lower version → hydration uses the binary sidecar.
        let handle = DocHandle::hydrate(&empty_json_body(1), Some(&bin), false);
        assert_eq!(handle.prose_html("p1").as_deref(), Some("<p>Live prose</p>"));
        assert!(handle.prose_html("absent").is_none(), "no fragment → None (caller uses JSON)");
        assert_eq!(
            handle.prose_pages(),
            vec![("p1".to_string(), "<p>Live prose</p>".to_string())]
        );
    }

    #[test]
    fn replace_prose_round_trips_through_the_serializer() {
        // html → replace_prose (parse + rebuild fragment) → prose_html (read).
        // The write parser + read serializer share `prose_schema`, so the common
        // subset is stable.
        let cases = [
            "<p>Hello <strong>world</strong></p>",
            "<h2>Title</h2><p>body</p>",
            "<ul><li><p>a</p></li><li><p>b</p></li></ul>",
            "<pre><code>let x = 1;</code></pre>",
            r#"<p><a href="https://x.test/a?b=1">go</a></p>"#,
            "<p>a<br>b</p>",
            "<p><strong><em>both</em></strong></p>",
            "<p>a &lt; b &amp; c</p>",
            // JP-89 custom prose-helper nodes (byte-exact round-trip — the
            // serializer's deterministic attr order matches these inputs).
            r#"<p>see <span data-citation data-ref-id="knuth1997" data-label="(Knuth, 1997)">(Knuth, 1997)</span>.</p>"#,
            r#"<div data-bibliography data-bib-html="&lt;div&gt;Knuth, D.&lt;/div&gt;"></div>"#,
        ];
        for html in cases {
            let handle = DocHandle::hydrate(&empty_json_body(1), None, false);
            let framed = handle.replace_prose("p1", html).expect("replace_prose");
            assert!(!framed.is_empty(), "a framed delta is returned to broadcast");
            assert_eq!(handle.prose_html("p1").as_deref(), Some(html), "round-trip: {html}");
        }
    }

    #[test]
    fn jp338_first_seed_dedupes_with_rehydration() {
        // Root-cause regression (Stage 1a): a page's FIRST content-write (into an
        // empty fragment) must use the deterministic lineage, so a client that
        // cached the write and the relay's later re-hydration DEDUPE on merge
        // instead of doubling. Before the fix the write used the live client-id
        // (lineage L) and this merge doubled.
        use yrs::updates::decoder::Decode;
        use yrs::{StateVector, Update};
        let html = "<h1>Architecture</h1><p>body text</p>";

        // First write via replace_prose (empty fragment → deterministic seed).
        let writer = DocHandle::hydrate(&empty_json_body(1), None, false);
        writer.replace_prose("p1", html).unwrap();
        let cached = writer
            .doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());

        // Independent fresh hydration of the same content from richTextPages (D).
        let json = json!({
            "id": "d", "serverVersion": 1, "activePageId": "p1",
            "pages": {"p1": {"shapes": {}, "shapeOrder": []}},
            "richTextPages": {"pageOrder": ["p1"], "pages": {"p1": {"content": html}}}
        });
        let relay = DocHandle::hydrate(&json, None, false);

        // The cached write meets the re-hydrated relay (the reload merge).
        {
            let mut txn = relay.doc.transact_mut();
            txn.apply_update(Update::decode_v1(&cached).unwrap()).unwrap();
        }
        assert_eq!(
            relay.prose_html("p1").as_deref(),
            Some(html),
            "deterministic first-seed dedupes on rehydrate — single copy, not doubled"
        );
    }

    #[test]
    fn jp338_collapse_doubled_prose_heals_exact_double() {
        use yrs::{Xml, XmlElementPrelim, XmlFragment, XmlTextPrelim};
        let doc = Doc::new();
        let frag = doc.get_or_insert_xml_fragment("prose:p1");
        {
            let mut txn = doc.transact_mut();
            // body = [h1, p]; doubled = [h1, p, h1, p] (the observed signature).
            for _ in 0..2 {
                let h = frag.push_back(&mut txn, XmlElementPrelim::empty("heading"));
                h.insert_attribute(&mut txn, "level", "1");
                h.push_back(&mut txn, XmlTextPrelim::new("Title"));
                let p = frag.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
                p.push_back(&mut txn, XmlTextPrelim::new("body"));
            }
        }
        {
            let mut txn = doc.transact_mut();
            assert!(collapse_doubled_prose(&frag, &mut txn), "exact double collapses");
        }
        let txn = doc.transact();
        assert_eq!(
            prose_html::fragment_to_html(&frag, &txn),
            "<h1>Title</h1><p>body</p>",
            "duplicate half removed"
        );
    }

    #[test]
    fn jp338_collapse_is_strict_no_false_positives() {
        use yrs::{XmlElementPrelim, XmlFragment, XmlTextPrelim};
        let para = |frag: &XmlFragmentRef, txn: &mut TransactionMut, label: &str| {
            let p = frag.push_back(txn, XmlElementPrelim::empty("paragraph"));
            p.push_back(txn, XmlTextPrelim::new(label));
        };

        // Two identical SINGLE paragraphs (n == 2) — plausibly intentional; never
        // collapse (the ≥2-blocks-per-half guard).
        let doc = Doc::new();
        let frag = doc.get_or_insert_xml_fragment("prose:p1");
        {
            let mut txn = doc.transact_mut();
            para(&frag, &mut txn, "same");
            para(&frag, &mut txn, "same");
        }
        {
            let mut txn = doc.transact_mut();
            assert!(!collapse_doubled_prose(&frag, &mut txn), "n==2 is never collapsed");
        }

        // Halves differ ([A,B,A,C]) — not a clean double → untouched.
        let doc2 = Doc::new();
        let frag2 = doc2.get_or_insert_xml_fragment("prose:p2");
        {
            let mut txn = doc2.transact_mut();
            for label in ["A", "B", "A", "C"] {
                para(&frag2, &mut txn, label);
            }
        }
        {
            let mut txn = doc2.transact_mut();
            assert!(!collapse_doubled_prose(&frag2, &mut txn), "unequal halves untouched");
        }
    }

    #[test]
    fn jp338_hydration_heals_already_doubled_richtextpages() {
        // Repair path: a doc whose persisted prose is already `body+body` hydrates
        // doubled, then self-heals to a single copy (so the next snapshot is clean).
        let html = "<h1>Overview</h1><p>the body</p>";
        let doubled = format!("{html}{html}");
        let json = json!({
            "id": "d", "serverVersion": 1, "activePageId": "p1",
            "pages": {"p1": {"shapes": {}, "shapeOrder": []}},
            "richTextPages": {"pageOrder": ["p1"], "pages": {"p1": {"content": doubled}}}
        });
        let handle = DocHandle::hydrate(&json, None, false);
        assert_eq!(
            handle.prose_html("p1").as_deref(),
            Some(html),
            "doubled richTextPages hydrates, then heals to single"
        );
    }

    #[test]
    fn custom_prose_nodes_survive_hydration() {
        // The JP-89 collab-foundation regression, on the open-doc path: a doc
        // hydrated from stored JSON whose prose carries a citation + bibliography
        // must keep them in the live Y.Doc (seed → serialize), not degrade the
        // <span> to plain text or drop the <div>. This is the exact flow that
        // failed on staging once a doc went resident.
        let content = concat!(
            r#"<p>Sorting is deep <span data-citation data-ref-id="knuth1997" data-label="(Knuth, 1997)">(Knuth, 1997)</span>.</p>"#,
            r#"<div data-bibliography data-bib-html="&lt;div&gt;Knuth, D.&lt;/div&gt;"></div>"#
        );
        let json = json!({
            "id": "d", "serverVersion": 1, "activePageId": "p1",
            "pages": {"p1": {"shapes": {}, "shapeOrder": []}},
            "richTextPages": { "pageOrder": ["p1"], "pages": {
                "p1": {"content": content}
            }}
        });
        let handle = DocHandle::hydrate(&json, None, false);
        let html = handle.prose_html("p1").expect("p1 prose seeded");
        assert!(html.contains(r#"data-ref-id="knuth1997""#), "citation ref survives: {html}");
        assert!(html.contains(r#"data-label="(Knuth, 1997)""#), "citation label survives: {html}");
        assert!(html.contains(r#"<div data-bibliography data-bib-html="&lt;div&gt;Knuth, D.&lt;/div&gt;">"#), "bibliography survives: {html}");
    }

    #[test]
    fn replace_prose_empty_yields_single_paragraph() {
        let handle = DocHandle::hydrate(&empty_json_body(1), None, false);
        handle.replace_prose("p1", "   ").expect("replace_prose");
        assert_eq!(handle.prose_html("p1").as_deref(), Some("<p></p>"));
    }

    #[test]
    fn replace_prose_clears_prior_content() {
        let handle = DocHandle::hydrate(&empty_json_body(1), None, false);
        handle.replace_prose("p1", "<p>first</p><p>second</p>").unwrap();
        handle.replace_prose("p1", "<p>only</p>").unwrap();
        assert_eq!(handle.prose_html("p1").as_deref(), Some("<p>only</p>"));
    }

    // --- JP-319 prose-integrity repro (RED until the fix lands) ---
    //
    // These two tests pin the two faces of the MCP-page seeding bug. They are
    // expected to FAIL on `master` — they are the acceptance gate (2a): the fix
    // (relay node-validation gate + seed stabilization) turns them green.

    #[test]
    fn jp319_src_less_image_is_not_seeded_as_a_naked_atom() {
        // The client's image node parses only `img[src]` and is an atom (no
        // children). An `<img>` with no src seeds an `image` element with no
        // `src` attribute, which the client can't reconcile — ReactNodeView's
        // desc-tree walk throws "Cannot read properties of undefined (reading
        // 'children')" on open. The relay must not seed a src-less image atom
        // (drop it, or keep it as literal text — never a naked `image` node).
        let handle = DocHandle::hydrate(&empty_json_body(1), None, false);
        handle.replace_prose("p1", r#"<img alt="logo">"#).unwrap();
        let html = handle.prose_html("p1").unwrap_or_default();
        assert!(
            !html.contains("<img") || html.contains("src=\""),
            "a src-less <img> must not survive as a naked image atom, got: {html}"
        );
    }

    #[test]
    fn jp319_image_attrs_survive_the_mcp_round_trip() {
        // pre-test #6: an image must keep src + sizing + float across an MCP
        // HTML→Y.Doc→HTML round-trip. Dropping width/height/data-float reset the
        // image to inline on every MCP edit; `data-float` ↔ `float` is the
        // HTML↔PM name translation that makes the float survive.
        let handle = DocHandle::hydrate(&empty_json_body(1), None, false);
        let html = r#"<img src="blob:abc" alt="logo" width="300" height="120" data-float="left">"#;
        handle.replace_prose("p1", html).unwrap();
        assert_eq!(handle.prose_html("p1").as_deref(), Some(html));
    }

    #[test]
    fn jp319_2d_structural_blocks_round_trip() {
        // Callout / figure / gallery now round-trip through the relay instead of
        // being silently unwrapped (lossy). HTML↔PM attr translation: callout
        // `data-variant`↔`variant`, gallery `data-layout`↔`layout`; gallery
        // images are lifted out of the render-only `.gallery-items` wrapper.
        let cases = [
            r#"<div data-callout data-variant="warning"><p>heads up</p></div>"#,
            r#"<figure><img src="blob:x" alt="diagram"><figcaption>Fig 1</figcaption></figure>"#,
            r#"<div data-gallery data-layout="row"><div class="gallery-items"><img src="blob:a"><img src="blob:b"></div></div>"#,
        ];
        for html in cases {
            let handle = DocHandle::hydrate(&empty_json_body(1), None, false);
            handle.replace_prose("p1", html).unwrap();
            assert_eq!(handle.prose_html("p1").as_deref(), Some(html), "round-trip: {html}");
        }
    }

    #[test]
    fn jp328_validate_prose_html_reports_a_diff_for_malformed_input() {
        // `validate_prose_html` is what the MCP set_prose/add_prose_page tools
        // call to surface the `fixes` diff to the author. Clean HTML reports no
        // fixes; malformed HTML (a ragged table the gate rebuilds rectangular)
        // reports at least one.
        assert!(
            super::validate_prose_html("<p>clean</p>").is_empty(),
            "well-formed prose must report no fixes"
        );
        let fixes =
            super::validate_prose_html("<table><tr><td>a</td><td>b</td></tr><tr><td>c</td></tr></table>");
        assert!(
            !fixes.is_empty(),
            "a ragged table must be reported as a fix so the author sees the heal"
        );
    }

    #[test]
    fn jp319_2d_figure_without_image_degrades_safely() {
        // `figcaption` has no block group on the client — emitting one standalone
        // would crash. A <figure> with no usable <img> must degrade to its text,
        // never leave an orphan figcaption.
        let handle = DocHandle::hydrate(&empty_json_body(1), None, false);
        handle
            .replace_prose("p1", "<figure><figcaption>orphan</figcaption></figure>")
            .unwrap();
        let html = handle.prose_html("p1").unwrap_or_default();
        assert!(!html.contains("figcaption"), "no standalone figcaption, got: {html}");
    }

    #[test]
    fn jp319_json_seed_lineage_churn_does_not_duplicate_on_merge() {
        use yrs::updates::decoder::Decode;
        use yrs::{StateVector, Update};
        // The duplication root (report #1 / pre-test #7): a page seeded from the
        // SAME JSON into two independent Docs gets two random client-ids → two
        // CRDT lineages for identical content (JP-172 made client-id random). When
        // a client carrying the prior lineage syncs with a freshly-rehydrated
        // relay Doc, the fragments concatenate and the page doubles.
        let snapshot = json!({
            "id": "d",
            "richTextPages": { "pageOrder": ["rt1"], "pages": { "rt1": {"content": "<p>hello</p>"} } }
        });
        let doc_a = Doc::new();
        hydration::json_prose_to_ydoc(&snapshot, &doc_a);
        let doc_b = Doc::new();
        hydration::json_prose_to_ydoc(&snapshot, &doc_b);

        let update_a = doc_a
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        doc_b
            .transact_mut()
            .apply_update(Update::decode_v1(&update_a).unwrap())
            .unwrap();

        let f = doc_b.get_or_insert_xml_fragment("prose:rt1");
        let txn = doc_b.transact();
        let html = super::prose_html::fragment_to_html(&f, &txn);
        assert_eq!(
            html, "<p>hello</p>",
            "JSON-seed lineage churn must not duplicate identical content on merge, got: {html}"
        );
    }

    #[test]
    fn hydrate_uses_json_when_no_binary() {
        let handle = DocHandle::hydrate(&json_body(1), None, true);
        let shapes = handle.doc.get_or_insert_map("shapes");
        assert!(shapes.contains_key(&handle.doc.transact(), "s1"));
    }

    #[test]
    fn poison_binary_zero_json_nonzero_prefers_json_and_self_heals() {
        // Current-version binary with 0 shapes, JSON snapshot with 1 → poison.
        let handle = DocHandle::hydrate(&json_body(5), Some(&poisoned_binary(5)), true);
        let shapes = handle.doc.get_or_insert_map("shapes");
        let prose = handle.doc.get_or_insert_text("prose:p1");
        let txn = handle.doc.transact();
        // Rebuilt from JSON: the shape is present…
        assert!(shapes.contains_key(&txn, "s1"), "rebuilt from JSON");
        // …and the poisoned binary's orphan prose was discarded.
        assert_eq!(prose.get_string(&txn), "", "poisoned binary ignored");
        drop(txn);
        // Self-heal: handle is dirty so the next snapshot rewrites the sidecar.
        assert!(handle.take_dirty(), "poison heal marks the handle dirty");
    }

    #[test]
    fn both_empty_is_not_a_false_poison() {
        // Binary 0 shapes + JSON 0 shapes (a legitimate empty doc) → no trigger,
        // not dirtied. Uses the binary unchanged (prose present proves it).
        let handle = DocHandle::hydrate(&empty_json_body(5), Some(&poisoned_binary(5)), true);
        let prose = handle.doc.get_or_insert_text("prose:p1");
        assert_eq!(
            prose.get_string(&handle.doc.transact()),
            "orphan prose",
            "empty-vs-empty serves the binary unchanged"
        );
        assert!(!handle.take_dirty(), "no heal, no dirty");
    }

    #[test]
    fn binary_nonzero_json_empty_keeps_binary() {
        // Binary has the shape, JSON is empty → binary is authoritative, no
        // false trigger (the guard only fires on binary 0 / JSON N>0).
        let handle =
            DocHandle::hydrate(&empty_json_body(5), Some(&binary_with_prose(5, "live")), true);
        let shapes = handle.doc.get_or_insert_map("shapes");
        let prose = handle.doc.get_or_insert_text("prose:p1");
        let txn = handle.doc.transact();
        assert!(shapes.contains_key(&txn, "s1"), "binary shapes kept");
        assert_eq!(prose.get_string(&txn), "live", "binary preferred");
    }

    #[test]
    fn poison_guard_off_serves_binary_empty() {
        // Flag disabled → the old behavior: a current 0-shape binary is served
        // even though JSON has shapes (proves the guard gates the new path).
        let handle = DocHandle::hydrate(&json_body(5), Some(&poisoned_binary(5)), false);
        let shapes = handle.doc.get_or_insert_map("shapes");
        assert_eq!(shapes.len(&handle.doc.transact()), 0, "served empty binary");
        assert!(!handle.take_dirty(), "no heal when guard is off");
    }

    #[test]
    fn suspicious_zeroing_only_fires_on_n_to_zero() {
        assert!(super::suspicious_zeroing(3, 0), "N>0 → 0 is suspicious");
        assert!(!super::suspicious_zeroing(0, 0), "empty → empty is fine");
        assert!(!super::suspicious_zeroing(0, 3), "growth is fine");
        assert!(!super::suspicious_zeroing(3, 2), "partial delete is fine");
    }

    // ---- JP-189 prose poison guard ----

    /// A `Y.Doc` with `non_empty` populated `prose:*` pages (one `<paragraph>`
    /// child each, the production `Y.XmlFragment` shape) plus `empty` empty ones
    /// and an unrelated `shapes` map (must be ignored by the prose count).
    fn prose_doc(non_empty: usize, empty: usize) -> Doc {
        use yrs::{XmlElementPrelim, XmlFragment};
        let doc = Doc::new();
        // Grab the root handles *before* the txn (`get_or_insert_*` transacts).
        let full: Vec<_> = (0..non_empty)
            .map(|i| doc.get_or_insert_xml_fragment(format!("prose:p{i}")))
            .collect();
        for i in 0..empty {
            doc.get_or_insert_xml_fragment(format!("prose:empty{i}"));
        }
        let shapes = doc.get_or_insert_map("shapes");
        let mut txn = doc.transact_mut();
        for frag in &full {
            frag.insert(&mut txn, 0, XmlElementPrelim::empty("paragraph"));
        }
        shapes.insert(&mut txn, "s1", yrs::Any::String("rect".into()));
        drop(txn);
        doc
    }

    #[test]
    fn doc_prose_count_counts_only_non_empty_prose_pages() {
        // 2 populated + 1 empty prose page; the shapes map is not prose.
        assert_eq!(super::doc_prose_count(&prose_doc(2, 1)), 2);
        assert_eq!(super::doc_prose_count(&prose_doc(0, 3)), 0);
        assert_eq!(super::doc_prose_count(&prose_doc(5, 0)), 5);
    }

    #[test]
    fn prose_count_in_binary_roundtrips() {
        let blob = binary::encode_snapshot(1, &prose_doc(3, 0));
        assert_eq!(super::prose_count_in_binary(&blob), Some(3));
        assert_eq!(super::prose_count_in_binary(b"not a sidecar"), None);
    }

    #[test]
    fn suspicious_prose_zeroing_needs_two_pages_emptied() {
        assert!(super::suspicious_prose_zeroing(3, 1), "2 pages emptied = poison");
        assert!(super::suspicious_prose_zeroing(2, 0), "both pages emptied = poison");
        assert!(
            !super::suspicious_prose_zeroing(2, 1),
            "one page cleared is a legit edit"
        );
        assert!(!super::suspicious_prose_zeroing(1, 0), "single page emptied is allowed");
        assert!(!super::suspicious_prose_zeroing(0, 0), "no prose, no trigger");
        assert!(!super::suspicious_prose_zeroing(1, 5), "growth is fine");
    }

    fn key() -> (WorkspaceId, DocId) {
        (
            WorkspaceId::single_tenant(),
            DocId::from_http_path("doc-1".to_string()).unwrap(),
        )
    }

    #[test]
    fn ensure_is_idempotent_then_evicts() {
        let reg = DocRegistry::new();
        let (ws, doc) = key();
        let body = json!({"id": "doc-1", "name": "x"});

        assert!(reg.is_empty());

        let h1 = reg.ensure(&ws, &doc, &body, None, true);
        assert_eq!(reg.len(), 1);

        // A second ensure returns the same handle — one hydration only.
        let h2 = reg.ensure(&ws, &doc, &body, None, true);
        assert!(Arc::ptr_eq(&h1, &h2));
        assert_eq!(reg.len(), 1);
        assert!(reg.get(&ws, &doc).is_some());

        reg.evict(&ws, &doc);
        assert!(reg.is_empty());
        assert!(reg.get(&ws, &doc).is_none());
    }

    // ---- JP-339: prose page-LIST as a shared type ----

    #[test]
    fn prose_page_list_round_trips_through_hydrate_handle_and_flatten() {
        let json = json!({
            "id": "d", "serverVersion": 1, "activePageId": "p1",
            "pages": {"p1": {"shapes": {}, "shapeOrder": []}},
            "richTextPages": {
                "activePageId": "rt-page-1",
                "pageOrder": ["rt-page-1"],
                "pages": {"rt-page-1": {"id": "rt-page-1", "name": "Page 1", "order": 0,
                                        "content": "<p>hi</p>"}}
            }
        });
        let handle = DocHandle::hydrate(&json, None, false);

        // Add a tab live, reorder it ahead of the default, then flatten.
        handle.set_prose_page_meta(
            "rt-3",
            &json!({"id": "rt-3", "name": "New", "order": 1, "content": "<p>ignored</p>"}),
        );
        handle.set_prose_page_order(&["rt-3".to_string(), "rt-page-1".to_string()]);

        let mut out = json.clone();
        assert!(handle.flatten_into(&mut out));
        let rtp = &out["richTextPages"];
        assert_eq!(rtp["pages"]["rt-3"]["name"], json!("New"), "added tab flattened");
        assert_eq!(rtp["pages"]["rt-3"]["content"], json!(""), "meta carries no content");
        assert_eq!(rtp["pages"]["rt-page-1"]["content"], json!("<p>hi</p>"), "content preserved");
        assert_eq!(rtp["pageOrder"], json!(["rt-3", "rt-page-1"]), "reorder flattened");

        // Now delete the added tab → it disappears from the flattened list.
        handle.remove_prose_page("rt-3");
        let mut out2 = json.clone();
        assert!(handle.flatten_into(&mut out2));
        assert!(out2["richTextPages"]["pages"].get("rt-3").is_none(), "deleted tab pruned");
        assert_eq!(out2["richTextPages"]["pageOrder"], json!(["rt-page-1"]));
    }

    // ---- JP-89: reference library as a shared type ----

    fn empty_lib_json(version: u64) -> serde_json::Value {
        json!({
            "id": "d", "serverVersion": version, "activePageId": "p1",
            "pages": {"p1": {"shapes": {}, "shapeOrder": []}}
        })
    }

    #[test]
    fn references_round_trip_through_hydrate_and_flatten() {
        let json = json!({
            "id": "d", "serverVersion": 1, "activePageId": "p1",
            "pages": {"p1": {"shapes": {}, "shapeOrder": []}},
            "references": {
                "items": {"knuth1997": {"id": "knuth1997", "type": "book"}},
                "itemOrder": ["knuth1997"], "style": "mla"
            }
        });
        let handle = DocHandle::hydrate(&json, None, false);
        assert!(handle.references_json().contains_key("knuth1997"));
        assert_eq!(handle.reference_order(), vec!["knuth1997".to_string()]);
        assert_eq!(handle.citation_style().as_deref(), Some("mla"));

        let mut out = json.clone();
        assert!(handle.flatten_into(&mut out));
        assert_eq!(out["references"]["itemOrder"], json!(["knuth1997"]));
        assert_eq!(out["references"]["style"], json!("mla"));
    }

    #[test]
    fn concurrent_mcp_and_author_adds_both_survive() {
        use yrs::updates::decoder::Decode;
        use yrs::{StateVector, Update};

        // Resident doc, empty library. Capture the shared base BEFORE either add.
        let handle = DocHandle::hydrate(&empty_lib_json(1), None, false);
        let base = handle
            .doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());

        // A "client" cloned from the same base — it has NOT seen the MCP add.
        let client = binary::doc_from_update(&base).unwrap();

        // MCP add (id A) lands on the authoritative Y.Doc (per-item set).
        handle.insert_references(&[("refA".to_string(), json!({"id": "refA", "type": "book"}))]);

        // Concurrently, the client adds a DIFFERENT ref (id B) to its own copy.
        {
            let refs = client.get_or_insert_map("references");
            let order = client.get_or_insert_array("referenceOrder");
            let mut txn = client.transact_mut();
            refs.insert(&mut txn, "refB", hydration::json_to_any(&json!({"id": "refB", "type": "article-journal"})));
            order.push_back(&mut txn, Any::String("refB".into()));
        }

        // The client's update flows to the relay and merges into the authoritative doc.
        let client_update = client
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        {
            let mut txn = handle.doc.transact_mut();
            txn.apply_update(Update::decode_v1(&client_update).unwrap()).unwrap();
        }

        // BOTH survive — no clobber on simultaneous add (the user's headline concern).
        let merged = handle.references_json();
        assert!(merged.contains_key("refA"), "MCP-added ref survived: {merged:?}");
        assert!(merged.contains_key("refB"), "author-added ref survived: {merged:?}");
        let order = handle.reference_order();
        assert!(order.contains(&"refA".to_string()) && order.contains(&"refB".to_string()));

        // And flatten emits both.
        let mut out = empty_lib_json(1);
        assert!(handle.flatten_into(&mut out));
        let items = out["references"]["items"].as_object().unwrap();
        assert!(items.contains_key("refA") && items.contains_key("refB"));
    }

    #[test]
    fn binary_backstop_backfills_references_without_wiping() {
        use yrs::Map;
        // A binary sidecar predating the feature: has shapes, NO references map.
        let bin = {
            let doc = Doc::new();
            let shapes = doc.get_or_insert_map("shapes");
            let mut txn = doc.transact_mut();
            shapes.insert(&mut txn, "s1", Any::String("rect".into()));
            drop(txn);
            binary::encode_snapshot(9, &doc)
        };
        // JSON (lower version → binary wins) DOES carry a library.
        let json = json!({
            "id": "d", "serverVersion": 1, "activePageId": "p1",
            "pages": {"p1": {"shapes": {"s1": {"id": "s1"}}, "shapeOrder": ["s1"]}},
            "references": {"items": {"k": {"id": "k", "type": "book"}}, "itemOrder": ["k"]}
        });
        let handle = DocHandle::hydrate(&json, Some(&bin), true);
        // Backstop seeded the library into the Y.Doc (would otherwise be empty →
        // flatten would wipe the JSON's refs).
        assert!(handle.references_json().contains_key("k"), "references backfilled from JSON");
        let mut out = json.clone();
        assert!(handle.flatten_into(&mut out));
        assert_eq!(out["references"]["itemOrder"], json!(["k"]));
    }
}
