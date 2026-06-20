//! WebSocket server module for Protected Local mode
//!
//! This module provides the WebSocket server that enables real-time collaboration
//! between clients in Protected Local mode. The host runs this server, and clients
//! connect to it to synchronize document changes via CRDT.
//!
//! ## Network Access Modes
//! - `localhost`: Only accepts connections from the same machine (127.0.0.1)
//! - `lan`: Accepts connections from the local network (0.0.0.0)
//!
//! ## Security Considerations
//! - LAN mode exposes the server to all devices on the local network
//! - Authentication is required for all connections
//! - Consider firewall rules for additional protection

mod blob_backend;
pub mod blobs;
pub(crate) mod chunk;
pub mod documents;
pub mod permissions;
pub mod protocol;

use axum::{
    body::Body,
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, Query, State,
    },
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, head, post},
    Router,
};
use futures_util::{SinkExt, StreamExt};
use std::collections::{HashMap, HashSet};
use std::net::IpAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::{broadcast, mpsc, RwLock};
use tower_http::cors::{Any, CorsLayer};

use blobs::{BlobStore, SaveBlobError};
use documents::{DocumentStore, MirrorOp};
use governor::{
    clock::DefaultClock, state::keyed::DefaultKeyedStateStore, Quota, RateLimiter,
};
use std::num::NonZeroU32;
use protocol::*;
use crate::auth::{AuthError, OidcAuthState, OidcClaims, WorkspaceRole};
use crate::config::{StorageConfig, SyncConfig, TenancyConfig, TenancyMode};
use crate::sync::{
    prose_count_in_binary, suspicious_prose_zeroing, suspicious_zeroing, total_shape_count,
    DocHandle, DocRegistry,
};
use blob_backend::S3Backend;

/// Per-workspace token-bucket limiter shared between WS sync handlers
/// and MCP write tools. Phase 21.3.
pub type WorkspaceWriteLimiter =
    RateLimiter<WorkspaceId, DefaultKeyedStateStore<WorkspaceId>, DefaultClock>;

/// Build the S3/R2 byte store from `[storage]` config. Returns `None` for the
/// filesystem backend; logs and returns `None` if `backend = "s3"` but the
/// `[storage.s3]` block is missing or incomplete (the relay then runs without
/// a usable blob byte store rather than refusing to boot).
fn build_s3_backend(storage: &StorageConfig) -> Option<Arc<S3Backend>> {
    if storage.backend != "s3" {
        return None;
    }
    match &storage.s3 {
        Some(cfg) if cfg.is_complete() => {
            Some(Arc::new(S3Backend::new(blob_backend::S3Config {
                endpoint: cfg.endpoint.clone(),
                bucket: cfg.bucket.clone(),
                region: cfg.region.clone(),
                access_key_id: cfg.access_key_id.clone(),
                secret_access_key: cfg.secret_access_key.clone(),
                key_prefix: cfg.key_prefix.clone(),
                put_ttl_secs: cfg.put_ttl_secs,
                get_ttl_secs: cfg.get_ttl_secs,
            })))
        }
        _ => {
            log::error!(
                "storage.backend = \"s3\" but [storage.s3] is missing or incomplete \
                 (need endpoint, bucket, access_key_id, secret_access_key); \
                 blob byte store unavailable"
            );
            None
        }
    }
}

/// Background worker that DELETEs reclaimed per-workspace objects from R2.
/// `BlobStore`'s GC runs synchronously and enqueues `(workspace, hash)` pairs;
/// this drains them and issues the async `delete_object`. Best-effort: a failed
/// delete is logged and dropped (the bucket lifecycle rule is the backstop), so
/// one bad object can't wedge the queue. Exits when the sink is dropped (server
/// shutdown).
async fn run_blob_delete_worker(
    mut rx: mpsc::UnboundedReceiver<(WorkspaceId, String)>,
    s3: Arc<S3Backend>,
) {
    while let Some((ws, hash)) = rx.recv().await {
        if let Err(e) = s3.delete_object(&ws, &hash).await {
            log::warn!("R2 blob delete failed for {}/{}: {}", ws.as_str(), hash, e);
        }
    }
}

/// Default MIME for a blob whose stored content-type can't be read during the
/// JP-232 reconstruct fallback. Display-only; never affects GC or quota.
fn default_blob_mime() -> String {
    "application/octet-stream".to_string()
}

/// Background worker that mirrors per-workspace **blob ledgers** to R2 (JP-232).
/// Each bookkeeping change sends the workspace id here; the worker coalesces a
/// burst (drains the backlog into a dedup set — e.g. a startup sweep releasing
/// many ACLs) and PUTs each workspace's current `blob_ledger.json` once,
/// re-reading live state via [`BlobStore::ledger_for_workspace`] at processing
/// time. Best-effort: a failed PUT is logged and dropped — the next change
/// re-enqueues and reconstruct-from-docs is the disaster backstop. Exits when
/// the sink is dropped (server shutdown).
async fn run_blob_ledger_worker(
    mut rx: mpsc::UnboundedReceiver<WorkspaceId>,
    blob_store: Arc<BlobStore>,
    s3: Arc<S3Backend>,
) {
    while let Some(ws) = rx.recv().await {
        let mut dirty: HashSet<WorkspaceId> = HashSet::new();
        dirty.insert(ws);
        while let Ok(more) = rx.try_recv() {
            dirty.insert(more);
        }
        for ws in dirty {
            let ledger = blob_store.ledger_for_workspace(&ws);
            let bytes = match serde_json::to_vec(&ledger) {
                Ok(b) => b,
                Err(e) => {
                    log::warn!("blob ledger serialize failed for {}: {}", ws.as_str(), e);
                    continue;
                }
            };
            let key = s3.blob_ledger_key(&ws);
            if let Err(e) = s3.put_object_at(&key, bytes, "application/json").await {
                log::warn!("R2 blob ledger PUT failed for {}: {}", key, e);
            }
        }
    }
}

/// Background worker that mirrors workspace **documents** to R2 (JP-200). The
/// synchronous write paths enqueue a [`MirrorOp`] after each local write; this
/// drains them in FIFO order and performs the async R2 PUT/DELETE, re-reading the
/// local file at processing time (coalesces rapid re-snapshots; bounds memory vs
/// carrying bytes through the channel). Best-effort: a failed transfer is logged
/// and dropped — the next write re-enqueues, and the startup backfill + bucket
/// lifecycle are backstops, so one bad object can't wedge the queue. Exits when
/// the sink is dropped (server shutdown).
async fn run_doc_mirror_worker(
    mut rx: mpsc::UnboundedReceiver<MirrorOp>,
    doc_store: Arc<DocumentStore>,
    s3: Arc<S3Backend>,
) {
    while let Some(op) = rx.recv().await {
        match op {
            MirrorOp::Put { ws, doc_id, ext } => {
                // JP-231: capture the local generation **before** reading the file
                // so the gen we later confirm can only lag the uploaded content,
                // never lead it (a racing save bumps the gen after this read).
                let gen = if ext == "json" {
                    Some(doc_store.current_local_gen(&ws, &doc_id))
                } else {
                    None
                };
                let Some(bytes) = doc_store.read_doc_object(&ws, &doc_id, ext) else {
                    // File gone before we got here (a Put-then-Delete race) — skip;
                    // the trailing Delete reconciles R2.
                    continue;
                };
                let content_type = if ext == "json" {
                    "application/json"
                } else {
                    "application/octet-stream"
                };
                let key = s3.doc_object_key(&ws, &doc_id, ext);
                match s3.put_object_at(&key, bytes, content_type).await {
                    Ok(()) => {
                        // JP-231: json content now confirmed durable in R2 — record
                        // the generation so eviction may reclaim it once it's cold.
                        if let Some(g) = gen {
                            doc_store.set_mirrored_gen(&ws, &doc_id, g);
                        }
                    }
                    Err(e) => log::warn!("R2 doc mirror PUT failed for {}: {}", key, e),
                }
            }
            MirrorOp::PutIndex { ws } => {
                let Some(bytes) = doc_store.read_workspace_index_bytes(&ws) else {
                    continue;
                };
                let key = s3.workspace_index_key(&ws);
                if let Err(e) = s3.put_object_at(&key, bytes, "application/json").await {
                    log::warn!("R2 index mirror PUT failed for {}: {}", key, e);
                }
            }
            MirrorOp::PutCollections { ws } => {
                let Some(bytes) = doc_store.read_workspace_collections_bytes(&ws) else {
                    continue;
                };
                let key = s3.workspace_collections_key(&ws);
                if let Err(e) = s3.put_object_at(&key, bytes, "application/json").await {
                    log::warn!("R2 collections mirror PUT failed for {}: {}", key, e);
                }
            }
            MirrorOp::Delete { ws, doc_id } => {
                for ext in ["json", "ydoc"] {
                    let key = s3.doc_object_key(&ws, &doc_id, ext);
                    if let Err(e) = s3.delete_object_at(&key).await {
                        log::warn!("R2 doc mirror DELETE failed for {}: {}", key, e);
                    }
                }
            }
            MirrorOp::Flush(ack) => {
                // FIFO ⇒ every prior op has been processed; release the drainer.
                let _ = ack.send(());
            }
        }
    }
}

/// Build a fresh per-workspace write limiter from numeric limits. A
/// zero burst falls back to 1 (governor requires `NonZeroU32`).
pub fn build_workspace_limiter(
    per_sec: u32,
    burst: u32,
) -> WorkspaceWriteLimiter {
    let per_sec = NonZeroU32::new(per_sec).unwrap_or_else(|| NonZeroU32::new(1).unwrap());
    let burst = NonZeroU32::new(burst).unwrap_or(per_sec);
    let quota = Quota::per_second(per_sec).allow_burst(burst);
    RateLimiter::dashmap(quota)
}

/// Network access mode for the server
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub enum NetworkMode {
    /// Only accept connections from localhost (127.0.0.1)
    #[serde(rename = "localhost")]
    Localhost,
    /// Accept connections from any interface (0.0.0.0) - enables LAN access
    #[serde(rename = "lan")]
    Lan,
}

impl Default for NetworkMode {
    fn default() -> Self {
        NetworkMode::Lan // Default to LAN for collaboration
    }
}

/// Server status information
#[derive(Clone, serde::Serialize)]
pub struct ServerStatus {
    pub running: bool,
    pub port: u16,
    pub connected_clients: usize,
    /// Primary address (localhost or first LAN IP)
    pub address: String,
    /// All available addresses to connect to
    pub addresses: Vec<String>,
    /// Current network mode
    pub network_mode: NetworkMode,
    /// Maximum allowed connections (0 = unlimited)
    pub max_connections: u16,
}

/// Server configuration
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct ServerConfig {
    /// Network access mode
    pub network_mode: NetworkMode,
    /// Maximum connections allowed (0 = unlimited)
    pub max_connections: u16,
    /// Port to listen on
    pub port: u16,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            network_mode: NetworkMode::Lan,
            max_connections: 10,
            port: 9876,
        }
    }
}

/// Get local IP addresses for LAN access
pub fn get_local_ips() -> Vec<IpAddr> {
    let mut ips = Vec::new();

    if let Ok(interfaces) = local_ip_address::list_afinet_netifas() {
        for (_, ip) in interfaces {
            if let IpAddr::V4(ipv4) = ip {
                if ipv4.is_private() && !ipv4.is_loopback() {
                    ips.push(ip);
                }
            }
        }
    }

    ips
}

/// Per-client connection state
#[derive(Debug)]
struct ClientState {
    /// Server-assigned client ID. Retained for diagnostics + Debug
    /// printing; not read directly post-Slice E.3 (the dead handlers
    /// that used it moved to REST).
    #[allow(dead_code)]
    id: u64,
    user_id: Option<String>,
    username: Option<String>,
    role: Option<String>,
    current_doc_id: Option<DocId>,
    /// Workspace the client is authenticated against. Phase 21.1
    /// plumbs this through every storage / sync call; Phase 21.5 will
    /// derive it from the JWT `wsp[].id` claim instead of the
    /// single-tenant constant. Not read by storage today (single-tenant
    /// layout), but the field is in place so 21.5 / 21.4 fuzz can
    /// observe it.
    #[allow(dead_code)]
    current_workspace_id: WorkspaceId,
    authenticated: bool,
    /// AU-3 (JP-300): the authenticating token's `jti` + `exp`, captured so a
    /// live session can be periodically rechecked against the revocation set and
    /// expiry — token validation otherwise runs only at connect, leaving a
    /// revoked/expired holder editing on an open socket. `None` until AUTH.
    jti: Option<String>,
    token_exp: Option<u64>,
    tx: mpsc::Sender<Vec<u8>>,
    /// JP-309: per-connection reassembly buffer for chunked SYNC frames.
    reassembly: chunk::ChunkReassembler,
}

/// Where a broadcast should land. Replaces the pre-21.4-B
/// `Option<DocId>` routing key, which silently merged tenants in
/// shared mode (two workspaces with the same doc id received each
/// other's sync/awareness frames).
#[derive(Clone, Debug)]
enum BroadcastTarget {
    /// Per-doc broadcast (sync / awareness). Delivered to clients whose
    /// `current_workspace_id` AND `current_doc_id` both match.
    Doc(WorkspaceId, DocId),
    /// All authenticated clients in one workspace (e.g. DOC_EVENT for a
    /// REST save). Pre-21.4-B used `broadcast_to_all` here, which
    /// leaked DocumentMetadata across tenants.
    Workspace(WorkspaceId),
    /// Every authenticated client regardless of workspace. No live
    /// caller today; reserved for future admin / system events.
    #[allow(dead_code)]
    Global,
}

/// Broadcast message with routing info
#[derive(Clone)]
struct BroadcastMessage {
    /// Routing target. See `BroadcastTarget`.
    target: BroadcastTarget,
    /// Exclude this client from receiving
    exclude_client: Option<u64>,
    /// Message data
    data: Vec<u8>,
}

/// Tenancy-check failure. Surfaced opaquely on the wire (no
/// disambiguation between mode + workspace).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TenancyError {
    Mismatch,
}

/// Per-workspace connection-cap failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WorkspaceLimitError {
    /// The total-connection safety ceiling (`max_ws_connections_per_workspace`,
    /// editors + viewers) is full. Guards pure-viewer flooding.
    CapExceeded,
    /// The per-workspace concurrent-**editor** cap (JP-81) is full. Viewers
    /// are never rejected on this axis.
    EditorCapExceeded,
}

/// Per-workspace live connection counts, split by whether the connection
/// can write. **Editor** connections (workspace role owner/member) drive
/// CRDT merge + broadcast-fanout cost; **viewer** connections (read-only,
/// e.g. share-token) only receive the broadcast stream. The split is a
/// raw observability signal — the relay exposes the counts; any quota
/// interpretation is the control plane's concern. The connection cap
/// itself still applies to the *total* (editors + viewers).
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct WorkspaceConnCounts {
    pub editors: u32,
    pub viewers: u32,
}

impl WorkspaceConnCounts {
    fn total(&self) -> u32 {
        self.editors.saturating_add(self.viewers)
    }
}

/// Effective per-workspace limits after applying the claim-else-config
/// fallback (JP-81). `None` means **unlimited** — either nothing was
/// minted on the claim and the config fallback is `0`, or the resolved
/// value is `0`. Built by [`ServerState::resolve_limits`].
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct EffectiveLimits {
    pub quota_bytes: Option<u64>,
    pub editor_limit: Option<u32>,
}

/// Shared state for the WebSocket server
pub struct ServerState {
    /// Broadcast channel for sending messages
    broadcast_tx: broadcast::Sender<BroadcastMessage>,
    /// Count of connected clients
    client_count: AtomicU16,
    /// Next client ID
    next_client_id: AtomicU64,
    /// Connected clients
    clients: RwLock<HashMap<u64, ClientState>>,
    /// Document store
    doc_store: Arc<DocumentStore>,
    /// Blob store for embedded files
    blob_store: Arc<BlobStore>,
    /// S3/R2 byte store, present only when `[storage] backend = "s3"`. Holds
    /// the presign / HEAD / DELETE surface the blob handlers use for direct
    /// client transfer; `None` for the filesystem backend.
    s3: Option<Arc<S3Backend>>,
    /// JP-200 document-mirror sink — the sender end of the channel drained by
    /// `run_doc_mirror_worker`. `Some` when the s3 backend is active. Shared
    /// (cloned) into the MCP server's separate `DocumentStore` and used by the
    /// graceful-shutdown drain.
    doc_mirror_tx: Option<mpsc::UnboundedSender<MirrorOp>>,
    /// OIDC validator + JWKS cache + revocation set. JP-77 — the relay
    /// no longer issues tokens, only validates them against an external
    /// issuer's JWKS.
    auth: OidcAuthState,
    /// Shared bearer secret authenticating
    /// `POST /api/v1/internal/revoke` from the control plane. `None`
    /// disables push (polling fallback still works).
    revocation_push_bearer: Option<String>,
    /// Region this relay pod runs in. Used to enforce `wsp[].region`
    /// matching on inbound tokens. Defaults to the legacy
    /// single-tenant region when unconfigured.
    relay_region: String,
    /// Tenancy mode + per-workspace limits. Phase 21.3 + 21.5.
    tenancy: TenancyConfig,
    /// Per-workspace authenticated WS connection counts, split into
    /// editor vs viewer. Enforces
    /// `tenancy.limits.max_ws_connections_per_workspace` on the total and
    /// exposes the editor/viewer breakdown as a metering signal.
    workspace_client_counts: RwLock<HashMap<WorkspaceId, WorkspaceConnCounts>>,
    /// Per-workspace token-bucket limiter for writes. Shared with the
    /// MCP server so a tenant's CRDT frames and MCP write tools draw
    /// from the same bucket. Phase 21.3.
    write_limiter: Arc<WorkspaceWriteLimiter>,
    /// Authoritative server-side Y.Doc per active document (JP-34). Hydrated
    /// on `JOIN_DOC`, fed by inbound SYNC frames, evicted when the last client
    /// on a doc disconnects.
    sync_registry: Arc<DocRegistry>,
    /// Process-wide counter of caught handler panics. Shared with the
    /// MCP server so both subsystems' panics surface at the same
    /// `/metrics` counter. Phase 21.2.
    panic_count: Arc<AtomicU64>,
    /// Pod-wide count of write-limiter rejections (CRDT + MCP). Shared
    /// `Arc` with the MCP server and `WebSocketServer`. Read by
    /// `/metrics`; the metering observability signal for the internal
    /// save/write fair-use throttle.
    rate_limit_rejections: Arc<AtomicU64>,
    /// Snapshot of `config.observability.metering_debug_log`. When true,
    /// `/metrics` also logs the per-workspace metering breakdown.
    metering_debug_log: bool,
    /// Snapshot of `config.sync.binary_persistence` (JP-108). When true, the
    /// relay writes a binary `Y.Doc` sidecar on snapshot and hydrates from it
    /// (preserving CRDT identity + prose); when false it uses pure-JSON.
    binary_persistence: bool,
    /// Snapshot of `config.sync.poison_guard` (JP-180). Gates the
    /// binary-vs-JSON hydrate sanity check + self-heal and the N→0 persist
    /// backup so a single bad client can't permanently zero a document.
    poison_guard: bool,
    /// DEBUG-only trigger: when set, any WS handler that observes a
    /// client with this workspace id will panic on entry. Compiled out
    /// of release builds. Phase 21.2.
    #[cfg(debug_assertions)]
    panic_tenant_trigger: Option<WorkspaceId>,
    /// JP-232 cold-recovery once-gate. `blob_recovery_done` records the
    /// workspaces whose blob bookkeeping has been restored/rebuilt this process;
    /// `blob_recovery_locks` holds a per-workspace async mutex so concurrent
    /// first-touches serialize *per workspace* (and a save can't race a half-done
    /// recovery) while different workspaces recover in parallel. Both guard
    /// short critical sections only — never held across an `.await`.
    blob_recovery_done: std::sync::Mutex<HashSet<WorkspaceId>>,
    blob_recovery_locks: std::sync::Mutex<HashMap<WorkspaceId, Arc<tokio::sync::Mutex<()>>>>,
    /// RB-1b (JP-299): bounds concurrent in-memory blob uploads across the proxy
    /// (`POST /api/blobs/:hash`) and URL-ingest paths. Both buffer up to
    /// `max_blob_bytes`, so the permit count (`max_concurrent_blob_uploads`)
    /// caps worst-case upload RAM — a burst of large uploads can't OOM a shared
    /// pod (cross-tenant availability).
    blob_upload_gate: Arc<tokio::sync::Semaphore>,
    /// RB-3 (JP-298): shared HTTP client for the URL blob-ingest endpoint, built
    /// once at startup instead of per request so the connection pool / keep-alive
    /// is reused. Carries the same SSRF redirect policy as before — the host
    /// allowlist (`tenancy.limits.blob_ingest_allowed_hosts`) is process-global
    /// config, so a startup-built policy is equivalent to the old per-request one.
    /// A `reqwest::Client` clone is a cheap `Arc` bump sharing the pool.
    ingest_http_client: reqwest::Client,
}

