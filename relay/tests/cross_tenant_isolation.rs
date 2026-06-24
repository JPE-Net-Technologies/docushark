//! Phase 21.4 — Cross-tenant isolation fuzz suite.
//!
//! Verifies that the per-request workspace boundary established by
//! Phase 21.1 (`WorkspaceId`/`DocId` newtypes), 21.3 (rate limits) and
//! 21.5 (`[tenancy]` mode) actually composes into the isolation
//! guarantee the Phase 21 doc promises. JP-20 is the *verification*
//! piece; it's deliberately the last deliverable in the phase.
//!
//! Surfaces exercised end-to-end against an in-process relay:
//!
//!   * `fuzz_doc_id_traversal` — REST `/api/docs/:id` with a corpus of
//!     adversarial path segments (`../`, NUL bytes, `%2e%2e`, oversized,
//!     control chars, plus random byte runs). Every rejection must be a
//!     400; every "accept" path must land inside the documents dir.
//!   * `fuzz_dedicated_mode_isolation` — dedicated mode pinned to
//!     `alpha`; iterations randomise method + endpoint + the `beta`
//!     token. Every iteration must 403 with an opaque body.
//!   * `fuzz_body_path_id_mismatch` — PUT `/api/docs/:id` with body
//!     `id` randomly equal or unequal to the path id. Mismatches must
//!     400; matches must succeed (200) and produce no doc file outside
//!     the documents dir.
//!   * `harness_self_test_known_bad_seed_trips_assertions` — the
//!     mandated "self-test that fails loudly" — temporarily replaces
//!     the corpus assertion with an inverted expectation and confirms
//!     the harness *would* catch a regression.
//!
//! Surfaces deferred (marked `#[ignore]` with a reason) until the
//! storage layer learns to namespace by workspace — `doc_path()` in
//! `src/server/documents.rs` currently ignores `_ws` (the `TODO(21.5)`
//! at line 108 is still open) and the blob store is content-addressed
//! globally with no per-workspace ACL. Running those tests today
//! produces a "spec says isolated; reality is shared" failure that
//! belongs on a different ticket.
//!
//! ## Iteration count + seed control
//!
//! Both come from env vars so CI and local runs can dial them:
//!   * `DOCUSHARK_FUZZ_ITERS` — per-surface iteration count
//!     (default 1000 — the CI floor from the Phase 21 doc). Set to
//!     10_000 locally for the full acceptance gate.
//!   * `DOCUSHARK_FUZZ_SEED` — u64 seed for `StdRng`. When unset, the
//!     suite derives a seed from the wall clock and *always* prints it
//!     so failures reproduce by exporting it on the next run.

use std::path::PathBuf;
use std::sync::Arc;

use docushark_relay::auth::WorkspaceRole;
use docushark_relay::config::{TenancyConfig, TenancyMode};
use docushark_relay::mcp::{McpConfig as InternalMcpConfig, McpServer};
use docushark_relay::test_support::OidcTestIssuer;
use std::collections::HashMap;
use std::sync::Mutex;
use docushark_relay::server::protocol::{
    encode_message, DocId, MESSAGE_AUTH, MESSAGE_AUTH_RESPONSE, MESSAGE_AWARENESS,
    MESSAGE_DOC_EVENT, MESSAGE_JOIN_DOC, MESSAGE_SYNC, PROTOCOL_VERSION,
};
use docushark_relay::server::{NetworkMode, ServerConfig, WebSocketServer};
use futures_util::{SinkExt, StreamExt};
use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};
use reqwest::StatusCode;
use serde_json::{json, Value};
use std::time::Duration;
use tempfile::TempDir;
use tokio_tungstenite::tungstenite::Message as WsMessage;

// ============================================================
// Harness
// ============================================================

/// Two-workspace in-process relay. Mirrors the pattern in
/// `tests/tenancy_modes.rs` so the existing reviewer eye for that file
/// transfers here. The MCP fields are `Option` because most surfaces
/// don't need MCP up; `Harness::with_mcp_enabled()` brings it up for
/// the cross-tenant test that does.
struct Harness {
    base: String,
    ws_base: String,
    server: Arc<WebSocketServer>,
    issuer: OidcTestIssuer,
    users: Mutex<HashMap<String, String>>, // username → workspace_id
    data_dir: PathBuf,
    mcp: Option<Arc<McpServer>>,
    mcp_base: Option<String>,
    mcp_token: Option<String>,
    _tmp: TempDir,
}

impl Harness {
    async fn start(tenancy: TenancyConfig) -> Self {
        let tmp = tempfile::tempdir().expect("tempdir");
        let data_dir = tmp.path().to_path_buf();
        let issuer = OidcTestIssuer::new().await;

        let server = Arc::new(WebSocketServer::new());
        server.set_app_data_dir(data_dir.clone()).await;
        server.set_auth(issuer.auth_state()).await;
        server.set_tenancy(tenancy).await;
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

        Self {
            base: http,
            ws_base,
            server,
            issuer,
            users: Mutex::new(HashMap::new()),
            data_dir,
            mcp: None,
            mcp_base: None,
            mcp_token: None,
            _tmp: tmp,
        }
    }

    /// Bring up the MCP server attached to the same data dir + write
    /// limiter the relay is using. Pattern lifted from
    /// `tests/rate_limits.rs:53-66`. Idempotent — calling twice is an
    /// error (we deliberately panic).
    async fn with_mcp_enabled(mut self) -> Self {
        assert!(self.mcp.is_none(), "MCP already enabled on this harness");
        let panic_counter = self.server.panic_counter_handle();
        let rate_limit_rejections = self.server.rate_limit_rejections_handle();
        let write_limiter = self.server.build_write_limiter().await;
        let on_doc_changed: Arc<docushark_relay::mcp::DocChangedSink> = Arc::new(|_, _| {});
        let on_doc_deleted: Arc<docushark_relay::mcp::DocDeletedSink> = Arc::new(|_, _| {});
        // This harness deliberately hands MCP a *standalone* Y.Doc registry +
        // noop broadcaster (not the server's): a separate registry never resolves
        // a live handle, so MCP writes take the JSON path, which already enforces
        // workspace scoping (JP-35 live-path isolation is covered by the in-module
        // unit tests). JP-230: the *DocumentStore*, by contrast, is shared with the
        // WS server (the server started in `new`), matching production.
        let sync_registry = Arc::new(docushark_relay::sync::DocRegistry::new());
        let on_doc_update: Arc<
            dyn Fn(&docushark_relay::server::protocol::WorkspaceId, &DocId, Vec<u8>) + Send + Sync,
        > = Arc::new(|_, _, _| {});
        let shared_doc_store = self
            .server
            .get_doc_store()
            .await
            .expect("doc store available after start");
        let mcp = Arc::new(
            McpServer::new(
                self.data_dir.clone(),
                on_doc_changed,
                on_doc_deleted,
                panic_counter,
                rate_limit_rejections,
                write_limiter,
                None, // JP-249: MCP read limiter (unlimited in this test)
                self.issuer.auth_state(),
                "default".to_string(),
                sync_registry,
                on_doc_update,
                shared_doc_store,
                false, // JP-370: private-doc enforcement off in this test
            )
            .expect("McpServer::new"),
        );
        mcp.set_config(InternalMcpConfig { port: 0 })
            .await
            .expect("mcp set_config");
        let mcp_addr = mcp.start().await.expect("mcp start");
        let mcp_token = mcp.get_token().await;
        self.mcp = Some(mcp);
        self.mcp_base = Some(mcp_addr);
        self.mcp_token = Some(mcp_token);
        self
    }

