//! Integration tests for the `/api/collections` registry surface (JP-424).
//!
//! Builds the relay in-process (same harness pattern as `smoke.rs`) and
//! exercises the optimistic-concurrency handshake end to end: versioned GET,
//! conditional PUT, the 409 conflict shape, and the sanitize gate.

use std::sync::Arc;

use docushark_relay::auth::WorkspaceRole;
use docushark_relay::server::{NetworkMode, ServerConfig, WebSocketServer};
use docushark_relay::test_support::OidcTestIssuer;
use serde_json::json;
use tempfile::TempDir;

struct RelayHarness {
    base: String,
    issuer: OidcTestIssuer,
    server: Arc<WebSocketServer>,
    _tmp: TempDir,
}

impl RelayHarness {
    async fn start() -> Self {
        let tmp = tempfile::tempdir().expect("tempdir");
        let issuer = OidcTestIssuer::new().await;

        let server = Arc::new(WebSocketServer::new());
        server.set_app_data_dir(tmp.path().to_path_buf()).await;
        server.set_auth(issuer.auth_state()).await;
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

        RelayHarness {
            base: http,
            issuer,
            server,
            _tmp: tmp,
        }
    }

    fn token(&self, sub: &str) -> String {
        self.issuer.mint(sub, "default", WorkspaceRole::Owner)
    }

    async fn stop(self) {
        self.server.stop().await.expect("stop");
    }
}

fn def(id: &str, name: &str, order: i64) -> serde_json::Value {
    json!({ "id": id, "name": name, "order": order })
}

#[tokio::test]
async fn collections_versioned_put_roundtrip_and_conflict() {
    let harness = RelayHarness::start().await;
    let client = reqwest::Client::new();
    let bearer = format!("Bearer {}", harness.token("alice"));
    let url = format!("{}/api/collections", harness.base);

    // Cold GET: empty set, version 0.
    let res = client
        .get(&url)
        .header(reqwest::header::AUTHORIZATION, &bearer)
        .send()
        .await
        .expect("get empty");
    assert_eq!(res.status().as_u16(), 200);
    let body: serde_json::Value = res.json().await.unwrap();
    assert_eq!(body["collections"].as_array().map(|a| a.len()), Some(0));
    assert_eq!(body["version"], 0);

    // Legacy blind PUT (no expectedVersion) lands and bumps to v1.
    let res = client
        .put(&url)
        .header(reqwest::header::AUTHORIZATION, &bearer)
        .json(&json!({ "collections": [def("a", "Alpha", 0)] }))
        .send()
        .await
        .expect("blind put");
    assert_eq!(res.status().as_u16(), 200);
    let body: serde_json::Value = res.json().await.unwrap();
    assert_eq!(body["success"], true);
    assert_eq!(body["newVersion"], 1);

    // GET reflects the write and its version.
    let res = client
        .get(&url)
        .header(reqwest::header::AUTHORIZATION, &bearer)
        .send()
        .await
        .expect("get v1");
    let body: serde_json::Value = res.json().await.unwrap();
    assert_eq!(body["version"], 1);
    assert_eq!(body["collections"][0]["id"], "a");

    // Stale expectedVersion ⇒ 409 with the doc-save conflict keys plus the
    // current set; the store is untouched.
    let res = client
        .put(&url)
        .header(reqwest::header::AUTHORIZATION, &bearer)
        .json(&json!({ "collections": [def("b", "Beta", 0)], "expectedVersion": 0 }))
        .send()
        .await
        .expect("stale put");
    assert_eq!(res.status().as_u16(), 409);
    let body: serde_json::Value = res.json().await.unwrap();
    assert_eq!(body["errorCode"], "VERSION_CONFLICT");
    assert_eq!(body["currentVersion"], 1);
    assert_eq!(body["collections"][0]["id"], "a");

    // Matching expectedVersion ⇒ accepted, v2.
    let res = client
        .put(&url)
        .header(reqwest::header::AUTHORIZATION, &bearer)
        .json(&json!({ "collections": [def("b", "Beta", 0)], "expectedVersion": 1 }))
        .send()
        .await
        .expect("conditional put");
    assert_eq!(res.status().as_u16(), 200);
    let body: serde_json::Value = res.json().await.unwrap();
    assert_eq!(body["newVersion"], 2);

    harness.stop().await;
}

#[tokio::test]
async fn collections_put_sanitizes_and_rejects() {
    let harness = RelayHarness::start().await;
    let client = reqwest::Client::new();
    let bearer = format!("Bearer {}", harness.token("alice"));
    let url = format!("{}/api/collections", harness.base);

    // Duplicate ids are healed keep-first, not rejected.
    let res = client
        .put(&url)
        .header(reqwest::header::AUTHORIZATION, &bearer)
        .json(&json!({ "collections": [def("a", "First", 0), def("a", "Second", 1)] }))
        .send()
        .await
        .expect("dupe put");
    assert_eq!(res.status().as_u16(), 200);
    let res = client
        .get(&url)
        .header(reqwest::header::AUTHORIZATION, &bearer)
        .send()
        .await
        .expect("get after dupe");
    let body: serde_json::Value = res.json().await.unwrap();
    let listed = body["collections"].as_array().unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0]["name"], "First");

    // Empty name ⇒ 400, nothing written (version unchanged).
    let res = client
        .put(&url)
        .header(reqwest::header::AUTHORIZATION, &bearer)
        .json(&json!({ "collections": [def("b", "   ", 0)] }))
        .send()
        .await
        .expect("bad name put");
    assert_eq!(res.status().as_u16(), 400);

    // Over the per-workspace cap ⇒ 400.
    let too_many: Vec<serde_json::Value> =
        (0..=200).map(|i| def(&format!("c{i}"), "N", i)).collect();
    let res = client
        .put(&url)
        .header(reqwest::header::AUTHORIZATION, &bearer)
        .json(&json!({ "collections": too_many }))
        .send()
        .await
        .expect("over cap put");
    assert_eq!(res.status().as_u16(), 400);

    // Registry still at the healed single entry, version 1.
    let res = client
        .get(&url)
        .header(reqwest::header::AUTHORIZATION, &bearer)
        .send()
        .await
        .expect("final get");
    let body: serde_json::Value = res.json().await.unwrap();
    assert_eq!(body["version"], 1);
    assert_eq!(body["collections"].as_array().map(|a| a.len()), Some(1));

    harness.stop().await;
}
