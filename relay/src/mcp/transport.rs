//! HTTP transport for the embedded MCP server.
//!
//! Implements just enough of MCP's JSON-RPC over HTTP to support
//! `initialize`, `tools/list`, and `tools/call`. The notifications/SSE
//! streaming surface is intentionally not implemented in the foundation —
//! it can be added when richer write/comment tools land.
//!
//! Every request must carry `Authorization: Bearer <token>` matching the
//! token stored in `TokenStore`. Localhost binding alone is not a security
//! boundary on multi-user machines.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use std::convert::Infallible;
use std::panic::AssertUnwindSafe;
use std::time::Duration;

use axum::{
    extract::State,
    http::{header::WWW_AUTHENTICATE, HeaderMap, StatusCode},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    routing::{get, post},
    Json, Router,
};
use futures_util::stream;
use serde_json::{json, Value};

use crate::auth::{OidcAuthState, WorkspaceRole};
use crate::server::blobs::BlobStore;
use crate::server::documents::DocumentStore;
use crate::server::protocol::{ClaimLimits, WorkspaceId};
use crate::server::{S3Backend, WorkspaceWriteLimiter};

use super::config::McpFeatureConfigStore;
use super::local_mirror::LocalDocumentMirror;
use super::token::TokenStore;
use super::tools::{descriptors, dispatch, ToolContext, ToolOutcome};

/// MCP protocol version this server implements. Update in lockstep with
/// the spec the user's Claude Code client supports.
const MCP_PROTOCOL_VERSION: &str = "2025-06-18";

/// Shared state passed into the Axum handler.
#[derive(Clone)]
pub struct McpAppState {
    pub doc_store: Arc<DocumentStore>,
    /// Blob bookkeeping store (index/ACL/refs), shared with the WS/REST path —
    /// the file tools (JP-430) read the same metadata + gates.
    pub blob_store: Arc<BlobStore>,
    /// S3/R2 byte store; `None` under the filesystem backend. `get_file`
    /// mints presigned GET URLs through it.
    pub s3: Option<Arc<S3Backend>>,
    /// Lifetime of MCP-minted presigned blob GET URLs (`[mcp]
    /// blob_url_ttl_secs`, JP-430).
    pub blob_url_ttl_secs: u64,
    /// Blob-write handles for the `add_file` upload preflight (JP-430 E3):
    /// shared ingest client + upload gate + tenancy blob limits.
    pub blob_write: super::BlobWriteHandles,
    pub local_mirror: Arc<LocalDocumentMirror>,
    pub feature_config: Arc<McpFeatureConfigStore>,
    pub token: Arc<TokenStore>,
    /// Called after a successful write so the running app can refresh. Carries
    /// the writing workspace so the coarse `DocEvent` reaches the right clients
    /// on a multi-tenant public pod (JP-235).
    pub on_doc_changed: Arc<super::DocChangedSink>,
    /// Called by `delete_document` after the store delete: broadcasts a
    /// `DocEvent::Deleted` + releases blob refs, the same follow-up the REST
    /// delete runs (JP-350). Separate from `on_doc_changed` because a delete
    /// must not tell clients to *reload* a now-missing doc.
    pub on_doc_deleted: Arc<super::DocDeletedSink>,
    /// Shared with `ServerState.panic_count` so MCP tool panics
    /// surface at the WS `/metrics` counter. Phase 21.2.
    pub panic_counter: Arc<AtomicU64>,
    /// Shared with `ServerState.write_limiter` so MCP write tools
    /// draw from the same per-workspace token bucket as WS sync
    /// frames. Phase 21.3.
    pub write_limiter: Arc<WorkspaceWriteLimiter>,
    /// Separate per-workspace bucket for MCP **reads** (JP-249) so a read-storm
    /// on the public pod can't burn CPU/IO unbounded without contending with the
    /// write/WS bucket. `None` = unlimited (loopback/self-host, or
    /// `reads_per_sec = 0`).
    pub read_limiter: Option<Arc<WorkspaceWriteLimiter>>,
    /// Shared with `ServerState.rate_limit_rejections` so MCP write
    /// throttles surface at the same `/metrics` counter as WS throttles.
    pub rate_limit_rejections: Arc<AtomicU64>,
    /// OIDC validator + JWKS cache + revocation set. When a request
    /// presents a relay JWT instead of the static MCP token, the
    /// `wsp[].id` of the first claim entry becomes the workspace;
    /// the static token still falls back to
    /// `WorkspaceId::single_tenant()`. Phase 21.6 + JP-77.
    pub auth: OidcAuthState,
    /// Region this relay pod runs in; used to enforce `wsp[].region`.
    pub relay_region: String,
    /// Authoritative Y.Doc registry shared with the WS subsystem (JP-34).
    /// Lets MCP shape writes target the live Y.Doc when a doc is resident on
    /// its active page, instead of rewriting the lagging JSON snapshot (JP-35).
    pub sync_registry: Arc<crate::sync::DocRegistry>,
    /// Broadcast sink for live-path CRDT deltas — wired to the WS server's
    /// `broadcast_to_doc` so MCP-authored changes reach connected clients as a
    /// normal sync frame (they merge, no reload). JP-35.
    pub on_doc_update: Arc<super::tools::OnDocUpdate>,
    /// Whether the static bearer token is accepted. `true` for the
    /// loopback listener (desktop / self-host, where the token gates a
    /// single-tenant store). `false` when the endpoint is folded onto the
    /// public HTTP surface (JP-210): a public, potentially multi-tenant pod
    /// must not honour a static token that resolves to the catch-all
    /// `single_tenant` workspace — callers there present a JWT whose `wsp`
    /// claim scopes them to a real workspace.
    pub allow_static_token: bool,
    /// Whether local (renderer-owned) documents are reachable via MCP. `true`
    /// on the loopback listener (desktop / self-host, where the local mirror is
    /// the point). `false` when folded onto the public surface (JP-235): a
    /// headless public pod never populates the mirror, and its only local layout
    /// would be the catch-all `single_tenant` one — so local access is forced off
    /// for defense-in-depth, independent of `feature_config`.
    pub allow_local: bool,
    /// JP-370: when true, JWT-authed MCP callers are gated by per-document
    /// access (owner + shares + workspace owner/admin), mirroring the WS/REST
    /// read paths. The static loopback token (no user identity) always
    /// bypasses. Mirrors `config.permissions.enforce_private_docs`.
    pub enforce_private_docs: bool,
}

