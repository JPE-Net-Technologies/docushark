//! WebSocket protocol message definitions
//!
//! Phase 20.3 Slice E.3: the WS now carries only CRDT sync,
//! awareness, bearer-token auth, JOIN_DOC routing, and DOC_EVENT
//! broadcasts. All document CRUD (list/get/save/delete/share/transfer)
//! and credential-based login moved to the REST API in
//! `relay/src/api.rs`. The deleted message types remain reserved in
//! the byte-code space (the gaps in 3–6, 11–13 are intentional) so
//! future protocol additions don't reuse the slots and an older
//! client surfaces an `unknown message type` rather than silently
//! mis-routing.

use serde::{Deserialize, Serialize};
use super::documents::DocumentMetadata;
use crate::auth::{AuthError, OidcClaims, WorkspaceRole};

/// Workspace (tenant) identifier. Newtype around `String` so the type
/// system enforces that workspace ids can't be silently confused with
/// arbitrary strings or document ids at call sites. See Phase 21.1.
///
/// `From<String>` is intentionally NOT implemented. Construction is
/// allowed only at the JWT/HTTP boundaries:
///   * `WorkspaceId::single_tenant()` — the only construction site
///     today; Phase 21.5 will replace it with a JWT `wsp[].id` read.
///   * `WorkspaceId::from_oidc_array(...)` — picks the matching entry
///     from a validated OIDC `wsp[]` claim (JP-77).
///   * `WorkspaceId::from_configured(...)` — configured ids from
///     `relay.toml` or test fixtures.
///
/// `#[serde(transparent)]` keeps the wire format as a bare string.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct WorkspaceId(String);

/// Raw per-workspace limits carried (optionally) on the chosen `wsp[]`
/// claim entry — surfaced alongside the resolved workspace by
/// [`WorkspaceId::from_oidc_array`]. `None` means the token didn't mint
/// the field; the caller resolves the config fallback
/// (`ServerState::resolve_limits`). The relay never interprets tiers —
/// these are raw numbers minted by the control plane (JP-81).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ClaimLimits {
    pub quota_bytes: Option<u64>,
    pub editor_limit: Option<u32>,
}

impl WorkspaceId {
    /// The legacy single-tenant constant (`"default"`). Used as the
    /// fallback when a JWT lacks a workspace claim, when `[tenancy]`
    /// is set to `dedicated` with no configured workspace id, and by
    /// MCP (which doesn't yet carry workspace ids).
    pub fn single_tenant() -> Self {
        Self("default".to_string())
    }

