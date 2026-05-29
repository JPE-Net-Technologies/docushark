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
use docushark_relay::server::{NetworkMode, ServerConfig, WebSocketServer};
use docushark_relay::test_support::OidcTestIssuer;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tempfile::TempDir;

/// In-process relay in shared-tenancy mode. Returns the HTTP base and the
/// issuer (kept alive so its JWKS endpoint keeps serving verification keys).
async fn start_relay() -> (Arc<WebSocketServer>, String, OidcTestIssuer, TempDir) {
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
    let http = bound
        .strip_prefix("ws://")
        .map(|rest| format!("http://{rest}"))
        .unwrap_or(bound);

    (server, http, issuer, tmp)
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
    let (_server, http, issuer, _tmp) = start_relay().await;

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
    let (_server, http, issuer, _tmp) = start_relay().await;
    // No limits minted + config default 0 → unlimited → null on the wire.
    let token = issuer.mint_with_limits("user-c", "gamma", WorkspaceRole::Owner, None, None);
    let usage = get_usage(&http, &token).await;
    assert!(usage["storageQuota"].is_null());
    assert!(usage["editorLimit"].is_null());
    assert_eq!(usage["storageBytes"], 0);
}

#[tokio::test]
async fn blob_upload_returns_507_over_quota_but_dedup_reupload_is_free() {
    let (_server, http, issuer, _tmp) = start_relay().await;
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
