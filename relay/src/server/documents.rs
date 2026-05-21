//! Team document storage and management
//!
//! Provides file-based storage for team documents that are shared across clients.
//! Documents are stored as JSON files in the app data directory.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::RwLock;

/// Document share entry for tracking who has access
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentShare {
    pub user_id: String,
    pub user_name: String,
    pub permission: String, // "view" or "edit"
    pub shared_at: u64,
}

/// Lightweight metadata for document listing
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentMetadata {
    pub id: String,
    pub name: String,
    pub page_count: usize,
    pub modified_at: u64,
    pub created_at: u64,

    // Relay document fields
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_relay_document: Option<bool>,
    /// Monotonically increasing server-side version used by REST
    /// `PUT /api/docs/:id` for optimistic concurrency. Bumped on every
    /// successful save. None for documents predating v2.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_version: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub locked_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub locked_by_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub locked_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shared_with: Option<Vec<DocumentShare>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_modified_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_modified_by_name: Option<String>,
}

/// Outcome of a save attempt with optimistic-concurrency support.
/// IO and validation errors continue to surface via the `Result::Err`
/// channel; this enum carries only application-level outcomes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SaveOutcome {
    /// New document created with the given version (always 1).
    Created { version: u64 },
    /// Existing document updated to the given version.
    Updated { version: u64 },
    /// Caller's `expected_version` did not match the stored version.
    /// `current` is the server's view; clients should refetch + retry.
    VersionConflict { current: u64 },
}

/// Relay document store with file-based persistence
pub struct DocumentStore {
    /// Directory for storing documents
    documents_dir: PathBuf,
    /// In-memory metadata index for fast lookups
    index: RwLock<HashMap<String, DocumentMetadata>>,
}

impl DocumentStore {
    /// Create a new document store
    pub fn new(app_data_dir: PathBuf) -> Self {
        let documents_dir = app_data_dir.join("relay_documents");

        // Ensure directories exist
        let _ = std::fs::create_dir_all(&documents_dir);
        let _ = std::fs::create_dir_all(documents_dir.join("docs"));

        let store = Self {
            documents_dir: documents_dir.clone(),
            index: RwLock::new(HashMap::new()),
        };

        // Load existing index
        store.load_index();

        store
    }

    /// Get path to the index file
    fn index_path(&self) -> PathBuf {
        self.documents_dir.join("index.json")
    }

    /// Get path to a document file
    fn doc_path(&self, doc_id: &str) -> PathBuf {
        self.documents_dir.join("docs").join(format!("{}.json", doc_id))
    }

    /// Reload the metadata index from disk. Public so external callers
    /// (e.g. the MCP server) can refresh their view after another component
    /// has written to the same documents directory.
    pub fn reload_index(&self) {
        self.load_index();
    }

