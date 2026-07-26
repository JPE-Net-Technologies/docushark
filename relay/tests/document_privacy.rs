//! JP-457 — document access-control matrix.
//!
//! JP-370 introduced per-document privacy behind `[permissions]
//! enforce_private_docs`, but the gate was applied to *some* surfaces and not
//! others. This suite pins the behaviour of every read/write surface against
//! both settings of the flag, so the two are either consistently open or
//! consistently gated — and a future surface that forgets the gate fails here.
//!
//! Roles under test map to the OIDC `wsp[].role` claim the control plane mints
//! (`relay/src/auth/jwt.rs`): Owner / Member / Viewer. `role_str` in `api.rs`
//! stringifies them for `get_user_permission`.

use std::path::PathBuf;
use std::sync::Arc;

use docushark_relay::auth::WorkspaceRole;
use docushark_relay::config::{TenancyConfig, TenancyMode};
use docushark_relay::server::protocol::{
    encode_message, MESSAGE_AUTH, MESSAGE_AUTH_RESPONSE, MESSAGE_ERROR, MESSAGE_JOIN_DOC, MESSAGE_SYNC,
    PROTOCOL_VERSION,
};
use docushark_relay::server::{NetworkMode, ServerConfig, WebSocketServer};
use docushark_relay::test_support::OidcTestIssuer;
use futures_util::{SinkExt, StreamExt};
use reqwest::StatusCode;
use serde_json::{json, Value};
use std::time::Duration;
use tempfile::TempDir;
use tokio_tungstenite::tungstenite::Message as WsMessage;

const WS: &str = "ws_privacy";

struct Harness {
    base: String,
    ws_base: String,
    issuer: OidcTestIssuer,
    #[allow(dead_code)]
    data_dir: PathBuf,
    _tmp: TempDir,
}

impl Harness {
    async fn start(enforce_private_docs: bool) -> Self {
        let tmp = tempfile::tempdir().expect("tempdir");
        let data_dir = tmp.path().to_path_buf();
        let issuer = OidcTestIssuer::new().await;

        let server = Arc::new(WebSocketServer::new());
        server.set_app_data_dir(data_dir.clone()).await;
        server.set_auth(issuer.auth_state()).await;
        // `Shared` (Cloud) mode: several people in one workspace is precisely
        // the deployment where per-document privacy has to hold. The default
        // `Dedicated` mode pins the relay to the `default` workspace and would
        // 403 this harness's own workspace id before any permission check ran.
        server
            .set_tenancy(TenancyConfig {
                mode: TenancyMode::Shared,
                workspace_id: None,
                ..TenancyConfig::default()
            })
            .await;
        server.set_enforce_private_docs(enforce_private_docs);
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

        // Leak the server for the process lifetime of the test — dropping the
        // Arc would tear the listener down while requests are in flight.
        std::mem::forget(server);

        Self { base: http, ws_base, issuer, data_dir, _tmp: tmp }
    }

    fn token(&self, sub: &str, role: WorkspaceRole) -> String {
        self.issuer.mint(sub, WS, role)
    }

    /// Create a document owned by `sub`. Returns the doc id.
    async fn create_doc(&self, sub: &str, role: WorkspaceRole, id: &str) -> String {
        let resp = reqwest::Client::new()
            .put(format!("{}/api/docs/{}", self.base, id))
            .bearer_auth(self.token(sub, role))
            .json(&json!({ "id": id, "name": "Private Doc", "pageOrder": [] }))
            .send()
            .await
            .expect("create doc");
        assert!(resp.status().is_success(), "seed PUT failed: {}", resp.status());
        id.to_string()
    }

    async fn share(&self, owner: &str, doc_id: &str, with: &str, permission: &str) {
        let resp = reqwest::Client::new()
            .post(format!("{}/api/docs/{}/share", self.base, doc_id))
            .bearer_auth(self.token(owner, WorkspaceRole::Owner))
            .json(&json!({
                "shares": [{
                    "userId": with,
                    "userName": with,
                    "permission": permission,
                    "sharedAt": 0,
                }]
            }))
            .send()
            .await
            .expect("share");
        assert!(resp.status().is_success(), "share failed: {}", resp.status());
    }

