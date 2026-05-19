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

use crate::auth::{
    create_token, hash_password, validate_token, Claims, User, UserInfo, UserRole,
};
use crate::server::documents::SaveOutcome;
use crate::server::protocol::ShareEntry;
use crate::server::permissions::{
    check_delete_permission, check_read_permission, check_write_permission, to_error_string,
};
use crate::server::protocol::DocEventType;
use crate::server::ServerState;

/// Build the REST router. Merged into the main Axum router in
/// `WebSocketServer::start` so /api/* shares the listener with /ws.
pub fn routes() -> Router<Arc<ServerState>> {
    Router::new()
        .route("/api/auth/register", post(register_handler))
        .route("/api/auth/login", post(login_handler))
        .route("/api/auth/me", get(me_handler))
        .route("/api/auth/password", post(change_password_handler))
        .route("/api/docs", get(list_docs_handler))
        .route("/api/docs/:id", get(get_doc_handler))
        .route("/api/docs/:id", put(save_doc_handler))
        .route("/api/docs/:id", delete(delete_doc_handler))
        .route("/api/docs/:id/share", post(share_doc_handler))
        .route("/api/docs/:id/transfer", post(transfer_doc_handler))
}

// ============ Request / Response shapes ============

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegisterRequest {
    username: String,
    password: String,
    display_name: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RegisterResponse {
    user: UserInfo,
}

#[derive(Debug, Deserialize)]
struct LoginRequest {
    username: String,
    password: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChangePasswordRequest {
    current_password: String,
    new_password: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LoginResponse {
    token: String,
    /// Unix-ms when the token expires.
    expires_at: u64,
    user: UserInfo,
}

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

// ============ Auth handlers ============

async fn register_handler(
    State(state): State<Arc<ServerState>>,
    Json(body): Json<RegisterRequest>,
) -> impl IntoResponse {
    let users = match state.user_store() {
        Some(s) => s.clone(),
        None => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                ApiError::body("user storage not configured"),
            )
                .into_response();
        }
    };

    if body.username.trim().is_empty() || body.password.len() < 8 {
        return (
            StatusCode::BAD_REQUEST,
            ApiError::body("username required; password must be at least 8 characters"),
        )
            .into_response();
    }

    if users.get_user_by_username(&body.username).is_some() {
        return (
            StatusCode::CONFLICT,
            ApiError::body("username already exists"),
        )
            .into_response();
    }

    let password_hash = match hash_password(&body.password) {
        Ok(h) => h,
        Err(e) => {
            log::error!("hash_password failed: {}", e);
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiError::body("failed to hash password"),
            )
                .into_response();
        }
    };

    let display_name = body
        .display_name
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| body.username.clone());

    let role = if users.has_users() {
        UserRole::User
    } else {
        // First-ever registered user gets admin so a fresh deploy is bootstrappable.
        UserRole::Admin
    };

    let user = User {
        id: nanoid::nanoid!(),
        display_name,
        username: body.username,
        password_hash,
        role,
        created_at: now_ms(),
        last_login_at: None,
        org_id: Some("default".to_string()),
    };

    if let Err(e) = users.add_user(user.clone()) {
        log::warn!("add_user failed: {}", e);
        return (StatusCode::INTERNAL_SERVER_ERROR, ApiError::body(e)).into_response();
    }

    (
        StatusCode::CREATED,
        Json(RegisterResponse {
            user: to_user_info(&user),
        }),
    )
        .into_response()
}

