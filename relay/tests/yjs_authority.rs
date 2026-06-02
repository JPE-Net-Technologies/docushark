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
use docushark_relay::server::protocol::{
    encode_message, MESSAGE_AUTH, MESSAGE_AUTH_RESPONSE, MESSAGE_JOIN_DOC, MESSAGE_SYNC,
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
use yrs::{Any, Array, ArrayRef, Doc, Map, MapRef, ReadTxn, StateVector, Transact, Update};

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