impl ServerState {
    #[allow(clippy::too_many_arguments)]
    fn new(
        app_data_dir: PathBuf,
        storage: StorageConfig,
        auth: OidcAuthState,
        revocation_push_bearer: Option<String>,
        relay_region: String,
        tenancy: TenancyConfig,
        write_limiter: Arc<WorkspaceWriteLimiter>,
        panic_count: Arc<AtomicU64>,
        rate_limit_rejections: Arc<AtomicU64>,
        metering_debug_log: bool,
        binary_persistence: bool,
        poison_guard: bool,
        #[cfg(debug_assertions)] panic_tenant_trigger: Option<WorkspaceId>,
    ) -> Self {
        let (broadcast_tx, _) = broadcast::channel(100);
        let s3 = build_s3_backend(&storage);
        let blob_store = {
            // JP-127: defer orphaned-blob reclaim by the configured grace so a
            // transient reference-drop can be corrected without losing bytes.
            let mut bs = BlobStore::new(app_data_dir.clone());
            bs.set_gc_grace_secs(tenancy.limits.blob_gc_grace_secs);
            // s3 mode: install the per-workspace object-delete (JP-127) and
            // ledger-mirror (JP-232) sinks *before* sharing the store, then spawn
            // their workers against the shared Arc — the ledger worker re-reads
            // live state through a store handle, so the Arc must exist first.
            let channels = if s3.is_some() {
                let (del_tx, del_rx) = mpsc::unbounded_channel();
                let (led_tx, led_rx) = mpsc::unbounded_channel();
                bs.set_object_delete_sink(del_tx);
                bs.set_ledger_mirror_sink(led_tx);
                Some((del_rx, led_rx))
            } else {
                None
            };
            let bs = Arc::new(bs);
            if let (Some(s3), Some((del_rx, led_rx))) = (s3.as_ref(), channels) {
                let s3d = s3.clone();
                tokio::spawn(async move { run_blob_delete_worker(del_rx, s3d).await });
                let s3l = s3.clone();
                let bsl = bs.clone();
                tokio::spawn(async move { run_blob_ledger_worker(led_rx, bsl, s3l).await });
            }
            bs
        };
        // JP-200: build the document store, wiring the R2 mirror sink + a
        // background worker when the s3 backend is active. The sender is also
        // stored on `ServerState` so it can be shared into the MCP store and used
        // by the shutdown drain. Filesystem backend → no sink (volume-only).
        let (doc_store, doc_mirror_tx) = {
            let mut ds = DocumentStore::new(app_data_dir);
            match &s3 {
                Some(s3) => {
                    let (tx, rx) = mpsc::unbounded_channel::<MirrorOp>();
                    ds.set_mirror_sink(tx.clone());
                    let ds = Arc::new(ds);
                    let worker_store = ds.clone();
                    let worker_s3 = s3.clone();
                    tokio::spawn(async move {
                        run_doc_mirror_worker(rx, worker_store, worker_s3).await
                    });
                    // Worker is up: push any pre-existing on-volume corpus to R2.
                    ds.backfill_mirror();
                    (ds, Some(tx))
                }
                None => (Arc::new(ds), None),
            }
        };
        // RB-1b: at least one permit so uploads never deadlock on a 0 config.
        let blob_upload_permits = tenancy.limits.max_concurrent_blob_uploads.max(1);
        // RB-3: build the URL-ingest HTTP client once. The redirect policy
        // re-validates every hop against the ingest allowlist (the classic
        // open-redirect SSRF escape); the allowlist is process-global config, so
        // snapshotting it here is equivalent to the old per-request build. A
        // build failure is a catastrophic startup condition (TLS backend init) —
        // fail loudly rather than degrade to a per-request 500.
        let ingest_allow = tenancy.limits.blob_ingest_allowed_hosts.clone();
        let ingest_http_client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::custom(move |attempt| {
                if attempt.previous().len() > 5 {
                    return attempt.error("too many redirects");
                }
                if crate::api::ingest_url_ok(attempt.url(), &ingest_allow) {
                    attempt.follow()
                } else {
                    attempt.stop()
                }
            }))
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .expect("failed to build blob-ingest HTTP client");
        Self {
            broadcast_tx,
            client_count: AtomicU16::new(0),
            next_client_id: AtomicU64::new(1),
            clients: RwLock::new(HashMap::new()),
            doc_store,
            blob_store,
            s3,
            doc_mirror_tx,
            auth,
            revocation_push_bearer,
            relay_region,
            tenancy,
            workspace_client_counts: RwLock::new(HashMap::new()),
            write_limiter,
            sync_registry: Arc::new(DocRegistry::new()),
            panic_count,
            rate_limit_rejections,
            metering_debug_log,
            binary_persistence,
            poison_guard,
            #[cfg(debug_assertions)]
            panic_tenant_trigger,
            blob_recovery_done: std::sync::Mutex::new(HashSet::new()),
            blob_recovery_locks: std::sync::Mutex::new(HashMap::new()),
            blob_upload_gate: Arc::new(tokio::sync::Semaphore::new(blob_upload_permits)),
            ingest_http_client,
        }
    }

    pub(crate) fn auth(&self) -> &OidcAuthState {
        &self.auth
    }

    pub(crate) fn revocation_push_bearer(&self) -> Option<&str> {
        self.revocation_push_bearer.as_deref()
    }

    pub(crate) fn relay_region(&self) -> &str {
        &self.relay_region
    }

    /// Accessor for the shared write limiter — used by handlers to
    /// meter CRDT/MCP writes against per-workspace token buckets.
    pub(crate) fn write_limiter(&self) -> &Arc<WorkspaceWriteLimiter> {
        &self.write_limiter
    }

    /// Phase 21.5: tenancy check. `dedicated` mode pins to the
    /// configured workspace (or single-tenant default when blank);
    /// `shared` accepts whatever the JWT carries. Returns
    /// `Err(TenancyError::Mismatch)` on rejection. Callers translate
    /// to HTTP 403 / WS close 4003 with an opaque message — no
    /// disambiguation leak per the Phase 21 doc.
    pub(crate) fn check_tenancy(&self, claim: &WorkspaceId) -> Result<(), TenancyError> {
        match self.tenancy.mode {
            TenancyMode::Shared => Ok(()),
            TenancyMode::Dedicated => {
                let pinned = self
                    .tenancy
                    .workspace_id
                    .as_deref()
                    .filter(|s| !s.is_empty())
                    .and_then(WorkspaceId::from_configured)
                    .unwrap_or_else(WorkspaceId::single_tenant);
                if &pinned == claim {
                    Ok(())
                } else {
                    Err(TenancyError::Mismatch)
                }
            }
        }
    }

    pub(crate) fn tenancy(&self) -> &TenancyConfig {
        &self.tenancy
    }

    /// JP-200: a clone of the document-mirror sender, shared into the MCP store
    /// and used by the shutdown drain. `None` on the filesystem backend.
    pub(crate) fn doc_mirror_sender(&self) -> Option<mpsc::UnboundedSender<MirrorOp>> {
        self.doc_mirror_tx.clone()
    }

    /// JP-200: ensure a document's body is present locally, restoring it from R2
    /// **by id** on a miss (recycled machine / cold volume). Returns whether the
    /// doc is now available locally. Fast-returns when already indexed; a no-op
    /// returning `false` on the filesystem backend (caller falls through to its
    /// normal not-found handling).
    pub(crate) async fn ensure_doc_local(&self, ws: &WorkspaceId, doc_id: &DocId) -> bool {
        // JP-232: recover this workspace's blob bookkeeping before any restore.
        // No-op (O(1)) on a healthy/already-recovered pod.
        self.ensure_blob_bookkeeping(ws).await;
        // JP-279: gate on **body presence**, not index/metadata presence. After a
        // JP-200 index restore (index eager, bodies lazy-by-id) or a JP-231
        // eviction, a doc is listed in the index but its body isn't on the volume
        // — using `get_metadata().is_some()` here short-circuited the restore and
        // ENOENT'd the subsequent read.
        if self.doc_store.has_local_body(ws, doc_id) {
            return true;
        }
        let s3 = match &self.s3 {
            Some(s3) => s3,
            None => return false,
        };
        let restored = self.doc_store.restore_doc_from(s3.as_ref(), ws, doc_id).await;
        if restored {
            // JP-232: `install_restored_doc` bypasses the blob store, so re-seed
            // this doc's blob references from the restored body. This keeps the
            // refcount/quota correct and self-heals any ledger lag for this doc
            // (the durable body is authoritative over a stale ledger).
            if let Ok(doc) = self.doc_store.get_document(ws, doc_id) {
                let hashes = crate::api::blob_refs_from_doc(&doc);
                if !hashes.is_empty() {
                    if let Err(e) = self.blob_store.seed_doc_refs(ws, doc_id.as_str(), hashes) {
                        log::warn!(
                            "JP-232 post-restore ref seed failed for {}/{}: {}",
                            ws.as_str(),
                            doc_id.as_str(),
                            e
                        );
                    }
                }
            }
        }
        restored
    }

    /// JP-232 cold-recovery: ensure `ws`'s blob bookkeeping (ACLs, per-doc
    /// refcounts, size/mime) is present in memory before the workspace is served.
    /// Idempotent + once-per-process per workspace, gated by a per-ws async mutex
    /// so concurrent first-touches serialize (a save can't race a half-done
    /// recovery) while different workspaces recover in parallel.
    ///
    /// Must be `await`ed at the top of every handler that **releases a blob ACL**
    /// (doc save/delete) or **serves a blob** — `resolve_workspace` is sync and
    /// the save path does not pass through `ensure_doc_local`, so this is the
    /// explicit gate that makes blocking recovery safe.
    ///
    /// Recovery is **ledger-first**: restore `blob_ledger.json` from R2 directly
    /// (fast, independent of the best-effort doc index); only when the ledger is
    /// absent/corrupt does it fall back to walking the R2 doc corpus and rebuild
    /// from each body's `blobReferences`. Filesystem mode and workspaces already
    /// resident on this pod are no-ops.
    pub(crate) async fn ensure_blob_bookkeeping(&self, ws: &WorkspaceId) {
        // Fast path — already recovered/known this process.
        if self.blob_recovery_done.lock().unwrap().contains(ws) {
            return;
        }
        // Per-workspace gate: serialize recovery for *this* ws, parallel across ws.
        let gate = {
            let mut locks = self.blob_recovery_locks.lock().unwrap();
            locks
                .entry(ws.clone())
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
                .clone()
        };
        let _guard = gate.lock().await;
        // Re-check under the gate — a concurrent first-touch may have finished.
        if self.blob_recovery_done.lock().unwrap().contains(ws) {
            return;
        }

        let s3 = match &self.s3 {
            // Filesystem mode: bookkeeping lives only on the volume; nothing to
            // recover from. Mark done so we never re-check.
            None => {
                self.blob_recovery_done.lock().unwrap().insert(ws.clone());
                return;
            }
            Some(s3) => s3.clone(),
        };
        // Volume intact for this ws → the on-volume sidecars are authoritative;
        // never walk R2. Either signal proves intactness: in-memory bookkeeping
        // (sidecars loaded at boot), or any local document (the index + blob
        // sidecars share the volume, so present docs ⇒ present sidecars; covers a
        // blob-less workspace too, and JP-231-evicted docs keep their index row).
        if self.blob_store.has_workspace_bookkeeping(ws)
            || !self.doc_store.list_documents(ws).is_empty()
        {
            self.blob_recovery_done.lock().unwrap().insert(ws.clone());
            return;
        }

        // Ledger-first.
        match s3.get_object_at(&s3.blob_ledger_key(ws)).await {
            Ok(Some(bytes)) => {
                match serde_json::from_slice::<crate::server::blobs::WorkspaceBlobLedger>(&bytes) {
                    Ok(ledger) => {
                        if let Err(e) = self.blob_store.install_ledger(ws, ledger) {
                            log::warn!("JP-232 ledger install failed for {}: {}", ws.as_str(), e);
                        }
                    }
                    Err(e) => {
                        log::warn!(
                            "JP-232 ledger for {} corrupt ({}); rebuilding from docs",
                            ws.as_str(),
                            e
                        );
                        self.reconstruct_blob_bookkeeping_from_docs(ws, &s3).await;
                    }
                }
            }
            Ok(None) => {
                // No ledger — disaster fallback (or a workspace new to this pod
                // that never wrote one). Rebuild from the durable doc corpus.
                self.reconstruct_blob_bookkeeping_from_docs(ws, &s3).await;
            }
            Err(e) => {
                // R2 unreachable: don't poison the done-set — leave the ws
                // un-recovered so a later touch retries. (Readiness gating on R2
                // is a separate follow-up.)
                log::warn!("JP-232 ledger GET failed for {}: {} — will retry", ws.as_str(), e);
                return;
            }
        }
        self.blob_recovery_done.lock().unwrap().insert(ws.clone());
    }

    /// JP-232 disaster fallback: rebuild `ws`'s blob bookkeeping by walking its
    /// R2 document corpus (no ledger). Restores the workspace index, then for
    /// each doc reads the body from R2, extracts `blobReferences`, HEADs each
    /// blob for size + content-type, and reconstructs ACLs/refs/index
    /// release-free. Writes a fresh ledger at the end so the next cold boot
    /// fast-paths. Best-effort per doc/blob — a single failure is logged, not
    /// fatal.
    async fn reconstruct_blob_bookkeeping_from_docs(&self, ws: &WorkspaceId, s3: &Arc<S3Backend>) {
        self.doc_store.restore_workspace_index_from(s3.as_ref(), ws).await;
        for meta in self.doc_store.list_documents(ws) {
            let key = s3.doc_object_key(ws, &meta.id, "json");
            let bytes = match s3.get_object_at(&key).await {
                Ok(Some(b)) => b,
                Ok(None) => continue,
                Err(e) => {
                    log::warn!("JP-232 reconstruct: R2 get {} failed: {}", key, e);
                    continue;
                }
            };
            let doc: serde_json::Value = match serde_json::from_slice(&bytes) {
                Ok(v) => v,
                Err(e) => {
                    log::warn!("JP-232 reconstruct: parse {} failed: {}", key, e);
                    continue;
                }
            };
            let hashes = crate::api::blob_refs_from_doc(&doc);
            let mut blobs: Vec<(String, u64, String)> = Vec::with_capacity(hashes.len());
            for h in hashes {
                let (size, mime) = match s3.head_object_typed(ws, &h).await {
                    Ok(Some((size, ct))) => (size, ct.unwrap_or_else(default_blob_mime)),
                    // Bytes missing/unreadable in R2: still record the ref + ACL
                    // (size 0) so GC never treats a referenced blob as orphaned;
                    // size self-corrects on the next upload/finalize of that hash.
                    Ok(None) => {
                        log::warn!(
                            "JP-232 reconstruct: blob {}/{} absent in R2; recording ref with size 0",
                            ws.as_str(),
                            h
                        );
                        (0, default_blob_mime())
                    }
                    Err(e) => {
                        log::warn!("JP-232 reconstruct: HEAD {}/{} failed: {}", ws.as_str(), h, e);
                        (0, default_blob_mime())
                    }
                };
                blobs.push((h, size, mime));
            }
            if let Err(e) = self.blob_store.reconstruct_doc_blobs(ws, meta.id.as_str(), blobs) {
                log::warn!(
                    "JP-232 reconstruct: rebuild {}/{} failed: {}",
                    ws.as_str(),
                    meta.id.as_str(),
                    e
                );
            }
        }
        // Persist the freshly-rebuilt bookkeeping as a ledger so subsequent cold
        // boots take the fast path (and a blob-less ws converges to an empty one).
        self.blob_store.mark_ledger_dirty(ws);
        log::info!("JP-232 rebuilt blob bookkeeping for {} from doc corpus", ws.as_str());
    }

    /// JP-200: ensure a workspace's document index is locally populated,
    /// restoring it from R2 on a cold machine. Never clobbers a populated
    /// in-memory index (only restores when the workspace has nothing in memory),
    /// so it's safe to call before a listing.
    pub(crate) async fn ensure_workspace_index_local(&self, ws: &WorkspaceId) {
        // JP-232: recover blob bookkeeping before serving a cold workspace listing.
        self.ensure_blob_bookkeeping(ws).await;
        if !self.doc_store.list_documents(ws).is_empty() {
            return;
        }
        if let Some(s3) = &self.s3 {
            self.doc_store
                .restore_workspace_index_from(s3.as_ref(), ws)
                .await;
        }
    }

    /// Best-effort restore of a workspace's collection definitions from R2 before
    /// serving the collections registry on a cold machine. Only reaches for R2
    /// when the in-memory registry is empty, so a populated one is never clobbered.
    pub(crate) async fn ensure_workspace_collections_local(&self, ws: &WorkspaceId) {
        if !self.doc_store.list_collections(ws).is_empty() {
            return;
        }
        if let Some(s3) = &self.s3 {
            self.doc_store
                .restore_workspace_collections_from(s3.as_ref(), ws)
                .await;
        }
    }

    /// Try to register a new authenticated WS connection for the
    /// given workspace. Returns:
    /// - `Err(CapExceeded)` if the total-connection safety ceiling
    ///   (`max_ws_connections_per_workspace`, editors + viewers) is full;
    /// - `Err(EditorCapExceeded)` if the connection is an **editor** and
    ///   the per-workspace editor cap (`editor_limit`, JP-81) is full —
    ///   viewers are never rejected on this axis;
    /// both checks and the increment are atomic under the write lock.
    /// `editor_limit` is the *effective* limit (claim else config);
    /// `None` = unlimited.
    pub(crate) async fn try_register_workspace_connection(
        &self,
        ws: &WorkspaceId,
        is_editor: bool,
        editor_limit: Option<u32>,
    ) -> Result<(), WorkspaceLimitError> {
        let cap = self.tenancy.limits.max_ws_connections_per_workspace;
        let mut counts = self.workspace_client_counts.write().await;
        let entry = counts.entry(ws.clone()).or_default();
        if entry.total() >= cap {
            return Err(WorkspaceLimitError::CapExceeded);
        }
        if is_editor {
            if let Some(limit) = editor_limit {
                if entry.editors >= limit {
                    return Err(WorkspaceLimitError::EditorCapExceeded);
                }
            }
            entry.editors += 1;
        } else {
            entry.viewers += 1;
        }
        Ok(())
    }

    /// Resolve the *effective* per-workspace limits for a request: the
    /// value minted on the JWT `wsp[]` claim if present, else the
    /// `[tenancy.limits]` config fallback. A resolved `0` (from either
    /// source) normalises to `None` = **unlimited** — the safe-by-default
    /// self-host story. The relay enforces raw numbers; tier resolution
    /// lives in the control plane (JP-81).
    pub(crate) fn resolve_limits(&self, claim: ClaimLimits) -> EffectiveLimits {
        let cfg = &self.tenancy.limits;
        let quota = claim.quota_bytes.unwrap_or(cfg.storage_quota_bytes);
        let editors = claim.editor_limit.unwrap_or(cfg.max_editors_per_workspace);
        EffectiveLimits {
            quota_bytes: (quota != 0).then_some(quota),
            editor_limit: (editors != 0).then_some(editors),
        }
    }

    /// Mirror of `try_register_workspace_connection` used on clean
    /// disconnect. `is_editor` must match the value used at registration
    /// so the editor/viewer split stays balanced.
    pub(crate) async fn release_workspace_connection(&self, ws: &WorkspaceId, is_editor: bool) {
        let mut counts = self.workspace_client_counts.write().await;
        if let Some(entry) = counts.get_mut(ws) {
            if is_editor {
                entry.editors = entry.editors.saturating_sub(1);
            } else {
                entry.viewers = entry.viewers.saturating_sub(1);
            }
        }
    }

    /// Pod-wide count of live **editor** connections across all
    /// workspaces. Metering signal for the concurrency hard-cap axis.
    pub(crate) async fn active_editor_count(&self) -> u64 {
        let counts = self.workspace_client_counts.read().await;
        counts.values().map(|c| c.editors as u64).sum()
    }

    /// Pod-wide count of live **viewer** connections across all
    /// workspaces. Viewers are free + uncapped; tracked for observability.
    pub(crate) async fn active_viewer_count(&self) -> u64 {
        let counts = self.workspace_client_counts.read().await;
        counts.values().map(|c| c.viewers as u64).sum()
    }

    /// Increment the pod-wide handler-panic counter.
    pub(crate) fn record_panic(&self) {
        self.panic_count.fetch_add(1, Ordering::Relaxed);
    }

    /// Read the pod-wide handler-panic counter.
    pub(crate) fn panic_count(&self) -> u64 {
        self.panic_count.load(Ordering::Relaxed)
    }

    /// Increment the pod-wide write-limiter rejection counter.
    pub(crate) fn record_rate_limit_rejection(&self) {
        self.rate_limit_rejections.fetch_add(1, Ordering::Relaxed);
    }

    /// Read the pod-wide write-limiter rejection counter.
    pub(crate) fn rate_limit_rejections(&self) -> u64 {
        self.rate_limit_rejections.load(Ordering::Relaxed)
    }

    /// Whether `/metrics` should also emit a per-workspace metering
    /// snapshot at debug level.
    pub(crate) fn metering_debug_log(&self) -> bool {
        self.metering_debug_log
    }

    pub(crate) fn binary_persistence(&self) -> bool {
        self.binary_persistence
    }

    pub(crate) fn poison_guard(&self) -> bool {
        self.poison_guard
    }

    /// Accessor for the blob store — used by `/metrics` to read storage
    /// totals and the per-workspace breakdown.
    pub(crate) fn blob_store(&self) -> &Arc<BlobStore> {
        &self.blob_store
    }

    /// The S3/R2 byte store, present only under `backend = "s3"`. Blob
    /// handlers use it to mint presigned URLs and to HEAD/DELETE objects.
    pub(crate) fn s3_backend(&self) -> Option<&Arc<S3Backend>> {
        self.s3.as_ref()
    }

    /// Configured per-request blob size ceiling (`[tenancy.limits]
    /// max_blob_bytes`). The proxy + ingest paths enforce this inline while
    /// buffering (RB-1); the presign path checks the client-asserted size
    /// against it at mint.
    pub(crate) fn max_blob_bytes(&self) -> usize {
        self.tenancy.limits.max_blob_bytes
    }

    /// RB-1b: permit gate bounding concurrent in-memory blob uploads (proxy +
    /// URL-ingest). Handlers acquire one owned permit before buffering.
    pub(crate) fn blob_upload_gate(&self) -> &Arc<tokio::sync::Semaphore> {
        &self.blob_upload_gate
    }

    /// Host allowlist for the generic blob ingest-from-URL endpoint
    /// (`[tenancy.limits] blob_ingest_allowed_hosts`). Empty = endpoint disabled.
    pub(crate) fn blob_ingest_allowed_hosts(&self) -> &[String] {
        &self.tenancy.limits.blob_ingest_allowed_hosts
    }

    /// RB-3: the shared URL-ingest HTTP client (built once at startup with the
    /// SSRF redirect policy). Clone is a cheap `Arc` bump sharing the pool.
    pub(crate) fn ingest_http_client(&self) -> &reqwest::Client {
        &self.ingest_http_client
    }

    /// Snapshot of per-workspace live connection counts (editor/viewer
    /// split), for the metering debug log.
    pub(crate) async fn workspace_conn_snapshot(&self) -> HashMap<WorkspaceId, WorkspaceConnCounts> {
        self.workspace_client_counts.read().await.clone()
    }

    /// JP-120 startup step: seed the blob refcount from the documents
    /// already on disk (so the per-workspace meter is accurate and the
    /// sweep is safe), then reclaim blobs no document references. Keeps
    /// `BlobStore` decoupled from `DocumentStore` — the cross-store wiring
    /// lives here. Best-effort; logs but never fails startup.
    pub(crate) fn backfill_and_sweep_blob_refs(&self) {
        for ws in self.doc_store.known_workspaces() {
            for meta in self.doc_store.list_documents(&ws) {
                if let Ok(doc) = self.doc_store.get_document(&ws, &meta.id) {
                    let hashes = crate::api::blob_refs_from_doc(&doc);
                    if let Err(e) = self.blob_store.seed_doc_refs(&ws, meta.id.as_str(), hashes) {
                        log::warn!(
                            "blob doc-ref seed failed for {}/{}: {}",
                            ws.as_str(),
                            meta.id.as_str(),
                            e
                        );
                    }
                }
            }
        }
        let reclaimed = self.blob_store.sweep_unreferenced();
        if reclaimed > 0 {
            log::info!(
                "JP-120 startup sweep reclaimed {} unreferenced blob ACL(s)",
                reclaimed
            );
        }
    }

    /// Live editor/viewer counts for a single workspace (zero if the
    /// workspace has no connections). Backs the `GET /api/v1/usage`
    /// `active_editors` field (JP-81).
    pub(crate) async fn workspace_conn_for(&self, ws: &WorkspaceId) -> WorkspaceConnCounts {
        self.workspace_client_counts
            .read()
            .await
            .get(ws)
            .copied()
            .unwrap_or_default()
    }

    fn next_client_id(&self) -> u64 {
        self.next_client_id.fetch_add(1, Ordering::Relaxed)
    }

    fn increment_clients(&self) {
        self.client_count.fetch_add(1, Ordering::Relaxed);
    }

    fn decrement_clients(&self) {
        self.client_count.fetch_sub(1, Ordering::Relaxed);
    }

    fn client_count(&self) -> u16 {
        self.client_count.load(Ordering::Relaxed)
    }

    /// Broadcast a message to all clients on a document
    /// Broadcast a doc-scoped frame. Delivered only to clients whose
    /// current workspace AND current doc both match — same-id docs in
    /// different workspaces no longer cross-talk.
    fn broadcast_to_doc(
        &self,
        ws: &WorkspaceId,
        doc_id: &DocId,
        data: Vec<u8>,
        exclude_client: Option<u64>,
    ) {
        let _ = self.broadcast_tx.send(BroadcastMessage {
            target: BroadcastTarget::Doc(ws.clone(), doc_id.clone()),
            exclude_client,
            data,
        });
    }

    /// Broadcast to every authenticated client in one workspace. Used
    /// by DOC_EVENT so a save in workspace `alpha` is announced only
    /// to alpha's connected clients.
    pub(crate) fn broadcast_to_workspace(
        &self,
        ws: &WorkspaceId,
        data: Vec<u8>,
        exclude_client: Option<u64>,
    ) {
        let _ = self.broadcast_tx.send(BroadcastMessage {
            target: BroadcastTarget::Workspace(ws.clone()),
            exclude_client,
            data,
        });
    }

    /// Broadcast to every authenticated client regardless of workspace.
    /// Reserved for future admin / system events; no live caller today.
    #[allow(dead_code)]
    pub(crate) fn broadcast_to_all(&self, data: Vec<u8>, exclude_client: Option<u64>) {
        let _ = self.broadcast_tx.send(BroadcastMessage {
            target: BroadcastTarget::Global,
            exclude_client,
            data,
        });
    }

    // ---- pub(crate) accessors used by the sibling `api` module ----

    pub(crate) fn doc_store(&self) -> &Arc<DocumentStore> {
        &self.doc_store
    }

    /// Authoritative Y.Doc registry (JP-34).
    pub(crate) fn sync_registry(&self) -> &Arc<DocRegistry> {
        &self.sync_registry
    }

    /// Evict the authoritative Y.Doc for `(ws, doc_id)` if no currently
    /// connected client is still joined to it. Called from the disconnect
    /// path and on a doc switch, so a doc's handle is dropped as soon as its
    /// last participant leaves.
    async fn evict_doc_if_unused(&self, ws: &WorkspaceId, doc_id: &DocId) {
        let still_used = {
            let clients = self.clients.read().await;
            clients
                .values()
                .any(|c| &c.current_workspace_id == ws && c.current_doc_id.as_ref() == Some(doc_id))
        };
        if !still_used {
            // JP-36: flush any unsaved edits to JSON before the handle drops.
            if let Some(handle) = self.sync_registry.get(ws, doc_id) {
                self.snapshot_doc(ws, doc_id, &handle);
            }
            self.sync_registry.evict(ws, doc_id);
        }
    }

    /// Flatten one dirty Y.Doc back to its JSON snapshot (JP-36). The flatten
    /// writes every page's shapes (JP-340), but we still gate on the hydrated
    /// active page: no-op if the doc isn't dirty, has no active page, was
    /// deleted, or the stored `activePageId` has diverged from what this handle
    /// hydrated (a divergence sentinel — the body we'd flatten into is no longer
    /// the one we hydrated, so we skip rather than risk clobbering it).
    pub(crate) fn snapshot_doc(&self, ws: &WorkspaceId, doc_id: &DocId, handle: &Arc<DocHandle>) {
        if !handle.take_dirty() {
            return;
        }

        // Poison guard (JP-180 shapes / JP-189 prose): if this snapshot would
        // zero a resident doc's content, copy the prior-good sidecar into the
        // recovery store *before* the binary write below overwrites it. Runs
        // ahead of every persist path so a tombstone-zeroing can't be permanent.
        // We back up + still persist (the relay can't always distinguish poison
        // from a genuine delete), so a real edit still goes through.
        if self.poison_guard {
            let mut reason: Option<String> = None;

            // Shapes (JP-180): prior on-disk N>0 → live 0. The JSON snapshot is
            // the baseline. A legitimate select-all+delete is indistinguishable
            // here and is backed up too.
            if let Ok(prior_json) = self.doc_store.get_document(ws, doc_id) {
                let prior = total_shape_count(&prior_json);
                if suspicious_zeroing(prior, handle.shape_count()) {
                    reason = Some(format!("prior {prior} shapes → 0"));
                }
            }

            // Prose (JP-189): ≥2 prose pages emptied at once — structurally
            // impossible from a real edit (you can only clear one focused
            // editor). Prose has no JSON reference (the relay flattens shapes
            // only), so the baseline is the prior *binary* sidecar.
            if let Some(prior_prose) = self
                .doc_store
                .load_ydoc_binary(ws, doc_id)
                .and_then(|b| prose_count_in_binary(&b))
            {
                let current_prose = handle.prose_count();
                if suspicious_prose_zeroing(prior_prose, current_prose) {
                    let msg = format!(
                        "{prior_prose} prose pages → {current_prose} (≥2 emptied at once)"
                    );
                    reason = Some(match reason {
                        Some(shapes) => format!("{shapes}; {msg}"),
                        None => msg,
                    });
                }
            }

            if let Some(reason) = reason {
                log::error!(
                    "snapshot would zero {}/{} ({reason}); \
                     backing up the prior state to the recovery store first",
                    ws.as_str(),
                    doc_id.as_str(),
                );
                self.doc_store.push_recovery_point(ws, doc_id);
            }
        }

        // JP-108: persist the whole Y.Doc as a binary sidecar *first*, before
        // the JSON path's active-page guards (which can early-return). This
        // captures every shared type — incl. prose — and preserves CRDT
        // identity across evict/rehydrate, independent of the active-page-only
        // JSON flatten below. Tagged with the doc's current serverVersion so a
        // later out-of-band JSON write can be detected on hydrate. Best-effort:
        // a write failure is logged; `dirty` is re-marked at the JSON step's
        // retry, and the next sweep rewrites both.
        if self.binary_persistence {
            let version = self
                .doc_store
                .get_metadata(ws, doc_id)
                .and_then(|m| m.server_version)
                .unwrap_or(0);
            let bytes = handle.encode_binary(version);
            if let Err(e) = self.doc_store.persist_ydoc_binary(ws, doc_id, &bytes) {
                handle.mark_dirty();
                log::warn!(
                    "binary Y.Doc snapshot failed for {}/{}: {} — will retry",
                    ws.as_str(),
                    doc_id.as_str(),
                    e
                );
            }
        }

        let Some(page) = handle.page_id() else { return };
        let mut json = match self.doc_store.get_document(ws, doc_id) {
            Ok(json) => json,
            // Doc deleted out from under us → nothing to persist.
            Err(_) => return,
        };
        // Divergence guard (JP-340): the flatten writes all pages, but we only
        // persist when the stored active page still matches what we hydrated —
        // a mismatch means the JSON body drifted from what's resident (e.g. the
        // active page was deleted, which evicts). Leaves `dirty` cleared so we
        // don't spin; a later edit re-marks it.
        let stored_page = json.get("activePageId").and_then(|v| v.as_str());
        if stored_page != Some(page) {
            log::debug!(
                "snapshot skipped (active page diverged: stored={:?} hydrated={}) {}/{}",
                stored_page,
                page,
                ws.as_str(),
                doc_id.as_str()
            );
            return;
        }
        if !handle.flatten_into(&mut json) {
            // Page object missing in the body — treat like divergence.
            return;
        }
        // JP-278: the flatten above writes shapes + prose but never the
        // top-level `blobReferences` array the relay refcounts against — so a
        // collab-edited doc's file/image blobs would look unreferenced and get
        // GC-reclaimed (and be invisible to JP-232 recovery). Derive the refs
        // from the flattened content, persist them in the body (so a cold
        // reader / reconstruct-from-docs sees them), and update the live
        // refcount (which also fires the JP-232 ledger write).
        let blob_refs = crate::api::collect_blob_references(&json);
        json["blobReferences"] =
            serde_json::Value::Array(blob_refs.iter().cloned().map(serde_json::Value::String).collect());
        if let Err(e) = self
            .blob_store
            .sync_doc_refs(ws, doc_id.as_str(), blob_refs.into_iter().collect())
        {
            log::warn!(
                "JP-278 snapshot blob-ref sync failed for {}/{}: {}",
                ws.as_str(),
                doc_id.as_str(),
                e
            );
        }
        if let Err(e) = self.doc_store.persist_snapshot(ws, json) {
            // Retry on the next tick rather than dropping the edit.
            handle.mark_dirty();
            log::warn!(
                "snapshot persist failed for {}/{}: {} — will retry",
                ws.as_str(),
                doc_id.as_str(),
                e
            );
        }
    }

    /// Snapshot every resident dirty doc (JP-36). Driven by the interval
    /// sweeper and the graceful-shutdown flush.
    pub(crate) fn snapshot_all(&self) {
        for ((ws, doc_id), handle) in self.sync_registry.entries() {
            self.snapshot_doc(&ws, &doc_id, &handle);
        }
    }

    /// JP-231: bound the doc volume to a working-set LRU cache. When the local
    /// document footprint exceeds `max_bytes`, evict the coldest docs that are
    /// **confirmed mirrored to R2** (`mirrored_gen >= local_gen`) and **not
    /// resident** in the sync registry, down to an 85% low-water mark. Evicted
    /// docs keep their index entry and restore from R2 on next touch (JP-200).
    /// `max_bytes == 0` disables eviction. Driven by the snapshot sweeper.
    pub(crate) fn evict_cold_docs_if_over_budget(&self, max_bytes: u64) {
        if max_bytes == 0 {
            return;
        }
        let used = self.doc_store.cache_bytes();
        // Sanity line so the cache footprint is visible in the logs every sweep.
        log::info!(
            "JP-231 doc cache: {} / {} bytes ({} docs resident)",
            used,
            max_bytes,
            self.doc_store.cache_present_count()
        );
        if used <= max_bytes {
            return;
        }
        let low_water = max_bytes / 100 * 85;
        let snapshot = self.doc_store.cache_snapshot();
        let resident: HashSet<(WorkspaceId, DocId)> = self
            .sync_registry
            .entries()
            .into_iter()
            .map(|((ws, doc_id), _)| (ws, doc_id))
            .collect();
        let victims = documents::select_victims(&snapshot, &resident, max_bytes, low_water);
        if victims.is_empty() {
            log::info!(
                "JP-231 doc cache over budget ({} > {} bytes) but no evictable docs \
                 (all resident or pending mirror); auto-extend is the safety net",
                used,
                max_bytes
            );
            return;
        }
        let mut freed = 0u64;
        for (ws, doc_id, _) in &victims {
            freed += self.doc_store.evict_doc_files(ws, doc_id);
        }
        log::info!(
            "JP-231 eviction: dropped {} cold doc(s), freed {} bytes; cache now {} / {} bytes",
            victims.len(),
            freed,
            self.doc_store.cache_bytes(),
            max_bytes
        );
    }

    /// Broadcast a synthetic `DocEvent` to every authenticated client.
    /// Used by REST `/api/docs` write paths so connected sync clients
    /// reload the affected doc — mirrors `handle_doc_save` in the WS path.
    pub(crate) fn emit_doc_event(
        &self,
        ws: &WorkspaceId,
        doc_id: &DocId,
        event_type: DocEventType,
        user_id: Option<String>,
    ) {
        let metadata = self.doc_store.get_metadata(ws, doc_id);
        let event = DocEvent {
            event_type,
            doc_id: doc_id.clone(),
            metadata,
            user_id: user_id.unwrap_or_else(|| "system".to_string()),
        };
        if let Ok(data) = encode_message(MESSAGE_DOC_EVENT, &event) {
            // DOC_EVENT carries DocumentMetadata (name, shares, owner) —
            // scope to the originating workspace so beta's clients
            // don't see alpha's saves.
            self.broadcast_to_workspace(ws, data, None);
        }
    }
}

