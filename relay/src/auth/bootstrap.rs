//! Admin-user bootstrap for `relay init`.
//!
//! A fresh relay used to ship with an empty `users.json`, leaving the
//! first operator to call `/api/auth/register` over HTTP just to log in
//! from the desktop. This module collects credentials (interactively or
//! via CLI flags) and seeds the first admin so `task d` lands on a
//! login-ready relay.
//!
//! Reuses the same building blocks as the REST register handler
//! (`hash_password`, `UserStore::add_user`) so seeded users are
//! indistinguishable from registered ones.
//!
//! Skip-if-populated: re-running `relay init` against an existing data
//! dir is intentionally a no-op for the user-seed step.

use std::io::{self, Write};
use std::path::Path;

use super::{hash_password, User, UserRole, UserStore};

/// Minimum password length kept in sync with `register_handler`.
const MIN_PASSWORD_LEN: usize = 8;

#[derive(Debug, Clone, Default)]
pub struct AdminSeedOptions {
    pub username: Option<String>,
    pub password: Option<String>,
    pub display_name: Option<String>,
    /// When true, skip the whole step (caller wants no user seeding).
    pub skip: bool,
}

#[derive(Debug)]
pub enum SeedOutcome {
    /// Wrote a new admin to `users.json`.
    Seeded { username: String },
    /// `users.json` already had at least one user; we did nothing.
    SkippedExisting { count: usize },
    /// Caller passed `--skip-admin`.
    SkippedByFlag,
}

pub fn seed_admin(users_path: &Path, opts: AdminSeedOptions) -> anyhow::Result<SeedOutcome> {
    if opts.skip {
        return Ok(SeedOutcome::SkippedByFlag);
    }

    if let Some(parent) = users_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let store = UserStore::with_persistence(users_path.to_string_lossy().into_owned());
    if store.has_users() {
        let count = store.list_users().len();
        return Ok(SeedOutcome::SkippedExisting { count });
    }

    let (username, password, display_name) = match (opts.username, opts.password) {
        (Some(u), Some(p)) => (u, p, opts.display_name),
        // Partial credentials are user error — fail fast rather than
        // half-prompt; mixing flags + prompts is a footgun.
        (Some(_), None) | (None, Some(_)) => {
            anyhow::bail!("--admin-user and --admin-password must be provided together");
        }
        (None, None) => prompt_credentials()?,
    };

    validate(&username, &password)?;

    let hash = hash_password(&password).map_err(|e| anyhow::anyhow!("hash_password: {}", e))?;
    let display_name = display_name
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| username.clone());

    let user = User {
        id: nanoid::nanoid!(),
        display_name,
        username: username.clone(),
        password_hash: hash,
        role: UserRole::Admin,
        created_at: now_ms(),
        last_login_at: None,
        org_id: Some("default".to_string()),
    };

    store
        .add_user(user)
        .map_err(|e| anyhow::anyhow!("add_user: {}", e))?;

    Ok(SeedOutcome::Seeded { username })
}

fn validate(username: &str, password: &str) -> anyhow::Result<()> {
    if username.trim().is_empty() {
        anyhow::bail!("admin username must not be empty");
    }
    if password.len() < MIN_PASSWORD_LEN {
        anyhow::bail!(
            "admin password must be at least {} characters",
            MIN_PASSWORD_LEN
        );
    }
    Ok(())
}

fn prompt_credentials() -> anyhow::Result<(String, String, Option<String>)> {
    eprintln!();
    eprintln!("First-run setup: create the initial relay admin.");
    eprintln!("Use --skip-admin to bypass, or --admin-user / --admin-password for non-interactive setup.");
    eprintln!();

    let username = prompt_line("Admin username: ")?;
    let password = rpassword::prompt_password("Admin password (min 8 chars): ")?;
    let confirm = rpassword::prompt_password("Confirm password: ")?;
    if password != confirm {
        anyhow::bail!("passwords did not match");
    }
    let display_input = prompt_line("Display name (blank = username): ")?;
    let display_name = if display_input.trim().is_empty() {
        None
    } else {
        Some(display_input)
    };
    Ok((username, password, display_name))
}

fn prompt_line(prompt: &str) -> anyhow::Result<String> {
    let mut stdout = io::stdout();
    stdout.write_all(prompt.as_bytes())?;
    stdout.flush()?;
    let mut buf = String::new();
    io::stdin().read_line(&mut buf)?;
    Ok(buf.trim_end_matches(['\r', '\n']).to_string())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn seeds_admin_with_explicit_credentials() {
        let dir = tempdir().unwrap();
        let users_path = dir.path().join("users.json");

        let outcome = seed_admin(
            &users_path,
            AdminSeedOptions {
                username: Some("admin".into()),
                password: Some("hunter22-strong".into()),
                display_name: Some("Admin".into()),
                skip: false,
            },
        )
        .unwrap();

        match outcome {
            SeedOutcome::Seeded { username } => assert_eq!(username, "admin"),
            _ => panic!("expected Seeded"),
        }

        let store = UserStore::with_persistence(users_path.to_string_lossy().into_owned());
        let u = store.get_user_by_username("admin").expect("user persisted");
        assert_eq!(u.role, UserRole::Admin);
        assert_eq!(u.display_name, "Admin");
        assert_eq!(u.org_id.as_deref(), Some("default"));
    }

    #[test]
    fn skips_when_users_already_present() {
        let dir = tempdir().unwrap();
        let users_path = dir.path().join("users.json");

        seed_admin(
            &users_path,
            AdminSeedOptions {
                username: Some("admin".into()),
                password: Some("hunter22-strong".into()),
                display_name: None,
                skip: false,
            },
        )
        .unwrap();

        let outcome = seed_admin(
            &users_path,
            AdminSeedOptions {
                username: Some("other".into()),
                password: Some("hunter22-strong".into()),
                display_name: None,
                skip: false,
            },
        )
        .unwrap();

        match outcome {
            SeedOutcome::SkippedExisting { count } => assert_eq!(count, 1),
            _ => panic!("expected SkippedExisting"),
        }
    }

    #[test]
    fn skip_flag_is_a_noop() {
        let dir = tempdir().unwrap();
        let users_path = dir.path().join("users.json");
        let outcome = seed_admin(
            &users_path,
            AdminSeedOptions {
                skip: true,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(matches!(outcome, SeedOutcome::SkippedByFlag));
        assert!(!users_path.exists());
    }

    #[test]
    fn rejects_short_password() {
        let dir = tempdir().unwrap();
        let users_path = dir.path().join("users.json");
        let err = seed_admin(
            &users_path,
            AdminSeedOptions {
                username: Some("admin".into()),
                password: Some("short".into()),
                display_name: None,
                skip: false,
            },
        )
        .unwrap_err();
        assert!(err.to_string().contains("at least 8"));
    }

    #[test]
    fn rejects_partial_flags() {
        let dir = tempdir().unwrap();
        let users_path = dir.path().join("users.json");
        let err = seed_admin(
            &users_path,
            AdminSeedOptions {
                username: Some("admin".into()),
                password: None,
                display_name: None,
                skip: false,
            },
        )
        .unwrap_err();
        assert!(err.to_string().contains("must be provided together"));
    }
}
