//! Bearer-token auth for the local MCP endpoint.
//!
//! The MCP server binds to 127.0.0.1, but localhost is not a real security
//! boundary on a multi-user or compromised machine — any local process
//! (including a malicious browser tab via DNS rebinding or a CORS misconfig)
//! could reach it. So every MCP request must present a bearer token.
//!
//! The token is generated on first launch, persisted under the app data
//! directory at `mcp_token`, and surfaced in the Settings UI so the user
//! can paste it into their `claude mcp add ... --header` command.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

/// Filename for the persisted token, inside the app data directory.
const TOKEN_FILENAME: &str = "mcp_token";

/// Length (in characters) of generated tokens. nanoid's default alphabet is
/// URL-safe and gives ~190 bits of entropy at length 32.
const TOKEN_LEN: usize = 32;

/// Acceptable length range for user-supplied tokens. Lower bound keeps a
/// reasonable entropy floor; upper bound prevents anything pathological.
pub const MIN_USER_TOKEN_LEN: usize = 16;
pub const MAX_USER_TOKEN_LEN: usize = 128;

/// Holds the current MCP bearer token and the path it is persisted to.
pub struct TokenStore {
    path: PathBuf,
    token: RwLock<String>,
}

impl TokenStore {
    /// Load the token from disk, or generate and persist a new one if none exists.
    pub fn load_or_create(app_data_dir: &Path) -> Result<Self, String> {
        let path = app_data_dir.join(TOKEN_FILENAME);

        let token = match fs::read_to_string(&path) {
            Ok(s) => {
                let trimmed = s.trim().to_string();
                if trimmed.is_empty() {
                    let fresh = generate();
                    write_token(&path, &fresh)?;
                    fresh
                } else {
                    trimmed
                }
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                let fresh = generate();
                write_token(&path, &fresh)?;
                fresh
            }
            Err(e) => return Err(format!("Failed to read MCP token: {}", e)),
        };

        Ok(Self {
            path,
            token: RwLock::new(token),
        })
    }

    /// Return the current token (cloned).
    pub fn current(&self) -> String {
        self.token
            .read()
            .map(|t| t.clone())
            .unwrap_or_default()
    }

    /// Replace the token with a user-supplied value and persist it.
    /// Trims surrounding whitespace, then enforces:
    ///   - length in `[MIN_USER_TOKEN_LEN, MAX_USER_TOKEN_LEN]`
    ///   - characters in `[A-Za-z0-9_-]` (URL-safe alphabet; matches the
    ///     nanoid default we generate, but also permits other clients'
    ///     URL-safe tokens for portability).
    pub fn set(&self, candidate: &str) -> Result<String, String> {
        let trimmed = candidate.trim().to_string();
        validate(&trimmed)?;
        write_token(&self.path, &trimmed)?;
        let mut guard = self
            .token
            .write()
            .map_err(|e| format!("Token lock poisoned: {}", e))?;
        *guard = trimmed.clone();
        Ok(trimmed)
    }

    /// Replace the token with a freshly generated one and persist it.
    /// Returns the new token.
    pub fn regenerate(&self) -> Result<String, String> {
        let fresh = generate();
        write_token(&self.path, &fresh)?;
        let mut guard = self
            .token
            .write()
            .map_err(|e| format!("Token lock poisoned: {}", e))?;
        *guard = fresh.clone();
        Ok(fresh)
    }

    /// Constant-time comparison of a presented token against the stored one.
    pub fn validate(&self, presented: &str) -> bool {
        let current = self.current();
        constant_time_eq(presented.as_bytes(), current.as_bytes())
    }
}

fn generate() -> String {
    nanoid::nanoid!(TOKEN_LEN)
}

fn validate(candidate: &str) -> Result<(), String> {
    if candidate.is_empty() {
        return Err("Token cannot be empty.".into());
    }
    if candidate.len() < MIN_USER_TOKEN_LEN {
        return Err(format!(
            "Token is too short (need at least {} characters, got {}).",
            MIN_USER_TOKEN_LEN,
            candidate.len()
        ));
    }
    if candidate.len() > MAX_USER_TOKEN_LEN {
        return Err(format!(
            "Token is too long (max {} characters).",
            MAX_USER_TOKEN_LEN
        ));
    }
    if !candidate
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(
            "Token may only contain letters, digits, '-', and '_' (URL-safe alphabet).".into(),
        );
    }
    Ok(())
}

fn write_token(path: &Path, token: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create token dir: {}", e))?;
    }
    fs::write(path, token).map_err(|e| format!("Failed to write MCP token: {}", e))?;
    set_owner_only_perms(path);
    Ok(())
}

