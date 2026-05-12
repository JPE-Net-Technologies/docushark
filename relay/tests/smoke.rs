//! End-to-end smoke test for `diagrammer-relay`.
//!
//! Builds the relay in-process on an OS-assigned port, hits the HTTP
//! API with `reqwest`, and asserts that register / login / docs CRUD
//! round-trips cleanly. Library-level — no `cargo run` subprocess —
//! so CI is deterministic.
//!
//! Mirrors `relay init && relay serve` from the binary path: a fresh
//! `RelayConfig::fresh()` seeds the JWT secret, a tempdir hosts the
//! filesystem storage, and `WebSocketServer::start(0)` lets the OS
//! pick a free port. Phase 20.3 Slice G.2.

use std::sync::Arc;

use diagrammer_relay::auth::UserStore;
use diagrammer_relay::config::RelayConfig;
use diagrammer_relay::server::{NetworkMode, ServerConfig, WebSocketServer};
use serde_json::json;
use tempfile::TempDir;

/// Standing harness for one test run.
struct RelayHarness {
    base: String,
    server: Arc<WebSocketServer>,
    _tmp: TempDir,
}

impl RelayHarness {
    async fn start() -> Self {
        let tmp = tempfile::tempdir().expect("tempdir");
        let data_dir = tmp.path().to_path_buf();

        // `relay init` parity: fresh JWT secret in TOML format.
        let config = RelayConfig::fresh();
        std::fs::write(
            data_dir.join("relay.toml"),
            config.to_toml_string().expect("toml"),
        )
        .expect("write relay.toml");

        let user_store = Arc::new(UserStore::with_persistence(
            data_dir.join("users.json").to_string_lossy().into_owned(),
        ));

        let server = Arc::new(WebSocketServer::new());
        server.set_app_data_dir(data_dir.clone()).await;
        server.set_user_store(user_store).await;
        server.set_jwt_secret(config.auth.jwt_secret.clone()).await;
        server
            .set_config(ServerConfig {
                port: 0,
                network_mode: NetworkMode::Localhost,
                max_connections: 0,
            })
            .await
            .expect("set_config");

        // port=0 -> OS-assigned. The bound address comes back as a
        // ws://host:port string; we want http://host:port for REST.
        let bound = server.start(0).await.expect("start");
        let http = bound
            .strip_prefix("ws://")
            .map(|rest| format!("http://{rest}"))
            .unwrap_or(bound);

        RelayHarness {
            base: http,
            server,
            _tmp: tmp,
        }
    }

    async fn stop(self) {
        self.server.stop().await.expect("stop");
    }
}

