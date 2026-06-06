//! JP-34 — the relay holds an authoritative Y.Doc per active document.
//!
//! These tests drive a real in-process relay over a WebSocket and assert the
//! two guarantees JP-34 adds on top of the pre-existing opaque-forwarding
//! sync path:
//!
//!   1. **Authority on join** — a client that joins a doc and asks for state
//!      (`SyncStep1`) receives the relay's hydrated state (`SyncStep2`),
//!      with `shapeOrder` carrying each id exactly once (the no-duplication
//!      guarantee — the client adopts relay state rather than independently
//!      re-hydrating).
//!   2. **Live broadcast** — an `Update` from one client is applied to the
//!      authoritative Y.Doc and rebroadcast to the other client on the doc.
//!
//! The WS client harness mirrors `tests/cross_tenant_isolation.rs`.

use std::sync::Arc;
use std::time::Duration;

use docushark_relay::auth::WorkspaceRole;
use docushark_relay::config::{TenancyConfig, TenancyMode};
use docushark_relay::mcp::{McpConfig as InternalMcpConfig, McpServer};
use docushark_relay::server::protocol::{
    encode_message, DocId, MESSAGE_AUTH, MESSAGE_AUTH_RESPONSE, MESSAGE_JOIN_DOC, MESSAGE_SYNC,
    PROTOCOL_VERSION,
};
use docushark_relay::server::{NetworkMode, ServerConfig, WebSocketServer};
use docushark_relay::test_support::OidcTestIssuer;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tempfile::TempDir;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use yrs::sync::SyncMessage;
use yrs::updates::decoder::Decode;
use yrs::updates::encoder::Encode;
use yrs::{
    Any, Array, ArrayRef, Doc, GetString, Map, MapRef, ReadTxn, StateVector, Text, Transact, Update,
    XmlElementPrelim, XmlFragment, XmlOut, XmlTextPrelim,
};

// ----------------------------------------------------------------------
// Relay + WS client harness
// ----------------------------------------------------------------------

struct Relay {
    ws_base: String,
    http: String,
    server: Arc<WebSocketServer>,
    issuer: OidcTestIssuer,
    _tmp: TempDir,
}

async fn start_relay() -> Relay {
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
        .unwrap_or_else(|| bound.clone());

    Relay {
        ws_base: bound,
        http,
        server,
        issuer,
        _tmp: tmp,
    }
}

/// Seed a document over REST so JOIN_DOC's existence check passes and the
/// relay has a snapshot to hydrate from.
async fn put_doc(http: &str, token: &str, body: Value) {
    let id = body["id"].as_str().expect("doc id").to_string();
    let resp = reqwest::Client::new()
        .put(format!("{http}/api/docs/{id}"))
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .expect("PUT doc");
    assert!(resp.status().is_success(), "seed PUT: {}", resp.status());
}

type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

struct WsClient {
    stream: WsStream,
}

impl WsClient {
    async fn connect(ws_base: &str) -> Self {
        let url = format!("{ws_base}/ws?protocolVersion={PROTOCOL_VERSION}");
        let (stream, _resp) = tokio_tungstenite::connect_async(&url)
            .await
            .expect("ws connect");
        Self { stream }
    }

    async fn auth(&mut self, token: &str) {
        let frame = encode_message(MESSAGE_AUTH, &token.to_string()).expect("encode auth");
        self.stream
            .send(WsMessage::Binary(frame))
            .await
            .expect("send auth");
        loop {
            let msg = self.stream.next().await.expect("auth stream end").expect("auth");
            if let WsMessage::Binary(bytes) = msg {
                if bytes.first().copied() == Some(MESSAGE_AUTH_RESPONSE) {
                    let body: Value = serde_json::from_slice(&bytes[1..]).expect("auth json");
                    assert_eq!(body["success"], json!(true), "auth failed: {body}");
                    return;
                }
            }
        }
    }

    async fn join_doc(&mut self, doc_id: &str) {
        let frame =
            encode_message(MESSAGE_JOIN_DOC, &json!({ "docId": doc_id })).expect("encode join");
        self.stream
            .send(WsMessage::Binary(frame))
            .await
            .expect("send join");
    }