async fn login_handler(
    State(state): State<Arc<ServerState>>,
    Json(body): Json<LoginRequest>,
) -> impl IntoResponse {
    let users = match state.user_store() {
        Some(s) => s.clone(),
        None => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                ApiError::body("user storage not configured"),
            )
                .into_response();
        }
    };

    let user = match users.get_user_by_username(&body.username) {
        Some(u) => u,
        None => {
            return (
                StatusCode::UNAUTHORIZED,
                ApiError::body("invalid username or password"),
            )
                .into_response();
        }
    };

    let valid = crate::auth::verify_password(&body.password, &user.password_hash)
        .unwrap_or(false);
    if !valid {
        return (
            StatusCode::UNAUTHORIZED,
            ApiError::body("invalid username or password"),
        )
            .into_response();
    }

    // Update last-login best-effort; failure shouldn't block the login.
    if let Err(e) = users.update_last_login(&user.id) {
        log::warn!("update_last_login failed: {}", e);
    }

    let (token, expires_at) = match create_token(
        &user.id,
        &user.username,
        &user.role.to_string(),
        state.token_config(),
    ) {
        Ok(t) => t,
        Err(e) => {
            log::error!("create_token failed: {}", e);
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiError::body("failed to issue token"),
            )
                .into_response();
        }
    };

    (
        StatusCode::OK,
        Json(LoginResponse {
            token,
            expires_at,
            user: to_user_info(&user),
        }),
    )
        .into_response()
}

async fn me_handler(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let claims = match require_auth(&state, &headers) {
        Ok(c) => c,
        Err(resp) => return resp,
    };

    let users = match state.user_store() {
        Some(s) => s.clone(),
        None => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                ApiError::body("user storage not configured"),
            )
                .into_response()
        }
    };

    match users.get_user(&claims.sub) {
        Some(u) => (StatusCode::OK, Json(json!({ "user": to_user_info(&u) }))).into_response(),
        None => (
            StatusCode::NOT_FOUND,
            ApiError::body("user no longer exists"),
        )
            .into_response(),
    }
}

async fn change_password_handler(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Json(body): Json<ChangePasswordRequest>,
) -> impl IntoResponse {
    let claims = match require_auth(&state, &headers) {
        Ok(c) => c,
        Err(resp) => return resp,
    };

    let users = match state.user_store() {
        Some(s) => s.clone(),
        None => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                ApiError::body("user storage not configured"),
            )
                .into_response();
        }
    };

    let user = match users.get_user(&claims.sub) {
        Some(u) => u,
        None => {
            return (
                StatusCode::NOT_FOUND,
                ApiError::body("user no longer exists"),
            )
                .into_response();
        }
    };

    let current_ok = crate::auth::verify_password(&body.current_password, &user.password_hash)
        .unwrap_or(false);
    if !current_ok {
        return (
            StatusCode::UNAUTHORIZED,
            ApiError::body("invalid current password"),
        )
            .into_response();
    }

    if body.new_password.len() < 8 {
        return (
            StatusCode::BAD_REQUEST,
            ApiError::body("new password must be at least 8 characters"),
        )
            .into_response();
    }

    let new_hash = match hash_password(&body.new_password) {
        Ok(h) => h,
        Err(e) => {
            log::error!("hash_password failed: {}", e);
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiError::body("failed to hash password"),
            )
                .into_response();
        }
    };

    if let Err(e) = users.update_user_password(&user.id, new_hash) {
        log::warn!("update_user_password failed: {}", e);
        return (StatusCode::INTERNAL_SERVER_ERROR, ApiError::body(e)).into_response();
    }

    (StatusCode::OK, Json(WriteAck { success: true })).into_response()
}

// ============ Document CRUD handlers ============

async fn list_docs_handler(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let _claims = match require_auth(&state, &headers) {
        Ok(c) => c,
        Err(resp) => return resp,
    };
    let docs = state.doc_store().list_documents();
    (StatusCode::OK, Json(json!({ "documents": docs }))).into_response()
}