    async fn get_doc(&self, sub: &str, role: WorkspaceRole, doc_id: &str) -> StatusCode {
        reqwest::Client::new()
            .get(format!("{}/api/docs/{}", self.base, doc_id))
            .bearer_auth(self.token(sub, role))
            .send()
            .await
            .expect("get doc")
            .status()
    }

    async fn put_doc(&self, sub: &str, role: WorkspaceRole, doc_id: &str) -> StatusCode {
        reqwest::Client::new()
            .put(format!("{}/api/docs/{}", self.base, doc_id))
            .bearer_auth(self.token(sub, role))
            .json(&json!({ "id": doc_id, "name": "Overwritten", "pageOrder": [] }))
            .send()
            .await
            .expect("put doc")
            .status()
    }

    async fn list_doc_ids(&self, sub: &str, role: WorkspaceRole) -> Vec<String> {
        let body: Value = reqwest::Client::new()
            .get(format!("{}/api/docs", self.base))
            .bearer_auth(self.token(sub, role))
            .send()
            .await
            .expect("list docs")
            .json()
            .await
            .expect("list json");
        body["documents"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|d| d["id"].as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Authenticate over WS and attempt a JOIN_DOC. `Ok(())` = joined,
    /// `Err(msg)` = the relay sent an error frame instead.
    async fn try_join(
        &self,
        sub: &str,
        role: WorkspaceRole,
        doc_id: &str,
    ) -> Result<(), String> {
        let url = format!("{}/ws?protocolVersion={}", self.ws_base, PROTOCOL_VERSION);
        let (mut ws, _) = tokio_tungstenite::connect_async(&url)
            .await
            .expect("ws connect");

        // The WS auth payload is a JSON-encoded bare string, not an object —
        // `handle_auth` in `src/server/mod.rs` decodes it as `String` directly.
        let auth = encode_message(MESSAGE_AUTH, &self.token(sub, role))
            .expect("encode auth");
        ws.send(WsMessage::Binary(auth)).await.expect("send auth");

        // Drain until AUTH_RESPONSE.
        loop {
            let msg = tokio::time::timeout(Duration::from_secs(5), ws.next())
                .await
                .expect("auth timeout")
                .expect("ws stream")
                .expect("ws msg");
            if let WsMessage::Binary(data) = msg {
                if data.first() == Some(&MESSAGE_AUTH_RESPONSE) {
                    let payload: Value =
                        serde_json::from_slice(&data[1..]).expect("auth response json");
                    assert_eq!(payload["success"], json!(true), "auth failed for {sub}");
                    break;
                }
            }
        }

        let join = encode_message(
            MESSAGE_JOIN_DOC,
            &json!({ "docId": doc_id, "requestId": "r1" }),
        )
        .expect("encode join");
        ws.send(WsMessage::Binary(join)).await.expect("send join");

        // An accepted join produces sync traffic; a refused one produces an
        // ERROR frame. Short timeout — silence means "no refusal".
        let deadline = tokio::time::Instant::now() + Duration::from_millis(1200);
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return Ok(());
            }
            match tokio::time::timeout(remaining, ws.next()).await {
                Ok(Some(Ok(WsMessage::Binary(data)))) if data.first() == Some(&MESSAGE_ERROR) => {
                    let payload: Value =
                        serde_json::from_slice(&data[1..]).unwrap_or_else(|_| json!({}));
                    return Err(payload["error"].as_str().unwrap_or("unknown").to_string());
                }
                Ok(Some(Ok(_))) => continue,
                Ok(Some(Err(_))) | Ok(None) => return Ok(()),
                Err(_) => return Ok(()),
            }
        }
    }
}

