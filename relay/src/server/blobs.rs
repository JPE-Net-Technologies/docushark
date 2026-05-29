//! Blob storage module for embedded files
//!
//! Provides content-addressed blob storage for files embedded in documents.
//! Blobs are stored with two-level directory sharding by hash prefix to avoid
//! filesystem issues with large numbers of files.
//!
//! Storage structure:
//! ```text
//! app_data_dir/relay_documents/
//!   blobs/
//!     ab/
//!       cd/
//!         abcd1234...  # Full SHA-256 hash as filename
//!   blob_index.json    # Metadata index
//! ```

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::PathBuf;
use std::sync::RwLock;

use super::protocol::WorkspaceId;

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

/// Per-`(workspace, hash)` access control entry. The bytes stay
/// content-addressed and globally deduplicated; this sidecar grants
/// access to a workspace. A blob with no ACL entry for the requesting
/// workspace is treated as nonexistent (404, not 403 — confirming
/// existence across workspaces would itself be a leak).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlobAcl {
    pub workspace: WorkspaceId,
    pub hash: String,
    pub uploaded_by: String,
    pub uploaded_at: u64,
}

/// Failure modes of [`BlobStore::save_blob_with_quota`]. The HTTP layer
/// maps `QuotaExceeded` to **507 Insufficient Storage** (JP-81), a hash
/// mismatch to 400, and IO to 500.
#[derive(Debug)]
pub enum SaveBlobError {
    /// The uploaded bytes don't hash to the claimed `:hash`.
    HashMismatch { expected: String, actual: String },
    /// Granting this new `(ws, hash)` would push the workspace's
    /// full-size-per-grant total past its storage quota. A re-upload of
    /// an already-granted hash never produces this (dedup adds 0).
    QuotaExceeded { used: u64, quota: u64, incoming: u64 },
    /// Filesystem / index-persistence failure.
    Io(String),
}

impl std::fmt::Display for SaveBlobError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            // Keep the "Hash mismatch" wording — the REST layer and tests
            // match on it.
            SaveBlobError::HashMismatch { expected, actual } => {
                write!(f, "Hash mismatch: expected {}, got {}", expected, actual)
            }
            SaveBlobError::QuotaExceeded { used, quota, incoming } => write!(
                f,
                "storage quota exceeded: {} used + {} incoming > {} quota",
                used, incoming, quota
            ),
            SaveBlobError::Io(e) => write!(f, "{}", e),
        }
    }
}

/// Content-addressed blob storage with per-`(workspace, hash)` ACLs.
pub struct BlobStore {
    /// Directory for storing blobs
    blobs_dir: PathBuf,
    /// In-memory metadata index for fast lookups
    index: RwLock<HashMap<String, BlobMetadata>>,
    /// In-memory ACL set — `(workspace, hash)` is granted access.
    /// Persisted to `blob_acl.json` next to `blob_index.json`.
    acls: RwLock<HashSet<(WorkspaceId, String)>>,
}

impl BlobStore {
    /// Create a new blob store, backfilling ACLs for any pre-existing
    /// content-addressed blobs (every legacy blob is granted to the
    /// single-tenant default workspace — preserves self-host behavior).
    pub fn new(app_data_dir: PathBuf) -> Self {
        let blobs_dir = app_data_dir.join("relay_documents").join("blobs");

        // Ensure blobs directory exists
        let _ = std::fs::create_dir_all(&blobs_dir);

        let store = Self {
            blobs_dir: blobs_dir.clone(),
            index: RwLock::new(HashMap::new()),
            acls: RwLock::new(HashSet::new()),
        };

        // Load existing index + ACLs.
        store.load_index();
        store.load_acls_or_backfill();

        store
    }

    /// Get path to the metadata index file
    fn index_path(&self) -> PathBuf {
        self.blobs_dir.parent()
            .map(|p| p.join("blob_index.json"))
            .unwrap_or_else(|| self.blobs_dir.join("blob_index.json"))
    }