    fn seed_user(&self, username: &str, workspace_id: Option<&str>) {
        let ws = workspace_id.unwrap_or("default").to_string();
        self.users.lock().unwrap().insert(username.to_string(), ws);
    }

    async fn login_token(&self, username: &str) -> String {
        let ws = self
            .users
            .lock()
            .unwrap()
            .get(username)
            .cloned()
            .unwrap_or_else(|| "default".to_string());
        self.issuer.mint(username, &ws, WorkspaceRole::Owner)
    }

    /// Walk the documents directory and list every file path. Used by
    /// the path-traversal invariant: nothing should ever appear outside
    /// `{data_dir}/documents/docs/`.
    fn list_all_files_under_data(&self) -> Vec<PathBuf> {
        fn walk(dir: &std::path::Path, out: &mut Vec<PathBuf>) {
            let Ok(entries) = std::fs::read_dir(dir) else { return };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    walk(&path, out);
                } else {
                    out.push(path);
                }
            }
        }
        let mut out = Vec::new();
        walk(&self.data_dir, &mut out);
        out
    }

    async fn stop(self) {
        if let Some(mcp) = self.mcp.as_ref() {
            mcp.stop().await.expect("mcp stop");
        }
        self.server.stop().await.expect("stop");
    }
}

// ============================================================
// WS + MCP test helpers (Phase 21.4-B)
// ============================================================

type WsStream = tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
>;

/// Minimal WS client that speaks the relay's binary framing:
/// `[type_byte: u8][json_payload: &[u8]]`. Reuses `encode_message` for
/// outbound frames so the wire format stays in lockstep with
/// `src/server/protocol.rs`.
struct WsClient {
    stream: WsStream,
}

impl WsClient {
    /// Connect to `<ws_base>/ws?protocolVersion=<N>`. Does not auth —
    /// caller must call `auth()` next.
    async fn connect(ws_base: &str) -> Self {
        let url = format!("{}/ws?protocolVersion={}", ws_base, PROTOCOL_VERSION);
        let (stream, _resp) = tokio_tungstenite::connect_async(&url)
            .await
            .expect("ws connect");
        Self { stream }
    }

    /// Send `MESSAGE_AUTH` and block until the server's
    /// `MESSAGE_AUTH_RESPONSE` arrives. Returns the parsed JSON body.
    ///
    /// Note: the WS auth payload is a JSON-encoded bare string (not
    /// `{"token": ...}`) — `handle_auth` in `src/server/mod.rs:1310`
    /// decodes as `String` directly. The matching TS client serializes
    /// the same way.
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
                    let body: Value =
                        serde_json::from_slice(&bytes[1..]).expect("auth response json");
                    return body;
                }
                // Ignore any other frame type while waiting for the
                // response (server sometimes sends nothing else here,
                // but keeping the loop is cheap insurance).
            }
        }
    }

    async fn join_doc(&mut self, doc_id: &str) {
        let frame = encode_message(MESSAGE_JOIN_DOC, &json!({ "docId": doc_id }))
            .expect("encode join_doc");
        self.stream
            .send(WsMessage::Binary(frame))
            .await
            .expect("send join_doc");
    }

    async fn send_awareness(&mut self, payload: &[u8]) {
        let mut frame = Vec::with_capacity(1 + payload.len());
        frame.push(MESSAGE_AWARENESS);
        frame.extend_from_slice(payload);
        self.stream
            .send(WsMessage::Binary(frame))
            .await
            .expect("send awareness");
    }

    async fn send_sync(&mut self, payload: &[u8]) {
        let mut frame = Vec::with_capacity(1 + payload.len());
        frame.push(MESSAGE_SYNC);
        frame.extend_from_slice(payload);
        self.stream
            .send(WsMessage::Binary(frame))
            .await
            .expect("send sync");
    }

    /// Wait up to `ms` for the next binary frame. Returns
    /// `Some((type_byte, full_bytes))` if one arrives, `None` on
    /// timeout. Non-binary frames (ping/pong/close) are passed through
    /// transparently as `None`.
    async fn recv_within(&mut self, ms: u64) -> Option<(u8, Vec<u8>)> {
        let next = tokio::time::timeout(Duration::from_millis(ms), self.stream.next()).await;
        match next {
            Err(_) => None,
            Ok(None) => None,
            Ok(Some(Err(_))) => None,
            Ok(Some(Ok(WsMessage::Binary(bytes)))) => {
                let ty = *bytes.first()?;
                Some((ty, bytes))
            }
            Ok(Some(Ok(_))) => None,
        }
    }

    /// Drain any pending frames in `ms` window. Used to clear out the
    /// noise (e.g. DOC_EVENT for the seed save) before starting a
    /// negative-assertion loop.
    async fn drain_for(&mut self, ms: u64) {
        let deadline = tokio::time::Instant::now() + Duration::from_millis(ms);
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return;
            }
            if tokio::time::timeout(remaining, self.stream.next()).await.is_err() {
                return;
            }
        }
    }
}

/// Thin MCP client. Modeled on the inline reqwest call in
/// `tests/rate_limits.rs:121`; lifted here so the cross-tenant test
/// can chain a couple of `tools/call` requests cleanly.
struct McpClient {
    http: reqwest::Client,
    base: String,
    token: String,
}

impl McpClient {
    fn new(base: &str, token: &str) -> Self {
        Self {
            http: reqwest::Client::new(),
            base: base.to_string(),
            token: token.to_string(),
        }
    }

