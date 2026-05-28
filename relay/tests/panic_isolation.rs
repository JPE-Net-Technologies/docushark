//! Phase 21.2 — `/metrics` endpoint smoke test.
//!
//! Verifies the `relay_handler_panics_total` counter is exposed on
//! `/metrics` in Prometheus exposition format, and increments when a
//! handler panic is caught via the debug `--panic-tenant` path.
//!
//! The WS-side panic injection itself is unit-tested in
//! `server::mod::tests::handle_message_catches_panic_and_increments_counter`;
//! this test exercises the HTTP surface that operators / Prometheus
//! scrape against.

use std::sync::Arc;

use docushark_relay::server::{NetworkMode, ServerConfig, WebSocketServer};
use docushark_relay::test_support::OidcTestIssuer;
use tempfile::TempDir;

async fn start_relay() -> (Arc<WebSocketServer>, String, TempDir) {
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

    (server, http, tmp)
}

#[tokio::test]
async fn metrics_endpoint_exposes_panic_counter_in_prometheus_format() {
    let (server, base, _tmp) = start_relay().await;

    let client = reqwest::Client::new();
    let resp = client
        .get(format!("{base}/metrics"))
        .send()
        .await
        .expect("GET /metrics");
    assert_eq!(resp.status(), 200);
    let ct = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    assert!(
        ct.starts_with("text/plain"),
        "expected Prometheus text content-type, got {ct:?}"
    );
    let body = resp.text().await.expect("body");
    assert!(
        body.contains("# HELP relay_handler_panics_total"),
        "missing HELP comment in {body:?}"
    );
    assert!(
        body.contains("# TYPE relay_handler_panics_total counter"),
        "missing TYPE comment in {body:?}"
    );
    assert!(
        body.contains("relay_handler_panics_total 0"),
        "expected initial counter 0 in {body:?}"
    );

    // Metering observability series are exposed on the same endpoint. At
    // a freshly-started relay with no traffic they're all zero. These are
    // pod-level aggregates only — no per-workspace labels (cardinality is
    // bounded), so each series name appears exactly once.
    for series in [
        "relay_storage_bytes_total",
        "relay_active_editors_total",
        "relay_active_viewers_total",
        "relay_rate_limit_rejections_total",
    ] {
        assert!(
            body.contains(&format!("# TYPE {series}")),
            "missing TYPE comment for {series} in {body:?}"
        );
        assert!(
            body.contains(&format!("{series} 0")),
            "expected initial {series} 0 in {body:?}"
        );
        // No per-workspace label series — the bare metric is the only line.
        assert!(
            !body.contains(&format!("{series}{{")),
            "{series} must not carry per-workspace labels in {body:?}"
        );
    }

    server.stop().await.expect("stop");
}