#[cfg(unix)]
fn set_owner_only_perms(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(metadata) = fs::metadata(path) {
        let mut perms = metadata.permissions();
        perms.set_mode(0o600);
        let _ = fs::set_permissions(path, perms);
    }
}

#[cfg(not(unix))]
fn set_owner_only_perms(_path: &Path) {
    // On Windows the file inherits ACLs from the app data dir, which is per-user.
}

/// Constant-time byte comparison. Returns false immediately on length
/// mismatch (length itself is not a secret), otherwise compares all bytes.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn generates_and_persists_on_first_load() {
        let dir = TempDir::new().unwrap();
        let store = TokenStore::load_or_create(dir.path()).unwrap();
        let token = store.current();
        assert_eq!(token.len(), TOKEN_LEN);

        let on_disk = fs::read_to_string(dir.path().join(TOKEN_FILENAME)).unwrap();
        assert_eq!(on_disk.trim(), token);
    }

    #[test]
    fn reloads_existing_token() {
        let dir = TempDir::new().unwrap();
        let first = TokenStore::load_or_create(dir.path()).unwrap();
        let token_a = first.current();
        drop(first);

        let second = TokenStore::load_or_create(dir.path()).unwrap();
        assert_eq!(second.current(), token_a);
    }

    #[test]
    fn regenerate_changes_token_and_invalidates_old() {
        let dir = TempDir::new().unwrap();
        let store = TokenStore::load_or_create(dir.path()).unwrap();
        let old = store.current();
        let new = store.regenerate().unwrap();
        assert_ne!(old, new);
        assert!(!store.validate(&old));
        assert!(store.validate(&new));
    }

    #[test]
    fn validate_constant_time_equal_and_unequal() {
        let dir = TempDir::new().unwrap();
        let store = TokenStore::load_or_create(dir.path()).unwrap();
        let token = store.current();
        assert!(store.validate(&token));
        assert!(!store.validate(""));
        assert!(!store.validate("short"));
        assert!(!store.validate(&format!("{}x", token)));
    }

    #[test]
    fn set_accepts_valid_user_token_and_persists() {
        let dir = TempDir::new().unwrap();
        let store = TokenStore::load_or_create(dir.path()).unwrap();
        let candidate = "  abcDEF_012-345xyz  ";
        let stored = store.set(candidate).unwrap();
        assert_eq!(stored, "abcDEF_012-345xyz");
        assert_eq!(store.current(), "abcDEF_012-345xyz");

        let on_disk = fs::read_to_string(dir.path().join(TOKEN_FILENAME)).unwrap();
        assert_eq!(on_disk.trim(), "abcDEF_012-345xyz");

        assert!(store.validate("abcDEF_012-345xyz"));
    }

    #[test]
    fn set_rejects_short_token() {
        let dir = TempDir::new().unwrap();
        let store = TokenStore::load_or_create(dir.path()).unwrap();
        let before = store.current();
        let err = store.set("tooShort").unwrap_err();
        assert!(err.contains("too short"));
        // Original token is preserved on failure.
        assert_eq!(store.current(), before);
    }

    #[test]
    fn set_rejects_long_token() {
        let dir = TempDir::new().unwrap();
        let store = TokenStore::load_or_create(dir.path()).unwrap();
        let long = "a".repeat(MAX_USER_TOKEN_LEN + 1);
        let err = store.set(&long).unwrap_err();
        assert!(err.contains("too long"));
    }

    #[test]
    fn set_rejects_bad_characters() {
        let dir = TempDir::new().unwrap();
        let store = TokenStore::load_or_create(dir.path()).unwrap();
        let err = store.set("abc def ghi jkl mno").unwrap_err();
        assert!(err.contains("URL-safe alphabet"));
        let err = store
            .set("aaaaaaaaaaaaaa$%")
            .unwrap_err();
        assert!(err.contains("URL-safe alphabet"));
    }

    #[test]
    fn set_rejects_empty_after_trim() {
        let dir = TempDir::new().unwrap();
        let store = TokenStore::load_or_create(dir.path()).unwrap();
        let err = store.set("    ").unwrap_err();
        assert!(err.contains("empty"));
    }

    #[test]
    fn empty_file_triggers_regeneration() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join(TOKEN_FILENAME), "").unwrap();
        let store = TokenStore::load_or_create(dir.path()).unwrap();
        assert_eq!(store.current().len(), TOKEN_LEN);
    }
}