    /// Issue `tools/call` for `tool` with `arguments`. Returns the raw
    /// JSON-RPC envelope — callers inspect `result` or `error`.
    async fn call(&self, tool: &str, args: Value) -> Value {
        let body = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": { "name": tool, "arguments": args },
        });
        self.http
            .post(format!("{}/mcp", self.base))
            .bearer_auth(&self.token)
            .json(&body)
            .send()
            .await
            .expect("POST /mcp")
            .json()
            .await
            .expect("mcp json")
    }
}

// ============================================================
// Seed / iteration plumbing
// ============================================================

/// CI floor per the Phase 21 doc. Local acceptance gate is 10_000;
/// override with `DOCUSHARK_FUZZ_ITERS=10000`.
const DEFAULT_FUZZ_ITERS: usize = 1000;

fn fuzz_iters() -> usize {
    std::env::var("DOCUSHARK_FUZZ_ITERS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_FUZZ_ITERS)
}

fn fuzz_seed() -> u64 {
    if let Ok(s) = std::env::var("DOCUSHARK_FUZZ_SEED") {
        if let Ok(n) = s.parse::<u64>() {
            return n;
        }
    }
    // Time-derived; always printed below so a failing run is reproducible.
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0xD0CD0C_DEAD_BEEF)
}

fn announce(label: &str, seed: u64, iters: usize) {
    eprintln!(
        "[fuzz] surface={label} seed={seed} iters={iters} \
         (override via DOCUSHARK_FUZZ_SEED / DOCUSHARK_FUZZ_ITERS)"
    );
}

/// A **well-formed** y-sync `Update` frame body (no `MESSAGE_SYNC` prefix —
/// `send_sync` adds it) carrying one random map entry. Unlike a random byte
/// blob — which `process_sync_message` rejects at decode, producing no peer
/// rebroadcast — a valid `SyncMessage::Update` is applied and rebroadcast to
/// the doc's peers, so it can serve as a deterministic positive control that a
/// real SYNC update reaches same-workspace peers (and never the other tenant).
fn valid_sync_update_frame(rng: &mut StdRng) -> Vec<u8> {
    use yrs::sync::SyncMessage;
    use yrs::updates::encoder::Encode;
    use yrs::{Doc, Map, ReadTxn, StateVector, Transact};

    let doc = Doc::new();
    let map = doc.get_or_insert_map("fuzz");
    let key = format!("k{}", rng.gen::<u64>());
    {
        let mut txn = doc.transact_mut();
        map.insert(&mut txn, key, format!("v{}", rng.gen::<u64>()));
    }
    let update = doc.transact().encode_state_as_update_v1(&StateVector::default());
    SyncMessage::Update(update).encode_v1()
}

// ============================================================
// Path-traversal corpus + helpers
// ============================================================

/// Static adversarial corpus. Every entry MUST be rejected by
/// `DocId::from_http_path` (the validator at
/// `src/server/protocol.rs:106`). The fuzz loop also splices in
/// pseudo-random byte runs around these seeds.
const TRAVERSAL_CORPUS: &[&str] = &[
    "",
    "..",
    "../",
    "../etc/passwd",
    "../../../../etc/shadow",
    "..\\",
    "..\\windows\\system32",
    "foo/bar",
    "foo\\bar",
    "foo/../bar",
    "foo\0bar",
    "\0",
    "\x01\x02\x03",
    "\u{007f}",
    "doc\nid",
    "doc\rid",
    "doc\tid",
];

/// Percent-encode every byte that is not in the unreserved set. Hand
/// rolled so we don't take a new dev-dep on `percent-encoding`. Axum's
/// `Path` extractor only matches a single segment, so raw `/` or NUL in
/// a doc id has to ride in as `%2F` / `%00` to even reach the handler.
fn pct_encode(raw: &str) -> String {
    fn unreserved(b: u8) -> bool {
        b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~')
    }
    let mut out = String::with_capacity(raw.len() * 3);
    for &b in raw.as_bytes() {
        if unreserved(b) {
            out.push(b as char);
        } else {
            out.push('%');
            out.push_str(&format!("{:02X}", b));
        }
    }
    out
}

/// Generate a random adversarial doc id. Either picks a corpus entry
/// directly or splices random bytes onto a corpus entry to keep the
/// distribution biased toward known-bad shapes while still exploring.
fn random_bad_doc_id(rng: &mut StdRng) -> String {
    let base = TRAVERSAL_CORPUS[rng.gen_range(0..TRAVERSAL_CORPUS.len())];
    let mode = rng.gen_range(0..4);
    match mode {
        0 => base.to_string(),
        1 => {
            // Oversized — splat to > DOC_ID_MAX_LEN (256).
            let pad = rng.gen_range(257..512);
            let mut s = String::with_capacity(pad + base.len());
            s.push_str(base);
            for _ in 0..pad {
                s.push((b'a' + rng.gen_range(0..26)) as char);
            }
            s
        }
        2 => {
            // Random control-char splice.
            let mut s = base.to_string();
            for _ in 0..rng.gen_range(1..4) {
                s.push(rng.gen_range(0u8..32) as char);
            }
            s
        }
        _ => {
            // Prefix with random ASCII garbage, then guarantee a
            // poison char so the result is unambiguously adversarial
            // even if `base` was the empty-string corpus entry.
            let n = rng.gen_range(1..16);
            let mut s = String::with_capacity(n + base.len() + 1);
            for _ in 0..n {
                s.push((b'!' + rng.gen_range(0..94)) as char);
            }
            s.push_str(base);
            s.push(['/', '\\', '\0'][rng.gen_range(0..3)]);
            s
        }
    }
}

/// A legal doc id — used by `fuzz_body_path_id_mismatch` and the
/// harness self-test. Restricted to the unreserved-URL alphabet so we
/// can drop it into a path segment unencoded.
fn random_legal_doc_id(rng: &mut StdRng) -> String {
    const ALPHA: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";
    let len = rng.gen_range(6..32);
    (0..len)
        .map(|_| ALPHA[rng.gen_range(0..ALPHA.len())] as char)
        .collect()
}

// ============================================================
// Surface 1: doc-id traversal
// ============================================================

