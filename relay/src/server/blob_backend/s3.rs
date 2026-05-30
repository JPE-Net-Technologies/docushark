//! S3 / Cloudflare R2 blob byte storage.
//!
//! The relay needs only a thin slice of the S3 API: **presigned PUT/GET URLs**
//! so clients transfer blob bytes directly to/from R2 (never through the
//! relay), plus server-side **HEAD** (confirm an upload landed + read its real
//! size at finalize) and **DELETE** (reclaim GC'd bytes). That's a small,
//! fully-specified SigV4 surface — implemented here over the `reqwest` client
//! the relay already ships, deliberately *not* pulling in the `aws-sdk-s3`
//! dependency tree (keeps the relay's low MSRV + a lean build; see the module
//! comment in `Cargo.toml`).
//!
//! Object keys are **per-workspace**: `{prefix}ws/{workspace}/{ab}/{cd}/{hash}`.
//! Scoping the key to the workspace makes tenant isolation a property of the
//! storage layout itself — a presigned URL can only ever address one tenant's
//! prefix — at the cost of cross-workspace byte dedup, consistent with the
//! relay's existing full-size-per-grant metering.

use chrono::{DateTime, Utc};
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

use crate::server::protocol::WorkspaceId;

type HmacSha256 = Hmac<Sha256>;

const ALGORITHM: &str = "AWS4-HMAC-SHA256";
const AWS4_REQUEST: &str = "aws4_request";
const SERVICE: &str = "s3";
const UNSIGNED_PAYLOAD: &str = "UNSIGNED-PAYLOAD";
/// SHA-256 of the empty string — the payload hash for body-less requests.
const EMPTY_SHA256: &str =
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/// Connection + credential parameters for the S3/R2 byte store.
#[derive(Debug, Clone)]
pub struct S3Config {
    /// Base endpoint, e.g. `https://<acct>.r2.cloudflarestorage.com`. No
    /// trailing slash (normalized on construction).
    pub endpoint: String,
    /// Bucket name (path-style addressing — the bucket is the first path
    /// segment, which is the robust choice against a custom R2 endpoint).
    pub bucket: String,
    /// Signing region. `"auto"` for Cloudflare R2.
    pub region: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    /// Optional key prefix (e.g. `"blobs/"`); empty for none. Always ends with
    /// `/` when non-empty (normalized on construction).
    pub key_prefix: String,
    /// Presigned PUT URL lifetime. Generous by default — a slow large upload
    /// must finish inside it; the content-length pin keeps a long TTL safe.
    pub put_ttl_secs: u64,
    /// Presigned GET URL lifetime.
    pub get_ttl_secs: u64,
}

/// A minted presigned upload: the URL the client PUTs to, the headers it must
/// echo for the signature to validate, the object key, and when the URL lapses.
#[derive(Debug, Clone)]
pub struct PresignedUpload {
    pub url: String,
    /// Headers the client must send on the PUT (these are signed).
    pub headers: Vec<(String, String)>,
    /// The object key the bytes land at (informational for the client/logs).
    pub key: String,
    /// Unix-millis expiry of the presigned URL.
    pub expires_at: u64,
}

/// S3/R2-backed blob bytes. Holds the credentials + a `reqwest` client and
/// exposes the presign / HEAD / DELETE / proxy-transfer operations the relay
/// needs. All object keys are workspace-scoped (see the module docs).
pub struct S3Backend {
    config: S3Config,
    http: reqwest::Client,
}

impl S3Backend {
    /// Build the backend, normalizing the endpoint + key prefix.
    pub fn new(mut config: S3Config) -> Self {
        config.endpoint = config.endpoint.trim_end_matches('/').to_string();
        if !config.key_prefix.is_empty() && !config.key_prefix.ends_with('/') {
            config.key_prefix.push('/');
        }
        Self {
            config,
            http: reqwest::Client::new(),
        }
    }

