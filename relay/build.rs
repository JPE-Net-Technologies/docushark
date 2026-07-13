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
    // Local builds: re-stamp when the checkout moves. Emitting ANY rerun-if
    // directive (above) opts this script out of cargo's default rerun-on-any-
    // source-change, so without these the stamp freezes at whatever HEAD was on
    // the target dir's first-ever build — /version then reports a commit that
    // can be days stale. Watch the git files that change on commit / branch
    // switch; when git or .git is absent (the Docker build context — identity
    // arrives via the GIT_SHA build-arg instead) nothing extra is watched.
    for path in git_stamp_paths() {
        println!("cargo:rerun-if-changed={path}");
    }

    println!("cargo:rustc-env=RELAY_GIT_SHA={}", resolve_git_sha());
    println!("cargo:rustc-env=RELAY_BUILD_TIME={}", resolve_build_time());
}

/// The files that move when the checkout does: `.git/HEAD` (branch switch,
/// detached-HEAD commit) plus the loose ref file HEAD points at (commit on a
/// branch). Resolved via `git rev-parse --git-path`, which handles the relay
/// living in a subdirectory and `git worktree` checkouts (where `.git` is a
/// file, not a directory). A packed/absent loose ref is skipped rather than
/// named: cargo treats a missing rerun-if-changed path as always-dirty, which
/// would re-stamp BUILD_TIME — and so recompile the crate — on every build.
fn git_stamp_paths() -> Vec<String> {
    let mut out = Vec::new();
    if let Some(head) = git_stdout(&["rev-parse", "--git-path", "HEAD"]) {
        if std::path::Path::new(&head).exists() {
            out.push(head);
        }
    }
    if let Some(sym) = git_stdout(&["symbolic-ref", "-q", "HEAD"]) {
        if let Some(ref_file) = git_stdout(&["rev-parse", "--git-path", &sym]) {
            if std::path::Path::new(&ref_file).exists() {
                out.push(ref_file);
            }
        }
    }
    out
}

/// `GIT_SHA` env (CI / Docker build-arg) → local `git rev-parse --short HEAD`
/// → `"unknown"`.
fn resolve_git_sha() -> String {
    if let Some(sha) = non_empty_env("GIT_SHA") {
        // Normalize to a short SHA for display parity with the `sha-<short>`
        // image tag, while tolerating a value that's already short.
        return short_sha(&sha);
    }

    git_stdout(&["rev-parse", "--short", "HEAD"]).unwrap_or_else(|| "unknown".to_string())
}

/// Trimmed stdout of a `git` invocation, `None` on any failure or empty output.
fn git_stdout(args: &[&str]) -> Option<String> {
    Command::new("git")
        .args(args)
        .output()
        .ok()
        .filter(|out| out.status.success())
        .and_then(|out| String::from_utf8(out.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
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
