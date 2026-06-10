//! Relay configuration (TOML).
//!
//! Loaded by `relay serve` from a path supplied on the CLI (defaults
//! to `./relay.toml`). `relay init` writes a starter file pointing the
//! relay at an external OIDC issuer (JP-77); operators fill in the
//! issuer URL + JWKS + audience before first boot.
//!
//! Layout deliberately small. Postgres, S3, TLS, and per-user keys
//! are out of scope for Phase 20 (deferred to the managed tier).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Default port for the HTTP + WebSocket listener.
pub const DEFAULT_LISTEN_PORT: u16 = 9876;

/// Default port for the MCP listener (separate from the sync port —
/// MCP is exposed only on loopback for now).
pub const DEFAULT_MCP_PORT: u16 = 9877;

/// Default storage root, relative to the working directory at startup.
pub const DEFAULT_DATA_DIR: &str = "data";

/// Default poll interval for the JTI revocation fallback transport.
/// Matches the 60-second propagation window in
/// `relay/docs/api/revocation.md`.
pub const DEFAULT_REVOCATION_POLL_SECONDS: u64 = 60;

/// Default audience accepted on inbound RS256 tokens. Matches the
/// constant in `relay/docs/api/token-format.md`.
pub const DEFAULT_AUDIENCE: &str = "docushark-relay";

// ---- Phase 21.5 + 21.3: tenancy + per-workspace limits ----
//
// Default limit values track the Free-Tier Enforcement Spec § 3.
// That spec lives in the private project board and is intentionally
// not linked from OSS code (CLAUDE.md one-way-link discipline). If you
// change these defaults, propose the matching change in the spec.

/// Default token-bucket refill rate (writes / sec) per workspace.
pub const DEFAULT_WRITES_PER_SEC: u32 = 40;
/// Default burst size for the per-workspace write bucket.
pub const DEFAULT_WRITES_BURST: u32 = 80;
/// Default token-bucket refill rate (MCP reads / sec) per workspace (JP-249).
/// Reads are cheap, so this is generous — a public-pod backstop against a
/// read-storm, not a throttle on normal agent use. `0` = unlimited.
pub const DEFAULT_READS_PER_SEC: u32 = 100;
/// Default burst size for the per-workspace MCP read bucket.
pub const DEFAULT_READS_BURST: u32 = 200;
/// Default cap on concurrent authenticated WS connections per workspace.
pub const DEFAULT_MAX_WS_CONNECTIONS_PER_WORKSPACE: u32 = 25;
/// Default cap on a single WS frame's payload size (bytes). Pathological
/// updates are rejected with WS close 1009. Phase 21.3 reframed
/// deliverable: there is no server-side Y.Doc history to bound, but a
/// per-frame size cap closes the same blast-radius concern.
pub const DEFAULT_MAX_WS_PAYLOAD_BYTES: usize = 262_144; // 256 KiB

/// Max body size for a single blob upload (`POST /api/blobs/:hash`). The
/// per-workspace `storage_quota_bytes` is the real cap; this just bounds one
/// request so the in-memory `Bytes` buffer can't grow unbounded. Without it,
/// Axum's 2 MiB default silently 413s larger blobs (JP-125).
pub const DEFAULT_MAX_BLOB_BYTES: usize = 157_286_400; // 150 MiB

/// Default cap on concurrent in-memory blob uploads across the proxy and
/// URL-ingest paths. Both buffer up to `max_blob_bytes`, so worst-case upload
/// RAM ≈ this × `max_blob_bytes`. Bounds the cross-tenant OOM risk on small
/// shared pods (RB-1b / JP-299). 4 × 150 MiB ≈ 600 MiB peak at the defaults.
pub const DEFAULT_MAX_CONCURRENT_BLOB_UPLOADS: usize = 4;

/// Default presigned PUT URL lifetime when `backend = "s3"`. Generous so a
/// slow large upload can finish inside the window; the content-length pinned
/// into the signature keeps a long TTL safe.
pub const DEFAULT_S3_PUT_TTL_SECS: u64 = 3600; // 1h
/// Default presigned GET URL lifetime when `backend = "s3"`.
pub const DEFAULT_S3_GET_TTL_SECS: u64 = 3600; // 1h

// ---- JP-81: single-meter free-tier enforcement fallbacks ----
//
// These are the *fallback* limits applied when a JWT `wsp[]` claim omits
// `quota_bytes` / `editor_limit` (self-host, `dedicated` mode, or a legacy
// token). The effective limit is always "claim value if present, else this
// config default." `0` means **unlimited / disabled** — the safe-by-default
// self-host story; DocuShark Cloud injects real per-tier numbers via the
// claim (or per-pod config). The relay enforces raw numbers and never knows
// tiers.

/// Default per-workspace storage byte quota fallback. `0` = unlimited.
pub const DEFAULT_STORAGE_QUOTA_BYTES: u64 = 0;
/// Default per-workspace concurrent-editor cap fallback. `0` = unlimited.
/// Distinct from `max_ws_connections_per_workspace` (the total-connection
/// safety ceiling that also guards pure-viewer flooding).
pub const DEFAULT_MAX_EDITORS_PER_WORKSPACE: u32 = 0;

/// Grace period (seconds) before an orphaned blob's bytes are reclaimed
/// (JP-127 defense-in-depth). `0` = reclaim immediately (default; preserves
/// self-host behavior). A positive value defers reclaim so a transient blob
/// reference-drop followed by a correction can't irreversibly delete bytes.
pub const DEFAULT_BLOB_GC_GRACE_SECS: u64 = 0;

/// Network exposure for the sync listener.
///
/// `Localhost` binds only to 127.0.0.1; `Lan` binds 0.0.0.0 (the
/// historical Protected-Local "LAN access enabled" mode).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum NetworkMode {
    Localhost,
    Lan,
}