/// WebSocket server manager
pub struct WebSocketServer {
    /// Whether the server is currently running
    running: Arc<AtomicBool>,
    /// The port the server is running on (0 if not running)
    port: Arc<AtomicU16>,
    /// Shutdown signal sender
    shutdown_tx: RwLock<Option<tokio::sync::oneshot::Sender<()>>>,
    /// Server state for connected clients
    state: Arc<RwLock<Option<Arc<ServerState>>>>,
    /// Server configuration
    config: RwLock<ServerConfig>,
    /// App data directory for document storage
    app_data_dir: RwLock<Option<PathBuf>>,
    /// Blob byte-storage config (`[storage]`): backend selector + S3/R2
    /// connection details. Set via [`set_storage`] before [`start`].
    storage: RwLock<StorageConfig>,
    /// OIDC auth bundle (JWKS cache + revocation set + validator
    /// config). Set via [`set_auth`] before [`start`]; the cache's
    /// background refresh task is owned by `main.rs`.
    auth: RwLock<Option<OidcAuthState>>,
    /// Optional shared secret for the revocation push endpoint.
    revocation_push_bearer: RwLock<Option<String>>,
    /// Region this relay runs in (e.g. `yyz`). Used to enforce
    /// `wsp[].region` matching on inbound tokens.
    relay_region: RwLock<String>,
    /// Tenancy + per-workspace limits (Phase 21.3 + 21.5).
    tenancy: RwLock<TenancyConfig>,
    /// Persistence (JP-36): snapshot-sweeper cadence. Read in `start()`.
    sync_config: RwLock<SyncConfig>,
    /// Handle to the JP-36 snapshot sweeper task, aborted on `stop()` after the
    /// final flush.
    snapshot_task: RwLock<Option<tokio::task::JoinHandle<()>>>,
    /// Shared per-workspace write limiter; lazily constructed by
    /// `build_write_limiter`. Both `ServerState` (WS path) and
    /// `McpServer` (MCP path) hold an `Arc` to the same instance so
    /// per-tenant accounting is consistent across subsystems.
    /// Phase 21.3.
    write_limiter: RwLock<Option<Arc<WorkspaceWriteLimiter>>>,
    /// Shared panic counter handed out to subsystems (MCP) and read
    /// by `/metrics`. Constructed once per `WebSocketServer` instance
    /// so the relay binary's `WebSocketServer` and `McpServer` see
    /// the same atomic. Phase 21.2.
    panic_count: Arc<AtomicU64>,
    /// Shared per-workspace write-limiter rejection counter. Incremented
    /// whenever a CRDT/MCP write is throttled by the token bucket, and
    /// read by `/metrics`. Same shared-`Arc` pattern as `panic_count` so
    /// WS and MCP rejections aggregate into one pod-level counter. This
    /// is the observability signal for the internal save/write fair-use
    /// rate limit (not a billed axis).
    rate_limit_rejections: Arc<AtomicU64>,
    /// When true, each `/metrics` scrape also logs a per-workspace
    /// metering snapshot at debug level. Mirrors
    /// `config.observability.metering_debug_log`; set before `start()`.
    metering_debug_log: AtomicBool,
    /// MCP-owned state for folding `/mcp` onto this public listener
    /// (JP-210, `[mcp] expose = "public"`). Set via
    /// [`set_mcp_public_mount`] before `start()`; `start()` takes it and
    /// merges the MCP router into the main router before binding. `None`
    /// (the default, and in every test) leaves the public surface
    /// MCP-free — the loopback `McpServer` is the only path.
    mcp_public_mount: RwLock<Option<crate::mcp::PublicMount>>,
    /// DEBUG-only panic-injection trigger; see ServerState.
    #[cfg(debug_assertions)]
    panic_tenant_trigger: RwLock<Option<WorkspaceId>>,
}

