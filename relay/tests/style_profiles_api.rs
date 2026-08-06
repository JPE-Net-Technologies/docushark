//! Integration tests for the `/api/v1/style-profiles` registry surface.
//!
//! Same harness pattern as `collections_api.rs`, whose optimistic-concurrency
//! contract this endpoint deliberately mirrors. Beyond that shared contract,
//! the cases here pin the three things that are specific to style profiles:
//! the opaque property bag survives a round trip, the registry is metered as
//! `configBytes` on `/api/v1/usage` and gated on quota, and the set is
//! workspace-scoped like every other tenant-owned resource.

use std::sync::Arc;

use docushark_relay::auth::WorkspaceRole;
use docushark_relay::config::{TenancyConfig, TenancyMode};
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
    /// Shared-tenancy relay — the DocuShark Cloud shape, where the workspace
    /// comes from the token's `wsp` claim. Required for the scoping and quota
    /// cases (single-tenant mode collapses every caller onto one workspace, so
    /// a cross-workspace assertion there would prove nothing).
    async fn start() -> Self {
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

    fn url(&self) -> String {
        format!("{}/api/v1/style-profiles", self.base)
    }

    async fn stop(self) {
        self.server.stop().await.expect("stop");
    }
}

fn profile(id: &str, name: &str) -> serde_json::Value {
    json!({
        "id": id,
        "name": name,
        "properties": { "fill": "#4a90d9", "strokeWidth": 2 },
        "createdAt": 1,
    })
}

#[tokio::test]
async fn style_profiles_versioned_put_roundtrip_and_conflict() {
    let harness = RelayHarness::start().await;
    let client = reqwest::Client::new();
    let bearer = format!("Bearer {}", harness.token("alice"));
    let url = harness.url();

    // Cold GET: empty set, version 0.
    let res = client
        .get(&url)
        .header(reqwest::header::AUTHORIZATION, &bearer)
        .send()
        .await
        .expect("get empty");
    assert_eq!(res.status().as_u16(), 200);
    let body: serde_json::Value = res.json().await.unwrap();
    assert_eq!(body["profiles"].as_array().map(|a| a.len()), Some(0));
    assert_eq!(body["version"], 0);

    // Unconditional PUT lands and bumps to v1.
    let res = client
        .put(&url)
        .header(reqwest::header::AUTHORIZATION, &bearer)
        .json(&json!({ "profiles": [profile("a", "Dark Neon")] }))
        .send()
        .await
        .expect("blind put");
    assert_eq!(res.status().as_u16(), 200);
    let body: serde_json::Value = res.json().await.unwrap();
    assert_eq!(body["success"], true);
    assert_eq!(body["newVersion"], 1);

    // Stale expectedVersion ⇒ 409 carrying the current set; store untouched.
    let res = client
        .put(&url)
        .header(reqwest::header::AUTHORIZATION, &bearer)
        .json(&json!({ "profiles": [profile("b", "Blueprint")], "expectedVersion": 0 }))
        .send()
        .await
        .expect("stale put");
    assert_eq!(res.status().as_u16(), 409);
    let body: serde_json::Value = res.json().await.unwrap();
    assert_eq!(body["errorCode"], "VERSION_CONFLICT");
    assert_eq!(body["currentVersion"], 1);
    assert_eq!(body["profiles"][0]["id"], "a");

    // Matching expectedVersion ⇒ accepted, v2.
    let res = client
        .put(&url)
        .header(reqwest::header::AUTHORIZATION, &bearer)
        .json(&json!({ "profiles": [profile("b", "Blueprint")], "expectedVersion": 1 }))
        .send()
        .await
        .expect("conditional put");
    assert_eq!(res.status().as_u16(), 200);
    assert_eq!(
        res.json::<serde_json::Value>().await.unwrap()["newVersion"],
        2
    );

    harness.stop().await;
}

