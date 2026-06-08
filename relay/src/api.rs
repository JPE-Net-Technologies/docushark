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

use std::collections::HashSet;
use std::net::IpAddr;
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
use crate::server::blobs::{BlobStore, SaveBlobError};
use crate::server::protocol::{ClaimLimits, DocEventType, DocId, WorkspaceId};
use crate::server::ServerState;

/// Resolve the workspace this request is authenticated to, and apply
/// the configured `[tenancy]` mode. Returns either the
/// `WorkspaceId` to use for storage calls, or a pre-built 403
/// response with an opaque "forbidden" body (no tenant
/// disambiguation, per Phase 21.5 acceptance).
fn resolve_workspace(
    state: &Arc<ServerState>,
    claims: &OidcClaims,
) -> Result<(WorkspaceId, WorkspaceRole, ClaimLimits), axum::response::Response> {
    let (ws, role, limits) = match WorkspaceId::from_oidc_array(claims, None, state.relay_region()) {
        Ok(v) => v,
        Err(_) => {
            return Err((StatusCode::FORBIDDEN, ApiError::body("forbidden")).into_response());
        }
    };
    if state.check_tenancy(&ws).is_err() {
        return Err((StatusCode::FORBIDDEN, ApiError::body("forbidden")).into_response());
    }
    Ok((ws, role, limits))
}

/// Extract a document's referenced blob hashes from its `blobReferences`
/// array (JP-120) — the canonical per-doc reference set the relay refcounts
/// against. Bare SHA-256 hashes; a `blob://` prefix is stripped defensively
/// in case a client ever sends the URI form.
pub(crate) fn blob_refs_from_doc(doc: &Value) -> HashSet<String> {
    doc.get("blobReferences")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str())
                .map(|s| s.strip_prefix("blob://").unwrap_or(s).to_string())
                .collect()
        })
        .unwrap_or_default()
}

/// Whether `hash` is a well-formed SHA-256 hex digest (64 lowercase hex
/// chars). Beyond rejecting junk, this is a **security gate** for the presign
/// path: the hash becomes part of the R2 object key, so anything but `[0-9a-f]`
/// (e.g. `/` or `..`) could escape the workspace prefix. The bytes are never
/// re-hashed server-side under direct-to-R2, so the format check is the only
/// structural guard at mint time.
fn is_valid_blob_hash(hash: &str) -> bool {
    hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
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
        .route("/api/v1/usage", get(usage_handler))
        .route("/api/v1/blobs/:hash/upload-url", post(blob_upload_url_handler))
        .route("/api/v1/blobs/:hash/finalize", post(blob_finalize_handler))
        .route(
            "/api/v1/blobs/:hash/download-url",
            post(blob_download_url_handler),
        )
        .route(
            "/api/v1/blobs/ingest-from-url",
            post(blob_ingest_from_url_handler),
        )
        .route("/api/docs", get(list_docs_handler))
        .route("/api/docs/:id", get(get_doc_handler))
        .route("/api/docs/:id", put(save_doc_handler))
        .route("/api/docs/:id", delete(delete_doc_handler))
        .route("/api/docs/:id/share", post(share_doc_handler))
        .route("/api/docs/:id/transfer", post(transfer_doc_handler))
        .route("/api/docs/:id/recovery", get(list_recovery_handler))
        .route(
            "/api/docs/:id/recovery/:pointId/restore",
            post(restore_recovery_handler),
        )
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

/// Workspace-scoped usage + effective limits, consumed by the
/// `docushark-web` account portal (JP-82). `null` quota/limit means
/// unlimited. Serialized camelCase to match the rest of the relay's REST
/// JSON. Privacy: counts only — no doc ids, no content (JP-81).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UsageResponse {
    storage_bytes: u64,
    storage_quota: Option<u64>,
    active_editors: u32,
    editor_limit: Option<u32>,
}

/// Body of `POST /api/v1/blobs/:hash/upload-url`. `size` is the client-asserted
/// byte length (re-verified authoritatively at finalize via the object HEAD).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadUrlRequest {
    size: u64,
    #[serde(default)]
    mime_type: Option<String>,
}

