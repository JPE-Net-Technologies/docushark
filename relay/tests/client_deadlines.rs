//! DSK-232: one connection can't hold up the others, over real sockets.
//!
//! A connection that doesn't authenticate may only authenticate or send
//! heartbeats, and is closed after a deadline. A client that stops taking
//! delivery is dropped once a frame goes unwritten past its deadline, while
//! everyone else carries on.

use std::sync::Arc;
use std::time::Duration;

use docushark_relay::auth::WorkspaceRole;
use docushark_relay::config::TenancyConfig;
use docushark_relay::server::protocol::{
    encode_message, WorkspaceId, MESSAGE_AUTH, MESSAGE_AUTH_RESPONSE, MESSAGE_HEARTBEAT,
    MESSAGE_JOIN_DOC, MESSAGE_SYNC, PROTOCOL_VERSION,
};
use docushark_relay::server::{ClientDeadlines, NetworkMode, ServerConfig, WebSocketServer};
use docushark_relay::test_support::OidcTestIssuer;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tempfile::TempDir;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::{TcpSocket, TcpStream};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

struct Relay {
    ws_base: String,
    issuer: OidcTestIssuer,
    server: Arc<WebSocketServer>,
    _tmp: TempDir,
}

async fn start(deadlines: ClientDeadlines) -> Relay {
    let tmp = tempfile::tempdir().expect("tempdir");
    let issuer = OidcTestIssuer::new().await;
    let server = Arc::new(WebSocketServer::new());
    server.set_app_data_dir(tmp.path().to_path_buf()).await;
    server.set_auth(issuer.auth_state()).await;
    server.set_tenancy(TenancyConfig::default()).await;
    server.set_client_deadlines(deadlines).await;
    server
        .set_config(ServerConfig {
            port: 0,
            network_mode: NetworkMode::Localhost,
            max_connections: 0,
        })
        .await
        .expect("set_config");
    let ws_base = server.start(0).await.expect("start");
    Relay {
        ws_base,
        issuer,
        server,
        _tmp: tmp,
    }
}

fn ws_url(relay: &Relay) -> String {
    format!("{}/ws?protocolVersion={}", relay.ws_base, PROTOCOL_VERSION)
}

async fn connect(relay: &Relay) -> WebSocketStream<MaybeTlsStream<TcpStream>> {
    tokio_tungstenite::connect_async(ws_url(relay))
        .await
        .expect("ws connect")
        .0
}

/// A connection with a tiny receive buffer that the test stops reading, so the
/// relay's frames back up almost at once.
async fn connect_never_reading(relay: &Relay) -> WebSocketStream<TcpStream> {
    let host = relay.ws_base.strip_prefix("ws://").expect("ws url");
    // The name can resolve to more addresses than the relay listens on.
    for addr in tokio::net::lookup_host(host).await.expect("resolve") {
        let socket = if addr.is_ipv4() {
            TcpSocket::new_v4()
        } else {
            TcpSocket::new_v6()
        }
        .expect("socket");
        socket.set_recv_buffer_size(4096).expect("receive buffer");
        if let Ok(stream) = socket.connect(addr).await {
            return tokio_tungstenite::client_async(ws_url(relay), stream)
                .await
                .expect("ws handshake")
                .0;
        }
    }
    panic!("could not connect to {host}");
}

/// The next binary frame, or `None` if the connection ends or nothing arrives
/// within `wait`.
async fn next_binary<T>(ws: &mut WebSocketStream<T>, wait: Duration) -> Option<Vec<u8>>
where
    T: AsyncRead + AsyncWrite + Unpin,
{
    let deadline = tokio::time::Instant::now() + wait;
    loop {
        match tokio::time::timeout_at(deadline, ws.next()).await {
            Ok(Some(Ok(Message::Binary(data)))) => return Some(data),
            Ok(Some(Ok(Message::Close(_)))) | Ok(Some(Err(_))) | Ok(None) | Err(_) => return None,
            Ok(Some(Ok(_))) => {}
        }
    }
}

/// Whether the relay closes the connection within `wait`, reading past anything
/// it delivered first.
async fn closed_within<T>(ws: &mut WebSocketStream<T>, wait: Duration) -> bool
where
    T: AsyncRead + AsyncWrite + Unpin,
{
    let deadline = tokio::time::Instant::now() + wait;
    loop {
        match tokio::time::timeout_at(deadline, ws.next()).await {
            Err(_) => return false,
            Ok(None) | Ok(Some(Err(_))) | Ok(Some(Ok(Message::Close(_)))) => return true,
            Ok(Some(Ok(_))) => {}
        }
    }
}

async fn authenticate<T>(ws: &mut WebSocketStream<T>, token: &str)
where
    T: AsyncRead + AsyncWrite + Unpin,
{
    let frame = encode_message(MESSAGE_AUTH, &token.to_string()).expect("encode auth");
    ws.send(Message::Binary(frame)).await.expect("send auth");
    loop {
        let frame = next_binary(ws, Duration::from_secs(5)).await.expect("an auth response");
        if frame.first().copied() == Some(MESSAGE_AUTH_RESPONSE) {
            let response: Value = serde_json::from_slice(&frame[1..]).expect("auth response json");
            assert_eq!(response["success"], true, "auth: {response}");
            return;
        }
    }
}