impl Default for NetworkMode {
    fn default() -> Self {
        // Default = LAN to match historical behavior. Operators who
        // want loopback-only flip this to `localhost`.
        Self::Lan
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ServerConfig {
    /// TCP port for the HTTP + WebSocket listener.
    pub port: u16,
    /// Network exposure mode.
    pub network_mode: NetworkMode,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            port: DEFAULT_LISTEN_PORT,
            network_mode: NetworkMode::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct StorageConfig {
    /// Blob byte-storage backend: `"filesystem"` (default — local sharded
    /// files; the zero-dependency self-host + dev + test path) or `"s3"` (any
    /// S3-compatible object store, e.g. Cloudflare R2; configured via [`s3`]).
    /// Document/CRDT state always lives under `path`; only blob *bytes* follow
    /// this selector.
    ///
    /// [`s3`]: StorageConfig::s3
    pub backend: String,
    /// Path to the storage root (documents, blobs, users.json).
    pub path: PathBuf,
    /// S3/R2 connection details. Required when `backend = "s3"`, ignored for
    /// `filesystem`. From `[storage.s3]` in TOML or the `RELAY_R2_*` env vars.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub s3: Option<S3StorageConfig>,
}

impl Default for StorageConfig {
    fn default() -> Self {
        Self {
            backend: "filesystem".into(),
            path: PathBuf::from(DEFAULT_DATA_DIR),
            s3: None,
        }
    }
}

/// Connection + credentials for an S3-compatible blob byte store (Cloudflare
/// R2 at Cloud; any S3 API for self-host). Mapped onto the runtime
/// `server::blob_backend::S3Config` at startup.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct S3StorageConfig {
    /// Endpoint base URL (e.g. `https://<acct>.r2.cloudflarestorage.com`).
    pub endpoint: String,
    /// Bucket name (path-style addressing — robust against a custom endpoint).
    pub bucket: String,
    /// Signing region. `"auto"` for Cloudflare R2.
    pub region: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    /// Optional key prefix (e.g. `"blobs/"`); empty for none.
    pub key_prefix: String,
    /// Presigned PUT URL lifetime (seconds).
    pub put_ttl_secs: u64,
    /// Presigned GET URL lifetime (seconds).
    pub get_ttl_secs: u64,
}

impl Default for S3StorageConfig {
    fn default() -> Self {
        Self {
            endpoint: String::new(),
            bucket: String::new(),
            region: "auto".into(),
            access_key_id: String::new(),
            secret_access_key: String::new(),
            key_prefix: String::new(),
            put_ttl_secs: DEFAULT_S3_PUT_TTL_SECS,
            get_ttl_secs: DEFAULT_S3_GET_TTL_SECS,
        }
    }
}

impl S3StorageConfig {
    /// Whether the four required connection fields are all set — the gate for
    /// auto-selecting `backend = "s3"` and for a usable backend at startup.
    pub fn is_complete(&self) -> bool {
        !self.endpoint.is_empty()
            && !self.bucket.is_empty()
            && !self.access_key_id.is_empty()
            && !self.secret_access_key.is_empty()
    }
}

/// OIDC resource-server configuration (JP-77). The relay no longer
/// issues tokens; it validates RS256 JWTs minted by an external
/// issuer. Self-hosters can point this at any conforming OIDC
/// provider (Keycloak, dex, Authelia, ZITADEL, Supabase, or
/// DocuShark Cloud's `docushark-web`).
///
/// At least `issuer`, `jwks_url`, and `audience` must be set before
/// `relay serve` will accept inbound traffic — there is no default
/// signing secret to fall back to.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct AuthConfig {
    /// Token `iss` claim value. Verified verbatim.
    pub issuer: String,
    /// HTTPS URL the relay GETs to populate the JWKS cache. 5-minute
    /// TTL + 1-hour fail-open grace per `token-format.md`.
    pub jwks_url: String,
    /// Token `aud` claim value. Defaults to `"docushark-relay"`.
    pub audience: String,
    /// Shared secret authenticating the push transport
    /// (`POST /api/v1/internal/revoke`). Constant-time compared.
    /// Optional — leave blank to disable push.
    #[serde(default)]
    pub revocation_push_bearer: Option<String>,
    /// Control-plane URL the relay polls for new revocations
    /// when the push transport is unavailable.
    #[serde(default)]
    pub revocation_polling_url: Option<String>,
    /// Bearer the relay sends on the polling GET.
    #[serde(default)]
    pub revocation_polling_bearer: Option<String>,
    /// Polling cadence. Defaults to 60 seconds.
    #[serde(default)]
    pub revocation_polling_interval_seconds: Option<u64>,
}

impl Default for AuthConfig {
    fn default() -> Self {
        Self {
            issuer: String::new(),
            jwks_url: String::new(),
            audience: DEFAULT_AUDIENCE.to_string(),
            revocation_push_bearer: None,
            revocation_polling_url: None,
            revocation_polling_bearer: None,
            revocation_polling_interval_seconds: None,
        }
    }
}

/// AU-4: accept an `https://` JWKS URL, or `http://` only for a loopback host
/// (dev). Rejects plaintext to any real host, where a MITM could swap the keys.
fn jwks_url_scheme_ok(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    if lower.starts_with("https://") {
        return true;
    }
    if let Some(rest) = lower.strip_prefix("http://") {
        // Host runs up to the first `/`, `:`, `?`, or `#`.
        let host = rest
            .split(['/', ':', '?', '#'])
            .next()
            .unwrap_or("");
        return matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1");
    }
    false
}

impl AuthConfig {
    /// Returns an error if any required OIDC field is unset. Called by
    /// `relay serve` at startup before binding listeners.
    pub fn validate(&self) -> Result<(), String> {
        if self.issuer.trim().is_empty() {
            return Err("auth.issuer is required".to_string());
        }
        if self.jwks_url.trim().is_empty() {
            return Err("auth.jwks_url is required".to_string());
        }
        // AU-4 (JP-300): an `http://` JWKS URL lets a network MITM inject signing
        // keys — a full auth bypass for self-hosters. Require HTTPS, carving out
        // loopback for local dev.
        if !jwks_url_scheme_ok(self.jwks_url.trim()) {
            return Err(
                "auth.jwks_url must use https:// (http:// is allowed only for localhost)"
                    .to_string(),
            );
        }
        if self.audience.trim().is_empty() {
            return Err("auth.audience is required".to_string());
        }
        Ok(())
    }