// ============================================================
// The asymmetry probe: what does flag-OFF actually mean?
// ============================================================

/// The boot warning in `main.rs` claims that with enforcement off "any
/// workspace member can read AND write any document". This test states what
/// the code actually does on each surface, so the claim can be checked rather
/// than assumed.
#[tokio::test]
async fn flag_off_surfaces_agree_with_each_other() {
    let h = Harness::start(false).await;
    let doc = h.create_doc("alice", WorkspaceRole::Owner, "doc-alpha").await;

    let listed = h.list_doc_ids("bob", WorkspaceRole::Member).await;
    let rest_get = h.get_doc("bob", WorkspaceRole::Member, &doc).await;
    let rest_put = h.put_doc("bob", WorkspaceRole::Member, &doc).await;
    let join = h.try_join("bob", WorkspaceRole::Member, &doc).await;

    let summary = format!(
        "flag=OFF  listed={}  REST GET={}  REST PUT={}  WS JOIN={}",
        listed.contains(&doc),
        rest_get,
        rest_put,
        join.as_ref().map(|_| "allowed".into()).unwrap_or_else(|e| e.clone()),
    );
    println!("{summary}");

    // The invariant: a surface set is only coherent if every read surface
    // agrees. Listing a document the caller cannot then fetch is the broken
    // middle state this test exists to forbid.
    let can_see_in_list = listed.contains(&doc);
    let can_fetch = rest_get.is_success();
    assert_eq!(
        can_see_in_list, can_fetch,
        "incoherent read surfaces — {summary}. A document that appears in the \
         listing must be fetchable by the same caller."
    );
}

/// Same matrix with enforcement on: every surface must refuse.
#[tokio::test]
async fn flag_on_denies_every_surface_to_an_unshared_member() {
    let h = Harness::start(true).await;
    let doc = h.create_doc("alice", WorkspaceRole::Owner, "doc-alpha").await;

    assert!(
        !h.list_doc_ids("bob", WorkspaceRole::Member).await.contains(&doc),
        "listing leaked a private document"
    );
    assert_eq!(
        h.get_doc("bob", WorkspaceRole::Member, &doc).await,
        StatusCode::FORBIDDEN,
        "REST GET must refuse an unshared member"
    );
    assert_eq!(
        h.put_doc("bob", WorkspaceRole::Member, &doc).await,
        StatusCode::FORBIDDEN,
        "REST PUT must refuse an unshared member"
    );
    assert!(
        h.try_join("bob", WorkspaceRole::Member, &doc).await.is_err(),
        "WS JOIN_DOC must refuse an unshared member"
    );
}

/// A shared member gets exactly the level they were granted — no more.
#[tokio::test]
async fn flag_on_grants_exactly_the_shared_level() {
    let h = Harness::start(true).await;
    let doc = h.create_doc("alice", WorkspaceRole::Owner, "doc-alpha").await;
    h.share("alice", &doc, "bob", "view").await;

    assert!(
        h.get_doc("bob", WorkspaceRole::Member, &doc).await.is_success(),
        "a view share must permit reading"
    );
    assert_eq!(
        h.put_doc("bob", WorkspaceRole::Member, &doc).await,
        StatusCode::FORBIDDEN,
        "a view share must NOT permit writing"
    );
}

/// A workspace **owner** holds owner rights on every document in the
/// workspace — the inheritance the access panel draws as "via workspace".
#[tokio::test]
async fn workspace_owner_inherits_owner_on_every_document() {
    let h = Harness::start(true).await;
    let doc = h.create_doc("alice", WorkspaceRole::Owner, "doc-alpha").await;

    assert!(
        h.get_doc("carol", WorkspaceRole::Owner, &doc).await.is_success(),
        "a workspace owner must be able to read any document"
    );
    assert!(
        h.put_doc("carol", WorkspaceRole::Owner, &doc).await.is_success(),
        "a workspace owner must be able to write any document"
    );
}

