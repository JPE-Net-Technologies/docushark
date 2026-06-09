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

use crate::server::protocol::{DocId, WorkspaceId};

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

    /// Object key for a workspace **document** object (JP-200), mirroring the
    /// local volume layout (`workspaces/<ws>/docs/<id>.<ext>`):
    /// `{prefix}docs/{ws}/docs/{doc_id}.{ext}`. Distinct from the
    /// content-addressed `ws/<...>` blob keys, in the **same paired bucket** so a
    /// region migration that copies the bucket carries documents along. The
    /// `docs/<ws>/docs/` nesting keeps a doc named `index` from colliding with the
    /// per-workspace index object below.
    pub fn doc_object_key(&self, ws: &WorkspaceId, doc_id: &DocId, ext: &str) -> String {
        format!(
            "{}docs/{}/docs/{}.{}",
            self.config.key_prefix,
            ws.as_str(),
            doc_id.as_str(),
            ext
        )
    }

    /// Object key for a workspace's document **index** (JP-200):
    /// `{prefix}docs/{ws}/index.json`. Best-effort listing restore; doc
    /// reachability never depends on it (restore is by-id).
    pub fn workspace_index_key(&self, ws: &WorkspaceId) -> String {
        format!("{}docs/{}/index.json", self.config.key_prefix, ws.as_str())
    }

    /// Object key for a workspace's collection-definitions registry:
    /// `{prefix}docs/{ws}/collections.json`. Sits beside the doc index so a
    /// region migration carries it along. Client-authoritative content; loss
    /// only costs collection titles until the editor re-pushes.
    pub fn workspace_collections_key(&self, ws: &WorkspaceId) -> String {
        format!("{}docs/{}/collections.json", self.config.key_prefix, ws.as_str())
    }

    /// Object key for a workspace's **blob ledger** (JP-232):
    /// `{prefix}docs/{ws}/blob_ledger.json`. Durable per-workspace projection of
    /// the blob bookkeeping (ACLs + per-doc refs + size/mime) so a recycled
    /// machine — whose on-volume sidecars are gone — restores reads, GC refcounts,
    /// and quota without re-walking the doc corpus. Sits beside the doc index in
    /// the same paired bucket so a region migration carries it along.
    pub fn blob_ledger_key(&self, ws: &WorkspaceId) -> String {
        format!("{}docs/{}/blob_ledger.json", self.config.key_prefix, ws.as_str())
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

    /// Mint a presigned PUT URL for a workspace's blob. Only `content_type` is
    /// pinned into the signature. `content-length` is deliberately **not** signed:
    /// it's a forbidden header in browser `fetch` and is stripped by the Tauri
    /// http plugin, so signing it would break the signature on those transports.
    /// The finalize `HEAD` re-reads the authoritative size, so size is still
    /// enforced (and over-quota objects reclaimed) regardless.
    pub fn presign_put(&self, ws: &WorkspaceId, hash: &str, content_type: &str) -> PresignedUpload {
        let now = Utc::now();
        let key = self.object_key(ws, hash);
        let signed: Vec<(String, String)> =
            vec![("content-type".to_string(), content_type.to_string())];
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
        Ok(self.head_object_typed(ws, hash).await?.map(|(size, _ct)| size))
    }

    /// HEAD the object, returning both the authoritative `size` and the stored
    /// `Content-Type` (`None` if the object carries no content-type header).
    /// `Ok(None)` on 404. Used by JP-232 blob-bookkeeping reconstruction so a
    /// restored blob recovers its true mime, not a placeholder.
    pub async fn head_object_typed(
        &self,
        ws: &WorkspaceId,
        hash: &str,
    ) -> Result<Option<(u64, Option<String>)>, String> {
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
        let content_type = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(|v| v.to_string());
        let size = resp
            .headers()
            .get(reqwest::header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok());
        match size {
            Some(s) => Ok(Some((s, content_type))),
            None => Err(format!("R2 HEAD {} missing content-length", key)),
        }
    }

    /// DELETE the object. A 404 is treated as success (idempotent reclaim).
    pub async fn delete_object(&self, ws: &WorkspaceId, hash: &str) -> Result<(), String> {
        self.delete_object_at(&self.object_key(ws, hash)).await
    }

    /// PUT bytes at an **explicit key** (JP-200 document objects). Server-side
    /// SigV4 PUT through the relay, signing the payload + content-type.
    pub async fn put_object_at(
        &self,
        key: &str,
        data: Vec<u8>,
        content_type: &str,
    ) -> Result<(), String> {
        let payload_hash = hex::encode(Sha256::digest(&data));
        let resp = self
            .send_signed(
                "PUT",
                key,
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

    /// GET bytes at an **explicit key** (JP-200). `Ok(None)` on 404 so callers can
    /// treat a truly-absent object distinctly from a transient failure.
    pub async fn get_object_at(&self, key: &str) -> Result<Option<Vec<u8>>, String> {
        let resp = self
            .send_signed("GET", key, reqwest::Body::from(Vec::new()), EMPTY_SHA256, &[])
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

    /// DELETE the object at an **explicit key** (JP-200). 404 = success (idempotent).
    pub async fn delete_object_at(&self, key: &str) -> Result<(), String> {
        let resp = self
            .send_signed("DELETE", key, reqwest::Body::from(Vec::new()), EMPTY_SHA256, &[])
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
        self.put_object_at(&self.object_key(ws, hash), data, content_type)
            .await
    }

    /// Proxy download: GET bytes from R2 through the relay. Not wired into a
    /// handler — downloads always 302-redirect straight to a presigned GET — but
    /// kept (and integration-tested) as the symmetric counterpart to
    /// `put_object` for any future proxy-download fallback.
    #[allow(dead_code)]
    pub async fn get_object(&self, ws: &WorkspaceId, hash: &str) -> Result<Option<Vec<u8>>, String> {
        self.get_object_at(&self.object_key(ws, hash)).await
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

/// The read side of R2 document storage the **restore-on-miss** path (JP-200)
/// needs, abstracted so the restore logic is unit-testable against an in-memory
/// fake. Kept generic (no `dyn`) so it needs no `async-trait` dependency —
/// callers use `impl DocObjectStore` / `<S: DocObjectStore>`. The write side
/// (mirror worker) uses the concrete [`S3Backend`] methods directly.
pub trait DocObjectStore: Send + Sync {
    /// Fetch a document object (`json` / `ydoc`) by id. `Ok(None)` = absent (404),
    /// `Err` = transient failure.
    fn get_doc_object(
        &self,
        ws: &WorkspaceId,
        doc_id: &DocId,
        ext: &str,
    ) -> impl std::future::Future<Output = Result<Option<Vec<u8>>, String>> + Send;

    /// Fetch a workspace's document index (best-effort listing restore).
    fn get_workspace_index(
        &self,
        ws: &WorkspaceId,
    ) -> impl std::future::Future<Output = Result<Option<Vec<u8>>, String>> + Send;

    /// Fetch a workspace's collection-definitions registry (best-effort restore).
    fn get_workspace_collections(
        &self,
        ws: &WorkspaceId,
    ) -> impl std::future::Future<Output = Result<Option<Vec<u8>>, String>> + Send;
}

impl DocObjectStore for S3Backend {
    async fn get_doc_object(
        &self,
        ws: &WorkspaceId,
        doc_id: &DocId,
        ext: &str,
    ) -> Result<Option<Vec<u8>>, String> {
        self.get_object_at(&self.doc_object_key(ws, doc_id, ext)).await
    }

    async fn get_workspace_index(&self, ws: &WorkspaceId) -> Result<Option<Vec<u8>>, String> {
        self.get_object_at(&self.workspace_index_key(ws)).await
    }

    async fn get_workspace_collections(&self, ws: &WorkspaceId) -> Result<Option<Vec<u8>>, String> {
        self.get_object_at(&self.workspace_collections_key(ws)).await
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

    #[test]
    fn doc_object_key_mirrors_local_layout_and_avoids_index_collision() {
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
        let doc = DocId::from_http_path("my-doc".to_string()).unwrap();
        assert_eq!(
            backend.doc_object_key(&ws, &doc, "json"),
            format!("p/docs/{}/docs/my-doc.json", ws.as_str())
        );
        assert_eq!(
            backend.doc_object_key(&ws, &doc, "ydoc"),
            format!("p/docs/{}/docs/my-doc.ydoc", ws.as_str())
        );
        assert_eq!(
            backend.workspace_index_key(&ws),
            format!("p/docs/{}/index.json", ws.as_str())
        );
        // A doc literally named "index" must not collide with the index object:
        // it nests under `.../docs/index.json`, distinct from `.../index.json`.
        let index_doc = DocId::from_http_path("index".to_string()).unwrap();
        assert_ne!(
            backend.doc_object_key(&ws, &index_doc, "json"),
            backend.workspace_index_key(&ws)
        );
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
        let mint = backend.presign_put(&ws, &hash, "text/plain");
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

    /// End-to-end doc-object path (JP-200) against a real S3 server: explicit-key
    /// PUT → GET (via the `DocObjectStore` trait, the restore path) → DELETE →
    /// GET-absent. Skipped unless `RELAY_TEST_S3_*` is set. Proves the doc keys +
    /// server-side SigV4 PUT/GET/DELETE validate against a live implementation.
    #[tokio::test]
    async fn s3_doc_object_roundtrip_against_live_endpoint() {
        let Some(backend) = test_backend_from_env() else {
            eprintln!("skipping s3 doc-object roundtrip: RELAY_TEST_S3_ENDPOINT unset");
            return;
        };
        let ws = WorkspaceId::single_tenant();
        let doc = DocId::from_http_path("roundtrip-doc".to_string()).unwrap();
        let json = br#"{"id":"roundtrip-doc","name":"R"}"#.to_vec();
        let ydoc = b"DSKY-binary-sidecar".to_vec();

        let json_key = backend.doc_object_key(&ws, &doc, "json");
        let ydoc_key = backend.doc_object_key(&ws, &doc, "ydoc");

        backend.put_object_at(&json_key, json.clone(), "application/json").await.unwrap();
        backend.put_object_at(&ydoc_key, ydoc.clone(), "application/octet-stream").await.unwrap();

        // Read back through the trait — exactly what restore-on-miss uses.
        assert_eq!(
            DocObjectStore::get_doc_object(&backend, &ws, &doc, "json").await.unwrap().as_deref(),
            Some(json.as_slice())
        );
        assert_eq!(
            DocObjectStore::get_doc_object(&backend, &ws, &doc, "ydoc").await.unwrap().as_deref(),
            Some(ydoc.as_slice())
        );

        backend.delete_object_at(&json_key).await.unwrap();
        backend.delete_object_at(&ydoc_key).await.unwrap();
        assert_eq!(
            DocObjectStore::get_doc_object(&backend, &ws, &doc, "json").await.unwrap(),
            None
        );
    }

    #[test]
    fn blob_ledger_key_sits_beside_the_doc_index() {
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
        assert_eq!(
            backend.blob_ledger_key(&ws),
            format!("docs/{}/blob_ledger.json", ws.as_str())
        );
    }

    /// JP-232 R2 surface against a live S3 server: the `head_object_typed`
    /// content-type read (used by reconstruct) and the blob-ledger key
    /// put/get round-trip. Skipped unless `RELAY_TEST_S3_*` is set.
    #[tokio::test]
    async fn s3_ledger_and_typed_head_roundtrip_against_live_endpoint() {
        let Some(backend) = test_backend_from_env() else {
            eprintln!("skipping s3 ledger roundtrip: RELAY_TEST_S3_ENDPOINT unset");
            return;
        };
        let ws = WorkspaceId::single_tenant();
        let hash = "c".repeat(64);
        let body = b"typed-head blob bytes".to_vec();

        // Proxy PUT pins a content-type; the typed HEAD must read it back.
        backend.put_object(&ws, &hash, body.clone(), "image/png").await.unwrap();
        let (size, ct) = backend.head_object_typed(&ws, &hash).await.unwrap().unwrap();
        assert_eq!(size, body.len() as u64);
        assert_eq!(ct.as_deref(), Some("image/png"));
        backend.delete_object(&ws, &hash).await.unwrap();
        assert_eq!(backend.head_object_typed(&ws, &hash).await.unwrap(), None);

        // Ledger object round-trips at its dedicated key.
        let key = backend.blob_ledger_key(&ws);
        let ledger = br#"{"acls":["abc"],"docRefs":[],"blobs":[]}"#.to_vec();
        backend.put_object_at(&key, ledger.clone(), "application/json").await.unwrap();
        assert_eq!(backend.get_object_at(&key).await.unwrap().as_deref(), Some(ledger.as_slice()));
        backend.delete_object_at(&key).await.unwrap();
        assert_eq!(backend.get_object_at(&key).await.unwrap(), None);
    }

    /// JP-232 end-to-end durability through live R2: drive the *real* mechanism
    /// — build a workspace's bookkeeping, serialize its ledger, PUT it to R2,
    /// simulate volume loss (a fresh `BlobStore`), GET + `install_ledger`, and
    /// assert reads/quota survive and the GC does not reclaim a still-referenced
    /// shared blob. Skipped unless `RELAY_TEST_S3_*` is set.
    #[tokio::test]
    async fn jp232_blob_ledger_survives_volume_loss_against_live_endpoint() {
        use crate::server::blobs::{BlobStore, WorkspaceBlobLedger};
        let Some(backend) = test_backend_from_env() else {
            eprintln!("skipping JP-232 ledger durability: RELAY_TEST_S3_ENDPOINT unset");
            return;
        };
        let ws = WorkspaceId::from_configured("jp232ws").unwrap();
        let a = b"shared blob A bytes";
        let ha = BlobStore::compute_hash(a);
        let b = b"docA-only blob B bytes";
        let hb = BlobStore::compute_hash(b);

        // Live pod: bookkeeping built, ledger serialized + PUT to R2.
        let dir = tempfile::tempdir().unwrap();
        let store = BlobStore::new(dir.path().to_path_buf());
        store.save_blob(&ws, &ha, a, "image/png", "u1").unwrap();
        store.save_blob(&ws, &hb, b, "application/pdf", "u1").unwrap();
        store.sync_doc_refs(&ws, "docA", [ha.clone(), hb.clone()].into_iter().collect()).unwrap();
        store.sync_doc_refs(&ws, "docB", [ha.clone()].into_iter().collect()).unwrap();
        let expected_size = store.get_workspace_size(&ws);

        let key = backend.blob_ledger_key(&ws);
        let bytes = serde_json::to_vec(&store.ledger_for_workspace(&ws)).unwrap();
        backend.put_object_at(&key, bytes, "application/json").await.unwrap();

        // Recycled machine: fresh volume, restore the ledger from R2.
        let dir2 = tempfile::tempdir().unwrap();
        let restored = BlobStore::new(dir2.path().to_path_buf());
        let got = backend.get_object_at(&key).await.unwrap().expect("ledger present in R2");
        let ledger: WorkspaceBlobLedger = serde_json::from_slice(&got).unwrap();
        restored.install_ledger(&ws, ledger).unwrap();

        // Reads + quota survive; GC keeps the shared blob, reclaims the docA-only one.
        assert!(restored.exists(&ws, &ha));
        assert_eq!(restored.get_workspace_size(&ws), expected_size);
        assert_eq!(restored.sweep_unreferenced(), 0, "full ref graph → nothing to reclaim");
        restored.release_doc_refs(&ws, "docA").unwrap();
        assert!(restored.exists(&ws, &ha), "shared blob still referenced by docB");
        assert!(!restored.exists(&ws, &hb), "docA-only blob reclaimed");

        backend.delete_object_at(&key).await.unwrap();
    }

    #[test]
    fn presign_put_pins_content_type_only() {
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
        let mint = backend.presign_put(&ws, "deadbeefcafe", "image/png");
        // Only content-type (+ host) is signed; content-length is omitted because
        // it's a forbidden header on browser/Tauri transports.
        assert!(mint.url.contains("X-Amz-SignedHeaders=content-type%3Bhost"));
        assert!(mint.url.contains("X-Amz-Signature="));
        assert_eq!(
            mint.headers,
            vec![("content-type".to_string(), "image/png".to_string())]
        );
    }
}
