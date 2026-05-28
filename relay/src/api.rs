//! REST API handlers — auth + document CRUD.
//!
//! Additive surface introduced in Phase 20.3 Slice D.3. The existing
//! WebSocket DOC_LIST/GET/SAVE/DELETE multiplex stays in place until
//! Slice E switches the renderer to these endpoints; both code paths
//! share the same `DocumentStore` and `UserStore` instances so they
//! cannot diverge.
//!
//! Mounted at `/api/...` by `server::mod::WebSocketServer::start`.
//! See `routes()` for the full surface.

use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{delete, get, post, put},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::auth::{OidcClaims, WorkspaceRole};
use crate::server::documents::SaveOutcome;
use crate::server::protocol::ShareEntry;
use crate::server::permissions::{
    check_delete_permission, check_read_permission, check_write_permission, to_error_string,
    PermissionError,
};
use crate::server::protocol::{DocEventType, DocId, WorkspaceId};
use crate::server::ServerState;

/// Resolve the workspace this request is authenticated to, and apply
/// the configured `[tenancy]` mode. Returns either the
/// `WorkspaceId` to use for storage calls, or a pre-built 403
/// response with an opaque "forbidden" body (no tenant
/// disambiguation, per Phase 21.5 acceptance).
fn resolve_workspace(
    state: &Arc<ServerState>,
    claims: &OidcClaims,
) -> Result<(WorkspaceId, WorkspaceRole), axum::response::Response> {
    let (ws, role) = match WorkspaceId::from_oidc_array(claims, None, state.relay_region()) {
        Ok(v) => v,
        Err(_) => {
            return Err((StatusCode::FORBIDDEN, ApiError::body("forbidden")).into_response());
        }
    };
    if state.check_tenancy(&ws).is_err() {
        return Err((StatusCode::FORBIDDEN, ApiError::body("forbidden")).into_response());
    }
    Ok((ws, role))
}

/// Stringified role value used by the permissions layer.
fn role_str(role: WorkspaceRole) -> &'static str {
    match role {
        WorkspaceRole::Owner => "owner",
        WorkspaceRole::Member => "user",
        WorkspaceRole::Viewer => "viewer",
    }
}

/// Translate a `PermissionError` into the right HTTP response.
/// Critically, `DocumentNotFound` becomes 404 — returning 403 here
/// would leak the existence of a doc that lives in another workspace
/// (the cross-tenant fuzz suite catches this regression).
fn permission_error_response(err: &PermissionError) -> axum::response::Response {
    let status = match err {
        PermissionError::DocumentNotFound => StatusCode::NOT_FOUND,
        _ => StatusCode::FORBIDDEN,
    };
    (status, ApiError::body(to_error_string(err))).into_response()
}

/// Parse the `:id` HTTP path segment into a `DocId`, returning a
/// pre-built 400 response on validation failure. This is one of the
/// two blessed `String → DocId` conversion points (the other is JSON
/// deserialization on the wire).
fn parse_doc_path(id: String) -> Result<DocId, axum::response::Response> {
    DocId::from_http_path(id).map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            ApiError::body(format!("invalid document id: {}", e)),
        )
            .into_response()
    })
}

/// Build the REST router. Merged into the main Axum router in
/// `WebSocketServer::start` so /api/* shares the listener with /ws.
pub fn routes() -> Router<Arc<ServerState>> {
    Router::new()
        .route("/api/v1/internal/revoke", post(revoke_handler))
        .route("/api/docs", get(list_docs_handler))
        .route("/api/docs/:id", get(get_doc_handler))
        .route("/api/docs/:id", put(save_doc_handler))
        .route("/api/docs/:id", delete(delete_doc_handler))
        .route("/api/docs/:id/share", post(share_doc_handler))
        .route("/api/docs/:id/transfer", post(transfer_doc_handler))
}

