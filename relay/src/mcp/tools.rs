//! MCP tool surface for DocuShark, all namespaced `docushark_*`.
//!
//! Reads:   list_documents, get_document, get_page, get_shape, get_prose,
//!          get_outline
//! Authoring (JP-93 "publish target"): create_document
//! Document manage (JP-350): rename_document, delete_document
//! Diagram writes: add_shape, add_shapes, connect, update_shape,
//!                 generate_diagram
//! Prose writes:   add_prose_page, set_prose, rename_prose_page,
//!                 insert_section, restructure_outline
//! Manage (JP-246/247): delete_shape (cascade connectors), delete_prose_page,
//!                 reorder_shapes, reorder_prose_pages
//!
//! A "document" carries both a diagram canvas (`pages` → shapes) and a
//! written body (`richTextPages`, multi-page TipTap prose stored as HTML).
//! All write tools target the team store (`ctx.team`), refuse local
//! renderer-owned docs, and persist through `mutate_with_retry` so a
//! concurrent collaborator edit is never clobbered (optimistic concurrency
//! on `serverVersion`).

use std::sync::Arc;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::server::documents::{DocumentStore, SaveOutcome};
use crate::server::protocol::{DocId, WorkspaceId};
use crate::sync::{DocHandle, DocRegistry};

use super::DocDeletedSink;
use super::adapter::{
    apply_dsl_patch, dsl_fixes, dsl_patch_fixes, dsl_to_shape_json, shape_json_to_dsl, DslPatch,
    DslShape, FixAction, ShapeFix,
};
use super::local_mirror::LocalDocumentMirror;
use super::outline::{clamp_level, escape_html, Outline, Section};
use super::layout::{layout_and_route, layout_diagram, LayoutMode, NodeSpec, NODE_H, NODE_W};

/// Type base for canvas (diagram) pages — mirror of `CANVAS_PAGE_BASE` in
/// `src/store/pageNaming.ts`.
const CANVAS_PAGE_BASE: &str = "Canvas";
/// Type base for prose (rich-text) pages — mirror of `PROSE_PAGE_BASE` in
/// `src/store/pageNaming.ts`.
const PROSE_PAGE_BASE: &str = "Prose";

/// Next default page name for a type `base`: the bare `base` for the first page,
/// `${base} p.${n}` thereafter with **monotonic max+1** (the bare base counts as
/// `p.1`; deleted numbers are never reused). Twin of `nextDefaultPageName` in
/// `src/store/pageNaming.ts` — keep the two in sync.
fn next_default_page_name<'a>(base: &str, existing_names: impl Iterator<Item = &'a str>) -> String {
    let prefix = format!("{} p.", base);
    let mut max: u64 = 0;
    let mut saw_base = false;
    for name in existing_names {
        if name == base {
            saw_base = true;
            max = max.max(1);
            continue;
        }
        if let Some(rest) = name.strip_prefix(&prefix) {
            if let Ok(n) = rest.parse::<u64>() {
                if n > 0 {
                    max = max.max(n);
                }
            }
        }
    }
    if max == 0 && !saw_base {
        return base.to_string();
    }
    format!("{} p.{}", base, max + 1)
}

/// Collect the `name` of every page in a `pages` object (canvas `doc["pages"]`
/// or prose `richTextPages["pages"]`), for default-name numbering.
fn page_names(pages: Option<&Value>) -> Vec<String> {
    pages
        .and_then(|v| v.as_object())
        .map(|m| {
            m.values()
                .filter_map(|p| p.get("name").and_then(|n| n.as_str()).map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

/// Where a document came from, surfaced in MCP tool results so clients
/// know whether they're looking at a team-shared or a (read-only) local
/// mirror of a renderer-owned document.
const SOURCE_TEAM: &str = "team";
const SOURCE_LOCAL: &str = "local";

/// Bundle of stores + flags passed to tool handlers. The tools used to
/// receive only the team `DocumentStore`; this grew when local-document
/// mirroring was added so the foundation could read renderer-owned docs
/// alongside team-shared ones.
pub struct ToolContext<'a> {
    pub team: &'a Arc<DocumentStore>,
    pub local: &'a Arc<LocalDocumentMirror>,
    pub local_enabled: bool,
    /// Workspace the MCP request authenticates against. Derived in
    /// `transport::authenticate` from either the static MCP token
    /// (→ `single_tenant()`) or a relay JWT's `wsp` claim. Threaded
    /// through every team/local storage call.
    pub workspace_id: WorkspaceId,
    /// JP-370: the authenticated caller's user id, for the per-document access
    /// gate. `None` for the static loopback MCP token (no user identity →
    /// treated as workspace admin; the desktop / self-host flow is unaffected).
    pub user_id: Option<String>,
    /// JP-370: the caller's workspace role string (`"owner"` short-circuits to
    /// full access). Paired with `user_id`.
    pub user_role: Option<String>,
    /// JP-370: whether to enforce per-document access for JWT callers. Mirrors
    /// `config.permissions.enforce_private_docs`; `false` (default) keeps the
    /// legacy workspace-scoped behaviour.
    pub enforce_private_docs: bool,
    /// Authoritative Y.Doc registry (JP-34). When a shape write targets a
    /// doc that's resident here *and* the doc's hydrated active page, the
    /// write applies to the live Y.Doc (JP-35) and is broadcast to peers,
    /// instead of rewriting the lagging JSON snapshot.
    pub registry: &'a Arc<DocRegistry>,
    /// Sink for live-path CRDT deltas. See [`OnDocUpdate`].
    pub on_doc_update: &'a OnDocUpdate,
    /// Sink invoked by `delete_document` after the store delete to run the
    /// Deleted-event broadcast + blob release (JP-350). See [`DocDeletedSink`].
    pub on_doc_deleted: &'a Arc<DocDeletedSink>,
}

/// Callback the MCP write path invokes to push a framed CRDT sync update to
/// the clients joined to `(workspace, doc)` — wired to the WS server's
/// `broadcast_to_doc` (JP-35). Synchronous (a `broadcast::Sender::send`), so
/// it's safe to call from the sync tool-dispatch path.
pub type OnDocUpdate = dyn Fn(&WorkspaceId, &DocId, Vec<u8>) + Send + Sync;

impl ToolContext<'_> {
    /// Push a framed CRDT update to the clients joined to this request's
    /// workspace + `doc_id`.
    fn broadcast_update(&self, doc_id: &DocId, framed: Vec<u8>) {
        (self.on_doc_update)(&self.workspace_id, doc_id, framed);
    }

    /// JP-370: enforce per-document access for a JWT caller. Returns the
    /// permission error string when the caller lacks `required` on a *team*
    /// document, else `Ok`. Bypassed entirely when enforcement is off or the
    /// caller is the static loopback token (`user_id == None`, treated as
    /// admin). A doc that isn't a team document (unknown id, or a local-mirror
    /// doc) is left to the tool's own not-found / `reject_if_local` handling —
    /// we only gate documents the team store actually owns.
    fn ensure_doc_permission(
        &self,
        doc_id: &DocId,
        required: crate::server::permissions::Permission,
    ) -> Result<(), String> {
        let Some(user_id) = self.user_id.as_deref() else {
            return Ok(()); // static loopback token → workspace admin
        };
        if !self.enforce_private_docs {
            return Ok(());
        }
        // Only gate team documents; absence here means "not a team doc" and the
        // caller's normal path reports not-found / handles the local mirror.
        if self.team.get_metadata(&self.workspace_id, doc_id).is_none() {
            return Ok(());
        }
        match crate::server::permissions::check_permission(
            self.team,
            &self.workspace_id,
            doc_id,
            Some(user_id),
            self.user_role.as_deref(),
            required,
        ) {
            Ok(_) => Ok(()),
            Err(e) => Err(crate::server::permissions::to_error_string(&e)),
        }
    }
}

/// JP-370: classify an MCP tool by the per-document access it requires.
/// `None` means the tool isn't gated by a single document (creation, the
/// catalogue/skills/icons tools, and `list_documents`, which filters its own
/// output). Reads require Viewer; writes require Editor; `delete_document`
/// requires Owner, matching the REST surface.
fn tool_required_permission(name: &str) -> Option<crate::server::permissions::Permission> {
    use crate::server::permissions::Permission;
    match name {
        // No specific target document.
        "docushark_list_documents"
        | "docushark_create_document"
        | "docushark_get_skills"
        | "docushark_list_icons"
        | "docushark_resolve_doi" => None,
        // Owner-only (matches REST DELETE /api/docs/:id).
        "docushark_delete_document" => Some(Permission::Owner),
        // Read-only tools.
        "docushark_get_document"
        | "docushark_get_page"
        | "docushark_get_shape"
        | "docushark_get_prose"
        | "docushark_get_outline"
        | "docushark_list_references"
        | "docushark_list_fields" => Some(Permission::Viewer),
        // Everything else mutates a specific existing document → Editor.
        _ => Some(Permission::Editor),
    }
}

/// A single MCP tool descriptor (name, description, input schema).
pub struct ToolDescriptor {
    pub name: &'static str,
    pub description: &'static str,
    pub input_schema: Value,
}

/// Return the list of foundation tools advertised via `tools/list`.
pub fn descriptors() -> Vec<ToolDescriptor> {
    vec![
        ToolDescriptor {
            name: "docushark_list_documents",
            description:
                "List DocuShark team documents stored on this host. Returns id, name, modifiedAt, and page counts for each: pageCount (canvas + prose total), with canvasPageCount and prosePageCount giving the breakdown (a document has a diagram canvas and a separate prose body).",
            input_schema: json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }),
        },
        ToolDescriptor {
            name: "docushark_get_document",
            description:
                "Return a document by id: top-level metadata plus a list of pages with their ids and names.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "docId": {"type": "string"}
                },
                "required": ["docId"],
                "additionalProperties": false
            }),
        },
        ToolDescriptor {
            name: "docushark_get_page",
            description:
                "Return the shapes on a single page as DSL objects. Shape kinds outside the foundation set (rectangle/ellipse/text) are returned in a generic form.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "docId": {"type": "string"},
                    "pageId": {"type": "string"}
                },
                "required": ["docId", "pageId"],
                "additionalProperties": false
            }),
        },
        ToolDescriptor {
            name: "docushark_get_shape",
            description:
                "Return a single shape (by id) on a page as a DSL object — the read-one companion to get_page. Useful to inspect a shape before update_shape/delete_shape.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "docId": {"type": "string"},
                    "pageId": {"type": "string"},
                    "id": {"type": "string", "description": "The shape id."}
                },
                "required": ["docId", "pageId", "id"],
                "additionalProperties": false
            }),
        },
        ToolDescriptor {
            name: "docushark_create_document",
            description:
                "Create a new, empty DocuShark document in the current workspace and return its id. The document starts with one blank canvas page (for diagrams) and one blank prose page (for text) — use add_shapes/connect to draw and the prose tools to write. This is the entry point for an agent authoring a document from scratch.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "Title for the new document. Defaults to \"Untitled Document\"."
                    }
                },
                "additionalProperties": false
            }),
        },
        ToolDescriptor {
            name: "docushark_rename_document",
            description:
                "Rename a document (set its title). Updates the document name live for anyone who has it open. Refuses local (renderer-owned) documents.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "docId": {"type": "string"},
                    "name": {"type": "string", "description": "New document title. Must not be empty."}
                },
                "required": ["docId", "name"],
                "additionalProperties": false
            }),
        },
        ToolDescriptor {
            name: "docushark_delete_document",
            description:
                "Permanently delete a document and all its pages, prose, and blobs. This cannot be undone on the server; anyone currently viewing it has it moved to their local Trash. Refuses local (renderer-owned) documents.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "docId": {"type": "string"}
                },
                "required": ["docId"],
                "additionalProperties": false
            }),
        },
        ToolDescriptor {
            name: "docushark_get_prose",
            description:
                "Read a document's prose (the written body, separate from the diagram canvas). With no pageId, returns every prose page (id, name, order, HTML content); with a pageId, returns just that page. Prose is stored as HTML.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "docId": {"type": "string"},
                    "pageId": {"type": "string", "description": "Optional prose page id; omit to get all prose pages."}
                },
                "required": ["docId"],
                "additionalProperties": false
            }),
        },
        ToolDescriptor {
            name: "docushark_add_prose_page",
            description:
                "Add a new prose page to a document and return its id. Content is Markdown by default (set format:\"html\" to pass HTML through). Use this to start a new section/chapter of the written document. Unsure what valid content looks like? Call get_skills first for the content contract.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "docId": {"type": "string"},
                    "name": {"type": "string", "description": "Page title. Defaults to \"Prose\" for the first page, then \"Prose p.2\", \"Prose p.3\", …"},
                    "content": {"type": "string", "maxLength": MAX_PROSE_CONTENT_BYTES, "description": "Initial body. Markdown unless format is \"html\". Optional (blank page if omitted). Capped at ~1 MiB."},
                    "format": {"type": "string", "enum": ["markdown", "html"], "description": "Interpretation of content. Default: \"markdown\"."}
                },
                "required": ["docId"],
                "additionalProperties": false
            }),
        },
        ToolDescriptor {
            name: "docushark_set_prose",
            description:
                "Write a prose page. By default replaces the entire page body with 'content'. For a TARGETED edit, pass 'anchor' (the current text of the block to change): then 'content' replaces only that block, leaving the rest of the page untouched — preferred when editing one part of a longer page. The anchor must match exactly one block (it doubles as a confirmation lock; if it matches none or several you get an ERR_ANCHOR_* error — read the page first and copy the block's text). Content is Markdown by default (set format:\"html\"). Refuses local (renderer-owned) documents. Unsure what valid content looks like? Call get_skills first for the content contract.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "docId": {"type": "string"},
                    "pageId": {"type": "string"},
                    "content": {"type": "string", "maxLength": MAX_PROSE_CONTENT_BYTES, "description": "New content. The whole page body, or — with 'anchor' — just the replacement for the matched block(s). Markdown unless format is \"html\". Capped at ~1 MiB."},
                    "format": {"type": "string", "enum": ["markdown", "html"], "description": "Interpretation of content. Default: \"markdown\"."},
                    "anchor": {"type": "string", "description": "Optional. The current text of the block to replace (a targeted edit). Must match exactly one top-level block; whitespace is normalized and styling/marks are ignored. Omit to replace the whole page."},
                    "anchorUntil": {"type": "string", "description": "Optional. With 'anchor', replace the inclusive span of blocks from 'anchor' through the block matching this text."}
                },
                "required": ["docId", "pageId", "content"],
                "additionalProperties": false
            }),
        },
        ToolDescriptor {
            name: "docushark_rename_prose_page",
            description:
                "Rename a prose page. Refuses local documents.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "docId": {"type": "string"},
                    "pageId": {"type": "string"},
                    "name": {"type": "string"}
                },
                "required": ["docId", "pageId", "name"],
                "additionalProperties": false
            }),
        },
        ToolDescriptor {
            name: "docushark_add_canvas_page",
            description:
                "Add a new (blank) canvas page to a document and return its id. Use this to start a second diagram in the same document; target it with the returned id in add_shape(s)/generate_diagram. Refuses local documents.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "docId": {"type": "string"},
                    "name": {"type": "string", "description": "Page title. Defaults to \"Canvas\" for the first page, then \"Canvas p.2\", \"Canvas p.3\", …"}
                },
                "required": ["docId"],
                "additionalProperties": false
            }),
        },
        ToolDescriptor {
            name: "docushark_rename_canvas_page",
            description:
                "Rename a canvas page. Refuses local documents.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "docId": {"type": "string"},
                    "pageId": {"type": "string"},
                    "name": {"type": "string"}
                },
                "required": ["docId", "pageId", "name"],
                "additionalProperties": false
            }),
        },
        ToolDescriptor {
            name: "docushark_reorder_canvas_page",
            description:
                "Set the order of a document's canvas pages. 'order' must be a permutation of the current canvas page ids. Refuses local documents.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "docId": {"type": "string"},
                    "order": {"type": "array", "items": {"type": "string"}}
                },
                "required": ["docId", "order"],
                "additionalProperties": false
            }),
        },
        ToolDescriptor {
            name: "docushark_delete_canvas_page",
            description:
                "Delete a canvas page by id. Refuses to delete the last remaining canvas page. Repoints the active page if the deleted one was active. Refuses local documents.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "docId": {"type": "string"},
                    "pageId": {"type": "string"}
                },
                "required": ["docId", "pageId"],
                "additionalProperties": false
            }),
        },
        ToolDescriptor {
            name: "docushark_get_outline",
            description:
                "Return the heading outline of a prose page as an ordered list of { index, level, title }. 'index' is the 0-based heading position used by insert_section and restructure_outline. Sections are flat: nesting is conveyed by 'level' (1–6), not containment.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "docId": {"type": "string"},
                    "pageId": {"type": "string"}
                },
                "required": ["docId", "pageId"],
                "additionalProperties": false
            }),
        },
        ToolDescriptor {
            name: "docushark_insert_section",
            description:
                "Insert a new section (a heading plus optional body) into a prose page. Body is Markdown by default (set format:\"html\"). Place it with position:\"start\"|\"end\" (default \"end\"), or afterIndex to drop it right after an existing heading's section. Refuses local documents.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "docId": {"type": "string"},
                    "pageId": {"type": "string"},
                    "level": {"type": "integer", "minimum": 1, "maximum": 6, "description": "Heading level 1–6."},
                    "title": {"type": "string", "description": "Heading text (plain)."},
                    "body": {"type": "string", "description": "Optional section body below the heading."},
                    "format": {"type": "string", "enum": ["markdown", "html"], "description": "Interpretation of body. Default: \"markdown\"."},
                    "position": {"type": "string", "enum": ["start", "end"], "description": "Where to insert when afterIndex is absent. Default: \"end\"."},
                    "afterIndex": {"type": "integer", "minimum": 0, "description": "Insert after the section at this 0-based heading index (takes precedence over position)."}
                },
                "required": ["docId", "pageId", "level", "title"],
                "additionalProperties": false
            }),
        },
        ToolDescriptor {
            name: "docushark_restructure_outline",
            description:
                "Restructure a prose page's outline. op=\"promote\" makes a heading more prominent (level −1), \"demote\" less (level +1), \"move\" relocates a section to toIndex. 'index' is the 0-based heading index from get_outline. Returns the updated outline. Refuses local documents.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "docId": {"type": "string"},
                    "pageId": {"type": "string"},
                    "op": {"type": "string", "enum": ["promote", "demote", "move"]},
                    "index": {"type": "integer", "minimum": 0, "description": "0-based heading index to act on."},
                    "toIndex": {"type": "integer", "minimum": 0, "description": "Target section index for op=\"move\"."}
                },
                "required": ["docId", "pageId", "op", "index"],
                "additionalProperties": false
            }),
        },
        ToolDescriptor {
            name: "docushark_generate_diagram",
            description:
                "Generate a whole diagram in one call from a graph of nodes and edges. Each node becomes a labelled shape (rectangle by default, or ellipse); each edge becomes a connector between two nodes. The relay auto-positions everything: \"layered\" (top-down by edge direction with crossing minimization, good for flow/architecture diagrams; the default when edges exist) or \"grid\". Connectors attach to typed anchors and by default are routed orthogonally around intervening shapes with explicit waypoints; pass routing \"straight\" for plain anchor-to-anchor lines. Reference nodes in edges by their caller-supplied 'id'. Returns the map of node id → created shape id, plus the connector ids. Refuses local documents.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "docId": {"type": "string"},
                    "pageId": {"type": "string"},
                    "nodes": {
                        "type": "array",
                        "minItems": 1,
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": {"type": "string", "description": "Caller-supplied logical id, referenced by edges. Must be unique within the call."},
                                "label": {"type": "string", "description": "Text shown in the shape. Defaults to the id."},
                                "kind": {"type": "string", "enum": ["rectangle", "ellipse"], "description": "Shape kind. Default: \"rectangle\"."}
                            },
                            "required": ["id"],
                            "additionalProperties": false
                        }
                    },
                    "edges": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "from": {"type": "string", "description": "Source node id."},
                                "to": {"type": "string", "description": "Target node id."},
                                "label": {"type": "string"}
                            },
                            "required": ["from", "to"],
                            "additionalProperties": false
                        }
                    },
                    "layout": {"type": "string", "enum": ["layered", "grid"], "description": "Placement strategy. Default: \"layered\" when edges are present, else \"grid\"."},
                    "routing": {"type": "string", "enum": ["orthogonal", "straight"], "description": "Connector routing. \"orthogonal\" (default) routes right-angle paths around intervening shapes and emits waypoints; \"straight\" draws plain anchor-to-anchor lines."}
                },
                "required": ["docId", "pageId", "nodes"],
                "additionalProperties": false
            }),
        },
        ToolDescriptor {
            name: "docushark_add_shape",
            description:
                "Add a single shape (rectangle, ellipse, text, or connector) to a page. Returns the id assigned. Warns if the document is locked by another user. Refuses local (renderer-owned) documents — those are read-only via MCP.",
            input_schema: dsl_shape_input_schema(),
        },
        ToolDescriptor {
            name: "docushark_add_shapes",
            description:
                "Add multiple shapes to a page in a single call. All-or-nothing: if any shape is invalid the whole batch is rejected and nothing is written. Returns the assigned ids in order.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "docId": {"type": "string"},
                    "pageId": {"type": "string"},
                    "shapes": {
                        "type": "array",
                        "items": dsl_shape_schema_inline(),
                        "minItems": 1
                    }
                },
                "required": ["docId", "pageId", "shapes"],
                "additionalProperties": false
            }),
        },
        ToolDescriptor {
            name: "docushark_connect",
            description:
                "Convenience over add_shape for connectors: creates a connector between two existing shapes on the same page. Anchors default to 'center'. Returns the new connector id.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "docId": {"type": "string"},
                    "pageId": {"type": "string"},
                    "fromId": {"type": "string"},
                    "toId": {"type": "string"},
                    "fromAnchor": {"type": "string", "enum": ["center","top","right","bottom","left"]},
                    "toAnchor": {"type": "string", "enum": ["center","top","right","bottom","left"]},
                    "label": {"type": "string"}
                },
                "required": ["docId", "pageId", "fromId", "toId"],
                "additionalProperties": false
            }),
        },
        ToolDescriptor {
            name: "docushark_update_shape",
            description:
                "Apply a partial DSL patch to an existing shape. Any subset of x, y, w, h, text, style, and icon fields (iconId/iconDisplayMode/iconSize) may be supplied; absent fields are left untouched. An empty iconId clears the icon. Refuses local documents.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "docId": {"type": "string"},
                    "pageId": {"type": "string"},
                    "id": {"type": "string"},
                    "patch": {
                        "type": "object",
                        "properties": {
                            "x": {"type": "number"},
                            "y": {"type": "number"},
                            "w": {"type": "number"},
                            "h": {"type": "number"},
                            "text": {"type": "string"},
                            "iconId": {"type": "string", "description": "Icon-library id from docushark_list_icons. Empty string clears the icon."},
                            "iconDisplayMode": {"type": "string", "enum": ["inside","badge","icon-only"]},
                            "iconSize": {"type": "number"},
                            "style": dsl_style_schema_inline()
                        },
                        "additionalProperties": false
                    }
                },
                "required": ["docId", "pageId", "id", "patch"],
                "additionalProperties": false
            }),
        },
        ToolDescriptor {
            name: "docushark_delete_shape",
            description:
                "Delete a shape by id. Connectors attached to it (start or end) are removed too, so no dangling connectors are left. Returns the ids actually deleted. Refuses local documents.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "docId": {"type": "string"},
                    "pageId": {"type": "string"},
                    "id": {"type": "string", "description": "The shape id to delete."}
                },
                "required": ["docId", "pageId", "id"],
                "additionalProperties": false
            }),
        },
        ToolDescriptor {
            name: "docushark_delete_prose_page",
            description:
                "Delete a prose page by id. Refuses to delete the last remaining prose page (a document always has at least one). Note: in a connected editor the page's tab may persist until reload (the prose page list isn't yet live-synced); its content is removed immediately. Refuses local documents.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "docId": {"type": "string"},
                    "pageId": {"type": "string", "description": "The prose page id to delete."}
                },
                "required": ["docId", "pageId"],
                "additionalProperties": false
            }),
        },
        ToolDescriptor {
            name: "docushark_reorder_shapes",
            description:
                "Set the z-order (front-to-back stacking) of a page's shapes. 'order' must be a permutation of the page's current shape ids — every id present, none added or duplicated (read get_page first). Later ids render on top. Refuses local documents.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "docId": {"type": "string"},
                    "pageId": {"type": "string"},
                    "order": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "All of the page's shape ids in the new z-order (back to front)."
                    }
                },
                "required": ["docId", "pageId", "order"],
                "additionalProperties": false
            }),
        },
        ToolDescriptor {
            name: "docushark_reorder_prose_pages",
            description:
                "Set the order of a document's prose pages. 'order' must be a permutation of the current prose page ids (read get_prose first). Note: in a connected editor the tab order may update only on reload (the prose page list isn't yet live-synced). Refuses local documents.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "docId": {"type": "string"},
                    "order": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "All of the document's prose page ids in the new order."
                    }
                },
                "required": ["docId", "order"],
                "additionalProperties": false
            }),
        },
        ToolDescriptor {
            name: "docushark_list_references",
            description:
                "Return a document's reference library (citations) as CSL-JSON items in display order, plus the active citation style. Read-only.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "docId": {"type": "string"}
                },
                "required": ["docId"],
                "additionalProperties": false
            }),
        },
        ToolDescriptor {
            name: "docushark_resolve_doi",
            description:
                "Resolve a DOI to a CSL-JSON reference via doi.org content negotiation, WITHOUT modifying any document. Use it to preview a reference before add_reference. Returns the CSL item.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "doi": {"type": "string", "description": "A DOI, bare (10.xxxx/…) or as a doi.org URL / doi: scheme."}
                },
                "required": ["doi"],
                "additionalProperties": false
            }),
        },
        ToolDescriptor {
            name: "docushark_add_reference",
            description:
                "Add one or more references (citations) to a document's reference library. Supply EITHER 'doi' (resolved via doi.org to CSL-JSON) OR 'items' (raw CSL-JSON object(s)). Deduplicates by DOI then id; returns the ids added and how many were skipped as duplicates. This populates the library only — it does not insert an inline citation or bibliography into the prose (do that in the editor). A connected editor sees new references on reload (references aren't live-synced yet). Refuses local (renderer-owned) documents.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "docId": {"type": "string"},
                    "doi": {"type": "string", "description": "A DOI to resolve and add. Mutually complementary with 'items'; supply at least one."},
                    "items": {
                        "type": "array",
                        "items": {"type": "object"},
                        "description": "CSL-JSON reference object(s) to add directly. Each should carry an 'id' (and ideally 'DOI'). Supply 'doi' instead to resolve one from a DOI."
                    }
                },
                "required": ["docId"],
                "additionalProperties": false
            }),
        },
        ToolDescriptor {
            name: "docushark_list_fields",
            description:
                "Return a document's fields (reusable named values like \"Company\" or \"Version\") in display order, each as {name, value}. Read-only.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "docId": {"type": "string"}
                },
                "required": ["docId"],
                "additionalProperties": false
            }),
        },
        ToolDescriptor {
            name: "docushark_set_fields",
            description:
                "Set or update one or more document fields (reusable named values). Each field is upserted by name: a new name is created, an existing name has its value replaced. Returns the names written and which were newly added. To reference a field in prose, write {{name}} in Markdown via set_prose/add_prose_page (it becomes a live field placeholder). Refuses local (renderer-owned) documents.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "docId": {"type": "string"},
                    "fields": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "name": {"type": "string", "description": "Field name — the {{name}} token. Required, non-empty."},
                                "value": {"type": "string", "description": "Field value. Substituted wherever {{name}} appears. Defaults to empty."}
                            },
                            "required": ["name"],
                            "additionalProperties": false
                        },
                        "description": "The fields to set (upsert by name)."
                    }
                },
                "required": ["docId", "fields"],
                "additionalProperties": false
            }),
        },
        ToolDescriptor {
            name: "docushark_get_skills",
            description:
                "Learn how to drive DocuShark before writing. With no arguments, returns the content contract (the rules for valid prose + shapes, so your writes aren't malformed) and a catalogue of recipes. Pass {skill:\"<slug>\"} for a recipe's full steps. Call this first if you're unsure how a tool expects its input.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "skill": {"type": "string", "description": "A recipe slug from the catalogue. Omit to get the contract + catalogue."}
                },
                "additionalProperties": false
            }),
        },
        ToolDescriptor {
            name: "docushark_list_icons",
            description:
                "Discover icon IDs to put on shapes. Returns {id, name, category} entries plus the total match count and the available categories. Filter with `query` (substring over id + name) and/or `category` — the cloud sets are large, so always filter or page with `limit`. Apply an icon by setting `iconId` (with `iconDisplayMode`) on a shape via add_shape/add_shapes/update_shape. Read-only.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Case-insensitive substring matched against icon id + name (e.g. \"database\", \"lambda\")."},
                    "category": {"type": "string", "description": "Restrict to one category, e.g. cloud-aws, cloud-azure, cloud-gcp, devops, databases, languages, frameworks, arrows, shapes, symbols, tech, general."},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 200, "description": "Max results to return (default 50, max 200). `total` reports the true match count."}
                },
                "additionalProperties": false
            }),
        },
    ]
}

fn dsl_style_schema_inline() -> Value {
    json!({
        "type": "object",
        "properties": {
            "fill": {"type": "string"},
            "stroke": {"type": "string"},
            "strokeWidth": {"type": "number"},
            "labelColor": {"type": "string"}
        },
        "additionalProperties": false
    })
}

