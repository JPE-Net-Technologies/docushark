//! Team document storage and management
//!
//! Provides file-based storage for team documents that are shared across clients.
//! Documents are stored as JSON files in the app data directory.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::RwLock;
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::oneshot;

use super::blob_backend::DocObjectStore;
use super::protocol::{DocId, WorkspaceId};

/// A document-mirror operation enqueued for the background R2 worker (JP-200).
/// Writes stay synchronous against the local volume; the worker re-reads the
/// just-written file at processing time and mirrors it to R2. A single FIFO
/// worker preserves order across ops.
pub enum MirrorOp {
    /// Upload a doc object — `ext` is `"json"` or `"ydoc"`. The worker re-reads
    /// the local file; a missing file is skipped (a trailing `Delete` cleans R2).
    Put {
        ws: WorkspaceId,
        doc_id: DocId,
        ext: &'static str,
    },
    /// Upload a workspace's `index.json` (best-effort listing restore).
    PutIndex { ws: WorkspaceId },
    /// Delete a doc's objects (`json` + `ydoc`) from R2.
    Delete { ws: WorkspaceId, doc_id: DocId },
    /// Drain marker: the worker acks once every prior op has been processed.
    Flush(oneshot::Sender<()>),
}

/// Document share entry for tracking who has access
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentShare {
    pub user_id: String,
    pub user_name: String,
    pub permission: String, // "view" or "edit"
    pub shared_at: u64,
}

/// Lightweight metadata for document listing
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentMetadata {
    pub id: DocId,
    pub name: String,
    pub page_count: usize,
    pub modified_at: u64,
    pub created_at: u64,

    // Relay document fields
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_relay_document: Option<bool>,
    /// Monotonically increasing server-side version used by REST
    /// `PUT /api/docs/:id` for optimistic concurrency. Bumped on every
    /// successful save. None for documents predating v2.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_version: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub locked_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub locked_by_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub locked_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shared_with: Option<Vec<DocumentShare>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_modified_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_modified_by_name: Option<String>,
}

/// One recovery point for a document (JP-180). A copy of the binary `Y.Doc`
/// sidecar taken just before a suspicious N→0 zeroing snapshot, so a single
/// bad client can't permanently zero a document. Surfaced over the REST
/// recovery routes and (eventually) the web interface.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryPoint {
    /// Opaque id addressing this point — the sidecar filename stem
    /// (`<createdAtMs>-v<serverVersion>`).
    pub id: String,
    /// Wall-clock millis when the recovery point was captured.
    pub created_at: u64,
    /// The document `serverVersion` carried by the backed-up state.
    pub server_version: u64,
    /// Size of the backed-up sidecar on disk.
    pub size_bytes: u64,
}

/// How many recovery points to retain per document (bounded ring — the backup
/// captures a copy on each suspicious zeroing, not every snapshot).
const RECOVERY_RING: usize = 5;

/// Outcome of a save attempt with optimistic-concurrency support.
/// IO and validation errors continue to surface via the `Result::Err`
/// channel; this enum carries only application-level outcomes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SaveOutcome {
    /// New document created with the given version (always 1).
    Created { version: u64 },
    /// Existing document updated to the given version.
    Updated { version: u64 },
    /// Caller's `expected_version` did not match the stored version.
    /// `current` is the server's view; clients should refetch + retry.
    VersionConflict { current: u64 },
}

/// Wall-clock millis since the epoch (0 if the clock is before 1970).
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// JP-231 per-doc cache bookkeeping — **machine-local, never mirrored to R2**.
/// Tracks LRU recency, the local↔R2 mirror generation, on-disk size, and whether
/// the doc's files are currently resident on this volume. Kept in a map parallel
/// to `index` (which *is* mirrored) so eviction state never leaks into R2.
#[derive(Debug, Clone)]
struct CacheState {
    /// Last read/write touch (LRU key).
    last_access_ms: u64,
    /// Bumped after each local json write that enqueues a mirror `Put`.
    local_gen: u64,
    /// Set by the mirror worker after a confirmed json upload (monotonic).
    /// `mirrored_gen >= local_gen` ⇒ the latest local content is durable in R2.
    mirrored_gen: u64,
    /// On-disk footprint of this doc (json + ydoc + recovery), 0 once evicted.
    size_bytes: u64,
    /// `false` after eviction — files gone, index entry kept (restore-on-miss).
    present: bool,
}

/// A read-only view of one cache entry for the eviction sweep (JP-231).
#[derive(Debug, Clone)]
pub(crate) struct CacheEntrySnapshot {
    pub ws: WorkspaceId,
    pub doc_id: DocId,
    pub last_access_ms: u64,
    /// `mirrored_gen >= local_gen` — the local content is confirmed in R2.
    pub evictable_by_gen: bool,
    pub size_bytes: u64,
}

/// Pure victim selection for the eviction sweep (JP-231) — no IO, no registry,
/// unit-testable. Given the present-doc `entries`, the set of docs `resident` in
/// the sync registry, and the byte `max`/`low` watermarks: if the total footprint
/// is over `max`, return the coldest docs that are **confirmed mirrored and not
/// resident**, in eviction order, until the projected footprint drops to `low`
/// (or no more are evictable). Dirty-but-unmirrored and actively-synced docs are
/// never selected.
pub(crate) fn select_victims(
    entries: &[CacheEntrySnapshot],
    resident: &HashSet<(WorkspaceId, DocId)>,
    max_bytes: u64,
    low_bytes: u64,
) -> Vec<(WorkspaceId, DocId, u64)> {
    let total: u64 = entries.iter().map(|e| e.size_bytes).sum();
    if max_bytes == 0 || total <= max_bytes {
        return Vec::new();
    }
    let mut candidates: Vec<&CacheEntrySnapshot> = entries
        .iter()
        .filter(|e| e.evictable_by_gen && !resident.contains(&(e.ws.clone(), e.doc_id.clone())))
        .collect();
    // Coldest (smallest last_access) first.
    candidates.sort_by_key(|e| e.last_access_ms);
    let mut victims = Vec::new();
    let mut remaining = total;
    for e in candidates {
        if remaining <= low_bytes {
            break;
        }
        victims.push((e.ws.clone(), e.doc_id.clone(), e.size_bytes));
        remaining = remaining.saturating_sub(e.size_bytes);
    }
    victims
}

/// Relay document store with file-based persistence.
///
/// Per the storage-scoping follow-up to Phase 21.5, on-disk layout is
/// `<documents_dir>/workspaces/<ws>/{index.json, docs/<doc_id>.json}`.
/// The in-memory index mirrors that: outer key is the workspace, inner
/// map is the same per-doc metadata as before. Methods that don't yet
/// take a `WorkspaceId` would silently merge tenants and are no longer
/// part of the public API.
pub struct DocumentStore {
    /// Root for relay-owned doc state — contains `workspaces/<ws>/...`.
    documents_dir: PathBuf,
    /// In-memory metadata index keyed by workspace, then by doc id.
    /// Loaded eagerly at startup; subsequent loads happen on demand
    /// when a new workspace is touched.
    index: RwLock<HashMap<WorkspaceId, HashMap<String, DocumentMetadata>>>,
    /// JP-200 write-through R2 mirror sink. `Some` enqueues a [`MirrorOp`] after
    /// each successful local write for a background worker to upload; `None`
    /// (self-host / filesystem backend) keeps the store volume-only. The same
    /// sender is set once on this single shared store (JP-230), so MCP-authored
    /// docs are mirrored too.
    mirror_tx: Option<UnboundedSender<MirrorOp>>,
    /// JP-231 working-set cache bookkeeping, keyed like `index` (workspace →
    /// doc id). Machine-local LRU recency + mirror-generation + footprint; drives
    /// eviction of cold, R2-confirmed docs. Never serialized / mirrored.
    cache: RwLock<HashMap<WorkspaceId, HashMap<String, CacheState>>>,
    /// JP-230: serializes `index.json` file writes. The in-memory index is shared
    /// (a single store), but `write_workspace_index_file` snapshots then writes —
    /// without this, two interleaved writers could land a stale snapshot after a
    /// fresher one and drop an entry. Held across snapshot+write.
    index_write_lock: std::sync::Mutex<()>,
}

impl DocumentStore {
    /// Create a new document store, applying the legacy-layout
    /// migration if needed.
    pub fn new(app_data_dir: PathBuf) -> Self {
        let documents_dir = app_data_dir.join("relay_documents");

        // Ensure the root and workspaces dir exist.
        let _ = std::fs::create_dir_all(&documents_dir);
        let _ = std::fs::create_dir_all(documents_dir.join("workspaces"));

        // One-shot migration from the pre-21.5 flat layout.
        Self::migrate_legacy_layout(&documents_dir);

        let store = Self {
            documents_dir: documents_dir.clone(),
            index: RwLock::new(HashMap::new()),
            mirror_tx: None,
            cache: RwLock::new(HashMap::new()),
            index_write_lock: std::sync::Mutex::new(()),
        };

        // Eagerly preload every workspace index so `list_documents`
        // for a known-but-not-yet-touched workspace doesn't miss its
        // entries on a cold start.
        store.preload_all_workspace_indexes();

        store
    }

    /// Attach the R2 mirror sink (JP-200). Call on the `&mut` store **before**
    /// `Arc::new`, mirroring `BlobStore::set_object_delete_sink`. Wired only when
    /// the s3 backend is active; shared into the MCP store too.
    pub fn set_mirror_sink(&mut self, tx: UnboundedSender<MirrorOp>) {
        self.mirror_tx = Some(tx);
    }

