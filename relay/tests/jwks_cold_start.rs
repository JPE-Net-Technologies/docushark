//! JP-397 — JWKS cold-start hardening.
//!
//! 1. `is_ready` / `warm_up` reflect whether the cache has ever loaded a key.
//! 2. A relay whose JWKS cache hasn't loaded yet answers an authed REST request
//!    with **503** (relay can't validate right now), NOT 401 (token rejected) —
//!    so a client doesn't mistake a cold-pod blip for a bad token and sign out.

use std::sync::Arc;
use std::time::Duration;

use docushark_relay::auth::{
    JwksCache, OidcAuthState, OidcValidationConfig, RevocationSet, WorkspaceRole,
};
use docushark_relay::config::{TenancyConfig, TenancyMode};
use docushark_relay::server::{NetworkMode, ServerConfig, WebSocketServer};
use docushark_relay::test_support::OidcTestIssuer;

/// An unroutable JWKS URL (discard port) so a refresh attempt always fails fast.
const DEAD_JWKS: &str = "http://127.0.0.1:9/jwks";

#[tokio::test]
async fn is_ready_and_warm_up_reflect_cache_state() {
    // Cold cache pointing at an unreachable endpoint is never ready.
    let cold = JwksCache::new(DEAD_JWKS.to_string());
    assert!(!cold.is_ready().await);

    // warm_up against a dead endpoint returns false and respects its bound.
    let t0 = std::time::Instant::now();
    assert!(!cold.warm_up(Duration::from_millis(300)).await);
    assert!(t0.elapsed() < Duration::from_secs(5), "warm_up overran its timeout");
    assert!(!cold.is_ready().await);

    // A preloaded cache (the test issuer's) is ready, and warm_up short-circuits
    // to true without touching any endpoint.
    let issuer = OidcTestIssuer::new().await;
    let warm = issuer.auth_state().jwks;
    assert!(warm.is_ready().await);
    assert!(warm.warm_up(Duration::from_millis(1)).await);
}

#[tokio::test]
async fn cold_jwks_returns_503_not_401() {
    let tmp = tempfile::tempdir().expect("tempdir");

    // Mint a structurally-valid token from a real issuer...
    let issuer = OidcTestIssuer::new().await;
    let token = issuer.mint("user-cold", "ws-cold", WorkspaceRole::Owner);

    // ...but give the SERVER a cold cache that can't resolve the kid. Validation
    // hits the JWKS lookup before any signature/claim check, so it returns
    // `JwksUnavailable` → 503.
    let cold_auth = OidcAuthState::new(
        OidcValidationConfig {
            issuer: "https://test.docushark.app".to_string(),
            audience: "docushark-relay".to_string(),
            resource: None,
        },
        JwksCache::new(DEAD_JWKS.to_string()),
        RevocationSet::new(),
    );

    let server = Arc::new(WebSocketServer::new());
    server.set_app_data_dir(tmp.path().to_path_buf()).await;
    server.set_auth(cold_auth).await;
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
    let http = bound
        .strip_prefix("ws://")
        .map(|rest| format!("http://{rest}"))
        .unwrap_or(bound);

    let status = reqwest::Client::new()
        .get(format!("{http}/api/docs"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("request")
        .status();

    assert_eq!(
        status,
        reqwest::StatusCode::SERVICE_UNAVAILABLE,
        "cold JWKS must surface as 503, not 401",
    );
}