/// Body of `POST /api/v1/blobs/:hash/finalize`. The size is read from the
/// object store, not the client, so only the (optional) MIME type is accepted.
#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct FinalizeRequest {
    #[serde(default)]
    mime_type: Option<String>,
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
    let (ws, _role, _limits) = match resolve_workspace(&state, &claims) {
        Ok(ws) => ws,
        Err(resp) => return resp,
    };
    // JP-200: on a cold machine, repopulate the workspace index from R2 first so
    // a listing isn't empty after a recycle (best-effort; never clobbers a
    // populated in-memory index).
    state.ensure_workspace_index_local(&ws).await;
    let docs = state.doc_store().list_documents(&ws);
    (StatusCode::OK, Json(json!({ "documents": docs }))).into_response()
}

/// `GET /api/v1/usage` — the caller's own workspace usage + effective
/// limits (JP-81). Workspace is resolved from the validated JWT exactly
/// like `/api/docs`, so a caller can only ever see their own numbers.
async fn usage_handler(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let claims = match require_auth(&state, &headers).await {
        Ok(c) => c,
        Err(resp) => return resp,
    };
    let (ws, _role, limits) = match resolve_workspace(&state, &claims) {
        Ok(ws) => ws,
        Err(resp) => return resp,
    };
    state.ensure_blob_bookkeeping(&ws).await;
    let effective = state.resolve_limits(limits);
    let counts = state.workspace_conn_for(&ws).await;
    (
        StatusCode::OK,
        Json(UsageResponse {
            storage_bytes: state.blob_store().get_workspace_size(&ws),
            storage_quota: effective.quota_bytes,
            active_editors: counts.editors,
            editor_limit: effective.editor_limit,
        }),
    )
        .into_response()
}

/// `POST /api/v1/blobs/:hash/upload-url` — mint a presigned PUT so the client
/// uploads blob bytes **directly to object storage**, bypassing the relay.
///
/// Short-circuits with `{ "exists": true }` when the workspace already holds
/// the blob (dedup), refuses oversize (413) and projected over-quota (507)
/// before minting, and returns 409 `presign_unsupported` on the filesystem
/// backend (the client then falls back to the proxy `POST /api/blobs/:hash`).
/// The mint is advisory on size; finalize re-checks the real size.
async fn blob_upload_url_handler(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Path(hash): Path<String>,
    Json(req): Json<UploadUrlRequest>,
) -> impl IntoResponse {
    let claims = match require_auth(&state, &headers).await {
        Ok(c) => c,
        Err(resp) => return resp,
    };
    let (ws, _role, limits) = match resolve_workspace(&state, &claims) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    state.ensure_blob_bookkeeping(&ws).await;
    if !is_valid_blob_hash(&hash) {
        return (StatusCode::BAD_REQUEST, ApiError::body("invalid blob hash")).into_response();
    }

    let s3 = match state.s3_backend() {
        Some(s3) => s3,
        None => {
            return (StatusCode::CONFLICT, ApiError::body("presign_unsupported")).into_response();
        }
    };

    // Dedup: the workspace already has this blob → client skips upload+finalize.
    if state.blob_store().exists(&ws, &hash) {
        return (StatusCode::OK, Json(json!({ "exists": true }))).into_response();
    }

    // Per-request size ceiling (mirrors the proxy body limit, JP-125).
    if req.size > state.max_blob_bytes() as u64 {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            ApiError::body("blob exceeds max size"),
        )
            .into_response();
    }

    // Projected per-workspace quota — re-checked authoritatively at finalize.
    if let Some(quota) = state.resolve_limits(limits).quota_bytes {
        let used = state.blob_store().get_workspace_size(&ws);
        if used.saturating_add(req.size) > quota {
            return (
                StatusCode::INSUFFICIENT_STORAGE,
                ApiError::body("storage quota exceeded"),
            )
                .into_response();
        }
    }

    let mime = req.mime_type.as_deref().unwrap_or("application/octet-stream");
    let mint = s3.presign_put(&ws, &hash, mime);
    let headers_obj: serde_json::Map<String, Value> = mint
        .headers
        .iter()
        .map(|(k, v)| (k.clone(), Value::String(v.clone())))
        .collect();
    (
        StatusCode::OK,
        Json(json!({
            "url": mint.url,
            "headers": headers_obj,
            "expiresAt": mint.expires_at,
            "key": mint.key,
        })),
    )
        .into_response()
}