    async fn send_sync(&mut self, body: &[u8]) {
        let mut frame = Vec::with_capacity(1 + body.len());
        frame.push(MESSAGE_SYNC);
        frame.extend_from_slice(body);
        self.stream
            .send(WsMessage::Binary(frame))
            .await
            .expect("send sync");
    }

    async fn recv_within(&mut self, ms: u64) -> Option<(u8, Vec<u8>)> {
        match tokio::time::timeout(Duration::from_millis(ms), self.stream.next()).await {
            Ok(Some(Ok(WsMessage::Binary(bytes)))) => {
                let ty = *bytes.first()?;
                Some((ty, bytes))
            }
            _ => None,
        }
    }
}

/// A client-side Y.Doc that mirrors `YjsDocument`'s shared types.
struct LocalDoc {
    doc: Doc,
    shapes: MapRef,
    order: ArrayRef,
}

impl LocalDoc {
    fn new() -> Self {
        let doc = Doc::new();
        let shapes = doc.get_or_insert_map("shapes");
        let order = doc.get_or_insert_array("shapeOrder");
        Self { doc, shapes, order }
    }

    /// Apply any inbound SYNC frame; SyncStep2/Update are applied to the doc.
    /// Returns true if the frame mutated state.
    fn apply_frame(&self, full_bytes: &[u8]) -> bool {
        let Ok(msg) = SyncMessage::decode_v1(&full_bytes[1..]) else {
            return false;
        };
        let update = match msg {
            SyncMessage::SyncStep2(u) | SyncMessage::Update(u) => u,
            SyncMessage::SyncStep1(_) => return false,
        };
        let Ok(update) = Update::decode_v1(&update) else {
            return false;
        };
        self.doc.transact_mut().apply_update(update).is_ok()
    }

    /// Insert a shape locally and return the incremental update frame body
    /// (a `SyncMessage::Update`, lib0-encoded) the client would send.
    fn insert_shape_update(&self, id: &str) -> Vec<u8> {
        let before = self.doc.transact().state_vector();
        {
            let mut txn = self.doc.transact_mut();
            self.shapes.insert(&mut txn, id, sample_shape(id));
        }
        let update = self
            .doc
            .transact()
            .encode_state_as_update_v1(&before);
        SyncMessage::Update(update).encode_v1()
    }

    /// Insert prose text into a page's `prose:<page>` fragment (a Text type,
    /// not a shape) and return the incremental `Update` frame. Prose is invisible
    /// to the relay's shapes-only JSON flatten, so it only survives eviction via
    /// the binary sidecar (JP-108).
    fn insert_prose_update(&self, page: &str, text: &str) -> Vec<u8> {
        let before = self.doc.transact().state_vector();
        // Grab the shared-type handle before opening a txn (get_or_insert_*
        // transacts internally; doing it under a live txn deadlocks).
        let prose = self.doc.get_or_insert_text(format!("prose:{page}"));
        {
            let mut txn = self.doc.transact_mut();
            prose.insert(&mut txn, 0, text);
        }
        let update = self.doc.transact().encode_state_as_update_v1(&before);
        SyncMessage::Update(update).encode_v1()
    }

    fn prose_text(&self, page: &str) -> String {
        let prose = self.doc.get_or_insert_text(format!("prose:{page}"));
        prose.get_string(&self.doc.transact())
    }

    /// Render the page's `prose:<page>` XmlFragment to a flat string (the PM-XML
    /// shape, e.g. `<paragraph>text</paragraph>`) — enough to assert content
    /// arrived live from a relay-side write.
    fn prose_fragment_string(&self, page: &str) -> String {
        let frag = self.doc.get_or_insert_xml_fragment(format!("prose:{page}"));
        let txn = self.doc.transact();
        let mut s = String::new();
        for node in frag.children(&txn) {
            match node {
                XmlOut::Element(el) => s.push_str(&el.get_string(&txn)),
                XmlOut::Text(t) => s.push_str(&t.get_string(&txn)),
                XmlOut::Fragment(_) => {}
            }
        }
        s
    }

