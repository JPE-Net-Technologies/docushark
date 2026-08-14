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
    routing::{get, post, put},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::auth::{OidcClaims, WorkspaceRole};
use crate::server::documents::{
    sanitize_collection_defs, CollectionDef, DocSaveGate, SaveOutcome, SetCollectionsOutcome,
};
use crate::server::style_profiles::{
    sanitize_style_profiles, SetStyleProfilesOutcome, StyleProfileDef,
};
use crate::server::protocol::ShareEntry;
use crate::server::permissions::{
    check_delete_permission, check_read_permission, check_write_permission, to_error_string,
    PermissionError, Principal,
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

/// **Derive** a document's referenced blob hashes by scanning its *content*
/// (JP-278), independent of the top-level `blobReferences` array — which the
/// relay's collab snapshot flatten never writes. Collects a `FileShape`'s raw
/// hash under a `blobRef` key (across every page's shapes) plus any
/// `blob://<hash>` embedded in a rich-text page's HTML `content`. Recursive over
/// the whole body so it's robust to shape nesting. Returns a sorted,
/// deduplicated list (deterministic JSON output). Derives purely from live
/// content, so a stale `blobReferences` array never pollutes the result and a
/// removed file-shape correctly drops its reference.
///
/// The client twin is `deriveBlobReferences` (`src/storage/AssetBundler.ts`).
/// **Do not assert that parity in prose** — this comment used to claim the two
/// mirrored each other while the client had no string scan at all, so it missed
/// every prose blob and the GC swept them (JP-494). Both sides are now pinned
/// to `relay/tests/blob-ref-fixtures/cases.json`; add a case there when
/// changing either walker.
pub(crate) fn collect_blob_references(doc: &Value) -> Vec<String> {
    let mut out = std::collections::BTreeSet::new();
    collect_blob_refs_walk(doc, None, &mut out);
    out.into_iter().collect()
}

fn collect_blob_refs_walk(
    v: &Value,
    parent_key: Option<&str>,
    out: &mut std::collections::BTreeSet<String>,
) {
    match v {
        Value::String(s) => {
            // FileShape stores its blob as a raw hash under `blobRef`.
            if parent_key == Some("blobRef") && is_valid_blob_hash(s) {
                out.insert(s.clone());
            }
            // Rich-text images embed `blob://<hash>` in HTML (e.g. an <img src>);
            // a single content string may carry several.
            collect_blob_uris_in_str(s, out);
        }
        Value::Array(a) => {
            for item in a {
                collect_blob_refs_walk(item, parent_key, out);
            }
        }
        Value::Object(o) => {
            for (k, val) in o {
                collect_blob_refs_walk(val, Some(k), out);
            }
        }
        _ => {}
    }
}

/// Collect every well-formed `blob://<hash>` reference embedded in a string
/// (rich-text HTML carries them in `<img src>`; one string may hold several).
/// Shared with the MCP file tools (JP-430), which list a prose page's blobs
/// from the same grammar the refcount walk recognizes.
pub(crate) fn collect_blob_uris_in_str(s: &str, out: &mut std::collections::BTreeSet<String>) {
    for seg in s.split("blob://").skip(1) {
        let hash: String = seg.chars().take_while(|c| c.is_ascii_hexdigit()).take(64).collect();
        if is_valid_blob_hash(&hash) {
            out.insert(hash);
        }
    }
}

/// Blob references to keep when a REST save updates a doc's refcount (RB-2 /
/// JP-299): the **union** of the (possibly stale) top-level `blobReferences`
/// array and the refs derived from the live content (`collect_blob_references`).
///
/// `save_doc_handler` used only the array, but the relay's collab-snapshot
/// flatten never writes it (JP-278), so a REST save with an outdated array would
/// release blobs the content still uses — irreversible at `blob_gc_grace_secs =
/// 0` (the same data-loss class as JP-127). Taking the union never under-counts:
/// a blob referenced by *either* source is retained.
pub(crate) fn save_blob_refs(doc: &Value) -> HashSet<String> {
    let mut refs = blob_refs_from_doc(doc);
    refs.extend(collect_blob_references(doc));
    refs
}

/// Append `chunk` to `buf` unless that would exceed `max` bytes; returns `false`
/// when the cap would be exceeded so the caller can abort (RB-1 / JP-299). Keeps
/// peak buffer memory at ~`max` even when a source omits or lies about its
/// Content-Length.
fn append_capped(buf: &mut Vec<u8>, chunk: &[u8], max: usize) -> bool {
    if buf.len().saturating_add(chunk.len()) > max {
        return false;
    }
    buf.extend_from_slice(chunk);
    true
}

/// Whether `hash` is a well-formed SHA-256 hex digest (64 lowercase hex
/// chars). Beyond rejecting junk, this is a **security gate** for the presign
/// path: the hash becomes part of the R2 object key, so anything but `[0-9a-f]`
/// (e.g. `/` or `..`) could escape the workspace prefix. The bytes are never
/// re-hashed server-side under direct-to-R2, so the format check is the only
/// structural guard at mint time.
pub(crate) fn is_valid_blob_hash(hash: &str) -> bool {
    hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Fallback stored type for anything unrecognized or unsafe to render.
const DEFAULT_BLOB_MIME: &str = "application/octet-stream";

/// Types a browser will execute as script if it renders them at the top level.
/// Stored as `application/octet-stream` instead, so the recorded type can never
/// itself become the vector.
///
/// SVG is deliberately **not** here: it is a legitimate image the editor renders
/// through `<img>` (which cannot run its script), and rewriting it would break
/// icon rendering. Keeping it accurate at rest means a consumer that serves
/// blobs to a browser must still decide inline-vs-download for itself.
const SCRIPT_CAPABLE_MIMES: &[&str] = &[
    "text/html",
    "application/xhtml+xml",
    "application/xhtml",
    "text/xml",
    "application/xml",
    "application/xslt+xml",
    "text/javascript",
    "application/javascript",
    "application/x-javascript",
    "application/ecmascript",
    "text/ecmascript",
];

/// Is `s` a well-formed `type/subtype` made only of RFC 9110 token characters?
///
/// A recorded type is echoed back as a `Content-Type` header, so a value
/// carrying CR/LF (or any other non-token byte) must never reach storage —
/// that is response-splitting, not a cosmetic problem.
fn is_wellformed_mime(s: &str) -> bool {
    fn is_token(part: &str) -> bool {
        !part.is_empty()
            && part.bytes().all(|b| {
                b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b)
            })
    }
    let mut parts = s.split('/');
    match (parts.next(), parts.next(), parts.next()) {
        (Some(ty), Some(sub), None) => is_token(ty) && is_token(sub),
        _ => false,
    }
}

/// Normalize a client-supplied MIME type before it is persisted (JP-474).
///
/// The type is attacker-controlled at upload and is later echoed when the bytes
/// are served, so it is normalized once at the storage boundary rather than
/// trusted at each read:
///
/// - parameters are dropped and the type is lowercased, so one stored form
///   corresponds to one type;
/// - anything malformed — empty, missing a subtype, or carrying a byte outside
///   the RFC 9110 token set (CR/LF included) — becomes the default;
/// - script-capable types become the default, so a stored blob cannot claim to
///   be a document a browser would execute.
///
/// Defense-in-depth, not the whole defense: a consumer that serves these bytes
/// to a browser still owes `nosniff` and an explicit inline-vs-download choice,
/// since a *correctly* typed SVG is still script-capable when navigated to.
pub(crate) fn normalize_stored_mime(mime: &str) -> String {
    let base = mime
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();

    if !is_wellformed_mime(&base) || SCRIPT_CAPABLE_MIMES.contains(&base.as_str()) {
        return DEFAULT_BLOB_MIME.to_string();
    }
    base
}

/// JP-370 (C1): may this caller read the bytes of `hash`? When private-doc
/// enforcement is off, blob access stays workspace-scoped (legacy). When on, the
/// caller must be able to read at least one document in the workspace that
/// references the blob — otherwise a member denied a private doc could still
/// fetch its images/attachments by content hash (blob hashes are derivable and
/// shared workspace-wide). An orphan blob (no referencing doc) is readable only
/// by a workspace owner/admin, mirroring the unowned-doc rule.
fn caller_can_read_blob(
    state: &Arc<ServerState>,
    ws: &WorkspaceId,
    hash: &str,
    sub: &str,
    role: WorkspaceRole,
) -> bool {
    blob_read_allowed(
        state.blob_store(),
        state.doc_store(),
        state.enforce_private_docs(),
        ws,
        hash,
        &principal_for(sub, role),
    )
}

/// The parts-based core of [`caller_can_read_blob`], shared with the MCP file
/// tools (JP-430) which hold the stores but no `ServerState`.
pub(crate) fn blob_read_allowed(
    blob_store: &crate::server::blobs::BlobStore,
    doc_store: &crate::server::documents::DocumentStore,
    enforce_private_docs: bool,
    ws: &WorkspaceId,
    hash: &str,
    principal: &Principal,
) -> bool {
    if !enforce_private_docs {
        return true;
    }
    // The trusted loopback caller manages the whole workspace.
    if matches!(principal, Principal::Service) {
        return true;
    }
    let referencing = blob_store.docs_referencing(ws, hash);
    referencing.iter().any(|doc_id| {
        match DocId::from_http_path(doc_id.clone()) {
            Ok(doc_id) => doc_store
                .get_metadata(ws, &doc_id)
                .map(|m| {
                    crate::server::permissions::get_user_permission(
                        &m,
                        principal,
                        enforce_private_docs,
                    ) != crate::server::permissions::Permission::None
                })
                .unwrap_or(false),
            Err(_) => false,
        }
    })
}

/// Build the authorization principal for an authenticated REST caller.
///
/// Replaces the previous `role_str` stringification. Two different spellings of
/// `WorkspaceRole` used to reach the permissions layer — REST mapped `Member`
/// to `"user"` while the WebSocket handler debug-formatted it to `"member"` —
/// and a legacy `"admin"` branch was matched but never produced by anything.
/// Passing the enum through removes all three problems at the type level.
fn principal_for(user_id: &str, role: WorkspaceRole) -> Principal<'_> {
    Principal::User { user_id, workspace_role: role }
}

/// Principal for a REST caller, from validated claims.
fn principal(claims: &OidcClaims, role: WorkspaceRole) -> Principal<'_> {
    principal_for(&claims.sub, role)
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

/// HTTP body limit for the document routes (JP-443). Deliberately DECOUPLED
/// from the `max_doc_bytes` enforcement cap: config only carries the
/// *fallback* cap — a JWT claim can mint a larger per-workspace ceiling, and
/// a body limit derived from the smaller config number would opaquely 413
/// those requests before the size gate (which sees the token) could return
/// its precise, typed error. So: a generous fixed floor, raised further (with
/// 25% slack — the stored pretty-printed size is ≥ the compact wire body)
/// when the config cap itself is larger. Replaces Axum's silent 2 MiB
/// default on `PUT /api/docs/:id` (the doc-route sibling of JP-125).
fn doc_body_limit_bytes(max_doc_bytes: u64) -> usize {
    let cap = usize::try_from(max_doc_bytes).unwrap_or(usize::MAX);
    let cap_with_slack = cap.saturating_add(cap / 4);
    cap_with_slack.max(crate::config::DEFAULT_DOC_BODY_LIMIT_BYTES)
}

