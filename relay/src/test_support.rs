//! Test-only helpers (JP-77).
//!
//! Compiled only with the `test-helpers` feature, which the crate's own
//! integration tests under `tests/` enable via the
//! `[dev-dependencies]` self-reference. Production builds never see
//! this module.
//!
//! The integration suites need to drive the OIDC validator without a
//! real `docushark-web` running. [`OidcTestIssuer`] does the bare
//! minimum: it generates an RSA keypair on construction, exposes a
//! [`JwksCache`] preloaded with the matching public key, and mints
//! conformant RS256 tokens via [`OidcTestIssuer::mint`].

use std::sync::Arc;

use chrono::Utc;
use jsonwebtoken::{Algorithm, EncodingKey, Header};
use rand::rngs::OsRng;
use rsa::pkcs1::EncodeRsaPublicKey;
use rsa::pkcs8::EncodePrivateKey;
use rsa::traits::PublicKeyParts;
use rsa::RsaPrivateKey;
use sha2::{Digest, Sha256};

use crate::auth::{
    JwksCache, OidcAuthState, OidcClaims, OidcValidationConfig, Revocation, RevocationSet,
    WorkspaceClaim, WorkspaceRole,
};

const TEST_ISSUER: &str = "https://test.docushark.local";
const TEST_AUDIENCE: &str = "docushark-relay";

/// Fake OIDC issuer used by integration tests.
pub struct OidcTestIssuer {
    kid: String,
    encoding_key: EncodingKey,
    jwks_cache: JwksCache,
    revocations: RevocationSet,
}

impl OidcTestIssuer {
    /// Build the issuer + a preloaded JWKS cache. Must be called from
    /// within a Tokio runtime (every integration test in this crate is
    /// `#[tokio::test]`, so this is the typical path).
    pub async fn new() -> Self {
        let private_key = RsaPrivateKey::new(&mut OsRng, 2048).expect("rsa keygen");
        let public_key = private_key.to_public_key();
        let pem = private_key
            .to_pkcs8_pem(rsa::pkcs8::LineEnding::LF)
            .expect("pkcs8 pem");
        let encoding_key = EncodingKey::from_rsa_pem(pem.as_bytes()).expect("encoding key");

        let n = public_key.n().to_bytes_be();
        let e = public_key.e().to_bytes_be();
        let kid_input = public_key
            .to_pkcs1_der()
            .expect("pkcs1 der")
            .as_bytes()
            .to_vec();
        let mut hasher = Sha256::new();
        hasher.update(&kid_input);
        let kid_hex = hex::encode(hasher.finalize());
        let kid = kid_hex[..12].to_string();

        let decoding_key = jsonwebtoken::DecodingKey::from_rsa_components(
            &b64url(&n),
            &b64url(&e),
        )
        .expect("decoding key");
        let jwks_cache = JwksCache::new("test://unused".to_string());
        let revocations = RevocationSet::new();
        jwks_cache.insert_for_tests(&kid, decoding_key).await;

        Self { kid, encoding_key, jwks_cache, revocations }
    }

    /// Build the shared auth bundle. Callers hand this to
    /// `WebSocketServer::set_auth`.
    pub fn auth_state(&self) -> OidcAuthState {
        OidcAuthState::new(
            OidcValidationConfig {
                issuer: TEST_ISSUER.to_string(),
                audience: TEST_AUDIENCE.to_string(),
            },
            self.jwks_cache.clone(),
            self.revocations.clone(),
        )
    }

    pub fn jwks_cache(&self) -> JwksCache {
        self.jwks_cache.clone()
    }

    pub fn revocations(&self) -> RevocationSet {
        self.revocations.clone()
    }

    /// Mint a token scoped to a single workspace. `region` defaults to
    /// the relay's `"default"` region.
    pub fn mint(&self, sub: &str, workspace: &str, role: WorkspaceRole) -> String {
        self.mint_with(sub, workspace, role, "default", 3600)
    }

    pub fn mint_with(
        &self,
        sub: &str,
        workspace: &str,
        role: WorkspaceRole,
        region: &str,
        ttl_seconds: u64,
    ) -> String {
        let now = Utc::now().timestamp() as u64;
        let claims = OidcClaims {
            iss: TEST_ISSUER.to_string(),
            sub: sub.to_string(),
            aud: serde_json::Value::String(TEST_AUDIENCE.to_string()),
            iat: now,
            exp: now + ttl_seconds,
            jti: format!("tok_test_{}", nanoid::nanoid!(12)),
            wsp: vec![WorkspaceClaim {
                id: workspace.to_string(),
                role,
                region: region.to_string(),
            }],
        };
        let mut header = Header::new(Algorithm::RS256);
        header.kid = Some(self.kid.clone());
        jsonwebtoken::encode(&header, &claims, &self.encoding_key).expect("encode test token")
    }

    pub fn revoke(&self, jti: &str) {
        self.revocations.revoke_many(&[Revocation {
            jti: jti.to_string(),
            revoked_at: Utc::now(),
        }]);
    }
}

/// Shared issuer for tests that don't care about isolation — saves the
/// ~30 ms per construction. Lazily initialised inside the calling
/// runtime; safe to call concurrently.
pub async fn shared_issuer() -> Arc<OidcTestIssuer> {
    use tokio::sync::OnceCell;
    static ISSUER: OnceCell<Arc<OidcTestIssuer>> = OnceCell::const_new();
    ISSUER
        .get_or_init(|| async { Arc::new(OidcTestIssuer::new().await) })
        .await
        .clone()
}

fn b64url(bytes: &[u8]) -> String {
    use base64_url_minimal::*;
    encode(bytes)
}

/// Tiny RFC 4648 §5 base64url-no-pad helper, scoped private to this
/// module so we don't pull a full base64 crate just for the JWK
/// modulus encoding.
#[allow(non_snake_case)]
mod base64_url_minimal {
    const ALPHABET: &[u8] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

    pub fn encode(input: &[u8]) -> String {
        let mut out = String::with_capacity((input.len() * 4).div_ceil(3));
        let mut i = 0;
        while i + 3 <= input.len() {
            let n = ((input[i] as u32) << 16)
                | ((input[i + 1] as u32) << 8)
                | (input[i + 2] as u32);
            out.push(ALPHABET[((n >> 18) & 0x3f) as usize] as char);
            out.push(ALPHABET[((n >> 12) & 0x3f) as usize] as char);
            out.push(ALPHABET[((n >> 6) & 0x3f) as usize] as char);
            out.push(ALPHABET[(n & 0x3f) as usize] as char);
            i += 3;
        }
        let rem = input.len() - i;
        if rem == 1 {
            let n = (input[i] as u32) << 16;
            out.push(ALPHABET[((n >> 18) & 0x3f) as usize] as char);
            out.push(ALPHABET[((n >> 12) & 0x3f) as usize] as char);
        } else if rem == 2 {
            let n = ((input[i] as u32) << 16) | ((input[i + 1] as u32) << 8);
            out.push(ALPHABET[((n >> 18) & 0x3f) as usize] as char);
            out.push(ALPHABET[((n >> 12) & 0x3f) as usize] as char);
            out.push(ALPHABET[((n >> 6) & 0x3f) as usize] as char);
        }
        out
    }
}
