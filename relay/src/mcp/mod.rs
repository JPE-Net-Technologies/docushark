//! Embedded MCP (Model Context Protocol) server.
//!
//! Lets external MCP clients (Claude Code, IDE plugins, etc.) inspect and
//! draft DocuShark documents. Bound to `127.0.0.1` and gated by a bearer
//! token persisted under the app data directory.
//!
//! See `plans/so-i-really-want-ancient-kay.md` for the foundation scope
//! and deferred follow-ups (batch writes, connectors, layout, comments,
//! live CRDT writes).

pub mod adapter;
pub mod config;
pub mod layout;
pub mod local_mirror;
pub mod outline;
pub mod token;
pub mod tools;
pub mod transport;

use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;

use tokio::sync::oneshot;
use tokio::sync::RwLock;

use crate::auth::OidcAuthState;
use crate::server::documents::DocumentStore;
use crate::server::protocol::DocId;
use crate::server::WorkspaceWriteLimiter;
use crate::sync::DocRegistry;
use tools::OnDocUpdate;
use config::McpFeatureConfigStore;
use local_mirror::LocalDocumentMirror;
use token::TokenStore;
use transport::McpAppState;

/// Status reported by `mcp_status` Tauri command.
#[derive(Clone, serde::Serialize)]
pub struct McpStatus {
    pub running: bool,
    pub port: u16,
    pub address: String,
}

/// Configuration for the MCP server. Kept tiny in the foundation.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct McpConfig {
    /// Port to listen on. 0 = OS-assigned (read back via status).
    pub port: u16,
}

impl Default for McpConfig {
    fn default() -> Self {
        Self { port: 9877 }
    }
}

/// Owns the running MCP HTTP server. One instance lives in `AppState`.
pub struct McpServer {
    config: RwLock<McpConfig>,
    bound_port: RwLock<u16>,
    shutdown: RwLock<Option<oneshot::Sender<()>>>,
    token: Arc<TokenStore>,
    doc_store: Arc<DocumentStore>,
    local_mirror: Arc<LocalDocumentMirror>,
    feature_config: Arc<McpFeatureConfigStore>,
    on_doc_changed: Arc<dyn Fn(DocId) + Send + Sync>,
    /// Shared panic counter — same atomic as `ServerState.panic_count`
    /// so the WS `/metrics` endpoint reflects MCP-side panics too.
    /// Phase 21.2.
    panic_counter: Arc<AtomicU64>,
    /// Shared write-limiter rejection counter — same atomic as
    /// `ServerState.rate_limit_rejections` so MCP throttles surface at
    /// the WS `/metrics` endpoint.
    rate_limit_rejections: Arc<AtomicU64>,
    /// Per-workspace write limiter shared with the WS subsystem.
    /// Phase 21.3.
    write_limiter: Arc<WorkspaceWriteLimiter>,
    /// OIDC validator + JWKS cache + revocation set, shared with the
    /// WS subsystem so MCP and WS accept the same relay-issued tokens.
    /// JP-77 + Phase 21.6.
    auth: OidcAuthState,
    /// Region this relay pod runs in.
    relay_region: String,
    /// Shared authoritative Y.Doc registry (JP-34) — the same `Arc` the WS
    /// server uses, so MCP writes hit the live doc connected clients are
    /// editing. JP-35.
    sync_registry: Arc<DocRegistry>,
    /// Broadcast sink for live-path CRDT deltas, wired to the WS server's
    /// `broadcast_to_doc`. JP-35.
    on_doc_update: Arc<OnDocUpdate>,
}

