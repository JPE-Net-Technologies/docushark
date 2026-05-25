//! RS256 JWT validation against an OIDC issuer (JP-77).
//!
//! The relay no longer mints tokens — it strictly validates inbound
//! ones against a JWKS-published key, the configured `iss`/`aud`, and
//! the in-memory revocation set. The legacy HS256 + bcrypt path was
//! removed alongside the `/api/auth/*` routes.

use std::time::{SystemTime, UNIX_EPOCH};

use jsonwebtoken::{decode, decode_header, Algorithm, Validation};
use serde::{Deserialize, Serialize};

use super::{AuthError, JwksCache, RevocationSet};

/// Skew tolerance from `relay/docs/api/token-format.md` §"Validation
/// order".
const CLOCK_SKEW_SECONDS: u64 = 60;

/// `wsp[].role` values the relay enforces on document operations.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceRole {
    Owner,
    Member,
    Viewer,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceClaim {
    pub id: String,
    pub role: WorkspaceRole,
    pub region: String,
}

/// Claim shape published in `relay/docs/api/token-format.md`. Optional
/// fields (`email`, `name`, `org_id`) are accepted but unused.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OidcClaims {
    pub iss: String,
    pub sub: String,
    /// `aud` may arrive as a single string or an array. `jsonwebtoken`
    /// normalises this for the validator; we deserialize it lazily as a
    /// JSON value and pluck the matching audience at validation time.
    pub aud: serde_json::Value,
    pub iat: u64,
    pub exp: u64,
    pub jti: String,
    #[serde(default)]
    pub wsp: Vec<WorkspaceClaim>,
}

impl OidcClaims {
    /// Single-string view of the audience claim (helper for callers
    /// that don't care about the array form).
    pub fn audience_str(&self) -> Option<&str> {
        match &self.aud {
            serde_json::Value::String(s) => Some(s.as_str()),
            serde_json::Value::Array(items) => items.iter().find_map(|v| v.as_str()),
            _ => None,
        }
    }
}

/// Config snapshot consumed by [`validate_token`]. Built from
/// `RelayConfig::auth` at startup; held on `ServerState`.
#[derive(Clone, Debug)]
pub struct OidcValidationConfig {
    pub issuer: String,
    pub audience: String,
}