/// `POST /api/v1/blobs/:hash/finalize` — after a direct presigned PUT, confirm
/// the object landed, read its **authoritative size** from the store's HEAD,
/// re-check the workspace quota against that real size (reclaiming + 507 if
/// over), then record the blob + grant the workspace its ACL. This is the
/// back half of the proxy upload, split out because the bytes never touch the
/// relay.
async fn blob_finalize_handler(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Path(hash): Path<String>,
    Json(req): Json<FinalizeRequest>,
) -> impl IntoResponse {
    let claims = match require_auth(&state, &headers).await {
        Ok(c) => c,
        Err(resp) => return resp,
    };
    let (ws, _role, limits) = match resolve_workspace(&state, &claims) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    state.ensure_blob_bookkeeping(&ws).await;
    if !is_valid_blob_hash(&hash) {
        return (StatusCode::BAD_REQUEST, ApiError::body("invalid blob hash")).into_response();
    }

    let s3 = match state.s3_backend() {
        Some(s3) => s3,
        None => {
            return (StatusCode::CONFLICT, ApiError::body("presign_unsupported")).into_response();
        }
    };

    // Authoritative size from the object store; absent = the PUT never landed.
    let size = match s3.head_object(&ws, &hash).await {
        Ok(Some(size)) => size,
        Ok(None) => {
            return (StatusCode::NOT_FOUND, ApiError::body("object_not_uploaded")).into_response();
        }
        Err(e) => {
            log::warn!("finalize HEAD failed for {}/{}: {}", ws.as_str(), hash, e);
            return (
                StatusCode::BAD_GATEWAY,
                ApiError::body("blob store unavailable"),
            )
                .into_response();
        }
    };

    // Re-run the quota against the *real* size; a new grant that would exceed
    // it is refused and the just-uploaded object reclaimed (closes the
    // lie-about-size hole in the advisory mint check). A re-finalize of an
    // already-granted hash adds 0 (dedup) and skips the check.
    if !state.blob_store().exists(&ws, &hash) {
        if let Some(quota) = state.resolve_limits(limits).quota_bytes {
            let used = state.blob_store().get_workspace_size(&ws);
            if used.saturating_add(size) > quota {
                if let Err(e) = s3.delete_object(&ws, &hash).await {
                    log::warn!(
                        "failed to reclaim over-quota object {}/{}: {}",
                        ws.as_str(),
                        hash,
                        e
                    );
                }
                return (
                    StatusCode::INSUFFICIENT_STORAGE,
                    ApiError::body("storage quota exceeded"),
                )
                    .into_response();
            }
        }
    }

    let mime = req.mime_type.as_deref().unwrap_or("application/octet-stream");
    match state
        .blob_store()
        .record_finalized_blob(&ws, &hash, size, mime, &claims.sub)
    {
        Ok(meta) => (
            StatusCode::OK,
            Json(json!({ "success": true, "hash": meta.hash, "size": meta.size })),
        )
            .into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, ApiError::body(e)).into_response(),
    }
}

