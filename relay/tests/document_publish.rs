//! Public projection (`/api/docs/:id/publish`) — behavioural pins.
//!
//! The published artifact is served to readers with no relay credentials, so
//! this suite is written adversarially: it asserts what the artifact must
//! **never** contain (the identity fields the raw body embeds), that the
//! meter counts published bytes, that the cap refuses without invalidating a
//! live snapshot, and that all of it survives a machine restart.
//!
//! Harness mirrors `document_privacy.rs`: a real relay on a random port in
//! `Shared` tenancy, driven over REST only.

use std::path::PathBuf;
use std::sync::Arc;

use docushark_relay::auth::WorkspaceRole;
use docushark_relay::config::{
    LimitsConfig, S3StorageConfig, StorageConfig, TenancyConfig, TenancyMode,
};
use docushark_relay::server::{NetworkMode, ServerConfig, WebSocketServer};
use docushark_relay::test_support::OidcTestIssuer;
use reqwest::StatusCode;
use serde_json::{json, Value};
use tempfile::TempDir;

const WS: &str = "ws_publish";
/// Bucket name for the in-process fake object store (path-style addressing —
/// the first URL segment, which the fake's wildcard route captures).
const BUCKET: &str = "pub-test-bucket";

struct Harness {
    base: String,
    issuer: OidcTestIssuer,
    data_dir: PathBuf,
    _tmp: Option<TempDir>,
}

impl Harness {
    async fn start() -> Self {
        Self::start_with_limits(LimitsConfig::default()).await
    }

    async fn start_with_limits(limits: LimitsConfig) -> Self {
        let tmp = tempfile::tempdir().expect("tempdir");
        let data_dir = tmp.path().to_path_buf();
        Self::boot(limits, data_dir, Some(tmp), None).await
    }

    /// Boot a relay whose byte store is the S3-compatible endpoint at
    /// `endpoint` (the in-process fake) — the Cloud shape, where publish
    /// uploads artifacts and mirrors the registry to the object store.
    async fn start_on_s3(limits: LimitsConfig, endpoint: &str) -> Self {
        let tmp = tempfile::tempdir().expect("tempdir");
        let data_dir = tmp.path().to_path_buf();
        let storage = StorageConfig {
            backend: "s3".into(),
            path: data_dir.clone(),
            s3: Some(S3StorageConfig {
                endpoint: endpoint.to_string(),
                bucket: BUCKET.into(),
                access_key_id: "test-access".into(),
                secret_access_key: "test-secret".into(),
                ..S3StorageConfig::default()
            }),
        };
        Self::boot(limits, data_dir, Some(tmp), Some(storage)).await
    }

    /// Boot a second relay over an existing data directory — proves the
    /// published registry (and its meter contribution) survives a restart.
    async fn reboot(self, limits: LimitsConfig) -> Self {
        let Harness { data_dir, _tmp, issuer: _, .. } = self;
        Self::boot(limits, data_dir, _tmp, None).await
    }

    async fn boot(
        limits: LimitsConfig,
        data_dir: PathBuf,
        tmp: Option<TempDir>,
        storage: Option<StorageConfig>,
    ) -> Self {
        let issuer = OidcTestIssuer::new().await;

        let server = Arc::new(WebSocketServer::new());
        server.set_app_data_dir(data_dir.clone()).await;
        server.set_auth(issuer.auth_state()).await;
        if let Some(storage) = storage {
            server.set_storage(storage).await;
        }
        server
            .set_tenancy(TenancyConfig {
                mode: TenancyMode::Shared,
                workspace_id: None,
                limits,
                ..TenancyConfig::default()
            })
            .await;
        // Publishing must respect per-document privacy the same way every
        // other surface does, so run with enforcement on — the default.
        server.set_enforce_private_docs(true);
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

        std::mem::forget(server);

        Self { base: http, issuer, data_dir, _tmp: tmp }
    }

    fn token(&self, sub: &str, role: WorkspaceRole) -> String {
        self.issuer.mint(sub, WS, role)
    }

    fn ws_dir(&self) -> PathBuf {
        self.data_dir.join("relay_documents/workspaces").join(WS)
    }

    async fn put_doc(&self, sub: &str, role: WorkspaceRole, id: &str, body: Value) -> StatusCode {
        reqwest::Client::new()
            .put(format!("{}/api/docs/{}", self.base, id))
            .bearer_auth(self.token(sub, role))
            .json(&body)
            .send()
            .await
            .expect("put doc")
            .status()
    }

