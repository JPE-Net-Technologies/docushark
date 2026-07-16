//! JP-81 — free-tier enforcement, end-to-end over the real REST surface.
//!
//! Exercises the two user-facing halves of the single-meter model through
//! HTTP against an in-process relay:
//!
//!   * `GET /api/v1/usage` reports the *calling* workspace's storage bytes
//!     and effective limits, and never another workspace's numbers.
//!   * `POST /api/blobs/:hash` returns **507** once a new grant would push
//!     the workspace past its `quota_bytes`, while a dedup re-upload of an
//!     already-stored hash is never refused.
//!
//! Limits are minted onto the JWT `wsp[]` claim via the test issuer
//! (`mint_with_limits`), the same path DocuShark Cloud uses — so this
//! validates the claim → effective-limit resolution too.

use std::sync::Arc;

use docushark_relay::auth::WorkspaceRole;
use docushark_relay::config::{TenancyConfig, TenancyMode};
use docushark_relay::server::protocol::{
    encode_message, MESSAGE_AUTH, MESSAGE_AUTH_RESPONSE, PROTOCOL_VERSION,
};
use docushark_relay::server::{NetworkMode, ServerConfig, WebSocketServer};
use docushark_relay::test_support::OidcTestIssuer;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use tokio_tungstenite::tungstenite::Message as WsMessage;

/// In-process relay in shared-tenancy mode. Returns the HTTP base, the WS
/// base, and the issuer (kept alive so its JWKS endpoint keeps serving
/// verification keys).
async fn start_relay() -> (Arc<WebSocketServer>, String, String, OidcTestIssuer, TempDir) {
    let tmp = tempfile::tempdir().expect("tempdir");
    let issuer = OidcTestIssuer::new().await;

    let server = Arc::new(WebSocketServer::new());
    server.set_app_data_dir(tmp.path().to_path_buf()).await;
    server.set_auth(issuer.auth_state()).await;
    server
        .set_tenancy(TenancyConfig {
            mode: TenancyMode::Shared,
            workspace_id: None,
            ..TenancyConfig::default()
        })
        .await;
    server
        .set_config(ServerConfig {
            port: 0,
            network_mode: NetworkMode::Localhost,
            max_connections: 0,
        })
        .await
        .expect("set_config");

    let bound = server.start(0).await.expect("start");
    let ws_base = bound.clone();
    let http = bound
        .strip_prefix("ws://")
        .map(|rest| format!("http://{rest}"))
        .unwrap_or(bound);

    (server, http, ws_base, issuer, tmp)
}

fn blob_hash(data: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(data);
    hex::encode(h.finalize())
}

async fn upload_blob(http: &str, token: &str, data: &[u8]) -> reqwest::StatusCode {
    reqwest::Client::new()
        .post(format!("{http}/api/blobs/{}", blob_hash(data)))
        .bearer_auth(token)
        .body(data.to_vec())
        .send()
        .await
        .expect("blob upload request")
        .status()
}

async fn get_usage(http: &str, token: &str) -> Value {
    reqwest::Client::new()
        .get(format!("{http}/api/v1/usage"))
        .bearer_auth(token)
        .send()
        .await
        .expect("usage request")
        .json()
        .await
        .expect("usage json")
}

#[tokio::test]
async fn usage_reports_claim_limits_and_is_workspace_scoped() {
    let (_server, http, _ws_base, issuer, _tmp) = start_relay().await;

    // Two workspaces with *different* minted limits.
    let alpha = issuer.mint_with_limits("user-a", "alpha", WorkspaceRole::Owner, Some(1_000_000), Some(2));
    let beta = issuer.mint_with_limits("user-b", "beta", WorkspaceRole::Owner, Some(5_000), Some(9));

    // Give alpha 11 bytes of stored blob.
    assert_eq!(upload_blob(&http, &alpha, b"hello world").await, reqwest::StatusCode::OK);

    let ua = get_usage(&http, &alpha).await;
    assert_eq!(ua["storageBytes"], 11);
    assert_eq!(ua["storageQuota"], 1_000_000);
    assert_eq!(ua["editorLimit"], 2);
    assert_eq!(ua["activeEditors"], 0); // no live WS editors

    // Beta sees only its own numbers — alpha's 11 bytes are invisible.
    let ub = get_usage(&http, &beta).await;
    assert_eq!(ub["storageBytes"], 0);
    assert_eq!(ub["storageQuota"], 5_000);
    assert_eq!(ub["editorLimit"], 9);
}

