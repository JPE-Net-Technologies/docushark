//! Local document mirror.
//!
//! DocuShark's "local" documents live in the renderer's `localStorage` and
//! are normally invisible to the Rust side. To make them reachable through
//! MCP the frontend pushes a copy of each local document into a dedicated
//! directory on every save; this module manages that directory.
//!
//! Mirroring is one-way: the renderer is authoritative. The MCP server
//! exposes mirrored docs read-only — writes go through the team document
//! flow. That keeps localStorage from being mutated from a process that
//! doesn't own it, which would create a race we don't want to handle in
//! the foundation.
//!
//! Phase 21.6: the on-disk layout is workspace-namespaced
//! (`<root>/local_documents/workspaces/<ws>/docs/<id>.json`) so MCP
//! requests authenticated with a JWT carrying a workspace claim see only
//! their own workspace's mirrored docs. A one-shot migration on
//! construction lifts any pre-21.6 flat layout into
//! `workspaces/default/`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::RwLock;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::server::protocol::WorkspaceId;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MirroredDocumentMetadata {
    pub id: String,
    pub name: String,
    pub page_count: usize,
    pub modified_at: u64,
}

pub struct LocalDocumentMirror {
    root: PathBuf,
    /// `workspace -> doc_id -> metadata`. Per-workspace inner map so
    /// `list(&ws)` is a cheap clone of one bucket.
    index: RwLock<HashMap<WorkspaceId, HashMap<String, MirroredDocumentMetadata>>>,
}

impl LocalDocumentMirror {
    /// Create a new mirror rooted at `<app_data_dir>/local_documents`.
    pub fn new(app_data_dir: PathBuf) -> Self {
        let root = app_data_dir.join("local_documents");
        let _ = std::fs::create_dir_all(&root);
        Self::migrate_legacy_layout(&root);
        let store = Self {
            root,
            index: RwLock::new(HashMap::new()),
        };
        store.scan_disk();
        store
    }