fn dsl_shape_schema_inline() -> Value {
    json!({
        "type": "object",
        "properties": {
            "kind": {"type": "string", "enum": ["rectangle", "ellipse", "text", "connector"]},
            "x": {"type": "number"},
            "y": {"type": "number"},
            "w": {"type": "number"},
            "h": {"type": "number"},
            "text": {"type": "string"},
            "id": {"type": "string"},
            "startShapeId": {"type": "string"},
            "endShapeId": {"type": "string"},
            "startAnchor": {"type": "string", "enum": ["center","top","right","bottom","left"]},
            "endAnchor": {"type": "string", "enum": ["center","top","right","bottom","left"]},
            "startArrowStyle": {
                "type": "string",
                "enum": ["none","triangle","open","diamond"],
                "description": "Connector-only. Arrowhead style at the start endpoint. Default: \"none\"."
            },
            "endArrowStyle": {
                "type": "string",
                "enum": ["none","triangle","open","diamond"],
                "description": "Connector-only. Arrowhead style at the end endpoint. Default: \"triangle\"."
            },
            "iconId": {"type": "string", "description": "Rectangle/ellipse only. Icon-library id from docushark_list_icons (e.g. \"builtin:aws-amazon-s3\")."},
            "iconDisplayMode": {"type": "string", "enum": ["inside","badge","icon-only"], "description": "How the icon renders. Default \"inside\". Use \"icon-only\" for a pure icon node (no fill/stroke)."},
            "iconSize": {"type": "number", "description": "Icon size in px. Default 24. Ignored for icon-only (fills the shape)."},
            "style": dsl_style_schema_inline()
        },
        "required": ["kind"],
        "additionalProperties": false
    })
}

fn dsl_shape_input_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "docId": {"type": "string"},
            "pageId": {"type": "string"},
            "shape": dsl_shape_schema_inline()
        },
        "required": ["docId", "pageId", "shape"],
        "additionalProperties": false
    })
}

/// Outcome of a tool call.
#[derive(Debug)]
pub struct ToolOutcome {
    /// JSON value returned to the caller (wrapped by transport into MCP
    /// content blocks).
    pub result: Value,
    /// If `Some`, the transport should also broadcast a doc-changed event
    /// for this document id so the running app reloads.
    pub changed_doc_id: Option<DocId>,
    /// Structured description of what changed, for the in-process Tauri
    /// event bridge that lets the running app apply the delta directly
    /// (avoiding a full reload). `None` when the tool didn't mutate.
    ///
    /// Payload schema (matches `McpDocChangedEvent.change` in TS):
    ///   { "kind": "shape-added",   "pageId": ..., "shape":   {...BaseShape...} }
    ///   { "kind": "shapes-added",  "pageId": ..., "shapes":  [ {...}, ... ] }
    ///   { "kind": "shape-updated", "pageId": ..., "shapeId": "...", "shape": {...} }
    pub change_detail: Option<Value>,
}

/// Dispatch a `tools/call` request. `name` is the tool name as advertised
/// in `descriptors()`; `args` is the `arguments` object from the call.
pub fn dispatch(ctx: &ToolContext, name: &str, args: &Value) -> Result<ToolOutcome, String> {
    // JP-370: per-document access gate. For tools that target a specific
    // document, enforce the caller's owner/share permission before dispatch —
    // the single chokepoint that also covers the resident-Y.Doc read paths that
    // bypass `fetch_doc`. No-op for the static loopback token and when
    // enforcement is off (see `ensure_doc_permission`). `list_documents`
    // filters its own output below; creation/catalogue tools target no doc.
    if let Some(required) = tool_required_permission(name) {
        if let Some(doc_id) = args
            .get("docId")
            .and_then(|v| v.as_str())
            .and_then(|s| DocId::from_http_path(s.to_string()).ok())
        {
            ctx.ensure_doc_permission(&doc_id, required)?;
        }
    }

    // JP-230: MCP and the WS/REST path now share one `DocumentStore`, so reads
    // already see every write through the shared in-memory index — no per-call
    // reload-from-disk needed (it was a band-aid for the old two-store split).
    match name {
        "docushark_list_documents" => list_documents(ctx),
        "docushark_get_document" => get_document(ctx, args),
        "docushark_get_page" => get_page(ctx, args),
        "docushark_get_shape" => get_shape(ctx, args),
        "docushark_create_document" => create_document(ctx, args),
        "docushark_rename_document" => rename_document(ctx, args),
        "docushark_delete_document" => delete_document(ctx, args),
        "docushark_get_prose" => get_prose(ctx, args),
        "docushark_add_prose_page" => add_prose_page(ctx, args),
        "docushark_set_prose" => set_prose(ctx, args),
        "docushark_rename_prose_page" => rename_prose_page(ctx, args),
        "docushark_add_canvas_page" => add_canvas_page(ctx, args),
        "docushark_rename_canvas_page" => rename_canvas_page(ctx, args),
        "docushark_reorder_canvas_page" => reorder_canvas_page(ctx, args),
        "docushark_delete_canvas_page" => delete_canvas_page(ctx, args),
        "docushark_get_outline" => get_outline(ctx, args),
        "docushark_insert_section" => insert_section(ctx, args),
        "docushark_restructure_outline" => restructure_outline(ctx, args),
        "docushark_generate_diagram" => generate_diagram(ctx, args),
        "docushark_add_shape" => add_shape(ctx, args),
        "docushark_add_shapes" => add_shapes(ctx, args),
        "docushark_connect" => connect(ctx, args),
        "docushark_update_shape" => update_shape(ctx, args),
        "docushark_delete_shape" => delete_shape(ctx, args),
        "docushark_delete_prose_page" => delete_prose_page(ctx, args),
        "docushark_reorder_shapes" => reorder_shapes(ctx, args),
        "docushark_reorder_prose_pages" => reorder_prose_pages(ctx, args),
        "docushark_list_references" => list_references(ctx, args),
        "docushark_add_reference" => add_reference(ctx, args),
        "docushark_list_fields" => list_fields(ctx, args),
        "docushark_set_fields" => set_fields(ctx, args),
        "docushark_get_skills" => get_skills(args),
        "docushark_list_icons" => list_icons(args),
        // docushark_resolve_doi is resolved async in the transport layer before
        // dispatch (it needs a network call); it never reaches this match.
        _ => Err(format!("Unknown tool: {}", name)),
    }
}

#[derive(Deserialize, Default)]
struct GetSkillsArgs {
    skill: Option<String>,
}

/// `docushark_get_skills` — agent guidance (JP-328). No `skill`: the content
/// contract + recipe catalogue. With `skill`: that recipe's full body. Pure
/// static content (no document, no filesystem), so it takes no `ToolContext`
/// and the `skill` argument is matched against a fixed table — there is no path
/// to traverse.
fn get_skills(args: &Value) -> Result<ToolOutcome, String> {
    let parsed: GetSkillsArgs = if args.is_null() {
        GetSkillsArgs::default()
    } else {
        serde_json::from_value(args.clone()).map_err(|e| format!("Invalid arguments: {}", e))?
    };

    let result = match parsed.skill.as_deref().filter(|s| !s.is_empty()) {
        None => super::skills::catalogue_json(),
        Some(slug) => match super::skills::skill_body(slug) {
            Some(body) => json!({ "skill": slug, "content": body }),
            None => {
                return Err(format!(
                    "ERR_SKILL_NOT_FOUND: no skill named {slug:?}. Valid skills: {}. \
                     Call get_skills with no arguments for the catalogue + content contract.",
                    super::skills::valid_slugs()
                ))
            }
        },
    };

    Ok(ToolOutcome {
        result,
        changed_doc_id: None,
        change_detail: None,
    })
}

#[derive(Deserialize, Default)]
struct ListIconsArgs {
    query: Option<String>,
    category: Option<String>,
    limit: Option<usize>,
}

/// `docushark_list_icons` — read-only icon discovery from the embedded catalog
/// (JP-342). No `ToolContext`: the catalog is static and request-independent.
fn list_icons(args: &Value) -> Result<ToolOutcome, String> {
    let parsed: ListIconsArgs = if args.is_null() {
        ListIconsArgs::default()
    } else {
        serde_json::from_value(args.clone()).map_err(|e| format!("Invalid arguments: {}", e))?
    };

    let result = super::icons::list(
        parsed.query.as_deref(),
        parsed.category.as_deref(),
        parsed.limit.unwrap_or(super::icons::DEFAULT_LIMIT),
    );

    Ok(ToolOutcome {
        result,
        changed_doc_id: None,
        change_detail: None,
    })
}

/// Look up a document across team + local sources. Returns the document
/// JSON and the source tag, or `Err` if it's nowhere (or in the local
/// mirror but local access is currently disabled).
fn fetch_doc(ctx: &ToolContext, doc_id: &DocId) -> Result<(Value, &'static str), String> {
    if let Ok(doc) = ctx.team.get_document(&ctx.workspace_id, doc_id) {
        return Ok((doc, SOURCE_TEAM));
    }
    if ctx.local_enabled && ctx.local.contains(&ctx.workspace_id, doc_id.as_str()) {
        let doc = ctx.local.get(&ctx.workspace_id, doc_id.as_str())?;
        return Ok((doc, SOURCE_LOCAL));
    }
    Err(format!("Document '{}' not found", doc_id.as_str()))
}

fn list_documents(ctx: &ToolContext) -> Result<ToolOutcome, String> {
    let mut team_docs = ctx.team.list_documents(&ctx.workspace_id);
    // JP-370: a JWT caller only lists team docs they may read (owner / shared /
    // workspace owner-admin), mirroring the REST listing. The static loopback
    // token (user_id None) and enforcement-off keep the full listing.
    if ctx.enforce_private_docs {
        if let Some(user_id) = ctx.user_id.as_deref() {
            let role = ctx.user_role.as_deref();
            team_docs.retain(|m| {
                crate::server::permissions::get_user_permission(m, user_id, role)
                    != crate::server::permissions::Permission::None
            });
        }
    }
    let mut payload: Vec<Value> = team_docs
        .into_iter()
        .map(|m| {
            // JP-349: pageCount is the canvas + prose total; the split lets an
            // agent see at a glance that prose pages exist (a canvas-only count
            // read as if they'd vanished). `prose_page_count` is `None` only on
            // an un-backfilled cold doc — fall back to 0 (canvas == total).
            let prose = m.prose_page_count.unwrap_or(0);
            json!({
                "id": m.id,
                "name": m.name,
                "pageCount": m.page_count,
                "canvasPageCount": m.page_count.saturating_sub(prose),
                "prosePageCount": prose,
                "modifiedAt": m.modified_at,
                "source": SOURCE_TEAM,
            })
        })
        .collect();
    if ctx.local_enabled {
        for m in ctx.local.list(&ctx.workspace_id) {
            payload.push(json!({
                "id": m.id,
                "name": m.name,
                "pageCount": m.page_count,
                "canvasPageCount": m.page_count.saturating_sub(m.prose_page_count),
                "prosePageCount": m.prose_page_count,
                "modifiedAt": m.modified_at,
                "source": SOURCE_LOCAL,
            }));
        }
    }
    payload.sort_by(|a, b| {
        b.get("modifiedAt")
            .and_then(|v| v.as_u64())
            .unwrap_or(0)
            .cmp(&a.get("modifiedAt").and_then(|v| v.as_u64()).unwrap_or(0))
    });
    Ok(ToolOutcome {
        result: json!({"documents": payload, "localAccessEnabled": ctx.local_enabled}),
        changed_doc_id: None,
        change_detail: None,
    })
}

#[derive(Deserialize)]
struct GetDocumentArgs {
    #[serde(rename = "docId")]
    doc_id: DocId,
}

fn get_document(ctx: &ToolContext, args: &Value) -> Result<ToolOutcome, String> {
    let parsed: GetDocumentArgs =
        serde_json::from_value(args.clone()).map_err(|e| format!("Invalid arguments: {}", e))?;
    let (doc, source) = fetch_doc(ctx, &parsed.doc_id)?;

    // JP-251/JP-340: when resident, every page's live shape count can be ahead
    // of the JSON snapshot — shapes are per-page (`shapes:<id>`), so report each
    // page's live count from its own surface, not just the active page.
    let resident = resident_handle(ctx, &parsed.doc_id);

    let pages: Vec<Value> = doc
        .get("pageOrder")
        .and_then(|v| v.as_array())
        .map(|order| {
            order
                .iter()
                .filter_map(|id| id.as_str())
                .filter_map(|id| {
                    let page = doc.get("pages")?.get(id)?;
                    let shape_count = if let Some(h) = resident.as_ref() {
                        h.shapes_json(id).len()
                    } else {
                        page.get("shapeOrder")
                            .and_then(|v| v.as_array())
                            .map(|a| a.len())
                            .unwrap_or(0)
                    };
                    Some(json!({
                        "id": id,
                        "name": page.get("name").cloned().unwrap_or(json!("")),
                        "shapeCount": shape_count,
                    }))
                })
                .collect()
        })
        .unwrap_or_default();

    // Document fields (Phase 3c) — reusable {{name}} values, in display order.
    // Read the live Y.Doc library when resident (fresher than the snapshot).
    let fields = match resident.as_ref() {
        Some(h) => super::fields::list_payload(&h.fields_json(), &h.field_order()),
        None => super::fields::list_fields_json(&doc),
    };

    Ok(ToolOutcome {
        result: json!({
            "id": doc.get("id").cloned().unwrap_or(Value::Null),
            "name": doc.get("name").cloned().unwrap_or(Value::Null),
            "modifiedAt": doc.get("modifiedAt").cloned().unwrap_or(Value::Null),
            "lockedBy": doc.get("lockedBy").cloned().unwrap_or(Value::Null),
            // Canvas pages (diagrams).
            "pages": pages,
            // Prose pages (the written body) — id/name/order only; fetch
            // content with get_prose. Empty for diagram-only documents.
            "prosePages": prose_page_summaries(&doc),
            // Reusable document fields ({{name}} values), each {name, value}.
            "fields": fields.get("fields").cloned().unwrap_or_else(|| json!([])),
            "source": source,
        }),
        changed_doc_id: None,
        change_detail: None,
    })
}

/// Summarise a doc's prose pages (id, name, order) in `pageOrder` order,
/// without their (potentially large) HTML bodies. Empty list when the doc
/// has no `richTextPages` (diagram-only or pre-prose documents).
fn prose_page_summaries(doc: &Value) -> Vec<Value> {
    let rtp = match doc.get("richTextPages") {
        Some(v) => v,
        None => return Vec::new(),
    };
    let pages = rtp.get("pages");
    rtp.get("pageOrder")
        .and_then(|v| v.as_array())
        .map(|order| {
            order
                .iter()
                .filter_map(|id| id.as_str())
                .filter_map(|id| {
                    let page = pages?.get(id)?;
                    Some(json!({
                        "id": id,
                        "name": page.get("name").cloned().unwrap_or(json!("")),
                        "order": page.get("order").cloned().unwrap_or(json!(0)),
                    }))
                })
                .collect()
        })
        .unwrap_or_default()
}

#[derive(Deserialize)]
struct GetPageArgs {
    #[serde(rename = "docId")]
    doc_id: DocId,
    #[serde(rename = "pageId")]
    page_id: String,
}

fn get_page(ctx: &ToolContext, args: &Value) -> Result<ToolOutcome, String> {
    let parsed: GetPageArgs =
        serde_json::from_value(args.clone()).map_err(|e| format!("Invalid arguments: {}", e))?;

    // JP-251/JP-340: resident-accurate when the doc is hot — reads the live
    // Y.Doc the write path mutates (JP-35) for THIS page's surface
    // (`shapes:<pageId>`), so a write-then-read round-trip is consistent on any
    // page. Else (non-resident) the JSON snapshot. Mirrors the prose
    // resident-read (JP-201) + `get_shape`.
    if let Some(handle) = resident_handle(ctx, &parsed.doc_id) {
        let shapes_map = handle.shapes_json(&parsed.page_id);
        // JP-330: dedupe the live shapeOrder so an agent never sees a shape
        // twice if the Y.Array doubled (dual-origin merge); orphans drop here too.
        let order = handle.shape_order(&parsed.page_id);
        let shapes: Vec<Value> = crate::sync::dedupe_order(
            order.iter().map(String::as_str),
            |id| shapes_map.contains_key(id),
        )
        .iter()
        .filter_map(|id| shapes_map.get(id))
        .map(shape_to_dsl_or_generic)
        .collect();
        return Ok(ToolOutcome {
            result: json!({"shapes": shapes, "source": "team"}),
            changed_doc_id: None,
            change_detail: None,
        });
    }

    let (doc, source) = fetch_doc(ctx, &parsed.doc_id)?;
    let page = doc
        .get("pages")
        .and_then(|p| p.get(&parsed.page_id))
        .ok_or_else(|| format!("Page '{}' not found", parsed.page_id))?;

    let order: Vec<String> = page
        .get("shapeOrder")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();

    let shapes_obj = page.get("shapes").cloned().unwrap_or_else(|| json!({}));

    let shapes: Vec<Value> = order
        .iter()
        .filter_map(|id| shapes_obj.get(id))
        .map(shape_to_dsl_or_generic)
        .collect();

    Ok(ToolOutcome {
        result: json!({"shapes": shapes, "source": source}),
        changed_doc_id: None,
        change_detail: None,
    })
}

/// A shape's DSL form, or a generic descriptor for kinds the foundation adapter
/// doesn't model yet (mirrors `get_page`'s fallback).
fn shape_to_dsl_or_generic(shape: &Value) -> Value {
    shape_json_to_dsl(shape).unwrap_or_else(|| {
        json!({
            "id": shape.get("id"),
            "kind": shape.get("type"),
            "x": shape.get("x"),
            "y": shape.get("y"),
            "_unmapped": true,
        })
    })
}

#[derive(Deserialize)]
struct GetShapeArgs {
    #[serde(rename = "docId")]
    doc_id: DocId,
    #[serde(rename = "pageId")]
    page_id: String,
    id: String,
}

fn get_shape(ctx: &ToolContext, args: &Value) -> Result<ToolOutcome, String> {
    let parsed: GetShapeArgs =
        serde_json::from_value(args.clone()).map_err(|e| format!("Invalid arguments: {}", e))?;
    // Resident-accurate when the doc is hot (consistent with the live write
    // path) on any page — reads `shapes:<pageId>` — else the JSON snapshot.
    if let Some(handle) = resident_handle(ctx, &parsed.doc_id) {
        if let Some(shape) = handle.get_shape_json(&parsed.page_id, &parsed.id) {
            return Ok(ToolOutcome {
                result: json!({"shape": shape_to_dsl_or_generic(&shape), "source": "team"}),
                changed_doc_id: None,
                change_detail: None,
            });
        }
    }
    let (doc, source) = fetch_doc(ctx, &parsed.doc_id)?;
    let shape = doc
        .get("pages")
        .and_then(|p| p.get(&parsed.page_id))
        .and_then(|pg| pg.get("shapes"))
        .and_then(|s| s.get(&parsed.id))
        .ok_or_else(|| {
            format!("Shape '{}' not found on page '{}'", parsed.id, parsed.page_id)
        })?;
    Ok(ToolOutcome {
        result: json!({"shape": shape_to_dsl_or_generic(shape), "source": source}),
        changed_doc_id: None,
        change_detail: None,
    })
}

#[derive(Deserialize)]
struct CreateDocumentArgs {
    /// Optional title; defaults to "Untitled Document".
    name: Option<String>,
}

/// Build a fresh, minimal `DiagramDocument` body equivalent to what the
/// editor's `persistenceStore.newDocument` produces: one blank canvas page
/// and one blank prose page. Field names + defaults mirror the TS types
/// (`src/types/Document.ts`, `richTextPagesStore.ts`) — drift here shows up
/// as a document that won't open cleanly in the editor.
fn build_new_document(name: &str) -> Value {
    let now = now_ms();
    let doc_id = format!("doc-{}", nanoid::nanoid!(12));
    let canvas_page_id = format!("page-{}", nanoid::nanoid!(12));
    let prose_page_id = format!("page-{}", nanoid::nanoid!(12));

    json!({
        "id": doc_id,
        "name": name,
        "version": 1,
        "createdAt": now,
        "modifiedAt": now,
        // Created in the team store, so it's a relay document from birth.
        "isRelayDocument": true,
        "activePageId": canvas_page_id,
        "pageOrder": [canvas_page_id],
        "pages": {
            canvas_page_id.clone(): {
                "id": canvas_page_id,
                "name": CANVAS_PAGE_BASE,
                "shapes": {},
                "shapeOrder": [],
                "createdAt": now,
                "modifiedAt": now,
            }
        },
        "richTextPages": {
            "pages": {
                prose_page_id.clone(): {
                    "id": prose_page_id,
                    "name": PROSE_PAGE_BASE,
                    "content": "",
                    "order": 0,
                    "createdAt": now,
                    "modifiedAt": now,
                }
            },
            "pageOrder": [prose_page_id],
            "activePageId": prose_page_id,
        }
    })
}

fn create_document(ctx: &ToolContext, args: &Value) -> Result<ToolOutcome, String> {
    let parsed: CreateDocumentArgs =
        serde_json::from_value(args.clone()).map_err(|e| format!("Invalid arguments: {}", e))?;
    let name = parsed
        .name
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "Untitled Document".to_string());

    let doc = build_new_document(&name);
    let id_str = doc["id"].as_str().expect("factory always sets id").to_string();
    let doc_id = DocId::from_body_id(id_str.clone())
        .map_err(|e| format!("Generated document id was invalid: {}", e))?;

    // Brand-new id, so there's nothing to race — the unconditional save
    // creates it at version 1.
    ctx.team.save_document(&ctx.workspace_id, doc)?;

    Ok(ToolOutcome {
        result: json!({"id": id_str, "name": name}),
        changed_doc_id: Some(doc_id),
        change_detail: None,
    })
}

// ---------------------------------------------------------------------------
// Document-level manage tools (JP-350): rename + delete a whole document, the
// MCP companions to `create_document`. The document title is CRDT-native (it
// lives in the Y.Doc `metadata.title`), so rename writes the JSON `name` AND —
// for a resident doc — the live `metadata` map so an open editor retitles
// without a reload. Delete mirrors the REST `DELETE /api/docs/:id` path exactly
// (store delete → Deleted event → blob release) via the `on_doc_deleted` sink.
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct RenameDocumentArgs {
    #[serde(rename = "docId")]
    doc_id: DocId,
    name: String,
}

fn rename_document(ctx: &ToolContext, args: &Value) -> Result<ToolOutcome, String> {
    let parsed: RenameDocumentArgs =
        serde_json::from_value(args.clone()).map_err(|e| format!("Invalid arguments: {}", e))?;
    reject_if_local(ctx, &parsed.doc_id)?;
    let name = parsed.name.trim().to_string();
    if name.is_empty() {
        return Err("Document name must not be empty".into());
    }

    // Persist the JSON `name` + bump `modifiedAt` under optimistic concurrency.
    // The same `now` is reused for the live Y.Doc `updatedAt` below so the flatten
    // title-adoption guard (adopt `metadata.title` only when `updatedAt >=
    // modifiedAt`) keeps this title rather than reverting it on the next snapshot.
    let now = now_ms();
    mutate_with_retry(ctx, &parsed.doc_id, |doc| {
        let obj = doc.as_object_mut().ok_or("Document is not an object")?;
        obj.insert("name".into(), json!(name.clone()));
        stamp_doc_modified(doc, now);
        Ok(())
    })?;

    // Fully live (JP-350): when the doc is resident, push the title into the live
    // `metadata` map so open editors retitle immediately — no reload. Cold docs
    // rely on the `changed_doc_id` nudge below to refresh the doc list.
    if let Some(handle) = resident_handle(ctx, &parsed.doc_id) {
        let framed = handle.set_metadata_title(&name, now);
        ctx.broadcast_update(&parsed.doc_id, framed);
    }

    Ok(ToolOutcome {
        result: json!({"id": parsed.doc_id.as_str(), "name": name}),
        changed_doc_id: Some(parsed.doc_id),
        change_detail: None,
    })
}

#[derive(Deserialize)]
struct DeleteDocumentArgs {
    #[serde(rename = "docId")]
    doc_id: DocId,
}

fn delete_document(ctx: &ToolContext, args: &Value) -> Result<ToolOutcome, String> {
    let parsed: DeleteDocumentArgs =
        serde_json::from_value(args.clone()).map_err(|e| format!("Invalid arguments: {}", e))?;
    reject_if_local(ctx, &parsed.doc_id)?;

    // Evict the resident Y.Doc FIRST, without snapshotting (raw registry evict),
    // so no live handle can re-flatten the JSON we're about to delete and
    // resurrect the doc. Unsaved CRDT edits are intentionally dropped — the doc
    // is being deleted. No-op when the doc isn't resident.
    ctx.registry.evict(&ctx.workspace_id, &parsed.doc_id);

    let existed = ctx.team.delete_document(&ctx.workspace_id, &parsed.doc_id)?;
    if !existed {
        return Err(format!("Document '{}' not found", parsed.doc_id.as_str()));
    }

    // Same follow-up as the REST delete (JP-350): broadcast a Deleted event so
    // connected clients leave/Trash the doc, and release its blob refs (JP-120).
    // Deliberately NOT `changed_doc_id`, whose `Updated` event would tell clients
    // to reload a now-missing doc.
    (ctx.on_doc_deleted)(&ctx.workspace_id, &parsed.doc_id);

    Ok(ToolOutcome {
        result: json!({"deleted": parsed.doc_id.as_str()}),
        changed_doc_id: None,
        change_detail: None,
    })
}

// ---------------------------------------------------------------------------
// Prose tools (JP-93 Slice B): read/write the document's written body, which
// lives in `richTextPages` (multi-page TipTap prose) alongside the diagram
// canvas. Prose is persisted as HTML; agents author in Markdown by default.
// ---------------------------------------------------------------------------

/// Render Markdown to the HTML TipTap persists. GFM tables / strikethrough /
/// task-lists are enabled to match the editor's extension set. `{{name}}` tokens
/// in prose text become live field placeholders (Phase 3c) — see
/// [`expand_field_tokens`].
fn markdown_to_html(md: &str) -> String {
    use pulldown_cmark::{html, Event, Options, Parser, Tag, TagEnd};
    let mut opts = Options::empty();
    opts.insert(Options::ENABLE_TABLES);
    opts.insert(Options::ENABLE_STRIKETHROUGH);
    opts.insert(Options::ENABLE_TASKLISTS);

    // Filter the event stream: transform `{{name}}` inside plain text into a
    // `<span data-field …>` (a live field reference), but NEVER inside a code
    // block (where `{{` must stay literal). Inline code is a separate
    // `Event::Code`, so it's left untouched by only matching `Event::Text`.
    let mut in_code_block = 0u32;
    let mut events: Vec<Event> = Vec::new();
    for ev in Parser::new_ext(md, opts) {
        match ev {
            Event::Start(Tag::CodeBlock(kind)) => {
                in_code_block += 1;
                events.push(Event::Start(Tag::CodeBlock(kind)));
            }
            Event::End(TagEnd::CodeBlock) => {
                in_code_block = in_code_block.saturating_sub(1);
                events.push(Event::End(TagEnd::CodeBlock));
            }
            Event::Text(t) if in_code_block == 0 && t.contains("{{") => {
                expand_field_tokens(&t, &mut events);
            }
            other => events.push(other),
        }
    }

    let mut out = String::new();
    html::push_html(&mut out, events.into_iter());
    out
}

/// Escape a string for an HTML double-quoted attribute value.
fn escape_field_attr(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// Parse a field token at the start of `s` (the text right after an opening
/// `{{`): the name runs to the closing `}}` and may not contain `{` or `}`.
/// Returns the trimmed name + the byte count to skip past the closing `}}`, or
/// `None` if it isn't a well-formed token. `{`/`}` are ASCII, so byte scanning
/// is char-boundary safe.
fn try_parse_field_token(s: &str) -> Option<(&str, usize)> {
    let bytes = s.as_bytes();
    let mut j = 0;
    while j < bytes.len() {
        match bytes[j] {
            b'{' => return None, // a name can't contain '{'
            b'}' => {
                if j + 1 < bytes.len() && bytes[j + 1] == b'}' {
                    let name = s[..j].trim();
                    return if name.is_empty() { None } else { Some((name, j + 2)) };
                }
                return None; // a lone '}' is not a close
            }
            _ => j += 1,
        }
    }
    None
}

/// Split `text` on `{{name}}` tokens, pushing literal stretches as `Event::Text`
/// and each token as an `Event::InlineHtml` `<span data-field data-name="name">`
/// (no `data-label` — the editor's nodeView fills the live value). A malformed
/// `{{…` with no valid close stays literal.
fn expand_field_tokens<'a>(text: &str, out: &mut Vec<pulldown_cmark::Event<'a>>) {
    use pulldown_cmark::{CowStr, Event};
    let bytes = text.as_bytes();
    let mut i = 0;
    let mut literal_start = 0;
    while i + 1 < bytes.len() {
        if bytes[i] == b'{' && bytes[i + 1] == b'{' {
            if let Some((name, consumed)) = try_parse_field_token(&text[i + 2..]) {
                if literal_start < i {
                    out.push(Event::Text(CowStr::from(text[literal_start..i].to_string())));
                }
                let span = format!("<span data-field data-name=\"{}\"></span>", escape_field_attr(name));
                out.push(Event::InlineHtml(CowStr::from(span)));
                i += 2 + consumed;
                literal_start = i;
                continue;
            }
        }
        i += 1;
    }
    if literal_start < text.len() {
        out.push(Event::Text(CowStr::from(text[literal_start..].to_string())));
    }
}

/// Hard cap on a single prose write's content size, in bytes (JP-248). A safety
/// bound on the public `/mcp` surface so one `set_prose`/`add_prose_page`/
/// `insert_section` can't build a huge fragment + broadcast delta. Advertised as
/// `maxLength` on the prose-write tools so agents self-limit. A const (not a
/// config knob) to stay lean — no `ToolContext` threading; promote to config if
/// per-deployment tuning is ever needed.
const MAX_PROSE_CONTENT_BYTES: usize = 1_048_576; // 1 MiB