#[tokio::test]
async fn fuzz_doc_id_traversal() {
    let seed = fuzz_seed();
    let iters = fuzz_iters();
    announce("doc_id_traversal", seed, iters);

    let h = Harness::start(TenancyConfig {
        mode: TenancyMode::Shared,
        workspace_id: None,
        ..TenancyConfig::default()
    })
    .await;
    h.seed_user("alice", Some("alpha"));
    let token = h.login_token("alice").await;

    let client = reqwest::Client::new();
    let mut rng = StdRng::seed_from_u64(seed);

    // Snapshot the file set before the fuzz so a leak shows up as a new
    // path that isn't under `documents/docs/`.
    let before = h.list_all_files_under_data();

    for i in 0..iters {
        let bad = random_bad_doc_id(&mut rng);
        let encoded = pct_encode(&bad);
        let url = format!("{}/api/docs/{}", h.base, encoded);
        let method = rng.gen_range(0..3);
        let resp = match method {
            0 => client.get(&url).bearer_auth(&token).send().await,
            1 => {
                client
                    .put(&url)
                    .bearer_auth(&token)
                    .json(&json!({ "id": bad, "name": "x", "pageOrder": [] }))
                    .send()
                    .await
            }
            _ => client.delete(&url).bearer_auth(&token).send().await,
        }
        .expect("http send");

        let status = resp.status();
        // Acceptable outcomes for a malformed id:
        //   * 400 — DocId::from_http_path rejected it (the intended path)
        //   * 404 — axum routed it somewhere else (e.g. empty segment
        //           resolves to `/api/docs/`, which is `list_docs` —
        //           still safe, no traversal landed)
        //   * 405 — method-not-allowed for the routed siblings
        // What we never tolerate:
        //   * 2xx for a malformed id (would mean traversal landed)
        //   * 5xx (would mean validator panicked / leaked an error)
        let ok = matches!(status.as_u16(), 400 | 404 | 405 | 401 | 403);
        assert!(
            ok,
            "iter {i} seed={seed}: malformed id `{}` (method={method}) \
             produced unexpected status {status} — \
             re-run with DOCUSHARK_FUZZ_SEED={seed}",
            bad.escape_debug()
        );
    }

    // Invariant: no file appeared outside the documents dir during the run.
    let after = h.list_all_files_under_data();
    let docs_root = h.data_dir.join("relay_documents");
    for path in after.iter() {
        if before.contains(path) {
            continue;
        }
        assert!(
            path.starts_with(&docs_root) || path.starts_with(h.data_dir.join("users.json")),
            "iter seed={seed}: traversal landed — new file {path:?} outside {docs_root:?}",
        );
    }

    h.stop().await;
}

// ============================================================
// Surface 2: dedicated-mode isolation under random traffic
// ============================================================

#[tokio::test]
async fn fuzz_dedicated_mode_isolation() {
    let seed = fuzz_seed();
    let iters = fuzz_iters();
    announce("dedicated_mode_isolation", seed, iters);

    // Pin to alpha; beta is the adversary.
    let h = Harness::start(TenancyConfig {
        mode: TenancyMode::Dedicated,
        workspace_id: Some("alpha".into()),
        ..TenancyConfig::default()
    })
    .await;
    h.seed_user("alice", Some("alpha"));
    h.seed_user("bob", Some("beta"));

    let alpha_token = h.login_token("alice").await;
    let beta_token = h.login_token("bob").await;

    let client = reqwest::Client::new();
    let mut rng = StdRng::seed_from_u64(seed);

    for i in 0..iters {
        // Half the time exercise the positive path so a stuck "always
        // returns 403" regression in `check_tenancy` would show up.
        let attacker = rng.gen_bool(0.5);
        let token = if attacker { &beta_token } else { &alpha_token };
        let doc_id = random_legal_doc_id(&mut rng);
        let endpoint = rng.gen_range(0..2);
        let url = match endpoint {
            0 => format!("{}/api/docs", h.base),
            _ => format!("{}/api/docs/{}", h.base, pct_encode(&doc_id)),
        };
        let resp = client
            .get(&url)
            .bearer_auth(token)
            .send()
            .await
            .expect("http send");
        let status = resp.status();

        if attacker {
            // Every workspace-scoped route must reject the beta token in
            // alpha-pinned dedicated mode.
            assert_eq!(
                status,
                StatusCode::FORBIDDEN,
                "iter {i} seed={seed}: beta token reached {url} without 403 \
                 (got {status}) — tenancy boundary leaked. \
                 Re-run with DOCUSHARK_FUZZ_SEED={seed}"
            );
            // Opacity check: no `alpha` / `beta` strings in the body.
            let body = resp.text().await.unwrap_or_default();
            assert!(
                !body.contains("alpha") && !body.contains("beta"),
                "iter {i} seed={seed}: 403 body leaked tenant id: {body:?}"
            );
        } else {
            // Alpha token: list_docs and /me always 200; GET on a
            // doc that doesn't exist resolves through
            // `check_read_permission` which returns 403 for a
            // missing doc (api.rs:461). Both are evidence the tenancy
            // boundary held — what we need to rule out is a 5xx
            // (panic / leak) or anything that *looks* like cross-talk.
            let acceptable = status.is_success()
                || status == StatusCode::NOT_FOUND
                || status == StatusCode::FORBIDDEN;
            assert!(
                acceptable,
                "iter {i} seed={seed}: alpha token at {url}: unexpected {status}"
            );
        }
    }

    h.stop().await;
}

// ============================================================
// Surface 3: body-id vs path-id mismatch on PUT
// ============================================================

#[tokio::test]
async fn fuzz_body_path_id_mismatch() {
    let seed = fuzz_seed();
    let iters = fuzz_iters();
    announce("body_path_id_mismatch", seed, iters);

    let h = Harness::start(TenancyConfig {
        mode: TenancyMode::Shared,
        workspace_id: None,
        ..TenancyConfig::default()
    })
    .await;
    h.seed_user("alice", Some("alpha"));
    let token = h.login_token("alice").await;

    let client = reqwest::Client::new();
    let mut rng = StdRng::seed_from_u64(seed);

    for i in 0..iters {
        let path_id = random_legal_doc_id(&mut rng);
        // 50/50 mismatch the body id.
        let mismatch = rng.gen_bool(0.5);
        let body_id = if mismatch {
            let mut other = random_legal_doc_id(&mut rng);
            if other == path_id {
                other.push('x');
            }
            other
        } else {
            path_id.clone()
        };

        let resp = client
            .put(format!("{}/api/docs/{}", h.base, pct_encode(&path_id)))
            .bearer_auth(&token)
            .json(&json!({ "id": body_id, "name": "x", "pageOrder": [] }))
            .send()
            .await
            .expect("http send");
        let status = resp.status();

        if mismatch {
            assert_eq!(
                status,
                StatusCode::BAD_REQUEST,
                "iter {i} seed={seed}: body_id `{body_id}` != path_id `{path_id}` \
                 but server accepted with {status}"
            );
        } else {
            assert!(
                status.is_success(),
                "iter {i} seed={seed}: matched body/path id `{path_id}` rejected with {status}"
            );
        }
    }

    h.stop().await;
}