    /// Best-effort enqueue of a mirror op. No-op when no sink is attached
    /// (filesystem backend). A closed channel (worker gone at shutdown) is
    /// dropped silently — durability of the local write already succeeded.
    fn enqueue_mirror(&self, op: MirrorOp) {
        if let Some(tx) = &self.mirror_tx {
            let _ = tx.send(op);
        }
    }

    /// Read a document object's raw bytes off the local volume for the mirror
    /// worker. `ext` is `"json"` or `"ydoc"`; `None` if the file is absent or
    /// unreadable (worker skips — a trailing `Delete` reconciles R2).
    pub fn read_doc_object(&self, ws: &WorkspaceId, doc_id: &DocId, ext: &str) -> Option<Vec<u8>> {
        let path = match ext {
            "json" => self.doc_path(ws, doc_id),
            "ydoc" => self.ydoc_path(ws, doc_id),
            _ => return None,
        };
        std::fs::read(path).ok()
    }

    /// Read a workspace's `index.json` bytes off the local volume for the mirror
    /// worker. `None` if absent/unreadable.
    pub fn read_workspace_index_bytes(&self, ws: &WorkspaceId) -> Option<Vec<u8>> {
        std::fs::read(self.index_path(ws)).ok()
    }

    /// Enqueue a mirror of every locally-indexed document (JP-200 startup
    /// backfill) so a pre-existing volume's corpus becomes durable in R2 without
    /// waiting for an edit. Idempotent (the worker overwrites). A missing `ydoc`
    /// sidecar is skipped by the worker. No-op without a sink.
    pub fn backfill_mirror(&self) {
        if self.mirror_tx.is_none() {
            return;
        }
        // Snapshot (ws, doc-ids) under the read lock, then enqueue outside it.
        let by_ws: Vec<(WorkspaceId, Vec<String>)> = match self.index.read() {
            Ok(index) => index
                .iter()
                .map(|(ws, docs)| (ws.clone(), docs.keys().cloned().collect()))
                .collect(),
            Err(_) => return,
        };
        let mut count = 0usize;
        for (ws, ids) in by_ws {
            for id in ids {
                if let Ok(doc_id) = DocId::from_body_id(id) {
                    self.enqueue_mirror(MirrorOp::Put {
                        ws: ws.clone(),
                        doc_id: doc_id.clone(),
                        ext: "json",
                    });
                    self.enqueue_mirror(MirrorOp::Put {
                        ws: ws.clone(),
                        doc_id,
                        ext: "ydoc",
                    });
                    count += 1;
                }
            }
            self.enqueue_mirror(MirrorOp::PutIndex { ws });
        }
        if count > 0 {
            log::info!("R2 doc mirror: enqueued startup backfill for {count} document(s)");
        }
    }

    // ---- JP-231 working-set cache (LRU eviction) ----------------------------

    /// On-disk footprint of a single doc: json + ydoc + recovery points.
    fn doc_local_size_bytes(&self, ws: &WorkspaceId, doc_id: &DocId) -> u64 {
        let mut total = 0u64;
        for p in [self.doc_path(ws, doc_id), self.ydoc_path(ws, doc_id)] {
            if let Ok(m) = std::fs::metadata(&p) {
                total += m.len();
            }
        }
        if let Ok(entries) = std::fs::read_dir(self.recovery_dir(ws, doc_id)) {
            for e in entries.flatten() {
                if let Ok(m) = e.metadata() {
                    total += m.len();
                }
            }
        }
        total
    }