/// Reject prose content over [`MAX_PROSE_CONTENT_BYTES`] with `ERR_PROSE_TOO_LARGE`.
fn check_prose_size(content: &str) -> Result<(), String> {
    if content.len() > MAX_PROSE_CONTENT_BYTES {
        return Err(format!(
            "ERR_PROSE_TOO_LARGE: content is {} bytes; the limit is {} bytes",
            content.len(),
            MAX_PROSE_CONTENT_BYTES
        ));
    }
    Ok(())
}

/// Turn agent-supplied content into the HTML stored on a prose page.
/// Markdown is the default (agents produce it reliably); `html` is a
/// pass-through escape hatch. The editor re-parses this HTML against the
/// ProseMirror schema on load, which silently drops anything the schema
/// doesn't model — a natural sanitizer for pass-through HTML.
fn content_to_html(content: &str, format: Option<&str>) -> Result<String, String> {
    match format.unwrap_or("markdown") {
        "markdown" | "md" => Ok(markdown_to_html(content)),
        "html" => Ok(content.to_string()),
        other => Err(format!(
            "Unknown content format '{}'; expected 'markdown' or 'html'",
            other
        )),
    }
}

/// Mutable handle to the doc's `richTextPages` container, initialising an
/// empty one for documents that predate multi-page prose so writes always
/// have somewhere to land.
fn rich_text_pages_mut(doc: &mut Value) -> Result<&mut serde_json::Map<String, Value>, String> {
    let obj = doc.as_object_mut().ok_or("Document is not an object")?;
    let rtp = obj.entry("richTextPages").or_insert_with(|| {
        json!({ "pages": {}, "pageOrder": [], "activePageId": Value::Null })
    });
    rtp.as_object_mut()
        .ok_or_else(|| "'richTextPages' is not an object".to_string())
}

#[derive(Deserialize)]
struct GetProseArgs {
    #[serde(rename = "docId")]
    doc_id: DocId,
    #[serde(rename = "pageId")]
    page_id: Option<String>,
}

fn get_prose(ctx: &ToolContext, args: &Value) -> Result<ToolOutcome, String> {
    let parsed: GetProseArgs =
        serde_json::from_value(args.clone()).map_err(|e| format!("Invalid arguments: {}", e))?;
    let (doc, source) = fetch_doc(ctx, &parsed.doc_id)?;

    // Live Y.Doc content overlaid on the JSON page list when the doc is
    // resident (JP-201), so an agent sees prose a connected editor just typed.
    let resolved = resolve_prose_pages(ctx, &parsed.doc_id, &doc);
    let render = |id: &str, name: &Value, order: &Value, content: &str| {
        json!({"id": id, "name": name, "order": order, "content": content})
    };

    if let Some(page_id) = parsed.page_id {
        let page = resolved
            .iter()
            .find(|e| e.0 == page_id)
            .ok_or_else(|| format!("Prose page '{}' not found", page_id))?;
        return Ok(ToolOutcome {
            result: json!({"page": render(&page.0, &page.1, &page.2, &page.3), "source": source}),
            changed_doc_id: None,
            change_detail: None,
        });
    }

    let pages: Vec<Value> = resolved
        .iter()
        .map(|e| render(&e.0, &e.1, &e.2, &e.3))
        .collect();

    Ok(ToolOutcome {
        result: json!({"pages": pages, "source": source}),
        changed_doc_id: None,
        change_detail: None,
    })
}

#[derive(Deserialize)]
struct AddProsePageArgs {
    #[serde(rename = "docId")]
    doc_id: DocId,
    name: Option<String>,
    content: Option<String>,
    format: Option<String>,
}

fn add_prose_page(ctx: &ToolContext, args: &Value) -> Result<ToolOutcome, String> {
    let parsed: AddProsePageArgs =
        serde_json::from_value(args.clone()).map_err(|e| format!("Invalid arguments: {}", e))?;
    reject_if_local(ctx, &parsed.doc_id)?;

    // Render once, outside the retry loop — deterministic and lets a bad
    // format fail fast before we touch the store.
    let html = match &parsed.content {
        Some(c) => {
            check_prose_size(c)?;
            content_to_html(c, parsed.format.as_deref())?
        }
        None => String::new(),
    };

    let id = mutate_with_retry(ctx, &parsed.doc_id, |doc| {
        let now = now_ms();
        let rtp = rich_text_pages_mut(doc)?;
        let order = rtp
            .get("pageOrder")
            .and_then(|v| v.as_array())
            .map(|a| a.len())
            .unwrap_or(0);
        let page_id = format!("page-{}", nanoid::nanoid!(12));
        let existing = page_names(rtp.get("pages"));
        let name = parsed
            .name
            .clone()
            .map(|n| n.trim().to_string())
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| {
                next_default_page_name(PROSE_PAGE_BASE, existing.iter().map(String::as_str))
            });

        rtp.entry("pages")
            .or_insert_with(|| json!({}))
            .as_object_mut()
            .ok_or("'richTextPages.pages' is not an object")?
            .insert(
                page_id.clone(),
                json!({
                    "id": page_id,
                    "name": name,
                    "content": html,
                    "order": order,
                    "createdAt": now,
                    "modifiedAt": now,
                }),
            );
        rtp.entry("pageOrder")
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .ok_or("'richTextPages.pageOrder' is not an array")?
            .push(json!(page_id.clone()));
        if rtp.get("activePageId").map(|v| v.is_null()).unwrap_or(true) {
            rtp.insert("activePageId".into(), json!(page_id.clone()));
        }

        stamp_doc_modified(doc, now);
        Ok(page_id)
    })?;

    // Seed the live `prose:<id>` fragment when resident, so the content is in the
    // Y.Doc for the new tab. JP-339: ALSO push the `prosePages` metadata delta so
    // the tab itself surfaces live — no reload (the JP-338 dup trigger).
    if let Some(handle) = resident_handle(ctx, &parsed.doc_id) {
        let framed = handle.replace_prose(&id, &html)?;
        ctx.broadcast_update(&parsed.doc_id, framed);
    }
    broadcast_prose_page_meta(ctx, &parsed.doc_id, &id);

    // JP-328: surface what the structural gate healed in the new page's content.
    let fixes = crate::sync::validate_prose_html(&html);
    let mut result = json!({"id": id});
    if !fixes.is_empty() {
        result["fixes"] = serde_json::to_value(&fixes).unwrap_or(Value::Null);
    }
    Ok(ToolOutcome {
        result,
        changed_doc_id: Some(parsed.doc_id),
        change_detail: None,
    })
}

#[derive(Deserialize)]
struct SetProseArgs {
    #[serde(rename = "docId")]
    doc_id: DocId,
    #[serde(rename = "pageId")]
    page_id: String,
    content: String,
    format: Option<String>,
    /// JP-239: when present, `content` replaces only the block matching this
    /// text (a targeted edit) instead of the whole page. The block's current
    /// text — the anchor doubles as a write-confirmation lock (must match
    /// exactly one block).
    anchor: Option<String>,
    /// JP-239: with `anchor`, replace the inclusive span of blocks from `anchor`
    /// through the block matching this text.
    #[serde(rename = "anchorUntil")]
    anchor_until: Option<String>,
}

fn set_prose(ctx: &ToolContext, args: &Value) -> Result<ToolOutcome, String> {
    let parsed: SetProseArgs =
        serde_json::from_value(args.clone()).map_err(|e| format!("Invalid arguments: {}", e))?;
    reject_if_local(ctx, &parsed.doc_id)?;
    check_prose_size(&parsed.content)?;
    let html = content_to_html(&parsed.content, parsed.format.as_deref())?;
    // JP-328: report what the structural gate healed, so the author sees it.
    let fixes = crate::sync::validate_prose_html(&html);

    match &parsed.anchor {
        // JP-239: anchored, block-level replace — only the matched block(s) change.
        Some(anchor) => write_prose_block_live_or_json(
            ctx,
            &parsed.doc_id,
            &parsed.page_id,
            anchor,
            parsed.anchor_until.as_deref(),
            &html,
        )?,
        // JP-238: whole-page replace — live to the Y.Doc fragment when resident
        // (connected editors see it immediately), else JSON.
        None => write_prose_page_live_or_json(ctx, &parsed.doc_id, &parsed.page_id, &html, |doc| {
            let now = now_ms();
            let rtp = rich_text_pages_mut(doc)?;
            let page = rtp
                .get_mut("pages")
                .and_then(|v| v.as_object_mut())
                .and_then(|pages| pages.get_mut(&parsed.page_id))
                .and_then(|p| p.as_object_mut())
                .ok_or_else(|| format!("Prose page '{}' not found", parsed.page_id))?;
            page.insert("content".into(), json!(html));
            page.insert("modifiedAt".into(), json!(now));
            stamp_doc_modified(doc, now);
            Ok(())
        })?,
    }

    let mut result = json!({"pageId": parsed.page_id, "ok": true});
    if !fixes.is_empty() {
        result["fixes"] = serde_json::to_value(&fixes).unwrap_or(Value::Null);
    }
    Ok(ToolOutcome {
        result,
        changed_doc_id: Some(parsed.doc_id),
        change_detail: None,
    })
}

#[derive(Deserialize)]
struct RenameProsePageArgs {
    #[serde(rename = "docId")]
    doc_id: DocId,
    #[serde(rename = "pageId")]
    page_id: String,
    name: String,
}

fn rename_prose_page(ctx: &ToolContext, args: &Value) -> Result<ToolOutcome, String> {
    let parsed: RenameProsePageArgs =
        serde_json::from_value(args.clone()).map_err(|e| format!("Invalid arguments: {}", e))?;
    reject_if_local(ctx, &parsed.doc_id)?;
    let name = parsed.name.trim().to_string();
    if name.is_empty() {
        return Err("Page name must not be empty".into());
    }

    mutate_with_retry(ctx, &parsed.doc_id, |doc| {
        let now = now_ms();
        let rtp = rich_text_pages_mut(doc)?;
        let page = rtp
            .get_mut("pages")
            .and_then(|v| v.as_object_mut())
            .and_then(|pages| pages.get_mut(&parsed.page_id))
            .and_then(|p| p.as_object_mut())
            .ok_or_else(|| format!("Prose page '{}' not found", parsed.page_id))?;
        page.insert("name".into(), json!(name.clone()));
        page.insert("modifiedAt".into(), json!(now));
        stamp_doc_modified(doc, now);
        Ok(())
    })?;

    // JP-339: push the rename to connected clients live (no reload).
    broadcast_prose_page_meta(ctx, &parsed.doc_id, &parsed.page_id);

    Ok(ToolOutcome {
        result: json!({"pageId": parsed.page_id, "name": name}),
        changed_doc_id: Some(parsed.doc_id),
        change_detail: None,
    })
}

// ---------------------------------------------------------------------------
// Canvas-page tools (JP-320). The canvas page LIST (`pages` map + `pageOrder`)
// is JSON-only — only the active page's shapes live in the authoritative Y.Doc
// — so these mirror the prose page-list ops (`add_prose_page` /
// `rename_prose_page`): write the JSON store under optimistic concurrency and
// nudge a reload via `changed_doc_id`.
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct AddCanvasPageArgs {
    #[serde(rename = "docId")]
    doc_id: DocId,
    name: Option<String>,
}

fn add_canvas_page(ctx: &ToolContext, args: &Value) -> Result<ToolOutcome, String> {
    let parsed: AddCanvasPageArgs =
        serde_json::from_value(args.clone()).map_err(|e| format!("Invalid arguments: {}", e))?;
    reject_if_local(ctx, &parsed.doc_id)?;

    let id = mutate_with_retry(ctx, &parsed.doc_id, |doc| {
        let now = now_ms();
        let page_id = format!("page-{}", nanoid::nanoid!(12));
        let existing = page_names(doc.get("pages"));
        let name = parsed
            .name
            .clone()
            .map(|n| n.trim().to_string())
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| {
                next_default_page_name(CANVAS_PAGE_BASE, existing.iter().map(String::as_str))
            });

        let obj = doc.as_object_mut().ok_or("Document is not an object")?;
        obj.entry("pages")
            .or_insert_with(|| json!({}))
            .as_object_mut()
            .ok_or("Document 'pages' is not an object")?
            .insert(
                page_id.clone(),
                json!({
                    "id": page_id,
                    "name": name,
                    "shapes": {},
                    "shapeOrder": [],
                    "createdAt": now,
                    "modifiedAt": now,
                }),
            );
        obj.entry("pageOrder")
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .ok_or("Document 'pageOrder' is not an array")?
            .push(json!(page_id.clone()));

        stamp_doc_modified(doc, now);
        Ok(page_id)
    })?;

    // JP-339: push the new tab into the live `canvasPages` list so connected
    // clients see it without reload.
    broadcast_canvas_page_meta(ctx, &parsed.doc_id, &id);

    Ok(ToolOutcome {
        result: json!({"id": id}),
        changed_doc_id: Some(parsed.doc_id),
        change_detail: None,
    })
}

#[derive(Deserialize)]
struct RenameCanvasPageArgs {
    #[serde(rename = "docId")]
    doc_id: DocId,
    #[serde(rename = "pageId")]
    page_id: String,
    name: String,
}

fn rename_canvas_page(ctx: &ToolContext, args: &Value) -> Result<ToolOutcome, String> {
    let parsed: RenameCanvasPageArgs =
        serde_json::from_value(args.clone()).map_err(|e| format!("Invalid arguments: {}", e))?;
    reject_if_local(ctx, &parsed.doc_id)?;
    let name = parsed.name.trim().to_string();
    if name.is_empty() {
        return Err("Page name must not be empty".into());
    }

    mutate_with_retry(ctx, &parsed.doc_id, |doc| {
        let now = now_ms();
        let page = doc
            .get_mut("pages")
            .and_then(|v| v.as_object_mut())
            .and_then(|pages| pages.get_mut(&parsed.page_id))
            .and_then(|p| p.as_object_mut())
            .ok_or_else(|| format!("Canvas page '{}' not found", parsed.page_id))?;
        page.insert("name".into(), json!(name.clone()));
        page.insert("modifiedAt".into(), json!(now));
        stamp_doc_modified(doc, now);
        Ok(())
    })?;

    // JP-339: push the rename to connected clients live (no reload).
    broadcast_canvas_page_meta(ctx, &parsed.doc_id, &parsed.page_id);

    Ok(ToolOutcome {
        result: json!({"pageId": parsed.page_id, "name": name}),
        changed_doc_id: Some(parsed.doc_id),
        change_detail: None,
    })
}

#[derive(Deserialize)]
struct ReorderCanvasPagesArgs {
    #[serde(rename = "docId")]
    doc_id: DocId,
    order: Vec<String>,
}

fn reorder_canvas_page(ctx: &ToolContext, args: &Value) -> Result<ToolOutcome, String> {
    let parsed: ReorderCanvasPagesArgs =
        serde_json::from_value(args.clone()).map_err(|e| format!("Invalid arguments: {}", e))?;
    reject_if_local(ctx, &parsed.doc_id)?;

    // Persist the new order to JSON under optimistic concurrency. Canvas pages
    // carry no numeric `order` field — the `pageOrder` array IS the order, so
    // there's nothing to renumber (unlike prose pages).
    mutate_with_retry(ctx, &parsed.doc_id, |doc| {
        let current: Vec<String> = doc
            .get("pageOrder")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .unwrap_or_default();
        validate_order(&current, &parsed.order, "canvas page")?;
        doc.as_object_mut()
            .ok_or("Document is not an object")?
            .insert("pageOrder".into(), json!(parsed.order));
        stamp_doc_modified(doc, now_ms());
        Ok(())
    })?;

    // JP-339: push the new tab order to connected clients live (no reload).
    if let Some(handle) = resident_handle(ctx, &parsed.doc_id) {
        let framed = handle.set_canvas_page_order(&parsed.order);
        ctx.broadcast_update(&parsed.doc_id, framed);
    }

    Ok(ToolOutcome {
        result: json!({"order": parsed.order, "ok": true}),
        changed_doc_id: Some(parsed.doc_id),
        change_detail: None,
    })
}

#[derive(Deserialize)]
struct DeleteCanvasPageArgs {
    #[serde(rename = "docId")]
    doc_id: DocId,
    #[serde(rename = "pageId")]
    page_id: String,
}

fn delete_canvas_page(ctx: &ToolContext, args: &Value) -> Result<ToolOutcome, String> {
    let parsed: DeleteCanvasPageArgs =
        serde_json::from_value(args.clone()).map_err(|e| format!("Invalid arguments: {}", e))?;
    reject_if_local(ctx, &parsed.doc_id)?;

    mutate_with_retry(ctx, &parsed.doc_id, |doc| {
        let obj = doc.as_object_mut().ok_or("Document is not an object")?;
        let exists = obj
            .get("pages")
            .and_then(|v| v.as_object())
            .is_some_and(|p| p.contains_key(&parsed.page_id));
        if !exists {
            return Err(format!("Canvas page '{}' not found", parsed.page_id));
        }
        let order_len = obj.get("pageOrder").and_then(|v| v.as_array()).map_or(0, Vec::len);
        if order_len <= 1 {
            return Err("Cannot delete the last canvas page; a document keeps at least one".into());
        }
        if let Some(pages) = obj.get_mut("pages").and_then(|v| v.as_object_mut()) {
            pages.remove(&parsed.page_id);
        }
        if let Some(order) = obj.get_mut("pageOrder").and_then(|v| v.as_array_mut()) {
            order.retain(|v| v.as_str() != Some(parsed.page_id.as_str()));
        }
        // Repoint the top-level activePageId if it was the deleted page.
        if obj.get("activePageId").and_then(|v| v.as_str()) == Some(parsed.page_id.as_str()) {
            let next = obj
                .get("pageOrder")
                .and_then(|v| v.as_array())
                .and_then(|a| a.first())
                .and_then(|v| v.as_str())
                .map(String::from);
            if let Some(next) = next {
                obj.insert("activePageId".into(), json!(next));
            }
        }
        stamp_doc_modified(doc, now_ms());
        Ok(())
    })?;

    if let Some(handle) = resident_handle(ctx, &parsed.doc_id) {
        if handle.page_id() == Some(parsed.page_id.as_str()) {
            // Deleting the hydrated ACTIVE page: evict so a rejoining client
            // re-hydrates from the new `activePageId`. We must evict (not just
            // clear) because `snapshot_doc`'s divergence guard skips persistence
            // once the stored `activePageId` no longer matches this handle's
            // hydrated page — so the handle can no longer durably flatten. The
            // JSON delete above is persisted; the re-hydrate rebuilds every
            // page's surface + `canvasPages` without the deleted page (JP-340).
            ctx.registry.evict(&ctx.workspace_id, &parsed.doc_id);
        } else {
            // Resident on a DIFFERENT page (JP-340): clear the deleted page's own
            // shape surface AND remove its tab from the live `canvasPages` list,
            // broadcasting both so the tab and its shapes vanish without a reload.
            let framed = handle.clear_shapes(&parsed.page_id);
            ctx.broadcast_update(&parsed.doc_id, framed);
            let framed = handle.remove_canvas_page(&parsed.page_id);
            ctx.broadcast_update(&parsed.doc_id, framed);
        }
    }

    Ok(ToolOutcome {
        result: json!({"deleted": parsed.page_id}),
        changed_doc_id: Some(parsed.doc_id),
        change_detail: None,
    })
}

/// Stamp the document's top-level `modifiedAt` (prose edits don't belong to
/// a canvas page, so `stamp_modified`'s page arm doesn't apply).
fn stamp_doc_modified(doc: &mut Value, now: u64) {
    if let Some(o) = doc.as_object_mut() {
        o.insert("modifiedAt".into(), json!(now));
    }
}

/// Read a prose page's HTML content. Errors if the page doesn't exist;
/// returns "" for an existing page with no content yet.
fn read_prose_content(doc: &Value, page_id: &str) -> Result<String, String> {
    let page = doc
        .get("richTextPages")
        .and_then(|r| r.get("pages"))
        .and_then(|p| p.get(page_id))
        .ok_or_else(|| format!("Prose page '{}' not found", page_id))?;
    Ok(page.get("content").and_then(|c| c.as_str()).unwrap_or("").to_string())
}

/// Write a prose page's content + bump its `modifiedAt`. Mirrors the lookup
/// in `set_prose`; used by the structural tools.
fn write_prose_content(doc: &mut Value, page_id: &str, html: String, now: u64) -> Result<(), String> {
    let rtp = rich_text_pages_mut(doc)?;
    let page = rtp
        .get_mut("pages")
        .and_then(|v| v.as_object_mut())
        .and_then(|pages| pages.get_mut(page_id))
        .and_then(|p| p.as_object_mut())
        .ok_or_else(|| format!("Prose page '{}' not found", page_id))?;
    page.insert("content".into(), json!(html));
    page.insert("modifiedAt".into(), json!(now));
    stamp_doc_modified(doc, now);
    Ok(())
}

/// Effective prose for one page (JP-201): the live Y.Doc fragment when the doc
/// is resident and the page has live content, else the JSON projection. Errors
/// (page not found) only when neither source has it.
fn resolve_prose_content(
    ctx: &ToolContext,
    doc_id: &DocId,
    doc: &Value,
    page_id: &str,
) -> Result<String, String> {
    if let Some(handle) = resident_handle(ctx, doc_id) {
        if let Some(html) = handle.prose_html(page_id) {
            return Ok(html);
        }
    }
    read_prose_content(doc, page_id)
}

/// Effective prose pages (JP-201): the JSON `richTextPages` list with each
/// page's `content` overlaid from the live Y.Doc when the doc is resident.
/// Content is authoritative from the live fragment; `name`/`order` come from
/// JSON (that page metadata isn't CRDT-synced). A live-only page (fragment with
/// no JSON entry) is appended with a default name. `(id, name, order, content)`
/// in JSON `pageOrder` order, live-only pages after.
fn resolve_prose_pages(
    ctx: &ToolContext,
    doc_id: &DocId,
    doc: &Value,
) -> Vec<(String, Value, Value, String)> {
    let empty = json!({});
    let rtp = doc.get("richTextPages");
    let pages_obj = rtp.and_then(|r| r.get("pages")).unwrap_or(&empty);
    let order: Vec<String> = rtp
        .and_then(|r| r.get("pageOrder"))
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();

    let mut pages: Vec<(String, Value, Value, String)> = order
        .iter()
        .filter_map(|id| {
            let page = pages_obj.get(id)?;
            Some((
                id.clone(),
                page.get("name").cloned().unwrap_or(json!("")),
                page.get("order").cloned().unwrap_or(json!(0)),
                page.get("content").and_then(|c| c.as_str()).unwrap_or("").to_string(),
            ))
        })
        .collect();

    if let Some(handle) = resident_handle(ctx, doc_id) {
        for (id, html) in handle.prose_pages() {
            match pages.iter_mut().find(|e| e.0 == id) {
                Some(entry) => entry.3 = html,
                None => {
                    let order_idx = pages.len() as i64;
                    pages.push((id, json!("Untitled"), json!(order_idx), html));
                }
            }
        }
    }
    pages
}

/// Summarise an outline's sections as `[{index, level, title}]`.
fn outline_summary(outline: &Outline) -> Vec<Value> {
    outline
        .sections
        .iter()
        .enumerate()
        .map(|(i, s)| json!({"index": i, "level": s.level, "title": s.title}))
        .collect()
}

#[derive(Deserialize)]
struct GetOutlineArgs {
    #[serde(rename = "docId")]
    doc_id: DocId,
    #[serde(rename = "pageId")]
    page_id: String,
}

fn get_outline(ctx: &ToolContext, args: &Value) -> Result<ToolOutcome, String> {
    let parsed: GetOutlineArgs =
        serde_json::from_value(args.clone()).map_err(|e| format!("Invalid arguments: {}", e))?;
    let (doc, source) = fetch_doc(ctx, &parsed.doc_id)?;
    let content = resolve_prose_content(ctx, &parsed.doc_id, &doc, &parsed.page_id)?;
    let outline = Outline::parse(&content);
    Ok(ToolOutcome {
        result: json!({"outline": outline_summary(&outline), "source": source}),
        changed_doc_id: None,
        change_detail: None,
    })
}

#[derive(Deserialize)]
struct InsertSectionArgs {
    #[serde(rename = "docId")]
    doc_id: DocId,
    #[serde(rename = "pageId")]
    page_id: String,
    level: i64,
    title: String,
    body: Option<String>,
    format: Option<String>,
    position: Option<String>,
    #[serde(rename = "afterIndex")]
    after_index: Option<usize>,
}

fn insert_section(ctx: &ToolContext, args: &Value) -> Result<ToolOutcome, String> {
    let parsed: InsertSectionArgs =
        serde_json::from_value(args.clone()).map_err(|e| format!("Invalid arguments: {}", e))?;
    reject_if_local(ctx, &parsed.doc_id)?;

    let level = clamp_level(parsed.level);
    // JP-312 talk-back: report when the requested heading level was clamped.
    let mut fixes = Vec::new();
    if i64::from(level) != parsed.level {
        fixes.push(ShapeFix {
            field: "level".into(),
            action: FixAction::Clamped,
            reason: format!(
                "heading level {} clamped to {} (valid range 1–6)",
                parsed.level, level
            ),
        });
    }
    let title = parsed.title.trim().to_string();
    let inner_html = escape_html(&title);
    // Render the body once, up front, so a bad format fails before any write.
    let body_html = match &parsed.body {
        Some(b) => {
            check_prose_size(b)?;
            content_to_html(b, parsed.format.as_deref())?
        }
        None => String::new(),
    };

    // Read the current page content (live if resident, else JSON), apply the
    // insert, then write the whole page back live-or-JSON (JP-238).
    let (doc_json, _) = fetch_doc(ctx, &parsed.doc_id)?;
    let current = resolve_prose_content(ctx, &parsed.doc_id, &doc_json, &parsed.page_id)?;
    let mut outline = Outline::parse(&current);
    let len = outline.sections.len();
    let pos = match parsed.after_index {
        Some(ai) => (ai + 1).min(len),
        None => match parsed.position.as_deref() {
            Some("start") => 0,
            _ => len,
        },
    };
    outline.sections.insert(pos, Section { level, inner_html, title, body_html });
    let new_html = outline.to_html();

    write_prose_page_live_or_json(ctx, &parsed.doc_id, &parsed.page_id, &new_html, |doc| {
        write_prose_content(doc, &parsed.page_id, new_html.clone(), now_ms())
    })?;

    let mut result = json!({"pageId": parsed.page_id, "ok": true});
    attach_fixes(&mut result, &fixes);
    Ok(ToolOutcome {
        result,
        changed_doc_id: Some(parsed.doc_id),
        change_detail: None,
    })
}

#[derive(Deserialize)]
struct RestructureOutlineArgs {
    #[serde(rename = "docId")]
    doc_id: DocId,
    #[serde(rename = "pageId")]
    page_id: String,
    op: String,
    index: usize,
    #[serde(rename = "toIndex")]
    to_index: Option<usize>,
}

fn restructure_outline(ctx: &ToolContext, args: &Value) -> Result<ToolOutcome, String> {
    let parsed: RestructureOutlineArgs =
        serde_json::from_value(args.clone()).map_err(|e| format!("Invalid arguments: {}", e))?;
    reject_if_local(ctx, &parsed.doc_id)?;

    // Read current content (live if resident, else JSON), apply the op, then
    // write the whole page back live-or-JSON (JP-238).
    let (doc_json, _) = fetch_doc(ctx, &parsed.doc_id)?;
    let current = resolve_prose_content(ctx, &parsed.doc_id, &doc_json, &parsed.page_id)?;
    let mut outline = Outline::parse(&current);
    let n = outline.sections.len();
    if parsed.index >= n {
        return Err(format!(
            "No section at index {} — the page has {} heading(s)",
            parsed.index, n
        ));
    }
    let mut fixes = Vec::new();
    match parsed.op.as_str() {
        "promote" => {
            let lvl = outline.sections[parsed.index].level as i64;
            let new = clamp_level(lvl - 1);
            if i64::from(new) == lvl {
                fixes.push(boundary_noop_fix(parsed.op.as_str(), lvl));
            }
            outline.sections[parsed.index].level = new;
        }
        "demote" => {
            let lvl = outline.sections[parsed.index].level as i64;
            let new = clamp_level(lvl + 1);
            if i64::from(new) == lvl {
                fixes.push(boundary_noop_fix(parsed.op.as_str(), lvl));
            }
            outline.sections[parsed.index].level = new;
        }
        "move" => {
            let to = parsed.to_index.ok_or("op 'move' requires 'toIndex'")?.min(n - 1);
            let section = outline.sections.remove(parsed.index);
            outline.sections.insert(to, section);
        }
        other => {
            return Err(format!(
                "Unknown op '{}'; expected 'promote', 'demote', or 'move'",
                other
            ))
        }
    }
    let summary = outline_summary(&outline);
    let new_html = outline.to_html();

    write_prose_page_live_or_json(ctx, &parsed.doc_id, &parsed.page_id, &new_html, |doc| {
        write_prose_content(doc, &parsed.page_id, new_html.clone(), now_ms())
    })?;

    let mut result = json!({"pageId": parsed.page_id, "outline": summary});
    attach_fixes(&mut result, &fixes);
    Ok(ToolOutcome {
        result,
        changed_doc_id: Some(parsed.doc_id),
        change_detail: None,
    })
}

/// JP-312 talk-back: a promote/demote that couldn't move because the heading is
/// already at the 1–6 boundary — surfaced so the agent doesn't assume it shifted.
fn boundary_noop_fix(op: &str, level: i64) -> ShapeFix {
    ShapeFix {
        field: "op".into(),
        action: FixAction::Clamped,
        reason: format!("'{op}' had no effect — heading already at level {level} (range 1–6)"),
    }
}