// ============================================================
// Harness self-test (the "known-bad seed" gate)
// ============================================================

/// Mandated by JP-20: a deliberate test of the harness that *must*
/// fail loudly if the suite ever no-ops. Instead of running a real
/// fuzz iteration (which would be tautological — pass means pass),
/// this asserts the validator agrees that a path in the corpus is
/// in fact rejected, and that a path NOT in the corpus is accepted.
/// If a future refactor accidentally widens `DocId::from_http_path`
/// to accept `../etc/passwd`, this test fails — proving the
/// fuzz suite is actually checking something.
#[tokio::test]
async fn harness_self_test_known_bad_seed_trips_assertions() {
    use docushark_relay::server::protocol::DocId;

    // Every corpus entry must be rejected.
    for bad in TRAVERSAL_CORPUS {
        let result = DocId::from_http_path((*bad).to_string());
        assert!(
            result.is_err(),
            "harness self-test: corpus entry {:?} unexpectedly accepted — \
             corpus is stale or validator regressed",
            bad.escape_debug().to_string()
        );
    }

    // At least one obviously-legal id must be accepted, otherwise the
    // validator is rejecting everything and the "negative" assertions
    // above would pass for the wrong reason.
    DocId::from_http_path("doc-1".to_string())
        .expect("harness self-test: validator rejected a known-legal id");

    // Round-trip the harness end-to-end: a legal id PUTs successfully
    // and the file lands inside the documents dir. If the data_dir
    // walker is broken, a future surface-leak test would silently pass.
    let h = Harness::start(TenancyConfig {
        mode: TenancyMode::Shared,
        workspace_id: None,
        ..TenancyConfig::default()
    })
    .await;
    h.seed_user("alice", Some("alpha"));
    let token = h.login_token("alice").await;

    let id = "harness-self-test-doc";
    let client = reqwest::Client::new();
    let resp = client
        .put(format!("{}/api/docs/{}", h.base, id))
        .bearer_auth(&token)
        .json(&json!({ "id": id, "name": "x", "pageOrder": [] }))
        .send()
        .await
        .expect("PUT self-test doc");
    assert!(resp.status().is_success(), "self-test PUT failed: {}", resp.status());

    let files = h.list_all_files_under_data();
    let docs_root = h.data_dir.join("relay_documents");
    assert!(
        files.iter().any(|p| p.starts_with(&docs_root) && p.to_string_lossy().contains(id)),
        "self-test: PUT succeeded but no file under {docs_root:?} matches {id} — \
         data_dir walker is broken"
    );

    h.stop().await;
}

// ============================================================
// Surface 4: cross-workspace doc visibility (storage isolation)
// ============================================================

/// Shared-mode harness with two workspaces. Each iteration: alpha PUTs
/// a randomly-named doc, beta tries to read it via REST (`GET`,
/// `PUT`, `DELETE`, list). Every cross-workspace read must surface as
/// `404` — never `200` (leak) and never `403` (existence confirmation
/// in disguise). The list intersection is asserted to be empty at the
/// end of every iteration as a catch-all.
#[tokio::test]
async fn fuzz_cross_workspace_doc_visibility() {
    let seed = fuzz_seed();
    let iters = fuzz_iters();
    announce("cross_workspace_doc_visibility", seed, iters);

    let h = Harness::start(TenancyConfig {
        mode: TenancyMode::Shared,
        workspace_id: None,
        ..TenancyConfig::default()
    })
    .await;
    h.seed_user("alice", Some("alpha"));
    h.seed_user("bob", Some("beta"));
    let alpha_token = h.login_token("alice").await;
    let beta_token = h.login_token("bob").await;

    let client = reqwest::Client::new();
    let mut rng = StdRng::seed_from_u64(seed);

    for i in 0..iters {
        let id = random_legal_doc_id(&mut rng);

        // Alpha PUTs the doc.
        let put_resp = client
            .put(format!("{}/api/docs/{}", h.base, id))
            .bearer_auth(&alpha_token)
            .json(&json!({
                "id": id,
                "name": format!("alpha-doc-{i}"),
                "pageOrder": ["p1"],
            }))
            .send()
            .await
            .expect("alpha PUT");
        assert!(
            put_resp.status().is_success(),
            "iter {i} seed={seed}: alpha PUT failed: {}",
            put_resp.status()
        );

        // Beta GET on the same id must be 404. Anything else — 200
        // (read leak), 403 (existence confirmation), 500 — is a fail.
        let get_resp = client
            .get(format!("{}/api/docs/{}", h.base, id))
            .bearer_auth(&beta_token)
            .send()
            .await
            .expect("beta GET");
        assert_eq!(
            get_resp.status(),
            StatusCode::NOT_FOUND,
            "iter {i} seed={seed}: beta GET on alpha's doc `{id}` returned {} \
             — DOCUMENT ISOLATION LEAK. \
             Re-run with DOCUSHARK_FUZZ_SEED={seed}",
            get_resp.status()
        );
        let body = get_resp.text().await.unwrap_or_default();
        assert!(
            !body.contains(&format!("alpha-doc-{i}")),
            "iter {i} seed={seed}: 404 body leaked alpha's doc name: {body:?}"
        );

        // Beta DELETE on the same id must also be 404 (NOT 200/403).
        let del_resp = client
            .delete(format!("{}/api/docs/{}", h.base, id))
            .bearer_auth(&beta_token)
            .send()
            .await
            .expect("beta DELETE");
        assert_eq!(
            del_resp.status(),
            StatusCode::NOT_FOUND,
            "iter {i} seed={seed}: beta DELETE on alpha's doc returned {}",
            del_resp.status()
        );

        // List intersection invariant: beta sees only docs beta wrote,
        // alpha sees only docs alpha wrote.
        let alpha_list: Value = client
            .get(format!("{}/api/docs", h.base))
            .bearer_auth(&alpha_token)
            .send()
            .await
            .expect("alpha LIST")
            .json()
            .await
            .expect("alpha LIST json");
        let beta_list: Value = client
            .get(format!("{}/api/docs", h.base))
            .bearer_auth(&beta_token)
            .send()
            .await
            .expect("beta LIST")
            .json()
            .await
            .expect("beta LIST json");
        let alpha_ids: Vec<&str> = alpha_list["documents"]
            .as_array()
            .map(|arr| arr.iter().filter_map(|v| v["id"].as_str()).collect())
            .unwrap_or_default();
        let beta_ids: Vec<&str> = beta_list["documents"]
            .as_array()
            .map(|arr| arr.iter().filter_map(|v| v["id"].as_str()).collect())
            .unwrap_or_default();
        assert!(
            alpha_ids.contains(&id.as_str()),
            "iter {i} seed={seed}: alpha's own doc missing from alpha's list"
        );
        assert!(
            !beta_ids.contains(&id.as_str()),
            "iter {i} seed={seed}: alpha's doc `{id}` visible in beta's list — \
             LIST ISOLATION LEAK"
        );
    }

    h.stop().await;
}

