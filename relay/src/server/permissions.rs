//! Document authorization (JP-457).
//!
//! Access is resolved by walking an ordered list of **grant sources**, each of
//! which either *grants* a permission level or *caps* one. The effective
//! permission is the highest grant, clamped by the lowest cap.
//!
//! This shape replaces an if-ladder. The ladder itself was fine; what wasn't is
//! that the *decision to consult it* lived in ~20 call sites, five of which
//! checked `enforce_private_docs` and fifteen of which didn't — so document
//! content was readable and writable over the WebSocket sync path while REST
//! refused it. Folding the flag into the resolver means no call site can
//! forget it. [`crate::server::ServerState::authorize`] is the single entry
//! point; the `check_*_permission` helpers below are thin wrappers over it.
//!
//! Adding a source is the extension point: collection-level grants and public
//! visibility are each one entry in [`resolve`], not another branch in another
//! handler.

use super::documents::{DocumentMetadata, DocumentStore};
use super::protocol::{DocId, WorkspaceId};
use crate::auth::WorkspaceRole;

/// Who is asking.
///
/// Deliberately an enum rather than `user_id: Option<&str>`. The absent-user
/// case is currently the loopback MCP token — a *fully trusted* caller — and
/// public documents will introduce an unauthenticated visitor, which is the
/// exact opposite. Conflating the two behind one `None` is how a public-docs
/// change would silently hand workspace authority to anonymous callers.
#[derive(Debug, Clone, Copy)]
pub enum Principal<'a> {
    /// The static loopback MCP token: no user identity, full workspace
    /// authority. Mirrors `ToolContext::ensure_doc_permission`.
    Service,
    /// An authenticated member of the workspace.
    User {
        user_id: &'a str,
        workspace_role: WorkspaceRole,
    },
    /// An unauthenticated caller. Grants nothing today; the seam public
    /// documents will resolve against once a `visibility` source exists.
    Anonymous,
}

impl<'a> Principal<'a> {
    /// The user id, when the principal has one. Service and anonymous callers
    /// have no identity to compare against `owner_id`.
    pub fn user_id(&self) -> Option<&'a str> {
        match self {
            Principal::User { user_id, .. } => Some(user_id),
            _ => None,
        }
    }
}

/// What is being asked about. One field today; the commented growth points are
/// the whole reason this is a struct rather than a bare `&DocumentMetadata`.
#[derive(Debug, Clone, Copy)]
pub struct ResourceContext<'a> {
    pub document: &'a DocumentMetadata,
    // Growth points — adding either is a new source in `resolve`, nothing else:
    //   pub collection: Option<&'a CollectionGrants>,
    //   pub visibility: Visibility,
}

impl<'a> ResourceContext<'a> {
    pub fn new(document: &'a DocumentMetadata) -> Self {
        Self { document }
    }
}