    /// A document body loaded with every people-shaped field the raw store
    /// carries — plus one field ("reviewers") that does not exist in the
    /// model at all, which is what distinguishes an allowlist from a denylist.
    fn people_laden_body(id: &str) -> Value {
        json!({
            "id": id,
            "name": "Projection Probe",
            "modifiedAt": 1000,
            "tags": ["secret-project"],
            "collectionId": "col-1",
            "lastModifiedBy": "user-owner",
            "lastModifiedByName": "Olive Owner",
            "reviewers": [{ "userId": "user-x", "userName": "Xavier X" }],
            "blobReferences": ["e".repeat(64)],
            "pageOrder": ["p1"],
            "activePageId": "p1",
            "pages": {
                "p1": {
                    "shapes": {
                        "s1": { "type": "rectangle", "x": 0.0, "y": 0.0 },
                        "s2": { "type": "file", "x": 1.0, "y": 1.0,
                                "blobUrl": format!("blob://{}", "f".repeat(64)) }
                    },
                    "shapeOrder": ["s1", "s2"]
                }
            },
            "richTextPages": { "pageOrder": [], "pages": {} }
        })
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

    async fn publish(&self, sub: &str, role: WorkspaceRole, doc_id: &str) -> reqwest::Response {
        reqwest::Client::new()
            .post(format!("{}/api/docs/{}/publish", self.base, doc_id))
            .bearer_auth(self.token(sub, role))
            .send()
            .await
            .expect("publish")
    }

    async fn unpublish(&self, sub: &str, role: WorkspaceRole, doc_id: &str) -> reqwest::Response {
        reqwest::Client::new()
            .delete(format!("{}/api/docs/{}/publish", self.base, doc_id))
            .bearer_auth(self.token(sub, role))
            .send()
            .await
            .expect("unpublish")
    }

    async fn publish_status(&self, sub: &str, role: WorkspaceRole, doc_id: &str) -> Value {
        let resp = reqwest::Client::new()
            .get(format!("{}/api/docs/{}/publish", self.base, doc_id))
            .bearer_auth(self.token(sub, role))
            .send()
            .await
            .expect("status");
        assert_eq!(resp.status(), StatusCode::OK, "status GET failed");
        resp.json().await.expect("status json")
    }

    async fn usage_storage_bytes(&self, sub: &str) -> u64 {
        let body: Value = reqwest::Client::new()
            .get(format!("{}/api/v1/usage", self.base))
            .bearer_auth(self.token(sub, WorkspaceRole::Owner))
            .send()
            .await
            .expect("usage")
            .json()
            .await
            .expect("usage json");
        body["storageBytes"].as_u64().expect("storageBytes")
    }

    fn artifact_path(&self, doc_id: &str) -> PathBuf {
        self.ws_dir().join("public").join(format!("{doc_id}.json"))
    }

    fn manifest_path(&self, doc_id: &str) -> PathBuf {
        self.ws_dir().join("public").join(format!("{doc_id}.manifest.json"))
    }
}

// ───────────────────────── the artifact is a projection ─────────────────────

#[tokio::test]
async fn published_artifact_carries_no_identity_and_no_novel_fields() {
    let h = Harness::start().await;
    let doc = "proj-doc";
    assert!(h
        .put_doc("user-owner", WorkspaceRole::Owner, doc, Harness::people_laden_body(doc))
        .await
        .is_success());
    // A share writes `sharedWith` (ids + display names) INTO the stored body —
    // the exact bytes the projection must strip.
    h.share("user-owner", doc, "user-collab", "edit").await;

    let resp = h.publish("user-owner", WorkspaceRole::Owner, doc).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let ack: Value = resp.json().await.unwrap();
    assert_eq!(ack["success"], json!(true));
    assert!(ack["bytes"].as_u64().unwrap() > 0);
    // Filesystem backend: keys are null, the artifact lives under public/.
    assert!(ack["artifactKey"].is_null());

    let artifact = std::fs::read_to_string(h.artifact_path(doc)).expect("artifact written");
    let parsed: Value = serde_json::from_str(&artifact).unwrap();

    // Kept: the content a reader needs.
    assert_eq!(parsed["name"], "Projection Probe");
    assert!(parsed["pages"]["p1"]["shapes"]["s1"].is_object());

    // Dropped: every identity-bearing or internal field — including one the
    // model has never heard of ("reviewers"), which a denylist written against
    // today's fields would have let through.
    for gone in [
        "id",
        "ownerId",
        "ownerName",
        "sharedWith",
        "lastModifiedBy",
        "lastModifiedByName",
        "collectionId",
        "tags",
        "serverVersion",
        "blobReferences",
        "reviewers",
    ] {
        assert!(parsed.get(gone).is_none(), "{gone} must not survive projection");
    }
    for needle in ["user-owner", "user-collab", "Olive Owner", "Xavier X", "secret-project"] {
        assert!(!artifact.contains(needle), "artifact leaked {needle:?}");
    }
}

#[tokio::test]
async fn manifest_authorizes_only_blobs_the_projection_references() {
    let h = Harness::start().await;
    let doc = "manifest-doc";
    assert!(h
        .put_doc("user-owner", WorkspaceRole::Owner, doc, Harness::people_laden_body(doc))
        .await
        .is_success());
    assert_eq!(h.publish("user-owner", WorkspaceRole::Owner, doc).await.status(), StatusCode::OK);

    let manifest: Value =
        serde_json::from_str(&std::fs::read_to_string(h.manifest_path(doc)).unwrap()).unwrap();
    let blobs = manifest["blobs"].as_object().expect("blobs map");

    // "f"×64 is referenced by the FileShape — in. "e"×64 lived only in the
    // dropped `blobReferences` array — a blob the artifact does not use must
    // not be resolvable through its manifest.
    let content_hash = "f".repeat(64);
    assert_eq!(blobs.len(), 1, "exactly the projection's blobs: {blobs:?}");
    assert_eq!(
        blobs[&content_hash].as_str().unwrap(),
        format!("ws/{}/ff/ff/{}", WS, content_hash),
        "manifest carries the full sharded key, consumer derives nothing"
    );
    assert_eq!(manifest["title"], "Projection Probe");
    assert_eq!(manifest["pageCount"], 1);
    assert_eq!(manifest["shapeCount"], 2);
    assert_eq!(manifest["fileCount"], 1);
}

// ───────────────────────────── authorization ────────────────────────────────

#[tokio::test]
async fn publish_and_unpublish_are_owner_only_status_is_read_scoped() {
    let h = Harness::start().await;
    let doc = "authz-doc";
    assert!(h
        .put_doc("user-owner", WorkspaceRole::Owner, doc, Harness::people_laden_body(doc))
        .await
        .is_success());
    h.share("user-owner", doc, "user-editor", "edit").await;
    h.share("user-owner", doc, "user-viewer", "view").await;

    // An edit share is not ownership: publishing exposes content beyond the
    // workspace, so it takes the owner gate.
    for (sub, role) in [
        ("user-editor", WorkspaceRole::Member),
        ("user-viewer", WorkspaceRole::Member),
        ("user-stranger", WorkspaceRole::Member),
    ] {
        assert_eq!(
            h.publish(sub, role, doc).await.status(),
            StatusCode::FORBIDDEN,
            "{sub} must not publish"
        );
    }

    assert_eq!(h.publish("user-owner", WorkspaceRole::Owner, doc).await.status(), StatusCode::OK);

    // Status: anyone who can read the doc can see its publish state…
    let status = h.publish_status("user-viewer", WorkspaceRole::Member, doc).await;
    assert_eq!(status["published"], json!(true));

    // …but cannot change it.
    assert_eq!(
        h.unpublish("user-editor", WorkspaceRole::Member, doc).await.status(),
        StatusCode::FORBIDDEN
    );

    // A workspace owner holds owner rights on every document (grant chain).
    assert_eq!(
        h.unpublish("user-admin", WorkspaceRole::Owner, doc).await.status(),
        StatusCode::OK
    );
}

#[tokio::test]
async fn publish_of_a_missing_document_is_404() {
    let h = Harness::start().await;
    assert_eq!(
        h.publish("user-owner", WorkspaceRole::Owner, "never-existed").await.status(),
        StatusCode::NOT_FOUND
    );
}

// ───────────────────────────── size + meter ─────────────────────────────────

#[tokio::test]
async fn over_cap_publish_is_refused_with_the_cap_and_leaves_the_live_snapshot() {
    let h = Harness::start_with_limits(LimitsConfig {
        publish_max_bytes: 600,
        ..LimitsConfig::default()
    })
    .await;
    let doc = "cap-doc";

    // Small body: publishes fine under the 600-byte cap.
    assert!(h
        .put_doc(
            "user-owner",
            WorkspaceRole::Owner,
            doc,
            json!({ "id": doc, "name": "small", "modifiedAt": 1, "pageOrder": [] }),
        )
        .await
        .is_success());
    let first = h.publish("user-owner", WorkspaceRole::Owner, doc).await;
    assert_eq!(first.status(), StatusCode::OK);
    let first_bytes = first.json::<Value>().await.unwrap()["bytes"].as_u64().unwrap();

    // Grow the source past the cap.
    assert!(h
        .put_doc(
            "user-owner",
            WorkspaceRole::Owner,
            doc,
            json!({
                "id": doc,
                "name": "x".repeat(800),
                "modifiedAt": 2,
                "pageOrder": [],
            }),
        )
        .await
        .is_success());

    let refused = h.publish("user-owner", WorkspaceRole::Owner, doc).await;
    assert_eq!(refused.status(), StatusCode::PAYLOAD_TOO_LARGE);
    let body: Value = refused.json().await.unwrap();
    assert_eq!(body["errorCode"], "PUBLISH_TOO_LARGE");
    assert_eq!(body["maxBytes"], 600, "cap echoed so clients render the configured number");
    assert!(body["sizeBytes"].as_u64().unwrap() > 600);

    // The refused republish must NOT have touched the live snapshot: readers
    // keep the previous artifact, and status still says published (stale).
    let artifact = std::fs::read_to_string(h.artifact_path(doc)).unwrap();
    assert!(artifact.contains("small"), "previous artifact still served");
    assert_eq!(artifact.len() as u64, first_bytes);
    let status = h.publish_status("user-owner", WorkspaceRole::Owner, doc).await;
    assert_eq!(status["published"], json!(true));
    assert_eq!(status["stale"], json!(true));
    assert_eq!(status["maxBytes"], 600);
}

#[tokio::test]
async fn published_bytes_join_the_storage_meter_and_leave_on_unpublish() {
    let h = Harness::start().await;
    let doc = "meter-doc";
    assert!(h
        .put_doc("user-owner", WorkspaceRole::Owner, doc, Harness::people_laden_body(doc))
        .await
        .is_success());

    let before = h.usage_storage_bytes("user-owner").await;
    let ack: Value = h
        .publish("user-owner", WorkspaceRole::Owner, doc)
        .await
        .json()
        .await
        .unwrap();
    let artifact_bytes = ack["bytes"].as_u64().unwrap();

    let during = h.usage_storage_bytes("user-owner").await;
    assert_eq!(
        during,
        before + artifact_bytes,
        "the artifact is a second stored copy and meters as one"
    );

    let resp = h.unpublish("user-owner", WorkspaceRole::Owner, doc).await;
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(resp.json::<Value>().await.unwrap()["removed"], json!(true));
    assert_eq!(h.usage_storage_bytes("user-owner").await, before, "unpublish frees the bytes");

    // Files gone, status back to unpublished, second delete idempotent.
    assert!(!h.artifact_path(doc).exists());
    assert!(!h.manifest_path(doc).exists());
    let status = h.publish_status("user-owner", WorkspaceRole::Owner, doc).await;
    assert_eq!(status["published"], json!(false));
    let again = h.unpublish("user-owner", WorkspaceRole::Owner, doc).await;
    assert_eq!(again.status(), StatusCode::OK);
    assert_eq!(again.json::<Value>().await.unwrap()["removed"], json!(false));
}

#[tokio::test]
async fn publish_refuses_when_the_quota_cannot_hold_a_second_copy() {
    // Quota sized to admit the document but not document + artifact.
    let h = Harness::start_with_limits(LimitsConfig {
        storage_quota_bytes: 700,
        ..LimitsConfig::default()
    })
    .await;
    let doc = "quota-doc";
    // ~400-byte body (pretty-printed on disk): fits the 700-byte quota alone;
    // its ~300-byte compact artifact would overflow it.
    assert!(h
        .put_doc(
            "user-owner",
            WorkspaceRole::Owner,
            doc,
            json!({ "id": doc, "name": "q".repeat(300), "modifiedAt": 1, "pageOrder": [] }),
        )
        .await
        .is_success());

    let resp = h.publish("user-owner", WorkspaceRole::Owner, doc).await;
    assert_eq!(resp.status(), StatusCode::INSUFFICIENT_STORAGE);
    // Same stable string as the save gate — clients key on it.
    assert_eq!(resp.json::<Value>().await.unwrap()["error"], "storage quota exceeded");
    assert!(!h.artifact_path(doc).exists(), "a refused publish writes nothing");
}

// ───────────────────────────── staleness ────────────────────────────────────

#[tokio::test]
async fn status_flags_stale_after_a_source_edit_and_clears_on_republish() {
    let h = Harness::start().await;
    let doc = "stale-doc";
    assert!(h
        .put_doc(
            "user-owner",
            WorkspaceRole::Owner,
            doc,
            json!({ "id": doc, "name": "v1", "modifiedAt": 1000, "pageOrder": [] }),
        )
        .await
        .is_success());

    assert_eq!(h.publish("user-owner", WorkspaceRole::Owner, doc).await.status(), StatusCode::OK);
    let status = h.publish_status("user-owner", WorkspaceRole::Owner, doc).await;
    assert_eq!(status["stale"], json!(false));

    // Edit with a later modifiedAt — the staleness axis is the timestamp,
    // deliberately (collab flushes don't bump serverVersion).
    assert!(h
        .put_doc(
            "user-owner",
            WorkspaceRole::Owner,
            doc,
            json!({ "id": doc, "name": "v2", "modifiedAt": 2000, "pageOrder": [] }),
        )
        .await
        .is_success());
    let status = h.publish_status("user-owner", WorkspaceRole::Owner, doc).await;
    assert_eq!(status["stale"], json!(true));

    assert_eq!(h.publish("user-owner", WorkspaceRole::Owner, doc).await.status(), StatusCode::OK);
    let status = h.publish_status("user-owner", WorkspaceRole::Owner, doc).await;
    assert_eq!(status["stale"], json!(false));
    // And the artifact now reflects the edit.
    assert!(std::fs::read_to_string(h.artifact_path(doc)).unwrap().contains("v2"));
}

// ─────────────────────── lifecycle teardown (JP-470) ────────────────────────
//
// A publication must end when its document does — through EVERY removal path,
// not just the explicit unpublish button. These pin the shared seam
// (`teardown_publish`): document delete tears the artifact down, and a
// recovery restore carries the FROZEN artifact to the successor id instead of
// ending (or re-projecting) the publication.

impl Harness {
    async fn delete_doc(&self, sub: &str, role: WorkspaceRole, id: &str) -> StatusCode {
        reqwest::Client::new()
            .delete(format!("{}/api/docs/{}", self.base, id))
            .bearer_auth(self.token(sub, role))
            .send()
            .await
            .expect("delete doc")
            .status()
    }

