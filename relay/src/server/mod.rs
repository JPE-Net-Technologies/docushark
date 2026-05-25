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

pub mod blobs;
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
use std::collections::HashMap;
use std::net::IpAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::{broadcast, mpsc, RwLock};
use tower_http::cors::{Any, CorsLayer};

use blobs::BlobStore;
use documents::DocumentStore;
use governor::{
    clock::DefaultClock, state::keyed::DefaultKeyedStateStore, Quota, RateLimiter,
};
use std::num::NonZeroU32;
use protocol::*;
use crate::auth::{AuthError, OidcAuthState, OidcClaims};
use crate::config::{TenancyConfig, TenancyMode};

/// Per-workspace token-bucket limiter shared between WS sync handlers
/// and MCP write tools. Phase 21.3.
pub type WorkspaceWriteLimiter =
    RateLimiter<WorkspaceId, DefaultKeyedStateStore<WorkspaceId>, DefaultClock>;

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
    tx: mpsc::Sender<Vec<u8>>,
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
    CapExceeded,
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
    /// Per-workspace authenticated WS connection counts. Enforces
    /// `tenancy.limits.max_ws_connections_per_workspace`.
    workspace_client_counts: RwLock<HashMap<WorkspaceId, u32>>,
    /// Per-workspace token-bucket limiter for writes. Shared with the
    /// MCP server so a tenant's CRDT frames and MCP write tools draw
    /// from the same bucket. Phase 21.3.
    write_limiter: Arc<WorkspaceWriteLimiter>,
    /// Process-wide counter of caught handler panics. Shared with the
    /// MCP server so both subsystems' panics surface at the same
    /// `/metrics` counter. Phase 21.2.
    panic_count: Arc<AtomicU64>,
    /// DEBUG-only trigger: when set, any WS handler that observes a
    /// client with this workspace id will panic on entry. Compiled out
    /// of release builds. Phase 21.2.
    #[cfg(debug_assertions)]
    panic_tenant_trigger: Option<WorkspaceId>,
}