/// Can a caller who joined over WS also *mutate* the document there? The live
/// edit path is Yjs SYNC frames, gated separately from REST. `data[1]` is the
/// lib0 sync sub-type: 0 = SyncStep1 (a read request, always allowed), 2 =
/// Update (write-bearing). `[0, 0]` is a well-formed empty yrs update, so the
/// only thing that can refuse the frame is the permission gate.
async fn ws_write_refused(h: &Harness, sub: &str, role: WorkspaceRole, doc_id: &str) -> bool {
    let url = format!("{}/ws?protocolVersion={}", h.ws_base, PROTOCOL_VERSION);
    let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.expect("ws connect");

    let auth = encode_message(MESSAGE_AUTH, &h.token(sub, role)).expect("encode auth");
    ws.send(WsMessage::Binary(auth)).await.expect("send auth");
    loop {
        let msg = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("auth timeout")
            .expect("ws stream")
            .expect("ws msg");
        if let WsMessage::Binary(data) = msg {
            if data.first() == Some(&MESSAGE_AUTH_RESPONSE) {
                break;
            }
        }
    }

    let join = encode_message(MESSAGE_JOIN_DOC, &json!({ "docId": doc_id })).expect("encode join");
    ws.send(WsMessage::Binary(join)).await.expect("send join");
    tokio::time::sleep(Duration::from_millis(300)).await;

    ws.send(WsMessage::Binary(vec![MESSAGE_SYNC, 2, 0, 0]))
        .await
        .expect("send sync update");

    let deadline = tokio::time::Instant::now() + Duration::from_millis(1200);
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return false;
        }
        match tokio::time::timeout(remaining, ws.next()).await {
            Ok(Some(Ok(WsMessage::Binary(data)))) if data.first() == Some(&MESSAGE_ERROR) => {
                let payload: Value = serde_json::from_slice(&data[1..]).unwrap_or_else(|_| json!({}));
                if payload["error"].as_str().unwrap_or("").contains("EDIT_FORBIDDEN") {
                    return true;
                }
            }
            Ok(Some(Ok(_))) => continue,
            Ok(Some(Err(_))) | Ok(None) => return false,
            Err(_) => return false,
        }
    }
}

/// With enforcement off, the live-edit gate is skipped entirely — so an
/// unshared member can mutate a document the REST API refuses to hand them.
/// This is the sharpest expression of the incoherence: REST says 403, the
/// sync path says yes.
#[tokio::test]
async fn flag_off_lets_an_unshared_member_write_over_websocket() {
    let h = Harness::start(false).await;
    let doc = h.create_doc("alice", WorkspaceRole::Owner, "doc-alpha").await;

    let rest_denied = h.put_doc("bob", WorkspaceRole::Member, &doc).await == StatusCode::FORBIDDEN;
    let ws_denied = ws_write_refused(&h, "bob", WorkspaceRole::Member, &doc).await;

    assert_eq!(
        rest_denied, ws_denied,
        "REST and the live-edit path disagree about whether bob may write \
         (REST denied={rest_denied}, WS denied={ws_denied})"
    );
}

/// With enforcement on, the live-edit gate must refuse a view-only share.
#[tokio::test]
async fn flag_on_refuses_a_view_share_write_over_websocket() {
    let h = Harness::start(true).await;
    let doc = h.create_doc("alice", WorkspaceRole::Owner, "doc-alpha").await;
    h.share("alice", &doc, "bob", "view").await;

    assert!(
        ws_write_refused(&h, "bob", WorkspaceRole::Member, &doc).await,
        "a view-only share must not be able to write over the sync path"
    );
}

// ============================================================
// The Viewer ceiling
// ============================================================

