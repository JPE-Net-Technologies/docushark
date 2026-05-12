//! Document permission management
//!
//! Implements a 3-tier permission model for document access control:
//! - Owner: Full access including delete, transfer ownership, manage sharing
//! - Editor: Read and write access
//! - Viewer: Read-only access
//!
//! Permission hierarchy:
//! - Document owner is set on creation
//! - Admins have implicit Owner access to all documents (full management)
//! - Users with explicit shares have their assigned permission level
//! - No implicit access for unshared documents

use super::documents::{DocumentMetadata, DocumentStore};

/// Permission levels for document access (ordered from most to least privileged)
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Permission {
    /// No access
    None = 0,
    /// Read-only access
    Viewer = 1,
    /// Read and write access
    Editor = 2,
    /// Full access including delete, transfer, and share management
    Owner = 3,
}

impl Permission {
    /// Parse permission from string (as stored in DocumentShare)
    pub fn from_str(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "owner" => Permission::Owner,
            "edit" | "editor" => Permission::Editor,
            "view" | "viewer" => Permission::Viewer,
            _ => Permission::None,
        }
    }

    /// Convert to string representation
    pub fn as_str(&self) -> &'static str {
        match self {
            Permission::Owner => "owner",
            Permission::Editor => "edit",
            Permission::Viewer => "view",
            Permission::None => "none",
        }
    }

    /// Check if this permission level allows reading
    pub fn can_read(&self) -> bool {
        *self >= Permission::Viewer
    }

    /// Check if this permission level allows writing
    pub fn can_write(&self) -> bool {
        *self >= Permission::Editor
    }

    /// Check if this permission level allows deletion
    pub fn can_delete(&self) -> bool {
        *self >= Permission::Owner
    }

    /// Check if this permission level allows managing shares
    pub fn can_manage_shares(&self) -> bool {
        *self >= Permission::Owner
    }
}

/// Permission error types
#[derive(Debug, Clone)]
pub enum PermissionError {
    /// User does not have required permission level
    AccessDenied {
        required: Permission,
        actual: Permission,
    },
    /// Document not found
    DocumentNotFound,
    /// User not authenticated
    NotAuthenticated,
}

impl std::fmt::Display for PermissionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PermissionError::AccessDenied { required, actual } => {
                write!(
                    f,
                    "Access denied: requires {} permission, user has {}",
                    required.as_str(),
                    actual.as_str()
                )
            }
            PermissionError::DocumentNotFound => write!(f, "Document not found"),
            PermissionError::NotAuthenticated => write!(f, "Authentication required"),
        }
    }
}

/// Permission error codes for protocol messages
pub mod error_codes {
    /// User lacks required permission for operation
    pub const ACCESS_DENIED: &str = "ERR_ACCESS_DENIED";
    /// Document not found
    pub const DOC_NOT_FOUND: &str = "ERR_DOC_NOT_FOUND";
    /// User not authenticated
    pub const NOT_AUTHENTICATED: &str = "ERR_NOT_AUTHENTICATED";
    /// Permission level insufficient for delete operation
    pub const DELETE_FORBIDDEN: &str = "ERR_DELETE_FORBIDDEN";
    /// Permission level insufficient for edit operation
    pub const EDIT_FORBIDDEN: &str = "ERR_EDIT_FORBIDDEN";
    /// Permission level insufficient for view operation
    pub const VIEW_FORBIDDEN: &str = "ERR_VIEW_FORBIDDEN";
}

/// Get effective permission for a user on a document
///
/// Priority order:
/// 1. Owner - full access
/// 2. Admin users - implicit Editor access
/// 3. Explicit share permission
/// 4. None - no access
pub fn get_user_permission(
    metadata: &DocumentMetadata,
    user_id: &str,
    user_role: Option<&str>,
) -> Permission {
    // Check if user is owner
    if let Some(owner_id) = &metadata.owner_id {
        if owner_id == user_id {
            return Permission::Owner;
        }
    }

    // Admin users get implicit Owner access for management purposes
    // (can manage shares, transfer ownership, delete)
    if user_role == Some("admin") {
        return Permission::Owner;
    }

    // Check explicit shares
    if let Some(shares) = &metadata.shared_with {
        for share in shares {
            if share.user_id == user_id {
                return Permission::from_str(&share.permission);
            }
        }
    }

    // No access
    Permission::None
}