// ============ Request / Response shapes ============

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WriteAck {
    success: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveAck {
    success: bool,
    new_version: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VersionConflictBody {
    error_code: &'static str,
    current_version: u64,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct SaveQuery {
    /// Caller's expected `serverVersion`. When present, the relay
    /// refuses the write (HTTP 409) if the stored version differs.
    expected_version: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShareRequest {
    shares: Vec<ShareEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TransferRequest {
    new_owner_id: String,
    new_owner_name: String,
}

#[derive(Serialize)]
struct ApiError {
    error: String,
}

impl ApiError {
    fn body(error: impl Into<String>) -> Json<ApiError> {
        Json(ApiError {
            error: error.into(),
        })
    }
}

// ============ Revocation push (internal control-plane endpoint) ============

async fn revoke_handler(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Json(batch): Json<crate::auth::RevocationBatch>,
) -> impl IntoResponse {
    let expected = match state.revocation_push_bearer() {
        Some(s) => s.to_string(),
        None => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                ApiError::body("revocation push transport disabled"),
            )
                .into_response();
        }
    };
    let presented = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::trim)
        .unwrap_or("");
    if !constant_time_eq(presented.as_bytes(), expected.as_bytes()) {
        return (
            StatusCode::UNAUTHORIZED,
            ApiError::body("unauthorized"),
        )
            .into_response();
    }

    state.auth().revocations.revoke_many(&batch.revocations);
    log::info!(
        "applied {} revocation(s); set_size={}",
        batch.revocations.len(),
        state.auth().revocations.len()
    );
    StatusCode::NO_CONTENT.into_response()
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

// ============ Document CRUD handlers ============

async fn list_docs_handler(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let claims = match require_auth(&state, &headers).await {
        Ok(c) => c,
        Err(resp) => return resp,
    };
    let (ws, _role) = match resolve_workspace(&state, &claims) {
        Ok(ws) => ws,
        Err(resp) => return resp,
    };
    let docs = state.doc_store().list_documents(&ws);
    (StatusCode::OK, Json(json!({ "documents": docs }))).into_response()
}

async fn get_doc_handler(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let claims = match require_auth(&state, &headers).await {
        Ok(c) => c,
        Err(resp) => return resp,
    };
    let doc_id = match parse_doc_path(id) {
        Ok(d) => d,
        Err(resp) => return resp,
    };
    let (ws, role) = match resolve_workspace(&state, &claims) {
        Ok(ws) => ws,
        Err(resp) => return resp,
    };

    if let Err(e) = check_read_permission(
        state.doc_store(),
        &ws,
        &doc_id,
        Some(&claims.sub),
        Some(role_str(role)),
    ) {
        return permission_error_response(&e);
    }

    match state.doc_store().get_document(&ws, &doc_id) {
        Ok(doc) => (StatusCode::OK, Json(doc)).into_response(),
        Err(e) => (StatusCode::NOT_FOUND, ApiError::body(e)).into_response(),
    }
}

async fn save_doc_handler(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(query): Query<SaveQuery>,
    Json(document): Json<Value>,
) -> impl IntoResponse {
    let claims = match require_auth(&state, &headers).await {
        Ok(c) => c,
        Err(resp) => return resp,
    };
    let doc_id = match parse_doc_path(id) {
        Ok(d) => d,
        Err(resp) => return resp,
    };
    let (ws, role) = match resolve_workspace(&state, &claims) {
        Ok(ws) => ws,
        Err(resp) => return resp,
    };

    // The doc body's `id` must match the path id — REST clients can't
    // forge a different doc id via the body.
    let body_id = document.get("id").and_then(|v| v.as_str()).unwrap_or("");
    if body_id != doc_id.as_str() {
        return (
            StatusCode::BAD_REQUEST,
            ApiError::body("document.id does not match path id"),
        )
            .into_response();
    }

    let doc_exists = state.doc_store().get_metadata(&ws, &doc_id).is_some();

    if doc_exists {
        if let Err(e) = check_write_permission(
            state.doc_store(),
            &ws,
            &doc_id,
            Some(&claims.sub),
            Some(role_str(role)),
        ) {
            return permission_error_response(&e);
        }
    }

    let outcome = match state
        .doc_store()
        .save_document_with_expected_version(&ws, document, query.expected_version)
    {
        Ok(o) => o,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, ApiError::body(e)).into_response(),
    };

    match outcome {
        SaveOutcome::VersionConflict { current } => (
            StatusCode::CONFLICT,
            Json(VersionConflictBody {
                error_code: "VERSION_CONFLICT",
                current_version: current,
            }),
        )
            .into_response(),
        SaveOutcome::Created { version } | SaveOutcome::Updated { version } => {
            let event_type = if matches!(outcome, SaveOutcome::Created { .. }) {
                DocEventType::Created
            } else {
                DocEventType::Updated
            };
            state.emit_doc_event(&ws, &doc_id, event_type, Some(claims.sub.clone()));
            (
                StatusCode::OK,
                Json(SaveAck {
                    success: true,
                    new_version: version,
                }),
            )
                .into_response()
        }
    }
}

async fn delete_doc_handler(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let claims = match require_auth(&state, &headers).await {
        Ok(c) => c,
        Err(resp) => return resp,
    };
    let doc_id = match parse_doc_path(id) {
        Ok(d) => d,
        Err(resp) => return resp,
    };
    let (ws, role) = match resolve_workspace(&state, &claims) {
        Ok(ws) => ws,
        Err(resp) => return resp,
    };

    if let Err(e) = check_delete_permission(
        state.doc_store(),
        &ws,
        &doc_id,
        Some(&claims.sub),
        Some(role_str(role)),
    ) {
        return permission_error_response(&e);
    }

    match state.doc_store().delete_document(&ws, &doc_id) {
        Ok(true) => {
            state.emit_doc_event(&ws, &doc_id, DocEventType::Deleted, Some(claims.sub.clone()));
            (StatusCode::OK, Json(WriteAck { success: true })).into_response()
        }
        Ok(false) => (
            StatusCode::NOT_FOUND,
            ApiError::body("document not found"),
        )
            .into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, ApiError::body(e)).into_response(),
    }
}

async fn share_doc_handler(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<ShareRequest>,
) -> impl IntoResponse {
    let claims = match require_auth(&state, &headers).await {
        Ok(c) => c,
        Err(resp) => return resp,
    };
    let doc_id = match parse_doc_path(id) {
        Ok(d) => d,
        Err(resp) => return resp,
    };
    let (ws, role) = match resolve_workspace(&state, &claims) {
        Ok(ws) => ws,
        Err(resp) => return resp,
    };

    // Owner-only — matches WS handler at server::mod::handle_doc_share.
    if let Err(e) = check_delete_permission(
        state.doc_store(),
        &ws,
        &doc_id,
        Some(&claims.sub),
        Some(role_str(role)),
    ) {
        return permission_error_response(&e);
    }

    if let Err(e) = state.doc_store().update_document_shares(&ws, &doc_id, &body.shares) {
        return (StatusCode::INTERNAL_SERVER_ERROR, ApiError::body(e)).into_response();
    }

    state.emit_doc_event(&ws, &doc_id, DocEventType::Updated, Some(claims.sub.clone()));

    (StatusCode::OK, Json(WriteAck { success: true })).into_response()
}

async fn transfer_doc_handler(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<TransferRequest>,
) -> impl IntoResponse {
    let claims = match require_auth(&state, &headers).await {
        Ok(c) => c,
        Err(resp) => return resp,
    };
    let doc_id = match parse_doc_path(id) {
        Ok(d) => d,
        Err(resp) => return resp,
    };
    let (ws, role) = match resolve_workspace(&state, &claims) {
        Ok(ws) => ws,
        Err(resp) => return resp,
    };

    if let Err(e) = check_delete_permission(
        state.doc_store(),
        &ws,
        &doc_id,
        Some(&claims.sub),
        Some(role_str(role)),
    ) {
        // 404 for cross-workspace probes; 403 + "Only owner" for the
        // owner-vs-editor case.
        if matches!(e, PermissionError::DocumentNotFound) {
            return permission_error_response(&e);
        }
        return (
            StatusCode::FORBIDDEN,
            ApiError::body(format!("Only owner can transfer: {}", to_error_string(&e))),
        )
            .into_response();
    }

    if let Err(e) = state.doc_store().transfer_ownership(
        &ws,
        &doc_id,
        &body.new_owner_id,
        &body.new_owner_name,
        &claims.sub,
    ) {
        return (StatusCode::INTERNAL_SERVER_ERROR, ApiError::body(e)).into_response();
    }

    state.emit_doc_event(&ws, &doc_id, DocEventType::Updated, Some(claims.sub.clone()));

    (StatusCode::OK, Json(WriteAck { success: true })).into_response()
}

// ============ Helpers ============

/// Pull `Authorization: Bearer <jwt>` from request headers and validate
/// it against the relay's OIDC config. Returns a ready-to-build
/// `Response` on failure so handlers can `match`/`?` cleanly.
async fn require_auth(
    state: &Arc<ServerState>,
    headers: &HeaderMap,
) -> Result<OidcClaims, axum::response::Response> {
    let auth_header = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    let token = auth_header.strip_prefix("Bearer ").unwrap_or("").trim();
    if token.is_empty() {
        return Err((
            StatusCode::UNAUTHORIZED,
            ApiError::body("missing bearer token"),
        )
            .into_response());
    }

    state.auth().validate(token).await.map_err(|e| {
        let (status, _) = crate::server::auth_error_to_http(&e);
        (status, ApiError::body(format!("invalid token: {}", e))).into_response()
    })
}
