//! OIDC resource-server auth (JP-77).
//!
//! The relay no longer mints tokens or stores passwords. Operators
//! point it at any OIDC issuer (Keycloak, dex, Authelia, ZITADEL,
//! Supabase, or DocuShark Cloud's `docushark-web`); the relay fetches
//! the issuer's JWKS, verifies inbound RS256 JWTs, and checks each
//! token's `jti` against an in-memory revocation set populated via the
//! push + polling transports documented in `relay/docs/api/`.

pub mod error;
pub mod jwks;
pub mod jwt;
pub mod revocation;

pub use error::AuthError;
pub use jwks::{JwksCache, JwksMetrics};
pub use jwt::{validate_token, OidcClaims, OidcValidationConfig, WorkspaceClaim, WorkspaceRole};
pub use revocation::{Revocation, RevocationBatch, RevocationSet};

/// Auth state bundle held on `ServerState` + `McpAppState`. Cheap to
/// clone (everything inside is `Arc`-shared).
#[derive(Clone)]
pub struct OidcAuthState {
    pub config: OidcValidationConfig,
    pub jwks: JwksCache,
    pub revocations: RevocationSet,
}

impl OidcAuthState {
    pub fn new(config: OidcValidationConfig, jwks: JwksCache, revocations: RevocationSet) -> Self {
        Self { config, jwks, revocations }
    }

    /// Convenience wrapper around [`validate_token`] using this bundle.
    pub async fn validate(&self, token: &str) -> Result<OidcClaims, AuthError> {
        validate_token(token, &self.config, &self.jwks, &self.revocations).await
    }
}