impl Default for WebSocketServer {
    fn default() -> Self {
        Self::new()
    }
}

impl WebSocketServer {
    pub fn new() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            port: Arc::new(AtomicU16::new(0)),
            shutdown_tx: RwLock::new(None),
            state: Arc::new(RwLock::new(None)),
            config: RwLock::new(ServerConfig::default()),
            app_data_dir: RwLock::new(None),
            storage: RwLock::new(StorageConfig::default()),
            auth: RwLock::new(None),
            revocation_push_bearer: RwLock::new(None),
            relay_region: RwLock::new("default".to_string()),
            tenancy: RwLock::new(TenancyConfig::default()),
            sync_config: RwLock::new(SyncConfig::default()),
            snapshot_task: RwLock::new(None),
            write_limiter: RwLock::new(None),
            panic_count: Arc::new(AtomicU64::new(0)),
            rate_limit_rejections: Arc::new(AtomicU64::new(0)),
            metering_debug_log: AtomicBool::new(false),
            mcp_public_mount: RwLock::new(None),
            #[cfg(debug_assertions)]
            panic_tenant_trigger: RwLock::new(None),
        }
    }

    /// Provide the MCP-owned state so `start()` folds `/mcp` + the RFC 9728
    /// discovery doc onto this public listener (JP-210). Must precede
    /// `start()`. Only the relay binary, when `[mcp] expose = "public"`, calls
    /// this; leaving it unset (the default) keeps MCP off the public surface.
    pub async fn set_mcp_public_mount(&self, mount: crate::mcp::PublicMount) {
        *self.mcp_public_mount.write().await = Some(mount);
    }

    /// Enable/disable the per-workspace metering debug-log on each
    /// `/metrics` scrape. Called during startup from
    /// `config.observability.metering_debug_log`. Must precede `start()`.
    pub fn set_metering_debug_log(&self, enabled: bool) {
        self.metering_debug_log.store(enabled, Ordering::Relaxed);
    }

    /// Replace the tenancy config (called during startup from
    /// `relay.toml` + CLI overrides). Must be called before `start()`.
    pub async fn set_tenancy(&self, tenancy: TenancyConfig) {
        *self.tenancy.write().await = tenancy;
    }

    /// Replace the persistence config (JP-36). Must precede `start()`.
    pub async fn set_sync_config(&self, sync: SyncConfig) {
        *self.sync_config.write().await = sync;
    }

    /// Get-or-build the shared per-workspace write limiter from the
    /// current tenancy limits. `main.rs` calls this *before* `start()`
    /// to hand the same `Arc` to `McpServer::new`; `start()` then
    /// reuses the cached value so both subsystems meter against one
    /// bucket. Phase 21.3.
    pub async fn build_write_limiter(&self) -> Arc<WorkspaceWriteLimiter> {
        {
            let cached = self.write_limiter.read().await;
            if let Some(l) = cached.as_ref() {
                return l.clone();
            }
        }
        let limits = self.tenancy.read().await.limits.clone();
        let fresh = Arc::new(build_workspace_limiter(
            limits.writes_per_sec,
            limits.writes_burst,
        ));
        *self.write_limiter.write().await = Some(fresh.clone());
        fresh
    }

    /// Handle to the shared panic counter. Used by `main.rs` to wire
    /// the same atomic into the MCP server so both subsystems' panics
    /// surface at the WS `/metrics` endpoint. Phase 21.2.
    pub fn panic_counter_handle(&self) -> Arc<AtomicU64> {
        self.panic_count.clone()
    }

    /// Handle to the shared write-limiter rejection counter. Wired into
    /// the MCP server (same as `panic_counter_handle`) so MCP write
    /// throttles and WS write throttles increment one atomic.
    pub fn rate_limit_rejections_handle(&self) -> Arc<AtomicU64> {
        self.rate_limit_rejections.clone()
    }

    /// Handle to the authoritative Y.Doc registry (JP-34). Lives on
    /// `ServerState`, so this is valid only **after** `start()`. `main.rs`
    /// hands it to `McpServer::new` so MCP shape writes hit the same live
    /// docs the WS path serves (JP-35).
    pub async fn sync_registry_handle(&self) -> Arc<DocRegistry> {
        self.state
            .read()
            .await
            .as_ref()
            .expect("sync_registry_handle() requires start() first")
            .sync_registry
            .clone()
    }

    /// A synchronous sink that broadcasts a framed CRDT update to the clients
    /// joined to `(workspace, doc)` — the relay-originated counterpart of an
    /// inbound SYNC frame's rebroadcast. Wired into the MCP write path so an
    /// MCP-authored change reaches connected editors as a normal sync frame
    /// they merge (no reload). Valid only after `start()`. JP-35.
    pub async fn doc_update_broadcaster(
        &self,
    ) -> Arc<dyn Fn(&WorkspaceId, &DocId, Vec<u8>) + Send + Sync> {
        let tx = self
            .state
            .read()
            .await
            .as_ref()
            .expect("doc_update_broadcaster() requires start() first")
            .broadcast_tx
            .clone();
        Arc::new(move |ws: &WorkspaceId, doc_id: &DocId, framed: Vec<u8>| {
            let _ = tx.send(BroadcastMessage {
                target: BroadcastTarget::Doc(ws.clone(), doc_id.clone()),
                exclude_client: None,
                data: framed,
            });
        })
    }

    /// DEBUG-only: set the workspace-id whose handlers should panic on
    /// entry. Called by the relay binary's `--panic-tenant` flag.
    /// No-op (and the trigger field doesn't exist) in release builds.
    #[cfg(debug_assertions)]
    pub async fn set_panic_tenant(&self, trigger: Option<WorkspaceId>) {
        *self.panic_tenant_trigger.write().await = trigger;
    }

    /// Set the app data directory (called during Tauri setup)
    pub async fn set_app_data_dir(&self, dir: PathBuf) {
        *self.app_data_dir.write().await = Some(dir);
    }

    /// Set the blob storage config (backend selector + S3/R2 details). Called
    /// during startup from `relay.toml` + `RELAY_*` overrides; must precede
    /// `start()` so the byte store is built when `ServerState` is created.
    pub async fn set_storage(&self, storage: StorageConfig) {
        *self.storage.write().await = storage;
    }

    /// Install the OIDC auth bundle. Must be called before `start()`.
    /// JP-77.
    pub async fn set_auth(&self, auth: OidcAuthState) {
        *self.auth.write().await = Some(auth);
    }

    /// Configure the shared secret authenticating the revocation push
    /// endpoint. Pass `None` to disable the push transport.
    pub async fn set_revocation_push_bearer(&self, bearer: Option<String>) {
        *self.revocation_push_bearer.write().await = bearer;
    }

    /// Set the region this relay pod runs in (e.g. `yyz`). Defaults to
    /// `"default"` for self-hosters who don't care about multi-region.
    pub async fn set_relay_region(&self, region: String) {
        *self.relay_region.write().await = region;
    }

    /// Snapshot the auth bundle. `main.rs` uses this to hand the same
    /// validator to `McpServer::new` so MCP and WS verify the same
    /// tokens against the same JWKS + revocation set.
    pub async fn current_auth(&self) -> Option<OidcAuthState> {
        self.auth.read().await.clone()
    }

    /// Check if the server is currently running
    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::Relaxed)
    }

    /// Get the current server configuration
    pub async fn get_config(&self) -> ServerConfig {
        self.config.read().await.clone()
    }

    /// Update server configuration (only when not running)
    pub async fn set_config(&self, config: ServerConfig) -> Result<(), String> {
        if self.is_running() {
            return Err("Cannot change configuration while server is running".to_string());
        }
        *self.config.write().await = config;
        Ok(())
    }

    /// Get the current server status
    pub async fn status(&self) -> ServerStatus {
        let port = self.port.load(Ordering::Relaxed);
        let running = self.running.load(Ordering::Relaxed);
        let config = self.config.read().await;

        let state_guard = self.state.read().await;
        let connected_clients = state_guard
            .as_ref()
            .map(|s| s.client_count() as usize)
            .unwrap_or(0);

        // Build list of available addresses
        let mut addresses = Vec::new();

        if running {
            match config.network_mode {
                NetworkMode::Localhost => {
                    addresses.push(format!("ws://localhost:{}", port));
                    addresses.push(format!("ws://127.0.0.1:{}", port));
                }
                NetworkMode::Lan => {
                    addresses.push(format!("ws://localhost:{}", port));
                    for ip in get_local_ips() {
                        addresses.push(format!("ws://{}:{}", ip, port));
                    }
                }
            }
        }

        let primary_address = if running {
            match config.network_mode {
                NetworkMode::Localhost => format!("ws://localhost:{}", port),
                NetworkMode::Lan => {
                    get_local_ips()
                        .first()
                        .map(|ip| format!("ws://{}:{}", ip, port))
                        .unwrap_or_else(|| format!("ws://localhost:{}", port))
                }
            }
        } else {
            String::new()
        };

        ServerStatus {
            running,
            port,
            connected_clients,
            address: primary_address,
            addresses,
            network_mode: config.network_mode,
            max_connections: config.max_connections,
        }
    }

    /// Start the WebSocket server on the specified port
    pub async fn start(&self, port: u16) -> Result<String, String> {
        if self.is_running() {
            return Err("Server is already running".to_string());
        }

        // Update config with the requested port
        {
            let mut config = self.config.write().await;
            config.port = port;
        }

        let config = self.config.read().await.clone();

        // Get app data directory
        let app_data_dir = self.app_data_dir.read().await
            .clone()
            .ok_or("App data directory not set")?;

        let auth = self
            .auth
            .read()
            .await
            .clone()
            .ok_or("OIDC auth not configured — call set_auth() before start()")?;
        let revocation_push_bearer = self.revocation_push_bearer.read().await.clone();
        let relay_region = self.relay_region.read().await.clone();

        let panic_count = self.panic_count.clone();
        let rate_limit_rejections = self.rate_limit_rejections.clone();
        let metering_debug_log = self.metering_debug_log.load(Ordering::Relaxed);
        let binary_persistence = self.sync_config.read().await.binary_persistence;
        let poison_guard = self.sync_config.read().await.poison_guard;
        let tenancy = self.tenancy.read().await.clone();
        let storage = self.storage.read().await.clone();
        // Reuse the cached limiter so MCP and WS share one bucket.
        let write_limiter = self.build_write_limiter().await;
        #[cfg(debug_assertions)]
        let panic_tenant_trigger = self.panic_tenant_trigger.read().await.clone();

        // Create server state with document store
        let server_state = Arc::new(ServerState::new(
            app_data_dir,
            storage,
            auth,
            revocation_push_bearer,
            relay_region,
            tenancy,
            write_limiter,
            panic_count,
            rate_limit_rejections,
            metering_debug_log,
            binary_persistence,
            poison_guard,
            #[cfg(debug_assertions)]
            panic_tenant_trigger,
        ));

        // JP-120: seed the blob refcount from the documents already on disk,
        // then sweep orphaned blobs. Done once at startup before serving.
        server_state.backfill_and_sweep_blob_refs();

        *self.state.write().await = Some(server_state.clone());

        // JP-36: spawn the snapshot sweeper that periodically flattens dirty
        // Y.Docs back to their JSON snapshots. `0` disables the timer (eviction
        // + shutdown flushes still run). Aborted on `stop()` after a final flush.
        let snapshot_interval_secs = self.sync_config.read().await.snapshot_interval_secs;
        let doc_cache_max_bytes = self.sync_config.read().await.doc_cache_max_bytes;
        // Whether deferred blob-GC (JP-127) is on. If so the sweeper must run so
        // grace-elapsed orphans get reclaimed on a cadence — otherwise
        // `reclaim_expired_orphans` only fires on the next incidental blob op or a
        // restart, so orphans from the *last* op (a doc delete / move-to-personal,
        // or an abandoned to-Cloud transfer that uploaded blobs but never
        // committed a doc-ref) linger indefinitely.
        let gc_grace_secs = server_state.blob_store.gc_grace_secs();
        // Run the sweeper if snapshots OR JP-231 eviction OR deferred GC is on.
        // When snapshots are off (interval 0) tick on a default cadence so the
        // cache stays bounded and orphans still get reclaimed.
        const DEFAULT_SWEEP_INTERVAL_SECS: u64 = 30;
        if snapshot_interval_secs > 0 || doc_cache_max_bytes > 0 || gc_grace_secs > 0 {
            let tick_secs = if snapshot_interval_secs > 0 {
                snapshot_interval_secs
            } else {
                DEFAULT_SWEEP_INTERVAL_SECS
            };
            let sweeper_state = server_state.clone();
            let handle = tokio::spawn(async move {
                let mut ticker =
                    tokio::time::interval(std::time::Duration::from_secs(tick_secs));
                // Skip the immediate first tick; nothing is dirty at startup.
                ticker.tick().await;
                loop {
                    ticker.tick().await;
                    // Flatten dirty Y.Docs first (JP-36), then reclaim cold,
                    // R2-confirmed docs from the volume cache (JP-231).
                    if snapshot_interval_secs > 0 {
                        sweeper_state.snapshot_all();
                    }
                    sweeper_state.evict_cold_docs_if_over_budget(doc_cache_max_bytes);
                    // JP-127 follow-up: reclaim deferred orphans whose grace has
                    // elapsed (no-op when grace is 0 or nothing is pending).
                    let reclaimed = sweeper_state.blob_store.reclaim_expired_orphans();
                    if reclaimed > 0 {
                        log::info!("sweeper reclaimed {} expired orphan blob(s)", reclaimed);
                    }
                }
            });
            *self.snapshot_task.write().await = Some(handle);
        }

        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();

        {
            let mut tx = self.shutdown_tx.write().await;
            *tx = Some(shutdown_tx);
        }

        // Create CORS layer
        let cors = CorsLayer::new()
            .allow_origin(Any)
            .allow_methods(Any)
            .allow_headers(Any);

        // JP-210: when a public MCP mount was provided (`[mcp] expose =
        // "public"`), build the MCP router from the mount + this server's
        // post-start shared handles, so `/mcp` rides this listener's origin
        // and TLS. Built before `server_state` is moved into the WS router's
        // state; the MCP path reuses the same `Arc`s (one write-limiter bucket,
        // one panic counter, one live Y.Doc registry) the WS path holds.
        let mcp_public_router = match self.mcp_public_mount.write().await.take() {
            Some(mount) => {
                let tx = server_state.broadcast_tx.clone();
                let on_doc_update: Arc<crate::mcp::tools::OnDocUpdate> =
                    Arc::new(move |ws: &WorkspaceId, doc_id: &DocId, framed: Vec<u8>| {
                        let _ = tx.send(BroadcastMessage {
                            target: BroadcastTarget::Doc(ws.clone(), doc_id.clone()),
                            exclude_client: None,
                            data: framed,
                        });
                    });
                let shared = crate::mcp::McpSharedHandles {
                    doc_store: server_state.doc_store.clone(),
                    panic_counter: server_state.panic_count.clone(),
                    rate_limit_rejections: server_state.rate_limit_rejections.clone(),
                    write_limiter: server_state.write_limiter.clone(),
                    auth: server_state.auth.clone(),
                    relay_region: server_state.relay_region.clone(),
                    sync_registry: server_state.sync_registry.clone(),
                    on_doc_update,
                };
                log::info!("MCP endpoint folded onto the public HTTP listener at /mcp (expose=public)");
                Some(mount.into_public_router(shared))
            }
            None => None,
        };

        // Create router with WebSocket + blob endpoints, merged with
        // the REST surface defined in `crate::api`.
        let mut app = Router::new()
            .route("/ws", get(ws_handler))
            .route("/health", get(health_handler))
            .route("/version", get(version_handler))
            .route("/metrics", get(metrics_handler))
            // RB-1: the proxy upload buffers the body inline with an explicit
            // `max_blob_bytes` cap + the RB-1b concurrency gate (see
            // `blob_upload_handler`), so no `DefaultBodyLimit` layer is needed.
            .route("/api/blobs/:hash", post(blob_upload_handler))
            .route("/api/blobs/:hash", get(blob_download_handler))
            .route("/api/blobs/:hash", head(blob_exists_handler))
            .merge(crate::api::routes())
            .with_state(server_state);
        if let Some(mcp_router) = mcp_public_router {
            app = app.merge(mcp_router);
        }
        let app = app.layer(cors);

        // Bind address based on network mode
        let bind_addr = match config.network_mode {
            NetworkMode::Localhost => format!("127.0.0.1:{}", port),
            NetworkMode::Lan => format!("0.0.0.0:{}", port),
        };

        let listener = tokio::net::TcpListener::bind(&bind_addr)
            .await
            .map_err(|e| format!("Failed to bind to {}: {}", bind_addr, e))?;

        let actual_port = listener
            .local_addr()
            .map_err(|e| format!("Failed to get local address: {}", e))?
            .port();

        // Update state
        self.running.store(true, Ordering::Relaxed);
        self.port.store(actual_port, Ordering::Relaxed);

        let mode_str = match config.network_mode {
            NetworkMode::Localhost => "localhost only",
            NetworkMode::Lan => "LAN access enabled",
        };
        log::info!("WebSocket server starting on port {} ({})", actual_port, mode_str);

        // Spawn the server task
        let running = self.running.clone();
        let port_atomic = self.port.clone();

        tokio::spawn(async move {
            let server = axum::serve(listener, app);

            tokio::select! {
                result = server => {
                    if let Err(e) = result {
                        log::error!("Server error: {}", e);
                    }
                }
                _ = shutdown_rx => {
                    log::info!("Server shutdown signal received");
                }
            }

            running.store(false, Ordering::Relaxed);
            port_atomic.store(0, Ordering::Relaxed);
            log::info!("WebSocket server stopped");
        });

        // Return the primary address
        let primary_address = match config.network_mode {
            NetworkMode::Localhost => format!("ws://localhost:{}", actual_port),
            NetworkMode::Lan => {
                get_local_ips()
                    .first()
                    .map(|ip| format!("ws://{}:{}", ip, actual_port))
                    .unwrap_or_else(|| format!("ws://localhost:{}", actual_port))
            }
        };

        Ok(primary_address)
    }

    /// Stop the WebSocket server
    pub async fn stop(&self) -> Result<(), String> {
        if !self.is_running() {
            return Ok(());
        }

        let mut tx = self.shutdown_tx.write().await;
        if let Some(shutdown_tx) = tx.take() {
            let _ = shutdown_tx.send(());
        }

        // JP-36: final durability flush before tearing state down, then stop
        // the sweeper. Runs on graceful shutdown (SIGINT/SIGTERM via main.rs)
        // so a redeploy doesn't lose edits between snapshot ticks.
        if let Some(state) = self.state.read().await.as_ref() {
            state.snapshot_all();
            // JP-200: drain the R2 doc-mirror queue so a graceful shutdown flushes
            // pending uploads. The Flush sentinel acks only after every prior op
            // (incl. the snapshots just enqueued) is processed; bounded by a
            // timeout so a slow R2 can't blow the SIGTERM grace.
            if let Some(tx) = state.doc_mirror_sender() {
                let (ack_tx, ack_rx) = tokio::sync::oneshot::channel();
                if tx.send(MirrorOp::Flush(ack_tx)).is_ok() {
                    let _ =
                        tokio::time::timeout(std::time::Duration::from_secs(3), ack_rx).await;
                }
            }
        }
        if let Some(handle) = self.snapshot_task.write().await.take() {
            handle.abort();
        }

        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;

        self.running.store(false, Ordering::Relaxed);
        self.port.store(0, Ordering::Relaxed);
        *self.state.write().await = None;

        log::info!("WebSocket server stop requested");
        Ok(())
    }

    /// Get the document store (for direct access)
    pub async fn get_doc_store(&self) -> Option<Arc<DocumentStore>> {
        self.state.read().await.as_ref().map(|s| s.doc_store.clone())
    }

    /// JP-200: the document-mirror sender from the running `ServerState`, shared
    /// into the MCP server's separate `DocumentStore` so MCP-authored docs are
    /// mirrored to R2 too. `None` before `start()` or on the filesystem backend.
    pub async fn doc_mirror_sender(&self) -> Option<mpsc::UnboundedSender<MirrorOp>> {
        self.state
            .read()
            .await
            .as_ref()
            .and_then(|s| s.doc_mirror_sender())
    }

    /// Broadcast a document event to all connected clients
    /// Used when documents are saved via Tauri commands (not WebSocket)
    pub async fn broadcast_doc_event(
        &self,
        ws: &WorkspaceId,
        doc_id: &DocId,
        event_type: DocEventType,
        user_id: Option<String>,
    ) {
        let state_guard = self.state.read().await;
        if let Some(state) = state_guard.as_ref() {
            let metadata = state.doc_store.get_metadata(ws, doc_id);
            let event = DocEvent {
                event_type,
                doc_id: doc_id.clone(),
                metadata,
                user_id: user_id.unwrap_or_else(|| "system".to_string()),
            };

            if let Ok(event_data) = encode_message(MESSAGE_DOC_EVENT, &event) {
                state.broadcast_to_workspace(ws, event_data, None);
                log::info!(
                    "Broadcast doc event: {:?} for {}/{}",
                    event_type,
                    ws.as_str(),
                    doc_id.as_str()
                );
            }
        }
    }
}