/// Check if user has required permission level
pub fn check_permission(
    doc_store: &DocumentStore,
    doc_id: &str,
    user_id: Option<&str>,
    user_role: Option<&str>,
    required: Permission,
) -> Result<Permission, PermissionError> {
    // Require authentication
    let user_id = match user_id {
        Some(id) if !id.is_empty() => id,
        _ => return Err(PermissionError::NotAuthenticated),
    };

    // Get document metadata
    let metadata = doc_store
        .get_metadata(doc_id)
        .ok_or(PermissionError::DocumentNotFound)?;

    // Get user's effective permission
    let actual = get_user_permission(&metadata, user_id, user_role);

    // Check if sufficient
    if actual >= required {
        Ok(actual)
    } else {
        Err(PermissionError::AccessDenied { required, actual })
    }
}

/// Check read permission (at least Viewer)
pub fn check_read_permission(
    doc_store: &DocumentStore,
    doc_id: &str,
    user_id: Option<&str>,
    user_role: Option<&str>,
) -> Result<Permission, PermissionError> {
    check_permission(doc_store, doc_id, user_id, user_role, Permission::Viewer)
}

/// Check write permission (at least Editor)
pub fn check_write_permission(
    doc_store: &DocumentStore,
    doc_id: &str,
    user_id: Option<&str>,
    user_role: Option<&str>,
) -> Result<Permission, PermissionError> {
    check_permission(doc_store, doc_id, user_id, user_role, Permission::Editor)
}

/// Check delete permission (requires Owner)
pub fn check_delete_permission(
    doc_store: &DocumentStore,
    doc_id: &str,
    user_id: Option<&str>,
    user_role: Option<&str>,
) -> Result<Permission, PermissionError> {
    check_permission(doc_store, doc_id, user_id, user_role, Permission::Owner)
}