    /// Insert a paragraph into a page's `prose:<page>` fragment as a real
    /// `XmlFragment` (paragraph element + text) — the shape y-prosemirror
    /// produces — so the relay can serialize it to HTML (JP-201). Returns the
    /// `Update` frame a client would send.
    fn insert_prose_paragraph(&self, page: &str, text: &str) -> Vec<u8> {
        let before = self.doc.transact().state_vector();
        let frag = self.doc.get_or_insert_xml_fragment(format!("prose:{page}"));
        {
            let mut txn = self.doc.transact_mut();
            let p = frag.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
            p.push_back(&mut txn, XmlTextPrelim::new(text));
        }
        let update = self.doc.transact().encode_state_as_update_v1(&before);
        SyncMessage::Update(update).encode_v1()
    }

    fn has_shape(&self, id: &str) -> bool {
        self.shapes.contains_key(&self.doc.transact(), id)
    }

    fn order_len(&self) -> u32 {
        self.order.len(&self.doc.transact())
    }
}

fn sample_shape(id: &str) -> Any {
    Any::Map(std::sync::Arc::new(std::collections::HashMap::from([
        ("id".to_string(), Any::String(id.into())),
        ("type".to_string(), Any::String("rectangle".into())),
        ("x".to_string(), Any::Number(5.0)),
        ("y".to_string(), Any::Number(6.0)),
    ])))
}

// ----------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------

#[tokio::test]
async fn join_delivers_authoritative_state_without_duplication() {
    let relay = start_relay().await;
    let token = relay.issuer.mint("alice", "default", WorkspaceRole::Owner);

    put_doc(
        &relay.http,
        &token,
        json!({
            "id": "doc-a", "name": "Authority", "pageOrder": ["p1"],
            "activePageId": "p1", "createdAt": 1, "modifiedAt": 2,
            "ownerId": "alice", "ownerName": "alice",
            "pages": {"p1": {
                "id": "p1",
                "shapes": {"s1": {"id": "s1", "type": "rectangle", "x": 10, "y": 20}},
                "shapeOrder": ["s1"]
            }}
        }),
    )
    .await;

    let mut client = WsClient::connect(&relay.ws_base).await;
    client.auth(&token).await;
    client.join_doc("doc-a").await;

    // Ask the relay for full state; an empty state vector means "I have nothing".
    let local = LocalDoc::new();
    client
        .send_sync(&SyncMessage::SyncStep1(StateVector::default()).encode_v1())
        .await;

    // Read frames until the seeded shape lands (relay sends its own SyncStep1
    // plus the SyncStep2 answer to ours).
    for _ in 0..10 {
        if let Some((ty, bytes)) = client.recv_within(300).await {
            if ty == MESSAGE_SYNC {
                local.apply_frame(&bytes);
            }
        }
        if local.has_shape("s1") {
            break;
        }
    }

    assert!(
        local.has_shape("s1"),
        "client did not receive the relay's authoritative shape"
    );
    assert_eq!(
        local.order_len(),
        1,
        "shapeOrder must carry s1 exactly once — no independent-hydration dup"
    );

    relay.server.stop().await.expect("stop");
}

