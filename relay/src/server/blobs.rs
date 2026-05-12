//! Blob storage module for embedded files
//!
//! Provides content-addressed blob storage for files embedded in documents.
//! Blobs are stored with two-level directory sharding by hash prefix to avoid
//! filesystem issues with large numbers of files.
//!
//! Storage structure:
//! ```text
//! app_data_dir/team_documents/
//!   blobs/
//!     ab/
//!       cd/
//!         abcd1234...  # Full SHA-256 hash as filename
//!   blob_index.json    # Metadata index
//! ```

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::Read;
use std::path::PathBuf;
use std::sync::RwLock;

/// Metadata for a stored blob
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlobMetadata {
    /// SHA-256 hash of the blob content (content ID)
    pub hash: String,
    /// Size of the blob in bytes
    pub size: u64,
    /// MIME type of the blob
    pub mime_type: String,
    /// Upload timestamp (Unix milliseconds)
    pub created_at: u64,
    /// User ID who uploaded the blob
    pub uploaded_by: String,
}

/// Content-addressed blob storage
pub struct BlobStore {
    /// Directory for storing blobs
    blobs_dir: PathBuf,
    /// In-memory metadata index for fast lookups
    index: RwLock<HashMap<String, BlobMetadata>>,
}

impl BlobStore {
    /// Create a new blob store
    pub fn new(app_data_dir: PathBuf) -> Self {
        let blobs_dir = app_data_dir.join("team_documents").join("blobs");

        // Ensure blobs directory exists
        let _ = std::fs::create_dir_all(&blobs_dir);

        let store = Self {
            blobs_dir: blobs_dir.clone(),
            index: RwLock::new(HashMap::new()),
        };

        // Load existing index
        store.load_index();

        store
    }

    /// Get path to the metadata index file
    fn index_path(&self) -> PathBuf {
        self.blobs_dir.parent()
            .map(|p| p.join("blob_index.json"))
            .unwrap_or_else(|| self.blobs_dir.join("blob_index.json"))
    }

    /// Get the sharded path for a blob hash
    /// Uses two-level sharding: first 2 chars / next 2 chars / full hash
    fn get_blob_path(&self, hash: &str) -> PathBuf {
        if hash.len() < 4 {
            // Fallback for short hashes (shouldn't happen with SHA-256)
            return self.blobs_dir.join(hash);
        }
        let level1 = &hash[0..2];
        let level2 = &hash[2..4];
        self.blobs_dir.join(level1).join(level2).join(hash)
    }

    /// Load the metadata index from disk
    fn load_index(&self) {
        let path = self.index_path();
        if let Ok(data) = std::fs::read_to_string(&path) {
            if let Ok(index) = serde_json::from_str::<HashMap<String, BlobMetadata>>(&data) {
                if let Ok(mut current) = self.index.write() {
                    *current = index;
                    log::info!("Loaded blob index with {} entries", current.len());
                }
            }
        }
    }

    /// Save the metadata index to disk
    fn save_index(&self) -> Result<(), String> {
        let index = self.index.read().map_err(|e| e.to_string())?;
        let json = serde_json::to_string_pretty(&*index)
            .map_err(|e| format!("Serialize error: {}", e))?;
        std::fs::write(self.index_path(), json)
            .map_err(|e| format!("Write error: {}", e))?;
        Ok(())
    }

    /// Compute SHA-256 hash of data
    pub fn compute_hash(data: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(data);
        let result = hasher.finalize();
        hex::encode(result)
    }

    /// Check if a blob exists
    pub fn exists(&self, hash: &str) -> bool {
        // First check index (fast path)
        if let Ok(index) = self.index.read() {
            if index.contains_key(hash) {
                return true;
            }
        }
        // Fallback to filesystem check
        self.get_blob_path(hash).exists()
    }

    /// Get blob metadata
    pub fn get_metadata(&self, hash: &str) -> Option<BlobMetadata> {
        self.index.read().ok()?.get(hash).cloned()
    }

    /// List all blobs
    pub fn list_blobs(&self) -> Vec<BlobMetadata> {
        self.index
            .read()
            .map(|index| index.values().cloned().collect())
            .unwrap_or_default()
    }

    /// Save a blob with hash verification
    ///
    /// Returns an error if the computed hash doesn't match the expected hash.
    pub fn save_blob(
        &self,
        expected_hash: &str,
        data: &[u8],
        mime_type: &str,
        user_id: &str,
    ) -> Result<BlobMetadata, String> {
        // Verify hash
        let actual_hash = Self::compute_hash(data);
        if actual_hash != expected_hash {
            return Err(format!(
                "Hash mismatch: expected {}, got {}",
                expected_hash, actual_hash
            ));
        }

        // Check if blob already exists (deduplication)
        if self.exists(&actual_hash) {
            log::debug!("Blob {} already exists, skipping write", actual_hash);
            if let Some(metadata) = self.get_metadata(&actual_hash) {
                return Ok(metadata);
            }
        }

        // Get blob path and ensure parent directories exist
        let blob_path = self.get_blob_path(&actual_hash);
        if let Some(parent) = blob_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directories: {}", e))?;
        }

        // Write blob data
        std::fs::write(&blob_path, data)
            .map_err(|e| format!("Failed to write blob: {}", e))?;

        // Create metadata
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        let metadata = BlobMetadata {
            hash: actual_hash.clone(),
            size: data.len() as u64,
            mime_type: mime_type.to_string(),
            created_at: now,
            uploaded_by: user_id.to_string(),
        };