/// Convert PermissionError to protocol error string
pub fn to_error_string(err: &PermissionError) -> String {
    match err {
        PermissionError::AccessDenied { required, .. } => {
            let code = match *required {
                Permission::Owner => error_codes::DELETE_FORBIDDEN,
                Permission::Editor => error_codes::EDIT_FORBIDDEN,
                Permission::Viewer => error_codes::VIEW_FORBIDDEN,
                Permission::None => error_codes::ACCESS_DENIED,
            };
            format!("{}: {}", code, err)
        }
        PermissionError::DocumentNotFound => {
            format!("{}: {}", error_codes::DOC_NOT_FOUND, err)
        }
        PermissionError::NotAuthenticated => {
            format!("{}: {}", error_codes::NOT_AUTHENTICATED, err)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::documents::DocumentShare;

    fn make_metadata(owner_id: &str, shares: Vec<(&str, &str)>) -> DocumentMetadata {
        DocumentMetadata {
            id: "doc-1".to_string(),
            name: "Test".to_string(),
            page_count: 1,
            modified_at: 0,
            created_at: 0,
            is_team_document: Some(true),
            locked_by: None,
            locked_by_name: None,
            locked_at: None,
            owner_id: Some(owner_id.to_string()),
            owner_name: Some("Owner".to_string()),
            shared_with: if shares.is_empty() {
                None
            } else {
                Some(
                    shares
                        .into_iter()
                        .map(|(user_id, permission)| DocumentShare {
                            user_id: user_id.to_string(),
                            user_name: "User".to_string(),
                            permission: permission.to_string(),
                            shared_at: 0,
                        })
                        .collect(),
                )
            },
            last_modified_by: None,
            last_modified_by_name: None,
        }
    }

    #[test]
    fn test_owner_permission() {
        let metadata = make_metadata("user-1", vec![]);
        assert_eq!(
            get_user_permission(&metadata, "user-1", None),
            Permission::Owner
        );
    }

    #[test]
    fn test_admin_has_owner_permission() {
        // Admins have implicit Owner access for management purposes
        let metadata = make_metadata("user-1", vec![]);
        assert_eq!(
            get_user_permission(&metadata, "user-2", Some("admin")),
            Permission::Owner
        );
    }

    #[test]
    fn test_admin_can_manage_any_document() {
        let metadata = make_metadata("user-1", vec![]);
        let permission = get_user_permission(&metadata, "admin-user", Some("admin"));
        
        // Admin should have full management capabilities
        assert!(permission.can_read());
        assert!(permission.can_write());
        assert!(permission.can_delete());
        assert!(permission.can_manage_shares());
    }

    #[test]
    fn test_owner_takes_precedence_over_share() {
        // Even if owner is in shares with lower permission, they're still owner
        let metadata = make_metadata("user-1", vec![("user-1", "view")]);
        assert_eq!(
            get_user_permission(&metadata, "user-1", None),
            Permission::Owner
        );
    }

    #[test]
    fn test_explicit_share() {
        let metadata = make_metadata("user-1", vec![("user-2", "edit"), ("user-3", "view")]);
        assert_eq!(
            get_user_permission(&metadata, "user-2", None),
            Permission::Editor
        );
        assert_eq!(
            get_user_permission(&metadata, "user-3", None),
            Permission::Viewer
        );
    }

    #[test]
    fn test_no_access() {
        let metadata = make_metadata("user-1", vec![]);
        assert_eq!(
            get_user_permission(&metadata, "user-2", None),
            Permission::None
        );
    }

    #[test]
    fn test_no_access_with_user_role() {
        // Non-admin user role should not grant access
        let metadata = make_metadata("user-1", vec![]);
        assert_eq!(
            get_user_permission(&metadata, "user-2", Some("user")),
            Permission::None
        );
    }

    #[test]
    fn test_permission_ordering() {
        assert!(Permission::Owner > Permission::Editor);
        assert!(Permission::Editor > Permission::Viewer);
        assert!(Permission::Viewer > Permission::None);
    }

    #[test]
    fn test_permission_capabilities() {
        assert!(Permission::Owner.can_read());
        assert!(Permission::Owner.can_write());
        assert!(Permission::Owner.can_delete());
        assert!(Permission::Owner.can_manage_shares());

        assert!(Permission::Editor.can_read());
        assert!(Permission::Editor.can_write());
        assert!(!Permission::Editor.can_delete());
        assert!(!Permission::Editor.can_manage_shares());

        assert!(Permission::Viewer.can_read());
        assert!(!Permission::Viewer.can_write());
        assert!(!Permission::Viewer.can_delete());
        assert!(!Permission::Viewer.can_manage_shares());

        assert!(!Permission::None.can_read());
        assert!(!Permission::None.can_write());
        assert!(!Permission::None.can_delete());
        assert!(!Permission::None.can_manage_shares());
    }

    #[test]
    fn test_permission_from_str() {
        assert_eq!(Permission::from_str("owner"), Permission::Owner);
        assert_eq!(Permission::from_str("edit"), Permission::Editor);
        assert_eq!(Permission::from_str("editor"), Permission::Editor);
        assert_eq!(Permission::from_str("view"), Permission::Viewer);
        assert_eq!(Permission::from_str("viewer"), Permission::Viewer);
        assert_eq!(Permission::from_str("invalid"), Permission::None);
        assert_eq!(Permission::from_str(""), Permission::None);
    }

    #[test]
    fn test_permission_as_str() {
        assert_eq!(Permission::Owner.as_str(), "owner");
        assert_eq!(Permission::Editor.as_str(), "edit");
        assert_eq!(Permission::Viewer.as_str(), "view");
        assert_eq!(Permission::None.as_str(), "none");
    }
}
