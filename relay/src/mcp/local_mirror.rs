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

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::RwLock;

use serde::{Deserialize, Serialize};
use serde_json::Value;

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
    index: RwLock<HashMap<String, MirroredDocumentMetadata>>,
}

impl LocalDocumentMirror {
    /// Create a new mirror rooted at `<app_data_dir>/local_documents`.
    pub fn new(app_data_dir: PathBuf) -> Self {
        let root = app_data_dir.join("local_documents");
        let _ = std::fs::create_dir_all(root.join("docs"));
        let store = Self {
            root,
            index: RwLock::new(HashMap::new()),
        };
        store.scan_disk();
        store
    }

    fn doc_path(&self, id: &str) -> PathBuf {
        // TODO(21.6 MCP workspace claim): once MCP carries a
        // `WorkspaceId`, namespace this layout the same way
        // `DocumentStore` does (`workspaces/<ws>/docs/<id>.json`) and
        // route through the JWT-derived workspace. Today MCP is
        // single-host / single-workspace by construction, so the flat
        // layout is safe — the team-doc fuzz suite proves the OSS
        // multi-tenant boundary holds for the writable surface.
        self.root.join("docs").join(format!("{}.json", id))
    }

    /// Walk the docs directory on startup and rebuild the in-memory index.
    /// Cheaper and more robust than persisting a separate index file —
    /// the mirror is treated as a cache, not a source of truth.
    fn scan_disk(&self) {
        let dir = self.root.join("docs");
        let entries = match std::fs::read_dir(&dir) {
            Ok(it) => it,
            Err(_) => return,
        };
        let mut map: HashMap<String, MirroredDocumentMetadata> = HashMap::new();
        for entry in entries.flatten() {
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
                map.insert(meta.id.clone(), meta);
            }
        }
        if let Ok(mut guard) = self.index.write() {
            *guard = map;
        }
    }

    /// Persist a mirrored copy of `doc` (overwrites any prior copy).
    pub fn mirror(&self, doc: Value) -> Result<(), String> {
        let meta = extract_metadata(&doc)
            .ok_or("Document is missing 'id' / 'name' / 'pageOrder' / 'modifiedAt'")?;

        let json = serde_json::to_string_pretty(&doc)
            .map_err(|e| format!("Serialize error: {}", e))?;
        std::fs::write(self.doc_path(&meta.id), json)
            .map_err(|e| format!("Failed to write mirrored doc: {}", e))?;

        let mut guard = self
            .index
            .write()
            .map_err(|e| format!("Mirror lock poisoned: {}", e))?;
        guard.insert(meta.id.clone(), meta);
        Ok(())
    }

    /// Remove a mirrored doc. Returns true if anything was deleted.
    pub fn unmirror(&self, id: &str) -> Result<bool, String> {
        let path = self.doc_path(id);
        let existed = path.exists();
        if existed {
            std::fs::remove_file(&path)
                .map_err(|e| format!("Failed to delete mirrored doc: {}", e))?;
        }
        let mut guard = self
            .index
            .write()
            .map_err(|e| format!("Mirror lock poisoned: {}", e))?;
        let removed = guard.remove(id).is_some();
        Ok(existed || removed)
    }

    /// Wipe the entire mirror. Used when the user disables local access.
    pub fn clear_all(&self) -> Result<(), String> {
        let dir = self.root.join("docs");
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let _ = std::fs::remove_file(entry.path());
            }
        }
        let mut guard = self
            .index
            .write()
            .map_err(|e| format!("Mirror lock poisoned: {}", e))?;
        guard.clear();
        Ok(())
    }

    pub fn list(&self) -> Vec<MirroredDocumentMetadata> {
        self.index
            .read()
            .map(|g| g.values().cloned().collect())
            .unwrap_or_default()
    }

    pub fn contains(&self, id: &str) -> bool {
        self.index
            .read()
            .map(|g| g.contains_key(id))
            .unwrap_or(false)
    }

    pub fn get(&self, id: &str) -> Result<Value, String> {
        if !self.contains(id) {
            return Err("Mirrored document not found".into());
        }
        let data = std::fs::read_to_string(self.doc_path(id))
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

    #[test]
    fn mirror_and_list() {
        let dir = TempDir::new().unwrap();
        let m = LocalDocumentMirror::new(dir.path().to_path_buf());
        m.mirror(make_doc("a", "Alpha")).unwrap();
        m.mirror(make_doc("b", "Bravo")).unwrap();
        let mut ids: Vec<String> = m.list().into_iter().map(|d| d.id).collect();
        ids.sort();
        assert_eq!(ids, vec!["a", "b"]);
    }

    #[test]
    fn get_returns_full_doc() {
        let dir = TempDir::new().unwrap();
        let m = LocalDocumentMirror::new(dir.path().to_path_buf());
        m.mirror(make_doc("a", "Alpha")).unwrap();
        let got = m.get("a").unwrap();
        assert_eq!(got["name"], "Alpha");
    }

    #[test]
    fn unmirror_removes() {
        let dir = TempDir::new().unwrap();
        let m = LocalDocumentMirror::new(dir.path().to_path_buf());
        m.mirror(make_doc("a", "Alpha")).unwrap();
        assert!(m.unmirror("a").unwrap());
        assert!(m.list().is_empty());
        assert!(m.unmirror("a").unwrap() == false);
    }

    #[test]
    fn clear_all_wipes_directory_and_index() {
        let dir = TempDir::new().unwrap();
        let m = LocalDocumentMirror::new(dir.path().to_path_buf());
        m.mirror(make_doc("a", "Alpha")).unwrap();
        m.mirror(make_doc("b", "Bravo")).unwrap();
        m.clear_all().unwrap();
        assert!(m.list().is_empty());
        let files: Vec<_> = std::fs::read_dir(dir.path().join("local_documents/docs"))
            .unwrap()
            .collect();
        assert!(files.is_empty());
    }

    #[test]
    fn scan_disk_picks_up_existing_files() {
        let dir = TempDir::new().unwrap();
        {
            let m = LocalDocumentMirror::new(dir.path().to_path_buf());
            m.mirror(make_doc("a", "Alpha")).unwrap();
        }
        let m2 = LocalDocumentMirror::new(dir.path().to_path_buf());
        let ids: Vec<String> = m2.list().into_iter().map(|d| d.id).collect();
        assert_eq!(ids, vec!["a"]);
    }

    #[test]
    fn mirror_rejects_doc_without_id() {
        let dir = TempDir::new().unwrap();
        let m = LocalDocumentMirror::new(dir.path().to_path_buf());
        let bad = json!({"name": "no id"});
        assert!(m.mirror(bad).is_err());
    }
}