    /// Pick a `WorkspaceId` (with its role) from the OIDC `wsp[]` array.
    ///
    /// - `requested` is the workspace the caller asked to act on (e.g.
    ///   pulled from a URL path); when `None`, the first entry wins.
    /// - `relay_region` is checked against the matching entry's `region`
    ///   to enforce regional pinning. Mismatches return
    ///   `AuthError::RegionMismatch`.
    /// - `WorkspaceMismatch` is returned if no entry matches `requested`
    ///   or if the claim array is empty.
    ///
    /// The workspace id itself goes through the same path-traversal
    /// validation as the legacy single-string claim — a forged
    /// `"../etc"` is rejected with `WorkspaceMismatch` rather than
    /// becoming a filesystem traversal once the id reaches
    /// `DocumentStore::doc_path`.
    pub fn from_oidc_array(
        claims: &OidcClaims,
        requested: Option<&str>,
        relay_region: &str,
    ) -> Result<(Self, WorkspaceRole, ClaimLimits), AuthError> {
        if claims.wsp.is_empty() {
            return Err(AuthError::WorkspaceMismatch);
        }
        let chosen = match requested {
            Some(name) => claims.wsp.iter().find(|w| w.id == name),
            None => claims.wsp.first(),
        }
        .ok_or(AuthError::WorkspaceMismatch)?;

        if chosen.region != relay_region {
            log::warn!(
                "wsp region mismatch: claim={} relay={}",
                chosen.region,
                relay_region
            );
            return Err(AuthError::RegionMismatch);
        }

        if let Err(e) = validate_workspace_id(&chosen.id) {
            log::warn!("rejected OIDC wsp[].id {:?}: {}", chosen.id, e);
            return Err(AuthError::WorkspaceMismatch);
        }

        Ok((
            Self(chosen.id.clone()),
            chosen.role,
            ClaimLimits {
                quota_bytes: chosen.quota_bytes,
                editor_limit: chosen.editor_limit,
            },
        ))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Construct a `WorkspaceId` from a configured id (e.g.
    /// `[tenancy].workspace_id` in `relay.toml`). Returns `None` if the
    /// id fails the same path-traversal validation the OIDC claim path
    /// applies. Tests use it to materialise workspace ids without going
    /// through a JWT.
    pub fn from_configured(id: &str) -> Option<Self> {
        match validate_workspace_id(id) {
            Ok(()) => Some(Self(id.to_string())),
            Err(e) => {
                log::warn!("rejected workspace id {:?}: {}", id, e);
                None
            }
        }
    }
}

/// Maximum allowed length for a workspace id, in bytes. Tighter than
/// `DocId` because workspace ids are administrative — they don't carry
/// user-meaningful content and end up as on-disk path components.
const WORKSPACE_ID_MAX_LEN: usize = 64;

fn validate_workspace_id(s: &str) -> Result<(), IdError> {
    if s.is_empty() {
        return Err(IdError::Empty);
    }
    if s.len() > WORKSPACE_ID_MAX_LEN {
        return Err(IdError::TooLong);
    }
    if s.contains("..") || s.contains('/') || s.contains('\\') {
        return Err(IdError::PathTraversal);
    }
    for ch in s.chars() {
        if ch == '\0' || ch.is_control() {
            return Err(IdError::InvalidCharacter);
        }
    }
    Ok(())
}

/// Document identifier. Newtype around `String` so the type system
/// enforces that a doc id can't be silently swapped with a workspace
/// id (or any other string) at call sites. See Phase 21.1.
///
/// `From<String>` is intentionally NOT implemented. Construction is
/// allowed only at protocol boundaries:
///   * `DocId::from_http_path(...)` — REST path params; validates
///     against path-traversal, NUL bytes, length.
///   * `Deserialize` — WebSocket / MCP JSON payloads. The wire format
///     is bare-string (via `#[serde(transparent)]`), so any source
///     that decodes JSON gets validated only by serde — the same
///     validation needs to run before storage I/O uses the value as a
///     file-system path component. Today that's the responsibility of
///     `DocumentStore::doc_path`; 21.4 will fuzz this.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct DocId(String);

/// Errors produced when an externally-supplied string fails to become a
/// `DocId`. Stays narrow on purpose — every variant maps to a distinct
/// HTTP/error response. Phase 21.4 will exercise the boundary with a
/// fuzz suite.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IdError {
    Empty,
    TooLong,
    PathTraversal,
    InvalidCharacter,
}

impl std::fmt::Display for IdError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            IdError::Empty => write!(f, "id is empty"),
            IdError::TooLong => write!(f, "id exceeds maximum length"),
            IdError::PathTraversal => write!(f, "id contains path-traversal characters"),
            IdError::InvalidCharacter => write!(f, "id contains invalid character"),
        }
    }
}

impl std::error::Error for IdError {}

/// Maximum allowed length for any doc id, in bytes.
const DOC_ID_MAX_LEN: usize = 256;

impl DocId {
    /// Construct a `DocId` from an HTTP path segment. Rejects empty,
    /// over-long, path-traversal, and structurally-invalid inputs.
    /// This is one of two blessed entry points for raw strings; the
    /// other is serde deserialization on the wire.
    pub fn from_http_path(s: String) -> Result<Self, IdError> {
        validate_doc_id(&s)?;
        Ok(Self(s))
    }