impl ServerState {
    #[allow(clippy::too_many_arguments)]
    fn new(
        app_data_dir: PathBuf,
        auth: OidcAuthState,
        revocation_push_bearer: Option<String>,
        relay_region: String,
        tenancy: TenancyConfig,
        write_limiter: Arc<WorkspaceWriteLimiter>,
        panic_count: Arc<AtomicU64>,
        #[cfg(debug_assertions)] panic_tenant_trigger: Option<WorkspaceId>,
    ) -> Self {
        let (broadcast_tx, _) = broadcast::channel(100);
        Self {
            broadcast_tx,
            client_count: AtomicU16::new(0),
            next_client_id: AtomicU64::new(1),
            clients: RwLock::new(HashMap::new()),
            doc_store: Arc::new(DocumentStore::new(app_data_dir.clone())),
            blob_store: Arc::new(BlobStore::new(app_data_dir)),
            auth,
            revocation_push_bearer,
            relay_region,
            tenancy,
            workspace_client_counts: RwLock::new(HashMap::new()),
            write_limiter,
            panic_count,
            #[cfg(debug_assertions)]
            panic_tenant_trigger,
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

    /// Try to register a new authenticated WS connection for the
    /// given workspace. Returns `Err(WorkspaceLimitError::CapExceeded)`
    /// if the per-workspace cap would be exceeded. Increment is atomic
    /// with the check under the write lock.
    pub(crate) async fn try_register_workspace_connection(
        &self,
        ws: &WorkspaceId,
    ) -> Result<(), WorkspaceLimitError> {
        let cap = self.tenancy.limits.max_ws_connections_per_workspace;
        let mut counts = self.workspace_client_counts.write().await;
        let entry = counts.entry(ws.clone()).or_insert(0);
        if *entry >= cap {
            return Err(WorkspaceLimitError::CapExceeded);
        }
        *entry += 1;
        Ok(())
    }

    /// Mirror of `try_register_workspace_connection` used on clean
    /// disconnect.
    pub(crate) async fn release_workspace_connection(&self, ws: &WorkspaceId) {
        let mut counts = self.workspace_client_counts.write().await;
        if let Some(entry) = counts.get_mut(ws) {
            if *entry > 0 {
                *entry -= 1;
            }
        }
    }

    /// Increment the pod-wide handler-panic counter.
    pub(crate) fn record_panic(&self) {
        self.panic_count.fetch_add(1, Ordering::Relaxed);
    }

    /// Read the pod-wide handler-panic counter.
    pub(crate) fn panic_count(&self) -> u64 {
        self.panic_count.load(Ordering::Relaxed)
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
            auth: RwLock::new(None),
            revocation_push_bearer: RwLock::new(None),
            relay_region: RwLock::new("default".to_string()),
            tenancy: RwLock::new(TenancyConfig::default()),
            write_limiter: RwLock::new(None),
            panic_count: Arc::new(AtomicU64::new(0)),
            #[cfg(debug_assertions)]
            panic_tenant_trigger: RwLock::new(None),
        }
    }

    /// Replace the tenancy config (called during startup from
    /// `relay.toml` + CLI overrides). Must be called before `start()`.
    pub async fn set_tenancy(&self, tenancy: TenancyConfig) {
        *self.tenancy.write().await = tenancy;
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
        let tenancy = self.tenancy.read().await.clone();
        // Reuse the cached limiter so MCP and WS share one bucket.
        let write_limiter = self.build_write_limiter().await;
        #[cfg(debug_assertions)]
        let panic_tenant_trigger = self.panic_tenant_trigger.read().await.clone();

        // Create server state with document store
        let server_state = Arc::new(ServerState::new(
            app_data_dir,
            auth,
            revocation_push_bearer,
            relay_region,
            tenancy,
            write_limiter,
            panic_count,
            #[cfg(debug_assertions)]
            panic_tenant_trigger,
        ));
        *self.state.write().await = Some(server_state.clone());

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

        // Create router with WebSocket + blob endpoints, merged with
        // the REST surface defined in `crate::api`.
        let app = Router::new()
            .route("/ws", get(ws_handler))
            .route("/health", get(health_handler))
            .route("/metrics", get(metrics_handler))
            .route("/api/blobs/:hash", post(blob_upload_handler))
            .route("/api/blobs/:hash", get(blob_download_handler))
            .route("/api/blobs/:hash", head(blob_exists_handler))
            .merge(crate::api::routes())
            .with_state(server_state)
            .layer(cors);

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

/// Health check endpoint
async fn health_handler() -> impl IntoResponse {
    "OK"
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

    let body = format!(
        "# HELP relay_handler_panics_total Total handler panics caught at the per-message boundary.\n\
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
         relay_revocation_set_size {revocation_set_size}\n",
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
) -> Result<WorkspaceId, axum::response::Response> {
    let (ws, _role) = match WorkspaceId::from_oidc_array(claims, requested, state.relay_region()) {
        Ok(v) => v,
        Err(_) => {
            return Err((StatusCode::FORBIDDEN, "forbidden".to_string()).into_response());
        }
    };
    if state.check_tenancy(&ws).is_err() {
        return Err((StatusCode::FORBIDDEN, "forbidden".to_string()).into_response());
    }
    Ok(ws)
}

/// Upload a blob (POST /api/blobs/:hash)
async fn blob_upload_handler(
    Path(hash): Path<String>,
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> impl IntoResponse {
    // Validate JWT
    let claims = match extract_jwt_from_headers(&headers, &state).await {
        Ok(c) => c,
        Err((status, msg)) => return (status, msg).into_response(),
    };
    let ws = match resolve_blob_workspace(&state, &claims, None) {
        Ok(w) => w,
        Err(resp) => return resp,
    };

    // Extract MIME type from Content-Type header (default to application/octet-stream)
    let mime_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();

    // Save blob with hash verification — grants ACL to the uploading workspace.
    match state.blob_store.save_blob(&ws, &hash, &body, &mime_type, &claims.sub) {
        Ok(metadata) => {
            let json = serde_json::json!({
                "success": true,
                "hash": metadata.hash,
                "size": metadata.size,
                "mimeType": metadata.mime_type,
            });
            (StatusCode::OK, axum::Json(json)).into_response()
        }
        Err(e) => {
            if e.contains("Hash mismatch") {
                (StatusCode::BAD_REQUEST, e).into_response()
            } else {
                (StatusCode::INTERNAL_SERVER_ERROR, e).into_response()
            }
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
    let ws = match resolve_blob_workspace(&state, &claims, None) {
        Ok(w) => w,
        Err(resp) => return resp,
    };

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
    let ws = match resolve_blob_workspace(&state, &claims, None) {
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
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

/// Handle an individual WebSocket connection
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
            tx: tx.clone(),
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

    // Handle incoming messages from this client
    while let Some(Ok(msg)) = ws_receiver.next().await {
        match msg {
            Message::Binary(data) => {
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

    // Cleanup
    broadcast_task.abort();
    send_task.abort();

    let disconnect_ws = {
        let mut clients = state.clients.write().await;
        clients
            .remove(&client_id)
            .filter(|c| c.authenticated)
            .map(|c| c.current_workspace_id)
    };
    if let Some(ws) = disconnect_ws {
        state.release_workspace_connection(&ws).await;
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

    // Phase 21.3: per-message payload-size cap. Pathologically large
    // frames are rejected before dispatch — see `max_ws_payload_bytes`
    // in [tenancy.limits]. Returning `false` makes the receive loop
    // drop this connection via the existing isolation path.
    let cap = state.tenancy().limits.max_ws_payload_bytes;
    if data.len() > cap {
        let ws_id = {
            let clients = state.clients.read().await;
            clients
                .get(&client_id)
                .map(|c| c.current_workspace_id.as_str().to_string())
                .unwrap_or_default()
        };
        log::warn!(
            "ws frame too large client_id={} workspace_id={} bytes={} cap={}",
            client_id,
            ws_id,
            data.len(),
            cap,
        );
        return false;
    }

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
            MESSAGE_AWARENESS => handle_awareness(client_id, data, state).await,
            MESSAGE_JOIN_DOC => handle_join_doc(client_id, data, state).await,
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

    let (claim_ws, role) =
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

    if let Err(WorkspaceLimitError::CapExceeded) =
        state.try_register_workspace_connection(&claim_ws).await
    {
        log::warn!(
            "ws auth rejected: workspace cap exceeded client_id={} workspace_id={}",
            client_id,
            claim_ws.as_str()
        );
        send_auth_response(
            client_id,
            false,
            None,
            None,
            None,
            None,
            None,
            Some("ERR_WORKSPACE_CONNECTION_LIMIT"),
            state,
        )
        .await;
        return;
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
    };

    if let Ok(data) = encode_message(MESSAGE_AUTH_RESPONSE, &response) {
        send_to_client(client_id, data, state).await;
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
        log::debug!(
            "ws sync frame rate-limited client_id={} workspace_id={}",
            client_id,
            workspace_id.as_str()
        );
        send_rate_limit_error(client_id, state).await;
        return;
    }

    if let Some(doc_id) = doc_id {
        // Forward to clients on the same (workspace, doc) — both keys
        // are required so same-id docs in two workspaces don't cross.
        state.broadcast_to_doc(&workspace_id, &doc_id, data.to_vec(), Some(client_id));
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
        return;
    }

    {
        let mut clients = state.clients.write().await;
        if let Some(client) = clients.get_mut(&client_id) {
            log::info!("Client {} joined document {}", client_id, request.doc_id.as_str());
            client.current_doc_id = Some(request.doc_id);
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
            test_auth_state(),
            None,
            "default".to_string(),
            tenancy,
            write_limiter,
            panic_count.clone(),
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
                    tx,
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
            test_auth_state(),
            None,
            "default".to_string(),
            tenancy,
            write_limiter,
            Arc::new(AtomicU64::new(0)),
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
            },
            JwksCache::new("https://test.example.com/.well-known/jwks.json".to_string()),
            RevocationSet::new(),
        )
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
    /// in `handle_sync` instead of being broadcast.
    #[tokio::test]
    async fn handle_join_doc_rejects_unknown_doc_id() {
        let state = test_server_state(TenancyConfig::default()).await;

        // Register a fake authenticated client. No documents in the
        // doc store, so any JOIN_DOC is "unknown" by definition.
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
                    tx,
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
                    tx,
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
        assert!(state.try_register_workspace_connection(&ws).await.is_ok());
        assert!(state.try_register_workspace_connection(&ws).await.is_ok());
        assert_eq!(
            state.try_register_workspace_connection(&ws).await,
            Err(WorkspaceLimitError::CapExceeded)
        );
        state.release_workspace_connection(&ws).await;
        assert!(state.try_register_workspace_connection(&ws).await.is_ok());
    }

}