/// Health check endpoint. Intentionally a bare `OK` (not JSON) — Fly/LB
/// liveness checks match on it; build identity lives at `/version`.
async fn health_handler() -> impl IntoResponse {
    "OK"
}

/// Build-identity endpoint. Unauthenticated (like `/health`) so an operator can
/// curl which build a pod is running. Reports the crate SemVer + the git SHA /
/// build time stamped in by `build.rs`. Under promote-don't-rebuild the binary
/// keeps its build-time identity (a `-beta.N` pre-release); the clean `X.Y.Z` is
/// the registry promotion tag, not something the binary re-stamps.
async fn version_handler() -> impl IntoResponse {
    axum::Json(serde_json::json!({
        "server": "docushark-relay",
        "version": crate::build_info::VERSION,
        "commit": crate::build_info::GIT_SHA,
        "built": crate::build_info::BUILD_TIME,
        "protocolVersion": PROTOCOL_VERSION,
    }))
}

/// Prometheus metrics endpoint. Hand-rolled exposition format — no
/// `prometheus` crate dep until we have more than a handful of
/// metrics. Phase 21.2.
async fn metrics_handler(State(state): State<Arc<ServerState>>) -> impl IntoResponse {
    let jwks = state.auth().jwks.metrics().await;
    let revocation_set_size = state.auth().revocations.len();
    let cache_age = jwks
        .cache_age_seconds
        .map(|s| s.to_string())
        // -1 sentinel = no successful fetch yet (Prometheus has no NaN
        // for gauges in the text format we emit by hand).
        .unwrap_or_else(|| "-1".to_string());

    // Metering observability signals (storage axis + concurrency cap +
    // write fair-use throttle). Pod-level aggregates only — per-workspace
    // detail goes out the usage webhook, never as Prometheus labels, to
    // keep cardinality bounded at the multi-tenant pod target.
    let storage_bytes = state.blob_store.get_total_size();
    let active_editors = state.active_editor_count().await;
    let active_viewers = state.active_viewer_count().await;
    let rate_limit_rejections = state.rate_limit_rejections();

    // Opt-in per-workspace breakdown at debug level. Pod-level series go
    // on the wire below regardless; the per-workspace detail stays in
    // logs (never as Prometheus labels) to keep scrape cardinality
    // bounded. Raw counts only — quota/billing interpretation lives in
    // the control plane, not the relay.
    if state.metering_debug_log() {
        let sizes = state.blob_store().iter_workspace_sizes();
        let conns = state.workspace_conn_snapshot().await;
        let mut workspaces: std::collections::HashSet<&WorkspaceId> = sizes.keys().collect();
        workspaces.extend(conns.keys());
        for ws in workspaces {
            let bytes = sizes.get(ws).copied().unwrap_or(0);
            let c = conns.get(ws).copied().unwrap_or_default();
            log::debug!(
                "metering workspace_id={} storage_bytes={} editors={} viewers={}",
                ws.as_str(),
                bytes,
                c.editors,
                c.viewers,
            );
        }
    }

    let body = format!(
        "# HELP relay_build_info Relay build identity (always 1; read the labels).\n\
         # TYPE relay_build_info gauge\n\
         relay_build_info{{version=\"{version}\",commit=\"{commit}\"}} 1\n\
         # HELP relay_handler_panics_total Total handler panics caught at the per-message boundary.\n\
         # TYPE relay_handler_panics_total counter\n\
         relay_handler_panics_total {panics}\n\
         # HELP relay_jwks_cache_age_seconds Seconds since the last successful JWKS fetch (-1 = never).\n\
         # TYPE relay_jwks_cache_age_seconds gauge\n\
         relay_jwks_cache_age_seconds {cache_age}\n\
         # HELP relay_jwks_refresh_failures_total JWKS refresh attempts that failed.\n\
         # TYPE relay_jwks_refresh_failures_total counter\n\
         relay_jwks_refresh_failures_total {jwks_failures}\n\
         # HELP relay_jwks_keys Number of signing keys currently cached.\n\
         # TYPE relay_jwks_keys gauge\n\
         relay_jwks_keys {jwks_keys}\n\
         # HELP relay_revocation_set_size Number of revoked JTIs held in memory.\n\
         # TYPE relay_revocation_set_size gauge\n\
         relay_revocation_set_size {revocation_set_size}\n\
         # HELP relay_storage_bytes_total Pod-wide blob bytes stored (the metered storage axis; deduped on disk).\n\
         # TYPE relay_storage_bytes_total gauge\n\
         relay_storage_bytes_total {storage_bytes}\n\
         # HELP relay_active_editors_total Live editor (read-write) connections across all workspaces.\n\
         # TYPE relay_active_editors_total gauge\n\
         relay_active_editors_total {active_editors}\n\
         # HELP relay_active_viewers_total Live viewer (read-only) connections across all workspaces; free + uncapped.\n\
         # TYPE relay_active_viewers_total gauge\n\
         relay_active_viewers_total {active_viewers}\n\
         # HELP relay_rate_limit_rejections_total Write frames (CRDT + MCP) throttled by the per-workspace fair-use limiter.\n\
         # TYPE relay_rate_limit_rejections_total counter\n\
         relay_rate_limit_rejections_total {rate_limit_rejections}\n",
        version = crate::build_info::VERSION,
        commit = crate::build_info::GIT_SHA,
        panics = state.panic_count(),
        jwks_failures = jwks.refresh_failures_total,
        jwks_keys = jwks.key_count,
    );
    (
        [(header::CONTENT_TYPE, "text/plain; version=0.0.4")],
        body,
    )
}

// ============ Blob HTTP Endpoints ============

/// Extract + validate the bearer JWT from a request. Returns the
/// validated claims, or a ready-to-build 401 response.
async fn extract_jwt_from_headers(
    headers: &HeaderMap,
    state: &Arc<ServerState>,
) -> Result<OidcClaims, (StatusCode, String)> {
    let auth_header = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .ok_or((StatusCode::UNAUTHORIZED, "Missing Authorization header".to_string()))?;

    if !auth_header.starts_with("Bearer ") {
        return Err((StatusCode::UNAUTHORIZED, "Invalid Authorization header format".to_string()));
    }

    let token = auth_header[7..].trim();
    state
        .auth()
        .validate(token)
        .await
        .map_err(|e| auth_error_to_http(&e))
}

/// Map an `AuthError` to the same opacity contract the WS path uses:
/// 401 for anything signature/claim-related, 403 for region/workspace.
pub(crate) fn auth_error_to_http(e: &AuthError) -> (StatusCode, String) {
    let status = match e {
        AuthError::WorkspaceMismatch | AuthError::RegionMismatch => StatusCode::FORBIDDEN,
        _ => StatusCode::UNAUTHORIZED,
    };
    (status, format!("invalid token: {}", e))
}

/// Resolve the workspace this blob request is authenticated to and
/// apply the configured `[tenancy]` mode. Returns either the workspace
/// to scope the blob op to, or a pre-built 403 response with an opaque
/// "forbidden" body — same opacity contract as `api.rs::resolve_workspace`.
fn resolve_blob_workspace(
    state: &Arc<ServerState>,
    claims: &OidcClaims,
    requested: Option<&str>,
) -> Result<(WorkspaceId, ClaimLimits), axum::response::Response> {
    let (ws, _role, limits) =
        match WorkspaceId::from_oidc_array(claims, requested, state.relay_region()) {
            Ok(v) => v,
            Err(_) => {
                return Err((StatusCode::FORBIDDEN, "forbidden".to_string()).into_response());
            }
        };
    if state.check_tenancy(&ws).is_err() {
        return Err((StatusCode::FORBIDDEN, "forbidden".to_string()).into_response());
    }
    Ok((ws, limits))
}