    /// Path to the per-workspace ACL sidecar.
    fn acl_path(&self) -> PathBuf {
        self.blobs_dir
            .parent()
            .map(|p| p.join("blob_acl.json"))
            .unwrap_or_else(|| self.blobs_dir.join("blob_acl.json"))
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

    /// Load ACLs from disk, or — if the sidecar doesn't yet exist —
    /// backfill one ACL entry per known blob for the single-tenant
    /// default workspace. Preserves the self-host invariant that every
    /// authenticated user can read every blob the host knows about.
    fn load_acls_or_backfill(&self) {
        let path = self.acl_path();
        if let Ok(data) = std::fs::read_to_string(&path) {
            if let Ok(rows) = serde_json::from_str::<Vec<BlobAcl>>(&data) {
                if let Ok(mut current) = self.acls.write() {
                    current.clear();
                    for row in rows {
                        current.insert((row.workspace, row.hash));
                    }
                    log::info!("Loaded blob ACL with {} entries", current.len());
                    return;
                }
            }
        }

        // No sidecar — backfill from the index.
        let default = WorkspaceId::single_tenant();
        let backfilled: Vec<BlobAcl> = {
            let index = match self.index.read() {
                Ok(g) => g,
                Err(_) => return,
            };
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            index
                .values()
                .map(|m| BlobAcl {
                    workspace: default.clone(),
                    hash: m.hash.clone(),
                    uploaded_by: m.uploaded_by.clone(),
                    uploaded_at: now,
                })
                .collect()
        };
        if !backfilled.is_empty() {
            log::info!(
                "backfilling {} blob ACL rows into single-tenant default workspace",
                backfilled.len()
            );
        }
        {
            if let Ok(mut acls) = self.acls.write() {
                for row in &backfilled {
                    acls.insert((row.workspace.clone(), row.hash.clone()));
                }
            }
        }
        // Best-effort persist; if disk is read-only we still have the
        // in-memory map and request handling continues.
        if let Err(e) = self.save_acls() {
            log::warn!("blob ACL persist failed: {}", e);
        }
    }

    fn save_acls(&self) -> Result<(), String> {
        let snapshot: Vec<BlobAcl> = {
            let acls = self.acls.read().map_err(|e| e.to_string())?;
            let index = self.index.read().map_err(|e| e.to_string())?;
            acls.iter()
                .map(|(ws, hash)| {
                    let meta = index.get(hash);
                    BlobAcl {
                        workspace: ws.clone(),
                        hash: hash.clone(),
                        uploaded_by: meta.map(|m| m.uploaded_by.clone()).unwrap_or_default(),
                        uploaded_at: meta.map(|m| m.created_at).unwrap_or(0),
                    }
                })
                .collect()
        };
        let json = serde_json::to_string_pretty(&snapshot)
            .map_err(|e| format!("Serialize error: {}", e))?;
        std::fs::write(self.acl_path(), json)
            .map_err(|e| format!("Write error: {}", e))?;
        Ok(())
    }

    /// True if `ws` is authorized to read `hash`.
    fn has_acl(&self, ws: &WorkspaceId, hash: &str) -> bool {
        self.acls
            .read()
            .map(|g| g.contains(&(ws.clone(), hash.to_string())))
            .unwrap_or(false)
    }

    /// Compute SHA-256 hash of data
    pub fn compute_hash(data: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(data);
        let result = hasher.finalize();
        hex::encode(result)
    }

    /// Check if a blob exists AND the requesting workspace is in its
    /// ACL. Returns false for cross-tenant probes — a blob the workspace
    /// can't read does not exist as far as that workspace is concerned.
    pub fn exists(&self, ws: &WorkspaceId, hash: &str) -> bool {
        if !self.has_acl(ws, hash) {
            return false;
        }
        if let Ok(index) = self.index.read() {
            if index.contains_key(hash) {
                return true;
            }
        }
        self.get_blob_path(hash).exists()
    }

    /// Get blob metadata for a workspace-scoped read. Returns `None`
    /// if the workspace has no ACL row for `hash`, even when the bytes
    /// are present on disk — same opacity contract as `load_blob`.
    pub fn get_metadata(&self, ws: &WorkspaceId, hash: &str) -> Option<BlobMetadata> {
        if !self.has_acl(ws, hash) {
            return None;
        }
        self.index.read().ok()?.get(hash).cloned()
    }

    /// List all blobs
    pub fn list_blobs(&self) -> Vec<BlobMetadata> {
        self.index
            .read()
            .map(|index| index.values().cloned().collect())
            .unwrap_or_default()
    }

    /// Save a blob with hash verification and grant access to the
    /// uploading workspace. Bytes are content-addressed and globally
    /// deduplicated; the ACL row is `(ws, hash)`-scoped so two workspaces
    /// that upload identical bytes share the storage but neither can
    /// see the other's upload metadata without independently re-granting.
    /// Save a blob without quota enforcement (the legacy contract).
    /// Equivalent to [`Self::save_blob_with_quota`] with no quota. Kept for
    /// callers/tests that don't enforce storage limits.
    pub fn save_blob(
        &self,
        ws: &WorkspaceId,
        expected_hash: &str,
        data: &[u8],
        mime_type: &str,
        user_id: &str,
    ) -> Result<BlobMetadata, String> {
        self.save_blob_with_quota(ws, expected_hash, data, mime_type, user_id, None)
            .map_err(|e| e.to_string())
    }

    /// Save a blob with hash verification, optional per-workspace storage
    /// quota enforcement, and an ACL grant to the uploading workspace.
    ///
    /// `quota_bytes = Some(q)` refuses the upload with
    /// [`SaveBlobError::QuotaExceeded`] when granting a **new** `(ws, hash)`
    /// would push the workspace's full-size-per-grant total past `q`. A
    /// re-upload of an already-granted hash adds 0 (dedup) and is never
    /// refused; existing data therefore stays readable when a workspace is
    /// over quota — only new writes are refused (JP-81). `None` = unlimited.
    ///
    /// The quota check runs before any disk write so a refused upload writes
    /// nothing. It reads `acls` then `index` (matching `get_workspace_size`'s
    /// lock order); a small over-grant under concurrent *new* uploads is
    /// accepted for simplicity, consistent with the metering tolerance.
    pub fn save_blob_with_quota(
        &self,
        ws: &WorkspaceId,
        expected_hash: &str,
        data: &[u8],
        mime_type: &str,
        user_id: &str,
        quota_bytes: Option<u64>,
    ) -> Result<BlobMetadata, SaveBlobError> {
        let actual_hash = Self::compute_hash(data);
        if actual_hash != expected_hash {
            return Err(SaveBlobError::HashMismatch {
                expected: expected_hash.to_string(),
                actual: actual_hash,
            });
        }

        if let Some(quota) = quota_bytes {
            // Only a *new* grant counts toward the workspace total; a
            // re-upload of an already-granted hash adds 0.
            if !self.has_acl(ws, &actual_hash) {
                let incoming = data.len() as u64;
                let used = self.get_workspace_size(ws);
                if used.saturating_add(incoming) > quota {
                    return Err(SaveBlobError::QuotaExceeded {
                        used,
                        quota,
                        incoming,
                    });
                }
            }
        }

        // If the bytes are already on disk, skip the rewrite — but
        // still ensure the requesting workspace has an ACL row.
        let blob_path = self.get_blob_path(&actual_hash);
        let bytes_exist = blob_path.exists();
        if !bytes_exist {
            if let Some(parent) = blob_path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| SaveBlobError::Io(format!("Failed to create directories: {}", e)))?;
            }
            std::fs::write(&blob_path, data)
                .map_err(|e| SaveBlobError::Io(format!("Failed to write blob: {}", e)))?;
        } else {
            log::debug!("Blob {} bytes already on disk, deduped", actual_hash);
        }

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