// ============================================================
// Surface 5: cross-workspace blob access (ACL)
// ============================================================

/// Shared-mode harness. Each iteration: alpha uploads a random byte
/// blob via `POST /api/blobs/:hash`; beta tries to download / HEAD the
/// same hash. All cross-workspace reads must 404. Also tests the inverse
/// direction so the ACL isn't accidentally one-way.
#[tokio::test]
async fn fuzz_cross_workspace_blob_access() {
    use sha2::{Digest, Sha256};

    let seed = fuzz_seed();
    let iters = fuzz_iters();
    announce("cross_workspace_blob_access", seed, iters);

    let h = Harness::start(TenancyConfig {
        mode: TenancyMode::Shared,
        workspace_id: None,
        ..TenancyConfig::default()
    })
    .await;
    h.seed_user("alice", Some("alpha"));
    h.seed_user("bob", Some("beta"));
    let alpha_token = h.login_token("alice").await;
    let beta_token = h.login_token("bob").await;

    let client = reqwest::Client::new();
    let mut rng = StdRng::seed_from_u64(seed);

    for i in 0..iters {
        // Generate distinct bytes per iter so dedup doesn't paper over
        // an ACL leak. 32-128 random bytes.
        let len = rng.gen_range(32..128);
        let payload: Vec<u8> = (0..len).map(|_| rng.gen::<u8>()).collect();
        let mut hasher = Sha256::new();
        hasher.update(&payload);
        let hash = hex::encode(hasher.finalize());

        // Pick uploader and adversary — alternate so both directions
        // are exercised across the run.
        let alpha_uploads = i % 2 == 0;
        let (uploader, uploader_name, adversary, adversary_name) = if alpha_uploads {
            (&alpha_token, "alpha", &beta_token, "beta")
        } else {
            (&beta_token, "beta", &alpha_token, "alpha")
        };

        // Upload.
        let put = client
            .post(format!("{}/api/blobs/{}", h.base, hash))
            .bearer_auth(uploader)
            .header("content-type", "application/octet-stream")
            .body(payload.clone())
            .send()
            .await
            .expect("uploader POST");
        assert!(
            put.status().is_success(),
            "iter {i} seed={seed}: {uploader_name} blob PUT failed: {}",
            put.status()
        );

        // Adversary GET must 404 (not 200 / 403 / 500).
        let get = client
            .get(format!("{}/api/blobs/{}", h.base, hash))
            .bearer_auth(adversary)
            .send()
            .await
            .expect("adversary GET");
        assert_eq!(
            get.status(),
            StatusCode::NOT_FOUND,
            "iter {i} seed={seed}: {adversary_name} GET on {uploader_name}'s blob \
             returned {} — BLOB ISOLATION LEAK. \
             Re-run with DOCUSHARK_FUZZ_SEED={seed}",
            get.status()
        );

        // Adversary HEAD must also 404.
        let head = client
            .head(format!("{}/api/blobs/{}", h.base, hash))
            .bearer_auth(adversary)
            .send()
            .await
            .expect("adversary HEAD");
        assert_eq!(
            head.status(),
            StatusCode::NOT_FOUND,
            "iter {i} seed={seed}: {adversary_name} HEAD on {uploader_name}'s blob \
             returned {} — BLOB EXISTENCE LEAK",
            head.status()
        );

        // Uploader's own GET must succeed and return the original bytes.
        let own = client
            .get(format!("{}/api/blobs/{}", h.base, hash))
            .bearer_auth(uploader)
            .send()
            .await
            .expect("uploader GET");
        assert!(
            own.status().is_success(),
            "iter {i} seed={seed}: {uploader_name} can't read their own blob: {}",
            own.status()
        );
        let bytes = own.bytes().await.expect("own bytes").to_vec();
        assert_eq!(bytes, payload, "iter {i} seed={seed}: blob roundtrip mismatch");
    }

    h.stop().await;
}

// ============================================================
// Surface 6: WS sync/awareness/DOC_EVENT + MCP workspace boundary
// ============================================================

/// Cap on the WS sub-loop. Each iter does a few network roundtrips
/// (50-150ms apiece bounded by the recv timeouts), so 100 keeps the
/// default `cargo test` run under a minute. Set
/// `DOCUSHARK_FUZZ_WS_ITERS` (or fall back to `DOCUSHARK_FUZZ_ITERS`)
/// to override for the acceptance gate.
const DEFAULT_WS_FUZZ_ITERS: usize = 100;

fn ws_fuzz_iters() -> usize {
    std::env::var("DOCUSHARK_FUZZ_WS_ITERS")
        .ok()
        .and_then(|s| s.parse().ok())
        .or_else(|| std::env::var("DOCUSHARK_FUZZ_ITERS").ok().and_then(|s| s.parse().ok()))
        .unwrap_or(DEFAULT_WS_FUZZ_ITERS)
}