        // Update index
        {
            let mut index = self.index.write().map_err(|e| e.to_string())?;
            index.insert(actual_hash.clone(), metadata.clone());
        }

        // Save index
        self.save_index()?;

        log::info!(
            "Saved blob: {} ({} bytes, {})",
            actual_hash,
            data.len(),
            mime_type
        );
        Ok(metadata)
    }

    /// Load a blob by hash
    pub fn load_blob(&self, hash: &str) -> Result<Vec<u8>, String> {
        let blob_path = self.get_blob_path(hash);

        if !blob_path.exists() {
            return Err(format!("Blob not found: {}", hash));
        }

        let mut file = std::fs::File::open(&blob_path)
            .map_err(|e| format!("Failed to open blob: {}", e))?;

        let mut data = Vec::new();
        file.read_to_end(&mut data)
            .map_err(|e| format!("Failed to read blob: {}", e))?;

        Ok(data)
    }

    /// Delete a blob
    pub fn delete_blob(&self, hash: &str) -> Result<bool, String> {
        let blob_path = self.get_blob_path(hash);

        // Remove from index first
        let existed = {
            let mut index = self.index.write().map_err(|e| e.to_string())?;
            index.remove(hash).is_some()
        };

        // Remove file if it exists
        if blob_path.exists() {
            std::fs::remove_file(&blob_path)
                .map_err(|e| format!("Failed to delete blob file: {}", e))?;

            // Try to clean up empty parent directories
            if let Some(parent) = blob_path.parent() {
                let _ = std::fs::remove_dir(parent); // Ignore errors (dir might not be empty)
                if let Some(grandparent) = parent.parent() {
                    let _ = std::fs::remove_dir(grandparent);
                }
            }
        }

        // Save index
        self.save_index()?;

        if existed {
            log::info!("Deleted blob: {}", hash);
        }
        Ok(existed)
    }

    /// Get total storage used by all blobs
    pub fn get_total_size(&self) -> u64 {
        self.index
            .read()
            .map(|index| index.values().map(|m| m.size).sum())
            .unwrap_or(0)
    }

    /// Get count of stored blobs
    pub fn get_blob_count(&self) -> usize {
        self.index
            .read()
            .map(|index| index.len())
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_compute_hash() {
        let data = b"hello world";
        let hash = BlobStore::compute_hash(data);
        // SHA-256 of "hello world"
        assert_eq!(
            hash,
            "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
        );
    }

    #[test]
    fn test_blob_store_lifecycle() {
        let dir = tempdir().unwrap();
        let store = BlobStore::new(dir.path().to_path_buf());

        let data = b"test blob content";
        let hash = BlobStore::compute_hash(data);

        // Initially blob doesn't exist
        assert!(!store.exists(&hash));
        assert_eq!(store.get_blob_count(), 0);

        // Save blob
        let metadata = store
            .save_blob(&hash, data, "text/plain", "user-1")
            .unwrap();
        assert_eq!(metadata.hash, hash);
        assert_eq!(metadata.size, data.len() as u64);
        assert_eq!(metadata.mime_type, "text/plain");

        // Blob now exists
        assert!(store.exists(&hash));
        assert_eq!(store.get_blob_count(), 1);

        // Load blob
        let loaded = store.load_blob(&hash).unwrap();
        assert_eq!(loaded, data);

        // Delete blob
        let deleted = store.delete_blob(&hash).unwrap();
        assert!(deleted);
        assert!(!store.exists(&hash));
        assert_eq!(store.get_blob_count(), 0);
    }

    #[test]
    fn test_hash_mismatch() {
        let dir = tempdir().unwrap();
        let store = BlobStore::new(dir.path().to_path_buf());

        let data = b"test data";
        let wrong_hash = "0000000000000000000000000000000000000000000000000000000000000000";

        let result = store.save_blob(wrong_hash, data, "text/plain", "user-1");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Hash mismatch"));
    }

    #[test]
    fn test_deduplication() {
        let dir = tempdir().unwrap();
        let store = BlobStore::new(dir.path().to_path_buf());

        let data = b"duplicate content";
        let hash = BlobStore::compute_hash(data);

        // Save same blob twice
        store.save_blob(&hash, data, "text/plain", "user-1").unwrap();
        store.save_blob(&hash, data, "text/plain", "user-2").unwrap();

        // Should only have one blob
        assert_eq!(store.get_blob_count(), 1);
    }

    #[test]
    fn test_blob_path_sharding() {
        let dir = tempdir().unwrap();
        let store = BlobStore::new(dir.path().to_path_buf());

        let hash = "abcd1234567890abcd1234567890abcd1234567890abcd1234567890abcd1234";
        let path = store.get_blob_path(hash);

        // Should have two-level sharding
        assert!(path.to_string_lossy().contains("ab"));
        assert!(path.to_string_lossy().contains("cd"));
        assert!(path.to_string_lossy().ends_with(hash));
    }

    #[test]
    fn test_persistence() {
        let dir = tempdir().unwrap();
        let data = b"persistent content";
        let hash = BlobStore::compute_hash(data);

        // Create store and save blob
        {
            let store = BlobStore::new(dir.path().to_path_buf());
            store.save_blob(&hash, data, "application/octet-stream", "user-1").unwrap();
        }

        // Create new store instance - should load from disk
        {
            let store = BlobStore::new(dir.path().to_path_buf());
            assert!(store.exists(&hash));
            let loaded = store.load_blob(&hash).unwrap();
            assert_eq!(loaded, data);
        }
    }
}
