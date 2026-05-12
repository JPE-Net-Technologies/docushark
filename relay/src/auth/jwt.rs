//! JWT token generation and validation
//!
//! Uses HS256 algorithm for signing tokens.
//! Tokens include user ID, username, and role in the claims.

use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

/// Default token expiry (24 hours in seconds)
const DEFAULT_EXPIRY_SECS: u64 = 24 * 60 * 60;

/// JWT claims structure
#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    /// Subject (user ID)
    pub sub: String,
    /// Username
    pub username: String,
    /// User role
    pub role: String,
    /// Issued at (Unix timestamp)
    pub iat: u64,
    /// Expires at (Unix timestamp)
    pub exp: u64,
}

/// Token configuration
#[derive(Clone)]
pub struct TokenConfig {
    /// Secret key for signing (should be randomly generated on first run)
    pub secret: String,
    /// Token expiry in seconds
    pub expiry_secs: u64,
}

impl Default for TokenConfig {
    fn default() -> Self {
        Self {
            // In production, this should be loaded from secure storage
            // or generated on first run and persisted
            secret: "diagrammer-jwt-secret-change-in-production".to_string(),
            expiry_secs: DEFAULT_EXPIRY_SECS,
        }
    }
}

/// Create a new JWT token for a user
pub fn create_token(
    user_id: &str,
    username: &str,
    role: &str,
    config: &TokenConfig,
) -> Result<(String, u64), String> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("Time error: {}", e))?
        .as_secs();

    let exp = now + config.expiry_secs;

    let claims = Claims {
        sub: user_id.to_string(),
        username: username.to_string(),
        role: role.to_string(),
        iat: now,
        exp,
    };

    let token = encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(config.secret.as_bytes()),
    )
    .map_err(|e| format!("Token encoding error: {}", e))?;

    // Convert expiry to milliseconds for JavaScript
    let expires_at_ms = exp * 1000;

    Ok((token, expires_at_ms))
}

/// Validate a JWT token and return the claims
pub fn validate_token(token: &str, config: &TokenConfig) -> Result<Claims, String> {
    let token_data = decode::<Claims>(
        token,
        &DecodingKey::from_secret(config.secret.as_bytes()),
        &Validation::default(),
    )
    .map_err(|e| format!("Token validation error: {}", e))?;

    Ok(token_data.claims)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_create_and_validate_token() {
        let config = TokenConfig::default();

        let (token, expires_at) = create_token("user-123", "testuser", "user", &config).unwrap();

        assert!(!token.is_empty());
        assert!(expires_at > 0);

        let claims = validate_token(&token, &config).unwrap();
        assert_eq!(claims.sub, "user-123");
        assert_eq!(claims.username, "testuser");
        assert_eq!(claims.role, "user");
    }

    #[test]
    fn test_invalid_token() {
        let config = TokenConfig::default();

        let result = validate_token("invalid-token", &config);
        assert!(result.is_err());
    }

    #[test]
    fn test_wrong_secret() {
        let config1 = TokenConfig::default();
        let config2 = TokenConfig {
            secret: "different-secret".to_string(),
            ..Default::default()
        };

        let (token, _) = create_token("user-123", "testuser", "user", &config1).unwrap();

        let result = validate_token(&token, &config2);
        assert!(result.is_err());
    }
}