/// Upload a blob (POST /api/blobs/:hash)
async fn blob_upload_handler(
    Path(hash): Path<String>,
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    body: Body,
) -> impl IntoResponse {
    // Validate JWT
    let claims = match extract_jwt_from_headers(&headers, &state).await {
        Ok(c) => c,
        Err((status, msg)) => return (status, msg).into_response(),
    };
    let (ws, claim_limits) = match resolve_blob_workspace(&state, &claims, None) {
        Ok(w) => w,
        Err(resp) => return resp,
    };

    // RB-1b (JP-299): acquire a permit *before* buffering the body so a burst of
    // concurrent uploads can't OOM the pod — worst-case upload RAM is bounded to
    // `max_concurrent_blob_uploads × max_blob_bytes`. The permit is held until
    // this handler returns (covers the buffer + the store write).
    let _permit = match state.blob_upload_gate().clone().acquire_owned().await {
        Ok(p) => p,
        Err(_) => {
            return (StatusCode::SERVICE_UNAVAILABLE, "upload gate unavailable".to_string())
                .into_response()
        }
    };

    // RB-1: buffer the request body with an explicit `max_blob_bytes` cap.
    // `to_bytes` stops reading once the cap is exceeded, so memory is bounded to
    // ~max even if the client lies about Content-Length (replaces the former
    // `DefaultBodyLimit` layer on this route).
    let body = match axum::body::to_bytes(body, state.max_blob_bytes()).await {
        Ok(b) => b,
        Err(_) => {
            return (StatusCode::PAYLOAD_TOO_LARGE, "blob exceeds max size".to_string())
                .into_response()
        }
    };

    // Extract MIME type from Content-Type header (default to application/octet-stream)
    let mime_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();

    let quota = state.resolve_limits(claim_limits).quota_bytes;

    // s3 backend: proxy the bytes straight to object storage, then record the
    // blob (the back half of finalize). Keeps the proxy upload coherent with the
    // 302 download — a local filesystem write would 404 on the R2 redirect — so
    // a client that can't do the presigned direct PUT still works end-to-end.
    if let Some(s3) = state.s3_backend() {
        // We hold the bytes here, so verify the content hash — the integrity
        // check the presigned path can't perform.
        let actual = BlobStore::compute_hash(&body);
        if actual != hash {
            return (
                StatusCode::BAD_REQUEST,
                format!("Hash mismatch: expected {hash}, got {actual}"),
            )
                .into_response();
        }
        if state.blob_store.exists(&ws, &hash) {
            let size = state
                .blob_store
                .get_metadata(&ws, &hash)
                .map(|m| m.size)
                .unwrap_or(body.len() as u64);
            return (
                StatusCode::OK,
                axum::Json(serde_json::json!({
                    "success": true, "hash": hash, "size": size, "mimeType": mime_type,
                })),
            )
                .into_response();
        }
        if let Some(q) = quota {
            if state
                .blob_store
                .get_workspace_size(&ws)
                .saturating_add(body.len() as u64)
                > q
            {
                return (StatusCode::INSUFFICIENT_STORAGE, "storage quota exceeded".to_string())
                    .into_response();
            }
        }
        if let Err(e) = s3.put_object(&ws, &hash, body.to_vec(), &mime_type).await {
            log::warn!("proxy upload to object storage failed for {}/{}: {}", ws.as_str(), hash, e);
            return (StatusCode::BAD_GATEWAY, "blob store unavailable".to_string()).into_response();
        }
        return match state
            .blob_store
            .record_finalized_blob(&ws, &hash, body.len() as u64, &mime_type, &claims.sub)
        {
            Ok(meta) => (
                StatusCode::OK,
                axum::Json(serde_json::json!({
                    "success": true, "hash": meta.hash, "size": meta.size, "mimeType": meta.mime_type,
                })),
            )
                .into_response(),
            Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
        };
    }

    // Filesystem backend: save bytes locally with hash verification + per-workspace
    // storage quota (JP-81) — grants ACL to the uploading workspace. Quota = claim
    // value else config fallback; `None` = unlimited.
    match state
        .blob_store
        .save_blob_with_quota(&ws, &hash, &body, &mime_type, &claims.sub, quota)
    {
        Ok(metadata) => {
            let json = serde_json::json!({
                "success": true,
                "hash": metadata.hash,
                "size": metadata.size,
                "mimeType": metadata.mime_type,
            });
            (StatusCode::OK, axum::Json(json)).into_response()
        }
        Err(e @ SaveBlobError::HashMismatch { .. }) => {
            (StatusCode::BAD_REQUEST, e.to_string()).into_response()
        }
        Err(e @ SaveBlobError::QuotaExceeded { .. }) => {
            // 507 Insufficient Storage: existing data stays readable; only
            // this new write is refused.
            log::info!("blob upload refused for {}: {}", ws.as_str(), e);
            (StatusCode::INSUFFICIENT_STORAGE, e.to_string()).into_response()
        }
        Err(e @ SaveBlobError::Io(_)) => {
            (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response()
        }
    }
}

/// Download a blob (GET /api/blobs/:hash)
async fn blob_download_handler(
    Path(hash): Path<String>,
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
) -> impl IntoResponse {
    // Validate JWT
    let claims = match extract_jwt_from_headers(&headers, &state).await {
        Ok(c) => c,
        Err((status, msg)) => return (status, msg).into_response(),
    };
    let (ws, _claim_limits) = match resolve_blob_workspace(&state, &claims, None) {
        Ok(w) => w,
        Err(resp) => return resp,
    };

    // S3/R2 backend: gate on the workspace ACL (an unknown/cross-tenant hash
    // has no ACL → opaque 404), then 302-redirect to a short-TTL presigned GET
    // so the bytes stream straight from object storage, never through the
    // relay. The presigned URL self-authenticates via its query string; the
    // client must NOT forward the `Authorization` bearer to R2 (it would be
    // rejected / leak the JWT) — browser fetch + the desktop reqwest transport
    // both strip it on the cross-origin redirect.
    if let Some(s3) = state.s3_backend() {
        if !state.blob_store.exists(&ws, &hash) {
            return (StatusCode::NOT_FOUND, format!("Blob not found: {}", hash)).into_response();
        }
        let url = s3.presign_get(&ws, &hash);
        return Response::builder()
            .status(StatusCode::FOUND)
            .header(header::LOCATION, url)
            .body(Body::empty())
            .unwrap_or_else(|_| {
                Response::builder()
                    .status(StatusCode::INTERNAL_SERVER_ERROR)
                    .body(Body::from("Failed to build redirect"))
                    .unwrap()
            });
    }

    // Filesystem backend: stream the bytes through the relay (unchanged).
    // Get metadata for MIME type — workspace-scoped, so MIME type lookup
    // can't leak existence either.
    let mime_type = state.blob_store
        .get_metadata(&ws, &hash)
        .map(|m| m.mime_type)
        .unwrap_or_else(|| "application/octet-stream".to_string());

    // Load blob (404 for both missing-bytes and missing-ACL).
    match state.blob_store.load_blob(&ws, &hash) {
        Ok(data) => {
            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, mime_type)
                .header(header::CONTENT_LENGTH, data.len())
                .body(Body::from(data))
                .unwrap_or_else(|_| {
                    Response::builder()
                        .status(StatusCode::INTERNAL_SERVER_ERROR)
                        .body(Body::from("Failed to build response"))
                        .unwrap()
                })
        }
        Err(e) => {
            if e.contains("not found") {
                (StatusCode::NOT_FOUND, e).into_response()
            } else {
                (StatusCode::INTERNAL_SERVER_ERROR, e).into_response()
            }
        }
    }
}

/// Check if a blob exists (HEAD /api/blobs/:hash)
async fn blob_exists_handler(
    Path(hash): Path<String>,
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
) -> impl IntoResponse {
    // Validate JWT
    let claims = match extract_jwt_from_headers(&headers, &state).await {
        Ok(c) => c,
        Err((status, msg)) => return (status, msg).into_response(),
    };
    let (ws, _claim_limits) = match resolve_blob_workspace(&state, &claims, None) {
        Ok(w) => w,
        Err(resp) => return resp,
    };

    if state.blob_store.exists(&ws, &hash) {
        // Return metadata in headers if available
        if let Some(metadata) = state.blob_store.get_metadata(&ws, &hash) {
            Response::builder()
                .status(StatusCode::NO_CONTENT)
                .header(header::CONTENT_TYPE, metadata.mime_type)
                .header(header::CONTENT_LENGTH, metadata.size)
                .header("X-Blob-Created-At", metadata.created_at.to_string())
                .body(Body::empty())
                .unwrap_or_else(|_| {
                    Response::builder()
                        .status(StatusCode::NO_CONTENT)
                        .body(Body::empty())
                        .unwrap()
                })
        } else {
            StatusCode::NO_CONTENT.into_response()
        }
    } else {
        StatusCode::NOT_FOUND.into_response()
    }
}

/// Query parameters accepted on the WebSocket upgrade URL.
#[derive(Debug, Clone, serde::Deserialize, Default)]
struct WsUpgradeParams {
    /// Client's wire-protocol version. Optional for the v1 transition so
    /// older clients aren't hard-blocked; once /relay/ ships in v2 this
    /// becomes required and the `None` branch is removed.
    #[serde(rename = "protocolVersion")]
    protocol_version: Option<u32>,
}

/// WebSocket upgrade handler
async fn ws_handler(
    ws: WebSocketUpgrade,
    Query(params): Query<WsUpgradeParams>,
    State(state): State<Arc<ServerState>>,
) -> impl IntoResponse {
    if let Some(client_version) = params.protocol_version {
        if client_version != PROTOCOL_VERSION {
            let body = format!(
                "{}: client protocol v{} does not match server v{}",
                ERR_PROTOCOL_VERSION_MISMATCH, client_version, PROTOCOL_VERSION
            );
            log::warn!("Rejecting WS upgrade: {}", body);
            return (StatusCode::UPGRADE_REQUIRED, body).into_response();
        }
    }
    // Bound a single frame at the WS layer. Must stay >= MAX_DOCUMENT_SIZE so the
    // relay's *outbound* initial-sync of a large doc to a joining client is never
    // truncated; the inbound per-message cap (gracefully rejected) is much lower.
    ws.max_message_size(16 * 1024 * 1024)
        .on_upgrade(move |socket| handle_socket(socket, state))
}

/// Handle an individual WebSocket connection
/// AU-3 (JP-300): cadence of the live-session token recheck. Matches the
/// revocation polling cadence so a revoked token is torn off an open socket
/// within roughly the same window the relay learns of the revocation.
const SESSION_RECHECK_INTERVAL_SECS: u64 = 60;

/// JP-309: how many over-cap inbound frames a single connection may send before
/// it's dropped as abuse. The first few are gracefully rejected (the client is
/// told to chunk) so a transitional/legacy client isn't punished for one frame.
const MAX_OVER_CAP_FRAMES: u32 = 3;

/// AU-3: whether `client_id`'s authenticating token is now revoked or past its
/// expiry. Unauthenticated connections have nothing to recheck yet (`false`).
async fn session_revoked_or_expired(client_id: u64, state: &Arc<ServerState>) -> bool {
    let (jti, exp) = {
        let clients = state.clients.read().await;
        match clients.get(&client_id) {
            Some(c) if c.authenticated => (c.jti.clone(), c.token_exp),
            _ => return false,
        }
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if matches!(exp, Some(e) if now >= e) {
        return true;
    }
    matches!(jti, Some(ref j) if state.auth().revocations.is_revoked(j))
}

async fn handle_socket(socket: WebSocket, state: Arc<ServerState>) {
    let (mut ws_sender, mut ws_receiver) = socket.split();

    // Create channel for sending messages to this client
    let (tx, mut rx) = mpsc::channel::<Vec<u8>>(100);

    // Generate client ID
    let client_id = state.next_client_id();

    // Subscribe to broadcast channel
    let mut broadcast_rx = state.broadcast_tx.subscribe();

    // Add client to state
    {
        let mut clients = state.clients.write().await;
        clients.insert(client_id, ClientState {
            id: client_id,
            user_id: None,
            username: None,
            role: None,
            current_doc_id: None,
            current_workspace_id: WorkspaceId::single_tenant(),
            authenticated: false,
            jti: None,
            token_exp: None,
            tx: tx.clone(),
            reassembly: chunk::ChunkReassembler::default(),
        });
    }

    state.increment_clients();
    log::info!("Client {} connected. Total clients: {}", client_id, state.client_count());

    // Clone state for broadcast task
    let state_for_broadcast = state.clone();

    // Task to forward broadcast messages to this client
    let broadcast_task = tokio::spawn(async move {
        while let Ok(msg) = broadcast_rx.recv().await {
            // Check if message should go to this client. Filter applies
            // the workspace boundary to every routing target — see
            // BroadcastTarget for rationale.
            let should_send = {
                let clients = state_for_broadcast.clients.read().await;
                if let Some(client) = clients.get(&client_id) {
                    if msg.exclude_client == Some(client_id) {
                        false
                    } else {
                        match &msg.target {
                            BroadcastTarget::Doc(ws, doc_id) => {
                                client.authenticated
                                    && &client.current_workspace_id == ws
                                    && client.current_doc_id.as_ref() == Some(doc_id)
                            }
                            BroadcastTarget::Workspace(ws) => {
                                client.authenticated && &client.current_workspace_id == ws
                            }
                            BroadcastTarget::Global => client.authenticated,
                        }
                    }
                } else {
                    false
                }
            };

            if should_send {
                let _ = tx.send(msg.data).await;
            }
        }
    });

    // Task to send messages from rx channel to WebSocket
    let send_task = tokio::spawn(async move {
        while let Some(data) = rx.recv().await {
            if ws_sender.send(Message::Binary(data)).await.is_err() {
                break;
            }
        }
    });

    // AU-3: recheck the live session's token on a fixed cadence alongside the
    // normal receive loop. `interval`'s immediate first tick is consumed so the
    // first real recheck is one full period after connect (the connect-time
    // validation already covered t=0).
    let mut recheck =
        tokio::time::interval(std::time::Duration::from_secs(SESSION_RECHECK_INTERVAL_SECS));
    recheck.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    recheck.tick().await;

    // JP-309: per-connection count of over-cap frames; sustained abuse drops.
    let mut over_cap_count: u32 = 0;

    // Handle incoming messages from this client
    loop {
        tokio::select! {
            incoming = ws_receiver.next() => {
                let Some(Ok(msg)) = incoming else { break };
                match msg {
                    Message::Binary(data) => {
                        // JP-309: enforce the inbound per-message cap here so an
                        // over-cap frame is gracefully rejected (tell the client,
                        // keep the connection) instead of dropping the session into
                        // a reconnect-loop that silently loses offline edits. Large
                        // logical updates arrive chunked (MESSAGE_SYNC_CHUNK), each
                        // under the cap. Sustained abuse still drops.
                        let cap = state.tenancy().limits.max_ws_payload_bytes;
                        if data.len() > cap {
                            log::warn!(
                                "ws frame too large client_id={} bytes={} cap={}",
                                client_id, data.len(), cap
                            );
                            let err = ErrorResponse {
                                request_id: None,
                                error: ERR_MESSAGE_TOO_LARGE.to_string(),
                            };
                            if let Ok(frame) = encode_message(MESSAGE_ERROR, &err) {
                                send_to_client(client_id, frame, &state).await;
                            }
                            over_cap_count += 1;
                            if over_cap_count > MAX_OVER_CAP_FRAMES {
                                log::warn!(
                                    "client {} dropped after {} over-cap frames",
                                    client_id, over_cap_count
                                );
                                break;
                            }
                            continue;
                        }
                        if let Some(msg_type) = decode_message_type(&data) {
                            if !handle_message(client_id, msg_type, &data, &state).await {
                                // A handler panicked. Drop just this connection;
                                // the cleanup block below removes the client and
                                // aborts its tasks. Other tenants are unaffected.
                                break;
                            }
                        }
                    }
                    Message::Text(text) => {
                        // Legacy text message support - broadcast as-is
                        log::debug!("Received text message from client {}: {}", client_id, text);
                    }
                    Message::Ping(_) => {
                        log::trace!("Received ping from client {}", client_id);
                    }
                    Message::Pong(_) => {
                        log::trace!("Received pong from client {}", client_id);
                    }
                    Message::Close(_) => {
                        log::debug!("Client {} requested close", client_id);
                        break;
                    }
                }
            }
            _ = recheck.tick() => {
                if session_revoked_or_expired(client_id, &state).await {
                    // AU-3: token revoked or expired since connect — tear down the
                    // session. The cleanup block below releases the connection; a
                    // reconnect attempt re-runs AUTH and is rejected at validation.
                    log::info!(
                        "Client {} disconnected: token revoked or expired (live recheck)",
                        client_id
                    );
                    break;
                }
            }
        }
    }

    // Cleanup
    broadcast_task.abort();
    send_task.abort();

    let removed = {
        let mut clients = state.clients.write().await;
        clients.remove(&client_id)
    };
    if let Some(client) = removed {
        if client.authenticated {
            // Classify from the stored role string so release balances the
            // same editor/viewer bucket that registration incremented.
            let is_editor = client.role.as_deref() != Some("viewer");
            state
                .release_workspace_connection(&client.current_workspace_id, is_editor)
                .await;
        }
        // JP-34: drop the authoritative Y.Doc once its last participant has
        // left. The client is already out of the table above, so the scan
        // inside `evict_doc_if_unused` reflects post-removal membership.
        if let Some(doc_id) = &client.current_doc_id {
            state
                .evict_doc_if_unused(&client.current_workspace_id, doc_id)
                .await;
        }
    }

    state.decrement_clients();
    log::info!("Client {} disconnected. Total clients: {}", client_id, state.client_count());
}

/// Handle a protocol message from a client.
///
/// Slice E.3: only CRDT sync, awareness, bearer-token auth, and
/// JOIN_DOC routing remain. Document CRUD and credential login moved
/// to REST handlers in `relay/src/api.rs`. Any client still sending
/// the deleted message bytes (3-6, 11-13) gets a warn-and-ignore.
///
/// Phase 21.2: every handler dispatch is wrapped in a `catch_unwind`
/// future-combinator so a panic in tenant A's request path drops only
/// that connection — the pod stays up. Returns `false` if a panic was
/// caught (caller should break the receive loop and clean up the
/// connection); `true` for normal completion or warn-and-ignore.
async fn handle_message(
    client_id: u64,
    msg_type: u8,
    data: &[u8],
    state: &Arc<ServerState>,
) -> bool {
    use futures_util::FutureExt;
    use std::panic::AssertUnwindSafe;

    // Phase 21.3 per-message payload-size cap is enforced in the receive loop
    // (`handle_socket`) so an over-cap frame can be gracefully rejected
    // (MESSAGE_ERROR, connection kept) rather than dropping the session — see
    // JP-309. By the time a frame reaches here it is already within the cap.

    let correlation_id = nanoid::nanoid!(10);
    let fut = async {
        // DEBUG-only panic injection. Compiled out of release builds —
        // the trigger field is gated by `cfg(debug_assertions)`. Placed
        // inside the wrapped future so the surrounding `catch_unwind`
        // intercepts the panic and exercises the isolation path.
        #[cfg(debug_assertions)]
        {
            if let Some(trigger) = &state.panic_tenant_trigger {
                let matches = {
                    let clients = state.clients.read().await;
                    clients
                        .get(&client_id)
                        .map(|c| &c.current_workspace_id == trigger)
                        .unwrap_or(false)
                };
                if matches {
                    panic!("debug panic-tenant trigger fired (msg_type={})", msg_type);
                }
            }
        }

        match msg_type {
            MESSAGE_AUTH => handle_auth(client_id, data, state).await,
            MESSAGE_SYNC => handle_sync(client_id, data, state).await,
            MESSAGE_SYNC_CHUNK => handle_sync_chunk(client_id, data, state).await,
            MESSAGE_AWARENESS => handle_awareness(client_id, data, state).await,
            MESSAGE_JOIN_DOC => handle_join_doc(client_id, data, state).await,
            // JP-237 liveness heartbeat: echo the bare frame straight back so the
            // client can detect a silently-dropped socket. Cheap and stateless.
            MESSAGE_HEARTBEAT => send_to_client(client_id, vec![MESSAGE_HEARTBEAT], state).await,
            _ => {
                log::warn!("Unknown message type {} from client {}", msg_type, client_id);
            }
        }
    };

    match AssertUnwindSafe(fut).catch_unwind().await {
        Ok(()) => true,
        Err(panic) => {
            let (ws_id, user_id) = {
                let clients = state.clients.read().await;
                clients
                    .get(&client_id)
                    .map(|c| (
                        c.current_workspace_id.as_str().to_string(),
                        c.user_id.clone().unwrap_or_default(),
                    ))
                    .unwrap_or_default()
            };
            state.record_panic();
            log::error!(
                "handler panic msg_type={} client_id={} workspace_id={} user_id={} correlation_id={} panic={}",
                msg_type,
                client_id,
                ws_id,
                user_id,
                correlation_id,
                panic_message(&panic),
            );
            false
        }
    }
}

/// Extract a best-effort string from a `catch_unwind` panic payload.
/// Handles the two common cases (`&'static str` and `String`) and
/// falls back to a descriptor for boxed-`Any` types we don't model.
pub(crate) fn panic_message(payload: &Box<dyn std::any::Any + Send>) -> String {
    if let Some(s) = payload.downcast_ref::<&'static str>() {
        return (*s).to_string();
    }
    if let Some(s) = payload.downcast_ref::<String>() {
        return s.clone();
    }
    "<non-string panic payload>".to_string()
}