    /// Load the metadata index from disk
    fn load_index(&self) {
        let path = self.index_path();
        if let Ok(data) = std::fs::read_to_string(&path) {
            if let Ok(index) = serde_json::from_str::<HashMap<String, DocumentMetadata>>(&data) {
                if let Ok(mut current) = self.index.write() {
                    *current = index;
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

    /// List all team documents
    pub fn list_documents(&self) -> Vec<DocumentMetadata> {
        self.index
            .read()
            .map(|index| index.values().cloned().collect())
            .unwrap_or_default()
    }

    /// Get a document by ID (returns full document as JSON value)
    pub fn get_document(&self, doc_id: &str) -> Result<serde_json::Value, String> {
        // Check if document exists in index
        {
            let index = self.index.read().map_err(|e| e.to_string())?;
            if !index.contains_key(doc_id) {
                return Err("Document not found".to_string());
            }
        }

        // Load document from file
        let path = self.doc_path(doc_id);
        let data = std::fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read document: {}", e))?;
        let doc: serde_json::Value = serde_json::from_str(&data)
            .map_err(|e| format!("Failed to parse document: {}", e))?;

        Ok(doc)
    }

    /// Save a document (creates or updates). Convenience wrapper for
    /// callers that don't need optimistic-concurrency semantics — used
    /// by the WS save handler, which never carried version fields on
    /// the wire. The REST handler uses
    /// `save_document_with_expected_version` directly.
    pub fn save_document(&self, doc: serde_json::Value) -> Result<(), String> {
        match self.save_document_with_expected_version(doc, None)? {
            SaveOutcome::Created { .. } | SaveOutcome::Updated { .. } => Ok(()),
            // `expected = None` cannot produce a conflict — collapse to
            // a string error to preserve the existing signature.
            SaveOutcome::VersionConflict { current } => Err(format!(
                "unexpected version conflict (current={})",
                current
            )),
        }
    }

    /// Save a document with optimistic-concurrency check.
    ///
    /// When `expected` is `Some(N)`, refuses the write if the stored
    /// `server_version` for this doc is not `N`, returning
    /// `SaveOutcome::VersionConflict { current }`. When `expected` is
    /// `None`, the write proceeds unconditionally (last-writer-wins —
    /// matches pre-v2 behavior for callers that don't opt in).
    ///
    /// On success, the stored `server_version` is bumped (or set to 1
    /// for first creation) and returned. The version is also injected
    /// into the doc body under `serverVersion` so clients can read it
    /// back via `GET /api/docs/:id` without consulting metadata.
    pub fn save_document_with_expected_version(
        &self,
        mut doc: serde_json::Value,
        expected: Option<u64>,
    ) -> Result<SaveOutcome, String> {
        let id = doc.get("id")
            .and_then(|v| v.as_str())
            .ok_or("Document missing 'id' field")?
            .to_string();

        // Read current stored version (if any) for the concurrency
        // check. Holding the read lock briefly is fine; the rest of
        // the save runs outside the lock.
        let (prior_version, doc_existed) = {
            let index = self.index.read().map_err(|e| e.to_string())?;
            match index.get(&id) {
                Some(meta) => (meta.server_version.unwrap_or(0), true),
                None => (0, false),
            }
        };

        if let Some(expected_version) = expected {
            if expected_version != prior_version {
                return Ok(SaveOutcome::VersionConflict {
                    current: prior_version,
                });
            }
        }

        let new_version = prior_version + 1;

        // Mirror the new version into the doc body so reads pick it up.
        if let Some(obj) = doc.as_object_mut() {
            obj.insert("serverVersion".to_string(), serde_json::json!(new_version));
        }

        let name = doc.get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("Untitled")
            .to_string();

        let page_order = doc.get("pageOrder")
            .and_then(|v| v.as_array())
            .map(|arr| arr.len())
            .unwrap_or(1);

        let modified_at = doc.get("modifiedAt")
            .and_then(|v| v.as_u64())
            .unwrap_or_else(|| {
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0)
            });

        let created_at = doc.get("createdAt")
            .and_then(|v| v.as_u64())
            .unwrap_or(modified_at);

        let metadata = DocumentMetadata {
            id: id.clone(),
            name,
            page_count: page_order,
            modified_at,
            created_at,
            is_relay_document: doc
                .get("isRelayDocument")
                .or_else(|| doc.get("isTeamDocument"))
                .and_then(|v| v.as_bool()),
            server_version: Some(new_version),
            locked_by: doc.get("lockedBy").and_then(|v| v.as_str()).map(String::from),
            locked_by_name: doc.get("lockedByName").and_then(|v| v.as_str()).map(String::from),
            locked_at: doc.get("lockedAt").and_then(|v| v.as_u64()),
            owner_id: doc.get("ownerId").and_then(|v| v.as_str()).map(String::from),
            owner_name: doc.get("ownerName").and_then(|v| v.as_str()).map(String::from),
            shared_with: doc.get("sharedWith").and_then(|v| {
                serde_json::from_value(v.clone()).ok()
            }),
            last_modified_by: doc.get("lastModifiedBy").and_then(|v| v.as_str()).map(String::from),
            last_modified_by_name: doc.get("lastModifiedByName").and_then(|v| v.as_str()).map(String::from),
        };

        let doc_json = serde_json::to_string_pretty(&doc)
            .map_err(|e| format!("Serialize error: {}", e))?;
        std::fs::write(self.doc_path(&id), doc_json)
            .map_err(|e| format!("Write error: {}", e))?;

        {
            let mut index = self.index.write().map_err(|e| e.to_string())?;
            index.insert(id.clone(), metadata);
        }

        self.save_index()?;

        log::info!("Saved relay document: {} (v{})", id, new_version);

        Ok(if doc_existed {
            SaveOutcome::Updated { version: new_version }
        } else {
            SaveOutcome::Created { version: new_version }
        })
    }

    /// Delete a document
    pub fn delete_document(&self, doc_id: &str) -> Result<bool, String> {
        // Check if document exists
        {
            let index = self.index.read().map_err(|e| e.to_string())?;
            if !index.contains_key(doc_id) {
                return Ok(false);
            }
        }

        // Remove document file
        let path = self.doc_path(doc_id);
        if path.exists() {
            std::fs::remove_file(&path)
                .map_err(|e| format!("Failed to delete document file: {}", e))?;
        }

        // Remove from index
        {
            let mut index = self.index.write().map_err(|e| e.to_string())?;
            index.remove(doc_id);
        }

        // Save index
        self.save_index()?;

        log::info!("Deleted team document: {}", doc_id);
        Ok(true)
    }

    /// Get document metadata by ID
    pub fn get_metadata(&self, doc_id: &str) -> Option<DocumentMetadata> {
        self.index.read().ok()?.get(doc_id).cloned()
    }

    /// Update document lock status
    pub fn set_lock(
        &self,
        doc_id: &str,
        user_id: Option<&str>,
        user_name: Option<&str>,
    ) -> Result<(), String> {
        // Load document
        let mut doc = self.get_document(doc_id)?;

        // Update lock fields
        if let Some(uid) = user_id {
            doc["lockedBy"] = serde_json::json!(uid);
            doc["lockedByName"] = serde_json::json!(user_name.unwrap_or("Unknown"));
            doc["lockedAt"] = serde_json::json!(
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0)
            );
        } else {
            doc["lockedBy"] = serde_json::Value::Null;
            doc["lockedByName"] = serde_json::Value::Null;
            doc["lockedAt"] = serde_json::Value::Null;
        }

        // Save document
        self.save_document(doc)
    }

    /// Check if a document is locked by another user
    pub fn is_locked_by_other(&self, doc_id: &str, user_id: &str) -> bool {
        if let Some(metadata) = self.get_metadata(doc_id) {
            if let Some(locked_by) = &metadata.locked_by {
                return locked_by != user_id;
            }
        }
        false
    }

    /// Get document metadata (alias for get_metadata)
    pub fn get_document_metadata(&self, doc_id: &str) -> Option<DocumentMetadata> {
        self.get_metadata(doc_id)
    }

    /// Update document sharing permissions
    pub fn update_document_shares(
        &self,
        doc_id: &str,
        shares: &[super::protocol::ShareEntry],
    ) -> Result<(), String> {
        // Load document
        let mut doc = self.get_document(doc_id)?;

        // Build new shares list
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        let new_shares: Vec<DocumentShare> = shares
            .iter()
            .filter(|s| s.permission != "none") // "none" means remove access
            .map(|s| DocumentShare {
                user_id: s.user_id.clone(),
                user_name: s.user_name.clone(),
                permission: s.permission.clone(),
                shared_at: now,
            })
            .collect();

        // Update document JSON
        doc["sharedWith"] = serde_json::to_value(&new_shares)
            .map_err(|e| format!("Failed to serialize shares: {}", e))?;

        // Save document
        self.save_document(doc)?;

        log::info!(
            "Updated shares for document {}: {} users",
            doc_id,
            new_shares.len()
        );
        Ok(())
    }

    /// Transfer document ownership to another user
    pub fn transfer_ownership(
        &self,
        doc_id: &str,
        new_owner_id: &str,
        new_owner_name: &str,
        previous_owner_id: &str,
    ) -> Result<(), String> {
        // Load document
        let mut doc = self.get_document(doc_id)?;

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        // Update owner fields
        doc["ownerId"] = serde_json::json!(new_owner_id);
        doc["ownerName"] = serde_json::json!(new_owner_name);

        // Add previous owner as an editor in the shares
        let mut shares: Vec<DocumentShare> = doc["sharedWith"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| serde_json::from_value(v.clone()).ok())
                    .collect()
            })
            .unwrap_or_default();

        // Remove new owner from shares (they're owner now)
        shares.retain(|s| s.user_id != new_owner_id);

        // Add previous owner as editor if not already in shares
        if !shares.iter().any(|s| s.user_id == previous_owner_id) {
            shares.push(DocumentShare {
                user_id: previous_owner_id.to_string(),
                user_name: doc["lastModifiedByName"]
                    .as_str()
                    .unwrap_or("Previous Owner")
                    .to_string(),
                permission: "edit".to_string(),
                shared_at: now,
            });
        }

        doc["sharedWith"] = serde_json::to_value(&shares)
            .map_err(|e| format!("Failed to serialize shares: {}", e))?;

        // Save document
        self.save_document(doc)?;

        log::info!(
            "Transferred ownership of document {} from {} to {}",
            doc_id,
            previous_owner_id,
            new_owner_id
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_document_store_lifecycle() {
        let dir = tempdir().unwrap();
        let store = DocumentStore::new(dir.path().to_path_buf());

        // Initially empty
        assert!(store.list_documents().is_empty());

        // Create a test document
        let doc = serde_json::json!({
            "id": "test-doc-1",
            "name": "Test Document",
            "pages": {},
            "pageOrder": ["page1"],
            "activePageId": "page1",
            "createdAt": 1000,
            "modifiedAt": 2000,
            "version": 1,
            "isRelayDocument": true
        });

        // Save document
        store.save_document(doc.clone()).unwrap();

        // List should now have one document
        let docs = store.list_documents();
        assert_eq!(docs.len(), 1);
        assert_eq!(docs[0].id, "test-doc-1");
        assert_eq!(docs[0].name, "Test Document");
        assert_eq!(docs[0].is_relay_document, Some(true));

        // Get document
        let retrieved = store.get_document("test-doc-1").unwrap();
        assert_eq!(retrieved["id"], "test-doc-1");

        // Delete document
        let deleted = store.delete_document("test-doc-1").unwrap();
        assert!(deleted);

        // List should be empty again
        assert!(store.list_documents().is_empty());
    }

    #[test]
    fn test_document_not_found() {
        let dir = tempdir().unwrap();
        let store = DocumentStore::new(dir.path().to_path_buf());

        let result = store.get_document("nonexistent");
        assert!(result.is_err());
    }
}
