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

use crate::auth::OidcAuthState;
use crate::server::documents::DocumentStore;
use crate::server::protocol::{DocId, WorkspaceId};
use crate::server::WorkspaceWriteLimiter;

use super::config::McpFeatureConfigStore;
use super::local_mirror::LocalDocumentMirror;
use super::token::TokenStore;
use super::tools::{descriptors, dispatch, ToolContext};

/// MCP protocol version this server implements. Update in lockstep with
/// the spec the user's Claude Code client supports.
const MCP_PROTOCOL_VERSION: &str = "2025-06-18";

/// Shared state passed into the Axum handler.
#[derive(Clone)]
pub struct McpAppState {
    pub doc_store: Arc<DocumentStore>,
    pub local_mirror: Arc<LocalDocumentMirror>,
    pub feature_config: Arc<McpFeatureConfigStore>,
    pub token: Arc<TokenStore>,
    /// Called after a successful write so the running app can refresh.
    pub on_doc_changed: Arc<dyn Fn(DocId) + Send + Sync>,
    /// Shared with `ServerState.panic_count` so MCP tool panics
    /// surface at the WS `/metrics` counter. Phase 21.2.
    pub panic_counter: Arc<AtomicU64>,
    /// Shared with `ServerState.write_limiter` so MCP write tools
    /// draw from the same per-workspace token bucket as WS sync
    /// frames. Phase 21.3.
    pub write_limiter: Arc<WorkspaceWriteLimiter>,
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
    Router::new()
        .route("/mcp", post(handle_rpc).get(handle_sse).delete(handle_delete))
        .route(
            "/.well-known/oauth-protected-resource",
            get(oauth_protected_resource),
        )
        .route("/", get(root_info))
        .with_state(state)
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
        "version": env!("CARGO_PKG_VERSION"),
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
    if authenticate(&headers, &state.token, &state.auth, &state.relay_region).await.is_none() {
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
    if authenticate(&headers, &state.token, &state.auth, &state.relay_region).await.is_none() {
        return unauthorized(&headers);
    }
    StatusCode::NO_CONTENT.into_response()
}

async fn handle_rpc(
    State(state): State<McpAppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let auth = match authenticate(&headers, &state.token, &state.auth, &state.relay_region).await {
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
        "tools/call" => handle_tools_call(&state, &auth.workspace, id, &params),
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
) -> Option<AuthOutcome> {
    let presented = extract_bearer(headers)?;
    if token.validate(presented) {
        return Some(AuthOutcome {
            workspace: WorkspaceId::single_tenant(),
        });
    }
    if let Ok(claims) = auth.validate(presented).await {
        if let Ok((ws, _role, _limits)) = WorkspaceId::from_oidc_array(&claims, None, relay_region) {
            return Some(AuthOutcome { workspace: ws });
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
            "version": env!("CARGO_PKG_VERSION")
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
        "docushark.add_shape"
            | "docushark.add_shapes"
            | "docushark.connect"
            | "docushark.update_shape"
    )
}

fn handle_tools_call(
    state: &McpAppState,
    workspace: &WorkspaceId,
    id: Value,
    params: &Value,
) -> Response {
    let name = match params.get("name").and_then(|v| v.as_str()) {
        Some(n) => n,
        None => return rpc_error(id, -32602, "Invalid params: missing tool name"),
    };
    let args = params.get("arguments").cloned().unwrap_or(json!({}));

    let ctx = ToolContext {
        team: &state.doc_store,
        local: &state.local_mirror,
        local_enabled: state.feature_config.local_access_enabled(),
        workspace_id: workspace.clone(),
        registry: &state.sync_registry,
        on_doc_update: state.on_doc_update.as_ref(),
    };

    // Phase 21.3: per-workspace write rate limit. Only mutating tools
    // count against the bucket — reads pass through. The workspace
    // here is the single-tenant default until MCP grows a workspace
    // claim of its own (deferred follow-up). Even so, MCP and WS
    // share the bucket, so a chatty MCP client and a chatty browser
    // editor on the same workspace see fair accounting.
    if is_mcp_write_tool(name) {
        if state.write_limiter.check_key(&ctx.workspace_id).is_err() {
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
    }

    // Phase 21.2: catch tool panics so one bad tool call can't take
    // down the MCP HTTP server. `dispatch` is sync, so we use the
    // stdlib catch_unwind directly (no future combinator needed).
    let outcome = match std::panic::catch_unwind(AssertUnwindSafe(|| dispatch(&ctx, name, &args))) {
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
    };

    match outcome {
        Ok(outcome) => {
            if let Some(doc_id) = outcome.changed_doc_id {
                (state.on_doc_changed)(doc_id);
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
            local_mirror: local,
            feature_config: cfg,
            token,
            on_doc_changed: Arc::new(|_| {}),
            panic_counter: Arc::new(AtomicU64::new(0)),
            rate_limit_rejections: Arc::new(AtomicU64::new(0)),
            write_limiter: Arc::new(crate::server::build_workspace_limiter(1000, 1000)),
            auth: test_auth_state(),
            relay_region: "default".to_string(),
            sync_registry: Arc::new(crate::sync::DocRegistry::new()),
            on_doc_update: Arc::new(|_, _, _| {}),
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
        assert!(names.contains(&"docushark.list_documents"));
        assert!(names.contains(&"docushark.create_document"));
        assert!(names.contains(&"docushark.add_shape"));
        assert!(names.contains(&"docushark.add_shapes"));
        assert!(names.contains(&"docushark.connect"));
        assert!(names.contains(&"docushark.update_shape"));
        assert!(names.contains(&"docushark.get_prose"));
        assert!(names.contains(&"docushark.add_prose_page"));
        assert!(names.contains(&"docushark.set_prose"));
        assert!(names.contains(&"docushark.rename_prose_page"));
        assert!(names.contains(&"docushark.get_outline"));
        assert!(names.contains(&"docushark.insert_section"));
        assert!(names.contains(&"docushark.restructure_outline"));
        assert!(names.contains(&"docushark.generate_diagram"));
        assert_eq!(tools.len(), 16);
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
