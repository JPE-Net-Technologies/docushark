//! Persistent MCP feature config.
//!
//! Lives at `<app_data_dir>/mcp_config.json`. Tiny on purpose — we only
//! persist a couple of toggles. Anything that influences which documents
//! the MCP server reveals belongs here.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use serde::{Deserialize, Serialize};

const CONFIG_FILENAME: &str = "mcp_config.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpFeatureConfig {
    /// When true (the default), the MCP server reveals mirrored local
    /// documents alongside team documents. Off means local docs are
    /// hidden from MCP and the mirror directory is wiped.
    #[serde(default = "default_true")]
    pub local_access_enabled: bool,
}

fn default_true() -> bool {
    true
}

impl Default for McpFeatureConfig {
    fn default() -> Self {
        Self {
            local_access_enabled: true,
        }
    }
}

pub struct McpFeatureConfigStore {
    path: PathBuf,
    config: RwLock<McpFeatureConfig>,
}

impl McpFeatureConfigStore {
    pub fn load_or_create(app_data_dir: &Path) -> Self {
        let path = app_data_dir.join(CONFIG_FILENAME);
        let config = match fs::read_to_string(&path) {
            Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
            Err(_) => McpFeatureConfig::default(),
        };
        // Touch the file so it's discoverable / editable. Ignore failures —
        // it'll be created on the first write either way.
        let _ = write_to(&path, &config);
        Self {
            path,
            config: RwLock::new(config),
        }
    }

    pub fn snapshot(&self) -> McpFeatureConfig {
        self.config
            .read()
            .map(|c| c.clone())
            .unwrap_or_default()
    }

    pub fn local_access_enabled(&self) -> bool {
        self.config
            .read()
            .map(|c| c.local_access_enabled)
            .unwrap_or(true)
    }

    /// Update the toggle and persist. Returns the new value.
    pub fn set_local_access(&self, enabled: bool) -> Result<bool, String> {
        {
            let mut guard = self
                .config
                .write()
                .map_err(|e| format!("MCP config lock poisoned: {}", e))?;
            guard.local_access_enabled = enabled;
        }
        let snap = self.snapshot();
        write_to(&self.path, &snap)?;
        Ok(enabled)
    }
}

fn write_to(path: &Path, config: &McpFeatureConfig) -> Result<(), String> {
    let json = serde_json::to_string_pretty(config)
        .map_err(|e| format!("MCP config serialize error: {}", e))?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("MCP config dir error: {}", e))?;
    }
    fs::write(path, json).map_err(|e| format!("MCP config write error: {}", e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn defaults_to_local_access_on() {
        let dir = TempDir::new().unwrap();
        let cfg = McpFeatureConfigStore::load_or_create(dir.path());
        assert!(cfg.local_access_enabled());
    }

    #[test]
    fn set_persists_across_loads() {
        let dir = TempDir::new().unwrap();
        {
            let cfg = McpFeatureConfigStore::load_or_create(dir.path());
            cfg.set_local_access(false).unwrap();
        }
        let cfg2 = McpFeatureConfigStore::load_or_create(dir.path());
        assert!(!cfg2.local_access_enabled());
    }

    #[test]
    fn corrupt_file_falls_back_to_default() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join(CONFIG_FILENAME), "not-json").unwrap();
        let cfg = McpFeatureConfigStore::load_or_create(dir.path());
        assert!(cfg.local_access_enabled());
    }
}