/// Build the REST router. Merged into the main Axum router in
/// `WebSocketServer::start` so /api/* shares the listener with /ws.
/// `max_doc_bytes` is the configured `[tenancy.limits].max_doc_bytes`
/// fallback, used only to size the doc-route body limit (see
/// [`doc_body_limit_bytes`]) — enforcement itself happens per-request in the
/// save gate with the claim-resolved value.
pub fn routes(max_doc_bytes: u64) -> Router<Arc<ServerState>> {
    let doc_body_limit = doc_body_limit_bytes(max_doc_bytes);
    Router::new()
        .route("/api/v1/internal/revoke", post(revoke_handler))
        .route(
            "/api/v1/internal/workspace/:ws/purge-member",
            post(purge_member_handler),
        )
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
        .route("/api/docs/:id/ydoc", get(get_doc_ydoc_handler))
        .route(
            "/api/docs/:id",
            get(get_doc_handler)
                .put(save_doc_handler)
                .delete(delete_doc_handler)
                .layer(axum::extract::DefaultBodyLimit::max(doc_body_limit)),
        )
        .route("/api/docs/:id/share", post(share_doc_handler))
        .route(
            "/api/docs/:id/publish",
            post(publish_doc_handler)
                .delete(unpublish_doc_handler)
                .get(publish_status_handler),
        )
        .route("/api/docs/:id/transfer", post(transfer_doc_handler))
        .route("/api/docs/:id/collection", put(set_doc_collection_handler))
        .route(
            "/api/collections",
            get(list_collections_handler).put(set_collections_handler),
        )
        .route(
            "/api/v1/style-profiles",
            get(list_style_profiles_handler).put(set_style_profiles_handler),
        )
        .route(
            "/api/collections/:id/documents",
            get(list_collection_docs_handler),
        )
        .route("/api/docs/:id/recovery", get(list_recovery_handler))
        .route(
            "/api/docs/:id/recovery/capture",
            post(capture_recovery_handler),
        )
        .route(
            "/api/docs/:id/recovery/:pointId",
            get(recovery_point_content_handler),
        )
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

/// 413 body for a document write over the per-document size ceiling
/// (JP-443). Typed like [`VersionConflictBody`] so clients can branch on
/// `errorCode` and show the actual numbers.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DocTooLargeBody {
    error_code: &'static str,
    size_bytes: u64,
    max_bytes: u64,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct SaveQuery {
    /// Caller's expected `serverVersion`. When present, the relay
    /// refuses the write (HTTP 409) if the stored version differs.
    expected_version: Option<u64>,
    /// JP-375: deliberate resurrection of a tombstoned (deleted) id. When
    /// `true`, the relay lifts the tombstone before saving — gated to the
    /// original owner or a workspace admin. The explicit human override of the
    /// fence that otherwise rejects a re-create with 410.
    #[serde(default)]
    override_tombstone: bool,
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

/// Body of `PUT /api/docs/:id/collection`. A document belongs to at most one
/// collection; `null` clears the assignment (Unassigned).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CollectionMembershipRequest {
    collection_id: Option<String>,
}

/// Response of `GET /api/collections`: the definition set plus the registry
/// version for the optimistic-concurrency handshake (JP-424). Pre-JP-424
/// clients ignore the extra field.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CollectionsResponse {
    collections: Vec<CollectionDef>,
    version: u64,
}

/// Body of `PUT /api/collections`. The editor owns the definition set and
/// replaces it wholesale. `expectedVersion` (JP-424) makes the write
/// conditional on the current registry version — absent, the write is the
/// legacy unconditional replace (pre-JP-424 clients).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetCollectionsRequest {
    collections: Vec<CollectionDef>,
    expected_version: Option<u64>,
}

/// 409 body for a conflicting `PUT /api/collections` (JP-424). Same
/// `errorCode`/`currentVersion` keys as the doc-save [`VersionConflictBody`]
/// so clients type it identically; `collections` carries the current set for
/// consumers that want to rebase without another GET.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CollectionsConflictBody {
    error_code: &'static str,
    current_version: u64,
    collections: Vec<CollectionDef>,
}

/// Response of `GET /api/v1/style-profiles`: the profile set plus the registry
/// version for the optimistic-concurrency handshake.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StyleProfilesResponse {
    profiles: Vec<StyleProfileDef>,
    version: u64,
}

/// Body of `PUT /api/v1/style-profiles`. The editor owns the set and replaces
/// it wholesale. `expectedVersion` makes the write conditional on the current
/// registry version; absent, it is an unconditional replace.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetStyleProfilesRequest {
    profiles: Vec<StyleProfileDef>,
    expected_version: Option<u64>,
}

/// 409 body for a conflicting `PUT /api/v1/style-profiles`. Same
/// `errorCode`/`currentVersion` keys as [`CollectionsConflictBody`] and the
/// doc-save [`VersionConflictBody`] so clients type all three identically.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StyleProfilesConflictBody {
    error_code: &'static str,
    current_version: u64,
    profiles: Vec<StyleProfileDef>,
}

/// Workspace-scoped usage + effective limits, consumed by the
/// `docushark-web` account portal (JP-82). `null` quota/limit means
/// unlimited. Serialized camelCase to match the rest of the relay's REST
/// JSON. Privacy: counts only — no doc ids, no content (JP-81).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UsageResponse {
    /// Combined storage: `doc_bytes + blob_bytes + config_bytes` (JP-443 —
    /// documents joined the meter; JP-301 — labeled configuration joined it.
    /// The field name/shape is unchanged for existing readers).
    storage_bytes: u64,
    /// Recorded document JSON bytes (the document share of `storage_bytes`).
    doc_bytes: u64,
    /// Blob bytes, full-size-per-grant (the blob share of `storage_bytes`).
    blob_bytes: u64,
    /// Labeled configuration — the style-profile registry (JP-301). Two orders
    /// of magnitude smaller than the other shares in practice; reported
    /// separately so it reads as its own category rather than document growth.
    config_bytes: u64,
    storage_quota: Option<u64>,
    /// Per-document serialized-size ceiling; `null` = no ceiling. Lets a
    /// client warn before a write is refused with 413.
    max_doc_bytes: Option<u64>,
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

/// Body for `POST /api/v1/internal/workspace/:ws/purge-member`.
#[derive(Deserialize)]
struct PurgeMemberRequest {
    user_id: String,
}

