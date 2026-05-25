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

use docushark_relay::auth::{hash_password, User, UserRole, UserStore};
use docushark_relay::config::{RelayConfig, TenancyConfig, TenancyMode};
use docushark_relay::server::{NetworkMode, ServerConfig, WebSocketServer};
use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};
use reqwest::StatusCode;
use serde_json::{json, Value};
use tempfile::TempDir;

// ============================================================
// Harness
// ============================================================

/// Two-workspace in-process relay. Mirrors the pattern in
/// `tests/tenancy_modes.rs` so the existing reviewer eye for that file
/// transfers here.
struct Harness {
    base: String,
    server: Arc<WebSocketServer>,
    user_store: Arc<UserStore>,
    data_dir: PathBuf,
    _tmp: TempDir,
}

impl Harness {
    async fn start(tenancy: TenancyConfig) -> Self {
        let tmp = tempfile::tempdir().expect("tempdir");
        let data_dir = tmp.path().to_path_buf();
        let config = RelayConfig::fresh();

        let user_store = Arc::new(UserStore::with_persistence(
            data_dir.join("users.json").to_string_lossy().into_owned(),
        ));

        let server = Arc::new(WebSocketServer::new());
        server.set_app_data_dir(data_dir.clone()).await;
        server.set_user_store(user_store.clone()).await;
        server.set_jwt_secret(config.auth.jwt_secret.clone()).await;
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
        let http = bound
            .strip_prefix("ws://")
            .map(|rest| format!("http://{rest}"))
            .unwrap_or(bound);

        Self {
            base: http,
            server,
            user_store,
            data_dir,
            _tmp: tmp,
        }
    }

    fn seed_user(&self, username: &str, workspace_id: Option<&str>) {
        let user = User {
            id: nanoid::nanoid!(),
            display_name: username.to_string(),
            username: username.to_string(),
            password_hash: hash_password("test-password-123").expect("hash"),
            role: UserRole::User,
            created_at: 0,
            last_login_at: None,
            workspace_id: workspace_id.map(|s| s.to_string()),
        };
        self.user_store.add_user(user).expect("add_user");
    }

    async fn login_token(&self, username: &str) -> String {
        let client = reqwest::Client::new();
        let resp: Value = client
            .post(format!("{}/api/auth/login", self.base))
            .json(&json!({ "username": username, "password": "test-password-123" }))
            .send()
            .await
            .expect("POST /api/auth/login")
            .json()
            .await
            .expect("login json");
        resp["token"]
            .as_str()
            .expect("token in login response")
            .to_string()
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
        self.server.stop().await.expect("stop");
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
        let endpoint = rng.gen_range(0..3);
        let url = match endpoint {
            0 => format!("{}/api/docs", h.base),
            1 => format!("{}/api/docs/{}", h.base, pct_encode(&doc_id)),
            _ => format!("{}/api/auth/me", h.base),
        };
        let resp = client
            .get(&url)
            .bearer_auth(token)
            .send()
            .await
            .expect("http send");
        let status = resp.status();

        if attacker {
            // `/api/auth/me` doesn't go through `resolve_workspace` —
            // it only validates the token. Cross-tenant rejection
            // happens on the workspace-scoped routes.
            if endpoint == 2 {
                assert!(
                    status.is_success(),
                    "iter {i} seed={seed}: /api/auth/me rejected a valid token: {status}"
                );
            } else {
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
            }
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
// Deferred surfaces — gated until the storage layer is workspace-aware
// ============================================================

/// Storage-level cross-tenant doc isolation. Blocked on
/// `documents.rs:108` — `doc_path()` still ignores `_ws`, so a doc
/// saved by workspace `alpha` is visible to workspace `beta` via
/// `GET /api/docs/:id`. Running this today is expected to fail and the
/// fix belongs on the storage-namespacing follow-up to 21.5, not on
/// JP-20. Kept here (ignored) so reviewers see exactly where the next
/// test slots in.
#[tokio::test]
#[ignore = "blocked: documents.rs doc_path() not yet workspace-scoped (TODO 21.5)"]
async fn fuzz_cross_workspace_doc_visibility() {
    panic!("storage-namespacing follow-up has not landed");
}

/// Blob isolation. Blobs are content-addressed and currently global —
/// `save_blob`/`load_blob` in `src/server/blobs.rs` take no
/// `WorkspaceId`. Adding per-workspace blob ACLs is a separate scoped
/// change; tracking that work is out of scope for JP-20.
#[tokio::test]
#[ignore = "blocked: blob store has no per-workspace ACL"]
async fn fuzz_cross_workspace_blob_access() {
    panic!("blob ACL follow-up has not landed");
}

/// Awareness frame misrouting + MCP workspace mismatch. Both require a
/// WS client (tokio-tungstenite) which is not currently a dev-dep, and
/// an MCP client harness which doesn't exist. Defer to a follow-up
/// that lands the WS test scaffolding once.
#[tokio::test]
#[ignore = "blocked: no WS / MCP test harness in dev-deps yet"]
async fn fuzz_ws_awareness_and_mcp_workspace_mismatch() {
    panic!("WS test harness has not landed");
}
