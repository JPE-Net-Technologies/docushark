//! End-to-end smoke test for `docushark-relay`.
//!
//! Builds the relay in-process on an OS-assigned port, hits the HTTP
//! API with `reqwest`, and asserts that doc CRUD round-trips cleanly
//! over RS256 OIDC tokens minted by [`OidcTestIssuer`]. Library-level —
//! no `cargo run` subprocess — so CI is deterministic.
//!
//! The legacy `/api/auth/{register,login,me,password}` surface was
//! deleted in JP-77; the relay is now a pure OIDC resource server.

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

#[tokio::test]
async fn relay_docs_crud_roundtrip() {
    let harness = RelayHarness::start().await;
    let client = reqwest::Client::new();
    let bearer = format!("Bearer {}", harness.token("alice"));

    // list (empty)
    let res = client
        .get(format!("{}/api/docs", harness.base))
        .header(reqwest::header::AUTHORIZATION, &bearer)
        .send()
        .await
        .expect("list");
    assert_eq!(res.status().as_u16(), 200);
    let body: serde_json::Value = res.json().await.unwrap();
    assert_eq!(body["documents"].as_array().map(|a| a.len()), Some(0));

    // save
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
        .expect("save");
    assert_eq!(res.status().as_u16(), 200);
    let body: serde_json::Value = res.json().await.unwrap();
    assert_eq!(body["newVersion"], 1);

    // save with mismatched body id rejected
    let res = client
        .put(format!("{}/api/docs/doc-1", harness.base))
        .header(reqwest::header::AUTHORIZATION, &bearer)
        .json(&json!({ "id": "different", "name": "x" }))
        .send()
        .await
        .expect("save bad id");
    assert_eq!(res.status().as_u16(), 400);

    // get
    let res = client
        .get(format!("{}/api/docs/doc-1", harness.base))
        .header(reqwest::header::AUTHORIZATION, &bearer)
        .send()
        .await
        .expect("get");
    assert_eq!(res.status().as_u16(), 200);
    let body: serde_json::Value = res.json().await.unwrap();
    assert_eq!(body["id"], "doc-1");

    // delete
    let res = client
        .delete(format!("{}/api/docs/doc-1", harness.base))
        .header(reqwest::header::AUTHORIZATION, &bearer)
        .send()
        .await
        .expect("delete");
    assert_eq!(res.status().as_u16(), 200);

    // /health
    let res = client
        .get(format!("{}/health", harness.base))
        .send()
        .await
        .expect("health");
    assert_eq!(res.status().as_u16(), 200);

    harness.stop().await;
}

#[tokio::test]
async fn relay_rejects_missing_bearer() {
    let harness = RelayHarness::start().await;
    let client = reqwest::Client::new();

    let res = client
        .get(format!("{}/api/docs", harness.base))
        .send()
        .await
        .expect("list no auth");
    assert_eq!(res.status().as_u16(), 401);

    harness.stop().await;
}

#[tokio::test]
async fn relay_rejects_revoked_token() {
    let harness = RelayHarness::start().await;
    let client = reqwest::Client::new();

    let token = harness.token("alice");
    let bearer = format!("Bearer {token}");

    // Decode jti to revoke it. Header.payload.signature; payload is
    // base64url-encoded JSON.
    let payload = token.split('.').nth(1).expect("jwt payload");
    let json_bytes = base64_url_decode(payload);
    let parsed: serde_json::Value = serde_json::from_slice(&json_bytes).unwrap();
    let jti = parsed["jti"].as_str().unwrap();
    harness.issuer.revoke(jti);

    let res = client
        .get(format!("{}/api/docs", harness.base))
        .header(reqwest::header::AUTHORIZATION, &bearer)
        .send()
        .await
        .expect("list after revoke");
    assert_eq!(res.status().as_u16(), 401);

    harness.stop().await;
}

fn base64_url_decode(input: &str) -> Vec<u8> {
    fn decode_char(c: u8) -> u8 {
        match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'-' => 62,
            b'_' => 63,
            _ => panic!("bad base64url char"),
        }
    }
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() * 3 / 4);
    let mut i = 0;
    while i + 4 <= bytes.len() {
        let n = (decode_char(bytes[i]) as u32) << 18
            | (decode_char(bytes[i + 1]) as u32) << 12
            | (decode_char(bytes[i + 2]) as u32) << 6
            | (decode_char(bytes[i + 3]) as u32);
        out.push(((n >> 16) & 0xff) as u8);
        out.push(((n >> 8) & 0xff) as u8);
        out.push((n & 0xff) as u8);
        i += 4;
    }
    let rem = bytes.len() - i;
    if rem == 2 {
        let n = (decode_char(bytes[i]) as u32) << 18 | (decode_char(bytes[i + 1]) as u32) << 12;
        out.push(((n >> 16) & 0xff) as u8);
    } else if rem == 3 {
        let n = (decode_char(bytes[i]) as u32) << 18
            | (decode_char(bytes[i + 1]) as u32) << 12
            | (decode_char(bytes[i + 2]) as u32) << 6;
        out.push(((n >> 16) & 0xff) as u8);
        out.push(((n >> 8) & 0xff) as u8);
    }
    out
}