/// Handle authentication message (JWT token auth)
async fn handle_auth(client_id: u64, data: &[u8], state: &Arc<ServerState>) {
    let token: String = match decode_payload(data) {
        Ok(t) => t,
        Err(e) => {
            log::warn!("Failed to decode auth token from client {}: {}", client_id, e);
            send_auth_response(client_id, false, None, None, None, None, None, Some("Invalid token format"), state).await;
            return;
        }
    };

    let claims = match state.auth().validate(&token).await {
        Ok(c) => c,
        Err(e) => {
            log::warn!("Auth failed for client {}: {}", client_id, e);
            send_auth_response(
                client_id,
                false,
                None,
                None,
                None,
                None,
                None,
                Some(&e.to_string()),
                state,
            )
            .await;
            return;
        }
    };

    let (claim_ws, role, claim_limits) =
        match WorkspaceId::from_oidc_array(&claims, None, state.relay_region()) {
            Ok(v) => v,
            Err(e) => {
                log::warn!("ws auth rejected: {} client_id={}", e, client_id);
                send_auth_response(client_id, false, None, None, None, None, None, Some("forbidden"), state).await;
                return;
            }
        };

    if state.check_tenancy(&claim_ws).is_err() {
        log::warn!(
            "ws auth rejected: tenancy mismatch client_id={} workspace_id={}",
            client_id,
            claim_ws.as_str()
        );
        send_auth_response(client_id, false, None, None, None, None, None, Some("forbidden"), state).await;
        return;
    }

    // Editors (owner/member) can write and drive CRDT cost; viewers are
    // read-only. The total-connection ceiling counts both; the editor cap
    // (JP-81) bounds editors only — viewers stay free + uncapped.
    let is_editor = !matches!(role, WorkspaceRole::Viewer);
    let editor_limit = state.resolve_limits(claim_limits).editor_limit;
    match state
        .try_register_workspace_connection(&claim_ws, is_editor, editor_limit)
        .await
    {
        Ok(()) => {}
        Err(e) => {
            let code = match e {
                WorkspaceLimitError::CapExceeded => "ERR_WORKSPACE_CONNECTION_LIMIT",
                WorkspaceLimitError::EditorCapExceeded => "ERR_EDITOR_LIMIT",
            };
            log::warn!(
                "ws auth rejected: {} client_id={} workspace_id={}",
                code,
                client_id,
                claim_ws.as_str()
            );
            send_auth_response(client_id, false, None, None, None, None, None, Some(code), state)
                .await;
            return;
        }
    }

    let role_str = format!("{:?}", role).to_lowercase();
    {
        let mut clients = state.clients.write().await;
        if let Some(client) = clients.get_mut(&client_id) {
            client.user_id = Some(claims.sub.clone());
            // OIDC tokens don't carry `username`; surface `sub` for logs.
            client.username = Some(claims.sub.clone());
            client.role = Some(role_str.clone());
            client.current_workspace_id = claim_ws.clone();
            client.authenticated = true;
            // AU-3: remember the token identity for the live recheck.
            client.jti = Some(claims.jti.clone());
            client.token_exp = Some(claims.exp);
        }
    }

    log::info!(
        "Client {} authenticated sub={} workspace_id={}",
        client_id,
        claims.sub,
        claim_ws.as_str()
    );
    send_auth_response(
        client_id,
        true,
        Some(claims.sub.clone()),
        Some(claims.sub),
        Some(role_str),
        None,
        None,
        None,
        state,
    )
    .await;
}

/// Send authentication response
#[allow(clippy::too_many_arguments)]
async fn send_auth_response(
    client_id: u64,
    success: bool,
    user_id: Option<String>,
    username: Option<String>,
    role: Option<String>,
    token: Option<String>,
    token_expires_at: Option<u64>,
    error: Option<&str>,
    state: &Arc<ServerState>,
) {
    let response = AuthResponse {
        success,
        user_id,
        username,
        role,
        token,
        token_expires_at,
        error: error.map(String::from),
        // JP-309: advertise the inbound cap (only meaningful on success) so the
        // client knows the threshold above which it must chunk SYNC frames.
        max_message_size: success.then(|| state.tenancy().limits.max_ws_payload_bytes as u64),
    };

    if let Ok(data) = encode_message(MESSAGE_AUTH_RESPONSE, &response) {
        send_to_client(client_id, data, state).await;
    }
}

/// JP-309: buffer a chunked SYNC fragment. Once the logical message is complete,
/// apply the reassembled `[MESSAGE_SYNC | update]` via the normal sync path (one
/// rate-limit check, full CRDT merge + broadcast — byte-identical to having
/// received it in one frame) and ack the msgId so the client can mark itself
/// synced. Malformed/abusive fragments are logged + ignored (connection kept).
async fn handle_sync_chunk(client_id: u64, data: &[u8], state: &Arc<ServerState>) {
    // [type][msgId: 16][seq: u32 BE][total: u32 BE][payload]
    let body = &data[1..];
    if body.len() < 24 {
        log::warn!(
            "malformed sync-chunk from client {} (body len {})",
            client_id,
            body.len()
        );
        return;
    }
    let mut msg_id = [0u8; 16];
    msg_id.copy_from_slice(&body[0..16]);
    let seq = u32::from_be_bytes([body[16], body[17], body[18], body[19]]);
    let total = u32::from_be_bytes([body[20], body[21], body[22], body[23]]);
    let payload = &body[24..];

    let reassembled = {
        let mut clients = state.clients.write().await;
        let Some(client) = clients.get_mut(&client_id) else { return };
        // Only an authenticated client may buffer — bounds pre-auth memory use.
        if !client.authenticated {
            log::warn!("sync-chunk from unauthenticated client {}", client_id);
            return;
        }
        match client
            .reassembly
            .push(msg_id, seq, total, payload, std::time::Instant::now())
        {
            Ok(r) => r,
            Err(e) => {
                log::warn!("sync-chunk rejected from client {}: {:?}", client_id, e);
                return;
            }
        }
    };

    if let Some(frame) = reassembled {
        // `frame` is the original [MESSAGE_SYNC | update]; apply as if it had
        // arrived whole, then ack the completed msgId.
        handle_sync(client_id, &frame, state).await;
        let mut ack = Vec::with_capacity(1 + 16);
        ack.push(MESSAGE_SYNC_CHUNK_ACK);
        ack.extend_from_slice(&msg_id);
        send_to_client(client_id, ack, state).await;
    }
}

/// Handle CRDT sync message - forward to clients on same document.
/// Phase 21.3: applies the per-workspace write rate limit before
/// broadcast. Over-quota frames are silently dropped (the sender gets
/// an ERROR frame); the connection isn't closed.
async fn handle_sync(client_id: u64, data: &[u8], state: &Arc<ServerState>) {
    let (doc_id, workspace_id): (Option<DocId>, WorkspaceId) = {
        let clients = state.clients.read().await;
        clients
            .get(&client_id)
            .map(|c| (c.current_doc_id.clone(), c.current_workspace_id.clone()))
            .unwrap_or_else(|| (None, WorkspaceId::single_tenant()))
    };

    if state.write_limiter().check_key(&workspace_id).is_err() {
        state.record_rate_limit_rejection();
        log::debug!(
            "ws sync frame rate-limited client_id={} workspace_id={}",
            client_id,
            workspace_id.as_str()
        );
        send_rate_limit_error(client_id, state).await;
        return;
    }

    let Some(doc_id) = doc_id else { return };

    // JP-34: apply the frame to the authoritative Y.Doc, then answer/broadcast.
    // The handle should already exist (created on JOIN_DOC); hydrate on demand
    // to cover the JOIN→SYNC race or a join-time body-load failure.
    let handle = match state.sync_registry().get(&workspace_id, &doc_id) {
        Some(handle) => Some(handle),
        None => {
            // JP-200: cover the JOIN→SYNC race on a cold machine — restore from R2
            // by id before the body load so hydrate-on-demand still works.
            state.ensure_doc_local(&workspace_id, &doc_id).await;
            match state.doc_store().get_document(&workspace_id, &doc_id) {
            Ok(doc_json) => {
                let ydoc_bin = if state.binary_persistence() {
                    state.doc_store().load_ydoc_binary(&workspace_id, &doc_id)
                } else {
                    None
                };
                Some(state.sync_registry().ensure(
                    &workspace_id,
                    &doc_id,
                    &doc_json,
                    ydoc_bin.as_deref(),
                    state.poison_guard(),
                ))
            }
            Err(_) => None,
            }
        }
    };

    match handle {
        Some(handle) => match handle.handle_sync_message(&data[1..]) {
            Ok(outcome) => {
                if let Some(reply) = outcome.reply {
                    send_to_client(client_id, reply, state).await;
                }
                if let Some(update) = outcome.broadcast {
                    // Both keys required so same-id docs in two workspaces
                    // don't cross-talk.
                    state.broadcast_to_doc(&workspace_id, &doc_id, update, Some(client_id));
                }
            }
            Err(e) => {
                // The frame didn't decode as a Yjs sync message. Valid clients
                // never hit this; to stay backwards-compatible (and preserve
                // the workspace-scoped routing for any non-standard frame) we
                // fall back to opaque forwarding rather than dropping it.
                log::warn!(
                    "sync decode/apply failed (doc {} ws {}): {:?} — forwarding opaque",
                    doc_id.as_str(),
                    workspace_id.as_str(),
                    e
                );
                state.broadcast_to_doc(&workspace_id, &doc_id, data.to_vec(), Some(client_id));
            }
        },
        // No authoritative Y.Doc available — fall back to opaque forwarding so
        // the frame isn't silently dropped.
        None => {
            state.broadcast_to_doc(&workspace_id, &doc_id, data.to_vec(), Some(client_id));
        }
    }
}

/// Send an `ERROR` frame to a single client indicating their last
/// write was dropped by the rate limiter. Connection stays open;
/// clients are expected to back off and retry.
async fn send_rate_limit_error(client_id: u64, state: &Arc<ServerState>) {
    let err = ErrorResponse {
        request_id: None,
        error: "ERR_RATE_LIMIT".to_string(),
    };
    if let Ok(data) = encode_message(MESSAGE_ERROR, &err) {
        send_to_client(client_id, data, state).await;
    }
}

/// Handle awareness message - forward to clients on the same
/// (workspace, doc). The workspace is snapshotted alongside the doc
/// so the broadcast filter can keep tenants apart.
async fn handle_awareness(client_id: u64, data: &[u8], state: &Arc<ServerState>) {
    let snapshot: Option<(WorkspaceId, DocId)> = {
        let clients = state.clients.read().await;
        clients
            .get(&client_id)
            .and_then(|c| c.current_doc_id.clone().map(|d| (c.current_workspace_id.clone(), d)))
    };

    if let Some((workspace_id, doc_id)) = snapshot {
        state.broadcast_to_doc(&workspace_id, &doc_id, data.to_vec(), Some(client_id));
    }
}


/// Handle join document request (for CRDT routing).
///
/// JP-64 defensive: only team documents (those present in the doc
/// store's index) are valid join targets. JOIN_DOC for an unknown
/// id is logged at warn level and the client's `current_doc_id`
/// stays unset, so any follow-on SYNC/AWARENESS frames are silently
/// dropped by `handle_sync` / `handle_awareness` instead of being
/// broadcast to other clients that may have erroneously joined the
/// same phantom id.
async fn handle_join_doc(client_id: u64, data: &[u8], state: &Arc<ServerState>) {
    let request: JoinDocRequest = match decode_payload(data) {
        Ok(r) => r,
        Err(e) => {
            log::warn!("Failed to decode join doc request: {}", e);
            return;
        }
    };

    // Snapshot the client's workspace for the doc-store lookup. The
    // join is rejected (without setting current_doc_id) if the client
    // record disappeared (race) or the doc isn't a team document.
    let workspace_id = {
        let clients = state.clients.read().await;
        match clients.get(&client_id) {
            Some(c) => c.current_workspace_id.clone(),
            None => return,
        }
    };

    // JP-200: on a local miss (recycled machine / cold volume) try to restore the
    // doc from R2 by id before the existence gate, so durability survives volume
    // loss. No-op when already local or on the filesystem backend.
    state.ensure_doc_local(&workspace_id, &request.doc_id).await;

    if state
        .doc_store()
        .get_metadata(&workspace_id, &request.doc_id)
        .is_none()
    {
        log::warn!(
            "rejecting JOIN_DOC for unknown doc client_id={} workspace_id={} doc_id={}",
            client_id,
            workspace_id.as_str(),
            request.doc_id.as_str(),
        );
        // Tell the client its join was rejected so it can stop pretending to
        // sync (and warn the user that edits are local-only) rather than
        // silently dropping its follow-on SYNC/AWARENESS frames. Connection
        // stays open; mirrors `send_rate_limit_error`.
        let err = ErrorResponse {
            request_id: None,
            error: "ERR_UNKNOWN_DOC".to_string(),
        };
        if let Ok(data) = encode_message(MESSAGE_ERROR, &err) {
            send_to_client(client_id, data, state).await;
        }
        return;
    }

    let previous_doc_id = {
        let mut clients = state.clients.write().await;
        match clients.get_mut(&client_id) {
            Some(client) => {
                log::info!("Client {} joined document {}", client_id, request.doc_id.as_str());
                client.current_doc_id.replace(request.doc_id.clone())
            }
            // Client record vanished mid-join (disconnect race) — nothing to do.
            None => return,
        }
    };

    // If the client switched away from another doc, evict that doc's
    // authoritative handle when it has no remaining participants.
    if let Some(prev) = previous_doc_id {
        if prev != request.doc_id {
            state.evict_doc_if_unused(&workspace_id, &prev).await;
        }
    }

    // JP-34: hydrate (or reuse) the authoritative Y.Doc and push the client a
    // relay-initiated SyncStep1 so it converges onto authoritative state. The
    // metadata-exists check above guarantees the doc is known; a body-load
    // failure is logged but non-fatal — `handle_sync` hydrates on demand.
    match state.doc_store().get_document(&workspace_id, &request.doc_id) {
        Ok(doc_json) => {
            let ydoc_bin = if state.binary_persistence() {
                state
                    .doc_store()
                    .load_ydoc_binary(&workspace_id, &request.doc_id)
            } else {
                None
            };
            let handle = state.sync_registry().ensure(
                &workspace_id,
                &request.doc_id,
                &doc_json,
                ydoc_bin.as_deref(),
                state.poison_guard(),
            );
            send_to_client(client_id, handle.sync_step1_frame(), state).await;
        }
        Err(e) => {
            log::warn!(
                "join_doc: could not load body for {} to hydrate Y.Doc: {}",
                request.doc_id.as_str(),
                e
            );
        }
    }
}


