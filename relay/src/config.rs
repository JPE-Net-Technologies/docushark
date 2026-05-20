//! Relay configuration (TOML).
//!
//! Loaded by `relay serve` from a path supplied on the CLI (defaults
//! to `./relay.toml`). `relay init` writes a fresh file at the same
//! path with a per-deploy JWT secret generated via the OS CSPRNG.
//!
//! Layout deliberately small. Postgres, S3, TLS, and per-user keys
//! are out of scope for Phase 20 (deferred to the managed tier).

use std::path::{Path, PathBuf};

use rand::RngCore;
use serde::{Deserialize, Serialize};

/// Default port for the HTTP + WebSocket listener.
pub const DEFAULT_LISTEN_PORT: u16 = 9876;

/// Default port for the MCP listener (separate from the sync port —
/// MCP is exposed only on loopback for now).
pub const DEFAULT_MCP_PORT: u16 = 9877;

/// Default storage root, relative to the working directory at startup.
pub const DEFAULT_DATA_DIR: &str = "data";

/// Default JWT TTL — long enough that interactive sessions don't have
/// to re-auth mid-flow, short enough that a stolen token expires
/// within a day.
pub const DEFAULT_JWT_TTL_HOURS: u32 = 24;

/// Network exposure for the sync listener.
///
/// `Localhost` binds only to 127.0.0.1; `Lan` binds 0.0.0.0 (the
/// historical Protected-Local "LAN access enabled" mode).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum NetworkMode {
    Localhost,
    Lan,
}

impl Default for NetworkMode {
    fn default() -> Self {
        // Default = LAN to match historical behavior. Operators who
        // want loopback-only flip this to `localhost`.
        Self::Lan
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ServerConfig {
    /// TCP port for the HTTP + WebSocket listener.
    pub port: u16,
    /// Network exposure mode.
    pub network_mode: NetworkMode,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            port: DEFAULT_LISTEN_PORT,
            network_mode: NetworkMode::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct StorageConfig {
    /// Storage backend identifier. Currently only `"filesystem"` is
    /// supported. Postgres / S3 are explicit non-goals for Phase 20.
    pub backend: String,
    /// Path to the storage root (documents, blobs, users.json).
    pub path: PathBuf,
}

impl Default for StorageConfig {
    fn default() -> Self {
        Self {
            backend: "filesystem".into(),
            path: PathBuf::from(DEFAULT_DATA_DIR),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct AuthConfig {
    /// HS256 JWT secret. Rolled per-deploy by `relay init`; never check
    /// this into a repo. 32 bytes of CSPRNG-derived entropy, hex-encoded.
    pub jwt_secret: String,
    /// Hours a freshly-issued token is valid for.
    pub token_ttl_hours: u32,
}

impl Default for AuthConfig {
    fn default() -> Self {
        Self {
            jwt_secret: String::new(),
            token_ttl_hours: DEFAULT_JWT_TTL_HOURS,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct McpConfig {
    /// Whether the MCP endpoint is exposed at all.
    pub enabled: bool,
    /// Loopback-only TCP port for the MCP HTTP listener.
    pub port: u16,
}

impl Default for McpConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            port: DEFAULT_MCP_PORT,
        }
    }
}

/// Top-level relay config. All sections optional in the TOML; missing
/// sections fall back to `Default::default()`.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
pub struct RelayConfig {
    pub server: ServerConfig,
    pub storage: StorageConfig,
    pub auth: AuthConfig,
    pub mcp: McpConfig,
}

impl RelayConfig {
    /// Load and parse the TOML at `path`. Returns `Ok(None)` if the
    /// file doesn't exist (callers warn + fall back to defaults).
    pub fn load(path: &Path) -> anyhow::Result<Option<Self>> {
        if !path.exists() {
            return Ok(None);
        }
        let raw = std::fs::read_to_string(path)
            .map_err(|e| anyhow::anyhow!("read {}: {}", path.display(), e))?;
        let config: RelayConfig = toml::from_str(&raw)
            .map_err(|e| anyhow::anyhow!("parse {}: {}", path.display(), e))?;
        Ok(Some(config))
    }

    /// Build a fresh config with a CSPRNG-derived JWT secret. Used by
    /// `relay init`.
    pub fn fresh() -> Self {
        Self {
            auth: AuthConfig {
                jwt_secret: generate_jwt_secret(),
                token_ttl_hours: DEFAULT_JWT_TTL_HOURS,
            },
            ..Default::default()
        }
    }

    /// Serialize to TOML with the documentation header preserved.
    pub fn to_toml_string(&self) -> anyhow::Result<String> {
        let body = toml::to_string_pretty(self)
            .map_err(|e| anyhow::anyhow!("serialize relay.toml: {}", e))?;
        Ok(format!(
            "# docushark-relay configuration\n\
             # Generated by `relay init`. The jwt_secret value is per-deploy entropy —\n\
             # do not commit this file to version control.\n\
             \n{body}"
        ))
    }
}

/// Generate a 32-byte hex-encoded JWT secret from the OS CSPRNG.
fn generate_jwt_secret() -> String {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    hex::encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_secret_is_64_hex_chars() {
        let s = generate_jwt_secret();
        assert_eq!(s.len(), 64);
        assert!(s.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn two_fresh_secrets_differ() {
        // Vanishingly unlikely to fail unless OsRng is broken.
        assert_ne!(generate_jwt_secret(), generate_jwt_secret());
    }

    #[test]
    fn fresh_config_round_trips_through_toml() {
        let original = RelayConfig::fresh();
        let toml = original.to_toml_string().expect("serialize");
        // Strip the comment header (toml::from_str handles it but the
        // assertion below compares structurally anyway).
        let parsed: RelayConfig = toml::from_str(&toml).expect("parse");
        assert_eq!(parsed.auth.jwt_secret, original.auth.jwt_secret);
        assert_eq!(parsed.server.port, DEFAULT_LISTEN_PORT);
        assert_eq!(parsed.mcp.port, DEFAULT_MCP_PORT);
        assert_eq!(parsed.storage.backend, "filesystem");
    }

    #[test]
    fn defaults_fill_missing_sections() {
        let parsed: RelayConfig = toml::from_str("").expect("parse empty");
        assert_eq!(parsed.server.port, DEFAULT_LISTEN_PORT);
        assert!(parsed.mcp.enabled);
    }

    #[test]
    fn deny_unknown_top_level_keys() {
        let result: Result<RelayConfig, _> =
            toml::from_str("[ghost]\nfield = 1\n");
        assert!(result.is_err(), "unknown sections should be rejected");
    }

    #[test]
    fn load_missing_file_returns_none() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("does-not-exist.toml");
        assert!(matches!(RelayConfig::load(&path), Ok(None)));
    }

    #[test]
    fn load_existing_file_returns_some() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("relay.toml");
        std::fs::write(&path, RelayConfig::fresh().to_toml_string().unwrap()).unwrap();
        let loaded = RelayConfig::load(&path).unwrap().expect("Some");
        assert_eq!(loaded.server.port, DEFAULT_LISTEN_PORT);
    }
}
