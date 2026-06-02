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
    /// Build a handle by hydrating a fresh `Doc` from a JSON snapshot.
    fn hydrate(doc_json: &Value) -> Self {
        let doc = Doc::new();
        hydration::json_to_ydoc(doc_json, &doc);
        let page_id = doc_json
            .get("activePageId")
            .and_then(Value::as_str)
            .map(str::to_string);
        Self {
            doc,
            page_id,
            dirty: AtomicBool::new(false),
        }
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

    /// Return the resident handle, or hydrate one from `doc_json` and insert
    /// it. Idempotent: concurrent callers share the first hydration.
    pub fn ensure(&self, ws: &WorkspaceId, doc_id: &DocId, doc_json: &Value) -> Arc<DocHandle> {
        if let Some(handle) = self.get(ws, doc_id) {
            return handle;
        }
        let key = (ws.clone(), doc_id.clone());
        let mut docs = self.docs.write().unwrap();
        docs.entry(key)
            .or_insert_with(|| Arc::new(DocHandle::hydrate(doc_json)))
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
    use super::DocRegistry;
    use serde_json::json;
    use std::sync::Arc;

    use crate::server::protocol::{DocId, WorkspaceId};

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

        let h1 = reg.ensure(&ws, &doc, &body);
        assert_eq!(reg.len(), 1);

        // A second ensure returns the same handle — one hydration only.
        let h2 = reg.ensure(&ws, &doc, &body);
        assert!(Arc::ptr_eq(&h1, &h2));
        assert_eq!(reg.len(), 1);
        assert!(reg.get(&ws, &doc).is_some());

        reg.evict(&ws, &doc);
        assert!(reg.is_empty());
        assert!(reg.get(&ws, &doc).is_none());
    }
}