    /// Construct a `DocId` from a document JSON body's `"id"` field.
    /// Same validation as the path form; separated so call sites read
    /// at the right level of intent.
    pub fn from_body_id(s: String) -> Result<Self, IdError> {
        validate_doc_id(&s)?;
        Ok(Self(s))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

fn validate_doc_id(s: &str) -> Result<(), IdError> {
    if s.is_empty() {
        return Err(IdError::Empty);
    }
    if s.len() > DOC_ID_MAX_LEN {
        return Err(IdError::TooLong);
    }
    // No path-traversal or fs separators.
    if s.contains("..") || s.contains('/') || s.contains('\\') {
        return Err(IdError::PathTraversal);
    }
    // No NUL or control characters; allow printable ASCII + common id chars.
    for ch in s.chars() {
        if ch == '\0' || ch.is_control() {
            return Err(IdError::InvalidCharacter);
        }
    }
    Ok(())
}

/// Wire-protocol version. Must match `PROTOCOL_VERSION` in
/// `src/collaboration/protocol.ts`. Sent by clients as
/// `?protocolVersion=<N>` on the WebSocket upgrade URL; the server
/// refuses mismatched versions.
///
/// v4 (JP-340): canvas shapes moved from a single active-page `shapes` /
/// `shapeOrder` surface to per-page `shapes:<id>` / `shapeOrder:<id>` shared
/// types. A v3 client speaks the old layout, so it must refresh rather than
/// silently desync against a per-page relay.
pub const PROTOCOL_VERSION: u32 = 4;

/// Query-parameter name carrying the client's protocol version.
pub const PROTOCOL_VERSION_PARAM: &str = "protocolVersion";

/// Error code returned when client/server protocol versions disagree.
pub const ERR_PROTOCOL_VERSION_MISMATCH: &str = "ERR_PROTOCOL_VERSION_MISMATCH";

/// Error code sent (MESSAGE_ERROR) when an inbound frame exceeds the
/// per-message cap. The connection is kept open (JP-309) — the client should
/// deliver large updates via MESSAGE_SYNC_CHUNK instead.
pub const ERR_MESSAGE_TOO_LARGE: &str = "ERR_MESSAGE_TOO_LARGE";

/// Message types for the sync protocol. Must match the TypeScript
/// MESSAGE_* constants in `protocol.ts`.
///
/// Reserved gaps (3–6, 11–13) are intentional — see module docs.
pub const MESSAGE_SYNC: u8 = 0;
pub const MESSAGE_AWARENESS: u8 = 1;
pub const MESSAGE_AUTH: u8 = 2;
// 3..=6 reserved (formerly DOC_LIST/GET/SAVE/DELETE — now REST)
pub const MESSAGE_DOC_EVENT: u8 = 7;
pub const MESSAGE_ERROR: u8 = 8;
pub const MESSAGE_AUTH_RESPONSE: u8 = 9;
pub const MESSAGE_JOIN_DOC: u8 = 10;
// 11..=13 reserved (formerly AUTH_LOGIN, DOC_SHARE, DOC_TRANSFER — now REST)
/// A fragment of a large SYNC frame, split client→relay so a big offline-
/// reconnect update can be delivered under the per-message cap (JP-309).
/// Body (binary): `[msgId: 16 bytes][seq: u32 BE][total: u32 BE][payload]`.
/// Reassembled bytes are the original `[MESSAGE_SYNC|update]` frame.
pub const MESSAGE_SYNC_CHUNK: u8 = 14;
/// Relay→client ack once a chunked update's msgId is fully reassembled and
/// applied. Body (binary): `[msgId: 16 bytes]`.
pub const MESSAGE_SYNC_CHUNK_ACK: u8 = 15;

/// Liveness heartbeat (bodyless, a bare 1-byte frame). The client sends it on an
/// interval; the relay echoes it straight back so the client can detect a
/// silently-dropped socket (wifi off, idle proxy kill) that never fires a WS
/// close. Additive + client-feature-detected, so no PROTOCOL_VERSION bump (an
/// older client simply never sends it; an older relay would log it as unknown).
pub const MESSAGE_HEARTBEAT: u8 = 16;

/// Authentication request with JWT token (sent by client)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthRequest {
    pub token: String,
}

/// Authentication response (sent by server)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_expires_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Relay's inbound per-message cap in bytes (JP-309). The client splits any
    /// outbound SYNC frame larger than this into MESSAGE_SYNC_CHUNK frames.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_message_size: Option<u64>,
}

/// Document event types
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum DocEventType {
    Created,
    Updated,
    Deleted,
}

/// Document event broadcast (sent when a document the client cares
/// about is created, updated, or deleted via REST or peer sync).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocEvent {
    pub event_type: DocEventType,
    pub doc_id: DocId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<DocumentMetadata>,
    pub user_id: String,
}

/// Join document request (for CRDT sync routing)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinDocRequest {
    pub doc_id: DocId,
}