#[tokio::test]
async fn relay_register_login_docs_roundtrip() {
    let harness = RelayHarness::start().await;
    let client = reqwest::Client::new();

    // ---- register ----
    let res = client
        .post(format!("{}/api/auth/register", harness.base))
        .json(&json!({
            "username": "alice",
            "password": "correct-horse",
            "displayName": "Alice"
        }))
        .send()
        .await
        .expect("register POST");
    assert_eq!(res.status().as_u16(), 201, "register should return 201");
    let body: serde_json::Value = res.json().await.expect("register body");
    assert_eq!(body["user"]["username"], "alice");
    // First-ever user is promoted to admin so a fresh deploy can self-bootstrap.
    assert_eq!(body["user"]["role"], "admin");

    // ---- register duplicate ----
    let res = client
        .post(format!("{}/api/auth/register", harness.base))
        .json(&json!({
            "username": "alice",
            "password": "correct-horse"
        }))
        .send()
        .await
        .expect("duplicate register POST");
    assert_eq!(
        res.status().as_u16(),
        409,
        "duplicate username must return 409"
    );

    // ---- login ----
    let res = client
        .post(format!("{}/api/auth/login", harness.base))
        .json(&json!({
            "username": "alice",
            "password": "correct-horse"
        }))
        .send()
        .await
        .expect("login POST");
    assert_eq!(res.status().as_u16(), 200, "login should return 200");
    let body: serde_json::Value = res.json().await.expect("login body");
    let token = body["token"]
        .as_str()
        .expect("login response must include a token")
        .to_string();
    assert!(!token.is_empty());

    let bearer = format!("Bearer {token}");

    // ---- me (authed) ----
    let res = client
        .get(format!("{}/api/auth/me", harness.base))
        .header(reqwest::header::AUTHORIZATION, &bearer)
        .send()
        .await
        .expect("me GET");
    assert_eq!(res.status().as_u16(), 200);
    let body: serde_json::Value = res.json().await.expect("me body");
    assert_eq!(body["user"]["username"], "alice");

    // ---- me (unauthed) ----
    let res = client
        .get(format!("{}/api/auth/me", harness.base))
        .send()
        .await
        .expect("me GET (no auth)");
    assert_eq!(res.status().as_u16(), 401);

    // ---- list docs (empty) ----
    let res = client
        .get(format!("{}/api/docs", harness.base))
        .header(reqwest::header::AUTHORIZATION, &bearer)
        .send()
        .await
        .expect("list GET");
    assert_eq!(res.status().as_u16(), 200);
    let body: serde_json::Value = res.json().await.expect("list body");
    assert_eq!(body["documents"].as_array().map(|a| a.len()), Some(0));

    // ---- save doc ----
    let res = client
        .put(format!("{}/api/docs/doc-1", harness.base))
        .header(reqwest::header::AUTHORIZATION, &bearer)
        .json(&json!({
            "id": "doc-1",
            "name": "Smoke Doc",
            "version": 1,
            "pages": [],
            "createdAt": 1000,
            "modifiedAt": 1000
        }))
        .send()
        .await
        .expect("save PUT");
    assert_eq!(res.status().as_u16(), 200);
    let body: serde_json::Value = res.json().await.expect("save body");
    assert_eq!(body["success"], true);

    // ---- save with mismatched body id rejected ----
    let res = client
        .put(format!("{}/api/docs/doc-1", harness.base))
        .header(reqwest::header::AUTHORIZATION, &bearer)
        .json(&json!({ "id": "different", "name": "x" }))
        .send()
        .await
        .expect("save mismatched id");
    assert_eq!(res.status().as_u16(), 400);

    // ---- list docs (one) ----
    let res = client
        .get(format!("{}/api/docs", harness.base))
        .header(reqwest::header::AUTHORIZATION, &bearer)
        .send()
        .await
        .expect("list GET 2");
    assert_eq!(res.status().as_u16(), 200);
    let body: serde_json::Value = res.json().await.expect("list body 2");
    let docs = body["documents"].as_array().expect("documents array");
    assert_eq!(docs.len(), 1);
    assert_eq!(docs[0]["id"], "doc-1");
    assert_eq!(docs[0]["name"], "Smoke Doc");

    // ---- get doc ----
    let res = client
        .get(format!("{}/api/docs/doc-1", harness.base))
        .header(reqwest::header::AUTHORIZATION, &bearer)
        .send()
        .await
        .expect("get GET");
    assert_eq!(res.status().as_u16(), 200);
    let body: serde_json::Value = res.json().await.expect("get body");
    assert_eq!(body["id"], "doc-1");
    assert_eq!(body["name"], "Smoke Doc");

    // ---- delete doc ----
    let res = client
        .delete(format!("{}/api/docs/doc-1", harness.base))
        .header(reqwest::header::AUTHORIZATION, &bearer)
        .send()
        .await
        .expect("delete DELETE");
    assert_eq!(res.status().as_u16(), 200);

    // ---- list empty again ----
    let res = client
        .get(format!("{}/api/docs", harness.base))
        .header(reqwest::header::AUTHORIZATION, &bearer)
        .send()
        .await
        .expect("list GET 3");
    let body: serde_json::Value = res.json().await.expect("list body 3");
    assert_eq!(
        body["documents"].as_array().map(|a| a.len()),
        Some(0),
        "doc should be gone after DELETE"
    );

    // ---- /health unauthenticated ----
    let res = client
        .get(format!("{}/health", harness.base))
        .send()
        .await
        .expect("health");
    assert_eq!(res.status().as_u16(), 200);

    harness.stop().await;
}

#[tokio::test]
async fn relay_rejects_short_passwords() {
    let harness = RelayHarness::start().await;
    let client = reqwest::Client::new();

    let res = client
        .post(format!("{}/api/auth/register", harness.base))
        .json(&json!({
            "username": "shorty",
            "password": "tiny"
        }))
        .send()
        .await
        .expect("register POST");
    assert_eq!(res.status().as_u16(), 400);

    harness.stop().await;
}

#[tokio::test]
async fn relay_rejects_invalid_credentials() {
    let harness = RelayHarness::start().await;
    let client = reqwest::Client::new();

    // Pre-register a user.
    client
        .post(format!("{}/api/auth/register", harness.base))
        .json(&json!({"username": "bob", "password": "correct-horse"}))
        .send()
        .await
        .expect("register");

    let res = client
        .post(format!("{}/api/auth/login", harness.base))
        .json(&json!({"username": "bob", "password": "WRONG"}))
        .send()
        .await
        .expect("login");
    assert_eq!(res.status().as_u16(), 401);

    harness.stop().await;
}