#[tokio::test]
async fn style_profiles_preserve_an_opaque_property_bag() {
    // The relay never interprets `properties`. A facet it has never heard of
    // must survive the round trip byte-for-byte, or shipping a new editor style
    // facet would silently drop user data on the next sync.
    let harness = RelayHarness::start().await;
    let client = reqwest::Client::new();
    let bearer = format!("Bearer {}", harness.token("alice"));
    let url = harness.url();

    let exotic = json!({
        "fill": "#000",
        "swimlaneHeaderBackground": "#123456",
        "icons": [{ "id": "aws/lambda", "size": 24 }],
        "aFacetInventedNextYear": { "nested": [1, 2, 3], "flag": true },
    });
    let res = client
        .put(&url)
        .header(reqwest::header::AUTHORIZATION, &bearer)
        .json(&json!({
            "profiles": [{
                "id": "a",
                "name": "Exotic",
                "properties": exotic,
                "createdAt": 7,
                "favorite": true,
                "collectionIds": ["acme"],
            }]
        }))
        .send()
        .await
        .expect("put exotic");
    assert_eq!(res.status().as_u16(), 200);

    let res = client
        .get(&url)
        .header(reqwest::header::AUTHORIZATION, &bearer)
        .send()
        .await
        .expect("get exotic");
    let body: serde_json::Value = res.json().await.unwrap();
    assert_eq!(body["profiles"][0]["properties"], exotic);
    assert_eq!(body["profiles"][0]["favorite"], true);
    assert_eq!(body["profiles"][0]["collectionIds"][0], "acme");

    harness.stop().await;
}

#[tokio::test]
async fn style_profiles_put_sanitizes_and_rejects() {
    let harness = RelayHarness::start().await;
    let client = reqwest::Client::new();
    let bearer = format!("Bearer {}", harness.token("alice"));
    let url = harness.url();

    // Duplicate ids are healed keep-first, not rejected.
    let res = client
        .put(&url)
        .header(reqwest::header::AUTHORIZATION, &bearer)
        .json(&json!({ "profiles": [profile("a", "First"), profile("a", "Second")] }))
        .send()
        .await
        .expect("dupe put");
    assert_eq!(res.status().as_u16(), 200);
    let res = client
        .get(&url)
        .header(reqwest::header::AUTHORIZATION, &bearer)
        .send()
        .await
        .expect("get after dupe");
    let body: serde_json::Value = res.json().await.unwrap();
    let listed = body["profiles"].as_array().unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0]["name"], "First");

    // Empty name ⇒ 400.
    let res = client
        .put(&url)
        .header(reqwest::header::AUTHORIZATION, &bearer)
        .json(&json!({ "profiles": [profile("b", "   ")] }))
        .send()
        .await
        .expect("bad name put");
    assert_eq!(res.status().as_u16(), 400);

    // A non-object property bag ⇒ 400.
    let res = client
        .put(&url)
        .header(reqwest::header::AUTHORIZATION, &bearer)
        .json(&json!({
            "profiles": [{ "id": "c", "name": "Bad bag", "properties": "nope", "createdAt": 1 }]
        }))
        .send()
        .await
        .expect("bad bag put");
    assert_eq!(res.status().as_u16(), 400);

    // Registry still at the healed single entry, version 1.
    let res = client
        .get(&url)
        .header(reqwest::header::AUTHORIZATION, &bearer)
        .send()
        .await
        .expect("final get");
    let body: serde_json::Value = res.json().await.unwrap();
    assert_eq!(body["version"], 1);
    assert_eq!(body["profiles"].as_array().map(|a| a.len()), Some(1));

    harness.stop().await;
}