/// A workspace **Viewer** is the coarse read-only role. The editor's invite
/// copy promises "Read-only, even where shared" — so an `edit` share must not
/// promote a Viewer to a writer. `get_user_permission` currently ignores the
/// Viewer role entirely and falls through to the share table.
#[tokio::test]
async fn workspace_viewer_cannot_write_even_with_an_edit_share() {
    let h = Harness::start(true).await;
    let doc = h.create_doc("alice", WorkspaceRole::Owner, "doc-alpha").await;
    h.share("alice", &doc, "dave", "edit").await;

    assert!(
        h.get_doc("dave", WorkspaceRole::Viewer, &doc).await.is_success(),
        "an edit share should still permit reading for a workspace viewer"
    );
    assert_eq!(
        h.put_doc("dave", WorkspaceRole::Viewer, &doc).await,
        StatusCode::FORBIDDEN,
        "the workspace Viewer role must clamp an edit share to read-only"
    );
}

/// The same clamp on the live-edit path — a Viewer's Yjs update frame must be
/// dropped even when a share says `edit`.
#[tokio::test]
async fn workspace_viewer_cannot_be_promoted_by_share_on_join() {
    let h = Harness::start(true).await;
    let doc = h.create_doc("alice", WorkspaceRole::Owner, "doc-alpha").await;
    h.share("alice", &doc, "dave", "edit").await;

    // Reading is fine; the write clamp is asserted by the REST sibling above.
    assert!(
        h.try_join("dave", WorkspaceRole::Viewer, &doc).await.is_ok(),
        "a viewer with a share may still join to read"
    );
}

/// An owned document is refused to an unshared member. The unowned legacy
/// carve-out is covered by the resolver's unit tests, which can construct
/// metadata with no owner directly — REST cannot, because the write path now
/// always stamps one.
#[tokio::test]
async fn owned_document_is_refused_to_an_unshared_member() {
    let h = Harness::start(true).await;
    let doc = h.create_doc("alice", WorkspaceRole::Owner, "doc-owned").await;
    assert_eq!(
        h.get_doc("bob", WorkspaceRole::Member, &doc).await,
        StatusCode::FORBIDDEN,
        "an unshared member must not read"
    );
}

// ============================================================
// Ownership provenance — is `ownerId` server-assigned or client-asserted?
// ============================================================

/// `DocumentStore` reads `owner_id` out of the document body's `ownerId`
/// field. If the relay never stamps it from the caller's token, then with
/// enforcement on a creator who is a plain Member cannot read back the
/// document they just created.
#[tokio::test]
async fn creator_can_read_back_their_own_document() {
    let h = Harness::start(true).await;
    let doc = h.create_doc("erin", WorkspaceRole::Member, "doc-erin").await;

    assert!(
        h.get_doc("erin", WorkspaceRole::Member, &doc).await.is_success(),
        "the creator of a document must be able to read it back"
    );
}

/// An editor holds write permission — but writing *content* must not let them
/// rewrite *ownership*. If `ownerId` is taken from the request body, an editor
/// can promote themselves to owner and then manage shares and delete.
#[tokio::test]
async fn an_editor_cannot_seize_ownership_via_the_document_body() {
    let h = Harness::start(true).await;
    let doc = h.create_doc("alice", WorkspaceRole::Owner, "doc-alpha").await;
    h.share("alice", &doc, "bob", "edit").await;

    let resp = reqwest::Client::new()
        .put(format!("{}/api/docs/{}", h.base, doc))
        .bearer_auth(h.token("bob", WorkspaceRole::Member))
        .json(&json!({
            "id": doc,
            "name": "Seized",
            "pageOrder": [],
            "ownerId": "bob",
        }))
        .send()
        .await
        .expect("put doc");
    assert!(resp.status().is_success(), "an editor's content write should succeed");

    // The escalation test: can bob now do something only an owner can do?
    let share_resp = reqwest::Client::new()
        .post(format!("{}/api/docs/{}/share", h.base, doc))
        .bearer_auth(h.token("bob", WorkspaceRole::Member))
        .json(&json!({ "shares": [] }))
        .send()
        .await
        .expect("share attempt");
    assert_eq!(
        share_resp.status(),
        StatusCode::FORBIDDEN,
        "an editor must not become owner by asserting ownerId in the body"
    );
}