#[tokio::test]
async fn update_from_one_client_reaches_the_other() {
    let relay = start_relay().await;
    let token = relay.issuer.mint("alice", "default", WorkspaceRole::Owner);

    put_doc(
        &relay.http,
        &token,
        json!({
            "id": "doc-b", "name": "Live", "pageOrder": ["p1"],
            "activePageId": "p1", "ownerId": "alice", "ownerName": "alice",
            "pages": {"p1": {"id": "p1", "shapes": {}, "shapeOrder": []}}
        }),
    )
    .await;

    // Two clients on the same doc.
    let mut a = WsClient::connect(&relay.ws_base).await;
    a.auth(&token).await;
    a.join_doc("doc-b").await;
    let a_local = LocalDoc::new();

    let mut b = WsClient::connect(&relay.ws_base).await;
    b.auth(&token).await;
    b.join_doc("doc-b").await;
    let b_local = LocalDoc::new();

    // Both sync to the (empty) authoritative doc first so they share roots.
    for client_doc in [(&mut a, &a_local), (&mut b, &b_local)] {
        let (client, local) = client_doc;
        client
            .send_sync(&SyncMessage::SyncStep1(StateVector::default()).encode_v1())
            .await;
        for _ in 0..5 {
            if let Some((ty, bytes)) = client.recv_within(150).await {
                if ty == MESSAGE_SYNC {
                    local.apply_frame(&bytes);
                }
            }
        }
    }

    // A inserts a shape and sends the incremental update.
    let update = a_local.insert_shape_update("s2");
    a.send_sync(&update).await;

    // B must receive and apply it.
    let mut delivered = false;
    for _ in 0..12 {
        if let Some((ty, bytes)) = b.recv_within(300).await {
            if ty == MESSAGE_SYNC {
                b_local.apply_frame(&bytes);
            }
        }
        if b_local.has_shape("s2") {
            delivered = true;
            break;
        }
    }

    assert!(
        delivered,
        "peer B never received A's shape via the authoritative relay broadcast"
    );

    relay.server.stop().await.expect("stop");
}

// ----------------------------------------------------------------------
// JP-36 — relay-side persistence (no client REST save required)
// ----------------------------------------------------------------------

/// REST `GET /api/docs/:id` → the doc body.
async fn get_doc(http: &str, token: &str, id: &str) -> Value {
    reqwest::Client::new()
        .get(format!("{http}/api/docs/{id}"))
        .bearer_auth(token)
        .send()
        .await
        .expect("GET doc")
        .json()
        .await
        .expect("doc json")
}

/// Join a doc and pull the relay's authoritative state into `local`.
async fn join_and_sync(client: &mut WsClient, local: &LocalDoc, doc_id: &str) {
    client.join_doc(doc_id).await;
    client
        .send_sync(&SyncMessage::SyncStep1(StateVector::default()).encode_v1())
        .await;
    for _ in 0..6 {
        if let Some((ty, bytes)) = client.recv_within(150).await {
            if ty == MESSAGE_SYNC {
                local.apply_frame(&bytes);
            }
        }
    }
}

#[tokio::test]
async fn evict_flush_persists_without_rest_save() {
    let relay = start_relay().await;
    let token = relay.issuer.mint("alice", "default", WorkspaceRole::Owner);

    put_doc(
        &relay.http,
        &token,
        json!({
            "id": "persist-doc", "name": "Persist", "pageOrder": ["p1"],
            "activePageId": "p1", "ownerId": "alice", "ownerName": "alice",
            "pages": {"p1": {"id": "p1", "shapes": {}, "shapeOrder": []}}
        }),
    )
    .await;

    let version_before = get_doc(&relay.http, &token, "persist-doc").await["serverVersion"].clone();

    // Client edits over CRDT only — never calls REST save.
    let mut client = WsClient::connect(&relay.ws_base).await;
    client.auth(&token).await;
    let local = LocalDoc::new();
    join_and_sync(&mut client, &local, "persist-doc").await;
    client.send_sync(&local.insert_shape_update("s1")).await;
    // Let the relay apply the update before we disconnect.
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;

    // Disconnecting drops the last participant → relay evict-flush snapshots.
    drop(client);
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;

    let doc = get_doc(&relay.http, &token, "persist-doc").await;
    assert!(
        doc["pages"]["p1"]["shapes"].get("s1").is_some(),
        "shape was not persisted by the relay (no client REST save): {doc}"
    );
    assert_eq!(
        doc["serverVersion"], version_before,
        "relay snapshot must not bump serverVersion"
    );

    relay.server.stop().await.expect("stop");
}

