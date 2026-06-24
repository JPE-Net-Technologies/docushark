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
    /// HTTP base of the relay's sync listener — for scraping `/metrics`.
    http_base: String,
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
        // JP-249: build the MCP read limiter from the tenancy limits before
        // `tenancy` is moved into `set_tenancy` (mirrors main.rs).
        let mcp_read_limiter = if tenancy.limits.reads_per_sec == 0 {
            None
        } else {
            Some(Arc::new(docushark_relay::server::build_workspace_limiter(
                tenancy.limits.reads_per_sec,
                tenancy.limits.reads_burst,
            )))
        };
        server.set_tenancy(tenancy).await;
        server
            .set_config(ServerConfig {
                port: 0,
                network_mode: NetworkMode::Localhost,
                max_connections: 0,
            })
            .await
            .expect("set_config");

        let panic_counter = server.panic_counter_handle();
        let rate_limit_rejections = server.rate_limit_rejections_handle();
        let write_limiter = server.build_write_limiter().await;
        let on_doc_changed: Arc<docushark_relay::mcp::DocChangedSink> = Arc::new(|_, _| {});
        let on_doc_deleted: Arc<docushark_relay::mcp::DocDeletedSink> = Arc::new(|_, _| {});

        // Start the server first so MCP can share its single `DocumentStore`
        // (JP-230). The write limiter is already built + cached above, so this
        // ordering doesn't change which limiter the two subsystems see.
        let bound = server.start(0).await.expect("server start");
        // The sync listener also serves `/metrics`; derive its HTTP base.
        let http_base = bound
            .strip_prefix("ws://")
            .map(|rest| format!("http://{rest}"))
            .unwrap_or(bound);
        let shared_doc_store = server
            .get_doc_store()
            .await
            .expect("doc store available after start");

        // Hand MCP a *standalone* Y.Doc registry + noop broadcaster — the JP-35
        // live-write path isn't exercised here (these tests cover rate limits via
        // the JSON path). The DocumentStore, by contrast, is shared with the server.
        let sync_registry = Arc::new(docushark_relay::sync::DocRegistry::new());
        let on_doc_update: Arc<
            dyn Fn(&docushark_relay::server::protocol::WorkspaceId, &DocId, Vec<u8>) + Send + Sync,
        > = Arc::new(|_, _, _| {});
        let mcp = Arc::new(
            McpServer::new(
                data_dir,
                on_doc_changed,
                on_doc_deleted,
                panic_counter,
                rate_limit_rejections,
                write_limiter,
                mcp_read_limiter,
                issuer.auth_state(),
                "default".to_string(),
                sync_registry,
                on_doc_update,
                shared_doc_store,
                false, // JP-370: private-doc enforcement off in this test
            )
            .expect("McpServer::new"),
        );
        mcp.set_config(InternalMcpConfig { port: 0 })
            .await
            .expect("mcp set_config");
        let mcp_addr = mcp.start().await.expect("mcp start");
        let mcp_token = mcp.get_token().await;

        Self {
            mcp_base: mcp_addr,
            mcp_token,
            http_base,
            server,
            mcp,
            _tmp: tmp,
        }
    }

    /// Scrape the pod-level `relay_rate_limit_rejections_total` counter from
    /// `/metrics`. Matches only the bare (unlabelled) series.
    async fn rate_limit_rejections_metric(&self) -> u64 {
        let body = reqwest::Client::new()
            .get(format!("{}/metrics", self.http_base))
            .send()
            .await
            .expect("GET /metrics")
            .text()
            .await
            .expect("metrics body");
        for line in body.lines() {
            let line = line.trim();
            if line.starts_with('#') {
                continue;
            }
            let mut it = line.split_whitespace();
            if it.next() == Some("relay_rate_limit_rejections_total") {
                return it
                    .next()
                    .and_then(|v| v.parse().ok())
                    .expect("parse rejection counter");
            }
        }
        panic!("relay_rate_limit_rejections_total not found in /metrics:\n{body}");
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
                "name": "docushark_add_shape",
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

    /// Fire one MCP `list_documents` read. Returns the HTTP status.
    async fn mcp_list_documents(&self) -> reqwest::StatusCode {
        let body = json!({
            "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": {"name": "docushark_list_documents", "arguments": {}}
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
    // Tight bucket so the test runs fast.
    let limits = LimitsConfig {
        writes_per_sec: 1,
        writes_burst: 2,
        ..LimitsConfig::default()
    };
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

    // JP-109: the throttle must also surface on the metering signal, not just
    // as 429s. Each rejected MCP write bumps the shared counter that `/metrics`
    // renders as `relay_rate_limit_rejections_total`, so the gauge must equal
    // the number of 429s we observed (this harness makes no WS writes, so MCP
    // is the only source of rejections).
    let rejections = h.rate_limit_rejections_metric().await;
    assert_eq!(
        rejections, limited_count as u64,
        "relay_rate_limit_rejections_total ({rejections}) should match the 429 count ({limited_count})"
    );

    h.stop().await;
}

/// JP-249: MCP reads are clamped by a **separate** per-workspace bucket — a
/// read-storm gets 429s without draining the write bucket (writes still pass).
#[tokio::test]
async fn mcp_reads_burst_then_rate_limit_independent_of_writes() {
    let limits = LimitsConfig {
        reads_per_sec: 1,
        reads_burst: 2,
        // Generous writes so the write path is never the bottleneck here.
        ..LimitsConfig::default()
    };
    let tenancy = TenancyConfig {
        mode: TenancyMode::Dedicated,
        workspace_id: None,
        limits,
    };
    let h = Harness::start(tenancy).await;
    h.seed_doc_via_store("doc-1", "p1").await;

    let mut statuses = Vec::new();
    for _ in 0..6 {
        statuses.push(h.mcp_list_documents().await);
    }
    let ok = statuses.iter().filter(|s| s.as_u16() == 200).count();
    let limited = statuses.iter().filter(|s| s.as_u16() == 429).count();
    assert!(ok >= 2, "read burst should pass >=2; statuses={statuses:?}");
    assert!(limited >= 1, "reads past burst must 429; statuses={statuses:?}");

    // Independence: the write bucket is untouched, so a write still passes even
    // after the read bucket is drained.
    assert_eq!(
        h.mcp_add_shape("doc-1", "p1").await.as_u16(),
        200,
        "writes must be unaffected by a read-storm (separate bucket)"
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