/// Resolve the effective permission for `principal` on `ctx`.
///
/// `enforce` is `config.permissions.enforce_private_docs`. When false, the
/// deployment has opted out of per-document privacy and any workspace member
/// may edit — which is what the old flag-off path *claimed* but did not do.
///
/// Sources are applied in order; grants accumulate as a maximum, caps as a
/// minimum, and the result is `max(grants).min(min(caps))`.
pub fn resolve(principal: &Principal, ctx: &ResourceContext, enforce: bool) -> Permission {
    let (user_id, workspace_role) = match principal {
        // Trusted loopback caller — manages the whole workspace.
        Principal::Service => return Permission::Owner,
        // No identity, and no visibility source exists to grant against yet.
        Principal::Anonymous => return Permission::None,
        Principal::User { user_id, workspace_role } => (*user_id, *workspace_role),
    };

    let doc = ctx.document;
    let mut granted = Permission::None;

    // GRANT: enforcement disabled → workspace-scoped editing for any member.
    if !enforce {
        granted = granted.max(Permission::Editor);
    }

    // GRANT: the document's owner.
    if doc.owner_id.as_deref() == Some(user_id) {
        granted = granted.max(Permission::Owner);
    }

    // GRANT: workspace owners manage every document in the workspace. This is
    // the inheritance the editor's access panel draws as "via workspace".
    if workspace_role == WorkspaceRole::Owner {
        granted = granted.max(Permission::Owner);
    }

    // GRANT: legacy documents with no recorded owner stay workspace-visible.
    //
    // The relay historically never assigned ownership — it read `ownerId` out
    // of the client-sent body, and the editor doesn't send one — so documents
    // predating the write-path stamp have no owner at all. Without this they
    // become unreachable by everyone except workspace owners, including the
    // person who created them. `Editor` and not `Viewer` deliberately: the
    // holder must be able to *write* the document, because the write is what
    // stamps a real owner and drains this carve-out toward zero.
    if doc.owner_id.is_none() {
        granted = granted.max(Permission::Editor);
    }

    // GRANT: explicit per-document shares.
    if let Some(shares) = &doc.shared_with {
        for share in shares {
            if share.user_id == user_id {
                granted = granted.max(Permission::from_str(&share.permission));
            }
        }
    }

    // CAP: the workspace Viewer role is a ceiling, not a starting point. A
    // share cannot promote a read-only member to a writer — the invite copy
    // promises "read-only, even where shared". This is the first cap-kind
    // source; future read-only access policies reuse the shape.
    //
    // The cap applies even to a Viewer who owns the document. That is the
    // stricter reading, and the safe one: the fix for a viewer who needs to
    // edit is to change their workspace role, not to leave a hole here.
    let cap = if workspace_role == WorkspaceRole::Viewer {
        Permission::Viewer
    } else {
        Permission::Owner
    };

    granted.min(cap)
}

/// Owner recorded for a document created through the static loopback MCP token,
/// which authenticates an integration rather than a person.
///
/// Such a document has no human creator to attribute, but it must not be left
/// *unowned* — `owner_id: None` means "legacy document from before the write
/// path stamped owners" and grants every workspace member Editor. Leaving
/// agent-created documents in that bucket would make every one of them readable
/// by anyone else's MCP session in the workspace.
///
/// No real `sub` can collide with this value, so the document resolves to
/// exactly: the service principal (Owner), workspace owners (Owner), and
/// nobody else — until somebody shares it deliberately.
pub const SERVICE_OWNER_MCP: &str = "service:mcp";

/// Display name paired with [`SERVICE_OWNER_MCP`], so the editor's access panel
/// shows a person-shaped label instead of a raw id it can't resolve.
pub const SERVICE_OWNER_MCP_NAME: &str = "MCP integration";

/// Count of documents in `metadata` carrying no owner — the size of the legacy
/// carve-out in [`resolve`]. Surfaced so the population is measurable rather
/// than assumed; it should trend to zero as documents are written.
///
/// Service-owned documents are *not* counted: they have an owner, deliberately.
pub fn unowned_count<'a>(docs: impl IntoIterator<Item = &'a DocumentMetadata>) -> usize {
    docs.into_iter().filter(|m| m.owner_id.is_none()).count()
}

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

/// Effective permission for a principal on one document's metadata.
///
/// Thin wrapper over [`resolve`] for call sites that already hold metadata and
/// don't need a store lookup (the listing filters, blob read checks).
pub fn get_user_permission(
    metadata: &DocumentMetadata,
    principal: &Principal,
    enforce: bool,
) -> Permission {
    resolve(principal, &ResourceContext::new(metadata), enforce)
}

/// Check that `principal` holds at least `required` on the document.
///
/// `enforce` must come from `ServerState::enforce_private_docs()` — prefer
/// [`crate::server::ServerState::authorize`], which supplies it for you, over
/// calling this directly.
pub fn check_permission(
    doc_store: &DocumentStore,
    ws: &WorkspaceId,
    doc_id: &DocId,
    principal: &Principal,
    enforce: bool,
    required: Permission,
) -> Result<Permission, PermissionError> {
    // An authenticated identity is still required for anything that isn't the
    // trusted loopback caller: `Anonymous` has nothing to resolve against, and
    // an empty user id is a malformed token, not a valid principal.
    match principal {
        Principal::Service => {}
        Principal::User { user_id, .. } if !user_id.is_empty() => {}
        _ => return Err(PermissionError::NotAuthenticated),
    }

    let metadata = doc_store
        .get_metadata(ws, doc_id)
        .ok_or(PermissionError::DocumentNotFound)?;

    let actual = resolve(principal, &ResourceContext::new(&metadata), enforce);

    if actual >= required {
        Ok(actual)
    } else {
        Err(PermissionError::AccessDenied { required, actual })
    }
}

