//! Pluggable byte storage for [`BlobStore`](super::blobs::BlobStore).
//!
//! `BlobStore` owns all blob *bookkeeping* — the content index, the
//! per-`(workspace, hash)` ACL set, the per-document reference map, and the
//! orphan-GC machinery — plus the JSON sidecars that persist them. This module
//! owns only the *bytes*: where a blob's content is physically stored and how
//! it's written, read, and removed.
//!
//! Splitting the two lets the bytes move to object storage (S3 / Cloudflare R2)
//! without disturbing the bookkeeping above it. Today the only backend is the
//! local filesystem — the historical behavior, byte-for-byte unchanged — which
//! stays the zero-dependency default for self-host, local dev, and tests.

mod filesystem;
mod s3;

pub use filesystem::FilesystemBackend;
pub use s3::{DocObjectStore, S3Backend, S3Config};

use std::io;
use std::path::PathBuf;

/// Physical byte storage for content-addressed blobs. Selected once at startup
/// from the `[storage]` config; the index/ACL/reference bookkeeping in
/// [`BlobStore`](super::blobs::BlobStore) is backend-agnostic.
pub enum BlobBackend {
    /// Local filesystem with two-level hash-prefix sharding. Bytes are
    /// content-addressed and deduplicated globally across workspaces.
    Filesystem(FilesystemBackend),
}

impl BlobBackend {
    /// Build a filesystem backend rooted at `blobs_dir`, creating it if absent.
    pub fn filesystem(blobs_dir: PathBuf) -> Self {
        BlobBackend::Filesystem(FilesystemBackend::new(blobs_dir))
    }

    /// True if the blob's bytes are already stored. Content-addressed, so the
    /// filesystem backend dedups identical bytes across every workspace.
    pub fn has_bytes(&self, hash: &str) -> bool {
        match self {
            BlobBackend::Filesystem(fs) => fs.has_bytes(hash),
        }
    }

    /// Write the blob's bytes. The caller guarantees `data` hashes to `hash`
    /// and only calls this when [`Self::has_bytes`] returned false.
    pub fn put_bytes(&self, hash: &str, data: &[u8]) -> io::Result<()> {
        match self {
            BlobBackend::Filesystem(fs) => fs.put_bytes(hash, data),
        }
    }

    /// Read the blob's bytes. Absent bytes surface as
    /// [`io::ErrorKind::NotFound`] so callers can map them to a 404 distinctly
    /// from a genuine IO failure.
    pub fn get_bytes(&self, hash: &str) -> io::Result<Vec<u8>> {
        match self {
            BlobBackend::Filesystem(fs) => fs.get_bytes(hash),
        }
    }

    /// Remove the blob's bytes, returning whether any were present. A missing
    /// object is a no-op success — reclaim is idempotent.
    pub fn delete_bytes(&self, hash: &str) -> io::Result<bool> {
        match self {
            BlobBackend::Filesystem(fs) => fs.delete_bytes(hash),
        }
    }
}
