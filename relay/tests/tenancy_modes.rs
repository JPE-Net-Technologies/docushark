//! Phase 21.5 integration tests for `[tenancy].mode`.
//!
//! These tests bypass the registration endpoint to seed users with
//! specific `workspace_id` values — `register_handler` always assigns
//! `"default"` today, so multi-workspace fixtures need direct
//! `UserStore::add_user` writes. The tokens are issued by the real
//! `/api/auth/login` flow so they carry a genuine `wsp` claim end-to-end.

use std::sync::Arc;

use docushark_relay::auth::{
    hash_password, User, UserRole, UserStore,
};
use docushark_relay::config::{RelayConfig, TenancyConfig, TenancyMode};
use docushark_relay::server::{NetworkMode, ServerConfig, WebSocketServer};
use serde_json::{json, Value};
use tempfile::TempDir;

struct Harness {
    base: String,
    server: Arc<WebSocketServer>,
    user_store: Arc<UserStore>,
    _tmp: TempDir,
}

impl Harness {
    async fn start(tenancy: TenancyConfig) -> Self {
        let tmp = tempfile::tempdir().expect("tempdir");
        let data_dir = tmp.path().to_path_buf();
        let config = RelayConfig::fresh();

        let user_store = Arc::new(UserStore::with_persistence(
            data_dir.join("users.json").to_string_lossy().into_owned(),
        ));

        let server = Arc::new(WebSocketServer::new());
        server.set_app_data_dir(data_dir.clone()).await;
        server.set_user_store(user_store.clone()).await;
        server.set_jwt_secret(config.auth.jwt_secret.clone()).await;
        server.set_tenancy(tenancy).await;
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

        Self {
            base: http,
            server,
            user_store,
            _tmp: tmp,
        }
    }

    fn seed_user(&self, username: &str, workspace_id: Option<&str>) {
        let user = User {
            id: nanoid::nanoid!(),
            display_name: username.to_string(),
            username: username.to_string(),
            password_hash: hash_password("test-password-123")
                .expect("hash"),
            role: UserRole::User,
            created_at: 0,
            last_login_at: None,
            workspace_id: workspace_id.map(|s| s.to_string()),
        };
        self.user_store.add_user(user).expect("add_user");
    }

    async fn login_token(&self, username: &str) -> String {
        let client = reqwest::Client::new();
        let resp: Value = client
            .post(format!("{}/api/auth/login", self.base))
            .json(&json!({ "username": username, "password": "test-password-123" }))
            .send()
            .await
            .expect("POST /api/auth/login")
            .json()
            .await
            .expect("login json");
        resp["token"]
            .as_str()
            .expect("token in login response")
            .to_string()
    }

    async fn list_docs_status(&self, token: &str) -> reqwest::StatusCode {
        reqwest::Client::new()
            .get(format!("{}/api/docs", self.base))
            .bearer_auth(token)
            .send()
            .await
            .expect("GET /api/docs")
            .status()
    }

    async fn stop(self) {
        self.server.stop().await.expect("stop");
    }
}

#[tokio::test]
async fn dedicated_mode_pins_to_configured_workspace() {
    let tenancy = TenancyConfig {
        mode: TenancyMode::Dedicated,
        workspace_id: Some("alpha".into()),
        ..TenancyConfig::default()
    };
    let h = Harness::start(tenancy).await;
    h.seed_user("alice", Some("alpha"));
    h.seed_user("bob", Some("beta"));

    let alpha_token = h.login_token("alice").await;
    let beta_token = h.login_token("bob").await;

    assert_eq!(h.list_docs_status(&alpha_token).await, 200);
    assert_eq!(h.list_docs_status(&beta_token).await, 403);

    h.stop().await;
}

#[tokio::test]
async fn shared_mode_accepts_multi_workspace() {
    let tenancy = TenancyConfig {
        mode: TenancyMode::Shared,
        workspace_id: None,
        ..TenancyConfig::default()
    };
    let h = Harness::start(tenancy).await;
    h.seed_user("alice", Some("alpha"));
    h.seed_user("bob", Some("beta"));

    let alpha_token = h.login_token("alice").await;
    let beta_token = h.login_token("bob").await;

    assert_eq!(h.list_docs_status(&alpha_token).await, 200);
    assert_eq!(h.list_docs_status(&beta_token).await, 200);

    h.stop().await;
}

#[tokio::test]
async fn dedicated_blank_workspace_preserves_default() {
    // Pre-21.5 self-hoster: `relay.toml` default = dedicated, blank
    // workspace_id. Users carry workspace_id = "default", tokens carry
    // wsp = "default", check_tenancy pins to "default" → all green.
    let tenancy = TenancyConfig {
        mode: TenancyMode::Dedicated,
        workspace_id: None,
        ..TenancyConfig::default()
    };
    let h = Harness::start(tenancy).await;
    h.seed_user("alice", Some("default"));

    let token = h.login_token("alice").await;
    assert_eq!(h.list_docs_status(&token).await, 200);

    h.stop().await;
}
