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
mod prose_html;
mod protocol;

pub use hydration::active_page_shape_count;
pub use protocol::{SyncError, SyncOutcome};

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};

use serde_json::Value;
use yrs::{Any, Array, Doc, Map, ReadTxn, Transact, XmlFragment};

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
                                return (doc, false);
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
        (doc, poison_healed)
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
    use super::{binary, DocHandle, DocRegistry};
    use serde_json::json;
    use std::sync::Arc;
    use yrs::{Doc, GetString, Map, Text, Transact};

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
}