/// JP-108: prose (a non-shape shared type) must survive eviction. The relay's
/// JSON snapshot is shapes-only, so the only way a fresh client gets the prose
/// back is the binary `Y.Doc` sidecar persisted on evict-flush and re-hydrated
/// on the next join.
#[tokio::test]
async fn prose_survives_eviction_via_binary_sidecar() {
    let relay = start_relay().await;
    let token = relay.issuer.mint("alice", "default", WorkspaceRole::Owner);

    put_doc(
        &relay.http,
        &token,
        json!({
            "id": "prose-doc", "name": "Prose", "pageOrder": ["p1"],
            "activePageId": "p1", "ownerId": "alice", "ownerName": "alice",
            "pages": {"p1": {"id": "p1", "shapes": {}, "shapeOrder": []}}
        }),
    )
    .await;

    // Client A writes prose over CRDT, then leaves (last participant → evict).
    let mut a = WsClient::connect(&relay.ws_base).await;
    a.auth(&token).await;
    let local_a = LocalDoc::new();
    join_and_sync(&mut a, &local_a, "prose-doc").await;
    a.send_sync(&local_a.insert_prose_update("p1", "hello from prose"))
        .await;
    tokio::time::sleep(Duration::from_millis(150)).await;
    drop(a);
    tokio::time::sleep(Duration::from_millis(400)).await;

    // A fresh client joins; the relay re-hydrates (from the binary sidecar) and
    // answers SyncStep1 with state that still carries the prose.
    let mut b = WsClient::connect(&relay.ws_base).await;
    b.auth(&token).await;
    let local_b = LocalDoc::new();
    join_and_sync(&mut b, &local_b, "prose-doc").await;
    assert_eq!(
        local_b.prose_text("p1"),
        "hello from prose",
        "prose did not survive eviction — binary Y.Doc sidecar not used on re-hydrate"
    );

    relay.server.stop().await.expect("stop");
}

#[tokio::test]
async fn snapshot_skips_when_active_page_diverged() {
    let relay = start_relay().await;
    let token = relay.issuer.mint("alice", "default", WorkspaceRole::Owner);

    put_doc(
        &relay.http,
        &token,
        json!({
            "id": "div-doc", "name": "Diverge", "pageOrder": ["p1", "p2"],
            "activePageId": "p1", "ownerId": "alice", "ownerName": "alice",
            "pages": {
                "p1": {"id": "p1", "shapes": {}, "shapeOrder": []},
                "p2": {"id": "p2", "shapes": {}, "shapeOrder": []}
            }
        }),
    )
    .await;

    // Client hydrates page p1 and edits it.
    let mut client = WsClient::connect(&relay.ws_base).await;
    client.auth(&token).await;
    let local = LocalDoc::new();
    join_and_sync(&mut client, &local, "div-doc").await;
    client.send_sync(&local.insert_shape_update("s1")).await;
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;

    // Stored active page diverges from the hydrated page (now p2).
    put_doc(
        &relay.http,
        &token,
        json!({
            "id": "div-doc", "name": "Diverge", "pageOrder": ["p1", "p2"],
            "activePageId": "p2", "ownerId": "alice", "ownerName": "alice",
            "pages": {
                "p1": {"id": "p1", "shapes": {}, "shapeOrder": []},
                "p2": {"id": "p2", "shapes": {}, "shapeOrder": []}
            }
        }),
    )
    .await;

    drop(client);
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;

    // The relay must NOT have written the hydrated-page (p1) shapes into the
    // doc — the divergence guard skips rather than risk the wrong page.
    let doc = get_doc(&relay.http, &token, "div-doc").await;
    assert!(
        doc["pages"]["p1"]["shapes"].get("s1").is_none(),
        "divergence guard failed: relay wrote s1 into p1 despite activePageId=p2: {doc}"
    );

    relay.server.stop().await.expect("stop");
}

// ----------------------------------------------------------------------
// JP-35 — MCP shape writes target the live Y.Doc and reach connected clients
// ----------------------------------------------------------------------

