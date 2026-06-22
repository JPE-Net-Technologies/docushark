//! JP-210: when `[mcp] expose = "public"`, the MCP endpoint rides the relay's
//! main HTTP listener (the one serving `/ws` + REST) instead of a separate
//! loopback listener. This exercises the merged surface end-to-end: the RFC
//! 9728 discovery doc + the `/mcp` auth contract on the public origin, plus
//! the public-pod hardening that the static token is refused (a `wsp`-scoped
//! JWT is required).

use std::sync::{Arc, Mutex};

use docushark_relay::auth::WorkspaceRole;
use docushark_relay::mcp::PublicMount;
use docushark_relay::server::protocol::WorkspaceId;
use docushark_relay::server::{NetworkMode, ServerConfig, WebSocketServer};
use docushark_relay::test_support::OidcTestIssuer;
use serde_json::json;

#[tokio::test]
async fn public_mcp_rides_main_listener_and_requires_jwt() {
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

    // JP-210: fold MCP onto the public listener before start().
    // JP-235: capture the workspace the coarse reload nudge is routed to, so we
    // can assert a write authenticated as `ws-public` broadcasts to *that*
    // workspace and not the hard-coded `single_tenant()`.
    let routed: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let routed_sink = routed.clone();
    let on_doc_changed: Arc<docushark_relay::mcp::DocChangedSink> =
        Arc::new(move |ws: &WorkspaceId, _doc| {
            routed_sink.lock().unwrap().push(ws.as_str().to_string());
        });
    let on_doc_deleted: Arc<docushark_relay::mcp::DocDeletedSink> = Arc::new(|_, _| {});
    let mount = PublicMount::new(tmp.path().to_path_buf(), on_doc_changed, on_doc_deleted, None)
        .expect("mount");
    let static_token = mount.token();
    server.set_mcp_public_mount(mount).await;

    let bound = server.start(0).await.expect("server start");
    let http = bound
        .strip_prefix("ws://")
        .map(|rest| format!("http://{rest}"))
        .expect("ws url");

    let client = reqwest::Client::new();

    // RFC 9728 discovery doc is served on the *main* origin and echoes it.
    let meta: serde_json::Value = client
        .get(format!("{http}/.well-known/oauth-protected-resource"))
        .send()
        .await
        .expect("metadata request")
        .json()
        .await
        .expect("metadata json");
    assert_eq!(meta["resource"], format!("{http}/mcp"));
    assert!(
        meta["authorization_servers"][0]
            .as_str()
            .unwrap()
            .contains("test.docushark.local"),
        "advertises the configured issuer as the AS: {meta}"
    );

    // Unauthenticated /mcp → 401 with the RFC 9728 challenge.
    let resp = client
        .post(format!("{http}/mcp"))
        .json(&json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}))
        .send()
        .await
        .expect("unauth post");
    assert_eq!(resp.status(), reqwest::StatusCode::UNAUTHORIZED);
    assert!(
        resp.headers().contains_key("www-authenticate"),
        "401 carries the WWW-Authenticate challenge"
    );

    // The static token is refused on a public pod.
    let resp = client
        .post(format!("{http}/mcp"))
        .bearer_auth(&static_token)
        .json(&json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}))
        .send()
        .await
        .expect("static-token post");
    assert_eq!(
        resp.status(),
        reqwest::StatusCode::UNAUTHORIZED,
        "the static single-tenant token must not authenticate on a public pod"
    );

    // A `wsp`-scoped JWT is accepted and the tool surface answers.
    let jwt = issuer.mint("user-1", "ws-public", WorkspaceRole::Member);
    let resp = client
        .post(format!("{http}/mcp"))
        .bearer_auth(&jwt)
        .json(&json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}))
        .send()
        .await
        .expect("jwt post");
    assert_eq!(resp.status(), reqwest::StatusCode::OK);
    let body: serde_json::Value = resp.json().await.expect("tools json");
    let names: Vec<&str> = body["result"]["tools"]
        .as_array()
        .expect("tools array")
        .iter()
        .filter_map(|t| t["name"].as_str())
        .collect();
    assert!(names.contains(&"docushark_create_document"), "{names:?}");
    assert!(names.contains(&"docushark_get_skills"), "get_skills must be advertised: {names:?}");

    // JP-328: get_skills (no args) returns the content contract + catalogue.
    let resp = client
        .post(format!("{http}/mcp"))
        .bearer_auth(&jwt)
        .json(&json!({
            "jsonrpc": "2.0", "id": 10, "method": "tools/call",
            "params": {"name": "docushark_get_skills", "arguments": {}}
        }))
        .send()
        .await
        .expect("get_skills post");
    assert_eq!(resp.status(), reqwest::StatusCode::OK);
    let body: serde_json::Value = resp.json().await.expect("skills json");
    let sc = &body["result"]["structuredContent"];
    assert!(
        sc["contentContract"].as_str().unwrap_or("").contains("content contract"),
        "get_skills must surface the content contract: {body}"
    );
    assert!(sc["skills"].as_array().is_some_and(|a| !a.is_empty()), "catalogue: {body}");

    // JP-328: a traversal-style skill name is just an unknown slug — there is no
    // filesystem lookup, so it can only ever be a clean ERR_SKILL_NOT_FOUND.
    let resp = client
        .post(format!("{http}/mcp"))
        .bearer_auth(&jwt)
        .json(&json!({
            "jsonrpc": "2.0", "id": 11, "method": "tools/call",
            "params": {"name": "docushark_get_skills", "arguments": {"skill": "../../../../etc/passwd"}}
        }))
        .send()
        .await
        .expect("get_skills traversal post");
    let body: serde_json::Value = resp.json().await.expect("skills err json");
    assert_eq!(body["result"]["isError"], json!(true), "traversal name must error cleanly: {body}");

    // JP-235 (1): a write authenticated as `ws-public` routes the coarse reload
    // nudge to *that* workspace, not the catch-all `single_tenant()`.
    let resp = client
        .post(format!("{http}/mcp"))
        .bearer_auth(&jwt)
        .json(&json!({
            "jsonrpc": "2.0", "id": 2, "method": "tools/call",
            "params": {"name": "docushark_create_document", "arguments": {"name": "JP-235"}}
        }))
        .send()
        .await
        .expect("create_document post");
    assert_eq!(resp.status(), reqwest::StatusCode::OK);
    assert_eq!(
        routed.lock().unwrap().as_slice(),
        ["ws-public"],
        "the doc-changed nudge must broadcast to the writing workspace"
    );

    // JP-235 (2): a public mount forces local access off — `list_documents`
    // reports it disabled regardless of the persisted feature flag (default on).
    let resp = client
        .post(format!("{http}/mcp"))
        .bearer_auth(&jwt)
        .json(&json!({
            "jsonrpc": "2.0", "id": 3, "method": "tools/call",
            "params": {"name": "docushark_list_documents", "arguments": {}}
        }))
        .send()
        .await
        .expect("list_documents post");
    let body: serde_json::Value = resp.json().await.expect("list json");
    assert_eq!(
        body["result"]["structuredContent"]["localAccessEnabled"],
        json!(false),
        "public mount must hard-disable local access: {body}"
    );

    // The sync/REST surface still answers on the same listener.
    let health = client
        .get(format!("{http}/health"))
        .send()
        .await
        .expect("health");
    assert_eq!(health.status(), reqwest::StatusCode::OK);
}