// ---------------------------------------------------------------------------
// Bulk diagram generation (JP-93 Slice D): turn a node/edge graph into shapes
// + connectors in one call, auto-positioned by the relay.
// ---------------------------------------------------------------------------

/// Caps to keep a single call bounded (rate limiting handles repeated abuse;
/// this guards one pathologically large request).
const MAX_DIAGRAM_NODES: usize = 500;
const MAX_DIAGRAM_EDGES: usize = 1000;

#[derive(Deserialize)]
struct GenNode {
    id: String,
    label: Option<String>,
    kind: Option<String>,
}

#[derive(Deserialize)]
struct GenEdge {
    from: String,
    to: String,
    label: Option<String>,
}

#[derive(Deserialize)]
struct GenerateDiagramArgs {
    #[serde(rename = "docId")]
    doc_id: DocId,
    #[serde(rename = "pageId")]
    page_id: String,
    nodes: Vec<GenNode>,
    #[serde(default)]
    edges: Vec<GenEdge>,
    layout: Option<String>,
    routing: Option<String>,
}

fn generate_diagram(ctx: &ToolContext, args: &Value) -> Result<ToolOutcome, String> {
    let parsed: GenerateDiagramArgs =
        serde_json::from_value(args.clone()).map_err(|e| format!("Invalid arguments: {}", e))?;
    reject_if_local(ctx, &parsed.doc_id)?;

    if parsed.nodes.is_empty() {
        return Err("'nodes' must contain at least one node".into());
    }
    if parsed.nodes.len() > MAX_DIAGRAM_NODES {
        return Err(format!("too many nodes ({}); max {}", parsed.nodes.len(), MAX_DIAGRAM_NODES));
    }
    if parsed.edges.len() > MAX_DIAGRAM_EDGES {
        return Err(format!("too many edges ({}); max {}", parsed.edges.len(), MAX_DIAGRAM_EDGES));
    }

    // Validate node ids are unique + non-empty, and that every edge endpoint
    // names a known node — before we create anything.
    let mut node_ids: Vec<String> = Vec::with_capacity(parsed.nodes.len());
    let mut seen = std::collections::HashSet::new();
    for n in &parsed.nodes {
        let id = n.id.trim();
        if id.is_empty() {
            return Err("every node needs a non-empty 'id'".into());
        }
        if !seen.insert(id.to_string()) {
            return Err(format!("duplicate node id '{}'", id));
        }
        node_ids.push(id.to_string());
    }
    for (i, e) in parsed.edges.iter().enumerate() {
        if !seen.contains(e.from.trim()) {
            return Err(format!("edge[{}] 'from' references unknown node '{}'", i, e.from));
        }
        if !seen.contains(e.to.trim()) {
            return Err(format!("edge[{}] 'to' references unknown node '{}'", i, e.to));
        }
    }

    // Mode: explicit wins; otherwise layered when there are edges to lay out.
    let mode = match parsed.layout.as_deref() {
        Some("layered") => LayoutMode::Layered,
        Some("grid") => LayoutMode::Grid,
        Some(other) => return Err(format!("Unknown layout '{}'; expected 'layered' or 'grid'", other)),
        None if parsed.edges.is_empty() => LayoutMode::Grid,
        None => LayoutMode::Layered,
    };
    let edge_pairs: Vec<(String, String)> = parsed
        .edges
        .iter()
        .map(|e| (e.from.trim().to_string(), e.to.trim().to_string()))
        .collect();
    let node_specs: Vec<NodeSpec> = node_ids
        .iter()
        .map(|id| NodeSpec { id: id.clone(), w: NODE_W, h: NODE_H })
        .collect();
    // Routing: orthogonal obstacle-avoiding waypoints by default; "straight"
    // keeps plain anchor-to-anchor connectors (no routed-path fields).
    let orthogonal = match parsed.routing.as_deref() {
        Some("orthogonal") | None => true,
        Some("straight") => false,
        Some(other) => {
            return Err(format!("Unknown routing '{}'; expected 'orthogonal' or 'straight'", other))
        }
    };
    let diagram = if orthogonal {
        layout_and_route(&node_specs, &edge_pairs, mode)
    } else {
        layout_diagram(&node_specs, &edge_pairs, mode)
    };

    // Build every shape up front with a pre-assigned id (nodes first, then
    // edges) so the live and cold write paths persist the identical set and the
    // returned id map is stable regardless of which path runs. Connectors carry
    // the node shape ids, which are assigned in this same pass before either
    // path runs. Mirrors `add_shapes` — `generate_diagram` previously wrote the
    // JSON store directly, so on a resident doc its shapes never reached the
    // authoritative Y.Doc and could be clobbered by the live doc on flatten.
    let mut node_map = serde_json::Map::new();
    let mut shapes: Vec<(String, DslShape)> =
        Vec::with_capacity(parsed.nodes.len() + parsed.edges.len());
    for (n, (_, pos)) in parsed.nodes.iter().zip(diagram.nodes.iter()) {
        let kind = match n.kind.as_deref() {
            Some("ellipse") => super::adapter::DslKind::Ellipse,
            _ => super::adapter::DslKind::Rectangle,
        };
        let mut dsl = DslShape {
            kind,
            x: pos.x,
            y: pos.y,
            w: Some(NODE_W),
            h: Some(NODE_H),
            text: Some(n.label.clone().unwrap_or_else(|| n.id.clone())),
            style: None,
            id: None,
            icon_id: None,
            icon_display_mode: None,
            icon_size: None,
            start_shape_id: None,
            end_shape_id: None,
            start_anchor: None,
            end_anchor: None,
            start_arrow_style: None,
            end_arrow_style: None,
            routing_mode: None,
            waypoints: None,
            label_position: None,
            x2: None,
            y2: None,
            unknown: serde_json::Map::new(),
        };
        let id = shape_id_or_gen(&dsl);
        dsl.id = Some(id.clone());
        node_map.insert(n.id.trim().to_string(), json!(id));
        shapes.push((id, dsl));
    }

    let mut edge_ids = Vec::with_capacity(parsed.edges.len());
    for (e, routed) in parsed.edges.iter().zip(diagram.edges.iter()) {
        let from = node_map.get(e.from.trim()).and_then(|v| v.as_str()).unwrap().to_string();
        let to = node_map.get(e.to.trim()).and_then(|v| v.as_str()).unwrap().to_string();
        let mut dsl = DslShape {
            kind: super::adapter::DslKind::Connector,
            x: routed.start.x,
            y: routed.start.y,
            w: None,
            h: None,
            text: e.label.clone(),
            style: None,
            id: None,
            icon_id: None,
            icon_display_mode: None,
            icon_size: None,
            start_shape_id: Some(from),
            end_shape_id: Some(to),
            start_anchor: Some(routed.start_anchor.as_str().to_string()),
            end_anchor: Some(routed.end_anchor.as_str().to_string()),
            start_arrow_style: None,
            end_arrow_style: None,
            routing_mode: orthogonal.then(|| "orthogonal".to_string()),
            waypoints: orthogonal.then(|| {
                routed
                    .waypoints
                    .iter()
                    .map(|p| super::adapter::DslPoint { x: p.x, y: p.y })
                    .collect()
            }),
            label_position: routed.label_position,
            x2: Some(routed.end.x),
            y2: Some(routed.end.y),
            unknown: serde_json::Map::new(),
        };
        let id = shape_id_or_gen(&dsl);
        dsl.id = Some(id.clone());
        edge_ids.push(json!(id));
        shapes.push((id, dsl));
    }

    let result = json!({
        "nodes": node_map,
        "edges": edge_ids,
        "layout": match mode { LayoutMode::Layered => "layered", LayoutMode::Grid => "grid" },
        "routing": if orthogonal { "orthogonal" } else { "straight" },
    });

    write_shape_live_or_json(
        ctx,
        &parsed.doc_id,
        &parsed.page_id,
        |handle, page_id| {
            // One transaction, single broadcast (atomic) — same as `add_shapes`.
            let items: Vec<(String, Value)> =
                shapes.iter().map(|(id, dsl)| (id.clone(), build_shape_json(dsl, id))).collect();
            let framed = handle.insert_shapes(page_id, &items)?;
            Ok((framed, result.clone()))
        },
        |doc| {
            for (idx, (_, dsl)) in shapes.iter().enumerate() {
                if let Err(e) = append_shape_in_place(doc, &parsed.page_id, dsl) {
                    return Err(format!("shape[{}]: {}", idx, e));
                }
            }
            stamp_modified(doc, &parsed.page_id);
            Ok(result.clone())
        },
    )
}

#[derive(Deserialize)]
struct AddShapeArgs {
    #[serde(rename = "docId")]
    doc_id: DocId,
    #[serde(rename = "pageId")]
    page_id: String,
    shape: DslShape,
}