    /// Whether the relay has *any* revocation transport wired — a control-plane
    /// push bearer or a polling URL. With neither, revoked tokens are accepted
    /// until expiry (AU-5a).
    pub fn has_revocation_transport(&self) -> bool {
        self.revocation_push_bearer.is_some() || self.revocation_polling_url.is_some()
    }

    pub fn revocation_polling_interval(&self) -> std::time::Duration {
        std::time::Duration::from_secs(
            self.revocation_polling_interval_seconds
                .unwrap_or(DEFAULT_REVOCATION_POLL_SECONDS),
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct McpConfig {
    /// Whether the MCP endpoint is exposed at all.
    pub enabled: bool,
    /// TCP port for the loopback MCP HTTP listener. Used only by
    /// `expose = "local"`; ignored when `expose = "public"` (the MCP
    /// routes then ride the main sync/REST listener's port instead).
    pub port: u16,
    /// Where the MCP endpoint is reachable. `local` (default) binds a
    /// loopback-only listener on `port` — desktop and self-host. `public`
    /// folds `/mcp` + the RFC 9728 discovery doc onto the main HTTP
    /// listener (the one already serving `/ws` + REST), so a remote MCP
    /// client can reach it on the relay's real origin. A `public` pod also
    /// refuses the static bearer token: callers must present a JWT whose
    /// `wsp` claim scopes the request to a workspace.
    pub expose: McpExpose,
}

/// Reachability of the MCP endpoint. See [`McpConfig::expose`].
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum McpExpose {
    Local,
    Public,
}

impl Default for McpExpose {
    fn default() -> Self {
        // Loopback-only by default: a self-hoster or desktop build never
        // exposes MCP to the network without explicitly opting in.
        Self::Local
    }
}

impl Default for McpConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            port: DEFAULT_MCP_PORT,
            expose: McpExpose::default(),
        }
    }
}

/// Tenancy mode. `dedicated` pins the relay to a single workspace and
/// refuses cross-tenant traffic; `shared` routes per request by the
/// JWT `wsp` claim. Phase 21.5.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TenancyMode {
    Shared,
    Dedicated,
}

impl Default for TenancyMode {
    fn default() -> Self {
        // Safe-by-default: self-hosters on a single-workspace deploy
        // get dedicated mode. Cloud explicitly opts into `shared`.
        Self::Dedicated
    }
}

/// Per-workspace traffic limits (Phase 21.3).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct LimitsConfig {
    /// Token-bucket refill rate (writes / second) per workspace.
    /// Applies to CRDT sync frames and MCP write tools.
    pub writes_per_sec: u32,
    /// Burst capacity for the per-workspace write bucket.
    pub writes_burst: u32,
    /// Token-bucket refill rate (MCP reads / second) per workspace (JP-249).
    /// `0` = unlimited (loopback/self-host). Separate from the write bucket so a
    /// read-storm never contends with live WS editing.
    pub reads_per_sec: u32,
    /// Burst capacity for the per-workspace MCP read bucket.
    pub reads_burst: u32,
    /// Cap on concurrent authenticated WS connections per workspace.
    pub max_ws_connections_per_workspace: u32,
    /// Cap on a single WS frame's payload size (bytes).
    pub max_ws_payload_bytes: usize,
    /// Max body size for a single blob upload (`POST /api/blobs/:hash`), bytes.
    /// Bounds in-memory buffering; the per-workspace storage quota is the real
    /// cap. Without this the Axum default (2 MiB) silently 413s larger blobs
    /// (JP-125).
    pub max_blob_bytes: usize,
    /// Cap on concurrent in-memory blob uploads across the proxy
    /// (`POST /api/blobs/:hash`) and URL-ingest paths. Both buffer up to
    /// `max_blob_bytes`, so worst-case upload RAM ≈ `max_concurrent_blob_uploads
    /// × max_blob_bytes`. Bounds the cross-tenant OOM risk on small shared pods
    /// (RB-1b / JP-299); raise for throughput on larger pods. Effective minimum
    /// is 1 (a `0` is treated as 1).
    pub max_concurrent_blob_uploads: usize,
    /// Fallback per-workspace storage byte quota (JP-81), used when the
    /// JWT claim omits `quota_bytes`. `0` = unlimited.
    pub storage_quota_bytes: u64,
    /// Fallback per-workspace concurrent-editor cap (JP-81), used when the
    /// JWT claim omits `editor_limit`. `0` = unlimited. Viewers are never
    /// counted here; the total-connection ceiling above still applies.
    pub max_editors_per_workspace: u32,
    /// Grace (seconds) before an orphaned blob's bytes are reclaimed (JP-127).
    /// `0` = immediate. A positive value defers reclaim so a transient blob
    /// reference-drop (e.g. a bad reconnect save) can be corrected without
    /// irreversible byte loss; the released ACL means it's already unmetered.
    pub blob_gc_grace_secs: u64,
    /// Host allowlist for the generic blob ingest-from-URL endpoint
    /// (`POST /api/v1/blobs/ingest-from-url`). Each entry is an exact host
    /// (`api.example.com`) or a `*.`-prefixed suffix wildcard (`*.example.com`,
    /// which also matches the bare suffix). **Empty disables the endpoint**
    /// (403) — the relay is never an open fetch proxy by default; an operator
    /// opts in by listing the hosts an integration may pull bytes from.
    /// Enforced on the initial URL *and every redirect hop*, alongside a
    /// private/loopback IP-literal block.
    #[serde(default)]
    pub blob_ingest_allowed_hosts: Vec<String>,
}

