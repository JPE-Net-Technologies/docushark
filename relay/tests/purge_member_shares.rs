//! JP-378 — auto-revoke a member's document shares, over the real REST surface.
//!
//! `POST /api/v1/internal/workspace/:ws/purge-member` drops a single user's
//! `sharedWith` grant from every document in the workspace. It is a generic,
//! membership-agnostic control-plane hook gated by the same shared bearer as the
//! revocation push (`revocation_push_bearer`). These tests exercise:
//!
//!   * the user is removed from every doc that shared with them, while other
//!     grants are kept verbatim — including their original `sharedAt`;
//!   * a doc the user was never shared on is left untouched (no version bump);
//!   * the bearer gate: wrong bearer → 401, transport disabled → 503;
//!   * a malformed workspace id → 400 (the path-traversal guard).

use std::sync::Arc;

use docushark_relay::auth::WorkspaceRole;
use docushark_relay::config::{TenancyConfig, TenancyMode};
use docushark_relay::server::{NetworkMode, ServerConfig, WebSocketServer};
use docushark_relay::test_support::OidcTestIssuer;
use serde_json::{json, Value};
use tempfile::TempDir;

const PUSH_BEARER: &str = "test-purge-bearer";

/// In-process relay in shared-tenancy mode. `bearer` is the control-plane push
/// secret — set *before* `start()` so it's captured into `ServerState`. Pass
/// `None` to leave the internal transport disabled (503 path).
async fn start_relay(
    bearer: Option<&str>,
) -> (Arc<WebSocketServer>, String, OidcTestIssuer, TempDir) {
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
        .set_revocation_push_bearer(bearer.map(str::to_string))
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
    let http = bound
        .strip_prefix("ws://")
        .map(|rest| format!("http://{rest}"))
        .unwrap_or(bound);

    (server, http, issuer, tmp)
}

/// One share grant in `sharedWith` (camelCase, matching `DocumentShare`).
fn share(user_id: &str, permission: &str, shared_at: u64) -> Value {
    json!({
        "userId": user_id,
        "userName": user_id,
        "permission": permission,
        "sharedAt": shared_at,
    })
}

/// Seed a document via the REST save handler with the given `sharedWith` array.
async fn save_doc(http: &str, token: &str, id: &str, shares: Vec<Value>) {
    let status = reqwest::Client::new()
        .put(format!("{http}/api/docs/{id}"))
        .bearer_auth(token)
        .json(&json!({
            "id": id,
            "name": id,
            "ownerId": "owner-1",
            "sharedWith": shares,
        }))
        .send()
        .await
        .expect("save request")
        .status();
    assert_eq!(status, reqwest::StatusCode::OK, "seed save for {id} failed");
}

/// Fetch a document body.
async fn get_doc(http: &str, token: &str, id: &str) -> Value {
    reqwest::Client::new()
        .get(format!("{http}/api/docs/{id}"))
        .bearer_auth(token)
        .send()
        .await
        .expect("get request")
        .json()
        .await
        .expect("get json")
}