/// Reject writes targeting a local-mirror document. Centralised here so
/// every mutating tool enforces the same contract — see AGENTS.md "MCP
/// Integration" for the rationale.
fn reject_if_local(ctx: &ToolContext, doc_id: &DocId) -> Result<(), String> {
    // The `local_enabled` short-circuit looks like it *weakens* the guard when
    // local access is off (e.g. a public mount, JP-235) — it doesn't. The guard
    // exists to stop a write from clobbering a renderer-owned doc that's mirrored
    // read-only. That mirror is only ever populated by a desktop renderer, so on
    // a headless/public pod `ctx.local.contains(...)` is always false and this
    // was already a no-op. With the mirror unreadable, a "local" id simply isn't
    // found in the team store and the write fails not-found — no local doc is
    // ever read or mutated. Do not "simplify" by dropping the `local_enabled`
    // term: on the loopback listener it's what makes the mirror reachable.
    if ctx.local_enabled
        && ctx.local.contains(&ctx.workspace_id, doc_id.as_str())
        && ctx.team.get_document(&ctx.workspace_id, doc_id).is_err()
    {
        return Err(
            "This is a local (renderer-owned) document and is read-only via MCP. \
             Promote it to a team document to enable writes."
                .into(),
        );
    }
    Ok(())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn lock_warning(doc: &Value) -> Option<String> {
    doc.get("lockedBy")
        .and_then(|v| v.as_str())
        .map(|uid| format!("Document is locked by user '{}' — write may be overwritten.", uid))
}

/// The shape id a DSL shape will use: its caller-supplied id, or a fresh one.
fn shape_id_or_gen(shape: &DslShape) -> String {
    shape
        .id
        .clone()
        .unwrap_or_else(|| format!("shape-{}", nanoid::nanoid!(10)))
}

/// Stamp a shape with MCP write provenance (JP-35). Durable, additive, and
/// namespaced so it survives flatten → JSON → reload without colliding with
/// shape geometry. Groundwork for agent-change highlighting (JP-202); the
/// ephemeral "recent change" view is *derived* from `at`. Applied identically
/// on the live-Y.Doc and JSON write paths so attribution doesn't depend on
/// which backend served the write.
fn stamp_provenance(shape: &mut Value) {
    if let Some(obj) = shape.as_object_mut() {
        obj.insert("provenance".into(), json!({"source": "mcp", "at": now_ms()}));
    }
}

/// Build the on-disk shape JSON for a DSL shape, provenance-stamped. The one
/// chokepoint both write paths route through.
fn build_shape_json(shape: &DslShape, id: &str) -> Value {
    let mut json = dsl_to_shape_json(shape, id);
    stamp_provenance(&mut json);
    json
}

/// Resolve the live authoritative Y.Doc handle for a write, but only when the
/// JP-35 two-condition gate holds: the doc is **resident** in the registry
/// (clients are connected → it's hydrated) *and* the target `page_id` is the
/// page the handle was hydrated from (`activePageId`). Anything else — closed
/// doc, or a non-active page the live Y.Doc doesn't physically hold — returns
/// `None`, and the caller falls back to the durable JSON path.
/// Shared shape-write dispatch (JP-250 / JP-340). Applies to the live Y.Doc when
/// the doc is resident — on ANY page, since shapes are now per-page
/// (`shapes:<pageId>`, JP-340) — broadcasting the CRDT delta, no `DocEvent`
/// (clients merge — JP-35) — else to the JSON store under optimistic concurrency,
/// with a `DocEvent` (`changed_doc_id`) so a running app reloads. Each shape tool
/// supplies just its two effects (each returning the result JSON): the `live`
/// op (given the handle + target `page_id` → framed delta + result) and the
/// `cold` op. Centralizing the gate, the broadcast, and the `changed_doc_id`
/// convention here keeps the cold path from silently drifting from the live one.
fn write_shape_live_or_json(
    ctx: &ToolContext,
    doc_id: &DocId,
    page_id: &str,
    live: impl FnOnce(&DocHandle, &str) -> Result<(Vec<u8>, Value), String>,
    cold: impl FnMut(&mut Value) -> Result<Value, String>,
) -> Result<ToolOutcome, String> {
    if let Some(handle) = resident_handle(ctx, doc_id) {
        let (framed, result) = live(handle.as_ref(), page_id)?;
        ctx.broadcast_update(doc_id, framed);
        Ok(ToolOutcome { result, changed_doc_id: None, change_detail: None })
    } else {
        let result = mutate_with_retry(ctx, doc_id, cold)?;
        Ok(ToolOutcome {
            result,
            changed_doc_id: Some(doc_id.clone()),
            change_detail: None,
        })
    }
}

/// The live Y.Doc handle for a doc that's **resident** in the registry (clients
/// connected → it's hydrated). Since JP-340 every page is live (shapes are
/// per-page, like prose's `prose:<pageId>` fragments), so there's no active-page
/// gate: any resident doc serves reads/writes for any of its pages. Shared by the
/// shape read/write paths, the JP-201 prose read resolvers, and the JP-238 prose
/// write path.
fn resident_handle(ctx: &ToolContext, doc_id: &DocId) -> Option<Arc<DocHandle>> {
    ctx.registry.get(&ctx.workspace_id, doc_id)
}

/// The full stored metadata object for a prose page (incl. content), read from
/// the just-persisted JSON — the source the live page-list write strips content
/// from. `None` if the doc or page is absent. (JP-339)
fn read_prose_page_json(ctx: &ToolContext, doc_id: &DocId, page_id: &str) -> Option<Value> {
    let doc = ctx.team.get_document(&ctx.workspace_id, doc_id).ok()?;
    doc.get("richTextPages")
        .and_then(|r| r.get("pages"))
        .and_then(|p| p.get(page_id))
        .cloned()
}

/// Push a prose page-list metadata upsert to connected clients (JP-339): when the
/// doc is resident, broadcast the `prosePages` delta for `page_id` (read from the
/// just-persisted JSON) so the tab appears/renames LIVE — removing the reload that
/// triggered the JP-338 prose dup. No-op when the doc isn't resident (a cold
/// `changed_doc_id` nudge still reloads it).
fn broadcast_prose_page_meta(ctx: &ToolContext, doc_id: &DocId, page_id: &str) {
    if let Some(handle) = resident_handle(ctx, doc_id) {
        if let Some(page) = read_prose_page_json(ctx, doc_id, page_id) {
            let framed = handle.set_prose_page_meta(page_id, &page);
            ctx.broadcast_update(doc_id, framed);
        }
    }
}

/// The full stored metadata object for a canvas page (incl. shapes), read from
/// the just-persisted JSON — the source the live page-list write strips
/// shapes/shapeOrder from. `None` if the doc or page is absent. (JP-339)
fn read_canvas_page_json(ctx: &ToolContext, doc_id: &DocId, page_id: &str) -> Option<Value> {
    let doc = ctx.team.get_document(&ctx.workspace_id, doc_id).ok()?;
    doc.get("pages").and_then(|p| p.get(page_id)).cloned()
}

/// Push a canvas page-list metadata upsert to connected clients (JP-339): when the
/// doc is resident, broadcast the `canvasPages` delta for `page_id` (read from the
/// just-persisted JSON) so the tab appears/renames LIVE — no reload. No-op when the
/// doc isn't resident (a cold `changed_doc_id` nudge still reloads it).
fn broadcast_canvas_page_meta(ctx: &ToolContext, doc_id: &DocId, page_id: &str) {
    if let Some(handle) = resident_handle(ctx, doc_id) {
        if let Some(page) = read_canvas_page_json(ctx, doc_id, page_id) {
            let framed = handle.set_canvas_page_meta(page_id, &page);
            ctx.broadcast_update(doc_id, framed);
        }
    }
}

/// Write a prose page's full HTML to the **live** Y.Doc fragment when the doc is
/// resident — broadcasting the CRDT delta so connected editors update live
/// (JP-238, whole-page replace) — else fall back to the JSON path. The live path
/// leaves durability to the JP-36/JP-201 snapshot flatten (which projects prose
/// into the JSON), exactly like the JP-35 shape write path.
fn write_prose_page_live_or_json(
    ctx: &ToolContext,
    doc_id: &DocId,
    page_id: &str,
    html: &str,
    json_fallback: impl FnMut(&mut Value) -> Result<(), String>,
) -> Result<(), String> {
    if let Some(handle) = resident_handle(ctx, doc_id) {
        let framed = handle.replace_prose(page_id, html)?;
        ctx.broadcast_update(doc_id, framed);
        Ok(())
    } else {
        mutate_with_retry(ctx, doc_id, json_fallback).map(|_| ())
    }
}

/// Anchored, block-level prose write (JP-239): replace only the block(s) matching
/// `anchor` with `html`. Mirrors [`write_prose_page_live_or_json`] — live to the
/// resident Y.Doc fragment (minimal delta, broadcast so connected editors merge
/// it), else apply the same block surgery on the page's JSON `content` under
/// optimistic concurrency. The anchor is matched against authoritative state
/// (the live fragment when resident; the JSON content when cold), so a stale
/// anchor is refused with `ERR_ANCHOR_*` in both modes.
fn write_prose_block_live_or_json(
    ctx: &ToolContext,
    doc_id: &DocId,
    page_id: &str,
    anchor: &str,
    anchor_until: Option<&str>,
    html: &str,
) -> Result<(), String> {
    if let Some(handle) = resident_handle(ctx, doc_id) {
        let framed = handle.replace_prose_block(page_id, anchor, anchor_until, html)?;
        ctx.broadcast_update(doc_id, framed);
        Ok(())
    } else {
        mutate_with_retry(ctx, doc_id, |doc| {
            let now = now_ms();
            let current = read_prose_content(doc, page_id)?;
            let new_html =
                crate::sync::replace_block_in_html(&current, anchor, anchor_until, html)?;
            let rtp = rich_text_pages_mut(doc)?;
            let page = rtp
                .get_mut("pages")
                .and_then(|v| v.as_object_mut())
                .and_then(|pages| pages.get_mut(page_id))
                .and_then(|p| p.as_object_mut())
                .ok_or_else(|| format!("Prose page '{}' not found", page_id))?;
            page.insert("content".into(), json!(new_html));
            page.insert("modifiedAt".into(), json!(now));
            stamp_doc_modified(doc, now);
            Ok(())
        })
        .map(|_| ())
    }
}

/// Insert one DSL shape into a doc that's already in memory. Returns the
/// id used. Does **not** save — callers batch a sequence of these and
/// then call `save_document` once, so a partial failure rolls back by
/// virtue of discarding the in-memory doc.
fn append_shape_in_place(doc: &mut Value, page_id: &str, shape: &DslShape) -> Result<String, String> {
    let id = shape_id_or_gen(shape);
    let shape_json = build_shape_json(shape, &id);

    let pages = doc
        .get_mut("pages")
        .and_then(|v| v.as_object_mut())
        .ok_or("Document missing 'pages'")?;
    let page = pages
        .get_mut(page_id)
        .and_then(|v| v.as_object_mut())
        .ok_or_else(|| format!("Page '{}' not found", page_id))?;

    let shapes = page
        .entry("shapes")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or("Page 'shapes' is not an object")?;
    if shapes.contains_key(&id) {
        return Err(format!("Shape id '{}' already exists on page", id));
    }
    shapes.insert(id.clone(), shape_json);

    let order = page
        .entry("shapeOrder")
        .or_insert_with(|| json!([]))
        .as_array_mut()
        .ok_or("Page 'shapeOrder' is not an array")?;
    order.push(json!(id.clone()));

    Ok(id)
}

/// Maximum optimistic-concurrency retries before a write gives up. A
/// conflict means a concurrent writer (a live collaborator's WS save, or
/// another MCP call) bumped the doc's `serverVersion` between our read and
/// save; we re-read and replay the mutation. Five attempts comfortably
/// absorbs realistic contention without spinning.
const MAX_WRITE_ATTEMPTS: usize = 5;

/// Read a team doc, apply `mutate`, then persist under optimistic
/// concurrency, retrying on `VersionConflict`. This is the write path for
/// every mutating MCP tool: the previous code called the unconditional
/// `save_document` (last-writer-wins), which silently clobbered concurrent
/// edits from a live collaborator. We instead echo the doc's `serverVersion`
/// back as the expected version (see `documents.rs`) so a stale write is
/// rejected and replayed on a fresh read.
///
/// `mutate` may run more than once (once per attempt), so it must be a pure
/// function of the doc it's handed — don't capture side effects. It returns
/// whatever per-call value the tool reports (an id, a list of ids, …); the
/// value from the attempt that actually persisted is returned.
///
/// A doc that predates server versioning has no `serverVersion` field; in
/// that case `expected` is `None` and the save proceeds unconditionally
/// (matching the prior behavior for legacy docs — they can't conflict).
fn mutate_with_retry<R>(
    ctx: &ToolContext,
    doc_id: &DocId,
    mut mutate: impl FnMut(&mut Value) -> Result<R, String>,
) -> Result<R, String> {
    let mut last_seen = 0u64;
    for _ in 0..MAX_WRITE_ATTEMPTS {
        let mut doc = ctx.team.get_document(&ctx.workspace_id, doc_id)?;
        let expected = doc.get("serverVersion").and_then(|v| v.as_u64());
        let value = mutate(&mut doc)?;
        match ctx
            .team
            .save_document_with_expected_version(&ctx.workspace_id, doc, expected)?
        {
            SaveOutcome::Created { .. } | SaveOutcome::Updated { .. } => return Ok(value),
            SaveOutcome::VersionConflict { current } => {
                last_seen = current;
                continue;
            }
            // JP-375: the doc was deleted out from under this write. MCP edits an
            // existing doc (read-then-save), so a tombstone mid-write means it's
            // gone — surface it rather than resurrecting it.
            SaveOutcome::Tombstoned => {
                return Err(format!(
                    "document '{}' was deleted during the write — re-read and try again",
                    doc_id.as_str()
                ));
            }
        }
    }
    Err(format!(
        "document '{}' was modified concurrently during the write (current version {}); \
         retried {} times without success — re-read and try again",
        doc_id.as_str(),
        last_seen,
        MAX_WRITE_ATTEMPTS
    ))
}

// ============ Citations / references (JP-89 slice 6) ============

#[derive(Deserialize)]
struct ListReferencesArgs {
    #[serde(rename = "docId")]
    doc_id: DocId,
}

/// Read a document's reference library as CSL-JSON in display order. Read-only.
/// Reads the live Y.Doc library when the doc is resident (so an agent sees refs a
/// peer/agent just added before the next flatten), else the JSON snapshot.
fn list_references(ctx: &ToolContext, args: &Value) -> Result<ToolOutcome, String> {
    let parsed: ListReferencesArgs =
        serde_json::from_value(args.clone()).map_err(|e| format!("Invalid arguments: {}", e))?;

    let result = if let Some(handle) = resident_handle(ctx, &parsed.doc_id) {
        let items = handle.references_json();
        let order = handle.reference_order();
        let mut payload =
            super::citations::list_payload(&items, &order, handle.citation_style().as_deref());
        if let Some(obj) = payload.as_object_mut() {
            obj.insert("source".into(), json!(SOURCE_TEAM));
        }
        payload
    } else {
        let (doc, source) = fetch_doc(ctx, &parsed.doc_id)?;
        let mut payload = super::citations::list_references_json(&doc);
        if let Some(obj) = payload.as_object_mut() {
            obj.insert("source".into(), json!(source));
        }
        payload
    };
    Ok(ToolOutcome { result, changed_doc_id: None, change_detail: None })
}

#[derive(Deserialize)]
struct AddReferenceArgs {
    #[serde(rename = "docId")]
    doc_id: DocId,
    // `doi` is resolved upstream in the transport layer and injected as
    // `items`, so it isn't read here — serde ignores it (no deny_unknown_fields).
    #[serde(default)]
    items: Option<Vec<Value>>,
}

/// Add reference(s) to a document's CSL-JSON library. The DOI form is resolved
/// to a CSL item upstream (transport) and arrives as `items`. When the doc is
/// **resident**, writes the live Y.Doc `references` map per item + broadcasts the
/// CRDT delta (so MCP and editor adds converge — JP-89), mirroring the shape
/// live-write path; else writes the JSON snapshot under optimistic concurrency.
fn add_reference(ctx: &ToolContext, args: &Value) -> Result<ToolOutcome, String> {
    let parsed: AddReferenceArgs =
        serde_json::from_value(args.clone()).map_err(|e| format!("Invalid arguments: {}", e))?;

    reject_if_local(ctx, &parsed.doc_id)?;

    let items = parsed.items.unwrap_or_default();
    if items.is_empty() {
        return Err("add_reference requires 'doi' or non-empty 'items'".into());
    }

    // Resident → live Y.Doc per-item write (INVARIANT A) + broadcast; the client's
    // references observer merges it, so no reload nudge (changed_doc_id None).
    if let Some(handle) = resident_handle(ctx, &parsed.doc_id) {
        let existing = handle.references_json();
        let plan = super::citations::plan_additions(&existing, &items)?;
        if !plan.added.is_empty() {
            let framed = handle.insert_references(&plan.added);
            ctx.broadcast_update(&parsed.doc_id, framed);
        }
        let added: Vec<String> = plan.added.iter().map(|(id, _)| id.clone()).collect();
        return Ok(ToolOutcome {
            result: json!({
                "added": added,
                "addedCount": added.len(),
                "duplicates": plan.duplicates,
            }),
            changed_doc_id: None,
            change_detail: None,
        });
    }

    // Cold path: JSON snapshot under optimistic concurrency.
    let lock = {
        let (doc, _) = fetch_doc(ctx, &parsed.doc_id)?;
        lock_warning(&doc)
    };
    let outcome = mutate_with_retry(ctx, &parsed.doc_id, |doc| {
        let out = super::citations::add_references_in_place(doc, &items)?;
        stamp_doc_modified(doc, now_ms());
        Ok(out)
    })?;

    let mut result = json!({
        "added": outcome.added,
        "addedCount": outcome.added.len(),
        "duplicates": outcome.duplicates,
    });
    if let Some(w) = lock {
        result.as_object_mut().unwrap().insert("warning".into(), json!(w));
    }

    Ok(ToolOutcome {
        result,
        changed_doc_id: Some(parsed.doc_id.clone()),
        change_detail: None,
    })
}

// ---------------------------------------------------------------------------
// Fields tools (Phase 3c): read/write the document's reusable named values,
// which live in `doc["fields"] = { fields: {name→{name,value}}, order: [...] }`.
// Mirror the citations tools' resident-live / cold-JSON split.
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct ListFieldsArgs {
    #[serde(rename = "docId")]
    doc_id: DocId,
}

/// Read a document's field library in display order. Read-only. Reads the live
/// Y.Doc library when the doc is resident (so an agent sees fields a peer/agent
/// just set before the next flatten), else the JSON snapshot.
fn list_fields(ctx: &ToolContext, args: &Value) -> Result<ToolOutcome, String> {
    let parsed: ListFieldsArgs =
        serde_json::from_value(args.clone()).map_err(|e| format!("Invalid arguments: {}", e))?;

    let result = if let Some(handle) = resident_handle(ctx, &parsed.doc_id) {
        let items = handle.fields_json();
        let order = handle.field_order();
        let mut payload = super::fields::list_payload(&items, &order);
        if let Some(obj) = payload.as_object_mut() {
            obj.insert("source".into(), json!(SOURCE_TEAM));
        }
        payload
    } else {
        let (doc, source) = fetch_doc(ctx, &parsed.doc_id)?;
        let mut payload = super::fields::list_fields_json(&doc);
        if let Some(obj) = payload.as_object_mut() {
            obj.insert("source".into(), json!(source));
        }
        payload
    };
    Ok(ToolOutcome { result, changed_doc_id: None, change_detail: None })
}

#[derive(Deserialize)]
struct SetFieldsArgs {
    #[serde(rename = "docId")]
    doc_id: DocId,
    fields: Vec<FieldInput>,
}

#[derive(Deserialize)]
struct FieldInput {
    name: String,
    #[serde(default)]
    value: String,
}

/// Set/update document fields by name. When the doc is **resident**, writes the
/// live Y.Doc `fields` map per item + broadcasts the CRDT delta (so MCP and editor
/// field edits converge — Phase 3b); else writes the JSON snapshot under optimistic
/// concurrency. Mirrors `add_reference`.
fn set_fields(ctx: &ToolContext, args: &Value) -> Result<ToolOutcome, String> {
    let parsed: SetFieldsArgs =
        serde_json::from_value(args.clone()).map_err(|e| format!("Invalid arguments: {}", e))?;

    reject_if_local(ctx, &parsed.doc_id)?;

    // Normalize + validate: every field needs a non-empty (trimmed) name.
    let mut sets: Vec<super::fields::FieldSet> = Vec::with_capacity(parsed.fields.len());
    for f in &parsed.fields {
        let name = f.name.trim().to_string();
        if name.is_empty() {
            return Err("set_fields: every field requires a non-empty 'name'".into());
        }
        sets.push(super::fields::FieldSet { name, value: f.value.clone() });
    }
    if sets.is_empty() {
        return Err("set_fields requires a non-empty 'fields' array".into());
    }

    // Resident → live Y.Doc per-item write (INVARIANT A) + broadcast; the client's
    // fields observer merges it, so no reload nudge (changed_doc_id None).
    if let Some(handle) = resident_handle(ctx, &parsed.doc_id) {
        let items: Vec<(String, Value)> = sets
            .iter()
            .map(|s| (s.name.clone(), json!({"name": s.name, "value": s.value})))
            .collect();
        let added_before: std::collections::HashSet<String> =
            handle.fields_json().keys().cloned().collect();
        let framed = handle.insert_fields(&items);
        ctx.broadcast_update(&parsed.doc_id, framed);
        let set: Vec<String> = sets.iter().map(|s| s.name.clone()).collect();
        let added: Vec<String> =
            set.iter().filter(|n| !added_before.contains(*n)).cloned().collect();
        // JP-312 talk-back: names that overwrote an existing field (vs created a
        // new one), so a fat-fingered name reads as a clobber not a create.
        let updated: Vec<String> =
            set.iter().filter(|n| added_before.contains(*n)).cloned().collect();
        return Ok(ToolOutcome {
            result: json!({"set": set, "setCount": set.len(), "added": added, "updated": updated}),
            changed_doc_id: None,
            change_detail: None,
        });
    }

    // Cold path: JSON snapshot under optimistic concurrency.
    let outcome = mutate_with_retry(ctx, &parsed.doc_id, |doc| {
        let out = super::fields::set_fields_in_place(doc, &sets)?;
        stamp_doc_modified(doc, now_ms());
        Ok(out)
    })?;

    let updated: Vec<String> = outcome
        .set
        .iter()
        .filter(|n| !outcome.added.contains(n))
        .cloned()
        .collect();
    Ok(ToolOutcome {
        result: json!({
            "set": outcome.set,
            "setCount": outcome.set.len(),
            "added": outcome.added,
            "updated": updated,
        }),
        changed_doc_id: Some(parsed.doc_id.clone()),
        change_detail: None,
    })
}

/// Attach a non-empty `fixes` array to a tool result so the agent learns what
/// was healed / dropped / clamped (JP-312 talk-back). No-op when nothing was
/// adjusted, so a clean write stays a bare success (no empty `fixes` noise).
fn attach_fixes(result: &mut Value, fixes: &[ShapeFix]) {
    if fixes.is_empty() {
        return;
    }
    if let Some(obj) = result.as_object_mut() {
        obj.insert("fixes".into(), serde_json::to_value(fixes).unwrap_or(Value::Null));
    }
}

fn add_shape(ctx: &ToolContext, args: &Value) -> Result<ToolOutcome, String> {
    let parsed: AddShapeArgs =
        serde_json::from_value(args.clone()).map_err(|e| format!("Invalid arguments: {}", e))?;

    reject_if_local(ctx, &parsed.doc_id)?;

    // Fixes derive from the input DSL, not the persistence path, so compute once
    // and attach to whichever path (live Y.Doc / JSON) ran.
    let fixes = dsl_fixes(&parsed.shape);
    let mut outcome = write_shape_live_or_json(
        ctx,
        &parsed.doc_id,
        &parsed.page_id,
        |handle, page_id| {
            let id = shape_id_or_gen(&parsed.shape);
            let shape = build_shape_json(&parsed.shape, &id);
            let framed = handle.insert_shapes(page_id, &[(id.clone(), shape)])?;
            Ok((framed, json!({"id": id, "warning": Value::Null})))
        },
        |doc| {
            let warning = lock_warning(doc);
            let id = append_shape_in_place(doc, &parsed.page_id, &parsed.shape)?;
            stamp_modified(doc, &parsed.page_id);
            Ok(json!({"id": id, "warning": warning}))
        },
    )?;
    attach_fixes(&mut outcome.result, &fixes);
    Ok(outcome)
}

fn stamp_modified(doc: &mut Value, page_id: &str) {
    let now = now_ms();
    if let Some(pages) = doc.get_mut("pages").and_then(|v| v.as_object_mut()) {
        if let Some(page) = pages.get_mut(page_id).and_then(|v| v.as_object_mut()) {
            page.insert("modifiedAt".into(), json!(now));
        }
    }
    if let Some(o) = doc.as_object_mut() {
        o.insert("modifiedAt".into(), json!(now));
    }
}

#[derive(Deserialize)]
struct AddShapesArgs {
    #[serde(rename = "docId")]
    doc_id: DocId,
    #[serde(rename = "pageId")]
    page_id: String,
    shapes: Vec<DslShape>,
}

fn add_shapes(ctx: &ToolContext, args: &Value) -> Result<ToolOutcome, String> {
    let parsed: AddShapesArgs =
        serde_json::from_value(args.clone()).map_err(|e| format!("Invalid arguments: {}", e))?;
    if parsed.shapes.is_empty() {
        return Err("'shapes' must contain at least one entry".into());
    }

    reject_if_local(ctx, &parsed.doc_id)?;

    // Per-shape fixes, each tagged with its `shape` index so the agent can map a
    // fix back to the offending entry (ids in the result are in shape order).
    let mut tagged_fixes: Vec<Value> = Vec::new();
    for (idx, s) in parsed.shapes.iter().enumerate() {
        for fix in dsl_fixes(s) {
            let mut v = serde_json::to_value(&fix).unwrap_or(Value::Null);
            if let Some(o) = v.as_object_mut() {
                o.insert("shape".into(), json!(idx));
            }
            tagged_fixes.push(v);
        }
    }
    let mut outcome = write_shape_live_or_json(
        ctx,
        &parsed.doc_id,
        &parsed.page_id,
        |handle, page_id| {
            // One transaction, single broadcast (atomic, unlike the JSON loop).
            let items: Vec<(String, Value)> = parsed
                .shapes
                .iter()
                .map(|s| {
                    let id = shape_id_or_gen(s);
                    let shape = build_shape_json(s, &id);
                    (id, shape)
                })
                .collect();
            let ids: Vec<String> = items.iter().map(|(id, _)| id.clone()).collect();
            let framed = handle.insert_shapes(page_id, &items)?;
            Ok((framed, json!({"ids": ids, "warning": Value::Null})))
        },
        |doc| {
            let warning = lock_warning(doc);
            let mut ids = Vec::with_capacity(parsed.shapes.len());
            for (idx, shape) in parsed.shapes.iter().enumerate() {
                match append_shape_in_place(doc, &parsed.page_id, shape) {
                    Ok(id) => ids.push(id),
                    Err(e) => return Err(format!("shape[{}]: {}", idx, e)),
                }
            }
            stamp_modified(doc, &parsed.page_id);
            Ok(json!({"ids": ids, "warning": warning}))
        },
    )?;
    if !tagged_fixes.is_empty() {
        if let Some(o) = outcome.result.as_object_mut() {
            o.insert("fixes".into(), Value::Array(tagged_fixes));
        }
    }
    Ok(outcome)
}

#[derive(Deserialize)]
struct ConnectArgs {
    #[serde(rename = "docId")]
    doc_id: DocId,
    #[serde(rename = "pageId")]
    page_id: String,
    #[serde(rename = "fromId")]
    from_id: String,
    #[serde(rename = "toId")]
    to_id: String,
    #[serde(rename = "fromAnchor")]
    from_anchor: Option<String>,
    #[serde(rename = "toAnchor")]
    to_anchor: Option<String>,
    label: Option<String>,
}

fn connect(ctx: &ToolContext, args: &Value) -> Result<ToolOutcome, String> {
    let parsed: ConnectArgs =
        serde_json::from_value(args.clone()).map_err(|e| format!("Invalid arguments: {}", e))?;

    reject_if_local(ctx, &parsed.doc_id)?;

    let dsl = DslShape {
        kind: super::adapter::DslKind::Connector,
        x: 0.0,
        y: 0.0,
        w: None,
        h: None,
        text: parsed.label.clone(),
        style: None,
        id: None,
        icon_id: None,
        icon_display_mode: None,
        icon_size: None,
        start_shape_id: Some(parsed.from_id.clone()),
        end_shape_id: Some(parsed.to_id.clone()),
        start_anchor: parsed.from_anchor.clone(),
        end_anchor: parsed.to_anchor.clone(),
        start_arrow_style: None,
        end_arrow_style: None,
        routing_mode: None,
        waypoints: None,
        label_position: None,
        x2: None,
        y2: None,
        unknown: serde_json::Map::new(),
    };

    write_shape_live_or_json(
        ctx,
        &parsed.doc_id,
        &parsed.page_id,
        |handle, page_id| {
            // Validate both endpoints exist on the live page before inserting.
            if !handle.has_shape(page_id, &parsed.from_id) {
                return Err(format!(
                    "fromId '{}' does not exist on page '{}'",
                    parsed.from_id, parsed.page_id
                ));
            }
            if !handle.has_shape(page_id, &parsed.to_id) {
                return Err(format!(
                    "toId '{}' does not exist on page '{}'",
                    parsed.to_id, parsed.page_id
                ));
            }
            let id = shape_id_or_gen(&dsl);
            let shape = build_shape_json(&dsl, &id);
            let framed = handle.insert_shapes(page_id, &[(id.clone(), shape)])?;
            Ok((framed, json!({"id": id, "warning": Value::Null})))
        },
        |doc| {
            // Validate the endpoints actually exist on the page before we mutate.
            let page = doc
                .get("pages")
                .and_then(|p| p.get(&parsed.page_id))
                .ok_or_else(|| format!("Page '{}' not found", parsed.page_id))?;
            let shapes = page.get("shapes").ok_or("Page has no shapes")?;
            if shapes.get(&parsed.from_id).is_none() {
                return Err(format!(
                    "fromId '{}' does not exist on page '{}'",
                    parsed.from_id, parsed.page_id
                ));
            }
            if shapes.get(&parsed.to_id).is_none() {
                return Err(format!(
                    "toId '{}' does not exist on page '{}'",
                    parsed.to_id, parsed.page_id
                ));
            }

            let warning = lock_warning(doc);
            let id = append_shape_in_place(doc, &parsed.page_id, &dsl)?;
            stamp_modified(doc, &parsed.page_id);
            Ok(json!({"id": id, "warning": warning}))
        },
    )
}

#[derive(Deserialize)]
struct UpdateShapeArgs {
    #[serde(rename = "docId")]
    doc_id: DocId,
    #[serde(rename = "pageId")]
    page_id: String,
    id: String,
    patch: DslPatch,
}

fn update_shape(ctx: &ToolContext, args: &Value) -> Result<ToolOutcome, String> {
    let parsed: UpdateShapeArgs =
        serde_json::from_value(args.clone()).map_err(|e| format!("Invalid arguments: {}", e))?;

    reject_if_local(ctx, &parsed.doc_id)?;

    // Unknown/invalid patch keys the agent supplied (dropped by apply_dsl_patch).
    // Reported on a successful patch; a patch of ONLY unknown keys still errors
    // "did not specify any updatable fields" below — already non-silent.
    let fixes = dsl_patch_fixes(&parsed.patch);
    let mut outcome = write_shape_live_or_json(
        ctx,
        &parsed.doc_id,
        &parsed.page_id,
        |handle, page_id| {
            // Read the live shape, merge the patch, overwrite + broadcast.
            // Read-then-write across two short txns; field-level last-write-wins,
            // inherent to a concurrent edit on the same shape.
            let mut shape = handle.get_shape_json(page_id, &parsed.id).ok_or_else(|| {
                format!("Shape '{}' not found on page '{}'", parsed.id, parsed.page_id)
            })?;
            let changed = apply_dsl_patch(&mut shape, &parsed.patch);
            if changed.is_empty() {
                return Err("Patch did not specify any updatable fields".into());
            }
            stamp_provenance(&mut shape);
            let framed = handle.overwrite_shape(page_id, &parsed.id, shape)?;
            Ok((framed, json!({"id": parsed.id, "changed": changed, "warning": Value::Null})))
        },
        |doc| {
            let warning = lock_warning(doc);
            let pages = doc
                .get_mut("pages")
                .and_then(|v| v.as_object_mut())
                .ok_or("Document missing 'pages'")?;
            let page = pages
                .get_mut(&parsed.page_id)
                .and_then(|v| v.as_object_mut())
                .ok_or_else(|| format!("Page '{}' not found", parsed.page_id))?;
            let shapes = page
                .get_mut("shapes")
                .and_then(|v| v.as_object_mut())
                .ok_or("Page 'shapes' is not an object")?;
            let shape = shapes.get_mut(&parsed.id).ok_or_else(|| {
                format!("Shape '{}' not found on page '{}'", parsed.id, parsed.page_id)
            })?;

            let changed = apply_dsl_patch(shape, &parsed.patch);
            if changed.is_empty() {
                return Err("Patch did not specify any updatable fields".into());
            }
            stamp_provenance(shape);

            stamp_modified(doc, &parsed.page_id);
            Ok(json!({"id": parsed.id, "changed": changed, "warning": warning}))
        },
    )?;
    attach_fixes(&mut outcome.result, &fixes);
    Ok(outcome)
}

/// All ids to remove when deleting `target`: the shape itself plus every
/// connector whose `startShapeId`/`endShapeId` references it — so a delete never
/// leaves a dangling connector pointing at a gone shape.
fn cascade_delete_ids(shapes: &serde_json::Map<String, Value>, target: &str) -> Vec<String> {
    let mut ids = vec![target.to_string()];
    for (id, shape) in shapes {
        if id == target {
            continue;
        }
        if shape.get("type").and_then(Value::as_str) == Some("connector") {
            let start = shape.get("startShapeId").and_then(Value::as_str);
            let end = shape.get("endShapeId").and_then(Value::as_str);
            if start == Some(target) || end == Some(target) {
                ids.push(id.clone());
            }
        }
    }
    ids
}

#[derive(Deserialize)]
struct DeleteShapeArgs {
    #[serde(rename = "docId")]
    doc_id: DocId,
    #[serde(rename = "pageId")]
    page_id: String,
    id: String,
}

fn delete_shape(ctx: &ToolContext, args: &Value) -> Result<ToolOutcome, String> {
    let parsed: DeleteShapeArgs =
        serde_json::from_value(args.clone()).map_err(|e| format!("Invalid arguments: {}", e))?;
    reject_if_local(ctx, &parsed.doc_id)?;

    write_shape_live_or_json(
        ctx,
        &parsed.doc_id,
        &parsed.page_id,
        |handle, page_id| {
            // Cascade against the live shapes, delete + broadcast.
            if !handle.has_shape(page_id, &parsed.id) {
                return Err(format!(
                    "Shape '{}' not found on page '{}'",
                    parsed.id, parsed.page_id
                ));
            }
            let ids = cascade_delete_ids(&handle.shapes_json(page_id), &parsed.id);
            let framed = handle.delete_shapes(page_id, &ids)?;
            Ok((framed, json!({"deleted": ids})))
        },
        |doc| {
            let page = doc
                .get_mut("pages")
                .and_then(|v| v.as_object_mut())
                .and_then(|pages| pages.get_mut(&parsed.page_id))
                .and_then(|p| p.as_object_mut())
                .ok_or_else(|| format!("Page '{}' not found", parsed.page_id))?;
            let shapes = page
                .get("shapes")
                .and_then(|v| v.as_object())
                .ok_or("Page 'shapes' is not an object")?;
            if !shapes.contains_key(&parsed.id) {
                return Err(format!(
                    "Shape '{}' not found on page '{}'",
                    parsed.id, parsed.page_id
                ));
            }
            let ids = cascade_delete_ids(shapes, &parsed.id);
            if let Some(shapes_mut) = page.get_mut("shapes").and_then(|v| v.as_object_mut()) {
                for did in &ids {
                    shapes_mut.remove(did);
                }
            }
            if let Some(order) = page.get_mut("shapeOrder").and_then(|v| v.as_array_mut()) {
                order.retain(|v| v.as_str().is_none_or(|s| !ids.iter().any(|d| d == s)));
            }
            stamp_modified(doc, &parsed.page_id);
            Ok(json!({"deleted": ids}))
        },
    )
}

#[derive(Deserialize)]
struct DeleteProsePageArgs {
    #[serde(rename = "docId")]
    doc_id: DocId,
    #[serde(rename = "pageId")]
    page_id: String,
}

fn delete_prose_page(ctx: &ToolContext, args: &Value) -> Result<ToolOutcome, String> {
    let parsed: DeleteProsePageArgs =
        serde_json::from_value(args.clone()).map_err(|e| format!("Invalid arguments: {}", e))?;
    reject_if_local(ctx, &parsed.doc_id)?;

    // The prose page list is the source of truth (JSON; not CRDT-synced), so the
    // removal is always a JSON write under optimistic concurrency.
    mutate_with_retry(ctx, &parsed.doc_id, |doc| {
        let rtp = rich_text_pages_mut(doc)?;
        let exists = rtp
            .get("pages")
            .and_then(|v| v.as_object())
            .is_some_and(|p| p.contains_key(&parsed.page_id));
        if !exists {
            return Err(format!("Prose page '{}' not found", parsed.page_id));
        }
        let order_len = rtp
            .get("pageOrder")
            .and_then(|v| v.as_array())
            .map_or(0, Vec::len);
        if order_len <= 1 {
            return Err(
                "Cannot delete the last prose page; a document keeps at least one".into(),
            );
        }
        if let Some(pages) = rtp.get_mut("pages").and_then(|v| v.as_object_mut()) {
            pages.remove(&parsed.page_id);
        }
        if let Some(order) = rtp.get_mut("pageOrder").and_then(|v| v.as_array_mut()) {
            order.retain(|v| v.as_str() != Some(parsed.page_id.as_str()));
        }
        // Repoint activePageId if it was the deleted page.
        if rtp.get("activePageId").and_then(|v| v.as_str()) == Some(parsed.page_id.as_str()) {
            let next = rtp
                .get("pageOrder")
                .and_then(|v| v.as_array())
                .and_then(|a| a.first())
                .and_then(|v| v.as_str())
                .map(String::from);
            if let Some(next) = next {
                rtp.insert("activePageId".into(), json!(next));
            }
        }
        stamp_doc_modified(doc, now_ms());
        Ok(())
    })?;

    // If resident, blank the live fragment AND remove the tab from the live
    // `prosePages` list (JP-339), so a connected client's view of the page clears
    // and the tab disappears immediately — no reload.
    if let Some(handle) = resident_handle(ctx, &parsed.doc_id) {
        let framed = handle.clear_prose(&parsed.page_id);
        ctx.broadcast_update(&parsed.doc_id, framed);
        let framed = handle.remove_prose_page(&parsed.page_id);
        ctx.broadcast_update(&parsed.doc_id, framed);
    }

    Ok(ToolOutcome {
        result: json!({"deleted": parsed.page_id}),
        changed_doc_id: Some(parsed.doc_id),
        change_detail: None,
    })
}

/// Validate that `requested` is a permutation of `current` — same ids, none
/// missing, added, or duplicated. Shared by `reorder_shapes`/`reorder_prose_pages`.
fn validate_order(current: &[String], requested: &[String], what: &str) -> Result<(), String> {
    let mut a = current.to_vec();
    a.sort();
    let mut b = requested.to_vec();
    b.sort();
    if a == b {
        Ok(())
    } else {
        Err(format!(
            "order must be a permutation of the current {what} ids ({} ids); got {} — check for \
             missing, extra, or duplicate ids",
            current.len(),
            requested.len()
        ))
    }
}

#[derive(Deserialize)]
struct ReorderShapesArgs {
    #[serde(rename = "docId")]
    doc_id: DocId,
    #[serde(rename = "pageId")]
    page_id: String,
    order: Vec<String>,
}

fn reorder_shapes(ctx: &ToolContext, args: &Value) -> Result<ToolOutcome, String> {
    let parsed: ReorderShapesArgs =
        serde_json::from_value(args.clone()).map_err(|e| format!("Invalid arguments: {}", e))?;
    reject_if_local(ctx, &parsed.doc_id)?;

    // Live path: validate against the live z-order for this page, then apply +
    // broadcast (any page is live, JP-340).
    if let Some(handle) = resident_handle(ctx, &parsed.doc_id) {
        validate_order(&handle.shape_order(&parsed.page_id), &parsed.order, "shape")?;
        let framed = handle.set_shape_order(&parsed.page_id, &parsed.order);
        ctx.broadcast_update(&parsed.doc_id, framed);
        return Ok(ToolOutcome {
            result: json!({"pageId": parsed.page_id, "ok": true}),
            changed_doc_id: None,
            change_detail: None,
        });
    }

    // Cold path.
    mutate_with_retry(ctx, &parsed.doc_id, |doc| {
        let page = doc
            .get_mut("pages")
            .and_then(|v| v.as_object_mut())
            .and_then(|pages| pages.get_mut(&parsed.page_id))
            .and_then(|p| p.as_object_mut())
            .ok_or_else(|| format!("Page '{}' not found", parsed.page_id))?;
        let current: Vec<String> = page
            .get("shapeOrder")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .unwrap_or_default();
        validate_order(&current, &parsed.order, "shape")?;
        page.insert("shapeOrder".into(), json!(parsed.order));
        stamp_modified(doc, &parsed.page_id);
        Ok(())
    })?;

    Ok(ToolOutcome {
        result: json!({"pageId": parsed.page_id, "ok": true}),
        changed_doc_id: Some(parsed.doc_id),
        change_detail: None,
    })
}

#[derive(Deserialize)]
struct ReorderProsePagesArgs {
    #[serde(rename = "docId")]
    doc_id: DocId,
    order: Vec<String>,
}

fn reorder_prose_pages(ctx: &ToolContext, args: &Value) -> Result<ToolOutcome, String> {
    let parsed: ReorderProsePagesArgs =
        serde_json::from_value(args.clone()).map_err(|e| format!("Invalid arguments: {}", e))?;
    reject_if_local(ctx, &parsed.doc_id)?;

    // The prose page list is JSON-only (not CRDT-synced, JP-171), so this is
    // always a JSON write; a connected editor's tab order updates on reload.
    mutate_with_retry(ctx, &parsed.doc_id, |doc| {
        let rtp = rich_text_pages_mut(doc)?;
        let current: Vec<String> = rtp
            .get("pageOrder")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .unwrap_or_default();
        validate_order(&current, &parsed.order, "prose page")?;
        rtp.insert("pageOrder".into(), json!(parsed.order));
        // Keep each page's numeric `order` field consistent with the new index.
        if let Some(pages) = rtp.get_mut("pages").and_then(|v| v.as_object_mut()) {
            for (i, id) in parsed.order.iter().enumerate() {
                if let Some(page) = pages.get_mut(id).and_then(|v| v.as_object_mut()) {
                    page.insert("order".into(), json!(i));
                }
            }
        }
        stamp_doc_modified(doc, now_ms());
        Ok(())
    })?;

    // JP-339: push the new tab order to connected clients live (no reload).
    if let Some(handle) = resident_handle(ctx, &parsed.doc_id) {
        let framed = handle.set_prose_page_order(&parsed.order);
        ctx.broadcast_update(&parsed.doc_id, framed);
    }

    Ok(ToolOutcome {
        result: json!({"order": parsed.order, "ok": true}),
        changed_doc_id: Some(parsed.doc_id),
        change_detail: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use tempfile::TempDir;

    /// JP-355: Claude.ai's hosted connector validates every advertised tool name
    /// against `^[a-zA-Z0-9_-]{1,64}$`. The relay originally namespaced tools
    /// with a dot (`docushark.add_shape`), which that regex rejects — breaking
    /// the whole connector. This test is the contract: no tool name may contain
    /// a character outside the allowed set, exceed 64 bytes, or drop the
    /// `docushark_` prefix.
    #[test]
    fn tool_names_match_connector_pattern() {
        for d in descriptors() {
            let ok = !d.name.is_empty()
                && d.name.len() <= 64
                && d.name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
            assert!(ok, "tool name violates connector pattern: {}", d.name);
            // Lock the convention so no future tool reintroduces a dotted separator.
            assert!(
                d.name.starts_with("docushark_"),
                "tool must use the docushark_ prefix: {}",
                d.name
            );
        }
    }

    #[test]
    fn next_default_page_name_matches_ts_twin() {
        let n = |base, names: &[&str]| next_default_page_name(base, names.iter().copied());

        // First page → bare base.
        assert_eq!(n(CANVAS_PAGE_BASE, &[]), "Canvas");
        assert_eq!(n(PROSE_PAGE_BASE, &[]), "Prose");
        // Bare base present → p.2.
        assert_eq!(n("Canvas", &["Canvas"]), "Canvas p.2");
        // Continue a sequence.
        assert_eq!(n("Prose", &["Prose", "Prose p.2", "Prose p.3"]), "Prose p.4");
        // Monotonic max+1 — a deleted number is never reused.
        assert_eq!(n("Prose", &["Prose", "Prose p.3"]), "Prose p.4");
        // Non-matching names ignored.
        assert_eq!(n("Prose", &["Intro", "Appendix"]), "Prose");
        assert_eq!(n("Prose", &["Intro", "Prose p.2"]), "Prose p.3");
        // Canvas and prose counters are independent.
        let mixed = &["Canvas", "Prose", "Prose p.2"];
        assert_eq!(n("Canvas", mixed), "Canvas p.2");
        assert_eq!(n("Prose", mixed), "Prose p.3");
        // Non-integer / zero suffixes don't match.
        assert_eq!(n("Prose", &["Prose p.x", "Prose p.0", "Prose p.2.5"]), "Prose");
    }

    struct Fixture {
        team: Arc<DocumentStore>,
        local: Arc<LocalDocumentMirror>,
        registry: Arc<DocRegistry>,
        broadcasts: Arc<std::sync::Mutex<Vec<(WorkspaceId, DocId, Vec<u8>)>>>,
        on_doc_update: Arc<OnDocUpdate>,
        deletions: Arc<std::sync::Mutex<Vec<(WorkspaceId, DocId)>>>,
        on_doc_deleted: Arc<DocDeletedSink>,
    }

    impl Fixture {
        fn ctx(&self, local_enabled: bool) -> ToolContext<'_> {
            ToolContext {
                team: &self.team,
                local: &self.local,
                local_enabled,
                workspace_id: WorkspaceId::single_tenant(),
                // JP-370: tool tests run as the static/local context (no user
                // identity, enforcement off) → the gate is a no-op, matching
                // the loopback-token semantics.
                user_id: None,
                user_role: None,
                enforce_private_docs: false,
                registry: &self.registry,
                on_doc_update: &*self.on_doc_update,
                on_doc_deleted: &self.on_doc_deleted,
            }
        }

        /// JP-370: a ToolContext as a specific JWT-authed user with the
        /// per-document gate enabled (vs `ctx`'s static-token, gate-off shape).
        fn ctx_as(&self, user_id: &str, role: &str, enforce: bool) -> ToolContext<'_> {
            ToolContext {
                team: &self.team,
                local: &self.local,
                local_enabled: false,
                workspace_id: WorkspaceId::single_tenant(),
                user_id: Some(user_id.to_string()),
                user_role: Some(role.to_string()),
                enforce_private_docs: enforce,
                registry: &self.registry,
                on_doc_update: &*self.on_doc_update,
                on_doc_deleted: &self.on_doc_deleted,
            }
        }

        /// Hydrate a team doc into the registry so it counts as "live"
        /// (resident on its active page) — exercises the JP-35 Y.Doc path.
        fn make_resident(&self, doc_id: &str) -> Arc<DocHandle> {
            let ws = WorkspaceId::single_tenant();
            let doc_id = DocId::from_http_path(doc_id.to_string()).unwrap();
            let json = self.team.get_document(&ws, &doc_id).unwrap();
            self.registry.ensure(&ws, &doc_id, &json, None, false)
        }

        /// (ws, doc, framed) updates pushed on the live broadcast path.
        fn broadcasts(&self) -> Vec<(WorkspaceId, DocId, Vec<u8>)> {
            self.broadcasts.lock().unwrap().clone()
        }

        /// (ws, doc) ids the `delete_document` post-delete sink fired for.
        fn deletions(&self) -> Vec<(WorkspaceId, DocId)> {
            self.deletions.lock().unwrap().clone()
        }
    }

    fn make_doc(doc_id: &str, page_id: &str, name: &str) -> Value {
        json!({
            "id": doc_id,
            "name": name,
            "version": 1,
            "createdAt": 1u64,
            "modifiedAt": 1u64,
            "activePageId": page_id,
            "pageOrder": [page_id],
            "pages": {
                page_id: {
                    "id": page_id,
                    "name": "Page 1",
                    "shapes": {},
                    "shapeOrder": [],
                    "createdAt": 1u64,
                    "modifiedAt": 1u64,
                }
            }
        })
    }

    fn seed(dir: &PathBuf) -> Fixture {
        let team = Arc::new(DocumentStore::new(dir.clone()));
        let local = Arc::new(LocalDocumentMirror::new(dir.clone()));
        team.save_document(&WorkspaceId::single_tenant(), make_doc("doc1", "p1", "Team Doc")).unwrap();
        let registry = Arc::new(DocRegistry::new());
        let broadcasts = Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = broadcasts.clone();
        let on_doc_update: Arc<OnDocUpdate> =
            Arc::new(move |ws: &WorkspaceId, doc: &DocId, framed: Vec<u8>| {
                sink.lock().unwrap().push((ws.clone(), doc.clone(), framed));
            });
        let deletions = Arc::new(std::sync::Mutex::new(Vec::new()));
        let del_sink = deletions.clone();
        let on_doc_deleted: Arc<DocDeletedSink> =
            Arc::new(move |ws: &WorkspaceId, doc: &DocId| {
                del_sink.lock().unwrap().push((ws.clone(), doc.clone()));
            });
        Fixture { team, local, registry, broadcasts, on_doc_update, deletions, on_doc_deleted }
    }

    // ---- JP-35: live Y.Doc write path ----

    #[test]
    fn add_shape_live_mutates_ydoc_broadcasts_and_skips_json() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());
        let handle = f.make_resident("doc1");

        let out = dispatch(
            &f.ctx(true),
            "docushark_add_shape",
            &json!({"docId": "doc1", "pageId": "p1",
                    "shape": {"kind": "rectangle", "x": 5.0, "y": 6.0}}),
        )
        .unwrap();
        let id = out.result["id"].as_str().unwrap().to_string();

        // Applied to the live Y.Doc, provenance-stamped.
        assert!(handle.has_shape("p1", &id), "shape applied to the live Y.Doc");
        let shape = handle.get_shape_json("p1", &id).unwrap();
        assert_eq!(shape["provenance"]["source"], "mcp");
        assert!(shape["provenance"]["at"].as_u64().unwrap() > 0);

        // One CRDT delta broadcast to (single_tenant, doc1), MESSAGE_SYNC-framed.
        let bc = f.broadcasts();
        assert_eq!(bc.len(), 1, "exactly one broadcast");
        assert_eq!(bc[0].1.as_str(), "doc1");
        assert!(!bc[0].2.is_empty());

        // JSON snapshot is NOT rewritten on the live path (sweeper persists it),
        // and changed_doc_id is None so transport won't also fire DocEvent.
        let ws = WorkspaceId::single_tenant();
        let doc_id = DocId::from_http_path("doc1".to_string()).unwrap();
        let json = f.team.get_document(&ws, &doc_id).unwrap();
        assert_eq!(
            json["pages"]["p1"]["shapes"].as_object().unwrap().len(),
            0,
            "live write must not touch the JSON store"
        );
        assert!(out.changed_doc_id.is_none());
    }

    #[test]
    fn update_shape_live_patches_ydoc_and_broadcasts() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());
        let handle = f.make_resident("doc1");

        dispatch(
            &f.ctx(true),
            "docushark_add_shape",
            &json!({"docId": "doc1", "pageId": "p1",
                    "shape": {"kind": "rectangle", "x": 1.0, "y": 2.0, "id": "s1"}}),
        )
        .unwrap();

        let out = dispatch(
            &f.ctx(true),
            "docushark_update_shape",
            &json!({"docId": "doc1", "pageId": "p1", "id": "s1", "patch": {"x": 99.0}}),
        )
        .unwrap();
        assert!(out.result["changed"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c == "x"));

        let shape = handle.get_shape_json("p1", "s1").unwrap();
        assert_eq!(shape["x"].as_f64(), Some(99.0));
        assert_eq!(shape["provenance"]["source"], "mcp");
        assert_eq!(f.broadcasts().len(), 2, "add + update each broadcast once");
        assert!(out.changed_doc_id.is_none());
    }

    // ---- JP-246: lifecycle/utility tools ----

    #[test]
    fn cascade_delete_ids_includes_referencing_connectors() {
        let shapes: serde_json::Map<String, Value> = serde_json::from_value(json!({
            "s1": {"id": "s1", "type": "rectangle"},
            "s2": {"id": "s2", "type": "rectangle"},
            "c1": {"id": "c1", "type": "connector", "startShapeId": "s1", "endShapeId": "s2"},
            "c2": {"id": "c2", "type": "connector", "startShapeId": "s2", "endShapeId": "s3"}
        }))
        .unwrap();

        let mut ids = cascade_delete_ids(&shapes, "s1");
        ids.sort();
        assert_eq!(ids, vec!["c1".to_string(), "s1".to_string()]);

        // s2 is referenced by both connectors.
        let mut ids2 = cascade_delete_ids(&shapes, "s2");
        ids2.sort();
        assert_eq!(ids2, vec!["c1".to_string(), "c2".to_string(), "s2".to_string()]);

        // A shape no connector touches deletes alone.
        assert_eq!(cascade_delete_ids(&shapes, "s9"), vec!["s9".to_string()]);
    }

    #[test]
    fn delete_shape_live_cascades_connectors_and_broadcasts() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());
        let handle = f.make_resident("doc1");

        dispatch(
            &f.ctx(true),
            "docushark_add_shapes",
            &json!({"docId": "doc1", "pageId": "p1", "shapes": [
                {"kind": "rectangle", "id": "s1", "x": 0.0, "y": 0.0},
                {"kind": "rectangle", "id": "s2", "x": 100.0, "y": 0.0}
            ]}),
        )
        .unwrap();
        dispatch(
            &f.ctx(true),
            "docushark_connect",
            &json!({"docId": "doc1", "pageId": "p1", "fromId": "s1", "toId": "s2"}),
        )
        .unwrap();

        let out = dispatch(
            &f.ctx(true),
            "docushark_delete_shape",
            &json!({"docId": "doc1", "pageId": "p1", "id": "s1"}),
        )
        .unwrap();

        let deleted: Vec<&str> = out.result["deleted"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|v| v.as_str())
            .collect();
        assert!(deleted.contains(&"s1"), "target deleted");
        assert_eq!(deleted.len(), 2, "target + its dangling connector");
        assert!(!handle.has_shape("p1", "s1"), "shape gone from live Y.Doc");
        assert!(handle.has_shape("p1", "s2"), "untouched shape kept");
        let connectors = handle
            .shapes_json("p1")
            .values()
            .filter(|s| s["type"] == "connector")
            .count();
        assert_eq!(connectors, 0, "no dangling connector left");
        assert!(out.changed_doc_id.is_none(), "live path skips DocEvent");
        assert_eq!(f.broadcasts().len(), 3, "add_shapes + connect + delete");
    }

    #[test]
    fn get_shape_returns_one_shape_or_not_found() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());
        let _handle = f.make_resident("doc1");
        dispatch(
            &f.ctx(true),
            "docushark_add_shape",
            &json!({"docId": "doc1", "pageId": "p1",
                    "shape": {"kind": "rectangle", "id": "s1", "x": 3.0, "y": 4.0}}),
        )
        .unwrap();

        let out = dispatch(
            &f.ctx(true),
            "docushark_get_shape",
            &json!({"docId": "doc1", "pageId": "p1", "id": "s1"}),
        )
        .unwrap();
        assert_eq!(out.result["shape"]["id"], "s1");
        assert_eq!(out.result["shape"]["kind"], "rectangle");
        assert!(out.changed_doc_id.is_none());

        let err = dispatch(
            &f.ctx(true),
            "docushark_get_shape",
            &json!({"docId": "doc1", "pageId": "p1", "id": "nope"}),
        )
        .unwrap_err();
        assert!(err.contains("not found"), "{err}");
    }

    #[test]
    fn get_page_and_get_document_read_live_shapes_when_resident() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());
        let _handle = f.make_resident("doc1");
        // Live add — goes to the Y.Doc, not the JSON store (JP-35).
        dispatch(
            &f.ctx(true),
            "docushark_add_shape",
            &json!({"docId": "doc1", "pageId": "p1",
                    "shape": {"kind": "rectangle", "id": "s1", "x": 1.0, "y": 2.0}}),
        )
        .unwrap();

        // get_page reflects the live shape (JP-251)...
        let page = dispatch(
            &f.ctx(true),
            "docushark_get_page",
            &json!({"docId": "doc1", "pageId": "p1"}),
        )
        .unwrap();
        let shapes = page.result["shapes"].as_array().unwrap();
        assert_eq!(shapes.len(), 1);
        assert_eq!(shapes[0]["id"], "s1");

        // ...while the JSON store is genuinely empty — proving the live read.
        let ws = WorkspaceId::single_tenant();
        let json = f
            .team
            .get_document(&ws, &DocId::from_http_path("doc1".to_string()).unwrap())
            .unwrap();
        assert_eq!(json["pages"]["p1"]["shapes"].as_object().unwrap().len(), 0);

        // get_document's active-page shapeCount is the live count too.
        let docout = dispatch(&f.ctx(true), "docushark_get_document", &json!({"docId": "doc1"}))
            .unwrap();
        let p1 = docout.result["pages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["id"] == "p1")
            .unwrap();
        assert_eq!(p1["shapeCount"], 1);
    }

    #[test]
    fn delete_prose_page_deletes_then_refuses_the_last() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());
        let ws = WorkspaceId::single_tenant();
        f.team
            .save_document(
                &ws,
                json!({
                    "id": "docp", "name": "P", "version": 1, "createdAt": 1u64, "modifiedAt": 1u64,
                    "activePageId": "c1", "pageOrder": ["c1"],
                    "pages": {"c1": {"id": "c1", "shapes": {}, "shapeOrder": []}},
                    "richTextPages": {"activePageId": "rt1", "pageOrder": ["rt1", "rt2"], "pages": {
                        "rt1": {"id": "rt1", "name": "One", "content": "<p>a</p>", "order": 0},
                        "rt2": {"id": "rt2", "name": "Two", "content": "<p>b</p>", "order": 1}
                    }}
                }),
            )
            .unwrap();

        // Delete the (active) first page → repoints activePageId to the survivor.
        dispatch(
            &f.ctx(true),
            "docushark_delete_prose_page",
            &json!({"docId": "docp", "pageId": "rt1"}),
        )
        .unwrap();
        let doc = f
            .team
            .get_document(&ws, &DocId::from_http_path("docp".to_string()).unwrap())
            .unwrap();
        assert!(doc["richTextPages"]["pages"].get("rt1").is_none(), "rt1 removed");
        assert_eq!(doc["richTextPages"]["pageOrder"], json!(["rt2"]));
        assert_eq!(doc["richTextPages"]["activePageId"], "rt2", "active repointed");

        // The now-last page can't be deleted.
        let err = dispatch(
            &f.ctx(true),
            "docushark_delete_prose_page",
            &json!({"docId": "docp", "pageId": "rt2"}),
        )
        .unwrap_err();
        assert!(err.contains("last prose page"), "{err}");
    }

    // ---- JP-247: reorder ----

    #[test]
    fn validate_order_accepts_permutation_rejects_otherwise() {
        let cur = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        assert!(validate_order(&cur, &["c".into(), "a".into(), "b".into()], "shape").is_ok());
        // missing one
        assert!(validate_order(&cur, &["a".into(), "b".into()], "shape").is_err());
        // extra id
        assert!(validate_order(&cur, &["a".into(), "b".into(), "c".into(), "d".into()], "shape").is_err());
        // duplicate (same length, wrong multiset)
        assert!(validate_order(&cur, &["a".into(), "a".into(), "b".into()], "shape").is_err());
    }

    #[test]
    fn reorder_shapes_live_sets_zorder_and_broadcasts() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());
        let handle = f.make_resident("doc1");
        dispatch(
            &f.ctx(true),
            "docushark_add_shapes",
            &json!({"docId": "doc1", "pageId": "p1", "shapes": [
                {"kind": "rectangle", "id": "s1", "x": 0.0, "y": 0.0},
                {"kind": "rectangle", "id": "s2", "x": 10.0, "y": 0.0},
                {"kind": "rectangle", "id": "s3", "x": 20.0, "y": 0.0}
            ]}),
        )
        .unwrap();
        assert_eq!(handle.shape_order("p1"), vec!["s1", "s2", "s3"]);

        let out = dispatch(
            &f.ctx(true),
            "docushark_reorder_shapes",
            &json!({"docId": "doc1", "pageId": "p1", "order": ["s3", "s1", "s2"]}),
        )
        .unwrap();
        assert_eq!(out.result["ok"], true);
        assert_eq!(handle.shape_order("p1"), vec!["s3", "s1", "s2"]);
        assert!(out.changed_doc_id.is_none(), "live path");
        assert_eq!(f.broadcasts().len(), 2, "add_shapes + reorder");

        // A non-permutation is refused (and applies nothing).
        let err = dispatch(
            &f.ctx(true),
            "docushark_reorder_shapes",
            &json!({"docId": "doc1", "pageId": "p1", "order": ["s3", "s1"]}),
        )
        .unwrap_err();
        assert!(err.contains("permutation"), "{err}");
        assert_eq!(handle.shape_order("p1"), vec!["s3", "s1", "s2"], "unchanged on error");
    }

    #[test]
    fn reorder_prose_pages_reorders_and_renumbers() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());
        let ws = WorkspaceId::single_tenant();
        f.team
            .save_document(
                &ws,
                json!({
                    "id": "docp", "name": "P", "version": 1, "createdAt": 1u64, "modifiedAt": 1u64,
                    "activePageId": "c1", "pageOrder": ["c1"],
                    "pages": {"c1": {"id": "c1", "shapes": {}, "shapeOrder": []}},
                    "richTextPages": {"activePageId": "rt1", "pageOrder": ["rt1", "rt2", "rt3"], "pages": {
                        "rt1": {"id": "rt1", "name": "One", "content": "<p>a</p>", "order": 0},
                        "rt2": {"id": "rt2", "name": "Two", "content": "<p>b</p>", "order": 1},
                        "rt3": {"id": "rt3", "name": "Three", "content": "<p>c</p>", "order": 2}
                    }}
                }),
            )
            .unwrap();

        let out = dispatch(
            &f.ctx(true),
            "docushark_reorder_prose_pages",
            &json!({"docId": "docp", "order": ["rt3", "rt1", "rt2"]}),
        )
        .unwrap();
        assert_eq!(out.result["ok"], true);

        let doc = f
            .team
            .get_document(&ws, &DocId::from_http_path("docp".to_string()).unwrap())
            .unwrap();
        assert_eq!(doc["richTextPages"]["pageOrder"], json!(["rt3", "rt1", "rt2"]));
        // Numeric order fields renumbered to match.
        assert_eq!(doc["richTextPages"]["pages"]["rt3"]["order"], 0);
        assert_eq!(doc["richTextPages"]["pages"]["rt1"]["order"], 1);
        assert_eq!(doc["richTextPages"]["pages"]["rt2"]["order"], 2);

        // Non-permutation refused.
        let err = dispatch(
            &f.ctx(true),
            "docushark_reorder_prose_pages",
            &json!({"docId": "docp", "order": ["rt3", "rt1"]}),
        )
        .unwrap_err();
        assert!(err.contains("permutation"), "{err}");
    }

    // ---- JP-336: canvas-page reorder / delete ----

    fn save_canvas_pages_doc(f: &Fixture, ids: &[&str]) {
        let pages: serde_json::Map<String, Value> = ids
            .iter()
            .map(|id| {
                ((*id).to_string(), json!({"id": id, "name": id, "shapes": {}, "shapeOrder": []}))
            })
            .collect();
        f.team
            .save_document(
                &WorkspaceId::single_tenant(),
                json!({
                    "id": "docc", "name": "C", "version": 1, "createdAt": 1u64, "modifiedAt": 1u64,
                    "activePageId": ids[0], "pageOrder": ids, "pages": pages
                }),
            )
            .unwrap();
    }

    #[test]
    fn add_canvas_page_surfaces_in_live_canvas_page_list_when_resident() {
        // JP-339: on a resident doc, add_canvas_page must write the new tab into
        // the live `canvasPages`/`canvasPageOrder` shared types (so connected
        // clients see it without reload). We prove it by flattening the live
        // handle — flatten reads the page list FROM the Y.Doc.
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());
        let ws = WorkspaceId::single_tenant();
        save_canvas_pages_doc(&f, &["c1"]);
        let doc_id = DocId::from_http_path("docc".into()).unwrap();
        let handle = f.make_resident("docc");

        let out = dispatch(
            &f.ctx(true),
            "docushark_add_canvas_page",
            &json!({"docId": "docc", "name": "Live Tab"}),
        )
        .unwrap();
        let page_id = out.result["id"].as_str().unwrap().to_string();

        let mut json = f.team.get_document(&ws, &doc_id).unwrap();
        assert!(handle.flatten_into(&mut json));
        assert_eq!(json["pages"][&page_id]["name"], "Live Tab", "tab in live page list");
        assert!(
            json["pageOrder"].as_array().unwrap().iter().any(|v| v.as_str() == Some(&page_id)),
            "new tab id present in flattened pageOrder"
        );
    }

    #[test]
    fn reorder_canvas_page_reorders_and_validates() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());
        let ws = WorkspaceId::single_tenant();
        save_canvas_pages_doc(&f, &["c1", "c2", "c3"]);

        let out = dispatch(
            &f.ctx(true),
            "docushark_reorder_canvas_page",
            &json!({"docId": "docc", "order": ["c3", "c1", "c2"]}),
        )
        .unwrap();
        assert_eq!(out.result["ok"], true);
        let doc = f.team.get_document(&ws, &DocId::from_http_path("docc".into()).unwrap()).unwrap();
        assert_eq!(doc["pageOrder"], json!(["c3", "c1", "c2"]));

        // Non-permutation refused.
        let err = dispatch(
            &f.ctx(true),
            "docushark_reorder_canvas_page",
            &json!({"docId": "docc", "order": ["c1", "c2"]}),
        )
        .unwrap_err();
        assert!(err.contains("permutation"), "{err}");
    }

    #[test]
    fn delete_canvas_page_deletes_then_refuses_the_last() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());
        let ws = WorkspaceId::single_tenant();
        save_canvas_pages_doc(&f, &["c1", "c2"]);

        // Delete the (active) first page → repoints activePageId to the survivor.
        dispatch(
            &f.ctx(true),
            "docushark_delete_canvas_page",
            &json!({"docId": "docc", "pageId": "c1"}),
        )
        .unwrap();
        let doc = f.team.get_document(&ws, &DocId::from_http_path("docc".into()).unwrap()).unwrap();
        assert!(doc["pages"].get("c1").is_none(), "c1 removed");
        assert_eq!(doc["pageOrder"], json!(["c2"]));
        assert_eq!(doc["activePageId"], "c2", "active repointed");

        // The now-last page can't be deleted.
        let err = dispatch(
            &f.ctx(true),
            "docushark_delete_canvas_page",
            &json!({"docId": "docc", "pageId": "c2"}),
        )
        .unwrap_err();
        assert!(err.contains("last canvas page"), "{err}");
    }

    #[test]
    fn delete_canvas_page_evicts_resident_active_page() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());
        let ws = WorkspaceId::single_tenant();
        let doc_id = DocId::from_http_path("docc".into()).unwrap();
        save_canvas_pages_doc(&f, &["c1", "c2"]);
        let handle = f.make_resident("docc");
        assert_eq!(handle.page_id(), Some("c1"), "resident on the active page");

        dispatch(
            &f.ctx(true),
            "docushark_delete_canvas_page",
            &json!({"docId": "docc", "pageId": "c1"}),
        )
        .unwrap();

        // The resident handle was on the deleted active page → evicted, so a
        // rejoin re-hydrates from the repointed activePageId (c2).
        assert!(f.registry.get(&ws, &doc_id).is_none(), "resident handle evicted");
        let doc = f.team.get_document(&ws, &doc_id).unwrap();
        assert_eq!(doc["activePageId"], "c2");
        assert!(doc["pages"].get("c1").is_none());
    }

    #[test]
    fn connect_live_validates_endpoints_against_ydoc() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());
        let handle = f.make_resident("doc1");

        // Missing endpoints → error, nothing applied, nothing broadcast.
        let err = dispatch(
            &f.ctx(true),
            "docushark_connect",
            &json!({"docId": "doc1", "pageId": "p1", "fromId": "a", "toId": "b"}),
        )
        .unwrap_err();
        assert!(err.contains("fromId 'a' does not exist"));
        assert!(f.broadcasts().is_empty());

        // Seed two shapes, then connect succeeds against the live Y.Doc.
        dispatch(
            &f.ctx(true),
            "docushark_add_shapes",
            &json!({"docId": "doc1", "pageId": "p1", "shapes": [
                {"kind": "rectangle", "id": "a"}, {"kind": "rectangle", "id": "b"}]}),
        )
        .unwrap();
        let out = dispatch(
            &f.ctx(true),
            "docushark_connect",
            &json!({"docId": "doc1", "pageId": "p1", "fromId": "a", "toId": "b"}),
        )
        .unwrap();
        let cid = out.result["id"].as_str().unwrap();
        assert!(handle.has_shape("p1", cid), "connector inserted into the live Y.Doc");
    }

    #[test]
    fn add_shape_non_resident_uses_json_and_no_broadcast() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());
        // Doc is not made resident → not live → JSON path.

        let out = dispatch(
            &f.ctx(true),
            "docushark_add_shape",
            &json!({"docId": "doc1", "pageId": "p1",
                    "shape": {"kind": "rectangle", "x": 1.0, "y": 2.0}}),
        )
        .unwrap();
        let id = out.result["id"].as_str().unwrap().to_string();

        // JSON store updated, provenance stamped on the JSON path too.
        let ws = WorkspaceId::single_tenant();
        let doc_id = DocId::from_http_path("doc1".to_string()).unwrap();
        let json = f.team.get_document(&ws, &doc_id).unwrap();
        let shape = json["pages"]["p1"]["shapes"]
            .get(id.as_str())
            .expect("shape persisted to JSON");
        assert_eq!(shape["provenance"]["source"], "mcp");

        // No live broadcast; changed_doc_id set so transport fires DocEvent.
        assert!(f.broadcasts().is_empty());
        assert_eq!(out.changed_doc_id.unwrap().as_str(), "doc1");
    }

    #[test]
    fn list_returns_seeded_doc() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());
        let out = dispatch(&f.ctx(true), "docushark_list_documents", &json!({})).unwrap();
        let docs = out.result["documents"].as_array().unwrap();
        assert_eq!(docs.len(), 1);
        assert_eq!(docs[0]["id"], "doc1");
        assert_eq!(docs[0]["source"], "team");
    }

    #[test]
    fn list_unions_team_and_local_when_enabled() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());
        f.local.mirror(&WorkspaceId::single_tenant(), make_doc("local1", "p1", "Local Doc")).unwrap();

        let out = dispatch(&f.ctx(true), "docushark_list_documents", &json!({})).unwrap();
        let docs = out.result["documents"].as_array().unwrap();
        let sources: Vec<&str> = docs.iter().map(|d| d["source"].as_str().unwrap()).collect();
        assert!(sources.contains(&"team"));
        assert!(sources.contains(&"local"));
        assert_eq!(out.result["localAccessEnabled"], true);
    }

    #[test]
    fn list_hides_local_when_disabled() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());
        f.local.mirror(&WorkspaceId::single_tenant(), make_doc("local1", "p1", "Local Doc")).unwrap();

        let out = dispatch(&f.ctx(false), "docushark_list_documents", &json!({})).unwrap();
        let docs = out.result["documents"].as_array().unwrap();
        assert_eq!(docs.len(), 1);
        assert_eq!(docs[0]["id"], "doc1");
        assert_eq!(out.result["localAccessEnabled"], false);
    }

    #[test]
    fn get_document_lists_pages() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());
        let out = dispatch(
            &f.ctx(true),
            "docushark_get_document",
            &json!({"docId": "doc1"}),
        )
        .unwrap();
        assert_eq!(out.result["pages"][0]["id"], "p1");
        assert_eq!(out.result["pages"][0]["shapeCount"], 0);
        assert_eq!(out.result["source"], "team");
    }

    #[test]
    fn get_document_falls_back_to_local() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());
        f.local.mirror(&WorkspaceId::single_tenant(), make_doc("local1", "p1", "Local Doc")).unwrap();

        let out = dispatch(
            &f.ctx(true),
            "docushark_get_document",
            &json!({"docId": "local1"}),
        )
        .unwrap();
        assert_eq!(out.result["source"], "local");
        assert_eq!(out.result["name"], "Local Doc");
    }

    #[test]
    fn get_document_local_blocked_when_disabled() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());
        f.local.mirror(&WorkspaceId::single_tenant(), make_doc("local1", "p1", "Local Doc")).unwrap();
        let err = dispatch(
            &f.ctx(false),
            "docushark_get_document",
            &json!({"docId": "local1"}),
        )
        .unwrap_err();
        assert!(err.contains("not found"));
    }

    #[test]
    fn add_shape_persists_and_appears_in_get_page() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());

        let out = dispatch(
            &f.ctx(true),
            "docushark_add_shape",
            &json!({
                "docId": "doc1",
                "pageId": "p1",
                "shape": {"kind": "rectangle", "x": 50, "y": 50, "text": "Hi"}
            }),
        )
        .unwrap();
        let id = out.result["id"].as_str().unwrap().to_string();
        assert_eq!(out.changed_doc_id.as_ref().map(|d| d.as_str()), Some("doc1"));

        let page = dispatch(
            &f.ctx(true),
            "docushark_get_page",
            &json!({"docId": "doc1", "pageId": "p1"}),
        )
        .unwrap();
        let shapes = page.result["shapes"].as_array().unwrap();
        assert_eq!(shapes.len(), 1);
        assert_eq!(shapes[0]["id"], id);
        assert_eq!(shapes[0]["kind"], "rectangle");
        assert_eq!(shapes[0]["text"], "Hi");
    }

    #[test]
    fn add_shape_rejects_duplicate_id() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());
        let args = json!({
            "docId": "doc1",
            "pageId": "p1",
            "shape": {"kind": "rectangle", "x": 0, "y": 0, "id": "fixed"}
        });
        dispatch(&f.ctx(true), "docushark_add_shape", &args).unwrap();
        let err = dispatch(&f.ctx(true), "docushark_add_shape", &args).unwrap_err();
        assert!(err.contains("already exists"));
    }

    #[test]
    fn add_shape_warns_when_doc_is_locked() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());
        f.team
            .set_lock(
                &WorkspaceId::single_tenant(),
                &DocId::from_http_path("doc1".to_string()).unwrap(),
                Some("other-user"),
                Some("Other"),
            )
            .unwrap();
        let out = dispatch(
            &f.ctx(true),
            "docushark_add_shape",
            &json!({
                "docId": "doc1",
                "pageId": "p1",
                "shape": {"kind": "rectangle", "x": 0, "y": 0}
            }),
        )
        .unwrap();
        assert!(out.result["warning"].as_str().unwrap().contains("locked"));
    }

    #[test]
    fn add_shape_refuses_local_docs_with_clear_message() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());
        f.local.mirror(&WorkspaceId::single_tenant(), make_doc("local1", "p1", "Local Doc")).unwrap();
        let err = dispatch(
            &f.ctx(true),
            "docushark_add_shape",
            &json!({
                "docId": "local1",
                "pageId": "p1",
                "shape": {"kind": "rectangle", "x": 0, "y": 0}
            }),
        )
        .unwrap_err();
        assert!(err.contains("read-only"));
    }

    #[test]
    fn add_shapes_batch_persists_all() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());
        let out = dispatch(
            &f.ctx(true),
            "docushark_add_shapes",
            &json!({
                "docId": "doc1",
                "pageId": "p1",
                "shapes": [
                    {"kind": "rectangle", "x": 0, "y": 0, "text": "A"},
                    {"kind": "ellipse",   "x": 100, "y": 0, "text": "B"},
                    {"kind": "text",      "x": 200, "y": 0, "text": "C"}
                ]
            }),
        )
        .unwrap();
        let ids = out.result["ids"].as_array().unwrap();
        assert_eq!(ids.len(), 3);

        let page = dispatch(
            &f.ctx(true),
            "docushark_get_page",
            &json!({"docId": "doc1", "pageId": "p1"}),
        )
        .unwrap();
        assert_eq!(page.result["shapes"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn add_shapes_is_all_or_nothing() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());
        // Force the second shape to collide on id.
        dispatch(
            &f.ctx(true),
            "docushark_add_shape",
            &json!({"docId":"doc1","pageId":"p1","shape":{"kind":"rectangle","x":0,"y":0,"id":"dup"}}),
        )
        .unwrap();

        let err = dispatch(
            &f.ctx(true),
            "docushark_add_shapes",
            &json!({
                "docId": "doc1",
                "pageId": "p1",
                "shapes": [
                    {"kind": "rectangle", "x": 0, "y": 0},
                    {"kind": "rectangle", "x": 0, "y": 0, "id": "dup"}
                ]
            }),
        )
        .unwrap_err();
        assert!(err.contains("already exists"));

        // Only the pre-existing "dup" shape should be present — neither
        // shape from the failed batch was written.
        let page = dispatch(
            &f.ctx(true),
            "docushark_get_page",
            &json!({"docId": "doc1", "pageId": "p1"}),
        )
        .unwrap();
        let shapes = page.result["shapes"].as_array().unwrap();
        assert_eq!(shapes.len(), 1);
        assert_eq!(shapes[0]["id"], "dup");
    }

    #[test]
    fn connect_requires_existing_endpoints() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());
        dispatch(
            &f.ctx(true),
            "docushark_add_shapes",
            &json!({
                "docId":"doc1","pageId":"p1",
                "shapes":[
                    {"kind":"rectangle","x":0,"y":0,"id":"src"},
                    {"kind":"rectangle","x":200,"y":0,"id":"dst"}
                ]
            }),
        )
        .unwrap();

        let out = dispatch(
            &f.ctx(true),
            "docushark_connect",
            &json!({
                "docId":"doc1","pageId":"p1",
                "fromId":"src","toId":"dst",
                "fromAnchor":"right","toAnchor":"left",
                "label":"calls"
            }),
        )
        .unwrap();
        let id = out.result["id"].as_str().unwrap().to_string();

        let page = dispatch(
            &f.ctx(true),
            "docushark_get_page",
            &json!({"docId":"doc1","pageId":"p1"}),
        )
        .unwrap();
        let connector = page
            .result["shapes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["id"].as_str() == Some(&id))
            .expect("connector present");
        assert_eq!(connector["kind"], "connector");
        assert_eq!(connector["startShapeId"], "src");
        assert_eq!(connector["endShapeId"], "dst");
        assert_eq!(connector["startAnchor"], "right");
    }

    #[test]
    fn connect_rejects_missing_endpoint() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());
        let err = dispatch(
            &f.ctx(true),
            "docushark_connect",
            &json!({"docId":"doc1","pageId":"p1","fromId":"nope","toId":"also-nope"}),
        )
        .unwrap_err();
        assert!(err.contains("does not exist"));
    }

    #[test]
    fn update_shape_patches_known_fields() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());
        let added = dispatch(
            &f.ctx(true),
            "docushark_add_shape",
            &json!({"docId":"doc1","pageId":"p1","shape":{"kind":"rectangle","x":0,"y":0,"text":"hi"}}),
        )
        .unwrap();
        let id = added.result["id"].as_str().unwrap().to_string();

        let out = dispatch(
            &f.ctx(true),
            "docushark_update_shape",
            &json!({
                "docId":"doc1","pageId":"p1","id":id,
                "patch":{"x":42,"text":"new","style":{"fill":"AUTO"}}
            }),
        )
        .unwrap();
        let changed = out.result["changed"].as_array().unwrap();
        let names: Vec<&str> = changed.iter().filter_map(|v| v.as_str()).collect();
        assert!(names.contains(&"x"));
        assert!(names.contains(&"text"));
        assert!(names.contains(&"style.fill"));
    }

    #[test]
    fn update_shape_errors_on_empty_patch() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());
        let added = dispatch(
            &f.ctx(true),
            "docushark_add_shape",
            &json!({"docId":"doc1","pageId":"p1","shape":{"kind":"rectangle","x":0,"y":0}}),
        )
        .unwrap();
        let id = added.result["id"].as_str().unwrap().to_string();

        let err = dispatch(
            &f.ctx(true),
            "docushark_update_shape",
            &json!({"docId":"doc1","pageId":"p1","id":id,"patch":{}}),
        )
        .unwrap_err();
        assert!(err.contains("updatable fields"));
    }

    #[test]
    fn write_tools_all_refuse_local_docs() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());
        f.local.mirror(&WorkspaceId::single_tenant(), make_doc("local1", "p1", "Local Doc")).unwrap();

        for (tool, args) in [
            (
                "docushark_add_shapes",
                json!({"docId":"local1","pageId":"p1","shapes":[{"kind":"rectangle","x":0,"y":0}]}),
            ),
            (
                "docushark_connect",
                json!({"docId":"local1","pageId":"p1","fromId":"a","toId":"b"}),
            ),
            (
                "docushark_update_shape",
                json!({"docId":"local1","pageId":"p1","id":"x","patch":{"x":1}}),
            ),
            (
                "docushark_delete_shape",
                json!({"docId":"local1","pageId":"p1","id":"x"}),
            ),
            (
                "docushark_delete_prose_page",
                json!({"docId":"local1","pageId":"rt1"}),
            ),
            (
                "docushark_reorder_shapes",
                json!({"docId":"local1","pageId":"p1","order":["a","b"]}),
            ),
            (
                "docushark_reorder_prose_pages",
                json!({"docId":"local1","order":["rt1","rt2"]}),
            ),
        ] {
            let err = dispatch(&f.ctx(true), tool, &args).unwrap_err();
            assert!(
                err.contains("read-only"),
                "{} should reject local docs, got: {}",
                tool,
                err
            );
        }
    }

    #[test]
    fn unknown_tool_errors() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());
        let err = dispatch(&f.ctx(true), "docushark_nope", &json!({})).unwrap_err();
        assert!(err.contains("Unknown tool"));
    }

    #[test]
    fn create_document_persists_and_is_listable() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());

        let out = dispatch(
            &f.ctx(true),
            "docushark_create_document",
            &json!({"name": "Architecture RFC"}),
        )
        .unwrap();
        let new_id = out.result["id"].as_str().unwrap().to_string();
        assert_eq!(out.result["name"], "Architecture RFC");
        assert!(new_id.starts_with("doc-"));
        // Should broadcast a change for the running app.
        assert_eq!(out.changed_doc_id.as_ref().map(|d| d.as_str()), Some(new_id.as_str()));

        // It shows up in list_documents as a team doc.
        let list = dispatch(&f.ctx(true), "docushark_list_documents", &json!({})).unwrap();
        let ids: Vec<&str> = list.result["documents"]
            .as_array()
            .unwrap()
            .iter()
            .map(|d| d["id"].as_str().unwrap())
            .collect();
        assert!(ids.contains(&new_id.as_str()));

        // get_document returns the blank canvas page.
        let got = dispatch(
            &f.ctx(true),
            "docushark_get_document",
            &json!({"docId": new_id}),
        )
        .unwrap();
        assert_eq!(got.result["source"], "team");
        let pages = got.result["pages"].as_array().unwrap();
        assert_eq!(pages.len(), 1);
        assert_eq!(pages[0]["shapeCount"], 0);
    }

    #[test]
    fn create_document_defaults_name_and_starts_with_a_prose_page() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());

        let out = dispatch(&f.ctx(true), "docushark_create_document", &json!({})).unwrap();
        assert_eq!(out.result["name"], "Untitled Document");
        let new_id = out.result["id"].as_str().unwrap().to_string();

        // The raw stored body carries a blank prose page so the editor's
        // Relaxed (prose) layout has something to open.
        let ws = WorkspaceId::single_tenant();
        let doc_id = DocId::from_body_id(new_id).unwrap();
        let raw = f.team.get_document(&ws, &doc_id).unwrap();
        let prose = &raw["richTextPages"];
        assert_eq!(prose["pageOrder"].as_array().unwrap().len(), 1);
        let active = prose["activePageId"].as_str().unwrap();
        assert_eq!(prose["pages"][active]["content"], "");
    }

    #[test]
    fn add_prose_page_renders_markdown_to_html() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());

        let out = dispatch(
            &f.ctx(true),
            "docushark_add_prose_page",
            &json!({
                "docId": "doc1",
                "name": "Overview",
                "content": "# Title\n\nA **bold** idea.\n\n- one\n- two"
            }),
        )
        .unwrap();
        let page_id = out.result["id"].as_str().unwrap().to_string();

        let got = dispatch(
            &f.ctx(true),
            "docushark_get_prose",
            &json!({"docId": "doc1", "pageId": page_id}),
        )
        .unwrap();
        let html = got.result["page"]["content"].as_str().unwrap();
        assert!(html.contains("<h1>Title</h1>"), "got: {}", html);
        assert!(html.contains("<strong>bold</strong>"));
        assert!(html.contains("<li>one</li>"));
        assert_eq!(got.result["page"]["name"], "Overview");
    }

    #[test]
    fn add_prose_page_surfaces_in_live_prose_page_list_when_resident() {
        // JP-339: on a resident doc, add_prose_page must write the new tab into
        // the live `prosePages`/`prosePageOrder` shared types (so connected
        // clients see it without reload). We prove it by flattening the live
        // handle — flatten reads the page list FROM the Y.Doc.
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());
        let ws = WorkspaceId::single_tenant();
        let doc_id = DocId::from_http_path("doc1".into()).unwrap();
        let handle = f.make_resident("doc1");

        let out = dispatch(
            &f.ctx(true),
            "docushark_add_prose_page",
            &json!({"docId": "doc1", "name": "Live Tab", "content": "body"}),
        )
        .unwrap();
        let page_id = out.result["id"].as_str().unwrap().to_string();

        let mut json = f.team.get_document(&ws, &doc_id).unwrap();
        assert!(handle.flatten_into(&mut json));
        let rtp = &json["richTextPages"];
        assert_eq!(rtp["pages"][&page_id]["name"], "Live Tab", "tab in live page list");
        assert!(
            rtp["pageOrder"].as_array().unwrap().iter().any(|v| v.as_str() == Some(&page_id)),
            "new tab id present in flattened pageOrder"
        );
    }

    #[test]
    fn set_prose_replaces_content_and_html_passthrough_works() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());
        let added = dispatch(
            &f.ctx(true),
            "docushark_add_prose_page",
            &json!({"docId": "doc1", "content": "old"}),
        )
        .unwrap();
        let page_id = added.result["id"].as_str().unwrap().to_string();

        dispatch(
            &f.ctx(true),
            "docushark_set_prose",
            &json!({"docId": "doc1", "pageId": page_id, "content": "<p>verbatim</p>", "format": "html"}),
        )
        .unwrap();

        let got = dispatch(
            &f.ctx(true),
            "docushark_get_prose",
            &json!({"docId": "doc1", "pageId": page_id}),
        )
        .unwrap();
        assert_eq!(got.result["page"]["content"], "<p>verbatim</p>");
    }

    #[test]
    fn set_prose_rejects_unknown_format_and_missing_page() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());
        let bad_fmt = dispatch(
            &f.ctx(true),
            "docushark_set_prose",
            &json!({"docId": "doc1", "pageId": "nope", "content": "x", "format": "rtf"}),
        )
        .unwrap_err();
        assert!(bad_fmt.contains("Unknown content format"));

        let missing = dispatch(
            &f.ctx(true),
            "docushark_set_prose",
            &json!({"docId": "doc1", "pageId": "nope", "content": "x"}),
        )
        .unwrap_err();
        assert!(missing.contains("not found"));
    }

    #[test]
    fn prose_writes_reject_oversized_content() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());
        let big = "a".repeat(MAX_PROSE_CONTENT_BYTES + 1);

        // The size check fires before page lookup, so the page need not exist.
        for (tool, args) in [
            ("docushark_set_prose", json!({"docId": "doc1", "pageId": "p", "content": big.clone()})),
            ("docushark_add_prose_page", json!({"docId": "doc1", "content": big.clone()})),
        ] {
            let err = dispatch(&f.ctx(true), tool, &args).unwrap_err();
            assert!(err.contains("ERR_PROSE_TOO_LARGE"), "{tool}: {err}");
        }

        // Just under the cap passes the size gate (fails later for a real reason).
        let ok_size = "a".repeat(MAX_PROSE_CONTENT_BYTES);
        let err = dispatch(
            &f.ctx(true),
            "docushark_set_prose",
            &json!({"docId": "doc1", "pageId": "nope", "content": ok_size}),
        )
        .unwrap_err();
        assert!(!err.contains("ERR_PROSE_TOO_LARGE"), "under-cap must pass the size gate: {err}");
    }

    #[test]
    fn rename_prose_page_updates_name_and_get_document_lists_prose() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());
        let added = dispatch(
            &f.ctx(true),
            "docushark_add_prose_page",
            &json!({"docId": "doc1", "name": "Draft"}),
        )
        .unwrap();
        let page_id = added.result["id"].as_str().unwrap().to_string();

        dispatch(
            &f.ctx(true),
            "docushark_rename_prose_page",
            &json!({"docId": "doc1", "pageId": page_id, "name": "Final"}),
        )
        .unwrap();

        let doc = dispatch(&f.ctx(true), "docushark_get_document", &json!({"docId": "doc1"})).unwrap();
        let prose = doc.result["prosePages"].as_array().unwrap();
        assert_eq!(prose.len(), 1);
        assert_eq!(prose[0]["id"], page_id.as_str());
        assert_eq!(prose[0]["name"], "Final");
    }

    #[test]
    fn prose_writes_refuse_local_docs() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());
        f.local.mirror(&WorkspaceId::single_tenant(), make_doc("local1", "p1", "Local")).unwrap();
        for (tool, args) in [
            ("docushark_add_prose_page", json!({"docId":"local1","content":"x"})),
            ("docushark_set_prose", json!({"docId":"local1","pageId":"p","content":"x"})),
            ("docushark_rename_prose_page", json!({"docId":"local1","pageId":"p","name":"y"})),
        ] {
            let err = dispatch(&f.ctx(true), tool, &args).unwrap_err();
            assert!(err.contains("read-only"), "{} -> {}", tool, err);
        }
    }

    // ---- JP-350: document-level rename / delete ----

    #[test]
    fn rename_document_updates_name_in_get_and_list_and_bumps_modified() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());

        let out = dispatch(
            &f.ctx(true),
            "docushark_rename_document",
            &json!({"docId": "doc1", "name": "Renamed Doc"}),
        )
        .unwrap();
        assert_eq!(out.result["id"], "doc1");
        assert_eq!(out.result["name"], "Renamed Doc");

        let got = dispatch(&f.ctx(true), "docushark_get_document", &json!({"docId": "doc1"})).unwrap();
        assert_eq!(got.result["name"], "Renamed Doc");
        // The seed doc starts at modifiedAt = 1; a rename stamps wall-clock now.
        assert!(
            got.result["modifiedAt"].as_u64().unwrap() > 1,
            "modifiedAt bumped: {:?}",
            got.result["modifiedAt"]
        );

        let list = dispatch(&f.ctx(true), "docushark_list_documents", &json!({})).unwrap();
        let doc = list.result["documents"]
            .as_array()
            .unwrap()
            .iter()
            .find(|d| d["id"] == "doc1")
            .expect("doc1 listed");
        assert_eq!(doc["name"], "Renamed Doc");
    }

    #[test]
    fn rename_document_validates_name_and_target() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());

        // Empty / whitespace-only names are rejected (no write).
        for bad in ["", "   "] {
            let err = dispatch(
                &f.ctx(true),
                "docushark_rename_document",
                &json!({"docId": "doc1", "name": bad}),
            )
            .unwrap_err();
            assert!(err.contains("must not be empty"), "name {bad:?}: {err}");
        }
        // The original name is untouched after the rejected writes.
        let got = dispatch(&f.ctx(true), "docushark_get_document", &json!({"docId": "doc1"})).unwrap();
        assert_eq!(got.result["name"], "Team Doc");

        // Unknown document id → not-found error (via the read in mutate_with_retry).
        let err = dispatch(
            &f.ctx(true),
            "docushark_rename_document",
            &json!({"docId": "nope", "name": "X"}),
        )
        .unwrap_err();
        assert!(err.contains("not found"), "{err}");

        // Surrounding whitespace is trimmed.
        let out = dispatch(
            &f.ctx(true),
            "docushark_rename_document",
            &json!({"docId": "doc1", "name": "  Trimmed  "}),
        )
        .unwrap();
        assert_eq!(out.result["name"], "Trimmed");
    }

    #[test]
    fn rename_document_is_idempotent_for_same_name() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());
        for _ in 0..2 {
            dispatch(
                &f.ctx(true),
                "docushark_rename_document",
                &json!({"docId": "doc1", "name": "Same"}),
            )
            .unwrap();
        }
        let got = dispatch(&f.ctx(true), "docushark_get_document", &json!({"docId": "doc1"})).unwrap();
        assert_eq!(got.result["name"], "Same");
    }

    #[test]
    fn rename_document_resident_broadcasts_title_nonresident_does_not() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());
        let ws = WorkspaceId::single_tenant();
        let doc_id = DocId::from_http_path("doc1".into()).unwrap();
        let handle = f.make_resident("doc1");
        assert!(f.broadcasts().is_empty(), "no broadcast before rename");

        dispatch(
            &f.ctx(true),
            "docushark_rename_document",
            &json!({"docId": "doc1", "name": "Renamed"}),
        )
        .unwrap();

        // Resident → a live metadata-title frame was broadcast (no reload needed).
        assert!(!f.broadcasts().is_empty(), "resident rename broadcasts a frame");

        // The live Y.Doc's metadata.title is now "Renamed": flatten adopts it over
        // a deliberately-wrong probe name (its updatedAt == the stamped modifiedAt,
        // so the flatten title-adoption guard fires). This would NOT happen if
        // set_metadata_title hadn't updated the resident Y.Doc.
        let mut probe = f.team.get_document(&ws, &doc_id).unwrap();
        probe["name"] = json!("PROBE-WRONG");
        assert!(handle.flatten_into(&mut probe), "flatten wrote");
        assert_eq!(probe["name"], "Renamed", "resident Y.Doc title updated live");

        // A non-resident rename persists but broadcasts nothing.
        let f2 = seed(&dir.path().join("nr").to_path_buf());
        dispatch(
            &f2.ctx(true),
            "docushark_rename_document",
            &json!({"docId": "doc1", "name": "Standalone"}),
        )
        .unwrap();
        assert!(f2.broadcasts().is_empty(), "non-resident rename does not broadcast");
        let got = dispatch(&f2.ctx(true), "docushark_get_document", &json!({"docId": "doc1"})).unwrap();
        assert_eq!(got.result["name"], "Standalone");
    }

    #[test]
    fn rename_document_title_survives_save_evict_rejoin() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());
        let ws = WorkspaceId::single_tenant();
        let doc_id = DocId::from_http_path("doc1".into()).unwrap();
        let _ = f.make_resident("doc1");

        dispatch(
            &f.ctx(true),
            "docushark_rename_document",
            &json!({"docId": "doc1", "name": "RoundTrip"}),
        )
        .unwrap();

        // Evict (drop the live Y.Doc) and re-hydrate from the persisted JSON —
        // the save→evict→rejoin cycle a real client triggers. The rehydrated
        // Y.Doc must carry the new title (JP-326 round-trip guard).
        f.registry.evict(&ws, &doc_id);
        let handle2 = f.make_resident("doc1");
        let mut probe = f.team.get_document(&ws, &doc_id).unwrap();
        probe["name"] = json!("PROBE");
        assert!(handle2.flatten_into(&mut probe), "flatten wrote");
        assert_eq!(probe["name"], "RoundTrip", "title survived save→evict→rejoin");
    }

    #[test]
    fn document_manage_tools_refuse_local_docs() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());
        f.local.mirror(&WorkspaceId::single_tenant(), make_doc("local1", "p1", "Local")).unwrap();
        for (tool, args) in [
            ("docushark_rename_document", json!({"docId": "local1", "name": "y"})),
            ("docushark_delete_document", json!({"docId": "local1"})),
        ] {
            let err = dispatch(&f.ctx(true), tool, &args).unwrap_err();
            assert!(err.contains("read-only"), "{tool} -> {err}");
        }
    }

    #[test]
    fn delete_document_removes_doc_and_fires_sink() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());
        let ws = WorkspaceId::single_tenant();
        let doc_id = DocId::from_http_path("doc1".into()).unwrap();

        let out = dispatch(&f.ctx(true), "docushark_delete_document", &json!({"docId": "doc1"})).unwrap();
        assert_eq!(out.result["deleted"], "doc1");
        // A delete must NOT set changed_doc_id (that broadcasts Updated → reload).
        assert!(out.changed_doc_id.is_none(), "delete sets no changed_doc_id");

        // Gone from the store + list.
        assert!(f.team.get_document(&ws, &doc_id).is_err(), "doc deleted from store");
        let list = dispatch(&f.ctx(true), "docushark_list_documents", &json!({})).unwrap();
        assert!(
            !list.result["documents"].as_array().unwrap().iter().any(|d| d["id"] == "doc1"),
            "doc1 no longer listed"
        );

        // The post-delete sink fired (Deleted event + blob release in production).
        let dels = f.deletions();
        assert!(dels.iter().any(|(w, d)| *w == ws && *d == doc_id), "delete sink fired: {dels:?}");
    }

    #[test]
    fn delete_document_missing_errors_and_skips_sink() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());
        let err = dispatch(&f.ctx(true), "docushark_delete_document", &json!({"docId": "nope"}))
            .unwrap_err();
        assert!(err.contains("not found"), "{err}");
        assert!(f.deletions().is_empty(), "no delete sink for a missing doc");
    }

    #[test]
    fn delete_document_evicts_resident_without_resurrecting() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());
        let ws = WorkspaceId::single_tenant();
        let doc_id = DocId::from_http_path("doc1".into()).unwrap();
        let _ = f.make_resident("doc1");
        assert!(f.registry.get(&ws, &doc_id).is_some(), "resident before delete");

        dispatch(&f.ctx(true), "docushark_delete_document", &json!({"docId": "doc1"})).unwrap();

        // Evicted (no live handle can re-snapshot) and the file stays gone.
        assert!(f.registry.get(&ws, &doc_id).is_none(), "resident handle evicted");
        assert!(f.team.get_document(&ws, &doc_id).is_err(), "doc stays deleted");
        assert!(f.deletions().iter().any(|(_, d)| *d == doc_id), "delete sink fired");
    }

    // ---- JP-349: canvas + prose page-count split in list_documents ----

    #[test]
    fn list_documents_reports_canvas_and_prose_split() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());
        // seed's doc1 is canvas-only (no richTextPages). Add one with prose.
        f.team
            .save_document(
                &WorkspaceId::single_tenant(),
                json!({
                    "id": "d2",
                    "name": "D2",
                    "pageOrder": ["c1", "c2"],
                    "richTextPages": {"pages": {}, "pageOrder": ["r1", "r2", "r3"], "activePageId": "r1"},
                }),
            )
            .unwrap();

        let out = dispatch(&f.ctx(true), "docushark_list_documents", &json!({})).unwrap();
        let docs = out.result["documents"].as_array().unwrap();

        let d1 = docs.iter().find(|d| d["id"] == "doc1").unwrap();
        assert_eq!(d1["pageCount"], 1);
        assert_eq!(d1["canvasPageCount"], 1);
        assert_eq!(d1["prosePageCount"], 0);

        let d2 = docs.iter().find(|d| d["id"] == "d2").unwrap();
        assert_eq!(d2["pageCount"], 5, "2 canvas + 3 prose");
        assert_eq!(d2["canvasPageCount"], 2);
        assert_eq!(d2["prosePageCount"], 3);
    }

    // ---- JP-312 "talk back": write tools report heal / drop / clamp ----

    #[test]
    fn add_shape_reports_unknown_key_and_clean_write_is_quiet() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());

        // Unknown top-level key ("fillColor" — the agent's fill typo) → reported.
        let out = dispatch(
            &f.ctx(true),
            "docushark_add_shape",
            &json!({"docId":"doc1","pageId":"p1","shape":{"kind":"rectangle","x":0,"y":0,"fillColor":"#f00"}}),
        )
        .unwrap();
        let fixes = out.result["fixes"].as_array().expect("fixes present");
        assert_eq!(fixes.len(), 1);
        assert_eq!(fixes[0]["field"], "fillColor");
        assert_eq!(fixes[0]["action"], "dropped_unknown");

        // A clean write has NO `fixes` key at all (quiet success, not []).
        let clean = dispatch(
            &f.ctx(true),
            "docushark_add_shape",
            &json!({"docId":"doc1","pageId":"p1","shape":{"kind":"rectangle","x":0,"y":0}}),
        )
        .unwrap();
        assert!(clean.result.get("fixes").is_none(), "clean write stays quiet");
    }

    #[test]
    fn add_shape_reports_fixes_on_both_resident_and_json_paths() {
        // The multi-area seam: fixes derive from the input DSL, so they must
        // surface whether the write took the live Y.Doc path or the JSON path.
        let bad = json!({"docId":"doc1","pageId":"p1","shape":{"kind":"rectangle","x":0,"y":0,"fillColor":"#f00"}});

        // JSON path (non-resident).
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());
        let json_path = dispatch(&f.ctx(true), "docushark_add_shape", &bad).unwrap();
        assert!(json_path.result.get("fixes").is_some(), "JSON path reports fixes");

        // Live path (resident).
        let dir2 = TempDir::new().unwrap();
        let f2 = seed(&dir2.path().to_path_buf());
        let _ = f2.make_resident("doc1");
        let live_path = dispatch(&f2.ctx(true), "docushark_add_shape", &bad).unwrap();
        assert!(live_path.result.get("fixes").is_some(), "live path reports fixes");
    }

    #[test]
    fn add_shape_fix_is_observational_not_behavioral() {
        // Reporting a dropped unknown key must NOT change what's persisted: the
        // shape built with the junk key is byte-identical to one without it.
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());

        let with_junk = dispatch(
            &f.ctx(true),
            "docushark_add_shape",
            &json!({"docId":"doc1","pageId":"p1","shape":{"kind":"rectangle","x":7,"y":8,"w":33,"fillColor":"#f00"}}),
        )
        .unwrap();
        let id_junk = with_junk.result["id"].as_str().unwrap().to_string();

        let clean = dispatch(
            &f.ctx(true),
            "docushark_add_shape",
            &json!({"docId":"doc1","pageId":"p1","shape":{"kind":"rectangle","x":7,"y":8,"w":33}}),
        )
        .unwrap();
        let id_clean = clean.result["id"].as_str().unwrap().to_string();

        let read = |id: &str| {
            let s = dispatch(
                &f.ctx(true),
                "docushark_get_shape",
                &json!({"docId":"doc1","pageId":"p1","id":id}),
            )
            .unwrap()
            .result;
            // get_shape returns { shape: {…dsl incl id}, source }. Drop the
            // differing id so we compare the shape bodies.
            let mut shape = s["shape"].clone();
            shape.as_object_mut().unwrap().remove("id");
            shape
        };
        assert_eq!(read(&id_junk), read(&id_clean), "junk key changed nothing persisted");
    }

    #[test]
    fn add_shapes_tags_fixes_with_shape_index() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());
        let out = dispatch(
            &f.ctx(true),
            "docushark_add_shapes",
            &json!({"docId":"doc1","pageId":"p1","shapes":[
                {"kind":"rectangle","x":0,"y":0},
                {"kind":"rectangle","x":10,"y":10,"bogus":1}
            ]}),
        )
        .unwrap();
        let fixes = out.result["fixes"].as_array().expect("fixes present");
        assert_eq!(fixes.len(), 1);
        assert_eq!(fixes[0]["field"], "bogus");
        assert_eq!(fixes[0]["shape"], 1, "tagged with the offending shape index");
    }

    #[test]
    fn update_shape_reports_unknown_patch_key_and_keeps_changes() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());
        let id = dispatch(
            &f.ctx(true),
            "docushark_add_shape",
            &json!({"docId":"doc1","pageId":"p1","shape":{"kind":"rectangle","x":0,"y":0}}),
        )
        .unwrap()
        .result["id"]
            .as_str()
            .unwrap()
            .to_string();

        let out = dispatch(
            &f.ctx(true),
            "docushark_update_shape",
            &json!({"docId":"doc1","pageId":"p1","id":id,"patch":{"x":99,"nope":1}}),
        )
        .unwrap();
        // The valid field still applied…
        assert!(out.result["changed"].as_array().unwrap().iter().any(|c| c == "x"));
        // …and the junk key was reported.
        let fixes = out.result["fixes"].as_array().expect("fixes present");
        assert_eq!(fixes[0]["field"], "nope");
        assert_eq!(fixes[0]["action"], "dropped_unknown");
    }

    #[test]
    fn insert_section_reports_level_clamp_and_persists_h6() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());
        let page_id = seed_prose(&f, "# Top");

        let out = dispatch(
            &f.ctx(true),
            "docushark_insert_section",
            &json!({"docId":"doc1","pageId":page_id,"level":9,"title":"Deep"}),
        )
        .unwrap();
        let fixes = out.result["fixes"].as_array().expect("clamp reported");
        assert_eq!(fixes[0]["field"], "level");
        assert_eq!(fixes[0]["action"], "clamped");

        // Heal + report agree: the persisted heading is h6.
        let outline = dispatch(
            &f.ctx(true),
            "docushark_get_outline",
            &json!({"docId":"doc1","pageId":page_id}),
        )
        .unwrap();
        let deep = outline.result["outline"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["title"] == "Deep")
            .unwrap();
        assert_eq!(deep["level"], 6);

        // An in-range level reports nothing.
        let clean = dispatch(
            &f.ctx(true),
            "docushark_insert_section",
            &json!({"docId":"doc1","pageId":page_id,"level":3,"title":"Fine"}),
        )
        .unwrap();
        assert!(clean.result.get("fixes").is_none());
    }

    #[test]
    fn set_fields_distinguishes_added_from_updated() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());

        let first = dispatch(
            &f.ctx(true),
            "docushark_set_fields",
            &json!({"docId":"doc1","fields":[{"name":"Framework","value":"Next"}]}),
        )
        .unwrap();
        assert_eq!(first.result["added"], json!(["Framework"]));
        assert_eq!(first.result["updated"], json!([]));

        // Re-setting the same name overwrites → reported as updated, not added.
        let second = dispatch(
            &f.ctx(true),
            "docushark_set_fields",
            &json!({"docId":"doc1","fields":[{"name":"Framework","value":"Remix"}]}),
        )
        .unwrap();
        assert_eq!(second.result["added"], json!([]));
        assert_eq!(second.result["updated"], json!(["Framework"]));
    }

    /// Seed a prose page with Markdown and return (docId, pageId).
    fn seed_prose(f: &Fixture, md: &str) -> String {
        let out = dispatch(
            &f.ctx(true),
            "docushark_add_prose_page",
            &json!({"docId": "doc1", "content": md}),
        )
        .unwrap();
        out.result["id"].as_str().unwrap().to_string()
    }

    #[test]
    fn get_outline_lists_headings_in_order() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());
        let page_id = seed_prose(&f, "# Alpha\n\ntext\n\n## Beta\n\n# Gamma");

        let out = dispatch(
            &f.ctx(true),
            "docushark_get_outline",
            &json!({"docId": "doc1", "pageId": page_id}),
        )
        .unwrap();
        let o = out.result["outline"].as_array().unwrap();
        assert_eq!(o.len(), 3);
        assert_eq!(o[0]["title"], "Alpha");
        assert_eq!(o[0]["level"], 1);
        assert_eq!(o[1]["title"], "Beta");
        assert_eq!(o[1]["level"], 2);
        assert_eq!(o[2]["title"], "Gamma");
    }

    #[test]
    fn insert_section_places_at_position_and_after_index() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());
        let page_id = seed_prose(&f, "# A\n\n# B");

        // Insert at start.
        dispatch(
            &f.ctx(true),
            "docushark_insert_section",
            &json!({"docId":"doc1","pageId":page_id,"level":1,"title":"Intro","position":"start"}),
        )
        .unwrap();
        // Insert after the second heading (index 1, which is now "A").
        dispatch(
            &f.ctx(true),
            "docushark_insert_section",
            &json!({"docId":"doc1","pageId":page_id,"level":2,"title":"A.1","body":"detail","afterIndex":1}),
        )
        .unwrap();

        let out = dispatch(
            &f.ctx(true),
            "docushark_get_outline",
            &json!({"docId":"doc1","pageId":page_id}),
        )
        .unwrap();
        let titles: Vec<&str> = out.result["outline"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["title"].as_str().unwrap())
            .collect();
        assert_eq!(titles, vec!["Intro", "A", "A.1", "B"]);

        // Body Markdown was rendered into the page HTML.
        let prose = dispatch(
            &f.ctx(true),
            "docushark_get_prose",
            &json!({"docId":"doc1","pageId":page_id}),
        )
        .unwrap();
        assert!(prose.result["page"]["content"].as_str().unwrap().contains("<p>detail</p>"));
    }

    #[test]
    fn restructure_outline_promotes_demotes_and_moves() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());
        let page_id = seed_prose(&f, "# First\n\n## Second\n\n## Third");

        // Promote "Second" (index 1, h2 -> h1).
        dispatch(
            &f.ctx(true),
            "docushark_restructure_outline",
            &json!({"docId":"doc1","pageId":page_id,"op":"promote","index":1}),
        )
        .unwrap();
        // Move "Third" (index 2) to the front.
        let moved = dispatch(
            &f.ctx(true),
            "docushark_restructure_outline",
            &json!({"docId":"doc1","pageId":page_id,"op":"move","index":2,"toIndex":0}),
        )
        .unwrap();
        let outline = moved.result["outline"].as_array().unwrap();
        assert_eq!(outline[0]["title"], "Third");
        assert_eq!(outline[1]["title"], "First");
        // Second was promoted to level 1.
        let second = outline.iter().find(|s| s["title"] == "Second").unwrap();
        assert_eq!(second["level"], 1);
    }

    #[test]
    fn restructure_outline_errors_on_bad_index_and_missing_to_index() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());
        let page_id = seed_prose(&f, "# Only");

        let oob = dispatch(
            &f.ctx(true),
            "docushark_restructure_outline",
            &json!({"docId":"doc1","pageId":page_id,"op":"promote","index":5}),
        )
        .unwrap_err();
        assert!(oob.contains("No section at index"));

        let no_to = dispatch(
            &f.ctx(true),
            "docushark_restructure_outline",
            &json!({"docId":"doc1","pageId":page_id,"op":"move","index":0}),
        )
        .unwrap_err();
        assert!(no_to.contains("requires 'toIndex'"));
    }

    #[test]
    fn generate_diagram_creates_shapes_and_connectors() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());

        let out = dispatch(
            &f.ctx(true),
            "docushark_generate_diagram",
            &json!({
                "docId": "doc1",
                "pageId": "p1",
                "nodes": [
                    {"id": "client", "label": "Client"},
                    {"id": "relay", "label": "Relay"},
                    {"id": "store", "label": "R2", "kind": "ellipse"}
                ],
                "edges": [
                    {"from": "client", "to": "relay", "label": "WS"},
                    {"from": "relay", "to": "store"}
                ]
            }),
        )
        .unwrap();
        assert_eq!(out.result["layout"], "layered");
        // 3 nodes mapped, 2 connectors.
        assert_eq!(out.result["nodes"].as_object().unwrap().len(), 3);
        assert_eq!(out.result["edges"].as_array().unwrap().len(), 2);

        // Page now holds 5 shapes: 3 nodes + 2 connectors.
        let page = dispatch(
            &f.ctx(true),
            "docushark_get_page",
            &json!({"docId": "doc1", "pageId": "p1"}),
        )
        .unwrap();
        let kinds: Vec<&str> = page.result["shapes"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|s| s["kind"].as_str())
            .collect();
        assert_eq!(kinds.iter().filter(|k| **k == "connector").count(), 2);
        assert_eq!(kinds.iter().filter(|k| **k == "ellipse").count(), 1);
        assert_eq!(kinds.iter().filter(|k| **k == "rectangle").count(), 2);

        // Layered layout assigns flow anchors (JP-245): forward edges leave
        // the bottom of their source and enter the top of their target —
        // not the old center-to-center attachment. Routing defaults to
        // orthogonal with explicit waypoints.
        for s in page.result["shapes"].as_array().unwrap() {
            if s["kind"] == "connector" {
                assert_eq!(s["startAnchor"], "bottom");
                assert_eq!(s["endAnchor"], "top");
                assert_eq!(s["routingMode"], "orthogonal");
                assert!(s["waypoints"].is_array());
            }
        }
        assert_eq!(out.result["routing"], "orthogonal");
    }

    /// The headline JP-245 acceptance: a connector forced past an
    /// intervening node detours around it — no path segment crosses any
    /// non-endpoint node's interior.
    #[test]
    fn generate_diagram_routes_around_intervening_nodes() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());

        // 3x3 grid; an edge across the top row must clear the middle node.
        let nodes: Vec<Value> = (0..9).map(|i| json!({"id": format!("n{}", i)})).collect();
        let out = dispatch(
            &f.ctx(true),
            "docushark_generate_diagram",
            &json!({
                "docId": "doc1",
                "pageId": "p1",
                "nodes": nodes,
                "edges": [{"from": "n0", "to": "n2"}],
                "layout": "grid"
            }),
        )
        .unwrap();

        let ws = WorkspaceId::single_tenant();
        let raw = f.team.get_document(&ws, &DocId::from_body_id("doc1".into()).unwrap()).unwrap();
        let shapes = raw["pages"]["p1"]["shapes"].as_object().unwrap();

        let connector_id = out.result["edges"][0].as_str().unwrap();
        let conn = &shapes[connector_id];
        let waypoints = conn["waypoints"].as_array().unwrap();
        assert!(!waypoints.is_empty(), "expected a detour, got a straight shot");

        // Full path: start, waypoints, end.
        let mut path: Vec<(f64, f64)> =
            vec![(conn["x"].as_f64().unwrap(), conn["y"].as_f64().unwrap())];
        for p in waypoints {
            path.push((p["x"].as_f64().unwrap(), p["y"].as_f64().unwrap()));
        }
        path.push((conn["x2"].as_f64().unwrap(), conn["y2"].as_f64().unwrap()));

        let endpoint_ids = [
            out.result["nodes"]["n0"].as_str().unwrap(),
            out.result["nodes"]["n2"].as_str().unwrap(),
        ];
        for (logical, shape_id) in out.result["nodes"].as_object().unwrap() {
            if endpoint_ids.contains(&shape_id.as_str().unwrap()) {
                continue;
            }
            let s = &shapes[shape_id.as_str().unwrap()];
            let (cx, cy) = (s["x"].as_f64().unwrap(), s["y"].as_f64().unwrap());
            let (w, h) = (s["width"].as_f64().unwrap(), s["height"].as_f64().unwrap());
            let rect = crate::mcp::route::Rect {
                min_x: cx - w / 2.0,
                min_y: cy - h / 2.0,
                max_x: cx + w / 2.0,
                max_y: cy + h / 2.0,
            };
            for i in 1..path.len() {
                assert!(
                    !crate::mcp::route::segment_crosses_box(
                        path[i - 1].0,
                        path[i - 1].1,
                        path[i].0,
                        path[i].1,
                        &rect
                    ),
                    "segment {:?} -> {:?} crosses node '{}'",
                    path[i - 1],
                    path[i],
                    logical
                );
            }
        }
    }

    #[test]
    fn generate_diagram_straight_routing_omits_routed_fields() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());

        let out = dispatch(
            &f.ctx(true),
            "docushark_generate_diagram",
            &json!({
                "docId": "doc1",
                "pageId": "p1",
                "nodes": [{"id": "a"}, {"id": "b"}],
                "edges": [{"from": "a", "to": "b"}],
                "routing": "straight"
            }),
        )
        .unwrap();
        assert_eq!(out.result["routing"], "straight");

        let ws = WorkspaceId::single_tenant();
        let raw = f.team.get_document(&ws, &DocId::from_body_id("doc1".into()).unwrap()).unwrap();
        let conn = &raw["pages"]["p1"]["shapes"][out.result["edges"][0].as_str().unwrap()];
        let obj = conn.as_object().unwrap();
        // Plain anchor-to-anchor connector: typed anchors but no routed-path
        // fields at all.
        assert_eq!(conn["startAnchor"], "bottom");
        assert_eq!(conn["endAnchor"], "top");
        assert!(!obj.contains_key("routingMode"));
        assert!(!obj.contains_key("waypoints"));
        assert!(!obj.contains_key("labelPosition"));
    }

    #[test]
    fn generate_diagram_is_deterministic_across_documents() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());

        let created = dispatch(&f.ctx(true), "docushark_create_document", &json!({"name": "Two"}))
            .unwrap();
        let doc2 = created.result["id"].as_str().unwrap().to_string();
        let got = dispatch(&f.ctx(true), "docushark_get_document", &json!({"docId": doc2})).unwrap();
        let page2 = got.result["pages"][0]["id"].as_str().unwrap().to_string();

        let graph = |doc: &str, page: &str| {
            json!({
                "docId": doc,
                "pageId": page,
                "nodes": [{"id": "a"}, {"id": "b"}, {"id": "c"}, {"id": "d"}],
                "edges": [
                    {"from": "a", "to": "b"}, {"from": "a", "to": "c"},
                    {"from": "b", "to": "d"}, {"from": "c", "to": "d"},
                    {"from": "d", "to": "a"}
                ]
            })
        };
        let out1 =
            dispatch(&f.ctx(true), "docushark_generate_diagram", &graph("doc1", "p1")).unwrap();
        let out2 =
            dispatch(&f.ctx(true), "docushark_generate_diagram", &graph(&doc2, &page2)).unwrap();

        let ws = WorkspaceId::single_tenant();
        let raw1 = f.team.get_document(&ws, &DocId::from_body_id("doc1".into()).unwrap()).unwrap();
        let raw2 = f.team.get_document(&ws, &DocId::from_body_id(doc2).unwrap()).unwrap();
        let shapes1 = &raw1["pages"]["p1"]["shapes"];
        let shapes2 = &raw2["pages"][&page2]["shapes"];

        // Same geometry in both documents (ids differ, fields don't).
        for key in ["a", "b", "c", "d"] {
            let s1 = &shapes1[out1.result["nodes"][key].as_str().unwrap()];
            let s2 = &shapes2[out2.result["nodes"][key].as_str().unwrap()];
            assert_eq!(s1["x"], s2["x"], "node '{}' x diverged", key);
            assert_eq!(s1["y"], s2["y"], "node '{}' y diverged", key);
        }
        for (e1, e2) in out1.result["edges"]
            .as_array()
            .unwrap()
            .iter()
            .zip(out2.result["edges"].as_array().unwrap())
        {
            let c1 = &shapes1[e1.as_str().unwrap()];
            let c2 = &shapes2[e2.as_str().unwrap()];
            for field in ["x", "y", "x2", "y2", "startAnchor", "endAnchor", "waypoints"] {
                assert_eq!(c1[field], c2[field], "connector field '{}' diverged", field);
            }
        }
    }

    #[test]
    fn generate_diagram_rejects_bad_graph() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());

        let dup = dispatch(
            &f.ctx(true),
            "docushark_generate_diagram",
            &json!({"docId":"doc1","pageId":"p1","nodes":[{"id":"a"},{"id":"a"}]}),
        )
        .unwrap_err();
        assert!(dup.contains("duplicate node id"));

        let dangling = dispatch(
            &f.ctx(true),
            "docushark_generate_diagram",
            &json!({"docId":"doc1","pageId":"p1","nodes":[{"id":"a"}],"edges":[{"from":"a","to":"ghost"}]}),
        )
        .unwrap_err();
        assert!(dangling.contains("unknown node 'ghost'"));

        let bad_routing = dispatch(
            &f.ctx(true),
            "docushark_generate_diagram",
            &json!({"docId":"doc1","pageId":"p1","nodes":[{"id":"a"}],"routing":"diagonal"}),
        )
        .unwrap_err();
        assert!(bad_routing.contains("Unknown routing"));

        let local_refused = {
            f.local.mirror(&WorkspaceId::single_tenant(), make_doc("local1", "p1", "Local")).unwrap();
            dispatch(
                &f.ctx(true),
                "docushark_generate_diagram",
                &json!({"docId":"local1","pageId":"p1","nodes":[{"id":"a"}]}),
            )
            .unwrap_err()
        };
        assert!(local_refused.contains("read-only"));
    }

    #[test]
    fn create_document_then_add_shape_round_trips() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());

        let created = dispatch(&f.ctx(true), "docushark_create_document", &json!({"name": "Flow"})).unwrap();
        let doc_id = created.result["id"].as_str().unwrap().to_string();

        // Discover the canvas page id via get_document.
        let got = dispatch(&f.ctx(true), "docushark_get_document", &json!({"docId": doc_id})).unwrap();
        let page_id = got.result["pages"][0]["id"].as_str().unwrap().to_string();

        // An agent can immediately draw on the fresh doc.
        dispatch(
            &f.ctx(true),
            "docushark_add_shape",
            &json!({"docId": doc_id, "pageId": page_id, "shape": {"kind": "rectangle", "x": 10, "y": 10}}),
        )
        .unwrap();

        let page = dispatch(
            &f.ctx(true),
            "docushark_get_page",
            &json!({"docId": doc_id, "pageId": page_id}),
        )
        .unwrap();
        assert_eq!(page.result["shapes"].as_array().unwrap().len(), 1);
    }

    /// A write that loses the optimistic-concurrency race re-reads and
    /// replays its mutation rather than clobbering the concurrent edit.
    /// Simulates a live collaborator's save landing between our read and
    /// our save; the final doc must carry *both* changes.
    #[test]
    fn write_retries_and_preserves_concurrent_edit() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());
        let ws = WorkspaceId::single_tenant();
        let ctx = f.ctx(true);
        let doc_id = DocId::from_body_id("doc1".to_string()).unwrap();

        let mut attempts = 0usize;
        mutate_with_retry(&ctx, &doc_id, |doc| {
            attempts += 1;
            if attempts == 1 {
                // A collaborator renames the doc after we read but before
                // we save, bumping serverVersion and forcing a conflict.
                let mut other = f.team.get_document(&ws, &doc_id).unwrap();
                other
                    .as_object_mut()
                    .unwrap()
                    .insert("name".into(), json!("Renamed by collaborator"));
                f.team.save_document(&ws, other).unwrap();
            }
            // Our mutation: stamp a marker field.
            doc.as_object_mut()
                .unwrap()
                .insert("mcpNote".into(), json!("mcp-was-here"));
            Ok::<(), String>(())
        })
        .unwrap();

        assert_eq!(attempts, 2, "should re-read and replay exactly once after the conflict");

        let final_doc = f.team.get_document(&ws, &doc_id).unwrap();
        assert_eq!(
            final_doc["mcpNote"], "mcp-was-here",
            "our mutation must persist"
        );
        assert_eq!(
            final_doc["name"], "Renamed by collaborator",
            "the concurrent edit must NOT be clobbered"
        );
    }

    /// Retries are bounded: a writer that never wins the race fails with a
    /// clear conflict message rather than spinning forever.
    #[test]
    fn write_gives_up_after_max_attempts() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());
        let ws = WorkspaceId::single_tenant();
        let ctx = f.ctx(true);
        let doc_id = DocId::from_body_id("doc1".to_string()).unwrap();

        let err = mutate_with_retry(&ctx, &doc_id, |doc| {
            // Always bump the version out from under ourselves before saving.
            let mut other = f.team.get_document(&ws, &doc_id).unwrap();
            let bump = other["modifiedAt"].as_u64().unwrap_or(0) + 1;
            other
                .as_object_mut()
                .unwrap()
                .insert("modifiedAt".into(), json!(bump));
            f.team.save_document(&ws, other).unwrap();
            doc.as_object_mut()
                .unwrap()
                .insert("mcpNote".into(), json!("never lands"));
            Ok::<(), String>(())
        })
        .unwrap_err();

        assert!(
            err.contains("modified concurrently"),
            "expected a concurrency error, got: {}",
            err
        );
    }

    // ---- JP-89: citation / reference tools ----

    #[test]
    fn add_reference_items_persist_and_list() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());

        let out = dispatch(
            &f.ctx(true),
            "docushark_add_reference",
            &json!({"docId": "doc1", "items": [
                {"id": "smith2020", "type": "article-journal", "DOI": "10.1000/AAA"},
                {"id": "jones2021", "DOI": "10.1000/bbb"},
            ]}),
        )
        .unwrap();
        assert_eq!(out.result["addedCount"], json!(2));
        assert_eq!(out.result["duplicates"], json!(0));
        // A write must nudge the app to reload (references aren't live-synced).
        assert_eq!(out.changed_doc_id.as_ref().unwrap().as_str(), "doc1");

        // Durable in the JSON store (top-level `references`).
        let ws = WorkspaceId::single_tenant();
        let doc_id = DocId::from_http_path("doc1".to_string()).unwrap();
        let json = f.team.get_document(&ws, &doc_id).unwrap();
        assert_eq!(json["references"]["itemOrder"], json!(["smith2020", "jones2021"]));

        // list_references reflects them, in order, with the count.
        let listed = dispatch(&f.ctx(true), "docushark_list_references", &json!({"docId": "doc1"}))
            .unwrap();
        assert_eq!(listed.result["count"], json!(2));
        assert_eq!(listed.result["references"][0]["id"], json!("smith2020"));
        assert_eq!(listed.result["source"], json!("team"));
        assert!(listed.changed_doc_id.is_none(), "a read must not nudge a reload");
    }

    #[test]
    fn add_reference_dedups_against_existing_library() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());

        dispatch(
            &f.ctx(true),
            "docushark_add_reference",
            &json!({"docId": "doc1", "items": [{"id": "a", "DOI": "10.1000/aaa"}]}),
        )
        .unwrap();
        // Same DOI (different case) + a genuinely new one.
        let out = dispatch(
            &f.ctx(true),
            "docushark_add_reference",
            &json!({"docId": "doc1", "items": [
                {"id": "a-again", "DOI": "10.1000/AAA"},
                {"id": "b", "DOI": "10.1000/bbb"},
            ]}),
        )
        .unwrap();
        assert_eq!(out.result["added"], json!(["b"]));
        assert_eq!(out.result["duplicates"], json!(1));
    }

    #[test]
    fn add_reference_requires_items_or_doi() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());
        let err = dispatch(&f.ctx(true), "docushark_add_reference", &json!({"docId": "doc1"}))
            .unwrap_err();
        assert!(err.contains("'doi' or non-empty 'items'"), "got: {}", err);
    }

    #[test]
    fn list_references_empty_for_fresh_doc() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());
        let out = dispatch(&f.ctx(true), "docushark_list_references", &json!({"docId": "doc1"}))
            .unwrap();
        assert_eq!(out.result["count"], json!(0));
        assert_eq!(out.result["references"], json!([]));
    }

    // ---- Phase 3c: fields tools ----

    #[test]
    fn set_fields_cold_persists_and_lists() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());

        let out = dispatch(
            &f.ctx(true),
            "docushark_set_fields",
            &json!({"docId": "doc1", "fields": [
                {"name": "Company", "value": "Acme"},
                {"name": "Version", "value": "2.0"},
            ]}),
        )
        .unwrap();
        assert_eq!(out.result["setCount"], json!(2));
        assert_eq!(out.result["added"], json!(["Company", "Version"]));
        // Cold write nudges the app to reload.
        assert_eq!(out.changed_doc_id.as_ref().unwrap().as_str(), "doc1");

        // Durable in the JSON store (top-level `fields`).
        let ws = WorkspaceId::single_tenant();
        let doc_id = DocId::from_http_path("doc1".to_string()).unwrap();
        let json = f.team.get_document(&ws, &doc_id).unwrap();
        assert_eq!(json["fields"]["order"], json!(["Company", "Version"]));
        assert_eq!(json["fields"]["fields"]["Company"]["value"], json!("Acme"));

        // list_fields reflects them in order; get_document exposes them too.
        let listed = dispatch(&f.ctx(true), "docushark_list_fields", &json!({"docId": "doc1"})).unwrap();
        assert_eq!(listed.result["count"], json!(2));
        assert_eq!(listed.result["fields"][0]["name"], json!("Company"));
        assert!(listed.changed_doc_id.is_none(), "a read must not nudge a reload");

        let got = dispatch(&f.ctx(true), "docushark_get_document", &json!({"docId": "doc1"})).unwrap();
        assert_eq!(got.result["fields"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn set_fields_upserts_value_in_place() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());
        dispatch(&f.ctx(true), "docushark_set_fields", &json!({"docId": "doc1", "fields": [{"name": "Company", "value": "Acme"}]})).unwrap();
        let out = dispatch(&f.ctx(true), "docushark_set_fields", &json!({"docId": "doc1", "fields": [{"name": "Company", "value": "Globex"}]})).unwrap();
        // An existing name → updated, not newly added.
        assert_eq!(out.result["added"], json!([]));
        let listed = dispatch(&f.ctx(true), "docushark_list_fields", &json!({"docId": "doc1"})).unwrap();
        assert_eq!(listed.result["count"], json!(1));
        assert_eq!(listed.result["fields"][0]["value"], json!("Globex"));
    }

    #[test]
    fn set_fields_resident_writes_ydoc_and_broadcasts() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());
        let handle = f.make_resident("doc1");

        let out = dispatch(
            &f.ctx(true),
            "docushark_set_fields",
            &json!({"docId": "doc1", "fields": [{"name": "Company", "value": "Acme"}]}),
        )
        .unwrap();

        // Applied to the live Y.Doc.
        assert_eq!(handle.fields_json().get("Company").unwrap()["value"], json!("Acme"));
        assert_eq!(handle.field_order(), vec!["Company".to_string()]);
        // One CRDT delta broadcast; no reload nudge (the client's observer merges).
        let bc = f.broadcasts();
        assert_eq!(bc.len(), 1, "exactly one broadcast");
        assert_eq!(bc[0].1.as_str(), "doc1");
        assert!(!bc[0].2.is_empty());
        assert!(out.changed_doc_id.is_none());
        assert_eq!(out.result["added"], json!(["Company"]));
    }

    #[test]
    fn set_fields_requires_non_empty_name() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());
        let err = dispatch(&f.ctx(true), "docushark_set_fields", &json!({"docId": "doc1", "fields": [{"name": "  ", "value": "x"}]}))
            .unwrap_err();
        assert!(err.contains("non-empty 'name'"), "got: {}", err);
    }

    #[test]
    fn set_fields_rejects_local_document() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());
        f.local.mirror(&WorkspaceId::single_tenant(), make_doc("local1", "p1", "Local Doc")).unwrap();
        let err = dispatch(&f.ctx(true), "docushark_set_fields", &json!({"docId": "local1", "fields": [{"name": "A", "value": "1"}]}))
            .unwrap_err();
        assert!(err.contains("read-only"), "got: {}", err);
    }

    #[test]
    fn list_fields_empty_for_fresh_doc() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());
        let out = dispatch(&f.ctx(true), "docushark_list_fields", &json!({"docId": "doc1"})).unwrap();
        assert_eq!(out.result["count"], json!(0));
        assert_eq!(out.result["fields"], json!([]));
    }

    // ---- Phase 3c: {{name}} markdown adapter ----

    #[test]
    fn markdown_field_token_becomes_span() {
        let html = markdown_to_html("The {{Company}} agrees to pay {{Amount}}.");
        assert!(html.contains(r#"<span data-field data-name="Company"></span>"#), "got: {html}");
        assert!(html.contains(r#"<span data-field data-name="Amount"></span>"#), "got: {html}");
        assert!(html.contains("The "), "literal text preserved");
    }

    #[test]
    fn markdown_field_token_left_literal_in_code() {
        // Inline code and fenced code blocks must keep `{{…}}` verbatim.
        let inline = markdown_to_html("use `{{notAField}}` here");
        assert!(inline.contains("{{notAField}}"), "inline code untouched: {inline}");
        assert!(!inline.contains("data-field"));

        let fenced = markdown_to_html("```\n{{alsoNotAField}}\n```");
        assert!(fenced.contains("{{alsoNotAField}}"), "code block untouched: {fenced}");
        assert!(!fenced.contains("data-field"));
    }

    #[test]
    fn markdown_malformed_field_token_stays_literal() {
        // No closing braces / an inner brace → not a token.
        let html = markdown_to_html("a {{unclosed and {{x}} b");
        assert!(html.contains("{{unclosed and "), "got: {html}");
        // The well-formed `{{x}}` after the junk still converts.
        assert!(html.contains(r#"<span data-field data-name="x"></span>"#), "got: {html}");
    }

    /// JP-356: the markdown a `set_prose` author writes for a soft-wrapped /
    /// loose list renders (pulldown-cmark) with a newline *inside* the item. The
    /// corroborating parser-side assertion that this collapses cleanly lives in
    /// `sync::prose_parse` (where `html_to_blocks` is reachable); this test pins
    /// the exact HTML pulldown emits, so the two can't silently drift.
    #[test]
    fn loose_list_markdown_bakes_interior_newline() {
        // Tight list, soft-wrapped continuation → newline inside the <li> text.
        assert!(markdown_to_html("- a\n  b\n").contains("a\nb"));
        // Loose list (blank line between items) → newline inside an explicit <p>.
        assert!(markdown_to_html("- a\n  b\n\n- c\n").contains("<p>a\nb</p>"));
    }

    // ───────────────────── JP-370: MCP per-document gate ─────────────────────

    /// Every advertised tool must have an explicit permission classification —
    /// and no doc-mutating tool may fall into the read/none buckets. This is the
    /// guard against a future tool silently shipping with no write-gate: add a
    /// tool to `descriptors()` without classifying it and (because the catch-all
    /// is Editor) it's gated as a write — this test pins the intended mapping so
    /// a *read* tool added to the write bucket (or vice-versa) is caught.
    #[test]
    fn every_tool_has_an_intended_permission_classification() {
        use crate::server::permissions::Permission;
        let reads = [
            "docushark_get_document",
            "docushark_get_page",
            "docushark_get_shape",
            "docushark_get_prose",
            "docushark_get_outline",
            "docushark_list_references",
            "docushark_list_fields",
        ];
        let no_doc = [
            "docushark_list_documents",
            "docushark_create_document",
            "docushark_get_skills",
            "docushark_list_icons",
            "docushark_resolve_doi",
        ];
        for d in descriptors() {
            let got = tool_required_permission(d.name);
            if reads.contains(&d.name) {
                assert_eq!(got, Some(Permission::Viewer), "{} should be a read", d.name);
            } else if no_doc.contains(&d.name) {
                assert_eq!(got, None, "{} targets no single doc", d.name);
            } else if d.name == "docushark_delete_document" {
                assert_eq!(got, Some(Permission::Owner), "delete is owner-only");
            } else {
                // Every other advertised tool mutates a document → Editor.
                assert_eq!(got, Some(Permission::Editor), "{} should require Editor", d.name);
            }
        }
    }

    /// Seed a doc owned by someone else (no shares) and confirm the gate denies a
    /// plain workspace member's read AND write via `dispatch`, then a `view`
    /// share lets the read through.
    #[tokio::test]
    async fn jwt_caller_is_gated_on_a_private_doc() {
        let dir = tempfile::tempdir().unwrap().keep();
        let f = seed(&dir);
        let ws = WorkspaceId::single_tenant();
        // An owned, unshared doc (distinct from the fixture's owner-less doc1).
        f.team
            .save_document(
                &ws,
                json!({
                    "id": "owned1", "name": "Owner's doc", "ownerId": "owner-1",
                    "version": 1, "createdAt": 1u64, "modifiedAt": 1u64,
                    "activePageId": "p1", "pageOrder": ["p1"],
                    "pages": { "p1": { "id": "p1", "name": "P", "shapes": {}, "shapeOrder": [] } },
                }),
            )
            .unwrap();

        let member = f.ctx_as("member-2", "member", true);
        let args = json!({ "docId": "owned1" });

        assert!(
            dispatch(&member, "docushark_get_document", &args).is_err(),
            "unshared member must be denied read"
        );
        assert!(
            dispatch(&member, "docushark_rename_document", &json!({ "docId": "owned1", "name": "x" }))
                .is_err(),
            "unshared member must be denied write"
        );

        // Owner-role caller (workspace owner/admin) is allowed by the role short-circuit.
        let owner = f.ctx_as("someone", "owner", true);
        assert!(dispatch(&owner, "docushark_get_document", &args).is_ok());

        // Grant member-2 a view share → read now allowed, write still denied.
        f.team
            .update_document_shares(
                &ws,
                &DocId::from_http_path("owned1".into()).unwrap(),
                &[crate::server::protocol::ShareEntry {
                    user_id: "member-2".into(),
                    user_name: "Member".into(),
                    permission: "view".into(),
                }],
            )
            .unwrap();
        assert!(dispatch(&member, "docushark_get_document", &args).is_ok(), "view share allows read");
        assert!(
            dispatch(&member, "docushark_rename_document", &json!({ "docId": "owned1", "name": "x" }))
                .is_err(),
            "a viewer still can't write"
        );
    }

    /// The static loopback token (no user identity) bypasses the gate even with
    /// enforcement on — preserving the desktop / self-host flow.
    #[tokio::test]
    async fn static_token_bypasses_the_gate() {
        let dir = tempfile::tempdir().unwrap().keep();
        let f = seed(&dir);
        f.team
            .save_document(
                &WorkspaceId::single_tenant(),
                json!({
                    "id": "owned1", "name": "Owner's doc", "ownerId": "owner-1",
                    "version": 1, "createdAt": 1u64, "modifiedAt": 1u64,
                    "activePageId": "p1", "pageOrder": ["p1"],
                    "pages": { "p1": { "id": "p1", "name": "P", "shapes": {}, "shapeOrder": [] } },
                }),
            )
            .unwrap();
        // ctx() has user_id = None (static token) — enforcement is irrelevant.
        let mut ctx = f.ctx(false);
        ctx.enforce_private_docs = true;
        assert!(
            dispatch(&ctx, "docushark_get_document", &json!({ "docId": "owned1" })).is_ok(),
            "static loopback token must bypass the per-doc gate"
        );
    }
}
