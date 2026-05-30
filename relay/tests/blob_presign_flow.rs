//! Full-relay end-to-end for the presigned-R2 blob path, against a live
//! S3 server (MinIO locally, or real R2). Skipped unless `RELAY_TEST_S3_*`
//! is set, so a plain `cargo test` is unaffected.
//!
//! Unlike the `S3Backend`-direct roundtrip (in `server::blob_backend::s3`),
//! this drives the **real HTTP handlers** through the running relay:
//! `upload-url` → direct PUT to storage → `finalize` → GET 302 → presigned
//! download → `/api/v1/usage`, then a doc reference + delete exercises the
//! GC ACL release.
//!
//! Run locally:
//! ```bash
//! docker run -d --name dsk-minio -p 9100:9000 \
//!   -e MINIO_ROOT_USER=miniotest -e MINIO_ROOT_PASSWORD=miniotest123 \
//!   minio/minio server /data
//! docker run --rm --network container:dsk-minio --entrypoint sh minio/mc -c \
//!   "mc alias set l http://localhost:9000 miniotest miniotest123 && mc mb l/dsk-blobs-test"
//! RELAY_TEST_S3_ENDPOINT=http://localhost:9100 RELAY_TEST_S3_BUCKET=dsk-blobs-test \
//!   RELAY_TEST_S3_ACCESS_KEY_ID=miniotest RELAY_TEST_S3_SECRET_ACCESS_KEY=miniotest123 \
//!   RELAY_TEST_S3_REGION=us-east-1 cargo test --test blob_presign_flow -- --nocapture
//! ```

use std::sync::Arc;

use docushark_relay::auth::WorkspaceRole;
use docushark_relay::config::{S3StorageConfig, StorageConfig};
use docushark_relay::server::blobs::BlobStore;
use docushark_relay::server::{NetworkMode, ServerConfig, WebSocketServer};
use docushark_relay::test_support::OidcTestIssuer;
use reqwest::header::{AUTHORIZATION, LOCATION};
use serde_json::json;
use tempfile::TempDir;

/// Build an s3-backed `StorageConfig` from `RELAY_TEST_S3_*`, or `None` to skip.
fn s3_storage_from_env() -> Option<StorageConfig> {
    let endpoint = std::env::var("RELAY_TEST_S3_ENDPOINT").ok()?;
    let access_key_id = std::env::var("RELAY_TEST_S3_ACCESS_KEY_ID").ok()?;
    let secret_access_key = std::env::var("RELAY_TEST_S3_SECRET_ACCESS_KEY").ok()?;
    Some(StorageConfig {
        backend: "s3".into(),
        path: std::path::PathBuf::from("data"),
        s3: Some(S3StorageConfig {
            endpoint,
            bucket: std::env::var("RELAY_TEST_S3_BUCKET").unwrap_or_else(|_| "dsk-blobs-test".into()),
            region: std::env::var("RELAY_TEST_S3_REGION").unwrap_or_else(|_| "us-east-1".into()),
            access_key_id,
            secret_access_key,
            key_prefix: String::new(),
            put_ttl_secs: 900,
            get_ttl_secs: 900,
        }),
    })
}

struct S3Harness {
    base: String,
    issuer: OidcTestIssuer,
    server: Arc<WebSocketServer>,
    _tmp: TempDir,
}

impl S3Harness {
    async fn start(storage: StorageConfig) -> Self {
        let tmp = tempfile::tempdir().expect("tempdir");
        let issuer = OidcTestIssuer::new().await;
        let server = Arc::new(WebSocketServer::new());
        server.set_app_data_dir(tmp.path().to_path_buf()).await;
        server.set_storage(storage).await;
        server.set_auth(issuer.auth_state()).await;
        server
            .set_config(ServerConfig {
                port: 0,
                network_mode: NetworkMode::Localhost,
                max_connections: 0,
            })
            .await
            .expect("set_config");
        let bound = server.start(0).await.expect("start");
        let base = bound
            .strip_prefix("ws://")
            .map(|rest| format!("http://{rest}"))
            .unwrap_or(bound);
        S3Harness { base, issuer, server, _tmp: tmp }
    }

    fn token(&self, sub: &str) -> String {
        self.issuer.mint(sub, "default", WorkspaceRole::Owner)
    }

    async fn stop(self) {
        self.server.stop().await.expect("stop");
    }
}