    /// Workspace-scoped, content-addressed object key
    /// (`{prefix}ws/{workspace}/{ab}/{cd}/{hash}`). The two-level shard mirrors
    /// the filesystem backend and keeps any one R2 listing prefix shallow.
    pub fn object_key(&self, ws: &WorkspaceId, hash: &str) -> String {
        let (a, b) = if hash.len() >= 4 {
            (&hash[0..2], &hash[2..4])
        } else {
            ("zz", "zz")
        };
        format!(
            "{}ws/{}/{}/{}/{}",
            self.config.key_prefix,
            ws.as_str(),
            a,
            b,
            hash
        )
    }

    /// Canonical request URI (path-style): `/{bucket}/{uri-encoded-key}`, with
    /// `/` preserved inside the key. This exact string is both signed and used
    /// as the request path, so they can never disagree.
    fn canonical_uri(&self, key: &str) -> String {
        format!(
            "/{}/{}",
            uri_encode(&self.config.bucket, false),
            uri_encode(key, false)
        )
    }

    fn scheme(&self) -> &str {
        if self.config.endpoint.starts_with("http://") {
            "http"
        } else {
            "https"
        }
    }

    /// Host (with port if non-default) — must match what `reqwest` sends as the
    /// `Host` header, since SigV4 signs it.
    fn host_header(&self) -> String {
        self.config
            .endpoint
            .strip_prefix("https://")
            .or_else(|| self.config.endpoint.strip_prefix("http://"))
            .unwrap_or(&self.config.endpoint)
            .to_string()
    }

    /// Mint a presigned PUT URL for a workspace's blob. `content_type` is pinned
    /// into the signature so the client can't upload a different type than was
    /// quota-checked; `content_length` is likewise pinned (the finalize HEAD
    /// re-verifies the real size regardless).
    pub fn presign_put(
        &self,
        ws: &WorkspaceId,
        hash: &str,
        content_type: &str,
        content_length: u64,
    ) -> PresignedUpload {
        let now = Utc::now();
        let key = self.object_key(ws, hash);
        let signed: Vec<(String, String)> = vec![
            ("content-type".to_string(), content_type.to_string()),
            ("content-length".to_string(), content_length.to_string()),
        ];
        let url = self.presign("PUT", &key, self.config.put_ttl_secs, &signed, now);
        let expires_at =
            now.timestamp_millis().max(0) as u64 + self.config.put_ttl_secs.saturating_mul(1000);
        PresignedUpload {
            url,
            headers: signed,
            key,
            expires_at,
        }
    }

    /// Mint a presigned GET URL for a workspace's blob (host-only signature; a
    /// GET has no body or pinned headers).
    pub fn presign_get(&self, ws: &WorkspaceId, hash: &str) -> String {
        let key = self.object_key(ws, hash);
        self.presign("GET", &key, self.config.get_ttl_secs, &[], Utc::now())
    }

    /// Core SigV4 query-string presigner. `extra_signed` are header
    /// `(name, value)` pairs the client must echo; `host` is always signed.
    fn presign(
        &self,
        method: &str,
        key: &str,
        expires_secs: u64,
        extra_signed: &[(String, String)],
        now: DateTime<Utc>,
    ) -> String {
        let canonical_uri = self.canonical_uri(key);
        presign_url_at(
            self.scheme(),
            &self.host_header(),
            &canonical_uri,
            &self.config.region,
            &self.config.access_key_id,
            &self.config.secret_access_key,
            method,
            expires_secs,
            extra_signed,
            now,
        )
    }

    /// HEAD the object: `Ok(Some(size))` if present, `Ok(None)` on 404,
    /// `Err` on any other failure. Used by finalize to read the authoritative
    /// size after a direct client upload.
    pub async fn head_object(&self, ws: &WorkspaceId, hash: &str) -> Result<Option<u64>, String> {
        let key = self.object_key(ws, hash);
        let resp = self
            .send_signed("HEAD", &key, reqwest::Body::from(Vec::new()), EMPTY_SHA256, &[])
            .await?;
        if resp.status().as_u16() == 404 {
            return Ok(None);
        }
        if !resp.status().is_success() {
            return Err(format!("R2 HEAD {} -> {}", key, resp.status()));
        }
        let size = resp
            .headers()
            .get(reqwest::header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok());
        match size {
            Some(s) => Ok(Some(s)),
            None => Err(format!("R2 HEAD {} missing content-length", key)),
        }
    }

