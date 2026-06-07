//! JP-230 regression: MCP- and editor-authored docs must not clobber each
//! other's `index.json`.
//!
//! Before the fix the relay ran two `DocumentStore` instances over the same
//! per-workspace index — an editor (REST/WS) save rewrote `index.json` from its
//! stale in-memory view and **dropped** a doc the MCP store had just created.
//! The fix shares one `DocumentStore` between the WS server and MCP. This test
//! reproduces the exact scenario: create a doc via MCP, save a *different* doc
//! via REST, and assert both survive in the REST **and** MCP listings.
//!
//! The MCP static token and a REST OIDC token minted for `"default"` resolve to
//! the same single-tenant workspace, so both writes target the same index.

use std::sync::Arc;

use docushark_relay::auth::WorkspaceRole;
use docushark_relay::mcp::{McpConfig as InternalMcpConfig, McpServer};
use docushark_relay::server::protocol::{DocId, WorkspaceId};
use docushark_relay::server::{NetworkMode, ServerConfig, WebSocketServer};
use docushark_relay::test_support::OidcTestIssuer;
use serde_json::json;

#[tokio::test]
async fn mcp_create_and_editor_save_dont_clobber_the_index() {
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
    let bound = server.start(0).await.expect("server start");
    let http = bound
        .strip_prefix("ws://")
        .map(|rest| format!("http://{rest}"))
        .unwrap_or(bound);

    // JP-230: MCP shares the server's single DocumentStore (built on start()).
    let shared_doc_store = server
        .get_doc_store()
        .await
        .expect("doc store available after start");
    let on_doc_changed: Arc<docushark_relay::mcp::DocChangedSink> = Arc::new(|_, _| {});
    let on_doc_update: Arc<dyn Fn(&WorkspaceId, &DocId, Vec<u8>) + Send + Sync> =
        Arc::new(|_, _, _| {});
    let mcp = Arc::new(
        McpServer::new(
            tmp.path().to_path_buf(),
            on_doc_changed,
            server.panic_counter_handle(),
            server.rate_limit_rejections_handle(),
            server.build_write_limiter().await,
            None, // JP-249: MCP read limiter (unlimited in this test)
            issuer.auth_state(),
            "default".to_string(),
            server.sync_registry_handle().await,
            on_doc_update,
            shared_doc_store,
        )
        .expect("McpServer::new"),
    );
    mcp.set_config(InternalMcpConfig { port: 0 })
        .await
        .expect("mcp set_config");
    let mcp_base = mcp.start().await.expect("mcp start");
    let mcp_token = mcp.get_token().await;

    let client = reqwest::Client::new();

    // 1) Create a doc via MCP (static token → workspace "default").
    let res = client
        .post(format!("{mcp_base}/mcp"))
        .bearer_auth(&mcp_token)
        .json(&json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": "docushark.create_document",
                "arguments": { "name": "MCP Doc" }
            }
        }))
        .send()
        .await
        .expect("mcp create");
    assert_eq!(res.status().as_u16(), 200, "MCP create_document");

    // 2) Save a DIFFERENT doc via the editor (REST), same workspace "default".
    let bearer = format!("Bearer {}", issuer.mint("alice", "default", WorkspaceRole::Owner));
    let res = client
        .put(format!("{http}/api/docs/editor-doc"))
        .header(reqwest::header::AUTHORIZATION, &bearer)
        .json(&json!({
            "id": "editor-doc",
            "name": "Editor Doc",
            "version": 1,
            "pages": [],
            "createdAt": 1000,
            "modifiedAt": 1000
        }))
        .send()
        .await
        .expect("rest save");
    assert_eq!(res.status().as_u16(), 200, "REST save");

    // 3) The REST listing — the WS-path store that used to clobber — must show
    //    BOTH. Pre-fix this returned only "Editor Doc".
    let res = client
        .get(format!("{http}/api/docs"))
        .header(reqwest::header::AUTHORIZATION, &bearer)
        .send()
        .await
        .expect("rest list");
    assert_eq!(res.status().as_u16(), 200);
    let body: serde_json::Value = res.json().await.unwrap();
    let names: Vec<&str> = body["documents"]
        .as_array()
        .expect("documents array")
        .iter()
        .filter_map(|d| d["name"].as_str())
        .collect();
    assert!(names.contains(&"MCP Doc"), "MCP doc dropped from REST listing: {names:?}");
    assert!(names.contains(&"Editor Doc"), "editor doc missing: {names:?}");
    assert_eq!(names.len(), 2, "exactly the two docs, no clobber: {names:?}");

    // 4) The MCP listing must agree (shared store).
    let res = client
        .post(format!("{mcp_base}/mcp"))
        .bearer_auth(&mcp_token)
        .json(&json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": { "name": "docushark.list_documents", "arguments": {} }
        }))
        .send()
        .await
        .expect("mcp list");
    assert_eq!(res.status().as_u16(), 200);
    let text = res.text().await.unwrap();
    assert!(
        text.contains("MCP Doc") && text.contains("Editor Doc"),
        "MCP list_documents missing a doc: {text}"
    );

    mcp.stop().await.expect("mcp stop");
    server.stop().await.expect("server stop");
}