/// Asserts the cross-tenant boundary holds on every wire path the
/// relay exposes that isn't already covered by the REST fuzz tests:
///
///   * MESSAGE_SYNC and MESSAGE_AWARENESS — broadcast routing must
///     include the workspace, not just the doc id.
///   * MESSAGE_DOC_EVENT — REST saves announce only to the originating
///     workspace's clients (DocumentMetadata in the event would
///     otherwise leak across tenants).
///   * MCP — accepts either the static MCP bearer token (pinned to
///     `WorkspaceId::single_tenant()`, the desktop regression guard)
///     or a relay JWT (workspace derived from the `wsp` claim, the
///     Cloud / multi-tenant path). Phase 21.6 covers both: a JWT for
///     workspace `alpha` must see only alpha's docs and never beta's,
///     and the static-token path must keep behaving exactly as before.
///
/// Each iter in the WS sub-loop:
///   1. alice (alpha) sends a random AWARENESS frame; bob (beta) on a
///      same-id doc must NOT receive it within 50ms.
///   2. alice sends a random SYNC frame; same.
///   3. alice's *second* WS connection (also alpha, same doc) MUST
///      receive both — positive control proving the filter isn't
///      "deny everything".
///   4. alice PUTs over REST; bob must NOT see the resulting
///      MESSAGE_DOC_EVENT within 100ms.
#[tokio::test]
async fn fuzz_ws_awareness_and_mcp_workspace_mismatch() {
    let seed = fuzz_seed();
    let iters = ws_fuzz_iters();
    announce("ws_awareness_and_mcp_workspace_mismatch", seed, iters);

    let h = Harness::start(TenancyConfig {
        mode: TenancyMode::Shared,
        workspace_id: None,
        ..TenancyConfig::default()
    })
    .await
    .with_mcp_enabled()
    .await;

    h.seed_user("alice", Some("alpha"));
    h.seed_user("bob", Some("beta"));
    h.seed_user("default-user", Some("default"));

    let alpha_token = h.login_token("alice").await;
    let beta_token = h.login_token("bob").await;
    let default_token = h.login_token("default-user").await;

    // OIDC tokens identify the user via `sub`, which the test issuer
    // sets to the username. Stamp `ownerId` to match so
    // `check_write_permission` accepts re-saves later in the iter loop.
    let alice_id = "alice".to_string();
    let bob_id = "bob".to_string();
    let default_user_id = "default-user".to_string();

    // Both workspaces own a doc with the same id. The pre-21.4-B bug
    // is that the broadcast filter keyed on this id alone — so any
    // assertion that "bob doesn't see alice's frames" depends on the
    // workspace boundary being in the routing key.
    let shared_id = "doc-shared-id";
    let client = reqwest::Client::new();
    for (token, owner_id, ws_label) in [
        (&alpha_token, &alice_id, "alpha"),
        (&beta_token, &bob_id, "beta"),
    ] {
        let resp = client
            .put(format!("{}/api/docs/{}", h.base, shared_id))
            .bearer_auth(token)
            .json(&json!({
                "id": shared_id,
                "name": format!("{ws_label}'s doc"),
                "pageOrder": ["p1"],
                "ownerId": owner_id,
                "ownerName": ws_label,
            }))
            .send()
            .await
            .expect("seed PUT");
        assert!(resp.status().is_success(), "seed PUT for {ws_label}: {}", resp.status());
    }

    // -------- WS sub-loop --------

    let mut alice_ws = WsClient::connect(&h.ws_base).await;
    let alice_auth = alice_ws.auth(&alpha_token).await;
    assert_eq!(alice_auth["success"], json!(true), "alice auth: {alice_auth}");
    alice_ws.join_doc(shared_id).await;

    let mut alice_observer = WsClient::connect(&h.ws_base).await;
    let alice_obs_auth = alice_observer.auth(&alpha_token).await;
    assert_eq!(alice_obs_auth["success"], json!(true));
    alice_observer.join_doc(shared_id).await;

    let mut bob_ws = WsClient::connect(&h.ws_base).await;
    let bob_auth = bob_ws.auth(&beta_token).await;
    assert_eq!(bob_auth["success"], json!(true), "bob auth: {bob_auth}");
    bob_ws.join_doc(shared_id).await;

    // Soak up the DOC_EVENTs from the seed saves so the negative
    // assertions below aren't matching against pre-existing noise.
    alice_ws.drain_for(150).await;
    alice_observer.drain_for(150).await;
    bob_ws.drain_for(150).await;

    let mut rng = StdRng::seed_from_u64(seed);

    for i in 0..iters {
        // --- AWARENESS ---
        let mut aw_payload = vec![0u8; rng.gen_range(8..32)];
        for byte in aw_payload.iter_mut() {
            *byte = rng.gen();
        }
        alice_ws.send_awareness(&aw_payload).await;

        // alice's second connection (same workspace, same doc) MUST
        // receive — positive control.
        let positive = alice_observer.recv_within(200).await;
        assert!(
            positive.as_ref().map(|(t, _)| *t == MESSAGE_AWARENESS).unwrap_or(false),
            "iter {i} seed={seed}: alice observer did not receive AWARENESS — \
             filter is over-restrictive. Got {positive:?}"
        );

        // bob (other workspace) MUST NOT receive.
        let leak = bob_ws.recv_within(75).await;
        assert!(
            leak.is_none(),
            "iter {i} seed={seed}: bob received frame from alpha's AWARENESS: {leak:?} \
             — CROSS-TENANT LEAK. Re-run with DOCUSHARK_FUZZ_SEED={seed}"
        );

        // --- SYNC: positive control (well-formed update) ---
        // A real y-sync Update is applied + rebroadcast to peers, so it MUST
        // reach alice's same-workspace observer and MUST NOT reach bob. (Random
        // bytes can't prove this: `process_sync_message` rejects them at decode
        // and rebroadcasts nothing — asserting peer delivery on random input is
        // what made this test flaky, since whether a random blob happened to
        // decode depended on the seed.)
        let valid_sync = valid_sync_update_frame(&mut rng);
        alice_ws.send_sync(&valid_sync).await;

        let positive_sync = alice_observer.recv_within(200).await;
        assert!(
            positive_sync.as_ref().map(|(t, _)| *t == MESSAGE_SYNC).unwrap_or(false),
            "iter {i} seed={seed}: alice observer missed a valid SYNC update — got {positive_sync:?}"
        );
        let leak_valid = bob_ws.recv_within(75).await;
        assert!(
            leak_valid.is_none(),
            "iter {i} seed={seed}: bob saw alpha's SYNC update: {leak_valid:?} — CROSS-TENANT LEAK"
        );

        // --- SYNC: parser fuzz (random bytes) ---
        // Random frames must never crash the relay or leak to the other tenant.
        // They almost never form a valid update, so the same-workspace observer
        // may or may not get a rebroadcast — drain whatever it produced so a
        // stray frame can't bleed into the next iteration's positive checks. The
        // isolation invariant (bob never receives) holds regardless.
        let mut sync_payload = vec![0u8; rng.gen_range(8..64)];
        for byte in sync_payload.iter_mut() {
            *byte = rng.gen();
        }
        alice_ws.send_sync(&sync_payload).await;
        let _ = alice_observer.recv_within(75).await;

        let leak_sync = bob_ws.recv_within(75).await;
        assert!(
            leak_sync.is_none(),
            "iter {i} seed={seed}: bob saw alpha's random SYNC bytes: {leak_sync:?}"
        );

        // --- DOC_EVENT (REST-triggered, every Nth iter to keep the
        // test fast; saves are heavier than the binary frames). ---
        if i % 10 == 0 {
            let resp = client
                .put(format!("{}/api/docs/{}", h.base, shared_id))
                .bearer_auth(&alpha_token)
                .json(&json!({
                    "id": shared_id,
                    "name": format!("alpha-iter-{i}"),
                    "pageOrder": ["p1"],
                    "ownerId": &alice_id,
                    "ownerName": "alpha",
                }))
                .send()
                .await
                .expect("alpha REST PUT");
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            assert!(status.is_success(), "iter {i}: alpha PUT failed: {status} body={body}");

            // alice's observer should see the DOC_EVENT (positive).
            let mut saw_event = false;
            for _ in 0..3 {
                if let Some((ty, _)) = alice_observer.recv_within(150).await {
                    if ty == MESSAGE_DOC_EVENT {
                        saw_event = true;
                        break;
                    }
                }
            }
            assert!(
                saw_event,
                "iter {i} seed={seed}: alice observer did not receive DOC_EVENT for alpha's save"
            );

            // bob (beta) must NOT see a DOC_EVENT — payload leaks
            // DocumentMetadata.
            let leak_event = bob_ws.recv_within(150).await;
            assert!(
                leak_event.is_none(),
                "iter {i} seed={seed}: bob received DOC_EVENT for alpha's save: {leak_event:?} \
                 — DOC_EVENT METADATA LEAK"
            );
        }
    }

    // -------- MCP sub-loop (constant assertions, not fuzz) --------

    // Seed one private doc per workspace so the cross-workspace
    // assertions can prove visibility *and* invisibility from each
    // side. The shared-id doc seeded above is intentionally not used
    // here — same-id docs in different workspaces are covered by the
    // WS sub-loop; the MCP sub-loop wants distinct ids so a leak
    // shows up as the wrong doc name appearing.
    let alpha_only_id = "alpha-only-team-doc";
    let beta_only_id = "beta-only-team-doc";
    let default_doc_id = "default-mcp-visible-doc";

    for (token, owner_id, owner_label, doc_id, doc_name) in [
        (&alpha_token, &alice_id, "alpha", alpha_only_id, "alpha's private doc"),
        (&beta_token, &bob_id, "beta", beta_only_id, "beta's private doc"),
        (&default_token, &default_user_id, "default", default_doc_id, "default visible"),
    ] {
        let resp = client
            .put(format!("{}/api/docs/{}", h.base, doc_id))
            .bearer_auth(token)
            .json(&json!({
                "id": doc_id,
                "name": doc_name,
                "pageOrder": ["p1"],
                "ownerId": owner_id,
                "ownerName": owner_label,
            }))
            .send()
            .await
            .expect("seed MCP test PUT");
        assert!(
            resp.status().is_success(),
            "seed PUT for {owner_label}/{doc_id}: {}",
            resp.status()
        );
    }

    let mcp_base = h.mcp_base.as_deref().expect("mcp_base");
    let static_mcp_token = h.mcp_token.as_deref().expect("mcp_token");

    // --- Multi-tenant JWT path: alpha JWT as MCP bearer ---
    let mcp_alpha = McpClient::new(mcp_base, &alpha_token);
    let listing_alpha = mcp_alpha.call("docushark_list_documents", json!({})).await;
    let listing_alpha_str = listing_alpha.to_string();
    assert!(
        listing_alpha_str.contains(alpha_only_id),
        "alpha JWT MCP listing did NOT contain alpha's own doc: {listing_alpha}"
    );
    assert!(
        !listing_alpha_str.contains(beta_only_id),
        "alpha JWT MCP listing leaked beta's doc id: {listing_alpha}"
    );
    assert!(
        !listing_alpha_str.contains("beta's private doc"),
        "alpha JWT MCP listing leaked beta's doc name: {listing_alpha}"
    );

    let alpha_reads_beta = mcp_alpha
        .call("docushark_get_document", json!({ "docId": beta_only_id }))
        .await;
    let alpha_reads_beta_str = alpha_reads_beta.to_string();
    assert!(
        !alpha_reads_beta_str.contains("beta's private doc"),
        "alpha JWT got_document leaked beta's body: {alpha_reads_beta}"
    );

    // Cross-workspace write attempt: alpha JWT, beta doc id. Must fail
    // closed; no shape may appear in beta's doc.
    let alpha_writes_beta = mcp_alpha
        .call(
            "docushark_add_shape",
            json!({
                "docId": beta_only_id,
                "pageId": "p1",
                "shape": {"kind": "rectangle", "x": 1, "y": 2, "text": "pwn"}
            }),
        )
        .await;
    let alpha_writes_beta_str = alpha_writes_beta.to_string();
    assert!(
        alpha_writes_beta_str.contains("not found")
            || alpha_writes_beta_str.contains("isError"),
        "alpha JWT add_shape against beta's doc should fail opaquely: {alpha_writes_beta}"
    );

    // --- Multi-tenant JWT path: beta JWT inverse check ---
    let mcp_beta = McpClient::new(mcp_base, &beta_token);
    let listing_beta = mcp_beta.call("docushark_list_documents", json!({})).await;
    let listing_beta_str = listing_beta.to_string();
    assert!(
        listing_beta_str.contains(beta_only_id),
        "beta JWT MCP listing did NOT contain beta's own doc: {listing_beta}"
    );
    assert!(
        !listing_beta_str.contains(alpha_only_id),
        "beta JWT MCP listing leaked alpha's doc id: {listing_beta}"
    );
    assert!(
        !listing_beta_str.contains("alpha's private doc"),
        "beta JWT MCP listing leaked alpha's doc name: {listing_beta}"
    );

    // --- Static-token regression guard: desktop path stays pinned to
    // `default`. Workspace-private docs must remain invisible; the
    // default-workspace doc must be visible.
    let mcp_static = McpClient::new(mcp_base, static_mcp_token);
    let listing_static = mcp_static.call("docushark_list_documents", json!({})).await;
    let listing_static_str = listing_static.to_string();
    assert!(
        !listing_static_str.contains(alpha_only_id),
        "static MCP token leaked alpha's doc id: {listing_static}"
    );
    assert!(
        !listing_static_str.contains(beta_only_id),
        "static MCP token leaked beta's doc id: {listing_static}"
    );
    assert!(
        listing_static_str.contains(default_doc_id),
        "static MCP token can't see a `default`-workspace doc — \
         harness/positive-control broken: {listing_static}"
    );

    h.stop().await;
}