/// Validate `token` end-to-end:
///   1. Parse header, enforce `alg = RS256`.
///   2. Resolve `kid` against the JWKS cache (one debounced refresh on
///      a miss).
///   3. Verify signature + standard `iss`/`aud`/`exp`/`iat` claims with
///      a 60-second skew tolerance.
///   4. Reject if `jti` is in the revocation set.
///
/// Workspace/region matching is handled by the protocol layer (see
/// `server::protocol::WorkspaceId::from_oidc_array`).
pub async fn validate_token(
    token: &str,
    config: &OidcValidationConfig,
    jwks: &JwksCache,
    revocations: &RevocationSet,
) -> Result<OidcClaims, AuthError> {
    let header = decode_header(token).map_err(|e| AuthError::MalformedToken(e.to_string()))?;
    if header.alg != Algorithm::RS256 {
        return Err(AuthError::UnsupportedAlgorithm);
    }
    let kid = header.kid.ok_or(AuthError::MissingKid)?;

    let key = match jwks.get(&kid).await? {
        Some(k) => k,
        None => {
            jwks.refresh_on_miss().await;
            match jwks.get(&kid).await? {
                Some(k) => k,
                None => return Err(AuthError::UnknownKid(kid)),
            }
        }
    };

    let mut validation = Validation::new(Algorithm::RS256);
    validation.set_issuer(&[config.issuer.as_str()]);
    validation.set_audience(&[config.audience.as_str()]);
    validation.leeway = CLOCK_SKEW_SECONDS;
    validation.validate_exp = true;
    validation.validate_nbf = false;
    validation.required_spec_claims = ["iss", "aud", "exp", "sub"]
        .iter()
        .map(|s| s.to_string())
        .collect();

    let data = decode::<OidcClaims>(token, &key, &validation).map_err(|e| {
        use jsonwebtoken::errors::ErrorKind as K;
        match e.kind() {
            K::InvalidSignature => AuthError::InvalidSignature,
            K::ExpiredSignature => AuthError::Expired,
            K::ImmatureSignature => AuthError::NotYetValid,
            K::InvalidIssuer => AuthError::IssuerMismatch,
            K::InvalidAudience => AuthError::AudienceMismatch,
            K::InvalidAlgorithm | K::InvalidAlgorithmName => AuthError::UnsupportedAlgorithm,
            _ => AuthError::MalformedToken(e.to_string()),
        }
    })?;

    // Belt-and-braces iat-skew check (jsonwebtoken doesn't validate
    // `iat` by default, but the spec says reject tokens issued absurdly
    // far in the future).
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if data.claims.iat > now + CLOCK_SKEW_SECONDS {
        return Err(AuthError::NotYetValid);
    }

    if revocations.is_revoked(&data.claims.jti) {
        return Err(AuthError::Revoked);
    }

    Ok(data.claims)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::{JwksCache, RevocationSet};
    use jsonwebtoken::{encode, EncodingKey, Header};
    use serde_json::json;

    fn cfg() -> OidcValidationConfig {
        OidcValidationConfig {
            issuer: "https://issuer.test".to_string(),
            audience: "docushark-relay".to_string(),
        }
    }

    fn empty_jwks() -> JwksCache {
        JwksCache::new("test://unused".to_string())
    }

    #[tokio::test]
    async fn rejects_hs256_before_key_lookup() {
        // An HS256 token must be rejected on the algorithm check, never
        // reaching the (empty) JWKS cache.
        let claims = json!({
            "iss": "https://issuer.test",
            "sub": "u1",
            "aud": "docushark-relay",
            "iat": 0u64,
            "exp": 9_999_999_999u64,
            "jti": "tok_x",
            "wsp": [],
        });
        let token = encode(
            &Header::new(Algorithm::HS256),
            &claims,
            &EncodingKey::from_secret(b"shared-secret"),
        )
        .unwrap();

        let err = validate_token(&token, &cfg(), &empty_jwks(), &RevocationSet::new())
            .await
            .unwrap_err();
        assert!(matches!(err, AuthError::UnsupportedAlgorithm));
    }

    #[tokio::test]
    async fn rejects_malformed_token() {
        let err = validate_token("not-a-jwt", &cfg(), &empty_jwks(), &RevocationSet::new())
            .await
            .unwrap_err();
        assert!(matches!(err, AuthError::MalformedToken(_)));
    }

    #[tokio::test]
    async fn rejects_unknown_kid_when_cache_empty() {
        // Hand-craft an RS256-headed token with a bogus signature. The
        // empty cache has no `last_success`, so the kid lookup returns
        // JwksUnavailable before signature verification is ever reached.
        fn b64(bytes: &[u8]) -> String {
            // RFC 4648 §5 base64url, no padding.
            const A: &[u8] =
                b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
            let mut out = String::new();
            for chunk in bytes.chunks(3) {
                let b = [
                    chunk[0],
                    *chunk.get(1).unwrap_or(&0),
                    *chunk.get(2).unwrap_or(&0),
                ];
                let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | (b[2] as u32);
                out.push(A[((n >> 18) & 63) as usize] as char);
                out.push(A[((n >> 12) & 63) as usize] as char);
                if chunk.len() > 1 {
                    out.push(A[((n >> 6) & 63) as usize] as char);
                }
                if chunk.len() > 2 {
                    out.push(A[(n & 63) as usize] as char);
                }
            }
            out
        }
        let header = json!({"alg": "RS256", "typ": "JWT", "kid": "unknown-kid"});
        let claims = json!({
            "iss": "https://issuer.test", "sub": "u1", "aud": "docushark-relay",
            "iat": 0u64, "exp": 9_999_999_999u64, "jti": "tok_x", "wsp": [],
        });
        let token = format!(
            "{}.{}.{}",
            b64(serde_json::to_string(&header).unwrap().as_bytes()),
            b64(serde_json::to_string(&claims).unwrap().as_bytes()),
            b64(b"not-a-real-signature"),
        );
        let err = validate_token(&token, &cfg(), &empty_jwks(), &RevocationSet::new())
            .await
            .unwrap_err();
        assert!(matches!(err, AuthError::JwksUnavailable), "got {err:?}");
    }
}
