//! Authentication module for Protected Local mode
//!
//! Provides JWT token generation/validation and bcrypt password hashing
//! for user authentication in team collaboration mode.

pub mod bootstrap;
mod jwt;
mod password;
mod users;

pub use bootstrap::{seed_admin, AdminSeedOptions, SeedOutcome};
pub use jwt::{create_token, validate_token, Claims, TokenConfig};
pub use password::{hash_password, verify_password};
pub use users::{User, UserRole, UserStore};

/// Login response sent to frontend
#[derive(Clone, serde::Serialize)]
pub struct LoginResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<UserInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<SessionToken>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// User info returned to frontend (excludes password hash)
#[derive(Clone, serde::Serialize)]
pub struct UserInfo {
    pub id: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
    pub username: String,
    pub role: UserRole,
    #[serde(rename = "createdAt")]
    pub created_at: u64,
    #[serde(rename = "lastLoginAt", skip_serializing_if = "Option::is_none")]
    pub last_login_at: Option<u64>,
    #[serde(rename = "orgId", skip_serializing_if = "Option::is_none")]
    pub org_id: Option<String>,
}

/// Session token returned to frontend
#[derive(Clone, serde::Serialize)]
pub struct SessionToken {
    pub token: String,
    #[serde(rename = "expiresAt")]
    pub expires_at: u64,
}

impl From<&User> for UserInfo {
    fn from(user: &User) -> Self {
        UserInfo {
            id: user.id.clone(),
            display_name: user.display_name.clone(),
            username: user.username.clone(),
            role: user.role.clone(),
            created_at: user.created_at,
            last_login_at: user.last_login_at,
            org_id: user.org_id.clone(),
        }
    }
}