/// Send data to a specific client
async fn send_to_client(client_id: u64, data: Vec<u8>, state: &Arc<ServerState>) {
    let clients = state.clients.read().await;
    if let Some(client) = clients.get(&client_id) {
        let _ = client.tx.send(data).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{LimitsConfig, TenancyConfig, TenancyMode};

    #[tokio::test]
    async fn test_server_lifecycle() {
        let server = WebSocketServer::new();

        // Set app data dir for test
        let temp_dir = tempfile::tempdir().unwrap();
        server.set_app_data_dir(temp_dir.path().to_path_buf()).await;
        server.set_auth(test_auth_state()).await;

        assert!(!server.is_running());

        // Start server on random port
        let result = server.start(0).await;
        assert!(result.is_ok(), "start error: {:?}", result.err());
        assert!(server.is_running());

        let status = server.status().await;
        assert!(status.running);
        assert!(status.port > 0);

        // Stop server
        let result = server.stop().await;
        assert!(result.is_ok());

        tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;
        assert!(!server.is_running());
    }

    #[tokio::test]
    async fn test_server_status() {
        let server = WebSocketServer::new();

        let status = server.status().await;
        assert!(!status.running);
        assert_eq!(status.port, 0);
        assert_eq!(status.connected_clients, 0);
        assert!(status.address.is_empty());
    }

    /// Phase 21.2: panic-payload string extraction covers the two
    /// shapes `std::panic` produces from `panic!(...)` invocations —
    /// `&'static str` for the no-args form, `String` for `format!`-style.
    /// Anything else falls back to a descriptor so the log line is never
    /// empty.
    #[test]
    fn panic_message_extracts_str_string_and_falls_back() {
        let payload_static: Box<dyn std::any::Any + Send> = Box::new("static-msg");
        assert_eq!(panic_message(&payload_static), "static-msg");

        let payload_string: Box<dyn std::any::Any + Send> = Box::new(String::from("owned-msg"));
        assert_eq!(panic_message(&payload_string), "owned-msg");

        let payload_other: Box<dyn std::any::Any + Send> = Box::new(42u64);
        assert_eq!(panic_message(&payload_other), "<non-string panic payload>");
    }

    /// Phase 21.2: a panic in a handler dispatched via `handle_message`
    /// must be caught, increment the counter, return `false` so the WS
    /// loop drops only this client. Drives the panic via the debug
    /// `panic_tenant_trigger` so the test doesn't depend on a real
    /// panicking handler.
    #[cfg(debug_assertions)]
    #[tokio::test]
    async fn handle_message_catches_panic_and_increments_counter() {
        use crate::server::protocol::WorkspaceId;

        let server = WebSocketServer::new();
        let temp_dir = tempfile::tempdir().unwrap();
        server.set_app_data_dir(temp_dir.path().to_path_buf()).await;
        server.set_panic_tenant(Some(WorkspaceId::single_tenant())).await;

        // Manually construct a ServerState mirroring `start()`'s wiring.
        let panic_count = server.panic_counter_handle();
        let trigger = server.panic_tenant_trigger.read().await.clone();
        let tenancy = TenancyConfig::default();
        let write_limiter = Arc::new(build_workspace_limiter(
            tenancy.limits.writes_per_sec,
            tenancy.limits.writes_burst,
        ));
        let state = Arc::new(ServerState::new(
            temp_dir.path().to_path_buf(),
            StorageConfig::default(),
            test_auth_state(),
            None,
            "default".to_string(),
            tenancy,
            write_limiter,
            panic_count.clone(),
            Arc::new(AtomicU64::new(0)),
            false,
            true,
            true,
            trigger,
        ));

        // Register a fake client carrying the single-tenant workspace id,
        // so the trigger matches.
        let (tx, _rx) = mpsc::channel(4);
        let client_id = state.next_client_id();
        {
            let mut clients = state.clients.write().await;
            clients.insert(
                client_id,
                ClientState {
                    id: client_id,
                    user_id: Some("user-1".to_string()),
                    username: None,
                    role: None,
                    current_doc_id: None,
                    current_workspace_id: WorkspaceId::single_tenant(),
                    authenticated: true,
                    jti: None,
                    token_exp: None,
                    tx,
                    reassembly: chunk::ChunkReassembler::default(),
                },
            );
        }

        assert_eq!(state.panic_count(), 0);

        // The trigger fires inside handle_message before the dispatch,
        // and the surrounding catch_unwind converts it into `false`.
        let keep_alive = handle_message(client_id, MESSAGE_SYNC, b"\x00ignored", &state).await;
        assert!(!keep_alive, "panic must drop the connection");
        assert_eq!(state.panic_count(), 1, "panic must increment the counter");
    }

    /// JP-237: a liveness heartbeat is echoed straight back to the sender so the
    /// client can detect a silently-dropped socket. Stateless and auth-agnostic.
    #[tokio::test]
    async fn handle_message_echoes_heartbeat() {
        use crate::server::protocol::WorkspaceId;

        let state = test_server_state(TenancyConfig::default()).await;

        let (tx, mut rx) = mpsc::channel(4);
        let client_id = state.next_client_id();
        {
            let mut clients = state.clients.write().await;
            clients.insert(
                client_id,
                ClientState {
                    id: client_id,
                    user_id: Some("user-1".to_string()),
                    username: None,
                    role: None,
                    current_doc_id: None,
                    current_workspace_id: WorkspaceId::single_tenant(),
                    authenticated: true,
                    jti: None,
                    token_exp: None,
                    tx,
                    reassembly: chunk::ChunkReassembler::default(),
                },
            );
        }

        let keep_alive =
            handle_message(client_id, MESSAGE_HEARTBEAT, &[MESSAGE_HEARTBEAT], &state).await;
        assert!(keep_alive, "heartbeat must keep the connection alive");

        let echoed = rx.recv().await.expect("heartbeat echo");
        assert_eq!(echoed, vec![MESSAGE_HEARTBEAT]);
    }

    /// Build a `ServerState` for inline tenancy/limit tests. Mirrors
    /// `WebSocketServer::start`'s wiring at the minimum needed to call
    /// `check_tenancy` and the workspace-cap methods.
    async fn test_server_state(tenancy: TenancyConfig) -> Arc<ServerState> {
        let temp_dir = tempfile::tempdir().unwrap().keep();
        let write_limiter = Arc::new(build_workspace_limiter(
            tenancy.limits.writes_per_sec,
            tenancy.limits.writes_burst,
        ));
        Arc::new(ServerState::new(
            temp_dir,
            StorageConfig::default(),
            test_auth_state(),
            None,
            "default".to_string(),
            tenancy,
            write_limiter,
            Arc::new(AtomicU64::new(0)),
            Arc::new(AtomicU64::new(0)),
            false,
            true,
            true,
            #[cfg(debug_assertions)]
            None,
        ))
    }

    /// Build a no-op `OidcAuthState` for tests that don't exercise auth
    /// (tenancy / connection cap / panic isolation). The JwksCache and
    /// RevocationSet stay empty; `validate()` will fail on any token —
    /// these tests don't call it.
    fn test_auth_state() -> OidcAuthState {
        use crate::auth::{JwksCache, OidcValidationConfig, RevocationSet};
        OidcAuthState::new(
            OidcValidationConfig {
                issuer: "https://test.example.com".to_string(),
                audience: "docushark-relay".to_string(),
                resource: None,
            },
            JwksCache::new("https://test.example.com/.well-known/jwks.json".to_string()),
            RevocationSet::new(),
        )
    }

    // AU-3 (JP-300): the live-session recheck flags a revoked or expired token.
    #[tokio::test]
    async fn session_recheck_flags_revoked_and_expired_tokens() {
        use crate::auth::Revocation;

        let temp_dir = tempfile::tempdir().unwrap();
        let tenancy = TenancyConfig::default();
        let write_limiter = Arc::new(build_workspace_limiter(
            tenancy.limits.writes_per_sec,
            tenancy.limits.writes_burst,
        ));
        let state = Arc::new(ServerState::new(
            temp_dir.path().to_path_buf(),
            StorageConfig::default(),
            test_auth_state(),
            None,
            "default".to_string(),
            tenancy,
            write_limiter,
            Arc::new(AtomicU64::new(0)),
            Arc::new(AtomicU64::new(0)),
            false,
            true,
            true,
            #[cfg(debug_assertions)]
            None,
        ));

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        // Insert four clients with distinct token states.
        let insert = |id: u64, jti: Option<&str>, exp: Option<u64>, authed: bool| {
            let (tx, _rx) = mpsc::channel(4);
            ClientState {
                id,
                user_id: Some("u".to_string()),
                username: None,
                role: None,
                current_doc_id: None,
                current_workspace_id: WorkspaceId::single_tenant(),
                authenticated: authed,
                jti: jti.map(|s| s.to_string()),
                token_exp: exp,
                tx,
                reassembly: chunk::ChunkReassembler::default(),
            }
        };
        {
            let mut clients = state.clients.write().await;
            clients.insert(1, insert(1, Some("live"), Some(now + 3600), true));
            clients.insert(2, insert(2, Some("revoked"), Some(now + 3600), true));
            clients.insert(3, insert(3, Some("expired"), Some(now - 10), true));
            clients.insert(4, insert(4, None, None, false));
        }

        state.auth().revocations.revoke_many(&[Revocation {
            jti: "revoked".to_string(),
            revoked_at: chrono::Utc::now(),
        }]);

        assert!(!session_revoked_or_expired(1, &state).await, "live token stays connected");
        assert!(session_revoked_or_expired(2, &state).await, "revoked token is torn down");
        assert!(session_revoked_or_expired(3, &state).await, "expired token is torn down");
        assert!(!session_revoked_or_expired(4, &state).await, "unauthed has nothing to recheck");
    }

    /// Phase 21.5: a dedicated-mode relay with a blank `workspace_id`
    /// must pin to the single-tenant default — preserves pre-21.5
    /// behavior for self-hosters who upgrade without touching their
    /// `relay.toml`.
    #[tokio::test]
    async fn check_tenancy_dedicated_pinned_to_default_when_blank() {
        let state = test_server_state(TenancyConfig {
            mode: TenancyMode::Dedicated,
            workspace_id: None,
            ..TenancyConfig::default()
        })
        .await;
        assert!(state.check_tenancy(&WorkspaceId::single_tenant()).is_ok());
        assert!(state
            .check_tenancy(&WorkspaceId::from_configured("other").unwrap())
            .is_err());
    }

    /// Phase 21.5: dedicated mode with a configured workspace refuses
    /// any other workspace id with an opaque error (no leak of the
    /// configured value).
    #[tokio::test]
    async fn check_tenancy_dedicated_rejects_mismatch() {
        let state = test_server_state(TenancyConfig {
            mode: TenancyMode::Dedicated,
            workspace_id: Some("alpha".into()),
            ..TenancyConfig::default()
        })
        .await;
        let alpha = WorkspaceId::from_configured("alpha").unwrap();
        let beta = WorkspaceId::from_configured("beta").unwrap();
        assert!(state.check_tenancy(&alpha).is_ok());
        assert_eq!(state.check_tenancy(&beta), Err(TenancyError::Mismatch));
    }

    /// Phase 21.5: shared mode accepts whatever the JWT claim says.
    #[tokio::test]
    async fn check_tenancy_shared_accepts_any_workspace() {
        let state = test_server_state(TenancyConfig {
            mode: TenancyMode::Shared,
            ..TenancyConfig::default()
        })
        .await;
        for ws in ["alpha", "beta", "default", "x"] {
            assert!(state
                .check_tenancy(&WorkspaceId::from_configured(ws).unwrap())
                .is_ok());
        }
    }

    /// JP-64: a JOIN_DOC payload addressing a document the relay
    /// doesn't know about must be rejected — `current_doc_id` stays
    /// `None` so subsequent SYNC frames from that client are dropped
    /// in `handle_sync` instead of being broadcast. JP-106: the client
    /// is also sent an `ERR_UNKNOWN_DOC` error frame so it can stop
    /// pretending to sync rather than silently failing.
    #[tokio::test]
    async fn handle_join_doc_rejects_unknown_doc_id() {
        let state = test_server_state(TenancyConfig::default()).await;

        // Register a fake authenticated client. No documents in the
        // doc store, so any JOIN_DOC is "unknown" by definition.
        let (tx, mut rx) = mpsc::channel(4);
        let client_id = state.next_client_id();
        {
            let mut clients = state.clients.write().await;
            clients.insert(
                client_id,
                ClientState {
                    id: client_id,
                    user_id: Some("user-1".to_string()),
                    username: None,
                    role: None,
                    current_doc_id: None,
                    current_workspace_id: WorkspaceId::single_tenant(),
                    authenticated: true,
                    jti: None,
                    token_exp: None,
                    tx,
                    reassembly: chunk::ChunkReassembler::default(),
                },
            );
        }

        // Construct a JOIN_DOC frame for a doc id that doesn't exist.
        let req = JoinDocRequest {
            doc_id: DocId::from_http_path("phantom-local-doc".to_string()).unwrap(),
        };
        let frame = encode_message(MESSAGE_JOIN_DOC, &req).expect("encode");

        handle_join_doc(client_id, &frame, &state).await;

        let cur = {
            let clients = state.clients.read().await;
            clients.get(&client_id).and_then(|c| c.current_doc_id.clone())
        };
        assert!(
            cur.is_none(),
            "unknown doc id must not set current_doc_id; got {cur:?}"
        );

        // The client should have received an ERR_UNKNOWN_DOC error frame.
        let frame = rx.try_recv().expect("expected an error frame to be sent");
        assert_eq!(
            decode_message_type(&frame),
            Some(MESSAGE_ERROR),
            "rejection frame must be MESSAGE_ERROR"
        );
        let err: ErrorResponse = decode_payload(&frame).expect("decode error frame");
        assert_eq!(err.error, "ERR_UNKNOWN_DOC");
    }

    /// JP-64: a JOIN_DOC for a real team document still works.
    #[tokio::test]
    async fn handle_join_doc_accepts_known_doc_id() {
        let state = test_server_state(TenancyConfig::default()).await;

        // Seed a team document so the JOIN_DOC target resolves.
        let ws = WorkspaceId::single_tenant();
        let doc = serde_json::json!({
            "id": "real-doc",
            "name": "Real",
            "pageOrder": ["p1"],
            "pages": {},
            "createdAt": 1u64,
            "modifiedAt": 1u64,
        });
        state.doc_store.save_document(&ws, doc).expect("save");

        let (tx, _rx) = mpsc::channel(4);
        let client_id = state.next_client_id();
        {
            let mut clients = state.clients.write().await;
            clients.insert(
                client_id,
                ClientState {
                    id: client_id,
                    user_id: Some("user-1".to_string()),
                    username: None,
                    role: None,
                    current_doc_id: None,
                    current_workspace_id: ws.clone(),
                    authenticated: true,
                    jti: None,
                    token_exp: None,
                    tx,
                    reassembly: chunk::ChunkReassembler::default(),
                },
            );
        }

        let req = JoinDocRequest {
            doc_id: DocId::from_http_path("real-doc".to_string()).unwrap(),
        };
        let frame = encode_message(MESSAGE_JOIN_DOC, &req).expect("encode");

        handle_join_doc(client_id, &frame, &state).await;

        let cur = {
            let clients = state.clients.read().await;
            clients
                .get(&client_id)
                .and_then(|c| c.current_doc_id.clone())
                .map(|d| d.as_str().to_string())
        };
        assert_eq!(cur.as_deref(), Some("real-doc"));
    }

    /// Phase 21.3: per-workspace connection cap is enforced atomically
    /// — the Nth + 1 register call fails. Release decrements so a
    /// closed connection makes room for a new one.
    #[tokio::test]
    async fn workspace_client_counts_respect_cap() {
        let mut limits = LimitsConfig::default();
        limits.max_ws_connections_per_workspace = 2;
        let state = test_server_state(TenancyConfig {
            limits,
            ..TenancyConfig::default()
        })
        .await;
        let ws = WorkspaceId::single_tenant();
        // Cap applies to the total regardless of editor/viewer mix.
        assert!(state.try_register_workspace_connection(&ws, true, None).await.is_ok());
        assert!(state.try_register_workspace_connection(&ws, false, None).await.is_ok());
        assert_eq!(
            state.try_register_workspace_connection(&ws, true, None).await,
            Err(WorkspaceLimitError::CapExceeded)
        );
        state.release_workspace_connection(&ws, false).await;
        assert!(state.try_register_workspace_connection(&ws, true, None).await.is_ok());
    }

    /// The editor/viewer split is tracked independently and balances on
    /// release; viewers don't count toward the editor metering signal.
    #[tokio::test]
    async fn editor_viewer_counts_split_and_balance() {
        let limits = LimitsConfig {
            max_ws_connections_per_workspace: 10,
            ..LimitsConfig::default()
        };
        let state = test_server_state(TenancyConfig {
            limits,
            ..TenancyConfig::default()
        })
        .await;
        let alpha = WorkspaceId::from_configured("alpha").unwrap();
        let beta = WorkspaceId::from_configured("beta").unwrap();

        state.try_register_workspace_connection(&alpha, true, None).await.unwrap();
        state.try_register_workspace_connection(&alpha, true, None).await.unwrap();
        state.try_register_workspace_connection(&alpha, false, None).await.unwrap();
        state.try_register_workspace_connection(&beta, false, None).await.unwrap();

        assert_eq!(state.active_editor_count().await, 2);
        assert_eq!(state.active_viewer_count().await, 2);

        // Releasing a viewer leaves the editor count untouched.
        state.release_workspace_connection(&alpha, false).await;
        assert_eq!(state.active_editor_count().await, 2);
        assert_eq!(state.active_viewer_count().await, 1);

        state.release_workspace_connection(&alpha, true).await;
        assert_eq!(state.active_editor_count().await, 1);
    }

    /// JP-81: the concurrent-editor cap refuses the Nth + 1 *editor* while
    /// viewers stay uncapped; releasing an editor frees a slot.
    #[tokio::test]
    async fn editor_cap_rejects_extra_editors_but_not_viewers() {
        let limits = LimitsConfig {
            max_ws_connections_per_workspace: 100,
            ..LimitsConfig::default()
        };
        let state = test_server_state(TenancyConfig {
            limits,
            ..TenancyConfig::default()
        })
        .await;
        let ws = WorkspaceId::single_tenant();
        let editor_limit = Some(2);

        assert!(state.try_register_workspace_connection(&ws, true, editor_limit).await.is_ok());
        assert!(state.try_register_workspace_connection(&ws, true, editor_limit).await.is_ok());
        assert_eq!(
            state.try_register_workspace_connection(&ws, true, editor_limit).await,
            Err(WorkspaceLimitError::EditorCapExceeded)
        );
        // Viewers are never refused on the editor axis.
        assert!(state.try_register_workspace_connection(&ws, false, editor_limit).await.is_ok());
        assert!(state.try_register_workspace_connection(&ws, false, editor_limit).await.is_ok());
        // Releasing an editor makes room for one more.
        state.release_workspace_connection(&ws, true).await;
        assert!(state.try_register_workspace_connection(&ws, true, editor_limit).await.is_ok());
    }

    /// JP-81: `editor_limit = None` is unlimited (only the total-connection
    /// ceiling applies).
    #[tokio::test]
    async fn editor_cap_none_is_unlimited() {
        let limits = LimitsConfig {
            max_ws_connections_per_workspace: 100,
            ..LimitsConfig::default()
        };
        let state = test_server_state(TenancyConfig {
            limits,
            ..TenancyConfig::default()
        })
        .await;
        let ws = WorkspaceId::single_tenant();
        for _ in 0..20 {
            state.try_register_workspace_connection(&ws, true, None).await.unwrap();
        }
        assert_eq!(state.active_editor_count().await, 20);
    }

    /// JP-81: effective limits prefer the JWT claim, fall back to config, and
    /// normalise `0` → `None` (unlimited) from either source.
    #[tokio::test]
    async fn resolve_limits_claim_overrides_config_and_zero_is_unlimited() {
        let limits = LimitsConfig {
            storage_quota_bytes: 1000,
            max_editors_per_workspace: 5,
            ..LimitsConfig::default()
        };
        let state = test_server_state(TenancyConfig {
            limits,
            ..TenancyConfig::default()
        })
        .await;

        // Claim absent → config fallback.
        let eff = state.resolve_limits(ClaimLimits::default());
        assert_eq!(eff.quota_bytes, Some(1000));
        assert_eq!(eff.editor_limit, Some(5));

        // Claim present → overrides config.
        let eff = state.resolve_limits(ClaimLimits {
            quota_bytes: Some(2048),
            editor_limit: Some(3),
        });
        assert_eq!(eff.quota_bytes, Some(2048));
        assert_eq!(eff.editor_limit, Some(3));

        // Claim 0 → unlimited (overrides a non-zero config).
        let eff = state.resolve_limits(ClaimLimits {
            quota_bytes: Some(0),
            editor_limit: Some(0),
        });
        assert_eq!(eff.quota_bytes, None);
        assert_eq!(eff.editor_limit, None);

        // Config 0 default + claim absent → unlimited.
        let state2 = test_server_state(TenancyConfig::default()).await;
        let eff = state2.resolve_limits(ClaimLimits::default());
        assert_eq!(eff.quota_bytes, None);
        assert_eq!(eff.editor_limit, None);
    }

}
