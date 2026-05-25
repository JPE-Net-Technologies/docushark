//! Team document storage and management
//!
//! Provides file-based storage for team documents that are shared across clients.
//! Documents are stored as JSON files in the app data directory.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::RwLock;

use super::protocol::{DocId, WorkspaceId};

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
    pub id: DocId,
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

/// Relay document store with file-based persistence.
///
/// Per the storage-scoping follow-up to Phase 21.5, on-disk layout is
/// `<documents_dir>/workspaces/<ws>/{index.json, docs/<doc_id>.json}`.
/// The in-memory index mirrors that: outer key is the workspace, inner
/// map is the same per-doc metadata as before. Methods that don't yet
/// take a `WorkspaceId` would silently merge tenants and are no longer
/// part of the public API.
pub struct DocumentStore {
    /// Root for relay-owned doc state — contains `workspaces/<ws>/...`.
    documents_dir: PathBuf,
    /// In-memory metadata index keyed by workspace, then by doc id.
    /// Loaded eagerly at startup; subsequent loads happen on demand
    /// when a new workspace is touched.
    index: RwLock<HashMap<WorkspaceId, HashMap<String, DocumentMetadata>>>,
}

impl DocumentStore {
    /// Create a new document store, applying the legacy-layout
    /// migration if needed.
    pub fn new(app_data_dir: PathBuf) -> Self {
        let documents_dir = app_data_dir.join("relay_documents");

        // Ensure the root and workspaces dir exist.
        let _ = std::fs::create_dir_all(&documents_dir);
        let _ = std::fs::create_dir_all(documents_dir.join("workspaces"));

        // One-shot migration from the pre-21.5 flat layout.
        Self::migrate_legacy_layout(&documents_dir);

        let store = Self {
            documents_dir: documents_dir.clone(),
            index: RwLock::new(HashMap::new()),
        };

        // Eagerly preload every workspace index so `list_documents`
        // for a known-but-not-yet-touched workspace doesn't miss its
        // entries on a cold start.
        store.preload_all_workspace_indexes();

        store
    }

    /// Move a pre-21.5 flat layout (`<root>/{index.json, docs/}`) into
    /// `<root>/workspaces/default/{index.json, docs/}`. Idempotent —
    /// re-running with the new layout already in place is a no-op.
    /// Aborts the migration on partial failure rather than booting in
    /// a half-migrated state. Pre-GA so a one-time on-disk break is
    /// allowed (see `docushark-app/AGENTS.md`).
    fn migrate_legacy_layout(documents_dir: &std::path::Path) {
        let legacy_index = documents_dir.join("index.json");
        let legacy_docs = documents_dir.join("docs");
        let new_root = documents_dir
            .join("workspaces")
            .join(WorkspaceId::single_tenant().as_str());

        let legacy_present = legacy_index.exists() || legacy_docs.exists();
        if !legacy_present {
            return;
        }
        // If the destination already has content, the migration ran
        // before — don't overwrite.
        if new_root.join("index.json").exists() {
            return;
        }

        log::info!(
            "migrating legacy relay_documents layout into workspaces/{}/",
            WorkspaceId::single_tenant().as_str()
        );
        if let Err(e) = std::fs::create_dir_all(&new_root) {
            panic!("storage migration: create_dir_all {:?}: {}", new_root, e);
        }
        if legacy_index.exists() {
            let dest = new_root.join("index.json");
            if let Err(e) = std::fs::rename(&legacy_index, &dest) {
                panic!("storage migration: rename index.json: {}", e);
            }
        }
        if legacy_docs.exists() {
            let dest = new_root.join("docs");
            if let Err(e) = std::fs::rename(&legacy_docs, &dest) {
                panic!("storage migration: rename docs/: {}", e);
            }
        }
        log::info!("storage migration complete");
    }

    /// Path to a workspace's index file.
    fn index_path(&self, ws: &WorkspaceId) -> PathBuf {
        self.workspace_root(ws).join("index.json")
    }

    /// Path to a workspace's per-doc directory.
    fn workspace_root(&self, ws: &WorkspaceId) -> PathBuf {
        self.documents_dir.join("workspaces").join(ws.as_str())
    }

    /// Path to a single document file under its workspace.
    fn doc_path(&self, ws: &WorkspaceId, doc_id: &DocId) -> PathBuf {
        self.workspace_root(ws).join("docs").join(format!("{}.json", doc_id.as_str()))
    }

