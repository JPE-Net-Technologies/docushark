//! End-to-end smoke test for `docushark-relay`.
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

use docushark_relay::auth::UserStore;
use docushark_relay::config::RelayConfig;
use docushark_relay::server::{NetworkMode, ServerConfig, WebSocketServer};
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
    // First save => serverVersion 1.
    assert_eq!(body["newVersion"], 1);

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

/// Helper: register + login a fresh user, return the bearer header.
async fn login_user(
    client: &reqwest::Client,
    base: &str,
    username: &str,
    password: &str,
) -> String {
    client
        .post(format!("{}/api/auth/register", base))
        .json(&json!({"username": username, "password": password}))
        .send()
        .await
        .expect("register");
    let res = client
        .post(format!("{}/api/auth/login", base))
        .json(&json!({"username": username, "password": password}))
        .send()
        .await
        .expect("login");
    let body: serde_json::Value = res.json().await.expect("login body");
    format!(
        "Bearer {}",
        body["token"].as_str().expect("token in login response")
    )
}

#[tokio::test]
async fn relay_save_version_conflict_returns_409() {
    let harness = RelayHarness::start().await;
    let client = reqwest::Client::new();
    let bearer = login_user(&client, &harness.base, "alice", "correct-horse").await;

    // First save => v1.
    let res = client
        .put(format!("{}/api/docs/doc-v", harness.base))
        .header(reqwest::header::AUTHORIZATION, &bearer)
        .json(&json!({"id": "doc-v", "name": "V", "pages": []}))
        .send()
        .await
        .expect("save v1");
    assert_eq!(res.status().as_u16(), 200);
    let body: serde_json::Value = res.json().await.expect("v1 body");
    assert_eq!(body["newVersion"], 1);

    // Save with expectedVersion=1 succeeds => v2.
    let res = client
        .put(format!(
            "{}/api/docs/doc-v?expectedVersion=1",
            harness.base
        ))
        .header(reqwest::header::AUTHORIZATION, &bearer)
        .json(&json!({"id": "doc-v", "name": "V edited", "pages": []}))
        .send()
        .await
        .expect("save v2");
    assert_eq!(res.status().as_u16(), 200);
    let body: serde_json::Value = res.json().await.expect("v2 body");
    assert_eq!(body["newVersion"], 2);

    // Save with stale expectedVersion=1 => 409.
    let res = client
        .put(format!(
            "{}/api/docs/doc-v?expectedVersion=1",
            harness.base
        ))
        .header(reqwest::header::AUTHORIZATION, &bearer)
        .json(&json!({"id": "doc-v", "name": "V stale", "pages": []}))
        .send()
        .await
        .expect("save stale");
    assert_eq!(res.status().as_u16(), 409);
    let body: serde_json::Value = res.json().await.expect("conflict body");
    assert_eq!(body["errorCode"], "VERSION_CONFLICT");
    assert_eq!(body["currentVersion"], 2);

    // GET should still reflect v2 with serverVersion in the doc body.
    let res = client
        .get(format!("{}/api/docs/doc-v", harness.base))
        .header(reqwest::header::AUTHORIZATION, &bearer)
        .send()
        .await
        .expect("get doc");
    let body: serde_json::Value = res.json().await.expect("get body");
    assert_eq!(body["serverVersion"], 2);
    assert_eq!(body["name"], "V edited");

    harness.stop().await;
}

#[tokio::test]
async fn relay_share_endpoint_grants_access() {
    let harness = RelayHarness::start().await;
    let client = reqwest::Client::new();
    let owner = login_user(&client, &harness.base, "alice", "correct-horse").await;

    // Owner creates a doc.
    client
        .put(format!("{}/api/docs/share-doc", harness.base))
        .header(reqwest::header::AUTHORIZATION, &owner)
        .json(&json!({
            "id": "share-doc",
            "name": "Shared",
            "ownerId": "alice-id",
            "pages": []
        }))
        .send()
        .await
        .expect("create");

    // Share with bob as editor.
    let res = client
        .post(format!("{}/api/docs/share-doc/share", harness.base))
        .header(reqwest::header::AUTHORIZATION, &owner)
        .json(&json!({
            "shares": [
                {"userId": "bob-id", "userName": "Bob", "permission": "editor"}
            ]
        }))
        .send()
        .await
        .expect("share POST");
    assert_eq!(res.status().as_u16(), 200);
    let body: serde_json::Value = res.json().await.expect("share body");
    assert_eq!(body["success"], true);

    // GET reflects the new share entry.
    let res = client
        .get(format!("{}/api/docs/share-doc", harness.base))
        .header(reqwest::header::AUTHORIZATION, &owner)
        .send()
        .await
        .expect("get");
    let body: serde_json::Value = res.json().await.expect("get body");
    let shares = body["sharedWith"].as_array().expect("sharedWith array");
    assert_eq!(shares.len(), 1);
    assert_eq!(shares[0]["userId"], "bob-id");
    assert_eq!(shares[0]["permission"], "editor");

    harness.stop().await;
}

