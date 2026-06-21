//! Build identity for the running relay binary.
//!
//! Single source of truth for "what build is this?" — surfaced at runtime via
//! the `/version` endpoint, the `relay_build_info` Prometheus metric, the MCP
//! `GET /` info response, and `relay --version` (Clap reads `CARGO_PKG_VERSION`
//! directly). `GIT_SHA` / `BUILD_TIME` are stamped by `build.rs` and are always
//! set (it falls back to `"unknown"`), so `env!` never fails to compile.

/// The crate SemVer (e.g. `1.0.0-beta.1`). Major coincides with the REST major.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Short git SHA the binary was built from, or `"unknown"`.
pub const GIT_SHA: &str = env!("RELAY_GIT_SHA");

/// Build timestamp (RFC3339 UTC from CI, or `epoch:<secs>` locally), or `"unknown"`.
pub const BUILD_TIME: &str = env!("RELAY_BUILD_TIME");