    /// Reload every workspace's index from disk. Public so external
    /// callers (e.g. the MCP server) can refresh after an out-of-band
    /// write.
    pub fn reload_index(&self) {
        self.preload_all_workspace_indexes();
    }

    /// Walk `workspaces/*` and load every workspace's `index.json` into
    /// the in-memory map. Best-effort — missing or malformed index files
    /// surface as empty maps.
    fn preload_all_workspace_indexes(&self) {
        let workspaces_root = self.documents_dir.join("workspaces");
        let Ok(entries) = std::fs::read_dir(&workspaces_root) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = match path.file_name().and_then(|n| n.to_str()) {
                Some(s) => s.to_string(),
                None => continue,
            };
            // Reuse the path-traversal validator: an attacker-supplied
            // directory like `workspaces/../etc` is rejected and the
            // entry is silently skipped, which is the safest behavior
            // on load.
            let Some(ws) = WorkspaceId::from_configured(&name) else { continue };
            self.load_workspace_index(&ws);
        }
    }

    /// Load a single workspace's index from disk into memory. No-op if
    /// the file is missing or unparseable — the in-memory map for that
    /// workspace stays at whatever it was (empty on first touch).
    fn load_workspace_index(&self, ws: &WorkspaceId) {
        let path = self.index_path(ws);
        let Ok(data) = std::fs::read_to_string(&path) else { return };
        let Ok(parsed) = serde_json::from_str::<HashMap<String, DocumentMetadata>>(&data) else {
            log::warn!("index for workspace {} is malformed — leaving empty", ws.as_str());
            return;
        };
        if let Ok(mut current) = self.index.write() {
            current.insert(ws.clone(), parsed);
        }
    }

    /// Persist a single workspace's index back to disk.
    fn save_workspace_index(&self, ws: &WorkspaceId) -> Result<(), String> {
        let snapshot = {
            let index = self.index.read().map_err(|e| e.to_string())?;
            index.get(ws).cloned().unwrap_or_default()
        };
        let json = serde_json::to_string_pretty(&snapshot)
            .map_err(|e| format!("Serialize error: {}", e))?;
        // Ensure the workspace dir exists before writing.
        let _ = std::fs::create_dir_all(self.workspace_root(ws).join("docs"));
        std::fs::write(self.index_path(ws), json)
            .map_err(|e| format!("Write error: {}", e))?;
        Ok(())
    }

    /// List all documents for a single workspace.
    pub fn list_documents(&self, ws: &WorkspaceId) -> Vec<DocumentMetadata> {
        self.index
            .read()
            .map(|index| {
                index
                    .get(ws)
                    .map(|m| m.values().cloned().collect())
                    .unwrap_or_default()
            })
            .unwrap_or_default()
    }

    /// List every workspace this store currently knows about. Used by
    /// the legacy WS save handler that doesn't yet carry a workspace
    /// id and by future admin tooling; **not** used by per-request
    /// handlers, which always have a workspace from the JWT.
    pub fn known_workspaces(&self) -> Vec<WorkspaceId> {
        self.index
            .read()
            .map(|index| index.keys().cloned().collect())
            .unwrap_or_default()
    }

    /// Get a document by ID (returns full document as JSON value).
    /// Returns `Document not found` if the doc isn't in the requesting
    /// workspace's index, regardless of whether another workspace
    /// happens to own a doc with the same id.
    pub fn get_document(
        &self,
        ws: &WorkspaceId,
        doc_id: &DocId,
    ) -> Result<serde_json::Value, String> {
        // Check if document exists in this workspace's index.
        {
            let index = self.index.read().map_err(|e| e.to_string())?;
            let in_workspace = index
                .get(ws)
                .map(|m| m.contains_key(doc_id.as_str()))
                .unwrap_or(false);
            if !in_workspace {
                return Err("Document not found".to_string());
            }
        }

        // Load document from file.
        let path = self.doc_path(ws, doc_id);
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
    pub fn save_document(
        &self,
        ws: &WorkspaceId,
        doc: serde_json::Value,
    ) -> Result<(), String> {
        match self.save_document_with_expected_version(ws, doc, None)? {
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
        ws: &WorkspaceId,
        mut doc: serde_json::Value,
        expected: Option<u64>,
    ) -> Result<SaveOutcome, String> {
        let id_str = doc.get("id")
            .and_then(|v| v.as_str())
            .ok_or("Document missing 'id' field")?
            .to_string();
        let doc_id = DocId::from_body_id(id_str.clone())
            .map_err(|e| format!("Invalid document id: {}", e))?;
        let id = id_str;

        // Read current stored version (if any) for the concurrency
        // check. Holding the read lock briefly is fine; the rest of
        // the save runs outside the lock.
        let (prior_version, doc_existed) = {
            let index = self.index.read().map_err(|e| e.to_string())?;
            match index.get(ws).and_then(|m| m.get(&id)) {
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
            id: doc_id.clone(),
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
        // Ensure the per-workspace docs dir exists (first-touch for a
        // new tenant on shared-mode Cloud).
        let _ = std::fs::create_dir_all(self.workspace_root(ws).join("docs"));
        std::fs::write(self.doc_path(ws, &doc_id), doc_json)
            .map_err(|e| format!("Write error: {}", e))?;

        {
            let mut index = self.index.write().map_err(|e| e.to_string())?;
            index
                .entry(ws.clone())
                .or_default()
                .insert(id.clone(), metadata);
        }

        self.save_workspace_index(ws)?;

        log::info!("Saved relay document: {}/{} (v{})", ws.as_str(), id, new_version);

        Ok(if doc_existed {
            SaveOutcome::Updated { version: new_version }
        } else {
            SaveOutcome::Created { version: new_version }
        })
    }

    /// Delete a document scoped to the requesting workspace. Returns
    /// `Ok(false)` if the doc isn't in this workspace's index — even
    /// when another workspace holds a doc with the same id.
    pub fn delete_document(&self, ws: &WorkspaceId, doc_id: &DocId) -> Result<bool, String> {
        // Check if document exists in this workspace.
        {
            let index = self.index.read().map_err(|e| e.to_string())?;
            let in_workspace = index
                .get(ws)
                .map(|m| m.contains_key(doc_id.as_str()))
                .unwrap_or(false);
            if !in_workspace {
                return Ok(false);
            }
        }

        // Remove document file.
        let path = self.doc_path(ws, doc_id);
        if path.exists() {
            std::fs::remove_file(&path)
                .map_err(|e| format!("Failed to delete document file: {}", e))?;
        }

        // Remove from this workspace's index.
        {
            let mut index = self.index.write().map_err(|e| e.to_string())?;
            if let Some(workspace_index) = index.get_mut(ws) {
                workspace_index.remove(doc_id.as_str());
            }
        }

        self.save_workspace_index(ws)?;

        log::info!("Deleted relay document: {}/{}", ws.as_str(), doc_id.as_str());
        Ok(true)
    }

    /// Get document metadata by ID, scoped to the requesting workspace.
    pub fn get_metadata(&self, ws: &WorkspaceId, doc_id: &DocId) -> Option<DocumentMetadata> {
        self.index.read().ok()?.get(ws)?.get(doc_id.as_str()).cloned()
    }

    /// Update document lock status
    pub fn set_lock(
        &self,
        ws: &WorkspaceId,
        doc_id: &DocId,
        user_id: Option<&str>,
        user_name: Option<&str>,
    ) -> Result<(), String> {
        // Load document
        let mut doc = self.get_document(ws, doc_id)?;

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
        self.save_document(ws, doc)
    }

    /// Check if a document is locked by another user
    pub fn is_locked_by_other(&self, ws: &WorkspaceId, doc_id: &DocId, user_id: &str) -> bool {
        if let Some(metadata) = self.get_metadata(ws, doc_id) {
            if let Some(locked_by) = &metadata.locked_by {
                return locked_by != user_id;
            }
        }
        false
    }

    /// Get document metadata (alias for get_metadata)
    pub fn get_document_metadata(
        &self,
        ws: &WorkspaceId,
        doc_id: &DocId,
    ) -> Option<DocumentMetadata> {
        self.get_metadata(ws, doc_id)
    }

    /// Update document sharing permissions
    pub fn update_document_shares(
        &self,
        ws: &WorkspaceId,
        doc_id: &DocId,
        shares: &[super::protocol::ShareEntry],
    ) -> Result<(), String> {
        // Load document
        let mut doc = self.get_document(ws, doc_id)?;

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
        self.save_document(ws, doc)?;

        log::info!(
            "Updated shares for document {}: {} users",
            doc_id.as_str(),
            new_shares.len()
        );
        Ok(())
    }

    /// Transfer document ownership to another user
    pub fn transfer_ownership(
        &self,
        ws: &WorkspaceId,
        doc_id: &DocId,
        new_owner_id: &str,
        new_owner_name: &str,
        previous_owner_id: &str,
    ) -> Result<(), String> {
        // Load document
        let mut doc = self.get_document(ws, doc_id)?;

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
        self.save_document(ws, doc)?;

        log::info!(
            "Transferred ownership of document {} from {} to {}",
            doc_id.as_str(),
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
        let ws = WorkspaceId::single_tenant();
        let doc_id = DocId::from_http_path("test-doc-1".to_string()).unwrap();

        // Initially empty
        assert!(store.list_documents(&ws).is_empty());

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
        store.save_document(&ws, doc.clone()).unwrap();

        // List should now have one document
        let docs = store.list_documents(&ws);
        assert_eq!(docs.len(), 1);
        assert_eq!(docs[0].id.as_str(), "test-doc-1");
        assert_eq!(docs[0].name, "Test Document");
        assert_eq!(docs[0].is_relay_document, Some(true));

        // Get document
        let retrieved = store.get_document(&ws, &doc_id).unwrap();
        assert_eq!(retrieved["id"], "test-doc-1");

        // Delete document
        let deleted = store.delete_document(&ws, &doc_id).unwrap();
        assert!(deleted);

        // List should be empty again
        assert!(store.list_documents(&ws).is_empty());
    }

    #[test]
    fn cross_workspace_lookup_returns_not_found() {
        let dir = tempdir().unwrap();
        let store = DocumentStore::new(dir.path().to_path_buf());
        let alpha = WorkspaceId::from_configured("alpha").unwrap();
        let beta = WorkspaceId::from_configured("beta").unwrap();

        let doc = serde_json::json!({
            "id": "shared-id",
            "name": "alpha's doc",
            "pageOrder": ["p1"],
        });
        store.save_document(&alpha, doc).unwrap();

        let doc_id = DocId::from_http_path("shared-id".into()).unwrap();
        // Alpha sees it.
        assert!(store.get_document(&alpha, &doc_id).is_ok());
        assert_eq!(store.list_documents(&alpha).len(), 1);
        // Beta does not — same id, different workspace.
        assert!(store.get_document(&beta, &doc_id).is_err());
        assert!(store.list_documents(&beta).is_empty());
        assert!(store.get_metadata(&beta, &doc_id).is_none());
    }

    #[test]
    fn migration_moves_legacy_layout_into_default_workspace() {
        let dir = tempdir().unwrap();
        let root = dir.path().join("relay_documents");
        std::fs::create_dir_all(root.join("docs")).unwrap();
        // Seed a legacy index + doc.
        let meta = DocumentMetadata {
            id: DocId::from_http_path("legacy-doc".into()).unwrap(),
            name: "legacy".into(),
            page_count: 1,
            modified_at: 1,
            created_at: 1,
            is_relay_document: Some(true),
            server_version: Some(1),
            locked_by: None,
            locked_by_name: None,
            locked_at: None,
            owner_id: None,
            owner_name: None,
            shared_with: None,
            last_modified_by: None,
            last_modified_by_name: None,
        };
        let mut legacy_index = HashMap::new();
        legacy_index.insert("legacy-doc".to_string(), meta);
        std::fs::write(
            root.join("index.json"),
            serde_json::to_string_pretty(&legacy_index).unwrap(),
        )
        .unwrap();
        std::fs::write(
            root.join("docs").join("legacy-doc.json"),
            "{\"id\":\"legacy-doc\"}",
        )
        .unwrap();

        // First boot — migration runs.
        let store = DocumentStore::new(dir.path().to_path_buf());
        let default = WorkspaceId::single_tenant();
        let doc_id = DocId::from_http_path("legacy-doc".into()).unwrap();
        assert!(store.get_metadata(&default, &doc_id).is_some());
        assert!(root.join("workspaces").join("default").join("index.json").exists());
        assert!(!root.join("index.json").exists());

        // Second boot — idempotent.
        drop(store);
        let _store2 = DocumentStore::new(dir.path().to_path_buf());
        assert!(root.join("workspaces").join("default").join("index.json").exists());
    }

    #[test]
    fn test_document_not_found() {
        let dir = tempdir().unwrap();
        let store = DocumentStore::new(dir.path().to_path_buf());
        let ws = WorkspaceId::single_tenant();
        let doc_id = DocId::from_http_path("nonexistent".to_string()).unwrap();

        let result = store.get_document(&ws, &doc_id);
        assert!(result.is_err());
    }
}