#[tokio::test]
async fn relay_transfer_endpoint_moves_ownership() {
    let harness = RelayHarness::start().await;
    let client = reqwest::Client::new();
    let owner = login_user(&client, &harness.base, "alice", "correct-horse").await;

    // Owner's user id, pulled from /api/auth/me — needed because doc
    // ownerId must match the claims sub for transfer-permission check.
    let res = client
        .get(format!("{}/api/auth/me", harness.base))
        .header(reqwest::header::AUTHORIZATION, &owner)
        .send()
        .await
        .expect("me");
    let body: serde_json::Value = res.json().await.expect("me body");
    let alice_id = body["user"]["id"].as_str().expect("alice id").to_string();

    // Create doc owned by alice.
    client
        .put(format!("{}/api/docs/xfer-doc", harness.base))
        .header(reqwest::header::AUTHORIZATION, &owner)
        .json(&json!({
            "id": "xfer-doc",
            "name": "Transferable",
            "ownerId": alice_id,
            "ownerName": "Alice",
            "pages": []
        }))
        .send()
        .await
        .expect("create");

    // Transfer to carol.
    let res = client
        .post(format!("{}/api/docs/xfer-doc/transfer", harness.base))
        .header(reqwest::header::AUTHORIZATION, &owner)
        .json(&json!({
            "newOwnerId": "carol-id",
            "newOwnerName": "Carol"
        }))
        .send()
        .await
        .expect("transfer POST");
    assert_eq!(res.status().as_u16(), 200);

    // GET reflects new owner.
    let res = client
        .get(format!("{}/api/docs/xfer-doc", harness.base))
        .header(reqwest::header::AUTHORIZATION, &owner)
        .send()
        .await
        .expect("get");
    let body: serde_json::Value = res.json().await.expect("get body");
    assert_eq!(body["ownerId"], "carol-id");
    assert_eq!(body["ownerName"], "Carol");

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

#[tokio::test]
async fn relay_change_password_roundtrip() {
    let harness = RelayHarness::start().await;
    let client = reqwest::Client::new();

    let bearer = login_user(&client, &harness.base, "carol", "first-password").await;

    // Wrong current password is rejected.
    let res = client
        .post(format!("{}/api/auth/password", harness.base))
        .header(reqwest::header::AUTHORIZATION, &bearer)
        .json(&json!({
            "currentPassword": "WRONG",
            "newPassword": "second-password",
        }))
        .send()
        .await
        .expect("change wrong-current");
    assert_eq!(res.status().as_u16(), 401);

    // Short new password is rejected.
    let res = client
        .post(format!("{}/api/auth/password", harness.base))
        .header(reqwest::header::AUTHORIZATION, &bearer)
        .json(&json!({
            "currentPassword": "first-password",
            "newPassword": "tiny",
        }))
        .send()
        .await
        .expect("change short-new");
    assert_eq!(res.status().as_u16(), 400);

    // Unauthenticated is rejected.
    let res = client
        .post(format!("{}/api/auth/password", harness.base))
        .json(&json!({
            "currentPassword": "first-password",
            "newPassword": "second-password",
        }))
        .send()
        .await
        .expect("change unauthed");
    assert_eq!(res.status().as_u16(), 401);

    // Happy path.
    let res = client
        .post(format!("{}/api/auth/password", harness.base))
        .header(reqwest::header::AUTHORIZATION, &bearer)
        .json(&json!({
            "currentPassword": "first-password",
            "newPassword": "second-password",
        }))
        .send()
        .await
        .expect("change happy");
    assert_eq!(res.status().as_u16(), 200);

    // Old password no longer works.
    let res = client
        .post(format!("{}/api/auth/login", harness.base))
        .json(&json!({"username": "carol", "password": "first-password"}))
        .send()
        .await
        .expect("relogin old");
    assert_eq!(res.status().as_u16(), 401);

    // New password works.
    let res = client
        .post(format!("{}/api/auth/login", harness.base))
        .json(&json!({"username": "carol", "password": "second-password"}))
        .send()
        .await
        .expect("relogin new");
    assert_eq!(res.status().as_u16(), 200);

    harness.stop().await;
}