#[tokio::test]
async fn presigned_blob_flow_end_to_end() {
    let Some(storage) = s3_storage_from_env() else {
        eprintln!("skipping presigned_blob_flow_end_to_end: RELAY_TEST_S3_ENDPOINT unset");
        return;
    };
    let harness = S3Harness::start(storage).await;
    let client = reqwest::Client::new();
    let no_redirect = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let bearer = format!("Bearer {}", harness.token("alice"));

    // Unique content per run so reruns don't dedup against a prior object.
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let body = format!("presigned blob e2e {nanos}").into_bytes();
    let hash = BlobStore::compute_hash(&body);

    // 1. Mint a presigned upload through the relay.
    let res = client
        .post(format!("{}/api/v1/blobs/{}/upload-url", harness.base, hash))
        .header(AUTHORIZATION, &bearer)
        .json(&json!({ "size": body.len(), "mimeType": "text/plain" }))
        .send()
        .await
        .expect("upload-url");
    assert_eq!(res.status().as_u16(), 200, "upload-url should presign on s3 backend");
    let mint: serde_json::Value = res.json().await.unwrap();
    let url = mint["url"].as_str().expect("presigned url");
    let headers = mint["headers"].as_object().expect("signed headers");

    // 2. PUT the bytes straight to object storage, echoing the signed headers
    //    (no Authorization — the URL self-authenticates).
    let mut put = client.put(url).body(body.clone());
    for (k, v) in headers {
        put = put.header(k.as_str(), v.as_str().unwrap());
    }
    let put_res = put.send().await.expect("direct PUT");
    assert!(put_res.status().is_success(), "direct PUT to storage: {}", put_res.status());

    // 3. Finalize — the relay HEADs for the authoritative size + grants the ACL.
    let res = client
        .post(format!("{}/api/v1/blobs/{}/finalize", harness.base, hash))
        .header(AUTHORIZATION, &bearer)
        .json(&json!({ "mimeType": "text/plain" }))
        .send()
        .await
        .expect("finalize");
    assert_eq!(res.status().as_u16(), 200, "finalize");
    let fin: serde_json::Value = res.json().await.unwrap();
    assert_eq!(fin["size"].as_u64(), Some(body.len() as u64), "finalize records the HEAD size");

    // 4. Download: GET 302 → presigned URL → bytes round-trip (no auth on R2).
    let res = no_redirect
        .get(format!("{}/api/blobs/{}", harness.base, hash))
        .header(AUTHORIZATION, &bearer)
        .send()
        .await
        .expect("get");
    assert_eq!(res.status().as_u16(), 302, "s3 backend redirects download");
    let location = res
        .headers()
        .get(LOCATION)
        .expect("Location header")
        .to_str()
        .unwrap()
        .to_string();
    let got = client.get(&location).send().await.expect("presigned GET");
    assert!(got.status().is_success(), "presigned GET: {}", got.status());
    assert_eq!(got.bytes().await.unwrap().as_ref(), body.as_slice(), "bytes round-trip");

    // 5. Usage meters the blob at its real size.
    let res = client
        .get(format!("{}/api/v1/usage", harness.base))
        .header(AUTHORIZATION, &bearer)
        .send()
        .await
        .expect("usage");
    assert_eq!(res.status().as_u16(), 200);
    let usage: serde_json::Value = res.json().await.unwrap();
    assert_eq!(
        usage["storageBytes"].as_u64(),
        Some(body.len() as u64),
        "usage meters the finalized blob"
    );

    // 5b. Proxy upload (the old-client path): POST raw bytes through the relay →
    //     they land in R2 → the 302 download round-trips. Distinct content.
    let pbody = format!("proxy blob e2e {nanos}").into_bytes();
    let phash = BlobStore::compute_hash(&pbody);
    let res = client
        .post(format!("{}/api/blobs/{}", harness.base, phash))
        .header(AUTHORIZATION, &bearer)
        .header("content-type", "text/plain")
        .body(pbody.clone())
        .send()
        .await
        .expect("proxy upload");
    assert_eq!(res.status().as_u16(), 200, "proxy upload on s3 backend lands in R2");
    let res = no_redirect
        .get(format!("{}/api/blobs/{}", harness.base, phash))
        .header(AUTHORIZATION, &bearer)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status().as_u16(), 302, "proxy-uploaded blob downloads via the R2 redirect");
    let loc = res.headers().get(LOCATION).unwrap().to_str().unwrap().to_string();
    let got = client.get(&loc).send().await.unwrap();
    assert_eq!(
        got.bytes().await.unwrap().as_ref(),
        pbody.as_slice(),
        "proxy blob round-trips through R2"
    );

    // 6. Reference the blob from a doc → still reachable; delete the doc → the
    //    ACL is released (grace 0) and the object reclaimed → 404.
    let save = client
        .put(format!("{}/api/docs/doc-blob", harness.base))
        .header(AUTHORIZATION, &bearer)
        .json(&json!({
            "id": "doc-blob",
            "name": "Blob Doc",
            "version": 1,
            "pages": [],
            "createdAt": 1,
            "modifiedAt": 1,
            "blobReferences": [hash],
        }))
        .send()
        .await
        .expect("save doc");
    assert_eq!(save.status().as_u16(), 200, "save doc referencing the blob");

    let res = no_redirect
        .get(format!("{}/api/blobs/{}", harness.base, hash))
        .header(AUTHORIZATION, &bearer)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status().as_u16(), 302, "still reachable while a doc references it");

    let del = client
        .delete(format!("{}/api/docs/doc-blob", harness.base))
        .header(AUTHORIZATION, &bearer)
        .send()
        .await
        .expect("delete doc");
    assert_eq!(del.status().as_u16(), 200);

    let res = no_redirect
        .get(format!("{}/api/blobs/{}", harness.base, hash))
        .header(AUTHORIZATION, &bearer)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status().as_u16(), 404, "blob ACL released after the referencing doc is deleted");

    harness.stop().await;
}