/// Build the Axum router for the MCP endpoint.
///
/// Streamable HTTP (per the MCP spec) requires three verbs on `/mcp`:
/// - `POST`  — JSON-RPC requests, JSON responses.
/// - `GET`   — opens a long-lived SSE stream for server-initiated
///   notifications. We don't push any in the foundation but the stream
///   must exist or clients will treat the server as unhealthy.
/// - `DELETE` — session termination. Accepted as a no-op.
pub fn router(state: McpAppState) -> Router {
    mcp_routes()
        // Liveness/info page — only on the dedicated loopback listener, where
        // `/` is the relay's whole surface. On the public surface (`public_router`)
        // `/` belongs to the sync/REST server, so it's omitted there.
        .route("/", get(root_info))
        .with_state(state)
}

/// Router for folding the MCP endpoint onto the relay's **public** HTTP
/// listener (JP-210) — just `/mcp` + the RFC 9728 discovery doc, no `/`
/// info page (that path is owned by the sync/REST server it merges into).
/// Returned already finalized (`Router<()>`) so the caller can `.merge()` it
/// into the main router after `with_state`.
pub fn public_router(state: McpAppState) -> Router {
    mcp_routes().with_state(state)
}

/// Request-body ceiling for `/mcp` (JP-430 E3). Axum's default 2 MiB Json
/// limit capped `add_file`'s base64 source at ~1.5 MiB decoded; 8 MiB admits
/// ~5.5 MiB of real bytes — enough for agent-generated PDFs/images — while
/// keeping the pre-auth buffering bound tight (the JSON body is read before
/// any `blob_upload_gate` permit). Larger files go via the `url` source.
/// An oversized POST is refused by the extractor with a plain 413 (not an
/// MCP `isError` result — the body never parses far enough to be a call).
const MCP_MAX_BODY_BYTES: usize = 8 * 1024 * 1024;

/// The MCP route set shared by the loopback and public routers.
fn mcp_routes() -> Router<McpAppState> {
    Router::new()
        .route("/mcp", post(handle_rpc).get(handle_sse).delete(handle_delete))
        .route(
            "/.well-known/oauth-protected-resource",
            get(oauth_protected_resource),
        )
        .layer(axum::extract::DefaultBodyLimit::max(MCP_MAX_BODY_BYTES))
}

/// RFC 9728 OAuth Protected Resource Metadata (JP-203). Public — no auth: an
/// MCP client fetches this after a 401 to learn which authorization server to
/// use, then runs the OAuth dance there. `authorization_servers` is the
/// relay's configured token issuer (`auth.issuer`) — the same authority whose
/// JWKS the relay already validates inbound JWTs against. `resource` echoes
/// the MCP endpoint URL the client reached us on.
async fn oauth_protected_resource(
    State(state): State<McpAppState>,
    headers: HeaderMap,
) -> Response {
    let origin = request_origin(&headers);
    Json(json!({
        "resource": format!("{origin}/mcp"),
        "authorization_servers": [state.auth.config.issuer],
        "bearer_methods_supported": ["header"],
    }))
    .into_response()
}

/// Scheme the client reached us on, best-effort: honor `X-Forwarded-Proto`
/// (Cloud terminates TLS at the proxy), else `http` for loopback and `https`
/// otherwise. Only ever used to echo discovery URLs back at the client —
/// never a security decision.
fn request_scheme(headers: &HeaderMap, host: &str) -> &'static str {
    if let Some(proto) = headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
    {
        if proto.eq_ignore_ascii_case("https") {
            return "https";
        }
        if proto.eq_ignore_ascii_case("http") {
            return "http";
        }
    }
    if host.starts_with("127.0.0.1") || host.starts_with("localhost") || host.starts_with("[::1]") {
        "http"
    } else {
        "https"
    }
}