/// Bring up the embedded MCP server sharing the *same* live registry +
/// broadcast channel as the running relay — the exact wiring `main.rs` does
/// post-`start()`. Returns the server handle + its `http://host:port` base.
async fn enable_mcp(relay: &Relay) -> (Arc<McpServer>, String) {
    let on_doc_changed: Arc<dyn Fn(DocId) + Send + Sync> = Arc::new(|_| {});
    let panic_counter = relay.server.panic_counter_handle();
    let rate_limit_rejections = relay.server.rate_limit_rejections_handle();
    let write_limiter = relay.server.build_write_limiter().await;
    let sync_registry = relay.server.sync_registry_handle().await;
    let on_doc_update = relay.server.doc_update_broadcaster().await;
    // JP-230: MCP shares the WS server's single DocumentStore (built on start()).
    let shared_doc_store = relay
        .server
        .get_doc_store()
        .await
        .expect("doc store available after start");
    let mcp = Arc::new(
        McpServer::new(
            relay._tmp.path().to_path_buf(),
            on_doc_changed,
            panic_counter,
            rate_limit_rejections,
            write_limiter,
            relay.issuer.auth_state(),
            "default".to_string(),
            sync_registry,
            on_doc_update,
            shared_doc_store,
        )
        .expect("McpServer::new"),
    );
    mcp.set_config(InternalMcpConfig { port: 0 })
        .await
        .expect("mcp set_config");
    let base = mcp.start().await.expect("mcp start");
    (mcp, base)
}

/// Call `docushark.add_shape` over the MCP HTTP endpoint, authenticating with
/// a relay JWT (same workspace as the WS editor). Returns the new shape id.
async fn mcp_add_shape(mcp_base: &str, token: &str, doc_id: &str, page_id: &str) -> String {
    let body = json!({
        "jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": {"name": "docushark.add_shape", "arguments": {
            "docId": doc_id, "pageId": page_id,
            "shape": {"kind": "rectangle", "x": 42.0, "y": 7.0}
        }}
    });
    let res: Value = reqwest::Client::new()
        .post(format!("{mcp_base}/mcp"))
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .expect("mcp post")
        .json()
        .await
        .expect("mcp json");
    res["result"]["structuredContent"]["id"]
        .as_str()
        .unwrap_or_else(|| panic!("no shape id in MCP result: {res}"))
        .to_string()
}

/// Call `docushark.get_prose` over MCP and return the `structuredContent`.
async fn mcp_get_prose(mcp_base: &str, token: &str, doc_id: &str) -> Value {
    let body = json!({
        "jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": {"name": "docushark.get_prose", "arguments": {"docId": doc_id}}
    });
    let res: Value = reqwest::Client::new()
        .post(format!("{mcp_base}/mcp"))
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .expect("mcp post")
        .json()
        .await
        .expect("mcp json");
    res["result"]["structuredContent"].clone()
}