    async fn get_doc(&self, sub: &str, role: WorkspaceRole, id: &str) -> StatusCode {
        reqwest::Client::new()
            .get(format!("{}/api/docs/{}", self.base, id))
            .bearer_auth(self.token(sub, role))
            .send()
            .await
            .expect("get doc")
            .status()
    }

    /// Mint the binary Y.Doc sidecar a collab session would have persisted.
    /// REST saves deliberately never write one (that's the snapshot path),
    /// and recovery capture refuses to invent one — `push_recovery_point_if_
    /// changed` backs up the sidecar, so a doc without one has nothing to
    /// capture. Built through the real envelope (`DocHandle::encode_binary`),
    /// so the restore path decodes it exactly like a production point.
    fn seed_sidecar(&self, doc_id: &str, page_id: &str) {
        let handle = docushark_relay::sync::DocHandle::from_decoded(
            yrs::Doc::new(),
            Some(page_id.to_string()),
        );
        handle
            .insert_shapes(
                page_id,
                &[(
                    "s1".to_string(),
                    json!({ "type": "rectangle", "x": 0.0, "y": 0.0 }),
                )],
            )
            .expect("seed shape");
        let dir = self.ws_dir().join("docs");
        std::fs::create_dir_all(&dir).expect("docs dir");
        std::fs::write(dir.join(format!("{doc_id}.ydoc")), handle.encode_binary(1))
            .expect("write sidecar");
    }

