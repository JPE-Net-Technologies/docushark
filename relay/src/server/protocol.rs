//! WebSocket protocol message definitions
//!
//! Defines the message types and structures for communication between
//! the server and clients for team document synchronization.

use serde::{Deserialize, Serialize};
use super::documents::DocumentMetadata;

/// Wire-protocol version. Must match `PROTOCOL_VERSION` in
/// `src/collaboration/protocol.ts`. Sent by clients as
/// `?protocolVersion=<N>` on the WebSocket upgrade URL; the server
/// refuses mismatched versions.
pub const PROTOCOL_VERSION: u32 = 1;

/// Query-parameter name carrying the client's protocol version.
pub const PROTOCOL_VERSION_PARAM: &str = "protocolVersion";

/// Error code returned when client/server protocol versions disagree.
pub const ERR_PROTOCOL_VERSION_MISMATCH: &str = "ERR_PROTOCOL_VERSION_MISMATCH";

/// Message types for the sync protocol
/// Must match the TypeScript MESSAGE_* constants in protocol.ts
pub const MESSAGE_SYNC: u8 = 0;
pub const MESSAGE_AWARENESS: u8 = 1;
pub const MESSAGE_AUTH: u8 = 2;
pub const MESSAGE_DOC_LIST: u8 = 3;
pub const MESSAGE_DOC_GET: u8 = 4;
pub const MESSAGE_DOC_SAVE: u8 = 5;
pub const MESSAGE_DOC_DELETE: u8 = 6;
pub const MESSAGE_DOC_EVENT: u8 = 7;
pub const MESSAGE_ERROR: u8 = 8;
pub const MESSAGE_AUTH_RESPONSE: u8 = 9;
pub const MESSAGE_JOIN_DOC: u8 = 10;
pub const MESSAGE_AUTH_LOGIN: u8 = 11;
pub const MESSAGE_DOC_SHARE: u8 = 12;
pub const MESSAGE_DOC_TRANSFER: u8 = 13;

/// Authentication request with JWT token (sent by client)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthRequest {
    pub token: String,
}

/// Authentication login request with username/password (sent by client)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthLoginRequest {
    pub username: String,
    pub password: String,
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
}

/// Document list request
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocListRequest {
    pub request_id: String,
}

/// Document list response
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocListResponse {
    pub request_id: String,
    pub documents: Vec<DocumentMetadata>,
}

/// Document get request
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocGetRequest {
    pub request_id: String,
    pub doc_id: String,
}

