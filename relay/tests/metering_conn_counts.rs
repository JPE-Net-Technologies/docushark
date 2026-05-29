//! JP-109 — editor/viewer metering split, end-to-end over a real WS.
//!
//! The `/metrics` smoke test in `tests/panic_isolation.rs` asserts the
//! metering series exist and read 0 at rest. This test exercises the
//! *classification* — that a live WS connection lands in the right bucket
//! based on its JWT workspace role (`wsp[].role`), and that the bucket is
//! released on disconnect.
//!
//! It deliberately replaces the original JP-109 acceptance step ("real
//! editor + share-token viewer connections"), which is not runnable from
//! the product: there is no view-only share-link surface, and the split
//! classifies off the JWT role (`is_editor = !matches!(role, Viewer)` at
//! `src/server/mod.rs:1594`), not the per-document share. Minting a
//! viewer-role token via the test issuer reproduces the exact input the
//! classifier sees, with no second account and no docushark-web dependency.

use std::sync::Arc;
use std::time::Duration;

use docushark_relay::auth::WorkspaceRole;
use docushark_relay::config::{TenancyConfig, TenancyMode};
use docushark_relay::server::protocol::{
    encode_message, MESSAGE_AUTH, MESSAGE_AUTH_RESPONSE, PROTOCOL_VERSION,
};
use docushark_relay::server::{NetworkMode, ServerConfig, WebSocketServer};
use docushark_relay::test_support::OidcTestIssuer;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tempfile::TempDir;
use tokio_tungstenite::tungstenite::Message as WsMessage;

const EDITORS: &str = "relay_active_editors_total";
const VIEWERS: &str = "relay_active_viewers_total";

/// In-process relay in shared-tenancy mode. Returns the HTTP base (for
/// `/metrics`), the WS base (for client connects), and the issuer — which
/// must stay alive for the whole test so its JWKS endpoint keeps serving
/// the keys the relay verifies tokens against.
async fn start_relay() -> (Arc<WebSocketServer>, String, String, OidcTestIssuer, TempDir) {
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
    let ws_base = bound.clone();
    let http = bound
        .strip_prefix("ws://")
        .map(|rest| format!("http://{rest}"))
        .unwrap_or(bound);

    (server, http, ws_base, issuer, tmp)
}

/// Minimal WS client: connect + auth. Lifted from the harness in
/// `tests/cross_tenant_isolation.rs`. The auth payload is a JSON-encoded
/// bare string (not `{"token": ...}`), matching `handle_auth`.
struct WsClient {
    stream: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
}

impl WsClient {
    async fn connect(ws_base: &str) -> Self {
        let url = format!("{}/ws?protocolVersion={}", ws_base, PROTOCOL_VERSION);
        let (stream, _resp) = tokio_tungstenite::connect_async(&url)
            .await
            .expect("ws connect");
        Self { stream }
    }

    async fn auth(&mut self, token: &str) -> Value {
        let frame = encode_message(MESSAGE_AUTH, &token.to_string()).expect("encode auth");
        self.stream
            .send(WsMessage::Binary(frame))
            .await
            .expect("send auth");
        loop {
            let msg = self
                .stream
                .next()
                .await
                .expect("auth response stream end")
                .expect("auth response");
            if let WsMessage::Binary(bytes) = msg {
                if bytes.first().copied() == Some(MESSAGE_AUTH_RESPONSE) {
                    return serde_json::from_slice(&bytes[1..]).expect("auth response json");
                }
            }
        }
    }
}

/// Read a bare (unlabelled) gauge from the Prometheus `/metrics` body.
/// Matches only when the first whitespace-separated token equals `series`
/// exactly, so a labelled series (`name{...}`) or a longer name never
/// matches.
fn parse_gauge(body: &str, series: &str) -> u64 {
    for line in body.lines() {
        let line = line.trim();
        if line.starts_with('#') {
            continue;
        }
        let mut it = line.split_whitespace();
        if it.next() == Some(series) {
            return it
                .next()
                .and_then(|v| v.parse().ok())
                .unwrap_or_else(|| panic!("unparseable value for {series} in line {line:?}"));
        }
    }
    panic!("series {series} not found in metrics body:\n{body}");
}

async fn scrape_gauge(http_base: &str, series: &str) -> u64 {
    let body = reqwest::Client::new()
        .get(format!("{http_base}/metrics"))
        .send()
        .await
        .expect("GET /metrics")
        .text()
        .await
        .expect("metrics body");
    parse_gauge(&body, series)
}

/// Poll `/metrics` until `series == want` or the timeout elapses. Used on
/// the disconnect path, where release runs asynchronously after the socket
/// closes. Returns the last observed value (== `want` on success).
async fn wait_for_gauge(http_base: &str, series: &str, want: u64, timeout: Duration) -> u64 {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let v = scrape_gauge(http_base, series).await;
        if v == want || tokio::time::Instant::now() >= deadline {
            return v;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

#[tokio::test]
async fn ws_connections_classify_into_editor_and_viewer_buckets() {
    let (server, http, ws_base, issuer, _tmp) = start_relay().await;

    // At rest both buckets are empty.
    assert_eq!(scrape_gauge(&http, EDITORS).await, 0, "editors nonzero at rest");
    assert_eq!(scrape_gauge(&http, VIEWERS).await, 0, "viewers nonzero at rest");

    // A viewer-role connection increments viewers and leaves editors at 0.
    let viewer_token = issuer.mint("viewer-1", "default", WorkspaceRole::Viewer);
    let mut viewer = WsClient::connect(&ws_base).await;
    let resp = viewer.auth(&viewer_token).await;
    assert_eq!(resp["success"], json!(true), "viewer auth failed: {resp}");
    assert_eq!(
        wait_for_gauge(&http, VIEWERS, 1, Duration::from_secs(1)).await,
        1,
        "viewer connection was not counted as a viewer"
    );
    assert_eq!(
        scrape_gauge(&http, EDITORS).await,
        0,
        "viewer connection was miscounted as an editor"
    );

    // A non-viewer role (Owner; Member classifies identically) increments
    // editors and leaves the viewer count untouched.
    let editor_token = issuer.mint("owner-1", "default", WorkspaceRole::Owner);
    let mut editor = WsClient::connect(&ws_base).await;
    let resp = editor.auth(&editor_token).await;
    assert_eq!(resp["success"], json!(true), "editor auth failed: {resp}");
    assert_eq!(
        wait_for_gauge(&http, EDITORS, 1, Duration::from_secs(1)).await,
        1,
        "owner connection was not counted as an editor"
    );
    assert_eq!(
        scrape_gauge(&http, VIEWERS).await,
        1,
        "owner connection disturbed the viewer count"
    );

    // Dropping the viewer's socket releases only the viewer bucket.
    drop(viewer);
    assert_eq!(
        wait_for_gauge(&http, VIEWERS, 0, Duration::from_secs(2)).await,
        0,
        "viewer bucket not released on disconnect"
    );
    assert_eq!(
        scrape_gauge(&http, EDITORS).await,
        1,
        "editor count changed when the viewer disconnected"
    );

    // Dropping the editor's socket releases the editor bucket.
    drop(editor);
    assert_eq!(
        wait_for_gauge(&http, EDITORS, 0, Duration::from_secs(2)).await,
        0,
        "editor bucket not released on disconnect"
    );

    server.stop().await.expect("stop");
}