/// `POST /api/v1/internal/workspace/:ws/purge-member` — drop a single user's
/// share grants (`sharedWith`) from every document in the workspace. A generic
/// control-plane hook: the relay is handed a workspace id + user id and knows
/// nothing about *why* the grants are being dropped. Gated by the same shared
/// bearer as the revocation push (`revocation_push_bearer`), constant-time
/// compared. Idempotent — re-running for the same user is a no-op.
async fn purge_member_handler(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Path(ws): Path<String>,
    Json(body): Json<PurgeMemberRequest>,
) -> impl IntoResponse {
    let expected = match state.revocation_push_bearer() {
        Some(s) => s.to_string(),
        None => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                ApiError::body("internal control-plane transport disabled"),
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
        return (StatusCode::UNAUTHORIZED, ApiError::body("unauthorized")).into_response();
    }

    // Same path-traversal validation the OIDC workspace claim goes through —
    // a forged `"../etc"` is rejected here rather than reaching `doc_path`.
    let ws = match WorkspaceId::from_configured(&ws) {
        Some(w) => w,
        None => {
            return (StatusCode::BAD_REQUEST, ApiError::body("invalid workspace id"))
                .into_response();
        }
    };

    // Cold-pod safety: a recycled machine may hold an empty in-memory index —
    // repopulate from R2 first so the purge sees the workspace's documents.
    state.ensure_workspace_index_local(&ws).await;

    let purged = match state
        .doc_store()
        .purge_user_from_workspace_shares(&ws, &body.user_id)
    {
        Ok(ids) => ids,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, ApiError::body(e)).into_response(),
    };

    // Notify connected clients (e.g. a workspace owner with the doc or list
    // open) so the dropped grant disappears without a manual refresh. No JWT
    // subject on an internal call → actor `None`.
    for doc_id in &purged {
        state.emit_doc_event(&ws, doc_id, DocEventType::Updated, None);
    }

    log::info!(
        "purge-member: workspace {} purged user from {} document(s)",
        ws.as_str(),
        purged.len()
    );

    (StatusCode::OK, Json(json!({ "purged": purged.len() }))).into_response()
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
    let (ws, role, _limits) = match resolve_workspace(&state, &claims) {
        Ok(ws) => ws,
        Err(resp) => return resp,
    };
    // JP-200: on a cold machine, repopulate the workspace index from R2 first so
    // a listing isn't empty after a recycle (best-effort; never clobbers a
    // populated in-memory index).
    state.ensure_workspace_index_local(&ws).await;
    let mut docs = state.doc_store().list_documents(&ws);
    // JP-370/JP-457: the listing shows exactly the documents the caller can
    // then open. The resolver owns the enforcement flag, so this filter runs
    // unconditionally — when enforcement is off it simply grants every member
    // Editor and nothing is filtered. Deciding here whether to filter is what
    // previously let the listing advertise documents REST would refuse.
    let caller = principal(&claims, role);
    let enforce = state.enforce_private_docs();
    docs.retain(|m| {
        crate::server::permissions::get_user_permission(m, &caller, enforce)
            != crate::server::permissions::Permission::None
    });
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
    let split = state.workspace_storage_split(&ws);
    (
        StatusCode::OK,
        Json(UsageResponse {
            // JP-443: documents joined the meter; JP-301 added labeled
            // configuration. The headline number is the sum of every share, and
            // the shares ride alongside for display splits.
            storage_bytes: split.total(),
            doc_bytes: split.doc_bytes,
            blob_bytes: split.blob_bytes,
            config_bytes: split.config_bytes,
            storage_quota: effective.quota_bytes,
            max_doc_bytes: effective.max_doc_bytes,
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
    // JP-443: gate against the quota remaining after recorded document bytes,
    // so blobs + docs share the single storage meter.
    if let Some(quota) = state.blob_quota_remaining(&ws, limits) {
        let used = state.blob_store().get_workspace_size(&ws);
        if used.saturating_add(req.size) > quota {
            return (
                StatusCode::INSUFFICIENT_STORAGE,
                ApiError::body("storage quota exceeded"),
            )
                .into_response();
        }
    }

    // JP-474: normalize before signing — this value becomes the R2 object's
    // stored content-type, and the bytes never pass back through the relay.
    let mime = normalize_stored_mime(req.mime_type.as_deref().unwrap_or(""));
    let mint = s3.presign_put(&ws, &hash, &mime);
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
    // already-granted hash adds 0 (dedup) and skips the check. JP-443: quota =
    // remaining after recorded document bytes (single storage meter).
    if !state.blob_store().exists(&ws, &hash) {
        if let Some(quota) = state.blob_quota_remaining(&ws, limits) {
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

    // JP-474: normalize at the storage boundary, not at each read.
    let mime = normalize_stored_mime(req.mime_type.as_deref().unwrap_or(""));
    match state
        .blob_store()
        .record_finalized_blob(&ws, &hash, size, &mime, &claims.sub)
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
    let (ws, role, _limits) = match resolve_workspace(&state, &claims) {
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

    // JP-370 (C1): when private-doc enforcement is on, gate the read on the
    // caller being able to read at least one document that references this blob —
    // otherwise a member denied a private doc could still fetch its images /
    // attachments by content hash. Opaque 404 (same shape as the ACL miss above),
    // so it never reveals the blob exists for docs the caller can't see.
    if !caller_can_read_blob(&state, &ws, &hash, &claims.sub, role) {
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
        &principal(&claims, role),
        state.enforce_private_docs(),
    ) {
        return permission_error_response(&e);
    }

    match state.doc_store().get_document(&ws, &doc_id) {
        Ok(doc) => (StatusCode::OK, Json(doc)).into_response(),
        Err(e) => (StatusCode::NOT_FOUND, ApiError::body(e)).into_response(),
    }
}

/// `GET /api/docs/:id/ydoc` — the document's authoritative binary Y.Doc sidecar
/// (JP-108: a `DSKY`-framed lib0-v1 full-state update — every shared type incl.
/// prose, with CRDT identity) as `application/octet-stream`. Read-scoped exactly
/// like `GET /api/docs/:id`.
///
/// JP-335: lets a client prefetch the relay's exact CRDT state so a downloaded
/// doc can be opened + edited offline and dedupe trivially on reconnect (the
/// bytes ARE the relay's own state, so a later re-hydrate merges without
/// doubling). Prefers a live handle's freshest encode, else the last persisted
/// sidecar; 404 when binary persistence is off or no sidecar exists yet — the
/// client then keeps its JSON-body read-only view, no regression.
async fn get_doc_ydoc_handler(
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
        Ok(v) => v,
        Err(resp) => return resp,
    };

    // JP-200: restore from R2 by id on a local miss before the permission check,
    // mirroring `get_doc_handler`.
    state.ensure_doc_local(&ws, &doc_id).await;

    if let Err(e) = check_read_permission(
        state.doc_store(),
        &ws,
        &doc_id,
        &principal(&claims, role),
        state.enforce_private_docs(),
    ) {
        return permission_error_response(&e);
    }

    // The `binary_persistence` gate is load-bearing, not incidental. The dedup
    // guarantee (client prefetches these bytes, edits offline, reconnects, and
    // the two states MERGE instead of doubling) holds ONLY if the identity we
    // serve now is the identity the relay reproduces on that reconnect. Both
    // sources below satisfy that: a persisted sidecar is re-hydrated verbatim,
    // and a live handle's lineage is flushed to a sidecar on evict. With
    // persistence OFF there is no such continuity — a cold reconnect re-hydrates
    // from JSON with FRESH clientIDs, so any bytes we served would double. So
    // never hydrate-from-JSON here to "fill the gap": 404 and let the client keep
    // its read-only JSON view (no regression) instead of handing out a lineage
    // the relay will not reproduce.
    if !state.binary_persistence() {
        return (
            StatusCode::NOT_FOUND,
            ApiError::body("binary sidecar not available"),
        )
            .into_response();
    }

    // Prefer a live handle's freshest full-state encode (captures edits not yet
    // flushed to disk; its lineage is persisted on evict, so identity carries
    // across the client's offline window); fall back to the last persisted
    // sidecar. Either is a valid lib0-v1 full-state update the client can
    // `Y.applyUpdate`.
    let bytes = if let Some(handle) = state.sync_registry().get(&ws, &doc_id) {
        let version = state
            .doc_store()
            .get_metadata(&ws, &doc_id)
            .and_then(|m| m.server_version)
            .unwrap_or(0);
        Some(handle.encode_binary(version))
    } else {
        state.doc_store().load_ydoc_binary(&ws, &doc_id)
    };

    match bytes {
        Some(bytes) => (
            StatusCode::OK,
            [(
                axum::http::header::CONTENT_TYPE,
                "application/octet-stream",
            )],
            bytes,
        )
            .into_response(),
        None => (
            StatusCode::NOT_FOUND,
            ApiError::body("binary sidecar not found"),
        )
            .into_response(),
    }
}

/// Validate a recovery point id (`<createdAtMs>-v<serverVersion>`) before it
/// indexes a file path — both halves must be numeric, which rejects any `/` or
/// `..` traversal (JP-183).
fn is_valid_recovery_point_id(id: &str) -> bool {
    match id.split_once("-v") {
        Some((ts, ver)) => ts.parse::<u64>().is_ok() && ver.parse::<u64>().is_ok(),
        None => false,
    }
}

/// Decode a recovery point and flatten its CRDT state over the document's
/// current JSON body, yielding `(restored_json, handle)` (JP-183). The handle
/// retains the decoded `Y.Doc` so the restore path can re-encode it as the new
/// doc's binary sidecar. Shared by the non-destructive content GET and the
/// restore POST; `Err` is a ready-to-return error response.
fn reconstruct_recovery_point(
    state: &Arc<ServerState>,
    ws: &WorkspaceId,
    doc_id: &DocId,
    point_id: &str,
) -> Result<(Value, crate::sync::DocHandle), axum::response::Response> {
    if !is_valid_recovery_point_id(point_id) {
        return Err((StatusCode::BAD_REQUEST, ApiError::body("invalid recovery point id")).into_response());
    }
    let bytes = state
        .doc_store()
        .read_recovery_point(ws, doc_id, point_id)
        .ok_or_else(|| {
            (StatusCode::NOT_FOUND, ApiError::body("recovery point not found")).into_response()
        })?;
    // Scaffold from the current body so non-CRDT metadata + page structure are
    // preserved; the recovery point only carries the CRDT shared types.
    let mut json = state.doc_store().get_document(ws, doc_id).map_err(|_| {
        (StatusCode::NOT_FOUND, ApiError::body("document not found")).into_response()
    })?;
    let page_id = json.get("activePageId").and_then(Value::as_str).map(str::to_string);
    let handle = crate::sync::DocHandle::from_sidecar_bytes(&bytes, page_id).map_err(|e| {
        (
            StatusCode::UNPROCESSABLE_ENTITY,
            ApiError::body(format!("recovery point is corrupt: {e}")),
        )
            .into_response()
    })?;
    if !handle.flatten_into(&mut json) {
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            ApiError::body("recovery point is incompatible with the current document structure"),
        )
            .into_response());
    }
    Ok((json, handle))
}

/// `POST /api/docs/:id/recovery/capture` — capture a recovery point NOW
/// (JP-428). Backs the Version History panel's open-time refresh, so the
/// timeline leads with current state instead of the last periodic tick.
/// Write-scoped like `PUT /api/docs/:id`. A resident dirty doc is flushed
/// first so the sidecar is current; byte-identical state dedupes to a no-op
/// (`captured: false`).
async fn capture_recovery_handler(
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
        Ok(v) => v,
        Err(resp) => return resp,
    };
    if state.doc_store().get_metadata(&ws, &doc_id).is_none() {
        return (StatusCode::NOT_FOUND, ApiError::body("document not found")).into_response();
    }
    if let Err(e) = check_write_permission(
        state.doc_store(),
        &ws,
        &doc_id,
        &principal(&claims, role),
        state.enforce_private_docs(),
    ) {
        return permission_error_response(&e);
    }
    // Flush a resident doc's live state into the sidecar before copying it —
    // otherwise the point captures the last persisted tick, not "now". The
    // flush itself may capture (the periodic gate fires inside snapshot_doc),
    // so `captured` is measured as "did a new point appear", not which
    // mechanism wrote it.
    let before = state
        .doc_store()
        .newest_recovery_point(&ws, &doc_id)
        .map(|p| p.id);
    if let Some(handle) = state.sync_registry().get(&ws, &doc_id) {
        state.snapshot_doc(&ws, &doc_id, &handle);
    }
    state.capture_version_point(&ws, &doc_id, "on-demand");
    let captured = state
        .doc_store()
        .newest_recovery_point(&ws, &doc_id)
        .map(|p| p.id)
        != before;
    (StatusCode::OK, Json(serde_json::json!({ "captured": captured }))).into_response()
}

/// `GET /api/docs/:id/recovery/:pointId` — a recovery point's content as a
/// document JSON (JP-183), **without mutating live state**. Read-scoped exactly
/// like `GET /api/docs/:id`. Backs the editor's "download to local".
async fn recovery_point_content_handler(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Path((id, point_id)): Path<(String, String)>,
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
        Ok(v) => v,
        Err(resp) => return resp,
    };
    if let Err(e) = check_read_permission(
        state.doc_store(),
        &ws,
        &doc_id,
        &principal(&claims, role),
        state.enforce_private_docs(),
    ) {
        return permission_error_response(&e);
    }
    match reconstruct_recovery_point(&state, &ws, &doc_id, &point_id) {
        Ok((json, _handle)) => {
            // Field-test breadcrumb: which point a "save to local" actually
            // served, correlatable with the client's console log.
            log::info!(
                "recovery point read {}/{} point {}",
                ws.as_str(),
                doc_id.as_str(),
                point_id
            );
            (StatusCode::OK, Json(json)).into_response()
        }
        Err(resp) => resp,
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
        &principal(&claims, role),
        state.enforce_private_docs(),
    ) {
        return permission_error_response(&e);
    }
    let points = state.doc_store().list_recovery_points(&ws, &doc_id);
    (StatusCode::OK, Json(json!({ "recoveryPoints": points }))).into_response()
}

/// `POST /api/docs/:id/recovery/:pointId/restore` — restore a recovery point as
/// a **new document** (JP-183), then delete + tombstone the source id. A fresh
/// id sidesteps the stale-sidecar hydration hazard and gives connected clients a
/// clean break: the source's `Deleted` broadcast kicks them (they strand their
/// pre-restore copy to Trash via JP-375), and the new doc surfaces via `Created`.
/// Owner-gated, since it deletes the source. Returns `{ newDocId, serverVersion }`.
/// What `carry_publish_forward` moved: the new artifact/manifest object keys
/// (`None` on the filesystem backend, like `PublishAck`) and the carried
/// entry's byte count. Reported in the restore ack so clients can follow the
/// publication to the new id.
struct PublishCarryOutcome {
    artifact_key: Option<String>,
    manifest_key: Option<String>,
    bytes: u64,
}

/// A doc's frozen public artifact (or manifest) as last published: the local
/// `public/` file when present, the object store on a cold machine — the
/// registry mirror restores entries, never artifact bytes, so a recycled
/// machine has the entry but not the file.
async fn read_frozen_public_bytes(
    state: &ServerState,
    ws: &WorkspaceId,
    doc_id: &DocId,
    suffix: &str,
) -> Option<String> {
    let path = if suffix == "manifest.json" {
        state.doc_store().public_manifest_path(ws, doc_id)
    } else {
        state.doc_store().public_doc_path(ws, doc_id)
    };
    if let Ok(s) = std::fs::read_to_string(&path) {
        return Some(s);
    }
    let s3 = state.s3_backend()?;
    match s3.get_object_at(&s3.doc_public_key(ws, doc_id, suffix)).await {
        Ok(Some(bytes)) => String::from_utf8(bytes).ok(),
        Ok(None) => None,
        Err(e) => {
            log::warn!(
                "restore: fetch frozen {} for {}/{} failed: {}",
                suffix,
                ws.as_str(),
                doc_id.as_str(),
                e
            );
            None
        }
    }
}

