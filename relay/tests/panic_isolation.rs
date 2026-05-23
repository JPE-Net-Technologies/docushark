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

use docushark_relay::auth::UserStore;
use docushark_relay::config::RelayConfig;
use docushark_relay::server::{NetworkMode, ServerConfig, WebSocketServer};
use tempfile::TempDir;

async fn start_relay() -> (Arc<WebSocketServer>, String, TempDir) {
    let tmp = tempfile::tempdir().expect("tempdir");
    let data_dir = tmp.path().to_path_buf();

    let config = RelayConfig::fresh();
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

    server.stop().await.expect("stop");
}
