//! Phase 21.3 integration tests for per-workspace write rate limits.
//!
//! Exercises both axes of the acceptance criteria:
//!   1. A workspace that exceeds its bucket gets clamped (the relay
//!      drops the over-quota MCP write with HTTP 429).
//!   2. Saturating one workspace's bucket leaves another workspace's
//!      throughput intact (per-key isolation).

use std::sync::Arc;

use docushark_relay::config::{LimitsConfig, TenancyConfig, TenancyMode};
use docushark_relay::mcp::{McpConfig as InternalMcpConfig, McpServer};
use docushark_relay::server::protocol::DocId;
use docushark_relay::server::{NetworkMode, ServerConfig, WebSocketServer};
use docushark_relay::test_support::OidcTestIssuer;
use serde_json::json;
use tempfile::TempDir;

struct Harness {
    mcp_base: String,
    mcp_token: String,
    server: Arc<WebSocketServer>,
    mcp: Arc<McpServer>,
    _tmp: TempDir,
}

impl Harness {
    /// Start a relay + MCP pair. `tenancy.limits.writes_per_sec` /
    /// `writes_burst` drive the shared limiter both subsystems see.
    async fn start(tenancy: TenancyConfig) -> Self {
        let tmp = tempfile::tempdir().expect("tempdir");
        let data_dir = tmp.path().to_path_buf();
        let issuer = OidcTestIssuer::new().await;

        let server = Arc::new(WebSocketServer::new());
        server.set_app_data_dir(data_dir.clone()).await;
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

        // Bring up MCP first so we share the limiter with the
        // not-yet-started server. `start()` reuses the cached Arc.
        let panic_counter = server.panic_counter_handle();
        let write_limiter = server.build_write_limiter().await;
        let on_doc_changed: Arc<dyn Fn(DocId) + Send + Sync> = Arc::new(|_| {});
        let mcp = Arc::new(
            McpServer::new(
                data_dir,
                on_doc_changed,
                panic_counter,
                write_limiter,
                issuer.auth_state(),
                "default".to_string(),
            )
            .expect("McpServer::new"),
        );
        mcp.set_config(InternalMcpConfig { port: 0 })
            .await
            .expect("mcp set_config");
        let mcp_addr = mcp.start().await.expect("mcp start");
        let mcp_token = mcp.get_token().await;

        let _bound = server.start(0).await.expect("server start");

        Self {
            mcp_base: mcp_addr,
            mcp_token,
            server,
            mcp,
            _tmp: tmp,
        }
    }

    async fn seed_doc_via_store(&self, doc_id: &str, page_id: &str) {
        use docushark_relay::server::protocol::WorkspaceId;
        let store = self.server.get_doc_store().await.expect("doc_store");
        let doc = json!({
            "id": doc_id,
            "name": "Rate Limit Test Doc",
            "version": 1,
            "createdAt": 1u64,
            "modifiedAt": 1u64,
            "activePageId": page_id,
            "pageOrder": [page_id],
            "pages": {
                page_id: {
                    "id": page_id,
                    "name": "Page 1",
                    "shapes": {},
                    "shapeOrder": [],
                    "createdAt": 1u64,
                    "modifiedAt": 1u64,
                }
            }
        });
        store
            .save_document(&WorkspaceId::single_tenant(), doc)
            .expect("save_document");
    }

    /// Fire one MCP `add_shape` write. Returns the HTTP status.
    async fn mcp_add_shape(&self, doc_id: &str, page_id: &str) -> reqwest::StatusCode {
        let body = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": "docushark.add_shape",
                "arguments": {
                    "docId": doc_id,
                    "pageId": page_id,
                    "shape": { "kind": "rectangle", "x": 0, "y": 0 }
                }
            }
        });
        reqwest::Client::new()
            .post(format!("{}/mcp", self.mcp_base))
            .bearer_auth(&self.mcp_token)
            .json(&body)
            .send()
            .await
            .expect("POST /mcp")
            .status()
    }

    async fn stop(self) {
        self.mcp.stop().await.expect("mcp stop");
        self.server.stop().await.expect("server stop");
    }
}

/// Phase 21.3 acceptance: writes past the burst capacity are
/// clamped — the relay returns HTTP 429 once the bucket is drained.
#[tokio::test]
async fn mcp_writes_burst_then_rate_limit_with_429() {
    let mut limits = LimitsConfig::default();
    // Tight bucket so the test runs fast.
    limits.writes_per_sec = 1;
    limits.writes_burst = 2;
    let tenancy = TenancyConfig {
        mode: TenancyMode::Dedicated,
        workspace_id: None,
        limits,
    };
    let h = Harness::start(tenancy).await;
    h.seed_doc_via_store("doc-1", "p1").await;

    // First two calls should pass (burst).
    let mut statuses = Vec::new();
    for _ in 0..6 {
        statuses.push(h.mcp_add_shape("doc-1", "p1").await);
    }
    let ok_count = statuses
        .iter()
        .filter(|s| s.as_u16() == 200)
        .count();
    let limited_count = statuses
        .iter()
        .filter(|s| s.as_u16() == 429)
        .count();
    assert!(
        ok_count >= 2,
        "burst should pass at least 2 writes; statuses={statuses:?}"
    );
    assert!(
        limited_count >= 1,
        "after burst, at least one write must be 429-rate-limited; statuses={statuses:?}"
    );

    h.stop().await;
}

/// Unit-test-style assertion against the shared limiter: governor's
/// keyed bucket isolates workspaces, so saturating one key never
/// affects another. This mirrors the acceptance line about one
/// tenant's quota not starving another.
#[tokio::test]
async fn limiter_isolates_workspaces() {
    use docushark_relay::server::build_workspace_limiter;
    use docushark_relay::server::protocol::WorkspaceId;
    let limiter = build_workspace_limiter(1, 1);
    let alpha = WorkspaceId::from_configured("alpha").unwrap();
    let beta = WorkspaceId::from_configured("beta").unwrap();

    assert!(limiter.check_key(&alpha).is_ok());
    assert!(limiter.check_key(&alpha).is_err(), "alpha bucket drained");
    // Beta has its own bucket, untouched.
    assert!(limiter.check_key(&beta).is_ok());
}