    /// Lift the pre-21.6 flat layout (`<root>/docs/`) into
    /// `<root>/workspaces/default/docs/`. Idempotent — re-running with
    /// the new layout already in place is a no-op. Mirrors the migration
    /// pattern in `DocumentStore::migrate_legacy_layout`.
    fn migrate_legacy_layout(root: &std::path::Path) {
        let legacy_docs = root.join("docs");
        if !legacy_docs.exists() {
            return;
        }
        let new_root = root
            .join("workspaces")
            .join(WorkspaceId::single_tenant().as_str())
            .join("docs");
        if new_root.exists() {
            // The destination is already populated — assume the migration
            // ran before and the leftover `docs/` is empty cruft. Don't
            // overwrite.
            return;
        }
        log::info!(
            "migrating legacy local_documents layout into workspaces/{}/",
            WorkspaceId::single_tenant().as_str()
        );
        if let Some(parent) = new_root.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                panic!("local_mirror migration: create_dir_all {:?}: {}", parent, e);
            }
        }
        if let Err(e) = std::fs::rename(&legacy_docs, &new_root) {
            panic!("local_mirror migration: rename docs/: {}", e);
        }
        log::info!("local_mirror migration complete");
    }

    fn workspace_root(&self, ws: &WorkspaceId) -> PathBuf {
        self.root.join("workspaces").join(ws.as_str())
    }

    fn doc_path(&self, ws: &WorkspaceId, id: &str) -> PathBuf {
        self.workspace_root(ws).join("docs").join(format!("{}.json", id))
    }

    /// Walk every workspace's `docs/` directory on startup and rebuild
    /// the in-memory index. Cheaper and more robust than persisting a
    /// separate index file — the mirror is treated as a cache, not a
    /// source of truth.
    fn scan_disk(&self) {
        let workspaces_root = self.root.join("workspaces");
        let Ok(ws_entries) = std::fs::read_dir(&workspaces_root) else {
            return;
        };
        let mut index: HashMap<WorkspaceId, HashMap<String, MirroredDocumentMetadata>> =
            HashMap::new();
        for ws_entry in ws_entries.flatten() {
            let ws_path = ws_entry.path();
            if !ws_path.is_dir() {
                continue;
            }
            let name = match ws_path.file_name().and_then(|n| n.to_str()) {
                Some(s) => s.to_string(),
                None => continue,
            };
            let Some(ws) = WorkspaceId::from_configured(&name) else { continue };
            let docs_dir = ws_path.join("docs");
            let Ok(doc_entries) = std::fs::read_dir(&docs_dir) else {
                continue;
            };
            let mut bucket: HashMap<String, MirroredDocumentMetadata> = HashMap::new();
            for entry in doc_entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|s| s.to_str()) != Some("json") {
                    continue;
                }
                let data = match std::fs::read_to_string(&path) {
                    Ok(s) => s,
                    Err(_) => continue,
                };
                let doc: Value = match serde_json::from_str(&data) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                if let Some(meta) = extract_metadata(&doc) {
                    bucket.insert(meta.id.clone(), meta);
                }
            }
            if !bucket.is_empty() {
                index.insert(ws, bucket);
            }
        }
        if let Ok(mut guard) = self.index.write() {
            *guard = index;
        }
    }

    /// Persist a mirrored copy of `doc` for `ws` (overwrites any prior
    /// copy at the same `(workspace, doc_id)` key).
    pub fn mirror(&self, ws: &WorkspaceId, doc: Value) -> Result<(), String> {
        let meta = extract_metadata(&doc)
            .ok_or("Document is missing 'id' / 'name' / 'pageOrder' / 'modifiedAt'")?;

        let json = serde_json::to_string_pretty(&doc)
            .map_err(|e| format!("Serialize error: {}", e))?;
        let _ = std::fs::create_dir_all(self.workspace_root(ws).join("docs"));
        std::fs::write(self.doc_path(ws, &meta.id), json)
            .map_err(|e| format!("Failed to write mirrored doc: {}", e))?;

        let mut guard = self
            .index
            .write()
            .map_err(|e| format!("Mirror lock poisoned: {}", e))?;
        guard
            .entry(ws.clone())
            .or_default()
            .insert(meta.id.clone(), meta);
        Ok(())
    }

    /// Remove a mirrored doc. Returns true if anything was deleted.
    pub fn unmirror(&self, ws: &WorkspaceId, id: &str) -> Result<bool, String> {
        let path = self.doc_path(ws, id);
        let existed = path.exists();
        if existed {
            std::fs::remove_file(&path)
                .map_err(|e| format!("Failed to delete mirrored doc: {}", e))?;
        }
        let mut guard = self
            .index
            .write()
            .map_err(|e| format!("Mirror lock poisoned: {}", e))?;
        let removed = guard
            .get_mut(ws)
            .map(|bucket| bucket.remove(id).is_some())
            .unwrap_or(false);
        Ok(existed || removed)
    }

    /// Wipe the entire mirror across every workspace. Used when the user
    /// disables local access globally.
    pub fn clear_all(&self) -> Result<(), String> {
        let workspaces_root = self.root.join("workspaces");
        if let Ok(ws_entries) = std::fs::read_dir(&workspaces_root) {
            for ws_entry in ws_entries.flatten() {
                let docs_dir = ws_entry.path().join("docs");
                if let Ok(entries) = std::fs::read_dir(&docs_dir) {
                    for entry in entries.flatten() {
                        let _ = std::fs::remove_file(entry.path());
                    }
                }
            }
        }
        let mut guard = self
            .index
            .write()
            .map_err(|e| format!("Mirror lock poisoned: {}", e))?;
        guard.clear();
        Ok(())
    }

    pub fn list(&self, ws: &WorkspaceId) -> Vec<MirroredDocumentMetadata> {
        self.index
            .read()
            .map(|g| {
                g.get(ws)
                    .map(|b| b.values().cloned().collect())
                    .unwrap_or_default()
            })
            .unwrap_or_default()
    }

    pub fn contains(&self, ws: &WorkspaceId, id: &str) -> bool {
        self.index
            .read()
            .map(|g| g.get(ws).map(|b| b.contains_key(id)).unwrap_or(false))
            .unwrap_or(false)
    }

    pub fn get(&self, ws: &WorkspaceId, id: &str) -> Result<Value, String> {
        if !self.contains(ws, id) {
            return Err("Mirrored document not found".into());
        }
        let data = std::fs::read_to_string(self.doc_path(ws, id))
            .map_err(|e| format!("Failed to read mirrored doc: {}", e))?;
        serde_json::from_str(&data).map_err(|e| format!("Mirrored doc parse error: {}", e))
    }
}