/// JP-470: move a published document's FROZEN artifact from `old_id` to
/// `new_id` — byte-for-byte, entry unchanged — so a restore doesn't end the
/// publication. Upload order mirrors publish (object store first, registry
/// second: the registry never records an artifact readers can't fetch). The
/// registry mirror PUT is deliberately left to the retirement teardown that
/// immediately follows, which uploads it once with both the new entry and the
/// old removal. Returns `None` when the source wasn't published or any step
/// failed — teardown then simply ends the publication, and an explicit
/// republish under the new id starts a fresh one.
async fn carry_publish_forward(
    state: &ServerState,
    ws: &WorkspaceId,
    old_id: &DocId,
    new_id: &DocId,
) -> Option<PublishCarryOutcome> {
    state.ensure_workspace_published_local(ws).await;
    let entry = state.doc_store().published_entry(ws, old_id)?;

    let artifact = read_frozen_public_bytes(state, ws, old_id, "json").await;
    let manifest = read_frozen_public_bytes(state, ws, old_id, "manifest.json").await;
    let (Some(artifact), Some(manifest)) = (artifact, manifest) else {
        log::warn!(
            "restore: publish carry skipped for {}/{} — frozen artifact unreadable",
            ws.as_str(),
            old_id.as_str()
        );
        return None;
    };

    let (artifact_key, manifest_key) = match state.s3_backend() {
        Some(s3) => {
            let a_key = s3.doc_public_key(ws, new_id, "json");
            let m_key = s3.doc_public_key(ws, new_id, "manifest.json");
            for (key, body) in [(&a_key, &artifact), (&m_key, &manifest)] {
                if let Err(e) =
                    s3.put_object_at(key, body.clone().into_bytes(), "application/json").await
                {
                    log::warn!("restore: publish carry PUT failed for {}: {}", key, e);
                    return None;
                }
            }
            (Some(a_key), Some(m_key))
        }
        None => (None, None),
    };

    let bytes = entry.bytes;
    if let Err(e) = state.doc_store().set_published(ws, new_id, entry, &artifact, &manifest) {
        log::warn!(
            "restore: publish carry registry write failed for {}/{}: {}",
            ws.as_str(),
            new_id.as_str(),
            e
        );
        return None;
    }
    log::info!(
        "restore: publication carried {}/{} -> {}",
        ws.as_str(),
        old_id.as_str(),
        new_id.as_str()
    );
    Some(PublishCarryOutcome { artifact_key, manifest_key, bytes })
}

async fn restore_recovery_handler(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Path((id, point_id)): Path<(String, String)>,
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
        Ok(v) => v,
        Err(resp) => return resp,
    };
    state.ensure_blob_bookkeeping(&ws).await;

    // Don't leak existence across tenants: 404 if the source isn't in this ws.
    if state.doc_store().get_metadata(&ws, &doc_id).is_none() {
        return (StatusCode::NOT_FOUND, ApiError::body("document not found")).into_response();
    }
    // Restore deletes the source doc → require delete-level (owner) permission.
    if let Err(e) = check_delete_permission(
        state.doc_store(),
        &ws,
        &doc_id,
        &principal(&claims, role),
        state.enforce_private_docs(),
    ) {
        return permission_error_response(&e);
    }

    // Reconstruct the restored content from the recovery point.
    let (mut json, handle) = match reconstruct_recovery_point(&state, &ws, &doc_id, &point_id) {
        Ok(v) => v,
        Err(resp) => return resp,
    };

    // Re-id into a fresh document (the source id is retired below).
    let new_id = format!("doc-{}", nanoid::nanoid!(12));
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    if let Some(obj) = json.as_object_mut() {
        let base = obj.get("name").and_then(Value::as_str).unwrap_or("Document").to_string();
        obj.insert("id".into(), json!(new_id));
        obj.insert("name".into(), json!(format!("{base} (Restored)")));
        obj.insert("createdAt".into(), json!(now));
        obj.insert("modifiedAt".into(), json!(now));
        obj.remove("serverVersion"); // the save assigns v1
        // JP-457: this creates a document, so it must leave one owned. The
        // recovery point carries the source's `ownerId` and that is kept —
        // restoring someone's document must not transfer it to whoever pressed
        // the button. Only a source that had no owner adopts the restorer,
        // which keeps the restored copy out of the legacy carve-out.
        if !obj.get("ownerId").is_some_and(Value::is_string) {
            obj.insert("ownerId".into(), json!(claims.sub));
        }
    }
    let new_doc_id = match DocId::from_body_id(new_id.clone()) {
        Ok(d) => d,
        Err(e) => {
            return (StatusCode::INTERNAL_SERVER_ERROR, ApiError::body(format!("mint id: {e}")))
                .into_response()
        }
    };

    // Blob refs the restored doc references — registered after the save and
    // before releasing the source's, so blobs shared by both stay alive.
    let new_refs = save_blob_refs(&json);

    // JP-443: restore replaces the source (deleted just below), so its net
    // storage growth is ~0 — the workspace quota is deliberately NOT applied
    // here (recovery must stay possible for an over-quota workspace). The
    // per-document size ceiling still holds: a restored point can't exceed
    // what a fresh write of the same bytes would be allowed.
    let gate = DocSaveGate {
        quota_bytes: None,
        blob_bytes: 0,
        max_doc_bytes: state.resolve_limits(limits).max_doc_bytes,
    };
    match state.doc_store().save_document_with_expected_version(&ws, json, None, Some(&gate)) {
        Ok(SaveOutcome::Created { .. }) | Ok(SaveOutcome::Updated { .. }) => {}
        Ok(SaveOutcome::DocTooLarge { size, max }) => {
            return (
                StatusCode::PAYLOAD_TOO_LARGE,
                Json(DocTooLargeBody {
                    error_code: "DOC_TOO_LARGE",
                    size_bytes: size,
                    max_bytes: max,
                }),
            )
                .into_response()
        }
        Ok(_) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiError::body("restore: unexpected save outcome"),
            )
                .into_response()
        }
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, ApiError::body(e)).into_response(),
    }

    // Seed the new doc's binary sidecar from the recovery Y.Doc (CRDT fidelity),
    // tagged at the new doc's version (1).
    let bytes = handle.encode_binary(1);
    if let Err(e) = state.doc_store().persist_ydoc_binary(&ws, &new_doc_id, &bytes) {
        log::warn!(
            "restore: persist new sidecar {}/{}: {}",
            ws.as_str(),
            new_doc_id.as_str(),
            e
        );
    }
    // Inherit the source's recovery ring before the source (and its ring) is deleted.
    state.doc_store().copy_recovery_ring(&ws, &doc_id, &new_doc_id);

    // Blob accounting: register the new doc's refs, then release the source's.
    if let Err(e) = state.blob_store().sync_doc_refs(&ws, new_doc_id.as_str(), new_refs) {
        log::warn!("restore: sync new-doc blob refs: {e}");
    }

    // JP-470: publish follows the document. If the source is published, carry
    // the FROZEN artifact to the new id before retirement tears the old one
    // down — never a re-projection: the recovery point can hold since-publish
    // edits the owner never exposed (the divergence the `stale` flag reports),
    // could newly exceed the artifact ceiling, and would leak the "(Restored)"
    // title onto the public page. Entry timestamps and bytes move unchanged,
    // so the meter is net-neutral and status correctly reads stale until an
    // explicit republish swaps the public content.
    let publish_carry = carry_publish_forward(&state, &ws, &doc_id, &new_doc_id).await;

    // Retire the source: delete + tombstone (the store records the tombstone),
    // then the shared post-delete seam — publish teardown for the OLD id,
    // Deleted broadcast (so connected clients strand their pre-restore copy to
    // Trash and leave, no merge-back), blob-ref release — then Created so the
    // new doc surfaces in browsers.
    let _ = state.doc_store().delete_document(&ws, &doc_id);
    state.after_doc_deleted(&ws, &doc_id, Some(claims.sub.clone())).await;
    state.emit_doc_event(&ws, &new_doc_id, DocEventType::Created, Some(claims.sub.clone()));

    log::info!(
        "recovery point restored {}/{} point {} -> new doc {}",
        ws.as_str(),
        doc_id.as_str(),
        point_id,
        new_id
    );
    let mut body = json!({
        "newDocId": new_id,
        "serverVersion": 1,
        "publishCarried": publish_carry.is_some(),
    });
    if let Some(carry) = publish_carry {
        body["publishArtifactKey"] = json!(carry.artifact_key);
        body["publishManifestKey"] = json!(carry.manifest_key);
        body["publishBytes"] = json!(carry.bytes);
    }
    (StatusCode::OK, Json(body)).into_response()
}