#[tokio::test]
async fn usage_omits_unlimited_quota_as_null() {
    let (_server, http, _ws_base, issuer, _tmp) = start_relay().await;
    // No limits minted + config default 0 → unlimited → null on the wire.
    let token = issuer.mint_with_limits("user-c", "gamma", WorkspaceRole::Owner, None, None);
    let usage = get_usage(&http, &token).await;
    assert!(usage["storageQuota"].is_null());
    assert!(usage["editorLimit"].is_null());
    assert_eq!(usage["storageBytes"], 0);
}

#[tokio::test]
async fn blob_upload_returns_507_over_quota_but_dedup_reupload_is_free() {
    let (_server, http, _ws_base, issuer, _tmp) = start_relay().await;
    // 15-byte quota.
    let token = issuer.mint_with_limits("user-d", "delta", WorkspaceRole::Owner, Some(15), None);

    let first = b"0123456789"; // 10 bytes → fits (10 <= 15)
    assert_eq!(upload_blob(&http, &token, first).await, reqwest::StatusCode::OK);

    // A second distinct 10-byte blob would be 20 > 15 → 507.
    let second = b"abcdefghij";
    assert_eq!(
        upload_blob(&http, &token, second).await,
        reqwest::StatusCode::INSUFFICIENT_STORAGE
    );

    // Re-uploading the already-granted hash adds 0 (dedup) → still OK,
    // even though the workspace is at quota.
    assert_eq!(upload_blob(&http, &token, first).await, reqwest::StatusCode::OK);

    // Usage confirms only the first blob's bytes are counted.
    let usage = get_usage(&http, &token).await;
    assert_eq!(usage["storageBytes"], 10);
    assert_eq!(usage["storageQuota"], 15);
}

async fn put_doc(http: &str, token: &str, id: &str, doc: &Value) -> reqwest::Response {
    reqwest::Client::new()
        .put(format!("{http}/api/docs/{id}"))
        .bearer_auth(token)
        .json(doc)
        .send()
        .await
        .expect("doc save request")
}

/// A minimal doc body owned by `sub` (so delete-permission checks pass) with
/// a `filler` payload to control its serialized size.
fn doc_body(id: &str, sub: &str, filler_len: usize) -> Value {
    json!({
        "id": id,
        "name": "Metered",
        "ownerId": sub,
        "filler": "x".repeat(filler_len),
    })
}

// ---- JP-443: document bytes join the single storage meter ----