    /// Capture a recovery point and return the newest point's id.
    async fn capture_point(&self, sub: &str, doc_id: &str) -> String {
        let resp = reqwest::Client::new()
            .post(format!("{}/api/docs/{}/recovery/capture", self.base, doc_id))
            .bearer_auth(self.token(sub, WorkspaceRole::Owner))
            .send()
            .await
            .expect("capture");
        assert_eq!(resp.status(), StatusCode::OK, "capture failed");
        let list: Value = reqwest::Client::new()
            .get(format!("{}/api/docs/{}/recovery", self.base, doc_id))
            .bearer_auth(self.token(sub, WorkspaceRole::Owner))
            .send()
            .await
            .expect("list points")
            .json()
            .await
            .expect("points json");
        let points = list["recoveryPoints"].as_array().expect("points array");
        points
            .last()
            .and_then(|p| p["id"].as_str())
            .expect("newest point id")
            .to_string()
    }

    async fn restore_point(&self, sub: &str, doc_id: &str, point_id: &str) -> Value {
        let resp = reqwest::Client::new()
            .post(format!(
                "{}/api/docs/{}/recovery/{}/restore",
                self.base, doc_id, point_id
            ))
            .bearer_auth(self.token(sub, WorkspaceRole::Owner))
            .send()
            .await
            .expect("restore");
        assert_eq!(resp.status(), StatusCode::OK, "restore failed");
        resp.json().await.expect("restore json")
    }