async fn save_doc_handler(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(query): Query<SaveQuery>,
    Json(mut document): Json<Value>,
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

    let existing = state.doc_store().get_metadata(&ws, &doc_id);
    let doc_exists = existing.is_some();

    if doc_exists {
        if let Err(e) = check_write_permission(
            state.doc_store(),
            &ws,
            &doc_id,
            &principal(&claims, role),
            state.enforce_private_docs(),
        ) {
            return permission_error_response(&e);
        }
    }

    // JP-457: ownership is assigned by the relay, never accepted from the body.
    //
    // `DocumentStore` derives `owner_id` from the document's `ownerId` field,
    // which meant ownership was whatever the client last claimed. Two
    // consequences, both test-proven: a caller holding only an `edit` share
    // could PUT `"ownerId": "<self>"` and seize the document (gaining share
    // management and delete), and a document created without the field had no
    // owner at all — unreadable by its own creator once enforcement is on.
    //
    // On create the owner is the authenticated caller. On update the stored
    // owner is re-asserted over whatever the body says. `POST /transfer` stays
    // the only route that changes ownership, and it re-checks Owner permission.
    match (doc_exists, existing.as_ref().and_then(|m| m.owner_id.as_deref())) {
        // Established owner — re-assert it, and the display name with it so the
        // pair can't drift.
        (_, Some(owner)) => {
            document["ownerId"] = json!(owner);
            match existing.as_ref().and_then(|m| m.owner_name.as_deref()) {
                Some(name) => document["ownerName"] = json!(name),
                None => {
                    document.as_object_mut().map(|o| o.remove("ownerName"));
                }
            }
        }
        // An existing document with no recorded owner — a legacy one, predating
        // ownership stamping. Deliberately left alone.
        //
        // An earlier revision adopted the writer here, on the theory that it
        // would drain the carve-out. Running it showed that to be wrong twice
        // over. It doesn't drain: a document open in a collaborative session
        // persists through the CRDT snapshot path, which never touches this
        // handler, so content saves while ownership stays absent. And where it
        // *did* fire it was harmful — silently transferring a legacy document
        // to whoever saved first, which revokes it from every other member who
        // could previously see it. Editing a document is not a claim of
        // ownership over it.
        //
        // Leaving these unowned preserves exactly the pre-enforcement status
        // quo. `relay_unowned_documents` reports the population; draining it is
        // a deliberate act (an operator backfill, or an explicit "claim"
        // affordance), never a side effect of typing.
        (true, None) => {}
        // A new document: the caller creating it is its owner.
        (false, None) => {
            document["ownerId"] = json!(claims.sub);
        }
    }

    // JP-375: a tombstoned id is normally refused with 410 (resurrection guard).
    // A returning offline editor's transfer / a stale PUT must not silently
    // re-create a deleted doc. The deliberate `overrideTombstone=true` lifts it —
    // but only for the original owner or a workspace admin, since the doc's live
    // metadata (and ACL) is gone, leaving the recorded tombstone owner as the
    // only thing to authorize against.
    if state.doc_store().is_deleted(&ws, &doc_id) {
        if !query.override_tombstone {
            return (
                StatusCode::GONE,
                ApiError::body(
                    "document was deleted; pass overrideTombstone=true to restore it",
                ),
            )
                .into_response();
        }
        // A workspace owner manages every document, including restoring a
        // deleted one. This previously read `role_str(role) == "admin"`, a
        // value nothing ever produced — so the branch was dead and only the
        // document's own owner could restore.
        let manages_workspace = role == WorkspaceRole::Owner;
        let is_owner = state
            .doc_store()
            .tombstone_owner(&ws, &doc_id)
            .map(|owner| owner == claims.sub)
            .unwrap_or(false);
        if !manages_workspace && !is_owner {
            return (
                StatusCode::FORBIDDEN,
                ApiError::body(
                    "only the document owner or a workspace admin can restore a deleted document",
                ),
            )
                .into_response();
        }
        state.doc_store().clear_tombstone(&ws, &doc_id);
    }

    // Storage gate (JP-81 / JP-443): document bytes count toward the single
    // storage meter, enforced delta-aware inside the save — a growing save
    // that lands over quota is refused with 507, while shrinking/equal-size
    // saves and deletes always pass (that's how a caller digs out). Existing
    // data stays readable (GET is unaffected). The per-document size ceiling
    // rides the same gate (413).
    let effective = state.resolve_limits(limits);
    let gate = DocSaveGate {
        quota_bytes: effective.quota_bytes,
        // Non-live-doc bytes on the meter: blobs + published projection
        // artifacts (a published snapshot is a second stored copy). The save
        // adds live doc bytes internally.
        blob_bytes: state
            .blob_store()
            .get_workspace_size(&ws)
            .saturating_add(state.doc_store().published_bytes_total(&ws, None)),
        max_doc_bytes: effective.max_doc_bytes,
    };

    // Capture the doc's referenced blob hashes before `document` is moved
    // into the store — used to update the blob refcount after a successful
    // save (JP-120). RB-2: union the (stale) `blobReferences` array with refs
    // derived from live content so a save can't release in-use blobs.
    let blob_refs = save_blob_refs(&document);

    let outcome = match state
        .doc_store()
        .save_document_with_expected_version(&ws, document, query.expected_version, Some(&gate))
    {
        Ok(o) => o,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, ApiError::body(e)).into_response(),
    };

    match outcome {
        // JP-443: keep the "storage quota exceeded" body verbatim — clients
        // key on the 507 status + this stable string.
        SaveOutcome::QuotaExceeded { used, quota, incoming } => {
            log::info!(
                "doc save refused for {}/{}: {} used + {} incoming > {} quota",
                ws.as_str(),
                doc_id.as_str(),
                used,
                incoming,
                quota
            );
            (
                StatusCode::INSUFFICIENT_STORAGE,
                ApiError::body("storage quota exceeded"),
            )
                .into_response()
        }
        SaveOutcome::DocTooLarge { size, max } => (
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(DocTooLargeBody {
                error_code: "DOC_TOO_LARGE",
                size_bytes: size,
                max_bytes: max,
            }),
        )
            .into_response(),
        // JP-375: the store also guards resurrection; the handler clears the
        // tombstone above when overriding, so this is a safety net (e.g. a race
        // re-tombstoned between the check and the save).
        SaveOutcome::Tombstoned => (
            StatusCode::GONE,
            ApiError::body("document was deleted; pass overrideTombstone=true to restore it"),
        )
            .into_response(),
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
        &principal(&claims, role),
        state.enforce_private_docs(),
    ) {
        return permission_error_response(&e);
    }

    match state.doc_store().delete_document(&ws, &doc_id) {
        Ok(true) => {
            // Broadcast Deleted + release blob refs (JP-120). Shared with the MCP
            // delete_document tool via ServerState::after_doc_deleted (JP-350).
            state.after_doc_deleted(&ws, &doc_id, Some(claims.sub.clone())).await;
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
        &principal(&claims, role),
        state.enforce_private_docs(),
    ) {
        return permission_error_response(&e);
    }

    if let Err(e) = state.doc_store().update_document_shares(&ws, &doc_id, &body.shares) {
        return (StatusCode::INTERNAL_SERVER_ERROR, ApiError::body(e)).into_response();
    }

    state.emit_doc_event(&ws, &doc_id, DocEventType::Updated, Some(claims.sub.clone()));

    (StatusCode::OK, Json(WriteAck { success: true })).into_response()
}

/// Response body for `POST /api/docs/:id/publish`. `artifact_key` /
/// `manifest_key` are the object-store keys the artifact landed at (`None` on
/// the filesystem backend, where the artifact lives under the workspace's
/// `public/` directory instead).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PublishAck {
    success: bool,
    artifact_key: Option<String>,
    manifest_key: Option<String>,
    bytes: u64,
    published_at: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UnpublishAck {
    success: bool,
    /// `false` = the doc wasn't published (the delete is idempotent).
    removed: bool,
}

/// Response body for `GET /api/docs/:id/publish` — the publish state a client
/// renders. `max_bytes` is the configured artifact ceiling (`None` = no
/// ceiling); reporting it here keeps the number single-homed in relay config
/// rather than duplicated into clients.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PublishStatusBody {
    published: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    published_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    bytes: Option<u64>,
    /// The source document has changed since publishing (`modified_at`
    /// comparison — collaborative flushes don't bump `serverVersion`, so a
    /// version count would miss them).
    stale: bool,
    max_bytes: Option<u64>,
}

/// `POST /api/docs/:id/publish` — write the document's **public projection**
/// (artifact + manifest) to storage. Owner-only, like share management.
///
/// The projection is `publish::project_public` — an allowlist; see that
/// module for why the raw body must never be the artifact. A resident live
/// doc is flushed first so the snapshot reflects "now", not the last
/// persistence tick. Object-store durability is awaited here (not queued):
/// publishing is rare and explicit, and success must mean the artifact is
/// really where downstream serving will look for it.
async fn publish_doc_handler(
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
    let (ws, role, limits) = match resolve_workspace(&state, &claims) {
        Ok(ws) => ws,
        Err(resp) => return resp,
    };

    state.ensure_doc_local(&ws, &doc_id).await;
    state.ensure_workspace_published_local(&ws).await;

    // Owner-only — publishing exposes content beyond the workspace, which is
    // a bigger grant than any share, so it takes the same gate as share
    // management and delete.
    if let Err(e) = check_delete_permission(
        state.doc_store(),
        &ws,
        &doc_id,
        &principal(&claims, role),
        state.enforce_private_docs(),
    ) {
        return permission_error_response(&e);
    }

    // Flush a resident doc's live CRDT state into the JSON body first —
    // otherwise the artifact freezes the last persisted tick, not what the
    // publisher is looking at.
    if let Some(handle) = state.sync_registry().get(&ws, &doc_id) {
        state.snapshot_doc(&ws, &doc_id, &handle);
    }

    let doc = match state.doc_store().get_document(&ws, &doc_id) {
        Ok(d) => d,
        Err(e) => return (StatusCode::NOT_FOUND, ApiError::body(e)).into_response(),
    };

    let projected = crate::server::publish::project_public(&doc);
    let artifact_json = match serde_json::to_string(&projected) {
        Ok(s) => s,
        Err(e) => {
            return (StatusCode::INTERNAL_SERVER_ERROR, ApiError::body(e.to_string()))
                .into_response()
        }
    };
    let artifact_bytes = artifact_json.len() as u64;

    // Artifact ceiling — checked before any byte is written, cap echoed in
    // the body so clients render the configured number instead of hardcoding
    // one. An already-published artifact is never invalidated by this: a
    // refused republish leaves the previous snapshot in place.
    if let Some(max) = state.publish_max_bytes() {
        if artifact_bytes > max {
            return (
                StatusCode::PAYLOAD_TOO_LARGE,
                Json(serde_json::json!({
                    "errorCode": "PUBLISH_TOO_LARGE",
                    "sizeBytes": artifact_bytes,
                    "maxBytes": max,
                })),
            )
                .into_response();
        }
    }

    // Storage meter: the artifact is a second stored copy of the document and
    // counts like any other bytes. Delta-aware against this doc's *previous*
    // artifact, so republishing a shrinking document always lands — same
    // dig-out principle as the save gate.
    if let Some(quota) = state.resolve_limits(limits).quota_bytes {
        let used = state
            .blob_store()
            .get_workspace_size(&ws)
            .saturating_add(state.doc_store().workspace_doc_bytes(&ws))
            .saturating_add(state.doc_store().published_bytes_total(&ws, Some(&doc_id)));
        if used.saturating_add(artifact_bytes) > quota {
            log::info!(
                "publish refused for {}/{}: {} used + {} artifact > {} quota",
                ws.as_str(),
                doc_id.as_str(),
                used,
                artifact_bytes,
                quota
            );
            return (
                StatusCode::INSUFFICIENT_STORAGE,
                ApiError::body("storage quota exceeded"),
            )
                .into_response();
        }
    }

    let source_modified_at = state
        .doc_store()
        .get_document_metadata(&ws, &doc_id)
        .map(|m| m.modified_at)
        .unwrap_or(0);
    let published_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    // Blob authorization map: hash → full object key, derived from the
    // *projection* (a blob only a dropped field referenced must not be
    // resolvable through the artifact). The writer supplies complete keys so
    // no consumer ever re-derives the layout.
    let hashes = crate::server::publish::projected_blob_hashes(&projected);
    let blob_keys: std::collections::BTreeMap<String, String> = hashes
        .into_iter()
        .map(|h| {
            let key = match state.s3_backend() {
                Some(s3) => s3.object_key(&ws, &h),
                None => crate::server::publish::sharded_blob_key(ws.as_str(), &h),
            };
            (h, key)
        })
        .collect();
    let manifest = crate::server::publish::build_public_manifest(
        &projected,
        &blob_keys,
        published_at,
        source_modified_at,
    );
    let manifest_json = match serde_json::to_string(&manifest) {
        Ok(s) => s,
        Err(e) => {
            return (StatusCode::INTERNAL_SERVER_ERROR, ApiError::body(e.to_string()))
                .into_response()
        }
    };

    // Object store first, local bookkeeping second: if the upload fails the
    // registry never records an artifact readers can't fetch, and a stray
    // uploaded object with no registry entry is unreachable (nothing serves
    // by key alone) — overwritten by the next successful publish.
    let (artifact_key, manifest_key) = match state.s3_backend() {
        Some(s3) => {
            let a_key = s3.doc_public_key(&ws, &doc_id, "json");
            let m_key = s3.doc_public_key(&ws, &doc_id, "manifest.json");
            if let Err(e) = s3
                .put_object_at(&a_key, artifact_json.clone().into_bytes(), "application/json")
                .await
            {
                log::warn!("publish artifact PUT failed for {}: {}", a_key, e);
                return (
                    StatusCode::BAD_GATEWAY,
                    ApiError::body("object store upload failed — nothing was published"),
                )
                    .into_response();
            }
            if let Err(e) = s3
                .put_object_at(&m_key, manifest_json.clone().into_bytes(), "application/json")
                .await
            {
                log::warn!("publish manifest PUT failed for {}: {}", m_key, e);
                return (
                    StatusCode::BAD_GATEWAY,
                    ApiError::body("object store upload failed — nothing was published"),
                )
                    .into_response();
            }
            (Some(a_key), Some(m_key))
        }
        None => (None, None),
    };

    let entry = crate::server::publish::PublishedEntry {
        published_at,
        bytes: artifact_bytes,
        source_modified_at,
    };
    if let Err(e) =
        state
            .doc_store()
            .set_published(&ws, &doc_id, entry, &artifact_json, &manifest_json)
    {
        return (StatusCode::INTERNAL_SERVER_ERROR, ApiError::body(e)).into_response();
    }

    // Mirror the registry itself (meter + status survive a cold machine).
    // Best-effort like the collections mirror: on failure the local file is
    // still authoritative and the next publish/unpublish re-uploads it.
    if let Some(s3) = state.s3_backend() {
        if let Some(bytes) = state.doc_store().read_workspace_published_bytes(&ws) {
            let key = s3.workspace_published_key(&ws);
            if let Err(e) = s3.put_object_at(&key, bytes, "application/json").await {
                log::warn!("published registry mirror PUT failed for {}: {}", key, e);
            }
        }
    }

    log::info!(
        "Published document projection: {}/{} ({} bytes)",
        ws.as_str(),
        doc_id.as_str(),
        artifact_bytes
    );

    (
        StatusCode::OK,
        Json(PublishAck {
            success: true,
            artifact_key,
            manifest_key,
            bytes: artifact_bytes,
            published_at,
        }),
    )
        .into_response()
}