/// Document get response
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocGetResponse {
    pub request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub document: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Document save request
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocSaveRequest {
    pub request_id: String,
    pub document: serde_json::Value,
}

/// Document save response
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocSaveResponse {
    pub request_id: String,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Document delete request
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocDeleteRequest {
    pub request_id: String,
    pub doc_id: String,
}

/// Document delete response
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocDeleteResponse {
    pub request_id: String,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Document event types
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum DocEventType {
    Created,
    Updated,
    Deleted,
}

/// Document event broadcast (sent when document list changes)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocEvent {
    pub event_type: DocEventType,
    pub doc_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<DocumentMetadata>,
    pub user_id: String,
}

/// Join document request (for CRDT sync routing)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinDocRequest {
    pub doc_id: String,
}

/// Document share/permission update request
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocShareRequest {
    pub request_id: String,
    pub doc_id: String,
    /// List of permission entries to set
    pub shares: Vec<ShareEntry>,
}

/// Individual share entry
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareEntry {
    pub user_id: String,
    pub user_name: String,
    /// "viewer" | "editor" | "none" (none = revoke)
    pub permission: String,
}

/// Document share response
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocShareResponse {
    pub request_id: String,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Document ownership transfer request
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocTransferRequest {
    pub request_id: String,
    pub doc_id: String,
    pub new_owner_id: String,
    pub new_owner_name: String,
}

/// Document ownership transfer response
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocTransferResponse {
    pub request_id: String,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
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
    fn test_encode_decode_doc_list_request() {
        let request = DocListRequest {
            request_id: "req-123".to_string(),
        };

        let encoded = encode_message(MESSAGE_DOC_LIST, &request).unwrap();

        assert_eq!(encoded[0], MESSAGE_DOC_LIST);

        let decoded: DocListRequest = decode_payload(&encoded).unwrap();
        assert_eq!(decoded.request_id, "req-123");
    }

    #[test]
    fn test_encode_decode_doc_event() {
        let event = DocEvent {
            event_type: DocEventType::Created,
            doc_id: "doc-1".to_string(),
            metadata: Some(DocumentMetadata {
                id: "doc-1".to_string(),
                name: "Test Doc".to_string(),
                page_count: 1,
                modified_at: 1000,
                created_at: 1000,
                is_team_document: Some(true),
                locked_by: None,
                locked_by_name: None,
                locked_at: None,
                owner_id: Some("user-1".to_string()),
                owner_name: Some("Test User".to_string()),
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
        assert_eq!(decoded.doc_id, "doc-1");
    }
}

// ============ Cross-Language Fixture Round-Trip ============
//
// Loads the shared JSON fixtures at `<repo>/protocol-fixtures/` (the
// matching TS test lives at `src/collaboration/protocol.fixtures.test.ts`)
// and round-trips each payload through the strongly-typed Rust structs.
// If a TS-side payload shape and the Rust struct disagree (renamed field,
// missing field, type mismatch), the round-trip diff fails the test.
//
// Path note: fixtures move to `/relay/tests/protocol-fixtures/` in Slice
// C of phase 20.3. Update `fixtures_dir()` then.
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
        // Fixtures live under the relay crate's tests dir as of Slice C.1.
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        manifest
            .parent()
            .expect("repo root")
            .join("relay")
            .join("tests")
            .join("protocol-fixtures")
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

    /// Round-trip a payload through type `T`, asserting structural equality.
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

            // messageType byte must match what encode_message produces.
            let encoded = encode_message(f.message_type, &f.payload)
                .unwrap_or_else(|e| panic!("{}: encode_message: {}", label, e));
            assert_eq!(encoded[0], f.message_type, "{}: type byte mismatch", label);

            // Strongly-typed round-trip per (messageName, kind).
            match (f.message_name.as_str(), f.kind.as_str()) {
                ("AUTH", "request") => round_trip::<AuthRequest>(&label, &f.payload),
                ("AUTH_LOGIN", "request") => round_trip::<AuthLoginRequest>(&label, &f.payload),
                ("AUTH_RESPONSE", "response") => round_trip::<AuthResponse>(&label, &f.payload),
                ("DOC_LIST", "request") => round_trip::<DocListRequest>(&label, &f.payload),
                ("DOC_LIST", "response") => round_trip::<DocListResponse>(&label, &f.payload),
                ("DOC_GET", "request") => round_trip::<DocGetRequest>(&label, &f.payload),
                ("DOC_GET", "response") => round_trip::<DocGetResponse>(&label, &f.payload),
                ("DOC_SAVE", "request") => round_trip::<DocSaveRequest>(&label, &f.payload),
                ("DOC_SAVE", "response") => round_trip::<DocSaveResponse>(&label, &f.payload),
                ("DOC_DELETE", "request") => round_trip::<DocDeleteRequest>(&label, &f.payload),
                ("DOC_DELETE", "response") => round_trip::<DocDeleteResponse>(&label, &f.payload),
                ("DOC_EVENT", "event") => round_trip::<DocEvent>(&label, &f.payload),
                ("JOIN_DOC", "oneshot") => round_trip::<JoinDocRequest>(&label, &f.payload),
                ("DOC_SHARE", "request") => round_trip::<DocShareRequest>(&label, &f.payload),
                ("DOC_SHARE", "response") => round_trip::<DocShareResponse>(&label, &f.payload),
                ("DOC_TRANSFER", "request") => round_trip::<DocTransferRequest>(&label, &f.payload),
                ("DOC_TRANSFER", "response") => round_trip::<DocTransferResponse>(&label, &f.payload),
                ("ERROR", "response") => round_trip::<ErrorResponse>(&label, &f.payload),
                other => panic!(
                    "{}: no Rust round-trip mapping for (name={:?}, kind={:?})",
                    label, other.0, other.1
                ),
            }
        }
    }
}