#[tokio::test]
async fn style_profiles_are_metered_as_config_bytes_and_gated_on_quota() {
    let harness = RelayHarness::start().await;
    let client = reqwest::Client::new();
    // A quota small enough that a handful of profiles crosses it.
    let token = harness.issuer.mint_with_limits(
        "user-q",
        "quota-ws",
        WorkspaceRole::Owner,
        Some(1024),
        None,
    );
    let bearer = format!("Bearer {token}");
    let url = harness.url();
    let usage_url = format!("{}/api/v1/usage", harness.base);

    // Baseline: nothing stored, config share is zero.
    let body: serde_json::Value = client
        .get(&usage_url)
        .header(reqwest::header::AUTHORIZATION, &bearer)
        .send()
        .await
        .expect("usage baseline")
        .json()
        .await
        .unwrap();
    assert_eq!(body["configBytes"], 0);
    assert_eq!(body["storageBytes"], 0);

    // A small set fits and shows up as config bytes in the headline number.
    let res = client
        .put(&url)
        .header(reqwest::header::AUTHORIZATION, &bearer)
        .json(&json!({ "profiles": [profile("a", "Dark Neon")] }))
        .send()
        .await
        .expect("small put");
    assert_eq!(res.status().as_u16(), 200);

    let body: serde_json::Value = client
        .get(&usage_url)
        .header(reqwest::header::AUTHORIZATION, &bearer)
        .send()
        .await
        .expect("usage after write")
        .json()
        .await
        .unwrap();
    let config_bytes = body["configBytes"].as_u64().expect("configBytes");
    assert!(config_bytes > 0, "a written registry is metered");
    assert_eq!(
        body["storageBytes"].as_u64().unwrap(),
        body["docBytes"].as_u64().unwrap()
            + body["blobBytes"].as_u64().unwrap()
            + config_bytes,
        "the headline number is the sum of its shares — a split that doesn't \
         add up is what makes an account meter look wrong to a user",
    );

    // A set past the quota is refused, and the stored registry is untouched.
    let too_many: Vec<serde_json::Value> = (0..40)
        .map(|i| profile(&format!("p{i}"), "A profile with a reasonably long name"))
        .collect();
    let res = client
        .put(&url)
        .header(reqwest::header::AUTHORIZATION, &bearer)
        .json(&json!({ "profiles": too_many }))
        .send()
        .await
        .expect("over quota put");
    assert_eq!(res.status().as_u16(), 507);

    let body: serde_json::Value = client
        .get(&url)
        .header(reqwest::header::AUTHORIZATION, &bearer)
        .send()
        .await
        .expect("get after refusal")
        .json()
        .await
        .unwrap();
    assert_eq!(body["version"], 1, "a refused write must not bump the version");
    assert_eq!(body["profiles"].as_array().map(|a| a.len()), Some(1));

    // Shrinking back is always allowed: the comparison excludes the registry's
    // own current bytes, so a workspace can never be locked out of *reducing*
    // what it stores.
    let res = client
        .put(&url)
        .header(reqwest::header::AUTHORIZATION, &bearer)
        .json(&json!({ "profiles": [] }))
        .send()
        .await
        .expect("shrink put");
    assert_eq!(res.status().as_u16(), 200);

    harness.stop().await;
}

#[tokio::test]
async fn style_profiles_are_workspace_scoped() {
    let harness = RelayHarness::start().await;
    let client = reqwest::Client::new();
    let alpha = format!(
        "Bearer {}",
        harness
            .issuer
            .mint("user-a", "alpha", WorkspaceRole::Owner)
    );
    let beta = format!(
        "Bearer {}",
        harness.issuer.mint("user-b", "beta", WorkspaceRole::Owner)
    );
    let url = harness.url();

    client
        .put(&url)
        .header(reqwest::header::AUTHORIZATION, &alpha)
        .json(&json!({ "profiles": [profile("secret", "Alpha house style")] }))
        .send()
        .await
        .expect("alpha put");

    // Beta sees an empty registry — never alpha's.
    let body: serde_json::Value = client
        .get(&url)
        .header(reqwest::header::AUTHORIZATION, &beta)
        .send()
        .await
        .expect("beta get")
        .json()
        .await
        .unwrap();
    assert_eq!(body["profiles"].as_array().map(|a| a.len()), Some(0));
    assert_eq!(body["version"], 0);

    // And beta writing its own set cannot disturb alpha's.
    client
        .put(&url)
        .header(reqwest::header::AUTHORIZATION, &beta)
        .json(&json!({ "profiles": [profile("b", "Beta style")] }))
        .send()
        .await
        .expect("beta put");

    let body: serde_json::Value = client
        .get(&url)
        .header(reqwest::header::AUTHORIZATION, &alpha)
        .send()
        .await
        .expect("alpha get")
        .json()
        .await
        .unwrap();
    assert_eq!(body["profiles"].as_array().map(|a| a.len()), Some(1));
    assert_eq!(body["profiles"][0]["id"], "secret");

    harness.stop().await;
}