/// `DELETE /api/docs/:id/publish` — remove the public projection. Owner-only,
/// idempotent (`removed: false` when nothing was published). The artifact's
/// bytes leave the storage meter with the registry entry.
async fn unpublish_doc_handler(
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

    if let Err(e) = check_delete_permission(
        state.doc_store(),
        &ws,
        &doc_id,
        &principal(&claims, role),
        state.enforce_private_docs(),
    ) {
        return permission_error_response(&e);
    }

    // The shared removal seam (JP-470): registry hydration, entry removal,
    // best-effort object deletes, and the registry mirror PUT all live in
    // `teardown_publish` — the same path document delete and restore
    // retirement take, so the four ways a publication ends cannot drift.
    let removed = match state.teardown_publish(&ws, &doc_id).await {
        Ok(r) => r,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, ApiError::body(e)).into_response(),
    };

    if removed.is_some() {
        log::info!("Unpublished document projection: {}/{}", ws.as_str(), doc_id.as_str());
    }

    (
        StatusCode::OK,
        Json(UnpublishAck { success: true, removed: removed.is_some() }),
    )
        .into_response()
}

/// `GET /api/docs/:id/publish` — publish state for a document. Read-scoped
/// like `GET /api/docs/:id`: any member who can open the doc can see whether
/// it is published; changing that state stays owner-only.
async fn publish_status_handler(
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

    state.ensure_doc_local(&ws, &doc_id).await;
    state.ensure_workspace_published_local(&ws).await;

    if let Err(e) = check_read_permission(
        state.doc_store(),
        &ws,
        &doc_id,
        &principal(&claims, role),
        state.enforce_private_docs(),
    ) {
        return permission_error_response(&e);
    }

    let entry = state.doc_store().published_entry(&ws, &doc_id);
    let stale = match &entry {
        Some(e) => state
            .doc_store()
            .get_document_metadata(&ws, &doc_id)
            .map(|m| m.modified_at > e.source_modified_at)
            .unwrap_or(false),
        None => false,
    };

    (
        StatusCode::OK,
        Json(PublishStatusBody {
            published: entry.is_some(),
            published_at: entry.as_ref().map(|e| e.published_at),
            bytes: entry.as_ref().map(|e| e.bytes),
            stale,
            max_bytes: state.publish_max_bytes(),
        }),
    )
        .into_response()
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
        &principal(&claims, role),
        state.enforce_private_docs(),
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

/// `PUT /api/docs/:id/collection` — set (or clear, with `collectionId: null`) a
/// document's collection membership. Write-scoped like a save; the membership
/// rides the document body's `collectionId` and surfaces in the metadata-only
/// listing. Mirrors `share_doc_handler` (a metadata-shaped mutation).
async fn set_doc_collection_handler(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<CollectionMembershipRequest>,
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

    // Restore the body from R2 on a cold miss before reading/mutating it.
    state.ensure_doc_local(&ws, &doc_id).await;

    if let Err(e) = check_write_permission(
        state.doc_store(),
        &ws,
        &doc_id,
        &principal(&claims, role),
        state.enforce_private_docs(),
    ) {
        return permission_error_response(&e);
    }

    if let Err(e) =
        state
            .doc_store()
            .update_document_collection(&ws, &doc_id, body.collection_id.as_deref())
    {
        return (StatusCode::INTERNAL_SERVER_ERROR, ApiError::body(e)).into_response();
    }

    state.emit_doc_event(&ws, &doc_id, DocEventType::Updated, Some(claims.sub.clone()));

    (StatusCode::OK, Json(WriteAck { success: true })).into_response()
}

/// `GET /api/collections/:id/documents` — the document-members of a collection
/// for the caller's workspace, as **metadata only** (id, name, owner,
/// modified-at, page count, sync version, `collectionId`). The relay never
/// returns document bodies, Y.Doc state, or blobs here — this is a browse/list
/// surface (consumed by the docushark-web collection view), not a content-read
/// side channel. Workspace-scoped from the JWT exactly like `/api/docs`, so a
/// caller only sees their own workspace; a foreign/unknown collection id simply
/// yields an empty list (no cross-tenant existence leak).
async fn list_collection_docs_handler(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Path(collection_id): Path<String>,
) -> impl IntoResponse {
    let claims = match require_auth(&state, &headers).await {
        Ok(c) => c,
        Err(resp) => return resp,
    };
    let (ws, role, _limits) = match resolve_workspace(&state, &claims) {
        Ok(ws) => ws,
        Err(resp) => return resp,
    };
    // Repopulate the workspace index from R2 on a cold machine first (best-effort).
    state.ensure_workspace_index_local(&ws).await;
    // JP-370: when private-doc enforcement is on, this browse listing is filtered
    // to documents the caller may read — the same owner/share rule as
    // GET /api/docs. Without it, the collection view leaked every private doc's
    // metadata (including its share list) to any workspace member.
    let enforce = state.enforce_private_docs();
    let caller = principal(&claims, role);
    let docs: Vec<_> = state
        .doc_store()
        .list_documents(&ws)
        .into_iter()
        .filter(|d| d.collection_id.as_deref() == Some(collection_id.as_str()))
        .filter(|d| {
            crate::server::permissions::get_user_permission(d, &caller, enforce)
                != crate::server::permissions::Permission::None
        })
        .collect();
    (StatusCode::OK, Json(json!({ "documents": docs }))).into_response()
}

/// `GET /api/collections` — the caller's workspace's collection **definitions**
/// (id/name/colour/order), sorted by order. Workspace-scoped from the JWT.
async fn list_collections_handler(
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
    state.ensure_workspace_collections_local(&ws).await;
    let (collections, version) = state.doc_store().collections_snapshot(&ws);
    (StatusCode::OK, Json(CollectionsResponse { collections, version })).into_response()
}

/// `PUT /api/collections` — replace the workspace's collection definitions
/// wholesale (the editor owns the set). Definitions are presentation metadata,
/// not membership, so a member-level session may update them; cross-workspace is
/// already impossible (the set is keyed by the JWT's workspace). JP-424: the
/// write is validated (`sanitize_collection_defs` → 400) and, when the body
/// carries `expectedVersion`, conditional on the registry version (→ 409 with
/// the current state on mismatch). The registry is hydrated from R2 first so a
/// cold machine neither spuriously conflicts against version 0 nor blind-writes
/// over a mirrored set it never loaded.
async fn set_collections_handler(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Json(body): Json<SetCollectionsRequest>,
) -> impl IntoResponse {
    let claims = match require_auth(&state, &headers).await {
        Ok(c) => c,
        Err(resp) => return resp,
    };
    let (ws, _role, _limits) = match resolve_workspace(&state, &claims) {
        Ok(ws) => ws,
        Err(resp) => return resp,
    };
    state.ensure_workspace_collections_local(&ws).await;
    let defs = match sanitize_collection_defs(body.collections) {
        Ok(defs) => defs,
        Err(e) => return (StatusCode::BAD_REQUEST, ApiError::body(e)).into_response(),
    };
    match state.doc_store().set_collections(&ws, defs, body.expected_version) {
        Ok(SetCollectionsOutcome::Updated { version }) => (
            StatusCode::OK,
            Json(SaveAck { success: true, new_version: version }),
        )
            .into_response(),
        Ok(SetCollectionsOutcome::VersionConflict { current_version, current }) => (
            StatusCode::CONFLICT,
            Json(CollectionsConflictBody {
                error_code: "VERSION_CONFLICT",
                current_version,
                collections: current,
            }),
        )
            .into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, ApiError::body(e)).into_response(),
    }
}

/// `GET /api/v1/style-profiles` — the caller's workspace's saved style
/// profiles plus the registry version. Workspace-scoped from the JWT.
async fn list_style_profiles_handler(
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
    state.ensure_workspace_style_profiles_local(&ws).await;
    let (profiles, version) = state.doc_store().style_profiles_snapshot(&ws);
    (StatusCode::OK, Json(StyleProfilesResponse { profiles, version })).into_response()
}