fn extract_metadata(doc: &Value) -> Option<MirroredDocumentMetadata> {
    let id = doc.get("id")?.as_str()?.to_string();
    let name = doc
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("Untitled")
        .to_string();
    let page_count = doc
        .get("pageOrder")
        .and_then(|v| v.as_array())
        .map(|a| a.len())
        .unwrap_or(1);
    let modified_at = doc
        .get("modifiedAt")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    Some(MirroredDocumentMetadata {
        id,
        name,
        page_count,
        modified_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;

    fn make_doc(id: &str, name: &str) -> Value {
        json!({
            "id": id,
            "name": name,
            "version": 1,
            "createdAt": 1u64,
            "modifiedAt": 2u64,
            "activePageId": "p1",
            "pageOrder": ["p1"],
            "pages": {"p1": {
                "id": "p1", "name": "Page 1",
                "shapes": {}, "shapeOrder": [],
                "createdAt": 1u64, "modifiedAt": 1u64,
            }}
        })
    }

    fn ws(name: &str) -> WorkspaceId {
        WorkspaceId::from_configured(name).expect("workspace id")
    }

    #[test]
    fn mirror_and_list() {
        let dir = TempDir::new().unwrap();
        let m = LocalDocumentMirror::new(dir.path().to_path_buf());
        let default = WorkspaceId::single_tenant();
        m.mirror(&default, make_doc("a", "Alpha")).unwrap();
        m.mirror(&default, make_doc("b", "Bravo")).unwrap();
        let mut ids: Vec<String> = m.list(&default).into_iter().map(|d| d.id).collect();
        ids.sort();
        assert_eq!(ids, vec!["a", "b"]);
    }

    #[test]
    fn get_returns_full_doc() {
        let dir = TempDir::new().unwrap();
        let m = LocalDocumentMirror::new(dir.path().to_path_buf());
        let default = WorkspaceId::single_tenant();
        m.mirror(&default, make_doc("a", "Alpha")).unwrap();
        let got = m.get(&default, "a").unwrap();
        assert_eq!(got["name"], "Alpha");
    }

    #[test]
    fn unmirror_removes() {
        let dir = TempDir::new().unwrap();
        let m = LocalDocumentMirror::new(dir.path().to_path_buf());
        let default = WorkspaceId::single_tenant();
        m.mirror(&default, make_doc("a", "Alpha")).unwrap();
        assert!(m.unmirror(&default, "a").unwrap());
        assert!(m.list(&default).is_empty());
        assert!(m.unmirror(&default, "a").unwrap() == false);
    }

    #[test]
    fn workspaces_are_isolated() {
        let dir = TempDir::new().unwrap();
        let m = LocalDocumentMirror::new(dir.path().to_path_buf());
        let alpha = ws("alpha");
        let beta = ws("beta");
        m.mirror(&alpha, make_doc("shared", "Alpha's doc")).unwrap();
        m.mirror(&beta, make_doc("shared", "Beta's doc")).unwrap();

        assert!(m.contains(&alpha, "shared"));
        assert!(m.contains(&beta, "shared"));
        assert_eq!(m.get(&alpha, "shared").unwrap()["name"], "Alpha's doc");
        assert_eq!(m.get(&beta, "shared").unwrap()["name"], "Beta's doc");
        assert_eq!(m.list(&alpha).len(), 1);
        assert_eq!(m.list(&beta).len(), 1);

        m.unmirror(&alpha, "shared").unwrap();
        assert!(!m.contains(&alpha, "shared"));
        assert!(m.contains(&beta, "shared"));
    }

    #[test]
    fn legacy_flat_layout_migrates_into_default_workspace() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().join("local_documents");
        let legacy_docs = root.join("docs");
        std::fs::create_dir_all(&legacy_docs).unwrap();
        let doc_json = serde_json::to_string_pretty(&make_doc("legacy", "Legacy Doc")).unwrap();
        std::fs::write(legacy_docs.join("legacy.json"), doc_json).unwrap();

        let m = LocalDocumentMirror::new(dir.path().to_path_buf());
        let default = WorkspaceId::single_tenant();
        assert!(m.contains(&default, "legacy"));
        assert_eq!(m.get(&default, "legacy").unwrap()["name"], "Legacy Doc");
        // The legacy directory is gone after migration.
        assert!(!legacy_docs.exists());
        // The new path exists.
        let migrated = root
            .join("workspaces")
            .join(default.as_str())
            .join("docs")
            .join("legacy.json");
        assert!(migrated.exists());
    }

    #[test]
    fn scan_disk_rebuilds_index_across_workspaces() {
        let dir = TempDir::new().unwrap();
        {
            let m = LocalDocumentMirror::new(dir.path().to_path_buf());
            m.mirror(&ws("alpha"), make_doc("a", "Alpha")).unwrap();
            m.mirror(&ws("beta"), make_doc("b", "Beta")).unwrap();
        }
        let m2 = LocalDocumentMirror::new(dir.path().to_path_buf());
        assert!(m2.contains(&ws("alpha"), "a"));
        assert!(m2.contains(&ws("beta"), "b"));
        assert!(!m2.contains(&ws("alpha"), "b"));
    }

    #[test]
    fn clear_all_wipes_every_workspace() {
        let dir = TempDir::new().unwrap();
        let m = LocalDocumentMirror::new(dir.path().to_path_buf());
        m.mirror(&ws("alpha"), make_doc("a", "Alpha")).unwrap();
        m.mirror(&ws("beta"), make_doc("b", "Beta")).unwrap();
        m.clear_all().unwrap();
        assert!(m.list(&ws("alpha")).is_empty());
        assert!(m.list(&ws("beta")).is_empty());
    }
}