    /// The on-disk `published.json` registry, parsed. `entries` empty when the
    /// workspace has no live publications.
    fn published_registry(&self) -> Value {
        match std::fs::read_to_string(self.ws_dir().join("published.json")) {
            Ok(s) => serde_json::from_str(&s).expect("registry json"),
            Err(_) => json!({ "entries": {} }),
        }
    }
}

#[tokio::test]
async fn document_delete_ends_the_publication_and_frees_the_meter() {
    let h = Harness::start().await;
    let doc = "del-doc";
    let usage_empty = h.usage_storage_bytes("user-owner").await;
    assert!(h
        .put_doc("user-owner", WorkspaceRole::Owner, doc, Harness::people_laden_body(doc))
        .await
        .is_success());
    assert_eq!(h.publish("user-owner", WorkspaceRole::Owner, doc).await.status(), StatusCode::OK);
    assert!(h.artifact_path(doc).exists());

    assert_eq!(h.delete_doc("user-owner", WorkspaceRole::Owner, doc).await, StatusCode::OK);

    // The artifact stopped existing WITH the document — no unpublish call ever
    // ran, which is the whole point: readers of the public link fail closed.
    assert!(!h.artifact_path(doc).exists(), "artifact must die with the doc");
    assert!(!h.manifest_path(doc).exists(), "manifest must die with the doc");
    assert_eq!(
        h.published_registry()["entries"].as_object().map(|m| m.len()),
        Some(0),
        "registry entry removed"
    );
    assert_eq!(
        h.usage_storage_bytes("user-owner").await,
        usage_empty,
        "doc bytes AND artifact bytes leave the meter together"
    );
}

#[tokio::test]
async fn restore_carries_the_frozen_publication_to_the_new_id() {
    let h = Harness::start().await;
    let doc = "carry-doc";
    assert!(h
        .put_doc(
            "user-owner",
            WorkspaceRole::Owner,
            doc,
            json!({
                "id": doc,
                "name": "published-v1",
                "modifiedAt": 1000,
                "pageOrder": ["p1"],
                "activePageId": "p1",
                "pages": { "p1": { "shapes": {}, "shapeOrder": [] } },
            }),
        )
        .await
        .is_success());
    let ack: Value =
        h.publish("user-owner", WorkspaceRole::Owner, doc).await.json().await.unwrap();
    let published_bytes = ack["bytes"].as_u64().unwrap();
    let frozen = std::fs::read_to_string(h.artifact_path(doc)).unwrap();
    let frozen_manifest = std::fs::read_to_string(h.manifest_path(doc)).unwrap();

    // Diverge the source AFTER publishing — the recovery point captures this
    // v2, and the carry must NOT leak it into the public artifact.
    assert!(h
        .put_doc(
            "user-owner",
            WorkspaceRole::Owner,
            doc,
            json!({
                "id": doc,
                "name": "secret-v2",
                "modifiedAt": 2000,
                "pageOrder": ["p1"],
                "activePageId": "p1",
                "pages": { "p1": { "shapes": {}, "shapeOrder": [] } },
            }),
        )
        .await
        .is_success());
    h.seed_sidecar(doc, "p1");
    let point = h.capture_point("user-owner", doc).await;
    let usage_before = h.usage_storage_bytes("user-owner").await;
    let doc_disk = |id: &str| {
        std::fs::metadata(h.ws_dir().join("docs").join(format!("{id}.json")))
            .map(|m| m.len())
            .unwrap_or(0)
    };
    let old_doc_bytes = doc_disk(doc);

    let restored = h.restore_point("user-owner", doc, &point).await;
    let new_id = restored["newDocId"].as_str().expect("newDocId").to_string();
    assert_ne!(new_id, doc);
    assert_eq!(restored["publishCarried"], json!(true));
    assert_eq!(restored["publishBytes"].as_u64().unwrap(), published_bytes);
    // Filesystem backend: keys are null, exactly like `PublishAck`.
    assert!(restored["publishArtifactKey"].is_null());

    // The public artifact moved BYTE-FOR-BYTE: readers keep seeing what was
    // published, never the restored (post-publish) content.
    let carried = std::fs::read_to_string(h.artifact_path(&new_id)).expect("carried artifact");
    assert_eq!(carried, frozen, "artifact must be the frozen bytes, not a re-projection");
    assert_eq!(
        std::fs::read_to_string(h.manifest_path(&new_id)).expect("carried manifest"),
        frozen_manifest
    );
    assert!(!carried.contains("secret-v2"), "post-publish content must not leak");
    assert!(!h.artifact_path(doc).exists(), "old id's artifact torn down");
    assert!(!h.manifest_path(doc).exists());
    let entries = h.published_registry()["entries"].as_object().cloned().unwrap();
    assert_eq!(entries.keys().collect::<Vec<_>>(), vec![&new_id], "entry moved, not duplicated");

    // Meter: the carry MOVES the artifact bytes. The only legitimate delta
    // across a restore is the document body itself (the flattened recovery
    // point replaces the source body); the published contribution nets to
    // exactly zero.
    assert_eq!(
        h.usage_storage_bytes("user-owner").await,
        usage_before + doc_disk(&new_id) - old_doc_bytes,
        "publish contribution must be net-zero across restore"
    );

    // Status on the successor: published, and STALE — the artifact still
    // reflects pre-restore content; an explicit republish is what swaps it.
    let status = h.publish_status("user-owner", WorkspaceRole::Owner, &new_id).await;
    assert_eq!(status["published"], json!(true));
    assert_eq!(status["stale"], json!(true));
    assert_eq!(status["bytes"].as_u64().unwrap(), published_bytes);
}

#[tokio::test]
async fn restore_of_an_unpublished_doc_reports_no_carry() {
    let h = Harness::start().await;
    let doc = "plain-doc";
    assert!(h
        .put_doc("user-owner", WorkspaceRole::Owner, doc, Harness::people_laden_body(doc))
        .await
        .is_success());
    h.seed_sidecar(doc, "p1");
    let point = h.capture_point("user-owner", doc).await;
    let restored = h.restore_point("user-owner", doc, &point).await;
    let new_id = restored["newDocId"].as_str().unwrap();

    // The contract the editor keys on: `publishCarried` present and false, no
    // key fields, successor unpublished.
    assert_eq!(restored["publishCarried"], json!(false));
    assert!(restored.get("publishArtifactKey").is_none());
    assert!(restored.get("publishBytes").is_none());
    let status = h.publish_status("user-owner", WorkspaceRole::Owner, new_id).await;
    assert_eq!(status["published"], json!(false));
}

// ───────────────────────────── durability ───────────────────────────────────

#[tokio::test]
async fn published_state_and_meter_survive_a_relay_restart() {
    let h = Harness::start().await;
    let doc = "durable-doc";
    assert!(h
        .put_doc("user-owner", WorkspaceRole::Owner, doc, Harness::people_laden_body(doc))
        .await
        .is_success());
    let ack: Value = h
        .publish("user-owner", WorkspaceRole::Owner, doc)
        .await
        .json()
        .await
        .unwrap();
    let artifact_bytes = ack["bytes"].as_u64().unwrap();
    let usage_before = h.usage_storage_bytes("user-owner").await;

    let h = h.reboot(LimitsConfig::default()).await;

    let status = h.publish_status("user-owner", WorkspaceRole::Owner, doc).await;
    assert_eq!(status["published"], json!(true), "registry reloaded from disk");
    assert_eq!(status["bytes"].as_u64().unwrap(), artifact_bytes);
    assert_eq!(
        h.usage_storage_bytes("user-owner").await,
        usage_before,
        "meter contribution survives the restart"
    );
}

// ──────────────────── cold-machine teardown (JP-470) ────────────────────────
//
// The registry hydration inside `teardown_publish` is load-bearing: on a
// machine whose local volume never saw the publish (state lives only in the
// object-store mirror), a teardown that forgot to hydrate would find no entry,
// delete nothing, and leave the artifact serving forever — then persist an
// EMPTY registry over the real mirror. This drives that exact machine shape
// with an in-process fake S3 endpoint (the SigV4 client speaks plain HTTP to
// it; signatures are accepted unverified).

/// In-memory S3 stand-in. Path-style requests (`/{bucket}/{key…}`) land on the
/// wildcard route; the map key is the full `bucket/key` path.
#[derive(Clone, Default)]
struct FakeS3 {
    objects: Arc<std::sync::Mutex<std::collections::HashMap<String, Vec<u8>>>>,
}

impl FakeS3 {
    async fn serve() -> (Self, String) {
        use axum::extract::{Path as AxPath, State as AxState};
        use axum::http::StatusCode as AxStatus;

        async fn put(
            AxState(s): AxState<FakeS3>,
            AxPath(key): AxPath<String>,
            body: axum::body::Bytes,
        ) -> AxStatus {
            s.objects.lock().unwrap().insert(key, body.to_vec());
            AxStatus::OK
        }
        async fn get(
            AxState(s): AxState<FakeS3>,
            AxPath(key): AxPath<String>,
        ) -> (AxStatus, Vec<u8>) {
            match s.objects.lock().unwrap().get(&key) {
                Some(b) => (AxStatus::OK, b.clone()),
                None => (AxStatus::NOT_FOUND, Vec::new()),
            }
        }
        async fn delete(AxState(s): AxState<FakeS3>, AxPath(key): AxPath<String>) -> AxStatus {
            s.objects.lock().unwrap().remove(&key);
            AxStatus::NO_CONTENT
        }

        let fake = FakeS3::default();
        let app = axum::Router::new()
            .route("/*key", axum::routing::get(get).put(put).delete(delete))
            .with_state(fake.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind fake s3");
        let addr = listener.local_addr().expect("fake s3 addr");
        tokio::spawn(async move {
            axum::serve(listener, app).await.ok();
        });
        (fake, format!("http://{addr}"))
    }

    /// Object bytes at a bucket-relative key, `None` when absent.
    fn object(&self, key: &str) -> Option<Vec<u8>> {
        self.objects.lock().unwrap().get(&format!("{BUCKET}/{key}")).cloned()
    }

    /// Wait out an asynchronous mirror write (the JP-200 doc mirror is
    /// queued, unlike the publish PUTs which are synchronous with the ack).
    async fn wait_for(&self, key: &str) {
        for _ in 0..200 {
            if self.object(key).is_some() {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        panic!("fake S3 never received {key}");
    }
}

#[tokio::test]
async fn cold_machine_delete_tears_down_the_publication() {
    let (fake, endpoint) = FakeS3::serve().await;
    let doc = "cold-doc";

    // Machine A: create + publish. Artifact, manifest, and registry-mirror
    // PUTs are synchronous with the publish ack, so no waiting.
    let a = Harness::start_on_s3(LimitsConfig::default(), &endpoint).await;
    assert!(a
        .put_doc("user-owner", WorkspaceRole::Owner, doc, Harness::people_laden_body(doc))
        .await
        .is_success());
    let ack: Value =
        a.publish("user-owner", WorkspaceRole::Owner, doc).await.json().await.unwrap();
    let artifact_key = ack["artifactKey"].as_str().expect("s3 ack carries the key").to_string();
    let manifest_key = ack["manifestKey"].as_str().expect("manifest key").to_string();
    assert!(fake.object(&artifact_key).is_some(), "artifact uploaded");
    assert!(fake.object(&manifest_key).is_some(), "manifest uploaded");
    let registry_key = format!("docs/{WS}/published.json");
    let mirrored: Value =
        serde_json::from_slice(&fake.object(&registry_key).expect("registry mirrored")).unwrap();
    assert!(mirrored["entries"].get(doc).is_some(), "mirror carries the entry");
    // Machine B's restore-on-miss needs the doc object; that mirror is queued.
    fake.wait_for(&format!("docs/{WS}/docs/{doc}.json")).await;

    // Machine B: EMPTY volume, same object store — the recycled pod. Warm the
    // DOCUMENT (restore-on-miss) but never touch a publish endpoint, so the
    // published registry is exactly as cold as a real pod's would be when the
    // delete arrives.
    let b = Harness::start_on_s3(LimitsConfig::default(), &endpoint).await;
    assert_eq!(b.get_doc("user-owner", WorkspaceRole::Owner, doc).await, StatusCode::OK);
    assert_eq!(b.delete_doc("user-owner", WorkspaceRole::Owner, doc).await, StatusCode::OK);

    // Fail-closed proof: the public objects are gone from the store readers
    // fetch through, and the mirror was REWRITTEN minus the entry — neither
    // left stale (would serve a deleted doc) nor clobbered from an empty
    // registry (would erase every other publication's meter).
    assert!(fake.object(&artifact_key).is_none(), "cold delete must remove the artifact");
    assert!(fake.object(&manifest_key).is_none(), "cold delete must remove the manifest");
    let mirrored: Value = serde_json::from_slice(
        &fake.object(&registry_key).expect("registry mirror still present"),
    )
    .unwrap();
    assert_eq!(
        mirrored["entries"].as_object().map(|m| m.len()),
        Some(0),
        "mirror rewritten with the entry removed"
    );
}
