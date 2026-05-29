//! JP-125 — blob upload body limit. `POST /api/blobs/:hash` must honor
//! `[tenancy.limits].max_blob_bytes`, not Axum's silent 2 MiB default (which
//! 413'd any larger blob regardless of the workspace storage quota).

use std::sync::Arc;

use docushark_relay::auth::WorkspaceRole;
use docushark_relay::config::{LimitsConfig, TenancyConfig, TenancyMode};
use docushark_relay::server::{NetworkMode, ServerConfig, WebSocketServer};
use docushark_relay::test_support::OidcTestIssuer;
use sha2::{Digest, Sha256};
use tempfile::TempDir;

/// In-process relay in shared-tenancy mode with an explicit `max_blob_bytes`.
async fn start_relay(max_blob_bytes: usize) -> (Arc<WebSocketServer>, String, OidcTestIssuer, TempDir) {
    let tmp = tempfile::tempdir().expect("tempdir");
    let issuer = OidcTestIssuer::new().await;

    let server = Arc::new(WebSocketServer::new());
    server.set_app_data_dir(tmp.path().to_path_buf()).await;
    server.set_auth(issuer.auth_state()).await;
    server
        .set_tenancy(TenancyConfig {
            mode: TenancyMode::Shared,
            workspace_id: None,
            limits: LimitsConfig { max_blob_bytes, ..LimitsConfig::default() },
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

fn blob_hash(data: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(data);
    hex::encode(h.finalize())
}

async fn upload(http: &str, token: &str, data: &[u8]) -> reqwest::StatusCode {
    reqwest::Client::new()
        .post(format!("{http}/api/blobs/{}", blob_hash(data)))
        .bearer_auth(token)
        .body(data.to_vec())
        .send()
        .await
        .expect("blob upload request")
        .status()
}

#[tokio::test]
async fn blob_upload_enforces_configured_max_not_axum_default() {
    // Tiny cap so the test stays cheap; proves the *config* value gates the body.
    let (_server, http, issuer, _tmp) = start_relay(1024).await;
    let token = issuer.mint("user-a", "default", WorkspaceRole::Owner);

    // Under the cap → accepted.
    assert_eq!(upload(&http, &token, &vec![b'a'; 500]).await, reqwest::StatusCode::OK);

    // Over the cap → 413 (not silently dropped, not the 2 MiB default).
    assert_eq!(
        upload(&http, &token, &vec![b'b'; 2048]).await,
        reqwest::StatusCode::PAYLOAD_TOO_LARGE
    );
}

#[tokio::test]
async fn blob_upload_allows_over_2mib_when_cap_is_higher() {
    // The regression: a 3 MiB blob — which Axum's 2 MiB default would have
    // 413'd — now succeeds because the cap is 8 MiB.
    let (_server, http, issuer, _tmp) = start_relay(8 * 1024 * 1024).await;
    let token = issuer.mint("user-b", "default", WorkspaceRole::Owner);

    let three_mib = vec![b'c'; 3 * 1024 * 1024];
    assert_eq!(upload(&http, &token, &three_mib).await, reqwest::StatusCode::OK);
}