    /// DELETE the object. A 404 is treated as success (idempotent reclaim).
    pub async fn delete_object(&self, ws: &WorkspaceId, hash: &str) -> Result<(), String> {
        let key = self.object_key(ws, hash);
        let resp = self
            .send_signed("DELETE", &key, reqwest::Body::from(Vec::new()), EMPTY_SHA256, &[])
            .await?;
        let code = resp.status().as_u16();
        if resp.status().is_success() || code == 404 {
            Ok(())
        } else {
            Err(format!("R2 DELETE {} -> {}", key, resp.status()))
        }
    }

    /// Proxy upload: PUT bytes through the relay to R2 (the fallback path for
    /// clients that can't reach R2 directly). The hot path is the presigned
    /// direct PUT; this exists so a CORS/egress issue degrades instead of fails.
    pub async fn put_object(
        &self,
        ws: &WorkspaceId,
        hash: &str,
        data: Vec<u8>,
        content_type: &str,
    ) -> Result<(), String> {
        let key = self.object_key(ws, hash);
        let payload_hash = hex::encode(Sha256::digest(&data));
        let resp = self
            .send_signed(
                "PUT",
                &key,
                reqwest::Body::from(data),
                &payload_hash,
                &[("content-type".to_string(), content_type.to_string())],
            )
            .await?;
        if resp.status().is_success() {
            Ok(())
        } else {
            Err(format!("R2 PUT {} -> {}", key, resp.status()))
        }
    }

    /// Proxy download: GET bytes from R2 through the relay. Not wired into a
    /// handler — downloads always 302-redirect straight to a presigned GET — but
    /// kept (and integration-tested) as the symmetric counterpart to
    /// `put_object` for any future proxy-download fallback.
    #[allow(dead_code)]
    pub async fn get_object(&self, ws: &WorkspaceId, hash: &str) -> Result<Option<Vec<u8>>, String> {
        let key = self.object_key(ws, hash);
        let resp = self
            .send_signed("GET", &key, reqwest::Body::from(Vec::new()), EMPTY_SHA256, &[])
            .await?;
        if resp.status().as_u16() == 404 {
            return Ok(None);
        }
        if !resp.status().is_success() {
            return Err(format!("R2 GET {} -> {}", key, resp.status()));
        }
        resp.bytes()
            .await
            .map(|b| Some(b.to_vec()))
            .map_err(|e| format!("R2 GET {} body: {}", key, e))
    }

    /// Issue a SigV4 header-authenticated request to R2. `extra_headers` are
    /// signed alongside `host`/`x-amz-date`/`x-amz-content-sha256`.
    async fn send_signed(
        &self,
        method: &str,
        key: &str,
        body: reqwest::Body,
        payload_hash: &str,
        extra_headers: &[(String, String)],
    ) -> Result<reqwest::Response, String> {
        let canonical_uri = self.canonical_uri(key);
        let url = format!("{}://{}{}", self.scheme(), self.host_header(), canonical_uri);
        let signed = sign_headers_at(
            &self.host_header(),
            &canonical_uri,
            &self.config.region,
            &self.config.access_key_id,
            &self.config.secret_access_key,
            method,
            payload_hash,
            extra_headers,
            Utc::now(),
        );

        let m = reqwest::Method::from_bytes(method.as_bytes())
            .map_err(|e| format!("bad method {}: {}", method, e))?;
        let mut req = self.http.request(m, &url).body(body);
        for (k, v) in signed {
            req = req.header(k, v);
        }
        req.send().await.map_err(|e| format!("R2 {} {}: {}", method, key, e))
    }
}