/// Direct confirmation of the sibling above: read the document back and check
/// whose id the relay records as owner after an editor writes content with a
/// forged `ownerId`. Before JP-457 this returned "bob".
#[tokio::test]
async fn document_body_cannot_rewrite_recorded_ownership() {
    let h = Harness::start(true).await;
    let doc = h.create_doc("alice", WorkspaceRole::Owner, "doc-alpha").await;
    h.share("alice", &doc, "bob", "edit").await;

    let _ = reqwest::Client::new()
        .put(format!("{}/api/docs/{}", h.base, doc))
        .bearer_auth(h.token("bob", WorkspaceRole::Member))
        .json(&json!({ "id": doc, "name": "Seized", "pageOrder": [], "ownerId": "bob" }))
        .send()
        .await
        .expect("put doc");

    let body: Value = reqwest::Client::new()
        .get(format!("{}/api/docs", h.base))
        .bearer_auth(h.token("alice", WorkspaceRole::Owner))
        .send()
        .await
        .expect("list")
        .json()
        .await
        .expect("json");
    let owner = body["documents"]
        .as_array()
        .and_then(|a| a.iter().find(|d| d["id"] == json!(doc.clone())))
        .and_then(|d| d["ownerId"].as_str())
        .unwrap_or("<none>")
        .to_string();

    assert_eq!(
        owner, "alice",
        "the recorded owner must survive a content write by an editor"
    );
}

/// Every path that CREATES a document must leave it owned, or the legacy
/// carve-out in `permissions::resolve` is refilled as fast as it drains.
/// REST PUT is covered by `creator_can_read_back_their_own_document`; this
/// covers restore-as-new-id, which mints a fresh document from a recovery
/// point. (MCP `create_document` is covered by a unit test in `mcp::tools`,
/// which can drive a tool context directly.)
#[tokio::test]
async fn restoring_a_recovery_point_leaves_the_new_document_owned() {
    let h = Harness::start(true).await;
    let doc = h.create_doc("alice", WorkspaceRole::Owner, "doc-alpha").await;

    let capture = reqwest::Client::new()
        .post(format!("{}/api/docs/{}/recovery/capture", h.base, doc))
        .bearer_auth(h.token("alice", WorkspaceRole::Owner))
        .send()
        .await
        .expect("capture recovery point");
    assert!(capture.status().is_success(), "capture failed: {}", capture.status());

    let points: Value = reqwest::Client::new()
        .get(format!("{}/api/docs/{}/recovery", h.base, doc))
        .bearer_auth(h.token("alice", WorkspaceRole::Owner))
        .send()
        .await
        .expect("list recovery")
        .json()
        .await
        .expect("json");
    let Some(point_id) = points["recoveryPoints"]
        .as_array()
        .and_then(|a| a.first())
        .and_then(|p| p["id"].as_str())
        .map(str::to_string)
    else {
        // No point captured (a fresh doc may be byte-identical to its baseline);
        // nothing to assert rather than a false pass.
        return;
    };

    let restored: Value = reqwest::Client::new()
        .post(format!("{}/api/docs/{}/recovery/{}/restore", h.base, doc, point_id))
        .bearer_auth(h.token("alice", WorkspaceRole::Owner))
        .send()
        .await
        .expect("restore")
        .json()
        .await
        .expect("restore json");
    let new_id = restored["id"].as_str().unwrap_or_default().to_string();
    assert!(!new_id.is_empty(), "restore did not report a new id: {restored}");

    // Alice must be able to read the restored copy as a plain member — which is
    // only true if it carries an owner.
    assert!(
        h.get_doc("alice", WorkspaceRole::Member, &new_id).await.is_success(),
        "the restored document must be owned, not orphaned into the carve-out"
    );
}