/// `POST /api/v1/blobs/:hash/download-url` — mint a presigned GET so the client
/// fetches blob bytes **directly from object storage**.
///
/// Mirrors `upload-url`. It exists because the proxy `GET /api/blobs/:hash`
/// 302-redirects to a presigned R2 URL, and a browser following that
/// cross-origin redirect sends `Origin: null`, which the bucket's CORS policy
/// rejects — so the redirect can't be made to work from the web. Minting the
/// URL as JSON lets the client issue a plain same-shape GET to R2 with a real
/// `Origin` (no redirect). Returns 409 `presign_unsupported` on the filesystem
/// backend, where the client falls back to the proxy `GET /api/blobs/:hash`.
async fn blob_download_url_handler(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Path(hash): Path<String>,
) -> impl IntoResponse {
    let claims = match require_auth(&state, &headers).await {
        Ok(c) => c,
        Err(resp) => return resp,
    };
    let (ws, _role, _limits) = match resolve_workspace(&state, &claims) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    state.ensure_blob_bookkeeping(&ws).await;
    if !is_valid_blob_hash(&hash) {
        return (StatusCode::BAD_REQUEST, ApiError::body("invalid blob hash")).into_response();
    }

    let s3 = match state.s3_backend() {
        Some(s3) => s3,
        None => {
            return (StatusCode::CONFLICT, ApiError::body("presign_unsupported")).into_response();
        }
    };

    // Workspace ACL gate: an unknown / cross-tenant hash has no ACL here, so it
    // reads as a plain 404 (never leaks that the blob exists elsewhere) — the
    // same gate the 302 download handler uses.
    if !state.blob_store().exists(&ws, &hash) {
        return (StatusCode::NOT_FOUND, ApiError::body("blob not found")).into_response();
    }

    let url = s3.presign_get(&ws, &hash);
    (StatusCode::OK, Json(json!({ "url": url }))).into_response()
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
    let (ws, role, _limits) = match resolve_workspace(&state, &claims) {
        Ok(ws) => ws,
        Err(resp) => return resp,
    };

    // JP-200: restore from R2 by id on a local miss before the permission check
    // (which reads the in-memory index) so a recycled machine can serve the doc.
    state.ensure_doc_local(&ws, &doc_id).await;

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

/// `GET /api/docs/:id/recovery` — list a document's recovery points (JP-180),
/// newest first. Read-scoped exactly like `GET /api/docs/:id`. The backups are
/// written by the relay's poison guard before a suspicious N→0 zeroing; this is
/// what makes them addressable (and, via JP-183, restorable from the web UI).
async fn list_recovery_handler(
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
    let (ws, role, _limits) = match resolve_workspace(&state, &claims) {
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
    let points = state.doc_store().list_recovery_points(&ws, &doc_id);
    (StatusCode::OK, Json(json!({ "recoveryPoints": points }))).into_response()
}

/// `POST /api/docs/:id/recovery/:pointId/restore` — restore a recovery point as
/// the live document. **Stub (JP-180):** authed + workspace-scoped, but the
/// actual restore (decode sidecar → flatten to JSON → versioned save + DocEvent
/// broadcast) and the web-interface surface are tracked in JP-183.
async fn restore_recovery_handler(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Path((id, _point_id)): Path<(String, String)>,
) -> impl IntoResponse {
    let claims = match require_auth(&state, &headers).await {
        Ok(c) => c,
        Err(resp) => return resp,
    };
    let doc_id = match parse_doc_path(id) {
        Ok(d) => d,
        Err(resp) => return resp,
    };
    let (ws, _role, _limits) = match resolve_workspace(&state, &claims) {
        Ok(ws) => ws,
        Err(resp) => return resp,
    };
    // Don't leak existence across tenants: 404 if the doc isn't in this
    // workspace before advertising the not-yet-implemented restore.
    if state.doc_store().get_metadata(&ws, &doc_id).is_none() {
        return (StatusCode::NOT_FOUND, ApiError::body("document not found")).into_response();
    }
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(json!({
            "error": "recovery restore not yet implemented",
            "issue": "JP-183",
        })),
    )
        .into_response()
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
    let (ws, role, limits) = match resolve_workspace(&state, &claims) {
        Ok(ws) => ws,
        Err(resp) => return resp,
    };
    state.ensure_blob_bookkeeping(&ws).await;

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

    // Storage backpressure (JP-81): once a workspace is at/over its storage
    // quota, refuse *new* writes with 507 — existing data stays readable
    // (GET is unaffected). Doc JSON references blobs (not base64) so its own
    // metered delta is ~0; the precise per-byte clamp lives on blob upload.
    if let Some(quota) = state.resolve_limits(limits).quota_bytes {
        if state.blob_store().get_workspace_size(&ws) >= quota {
            return (
                StatusCode::INSUFFICIENT_STORAGE,
                ApiError::body("storage quota exceeded"),
            )
                .into_response();
        }
    }

    // Capture the doc's referenced blob hashes before `document` is moved
    // into the store — used to update the blob refcount after a successful
    // save (JP-120).
    let blob_refs = blob_refs_from_doc(&document);

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
            // Refresh the blob refcount; release+GC anything this doc dropped.
            if let Err(e) = state.blob_store().sync_doc_refs(&ws, doc_id.as_str(), blob_refs) {
                log::warn!(
                    "blob doc-ref sync failed for {}/{}: {}",
                    ws.as_str(),
                    doc_id.as_str(),
                    e
                );
            }
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
    let (ws, role, _limits) = match resolve_workspace(&state, &claims) {
        Ok(ws) => ws,
        Err(resp) => return resp,
    };
    state.ensure_blob_bookkeeping(&ws).await;

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
            // Release this doc's blob references; GC anything the workspace
            // no longer references (JP-120).
            if let Err(e) = state.blob_store().release_doc_refs(&ws, doc_id.as_str()) {
                log::warn!(
                    "blob doc-ref release failed for {}/{}: {}",
                    ws.as_str(),
                    doc_id.as_str(),
                    e
                );
            }
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
    let (ws, role, _limits) = match resolve_workspace(&state, &claims) {
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
    let (ws, role, _limits) = match resolve_workspace(&state, &claims) {
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

// ============ Generic blob ingest-from-URL (JP-264) ============

/// Body of `POST /api/v1/blobs/ingest-from-url`. The relay fetches `url`
/// (sending `authorization` verbatim as the `Authorization` header), stores the
/// bytes content-addressed, and returns the hash. `source`/`tags` are **opaque**
/// provenance strings recorded for audit — the relay never interprets them.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IngestFromUrlRequest {
    url: String,
    /// Verbatim value for the `Authorization` header sent to `url`.
    authorization: String,
    #[serde(default)]
    mime_type: Option<String>,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    tags: Vec<String>,
}

/// Match a host against one allowlist entry: exact, or a `*.suffix` wildcard
/// that matches the bare suffix and any subdomain. Case/trailing-dot insensitive.
fn ingest_host_matches(host: &str, pattern: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    let pat = pattern.trim().trim_end_matches('.').to_ascii_lowercase();
    if let Some(suffix) = pat.strip_prefix("*.") {
        !suffix.is_empty() && (host == suffix || host.ends_with(&format!(".{suffix}")))
    } else {
        !pat.is_empty() && host == pat
    }
}

fn ingest_host_allowed(host: &str, allow: &[String]) -> bool {
    !host.is_empty() && allow.iter().any(|p| ingest_host_matches(host, p))
}

/// Reject IP-literal hosts that point at private/loopback/link-local/unspecified
/// space (defense-in-depth atop the allowlist; covers IPv4-mapped IPv6 too).
fn ingest_ip_blocked(host: &str) -> bool {
    let h = host.trim_start_matches('[').trim_end_matches(']');
    match h.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => {
            ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_unspecified()
                || ip.is_broadcast()
        }
        Ok(IpAddr::V6(ip)) => {
            if let Some(v4) = ip.to_ipv4_mapped() {
                return v4.is_private()
                    || v4.is_loopback()
                    || v4.is_link_local()
                    || v4.is_unspecified()
                    || v4.is_broadcast();
            }
            if ip.is_loopback() || ip.is_unspecified() {
                return true;
            }
            let seg = ip.segments();
            let unique_local = (seg[0] & 0xfe00) == 0xfc00; // fc00::/7
            let link_local = (seg[0] & 0xffc0) == 0xfe80; // fe80::/10
            unique_local || link_local
        }
        Err(_) => false, // not an IP literal → a DNS host, governed by the allowlist
    }
}

/// SSRF gate: https only, host on the allowlist, not a blocked IP literal.
/// Enforced on the initial URL and (via the redirect policy) every hop.
fn ingest_url_ok(url: &reqwest::Url, allow: &[String]) -> bool {
    if url.scheme() != "https" {
        return false;
    }
    match url.host_str() {
        Some(host) => !ingest_ip_blocked(host) && ingest_host_allowed(host, allow),
        None => false,
    }
}

/// `POST /api/v1/blobs/ingest-from-url` — fetch a blob from an allowlisted URL
/// and store it content-addressed for the caller's workspace. Generic: the
/// relay has no knowledge of any specific integration; the `source`/`tags` are
/// opaque. Disabled (403) unless `[tenancy.limits] blob_ingest_allowed_hosts`
/// is configured — the relay is never an open fetch proxy by default.
async fn blob_ingest_from_url_handler(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Json(req): Json<IngestFromUrlRequest>,
) -> impl IntoResponse {
    let claims = match require_auth(&state, &headers).await {
        Ok(c) => c,
        Err(resp) => return resp,
    };
    let (ws, _role, limits) = match resolve_workspace(&state, &claims) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    state.ensure_blob_bookkeeping(&ws).await;

    let allow: Vec<String> = state.blob_ingest_allowed_hosts().to_vec();
    if allow.is_empty() {
        return (
            StatusCode::FORBIDDEN,
            ApiError::body("ingest_not_configured"),
        )
            .into_response();
    }

    let url = match reqwest::Url::parse(&req.url) {
        Ok(u) => u,
        Err(_) => return (StatusCode::BAD_REQUEST, ApiError::body("invalid url")).into_response(),
    };
    if !ingest_url_ok(&url, &allow) {
        return (StatusCode::FORBIDDEN, ApiError::body("url_not_allowed")).into_response();
    }

    let max = state.max_blob_bytes();

    // Validate every redirect hop against the same allowlist (an open redirect
    // to an internal host is the classic SSRF escape).
    let policy_allow = allow.clone();
    let client = match reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::custom(move |attempt| {
            if attempt.previous().len() > 5 {
                return attempt.error("too many redirects");
            }
            if ingest_url_ok(attempt.url(), &policy_allow) {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }))
        .timeout(std::time::Duration::from_secs(30))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            log::warn!("ingest client build failed: {e}");
            return (StatusCode::INTERNAL_SERVER_ERROR, ApiError::body("client_error"))
                .into_response();
        }
    };

    let resp = match client
        .get(url)
        .header(reqwest::header::AUTHORIZATION, &req.authorization)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            log::info!("ingest fetch failed for ws {}: {e}", ws.as_str());
            return (StatusCode::BAD_GATEWAY, ApiError::body("fetch_failed")).into_response();
        }
    };
    if !resp.status().is_success() {
        return (
            StatusCode::BAD_GATEWAY,
            ApiError::body(format!("source returned {}", resp.status())),
        )
            .into_response();
    }

    // Early reject on a declared length over the ceiling.
    if let Some(len) = resp.content_length() {
        if len > max as u64 {
            return (
                StatusCode::PAYLOAD_TOO_LARGE,
                ApiError::body("blob exceeds max size"),
            )
                .into_response();
        }
    }

    let mime = req
        .mime_type
        .clone()
        .or_else(|| {
            resp.headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .map(|s| s.split(';').next().unwrap_or(s).trim().to_string())
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "application/octet-stream".to_string());

    let body = match resp.bytes().await {
        Ok(b) => b,
        Err(e) => {
            log::info!("ingest body read failed for ws {}: {e}", ws.as_str());
            return (StatusCode::BAD_GATEWAY, ApiError::body("fetch_failed")).into_response();
        }
    };
    // Authoritative size check (the host may ignore/omit Content-Length).
    if body.len() > max {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            ApiError::body("blob exceeds max size"),
        )
            .into_response();
    }

    let hash = BlobStore::compute_hash(&body);
    let quota = state.resolve_limits(limits).quota_bytes;

    // Persist, mirroring the proxy upload's s3-vs-filesystem split.
    let (size, hash) = if let Some(s3) = state.s3_backend() {
        if state.blob_store().exists(&ws, &hash) {
            let size = state
                .blob_store()
                .get_metadata(&ws, &hash)
                .map(|m| m.size)
                .unwrap_or(body.len() as u64);
            (size, hash)
        } else {
            if let Some(q) = quota {
                if state
                    .blob_store()
                    .get_workspace_size(&ws)
                    .saturating_add(body.len() as u64)
                    > q
                {
                    return (
                        StatusCode::INSUFFICIENT_STORAGE,
                        ApiError::body("storage quota exceeded"),
                    )
                        .into_response();
                }
            }
            if let Err(e) = s3.put_object(&ws, &hash, body.to_vec(), &mime).await {
                log::warn!("ingest s3 put failed {}/{}: {e}", ws.as_str(), hash);
                return (
                    StatusCode::BAD_GATEWAY,
                    ApiError::body("blob store unavailable"),
                )
                    .into_response();
            }
            match state
                .blob_store()
                .record_finalized_blob(&ws, &hash, body.len() as u64, &mime, &claims.sub)
            {
                Ok(m) => (m.size, m.hash),
                Err(e) => {
                    return (StatusCode::INTERNAL_SERVER_ERROR, ApiError::body(e)).into_response()
                }
            }
        }
    } else {
        match state
            .blob_store()
            .save_blob_with_quota(&ws, &hash, &body, &mime, &claims.sub, quota)
        {
            Ok(m) => (m.size, m.hash),
            Err(e @ SaveBlobError::QuotaExceeded { .. }) => {
                return (StatusCode::INSUFFICIENT_STORAGE, ApiError::body(e.to_string()))
                    .into_response()
            }
            Err(e) => {
                return (StatusCode::INTERNAL_SERVER_ERROR, ApiError::body(e.to_string()))
                    .into_response()
            }
        }
    };

    // Record opaque provenance (source + tags), additive; advisory only.
    let mut tags = req.tags.clone();
    if let Some(s) = req.source.clone() {
        tags.push(s);
    }
    if let Err(e) = state.blob_store().record_provenance(&ws, &hash, &tags) {
        log::warn!("provenance record failed {}/{}: {e}", ws.as_str(), hash);
    }

    (
        StatusCode::OK,
        Json(json!({ "hash": hash, "size": size, "mimeType": mime })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blob_hash_validation_accepts_sha256_and_rejects_path_tricks() {
        // A real lowercase-hex SHA-256 digest passes.
        let good = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
        assert!(is_valid_blob_hash(good));

        // Anything that could escape the workspace key prefix is rejected.
        assert!(!is_valid_blob_hash("../../etc/passwd"));
        assert!(!is_valid_blob_hash("ab/cd/evil"));
        assert!(!is_valid_blob_hash(&"a".repeat(63))); // too short
        assert!(!is_valid_blob_hash(&"a".repeat(65))); // too long
        assert!(!is_valid_blob_hash(&"A".repeat(64))); // uppercase not allowed
        assert!(!is_valid_blob_hash(&"g".repeat(64))); // non-hex
        assert!(!is_valid_blob_hash("")); // empty
    }

    #[test]
    fn ingest_host_matching_exact_and_wildcard() {
        let allow = vec!["api.example.com".to_string(), "*.example.net".to_string()];
        // exact
        assert!(ingest_host_allowed("api.example.com", &allow));
        // wildcard matches subdomain + the bare suffix
        assert!(ingest_host_allowed("acme.example.net", &allow));
        assert!(ingest_host_allowed("example.net", &allow));
        assert!(ingest_host_allowed("API.Example.COM", &allow)); // case-insensitive
        // misses
        assert!(!ingest_host_allowed("evil.com", &allow));
        assert!(!ingest_host_allowed("example.net.evil.com", &allow)); // suffix trick
        assert!(!ingest_host_allowed("notexample.net", &allow)); // not a dot-boundary
        assert!(!ingest_host_allowed("", &allow));
        assert!(!ingest_host_allowed("api.example.com", &[])); // empty allowlist = nothing
    }

    #[test]
    fn ingest_blocks_private_and_loopback_ip_literals() {
        assert!(ingest_ip_blocked("127.0.0.1"));
        assert!(ingest_ip_blocked("10.0.0.5"));
        assert!(ingest_ip_blocked("192.168.1.1"));
        assert!(ingest_ip_blocked("169.254.1.1")); // link-local
        assert!(ingest_ip_blocked("0.0.0.0"));
        assert!(ingest_ip_blocked("[::1]")); // ipv6 loopback w/ brackets
        assert!(ingest_ip_blocked("fc00::1")); // ULA
        assert!(ingest_ip_blocked("fe80::1")); // link-local
        assert!(ingest_ip_blocked("[::ffff:127.0.0.1]")); // ipv4-mapped loopback
        // public literals are not blocked here (the allowlist is the gate)
        assert!(!ingest_ip_blocked("8.8.8.8"));
        assert!(!ingest_ip_blocked("example.com")); // not an IP literal
    }

    #[test]
    fn ingest_url_ok_enforces_https_allowlist_and_ip_block() {
        let allow = vec!["*.example.net".to_string(), "8.8.8.8".to_string()];
        let ok = reqwest::Url::parse("https://acme.example.net/x").unwrap();
        assert!(ingest_url_ok(&ok, &allow));
        // http rejected even if host allowed
        let http = reqwest::Url::parse("http://acme.example.net/x").unwrap();
        assert!(!ingest_url_ok(&http, &allow));
        // off-allowlist host
        let off = reqwest::Url::parse("https://evil.com/x").unwrap();
        assert!(!ingest_url_ok(&off, &allow));
        // a private IP literal is blocked even if it were somehow allowlisted
        let priv_allow = vec!["127.0.0.1".to_string()];
        let loop_url = reqwest::Url::parse("https://127.0.0.1/x").unwrap();
        assert!(!ingest_url_ok(&loop_url, &priv_allow));
    }
}