    /// Insert-or-get a cache entry, defaulting a fresh one (present, gen 0).
    fn cache_upsert<'a>(
        cache: &'a mut HashMap<WorkspaceId, HashMap<String, CacheState>>,
        ws: &WorkspaceId,
        id: &str,
    ) -> &'a mut CacheState {
        cache
            .entry(ws.clone())
            .or_default()
            .entry(id.to_string())
            .or_insert(CacheState {
                last_access_ms: now_ms(),
                local_gen: 0,
                mirrored_gen: 0,
                size_bytes: 0,
                present: true,
            })
    }

    /// JP-231: record a **read** access — refresh LRU recency. No-op-safe.
    pub fn touch(&self, ws: &WorkspaceId, doc_id: &DocId) {
        if let Ok(mut cache) = self.cache.write() {
            let e = Self::cache_upsert(&mut cache, ws, doc_id.as_str());
            e.last_access_ms = now_ms();
            e.present = true;
        }
    }

    /// JP-231: record a **local write** — refresh recency + on-disk size, and for
    /// json writes that enqueue a mirror `Put` (`bump_gen`) advance `local_gen`,
    /// so the doc is non-evictable until the mirror worker confirms the upload.
    fn note_local_write(&self, ws: &WorkspaceId, doc_id: &DocId, bump_gen: bool) {
        let size = self.doc_local_size_bytes(ws, doc_id);
        if let Ok(mut cache) = self.cache.write() {
            let e = Self::cache_upsert(&mut cache, ws, doc_id.as_str());
            e.last_access_ms = now_ms();
            e.size_bytes = size;
            e.present = true;
            if bump_gen {
                e.local_gen += 1;
            }
        }
    }

    /// JP-231: the doc's current local generation (0 if unknown). The mirror
    /// worker captures this **before** reading the file, so the gen it records
    /// can only lag the uploaded content, never lead it.
    pub fn current_local_gen(&self, ws: &WorkspaceId, doc_id: &DocId) -> u64 {
        self.cache
            .read()
            .ok()
            .and_then(|c| c.get(ws).and_then(|m| m.get(doc_id.as_str())).map(|e| e.local_gen))
            .unwrap_or(0)
    }

    /// JP-231: mark a json upload confirmed in R2 at generation `gen` (monotonic
    /// — never regresses). Called by the mirror worker after a successful PUT.
    pub fn set_mirrored_gen(&self, ws: &WorkspaceId, doc_id: &DocId, gen: u64) {
        if let Ok(mut cache) = self.cache.write() {
            let e = Self::cache_upsert(&mut cache, ws, doc_id.as_str());
            if gen > e.mirrored_gen {
                e.mirrored_gen = gen;
            }
        }
    }

    /// JP-231: total local footprint of present (non-evicted) docs, in bytes.
    pub fn cache_bytes(&self) -> u64 {
        self.cache
            .read()
            .map(|c| {
                c.values()
                    .flat_map(|m| m.values())
                    .filter(|e| e.present)
                    .map(|e| e.size_bytes)
                    .sum()
            })
            .unwrap_or(0)
    }

    /// JP-231: number of docs currently resident on this volume.
    pub fn cache_present_count(&self) -> usize {
        self.cache
            .read()
            .map(|c| c.values().flat_map(|m| m.values()).filter(|e| e.present).count())
            .unwrap_or(0)
    }

    /// JP-231: snapshot the present cache entries for the eviction sweep.
    pub(crate) fn cache_snapshot(&self) -> Vec<CacheEntrySnapshot> {
        let Ok(cache) = self.cache.read() else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for (ws, docs) in cache.iter() {
            for (id, e) in docs.iter() {
                if !e.present {
                    continue;
                }
                let Ok(doc_id) = DocId::from_body_id(id.clone()) else {
                    continue;
                };
                out.push(CacheEntrySnapshot {
                    ws: ws.clone(),
                    doc_id,
                    last_access_ms: e.last_access_ms,
                    evictable_by_gen: e.mirrored_gen >= e.local_gen,
                    size_bytes: e.size_bytes,
                });
            }
        }
        out
    }

    /// JP-231: evict a doc's local files (json + ydoc + recovery), **keeping** the
    /// index entry so the doc stays listable and `ensure_doc_local` restores it
    /// from R2 on next touch. Enqueues **no** mirror op (the R2 copy is durable).
    /// Returns bytes freed. The caller guarantees the doc is confirmed-mirrored
    /// and not resident in the sync registry.
    pub fn evict_doc_files(&self, ws: &WorkspaceId, doc_id: &DocId) -> u64 {
        let freed = self
            .cache
            .read()
            .ok()
            .and_then(|c| c.get(ws).and_then(|m| m.get(doc_id.as_str())).map(|e| e.size_bytes))
            .unwrap_or(0);
        let _ = std::fs::remove_file(self.doc_path(ws, doc_id));
        let _ = std::fs::remove_file(self.ydoc_path(ws, doc_id));
        let rec = self.recovery_dir(ws, doc_id);
        if rec.exists() {
            let _ = std::fs::remove_dir_all(&rec);
        }
        if let Ok(mut cache) = self.cache.write() {
            if let Some(e) = cache.get_mut(ws).and_then(|m| m.get_mut(doc_id.as_str())) {
                e.present = false;
                e.size_bytes = 0;
            }
        }
        log::info!(
            "JP-231 evicting {}/{} from volume ({} bytes freed; durable copy kept in R2)",
            ws.as_str(),
            doc_id.as_str(),
            freed
        );
        freed
    }

    /// JP-231: seed cache entries for a freshly-loaded workspace index. Idempotent
    /// — existing entries (with live gen state) are preserved; only doc ids new to
    /// the cache are seeded. New entries start `local_gen=1, mirrored_gen=0`
    /// ("dirty until the startup backfill confirms R2"), so a doc is never
    /// evictable before its bytes are uploaded.
    fn seed_cache_for_workspace(&self, ws: &WorkspaceId, ids: &[String]) {
        let sized: Vec<(String, u64)> = ids
            .iter()
            .filter_map(|id| {
                DocId::from_body_id(id.clone())
                    .ok()
                    .map(|doc_id| (id.clone(), self.doc_local_size_bytes(ws, &doc_id)))
            })
            .collect();
        let now = now_ms();
        if let Ok(mut cache) = self.cache.write() {
            let m = cache.entry(ws.clone()).or_default();
            for (id, size) in sized {
                m.entry(id).or_insert(CacheState {
                    last_access_ms: now,
                    local_gen: 1,
                    mirrored_gen: 0,
                    size_bytes: size,
                    present: size > 0,
                });
            }
        }
    }

    /// Install a document restored from R2 onto the local volume + in-memory
    /// index (JP-200), **bypassing every mirror enqueue** — the bytes just came
    /// from R2, so re-uploading would be wasteful and could clobber a newer copy.
    /// The doc body is written verbatim (no re-serialize) to preserve exactly
    /// what R2 holds. Returns `Err` on a malformed body.
    pub fn install_restored_doc(
        &self,
        ws: &WorkspaceId,
        json_bytes: &[u8],
        ydoc_bytes: Option<&[u8]>,
    ) -> Result<(), String> {
        let doc: serde_json::Value = serde_json::from_slice(json_bytes)
            .map_err(|e| format!("restore: parse doc json: {}", e))?;
        let id = doc
            .get("id")
            .and_then(|v| v.as_str())
            .ok_or("restore: doc missing 'id'")?
            .to_string();
        let doc_id = DocId::from_body_id(id.clone())
            .map_err(|e| format!("restore: invalid id: {}", e))?;
        let version = doc.get("serverVersion").and_then(|v| v.as_u64()).unwrap_or(0);

        let _ = std::fs::create_dir_all(self.workspace_root(ws).join("docs"));
        std::fs::write(self.doc_path(ws, &doc_id), json_bytes)
            .map_err(|e| format!("restore: write json: {}", e))?;
        if let Some(bin) = ydoc_bytes {
            std::fs::write(self.ydoc_path(ws, &doc_id), bin)
                .map_err(|e| format!("restore: write ydoc: {}", e))?;
        }

        let metadata = Self::metadata_from_body(&doc, doc_id.clone(), version);
        {
            let mut index = self.index.write().map_err(|e| e.to_string())?;
            index.entry(ws.clone()).or_default().insert(id, metadata);
        }
        // Enqueue-free index write — restore must not feed the mirror back.
        self.write_workspace_index_file(ws)?;
        // JP-231: the bytes just came from R2, so this content is already durable
        // there — mark recency/size and pin mirrored_gen == local_gen so the
        // freshly-restored doc is immediately re-evictable once it goes cold.
        self.note_local_write(ws, &doc_id, false);
        self.set_mirrored_gen(ws, &doc_id, self.current_local_gen(ws, &doc_id));
        Ok(())
    }

    /// Restore a document **by id** from an object store on a local miss (JP-200
    /// hydrate-on-join). Reachability never depends on the workspace index being
    /// complete — the id comes from the request. `false` when the doc is truly
    /// absent in R2 (404) or on a transient fetch error (logged); the caller then
    /// falls through to its normal not-found handling.
    pub async fn restore_doc_from<S: DocObjectStore>(
        &self,
        store: &S,
        ws: &WorkspaceId,
        doc_id: &DocId,
    ) -> bool {
        let json = match store.get_doc_object(ws, doc_id, "json").await {
            Ok(Some(bytes)) => bytes,
            Ok(None) => return false, // truly absent — not a relay doc
            Err(e) => {
                log::warn!(
                    "restore: R2 get json {}/{}: {}",
                    ws.as_str(),
                    doc_id.as_str(),
                    e
                );
                return false;
            }
        };
        // The binary sidecar is optional; a missing/older one is reconciled on
        // hydrate (the sync layer prefers JSON when the binary is stale).
        let ydoc = match store.get_doc_object(ws, doc_id, "ydoc").await {
            Ok(opt) => opt,
            Err(e) => {
                log::warn!(
                    "restore: R2 get ydoc {}/{}: {} — restoring json-only",
                    ws.as_str(),
                    doc_id.as_str(),
                    e
                );
                None
            }
        };
        match self.install_restored_doc(ws, &json, ydoc.as_deref()) {
            Ok(()) => {
                log::info!("restored {}/{} from R2", ws.as_str(), doc_id.as_str());
                true
            }
            Err(e) => {
                log::warn!(
                    "restore: install {}/{}: {}",
                    ws.as_str(),
                    doc_id.as_str(),
                    e
                );
                false
            }
        }
    }

    /// Best-effort restore of a workspace's document index from R2 (JP-200
    /// listing restore). Only repopulates the local index file; doc reachability
    /// is by-id and never blocks on this. Caller guards against clobbering a
    /// populated in-memory index (only call on a cold/empty workspace).
    pub async fn restore_workspace_index_from<S: DocObjectStore>(
        &self,
        store: &S,
        ws: &WorkspaceId,
    ) {
        match store.get_workspace_index(ws).await {
            Ok(Some(bytes)) => {
                let _ = std::fs::create_dir_all(self.workspace_root(ws).join("docs"));
                if std::fs::write(self.index_path(ws), &bytes).is_ok() {
                    self.load_workspace_index(ws);
                    log::info!("restored index for workspace {} from R2", ws.as_str());
                }
            }
            Ok(None) => {}
            Err(e) => log::warn!("restore: R2 get index {}: {}", ws.as_str(), e),
        }
    }

    /// Move a pre-21.5 flat layout (`<root>/{index.json, docs/}`) into
    /// `<root>/workspaces/default/{index.json, docs/}`. Idempotent —
    /// re-running with the new layout already in place is a no-op.
    /// Aborts the migration on partial failure rather than booting in
    /// a half-migrated state. Pre-GA so a one-time on-disk break is
    /// allowed (see `docushark-app/AGENTS.md`).
    fn migrate_legacy_layout(documents_dir: &std::path::Path) {
        let legacy_index = documents_dir.join("index.json");
        let legacy_docs = documents_dir.join("docs");
        let new_root = documents_dir
            .join("workspaces")
            .join(WorkspaceId::single_tenant().as_str());

        let legacy_present = legacy_index.exists() || legacy_docs.exists();
        if !legacy_present {
            return;
        }
        // If the destination already has content, the migration ran
        // before — don't overwrite.
        if new_root.join("index.json").exists() {
            return;
        }

        log::info!(
            "migrating legacy relay_documents layout into workspaces/{}/",
            WorkspaceId::single_tenant().as_str()
        );
        if let Err(e) = std::fs::create_dir_all(&new_root) {
            panic!("storage migration: create_dir_all {:?}: {}", new_root, e);
        }
        if legacy_index.exists() {
            let dest = new_root.join("index.json");
            if let Err(e) = std::fs::rename(&legacy_index, &dest) {
                panic!("storage migration: rename index.json: {}", e);
            }
        }
        if legacy_docs.exists() {
            let dest = new_root.join("docs");
            if let Err(e) = std::fs::rename(&legacy_docs, &dest) {
                panic!("storage migration: rename docs/: {}", e);
            }
        }
        log::info!("storage migration complete");
    }

    /// Path to a workspace's index file.
    fn index_path(&self, ws: &WorkspaceId) -> PathBuf {
        self.workspace_root(ws).join("index.json")
    }

    /// Path to a workspace's per-doc directory.
    fn workspace_root(&self, ws: &WorkspaceId) -> PathBuf {
        self.documents_dir.join("workspaces").join(ws.as_str())
    }

    /// Path to a single document file under its workspace.
    fn doc_path(&self, ws: &WorkspaceId, doc_id: &DocId) -> PathBuf {
        self.workspace_root(ws).join("docs").join(format!("{}.json", doc_id.as_str()))
    }

    /// Path to a document's binary `Y.Doc` sidecar (JP-108), next to its JSON.
    fn ydoc_path(&self, ws: &WorkspaceId, doc_id: &DocId) -> PathBuf {
        self.workspace_root(ws).join("docs").join(format!("{}.ydoc", doc_id.as_str()))
    }

    /// Write the binary `Y.Doc` sidecar (JP-108). `bytes` already carries the
    /// self-describing header (`sync::binary`); this layer is format-agnostic.
    /// Best-effort: callers log and retry on the next snapshot rather than
    /// failing a save.
    pub fn persist_ydoc_binary(
        &self,
        ws: &WorkspaceId,
        doc_id: &DocId,
        bytes: &[u8],
    ) -> Result<(), String> {
        let _ = std::fs::create_dir_all(self.workspace_root(ws).join("docs"));
        std::fs::write(self.ydoc_path(ws, doc_id), bytes)
            .map_err(|e| format!("Write error: {}", e))?;
        // JP-231: refresh size/recency. No gen bump — json is the eviction gate;
        // restore is json-authoritative, a lagging ydoc is reconciled on hydrate.
        self.note_local_write(ws, doc_id, false);
        self.enqueue_mirror(MirrorOp::Put {
            ws: ws.clone(),
            doc_id: doc_id.clone(),
            ext: "ydoc",
        });
        Ok(())
    }

    /// Read a document's binary `Y.Doc` sidecar (JP-108), or `None` if there
    /// is none yet (pre-binary / MCP-created doc) or it can't be read.
    pub fn load_ydoc_binary(&self, ws: &WorkspaceId, doc_id: &DocId) -> Option<Vec<u8>> {
        std::fs::read(self.ydoc_path(ws, doc_id)).ok()
    }

    /// Directory holding a document's recovery points (JP-180), under its
    /// workspace next to the doc's JSON + sidecar.
    fn recovery_dir(&self, ws: &WorkspaceId, doc_id: &DocId) -> PathBuf {
        self.workspace_root(ws)
            .join("docs")
            .join("recovery")
            .join(doc_id.as_str())
    }

    /// Copy the current binary sidecar into the doc's recovery ring (JP-180),
    /// taken just before a suspicious N→0 zeroing snapshot overwrites it.
    /// Best-effort: a missing source or any IO error is logged, never fatal.
    /// Retains the newest [`RECOVERY_RING`] points.
    pub fn push_recovery_point(&self, ws: &WorkspaceId, doc_id: &DocId) {
        let src = self.ydoc_path(ws, doc_id);
        if !src.exists() {
            return; // nothing persisted yet — nothing to back up
        }
        let dir = self.recovery_dir(ws, doc_id);
        if let Err(e) = std::fs::create_dir_all(&dir) {
            log::warn!(
                "recovery dir create failed {}/{}: {}",
                ws.as_str(),
                doc_id.as_str(),
                e
            );
            return;
        }
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let version = self
            .get_metadata(ws, doc_id)
            .and_then(|m| m.server_version)
            .unwrap_or(0);
        let dest = dir.join(format!("{ts}-v{version}.ydoc"));
        if let Err(e) = std::fs::copy(&src, &dest) {
            log::warn!(
                "recovery point copy failed {}/{}: {}",
                ws.as_str(),
                doc_id.as_str(),
                e
            );
            return;
        }
        self.prune_recovery_points(&dir);
    }

    /// Drop all but the newest [`RECOVERY_RING`] recovery points in `dir`.
    /// Filenames lead with the millisecond timestamp, so a lexical sort is
    /// chronological.
    fn prune_recovery_points(&self, dir: &std::path::Path) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        let mut files: Vec<PathBuf> = entries
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().is_some_and(|x| x == "ydoc"))
            .collect();
        files.sort();
        if files.len() > RECOVERY_RING {
            for p in &files[..files.len() - RECOVERY_RING] {
                let _ = std::fs::remove_file(p);
            }
        }
    }

    /// List a document's recovery points (JP-180), newest first. Empty when the
    /// doc has never been backed up or the directory can't be read.
    pub fn list_recovery_points(&self, ws: &WorkspaceId, doc_id: &DocId) -> Vec<RecoveryPoint> {
        let dir = self.recovery_dir(ws, doc_id);
        let Ok(entries) = std::fs::read_dir(&dir) else {
            return Vec::new();
        };
        let mut points: Vec<RecoveryPoint> = entries
            .filter_map(|e| e.ok())
            .filter_map(|e| {
                let path = e.path();
                if path.extension().is_none_or(|x| x != "ydoc") {
                    return None;
                }
                // Stem is `<createdAtMs>-v<serverVersion>`.
                let stem = path.file_stem()?.to_str()?.to_string();
                let (ts_str, ver_str) = stem.split_once("-v")?;
                let created_at = ts_str.parse::<u64>().ok()?;
                let server_version = ver_str.parse::<u64>().ok()?;
                let size_bytes = e.metadata().map(|m| m.len()).unwrap_or(0);
                Some(RecoveryPoint {
                    id: stem,
                    created_at,
                    server_version,
                    size_bytes,
                })
            })
            .collect();
        points.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        points
    }

    /// Walk `workspaces/*` and load every workspace's `index.json` into
    /// the in-memory map. Best-effort — missing or malformed index files
    /// surface as empty maps.
    fn preload_all_workspace_indexes(&self) {
        let workspaces_root = self.documents_dir.join("workspaces");
        let Ok(entries) = std::fs::read_dir(&workspaces_root) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = match path.file_name().and_then(|n| n.to_str()) {
                Some(s) => s.to_string(),
                None => continue,
            };
            // Reuse the path-traversal validator: an attacker-supplied
            // directory like `workspaces/../etc` is rejected and the
            // entry is silently skipped, which is the safest behavior
            // on load.
            let Some(ws) = WorkspaceId::from_configured(&name) else { continue };
            self.load_workspace_index(&ws);
        }
    }

    /// Load a single workspace's index from disk into memory. No-op if
    /// the file is missing or unparseable — the in-memory map for that
    /// workspace stays at whatever it was (empty on first touch).
    fn load_workspace_index(&self, ws: &WorkspaceId) {
        let path = self.index_path(ws);
        let Ok(data) = std::fs::read_to_string(&path) else { return };
        let Ok(parsed) = serde_json::from_str::<HashMap<String, DocumentMetadata>>(&data) else {
            log::warn!("index for workspace {} is malformed — leaving empty", ws.as_str());
            return;
        };
        let ids: Vec<String> = parsed.keys().cloned().collect();
        if let Ok(mut current) = self.index.write() {
            current.insert(ws.clone(), parsed);
        }
        // JP-231: seed working-set cache state for these docs (idempotent).
        self.seed_cache_for_workspace(ws, &ids);
    }

    /// Write a single workspace's index to disk. The raw file write with **no**
    /// R2 enqueue — used by the restore path (`install_restored_doc`) so a
    /// restore doesn't re-upload (and risk clobbering a newer R2 copy).
    fn write_workspace_index_file(&self, ws: &WorkspaceId) -> Result<(), String> {
        // JP-230: serialize index writes so two interleaved writers can't drop an
        // entry (a stale snapshot's write landing after a fresher one). The
        // snapshot is taken **under** this lock, so each serialized write flushes
        // the latest complete in-memory map. Poisoned-lock recovery: take the
        // inner guard anyway — the data it guards is `()`, never corrupt.
        let _guard = self
            .index_write_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let snapshot = {
            let index = self.index.read().map_err(|e| e.to_string())?;
            index.get(ws).cloned().unwrap_or_default()
        };
        let json = serde_json::to_string_pretty(&snapshot)
            .map_err(|e| format!("Serialize error: {}", e))?;
        // Ensure the workspace dir exists before writing.
        let _ = std::fs::create_dir_all(self.workspace_root(ws).join("docs"));
        std::fs::write(self.index_path(ws), json)
            .map_err(|e| format!("Write error: {}", e))?;
        Ok(())
    }

    /// Persist a single workspace's index back to disk and mirror it to R2
    /// (JP-200). The single chokepoint for `PutIndex` enqueues — index mirroring
    /// is never duplicated by the per-doc write paths that call this.
    fn save_workspace_index(&self, ws: &WorkspaceId) -> Result<(), String> {
        self.write_workspace_index_file(ws)?;
        self.enqueue_mirror(MirrorOp::PutIndex { ws: ws.clone() });
        Ok(())
    }

    /// List all documents for a single workspace.
    pub fn list_documents(&self, ws: &WorkspaceId) -> Vec<DocumentMetadata> {
        self.index
            .read()
            .map(|index| {
                index
                    .get(ws)
                    .map(|m| m.values().cloned().collect())
                    .unwrap_or_default()
            })
            .unwrap_or_default()
    }

    /// List every workspace this store currently knows about. Used by
    /// the legacy WS save handler that doesn't yet carry a workspace
    /// id and by future admin tooling; **not** used by per-request
    /// handlers, which always have a workspace from the JWT.
    pub fn known_workspaces(&self) -> Vec<WorkspaceId> {
        self.index
            .read()
            .map(|index| index.keys().cloned().collect())
            .unwrap_or_default()
    }

    /// Get a document by ID (returns full document as JSON value).
    /// Returns `Document not found` if the doc isn't in the requesting
    /// workspace's index, regardless of whether another workspace
    /// happens to own a doc with the same id.
    pub fn get_document(
        &self,
        ws: &WorkspaceId,
        doc_id: &DocId,
    ) -> Result<serde_json::Value, String> {
        // Check if document exists in this workspace's index.
        {
            let index = self.index.read().map_err(|e| e.to_string())?;
            let in_workspace = index
                .get(ws)
                .map(|m| m.contains_key(doc_id.as_str()))
                .unwrap_or(false);
            if !in_workspace {
                return Err("Document not found".to_string());
            }
        }

        // Load document from file.
        let path = self.doc_path(ws, doc_id);
        let data = std::fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read document: {}", e))?;
        let doc: serde_json::Value = serde_json::from_str(&data)
            .map_err(|e| format!("Failed to parse document: {}", e))?;

        self.touch(ws, doc_id); // JP-231: refresh LRU recency on read.
        Ok(doc)
    }

    /// Save a document (creates or updates). Convenience wrapper for
    /// callers that don't need optimistic-concurrency semantics — used
    /// by the WS save handler, which never carried version fields on
    /// the wire. The REST handler uses
    /// `save_document_with_expected_version` directly.
    pub fn save_document(
        &self,
        ws: &WorkspaceId,
        doc: serde_json::Value,
    ) -> Result<(), String> {
        match self.save_document_with_expected_version(ws, doc, None)? {
            SaveOutcome::Created { .. } | SaveOutcome::Updated { .. } => Ok(()),
            // `expected = None` cannot produce a conflict — collapse to
            // a string error to preserve the existing signature.
            SaveOutcome::VersionConflict { current } => Err(format!(
                "unexpected version conflict (current={})",
                current
            )),
        }
    }

    /// Build [`DocumentMetadata`] from a document body at a given server
    /// version. Shared by the save / snapshot / restore write paths so the
    /// derived index fields can't drift between them (JP-200 de-dup).
    fn metadata_from_body(
        doc: &serde_json::Value,
        doc_id: DocId,
        version: u64,
    ) -> DocumentMetadata {
        let modified_at = doc.get("modifiedAt").and_then(|v| v.as_u64()).unwrap_or_else(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0)
        });
        let created_at = doc.get("createdAt").and_then(|v| v.as_u64()).unwrap_or(modified_at);
        DocumentMetadata {
            id: doc_id,
            name: doc.get("name").and_then(|v| v.as_str()).unwrap_or("Untitled").to_string(),
            page_count: doc
                .get("pageOrder")
                .and_then(|v| v.as_array())
                .map(|arr| arr.len())
                .unwrap_or(1),
            modified_at,
            created_at,
            is_relay_document: doc
                .get("isRelayDocument")
                .or_else(|| doc.get("isTeamDocument"))
                .and_then(|v| v.as_bool()),
            server_version: Some(version),
            locked_by: doc.get("lockedBy").and_then(|v| v.as_str()).map(String::from),
            locked_by_name: doc.get("lockedByName").and_then(|v| v.as_str()).map(String::from),
            locked_at: doc.get("lockedAt").and_then(|v| v.as_u64()),
            owner_id: doc.get("ownerId").and_then(|v| v.as_str()).map(String::from),
            owner_name: doc.get("ownerName").and_then(|v| v.as_str()).map(String::from),
            shared_with: doc
                .get("sharedWith")
                .and_then(|v| serde_json::from_value(v.clone()).ok()),
            last_modified_by: doc.get("lastModifiedBy").and_then(|v| v.as_str()).map(String::from),
            last_modified_by_name: doc
                .get("lastModifiedByName")
                .and_then(|v| v.as_str())
                .map(String::from),
        }
    }

    /// Save a document with optimistic-concurrency check.
    ///
    /// When `expected` is `Some(N)`, refuses the write if the stored
    /// `server_version` for this doc is not `N`, returning
    /// `SaveOutcome::VersionConflict { current }`. When `expected` is
    /// `None`, the write proceeds unconditionally (last-writer-wins —
    /// matches pre-v2 behavior for callers that don't opt in).
    ///
    /// On success, the stored `server_version` is bumped (or set to 1
    /// for first creation) and returned. The version is also injected
    /// into the doc body under `serverVersion` so clients can read it
    /// back via `GET /api/docs/:id` without consulting metadata.
    pub fn save_document_with_expected_version(
        &self,
        ws: &WorkspaceId,
        mut doc: serde_json::Value,
        expected: Option<u64>,
    ) -> Result<SaveOutcome, String> {
        let id_str = doc.get("id")
            .and_then(|v| v.as_str())
            .ok_or("Document missing 'id' field")?
            .to_string();
        let doc_id = DocId::from_body_id(id_str.clone())
            .map_err(|e| format!("Invalid document id: {}", e))?;
        let id = id_str;

        // Read current stored version (if any) for the concurrency
        // check. Holding the read lock briefly is fine; the rest of
        // the save runs outside the lock.
        let (prior_version, doc_existed) = {
            let index = self.index.read().map_err(|e| e.to_string())?;
            match index.get(ws).and_then(|m| m.get(&id)) {
                Some(meta) => (meta.server_version.unwrap_or(0), true),
                None => (0, false),
            }
        };

        if let Some(expected_version) = expected {
            if expected_version != prior_version {
                return Ok(SaveOutcome::VersionConflict {
                    current: prior_version,
                });
            }
        }

        let new_version = prior_version + 1;

        // Mirror the new version into the doc body so reads pick it up.
        if let Some(obj) = doc.as_object_mut() {
            obj.insert("serverVersion".to_string(), serde_json::json!(new_version));
        }

        let metadata = Self::metadata_from_body(&doc, doc_id.clone(), new_version);

        let doc_json = serde_json::to_string_pretty(&doc)
            .map_err(|e| format!("Serialize error: {}", e))?;
        // Ensure the per-workspace docs dir exists (first-touch for a
        // new tenant on shared-mode Cloud).
        let _ = std::fs::create_dir_all(self.workspace_root(ws).join("docs"));
        std::fs::write(self.doc_path(ws, &doc_id), doc_json)
            .map_err(|e| format!("Write error: {}", e))?;

        {
            let mut index = self.index.write().map_err(|e| e.to_string())?;
            index
                .entry(ws.clone())
                .or_default()
                .insert(id.clone(), metadata);
        }

        self.save_workspace_index(ws)?;
        // JP-231: file written → bump local gen → enqueue (the worker captures
        // the gen before re-reading, so it can only confirm content it uploaded).
        self.note_local_write(ws, &doc_id, true);
        self.enqueue_mirror(MirrorOp::Put {
            ws: ws.clone(),
            doc_id: doc_id.clone(),
            ext: "json",
        });

        log::info!("Saved relay document: {}/{} (v{})", ws.as_str(), id, new_version);

        Ok(if doc_existed {
            SaveOutcome::Updated { version: new_version }
        } else {
            SaveOutcome::Created { version: new_version }
        })
    }

    /// Persist a relay-authored snapshot of an **existing** document (JP-36).
    ///
    /// Unlike [`save_document_with_expected_version`], this **preserves**
    /// `serverVersion` (no bump) and emits no `DocEvent`: the relay's periodic
    /// `Y.Doc → JSON` flush is a quiet durability mechanism, not a client save.
    /// Bumping the version would make a connected client's next REST save
    /// spuriously conflict, and a `DocEvent` would trigger needless reloads —
    /// the clients are already CRDT-synced with this exact content.
    ///
    /// Returns `Err` if the doc isn't in this workspace's index (the relay only
    /// snapshots docs it hydrated from an existing body).
    pub fn persist_snapshot(&self, ws: &WorkspaceId, mut doc: serde_json::Value) -> Result<(), String> {
        let id = doc
            .get("id")
            .and_then(|v| v.as_str())
            .ok_or("Document missing 'id' field")?
            .to_string();
        let doc_id = DocId::from_body_id(id.clone())
            .map_err(|e| format!("Invalid document id: {}", e))?;

        // Preserve the stored version; refuse to snapshot a doc that doesn't
        // already exist (no version to preserve, and persist_snapshot is never
        // a create path).
        let version = {
            let index = self.index.read().map_err(|e| e.to_string())?;
            match index.get(ws).and_then(|m| m.get(&id)) {
                Some(meta) => meta.server_version.unwrap_or(0),
                None => return Err("Document not found".to_string()),
            }
        };

        // Keep the body's serverVersion in lockstep with the preserved index
        // version so a subsequent read doesn't see a stale number.
        if let Some(obj) = doc.as_object_mut() {
            obj.insert("serverVersion".to_string(), serde_json::json!(version));
        }

        let metadata = Self::metadata_from_body(&doc, doc_id.clone(), version);

        let doc_json = serde_json::to_string_pretty(&doc).map_err(|e| format!("Serialize error: {}", e))?;
        let _ = std::fs::create_dir_all(self.workspace_root(ws).join("docs"));
        std::fs::write(self.doc_path(ws, &doc_id), doc_json).map_err(|e| format!("Write error: {}", e))?;

        {
            let mut index = self.index.write().map_err(|e| e.to_string())?;
            index.entry(ws.clone()).or_default().insert(id.clone(), metadata);
        }
        self.save_workspace_index(ws)?;
        // JP-231: snapshot preserves serverVersion (no bump), so the version
        // number can't signal "new bytes pending" — the local gen does.
        self.note_local_write(ws, &doc_id, true);
        self.enqueue_mirror(MirrorOp::Put {
            ws: ws.clone(),
            doc_id: doc_id.clone(),
            ext: "json",
        });

        log::debug!("relay snapshot persisted: {}/{} (v{}, unchanged)", ws.as_str(), id, version);
        Ok(())
    }

    /// Delete a document scoped to the requesting workspace. Returns
    /// `Ok(false)` if the doc isn't in this workspace's index — even
    /// when another workspace holds a doc with the same id.
    pub fn delete_document(&self, ws: &WorkspaceId, doc_id: &DocId) -> Result<bool, String> {
        // Check if document exists in this workspace.
        {
            let index = self.index.read().map_err(|e| e.to_string())?;
            let in_workspace = index
                .get(ws)
                .map(|m| m.contains_key(doc_id.as_str()))
                .unwrap_or(false);
            if !in_workspace {
                return Ok(false);
            }
        }

        // Remove document file.
        let path = self.doc_path(ws, doc_id);
        if path.exists() {
            std::fs::remove_file(&path)
                .map_err(|e| format!("Failed to delete document file: {}", e))?;
        }

        // Remove the binary Y.Doc sidecar if present (JP-108). Best-effort:
        // a leftover sidecar is harmless (its doc id is gone from the index),
        // so don't fail the delete on a sidecar removal error.
        let ydoc = self.ydoc_path(ws, doc_id);
        if ydoc.exists() {
            if let Err(e) = std::fs::remove_file(&ydoc) {
                log::warn!("Failed to delete Y.Doc sidecar {}/{}: {}", ws.as_str(), doc_id.as_str(), e);
            }
        }

        // Remove the document's recovery points too (JP-180). Best-effort —
        // a leftover recovery dir is harmless once the doc id is gone.
        let recovery = self.recovery_dir(ws, doc_id);
        if recovery.exists() {
            if let Err(e) = std::fs::remove_dir_all(&recovery) {
                log::warn!("Failed to delete recovery dir {}/{}: {}", ws.as_str(), doc_id.as_str(), e);
            }
        }

        // Remove from this workspace's index.
        {
            let mut index = self.index.write().map_err(|e| e.to_string())?;
            if let Some(workspace_index) = index.get_mut(ws) {
                workspace_index.remove(doc_id.as_str());
            }
        }

        self.save_workspace_index(ws)?;
        self.enqueue_mirror(MirrorOp::Delete {
            ws: ws.clone(),
            doc_id: doc_id.clone(),
        });

        log::info!("Deleted relay document: {}/{}", ws.as_str(), doc_id.as_str());
        Ok(true)
    }

    /// Get document metadata by ID, scoped to the requesting workspace.
    pub fn get_metadata(&self, ws: &WorkspaceId, doc_id: &DocId) -> Option<DocumentMetadata> {
        self.index.read().ok()?.get(ws)?.get(doc_id.as_str()).cloned()
    }

    /// Whether the document's JSON **body** is present on the local volume
    /// (JP-279). The index can list a doc whose body isn't local — after a
    /// JP-200 R2 `index.json` restore (index eager, bodies lazy-by-id) or a
    /// JP-231 eviction (index entry kept, body removed) — so body presence, not
    /// index/metadata presence, is the correct "is it local" signal for
    /// restore-on-miss. Using metadata instead would short-circuit the restore
    /// and ENOENT on the subsequent `get_document` read.
    pub fn has_local_body(&self, ws: &WorkspaceId, doc_id: &DocId) -> bool {
        self.doc_path(ws, doc_id).exists()
    }

    /// Update document lock status
    pub fn set_lock(
        &self,
        ws: &WorkspaceId,
        doc_id: &DocId,
        user_id: Option<&str>,
        user_name: Option<&str>,
    ) -> Result<(), String> {
        // Load document
        let mut doc = self.get_document(ws, doc_id)?;

        // Update lock fields
        if let Some(uid) = user_id {
            doc["lockedBy"] = serde_json::json!(uid);
            doc["lockedByName"] = serde_json::json!(user_name.unwrap_or("Unknown"));
            doc["lockedAt"] = serde_json::json!(
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0)
            );
        } else {
            doc["lockedBy"] = serde_json::Value::Null;
            doc["lockedByName"] = serde_json::Value::Null;
            doc["lockedAt"] = serde_json::Value::Null;
        }

        // Save document
        self.save_document(ws, doc)
    }

    /// Check if a document is locked by another user
    pub fn is_locked_by_other(&self, ws: &WorkspaceId, doc_id: &DocId, user_id: &str) -> bool {
        if let Some(metadata) = self.get_metadata(ws, doc_id) {
            if let Some(locked_by) = &metadata.locked_by {
                return locked_by != user_id;
            }
        }
        false
    }

    /// Get document metadata (alias for get_metadata)
    pub fn get_document_metadata(
        &self,
        ws: &WorkspaceId,
        doc_id: &DocId,
    ) -> Option<DocumentMetadata> {
        self.get_metadata(ws, doc_id)
    }

    /// Update document sharing permissions
    pub fn update_document_shares(
        &self,
        ws: &WorkspaceId,
        doc_id: &DocId,
        shares: &[super::protocol::ShareEntry],
    ) -> Result<(), String> {
        // Load document
        let mut doc = self.get_document(ws, doc_id)?;

        // Build new shares list
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        let new_shares: Vec<DocumentShare> = shares
            .iter()
            .filter(|s| s.permission != "none") // "none" means remove access
            .map(|s| DocumentShare {
                user_id: s.user_id.clone(),
                user_name: s.user_name.clone(),
                permission: s.permission.clone(),
                shared_at: now,
            })
            .collect();

        // Update document JSON
        doc["sharedWith"] = serde_json::to_value(&new_shares)
            .map_err(|e| format!("Failed to serialize shares: {}", e))?;

        // Save document
        self.save_document(ws, doc)?;

        log::info!(
            "Updated shares for document {}: {} users",
            doc_id.as_str(),
            new_shares.len()
        );
        Ok(())
    }

    /// Transfer document ownership to another user
    pub fn transfer_ownership(
        &self,
        ws: &WorkspaceId,
        doc_id: &DocId,
        new_owner_id: &str,
        new_owner_name: &str,
        previous_owner_id: &str,
    ) -> Result<(), String> {
        // Load document
        let mut doc = self.get_document(ws, doc_id)?;

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        // Update owner fields
        doc["ownerId"] = serde_json::json!(new_owner_id);
        doc["ownerName"] = serde_json::json!(new_owner_name);

        // Add previous owner as an editor in the shares
        let mut shares: Vec<DocumentShare> = doc["sharedWith"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| serde_json::from_value(v.clone()).ok())
                    .collect()
            })
            .unwrap_or_default();

        // Remove new owner from shares (they're owner now)
        shares.retain(|s| s.user_id != new_owner_id);

        // Add previous owner as editor if not already in shares
        if !shares.iter().any(|s| s.user_id == previous_owner_id) {
            shares.push(DocumentShare {
                user_id: previous_owner_id.to_string(),
                user_name: doc["lastModifiedByName"]
                    .as_str()
                    .unwrap_or("Previous Owner")
                    .to_string(),
                permission: "edit".to_string(),
                shared_at: now,
            });
        }

        doc["sharedWith"] = serde_json::to_value(&shares)
            .map_err(|e| format!("Failed to serialize shares: {}", e))?;

        // Save document
        self.save_document(ws, doc)?;

        log::info!(
            "Transferred ownership of document {} from {} to {}",
            doc_id.as_str(),
            previous_owner_id,
            new_owner_id
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_document_store_lifecycle() {
        let dir = tempdir().unwrap();
        let store = DocumentStore::new(dir.path().to_path_buf());
        let ws = WorkspaceId::single_tenant();
        let doc_id = DocId::from_http_path("test-doc-1".to_string()).unwrap();

        // Initially empty
        assert!(store.list_documents(&ws).is_empty());

        // Create a test document
        let doc = serde_json::json!({
            "id": "test-doc-1",
            "name": "Test Document",
            "pages": {},
            "pageOrder": ["page1"],
            "activePageId": "page1",
            "createdAt": 1000,
            "modifiedAt": 2000,
            "version": 1,
            "isRelayDocument": true
        });

        // Save document
        store.save_document(&ws, doc.clone()).unwrap();

        // List should now have one document
        let docs = store.list_documents(&ws);
        assert_eq!(docs.len(), 1);
        assert_eq!(docs[0].id.as_str(), "test-doc-1");
        assert_eq!(docs[0].name, "Test Document");
        assert_eq!(docs[0].is_relay_document, Some(true));

        // Get document
        let retrieved = store.get_document(&ws, &doc_id).unwrap();
        assert_eq!(retrieved["id"], "test-doc-1");

        // Delete document
        let deleted = store.delete_document(&ws, &doc_id).unwrap();
        assert!(deleted);

        // List should be empty again
        assert!(store.list_documents(&ws).is_empty());
    }

    #[test]
    fn mirror_enqueues_expected_ops_without_duplicate_index() {
        let dir = tempdir().unwrap();
        let mut store = DocumentStore::new(dir.path().to_path_buf());
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        store.set_mirror_sink(tx);
        let ws = WorkspaceId::single_tenant();
        let doc_id = DocId::from_http_path("m-doc".into()).unwrap();

        // save → one Put json + one PutIndex
        store
            .save_document(&ws, serde_json::json!({"id": "m-doc", "name": "M"}))
            .unwrap();
        // binary sidecar → one Put ydoc (no index write)
        store.persist_ydoc_binary(&ws, &doc_id, b"bin").unwrap();
        // delete → one Delete + one PutIndex
        store.delete_document(&ws, &doc_id).unwrap();
        drop(store); // close the sender so the drain terminates

        let (mut put_json, mut put_ydoc, mut put_index, mut deletes) = (0, 0, 0, 0);
        while let Ok(op) = rx.try_recv() {
            match op {
                MirrorOp::Put { ext: "json", .. } => put_json += 1,
                MirrorOp::Put { ext: "ydoc", .. } => put_ydoc += 1,
                MirrorOp::Put { .. } => {}
                MirrorOp::PutIndex { .. } => put_index += 1,
                MirrorOp::Delete { .. } => deletes += 1,
                MirrorOp::Flush(_) => {}
            }
        }
        assert_eq!(put_json, 1, "one json Put from the save");
        assert_eq!(put_ydoc, 1, "one ydoc Put from the binary sidecar");
        assert_eq!(deletes, 1, "one Delete");
        // save (1) + delete (1) each write the index exactly once — never more,
        // proving PutIndex isn't duplicated by the per-doc write paths.
        assert_eq!(put_index, 2, "exactly one PutIndex per index-writing op");
    }

    #[test]
    fn mirror_sink_absent_is_noop() {
        // Filesystem backend (no sink) must not panic and writes still succeed.
        let dir = tempdir().unwrap();
        let store = DocumentStore::new(dir.path().to_path_buf());
        let ws = WorkspaceId::single_tenant();
        store
            .save_document(&ws, serde_json::json!({"id": "n", "name": "N"}))
            .unwrap();
        store.backfill_mirror(); // no-op without a sink
    }

    /// In-memory `DocObjectStore` standing in for R2 — lets the restore path be
    /// unit-tested offline (the live SigV4 path is the env-gated s3 roundtrip).
    struct FakeObjectStore {
        json: Option<Vec<u8>>,
        ydoc: Option<Vec<u8>>,
        index: Option<Vec<u8>>,
    }

    impl DocObjectStore for FakeObjectStore {
        async fn get_doc_object(
            &self,
            _ws: &WorkspaceId,
            _doc_id: &DocId,
            ext: &str,
        ) -> Result<Option<Vec<u8>>, String> {
            Ok(match ext {
                "json" => self.json.clone(),
                "ydoc" => self.ydoc.clone(),
                _ => None,
            })
        }

        async fn get_workspace_index(
            &self,
            _ws: &WorkspaceId,
        ) -> Result<Option<Vec<u8>>, String> {
            Ok(self.index.clone())
        }
    }

    #[tokio::test]
    async fn restore_doc_from_object_store_on_local_miss() {
        let dir = tempdir().unwrap();
        let store = DocumentStore::new(dir.path().to_path_buf());
        let ws = WorkspaceId::single_tenant();
        let doc_id = DocId::from_http_path("r-doc".into()).unwrap();

        // Cold: nothing on the local volume.
        assert!(store.get_document(&ws, &doc_id).is_err());

        let fake = FakeObjectStore {
            json: Some(br#"{"id":"r-doc","name":"Restored","serverVersion":3}"#.to_vec()),
            ydoc: Some(b"DSKY-bin".to_vec()),
            index: None,
        };
        assert!(store.restore_doc_from(&fake, &ws, &doc_id).await);

        // Now readable + indexed at the restored version, with the sidecar.
        let got = store.get_document(&ws, &doc_id).unwrap();
        assert_eq!(got["name"], "Restored");
        assert_eq!(
            store.get_metadata(&ws, &doc_id).unwrap().server_version,
            Some(3)
        );
        assert_eq!(store.load_ydoc_binary(&ws, &doc_id).as_deref(), Some(&b"DSKY-bin"[..]));
    }

    #[tokio::test]
    async fn restore_doc_missing_ydoc_still_restores_json() {
        let dir = tempdir().unwrap();
        let store = DocumentStore::new(dir.path().to_path_buf());
        let ws = WorkspaceId::single_tenant();
        let doc_id = DocId::from_http_path("j-doc".into()).unwrap();

        let fake = FakeObjectStore {
            json: Some(br#"{"id":"j-doc","name":"JsonOnly"}"#.to_vec()),
            ydoc: None,
            index: None,
        };
        assert!(store.restore_doc_from(&fake, &ws, &doc_id).await);
        assert_eq!(store.get_document(&ws, &doc_id).unwrap()["name"], "JsonOnly");
        // No sidecar → hydrate falls back to JSON (sync-layer reconciliation).
        assert!(store.load_ydoc_binary(&ws, &doc_id).is_none());
    }

    #[tokio::test]
    async fn restore_absent_doc_returns_false() {
        let dir = tempdir().unwrap();
        let store = DocumentStore::new(dir.path().to_path_buf());
        let ws = WorkspaceId::single_tenant();
        let doc_id = DocId::from_http_path("ghost".into()).unwrap();

        let fake = FakeObjectStore { json: None, ydoc: None, index: None };
        assert!(!store.restore_doc_from(&fake, &ws, &doc_id).await);
        assert!(store.get_document(&ws, &doc_id).is_err());
    }

    #[tokio::test]
    async fn restore_does_not_re_enqueue_a_mirror() {
        // Restore must never feed the mirror back (no re-upload / clobber).
        let dir = tempdir().unwrap();
        let mut store = DocumentStore::new(dir.path().to_path_buf());
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        store.set_mirror_sink(tx);
        let ws = WorkspaceId::single_tenant();
        let doc_id = DocId::from_http_path("q-doc".into()).unwrap();

        let fake = FakeObjectStore {
            json: Some(br#"{"id":"q-doc","name":"Q"}"#.to_vec()),
            ydoc: Some(b"bin".to_vec()),
            index: None,
        };
        assert!(store.restore_doc_from(&fake, &ws, &doc_id).await);
        drop(store);
        assert!(rx.try_recv().is_err(), "restore enqueued a mirror op");
    }

    #[test]
    fn recovery_point_push_and_list() {
        let dir = tempdir().unwrap();
        let store = DocumentStore::new(dir.path().to_path_buf());
        let ws = WorkspaceId::single_tenant();
        let doc_id = DocId::from_http_path("rec-doc".to_string()).unwrap();

        // No sidecar yet → push is a no-op, list is empty.
        store.push_recovery_point(&ws, &doc_id);
        assert!(store.list_recovery_points(&ws, &doc_id).is_empty());

        // Save the doc (→ serverVersion 1) and lay down a sidecar to back up.
        store
            .save_document(
                &ws,
                serde_json::json!({"id": "rec-doc", "name": "R", "pages": {}}),
            )
            .unwrap();
        store
            .persist_ydoc_binary(&ws, &doc_id, b"DSKY-fake-sidecar")
            .unwrap();

        store.push_recovery_point(&ws, &doc_id);
        let points = store.list_recovery_points(&ws, &doc_id);
        assert_eq!(points.len(), 1, "one recovery point captured");
        assert_eq!(points[0].server_version, 1, "version parsed from filename");
        assert!(points[0].created_at > 0, "timestamp parsed");
        assert_eq!(points[0].size_bytes, b"DSKY-fake-sidecar".len() as u64);
    }

    #[test]
    fn recovery_ring_prunes_to_newest_five() {
        let dir = tempdir().unwrap();
        let store = DocumentStore::new(dir.path().to_path_buf());
        let ws = WorkspaceId::single_tenant();
        let doc_id = DocId::from_http_path("ring-doc".to_string()).unwrap();
        let recovery = store.recovery_dir(&ws, &doc_id);
        std::fs::create_dir_all(&recovery).unwrap();

        // Seven points with distinct, increasing timestamps.
        for ts in 1000u64..1007 {
            std::fs::write(recovery.join(format!("{ts}-v1.ydoc")), b"x").unwrap();
        }
        store.prune_recovery_points(&recovery);

        let points = store.list_recovery_points(&ws, &doc_id);
        assert_eq!(points.len(), RECOVERY_RING, "ring bounded to newest five");
        // Newest first, and the two oldest (1000, 1001) were pruned.
        assert_eq!(points[0].created_at, 1006);
        assert_eq!(points[4].created_at, 1002);
    }

    #[test]
    fn delete_document_clears_recovery_points() {
        let dir = tempdir().unwrap();
        let store = DocumentStore::new(dir.path().to_path_buf());
        let ws = WorkspaceId::single_tenant();
        let doc_id = DocId::from_http_path("del-doc".to_string()).unwrap();

        store
            .save_document(&ws, serde_json::json!({"id": "del-doc", "name": "D"}))
            .unwrap();
        store
            .persist_ydoc_binary(&ws, &doc_id, b"sidecar")
            .unwrap();
        store.push_recovery_point(&ws, &doc_id);
        assert_eq!(store.list_recovery_points(&ws, &doc_id).len(), 1);

        store.delete_document(&ws, &doc_id).unwrap();
        assert!(
            store.list_recovery_points(&ws, &doc_id).is_empty(),
            "recovery points removed with the document"
        );
    }

    #[test]
    fn persist_snapshot_preserves_server_version() {
        let dir = tempdir().unwrap();
        let store = DocumentStore::new(dir.path().to_path_buf());
        let ws = WorkspaceId::single_tenant();
        let doc_id = DocId::from_http_path("snap-doc".to_string()).unwrap();

        // Two real saves → serverVersion is now 2.
        let doc = serde_json::json!({
            "id": "snap-doc", "name": "Snap", "pageOrder": ["p1"],
            "activePageId": "p1", "createdAt": 1, "modifiedAt": 2,
            "pages": {"p1": {"id": "p1", "shapes": {}, "shapeOrder": []}}
        });
        store.save_document(&ws, doc.clone()).unwrap();
        store.save_document(&ws, doc).unwrap();
        let before = store.get_document(&ws, &doc_id).unwrap();
        assert_eq!(before["serverVersion"], serde_json::json!(2));

        // A snapshot writes new content but must NOT bump the version.
        let mut snap = before.clone();
        snap["pages"]["p1"]["shapes"]["s1"] = serde_json::json!({ "id": "s1" });
        snap["modifiedAt"] = serde_json::json!(9999);
        store.persist_snapshot(&ws, snap).unwrap();

        let after = store.get_document(&ws, &doc_id).unwrap();
        assert_eq!(after["serverVersion"], serde_json::json!(2), "version preserved");
        assert!(after["pages"]["p1"]["shapes"].get("s1").is_some(), "content written");
        assert_eq!(after["modifiedAt"], serde_json::json!(9999), "modifiedAt updated");

        // Snapshotting a non-existent doc errors (never a create path).
        let ghost = serde_json::json!({ "id": "ghost", "pageOrder": [] });
        assert!(store.persist_snapshot(&ws, ghost).is_err());
    }

    #[test]
    fn cross_workspace_lookup_returns_not_found() {
        let dir = tempdir().unwrap();
        let store = DocumentStore::new(dir.path().to_path_buf());
        let alpha = WorkspaceId::from_configured("alpha").unwrap();
        let beta = WorkspaceId::from_configured("beta").unwrap();

        let doc = serde_json::json!({
            "id": "shared-id",
            "name": "alpha's doc",
            "pageOrder": ["p1"],
        });
        store.save_document(&alpha, doc).unwrap();

        let doc_id = DocId::from_http_path("shared-id".into()).unwrap();
        // Alpha sees it.
        assert!(store.get_document(&alpha, &doc_id).is_ok());
        assert_eq!(store.list_documents(&alpha).len(), 1);
        // Beta does not — same id, different workspace.
        assert!(store.get_document(&beta, &doc_id).is_err());
        assert!(store.list_documents(&beta).is_empty());
        assert!(store.get_metadata(&beta, &doc_id).is_none());
    }

    #[test]
    fn migration_moves_legacy_layout_into_default_workspace() {
        let dir = tempdir().unwrap();
        let root = dir.path().join("relay_documents");
        std::fs::create_dir_all(root.join("docs")).unwrap();
        // Seed a legacy index + doc.
        let meta = DocumentMetadata {
            id: DocId::from_http_path("legacy-doc".into()).unwrap(),
            name: "legacy".into(),
            page_count: 1,
            modified_at: 1,
            created_at: 1,
            is_relay_document: Some(true),
            server_version: Some(1),
            locked_by: None,
            locked_by_name: None,
            locked_at: None,
            owner_id: None,
            owner_name: None,
            shared_with: None,
            last_modified_by: None,
            last_modified_by_name: None,
        };
        let mut legacy_index = HashMap::new();
        legacy_index.insert("legacy-doc".to_string(), meta);
        std::fs::write(
            root.join("index.json"),
            serde_json::to_string_pretty(&legacy_index).unwrap(),
        )
        .unwrap();
        std::fs::write(
            root.join("docs").join("legacy-doc.json"),
            "{\"id\":\"legacy-doc\"}",
        )
        .unwrap();

        // First boot — migration runs.
        let store = DocumentStore::new(dir.path().to_path_buf());
        let default = WorkspaceId::single_tenant();
        let doc_id = DocId::from_http_path("legacy-doc".into()).unwrap();
        assert!(store.get_metadata(&default, &doc_id).is_some());
        assert!(root.join("workspaces").join("default").join("index.json").exists());
        assert!(!root.join("index.json").exists());

        // Second boot — idempotent.
        drop(store);
        let _store2 = DocumentStore::new(dir.path().to_path_buf());
        assert!(root.join("workspaces").join("default").join("index.json").exists());
    }

    #[test]
    fn test_document_not_found() {
        let dir = tempdir().unwrap();
        let store = DocumentStore::new(dir.path().to_path_buf());
        let ws = WorkspaceId::single_tenant();
        let doc_id = DocId::from_http_path("nonexistent".to_string()).unwrap();

        let result = store.get_document(&ws, &doc_id);
        assert!(result.is_err());
    }

    // ---- JP-231 working-set cache / eviction --------------------------------

    fn snap(
        ws: &WorkspaceId,
        id: &str,
        last: u64,
        evictable: bool,
        size: u64,
    ) -> CacheEntrySnapshot {
        CacheEntrySnapshot {
            ws: ws.clone(),
            doc_id: DocId::from_http_path(id.to_string()).unwrap(),
            last_access_ms: last,
            evictable_by_gen: evictable,
            size_bytes: size,
        }
    }

    #[test]
    fn select_victims_picks_coldest_mirrored_non_resident_until_low_water() {
        let ws = WorkspaceId::single_tenant();
        let entries = vec![
            snap(&ws, "warm", 100, true, 100),
            snap(&ws, "cold", 1, true, 100),
            snap(&ws, "dirty", 0, false, 100),   // unmirrored — never a victim
            snap(&ws, "resident", 0, true, 100), // actively synced — never a victim
        ];
        let resident: HashSet<(WorkspaceId, DocId)> =
            [(ws.clone(), DocId::from_http_path("resident".into()).unwrap())]
                .into_iter()
                .collect();
        // total = 400 > max 250; evict toward low-water 150.
        let victims = select_victims(&entries, &resident, 250, 150);
        let ids: Vec<&str> = victims.iter().map(|(_, d, _)| d.as_str()).collect();
        // Coldest first; dirty + resident excluded.
        assert_eq!(ids, vec!["cold", "warm"]);
    }

    #[test]
    fn select_victims_empty_when_under_budget_or_disabled() {
        let ws = WorkspaceId::single_tenant();
        let entries = vec![snap(&ws, "a", 1, true, 100), snap(&ws, "b", 2, true, 100)];
        let resident = HashSet::new();
        assert!(select_victims(&entries, &resident, 1000, 800).is_empty(), "under budget");
        assert!(select_victims(&entries, &resident, 0, 0).is_empty(), "disabled (max 0)");
    }

    #[test]
    fn saved_doc_is_dirty_until_mirror_confirmed() {
        let dir = tempdir().unwrap();
        let store = DocumentStore::new(dir.path().to_path_buf());
        let ws = WorkspaceId::single_tenant();
        let doc_id = DocId::from_http_path("g-doc".into()).unwrap();

        store
            .save_document(&ws, serde_json::json!({"id": "g-doc", "name": "G"}))
            .unwrap();
        // local_gen bumped to 1, mirrored_gen still 0 → not evictable yet.
        let before = store.cache_snapshot();
        let e = before.iter().find(|e| e.doc_id.as_str() == "g-doc").unwrap();
        assert!(!e.evictable_by_gen, "unmirrored save must not be evictable");

        // Mirror worker confirms the upload at the captured gen.
        let gen = store.current_local_gen(&ws, &doc_id);
        store.set_mirrored_gen(&ws, &doc_id, gen);
        let after = store.cache_snapshot();
        let e = after.iter().find(|e| e.doc_id.as_str() == "g-doc").unwrap();
        assert!(e.evictable_by_gen, "confirmed-mirrored doc is evictable");
    }

    #[test]
    fn evict_doc_files_drops_local_keeps_index_no_mirror() {
        let dir = tempdir().unwrap();
        let mut store = DocumentStore::new(dir.path().to_path_buf());
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        store.set_mirror_sink(tx);
        let ws = WorkspaceId::single_tenant();
        let doc_id = DocId::from_http_path("e-doc".into()).unwrap();

        store
            .save_document(&ws, serde_json::json!({"id": "e-doc", "name": "E"}))
            .unwrap();
        store.persist_ydoc_binary(&ws, &doc_id, b"bin").unwrap();
        assert!(store.cache_bytes() > 0, "saved doc has a footprint");
        // Drain the save/sidecar ops so we can prove eviction adds none.
        while rx.try_recv().is_ok() {}

        let freed = store.evict_doc_files(&ws, &doc_id);
        assert!(freed > 0, "eviction freed the doc's bytes");
        // Files gone locally…
        assert!(store.get_document(&ws, &doc_id).is_err(), "local files removed");
        assert!(store.load_ydoc_binary(&ws, &doc_id).is_none(), "sidecar removed");
        // …but the doc stays listable (index entry kept) and the footprint drops.
        assert!(
            store.get_metadata(&ws, &doc_id).is_some(),
            "index entry kept for restore-on-miss"
        );
        assert_eq!(store.list_documents(&ws).len(), 1, "still listable");
        assert_eq!(store.cache_bytes(), 0, "evicted bytes reclaimed");
        // Eviction must not feed the mirror back.
        drop(store);
        assert!(rx.try_recv().is_err(), "eviction enqueued a mirror op");
    }

    // JP-279: the "is it local" signal must follow the **body file**, not the
    // index. A doc whose body was evicted (or whose index was restored from R2
    // ahead of its body) is still listed in the index — using metadata presence
    // as the gate short-circuits restore-on-miss and ENOENTs the read.
    #[test]
    fn has_local_body_tracks_the_body_not_the_index() {
        let dir = tempdir().unwrap();
        let store = DocumentStore::new(dir.path().to_path_buf());
        let ws = WorkspaceId::single_tenant();
        let doc_id = DocId::from_http_path("body-doc".into()).unwrap();

        store
            .save_document(
                &ws,
                serde_json::json!({"id": "body-doc", "name": "B", "serverVersion": 1}),
            )
            .unwrap();
        assert!(store.has_local_body(&ws, &doc_id), "body present after save");

        store.evict_doc_files(&ws, &doc_id);
        // Index entry kept (listable) but the body is gone — the exact state that
        // ENOENT'd: `get_metadata` is Some while `has_local_body` is false.
        assert!(store.get_metadata(&ws, &doc_id).is_some(), "still indexed");
        assert!(
            !store.has_local_body(&ws, &doc_id),
            "body gone — must trigger restore-on-miss, not report 'local'"
        );
    }

    #[tokio::test]
    async fn evict_then_restore_round_trip() {
        let dir = tempdir().unwrap();
        let store = DocumentStore::new(dir.path().to_path_buf());
        let ws = WorkspaceId::single_tenant();
        let doc_id = DocId::from_http_path("rt-doc".into()).unwrap();

        store
            .save_document(
                &ws,
                serde_json::json!({"id": "rt-doc", "name": "RoundTrip", "serverVersion": 1}),
            )
            .unwrap();
        // Simulate the volume being reclaimed for this cold doc.
        store.evict_doc_files(&ws, &doc_id);
        assert!(store.get_document(&ws, &doc_id).is_err(), "cold miss after eviction");

        // R2 still holds it (JP-200) — restore on next touch.
        let fake = FakeObjectStore {
            json: Some(br#"{"id":"rt-doc","name":"RoundTrip","serverVersion":1}"#.to_vec()),
            ydoc: None,
            index: None,
        };
        assert!(store.restore_doc_from(&fake, &ws, &doc_id).await);
        assert_eq!(store.get_document(&ws, &doc_id).unwrap()["name"], "RoundTrip");
        // Restored from R2 → immediately re-evictable once cold (mirrored == local).
        let snap = store.cache_snapshot();
        let e = snap.iter().find(|e| e.doc_id.as_str() == "rt-doc").unwrap();
        assert!(e.evictable_by_gen, "restored doc is confirmed-mirrored");
    }

    // ---- JP-230 index-write serialization -----------------------------------

    #[test]
    fn concurrent_saves_all_land_in_the_index() {
        // Many threads saving distinct docs into ONE shared store must not lose
        // an entry — neither in memory nor on disk. Without `index_write_lock`,
        // interleaved snapshot-then-write index flushes drop entries on disk.
        use std::sync::Arc;
        let dir = tempdir().unwrap();
        let store = Arc::new(DocumentStore::new(dir.path().to_path_buf()));
        let ws = WorkspaceId::single_tenant();
        let n = 32usize;

        let handles: Vec<_> = (0..n)
            .map(|i| {
                let store = store.clone();
                let ws = ws.clone();
                std::thread::spawn(move || {
                    store
                        .save_document(
                            &ws,
                            serde_json::json!({"id": format!("doc-{i}"), "name": format!("D{i}")}),
                        )
                        .unwrap();
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }

        assert_eq!(store.list_documents(&ws).len(), n, "in-memory index complete");
        // A fresh store over the same dir reads the on-disk index — the real test
        // that no serialized file write clobbered a concurrent one.
        let reloaded = DocumentStore::new(dir.path().to_path_buf());
        assert_eq!(
            reloaded.list_documents(&ws).len(),
            n,
            "on-disk index.json retained every concurrent save"
        );
    }
}