/// Whether the relay echoes a heartbeat within a second.
async fn heartbeat<T>(ws: &mut WebSocketStream<T>) -> bool
where
    T: AsyncRead + AsyncWrite + Unpin,
{
    ws.send(Message::Binary(vec![MESSAGE_HEARTBEAT]))
        .await
        .expect("send heartbeat");
    loop {
        match next_binary(ws, Duration::from_secs(1)).await {
            Some(frame) if frame == [MESSAGE_HEARTBEAT] => return true,
            Some(_) => {}
            None => return false,
        }
    }
}

#[tokio::test]
async fn an_unauthenticated_connection_may_only_authenticate_and_is_closed_in_time() {
    let relay = start(ClientDeadlines {
        auth: Duration::from_millis(500),
        ..ClientDeadlines::default()
    })
    .await;
    let mut ws = connect(&relay).await;

    // A join is refused outright for an unknown document, so if it were handled
    // its error would arrive first. Before authenticating it gets nothing, and
    // the heartbeat's echo is the first frame.
    let join = encode_message(MESSAGE_JOIN_DOC, &json!({ "docId": "no-such-doc" })).expect("encode join");
    ws.send(Message::Binary(join)).await.expect("send join");
    ws.send(Message::Binary(vec![MESSAGE_SYNC, 0, 1, 0]))
        .await
        .expect("send state request");
    ws.send(Message::Binary(vec![MESSAGE_HEARTBEAT]))
        .await
        .expect("send heartbeat");
    assert_eq!(
        next_binary(&mut ws, Duration::from_secs(2)).await,
        Some(vec![MESSAGE_HEARTBEAT]),
        "only the heartbeat is answered"
    );

    assert!(closed_within(&mut ws, Duration::from_secs(3)).await, "closed after the deadline");
}

#[tokio::test]
async fn an_authenticated_connection_outlives_the_deadline() {
    let relay = start(ClientDeadlines {
        auth: Duration::from_millis(300),
        ..ClientDeadlines::default()
    })
    .await;
    let token = relay.issuer.mint("alice", "default", WorkspaceRole::Owner);
    let mut ws = connect(&relay).await;
    authenticate(&mut ws, &token).await;

    tokio::time::sleep(Duration::from_millis(800)).await;
    assert!(heartbeat(&mut ws).await, "still open past the deadline");
}

#[tokio::test]
async fn a_client_that_stops_reading_is_dropped_and_the_others_carry_on() {
    let relay = start(ClientDeadlines {
        write_floor: Duration::from_millis(300),
        write_min_bytes_per_sec: u64::MAX,
        ..ClientDeadlines::default()
    })
    .await;

    // A document whose state is about a megabyte, so a few answers fill the
    // socket buffers between the relay and a client that isn't reading.
    let mut shapes = serde_json::Map::new();
    let mut order = Vec::new();
    for i in 0..4_000 {
        let id = format!("shape-{i:05}");
        shapes.insert(
            id.clone(),
            json!({
                "id": id, "type": "rectangle", "x": i, "y": i, "width": 120, "height": 60,
                "rotation": 0, "opacity": 1, "locked": false, "visible": true,
                "fill": "#4a90d9", "stroke": "#1e1e1e", "strokeWidth": 2,
                "label": "A typical short label",
            }),
        );
        order.push(id);
    }
    relay
        .server
        .get_doc_store()
        .await
        .expect("doc store")
        .save_document(
            &WorkspaceId::single_tenant(),
            json!({
                "id": "big", "name": "Big", "pageOrder": ["p1"], "activePageId": "p1",
                "pages": { "p1": { "id": "p1", "name": "Page", "shapes": shapes,
                                   "shapeOrder": order, "createdAt": 1u64, "modifiedAt": 1u64 } },
                "createdAt": 1u64, "modifiedAt": 1u64,
            }),
        )
        .expect("seed document");

    let token = relay.issuer.mint("alice", "default", WorkspaceRole::Owner);
    let mut healthy = connect(&relay).await;
    authenticate(&mut healthy, &token).await;

    // From here on, this client sends but never reads.
    let mut stalled = connect_never_reading(&relay).await;
    authenticate(&mut stalled, &token).await;
    let join = encode_message(MESSAGE_JOIN_DOC, &json!({ "docId": "big" })).expect("encode join");
    stalled.send(Message::Binary(join)).await.expect("send join");
    for _ in 0..12 {
        stalled
            .send(Message::Binary(vec![MESSAGE_SYNC, 0, 1, 0]))
            .await
            .expect("send state request");
    }

    // Everyone else carries on, a newcomer included.
    for _ in 0..5 {
        assert!(heartbeat(&mut healthy).await, "the healthy client is answered");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let mut newcomer = connect(&relay).await;
    authenticate(&mut newcomer, &token).await;
    assert!(heartbeat(&mut newcomer).await, "a newcomer is answered");

    // The relay has dropped the stalled client: past what it delivered before
    // the deadline, its connection ends.
    assert!(
        closed_within(&mut stalled, Duration::from_secs(10)).await,
        "the client that stopped reading was dropped"
    );
    assert!(heartbeat(&mut healthy).await, "the healthy client is still answered");
}
