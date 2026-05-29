//! JP-120 — blob refcount + orphan GC, end-to-end over REST.
//!
//! Acceptance (from the issue): upload a blob, reference it from documents in
//! two workspaces, delete one → that workspace's ACL is released and its
//! `/api/v1/usage` storage drops, while the other workspace still reads the
//! blob; delete the second → the last ACL is gone and the bytes are reclaimed
//! (the blob 404s). Content-addressed bytes shared across workspaces survive
//! until the last reference drops.

use std::sync::Arc;

use docushark_relay::auth::WorkspaceRole;
use docushark_relay::config::{TenancyConfig, TenancyMode};
use docushark_relay::server::{NetworkMode, ServerConfig, WebSocketServer};
use docushark_relay::test_support::OidcTestIssuer;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tempfile::TempDir;

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
        .expect("upload")
        .status()
}

async fn blob_status(http: &str, token: &str, hash: &str) -> reqwest::StatusCode {
    reqwest::Client::new()
        .get(format!("{http}/api/blobs/{hash}"))
        .bearer_auth(token)
        .send()
        .await
        .expect("blob get")
        .status()
}

async fn put_doc(http: &str, token: &str, doc_id: &str, blob_refs: &[&str]) -> reqwest::StatusCode {
    let body = json!({ "id": doc_id, "blobReferences": blob_refs });
    reqwest::Client::new()
        .put(format!("{http}/api/docs/{doc_id}"))
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .expect("put doc")
        .status()
}

async fn delete_doc(http: &str, token: &str, doc_id: &str) -> reqwest::StatusCode {
    reqwest::Client::new()
        .delete(format!("{http}/api/docs/{doc_id}"))
        .bearer_auth(token)
        .send()
        .await
        .expect("delete doc")
        .status()
}

async fn usage_storage(http: &str, token: &str) -> u64 {
    let v: Value = reqwest::Client::new()
        .get(format!("{http}/api/v1/usage"))
        .bearer_auth(token)
        .send()
        .await
        .expect("usage")
        .json()
        .await
        .expect("usage json");
    v["storageBytes"].as_u64().expect("storageBytes")
}

#[tokio::test]
async fn deleting_a_doc_releases_acls_and_shared_blob_survives_until_last_drop() {
    let (_server, http, issuer, _tmp) = start_relay().await;
    let alpha = issuer.mint("user-a", "alpha", WorkspaceRole::Owner);
    let beta = issuer.mint("user-b", "beta", WorkspaceRole::Owner);

    let data = b"shared image bytes";
    let hash = blob_hash(data);

    // Same bytes uploaded to both workspaces (deduped on disk, one ACL each),
    // each referenced by a document in its workspace.
    assert_eq!(upload_blob(&http, &alpha, data).await, reqwest::StatusCode::OK);
    assert_eq!(upload_blob(&http, &beta, data).await, reqwest::StatusCode::OK);
    assert_eq!(put_doc(&http, &alpha, "docalpha", &[&hash]).await, reqwest::StatusCode::OK);
    assert_eq!(put_doc(&http, &beta, "docbeta", &[&hash]).await, reqwest::StatusCode::OK);

    assert_eq!(usage_storage(&http, &alpha).await, data.len() as u64);
    assert_eq!(usage_storage(&http, &beta).await, data.len() as u64);

    // Delete alpha's doc → alpha's ACL released (usage 0, blob 404 for alpha),
    // but beta still references it (blob still readable, bytes intact).
    assert_eq!(delete_doc(&http, &alpha, "docalpha").await, reqwest::StatusCode::OK);
    assert_eq!(usage_storage(&http, &alpha).await, 0);
    assert_eq!(blob_status(&http, &alpha, &hash).await, reqwest::StatusCode::NOT_FOUND);
    assert_eq!(blob_status(&http, &beta, &hash).await, reqwest::StatusCode::OK);
    assert_eq!(usage_storage(&http, &beta).await, data.len() as u64);

    // Delete beta's doc → last ACL gone → bytes reclaimed (404 for beta too).
    assert_eq!(delete_doc(&http, &beta, "docbeta").await, reqwest::StatusCode::OK);
    assert_eq!(usage_storage(&http, &beta).await, 0);
    assert_eq!(blob_status(&http, &beta, &hash).await, reqwest::StatusCode::NOT_FOUND);
}