/// RFC3986 URI-encode per AWS SigV4. Unreserved chars pass through; `/` is kept
/// only when `encode_slash` is false (path segments preserve their slashes).
fn uri_encode(input: &str, encode_slash: bool) -> String {
    let mut out = String::with_capacity(input.len());
    for &b in input.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            b'/' if !encode_slash => out.push('/'),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

fn sha256_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

fn hmac(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

/// Derive the SigV4 signing key: `HMAC` chained over date → region → service →
/// `aws4_request`, seeded with `"AWS4"+secret`.
fn signing_key(secret: &str, datestamp: &str, region: &str) -> Vec<u8> {
    let k_date = hmac(format!("AWS4{}", secret).as_bytes(), datestamp.as_bytes());
    let k_region = hmac(&k_date, region.as_bytes());
    let k_service = hmac(&k_region, SERVICE.as_bytes());
    hmac(&k_service, AWS4_REQUEST.as_bytes())
}

/// Build the sorted canonical-headers block + the `;`-joined signed-headers
/// list from `(name, value)` pairs (names lowercased, values trimmed).
fn canonical_headers(pairs: &[(String, String)]) -> (String, String) {
    let mut hs: Vec<(String, String)> = pairs
        .iter()
        .map(|(k, v)| (k.to_lowercase(), v.trim().to_string()))
        .collect();
    hs.sort_by(|a, b| a.0.cmp(&b.0));
    let signed = hs.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>().join(";");
    let canonical = hs.iter().map(|(k, v)| format!("{}:{}\n", k, v)).collect::<String>();
    (canonical, signed)
}

/// SigV4 query-string presign with an injectable clock (the `_at` suffix marks
/// the testable seam; the public callers pass `Utc::now()`).
#[allow(clippy::too_many_arguments)]
fn presign_url_at(
    scheme: &str,
    host: &str,
    canonical_uri: &str,
    region: &str,
    access_key: &str,
    secret: &str,
    method: &str,
    expires_secs: u64,
    extra_signed: &[(String, String)],
    now: DateTime<Utc>,
) -> String {
    let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
    let datestamp = now.format("%Y%m%d").to_string();
    let credential_scope = format!("{}/{}/{}/{}", datestamp, region, SERVICE, AWS4_REQUEST);

    let mut header_pairs = vec![("host".to_string(), host.to_string())];
    header_pairs.extend(extra_signed.iter().cloned());
    let (canonical_header_block, signed_headers) = canonical_headers(&header_pairs);

    // Canonical query string: the X-Amz-* params, sorted by key, URI-encoded.
    let credential = format!("{}/{}", access_key, credential_scope);
    let mut query = [
        ("X-Amz-Algorithm".to_string(), ALGORITHM.to_string()),
        ("X-Amz-Credential".to_string(), credential),
        ("X-Amz-Date".to_string(), amz_date.clone()),
        ("X-Amz-Expires".to_string(), expires_secs.to_string()),
        ("X-Amz-SignedHeaders".to_string(), signed_headers.clone()),
    ];
    query.sort_by(|a, b| a.0.cmp(&b.0));
    let canonical_query = query
        .iter()
        .map(|(k, v)| format!("{}={}", uri_encode(k, true), uri_encode(v, true)))
        .collect::<Vec<_>>()
        .join("&");

    let canonical_request = format!(
        "{}\n{}\n{}\n{}\n{}\n{}",
        method, canonical_uri, canonical_query, canonical_header_block, signed_headers, UNSIGNED_PAYLOAD
    );
    let string_to_sign = format!(
        "{}\n{}\n{}\n{}",
        ALGORITHM,
        amz_date,
        credential_scope,
        sha256_hex(canonical_request.as_bytes())
    );
    let signature = hex::encode(hmac(
        &signing_key(secret, &datestamp, region),
        string_to_sign.as_bytes(),
    ));

    format!(
        "{}://{}{}?{}&X-Amz-Signature={}",
        scheme, host, canonical_uri, canonical_query, signature
    )
}

/// SigV4 header-authentication. Returns the headers to attach to the request
/// (`Authorization`, `x-amz-date`, `x-amz-content-sha256`, plus any extras).
#[allow(clippy::too_many_arguments)]
fn sign_headers_at(
    host: &str,
    canonical_uri: &str,
    region: &str,
    access_key: &str,
    secret: &str,
    method: &str,
    payload_hash: &str,
    extra_headers: &[(String, String)],
    now: DateTime<Utc>,
) -> Vec<(String, String)> {
    let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
    let datestamp = now.format("%Y%m%d").to_string();
    let credential_scope = format!("{}/{}/{}/{}", datestamp, region, SERVICE, AWS4_REQUEST);

    let mut header_pairs = vec![
        ("host".to_string(), host.to_string()),
        ("x-amz-content-sha256".to_string(), payload_hash.to_string()),
        ("x-amz-date".to_string(), amz_date.clone()),
    ];
    header_pairs.extend(extra_headers.iter().cloned());
    let (canonical_header_block, signed_headers) = canonical_headers(&header_pairs);

    let canonical_request = format!(
        "{}\n{}\n{}\n{}\n{}\n{}",
        method, canonical_uri, "", canonical_header_block, signed_headers, payload_hash
    );
    let string_to_sign = format!(
        "{}\n{}\n{}\n{}",
        ALGORITHM,
        amz_date,
        credential_scope,
        sha256_hex(canonical_request.as_bytes())
    );
    let signature = hex::encode(hmac(
        &signing_key(secret, &datestamp, region),
        string_to_sign.as_bytes(),
    ));

    let authorization = format!(
        "{} Credential={}/{}, SignedHeaders={}, Signature={}",
        ALGORITHM, access_key, credential_scope, signed_headers, signature
    );

    let mut out = vec![
        ("authorization".to_string(), authorization),
        ("x-amz-date".to_string(), amz_date),
        ("x-amz-content-sha256".to_string(), payload_hash.to_string()),
    ];
    out.extend(extra_headers.iter().cloned());
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    // AWS's documented worked example for a presigned S3 GET ("Authenticating
    // Requests: Using Query Parameters"). Pinning to this fixed vector proves
    // the whole canonicalize → derive-key → sign pipeline, deterministically
    // and offline.
    #[test]
    fn presign_get_matches_aws_documented_vector() {
        let now = Utc.with_ymd_and_hms(2013, 5, 24, 0, 0, 0).unwrap();
        let url = presign_url_at(
            "https",
            "examplebucket.s3.amazonaws.com",
            "/test.txt",
            "us-east-1",
            "AKIAIOSFODNN7EXAMPLE",
            "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
            "GET",
            86400,
            &[],
            now,
        );
        assert!(
            url.contains(
                "X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404"
            ),
            "presigned URL had wrong signature: {url}"
        );
        // Sanity-check the surrounding query shape too.
        assert!(url.contains("X-Amz-Algorithm=AWS4-HMAC-SHA256"));
        assert!(url.contains(
            "X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request"
        ));
        assert!(url.contains("X-Amz-SignedHeaders=host"));
    }

    #[test]
    fn uri_encode_preserves_unreserved_and_handles_slash() {
        assert_eq!(uri_encode("AWS4-HMAC-SHA256", true), "AWS4-HMAC-SHA256");
        assert_eq!(uri_encode("a/b", false), "a/b");
        assert_eq!(uri_encode("a/b", true), "a%2Fb");
        assert_eq!(uri_encode("a b+c", true), "a%20b%2Bc");
    }

    #[test]
    fn object_key_is_workspace_scoped_and_sharded() {
        let backend = S3Backend::new(S3Config {
            endpoint: "https://acct.r2.cloudflarestorage.com".to_string(),
            bucket: "blobs".to_string(),
            region: "auto".to_string(),
            access_key_id: "k".to_string(),
            secret_access_key: "s".to_string(),
            key_prefix: "p".to_string(),
            put_ttl_secs: 3600,
            get_ttl_secs: 3600,
        });
        let ws = WorkspaceId::single_tenant();
        let key = backend.object_key(&ws, "abcd1234ef");
        // Prefix normalized to end with '/', workspace-scoped, two-level shard.
        assert_eq!(key, format!("p/ws/{}/ab/cd/abcd1234ef", ws.as_str()));
    }

    /// Build a backend from `RELAY_TEST_S3_*` env, or `None` to skip. Lets the
    /// roundtrip below run against MinIO / real R2 in CI or locally without
    /// hard-failing a plain `cargo test`.
    fn test_backend_from_env() -> Option<S3Backend> {
        let endpoint = std::env::var("RELAY_TEST_S3_ENDPOINT").ok()?;
        Some(S3Backend::new(S3Config {
            endpoint,
            bucket: std::env::var("RELAY_TEST_S3_BUCKET").unwrap_or_else(|_| "dsk-blobs-test".into()),
            region: std::env::var("RELAY_TEST_S3_REGION").unwrap_or_else(|_| "us-east-1".into()),
            access_key_id: std::env::var("RELAY_TEST_S3_ACCESS_KEY_ID").ok()?,
            secret_access_key: std::env::var("RELAY_TEST_S3_SECRET_ACCESS_KEY").ok()?,
            key_prefix: String::new(),
            put_ttl_secs: 900,
            get_ttl_secs: 900,
        }))
    }

    /// End-to-end against a real S3 server (MinIO or R2): presigned PUT (client
    /// upload) → HEAD → presigned GET (client download) → proxy PUT/GET →
    /// DELETE. Skipped unless `RELAY_TEST_S3_*` is set. This is what proves the
    /// SigV4 signer + wire actually validate against a live S3 implementation,
    /// beyond the offline AWS vector above.
    #[tokio::test]
    async fn s3_presigned_roundtrip_against_live_endpoint() {
        let Some(backend) = test_backend_from_env() else {
            eprintln!("skipping s3 roundtrip: RELAY_TEST_S3_ENDPOINT unset");
            return;
        };
        let ws = WorkspaceId::single_tenant();
        let hash = "a".repeat(64);
        let body = b"hello R2 presigned world".to_vec();
        let http = reqwest::Client::new();

        // 1. Mint a presigned PUT and upload directly, echoing the signed headers.
        let mint = backend.presign_put(&ws, &hash, "text/plain", body.len() as u64);
        let mut put = http.put(&mint.url).body(body.clone());
        for (k, v) in &mint.headers {
            put = put.header(k, v);
        }
        let status = put.send().await.unwrap().status();
        assert!(status.is_success(), "presigned PUT failed: {status}");

        // 2. HEAD returns the authoritative size (what finalize reads).
        assert_eq!(
            backend.head_object(&ws, &hash).await.unwrap(),
            Some(body.len() as u64)
        );

        // 3. Mint a presigned GET and download directly — bytes round-trip.
        let get_url = backend.presign_get(&ws, &hash);
        let got = http.get(&get_url).send().await.unwrap();
        assert!(got.status().is_success(), "presigned GET failed");
        assert_eq!(got.bytes().await.unwrap().as_ref(), body.as_slice());

        // 4. Proxy PUT/GET fallback also works against the same key.
        backend.delete_object(&ws, &hash).await.unwrap();
        backend
            .put_object(&ws, &hash, body.clone(), "text/plain")
            .await
            .unwrap();
        assert_eq!(
            backend.get_object(&ws, &hash).await.unwrap().as_deref(),
            Some(body.as_slice())
        );

        // 5. DELETE reclaims the object; HEAD then reports absent.
        backend.delete_object(&ws, &hash).await.unwrap();
        assert_eq!(backend.head_object(&ws, &hash).await.unwrap(), None);
    }

    #[test]
    fn presign_put_pins_content_type_and_length() {
        let backend = S3Backend::new(S3Config {
            endpoint: "https://acct.r2.cloudflarestorage.com".to_string(),
            bucket: "blobs".to_string(),
            region: "auto".to_string(),
            access_key_id: "AKID".to_string(),
            secret_access_key: "secret".to_string(),
            key_prefix: String::new(),
            put_ttl_secs: 900,
            get_ttl_secs: 900,
        });
        let ws = WorkspaceId::single_tenant();
        let mint = backend.presign_put(&ws, "deadbeefcafe", "image/png", 1234);
        // content-type + content-length are signed → SignedHeaders lists both
        // (plus host), and the client gets them back to echo on the PUT.
        assert!(mint
            .url
            .contains("X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost"));
        assert!(mint.url.contains("X-Amz-Signature="));
        assert_eq!(
            mint.headers,
            vec![
                ("content-type".to_string(), "image/png".to_string()),
                ("content-length".to_string(), "1234".to_string()),
            ]
        );
    }
}
