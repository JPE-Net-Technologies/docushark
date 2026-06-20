//! Build script: stamps the relay binary with its build identity.
//!
//! Emits two compile-time env vars (read via `env!` in `src/build_info.rs`):
//!   - `RELAY_GIT_SHA`    — the commit the binary was built from.
//!   - `RELAY_BUILD_TIME` — when it was built (RFC3339 UTC, or epoch seconds).
//!
//! Both prefer a value passed in by the build environment (`GIT_SHA` /
//! `BUILD_TIME`, set by the Docker build-arg → ENV in `Dockerfile`, fed by CI),
//! falling back to a local `git` invocation / the wall clock so plain
//! `cargo build` still produces something useful. Neither var is ever unset,
//! so `env!` (not `option_env!`) is safe at the call site.
//!
//! Deliberately std-only — no `vergen`/`chrono` build-dep, matching the relay's
//! small-dep-tree house style (hand-rolled SigV4, no `prometheus` crate, etc.).

use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

fn main() {
    // Re-run when the injected values change, or when this script is edited.
    println!("cargo:rerun-if-env-changed=GIT_SHA");
    println!("cargo:rerun-if-env-changed=BUILD_TIME");
    println!("cargo:rerun-if-changed=build.rs");

    println!("cargo:rustc-env=RELAY_GIT_SHA={}", resolve_git_sha());
    println!("cargo:rustc-env=RELAY_BUILD_TIME={}", resolve_build_time());
}

/// `GIT_SHA` env (CI / Docker build-arg) → local `git rev-parse --short HEAD`
/// → `"unknown"`.
fn resolve_git_sha() -> String {
    if let Some(sha) = non_empty_env("GIT_SHA") {
        // Normalize to a short SHA for display parity with the `sha-<short>`
        // image tag, while tolerating a value that's already short.
        return short_sha(&sha);
    }

    Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .output()
        .ok()
        .filter(|out| out.status.success())
        .and_then(|out| String::from_utf8(out.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".to_string())
}

/// `BUILD_TIME` env (CI passes RFC3339 UTC) → wall-clock epoch seconds →
/// `"unknown"`.
fn resolve_build_time() -> String {
    if let Some(t) = non_empty_env("BUILD_TIME") {
        return t;
    }

    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| format!("epoch:{}", d.as_secs()))
        .unwrap_or_else(|_| "unknown".to_string())
}

fn non_empty_env(key: &str) -> Option<String> {
    std::env::var(key).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn short_sha(sha: &str) -> String {
    let sha = sha.trim();
    if sha.len() > 12 {
        sha[..12].to_string()
    } else {
        sha.to_string()
    }
}