/// The set of user ids currently in a doc's `sharedWith`.
fn shared_user_ids(doc: &Value) -> Vec<String> {
    doc.get("sharedWith")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|e| e.get("userId").and_then(|u| u.as_str()).map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

async fn purge(
    http: &str,
    bearer: &str,
    ws: &str,
    user_id: &str,
) -> (reqwest::StatusCode, Value) {
    let resp = reqwest::Client::new()
        .post(format!("{http}/api/v1/internal/workspace/{ws}/purge-member"))
        .bearer_auth(bearer)
        .json(&json!({ "user_id": user_id }))
        .send()
        .await
        .expect("purge request");
    let status = resp.status();
    let body = resp.json().await.unwrap_or(Value::Null);
    (status, body)
}

#[tokio::test]
async fn purge_removes_user_everywhere_and_keeps_other_grants_verbatim() {
    let (_server, http, issuer, _tmp) = start_relay(Some(PUSH_BEARER)).await;
    let owner = issuer.mint("owner-1", "alpha", WorkspaceRole::Owner);

    // doc1: shared with X (edit) and Y (view, sharedAt=222); doc2: X only;
    // doc3: Y only (X never on it → must be left untouched, no version bump).
    save_doc(&http, &owner, "doc1", vec![
        share("user-x", "edit", 111),
        share("user-y", "view", 222),
    ]).await;
    save_doc(&http, &owner, "doc2", vec![share("user-x", "view", 333)]).await;
    save_doc(&http, &owner, "doc3", vec![share("user-y", "edit", 444)]).await;

    let doc3_before = get_doc(&http, &owner, "doc3").await;
    let doc3_ver_before = doc3_before.get("serverVersion").cloned();

    let (status, body) = purge(&http, PUSH_BEARER, "alpha", "user-x").await;
    assert_eq!(status, reqwest::StatusCode::OK);
    assert_eq!(body["purged"], json!(2), "should have touched exactly doc1 + doc2");

    // doc1: X gone, Y retained with its ORIGINAL sharedAt (not rebuilt to `now`).
    let doc1 = get_doc(&http, &owner, "doc1").await;
    assert_eq!(shared_user_ids(&doc1), vec!["user-y".to_string()]);
    let y = &doc1["sharedWith"][0];
    assert_eq!(y["sharedAt"], json!(222), "remaining grant's timestamp must be preserved");
    assert_eq!(y["permission"], json!("view"));

    // doc2: X was the only grant → now empty.
    let doc2 = get_doc(&http, &owner, "doc2").await;
    assert!(shared_user_ids(&doc2).is_empty());

    // doc3: untouched — Y still present and serverVersion unchanged (no save).
    let doc3 = get_doc(&http, &owner, "doc3").await;
    assert_eq!(shared_user_ids(&doc3), vec!["user-y".to_string()]);
    assert_eq!(
        doc3.get("serverVersion").cloned(),
        doc3_ver_before,
        "a doc the user was never shared on must not be re-saved"
    );
}

#[tokio::test]
async fn purge_is_idempotent() {
    let (_server, http, issuer, _tmp) = start_relay(Some(PUSH_BEARER)).await;
    let owner = issuer.mint("owner-1", "alpha", WorkspaceRole::Owner);
    save_doc(&http, &owner, "doc1", vec![share("user-x", "edit", 111)]).await;

    let (s1, b1) = purge(&http, PUSH_BEARER, "alpha", "user-x").await;
    assert_eq!(s1, reqwest::StatusCode::OK);
    assert_eq!(b1["purged"], json!(1));

    // Second run: nothing left to drop.
    let (s2, b2) = purge(&http, PUSH_BEARER, "alpha", "user-x").await;
    assert_eq!(s2, reqwest::StatusCode::OK);
    assert_eq!(b2["purged"], json!(0));
}

#[tokio::test]
async fn purge_rejects_wrong_bearer() {
    let (_server, http, issuer, _tmp) = start_relay(Some(PUSH_BEARER)).await;
    let owner = issuer.mint("owner-1", "alpha", WorkspaceRole::Owner);
    save_doc(&http, &owner, "doc1", vec![share("user-x", "edit", 111)]).await;

    let (status, _) = purge(&http, "not-the-bearer", "alpha", "user-x").await;
    assert_eq!(status, reqwest::StatusCode::UNAUTHORIZED);

    // The grant is untouched after the rejected call.
    let doc1 = get_doc(&http, &owner, "doc1").await;
    assert_eq!(shared_user_ids(&doc1), vec!["user-x".to_string()]);
}

#[tokio::test]
async fn purge_returns_503_when_transport_disabled() {
    // No push bearer configured → the internal endpoint is unavailable.
    let (_server, http, _issuer, _tmp) = start_relay(None).await;
    let (status, _) = purge(&http, PUSH_BEARER, "alpha", "user-x").await;
    assert_eq!(status, reqwest::StatusCode::SERVICE_UNAVAILABLE);
}

#[tokio::test]
async fn purge_rejects_malformed_workspace_id() {
    let (_server, http, _issuer, _tmp) = start_relay(Some(PUSH_BEARER)).await;
    // "a..b" is a single valid URL segment but fails workspace-id validation
    // (contains ".."), so it never reaches the document store as a path.
    let (status, _) = purge(&http, PUSH_BEARER, "a..b", "user-x").await;
    assert_eq!(status, reqwest::StatusCode::BAD_REQUEST);
}
