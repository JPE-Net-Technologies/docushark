//! Phase 21.5 integration tests for `[tenancy].mode`.
//!
//! Mints OIDC tokens via [`OidcTestIssuer`] carrying explicit
//! `wsp[].id` claims, then hits `/api/docs` to verify the relay's
//! tenancy enforcement (200 on match, 403 on mismatch). The legacy
//! `/api/auth/login` flow was deleted in JP-77.

use std::sync::Arc;

use docushark_relay::auth::WorkspaceRole;
use docushark_relay::config::{TenancyConfig, TenancyMode};
use docushark_relay::server::{NetworkMode, ServerConfig, WebSocketServer};
use docushark_relay::test_support::OidcTestIssuer;
use tempfile::TempDir;

struct Harness {
    base: String,
    issuer: OidcTestIssuer,
    server: Arc<WebSocketServer>,
    _tmp: TempDir,
}

impl Harness {
    async fn start(tenancy: TenancyConfig) -> Self {
        let tmp = tempfile::tempdir().expect("tempdir");
        let issuer = OidcTestIssuer::new().await;

        let server = Arc::new(WebSocketServer::new());
        server.set_app_data_dir(tmp.path().to_path_buf()).await;
        server.set_auth(issuer.auth_state()).await;
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
            issuer,
            server,
            _tmp: tmp,
        }
    }

    fn token_for(&self, sub: &str, workspace: &str) -> String {
        self.issuer.mint(sub, workspace, WorkspaceRole::Owner)
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
    let alpha_token = h.token_for("alice", "alpha");
    let beta_token = h.token_for("bob", "beta");

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
    let alpha_token = h.token_for("alice", "alpha");
    let beta_token = h.token_for("bob", "beta");

    assert_eq!(h.list_docs_status(&alpha_token).await, 200);
    assert_eq!(h.list_docs_status(&beta_token).await, 200);

    h.stop().await;
}

#[tokio::test]
async fn dedicated_blank_workspace_preserves_default() {
    // Pre-21.5 self-hoster behaviour: dedicated mode with blank
    // workspace_id pins to "default" so existing single-tenant tokens
    // keep working.
    let tenancy = TenancyConfig {
        mode: TenancyMode::Dedicated,
        workspace_id: None,
        ..TenancyConfig::default()
    };
    let h = Harness::start(tenancy).await;
    let token = h.token_for("alice", "default");
    assert_eq!(h.list_docs_status(&token).await, 200);

    h.stop().await;
}