/// The origin (`scheme://host`) the request arrived on, from `Host`.
fn request_origin(headers: &HeaderMap) -> String {
    let host = headers
        .get(axum::http::header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("127.0.0.1");
    format!("{}://{}", request_scheme(headers, host), host)
}

/// 401 carrying the RFC 9728 `WWW-Authenticate` challenge that points an MCP
/// client at the protected-resource metadata, so it can discover the
/// authorization server and authenticate (JP-203). Same opaque body as before.
fn unauthorized(headers: &HeaderMap) -> Response {
    let challenge = format!(
        "Bearer resource_metadata=\"{}/.well-known/oauth-protected-resource\"",
        request_origin(headers)
    );
    (
        StatusCode::UNAUTHORIZED,
        [(WWW_AUTHENTICATE, challenge)],
        "Missing or invalid bearer token",
    )
        .into_response()
}

/// Liveness/info endpoint. Returns server name + version with no auth, so
/// a user can sanity-check the binding from a browser.
async fn root_info() -> Response {
    Json(json!({
        "server": "docushark-mcp",
        "version": crate::build_info::VERSION,
        "commit": crate::build_info::GIT_SHA,
        "endpoint": "/mcp",
        "transport": "streamable-http",
        "protocolVersion": MCP_PROTOCOL_VERSION,
    }))
    .into_response()
}

async fn handle_sse(
    State(state): State<McpAppState>,
    headers: HeaderMap,
) -> Response {
    if authenticate(&headers, &state.token, &state.auth, &state.relay_region, state.allow_static_token).await.is_none() {
        log::warn!("MCP SSE: missing or invalid bearer token");
        return unauthorized(&headers);
    }
    // Empty stream — the foundation has no server-initiated notifications.
    // KeepAlive emits a comment frame periodically so proxies and the
    // client don't close the connection.
    let stream = stream::pending::<Result<Event, Infallible>>();
    Sse::new(stream)
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
        .into_response()
}

async fn handle_delete(
    State(state): State<McpAppState>,
    headers: HeaderMap,
) -> Response {
    if authenticate(&headers, &state.token, &state.auth, &state.relay_region, state.allow_static_token).await.is_none() {
        return unauthorized(&headers);
    }
    StatusCode::NO_CONTENT.into_response()
}

async fn handle_rpc(
    State(state): State<McpAppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let auth = match authenticate(&headers, &state.token, &state.auth, &state.relay_region, state.allow_static_token).await {
        Some(a) => a,
        None => {
            log::warn!(
                "MCP POST /mcp: rejected (missing or invalid bearer token) from {:?}",
                headers.get("user-agent").and_then(|v| v.to_str().ok()).unwrap_or("?")
            );
            return unauthorized(&headers);
        }
    };

    let id = body.get("id").cloned().unwrap_or(Value::Null);
    let method = match body.get("method").and_then(|v| v.as_str()) {
        Some(m) => m.to_string(),
        None => return rpc_error(id, -32600, "Invalid Request: missing method"),
    };
    let params = body.get("params").cloned().unwrap_or(json!({}));
    log::info!(
        "MCP rpc method={} workspace_id={}",
        method,
        auth.workspace.as_str()
    );

    match method.as_str() {
        "initialize" => Json(rpc_result(id, initialize_result())).into_response(),
        "tools/list" => Json(rpc_result(id, tools_list_result())).into_response(),
        "tools/call" => handle_tools_call(&state, &auth, id, &params).await,
        // Spec-defined no-op notifications we may receive from the client.
        "notifications/initialized" | "ping" => {
            (StatusCode::OK, Json(json!({"jsonrpc": "2.0", "id": id, "result": {}}))).into_response()
        }
        other => rpc_error(id, -32601, &format!("Method not found: {}", other)),
    }
}

/// Outcome of authenticating an inbound MCP request. Carries the
/// workspace the request operates against — `WorkspaceId::single_tenant()`
/// for the static MCP token (desktop default), or the JWT's `wsp` claim
/// for relay-issued JWTs (Cloud / multi-tenant). Phase 21.6.
struct AuthOutcome {
    workspace: WorkspaceId,
    /// JP-370: the authenticated user's id + role for JWT callers, used by the
    /// per-document access gate. `None` for the static loopback MCP token —
    /// which has no user identity and is treated as a workspace admin so the
    /// desktop / self-host flow is unaffected.
    user_id: Option<String>,
    role: Option<String>,
    /// Raw per-workspace limits minted on the chosen `wsp[]` entry (JP-81) —
    /// the quota the `add_file` upload enforces (JP-430 E3). Default (no
    /// overrides) for the static token; the config fallback then applies.
    limits: ClaimLimits,
}

/// Stringified workspace role, matching the values the permissions layer
/// recognises (`"owner"` short-circuits to full access; api.rs uses the same
/// mapping). JP-370.
fn role_str(role: WorkspaceRole) -> String {
    match role {
        WorkspaceRole::Owner => "owner",
        WorkspaceRole::Member => "user",
        WorkspaceRole::Viewer => "viewer",
    }
    .to_string()
}

fn extract_bearer(headers: &HeaderMap) -> Option<&str> {
    let header = headers.get("authorization")?;
    let value = header.to_str().ok()?;
    value
        .strip_prefix("Bearer ")
        .or_else(|| value.strip_prefix("bearer "))
        .map(str::trim)
}

/// Authenticate an inbound request. Accepts either the static MCP
/// bearer token (single-tenant fallback) or a relay-issued JWT (workspace
/// derived from the `wsp` claim). Returns `None` if the credential is
/// missing or rejected by both paths — same opacity contract as before,
/// no disambiguation between "no token" / "bad static token" /
/// "bad JWT".
async fn authenticate(
    headers: &HeaderMap,
    token: &TokenStore,
    auth: &OidcAuthState,
    relay_region: &str,
    allow_static_token: bool,
) -> Option<AuthOutcome> {
    let presented = extract_bearer(headers)?;
    // The static token only ever resolves to the catch-all single-tenant
    // workspace, so it's accepted on the loopback listener but refused on a
    // public (multi-tenant) pod — see `McpAppState::allow_static_token`.
    if allow_static_token && token.validate(presented) {
        return Some(AuthOutcome {
            workspace: WorkspaceId::single_tenant(),
            user_id: None,
            role: None,
            limits: ClaimLimits::default(),
        });
    }
    if let Ok(claims) = auth.validate(presented).await {
        if let Ok((ws, role, limits)) = WorkspaceId::from_oidc_array(&claims, None, relay_region) {
            return Some(AuthOutcome {
                workspace: ws,
                user_id: Some(claims.sub.clone()),
                role: Some(role_str(role)),
                limits,
            });
        }
    }
    None
}

fn initialize_result() -> Value {
    json!({
        "protocolVersion": MCP_PROTOCOL_VERSION,
        "capabilities": {
            "tools": {"listChanged": false}
        },
        "serverInfo": {
            "name": "docushark",
            "version": crate::build_info::VERSION
        }
    })
}

fn tools_list_result() -> Value {
    let tools: Vec<Value> = descriptors()
        .into_iter()
        .map(|d| {
            json!({
                "name": d.name,
                "description": d.description,
                "inputSchema": d.input_schema,
            })
        })
        .collect();
    json!({"tools": tools})
}

/// Tool names that mutate the team-document store. Kept in lockstep
/// with `tools::dispatch` — reads pass through the rate limiter, only
/// writes count against the per-workspace bucket. Phase 21.3.
fn is_mcp_write_tool(name: &str) -> bool {
    matches!(
        name,
        "docushark_add_shape"
            | "docushark_add_shapes"
            | "docushark_add_file"
            | "docushark_connect"
            | "docushark_update_shape"
            | "docushark_delete_shape"
            | "docushark_delete_prose_page"
            | "docushark_reorder_shapes"
            | "docushark_reorder_prose_pages"
            | "docushark_add_reference"
            | "docushark_rename_document"
            | "docushark_delete_document"
    )
}

/// Result of the JP-89 async DOI preflight for citation tools.
enum DoiPreflight {
    /// Not a DOI-resolving tool (or no DOI supplied) — proceed to sync dispatch
    /// with `args` (possibly mutated to carry the resolved item).
    Continue,
    /// A finished tool result to return directly (`resolve_doi`).
    Reply(Value),
    /// A tool error message (DOI invalid / lookup failed).
    Error(String),
}

/// Resolve the DOI that `resolve_doi` / `add_reference` may carry, before the
/// synchronous `dispatch`. For `add_reference` the resolved CSL item is injected
/// at the front of `args.items` so the pure JSON write path adds it like any
/// other item. A non-DOI tool (or `add_reference` with no `doi`) returns
/// `Continue` unchanged.
async fn resolve_citation_doi(name: &str, args: &mut Value) -> DoiPreflight {
    match name {
        "docushark_resolve_doi" => {
            let doi = args.get("doi").and_then(|v| v.as_str()).unwrap_or("");
            match super::citations::resolve_doi_to_csl(doi).await {
                Ok(item) => DoiPreflight::Reply(json!({"reference": item})),
                Err(e) => DoiPreflight::Error(e),
            }
        }
        "docushark_add_reference" => {
            let doi = args
                .get("doi")
                .and_then(|v| v.as_str())
                .map(str::to_string)
                .filter(|d| !d.trim().is_empty());
            let Some(doi) = doi else {
                return DoiPreflight::Continue;
            };
            let item = match super::citations::resolve_doi_to_csl(&doi).await {
                Ok(item) => item,
                Err(e) => return DoiPreflight::Error(e),
            };
            let Some(obj) = args.as_object_mut() else {
                return DoiPreflight::Error("invalid arguments".into());
            };
            let items = obj.entry("items").or_insert_with(|| json!([]));
            match items.as_array_mut() {
                Some(arr) => {
                    arr.insert(0, item);
                    DoiPreflight::Continue
                }
                None => DoiPreflight::Error("'items' must be an array".into()),
            }
        }
        _ => DoiPreflight::Continue,
    }
}

/// Result of the JP-430 E3 file-upload preflight for `add_file`.
enum FilePreflight {
    /// Not `add_file`, or the source is already a `blobRef` — proceed to sync
    /// dispatch with `args` (possibly mutated to carry the stored blob).
    Continue,
    /// A tool error message (validation, decode, fetch, quota, store).
    Error(String),
}

/// Map a shared-core [`crate::api::BlobWriteError`] to the typed `ERR_*`
/// string an MCP tool error carries (the REST twin maps the same variants to
/// HTTP statuses — `blob_write_error_response`).
fn file_upload_error(e: crate::api::BlobWriteError) -> String {
    use crate::api::BlobWriteError as E;
    match e {
        E::NotConfigured => "ERR_INGEST_NOT_CONFIGURED: url sources are disabled on this relay \
             (no ingest allowlist is configured). Use a base64 source, or ask the operator to \
             set RELAY_BLOB_INGEST_ALLOWED_HOSTS."
            .to_string(),
        E::InvalidUrl => "ERR_BAD_URL: the url could not be parsed".to_string(),
        E::UrlNotAllowed => "ERR_URL_NOT_ALLOWED: url sources must be https, on the relay's \
             ingest allowlist, and not an IP-literal/private host"
            .to_string(),
        E::Fetch(msg) => format!("ERR_FETCH_FAILED: {msg}"),
        E::TooLarge => "ERR_FILE_TOO_LARGE: the file exceeds the relay's max blob size".to_string(),
        E::GateUnavailable | E::StoreUnavailable => {
            "ERR_STORE_UNAVAILABLE: the blob store is unavailable — try again".to_string()
        }
        E::Quota(msg) => format!("ERR_QUOTA_EXCEEDED: {msg}"),
        E::Backend(msg) => format!("ERR_INTERNAL: {msg}"),
    }
}

/// `add_file`'s upload leg (JP-430 E3). `dispatch` is synchronous, but the
/// upload needs async I/O (the reqwest download for a `url` source, the S3
/// PUT on the object-storage backend) — so, exactly like the JP-89 DOI
/// preflight, it runs here before dispatch and injects the stored blob's
/// identity (`blobRef`/`mimeType`/`fileSize`) into `args`; the sync tool then
/// only attaches the FileShape. Target validation (doc/page/permission) runs
/// BEFORE any byte is stored so an unauthorized or misaddressed call can't
/// leave orphan bytes. Runs after the write-limiter gate — an upload draws
/// from the same per-workspace write bucket as any other write.
async fn resolve_file_upload(
    state: &McpAppState,
    ctx: &ToolContext<'_>,
    name: &str,
    args: &mut Value,
) -> FilePreflight {
    if name != "docushark_add_file" {
        return FilePreflight::Continue;
    }

    // Minimal arg surface for the upload leg; `add_file` does full parsing.
    let Ok(doc_id) = serde_json::from_value::<crate::server::protocol::DocId>(
        args.get("docId").cloned().unwrap_or(Value::Null),
    ) else {
        return FilePreflight::Error("Invalid arguments: missing or invalid docId".into());
    };
    let Some(page_id) = args.get("pageId").and_then(|v| v.as_str()).map(str::to_string) else {
        return FilePreflight::Error("Invalid arguments: missing pageId".into());
    };
    let file_name = args
        .get("fileName")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let url = args.get("url").and_then(|v| v.as_str()).map(str::to_string);
    let base64 = args.get("base64").and_then(|v| v.as_str()).map(str::to_string);
    let blob_ref = args.get("blobRef").and_then(|v| v.as_str()).map(str::to_string);
    let source_count = [url.is_some(), base64.is_some(), blob_ref.is_some()]
        .iter()
        .filter(|&&b| b)
        .count();
    if source_count != 1 {
        return FilePreflight::Error(
            "ERR_BAD_SOURCE: provide exactly one of url, base64, or blobRef".into(),
        );
    }

    // Validate the attach target before storing a single byte.
    if let Err(e) = super::tools::validate_add_file_target(ctx, &doc_id, &page_id) {
        return FilePreflight::Error(e);
    }
    if blob_ref.is_some() {
        // Attach-only: no upload; `add_file` validates the hash against the
        // workspace store.
        return FilePreflight::Continue;
    }

    let declared_mime = args
        .get("mimeType")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .map(str::to_string);
    // `uploaded_by` bookkeeping: the JWT subject, or the static loopback
    // token's fixed identity (it has no user).
    let user = ctx.user_id.clone().unwrap_or_else(|| "mcp".to_string());

    let stored = if let Some(url) = url {
        let authorization = args
            .get("authorization")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        crate::api::ingest_blob_from_url(
            &state.blob_write.http,
            &state.blob_write.allowed_hosts,
            &state.blob_write.gate,
            &state.blob_store,
            state.s3.as_deref(),
            &ctx.workspace_id,
            &user,
            ctx.quota_bytes,
            state.blob_write.max_blob_bytes,
            &url,
            authorization.as_deref(),
            declared_mime.as_deref(),
        )
        .await
    } else {
        let encoded = base64.unwrap_or_default();
        let bytes = match super::tools::base64_decode(&encoded) {
            Ok(b) => b,
            Err(e) => return FilePreflight::Error(format!("ERR_BAD_BASE64: {e}")),
        };
        if bytes.is_empty() {
            return FilePreflight::Error("ERR_BAD_BASE64: the payload is empty".into());
        }
        if bytes.len() > state.blob_write.max_blob_bytes {
            return FilePreflight::Error(file_upload_error(crate::api::BlobWriteError::TooLarge));
        }
        // Mime precedence for a headerless base64 source: caller override,
        // else the fileName extension (the editor's own fallback order).
        let mime = declared_mime
            .unwrap_or_else(|| super::tools::mime_from_file_name(&file_name).to_string());
        crate::api::store_blob_bytes(
            &state.blob_store,
            state.s3.as_deref(),
            &ctx.workspace_id,
            &user,
            ctx.quota_bytes,
            &bytes,
            &mime,
        )
        .await
    };

    match stored {
        Ok(s) => {
            // Advisory provenance, same as the REST ingest path.
            if let Err(e) = state.blob_store.record_provenance(
                &ctx.workspace_id,
                &s.hash,
                &["mcp:add_file".to_string()],
            ) {
                log::warn!(
                    "add_file provenance record failed {}/{}: {e}",
                    ctx.workspace_id.as_str(),
                    s.hash
                );
            }
            let Some(obj) = args.as_object_mut() else {
                return FilePreflight::Error("invalid arguments".into());
            };
            obj.insert("blobRef".into(), json!(s.hash));
            obj.insert("mimeType".into(), json!(s.mime));
            obj.insert("fileSize".into(), json!(s.size));
            obj.remove("url");
            obj.remove("base64");
            obj.remove("authorization");
            FilePreflight::Continue
        }
        Err(e) => FilePreflight::Error(file_upload_error(e)),
    }
}

async fn handle_tools_call(
    state: &McpAppState,
    auth: &AuthOutcome,
    id: Value,
    params: &Value,
) -> Response {
    let workspace = &auth.workspace;
    let name = match params.get("name").and_then(|v| v.as_str()) {
        Some(n) => n,
        None => return rpc_error(id, -32602, "Invalid params: missing tool name"),
    };
    let mut args = params.get("arguments").cloned().unwrap_or(json!({}));

    let ctx = ToolContext {
        team: &state.doc_store,
        blob_store: &state.blob_store,
        s3: state.s3.as_ref(),
        blob_url_ttl_secs: state.blob_url_ttl_secs,
        // JP-430 E3: the effective storage quota for this request — the JWT
        // claim override else the config fallback, `0` → unlimited. Resolved
        // through the same helper as REST (`ServerState::resolve_limits`).
        quota_bytes: crate::config::effective_limit_u64(
            auth.limits.quota_bytes,
            state.blob_write.fallback_quota_bytes,
        ),
        max_blob_bytes: state.blob_write.max_blob_bytes,
        local: &state.local_mirror,
        // JP-235: a public mount hard-disables local access (`allow_local =
        // false`) regardless of the persisted feature flag.
        local_enabled: state.allow_local && state.feature_config.local_access_enabled(),
        workspace_id: workspace.clone(),
        // JP-370: per-document access gate. `user_id == None` (static loopback
        // token) bypasses, treated as workspace admin; a JWT caller is gated by
        // the doc's owner/share set when enforcement is on.
        user_id: auth.user_id.clone(),
        user_role: auth.role.clone(),
        enforce_private_docs: state.enforce_private_docs,
        registry: &state.sync_registry,
        on_doc_update: state.on_doc_update.as_ref(),
        on_doc_deleted: &state.on_doc_deleted,
    };

    // Per-workspace rate limit. Writes draw from the shared write bucket (same
    // bucket as WS sync frames, Phase 21.3); reads draw from a **separate** MCP
    // read bucket (JP-249) so a read-storm on the public pod can't burn CPU/IO
    // unbounded — yet never contends with live WS editing or writes. The read
    // limiter is `None` (unlimited) on loopback/self-host or when
    // `reads_per_sec = 0`.
    let throttled = if is_mcp_write_tool(name) {
        state.write_limiter.check_key(&ctx.workspace_id).is_err()
    } else {
        state
            .read_limiter
            .as_ref()
            .is_some_and(|rl| rl.check_key(&ctx.workspace_id).is_err())
    };
    if throttled {
        state.rate_limit_rejections.fetch_add(1, Ordering::Relaxed);
        log::debug!(
            "mcp tool rate-limited tool={} workspace_id={}",
            name,
            ctx.workspace_id.as_str()
        );
        return (
            axum::http::StatusCode::TOO_MANY_REQUESTS,
            [(axum::http::header::RETRY_AFTER, "1")],
            Json(rpc_result(
                id,
                json!({
                    "content": [{"type": "text", "text": "ERR_RATE_LIMIT"}],
                    "isError": true,
                }),
            )),
        )
            .into_response();
    }

    // JP-89: `resolve_doi` and the DOI form of `add_reference` need an outbound
    // network call (doi.org content negotiation), which the synchronous
    // `dispatch` can't make. Resolve it here (async) — `resolve_doi` returns the
    // CSL item directly; `add_reference` gets the resolved item injected into
    // `args.items` and then falls through to the normal sync write dispatch. The
    // rate-limit gate above already ran, so a DOI-lookup storm is throttled.
    //
    // Both async preflights (DOI, file upload) run under the same panic guard
    // philosophy as the sync dispatch below (Phase 21.2) — via the futures
    // `catch_unwind` combinator, so a preflight panic is a clean tool error
    // instead of a dropped connection.
    let doi = futures_util::FutureExt::catch_unwind(AssertUnwindSafe(resolve_citation_doi(
        name, &mut args,
    )))
    .await
    .unwrap_or_else(|panic| {
        state.panic_counter.fetch_add(1, Ordering::Relaxed);
        log::error!(
            "mcp preflight panic tool={} workspace_id={} panic={}",
            name,
            ctx.workspace_id.as_str(),
            crate::server::panic_message(&panic),
        );
        DoiPreflight::Error("internal error".into())
    });
    let outcome = match doi {
        DoiPreflight::Reply(result) => {
            Ok(ToolOutcome { result, changed_doc_id: None, change_detail: None })
        }
        DoiPreflight::Error(msg) => Err(msg),
        DoiPreflight::Continue => {
            // JP-430 E3: `add_file`'s upload leg (validation → download/decode
            // → blob store) — injects blobRef/mimeType/fileSize into `args` so
            // the sync tool only attaches the shape.
            let file = futures_util::FutureExt::catch_unwind(AssertUnwindSafe(
                resolve_file_upload(state, &ctx, name, &mut args),
            ))
            .await
            .unwrap_or_else(|panic| {
                state.panic_counter.fetch_add(1, Ordering::Relaxed);
                log::error!(
                    "mcp preflight panic tool={} workspace_id={} panic={}",
                    name,
                    ctx.workspace_id.as_str(),
                    crate::server::panic_message(&panic),
                );
                FilePreflight::Error("internal error".into())
            });
            match file {
                FilePreflight::Error(msg) => Err(msg),
                FilePreflight::Continue => {
                    // Phase 21.2: catch tool panics so one bad tool call can't take
                    // down the MCP HTTP server. `dispatch` is sync, so we use the
                    // stdlib catch_unwind directly (no future combinator needed).
                    match std::panic::catch_unwind(AssertUnwindSafe(|| dispatch(&ctx, name, &args))) {
                        Ok(result) => result,
                        Err(panic) => {
                            state.panic_counter.fetch_add(1, Ordering::Relaxed);
                            let correlation_id = nanoid::nanoid!(10);
                            log::error!(
                                "mcp tool panic tool={} workspace_id={} correlation_id={} panic={}",
                                name,
                                ctx.workspace_id.as_str(),
                                correlation_id,
                                crate::server::panic_message(&panic),
                            );
                            return Json(rpc_result(
                                id,
                                json!({
                                    "content": [{"type": "text", "text": "internal error"}],
                                    "isError": true,
                                }),
                            ))
                            .into_response();
                        }
                    }
                }
            }
        }
    };

    match outcome {
        Ok(outcome) => {
            if let Some(doc_id) = outcome.changed_doc_id {
                // JP-235: route the coarse reload nudge to the *writing*
                // workspace (the request's authenticated workspace), not the
                // hard-coded `single_tenant()` — correct on a public pod.
                (state.on_doc_changed)(workspace, doc_id);
            }
            let text = serde_json::to_string_pretty(&outcome.result).unwrap_or_else(|_| "{}".into());
            Json(rpc_result(
                id,
                json!({
                    "content": [{"type": "text", "text": text}],
                    "isError": false,
                    "structuredContent": outcome.result,
                }),
            ))
            .into_response()
        }
        Err(msg) => {
            // Per MCP spec, tool execution errors are reported as a result
            // with `isError: true` rather than a JSON-RPC error.
            Json(rpc_result(
                id,
                json!({
                    "content": [{"type": "text", "text": msg}],
                    "isError": true,
                }),
            ))
            .into_response()
        }
    }
}

fn rpc_result(id: Value, result: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}

fn rpc_error(id: Value, code: i32, message: &str) -> Response {
    Json(json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {"code": code, "message": message}
    }))
    .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::token::TokenStore;
    use axum::body::to_bytes;
    use axum::http::Request;
    use std::sync::Arc;
    use tempfile::TempDir;
    use tower::ServiceExt;

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

    fn make_state(dir: &TempDir) -> (McpAppState, String) {
        let token = Arc::new(TokenStore::load_or_create(dir.path()).unwrap());
        let store = Arc::new(DocumentStore::new(dir.path().to_path_buf()));
        let local = Arc::new(LocalDocumentMirror::new(dir.path().to_path_buf()));
        let cfg = Arc::new(McpFeatureConfigStore::load_or_create(dir.path()));
        let token_str = token.current();
        let state = McpAppState {
            doc_store: store,
            blob_store: Arc::new(BlobStore::new(dir.path().to_path_buf())),
            s3: None,
            blob_url_ttl_secs: 300,
            local_mirror: local,
            feature_config: cfg,
            token,
            on_doc_changed: Arc::new(|_, _| {}),
            on_doc_deleted: Arc::new(|_, _| {}),
            panic_counter: Arc::new(AtomicU64::new(0)),
            rate_limit_rejections: Arc::new(AtomicU64::new(0)),
            write_limiter: Arc::new(crate::server::build_workspace_limiter(1000, 1000)),
            read_limiter: None,
            auth: test_auth_state(),
            relay_region: "default".to_string(),
            sync_registry: Arc::new(crate::sync::DocRegistry::new()),
            on_doc_update: Arc::new(|_, _, _| {}),
            allow_static_token: true,
            allow_local: true,
            enforce_private_docs: false,
            blob_write: crate::mcp::BlobWriteHandles::defaults_for_tests(),
        };
        (state, token_str)
    }

    async fn body_json(resp: Response) -> Value {
        let bytes = to_bytes(resp.into_body(), 1_000_000).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn missing_token_returns_401() {
        let dir = TempDir::new().unwrap();
        let (state, _) = make_state(&dir);
        let app = router(state);
        let req = Request::builder()
            .method("POST")
            .uri("/mcp")
            .header("content-type", "application/json")
            .body(axum::body::Body::from(
                serde_json::to_vec(&json!({
                    "jsonrpc": "2.0", "id": 1, "method": "tools/list"
                }))
                .unwrap(),
            ))
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn unauthenticated_mcp_returns_www_authenticate_challenge() {
        let dir = TempDir::new().unwrap();
        let (state, _) = make_state(&dir);
        let app = router(state);
        let req = Request::builder()
            .method("POST")
            .uri("/mcp")
            .header("host", "relay.example.com")
            .header("content-type", "application/json")
            .body(axum::body::Body::from(
                serde_json::to_vec(&json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}))
                    .unwrap(),
            ))
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        let challenge = resp
            .headers()
            .get(axum::http::header::WWW_AUTHENTICATE)
            .expect("WWW-Authenticate header present")
            .to_str()
            .unwrap()
            .to_string();
        assert!(challenge.starts_with("Bearer "), "challenge: {challenge}");
        assert!(
            challenge.contains(
                "resource_metadata=\"https://relay.example.com/.well-known/oauth-protected-resource\""
            ),
            "challenge missing resource_metadata: {challenge}"
        );
    }

    #[tokio::test]
    async fn protected_resource_metadata_advertises_issuer() {
        let dir = TempDir::new().unwrap();
        let (state, _) = make_state(&dir);
        let app = router(state);
        let req = Request::builder()
            .method("GET")
            .uri("/.well-known/oauth-protected-resource")
            .header("host", "relay.example.com")
            .body(axum::body::Body::empty())
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = body_json(resp).await;
        assert_eq!(body["resource"], "https://relay.example.com/mcp");
        assert_eq!(
            body["authorization_servers"][0], "https://test.example.com",
            "advertises the relay's configured token issuer as the authorization server"
        );
        assert_eq!(body["bearer_methods_supported"][0], "header");
    }

    #[tokio::test]
    async fn wrong_token_returns_401() {
        let dir = TempDir::new().unwrap();
        let (state, _) = make_state(&dir);
        let app = router(state);
        let req = Request::builder()
            .method("POST")
            .uri("/mcp")
            .header("content-type", "application/json")
            .header("authorization", "Bearer not-the-real-token")
            .body(axum::body::Body::from(
                serde_json::to_vec(&json!({
                    "jsonrpc": "2.0", "id": 1, "method": "tools/list"
                }))
                .unwrap(),
            ))
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn tools_list_returns_foundation_tools() {
        let dir = TempDir::new().unwrap();
        let (state, token) = make_state(&dir);
        let app = router(state);
        let req = Request::builder()
            .method("POST")
            .uri("/mcp")
            .header("content-type", "application/json")
            .header("authorization", format!("Bearer {}", token))
            .body(axum::body::Body::from(
                serde_json::to_vec(&json!({
                    "jsonrpc": "2.0", "id": 1, "method": "tools/list"
                }))
                .unwrap(),
            ))
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = body_json(resp).await;
        let tools = body["result"]["tools"].as_array().unwrap();
        let names: Vec<&str> = tools.iter().filter_map(|t| t["name"].as_str()).collect();
        assert!(names.contains(&"docushark_list_documents"));
        assert!(names.contains(&"docushark_create_document"));
        assert!(names.contains(&"docushark_rename_document"));
        assert!(names.contains(&"docushark_delete_document"));
        assert!(names.contains(&"docushark_add_shape"));
        assert!(names.contains(&"docushark_add_shapes"));
        assert!(names.contains(&"docushark_connect"));
        assert!(names.contains(&"docushark_update_shape"));
        assert!(names.contains(&"docushark_get_prose"));
        assert!(names.contains(&"docushark_add_prose_page"));
        assert!(names.contains(&"docushark_set_prose"));
        assert!(names.contains(&"docushark_rename_prose_page"));
        assert!(names.contains(&"docushark_add_canvas_page"));
        assert!(names.contains(&"docushark_rename_canvas_page"));
        assert!(names.contains(&"docushark_reorder_canvas_page"));
        assert!(names.contains(&"docushark_delete_canvas_page"));
        assert!(names.contains(&"docushark_get_outline"));
        assert!(names.contains(&"docushark_insert_section"));
        assert!(names.contains(&"docushark_restructure_outline"));
        assert!(names.contains(&"docushark_generate_diagram"));
        assert!(names.contains(&"docushark_get_shape"));
        assert!(names.contains(&"docushark_delete_shape"));
        assert!(names.contains(&"docushark_delete_prose_page"));
        assert!(names.contains(&"docushark_reorder_shapes"));
        assert!(names.contains(&"docushark_reorder_prose_pages"));
        assert!(names.contains(&"docushark_list_references"));
        assert!(names.contains(&"docushark_resolve_doi"));
        assert!(names.contains(&"docushark_add_reference"));
        assert!(names.contains(&"docushark_list_fields"));
        assert!(names.contains(&"docushark_set_fields"));
        assert!(names.contains(&"docushark_get_skills"));
        assert!(names.contains(&"docushark_list_icons"));
        assert!(names.contains(&"docushark_insert_block"));
        assert!(names.contains(&"docushark_delete_block"));
        assert!(names.contains(&"docushark_move_block"));
        assert!(names.contains(&"docushark_list_files"));
        assert!(names.contains(&"docushark_get_file"));
        assert!(names.contains(&"docushark_add_file"));
        assert!(names.contains(&"docushark_get_storage"));
        assert_eq!(tools.len(), 41);
    }

    // ---- JP-430 E3: add_file over the full transport (preflight + dispatch) ----

    /// Seed a minimal one-canvas-page team doc into `state.doc_store`.
    fn seed_canvas_doc(state: &McpAppState, doc_id: &str, page_id: &str) {
        state
            .doc_store
            .save_document(
                &WorkspaceId::single_tenant(),
                json!({
                    "id": doc_id, "name": "File Target", "version": 1,
                    "createdAt": 1u64, "modifiedAt": 1u64,
                    "activePageId": page_id, "pageOrder": [page_id],
                    "pages": { page_id: {
                        "id": page_id, "name": "P1", "shapes": {}, "shapeOrder": [],
                        "createdAt": 1u64, "modifiedAt": 1u64,
                    }},
                }),
            )
            .unwrap();
    }

    /// POST one `tools/call` through the router; returns the JSON-RPC body.
    async fn call_tool(app: Router, token: &str, name: &str, args: Value) -> Value {
        let req = Request::builder()
            .method("POST")
            .uri("/mcp")
            .header("content-type", "application/json")
            .header("authorization", format!("Bearer {}", token))
            .body(axum::body::Body::from(
                serde_json::to_vec(&json!({
                    "jsonrpc": "2.0", "id": 1, "method": "tools/call",
                    "params": {"name": name, "arguments": args}
                }))
                .unwrap(),
            ))
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        body_json(resp).await
    }

    /// The full base64 upload path: preflight decodes + stores + injects, the
    /// sync tool attaches, the parity fix registers the reference — so the
    /// blob survives a destructive sweep at grace 0.
    #[tokio::test]
    async fn add_file_base64_uploads_attaches_and_survives_sweep() {
        let dir = TempDir::new().unwrap();
        let (state, token) = make_state(&dir);
        seed_canvas_doc(&state, "fdoc", "p1");
        let blob_store = state.blob_store.clone();
        let doc_store = state.doc_store.clone();
        blob_store.set_gc_grace_secs(0);
        let app = router(state);

        let bytes: &[u8] = b"hello file!!";
        let expected_hash = crate::server::blobs::BlobStore::compute_hash(bytes);
        let body = call_tool(
            app,
            &token,
            "docushark_add_file",
            json!({
                "docId": "fdoc", "pageId": "p1",
                "fileName": "greeting.txt",
                "base64": "aGVsbG8gZmlsZSEh",
            }),
        )
        .await;
        assert_eq!(body["result"]["isError"], json!(false), "{body}");
        let sc = &body["result"]["structuredContent"];
        assert_eq!(sc["blobRef"], json!(expected_hash));
        assert_eq!(sc["mimeType"], "text/plain", "inferred from the .txt extension");
        assert_eq!(sc["sizeBytes"], bytes.len());

        let ws = WorkspaceId::single_tenant();
        assert!(blob_store.exists(&ws, &expected_hash), "bytes stored under the workspace ACL");
        // Attached + referenced: the shape is in the doc and the array + refcount
        // shield the blob from the sweep.
        let doc = doc_store
            .get_document(&ws, &crate::server::protocol::DocId::from_http_path("fdoc".into()).unwrap())
            .unwrap();
        let shape_id = sc["shapeId"].as_str().unwrap();
        assert!(doc["pages"]["p1"]["shapes"].get(shape_id).is_some());
        assert!(doc["blobReferences"]
            .as_array()
            .unwrap()
            .contains(&json!(expected_hash)));
        assert_eq!(blob_store.sweep_unreferenced(), 0);
        assert!(blob_store.exists(&ws, &expected_hash));
    }

    #[tokio::test]
    async fn add_file_rejects_zero_or_multiple_sources() {
        let dir = TempDir::new().unwrap();
        let (state, token) = make_state(&dir);
        seed_canvas_doc(&state, "fdoc", "p1");
        let app = router(state);

        let body = call_tool(
            app.clone(),
            &token,
            "docushark_add_file",
            json!({
                "docId": "fdoc", "pageId": "p1", "fileName": "a.txt",
                "base64": "Zm9v", "url": "https://example.com/a.txt",
            }),
        )
        .await;
        assert_eq!(body["result"]["isError"], json!(true));
        assert!(
            body["result"]["content"][0]["text"].as_str().unwrap().starts_with("ERR_BAD_SOURCE"),
            "{body}"
        );

        let body = call_tool(
            app,
            &token,
            "docushark_add_file",
            json!({"docId": "fdoc", "pageId": "p1", "fileName": "a.txt"}),
        )
        .await;
        assert_eq!(body["result"]["isError"], json!(true));
        assert!(
            body["result"]["content"][0]["text"].as_str().unwrap().starts_with("ERR_BAD_SOURCE"),
            "{body}"
        );
    }

    /// With no ingest allowlist configured (the default), a `url` source is a
    /// typed refusal — the shared helper owns the gate, so MCP can never be an
    /// open fetch proxy. Nothing is stored and nothing attaches.
    #[tokio::test]
    async fn add_file_url_source_requires_allowlist() {
        let dir = TempDir::new().unwrap();
        let (state, token) = make_state(&dir);
        seed_canvas_doc(&state, "fdoc", "p1");
        let blob_store = state.blob_store.clone();
        let app = router(state);

        let body = call_tool(
            app,
            &token,
            "docushark_add_file",
            json!({
                "docId": "fdoc", "pageId": "p1", "fileName": "a.pdf",
                "url": "https://example.com/a.pdf",
            }),
        )
        .await;
        assert_eq!(body["result"]["isError"], json!(true));
        assert!(
            body["result"]["content"][0]["text"]
                .as_str()
                .unwrap()
                .starts_with("ERR_INGEST_NOT_CONFIGURED"),
            "{body}"
        );
        assert_eq!(blob_store.get_blob_count(), 0, "nothing stored");
    }

    /// The upload enforces the effective storage quota (the config fallback
    /// here — a JWT claim would override it via the same helper REST uses).
    #[tokio::test]
    async fn add_file_enforces_storage_quota() {
        let dir = TempDir::new().unwrap();
        let (mut state, token) = make_state(&dir);
        state.blob_write.fallback_quota_bytes = 4; // tiny cap
        seed_canvas_doc(&state, "fdoc", "p1");
        let blob_store = state.blob_store.clone();
        let app = router(state);

        let body = call_tool(
            app,
            &token,
            "docushark_add_file",
            json!({
                "docId": "fdoc", "pageId": "p1", "fileName": "big.txt",
                "base64": "aGVsbG8gZmlsZSEh", // 12 bytes > 4-byte quota
            }),
        )
        .await;
        assert_eq!(body["result"]["isError"], json!(true));
        assert!(
            body["result"]["content"][0]["text"]
                .as_str()
                .unwrap()
                .starts_with("ERR_QUOTA_EXCEEDED"),
            "{body}"
        );
        assert_eq!(blob_store.get_blob_count(), 0, "over-quota upload stores nothing");
    }

    /// The preflight validates the attach target BEFORE storing bytes — a bad
    /// page leaves no orphan blob behind.
    #[tokio::test]
    async fn add_file_validates_target_before_storing_bytes() {
        let dir = TempDir::new().unwrap();
        let (state, token) = make_state(&dir);
        seed_canvas_doc(&state, "fdoc", "p1");
        let blob_store = state.blob_store.clone();
        let app = router(state);

        let body = call_tool(
            app,
            &token,
            "docushark_add_file",
            json!({
                "docId": "fdoc", "pageId": "no-such-page", "fileName": "a.txt",
                "base64": "Zm9v",
            }),
        )
        .await;
        assert_eq!(body["result"]["isError"], json!(true));
        assert!(
            body["result"]["content"][0]["text"].as_str().unwrap().contains("not found"),
            "{body}"
        );
        assert_eq!(blob_store.get_blob_count(), 0, "validation failed before any byte was stored");
    }

    #[tokio::test]
    async fn public_router_omits_root_info_but_serves_metadata() {
        let dir = TempDir::new().unwrap();
        let (state, _) = make_state(&dir);
        let app = public_router(state);
        // `/` belongs to the sync/REST server it merges into — not served here.
        let root = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(root.status(), StatusCode::NOT_FOUND);
        // The RFC 9728 discovery doc is still served.
        let meta = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/.well-known/oauth-protected-resource")
                    .header("host", "relay.example.com")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(meta.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn public_mode_refuses_static_token() {
        let dir = TempDir::new().unwrap();
        let (mut state, token) = make_state(&dir);
        // Public pods set this off — the static single-tenant token must not
        // authenticate (callers present a `wsp`-scoped JWT instead).
        state.allow_static_token = false;
        let app = public_router(state);
        let req = Request::builder()
            .method("POST")
            .uri("/mcp")
            .header("content-type", "application/json")
            .header("authorization", format!("Bearer {}", token))
            .body(axum::body::Body::from(
                serde_json::to_vec(&json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}))
                    .unwrap(),
            ))
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn initialize_advertises_protocol_version() {
        let dir = TempDir::new().unwrap();
        let (state, token) = make_state(&dir);
        let app = router(state);
        let req = Request::builder()
            .method("POST")
            .uri("/mcp")
            .header("content-type", "application/json")
            .header("authorization", format!("Bearer {}", token))
            .body(axum::body::Body::from(
                serde_json::to_vec(&json!({
                    "jsonrpc": "2.0", "id": 1, "method": "initialize",
                    "params": {"protocolVersion": MCP_PROTOCOL_VERSION}
                }))
                .unwrap(),
            ))
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        let body = body_json(resp).await;
        assert_eq!(body["result"]["protocolVersion"], MCP_PROTOCOL_VERSION);
        assert_eq!(body["result"]["serverInfo"]["name"], "docushark");
    }
}
