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

use std::sync::Arc;

use std::convert::Infallible;
use std::time::Duration;

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    routing::{get, post},
    Json, Router,
};
use futures_util::stream;
use serde_json::{json, Value};

use crate::server::documents::DocumentStore;

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
    pub on_doc_changed: Arc<dyn Fn(String) + Send + Sync>,
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
        .route("/", get(root_info))
        .with_state(state)
}

/// Liveness/info endpoint. Returns server name + version with no auth, so
/// a user can sanity-check the binding from a browser.
async fn root_info() -> Response {
    Json(json!({
        "server": "diagrammer-mcp",
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
    if !check_auth(&headers, &state.token) {
        log::warn!("MCP SSE: missing or invalid bearer token");
        return (StatusCode::UNAUTHORIZED, "Missing or invalid bearer token").into_response();
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
    if !check_auth(&headers, &state.token) {
        return (StatusCode::UNAUTHORIZED, "Missing or invalid bearer token").into_response();
    }
    StatusCode::NO_CONTENT.into_response()
}

async fn handle_rpc(
    State(state): State<McpAppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !check_auth(&headers, &state.token) {
        log::warn!(
            "MCP POST /mcp: rejected (missing or invalid bearer token) from {:?}",
            headers.get("user-agent").and_then(|v| v.to_str().ok()).unwrap_or("?")
        );
        return (StatusCode::UNAUTHORIZED, "Missing or invalid bearer token").into_response();
    }

    let id = body.get("id").cloned().unwrap_or(Value::Null);
    let method = match body.get("method").and_then(|v| v.as_str()) {
        Some(m) => m.to_string(),
        None => return rpc_error(id, -32600, "Invalid Request: missing method"),
    };
    let params = body.get("params").cloned().unwrap_or(json!({}));
    log::info!("MCP rpc method={}", method);

    match method.as_str() {
        "initialize" => Json(rpc_result(id, initialize_result())).into_response(),
        "tools/list" => Json(rpc_result(id, tools_list_result())).into_response(),
        "tools/call" => handle_tools_call(&state, id, &params),
        // Spec-defined no-op notifications we may receive from the client.
        "notifications/initialized" | "ping" => {
            (StatusCode::OK, Json(json!({"jsonrpc": "2.0", "id": id, "result": {}}))).into_response()
        }
        other => rpc_error(id, -32601, &format!("Method not found: {}", other)),
    }
}

fn check_auth(headers: &HeaderMap, token: &TokenStore) -> bool {
    let header = match headers.get("authorization") {
        Some(h) => h,
        None => return false,
    };
    let value = match header.to_str() {
        Ok(s) => s,
        Err(_) => return false,
    };
    let presented = match value.strip_prefix("Bearer ").or_else(|| value.strip_prefix("bearer ")) {
        Some(s) => s.trim(),
        None => return false,
    };
    token.validate(presented)
}

fn initialize_result() -> Value {
    json!({
        "protocolVersion": MCP_PROTOCOL_VERSION,
        "capabilities": {
            "tools": {"listChanged": false}
        },
        "serverInfo": {
            "name": "diagrammer",
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

fn handle_tools_call(state: &McpAppState, id: Value, params: &Value) -> Response {
    let name = match params.get("name").and_then(|v| v.as_str()) {
        Some(n) => n,
        None => return rpc_error(id, -32602, "Invalid params: missing tool name"),
    };
    let args = params.get("arguments").cloned().unwrap_or(json!({}));

    let ctx = ToolContext {
        team: &state.doc_store,
        local: &state.local_mirror,
        local_enabled: state.feature_config.local_access_enabled(),
    };
    match dispatch(&ctx, name, &args) {
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
        assert!(names.contains(&"diagrammer.list_documents"));
        assert!(names.contains(&"diagrammer.add_shape"));
        assert!(names.contains(&"diagrammer.add_shapes"));
        assert!(names.contains(&"diagrammer.connect"));
        assert!(names.contains(&"diagrammer.update_shape"));
        assert_eq!(tools.len(), 7);
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
        assert_eq!(body["result"]["serverInfo"]["name"], "diagrammer");
    }
}