async fn get_doc_handler(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let claims = match require_auth(&state, &headers) {
        Ok(c) => c,
        Err(resp) => return resp,
    };

    if let Err(e) = check_read_permission(
        state.doc_store(),
        &id,
        Some(&claims.sub),
        Some(&claims.role),
    ) {
        return (StatusCode::FORBIDDEN, ApiError::body(to_error_string(&e))).into_response();
    }

    match state.doc_store().get_document(&id) {
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
    let claims = match require_auth(&state, &headers) {
        Ok(c) => c,
        Err(resp) => return resp,
    };

    // The doc body's `id` must match the path id — REST clients can't
    // forge a different doc id via the body.
    let body_id = document.get("id").and_then(|v| v.as_str()).unwrap_or("");
    if body_id != id {
        return (
            StatusCode::BAD_REQUEST,
            ApiError::body("document.id does not match path id"),
        )
            .into_response();
    }

    let doc_exists = state.doc_store().get_metadata(&id).is_some();

    if doc_exists {
        if let Err(e) = check_write_permission(
            state.doc_store(),
            &id,
            Some(&claims.sub),
            Some(&claims.role),
        ) {
            return (StatusCode::FORBIDDEN, ApiError::body(to_error_string(&e))).into_response();
        }
    }

    let outcome = match state
        .doc_store()
        .save_document_with_expected_version(document, query.expected_version)
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
            state.emit_doc_event(&id, event_type, Some(claims.sub.clone()));
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
    let claims = match require_auth(&state, &headers) {
        Ok(c) => c,
        Err(resp) => return resp,
    };

    if let Err(e) = check_delete_permission(
        state.doc_store(),
        &id,
        Some(&claims.sub),
        Some(&claims.role),
    ) {
        return (StatusCode::FORBIDDEN, ApiError::body(to_error_string(&e))).into_response();
    }

    match state.doc_store().delete_document(&id) {
        Ok(true) => {
            state.emit_doc_event(&id, DocEventType::Deleted, Some(claims.sub.clone()));
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
    let claims = match require_auth(&state, &headers) {
        Ok(c) => c,
        Err(resp) => return resp,
    };

    // Owner-only — matches WS handler at server::mod::handle_doc_share.
    if let Err(e) = check_delete_permission(
        state.doc_store(),
        &id,
        Some(&claims.sub),
        Some(&claims.role),
    ) {
        return (StatusCode::FORBIDDEN, ApiError::body(to_error_string(&e))).into_response();
    }

    if let Err(e) = state.doc_store().update_document_shares(&id, &body.shares) {
        return (StatusCode::INTERNAL_SERVER_ERROR, ApiError::body(e)).into_response();
    }

    state.emit_doc_event(&id, DocEventType::Updated, Some(claims.sub.clone()));

    (StatusCode::OK, Json(WriteAck { success: true })).into_response()
}

async fn transfer_doc_handler(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<TransferRequest>,
) -> impl IntoResponse {
    let claims = match require_auth(&state, &headers) {
        Ok(c) => c,
        Err(resp) => return resp,
    };

    if let Err(e) = check_delete_permission(
        state.doc_store(),
        &id,
        Some(&claims.sub),
        Some(&claims.role),
    ) {
        return (
            StatusCode::FORBIDDEN,
            ApiError::body(format!("Only owner can transfer: {}", to_error_string(&e))),
        )
            .into_response();
    }

    if let Err(e) = state.doc_store().transfer_ownership(
        &id,
        &body.new_owner_id,
        &body.new_owner_name,
        &claims.sub,
    ) {
        return (StatusCode::INTERNAL_SERVER_ERROR, ApiError::body(e)).into_response();
    }

    state.emit_doc_event(&id, DocEventType::Updated, Some(claims.sub.clone()));

    (StatusCode::OK, Json(WriteAck { success: true })).into_response()
}

// ============ Helpers ============

/// Pull `Authorization: Bearer <jwt>` from request headers and validate
/// it against the server's TokenConfig. Returns a ready-to-build
/// `Response` on failure so handlers can `match`/`?` cleanly.
fn require_auth(
    state: &Arc<ServerState>,
    headers: &HeaderMap,
) -> Result<Claims, axum::response::Response> {
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

    validate_token(token, state.token_config()).map_err(|e| {
        (
            StatusCode::UNAUTHORIZED,
            ApiError::body(format!("invalid token: {}", e)),
        )
            .into_response()
    })
}

fn to_user_info(u: &User) -> UserInfo {
    UserInfo::from(u)
}

fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
