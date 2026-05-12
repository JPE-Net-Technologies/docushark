//! User storage and management
//!
//! Provides in-memory user storage with persistence to JSON file.
//! The host stores user credentials; clients authenticate via tokens.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::RwLock;

/// User role
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum UserRole {
    Admin,
    User,
}

impl std::fmt::Display for UserRole {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            UserRole::Admin => write!(f, "admin"),
            UserRole::User => write!(f, "user"),
        }
    }
}

/// User account
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct User {
    pub id: String,
    pub display_name: String,
    pub username: String,
    pub password_hash: String,
    pub role: UserRole,
    pub created_at: u64,
    pub last_login_at: Option<u64>,
}

/// User store for managing user accounts
pub struct UserStore {
    users: RwLock<HashMap<String, User>>,
    /// Path to persist users (optional)
    persist_path: Option<String>,
}

impl Default for UserStore {
    fn default() -> Self {
        Self::new()
    }
}

impl UserStore {
    /// Create a new user store
    pub fn new() -> Self {
        Self {
            users: RwLock::new(HashMap::new()),
            persist_path: None,
        }
    }

    /// Create a user store with persistence
    pub fn with_persistence(path: String) -> Self {
        let store = Self {
            users: RwLock::new(HashMap::new()),
            persist_path: Some(path.clone()),
        };

        // Try to load existing users
        if let Ok(data) = std::fs::read_to_string(&path) {
            if let Ok(users) = serde_json::from_str::<HashMap<String, User>>(&data) {
                *store.users.write().unwrap() = users;
            }
        }

        store
    }

    /// Add a new user
    pub fn add_user(&self, user: User) -> Result<(), String> {
        let mut users = self.users.write().map_err(|e| e.to_string())?;

        // Check for duplicate username
        if users.values().any(|u| u.username == user.username) {
            return Err("Username already exists".to_string());
        }

        users.insert(user.id.clone(), user);
        drop(users);

        self.persist()?;
        Ok(())
    }

    /// Get a user by ID
    pub fn get_user(&self, id: &str) -> Option<User> {
        self.users.read().ok()?.get(id).cloned()
    }

    /// Get a user by username
    pub fn get_user_by_username(&self, username: &str) -> Option<User> {
        self.users
            .read()
            .ok()?
            .values()
            .find(|u| u.username == username)
            .cloned()
    }

    /// Update user's last login time
    pub fn update_last_login(&self, id: &str) -> Result<(), String> {
        let mut users = self.users.write().map_err(|e| e.to_string())?;

        if let Some(user) = users.get_mut(id) {
            user.last_login_at = Some(
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0),
            );
        }

        drop(users);
        self.persist()?;
        Ok(())
    }

    /// Remove a user
    pub fn remove_user(&self, id: &str) -> Result<bool, String> {
        let mut users = self.users.write().map_err(|e| e.to_string())?;
        let removed = users.remove(id).is_some();
        drop(users);

        if removed {
            self.persist()?;
        }

        Ok(removed)
    }

    /// Update a user's role
    pub fn update_user_role(&self, id: &str, new_role: UserRole) -> Result<(), String> {
        let mut users = self.users.write().map_err(|e| e.to_string())?;

        if let Some(user) = users.get_mut(id) {
            user.role = new_role;
            drop(users);
            self.persist()?;
            Ok(())
        } else {
            Err("User not found".to_string())
        }
    }

    /// Update a user's password hash
    pub fn update_user_password(&self, id: &str, new_password_hash: String) -> Result<(), String> {
        let mut users = self.users.write().map_err(|e| e.to_string())?;

        if let Some(user) = users.get_mut(id) {
            user.password_hash = new_password_hash;
            drop(users);
            self.persist()?;
            Ok(())
        } else {
            Err("User not found".to_string())
        }
    }

    /// Get all users (without password hashes)
    pub fn list_users(&self) -> Vec<User> {
        self.users
            .read()
            .map(|users| users.values().cloned().collect())
            .unwrap_or_default()
    }

    /// Check if any users exist
    pub fn has_users(&self) -> bool {
        self.users
            .read()
            .map(|users| !users.is_empty())
            .unwrap_or(false)
    }

    /// Persist users to file
    fn persist(&self) -> Result<(), String> {
        if let Some(path) = &self.persist_path {
            let users = self.users.read().map_err(|e| e.to_string())?;
            let json =
                serde_json::to_string_pretty(&*users).map_err(|e| format!("Serialize error: {}", e))?;
            std::fs::write(path, json).map_err(|e| format!("Write error: {}", e))?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_test_user(id: &str, username: &str, role: UserRole) -> User {
        User {
            id: id.to_string(),
            display_name: format!("Test {}", username),
            username: username.to_string(),
            password_hash: "hash".to_string(),
            role,
            created_at: 0,
            last_login_at: None,
        }
    }

    #[test]
    fn test_add_and_get_user() {
        let store = UserStore::new();
        let user = create_test_user("1", "testuser", UserRole::User);

        store.add_user(user.clone()).unwrap();

        let retrieved = store.get_user("1").unwrap();
        assert_eq!(retrieved.username, "testuser");
    }

    #[test]
    fn test_get_user_by_username() {
        let store = UserStore::new();
        let user = create_test_user("1", "findme", UserRole::Admin);

        store.add_user(user).unwrap();

        let retrieved = store.get_user_by_username("findme").unwrap();
        assert_eq!(retrieved.id, "1");
        assert_eq!(retrieved.role, UserRole::Admin);
    }

    #[test]
    fn test_duplicate_username() {
        let store = UserStore::new();

        store
            .add_user(create_test_user("1", "duplicate", UserRole::User))
            .unwrap();

        let result = store.add_user(create_test_user("2", "duplicate", UserRole::User));
        assert!(result.is_err());
    }

    #[test]
    fn test_remove_user() {
        let store = UserStore::new();
        store
            .add_user(create_test_user("1", "removeme", UserRole::User))
            .unwrap();

        assert!(store.remove_user("1").unwrap());
        assert!(store.get_user("1").is_none());
    }
}
