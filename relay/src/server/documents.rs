//! Relay document storage and management
//!
//! Provides file-based storage for relay documents that are shared across clients.
//! Documents are stored as JSON files in the app data directory.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::RwLock;
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::oneshot;

use super::blob_backend::DocObjectStore;
use super::protocol::{DocId, WorkspaceId};

/// Crash-safe file write (JP-424): write to a sibling temp file in the same
/// directory (same filesystem — required for an atomic `rename`), fsync, then
/// rename over the destination. A crash mid-write leaves only a stray temp
/// file, never a torn destination — load paths that treat a malformed file as
/// empty (e.g. the collections registry) can't be tripped by a partial write.
/// The temp suffix is unique per process+call because writers of the *same*
/// path (doc saves) are not serialized by any per-doc lock. Directory fsync is
/// deliberately skipped: the worst post-crash case is "rename not yet durable"
/// (file absent), the same exposure as a plain write, and the R2 mirror
/// restore path covers it.
fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    static TMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let dir = match path.parent() {
        Some(p) if !p.as_os_str().is_empty() => p.to_path_buf(),
        _ => PathBuf::from("."),
    };
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".to_string());
    let tmp = dir.join(format!(
        ".{}.tmp-{}-{}",
        file_name,
        std::process::id(),
        TMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    let result = (|| {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        std::fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

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
    /// Upload a workspace's `collections.json` (collection definitions registry).
    PutCollections { ws: WorkspaceId },
    /// Upload a workspace's `deleted-ids.json` tombstone registry (JP-375) so a
    /// cold machine knows which ids are dead and won't resurrect them from R2.
    PutDeleted { ws: WorkspaceId },
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

/// A collection **definition** — name/colour/order for one collection in a
/// workspace. Definitions are client-authoritative (the editor owns them) and
/// stored per-workspace in `collections.json` so docushark-web can render a
/// collection's title/colour. Membership (which documents are in a collection)
/// is NOT here — it lives on each document's `collection_id`
/// ([`DocumentMetadata`]). Flat by design: no nesting, no parent links.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionDef {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    pub order: i64,
}

/// In-memory per-workspace collections registry: the defs plus a monotonic
/// version bumped on every accepted write (JP-424). The version backs the
/// optimistic-concurrency check on `PUT /api/collections`, closing the
/// lost-update window between two clients' read-modify-write cycles.
#[derive(Debug, Clone, Default)]
pub struct CollectionsRegistry {
    pub version: u64,
    pub defs: Vec<CollectionDef>,
}

/// On-disk shape of `collections.json` (JP-424): a version wrapper around the
/// defs. Legacy files are a bare `[CollectionDef]` array — the loader accepts
/// both (bare array ⇒ version 0) and the next accepted write rewrites the file
/// in wrapper form.
#[derive(Debug, Serialize, Deserialize)]
struct CollectionsFile {
    version: u64,
    collections: Vec<CollectionDef>,
}

/// Parse `collections.json` content in either shape: the JP-424 version
/// wrapper, or the legacy bare `[CollectionDef]` array (⇒ version 0). `None`
/// when neither shape parses.
fn parse_collections_file(data: &str) -> Option<CollectionsRegistry> {
    if let Ok(file) = serde_json::from_str::<CollectionsFile>(data) {
        return Some(CollectionsRegistry { version: file.version, defs: file.collections });
    }
    let defs = serde_json::from_str::<Vec<CollectionDef>>(data).ok()?;
    Some(CollectionsRegistry { version: 0, defs })
}

/// Result of a collections-registry write attempt (JP-424) — mirrors the
/// document-save `SaveOutcome` split so the handler can map a conflict to the
/// same 409 wire shape.
#[derive(Debug)]
pub enum SetCollectionsOutcome {
    /// The write landed; `version` is the new registry version.
    Updated { version: u64 },
    /// `expectedVersion` didn't match — nothing was written. Carries the
    /// current state so the client can rebase without another GET.
    VersionConflict { current_version: u64, current: Vec<CollectionDef> },
}

/// Registry caps enforced on `PUT /api/collections` (JP-424). Generous for
/// interactive use; they exist to bound the sidecar file, not to police UX.
pub const MAX_COLLECTIONS_PER_WORKSPACE: usize = 200;
pub const MAX_COLLECTION_NAME_LEN: usize = 120;
pub const MAX_COLLECTION_ID_LEN: usize = 64;
pub const MAX_COLLECTION_COLOR_LEN: usize = 32;

/// Validate + heal an incoming definition set (JP-424): duplicate ids are
/// deduped keep-first (a heal for client bugs, not a user error); structural
/// violations — empty/oversized fields or an oversized set — are rejected with
/// a technical message the handler surfaces as a 400.
pub fn sanitize_collection_defs(defs: Vec<CollectionDef>) -> Result<Vec<CollectionDef>, String> {
    let mut seen = HashSet::new();
    let mut out = Vec::with_capacity(defs.len());
    for def in defs {
        if !seen.insert(def.id.clone()) {
            continue;
        }
        if def.id.is_empty() || def.id.len() > MAX_COLLECTION_ID_LEN {
            return Err(format!(
                "collection id must be 1..={} bytes",
                MAX_COLLECTION_ID_LEN
            ));
        }
        if def.name.trim().is_empty() || def.name.chars().count() > MAX_COLLECTION_NAME_LEN {
            return Err(format!(
                "collection name must be non-empty and at most {} characters",
                MAX_COLLECTION_NAME_LEN
            ));
        }
        if def.color.as_ref().is_some_and(|c| c.len() > MAX_COLLECTION_COLOR_LEN) {
            return Err(format!(
                "collection color exceeds {} bytes",
                MAX_COLLECTION_COLOR_LEN
            ));
        }
        out.push(def);
    }
    if out.len() > MAX_COLLECTIONS_PER_WORKSPACE {
        return Err(format!(
            "workspace exceeds {} collections",
            MAX_COLLECTIONS_PER_WORKSPACE
        ));
    }
    Ok(out)
}

/// Lightweight metadata for document listing
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentMetadata {
    pub id: DocId,
    pub name: String,
    /// Total pages across BOTH collections — canvas (`pageOrder`) + prose
    /// (`richTextPages.pageOrder`). Was canvas-only, which made the MCP doc
    /// list read as if prose pages had vanished (JP-349). Derived in
    /// `metadata_from_body`; the canvas/prose split is recoverable as
    /// `page_count - prose_page_count`.
    pub page_count: usize,
    /// Number of prose pages, so the MCP doc list can report a canvas/prose
    /// breakdown (JP-349). `None` on entries written before JP-349 — backfilled
    /// from the body in `load_workspace_index`. `#[serde(default)]` keeps a
    /// pre-JP-349 `index.json` loadable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prose_page_count: Option<usize>,
    /// Byte length of the persisted doc JSON (`docs/<id>.json`), recorded at
    /// write time. Counts toward the workspace storage meter alongside blob
    /// bytes (JP-443). Lives in the mirrored `index.json`, so the number
    /// survives eviction and R2 restore. `None` on entries written before
    /// this field — backfilled from the local body in `load_workspace_index`;
    /// an evicted legacy entry stays `None` until its next save/restore.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
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
    /// Membership in a single collection ("workspace inside your workspace").
    /// `None` means unassigned. Carried on the document body under `collectionId`
    /// and lifted here by `metadata_from_body`, so it rides the existing save +
    /// R2-mirror path and surfaces in the metadata-only listing without a
    /// separate membership store. Additive + optional → backward-compatible
    /// (absent in pre-collections `index.json` entries).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collection_id: Option<String>,
    /// Free-form organizational tags (JP-388). Unlike `collection_id` these
    /// are document *content*, not scope-bound membership: they carry on the
    /// body under `tags` and are lifted here by `metadata_from_body` so the
    /// browser can filter/search without fetching bodies. `None` covers both
    /// "untagged" and pre-tags entries (additive + optional →
    /// backward-compatible `index.json`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
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

/// Default recovery-ring depth per document. Points are captured periodically
/// while a doc is actively edited, at session end, and by the poison guard
/// (JP-180/JP-185); the ring keeps the newest N. Overridden per store via
/// [`DocumentStore::set_recovery_ring`] from `[sync] version_ring`.
const DEFAULT_RECOVERY_RING: usize = 20;

/// Default tombstone retention window (JP-375). A deleted id is fenced for this
/// long so a returning offline editor's stale state can't merge back into a
/// re-created/restored doc; after the window the record is pruned so
/// `deleted-ids.json` stays bounded. Override with `RELAY_TOMBSTONE_TTL_DAYS`.
const DEFAULT_TOMBSTONE_TTL_DAYS: u64 = 30;

/// One tombstone entry (JP-375): a document id that was deleted, with enough
/// context to fence stale rejoins and to prune the record once it ages out.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletedRecord {
    /// Wall-clock millis when the id was tombstoned (prune key).
    pub deleted_at_ms: u64,
    /// The `serverVersion` the doc carried at deletion (diagnostic / future
    /// version-fence use).
    #[serde(default)]
    pub last_server_version: u64,
    /// The doc's owner at deletion. The deliberate resurrection override is
    /// gated on this (the doc's metadata is gone, so there's nothing else to
    /// authorize against): only the original owner — or a workspace admin —
    /// may lift the tombstone. `None` if the doc had no recorded owner.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_id: Option<String>,
}

/// Drop tombstone records older than `ttl_ms` relative to `now_ms`. Pure (no IO)
/// so the prune policy is unit-testable. Returns whether anything was removed.
fn prune_deleted_records(
    map: &mut std::collections::BTreeMap<String, DeletedRecord>,
    now_ms: u64,
    ttl_ms: u64,
) -> bool {
    let before = map.len();
    map.retain(|_, rec| now_ms.saturating_sub(rec.deleted_at_ms) < ttl_ms);
    map.len() != before
}

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
    /// The id is tombstoned (JP-375): it was deleted and the write would
    /// resurrect it. Refused unless the caller first clears the tombstone via
    /// an explicit, permission-gated override (`clear_tombstone`).
    Tombstoned,
    /// The save would grow the workspace's storage (doc + blob bytes) past its
    /// quota (JP-443). Only a *growing* save is refused — shrinking/equal-size
    /// saves and deletes always pass, so a caller can dig out of an over-quota
    /// state by removing content.
    QuotaExceeded {
        /// Combined doc+blob bytes before this save.
        used: u64,
        /// The effective storage quota that refused the write.
        quota: u64,
        /// Serialized size of the incoming document.
        incoming: u64,
    },
    /// The serialized document exceeds the per-document size ceiling (JP-443).
    DocTooLarge { size: u64, max: u64 },
}

/// Caller-supplied storage-gate inputs for a document save (JP-443). `None`
/// fields disable that check. Built by the HTTP/MCP layers from the request's
/// effective limits; the store enforces raw numbers only and never learns
/// where they came from (claim vs config).
#[derive(Debug, Clone, Default)]
pub struct DocSaveGate {
    /// Effective workspace storage quota (doc + blob bytes).
    pub quota_bytes: Option<u64>,
    /// Workspace blob usage snapshot (the caller reads the blob store; this
    /// store only knows documents).
    pub blob_bytes: u64,
    /// Per-document byte ceiling for the serialized JSON body.
    pub max_doc_bytes: Option<u64>,
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
    /// Per-workspace collection **definitions** (name/colour/order), loaded from
    /// `workspaces/<ws>/collections.json`. Client-authoritative; the relay stores
    /// them so the web can render collection titles. Membership is not here (it's
    /// `DocumentMetadata.collection_id`). Key presence (even with empty defs)
    /// means "loaded/probed" — [`ensure_workspace_collections_local`] keys its
    /// cold-start R2 restore off that, so an emptied registry isn't re-fetched
    /// (and resurrected) from a stale mirror (JP-424).
    collections: RwLock<HashMap<WorkspaceId, CollectionsRegistry>>,
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
    /// JP-375 tombstone registry: deleted document ids per workspace, persisted to
    /// `workspaces/<ws>/deleted-ids.json` (and mirrored to R2). Fences stale
    /// offline rejoins / blind re-creates so a deleted (or restored) doc can't be
    /// silently resurrected. Loaded on boot like `index`; pruned by TTL.
    deleted_ids: RwLock<HashMap<WorkspaceId, std::collections::BTreeMap<String, DeletedRecord>>>,
    /// JP-375 tombstone retention window in millis (from `RELAY_TOMBSTONE_TTL_DAYS`,
    /// default [`DEFAULT_TOMBSTONE_TTL_DAYS`]). Records older than this are pruned.
    tombstone_ttl_ms: u64,
    /// Recovery-ring depth (JP-185): how many recovery points each document
    /// retains. Set from `[sync] version_ring` via [`Self::set_recovery_ring`].
    recovery_ring: usize,
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

        let tombstone_ttl_ms = std::env::var("RELAY_TOMBSTONE_TTL_DAYS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(DEFAULT_TOMBSTONE_TTL_DAYS)
            .saturating_mul(24 * 60 * 60 * 1000);

        let store = Self {
            documents_dir: documents_dir.clone(),
            index: RwLock::new(HashMap::new()),
            collections: RwLock::new(HashMap::new()),
            mirror_tx: None,
            cache: RwLock::new(HashMap::new()),
            index_write_lock: std::sync::Mutex::new(()),
            deleted_ids: RwLock::new(HashMap::new()),
            tombstone_ttl_ms,
            recovery_ring: DEFAULT_RECOVERY_RING,
        };

        // Eagerly preload every workspace index (and collection registry) so
        // `list_documents` / `list_collections` for a known-but-not-yet-touched
        // workspace doesn't miss its entries on a cold start.
        store.preload_all_workspace_indexes();

        store
    }

    /// Attach the R2 mirror sink (JP-200). Call on the `&mut` store **before**
    /// `Arc::new`, mirroring `BlobStore::set_object_delete_sink`. Wired only when
    /// the s3 backend is active; shared into the MCP store too.
    pub fn set_mirror_sink(&mut self, tx: UnboundedSender<MirrorOp>) {
        self.mirror_tx = Some(tx);
    }

    /// Set the recovery-ring depth (JP-185, `[sync] version_ring`). Call on the
    /// `&mut` store before `Arc::new`, like [`Self::set_mirror_sink`]. Clamped
    /// to at least 1 so the poison guard always has somewhere to back up to.
    pub fn set_recovery_ring(&mut self, n: usize) {
        self.recovery_ring = n.max(1);
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

    /// JP-443: recorded document bytes for one workspace — the document half of
    /// the storage meter (serialized JSON only; sidecars and recovery points
    /// are operational copies and never counted). Sums the mirrored index, so
    /// the number survives eviction; legacy entries without a recorded size
    /// contribute 0 until their next save/restore.
    pub fn workspace_doc_bytes(&self, ws: &WorkspaceId) -> u64 {
        self.index
            .read()
            .ok()
            .and_then(|index| {
                index
                    .get(ws)
                    .map(|m| m.values().map(|meta| meta.size_bytes.unwrap_or(0)).sum())
            })
            .unwrap_or(0)
    }

    /// JP-443: recorded document bytes across all workspaces (pod-wide, for
    /// `/metrics`). Indexes are preloaded at startup, so this sum is complete.
    pub fn total_doc_bytes(&self) -> u64 {
        self.index
            .read()
            .map(|index| {
                index
                    .values()
                    .flat_map(|m| m.values())
                    .map(|meta| meta.size_bytes.unwrap_or(0))
                    .sum()
            })
            .unwrap_or(0)
    }

    /// Root of the relay-owned document tree — the filesystem the /metrics
    /// volume gauges describe (JP-443).
    pub fn documents_dir(&self) -> &std::path::Path {
        &self.documents_dir
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
        write_atomic(&self.doc_path(ws, &doc_id), json_bytes)
            .map_err(|e| format!("restore: write json: {}", e))?;
        if let Some(bin) = ydoc_bytes {
            write_atomic(&self.ydoc_path(ws, &doc_id), bin)
                .map_err(|e| format!("restore: write ydoc: {}", e))?;
        }

        let mut metadata = Self::metadata_from_body(&doc, doc_id.clone(), version);
        // Restores stay size-accurate even when the mirrored index copy was
        // stale — the body bytes in hand are the exact on-disk length (JP-443).
        metadata.size_bytes = Some(json_bytes.len() as u64);
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
                if write_atomic(&self.index_path(ws), &bytes).is_ok() {
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
        write_atomic(&self.ydoc_path(ws, doc_id), bytes)
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

    /// Copy the current binary sidecar into the doc's recovery ring
    /// (JP-180/JP-185): periodically while a doc is edited, at session end,
    /// and just before a suspicious N→0 zeroing snapshot overwrites it.
    /// Best-effort: a missing source or any IO error is logged, never fatal.
    /// Retains the newest `recovery_ring` points.
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
        let mut ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let version = self
            .get_metadata(ws, doc_id)
            .and_then(|m| m.server_version)
            .unwrap_or(0);
        // Two captures inside the same millisecond at the same version would
        // collide on the filename and silently overwrite — nudge forward.
        let mut dest = dir.join(format!("{ts}-v{version}.ydoc"));
        while dest.exists() {
            ts += 1;
            dest = dir.join(format!("{ts}-v{version}.ydoc"));
        }
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

    /// Drop all but the newest `recovery_ring` recovery points in `dir`.
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
        if files.len() > self.recovery_ring {
            for p in &files[..files.len() - self.recovery_ring] {
                let _ = std::fs::remove_file(p);
            }
        }
    }

    /// The newest recovery point for a doc, if any (JP-185 capture gating).
    pub fn newest_recovery_point(&self, ws: &WorkspaceId, doc_id: &DocId) -> Option<RecoveryPoint> {
        self.list_recovery_points(ws, doc_id).into_iter().next()
    }

    /// Push a recovery point unless the current sidecar is byte-identical to
    /// the newest existing point (JP-185 session-end capture). `serverVersion`
    /// can't discriminate here — quiet CRDT snapshots preserve it — so identity
    /// is checked on the bytes (size first, then content). Returns whether a
    /// point was captured.
    pub fn push_recovery_point_if_changed(&self, ws: &WorkspaceId, doc_id: &DocId) -> bool {
        let src = self.ydoc_path(ws, doc_id);
        let Ok(src_meta) = std::fs::metadata(&src) else {
            return false; // nothing persisted yet — nothing to back up
        };
        if let Some(newest) = self.newest_recovery_point(ws, doc_id) {
            let newest_path = self.recovery_dir(ws, doc_id).join(format!("{}.ydoc", newest.id));
            if newest.size_bytes == src_meta.len() {
                if let (Ok(a), Ok(b)) = (std::fs::read(&src), std::fs::read(&newest_path)) {
                    if a == b {
                        return false;
                    }
                }
            }
        }
        self.push_recovery_point(ws, doc_id);
        true
    }

    /// Read one recovery point's raw binary `.ydoc` bytes by its filename stem
    /// (`<createdAtMs>-v<serverVersion>`), JP-183. `None` if the id is malformed,
    /// absent, or pruned. The caller validates the stem shape (no path
    /// separators) before calling; the join here also can't escape the recovery
    /// dir because a stem containing `/` or `..` won't match an actual file.
    pub fn read_recovery_point(
        &self,
        ws: &WorkspaceId,
        doc_id: &DocId,
        point_id: &str,
    ) -> Option<Vec<u8>> {
        let path = self.recovery_dir(ws, doc_id).join(format!("{point_id}.ydoc"));
        std::fs::read(path).ok()
    }

    /// Copy a document's recovery ring to another doc id (JP-183) so a restored
    /// doc inherits its source's backup history (you can restore further back
    /// after a restore). Best-effort: per-file errors are logged, never fatal.
    pub fn copy_recovery_ring(&self, ws: &WorkspaceId, from: &DocId, to: &DocId) {
        let src = self.recovery_dir(ws, from);
        let Ok(entries) = std::fs::read_dir(&src) else {
            return;
        };
        let dest_dir = self.recovery_dir(ws, to);
        if std::fs::create_dir_all(&dest_dir).is_err() {
            return;
        }
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().is_some_and(|x| x == "ydoc") {
                if let Some(name) = p.file_name() {
                    let _ = std::fs::copy(&p, dest_dir.join(name));
                }
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
            self.load_workspace_collections(&ws);
            self.load_workspace_deleted_ids(&ws);
        }
    }

    /// Load a single workspace's index from disk into memory. No-op if
    /// the file is missing or unparseable — the in-memory map for that
    /// workspace stays at whatever it was (empty on first touch).
    fn load_workspace_index(&self, ws: &WorkspaceId) {
        let path = self.index_path(ws);
        let Ok(data) = std::fs::read_to_string(&path) else { return };
        let Ok(mut parsed) = serde_json::from_str::<HashMap<String, DocumentMetadata>>(&data) else {
            log::warn!("index for workspace {} is malformed — leaving empty", ws.as_str());
            return;
        };
        // JP-349 backfill: pre-JP-349 entries lack `prose_page_count` and their
        // `page_count` is canvas-only — so without this an existing (cold) doc
        // would keep reporting the canvas-only count, the very thing JP-349
        // fixes. Re-derive both from the local body. Best-effort: an
        // evicted-to-R2 body that isn't local stays `None` until its next save
        // (acceptable pre-GA). `meta.id` is the doc's `DocId`, so no key parse.
        let mut backfilled = false;
        for meta in parsed.values_mut() {
            // JP-443 backfill: pre-JP-443 entries lack `size_bytes` — derive it
            // from the local body's on-disk length (`write_atomic` writes
            // exactly the serialized bytes, so the stat is exact). An
            // evicted-to-R2 body stays `None` until its next save/restore; the
            // save gate is deliberately lenient for that case.
            if meta.size_bytes.is_none() {
                if let Ok(m) = std::fs::metadata(self.doc_path(ws, &meta.id)) {
                    meta.size_bytes = Some(m.len());
                    backfilled = true;
                }
            }
            if meta.prose_page_count.is_some() {
                continue;
            }
            let path = self.doc_path(ws, &meta.id);
            if let Some(body) = std::fs::read_to_string(&path)
                .ok()
                .and_then(|d| serde_json::from_str::<serde_json::Value>(&d).ok())
            {
                let (canvas, prose) = Self::page_counts_of(&body);
                meta.page_count = (canvas + prose).max(1);
                meta.prose_page_count = Some(prose);
                backfilled = true;
            }
        }
        let ids: Vec<String> = parsed.keys().cloned().collect();
        if let Ok(mut current) = self.index.write() {
            current.insert(ws.clone(), parsed);
        }
        // Persist the backfilled counts once (raw file write, no R2 enqueue) so
        // subsequent boots skip the re-derive. Best-effort — a failure just
        // means we re-derive next boot.
        if backfilled {
            if let Err(e) = self.write_workspace_index_file(ws) {
                log::warn!("JP-349 index backfill persist failed for {}: {}", ws.as_str(), e);
            }
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
        write_atomic(&self.index_path(ws), json.as_bytes())
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

    // ── Collection definitions registry (`collections.json`) ──────────────────

    /// Path to a workspace's collection-definitions file.
    fn collections_path(&self, ws: &WorkspaceId) -> PathBuf {
        self.workspace_root(ws).join("collections.json")
    }

    /// Load a single workspace's collection definitions from disk into memory.
    /// No-op (leaves the in-memory entry untouched) if the file is missing or
    /// unparseable — collections are client-authoritative and re-pushed on change.
    fn load_workspace_collections(&self, ws: &WorkspaceId) {
        let path = self.collections_path(ws);
        let Ok(data) = std::fs::read_to_string(&path) else { return };
        let Some(registry) = parse_collections_file(&data) else {
            log::warn!("collections for workspace {} are malformed — leaving empty", ws.as_str());
            return;
        };
        if let Ok(mut current) = self.collections.write() {
            current.insert(ws.clone(), registry);
        }
    }

    /// Snapshot the in-memory registry for a workspace and write it to disk in
    /// the version-wrapper shape. A wholesale replace (the client PUTs the full
    /// set), so unlike the index there's no per-entry merge race; the
    /// `index_write_lock` still serializes concurrent file writes for this
    /// workspace's sidecars.
    fn write_workspace_collections_file(&self, ws: &WorkspaceId) -> Result<(), String> {
        let _guard = self
            .index_write_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let snapshot = {
            let collections = self.collections.read().map_err(|e| e.to_string())?;
            collections.get(ws).cloned().unwrap_or_default()
        };
        let file = CollectionsFile { version: snapshot.version, collections: snapshot.defs };
        let json = serde_json::to_string_pretty(&file)
            .map_err(|e| format!("Serialize error: {}", e))?;
        let _ = std::fs::create_dir_all(self.workspace_root(ws));
        write_atomic(&self.collections_path(ws), json.as_bytes())
            .map_err(|e| format!("Write error: {}", e))?;
        Ok(())
    }

    /// Read a workspace's `collections.json` bytes off the local volume for the
    /// mirror worker. `None` if absent/unreadable.
    pub fn read_workspace_collections_bytes(&self, ws: &WorkspaceId) -> Option<Vec<u8>> {
        std::fs::read(self.collections_path(ws)).ok()
    }

    /// List a workspace's collection definitions (sorted by `order`).
    pub fn list_collections(&self, ws: &WorkspaceId) -> Vec<CollectionDef> {
        self.collections_snapshot(ws).0
    }

    /// A workspace's definitions (sorted by `order`) plus the registry version,
    /// for the GET handler's optimistic-concurrency handshake (JP-424).
    pub fn collections_snapshot(&self, ws: &WorkspaceId) -> (Vec<CollectionDef>, u64) {
        let registry = self
            .collections
            .read()
            .ok()
            .and_then(|c| c.get(ws).cloned())
            .unwrap_or_default();
        let mut defs = registry.defs;
        defs.sort_by_key(|c| c.order);
        (defs, registry.version)
    }

    /// Whether a workspace's registry has been loaded or probed (key presence —
    /// an empty entry counts). Gates the cold-start R2 restore so an emptied
    /// registry isn't re-fetched from a stale mirror (JP-424).
    pub fn has_workspace_collections_loaded(&self, ws: &WorkspaceId) -> bool {
        self.collections.read().ok().is_some_and(|c| c.contains_key(ws))
    }

    /// Ensure a workspace has an in-memory registry entry (default empty, v0).
    /// Called once the cold-start restore attempt has run — hit or miss — so
    /// repeated reads don't re-probe R2.
    pub fn memoize_collections_probe(&self, ws: &WorkspaceId) {
        if let Ok(mut current) = self.collections.write() {
            current.entry(ws.clone()).or_default();
        }
    }

    /// Replace a workspace's collection definitions wholesale (the editor owns
    /// the set and PUTs it whole). When `expected` is `Some`, the write only
    /// lands if it matches the current registry version (optimistic concurrency,
    /// JP-424) — a mismatch returns the current state for the client to rebase
    /// onto. `None` preserves the legacy blind write. Every accepted write bumps
    /// the version, persists locally, and mirrors to R2.
    pub fn set_collections(
        &self,
        ws: &WorkspaceId,
        defs: Vec<CollectionDef>,
        expected: Option<u64>,
    ) -> Result<SetCollectionsOutcome, String> {
        let version = {
            let mut current = self.collections.write().map_err(|e| e.to_string())?;
            let entry = current.entry(ws.clone()).or_default();
            if let Some(expected) = expected {
                if expected != entry.version {
                    let mut defs = entry.defs.clone();
                    defs.sort_by_key(|c| c.order);
                    return Ok(SetCollectionsOutcome::VersionConflict {
                        current_version: entry.version,
                        current: defs,
                    });
                }
            }
            entry.version += 1;
            entry.defs = defs;
            entry.version
        };
        self.write_workspace_collections_file(ws)?;
        self.enqueue_mirror(MirrorOp::PutCollections { ws: ws.clone() });
        Ok(SetCollectionsOutcome::Updated { version })
    }

    /// Restore a workspace's collection definitions from R2 on a cold machine
    /// (best-effort), paralleling `restore_workspace_index_from`.
    pub async fn restore_workspace_collections_from<S: DocObjectStore>(
        &self,
        store: &S,
        ws: &WorkspaceId,
    ) {
        match store.get_workspace_collections(ws).await {
            Ok(Some(bytes)) => {
                let _ = std::fs::create_dir_all(self.workspace_root(ws));
                if write_atomic(&self.collections_path(ws), &bytes).is_ok() {
                    self.load_workspace_collections(ws);
                    log::info!("restored collections for workspace {} from R2", ws.as_str());
                }
            }
            Ok(None) => {}
            Err(e) => log::warn!("restore: R2 get collections {}: {}", ws.as_str(), e),
        }
    }

    // ── Deleted-doc tombstones (`deleted-ids.json`, JP-375) ────────────────────

    /// Path to a workspace's tombstone registry file.
    fn deleted_ids_path(&self, ws: &WorkspaceId) -> PathBuf {
        self.workspace_root(ws).join("deleted-ids.json")
    }

    /// Load a workspace's tombstone registry from disk into memory, pruning any
    /// records that have aged past the TTL. No-op (leaves the in-memory entry
    /// untouched) if the file is missing or unparseable.
    fn load_workspace_deleted_ids(&self, ws: &WorkspaceId) {
        let path = self.deleted_ids_path(ws);
        let Ok(data) = std::fs::read_to_string(&path) else { return };
        let Ok(mut parsed) =
            serde_json::from_str::<std::collections::BTreeMap<String, DeletedRecord>>(&data)
        else {
            log::warn!("deleted-ids for workspace {} are malformed — leaving empty", ws.as_str());
            return;
        };
        let pruned = prune_deleted_records(&mut parsed, now_ms(), self.tombstone_ttl_ms);
        if let Ok(mut current) = self.deleted_ids.write() {
            current.insert(ws.clone(), parsed);
        }
        // Persist back if the load-time prune removed anything (raw write, no
        // mirror — boot housekeeping).
        if pruned {
            if let Err(e) = self.write_deleted_ids_file(ws) {
                log::warn!("JP-375 tombstone prune persist failed for {}: {}", ws.as_str(), e);
            }
        }
    }

    /// Read a workspace's `deleted-ids.json` bytes off the local volume for the
    /// mirror worker. `None` if absent/unreadable.
    pub fn read_workspace_deleted_ids_bytes(&self, ws: &WorkspaceId) -> Option<Vec<u8>> {
        std::fs::read(self.deleted_ids_path(ws)).ok()
    }

    /// Snapshot the in-memory tombstones for a workspace and write them to disk
    /// (raw, no mirror enqueue). Serialized with the other sidecar writes.
    fn write_deleted_ids_file(&self, ws: &WorkspaceId) -> Result<(), String> {
        let _guard = self
            .index_write_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let snapshot = {
            let map = self.deleted_ids.read().map_err(|e| e.to_string())?;
            map.get(ws).cloned().unwrap_or_default()
        };
        let json = serde_json::to_string_pretty(&snapshot)
            .map_err(|e| format!("Serialize error: {}", e))?;
        let _ = std::fs::create_dir_all(self.workspace_root(ws));
        write_atomic(&self.deleted_ids_path(ws), json.as_bytes())
            .map_err(|e| format!("Write error: {}", e))?;
        Ok(())
    }

    /// Persist a workspace's tombstones locally and mirror to R2 (JP-375).
    fn save_deleted_ids(&self, ws: &WorkspaceId) -> Result<(), String> {
        self.write_deleted_ids_file(ws)?;
        self.enqueue_mirror(MirrorOp::PutDeleted { ws: ws.clone() });
        Ok(())
    }

    /// Whether a document id is tombstoned in this workspace (JP-375). Stale
    /// records past the TTL are treated as absent (the load-time prune reclaims
    /// them lazily).
    pub fn is_deleted(&self, ws: &WorkspaceId, doc_id: &DocId) -> bool {
        let now = now_ms();
        self.deleted_ids
            .read()
            .ok()
            .and_then(|m| {
                m.get(ws)
                    .and_then(|t| t.get(doc_id.as_str()))
                    .map(|rec| now.saturating_sub(rec.deleted_at_ms) < self.tombstone_ttl_ms)
            })
            .unwrap_or(false)
    }

    /// Tombstone a document id (JP-375), recording the version + owner it
    /// carried. Called from `delete_document`; persists + mirrors. Best-effort —
    /// a failure to persist is logged, never fatal to the delete.
    fn tombstone(
        &self,
        ws: &WorkspaceId,
        doc_id: &DocId,
        last_server_version: u64,
        owner_id: Option<String>,
    ) {
        {
            let mut map = match self.deleted_ids.write() {
                Ok(m) => m,
                Err(_) => return,
            };
            map.entry(ws.clone()).or_default().insert(
                doc_id.as_str().to_string(),
                DeletedRecord { deleted_at_ms: now_ms(), last_server_version, owner_id },
            );
        }
        if let Err(e) = self.save_deleted_ids(ws) {
            log::warn!("JP-375 tombstone persist failed for {}/{}: {}", ws.as_str(), doc_id.as_str(), e);
        }
    }

    /// The recorded owner of a tombstoned id, if any (JP-375). `None` when the id
    /// isn't tombstoned or had no owner. Used to authorize the resurrection
    /// override, since the doc's live metadata is already gone.
    pub fn tombstone_owner(&self, ws: &WorkspaceId, doc_id: &DocId) -> Option<String> {
        self.deleted_ids
            .read()
            .ok()
            .and_then(|m| m.get(ws).and_then(|t| t.get(doc_id.as_str())).and_then(|r| r.owner_id.clone()))
    }

    /// Clear a document id's tombstone (JP-375) — the deliberate,
    /// permission-gated override that lets an explicit human re-create a deleted
    /// doc. Persists + mirrors. Returns whether a record was present.
    pub fn clear_tombstone(&self, ws: &WorkspaceId, doc_id: &DocId) -> bool {
        let removed = {
            let mut map = match self.deleted_ids.write() {
                Ok(m) => m,
                Err(_) => return false,
            };
            map.get_mut(ws).map(|t| t.remove(doc_id.as_str()).is_some()).unwrap_or(false)
        };
        if removed {
            if let Err(e) = self.save_deleted_ids(ws) {
                log::warn!(
                    "JP-375 tombstone clear persist failed for {}/{}: {}",
                    ws.as_str(),
                    doc_id.as_str(),
                    e
                );
            }
        }
        removed
    }

    /// Restore a workspace's tombstone registry from R2 on a cold machine
    /// (best-effort), paralleling `restore_workspace_index_from`. Pruned on load.
    pub async fn restore_workspace_deleted_ids_from<S: DocObjectStore>(
        &self,
        store: &S,
        ws: &WorkspaceId,
    ) {
        match store.get_workspace_deleted_ids(ws).await {
            Ok(Some(bytes)) => {
                let _ = std::fs::create_dir_all(self.workspace_root(ws));
                if write_atomic(&self.deleted_ids_path(ws), &bytes).is_ok() {
                    self.load_workspace_deleted_ids(ws);
                    log::info!("restored tombstones for workspace {} from R2", ws.as_str());
                }
            }
            Ok(None) => {}
            Err(e) => log::warn!("restore: R2 get deleted-ids {}: {}", ws.as_str(), e),
        }
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
        match self.save_document_with_expected_version(ws, doc, None, None)? {
            SaveOutcome::Created { .. } | SaveOutcome::Updated { .. } => Ok(()),
            // `expected = None` cannot produce a conflict — collapse to
            // a string error to preserve the existing signature.
            SaveOutcome::VersionConflict { current } => Err(format!(
                "unexpected version conflict (current={})",
                current
            )),
            // This non-versioned helper is used for internal writes to existing
            // docs (locks, shares); a tombstoned id here is a logic error.
            SaveOutcome::Tombstoned => Err("document is tombstoned (deleted)".to_string()),
            // `gate = None` cannot produce storage outcomes (JP-443).
            SaveOutcome::QuotaExceeded { .. } | SaveOutcome::DocTooLarge { .. } => {
                Err("unexpected storage-gate outcome on ungated save".to_string())
            }
        }
    }

    /// Save without a version expectation but **with** the JP-443 storage gate
    /// — the create/last-writer-wins twin of
    /// [`Self::save_document_with_expected_version`] for callers (MCP create)
    /// that need quota/size enforcement and the full [`SaveOutcome`].
    pub fn save_document_gated(
        &self,
        ws: &WorkspaceId,
        doc: serde_json::Value,
        gate: &DocSaveGate,
    ) -> Result<SaveOutcome, String> {
        self.save_document_with_expected_version(ws, doc, None, Some(gate))
    }

    /// Build [`DocumentMetadata`] from a document body at a given server
    /// version. Shared by the save / snapshot / restore write paths so the
    /// derived index fields can't drift between them (JP-200 de-dup).
    /// Count a document body's two independent page collections (JP-349):
    /// canvas pages (top-level `pageOrder`) and prose pages
    /// (`richTextPages.pageOrder`). Either is 0 when its array is absent. The
    /// single derivation shared by `metadata_from_body` and the local-mirror
    /// extractor so the two can't drift.
    pub(crate) fn page_counts_of(doc: &serde_json::Value) -> (usize, usize) {
        let canvas = doc
            .get("pageOrder")
            .and_then(|v| v.as_array())
            .map(|arr| arr.len())
            .unwrap_or(0);
        let prose = doc
            .get("richTextPages")
            .and_then(|rtp| rtp.get("pageOrder"))
            .and_then(|v| v.as_array())
            .map(|arr| arr.len())
            .unwrap_or(0);
        (canvas, prose)
    }

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
        let (canvas, prose) = Self::page_counts_of(doc);
        DocumentMetadata {
            id: doc_id,
            name: doc.get("name").and_then(|v| v.as_str()).unwrap_or("Untitled").to_string(),
            // Combined total, floored to 1 so a doc never reports 0 pages (the
            // historical canvas-only `unwrap_or(1)` floor, now applied to the
            // total). JP-349.
            page_count: (canvas + prose).max(1),
            prose_page_count: Some(prose),
            // Set by the write seams (save / snapshot / restore) that hold the
            // serialized bytes; this body-only derivation has none (JP-443).
            size_bytes: None,
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
            collection_id: doc.get("collectionId").and_then(|v| v.as_str()).map(String::from),
            // Non-string members are dropped, an empty list lifts as `None`
            // (keeps the index lean; absent ≡ untagged).
            tags: doc
                .get("tags")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|t| t.as_str())
                        .map(String::from)
                        .collect::<Vec<_>>()
                })
                .filter(|v| !v.is_empty()),
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
        gate: Option<&DocSaveGate>,
    ) -> Result<SaveOutcome, String> {
        let id_str = doc.get("id")
            .and_then(|v| v.as_str())
            .ok_or("Document missing 'id' field")?
            .to_string();
        let doc_id = DocId::from_body_id(id_str.clone())
            .map_err(|e| format!("Invalid document id: {}", e))?;
        let id = id_str;

        // JP-375: refuse to resurrect a tombstoned id. A blind re-create (a
        // returning offline editor's transfer, a stale PUT) would undo a delete
        // or a restore and re-introduce the old state. The deliberate override
        // path (`clear_tombstone`, Owner-gated) lifts the tombstone first.
        if self.is_deleted(ws, &doc_id) {
            return Ok(SaveOutcome::Tombstoned);
        }

        // Read current stored version (if any) for the concurrency check, plus
        // the storage-gate inputs (this doc's recorded size + the workspace
        // doc-bytes sum) in the same lock hold so they're mutually consistent.
        // Holding the read lock briefly is fine; the rest of the save runs
        // outside the lock.
        let (prior_version, doc_existed, old_size, ws_doc_bytes) = {
            let index = self.index.read().map_err(|e| e.to_string())?;
            let ws_map = index.get(ws);
            let ws_doc_bytes: u64 = ws_map
                .map(|m| m.values().map(|meta| meta.size_bytes.unwrap_or(0)).sum())
                .unwrap_or(0);
            match ws_map.and_then(|m| m.get(&id)) {
                // `old_size = None` means the entry predates size recording and
                // its body isn't locally stat-able (evicted) — see the lenient
                // branch in the gate below.
                Some(meta) => (meta.server_version.unwrap_or(0), true, meta.size_bytes, ws_doc_bytes),
                None => (0, false, Some(0), ws_doc_bytes),
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

        let mut metadata = Self::metadata_from_body(&doc, doc_id.clone(), new_version);

        let doc_json = serde_json::to_string_pretty(&doc)
            .map_err(|e| format!("Serialize error: {}", e))?;
        let new_size = doc_json.len() as u64;
        metadata.size_bytes = Some(new_size);

        // JP-443 storage gate — runs before any byte hits the disk.
        if let Some(gate) = gate {
            if let Some(max) = gate.max_doc_bytes {
                if max > 0 && new_size > max {
                    return Ok(SaveOutcome::DocTooLarge { size: new_size, max });
                }
            }
            if let Some(quota) = gate.quota_bytes {
                match old_size {
                    // Refuse only a GROWING save that lands over quota. A
                    // shrinking or equal-size save always passes — deleting
                    // content is how a caller digs out of an over-quota state.
                    Some(old) if new_size > old => {
                        let used = gate.blob_bytes.saturating_add(ws_doc_bytes);
                        let projected = used.saturating_sub(old).saturating_add(new_size);
                        if projected > quota {
                            return Ok(SaveOutcome::QuotaExceeded {
                                used,
                                quota,
                                incoming: new_size,
                            });
                        }
                    }
                    Some(_) => {}
                    // Legacy entry with unknown recorded size: skip the quota
                    // check for this one save (the projection would over-charge
                    // by the full new size and could refuse a non-growing
                    // edit). The save records the true size, so the next one
                    // is gated normally — a false lockout is worse than one
                    // lenient write.
                    None => {}
                }
            }
        }

        // Ensure the per-workspace docs dir exists (first-touch for a
        // new tenant on shared-mode Cloud).
        let _ = std::fs::create_dir_all(self.workspace_root(ws).join("docs"));
        write_atomic(&self.doc_path(ws, &doc_id), doc_json.as_bytes())
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
    /// snapshots docs it hydrated from an existing body). On success returns the
    /// serialized byte size that was written, so the caller can observe
    /// per-document size overages (JP-443) — the snapshot itself is **never**
    /// gated: refusing a CRDT flush would drop already-merged edits.
    pub fn persist_snapshot(&self, ws: &WorkspaceId, mut doc: serde_json::Value) -> Result<u64, String> {
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

        let mut metadata = Self::metadata_from_body(&doc, doc_id.clone(), version);

        let doc_json = serde_json::to_string_pretty(&doc).map_err(|e| format!("Serialize error: {}", e))?;
        let written_size = doc_json.len() as u64;
        metadata.size_bytes = Some(written_size);
        let _ = std::fs::create_dir_all(self.workspace_root(ws).join("docs"));
        write_atomic(&self.doc_path(ws, &doc_id), doc_json.as_bytes())
            .map_err(|e| format!("Write error: {}", e))?;

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
        Ok(written_size)
    }

    /// Delete a document scoped to the requesting workspace. Returns
    /// `Ok(false)` if the doc isn't in this workspace's index — even
    /// when another workspace holds a doc with the same id.
    pub fn delete_document(&self, ws: &WorkspaceId, doc_id: &DocId) -> Result<bool, String> {
        // Check if document exists in this workspace, and capture its version +
        // owner for the tombstone record.
        let (last_server_version, owner_id) = {
            let index = self.index.read().map_err(|e| e.to_string())?;
            match index.get(ws).and_then(|m| m.get(doc_id.as_str())) {
                Some(meta) => (meta.server_version.unwrap_or(0), meta.owner_id.clone()),
                None => return Ok(false),
            }
        };

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

        // JP-375: record the tombstone so the id can't be silently resurrected
        // by a stale offline rejoin or a blind re-create.
        self.tombstone(ws, doc_id, last_server_version, owner_id);

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

    /// Drop a single user's share grant (`sharedWith`) from every document in a
    /// workspace. For each document that currently shares with `user_id`, the
    /// entry is removed and the remaining grants are kept verbatim — including
    /// their original `sharedAt` (unlike [`update_document_shares`], which
    /// rebuilds the whole list with a fresh timestamp). Documents the user was
    /// never shared on are left untouched (no version bump, no R2 write).
    /// Ownership (`owner_id`) is never affected. Returns the ids of the
    /// documents actually modified.
    pub fn purge_user_from_workspace_shares(
        &self,
        ws: &WorkspaceId,
        user_id: &str,
    ) -> Result<Vec<DocId>, String> {
        // Narrow to candidates using the in-memory index: only documents whose
        // metadata already lists this user are worth loading from disk.
        let candidates: Vec<DocId> = self
            .list_documents(ws)
            .into_iter()
            .filter(|m| {
                m.shared_with
                    .as_ref()
                    .map(|s| s.iter().any(|e| e.user_id == user_id))
                    .unwrap_or(false)
            })
            .map(|m| m.id)
            .collect();

        let mut purged = Vec::new();
        for doc_id in candidates {
            let mut doc = match self.get_document(ws, &doc_id) {
                Ok(d) => d,
                Err(e) => {
                    log::warn!(
                        "purge-member: skip {}/{}: {}",
                        ws.as_str(),
                        doc_id.as_str(),
                        e
                    );
                    continue;
                }
            };

            // Re-read the body's shares (authoritative over the index snapshot)
            // and drop the target user, keeping every other grant verbatim.
            let existing: Vec<DocumentShare> = doc
                .get("sharedWith")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default();
            let before = existing.len();
            let kept: Vec<DocumentShare> = existing
                .into_iter()
                .filter(|e| e.user_id != user_id)
                .collect();
            // Index said this doc shared with the user but the body disagrees
            // (stale index) — nothing to write, skip to avoid a needless bump.
            if kept.len() == before {
                continue;
            }

            doc["sharedWith"] = serde_json::to_value(&kept)
                .map_err(|e| format!("Failed to serialize shares: {}", e))?;
            self.save_document(ws, doc)?;
            log::info!(
                "purge-member: dropped a share grant from {}/{} ({} grants remain)",
                ws.as_str(),
                doc_id.as_str(),
                kept.len()
            );
            purged.push(doc_id);
        }

        Ok(purged)
    }

    /// Set (or clear, with `None`) a document's collection membership. A document
    /// belongs to at most one collection; passing a new id reassigns it, `None`
    /// unassigns it. Writes `collectionId` onto the body and saves through the
    /// normal path, so `metadata_from_body` lifts it into the index and the save
    /// mirrors body + index to R2 — no separate membership store. Mirrors
    /// `update_document_shares` (metadata-shaped mutation of the body).
    pub fn update_document_collection(
        &self,
        ws: &WorkspaceId,
        doc_id: &DocId,
        collection_id: Option<&str>,
    ) -> Result<(), String> {
        let mut doc = self.get_document(ws, doc_id)?;
        match collection_id {
            Some(cid) => doc["collectionId"] = serde_json::json!(cid),
            None => {
                if let Some(obj) = doc.as_object_mut() {
                    obj.remove("collectionId");
                }
            }
        }
        self.save_document(ws, doc)
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
    fn collection_def_serializes_camelcase() {
        // Contract guard (JP-159): the wire shape docushark-web + the editor's
        // RelayCollectionDef mirror. camelCase keys, color omitted when None.
        let def = CollectionDef {
            id: "c1".into(),
            name: "Alpha".into(),
            color: Some("#fff".into()),
            order: 2,
        };
        let v = serde_json::to_value(&def).unwrap();
        let obj = v.as_object().unwrap();
        assert_eq!(
            obj.keys().cloned().collect::<std::collections::BTreeSet<_>>(),
            ["color", "id", "name", "order"].iter().map(|s| s.to_string()).collect(),
        );
        assert!(obj.keys().all(|k| !k.contains('_')), "no snake_case leakage");

        let no_color = CollectionDef { id: "c2".into(), name: "B".into(), color: None, order: 0 };
        let v2 = serde_json::to_value(&no_color).unwrap();
        assert!(v2.get("color").is_none(), "color omitted when None");
    }

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
    fn collection_membership_set_and_clear() {
        let dir = tempdir().unwrap();
        let store = DocumentStore::new(dir.path().to_path_buf());
        let ws = WorkspaceId::single_tenant();
        let doc_id = DocId::from_http_path("c-doc".to_string()).unwrap();

        store
            .save_document(
                &ws,
                serde_json::json!({ "id": "c-doc", "name": "C", "pageOrder": ["p"] }),
            )
            .unwrap();

        // Unassigned by default.
        assert_eq!(store.get_metadata(&ws, &doc_id).unwrap().collection_id, None);

        // Assign → surfaces in metadata + on the body.
        store
            .update_document_collection(&ws, &doc_id, Some("coll-1"))
            .unwrap();
        assert_eq!(
            store.get_metadata(&ws, &doc_id).unwrap().collection_id.as_deref(),
            Some("coll-1")
        );
        assert_eq!(store.get_document(&ws, &doc_id).unwrap()["collectionId"], "coll-1");

        // Reassign to a different collection.
        store
            .update_document_collection(&ws, &doc_id, Some("coll-2"))
            .unwrap();
        assert_eq!(
            store.get_metadata(&ws, &doc_id).unwrap().collection_id.as_deref(),
            Some("coll-2")
        );

        // Clear → unassigned again, body key removed.
        store.update_document_collection(&ws, &doc_id, None).unwrap();
        assert_eq!(store.get_metadata(&ws, &doc_id).unwrap().collection_id, None);
        assert!(store.get_document(&ws, &doc_id).unwrap().get("collectionId").is_none());
    }

    #[test]
    fn tags_lift_into_metadata() {
        let dir = tempdir().unwrap();
        let store = DocumentStore::new(dir.path().to_path_buf());
        let ws = WorkspaceId::single_tenant();

        // Tagged body → lifted (non-string members dropped).
        let tagged = DocId::from_http_path("t-doc".to_string()).unwrap();
        store
            .save_document(
                &ws,
                serde_json::json!({
                    "id": "t-doc", "name": "T", "pageOrder": ["p"],
                    "tags": ["alpha", 7, "beta"]
                }),
            )
            .unwrap();
        assert_eq!(
            store.get_metadata(&ws, &tagged).unwrap().tags,
            Some(vec!["alpha".to_string(), "beta".to_string()])
        );

        // No tags key → None.
        let untagged = DocId::from_http_path("u-doc".to_string()).unwrap();
        store
            .save_document(
                &ws,
                serde_json::json!({ "id": "u-doc", "name": "U", "pageOrder": ["p"] }),
            )
            .unwrap();
        assert_eq!(store.get_metadata(&ws, &untagged).unwrap().tags, None);

        // Explicit empty list lifts as None (index stays lean).
        let cleared = DocId::from_http_path("e-doc".to_string()).unwrap();
        store
            .save_document(
                &ws,
                serde_json::json!({ "id": "e-doc", "name": "E", "pageOrder": ["p"], "tags": [] }),
            )
            .unwrap();
        assert_eq!(store.get_metadata(&ws, &cleared).unwrap().tags, None);
    }

    #[test]
    fn collections_registry_round_trips_and_sorts() {
        let dir = tempdir().unwrap();
        let ws = WorkspaceId::single_tenant();
        let defs = vec![
            CollectionDef { id: "b".into(), name: "Beta".into(), color: None, order: 1 },
            CollectionDef {
                id: "a".into(),
                name: "Alpha".into(),
                color: Some("#ef4444".into()),
                order: 0,
            },
        ];
        {
            let store = DocumentStore::new(dir.path().to_path_buf());
            assert!(store.list_collections(&ws).is_empty());
            let outcome = store.set_collections(&ws, defs.clone(), None).unwrap();
            assert!(matches!(outcome, SetCollectionsOutcome::Updated { version: 1 }));
            // Sorted by order.
            let listed = store.list_collections(&ws);
            assert_eq!(listed.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), ["a", "b"]);
            assert_eq!(listed[0].color.as_deref(), Some("#ef4444"));
        }
        // A fresh store over the same dir preloads the persisted registry —
        // including the version (the wrapper file shape round-trips).
        let reloaded = DocumentStore::new(dir.path().to_path_buf());
        let (listed, version) = reloaded.collections_snapshot(&ws);
        assert_eq!(listed.len(), 2);
        assert_eq!(version, 1);

        // Wholesale replace bumps again.
        let outcome = reloaded
            .set_collections(
                &ws,
                vec![CollectionDef { id: "c".into(), name: "C".into(), color: None, order: 0 }],
                None,
            )
            .unwrap();
        assert!(matches!(outcome, SetCollectionsOutcome::Updated { version: 2 }));
        assert_eq!(
            reloaded.list_collections(&ws).iter().map(|c| c.id.clone()).collect::<Vec<_>>(),
            ["c"]
        );
    }

    #[test]
    fn collections_legacy_bare_array_loads_as_v0_and_upgrades_on_write() {
        let dir = tempdir().unwrap();
        let ws = WorkspaceId::single_tenant();
        // Pre-JP-424 file: a bare CollectionDef array.
        {
            let store = DocumentStore::new(dir.path().to_path_buf());
            let path = store.collections_path(&ws);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, br#"[{"id":"x","name":"X","order":0}]"#).unwrap();
        }
        let store = DocumentStore::new(dir.path().to_path_buf());
        let (defs, version) = store.collections_snapshot(&ws);
        assert_eq!(defs.len(), 1);
        assert_eq!(version, 0, "legacy bare array reads as version 0");

        // First accepted write (conditional on the legacy version) upgrades the
        // file to the wrapper shape.
        let outcome = store
            .set_collections(
                &ws,
                vec![CollectionDef { id: "x".into(), name: "X2".into(), color: None, order: 0 }],
                Some(0),
            )
            .unwrap();
        assert!(matches!(outcome, SetCollectionsOutcome::Updated { version: 1 }));
        let raw = std::fs::read_to_string(store.collections_path(&ws)).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed["version"], 1, "file rewritten in wrapper form");
        assert_eq!(parsed["collections"][0]["name"], "X2");
    }

    #[test]
    fn collections_expected_version_gates_the_write() {
        let dir = tempdir().unwrap();
        let store = DocumentStore::new(dir.path().to_path_buf());
        let ws = WorkspaceId::single_tenant();
        let def = |id: &str, order: i64| CollectionDef {
            id: id.into(),
            name: id.to_uppercase(),
            color: None,
            order,
        };
        store.set_collections(&ws, vec![def("a", 0)], None).unwrap(); // v1

        // Stale expectation ⇒ conflict, nothing written.
        let outcome = store.set_collections(&ws, vec![def("b", 0)], Some(0)).unwrap();
        match outcome {
            SetCollectionsOutcome::VersionConflict { current_version, current } => {
                assert_eq!(current_version, 1);
                assert_eq!(current.len(), 1);
                assert_eq!(current[0].id, "a");
            }
            other => panic!("expected conflict, got {:?}", other),
        }
        assert_eq!(store.list_collections(&ws)[0].id, "a", "conflicting write must not land");

        // Matching expectation ⇒ accepted.
        let outcome = store.set_collections(&ws, vec![def("b", 0)], Some(1)).unwrap();
        assert!(matches!(outcome, SetCollectionsOutcome::Updated { version: 2 }));

        // Blind write (legacy client) still lands and bumps.
        let outcome = store.set_collections(&ws, vec![def("c", 0)], None).unwrap();
        assert!(matches!(outcome, SetCollectionsOutcome::Updated { version: 3 }));
    }

    #[test]
    fn collections_presence_guard_and_probe_memoization() {
        let dir = tempdir().unwrap();
        let store = DocumentStore::new(dir.path().to_path_buf());
        let ws = WorkspaceId::single_tenant();
        // Never touched: not loaded (the ensure path would probe R2 once).
        assert!(!store.has_workspace_collections_loaded(&ws));
        store.memoize_collections_probe(&ws);
        assert!(store.has_workspace_collections_loaded(&ws));
        assert!(store.list_collections(&ws).is_empty());
        // A memoized empty entry is presence — an emptied registry must not be
        // treated as "cold" again (stale-mirror resurrection guard).
        assert_eq!(store.collections_snapshot(&ws).1, 0);
    }

    #[test]
    fn sanitize_collection_defs_dedupes_and_rejects() {
        let def = |id: &str, name: &str| CollectionDef {
            id: id.into(),
            name: name.into(),
            color: None,
            order: 0,
        };
        // Duplicate ids: keep-first heal, not an error.
        let out =
            sanitize_collection_defs(vec![def("a", "First"), def("a", "Second"), def("b", "B")])
                .unwrap();
        assert_eq!(out.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["First", "B"]);

        // Structural violations reject.
        assert!(sanitize_collection_defs(vec![def("", "X")]).is_err());
        assert!(sanitize_collection_defs(vec![def("a", "   ")]).is_err());
        assert!(sanitize_collection_defs(vec![def("a", &"n".repeat(121))]).is_err());
        assert!(sanitize_collection_defs(vec![def(&"i".repeat(65), "X")]).is_err());
        let mut oversized_color = def("a", "X");
        oversized_color.color = Some("c".repeat(33));
        assert!(sanitize_collection_defs(vec![oversized_color]).is_err());
        let too_many: Vec<_> =
            (0..=MAX_COLLECTIONS_PER_WORKSPACE).map(|i| def(&format!("c{}", i), "N")).collect();
        assert!(sanitize_collection_defs(too_many).is_err());

        // At the cap is fine.
        let at_cap: Vec<_> =
            (0..MAX_COLLECTIONS_PER_WORKSPACE).map(|i| def(&format!("c{}", i), "N")).collect();
        assert_eq!(sanitize_collection_defs(at_cap).unwrap().len(), MAX_COLLECTIONS_PER_WORKSPACE);
    }

    #[test]
    fn write_atomic_lands_content_and_leaves_no_temp_residue() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("out.json");
        write_atomic(&path, b"first").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"first");
        // Overwrite via rename-over-existing.
        write_atomic(&path, b"second").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"second");
        // No stray temp files.
        let residue: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp-"))
            .collect();
        assert!(residue.is_empty(), "temp files must be renamed or removed");
    }

    #[test]
    fn prune_deleted_records_drops_only_aged() {
        let mut map = std::collections::BTreeMap::new();
        map.insert(
            "fresh".to_string(),
            DeletedRecord { deleted_at_ms: 9_000, last_server_version: 1, owner_id: None },
        );
        map.insert(
            "old".to_string(),
            DeletedRecord { deleted_at_ms: 1_000, last_server_version: 1, owner_id: None },
        );
        // now=10_000, ttl=5_000 ⇒ "old" (age 9_000) pruned, "fresh" (age 1_000) kept.
        let removed = prune_deleted_records(&mut map, 10_000, 5_000);
        assert!(removed);
        assert!(map.contains_key("fresh"));
        assert!(!map.contains_key("old"));
    }

    #[test]
    fn tombstone_blocks_resave_and_override_clears_it() {
        let dir = tempdir().unwrap();
        let store = DocumentStore::new(dir.path().to_path_buf());
        let ws = WorkspaceId::single_tenant();
        let doc_id = DocId::from_http_path("t-doc".to_string()).unwrap();

        store
            .save_document(&ws, serde_json::json!({ "id": "t-doc", "name": "T", "ownerId": "u1" }))
            .unwrap();
        assert!(!store.is_deleted(&ws, &doc_id));

        // Delete → tombstoned (owner recorded for the override gate).
        assert!(store.delete_document(&ws, &doc_id).unwrap());
        assert!(store.is_deleted(&ws, &doc_id));
        assert_eq!(store.tombstone_owner(&ws, &doc_id).as_deref(), Some("u1"));

        // A blind re-create is refused (resurrection guard).
        let outcome = store
            .save_document_with_expected_version(
                &ws,
                serde_json::json!({ "id": "t-doc", "name": "T again" }),
                None,
                None,
            )
            .unwrap();
        assert_eq!(outcome, SaveOutcome::Tombstoned);

        // Deliberate override: clear the tombstone, then the save creates it anew.
        assert!(store.clear_tombstone(&ws, &doc_id));
        assert!(!store.is_deleted(&ws, &doc_id));
        let outcome = store
            .save_document_with_expected_version(
                &ws,
                serde_json::json!({ "id": "t-doc", "name": "T restored" }),
                None,
                None,
            )
            .unwrap();
        assert!(matches!(outcome, SaveOutcome::Created { .. }));
    }

    #[test]
    fn tombstone_persists_across_store_reload() {
        let dir = tempdir().unwrap();
        let ws = WorkspaceId::single_tenant();
        let doc_id = DocId::from_http_path("p-doc".to_string()).unwrap();
        {
            let store = DocumentStore::new(dir.path().to_path_buf());
            store
                .save_document(&ws, serde_json::json!({ "id": "p-doc", "name": "P" }))
                .unwrap();
            store.delete_document(&ws, &doc_id).unwrap();
            assert!(store.is_deleted(&ws, &doc_id));
        }
        // A fresh store over the same dir preloads the persisted tombstones.
        let reloaded = DocumentStore::new(dir.path().to_path_buf());
        assert!(reloaded.is_deleted(&ws, &doc_id));
    }

    #[tokio::test]
    async fn restore_tombstones_from_object_store() {
        let dir = tempdir().unwrap();
        let store = DocumentStore::new(dir.path().to_path_buf());
        let ws = WorkspaceId::single_tenant();
        let doc_id = DocId::from_http_path("r-doc".to_string()).unwrap();
        assert!(!store.is_deleted(&ws, &doc_id));

        // A cold machine restores the tombstone registry from R2 and honours it.
        let fake = FakeObjectStore {
            deleted_ids: Some(
                br#"{"r-doc":{"deletedAtMs":9999999999999,"lastServerVersion":3}}"#.to_vec(),
            ),
            ..Default::default()
        };
        store.restore_workspace_deleted_ids_from(&fake, &ws).await;
        assert!(store.is_deleted(&ws, &doc_id));
    }

    #[tokio::test]
    async fn restore_collections_from_object_store() {
        let dir = tempdir().unwrap();
        let store = DocumentStore::new(dir.path().to_path_buf());
        let ws = WorkspaceId::single_tenant();
        assert!(store.list_collections(&ws).is_empty());

        let fake = FakeObjectStore {
            collections: Some(
                br#"[{"id":"x","name":"X","order":0}]"#.to_vec(),
            ),
            ..Default::default()
        };
        store.restore_workspace_collections_from(&fake, &ws).await;
        let (defs, version) = store.collections_snapshot(&ws);
        assert_eq!(defs.len(), 1);
        assert_eq!(defs[0].name, "X");
        // Legacy bare-array mirror object parses through the dual-format loader.
        assert_eq!(version, 0);
        assert!(store.has_workspace_collections_loaded(&ws));
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
                MirrorOp::PutCollections { .. } => {}
                MirrorOp::PutDeleted { .. } => {}
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
    #[derive(Default)]
    struct FakeObjectStore {
        json: Option<Vec<u8>>,
        ydoc: Option<Vec<u8>>,
        index: Option<Vec<u8>>,
        collections: Option<Vec<u8>>,
        deleted_ids: Option<Vec<u8>>,
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

        async fn get_workspace_collections(
            &self,
            _ws: &WorkspaceId,
        ) -> Result<Option<Vec<u8>>, String> {
            Ok(self.collections.clone())
        }

        async fn get_workspace_deleted_ids(
            &self,
            _ws: &WorkspaceId,
        ) -> Result<Option<Vec<u8>>, String> {
            Ok(self.deleted_ids.clone())
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
            ..Default::default()
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
            ..Default::default()
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

        let fake = FakeObjectStore::default();
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
            ..Default::default()
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
    fn recovery_ring_prunes_to_configured_depth() {
        let dir = tempdir().unwrap();
        let mut store = DocumentStore::new(dir.path().to_path_buf());
        store.set_recovery_ring(5);
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
        assert_eq!(points.len(), 5, "ring bounded to configured depth");
        // Newest first, and the two oldest (1000, 1001) were pruned.
        assert_eq!(points[0].created_at, 1006);
        assert_eq!(points[4].created_at, 1002);

        // Re-pruning at a tighter depth drops down to it (clamped ≥ 1).
        store.set_recovery_ring(0);
        store.prune_recovery_points(&recovery);
        assert_eq!(
            store.list_recovery_points(&ws, &doc_id).len(),
            1,
            "depth clamps to at least one point"
        );
    }

    #[test]
    fn push_recovery_point_if_changed_dedupes_identical_sidecar() {
        let dir = tempdir().unwrap();
        let store = DocumentStore::new(dir.path().to_path_buf());
        let ws = WorkspaceId::single_tenant();
        let doc_id = DocId::from_http_path("dedupe-doc".to_string()).unwrap();

        // No sidecar yet → nothing to capture.
        assert!(!store.push_recovery_point_if_changed(&ws, &doc_id));

        store
            .save_document(&ws, serde_json::json!({"id": "dedupe-doc", "name": "D"}))
            .unwrap();
        store
            .persist_ydoc_binary(&ws, &doc_id, b"state-one")
            .unwrap();

        assert!(
            store.push_recovery_point_if_changed(&ws, &doc_id),
            "first capture always pushes"
        );
        assert_eq!(store.list_recovery_points(&ws, &doc_id).len(), 1);

        assert!(
            !store.push_recovery_point_if_changed(&ws, &doc_id),
            "identical sidecar is skipped"
        );
        assert_eq!(store.list_recovery_points(&ws, &doc_id).len(), 1);

        // Same length, different bytes → still captured (byte compare, not size).
        store
            .persist_ydoc_binary(&ws, &doc_id, b"state-two")
            .unwrap();
        assert!(
            store.push_recovery_point_if_changed(&ws, &doc_id),
            "changed sidecar pushes a new point"
        );
        assert_eq!(store.list_recovery_points(&ws, &doc_id).len(), 2);
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
            prose_page_count: None,
            size_bytes: None,
            modified_at: 1,
            created_at: 1,
            is_relay_document: Some(true),
            server_version: Some(1),
            locked_by: None,
            locked_by_name: None,
            locked_at: None,
            owner_id: None,
            owner_name: None,
            collection_id: None,
            tags: None,
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

    // ---- JP-349: canvas + prose page counts ----

    #[test]
    fn page_counts_of_counts_both_collections() {
        let two_canvas_three_prose = serde_json::json!({
            "pageOrder": ["c1", "c2"],
            "richTextPages": { "pageOrder": ["r1", "r2", "r3"] },
        });
        assert_eq!(DocumentStore::page_counts_of(&two_canvas_three_prose), (2, 3));

        // Absent richTextPages → 0 prose (not a panic / default-1).
        let canvas_only = serde_json::json!({ "pageOrder": ["c1"] });
        assert_eq!(DocumentStore::page_counts_of(&canvas_only), (1, 0));

        // Absent everything → (0, 0); the floor lives in metadata_from_body.
        assert_eq!(DocumentStore::page_counts_of(&serde_json::json!({})), (0, 0));
    }

    #[test]
    fn metadata_page_count_is_canvas_plus_prose() {
        let dir = tempdir().unwrap();
        let store = DocumentStore::new(dir.path().to_path_buf());
        let ws = WorkspaceId::single_tenant();
        store
            .save_document(
                &ws,
                serde_json::json!({
                    "id": "d",
                    "name": "D",
                    "pageOrder": ["c1"],
                    "richTextPages": { "pageOrder": ["r1", "r2", "r3"] },
                }),
            )
            .unwrap();

        let doc_id = DocId::from_http_path("d".into()).unwrap();
        let meta = store.get_metadata(&ws, &doc_id).unwrap();
        assert_eq!(meta.page_count, 4, "1 canvas + 3 prose");
        assert_eq!(meta.prose_page_count, Some(3));
        // canvasPageCount is derived as page_count - prose at the MCP edge.
        assert_eq!(meta.page_count - meta.prose_page_count.unwrap(), 1);
    }

    #[test]
    fn load_workspace_index_backfills_legacy_entry_prose_count() {
        // A pre-JP-349 index.json: canvas-only `pageCount`, no `prosePageCount`.
        let dir = tempdir().unwrap();
        let ws_dir = dir
            .path()
            .join("relay_documents")
            .join("workspaces")
            .join("default");
        std::fs::create_dir_all(ws_dir.join("docs")).unwrap();
        std::fs::write(
            ws_dir.join("index.json"),
            r#"{"legacy-doc":{"id":"legacy-doc","name":"L","pageCount":1,"modifiedAt":1,"createdAt":1}}"#,
        )
        .unwrap();
        // The body it points at has 1 canvas + 3 prose pages.
        std::fs::write(
            ws_dir.join("docs").join("legacy-doc.json"),
            r#"{"id":"legacy-doc","name":"L","pageOrder":["c1"],"richTextPages":{"pages":{},"pageOrder":["r1","r2","r3"],"activePageId":"r1"}}"#,
        )
        .unwrap();

        // Boot re-derives from the body — the cold doc is fixed, not stuck at 1.
        let store = DocumentStore::new(dir.path().to_path_buf());
        let ws = WorkspaceId::single_tenant();
        let doc_id = DocId::from_http_path("legacy-doc".into()).unwrap();
        let meta = store.get_metadata(&ws, &doc_id).unwrap();
        assert_eq!(meta.page_count, 4, "backfilled to canvas + prose");
        assert_eq!(meta.prose_page_count, Some(3));
    }

    // ---- JP-443 doc-size accounting + storage gate ---------------------------

    #[test]
    fn save_records_size_bytes_and_snapshot_updates_it() {
        let dir = tempdir().unwrap();
        let store = DocumentStore::new(dir.path().to_path_buf());
        let ws = WorkspaceId::single_tenant();
        let doc_id = DocId::from_http_path("sz-doc".into()).unwrap();

        store.save_document(&ws, serde_json::json!({"id": "sz-doc", "name": "S"})).unwrap();
        let meta = store.get_metadata(&ws, &doc_id).unwrap();
        let recorded = meta.size_bytes.expect("save records size");
        let on_disk = std::fs::metadata(store.doc_path(&ws, &doc_id)).unwrap().len();
        assert_eq!(recorded, on_disk, "recorded size is the exact on-disk length");
        assert_eq!(store.workspace_doc_bytes(&ws), recorded);
        assert_eq!(store.total_doc_bytes(), recorded);

        // A snapshot (quiet CRDT flush — never gated by construction: it has
        // no gate parameter) updates the recorded size and reports it back.
        let snap =
            serde_json::json!({"id": "sz-doc", "name": "S", "filler": "x".repeat(512)});
        let written = store.persist_snapshot(&ws, snap).unwrap();
        let meta = store.get_metadata(&ws, &doc_id).unwrap();
        assert_eq!(meta.size_bytes, Some(written));
        assert!(written > recorded);
        assert_eq!(store.workspace_doc_bytes(&ws), written);
    }

    #[test]
    fn load_workspace_index_backfills_legacy_size_bytes() {
        // A pre-JP-443 index.json entry: no `sizeBytes`.
        let dir = tempdir().unwrap();
        let ws_dir = dir
            .path()
            .join("relay_documents")
            .join("workspaces")
            .join("default");
        std::fs::create_dir_all(ws_dir.join("docs")).unwrap();
        std::fs::write(
            ws_dir.join("index.json"),
            r#"{"legacy-doc":{"id":"legacy-doc","name":"L","pageCount":1,"prosePageCount":0,"modifiedAt":1,"createdAt":1}}"#,
        )
        .unwrap();
        let body = r#"{"id":"legacy-doc","name":"L"}"#;
        std::fs::write(ws_dir.join("docs").join("legacy-doc.json"), body).unwrap();

        let store = DocumentStore::new(dir.path().to_path_buf());
        let ws = WorkspaceId::single_tenant();
        let doc_id = DocId::from_http_path("legacy-doc".into()).unwrap();
        let meta = store.get_metadata(&ws, &doc_id).unwrap();
        assert_eq!(meta.size_bytes, Some(body.len() as u64), "stat-derived backfill");
        assert_eq!(store.workspace_doc_bytes(&ws), body.len() as u64);

        // The backfill persisted once, so the next boot skips the re-derive.
        let raw = std::fs::read_to_string(ws_dir.join("index.json")).unwrap();
        assert!(raw.contains("sizeBytes"), "backfill persisted to index.json");
    }

    #[test]
    fn doc_save_gate_refuses_growth_over_quota() {
        let dir = tempdir().unwrap();
        let store = DocumentStore::new(dir.path().to_path_buf());
        let ws = WorkspaceId::single_tenant();

        store.save_document(&ws, serde_json::json!({"id": "q-doc", "name": "Q"})).unwrap();
        let base = store.workspace_doc_bytes(&ws);
        let gate =
            DocSaveGate { quota_bytes: Some(base + 64), blob_bytes: 0, max_doc_bytes: None };

        // Growing well past the quota is refused with the gate's numbers…
        let big = serde_json::json!({"id": "q-doc", "name": "Q", "filler": "x".repeat(1024)});
        let outcome =
            store.save_document_with_expected_version(&ws, big, None, Some(&gate)).unwrap();
        assert!(matches!(
            outcome,
            SaveOutcome::QuotaExceeded { used, quota, .. } if used == base && quota == base + 64
        ));
        // …and nothing was persisted (recorded size unchanged).
        assert_eq!(store.workspace_doc_bytes(&ws), base);
    }

    #[test]
    fn doc_save_gate_allows_shrinking_save_while_over_quota() {
        let dir = tempdir().unwrap();
        let store = DocumentStore::new(dir.path().to_path_buf());
        let ws = WorkspaceId::single_tenant();

        store
            .save_document(
                &ws,
                serde_json::json!({"id": "s-doc", "name": "S", "filler": "x".repeat(2048)}),
            )
            .unwrap();
        let big = store.workspace_doc_bytes(&ws);
        // The workspace is now far over this quota…
        let gate =
            DocSaveGate { quota_bytes: Some(big / 4), blob_bytes: 0, max_doc_bytes: None };

        // …but a shrinking save still lands — deleting content is the dig-out
        // path, and refusing it would deadlock an over-quota workspace.
        let smaller = serde_json::json!({"id": "s-doc", "name": "S"});
        let outcome = store
            .save_document_with_expected_version(&ws, smaller, None, Some(&gate))
            .unwrap();
        assert!(matches!(outcome, SaveOutcome::Updated { .. }));
        assert!(store.workspace_doc_bytes(&ws) < big);

        // A growing save from the same over-quota state is refused.
        let bigger =
            serde_json::json!({"id": "s-doc", "name": "S", "filler": "y".repeat(4096)});
        let outcome = store
            .save_document_with_expected_version(&ws, bigger, None, Some(&gate))
            .unwrap();
        assert!(matches!(outcome, SaveOutcome::QuotaExceeded { .. }));
    }

    #[test]
    fn doc_save_gate_lenient_when_legacy_old_size_unknown() {
        // An index entry without a recorded size whose body isn't local (an
        // evicted legacy doc — the boot backfill had nothing to stat): the
        // quota check is skipped for that one save, which records the true
        // size, so the next growing save is gated normally.
        let dir = tempdir().unwrap();
        let ws_dir = dir
            .path()
            .join("relay_documents")
            .join("workspaces")
            .join("default");
        std::fs::create_dir_all(ws_dir.join("docs")).unwrap();
        std::fs::write(
            ws_dir.join("index.json"),
            r#"{"ghost-doc":{"id":"ghost-doc","name":"G","pageCount":1,"prosePageCount":0,"modifiedAt":1,"createdAt":1,"serverVersion":3}}"#,
        )
        .unwrap();

        let store = DocumentStore::new(dir.path().to_path_buf());
        let ws = WorkspaceId::single_tenant();
        let doc_id = DocId::from_http_path("ghost-doc".into()).unwrap();
        assert_eq!(store.get_metadata(&ws, &doc_id).unwrap().size_bytes, None);

        // Even a 1-byte quota doesn't refuse this save (old size unknown →
        // lenient: a false 507 lockout is worse than one lenient write).
        let gate = DocSaveGate { quota_bytes: Some(1), blob_bytes: 0, max_doc_bytes: None };
        let doc =
            serde_json::json!({"id": "ghost-doc", "name": "G", "filler": "x".repeat(256)});
        let outcome =
            store.save_document_with_expected_version(&ws, doc, None, Some(&gate)).unwrap();
        assert!(matches!(outcome, SaveOutcome::Updated { .. }));

        // Self-healed: the size is recorded, so growth is now gated.
        assert!(store.get_metadata(&ws, &doc_id).unwrap().size_bytes.unwrap() > 0);
        let bigger =
            serde_json::json!({"id": "ghost-doc", "name": "G", "filler": "x".repeat(4096)});
        let outcome = store
            .save_document_with_expected_version(&ws, bigger, None, Some(&gate))
            .unwrap();
        assert!(matches!(outcome, SaveOutcome::QuotaExceeded { .. }));
    }

    #[test]
    fn doc_save_gate_refuses_doc_over_max_doc_bytes() {
        let dir = tempdir().unwrap();
        let store = DocumentStore::new(dir.path().to_path_buf());
        let ws = WorkspaceId::single_tenant();

        let gate = DocSaveGate { quota_bytes: None, blob_bytes: 0, max_doc_bytes: Some(256) };
        let big = serde_json::json!({"id": "cap-doc", "name": "C", "filler": "x".repeat(512)});
        let outcome =
            store.save_document_with_expected_version(&ws, big, None, Some(&gate)).unwrap();
        assert!(matches!(
            outcome,
            SaveOutcome::DocTooLarge { size, max } if size > 256 && max == 256
        ));
        let doc_id = DocId::from_http_path("cap-doc".into()).unwrap();
        assert!(store.get_metadata(&ws, &doc_id).is_none(), "nothing persisted");

        // Under the ceiling → lands.
        let small = serde_json::json!({"id": "cap-doc", "name": "C"});
        let outcome =
            store.save_document_with_expected_version(&ws, small, None, Some(&gate)).unwrap();
        assert!(matches!(outcome, SaveOutcome::Created { .. }));
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
            ..Default::default()
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