impl Default for LimitsConfig {
    fn default() -> Self {
        Self {
            writes_per_sec: DEFAULT_WRITES_PER_SEC,
            writes_burst: DEFAULT_WRITES_BURST,
            reads_per_sec: DEFAULT_READS_PER_SEC,
            reads_burst: DEFAULT_READS_BURST,
            max_ws_connections_per_workspace: DEFAULT_MAX_WS_CONNECTIONS_PER_WORKSPACE,
            max_ws_payload_bytes: DEFAULT_MAX_WS_PAYLOAD_BYTES,
            max_blob_bytes: DEFAULT_MAX_BLOB_BYTES,
            max_concurrent_blob_uploads: DEFAULT_MAX_CONCURRENT_BLOB_UPLOADS,
            storage_quota_bytes: DEFAULT_STORAGE_QUOTA_BYTES,
            max_editors_per_workspace: DEFAULT_MAX_EDITORS_PER_WORKSPACE,
            blob_gc_grace_secs: DEFAULT_BLOB_GC_GRACE_SECS,
            blob_ingest_allowed_hosts: Vec::new(),
        }
    }
}

/// Tenancy section. Phase 21.5.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct TenancyConfig {
    pub mode: TenancyMode,
    /// In `dedicated` mode this pins the relay to one workspace id.
    /// When blank, the relay pins to the legacy `"default"` workspace
    /// so pre-21.5 self-hosters keep working unchanged.
    pub workspace_id: Option<String>,
    pub limits: LimitsConfig,
}

impl Default for TenancyConfig {
    fn default() -> Self {
        Self {
            mode: TenancyMode::default(),
            workspace_id: None,
            limits: LimitsConfig::default(),
        }
    }
}

/// Observability section. Controls the metering signals the relay
/// exposes for the storage / concurrency / write-throttle axes. The
/// pod-level Prometheus series at `/metrics` are always on; this section
/// only gates the verbose per-workspace breakdown, which is opt-in
/// because it's O(workspaces) work per scrape and noisy in logs.
///
/// Generic by design: the relay emits raw counts (bytes, editor/viewer
/// connections, throttle rejections); any quota or billing interpretation
/// lives in the control plane, not the OSS relay.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ObservabilityConfig {
    /// When true, each `/metrics` scrape also logs a per-workspace
    /// metering snapshot (storage bytes + editor/viewer counts) at
    /// `debug` level. Off by default. Pod-level aggregates are emitted
    /// at `/metrics` regardless of this flag.
    pub metering_debug_log: bool,
}

impl Default for ObservabilityConfig {
    fn default() -> Self {
        Self {
            metering_debug_log: false,
        }
    }
}

/// Default cadence for the relay's `Y.Doc → JSON` snapshot sweeper (JP-36).
const DEFAULT_SNAPSHOT_INTERVAL_SECS: u64 = 10;

/// Persistence section (JP-36). Controls how often the relay flattens its
/// authoritative in-memory `Y.Doc`s back to their JSON snapshots. Snapshots
/// also fire on last-client eviction and graceful shutdown regardless of this
/// interval.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct SyncConfig {
    /// Seconds between snapshot sweeps. `0` disables the timer (eviction +
    /// shutdown flushes still run).
    pub snapshot_interval_secs: u64,
    /// Persist the authoritative `Y.Doc` as a **binary** sidecar (JP-108)
    /// alongside the JSON snapshot, and hydrate from it (preserving CRDT
    /// identity + prose across evict/rehydrate) when current. Default on;
    /// set false to fall back to pure-JSON persistence (ops rollback).
    pub binary_persistence: bool,
    /// Defense-in-depth against a poisoned persisted `Y.Doc` (JP-180). On
    /// hydrate, if a current binary sidecar decodes to 0 shapes while the JSON
    /// snapshot still holds N>0, prefer JSON (and rebuild the binary) instead of
    /// silently serving empty. On snapshot, if a resident doc would drop from
    /// N>0 to 0 shapes, copy the prior state into the recovery store first so a
    /// single bad client can't permanently zero a document. Default on.
    pub poison_guard: bool,
    /// JP-231 working-set cache cap. When the relay's local document footprint
    /// (sum of cached `.json`/`.ydoc`/recovery bytes) exceeds this, the snapshot
    /// sweeper evicts the coldest docs that are confirmed mirrored to R2 and not
    /// actively synced — the volume becomes an LRU cache, the durable corpus
    /// lives in R2 (JP-200). `0` disables eviction (self-host / no R2). Set this
    /// **below** the volume's auto-extend threshold so eviction is the normal
    /// reclaim path and auto-extend only fires under genuine pressure.
    pub doc_cache_max_bytes: u64,
}

impl Default for SyncConfig {
    fn default() -> Self {
        Self {
            snapshot_interval_secs: DEFAULT_SNAPSHOT_INTERVAL_SECS,
            binary_persistence: true,
            poison_guard: true,
            doc_cache_max_bytes: 0,
        }
    }
}

/// Top-level relay config. All sections optional in the TOML; missing
/// sections fall back to `Default::default()`.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
pub struct RelayConfig {
    pub server: ServerConfig,
    pub storage: StorageConfig,
    pub auth: AuthConfig,
    pub mcp: McpConfig,
    pub tenancy: TenancyConfig,
    pub observability: ObservabilityConfig,
    pub sync: SyncConfig,
}