/// JP-201: an MCP `get_prose` of a resident doc reflects prose a connected
/// editor just typed into the live Y.Doc — *before* any snapshot flatten —
/// where the JSON store still shows the old (empty) content.
#[tokio::test]
async fn jp201_mcp_get_prose_reads_live_prose_fragment() {
    let relay = start_relay().await;
    let (mcp, mcp_base) = enable_mcp(&relay).await;
    let token = relay.issuer.mint("alice", "default", WorkspaceRole::Owner);

    // Seed a doc whose JSON prose page `rt1` is empty.
    put_doc(
        &relay.http,
        &token,
        json!({
            "id": "doc-prose", "name": "Prose", "pageOrder": ["p1"],
            "activePageId": "p1", "ownerId": "alice", "ownerName": "alice",
            "pages": {"p1": {"id": "p1", "shapes": {}, "shapeOrder": []}},
            "richTextPages": {
                "pageOrder": ["rt1"],
                "pages": {"rt1": {"name": "Page 1", "order": 0, "content": "<p></p>"}}
            }
        }),
    )
    .await;

    // Cold read (no client connected) → the JSON projection: empty.
    let cold = mcp_get_prose(&mcp_base, &token, "doc-prose").await;
    assert_eq!(cold["pages"][0]["content"], "<p></p>", "cold read serves JSON");

    // An editor connects + joins → doc becomes resident, then types prose into
    // `rt1`'s fragment (a live Y.Doc update, never a REST save).
    let mut editor = WsClient::connect(&relay.ws_base).await;
    editor.auth(&token).await;
    let local = LocalDoc::new();
    join_and_sync(&mut editor, &local, "doc-prose").await;
    editor
        .send_sync(&local.insert_prose_paragraph("rt1", "Hello live"))
        .await;

    // Resident read reflects the live fragment within one snapshot interval
    // (default 10s; we poll well under it, so no flatten has run).
    let mut content = String::new();
    for _ in 0..25 {
        let res = mcp_get_prose(&mcp_base, &token, "doc-prose").await;
        content = res["pages"][0]["content"].as_str().unwrap_or("").to_string();
        if content.contains("Hello live") {
            // Page metadata still comes from JSON (not CRDT-synced).
            assert_eq!(res["pages"][0]["name"], "Page 1", "name preserved from JSON");
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(content, "<p>Hello live</p>", "resident read serves the live Y.Doc prose");

    mcp.stop().await.ok();
    relay.server.stop().await.expect("stop");
}

/// Call `docushark.set_prose` over MCP (markdown content).
async fn mcp_set_prose(mcp_base: &str, token: &str, doc_id: &str, page_id: &str, content: &str) {
    let body = json!({
        "jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": {"name": "docushark.set_prose", "arguments": {
            "docId": doc_id, "pageId": page_id, "content": content, "format": "markdown"
        }}
    });
    let res: Value = reqwest::Client::new()
        .post(format!("{mcp_base}/mcp"))
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .expect("mcp post")
        .json()
        .await
        .expect("mcp json");
    assert_eq!(res["result"]["structuredContent"]["ok"], true, "set_prose failed: {res}");
}

/// JP-238: an MCP `set_prose` on a **resident** doc rebuilds the live `prose:`
/// fragment and broadcasts the delta — a connected WS editor receives it live
/// (the write-side mirror of the JP-201 read test).
#[tokio::test]
async fn jp238_mcp_set_prose_reaches_connected_editor() {
    let relay = start_relay().await;
    let (mcp, mcp_base) = enable_mcp(&relay).await;
    let token = relay.issuer.mint("alice", "default", WorkspaceRole::Owner);

    put_doc(
        &relay.http,
        &token,
        json!({
            "id": "doc-write", "name": "Write", "pageOrder": ["p1"],
            "activePageId": "p1", "ownerId": "alice", "ownerName": "alice",
            "pages": {"p1": {"id": "p1", "shapes": {}, "shapeOrder": []}},
            "richTextPages": {
                "pageOrder": ["rt1"],
                "pages": {"rt1": {"name": "Page 1", "order": 0, "content": "<p></p>"}}
            }
        }),
    )
    .await;

    // Editor joins → doc resident.
    let mut editor = WsClient::connect(&relay.ws_base).await;
    editor.auth(&token).await;
    let local = LocalDoc::new();
    join_and_sync(&mut editor, &local, "doc-write").await;

    // MCP agent writes prose.
    mcp_set_prose(&mcp_base, &token, "doc-write", "rt1", "Agent wrote this").await;

    // The editor receives the prose delta live (merges, no reload).
    let mut delivered = false;
    for _ in 0..25 {
        if let Some((ty, bytes)) = editor.recv_within(200).await {
            if ty == MESSAGE_SYNC {
                local.apply_frame(&bytes);
            }
        }
        if local.prose_fragment_string("rt1").contains("Agent wrote this") {
            delivered = true;
            break;
        }
    }
    assert!(delivered, "editor never received the MCP prose via the live broadcast path");

    // And an MCP read reflects it too.
    let prose = mcp_get_prose(&mcp_base, &token, "doc-write").await;
    assert!(
        prose["pages"][0]["content"].as_str().unwrap_or("").contains("Agent wrote this"),
        "get_prose did not reflect the write: {prose}"
    );

    mcp.stop().await.ok();
    relay.server.stop().await.expect("stop");
}

/// JP-201 Slice 3: the snapshot flatten projects live prose into the JSON
/// `richTextPages`, so a cold reader (REST / non-resident MCP) sees prose the
/// shape-only flatten never wrote — without re-seeding the Y.Doc (restore stays
/// binary-sidecar based).
#[tokio::test]
async fn jp201_flatten_projects_prose_into_json_on_evict() {
    let relay = start_relay().await;
    let token = relay.issuer.mint("alice", "default", WorkspaceRole::Owner);

    put_doc(
        &relay.http,
        &token,
        json!({
            "id": "flat-prose", "name": "Flat", "pageOrder": ["p1"],
            "activePageId": "p1", "ownerId": "alice", "ownerName": "alice",
            "pages": {"p1": {"id": "p1", "shapes": {}, "shapeOrder": []}},
            "richTextPages": {
                "pageOrder": ["rt1"],
                "pages": {"rt1": {"id": "rt1", "name": "Page 1", "order": 0, "content": "<p></p>"}}
            }
        }),
    )
    .await;

    // A client types prose, then leaves (last participant → evict-flush).
    let mut a = WsClient::connect(&relay.ws_base).await;
    a.auth(&token).await;
    let local = LocalDoc::new();
    join_and_sync(&mut a, &local, "flat-prose").await;
    a.send_sync(&local.insert_prose_paragraph("rt1", "Durable prose"))
        .await;
    tokio::time::sleep(Duration::from_millis(150)).await;
    drop(a);
    tokio::time::sleep(Duration::from_millis(400)).await;

    // Cold REST read now carries the prose (projected by the flatten).
    let doc = get_doc(&relay.http, &token, "flat-prose").await;
    assert_eq!(
        doc["richTextPages"]["pages"]["rt1"]["content"], "<p>Durable prose</p>",
        "flatten projected live prose into JSON: {doc}"
    );
    assert_eq!(
        doc["richTextPages"]["pages"]["rt1"]["name"], "Page 1",
        "JSON page name preserved"
    );

    relay.server.stop().await.expect("stop");
}

#[tokio::test]
async fn jp35_mcp_live_write_reaches_connected_client() {
    let relay = start_relay().await;
    let (mcp, mcp_base) = enable_mcp(&relay).await;
    let token = relay.issuer.mint("alice", "default", WorkspaceRole::Owner);
    println!("\n● relay + MCP up; JWT minted in-process (no OAuth / real workspace needed)");

    put_doc(
        &relay.http,
        &token,
        json!({
            "id": "doc-live", "name": "Live MCP", "pageOrder": ["p1"],
            "activePageId": "p1", "ownerId": "alice", "ownerName": "alice",
            "pages": {"p1": {"id": "p1", "shapes": {}, "shapeOrder": []}}
        }),
    )
    .await;
    println!("● seeded doc-live (active page p1, 0 shapes)");

    // An editor connects + joins → the doc becomes RESIDENT (live).
    let mut editor = WsClient::connect(&relay.ws_base).await;
    editor.auth(&token).await;
    let local = LocalDoc::new();
    join_and_sync(&mut editor, &local, "doc-live").await;
    println!(
        "● editor connected + joined doc-live → now resident/live ({} shapes synced)",
        local.order_len()
    );

    // An MCP agent writes a shape over HTTP.
    let new_id = mcp_add_shape(&mcp_base, &token, "doc-live", "p1").await;
    println!("● MCP agent called add_shape → new shape id = {new_id}");

    // The editor receives the CRDT delta LIVE — it merges, no reload.
    let mut delivered = false;
    for _ in 0..25 {
        if let Some((ty, bytes)) = editor.recv_within(200).await {
            if ty == MESSAGE_SYNC {
                local.apply_frame(&bytes);
            }
        }
        if local.has_shape(&new_id) {
            delivered = true;
            break;
        }
    }
    println!("● editor received the MCP-authored shape live: {delivered}");
    assert!(
        delivered,
        "editor never received the MCP shape via the live broadcast path"
    );

    // The JSON snapshot was NOT rewritten — the live path leaves durability to
    // the JP-36 snapshot sweeper, exactly like a human editor's own edits.
    let doc = get_doc(&relay.http, &token, "doc-live").await;
    let json_shapes = doc["pages"]["p1"]["shapes"].as_object().unwrap().len();
    println!(
        "● on-disk JSON still has {json_shapes} shape(s) — live write skipped JSON (sweeper persists later)"
    );
    assert_eq!(json_shapes, 0, "live write must not touch the JSON store");

    println!("✓ JP-35 live path verified end-to-end over real sockets\n");
    mcp.stop().await.ok();
    relay.server.stop().await.expect("stop");
}