impl McpServer {
    /// Build a new MCP server. The token is loaded (or generated) from
    /// `app_data_dir`. `on_doc_changed` is invoked after each successful
    /// write so the caller can broadcast a `DocEvent` to connected clients.
    /// `panic_counter` is the shared `Arc<AtomicU64>` from
    /// `WebSocketServer::panic_counter_handle()` so MCP tool panics
    /// surface at the same `/metrics` counter.
    #[allow(clippy::too_many_arguments)] // shared handles wired from main.rs
    pub fn new(
        app_data_dir: PathBuf,
        on_doc_changed: Arc<dyn Fn(DocId) + Send + Sync>,
        panic_counter: Arc<AtomicU64>,
        rate_limit_rejections: Arc<AtomicU64>,
        write_limiter: Arc<WorkspaceWriteLimiter>,
        auth: OidcAuthState,
        relay_region: String,
        sync_registry: Arc<DocRegistry>,
        on_doc_update: Arc<OnDocUpdate>,
    ) -> Result<Self, String> {
        let token = Arc::new(TokenStore::load_or_create(&app_data_dir)?);
        let feature_config = Arc::new(McpFeatureConfigStore::load_or_create(&app_data_dir));
        let local_mirror = Arc::new(LocalDocumentMirror::new(app_data_dir.clone()));
        let doc_store = Arc::new(DocumentStore::new(app_data_dir));
        Ok(Self {
            config: RwLock::new(McpConfig::default()),
            bound_port: RwLock::new(0),
            shutdown: RwLock::new(None),
            token,
            doc_store,
            local_mirror,
            feature_config,
            on_doc_changed,
            panic_counter,
            rate_limit_rejections,
            write_limiter,
            auth,
            relay_region,
            sync_registry,
            on_doc_update,
        })
    }

    pub fn local_mirror(&self) -> Arc<LocalDocumentMirror> {
        self.local_mirror.clone()
    }

    pub fn feature_config(&self) -> Arc<McpFeatureConfigStore> {
        self.feature_config.clone()
    }

    pub async fn is_running(&self) -> bool {
        self.shutdown.read().await.is_some()
    }

    pub async fn status(&self) -> McpStatus {
        let running = self.is_running().await;
        let port = *self.bound_port.read().await;
        McpStatus {
            running,
            port,
            address: format!("127.0.0.1:{}", port),
        }
    }

    pub async fn get_token(&self) -> String {
        self.token.current()
    }

    pub async fn regenerate_token(&self) -> Result<String, String> {
        self.token.regenerate()
    }

    /// Replace the token with a user-supplied value. Validated against
    /// [`token::validate`] before persisting; returns the trimmed token
    /// that was stored.
    pub async fn set_token(&self, candidate: &str) -> Result<String, String> {
        self.token.set(candidate)
    }

    pub async fn set_config(&self, config: McpConfig) -> Result<(), String> {
        if self.is_running().await {
            return Err("Cannot change MCP config while server is running".into());
        }
        *self.config.write().await = config;
        Ok(())
    }

    /// Start the HTTP listener. Returns the bound address.
    pub async fn start(&self) -> Result<String, String> {
        if self.is_running().await {
            return Err("MCP server already running".into());
        }

        let port = self.config.read().await.port;
        let bind_addr = format!("127.0.0.1:{}", port);
        let listener = tokio::net::TcpListener::bind(&bind_addr)
            .await
            .map_err(|e| format!("Failed to bind MCP server on {}: {}", bind_addr, e))?;
        let local_addr = listener
            .local_addr()
            .map_err(|e| format!("Failed to read MCP local addr: {}", e))?;

        let state = McpAppState {
            doc_store: self.doc_store.clone(),
            local_mirror: self.local_mirror.clone(),
            feature_config: self.feature_config.clone(),
            token: self.token.clone(),
            on_doc_changed: self.on_doc_changed.clone(),
            panic_counter: self.panic_counter.clone(),
            rate_limit_rejections: self.rate_limit_rejections.clone(),
            write_limiter: self.write_limiter.clone(),
            auth: self.auth.clone(),
            relay_region: self.relay_region.clone(),
            sync_registry: self.sync_registry.clone(),
            on_doc_update: self.on_doc_update.clone(),
        };
        let app = transport::router(state);

        let (tx, rx) = oneshot::channel::<()>();
        *self.shutdown.write().await = Some(tx);
        *self.bound_port.write().await = local_addr.port();

        tokio::spawn(async move {
            let server = axum::serve(listener, app).with_graceful_shutdown(async {
                let _ = rx.await;
            });
            if let Err(e) = server.await {
                log::error!("MCP server error: {}", e);
            }
        });

        log::info!("MCP server listening on http://{}", local_addr);
        Ok(format!("http://{}", local_addr))
    }

    pub async fn stop(&self) -> Result<(), String> {
        if let Some(tx) = self.shutdown.write().await.take() {
            let _ = tx.send(());
            *self.bound_port.write().await = 0;
            log::info!("MCP server stopped");
            Ok(())
        } else {
            Err("MCP server not running".into())
        }
    }
}
