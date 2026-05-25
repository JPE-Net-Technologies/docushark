//! Auth error taxonomy used by the OIDC validation path.
//!
//! Variants map deterministically to HTTP responses at the API
//! boundary: `MalformedToken` → 400, everything signature/claim related
//! → 401, workspace/region/tenancy → 403.

use thiserror::Error;

#[derive(Debug, Clone, Error)]
pub enum AuthError {
    #[error("malformed token: {0}")]
    MalformedToken(String),

    #[error("unsupported algorithm")]
    UnsupportedAlgorithm,

    #[error("missing key id (kid)")]
    MissingKid,

    #[error("unknown signing key (kid={0})")]
    UnknownKid(String),

    #[error("invalid signature")]
    InvalidSignature,

    #[error("token expired")]
    Expired,

    #[error("issued in the future beyond skew tolerance")]
    NotYetValid,

    #[error("issuer mismatch")]
    IssuerMismatch,

    #[error("audience mismatch")]
    AudienceMismatch,

    #[error("token revoked")]
    Revoked,

    #[error("workspace claim does not include the requested workspace")]
    WorkspaceMismatch,

    #[error("workspace claim region does not match relay region")]
    RegionMismatch,

    #[error("jwks unavailable (fail-open grace expired)")]
    JwksUnavailable,
}

impl AuthError {
    /// Stable label for the `relay_auth_failures_total{reason=...}`
    /// counter at `/metrics`.
    pub fn metric_reason(&self) -> &'static str {
        match self {
            AuthError::MalformedToken(_) => "malformed",
            AuthError::UnsupportedAlgorithm => "alg",
            AuthError::MissingKid => "kid_missing",
            AuthError::UnknownKid(_) => "kid_unknown",
            AuthError::InvalidSignature => "sig",
            AuthError::Expired => "expired",
            AuthError::NotYetValid => "not_yet_valid",
            AuthError::IssuerMismatch => "iss",
            AuthError::AudienceMismatch => "aud",
            AuthError::Revoked => "revoked",
            AuthError::WorkspaceMismatch => "wsp",
            AuthError::RegionMismatch => "region",
            AuthError::JwksUnavailable => "jwks_unavailable",
        }
    }
}
