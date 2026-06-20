//! DocuShark Relay library crate.
//!
//! Carries the WebSocket sync server, HTTP API, MCP endpoint, and
//! auth/user storage. The `relay` binary in `main.rs` composes these
//! into a running server.
//!
//! Module layout mirrors `src-tauri/src/{server,mcp,auth}/` as of
//! Phase 20.3 Slice C.2 — a wholesale lift, no behavior changes.
//! Sync/API split + the Storage trait arrive in Slice D; the
//! src-tauri copies are deleted in Slice E.

pub mod api;
pub mod auth;
pub mod build_info;
pub mod config;
pub mod mcp;
pub mod server;
pub mod sync;

#[cfg(feature = "test-helpers")]
pub mod test_support;