impl RelayConfig {
    /// Load and parse the TOML at `path`. Returns `Ok(None)` if the
    /// file doesn't exist (callers warn + fall back to defaults).
    pub fn load(path: &Path) -> anyhow::Result<Option<Self>> {
        if !path.exists() {
            return Ok(None);
        }
        let raw = std::fs::read_to_string(path)
            .map_err(|e| anyhow::anyhow!("read {}: {}", path.display(), e))?;
        let config: RelayConfig = toml::from_str(&raw)
            .map_err(|e| anyhow::anyhow!("parse {}: {}", path.display(), e))?;
        Ok(Some(config))
    }

    /// Overlay `RELAY_*` environment variables onto the config.
    ///
    /// Intended to run *after* [`RelayConfig::load`] and *before* CLI
    /// overrides, giving the precedence `CLI flag > env > relay.toml >
    /// default`. Takes a getter closure rather than reading the process
    /// environment directly so callers — and tests — control the source.
    ///
    /// Generic by design: any operator running the relay in a container
    /// (Kubernetes, Nomad, plain Docker, a PaaS) can configure it purely
    /// from the environment without baking a `relay.toml` into the image.
    /// Unset variables leave the existing value untouched. Malformed
    /// values (a non-numeric port, an unknown mode) are a hard error.
    pub fn apply_env_overrides(
        &mut self,
        get: impl Fn(&str) -> Option<String>,
    ) -> anyhow::Result<()> {
        if let Some(v) = get("RELAY_PORT") {
            self.server.port = v
                .parse()
                .map_err(|_| anyhow::anyhow!("RELAY_PORT must be a u16 (got {v:?})"))?;
        }
        if let Some(v) = get("RELAY_NETWORK_MODE") {
            self.server.network_mode = match v.as_str() {
                "localhost" => NetworkMode::Localhost,
                "lan" => NetworkMode::Lan,
                other => {
                    anyhow::bail!("RELAY_NETWORK_MODE must be 'localhost' or 'lan' (got {other:?})")
                }
            };
        }
        if let Some(v) = get("RELAY_MCP_ENABLED") {
            self.mcp.enabled = match v.to_ascii_lowercase().as_str() {
                "1" | "true" | "yes" | "on" => true,
                "0" | "false" | "no" | "off" => false,
                other => anyhow::bail!("RELAY_MCP_ENABLED must be a boolean (got {other:?})"),
            };
        }
        if let Some(v) = get("RELAY_MCP_PORT") {
            self.mcp.port = v
                .parse()
                .map_err(|_| anyhow::anyhow!("RELAY_MCP_PORT must be a u16 (got {v:?})"))?;
        }
        if let Some(v) = get("RELAY_MCP_EXPOSE") {
            self.mcp.expose = match v.as_str() {
                "local" => McpExpose::Local,
                "public" => McpExpose::Public,
                other => {
                    anyhow::bail!("RELAY_MCP_EXPOSE must be 'local' or 'public' (got {other:?})")
                }
            };
        }
        if let Some(v) = get("RELAY_DATA_DIR") {
            self.storage.path = PathBuf::from(v);
        }
        if let Some(v) = get("RELAY_JWT_ISSUER") {
            self.auth.issuer = v;
        }
        if let Some(v) = get("RELAY_JWT_JWKS_URL") {
            self.auth.jwks_url = v;
        }
        if let Some(v) = get("RELAY_JWT_AUDIENCE") {
            self.auth.audience = v;
        }
        if let Some(v) = get("RELAY_REVOCATION_BEARER") {
            self.auth.revocation_push_bearer = Some(v);
        }
        if let Some(v) = get("RELAY_REVOCATION_POLLING_URL") {
            self.auth.revocation_polling_url = Some(v);
        }
        if let Some(v) = get("RELAY_REVOCATION_POLLING_BEARER") {
            self.auth.revocation_polling_bearer = Some(v);
        }
        if let Some(v) = get("RELAY_TENANCY_MODE") {
            self.tenancy.mode = match v.as_str() {
                "shared" => TenancyMode::Shared,
                "dedicated" => TenancyMode::Dedicated,
                other => {
                    anyhow::bail!("RELAY_TENANCY_MODE must be 'shared' or 'dedicated' (got {other:?})")
                }
            };
        }
        if let Some(v) = get("RELAY_TENANCY_WORKSPACE") {
            self.tenancy.workspace_id = Some(v);
        }
        if let Some(v) = get("RELAY_STORAGE_QUOTA_BYTES") {
            self.tenancy.limits.storage_quota_bytes = v
                .parse()
                .map_err(|_| anyhow::anyhow!("RELAY_STORAGE_QUOTA_BYTES must be a u64 (got {v:?})"))?;
        }
        if let Some(v) = get("RELAY_MAX_EDITORS_PER_WORKSPACE") {
            self.tenancy.limits.max_editors_per_workspace = v
                .parse()
                .map_err(|_| {
                    anyhow::anyhow!("RELAY_MAX_EDITORS_PER_WORKSPACE must be a u32 (got {v:?})")
                })?;
        }
        if let Some(v) = get("RELAY_MAX_BLOB_BYTES") {
            self.tenancy.limits.max_blob_bytes = v
                .parse()
                .map_err(|_| anyhow::anyhow!("RELAY_MAX_BLOB_BYTES must be a usize (got {v:?})"))?;
        }
        if let Some(v) = get("RELAY_MAX_CONCURRENT_BLOB_UPLOADS") {
            self.tenancy.limits.max_concurrent_blob_uploads = v.parse().map_err(|_| {
                anyhow::anyhow!("RELAY_MAX_CONCURRENT_BLOB_UPLOADS must be a usize (got {v:?})")
            })?;
        }
        if let Some(v) = get("RELAY_BLOB_GC_GRACE_SECS") {
            self.tenancy.limits.blob_gc_grace_secs = v
                .parse()
                .map_err(|_| anyhow::anyhow!("RELAY_BLOB_GC_GRACE_SECS must be a u64 (got {v:?})"))?;
        }
        if let Some(v) = get("RELAY_BLOB_INGEST_ALLOWED_HOSTS") {
            self.tenancy.limits.blob_ingest_allowed_hosts = v
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
        }
        if let Some(v) = get("RELAY_SNAPSHOT_INTERVAL_SECS") {
            self.sync.snapshot_interval_secs = v.parse().map_err(|_| {
                anyhow::anyhow!("RELAY_SNAPSHOT_INTERVAL_SECS must be a u64 (got {v:?})")
            })?;
        }
        if let Some(v) = get("RELAY_DOC_CACHE_MAX_BYTES") {
            self.sync.doc_cache_max_bytes = v.parse().map_err(|_| {
                anyhow::anyhow!("RELAY_DOC_CACHE_MAX_BYTES must be a u64 (got {v:?})")
            })?;
        }
        if let Some(v) = get("RELAY_BINARY_PERSISTENCE") {
            self.sync.binary_persistence = match v.to_ascii_lowercase().as_str() {
                "1" | "true" | "yes" | "on" => true,
                "0" | "false" | "no" | "off" => false,
                other => anyhow::bail!(
                    "RELAY_BINARY_PERSISTENCE must be a boolean (got {other:?})"
                ),
            };
        }
        if let Some(v) = get("RELAY_POISON_GUARD") {
            self.sync.poison_guard = match v.to_ascii_lowercase().as_str() {
                "1" | "true" | "yes" | "on" => true,
                "0" | "false" | "no" | "off" => false,
                other => anyhow::bail!(
                    "RELAY_POISON_GUARD must be a boolean (got {other:?})"
                ),
            };
        }

        // Blob byte-storage backend selection + S3/R2 credentials. Any
        // `RELAY_R2_*` var materializes `[storage.s3]`; a *complete* set
        // auto-selects `backend = "s3"` unless the operator pinned
        // `RELAY_STORAGE_BACKEND` (which always wins).
        let backend_pinned = get("RELAY_STORAGE_BACKEND").is_some();
        if let Some(v) = get("RELAY_STORAGE_BACKEND") {
            match v.as_str() {
                "filesystem" | "s3" => self.storage.backend = v,
                other => anyhow::bail!(
                    "RELAY_STORAGE_BACKEND must be 'filesystem' or 's3' (got {other:?})"
                ),
            }
        }
        let r2_vars = [
            "RELAY_R2_ENDPOINT",
            "RELAY_R2_BUCKET",
            "RELAY_R2_REGION",
            "RELAY_R2_ACCESS_KEY_ID",
            "RELAY_R2_SECRET_ACCESS_KEY",
            "RELAY_R2_KEY_PREFIX",
            "RELAY_R2_PUT_TTL_SECS",
            "RELAY_R2_GET_TTL_SECS",
        ];
        if r2_vars.iter().any(|k| get(k).is_some()) {
            let s3 = self.storage.s3.get_or_insert_with(S3StorageConfig::default);
            if let Some(v) = get("RELAY_R2_ENDPOINT") {
                s3.endpoint = v;
            }
            if let Some(v) = get("RELAY_R2_BUCKET") {
                s3.bucket = v;
            }
            if let Some(v) = get("RELAY_R2_REGION") {
                s3.region = v;
            }
            if let Some(v) = get("RELAY_R2_ACCESS_KEY_ID") {
                s3.access_key_id = v;
            }
            if let Some(v) = get("RELAY_R2_SECRET_ACCESS_KEY") {
                s3.secret_access_key = v;
            }
            if let Some(v) = get("RELAY_R2_KEY_PREFIX") {
                s3.key_prefix = v;
            }
            if let Some(v) = get("RELAY_R2_PUT_TTL_SECS") {
                s3.put_ttl_secs = v.parse().map_err(|_| {
                    anyhow::anyhow!("RELAY_R2_PUT_TTL_SECS must be a u64 (got {v:?})")
                })?;
            }
            if let Some(v) = get("RELAY_R2_GET_TTL_SECS") {
                s3.get_ttl_secs = v.parse().map_err(|_| {
                    anyhow::anyhow!("RELAY_R2_GET_TTL_SECS must be a u64 (got {v:?})")
                })?;
            }
        }
        if !backend_pinned {
            if let Some(s3) = &self.storage.s3 {
                if s3.is_complete() {
                    self.storage.backend = "s3".into();
                }
            }
        }
        Ok(())
    }