/// Check read permission (at least Viewer)
pub fn check_read_permission(
    doc_store: &DocumentStore,
    ws: &WorkspaceId,
    doc_id: &DocId,
    principal: &Principal,
    enforce: bool,
) -> Result<Permission, PermissionError> {
    check_permission(doc_store, ws, doc_id, principal, enforce, Permission::Viewer)
}

/// Check write permission (at least Editor)
pub fn check_write_permission(
    doc_store: &DocumentStore,
    ws: &WorkspaceId,
    doc_id: &DocId,
    principal: &Principal,
    enforce: bool,
) -> Result<Permission, PermissionError> {
    check_permission(doc_store, ws, doc_id, principal, enforce, Permission::Editor)
}

/// Check delete permission (requires Owner)
pub fn check_delete_permission(
    doc_store: &DocumentStore,
    ws: &WorkspaceId,
    doc_id: &DocId,
    principal: &Principal,
    enforce: bool,
) -> Result<Permission, PermissionError> {
    check_permission(doc_store, ws, doc_id, principal, enforce, Permission::Owner)
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

    fn make_metadata(owner_id: Option<&str>, shares: Vec<(&str, &str)>) -> DocumentMetadata {
        DocumentMetadata {
            id: DocId::from_http_path("doc-1".to_string()).unwrap(),
            name: "Test".to_string(),
            page_count: 1,
            prose_page_count: None,
            size_bytes: None,
            modified_at: 0,
            created_at: 0,
            is_relay_document: Some(true),
            server_version: None,
            locked_by: None,
            locked_by_name: None,
            locked_at: None,
            owner_id: owner_id.map(String::from),
            owner_name: owner_id.map(|_| "Owner".to_string()),
            collection_id: None,
            tags: None,
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

    fn user(id: &str, role: WorkspaceRole) -> Principal<'_> {
        Principal::User { user_id: id, workspace_role: role }
    }

    // ========================================================
    // The shared matrix — see relay/tests/fixtures/permission-matrix.json
    // ========================================================

    /// Drives [`resolve`] from the same table the editor's mirror test reads.
    /// A row that disagrees fails in whichever language drifted, which is the
    /// entire point: client/relay divergence becomes a red test rather than
    /// something a person notices while building a UI.
    #[test]
    fn matrix_fixture_matches_the_resolver() {
        let raw = include_str!("../../tests/fixtures/permission-matrix.json");
        let fixture: serde_json::Value =
            serde_json::from_str(raw).expect("permission-matrix.json parses");
        let cases = fixture["cases"].as_array().expect("cases array");
        assert!(!cases.is_empty(), "fixture must not be empty");

        for case in cases {
            let name = case["name"].as_str().unwrap_or("<unnamed>");
            let enforce = case["enforce"].as_bool().expect("enforce bool");

            let doc = &case["document"];
            let owner = doc["ownerId"].as_str();
            let shares: Vec<(&str, &str)> = doc["sharedWith"]
                .as_array()
                .map(|arr| {
                    arr.iter()
                        .map(|s| {
                            (
                                s["userId"].as_str().expect("share userId"),
                                s["permission"].as_str().expect("share permission"),
                            )
                        })
                        .collect()
                })
                .unwrap_or_default();
            let metadata = make_metadata(owner, shares);

            let p = &case["principal"];
            let principal = match p["kind"].as_str().expect("principal kind") {
                "service" => Principal::Service,
                "anonymous" => Principal::Anonymous,
                "user" => Principal::User {
                    user_id: p["userId"].as_str().expect("userId"),
                    workspace_role: match p["workspaceRole"].as_str().expect("workspaceRole") {
                        "owner" => WorkspaceRole::Owner,
                        "member" => WorkspaceRole::Member,
                        "viewer" => WorkspaceRole::Viewer,
                        other => panic!("unknown workspaceRole {other:?} in case {name:?}"),
                    },
                },
                other => panic!("unknown principal kind {other:?} in case {name:?}"),
            };

            let expected = match case["expect"].as_str().expect("expect") {
                "owner" => Permission::Owner,
                "editor" => Permission::Editor,
                "viewer" => Permission::Viewer,
                "none" => Permission::None,
                other => panic!("unknown expect {other:?} in case {name:?}"),
            };

            let actual = resolve(&principal, &ResourceContext::new(&metadata), enforce);
            assert_eq!(actual, expected, "matrix case failed: {name}");
        }
    }

    // ========================================================
    // Focused cases — the invariants worth naming individually
    // ========================================================

    #[test]
    fn owner_outranks_a_self_share() {
        let metadata = make_metadata(Some("user-1"), vec![("user-1", "view")]);
        assert_eq!(
            resolve(&user("user-1", WorkspaceRole::Member), &ResourceContext::new(&metadata), true),
            Permission::Owner
        );
    }

    #[test]
    fn membership_alone_grants_nothing() {
        let metadata = make_metadata(Some("user-1"), vec![]);
        assert_eq!(
            resolve(&user("user-2", WorkspaceRole::Member), &ResourceContext::new(&metadata), true),
            Permission::None
        );
    }

    /// The workspace Viewer role is a ceiling, not a floor. A share must never
    /// promote a read-only member — the invite copy promises exactly this.
    #[test]
    fn viewer_role_caps_an_edit_share() {
        let metadata = make_metadata(Some("user-1"), vec![("user-2", "edit")]);
        assert_eq!(
            resolve(&user("user-2", WorkspaceRole::Viewer), &ResourceContext::new(&metadata), true),
            Permission::Viewer
        );
    }

    #[test]
    fn viewer_role_caps_even_document_ownership() {
        let metadata = make_metadata(Some("user-2"), vec![]);
        assert_eq!(
            resolve(&user("user-2", WorkspaceRole::Viewer), &ResourceContext::new(&metadata), true),
            Permission::Viewer
        );
    }

    /// Disabling enforcement opts the deployment out of per-document privacy.
    /// It must not also dissolve the Viewer ceiling.
    #[test]
    fn enforcement_off_opens_documents_but_keeps_the_viewer_cap() {
        let metadata = make_metadata(Some("user-1"), vec![]);
        assert_eq!(
            resolve(&user("user-2", WorkspaceRole::Member), &ResourceContext::new(&metadata), false),
            Permission::Editor
        );
        assert_eq!(
            resolve(&user("user-3", WorkspaceRole::Viewer), &ResourceContext::new(&metadata), false),
            Permission::Viewer
        );
    }

    /// A legacy document with no recorded owner stays reachable, and at Editor
    /// specifically — the holder must be able to write it, because the write is
    /// what stamps a real owner and drains the carve-out.
    #[test]
    fn unowned_document_is_workspace_visible_and_writable() {
        let metadata = make_metadata(None, vec![]);
        assert_eq!(
            resolve(&user("anyone", WorkspaceRole::Member), &ResourceContext::new(&metadata), true),
            Permission::Editor
        );
    }

    /// `Service` (the loopback MCP token) and `Anonymous` both lack a user id
    /// but sit at opposite ends of trust. If these ever collapse into one case,
    /// public documents would hand workspace authority to unauthenticated
    /// callers.
    #[test]
    fn service_and_anonymous_are_opposites() {
        let metadata = make_metadata(Some("user-1"), vec![]);
        assert_eq!(
            resolve(&Principal::Service, &ResourceContext::new(&metadata), true),
            Permission::Owner
        );
        assert_eq!(
            resolve(&Principal::Anonymous, &ResourceContext::new(&metadata), true),
            Permission::None
        );
    }

    #[test]
    fn unowned_count_reports_the_carve_out_population() {
        let owned = make_metadata(Some("user-1"), vec![]);
        let orphan = make_metadata(None, vec![]);
        assert_eq!(unowned_count([&owned, &orphan, &orphan]), 2);
        assert_eq!(unowned_count([&owned]), 0);
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

    /// One canonical spelling of the role on the wire (JP-457).
    #[test]
    fn workspace_role_has_a_single_spelling() {
        assert_eq!(WorkspaceRole::Owner.as_str(), "owner");
        assert_eq!(WorkspaceRole::Member.as_str(), "member");
        assert_eq!(WorkspaceRole::Viewer.as_str(), "viewer");
    }
}
