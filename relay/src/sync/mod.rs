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
mod protocol;

pub use protocol::{SyncError, SyncOutcome};

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};

use serde_json::Value;
use yrs::Doc;

use crate::server::protocol::{DocId, WorkspaceId};

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
    fn hydrate(doc_json: &Value, ydoc_bin: Option<&[u8]>) -> Self {
        let page_id = doc_json
            .get("activePageId")
            .and_then(Value::as_str)
            .map(str::to_string);
        let doc = Self::hydrate_doc(doc_json, ydoc_bin);
        Self {
            doc,
            page_id,
            dirty: AtomicBool::new(false),
        }
    }

    /// Choose the hydration source. The binary is authoritative only when it's
    /// at least as new as the JSON body: `persist_snapshot` preserves
    /// `serverVersion` while MCP/REST writes bump it, so a binary tagged with an
    /// older version means an out-of-band JSON write landed after it — in which
    /// case we hydrate from JSON and let the next snapshot rewrite the binary.
    fn hydrate_doc(doc_json: &Value, ydoc_bin: Option<&[u8]>) -> Doc {
        if let Some(bytes) = ydoc_bin {
            if let Some((bin_version, update)) = binary::decode_header(bytes) {
                let json_version = doc_json.get("serverVersion").and_then(Value::as_u64);
                let current = json_version.map_or(true, |jv| bin_version >= jv);
                if current {
                    match binary::doc_from_update(update) {
                        Ok(doc) => return doc,
                        Err(e) => log::warn!(
                            "binary Y.Doc hydrate failed ({e}); falling back to JSON"
                        ),
                    }
                }
            }
        }
        let doc = Doc::new();
        hydration::json_to_ydoc(doc_json, &doc);
        doc
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
        match &self.page_id {
            Some(page_id) => flatten::flatten_into(&self.doc, page_id, json),
            None => false,
        }
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
    ) -> Arc<DocHandle> {
        if let Some(handle) = self.get(ws, doc_id) {
            return handle;
        }
        let key = (ws.clone(), doc_id.clone());
        let mut docs = self.docs.write().unwrap();
        docs.entry(key)
            .or_insert_with(|| Arc::new(DocHandle::hydrate(doc_json, ydoc_bin)))
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
        let mut txn = doc.transact_mut();
        prose.insert(&mut txn, 0, text);
        drop(txn);
        binary::encode_snapshot(server_version, &doc)
    }

    #[test]
    fn hydrate_prefers_binary_when_version_matches() {
        let handle = DocHandle::hydrate(&json_body(5), Some(&binary_with_prose(5, "from binary")));
        // Binary used → its prose is present (JSON hydration never creates it).
        let prose = handle.doc.get_or_insert_text("prose:p1");
        assert_eq!(prose.get_string(&handle.doc.transact()), "from binary");
    }

    #[test]
    fn hydrate_falls_back_to_json_when_binary_is_stale() {
        // Binary tagged v4, JSON body bumped to v7 by an out-of-band write.
        let handle = DocHandle::hydrate(&json_body(7), Some(&binary_with_prose(4, "stale")));
        let shapes = handle.doc.get_or_insert_map("shapes");
        let prose = handle.doc.get_or_insert_text("prose:p1");
        let txn = handle.doc.transact();
        assert!(shapes.contains_key(&txn, "s1"), "JSON shapes hydrated");
        assert_eq!(prose.get_string(&txn), "", "stale binary prose ignored");
    }

    #[test]
    fn hydrate_uses_json_when_no_binary() {
        let handle = DocHandle::hydrate(&json_body(1), None);
        let shapes = handle.doc.get_or_insert_map("shapes");
        assert!(shapes.contains_key(&handle.doc.transact(), "s1"));
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

        let h1 = reg.ensure(&ws, &doc, &body, None);
        assert_eq!(reg.len(), 1);

        // A second ensure returns the same handle — one hydration only.
        let h2 = reg.ensure(&ws, &doc, &body, None);
        assert!(Arc::ptr_eq(&h1, &h2));
        assert_eq!(reg.len(), 1);
        assert!(reg.get(&ws, &doc).is_some());

        reg.evict(&ws, &doc);
        assert!(reg.is_empty());
        assert!(reg.get(&ws, &doc).is_none());
    }
}