/// `PUT /api/v1/style-profiles` — replace the workspace's style profiles
/// wholesale (the editor owns the set). Same shape as the collections registry:
/// validated (`sanitize_style_profiles` → 400) and, when the body carries
/// `expectedVersion`, conditional on the registry version (→ 409 with the
/// current state on mismatch). Hydrated from R2 first so a cold machine neither
/// spuriously conflicts against version 0 nor blind-writes over a mirrored set
/// it never loaded.
///
/// The one addition over collections is the **quota gate**: the registry is
/// metered storage, so a write that would push the workspace past its quota is
/// refused with 507 before anything is persisted. The projected size is
/// measured from exactly what would be written, and the workspace's *current*
/// registry bytes are excluded from the comparison base — otherwise shrinking
/// an over-quota registry would be refused for being over quota.
async fn set_style_profiles_handler(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Json(body): Json<SetStyleProfilesRequest>,
) -> impl IntoResponse {
    let claims = match require_auth(&state, &headers).await {
        Ok(c) => c,
        Err(resp) => return resp,
    };
    let (ws, _role, limits) = match resolve_workspace(&state, &claims) {
        Ok(ws) => ws,
        Err(resp) => return resp,
    };
    state.ensure_workspace_style_profiles_local(&ws).await;
    let profiles = match sanitize_style_profiles(body.profiles) {
        Ok(profiles) => profiles,
        Err(e) => return (StatusCode::BAD_REQUEST, ApiError::body(e)).into_response(),
    };

    let effective = state.resolve_limits(limits);
    let projected = state
        .doc_store()
        .projected_style_profiles_bytes(&ws, &profiles);
    if let Some(max_config) = state.max_config_bytes() {
        if projected > max_config {
            return (
                StatusCode::INSUFFICIENT_STORAGE,
                ApiError::body(format!(
                    "style profile registry exceeds the {} byte ceiling",
                    max_config
                )),
            )
                .into_response();
        }
    }
    if let Some(quota) = effective.quota_bytes {
        let split = state.workspace_storage_split(&ws);
        // Compare against the workspace without its *current* registry, so a
        // shrinking write is never refused by the bytes it is about to release.
        let other = split.total().saturating_sub(split.config_bytes);
        if other.saturating_add(projected) > quota {
            return (
                StatusCode::INSUFFICIENT_STORAGE,
                ApiError::body("workspace storage quota exceeded".to_string()),
            )
                .into_response();
        }
    }

    match state
        .doc_store()
        .set_style_profiles(&ws, profiles, body.expected_version)
    {
        Ok(SetStyleProfilesOutcome::Updated { version }) => (
            StatusCode::OK,
            Json(SaveAck { success: true, new_version: version }),
        )
            .into_response(),
        Ok(SetStyleProfilesOutcome::VersionConflict { current_version, current }) => (
            StatusCode::CONFLICT,
            Json(StyleProfilesConflictBody {
                error_code: "VERSION_CONFLICT",
                current_version,
                profiles: current,
            }),
        )
            .into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, ApiError::body(e)).into_response(),
    }
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
pub(crate) fn ingest_url_ok(url: &reqwest::Url, allow: &[String]) -> bool {
    if url.scheme() != "https" {
        return false;
    }
    match url.host_str() {
        Some(host) => !ingest_ip_blocked(host) && ingest_host_allowed(host, allow),
        None => false,
    }
}

/// The `Authorization` value to forward to the blob source, if any.
///
/// An empty or whitespace-only value is not a credential, and forwarding it as a
/// header is actively harmful rather than merely useless. A presigned URL carries
/// its authorization in the query string, and S3 rejects a request that *also*
/// presents an `Authorization` header:
///
/// ```text
/// 400 InvalidArgument — Only one auth mechanism allowed; only the X-Amz-Algorithm
/// query parameter, Signature query string parameter or the Authorization header
/// should be specified
/// ```
///
/// A caller with a presigned URL correctly sends no credential — but the wire
/// field is a plain `String`, so "none" arrives as `""`, and this function's
/// caller wrapped it in `Some(...)` regardless. Every ingest of a presigned URL
/// therefore failed from the day it shipped (JP-493).
///
/// Non-empty values pass through untouched: sources that are *not* presigned
/// genuinely need the header, so this must stay a blank filter and never become
/// an unconditional drop.
fn ingest_auth_header(authorization: Option<&str>) -> Option<&str> {
    authorization.filter(|s| !s.trim().is_empty())
}

/// Identity of a blob persisted by the shared write core (JP-430 E3): the
/// content hash, authoritative size, and the mime recorded in the index.
pub(crate) struct StoredBlob {
    pub hash: String,
    pub size: u64,
    pub mime: String,
}

/// Failure taxonomy shared by the REST ingest handler and the MCP file
/// preflight (JP-430 E3). REST maps variants to the exact HTTP statuses the
/// pre-refactor handler returned; MCP maps them to typed `ERR_*` tool errors.
pub(crate) enum BlobWriteError {
    /// `blob_ingest_allowed_hosts` is empty — URL ingest is disabled. The gate
    /// lives *inside* the shared helper so no caller can become an open fetch
    /// proxy by forgetting it.
    NotConfigured,
    /// The source URL failed to parse.
    InvalidUrl,
    /// The source URL failed the SSRF/allowlist gate.
    UrlNotAllowed,
    /// Downloading the source failed (network error, non-2xx, body read).
    Fetch(String),
    /// Declared or streamed size exceeds `max_blob_bytes`.
    TooLarge,
    /// The shared upload-concurrency gate is closed (shutdown).
    GateUnavailable,
    /// Workspace storage quota exceeded (507 class).
    Quota(String),
    /// The object store rejected the write (s3 PUT).
    StoreUnavailable,
    /// Bookkeeping failure after the bytes were stored.
    Backend(String),
}

/// Persist a blob's bytes for `ws`, mirroring the proxy upload's
/// s3-vs-filesystem split: on s3/R2 an existing `(ws, hash)` grant is reused
/// (dedup), else quota is checked against the workspace ledger before
/// `put_object` + `record_finalized_blob`; on the filesystem backend
/// `save_blob_with_quota` owns hashing, dedup, and the quota check. The one
/// write core under REST ingest and the MCP `add_file` preflight (JP-430 E3).
pub(crate) async fn store_blob_bytes(
    blob_store: &BlobStore,
    s3: Option<&crate::server::S3Backend>,
    ws: &WorkspaceId,
    user: &str,
    quota: Option<u64>,
    body: &[u8],
    mime: &str,
) -> Result<StoredBlob, BlobWriteError> {
    // JP-474: the one write core, so normalizing here covers proxy upload, URL
    // ingest, and the MCP `add_file` preflight together. Ingest is the case that
    // matters most — the type comes from a remote server's `Content-Type`, not
    // from a client we authenticated.
    let mime = &normalize_stored_mime(mime);
    let hash = BlobStore::compute_hash(body);
    let (size, hash) = if let Some(s3) = s3 {
        if blob_store.exists(ws, &hash) {
            let size = blob_store
                .get_metadata(ws, &hash)
                .map(|m| m.size)
                .unwrap_or(body.len() as u64);
            (size, hash)
        } else {
            if let Some(q) = quota {
                if blob_store
                    .get_workspace_size(ws)
                    .saturating_add(body.len() as u64)
                    > q
                {
                    return Err(BlobWriteError::Quota("storage quota exceeded".to_string()));
                }
            }
            if let Err(e) = s3.put_object(ws, &hash, body.to_vec(), mime).await {
                log::warn!("blob s3 put failed {}/{}: {e}", ws.as_str(), hash);
                return Err(BlobWriteError::StoreUnavailable);
            }
            match blob_store.record_finalized_blob(ws, &hash, body.len() as u64, mime, user) {
                Ok(m) => (m.size, m.hash),
                Err(e) => return Err(BlobWriteError::Backend(e)),
            }
        }
    } else {
        match blob_store.save_blob_with_quota(ws, &hash, body, mime, user, quota) {
            Ok(m) => (m.size, m.hash),
            Err(e @ SaveBlobError::QuotaExceeded { .. }) => {
                return Err(BlobWriteError::Quota(e.to_string()))
            }
            Err(e) => return Err(BlobWriteError::Backend(e.to_string())),
        }
    };
    Ok(StoredBlob {
        hash,
        size,
        mime: mime.to_string(),
    })
}

/// Fetch a blob from an allowlisted https URL and persist it via
/// [`store_blob_bytes`]. Owns every ingest gate: the allowlist-empty disable,
/// the SSRF check (`ingest_url_ok`, re-validated on every redirect hop by the
/// client's policy), the declared-length early reject, the shared upload-
/// concurrency permit, and the streamed `append_capped` size ceiling (RB-1).
/// `authorization` is sent verbatim as the `Authorization` header — omitted
/// entirely when `None`. Mime precedence: `mime_override`, else the response
/// `Content-Type`, else `application/octet-stream`.
#[allow(clippy::too_many_arguments)] // a deliberate free function: both callers hold these handles under different state types
pub(crate) async fn ingest_blob_from_url(
    http: &reqwest::Client,
    allowed_hosts: &[String],
    gate: &Arc<tokio::sync::Semaphore>,
    blob_store: &BlobStore,
    s3: Option<&crate::server::S3Backend>,
    ws: &WorkspaceId,
    user: &str,
    quota: Option<u64>,
    max_bytes: usize,
    url: &str,
    authorization: Option<&str>,
    mime_override: Option<&str>,
) -> Result<StoredBlob, BlobWriteError> {
    if allowed_hosts.is_empty() {
        return Err(BlobWriteError::NotConfigured);
    }
    let url = reqwest::Url::parse(url).map_err(|_| BlobWriteError::InvalidUrl)?;
    if !ingest_url_ok(&url, allowed_hosts) {
        return Err(BlobWriteError::UrlNotAllowed);
    }

    // Captured before `url` is moved into the request, so the rejection log below
    // can name the host without re-parsing.
    let host_for_log = url.host_str().unwrap_or("?").to_string();

    let mut req = http.get(url);
    if let Some(auth) = ingest_auth_header(authorization) {
        req = req.header(reqwest::header::AUTHORIZATION, auth);
    }
    let mut resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            log::info!("ingest fetch failed for ws {}: {e}", ws.as_str());
            return Err(BlobWriteError::Fetch("fetch_failed".to_string()));
        }
    };
    if !resp.status().is_success() {
        // Log parity with the transport-error arm above, which had it from the
        // start. An upstream *rejection* left no trace at all: the 502 showed up
        // in metrics with no matching line, so the natural read was "the proxy is
        // broken" while S3 was in fact answering 400 every time (JP-493).
        log::info!(
            "ingest source rejected for ws {}: {host_for_log} returned {}",
            ws.as_str(),
            resp.status()
        );
        return Err(BlobWriteError::Fetch(format!(
            "source returned {}",
            resp.status()
        )));
    }

    // Early reject on a declared length over the ceiling.
    if let Some(len) = resp.content_length() {
        if len > max_bytes as u64 {
            return Err(BlobWriteError::TooLarge);
        }
    }

    let mime = mime_override
        .map(str::to_string)
        .or_else(|| {
            resp.headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .map(|s| s.split(';').next().unwrap_or(s).trim().to_string())
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "application/octet-stream".to_string());

    // RB-1b: bound concurrent in-memory uploads (shared gate with the proxy
    // path) before buffering the body.
    let _permit = match gate.clone().acquire_owned().await {
        Ok(p) => p,
        Err(_) => return Err(BlobWriteError::GateUnavailable),
    };

    // RB-1: stream the body in chunks, aborting the moment the running total
    // exceeds `max_bytes` — a host that omits or lies about Content-Length
    // can't make us buffer an unbounded response into RAM (the post-hoc
    // `.bytes()` check read the whole body first).
    let mut body: Vec<u8> = Vec::new();
    loop {
        match resp.chunk().await {
            Ok(Some(chunk)) => {
                if !append_capped(&mut body, &chunk, max_bytes) {
                    return Err(BlobWriteError::TooLarge);
                }
            }
            Ok(None) => break,
            Err(e) => {
                log::info!("ingest body read failed for ws {}: {e}", ws.as_str());
                return Err(BlobWriteError::Fetch("fetch_failed".to_string()));
            }
        }
    }

    store_blob_bytes(blob_store, s3, ws, user, quota, &body, &mime).await
}

