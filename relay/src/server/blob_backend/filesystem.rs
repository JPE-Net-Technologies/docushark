//! Local-filesystem blob byte storage with two-level hash-prefix sharding.
//!
//! Layout (unchanged from the original in-`BlobStore` implementation):
//! ```text
//! <blobs_dir>/ab/cd/abcd1234...   # full SHA-256 hash as the filename
//! ```
//!
//! Sharding by the first two hash-byte pairs keeps any one directory from
//! accumulating an unbounded number of entries.

use std::io::{self, Read};
use std::path::PathBuf;

/// Content-addressed blob bytes on the local filesystem. The path is derived
/// purely from the content hash, so identical bytes are stored once and shared
/// across workspaces; the owning [`BlobStore`](crate::server::blobs::BlobStore)
/// enforces per-workspace access through its ACL set.
pub struct FilesystemBackend {
    blobs_dir: PathBuf,
}

impl FilesystemBackend {
    /// Create the backend, ensuring `blobs_dir` exists.
    pub fn new(blobs_dir: PathBuf) -> Self {
        let _ = std::fs::create_dir_all(&blobs_dir);
        Self { blobs_dir }
    }

    /// Two-level sharded path `<dir>/<h[0..2]>/<h[2..4]>/<hash>`. Hashes shorter
    /// than four chars (never produced by SHA-256) fall back to a flat path so
    /// the function is total.
    fn blob_path(&self, hash: &str) -> PathBuf {
        if hash.len() < 4 {
            return self.blobs_dir.join(hash);
        }
        self.blobs_dir.join(&hash[0..2]).join(&hash[2..4]).join(hash)
    }

    /// Whether the bytes for `hash` are present on disk.
    pub fn has_bytes(&self, hash: &str) -> bool {
        self.blob_path(hash).exists()
    }

    /// Write `data` to the sharded path, creating the shard directories.
    pub fn put_bytes(&self, hash: &str, data: &[u8]) -> io::Result<()> {
        let path = self.blob_path(hash);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&path, data)
    }

    /// Read the bytes for `hash`. A missing file surfaces as
    /// [`io::ErrorKind::NotFound`] (the natural error from `File::open`).
    pub fn get_bytes(&self, hash: &str) -> io::Result<Vec<u8>> {
        let mut file = std::fs::File::open(self.blob_path(hash))?;
        let mut data = Vec::new();
        file.read_to_end(&mut data)?;
        Ok(data)
    }

    /// Remove the bytes and tidy now-empty shard directories. Returns whether
    /// the file was present; a missing file is a no-op success so reclaim is
    /// idempotent.
    pub fn delete_bytes(&self, hash: &str) -> io::Result<bool> {
        let path = self.blob_path(hash);
        if !path.exists() {
            return Ok(false);
        }
        std::fs::remove_file(&path)?;
        // Best-effort cleanup of the two shard levels; non-empty dirs are left
        // in place (the errors are intentionally ignored).
        if let Some(parent) = path.parent() {
            let _ = std::fs::remove_dir(parent);
            if let Some(grandparent) = parent.parent() {
                let _ = std::fs::remove_dir(grandparent);
            }
        }
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn sharded_path_uses_two_levels() {
        let dir = tempdir().unwrap();
        let backend = FilesystemBackend::new(dir.path().join("blobs"));
        let hash = "abcd1234567890abcd1234567890abcd1234567890abcd1234567890abcd1234";
        let path = backend.blob_path(hash);
        assert!(path.to_string_lossy().contains("ab"));
        assert!(path.to_string_lossy().contains("cd"));
        assert!(path.to_string_lossy().ends_with(hash));
    }

    #[test]
    fn put_get_delete_roundtrip() {
        let dir = tempdir().unwrap();
        let backend = FilesystemBackend::new(dir.path().join("blobs"));
        let hash = "abcd1234";

        assert!(!backend.has_bytes(hash));
        backend.put_bytes(hash, b"hello").unwrap();
        assert!(backend.has_bytes(hash));
        assert_eq!(backend.get_bytes(hash).unwrap(), b"hello");

        assert!(backend.delete_bytes(hash).unwrap());
        assert!(!backend.has_bytes(hash));
        // A second delete is a no-op success.
        assert!(!backend.delete_bytes(hash).unwrap());
    }

    #[test]
    fn missing_bytes_surface_as_not_found() {
        let dir = tempdir().unwrap();
        let backend = FilesystemBackend::new(dir.path().join("blobs"));
        let err = backend.get_bytes("deadbeef").unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::NotFound);
    }
}