#[tokio::test]
async fn doc_bytes_count_toward_usage_and_507_is_delta_aware() {
    let (_server, http, _ws_base, issuer, _tmp) = start_relay().await;
    let token = issuer.mint_with_limits("user-e", "epsilon", WorkspaceRole::Owner, Some(4096), None);

    // A small doc lands and its serialized bytes appear on the meter.
    let resp = put_doc(&http, &token, "meter-doc", &doc_body("meter-doc", "user-e", 16)).await;
    assert_eq!(resp.status(), reqwest::StatusCode::OK);
    let usage = get_usage(&http, &token).await;
    let small = usage["docBytes"].as_u64().expect("docBytes present");
    assert!(small > 0, "doc bytes metered: {usage}");
    assert_eq!(usage["blobBytes"], 0);
    assert_eq!(usage["storageBytes"], small, "storageBytes = docBytes + blobBytes");
    assert_eq!(usage["storageQuota"], 4096);

    // Growing past the quota is refused with 507 + the stable body string.
    let resp = put_doc(&http, &token, "meter-doc", &doc_body("meter-doc", "user-e", 8192)).await;
    assert_eq!(resp.status(), reqwest::StatusCode::INSUFFICIENT_STORAGE);
    assert!(resp.text().await.unwrap().contains("storage quota exceeded"));

    // Delta-aware: a growing save that still FITS lands…
    let resp = put_doc(&http, &token, "meter-doc", &doc_body("meter-doc", "user-e", 1024)).await;
    assert_eq!(resp.status(), reqwest::StatusCode::OK);
    // …and a shrinking save is always accepted.
    let resp = put_doc(&http, &token, "meter-doc", &doc_body("meter-doc", "user-e", 16)).await;
    assert_eq!(resp.status(), reqwest::StatusCode::OK);

    // Delete frees the metered bytes (the dig-out path).
    let resp = reqwest::Client::new()
        .delete(format!("{http}/api/docs/meter-doc"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("doc delete request");
    assert_eq!(resp.status(), reqwest::StatusCode::OK);
    let usage = get_usage(&http, &token).await;
    assert_eq!(usage["docBytes"], 0, "delete releases doc bytes: {usage}");
}

#[tokio::test]
async fn blob_upload_507_when_docs_consume_quota() {
    let (_server, http, _ws_base, issuer, _tmp) = start_relay().await;
    let token = issuer.mint_with_limits("user-f", "zeta", WorkspaceRole::Owner, Some(2048), None);

    // Park ~600+ bytes of document on the meter.
    let resp = put_doc(&http, &token, "hog-doc", &doc_body("hog-doc", "user-f", 600)).await;
    assert_eq!(resp.status(), reqwest::StatusCode::OK);
    let usage = get_usage(&http, &token).await;
    let doc_bytes = usage["docBytes"].as_u64().unwrap();
    assert!(doc_bytes > 600);

    // A blob that would fit a doc-less quota no longer does: docs + blobs
    // share the single meter.
    let big_blob = vec![7u8; 1600];
    assert_eq!(
        upload_blob(&http, &token, &big_blob).await,
        reqwest::StatusCode::INSUFFICIENT_STORAGE
    );
    // A smaller blob that fits alongside the doc is granted.
    let small_blob = vec![9u8; 512];
    assert_eq!(upload_blob(&http, &token, &small_blob).await, reqwest::StatusCode::OK);
    let usage = get_usage(&http, &token).await;
    assert_eq!(usage["blobBytes"], 512);
    assert_eq!(
        usage["storageBytes"].as_u64().unwrap(),
        doc_bytes + 512,
        "combined meter: {usage}"
    );
}

#[tokio::test]
async fn doc_save_413_over_minted_max_doc_bytes() {
    let (_server, http, _ws_base, issuer, _tmp) = start_relay().await;
    let token =
        issuer.mint_with_max_doc_bytes("user-g", "eta", WorkspaceRole::Owner, Some(300));
    let usage = get_usage(&http, &token).await;
    assert_eq!(usage["maxDocBytes"], 300, "ceiling surfaces on usage: {usage}");

    // Over the per-document ceiling → 413 with the typed body.
    let resp = put_doc(&http, &token, "cap-doc", &doc_body("cap-doc", "user-g", 1024)).await;
    assert_eq!(resp.status(), reqwest::StatusCode::PAYLOAD_TOO_LARGE);
    let body: Value = resp.json().await.expect("typed 413 body");
    assert_eq!(body["errorCode"], "DOC_TOO_LARGE");
    assert_eq!(body["maxBytes"], 300);
    assert!(body["sizeBytes"].as_u64().unwrap() > 300);

    // Under the ceiling → lands.
    let resp = put_doc(&http, &token, "cap-doc", &doc_body("cap-doc", "user-g", 8)).await;
    assert_eq!(resp.status(), reqwest::StatusCode::OK);
}

/// The JP-443 observability series ride /metrics: the doc-bytes half of the
/// storage meter, the on-volume cache footprint, the over-cap snapshot
/// counter, and (on unix) the data-dir volume gauges.
#[tokio::test]
async fn metrics_expose_doc_bytes_and_volume_series() {
    let (_server, http, _ws_base, issuer, _tmp) = start_relay().await;
    let token = issuer.mint_with_limits("user-m", "mu", WorkspaceRole::Owner, None, None);
    let resp = put_doc(&http, &token, "metric-doc", &doc_body("metric-doc", "user-m", 64)).await;
    assert_eq!(resp.status(), reqwest::StatusCode::OK);
    let usage = get_usage(&http, &token).await;
    let doc_bytes = usage["docBytes"].as_u64().unwrap();

    let body = reqwest::Client::new()
        .get(format!("{http}/metrics"))
        .send()
        .await
        .expect("metrics request")
        .text()
        .await
        .expect("metrics body");
    assert!(
        body.contains(&format!("relay_doc_bytes_total {doc_bytes}")),
        "doc-bytes gauge must match usage: {body}"
    );
    assert!(body.contains("relay_doc_cache_bytes "), "cache footprint gauge: {body}");
    assert!(
        body.contains("relay_doc_over_cap_snapshots_total 0"),
        "over-cap counter present at 0: {body}"
    );
    #[cfg(unix)]
    {
        assert!(body.contains("relay_volume_total_bytes "), "volume total gauge: {body}");
        assert!(body.contains("relay_volume_used_bytes "), "volume used gauge: {body}");
        assert!(body.contains("relay_volume_available_bytes "), "volume avail gauge: {body}");
    }
}

/// Regression for the implicit Axum 2 MiB body limit (the doc-route sibling
/// of JP-125): an uncapped relay must accept a multi-MiB document body.
#[tokio::test]
async fn large_doc_body_not_413_by_default() {
    let (_server, http, _ws_base, issuer, _tmp) = start_relay().await;
    let token = issuer.mint_with_limits("user-h", "theta", WorkspaceRole::Owner, None, None);

    let resp =
        put_doc(&http, &token, "big-doc", &doc_body("big-doc", "user-h", 3 * 1024 * 1024)).await;
    assert_eq!(resp.status(), reqwest::StatusCode::OK, "3 MiB doc body must not 413");
    let usage = get_usage(&http, &token).await;
    assert!(usage["docBytes"].as_u64().unwrap() > 3 * 1024 * 1024);
}

/// Minimal WS client: connect + auth, returning the parsed `AUTH_RESPONSE`.
/// The auth payload is a JSON-encoded bare string (not `{"token": ...}`),
/// matching `handle_auth`. Lifted from `tests/metering_conn_counts.rs`.
struct WsClient {
    stream: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
}

impl WsClient {
    async fn connect(ws_base: &str) -> Self {
        let url = format!("{}/ws?protocolVersion={}", ws_base, PROTOCOL_VERSION);
        let (stream, _resp) = tokio_tungstenite::connect_async(&url)
            .await
            .expect("ws connect");
        Self { stream }
    }

    async fn auth(&mut self, token: &str) -> Value {
        let frame = encode_message(MESSAGE_AUTH, &token.to_string()).expect("encode auth");
        self.stream
            .send(WsMessage::Binary(frame))
            .await
            .expect("send auth");
        loop {
            let msg = self
                .stream
                .next()
                .await
                .expect("auth response stream end")
                .expect("auth response");
            if let WsMessage::Binary(bytes) = msg {
                if bytes.first().copied() == Some(MESSAGE_AUTH_RESPONSE) {
                    return serde_json::from_slice(&bytes[1..]).expect("auth response json");
                }
            }
        }
    }
}

/// The editor half of the single-meter model, end-to-end over a real WS:
/// the Nth + 1 **editor** connection is refused with `ERR_EDITOR_LIMIT` on
/// the `AUTH_RESPONSE`, while a **viewer** still joins even with the editor
/// cap full. Limit rides on the JWT `wsp[].editor_limit` claim — the same
/// path DocuShark Cloud mints — so this also covers claim → effective-limit
/// resolution for the editor axis. Complements the unit coverage of
/// `try_register_workspace_connection` with the live socket handshake.
#[tokio::test]
async fn ws_editor_cap_refuses_third_editor_but_viewer_still_joins() {
    let (_server, _http, ws_base, issuer, _tmp) = start_relay().await;

    // editor_limit: 2 minted onto the workspace claim. Owner + Member both
    // classify as editors (`is_editor = !matches!(role, Viewer)`).
    let ed1 = issuer.mint_with_limits("ed-1", "capped", WorkspaceRole::Owner, None, Some(2));
    let ed2 = issuer.mint_with_limits("ed-2", "capped", WorkspaceRole::Member, None, Some(2));
    let ed3 = issuer.mint_with_limits("ed-3", "capped", WorkspaceRole::Owner, None, Some(2));
    // Viewer carries the same editor_limit but is never counted against it.
    let viewer = issuer.mint_with_limits("vw-1", "capped", WorkspaceRole::Viewer, None, Some(2));

    // First two editors fill the cap. Keep the sockets in scope so the
    // workspace's editor slots stay held while we probe the 3rd.
    let mut e1 = WsClient::connect(&ws_base).await;
    assert_eq!(e1.auth(&ed1).await["success"], json!(true), "1st editor rejected");
    let mut e2 = WsClient::connect(&ws_base).await;
    assert_eq!(e2.auth(&ed2).await["success"], json!(true), "2nd editor rejected");

    // The 3rd editor is refused with ERR_EDITOR_LIMIT on AUTH_RESPONSE.
    let mut e3 = WsClient::connect(&ws_base).await;
    let denied = e3.auth(&ed3).await;
    assert_eq!(denied["success"], json!(false), "3rd editor should be capped: {denied}");
    assert_eq!(denied["error"], json!("ERR_EDITOR_LIMIT"), "wrong rejection code: {denied}");

    // A viewer still joins while the editor cap is full — viewers uncapped.
    let mut v = WsClient::connect(&ws_base).await;
    let joined = v.auth(&viewer).await;
    assert_eq!(joined["success"], json!(true), "viewer wrongly refused: {joined}");

    // Hold the editor sockets open until here so their slots were occupied
    // for the duration of the 3rd-editor + viewer probes.
    drop((e1, e2, e3, v));
}
