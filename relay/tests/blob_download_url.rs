//! JP-129 Slice B — `POST /api/v1/blobs/:hash/download-url` wiring on the
//! filesystem backend (no presign): a malformed hash 400s and a well-formed
//! hash 409s `presign_unsupported`, so the web client falls back to the proxy
//! `GET /api/blobs/:hash`. The presigned 200/404 happy path needs object
//! storage and lives in the S3-gated `blob_presign_flow.rs`.

use std::sync::Arc;

use docushark_relay::auth::WorkspaceRole;
use docushark_relay::config::{LimitsConfig, TenancyConfig, TenancyMode};
use docushark_relay::server::{NetworkMode, ServerConfig, WebSocketServer};
use docushark_relay::test_support::OidcTestIssuer;
use tempfile::TempDir;

/// In-process relay on the default (filesystem) backend — `s3_backend()` is None.
async fn start_fs_relay() -> (Arc<WebSocketServer>, String, OidcTestIssuer, TempDir) {
    let tmp = tempfile::tempdir().expect("tempdir");
    let issuer = OidcTestIssuer::new().await;

    let server = Arc::new(WebSocketServer::new());
    server.set_app_data_dir(tmp.path().to_path_buf()).await;
    server.set_auth(issuer.auth_state()).await;
    server
        .set_tenancy(TenancyConfig {
            mode: TenancyMode::Shared,
            workspace_id: None,
            limits: LimitsConfig::default(),
        })
        .await;
    server
        .set_config(ServerConfig { port: 0, network_mode: NetworkMode::Localhost, max_connections: 0 })
        .await
        .expect("set_config");

    let bound = server.start(0).await.expect("start");
    let http = bound
        .strip_prefix("ws://")
        .map(|rest| format!("http://{rest}"))
        .unwrap_or(bound);
    (server, http, issuer, tmp)
}

async fn download_url_status(http: &str, token: &str, hash: &str) -> reqwest::StatusCode {
    reqwest::Client::new()
        .post(format!("{http}/api/v1/blobs/{hash}/download-url"))
        .bearer_auth(token)
        .send()
        .await
        .expect("download-url request")
        .status()
}

#[tokio::test]
async fn download_url_rejects_malformed_hash_400() {
    let (_server, http, issuer, _tmp) = start_fs_relay().await;
    let token = issuer.mint("user-a", "default", WorkspaceRole::Owner);
    assert_eq!(
        download_url_status(&http, &token, "not-a-valid-hash").await,
        reqwest::StatusCode::BAD_REQUEST,
    );
}

#[tokio::test]
async fn download_url_409_presign_unsupported_on_filesystem_backend() {
    let (_server, http, issuer, _tmp) = start_fs_relay().await;
    let token = issuer.mint("user-b", "default", WorkspaceRole::Owner);
    // Well-formed 64-hex hash → passes the format gate, then the filesystem
    // backend has no presign → 409 so the client proxies the GET instead.
    let hash = "a".repeat(64);
    assert_eq!(
        download_url_status(&http, &token, &hash).await,
        reqwest::StatusCode::CONFLICT,
    );
}