/// Map a [`BlobWriteError`] to the REST response the pre-refactor ingest
/// handler returned — the status/message table is the wire contract.
fn blob_write_error_response(e: BlobWriteError) -> axum::response::Response {
    let (status, msg) = match e {
        BlobWriteError::NotConfigured => {
            (StatusCode::FORBIDDEN, "ingest_not_configured".to_string())
        }
        BlobWriteError::InvalidUrl => (StatusCode::BAD_REQUEST, "invalid url".to_string()),
        BlobWriteError::UrlNotAllowed => (StatusCode::FORBIDDEN, "url_not_allowed".to_string()),
        BlobWriteError::Fetch(msg) => (StatusCode::BAD_GATEWAY, msg),
        BlobWriteError::TooLarge => (
            StatusCode::PAYLOAD_TOO_LARGE,
            "blob exceeds max size".to_string(),
        ),
        BlobWriteError::GateUnavailable => (
            StatusCode::SERVICE_UNAVAILABLE,
            "upload gate unavailable".to_string(),
        ),
        BlobWriteError::Quota(msg) => (StatusCode::INSUFFICIENT_STORAGE, msg),
        BlobWriteError::StoreUnavailable => (
            StatusCode::BAD_GATEWAY,
            "blob store unavailable".to_string(),
        ),
        BlobWriteError::Backend(msg) => (StatusCode::INTERNAL_SERVER_ERROR, msg),
    };
    (status, ApiError::body(msg)).into_response()
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

    // JP-443: quota = storage remaining after recorded document bytes (single
    // storage meter across docs + blobs).
    let quota = state.blob_quota_remaining(&ws, limits);
    // RB-3: reuse the process-wide ingest client (built once at startup). Its
    // redirect policy already re-validates every hop against the same allowlist
    // (an open redirect to an internal host is the classic SSRF escape); the
    // allowlist is process-global config, so the startup-built policy matches
    // what a per-request build would have produced.
    let stored = match ingest_blob_from_url(
        state.ingest_http_client(),
        state.blob_ingest_allowed_hosts(),
        state.blob_upload_gate(),
        state.blob_store(),
        state.s3_backend().map(|s| s.as_ref()),
        &ws,
        &claims.sub,
        quota,
        state.max_blob_bytes(),
        &req.url,
        Some(&req.authorization),
        req.mime_type.as_deref(),
    )
    .await
    {
        Ok(s) => s,
        Err(e) => return blob_write_error_response(e),
    };

    // Record opaque provenance (source + tags), additive; advisory only.
    let mut tags = req.tags.clone();
    if let Some(s) = req.source.clone() {
        tags.push(s);
    }
    if let Err(e) = state
        .blob_store()
        .record_provenance(&ws, &stored.hash, &tags)
    {
        log::warn!("provenance record failed {}/{}: {e}", ws.as_str(), stored.hash);
    }

    (
        StatusCode::OK,
        Json(json!({ "hash": stored.hash, "size": stored.size, "mimeType": stored.mime })),
    )
        .into_response()
}

/// Cross-language parity for blob-reference collection (JP-494).
///
/// Reads the same `relay/tests/blob-ref-fixtures/cases.json` the client suite
/// (`src/storage/AssetBundler.fixtures.test.ts`) reads. The two walkers decide
/// what the garbage collector keeps, and they had already drifted once — the
/// client missed every `blob://` embedded in prose HTML while its doc comment
/// claimed parity. A shared fixture is what makes that fail loudly.
#[cfg(test)]
mod blob_ref_fixture_tests {
    use super::*;

    #[derive(serde::Deserialize)]
    struct Case {
        name: String,
        doc: Value,
        expected: Vec<String>,
    }

    #[derive(serde::Deserialize)]
    struct Cases {
        cases: Vec<Case>,
    }

    #[test]
    fn matches_the_shared_fixtures() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/blob-ref-fixtures/cases.json");
        let raw = std::fs::read_to_string(path).expect("read blob-ref fixtures");
        let cases: Cases = serde_json::from_str(&raw).expect("parse blob-ref fixtures");
        assert!(!cases.cases.is_empty(), "fixtures must not be empty");

        for case in cases.cases {
            let mut expected = case.expected.clone();
            expected.sort();
            // `collect_blob_references` already returns a sorted, deduplicated list.
            let found = collect_blob_references(&case.doc);
            assert_eq!(found, expected, "fixture case: {}", case.name);
        }
    }
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
    fn stored_mime_normalization_disarms_script_capable_types() {
        // The finding: a blob uploaded as text/html executes on the app origin
        // when navigated to. It must never be persisted with that type.
        assert_eq!(normalize_stored_mime("text/html"), "application/octet-stream");
        assert_eq!(
            normalize_stored_mime("TEXT/HTML; charset=utf-8"),
            "application/octet-stream"
        );
        assert_eq!(
            normalize_stored_mime("application/xhtml+xml"),
            "application/octet-stream"
        );
        assert_eq!(
            normalize_stored_mime("application/javascript"),
            "application/octet-stream"
        );
        // XML can script via XSLT.
        assert_eq!(normalize_stored_mime("text/xml"), "application/octet-stream");
    }

    #[test]
    fn stored_mime_normalization_preserves_legitimate_types() {
        // Over-rewriting would break viewer dispatch, which keys off the mime.
        assert_eq!(normalize_stored_mime("image/png"), "image/png");
        assert_eq!(normalize_stored_mime("application/pdf"), "application/pdf");
        assert_eq!(
            normalize_stored_mime("application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        );
        // Parameters are dropped and case is folded so one type has one form.
        assert_eq!(normalize_stored_mime("Image/PNG; charset=binary"), "image/png");
        assert_eq!(normalize_stored_mime("  image/webp  "), "image/webp");
        // SVG stays accurate at rest; serving it safely is the consumer's job.
        assert_eq!(normalize_stored_mime("image/svg+xml"), "image/svg+xml");
    }

    #[test]
    fn stored_mime_normalization_rejects_header_injection_and_junk() {
        // A recorded type is echoed as a Content-Type header, so CR/LF must not
        // survive — that is response splitting, not a cosmetic issue.
        assert_eq!(
            normalize_stored_mime("image/png\r\nX-Injected: 1"),
            "application/octet-stream"
        );
        assert_eq!(
            normalize_stored_mime("image/png\nSet-Cookie: a=b"),
            "application/octet-stream"
        );
        assert_eq!(normalize_stored_mime(""), "application/octet-stream");
        assert_eq!(normalize_stored_mime("   "), "application/octet-stream");
        assert_eq!(normalize_stored_mime("notamime"), "application/octet-stream");
        assert_eq!(normalize_stored_mime("a/b/c"), "application/octet-stream");
        assert_eq!(normalize_stored_mime("image/"), "application/octet-stream");
        assert_eq!(normalize_stored_mime("/png"), "application/octet-stream");
        // A quoted/spaced subtype is not a token.
        assert_eq!(
            normalize_stored_mime("image/\"png\""),
            "application/octet-stream"
        );
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
    fn ingest_auth_header_treats_blank_as_absent() {
        // The whole point: a blank credential must not become a header. Sending
        // one to a presigned URL is a 400 from S3, not a no-op, so "harmless
        // extra header" is exactly the wrong intuition here (JP-493).
        assert_eq!(ingest_auth_header(None), None);
        assert_eq!(ingest_auth_header(Some("")), None);
        assert_eq!(ingest_auth_header(Some("   ")), None);
        assert_eq!(ingest_auth_header(Some("\t\n")), None);

        // ...and a real credential still goes through untouched, including its
        // surrounding whitespace: this filters blank values, it does not trim
        // values it keeps. Sources that are not presigned depend on this.
        assert_eq!(ingest_auth_header(Some("Bearer abc")), Some("Bearer abc"));
        assert_eq!(ingest_auth_header(Some(" Bearer abc ")), Some(" Bearer abc "));
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

    // JP-278: the relay must derive a collab doc's blob refs from its content
    // (FileShape `blobRef` + rich-text `blob://`), not the stale top-level array
    // its snapshot flatten never populates.
    #[test]
    fn collect_blob_references_derives_from_content_ignoring_stale_array() {
        let h_shape1 = "a".repeat(64); // FileShape on p1 (also echoed in rich text)
        let h_shape2 = "b".repeat(64); // FileShape on a different page
        let h_rich = "d".repeat(64); // rich-text image only
        let stale = "c".repeat(64); // only in the stale top-level array
        let upper = "E".repeat(64); // uppercase → not a valid (lowercase) hash

        let doc = serde_json::json!({
            "blobReferences": [stale],
            "pages": {
                "p1": { "shapes": {
                    "s1": { "type": "file", "blobRef": h_shape1 },
                    "s2": { "type": "file", "blobRef": upper },     // invalid → ignored
                    "s3": { "type": "rect" }                         // no blob
                }},
                "p2": { "shapes": {
                    "s4": { "type": "file", "blobRef": h_shape2 }
                }}
            },
            "richTextPages": { "pages": {
                "rp1": { "content": format!(
                    "<p><img src=\"blob://{}\"></p><img src=\"blob://{}\">",
                    h_shape1, h_rich
                )}
            }}
        });

        // Sorted + deduped; derived purely from content (stale `c` + uppercase
        // excluded; `h_shape1` appearing in both a shape and rich text counts once).
        assert_eq!(
            collect_blob_references(&doc),
            vec![h_shape1.clone(), h_shape2.clone(), h_rich.clone()]
        );
    }

    #[test]
    fn save_blob_refs_unions_array_and_content() {
        let content = "a".repeat(64); // referenced by a FileShape only
        let stale = "c".repeat(64); // present only in the top-level array

        let doc = serde_json::json!({
            "blobReferences": [stale],
            "pages": { "p1": { "shapes": {
                "s1": { "type": "file", "blobRef": content }
            }}}
        });

        // Union (RB-2): keeps the content-derived ref the stale array omits AND
        // the array entry the content omits — never under-counts, so a save can
        // never release an in-use blob.
        let refs = save_blob_refs(&doc);
        assert!(refs.contains(&content), "content-derived ref must be kept");
        assert!(refs.contains(&stale), "stale-array ref must be kept (union)");
        assert_eq!(refs.len(), 2);
    }

    #[test]
    fn append_capped_accepts_up_to_max_then_rejects() {
        let max = 4;
        let mut buf = Vec::new();
        assert!(append_capped(&mut buf, &[1, 2], max)); // 2 <= 4
        assert!(append_capped(&mut buf, &[3, 4], max)); // 4 <= 4 (exactly at cap)
        assert_eq!(buf, vec![1, 2, 3, 4]);
        // One more byte → 5 > 4: rejected, buffer left unchanged.
        assert!(!append_capped(&mut buf, &[5], max));
        assert_eq!(buf, vec![1, 2, 3, 4]);
    }

    #[test]
    fn append_capped_rejects_single_oversized_chunk() {
        let mut buf = Vec::new();
        assert!(!append_capped(&mut buf, &[0u8; 10], 4));
        assert!(buf.is_empty());
    }
}