        let metadata_changed;
        {
            let mut index = self.index.write().map_err(|e| SaveBlobError::Io(e.to_string()))?;
            // Keep the original metadata if the blob was already known —
            // we only need to ensure presence, not overwrite uploader.
            metadata_changed = !index.contains_key(&actual_hash);
            index.entry(actual_hash.clone()).or_insert_with(|| metadata.clone());
        }
        let acl_changed;
        {
            let mut acls = self.acls.write().map_err(|e| SaveBlobError::Io(e.to_string()))?;
            acl_changed = acls.insert((ws.clone(), actual_hash.clone()));
        }

        if metadata_changed {
            self.save_index().map_err(SaveBlobError::Io)?;
            log::info!(
                "Saved blob: {}/{} ({} bytes, {})",
                ws.as_str(),
                actual_hash,
                data.len(),
                mime_type
            );
        }
        if acl_changed {
            self.save_acls().map_err(SaveBlobError::Io)?;
        }

        // Return the canonical (possibly pre-existing) metadata.
        let final_meta = self
            .get_metadata_unchecked(&actual_hash)
            .unwrap_or(metadata);
        Ok(final_meta)
    }

    /// Load a blob by hash, scoped to the requesting workspace. Returns
    /// `Err("Blob not found: ...")` (404 by convention) for both
    /// genuinely-missing blobs and blobs the workspace lacks an ACL for —
    /// the same error so a cross-workspace probe can't confirm existence.
    pub fn load_blob(&self, ws: &WorkspaceId, hash: &str) -> Result<Vec<u8>, String> {
        if !self.has_acl(ws, hash) {
            return Err(format!("Blob not found: {}", hash));
        }

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

    /// Internal: lookup metadata without an ACL check. Reserved for
    /// `save_blob` post-write, and for the `/metrics`-shaped admin
    /// surfaces that need the global index (no such surface today).
    fn get_metadata_unchecked(&self, hash: &str) -> Option<BlobMetadata> {
        self.index.read().ok()?.get(hash).cloned()
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

    /// Blob bytes attributed to a single workspace, summed over its ACL
    /// grants. **Attribution rule: full-size-per-grant** — a content-addressed
    /// blob shared (deduped) across N workspaces counts its full size against
    /// each. This is the observability/metering signal for the storage axis;
    /// it intentionally over-counts deduped bytes at the pod level. The
    /// *billing* attribution rule (full vs. split) is a separate decision
    /// deferred to the storage-enforcement work — do not assume this is it.
    pub fn get_workspace_size(&self, ws: &WorkspaceId) -> u64 {
        let acls = match self.acls.read() {
            Ok(g) => g,
            Err(_) => return 0,
        };
        let index = match self.index.read() {
            Ok(g) => g,
            Err(_) => return 0,
        };
        acls.iter()
            .filter(|(w, _)| w == ws)
            .filter_map(|(_, hash)| index.get(hash).map(|m| m.size))
            .sum()
    }

    /// Per-workspace blob bytes for every workspace with at least one grant,
    /// using the same full-size-per-grant rule as [`Self::get_workspace_size`].
    /// Computed in a single scrape-time pass over the ACL set; fine at launch
    /// scale. The scalable form is an incrementally-maintained per-workspace
    /// counter updated on grant/revoke — deferred until pod density warrants it.
    pub fn iter_workspace_sizes(&self) -> HashMap<WorkspaceId, u64> {
        let mut out: HashMap<WorkspaceId, u64> = HashMap::new();
        let acls = match self.acls.read() {
            Ok(g) => g,
            Err(_) => return out,
        };
        let index = match self.index.read() {
            Ok(g) => g,
            Err(_) => return out,
        };
        for (ws, hash) in acls.iter() {
            if let Some(meta) = index.get(hash) {
                *out.entry(ws.clone()).or_insert(0) += meta.size;
            }
        }
        out
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
        let ws = WorkspaceId::single_tenant();

        let data = b"test blob content";
        let hash = BlobStore::compute_hash(data);

        // Initially blob doesn't exist
        assert!(!store.exists(&ws, &hash));
        assert_eq!(store.get_blob_count(), 0);

        // Save blob
        let metadata = store
            .save_blob(&ws, &hash, data, "text/plain", "user-1")
            .unwrap();
        assert_eq!(metadata.hash, hash);
        assert_eq!(metadata.size, data.len() as u64);
        assert_eq!(metadata.mime_type, "text/plain");

        // Blob now exists
        assert!(store.exists(&ws, &hash));
        assert_eq!(store.get_blob_count(), 1);

        // Load blob
        let loaded = store.load_blob(&ws, &hash).unwrap();
        assert_eq!(loaded, data);

        // Delete blob
        let deleted = store.delete_blob(&hash).unwrap();
        assert!(deleted);
        assert!(!store.exists(&ws, &hash));
        assert_eq!(store.get_blob_count(), 0);
    }

    #[test]
    fn cross_workspace_blob_load_returns_not_found() {
        let dir = tempdir().unwrap();
        let store = BlobStore::new(dir.path().to_path_buf());
        let alpha = WorkspaceId::from_configured("alpha").unwrap();
        let beta = WorkspaceId::from_configured("beta").unwrap();

        let data = b"cross-tenant content";
        let hash = BlobStore::compute_hash(data);

        store.save_blob(&alpha, &hash, data, "text/plain", "alice").unwrap();
        assert!(store.exists(&alpha, &hash));
        assert!(!store.exists(&beta, &hash));
        // Beta gets the same opaque "not found" — not a 403 disambiguation.
        let err = store.load_blob(&beta, &hash).unwrap_err();
        assert!(err.contains("not found"), "got {err}");
        assert!(store.get_metadata(&beta, &hash).is_none());
    }

    #[test]
    fn dedup_preserves_acl_per_workspace() {
        let dir = tempdir().unwrap();
        let store = BlobStore::new(dir.path().to_path_buf());
        let alpha = WorkspaceId::from_configured("alpha").unwrap();
        let beta = WorkspaceId::from_configured("beta").unwrap();

        let data = b"shared bytes";
        let hash = BlobStore::compute_hash(data);

        store.save_blob(&alpha, &hash, data, "text/plain", "alice").unwrap();
        store.save_blob(&beta, &hash, data, "text/plain", "bob").unwrap();

        // One blob on disk (dedup), two ACL grants.
        assert_eq!(store.get_blob_count(), 1);
        assert!(store.exists(&alpha, &hash));
        assert!(store.exists(&beta, &hash));
    }

    #[test]
    fn workspace_size_full_attribution_per_grant() {
        let dir = tempdir().unwrap();
        let store = BlobStore::new(dir.path().to_path_buf());
        let alpha = WorkspaceId::from_configured("alpha").unwrap();
        let beta = WorkspaceId::from_configured("beta").unwrap();

        let shared = b"shared deduped bytes"; // 20 bytes
        let shared_hash = BlobStore::compute_hash(shared);
        let alpha_only = b"alpha exclusive payload"; // 23 bytes
        let alpha_hash = BlobStore::compute_hash(alpha_only);

        store.save_blob(&alpha, &shared_hash, shared, "text/plain", "alice").unwrap();
        store.save_blob(&beta, &shared_hash, shared, "text/plain", "bob").unwrap();
        store.save_blob(&alpha, &alpha_hash, alpha_only, "text/plain", "alice").unwrap();

        // Dedup: one copy of the shared bytes on disk, total = 20 + 23.
        assert_eq!(store.get_blob_count(), 2);
        assert_eq!(store.get_total_size(), (shared.len() + alpha_only.len()) as u64);

        // Full-size-per-grant: the shared blob counts in full against both.
        assert_eq!(store.get_workspace_size(&alpha), (shared.len() + alpha_only.len()) as u64);
        assert_eq!(store.get_workspace_size(&beta), shared.len() as u64);

        let per_ws = store.iter_workspace_sizes();
        assert_eq!(per_ws.get(&alpha).copied(), Some((shared.len() + alpha_only.len()) as u64));
        assert_eq!(per_ws.get(&beta).copied(), Some(shared.len() as u64));
    }

    #[test]
    fn test_hash_mismatch() {
        let dir = tempdir().unwrap();
        let store = BlobStore::new(dir.path().to_path_buf());
        let ws = WorkspaceId::single_tenant();

        let data = b"test data";
        let wrong_hash = "0000000000000000000000000000000000000000000000000000000000000000";

        let result = store.save_blob(&ws, wrong_hash, data, "text/plain", "user-1");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Hash mismatch"));
    }

    #[test]
    fn test_deduplication() {
        let dir = tempdir().unwrap();
        let store = BlobStore::new(dir.path().to_path_buf());
        let ws = WorkspaceId::single_tenant();

        let data = b"duplicate content";
        let hash = BlobStore::compute_hash(data);

        // Save same blob twice in the same workspace
        store.save_blob(&ws, &hash, data, "text/plain", "user-1").unwrap();
        store.save_blob(&ws, &hash, data, "text/plain", "user-2").unwrap();

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
        let ws = WorkspaceId::single_tenant();
        let data = b"persistent content";
        let hash = BlobStore::compute_hash(data);

        // Create store and save blob
        {
            let store = BlobStore::new(dir.path().to_path_buf());
            store.save_blob(&ws, &hash, data, "application/octet-stream", "user-1").unwrap();
        }

        // Create new store instance - should load from disk
        {
            let store = BlobStore::new(dir.path().to_path_buf());
            assert!(store.exists(&ws, &hash));
            let loaded = store.load_blob(&ws, &hash).unwrap();
            assert_eq!(loaded, data);
        }
    }

    // ---- JP-81: per-workspace storage quota (507) ----

    #[test]
    fn quota_allows_under_and_rejects_over() {
        let dir = tempdir().unwrap();
        let store = BlobStore::new(dir.path().to_path_buf());
        let ws = WorkspaceId::single_tenant();

        let a = b"0123456789"; // 10 bytes
        let a_hash = BlobStore::compute_hash(a);
        store.save_blob_with_quota(&ws, &a_hash, a, "text/plain", "u", Some(25)).unwrap();

        let b = b"abcdefghij"; // 10 bytes, distinct content → 20 total
        let b_hash = BlobStore::compute_hash(b);
        store.save_blob_with_quota(&ws, &b_hash, b, "text/plain", "u", Some(25)).unwrap();

        // A third distinct 10-byte blob would be 30 > 25 → refused.
        let c = b"klmnopqrst";
        let c_hash = BlobStore::compute_hash(c);
        let err = store
            .save_blob_with_quota(&ws, &c_hash, c, "text/plain", "u", Some(25))
            .unwrap_err();
        assert!(matches!(err, SaveBlobError::QuotaExceeded { .. }));
        // The refused upload granted no ACL → workspace size stays at 20.
        assert_eq!(store.get_workspace_size(&ws), 20);
    }

    #[test]
    fn quota_dedup_reupload_of_granted_hash_adds_zero() {
        let dir = tempdir().unwrap();
        let store = BlobStore::new(dir.path().to_path_buf());
        let ws = WorkspaceId::single_tenant();
        let data = b"0123456789"; // 10 bytes
        let hash = BlobStore::compute_hash(data);

        // Quota exactly 10: the first upload fits.
        store.save_blob_with_quota(&ws, &hash, data, "text/plain", "u", Some(10)).unwrap();
        // Re-upload of the already-granted hash adds 0 → still OK at quota.
        store.save_blob_with_quota(&ws, &hash, data, "text/plain", "u", Some(10)).unwrap();
        assert_eq!(store.get_workspace_size(&ws), 10);
    }

    #[test]
    fn quota_is_per_workspace_isolated() {
        let dir = tempdir().unwrap();
        let store = BlobStore::new(dir.path().to_path_buf());
        let alpha = WorkspaceId::from_configured("alpha").unwrap();
        let beta = WorkspaceId::from_configured("beta").unwrap();

        let data = b"0123456789"; // 10 bytes
        let hash = BlobStore::compute_hash(data);
        // Alpha fills its 10-byte quota.
        store.save_blob_with_quota(&alpha, &hash, data, "text/plain", "a", Some(10)).unwrap();
        // Alpha is full: a new distinct blob is refused.
        let data2 = b"xyz";
        let hash2 = BlobStore::compute_hash(data2);
        assert!(matches!(
            store
                .save_blob_with_quota(&alpha, &hash2, data2, "text/plain", "a", Some(10))
                .unwrap_err(),
            SaveBlobError::QuotaExceeded { .. }
        ));
        // Beta is unaffected — it can still grant the shared hash (deduped
        // bytes, fresh ACL) within its own 10-byte quota.
        store.save_blob_with_quota(&beta, &hash, data, "text/plain", "b", Some(10)).unwrap();
        assert_eq!(store.get_workspace_size(&beta), 10);
    }
}