    /// Starter config emitted by `relay init`. Auth fields are left as
    /// placeholder strings — the operator points the relay at an OIDC
    /// issuer before first boot.
    pub fn fresh() -> Self {
        Self::default()
    }

    /// Serialize to TOML with the documentation header preserved.
    pub fn to_toml_string(&self) -> anyhow::Result<String> {
        let body = toml::to_string_pretty(self)
            .map_err(|e| anyhow::anyhow!("serialize relay.toml: {}", e))?;
        Ok(format!(
            "# docushark-relay configuration\n\
             # Generated by `relay init`. Fill in [auth] with your OIDC\n\
             # issuer (Keycloak, dex, Authelia, ZITADEL, Supabase, or\n\
             # DocuShark Cloud) before running `relay serve`.\n\
             \n{body}"
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_auth_requires_population() {
        let cfg = AuthConfig::default();
        assert!(cfg.validate().is_err(), "issuer/jwks_url must be set");
    }

    #[test]
    fn populated_auth_validates() {
        let cfg = AuthConfig {
            issuer: "https://issuer.example.com".to_string(),
            jwks_url: "https://issuer.example.com/.well-known/jwks.json".to_string(),
            audience: DEFAULT_AUDIENCE.to_string(),
            ..Default::default()
        };
        cfg.validate().expect("validates");
    }

    #[test]
    fn fresh_config_round_trips_through_toml() {
        let original = RelayConfig::fresh();
        let toml = original.to_toml_string().expect("serialize");
        let parsed: RelayConfig = toml::from_str(&toml).expect("parse");
        assert_eq!(parsed.auth.audience, DEFAULT_AUDIENCE);
        assert_eq!(parsed.server.port, DEFAULT_LISTEN_PORT);
        assert_eq!(parsed.mcp.port, DEFAULT_MCP_PORT);
        assert_eq!(parsed.mcp.expose, McpExpose::Local);
        assert_eq!(parsed.storage.backend, "filesystem");
    }

    #[test]
    fn mcp_env_overlay_sets_expose_enabled_and_port() {
        let mut cfg = RelayConfig::default();
        cfg.apply_env_overrides(env_getter(&[
            ("RELAY_MCP_EXPOSE", "public"),
            ("RELAY_MCP_ENABLED", "false"),
            ("RELAY_MCP_PORT", "9999"),
        ]))
        .expect("overlay");
        assert_eq!(cfg.mcp.expose, McpExpose::Public);
        assert!(!cfg.mcp.enabled);
        assert_eq!(cfg.mcp.port, 9999);
    }

    #[test]
    fn mcp_expose_rejects_unknown_value() {
        let mut cfg = RelayConfig::default();
        let err = cfg
            .apply_env_overrides(env_getter(&[("RELAY_MCP_EXPOSE", "internet")]))
            .unwrap_err();
        assert!(err.to_string().contains("RELAY_MCP_EXPOSE"), "{err}");
    }

    #[test]
    fn defaults_fill_missing_sections() {
        let parsed: RelayConfig = toml::from_str("").expect("parse empty");
        assert_eq!(parsed.server.port, DEFAULT_LISTEN_PORT);
        assert!(parsed.mcp.enabled);
        assert_eq!(parsed.auth.audience, DEFAULT_AUDIENCE);
    }

    #[test]
    fn deny_unknown_top_level_keys() {
        let result: Result<RelayConfig, _> =
            toml::from_str("[ghost]\nfield = 1\n");
        assert!(result.is_err(), "unknown sections should be rejected");
    }

    #[test]
    fn load_missing_file_returns_none() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("does-not-exist.toml");
        assert!(matches!(RelayConfig::load(&path), Ok(None)));
    }

    /// Build a getter closure backed by a fixed set of pairs — keeps the
    /// overlay tests off the process-global environment.
    fn env_getter(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: std::collections::HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect();
        move |k| map.get(k).cloned()
    }

    #[test]
    fn env_overlay_sets_auth_and_tenancy() {
        let mut cfg = RelayConfig::default();
        cfg.apply_env_overrides(env_getter(&[
            ("RELAY_JWT_ISSUER", "https://issuer.example.com"),
            ("RELAY_JWT_JWKS_URL", "https://issuer.example.com/jwks.json"),
            ("RELAY_JWT_AUDIENCE", "custom-aud"),
            ("RELAY_REVOCATION_BEARER", "deadbeef"),
            ("RELAY_TENANCY_MODE", "shared"),
            ("RELAY_TENANCY_WORKSPACE", "ws-123"),
        ]))
        .expect("overlay applies");
        assert_eq!(cfg.auth.issuer, "https://issuer.example.com");
        assert_eq!(cfg.auth.jwks_url, "https://issuer.example.com/jwks.json");
        assert_eq!(cfg.auth.audience, "custom-aud");
        assert_eq!(cfg.auth.revocation_push_bearer.as_deref(), Some("deadbeef"));
        assert_eq!(cfg.tenancy.mode, TenancyMode::Shared);
        assert_eq!(cfg.tenancy.workspace_id.as_deref(), Some("ws-123"));
        // Env-only config (no relay.toml) must satisfy auth validation.
        cfg.auth.validate().expect("env-only auth validates");
    }

    #[test]
    fn env_overlay_parses_port_and_network_mode() {
        let mut cfg = RelayConfig::default();
        cfg.apply_env_overrides(env_getter(&[
            ("RELAY_PORT", "9999"),
            ("RELAY_NETWORK_MODE", "localhost"),
            ("RELAY_DATA_DIR", "/data"),
        ]))
        .expect("overlay applies");
        assert_eq!(cfg.server.port, 9999);
        assert_eq!(cfg.server.network_mode, NetworkMode::Localhost);
        assert_eq!(cfg.storage.path, PathBuf::from("/data"));
    }

    #[test]
    fn env_overlay_rejects_bad_values() {
        let mut cfg = RelayConfig::default();
        assert!(cfg
            .apply_env_overrides(env_getter(&[("RELAY_PORT", "not-a-port")]))
            .is_err());
        assert!(cfg
            .apply_env_overrides(env_getter(&[("RELAY_TENANCY_MODE", "sideways")]))
            .is_err());
        assert!(cfg
            .apply_env_overrides(env_getter(&[("RELAY_NETWORK_MODE", "wan")]))
            .is_err());
    }

    #[test]
    fn env_overlay_r2_credentials_auto_select_s3_backend() {
        let mut cfg = RelayConfig::default();
        assert_eq!(cfg.storage.backend, "filesystem");
        cfg.apply_env_overrides(env_getter(&[
            ("RELAY_R2_ENDPOINT", "https://acct.r2.cloudflarestorage.com"),
            ("RELAY_R2_BUCKET", "docushark-blobs"),
            ("RELAY_R2_ACCESS_KEY_ID", "AKID"),
            ("RELAY_R2_SECRET_ACCESS_KEY", "secret"),
            ("RELAY_R2_KEY_PREFIX", "blobs/"),
        ]))
        .expect("overlay applies");
        // A complete R2 credential set auto-selects the s3 backend.
        assert_eq!(cfg.storage.backend, "s3");
        let s3 = cfg.storage.s3.expect("s3 block materialized");
        assert_eq!(s3.endpoint, "https://acct.r2.cloudflarestorage.com");
        assert_eq!(s3.bucket, "docushark-blobs");
        assert_eq!(s3.key_prefix, "blobs/");
        assert_eq!(s3.region, "auto"); // default when unset
        assert!(s3.is_complete());
    }

    #[test]
    fn env_overlay_explicit_backend_pin_overrides_auto_select() {
        let mut cfg = RelayConfig::default();
        cfg.apply_env_overrides(env_getter(&[
            ("RELAY_STORAGE_BACKEND", "filesystem"),
            ("RELAY_R2_ENDPOINT", "https://acct.r2.cloudflarestorage.com"),
            ("RELAY_R2_BUCKET", "docushark-blobs"),
            ("RELAY_R2_ACCESS_KEY_ID", "AKID"),
            ("RELAY_R2_SECRET_ACCESS_KEY", "secret"),
        ]))
        .expect("overlay applies");
        // Operator pinned filesystem → no auto-switch, but the s3 block is
        // still parsed (and stays available if they flip the backend later).
        assert_eq!(cfg.storage.backend, "filesystem");
        assert!(cfg.storage.s3.expect("s3 parsed").is_complete());
    }

    #[test]
    fn env_overlay_partial_r2_does_not_select_s3() {
        let mut cfg = RelayConfig::default();
        cfg.apply_env_overrides(env_getter(&[
            ("RELAY_R2_BUCKET", "docushark-blobs"), // endpoint + creds missing
        ]))
        .expect("overlay applies");
        assert_eq!(cfg.storage.backend, "filesystem");
        assert!(!cfg.storage.s3.expect("partial s3 parsed").is_complete());
    }

    #[test]
    fn env_overlay_rejects_bad_r2_backend_and_ttl() {
        let mut cfg = RelayConfig::default();
        assert!(cfg
            .apply_env_overrides(env_getter(&[("RELAY_STORAGE_BACKEND", "postgres")]))
            .is_err());
        assert!(cfg
            .apply_env_overrides(env_getter(&[("RELAY_R2_PUT_TTL_SECS", "soon")]))
            .is_err());
    }

    #[test]
    fn limits_defaults_are_unlimited() {
        // JP-81: a self-host deploy is unconstrained out of the box.
        let cfg = LimitsConfig::default();
        assert_eq!(cfg.storage_quota_bytes, 0);
        assert_eq!(cfg.max_editors_per_workspace, 0);
    }

    #[test]
    fn env_overlay_sets_storage_and_editor_limits() {
        let mut cfg = RelayConfig::default();
        cfg.apply_env_overrides(env_getter(&[
            ("RELAY_STORAGE_QUOTA_BYTES", "262144000"),
            ("RELAY_MAX_EDITORS_PER_WORKSPACE", "2"),
        ]))
        .expect("overlay applies");
        assert_eq!(cfg.tenancy.limits.storage_quota_bytes, 262_144_000);
        assert_eq!(cfg.tenancy.limits.max_editors_per_workspace, 2);
    }

    #[test]
    fn env_overlay_rejects_bad_limit_values() {
        let mut cfg = RelayConfig::default();
        assert!(cfg
            .apply_env_overrides(env_getter(&[("RELAY_STORAGE_QUOTA_BYTES", "lots")]))
            .is_err());
        assert!(cfg
            .apply_env_overrides(env_getter(&[("RELAY_MAX_EDITORS_PER_WORKSPACE", "-1")]))
            .is_err());
    }

    #[test]
    fn env_overlay_empty_is_noop() {
        let mut cfg = RelayConfig::default();
        let before = format!("{cfg:?}");
        cfg.apply_env_overrides(env_getter(&[])).expect("no-op");
        assert_eq!(before, format!("{cfg:?}"));
    }

    #[test]
    fn load_existing_file_returns_some() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("relay.toml");
        std::fs::write(&path, RelayConfig::fresh().to_toml_string().unwrap()).unwrap();
        let loaded = RelayConfig::load(&path).unwrap().expect("Some");
        assert_eq!(loaded.server.port, DEFAULT_LISTEN_PORT);
    }

    // AU-4 (JP-300)
    #[test]
    fn jwks_url_requires_https_except_localhost() {
        assert!(jwks_url_scheme_ok("https://issuer.example/.well-known/jwks.json"));
        assert!(jwks_url_scheme_ok("http://localhost:9999/jwks.json"));
        assert!(jwks_url_scheme_ok("http://127.0.0.1/jwks.json"));
        // Plaintext to a real host is rejected…
        assert!(!jwks_url_scheme_ok("http://issuer.example/jwks.json"));
        // …and a look-alike host that merely contains "localhost" is not loopback.
        assert!(!jwks_url_scheme_ok("http://evil.localhost.attacker.com/jwks.json"));
        assert!(!jwks_url_scheme_ok("ftp://issuer.example/jwks.json"));
    }

    #[test]
    fn auth_validate_rejects_plaintext_jwks_url() {
        let mut cfg = AuthConfig {
            issuer: "https://issuer.example".to_string(),
            jwks_url: "http://issuer.example/jwks.json".to_string(),
            ..AuthConfig::default()
        };
        assert!(cfg.validate().is_err(), "http jwks to a real host must fail");
        cfg.jwks_url = "https://issuer.example/jwks.json".to_string();
        assert!(cfg.validate().is_ok(), "https jwks validates");
    }

    // AU-5a (JP-300)
    #[test]
    fn has_revocation_transport_detects_either_channel() {
        let none = AuthConfig::default();
        assert!(!none.has_revocation_transport());

        let polling = AuthConfig {
            revocation_polling_url: Some("https://cp.example/revocations".to_string()),
            ..AuthConfig::default()
        };
        assert!(polling.has_revocation_transport());

        let push = AuthConfig {
            revocation_push_bearer: Some("secret".to_string()),
            ..AuthConfig::default()
        };
        assert!(push.has_revocation_transport());
    }
}