/// Individual share entry. Still lives in this module because the
/// REST `/api/docs/:id/share` body uses it (`relay/src/api.rs`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareEntry {
    pub user_id: String,
    pub user_name: String,
    /// "viewer" | "editor" | "none" (none = revoke)
    pub permission: String,
}

/// Error response
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorResponse {
    pub request_id: Option<String>,
    pub error: String,
}

/// Encode a message with type prefix for sending over WebSocket
pub fn encode_message<T: Serialize>(msg_type: u8, payload: &T) -> Result<Vec<u8>, String> {
    let json = serde_json::to_vec(payload)
        .map_err(|e| format!("Failed to serialize message: {}", e))?;

    let mut data = Vec::with_capacity(1 + json.len());
    data.push(msg_type);
    data.extend(json);

    Ok(data)
}

/// Decode a message type from binary data
pub fn decode_message_type(data: &[u8]) -> Option<u8> {
    data.first().copied()
}

/// Decode message payload (everything after the first byte)
pub fn decode_payload<'a, T: Deserialize<'a>>(data: &'a [u8]) -> Result<T, String> {
    if data.len() < 2 {
        return Err("Message too short".to_string());
    }

    serde_json::from_slice(&data[1..])
        .map_err(|e| format!("Failed to deserialize message: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encode_decode_doc_event() {
        let event = DocEvent {
            event_type: DocEventType::Created,
            doc_id: DocId::from_http_path("doc-1".to_string()).unwrap(),
            metadata: Some(DocumentMetadata {
                id: DocId::from_http_path("doc-1".to_string()).unwrap(),
                name: "Test Doc".to_string(),
                page_count: 1,
                modified_at: 1000,
                created_at: 1000,
                is_relay_document: Some(true),
                server_version: None,
                locked_by: None,
                locked_by_name: None,
                locked_at: None,
                owner_id: Some("user-1".to_string()),
                owner_name: Some("Test User".to_string()),
                collection_id: None,
                shared_with: None,
                last_modified_by: None,
                last_modified_by_name: None,
            }),
            user_id: "user-1".to_string(),
        };

        let encoded = encode_message(MESSAGE_DOC_EVENT, &event).unwrap();
        assert_eq!(encoded[0], MESSAGE_DOC_EVENT);

        let decoded: DocEvent = decode_payload(&encoded).unwrap();
        assert_eq!(decoded.event_type, DocEventType::Created);
        assert_eq!(decoded.doc_id.as_str(), "doc-1");
    }

    #[test]
    fn doc_id_serializes_as_bare_string() {
        // serde(transparent) invariant: DocId on the wire is `"doc-1"`
        // not `{"0":"doc-1"}`. Required for compatibility with the TS
        // protocol and the protocol fixtures.
        let req = JoinDocRequest {
            doc_id: DocId::from_http_path("doc-1".to_string()).unwrap(),
        };
        let v = serde_json::to_value(&req).unwrap();
        assert_eq!(v, serde_json::json!({ "docId": "doc-1" }));

        // Round-trip: bare-string JSON deserializes back to DocId.
        let parsed: JoinDocRequest = serde_json::from_value(v).unwrap();
        assert_eq!(parsed.doc_id.as_str(), "doc-1");
    }

    #[test]
    fn workspace_id_from_configured_rejects_path_traversal() {
        // A configured workspace id with a traversal must never become a
        // path component — `from_configured` returns `None`.
        for bad in &[
            "../etc",
            "..",
            "alpha/beta",
            "alpha\\beta",
            "alpha\0",
            "alpha\nbeta",
            "",
        ] {
            assert!(
                WorkspaceId::from_configured(bad).is_none(),
                "bad workspace id {:?} should be rejected",
                bad
            );
        }
        let too_long = "a".repeat(WORKSPACE_ID_MAX_LEN + 1);
        assert!(WorkspaceId::from_configured(&too_long).is_none());
    }

    #[test]
    fn workspace_id_from_configured_accepts_legal() {
        let ws = WorkspaceId::from_configured("alpha").unwrap();
        assert_eq!(ws.as_str(), "alpha");
        let ws = WorkspaceId::from_configured("ws-123_abc").unwrap();
        assert_eq!(ws.as_str(), "ws-123_abc");
    }

    #[test]
    fn doc_id_validation_rejects_path_traversal() {
        assert!(matches!(
            DocId::from_http_path("../etc/passwd".to_string()),
            Err(IdError::PathTraversal)
        ));
        assert!(matches!(
            DocId::from_http_path("foo/bar".to_string()),
            Err(IdError::PathTraversal)
        ));
        assert!(matches!(
            DocId::from_http_path("foo\\bar".to_string()),
            Err(IdError::PathTraversal)
        ));
        assert!(matches!(
            DocId::from_http_path("".to_string()),
            Err(IdError::Empty)
        ));
        assert!(matches!(
            DocId::from_http_path("foo\0bar".to_string()),
            Err(IdError::InvalidCharacter)
        ));
        assert!(matches!(
            DocId::from_http_path("a".repeat(300)),
            Err(IdError::TooLong)
        ));
    }
}

// ============ Cross-Language Fixture Round-Trip ============
//
// Loads the shared JSON fixtures at `tests/protocol-fixtures/` and
// round-trips each payload through the strongly-typed Rust structs.
// The matching TS test lives at `src/collaboration/protocol.fixtures.test.ts`.
// If a TS-side payload shape and the Rust struct disagree (renamed
// field, missing field, type mismatch), the round-trip diff fails.
#[cfg(test)]
mod fixture_tests {
    use super::*;
    use serde::de::DeserializeOwned;
    use serde_json::Value;
    use std::fs;
    use std::path::PathBuf;

    #[derive(Debug, serde::Deserialize)]
    struct Fixture {
        #[serde(rename = "messageType")]
        message_type: u8,
        #[serde(rename = "messageName")]
        message_name: String,
        kind: String,
        payload: Value,
    }

    fn fixtures_dir() -> PathBuf {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        manifest.join("tests").join("protocol-fixtures")
    }

    fn load_all() -> Vec<(String, Fixture)> {
        let dir = fixtures_dir();
        let mut out = Vec::new();
        for entry in fs::read_dir(&dir).expect("read protocol-fixtures dir") {
            let entry = entry.expect("dir entry");
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let raw = fs::read_to_string(&path).expect("read fixture");
            let fixture: Fixture = serde_json::from_str(&raw)
                .unwrap_or_else(|e| panic!("parse {:?}: {}", path, e));
            out.push((path.file_name().unwrap().to_string_lossy().to_string(), fixture));
        }
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out
    }

    fn round_trip<T: DeserializeOwned + serde::Serialize>(label: &str, payload: &Value) {
        let typed: T = serde_json::from_value(payload.clone())
            .unwrap_or_else(|e| panic!("{}: deserialize into Rust struct: {}", label, e));
        let reserialized = serde_json::to_value(&typed)
            .unwrap_or_else(|e| panic!("{}: re-serialize: {}", label, e));
        assert_eq!(
            &reserialized, payload,
            "{}: Rust round-trip diverged from fixture payload\nlhs (Rust) = {}\nrhs (fixture) = {}",
            label, reserialized, payload
        );
    }

    #[test]
    fn protocol_version_is_set() {
        assert!(PROTOCOL_VERSION > 0);
    }

    #[test]
    fn fixtures_round_trip_through_rust_types() {
        let fixtures = load_all();
        assert!(!fixtures.is_empty(), "no fixtures discovered");

        for (file, f) in &fixtures {
            let label = format!("{} ({} {})", file, f.message_name, f.kind);

            let encoded = encode_message(f.message_type, &f.payload)
                .unwrap_or_else(|e| panic!("{}: encode_message: {}", label, e));
            assert_eq!(encoded[0], f.message_type, "{}: type byte mismatch", label);

            match (f.message_name.as_str(), f.kind.as_str()) {
                ("AUTH", "request") => round_trip::<AuthRequest>(&label, &f.payload),
                ("AUTH_RESPONSE", "response") => round_trip::<AuthResponse>(&label, &f.payload),
                ("DOC_EVENT", "event") => round_trip::<DocEvent>(&label, &f.payload),
                ("JOIN_DOC", "oneshot") => round_trip::<JoinDocRequest>(&label, &f.payload),
                ("ERROR", "response") => round_trip::<ErrorResponse>(&label, &f.payload),
                other => panic!(
                    "{}: no Rust round-trip mapping for (name={:?}, kind={:?})",
                    label, other.0, other.1
                ),
            }
        }
    }
}
