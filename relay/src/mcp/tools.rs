//! MCP tool surface for DocuShark, all namespaced `docushark.*`.
//!
//! Reads:   list_documents, get_document, get_page, get_prose
//! Authoring (JP-93 "publish target"): create_document
//! Diagram writes: add_shape, add_shapes, connect, update_shape
//! Prose writes:   add_prose_page, set_prose, rename_prose_page
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

use super::adapter::{apply_dsl_patch, dsl_to_shape_json, shape_json_to_dsl, DslPatch, DslShape};
use super::local_mirror::LocalDocumentMirror;
use super::outline::{clamp_level, escape_html, Outline, Section};

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
            name: "docushark.list_documents",
            description:
                "List DocuShark team documents stored on this host. Returns id, name, pageCount, modifiedAt for each.",
            input_schema: json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }),
        },
        ToolDescriptor {
            name: "docushark.get_document",
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
            name: "docushark.get_page",
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
            name: "docushark.create_document",
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
            name: "docushark.get_prose",
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
            name: "docushark.add_prose_page",
            description:
                "Add a new prose page to a document and return its id. Content is Markdown by default (set format:\"html\" to pass HTML through). Use this to start a new section/chapter of the written document.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "docId": {"type": "string"},
                    "name": {"type": "string", "description": "Page title. Defaults to \"Page N\"."},
                    "content": {"type": "string", "description": "Initial body. Markdown unless format is \"html\". Optional (blank page if omitted)."},
                    "format": {"type": "string", "enum": ["markdown", "html"], "description": "Interpretation of content. Default: \"markdown\"."}
                },
                "required": ["docId"],
                "additionalProperties": false
            }),
        },
        ToolDescriptor {
            name: "docushark.set_prose",
            description:
                "Replace the entire content of a prose page. Content is Markdown by default (set format:\"html\" to pass HTML through). Refuses local (renderer-owned) documents.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "docId": {"type": "string"},
                    "pageId": {"type": "string"},
                    "content": {"type": "string", "description": "New full body. Markdown unless format is \"html\"."},
                    "format": {"type": "string", "enum": ["markdown", "html"], "description": "Interpretation of content. Default: \"markdown\"."}
                },
                "required": ["docId", "pageId", "content"],
                "additionalProperties": false
            }),
        },
        ToolDescriptor {
            name: "docushark.rename_prose_page",
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
            name: "docushark.get_outline",
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
            name: "docushark.insert_section",
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
            name: "docushark.restructure_outline",
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
            name: "docushark.add_shape",
            description:
                "Add a single shape (rectangle, ellipse, text, or connector) to a page. Returns the id assigned. Warns if the document is locked by another user. Refuses local (renderer-owned) documents — those are read-only via MCP.",
            input_schema: dsl_shape_input_schema(),
        },
        ToolDescriptor {
            name: "docushark.add_shapes",
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
            name: "docushark.connect",
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
            name: "docushark.update_shape",
            description:
                "Apply a partial DSL patch to an existing shape. Any subset of x, y, w, h, text, and style may be supplied; absent fields are left untouched. Refuses local documents.",
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
                            "style": dsl_style_schema_inline()
                        },
                        "additionalProperties": false
                    }
                },
                "required": ["docId", "pageId", "id", "patch"],
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
    // Always refresh the index from disk first so reads see any writes the
    // WebSocket server (or another MCP write) made since last call.
    ctx.team.reload_index();

    match name {
        "docushark.list_documents" => list_documents(ctx),
        "docushark.get_document" => get_document(ctx, args),
        "docushark.get_page" => get_page(ctx, args),
        "docushark.create_document" => create_document(ctx, args),
        "docushark.get_prose" => get_prose(ctx, args),
        "docushark.add_prose_page" => add_prose_page(ctx, args),
        "docushark.set_prose" => set_prose(ctx, args),
        "docushark.rename_prose_page" => rename_prose_page(ctx, args),
        "docushark.get_outline" => get_outline(ctx, args),
        "docushark.insert_section" => insert_section(ctx, args),
        "docushark.restructure_outline" => restructure_outline(ctx, args),
        "docushark.add_shape" => add_shape(ctx, args),
        "docushark.add_shapes" => add_shapes(ctx, args),
        "docushark.connect" => connect(ctx, args),
        "docushark.update_shape" => update_shape(ctx, args),
        _ => Err(format!("Unknown tool: {}", name)),
    }
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
    let mut payload: Vec<Value> = ctx
        .team
        .list_documents(&ctx.workspace_id)
        .into_iter()
        .map(|m| {
            json!({
                "id": m.id,
                "name": m.name,
                "pageCount": m.page_count,
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

    let pages: Vec<Value> = doc
        .get("pageOrder")
        .and_then(|v| v.as_array())
        .map(|order| {
            order
                .iter()
                .filter_map(|id| id.as_str())
                .filter_map(|id| {
                    let page = doc.get("pages")?.get(id)?;
                    let shape_count = page
                        .get("shapeOrder")
                        .and_then(|v| v.as_array())
                        .map(|a| a.len())
                        .unwrap_or(0);
                    Some(json!({
                        "id": id,
                        "name": page.get("name").cloned().unwrap_or(json!("")),
                        "shapeCount": shape_count,
                    }))
                })
                .collect()
        })
        .unwrap_or_default();

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
        .map(|shape| {
            shape_json_to_dsl(shape).unwrap_or_else(|| {
                // Fallback: pass through a minimal generic descriptor for
                // shape kinds the foundation adapter doesn't model yet.
                json!({
                    "id": shape.get("id"),
                    "kind": shape.get("type"),
                    "x": shape.get("x"),
                    "y": shape.get("y"),
                    "_unmapped": true,
                })
            })
        })
        .collect();

    Ok(ToolOutcome {
        result: json!({"shapes": shapes, "source": source}),
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
                "name": "Page 1",
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
                    "name": "Page 1",
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
// Prose tools (JP-93 Slice B): read/write the document's written body, which
// lives in `richTextPages` (multi-page TipTap prose) alongside the diagram
// canvas. Prose is persisted as HTML; agents author in Markdown by default.
// ---------------------------------------------------------------------------

/// Render Markdown to the HTML TipTap persists. GFM tables / strikethrough /
/// task-lists are enabled to match the editor's extension set.
fn markdown_to_html(md: &str) -> String {
    use pulldown_cmark::{html, Options, Parser};
    let mut opts = Options::empty();
    opts.insert(Options::ENABLE_TABLES);
    opts.insert(Options::ENABLE_STRIKETHROUGH);
    opts.insert(Options::ENABLE_TASKLISTS);
    let parser = Parser::new_ext(md, opts);
    let mut out = String::new();
    html::push_html(&mut out, parser);
    out
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

    let empty_pages = json!({});
    let rtp = doc.get("richTextPages");
    let pages_obj = rtp.and_then(|r| r.get("pages")).unwrap_or(&empty_pages);

    let render = |id: &str, page: &Value| {
        json!({
            "id": id,
            "name": page.get("name").cloned().unwrap_or(json!("")),
            "order": page.get("order").cloned().unwrap_or(json!(0)),
            "content": page.get("content").cloned().unwrap_or(json!("")),
        })
    };

    if let Some(page_id) = parsed.page_id {
        let page = pages_obj
            .get(&page_id)
            .ok_or_else(|| format!("Prose page '{}' not found", page_id))?;
        return Ok(ToolOutcome {
            result: json!({"page": render(&page_id, page), "source": source}),
            changed_doc_id: None,
            change_detail: None,
        });
    }

    let order: Vec<String> = rtp
        .and_then(|r| r.get("pageOrder"))
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let pages: Vec<Value> = order
        .iter()
        .filter_map(|id| pages_obj.get(id).map(|p| render(id, p)))
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
        Some(c) => content_to_html(c, parsed.format.as_deref())?,
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
        let name = parsed
            .name
            .clone()
            .map(|n| n.trim().to_string())
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| format!("Page {}", order + 1));

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

    Ok(ToolOutcome {
        result: json!({"id": id}),
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
}

fn set_prose(ctx: &ToolContext, args: &Value) -> Result<ToolOutcome, String> {
    let parsed: SetProseArgs =
        serde_json::from_value(args.clone()).map_err(|e| format!("Invalid arguments: {}", e))?;
    reject_if_local(ctx, &parsed.doc_id)?;
    let html = content_to_html(&parsed.content, parsed.format.as_deref())?;

    mutate_with_retry(ctx, &parsed.doc_id, |doc| {
        let now = now_ms();
        let rtp = rich_text_pages_mut(doc)?;
        let page = rtp
            .get_mut("pages")
            .and_then(|v| v.as_object_mut())
            .and_then(|pages| pages.get_mut(&parsed.page_id))
            .and_then(|p| p.as_object_mut())
            .ok_or_else(|| format!("Prose page '{}' not found", parsed.page_id))?;
        page.insert("content".into(), json!(html.clone()));
        page.insert("modifiedAt".into(), json!(now));
        stamp_doc_modified(doc, now);
        Ok(())
    })?;

    Ok(ToolOutcome {
        result: json!({"pageId": parsed.page_id, "ok": true}),
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

    Ok(ToolOutcome {
        result: json!({"pageId": parsed.page_id, "name": name}),
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
    let content = read_prose_content(&doc, &parsed.page_id)?;
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
    let title = parsed.title.trim().to_string();
    let inner_html = escape_html(&title);
    // Render the body once, up front, so a bad format fails before any write.
    let body_html = match &parsed.body {
        Some(b) => content_to_html(b, parsed.format.as_deref())?,
        None => String::new(),
    };

    mutate_with_retry(ctx, &parsed.doc_id, |doc| {
        let now = now_ms();
        let content = read_prose_content(doc, &parsed.page_id)?;
        let mut outline = Outline::parse(&content);
        let len = outline.sections.len();
        let pos = match parsed.after_index {
            Some(ai) => (ai + 1).min(len),
            None => match parsed.position.as_deref() {
                Some("start") => 0,
                _ => len,
            },
        };
        outline.sections.insert(
            pos,
            Section {
                level,
                inner_html: inner_html.clone(),
                title: title.clone(),
                body_html: body_html.clone(),
            },
        );
        write_prose_content(doc, &parsed.page_id, outline.to_html(), now)
    })?;

    Ok(ToolOutcome {
        result: json!({"pageId": parsed.page_id, "ok": true}),
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

    let summary = mutate_with_retry(ctx, &parsed.doc_id, |doc| {
        let now = now_ms();
        let content = read_prose_content(doc, &parsed.page_id)?;
        let mut outline = Outline::parse(&content);
        let n = outline.sections.len();
        if parsed.index >= n {
            return Err(format!(
                "No section at index {} — the page has {} heading(s)",
                parsed.index, n
            ));
        }
        match parsed.op.as_str() {
            "promote" => {
                let lvl = outline.sections[parsed.index].level as i64;
                outline.sections[parsed.index].level = clamp_level(lvl - 1);
            }
            "demote" => {
                let lvl = outline.sections[parsed.index].level as i64;
                outline.sections[parsed.index].level = clamp_level(lvl + 1);
            }
            "move" => {
                let to = parsed
                    .to_index
                    .ok_or("op 'move' requires 'toIndex'")?
                    .min(n - 1);
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
        write_prose_content(doc, &parsed.page_id, outline.to_html(), now)?;
        Ok(outline_summary(&outline))
    })?;

    Ok(ToolOutcome {
        result: json!({"pageId": parsed.page_id, "outline": summary}),
        changed_doc_id: Some(parsed.doc_id),
        change_detail: None,
    })
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

/// Insert one DSL shape into a doc that's already in memory. Returns the
/// id used. Does **not** save — callers batch a sequence of these and
/// then call `save_document` once, so a partial failure rolls back by
/// virtue of discarding the in-memory doc.
fn append_shape_in_place(doc: &mut Value, page_id: &str, shape: &DslShape) -> Result<String, String> {
    let id = shape
        .id
        .clone()
        .unwrap_or_else(|| format!("shape-{}", nanoid::nanoid!(10)));
    let shape_json = dsl_to_shape_json(shape, &id);

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

fn add_shape(ctx: &ToolContext, args: &Value) -> Result<ToolOutcome, String> {
    let parsed: AddShapeArgs =
        serde_json::from_value(args.clone()).map_err(|e| format!("Invalid arguments: {}", e))?;

    reject_if_local(ctx, &parsed.doc_id)?;
    let (id, warning) = mutate_with_retry(ctx, &parsed.doc_id, |doc| {
        let warning = lock_warning(doc);
        let id = append_shape_in_place(doc, &parsed.page_id, &parsed.shape)?;
        stamp_modified(doc, &parsed.page_id);
        Ok((id, warning))
    })?;

    Ok(ToolOutcome {
        result: json!({"id": id, "warning": warning}),
        changed_doc_id: Some(parsed.doc_id),
        change_detail: None,
    })
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
    let (ids, warning) = mutate_with_retry(ctx, &parsed.doc_id, |doc| {
        let warning = lock_warning(doc);
        let mut ids = Vec::with_capacity(parsed.shapes.len());
        for (idx, shape) in parsed.shapes.iter().enumerate() {
            match append_shape_in_place(doc, &parsed.page_id, shape) {
                Ok(id) => ids.push(id),
                Err(e) => return Err(format!("shape[{}]: {}", idx, e)),
            }
        }
        stamp_modified(doc, &parsed.page_id);
        Ok((ids, warning))
    })?;

    Ok(ToolOutcome {
        result: json!({"ids": ids, "warning": warning}),
        changed_doc_id: Some(parsed.doc_id),
        change_detail: None,
    })
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
    let (id, warning) = mutate_with_retry(ctx, &parsed.doc_id, |doc| {
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
        let dsl = DslShape {
            kind: super::adapter::DslKind::Connector,
            x: 0.0,
            y: 0.0,
            w: None,
            h: None,
            text: parsed.label.clone(),
            style: None,
            id: None,
            start_shape_id: Some(parsed.from_id.clone()),
            end_shape_id: Some(parsed.to_id.clone()),
            start_anchor: parsed.from_anchor.clone(),
            end_anchor: parsed.to_anchor.clone(),
            start_arrow_style: None,
            end_arrow_style: None,
        };
        let id = append_shape_in_place(doc, &parsed.page_id, &dsl)?;
        stamp_modified(doc, &parsed.page_id);
        Ok((id, warning))
    })?;

    Ok(ToolOutcome {
        result: json!({"id": id, "warning": warning}),
        changed_doc_id: Some(parsed.doc_id),
        change_detail: None,
    })
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
    let (changed, warning) = mutate_with_retry(ctx, &parsed.doc_id, |doc| {
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
        let shape = shapes
            .get_mut(&parsed.id)
            .ok_or_else(|| format!("Shape '{}' not found on page '{}'", parsed.id, parsed.page_id))?;

        let changed = apply_dsl_patch(shape, &parsed.patch);
        if changed.is_empty() {
            return Err("Patch did not specify any updatable fields".into());
        }

        stamp_modified(doc, &parsed.page_id);
        Ok((changed, warning))
    })?;

    Ok(ToolOutcome {
        result: json!({"id": parsed.id, "changed": changed, "warning": warning}),
        changed_doc_id: Some(parsed.doc_id),
        change_detail: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use tempfile::TempDir;

    struct Fixture {
        team: Arc<DocumentStore>,
        local: Arc<LocalDocumentMirror>,
    }

    impl Fixture {
        fn ctx(&self, local_enabled: bool) -> ToolContext<'_> {
            ToolContext {
                team: &self.team,
                local: &self.local,
                local_enabled,
                workspace_id: WorkspaceId::single_tenant(),
            }
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
        Fixture { team, local }
    }

    #[test]
    fn list_returns_seeded_doc() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());
        let out = dispatch(&f.ctx(true), "docushark.list_documents", &json!({})).unwrap();
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

        let out = dispatch(&f.ctx(true), "docushark.list_documents", &json!({})).unwrap();
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

        let out = dispatch(&f.ctx(false), "docushark.list_documents", &json!({})).unwrap();
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
            "docushark.get_document",
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
            "docushark.get_document",
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
            "docushark.get_document",
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
            "docushark.add_shape",
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
            "docushark.get_page",
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
        dispatch(&f.ctx(true), "docushark.add_shape", &args).unwrap();
        let err = dispatch(&f.ctx(true), "docushark.add_shape", &args).unwrap_err();
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
            "docushark.add_shape",
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
            "docushark.add_shape",
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
            "docushark.add_shapes",
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
            "docushark.get_page",
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
            "docushark.add_shape",
            &json!({"docId":"doc1","pageId":"p1","shape":{"kind":"rectangle","x":0,"y":0,"id":"dup"}}),
        )
        .unwrap();

        let err = dispatch(
            &f.ctx(true),
            "docushark.add_shapes",
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
            "docushark.get_page",
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
            "docushark.add_shapes",
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
            "docushark.connect",
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
            "docushark.get_page",
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
            "docushark.connect",
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
            "docushark.add_shape",
            &json!({"docId":"doc1","pageId":"p1","shape":{"kind":"rectangle","x":0,"y":0,"text":"hi"}}),
        )
        .unwrap();
        let id = added.result["id"].as_str().unwrap().to_string();

        let out = dispatch(
            &f.ctx(true),
            "docushark.update_shape",
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
            "docushark.add_shape",
            &json!({"docId":"doc1","pageId":"p1","shape":{"kind":"rectangle","x":0,"y":0}}),
        )
        .unwrap();
        let id = added.result["id"].as_str().unwrap().to_string();

        let err = dispatch(
            &f.ctx(true),
            "docushark.update_shape",
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
                "docushark.add_shapes",
                json!({"docId":"local1","pageId":"p1","shapes":[{"kind":"rectangle","x":0,"y":0}]}),
            ),
            (
                "docushark.connect",
                json!({"docId":"local1","pageId":"p1","fromId":"a","toId":"b"}),
            ),
            (
                "docushark.update_shape",
                json!({"docId":"local1","pageId":"p1","id":"x","patch":{"x":1}}),
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
        let err = dispatch(&f.ctx(true), "docushark.nope", &json!({})).unwrap_err();
        assert!(err.contains("Unknown tool"));
    }

    #[test]
    fn create_document_persists_and_is_listable() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());

        let out = dispatch(
            &f.ctx(true),
            "docushark.create_document",
            &json!({"name": "Architecture RFC"}),
        )
        .unwrap();
        let new_id = out.result["id"].as_str().unwrap().to_string();
        assert_eq!(out.result["name"], "Architecture RFC");
        assert!(new_id.starts_with("doc-"));
        // Should broadcast a change for the running app.
        assert_eq!(out.changed_doc_id.as_ref().map(|d| d.as_str()), Some(new_id.as_str()));

        // It shows up in list_documents as a team doc.
        let list = dispatch(&f.ctx(true), "docushark.list_documents", &json!({})).unwrap();
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
            "docushark.get_document",
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

        let out = dispatch(&f.ctx(true), "docushark.create_document", &json!({})).unwrap();
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
            "docushark.add_prose_page",
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
            "docushark.get_prose",
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
    fn set_prose_replaces_content_and_html_passthrough_works() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());
        let added = dispatch(
            &f.ctx(true),
            "docushark.add_prose_page",
            &json!({"docId": "doc1", "content": "old"}),
        )
        .unwrap();
        let page_id = added.result["id"].as_str().unwrap().to_string();

        dispatch(
            &f.ctx(true),
            "docushark.set_prose",
            &json!({"docId": "doc1", "pageId": page_id, "content": "<p>verbatim</p>", "format": "html"}),
        )
        .unwrap();

        let got = dispatch(
            &f.ctx(true),
            "docushark.get_prose",
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
            "docushark.set_prose",
            &json!({"docId": "doc1", "pageId": "nope", "content": "x", "format": "rtf"}),
        )
        .unwrap_err();
        assert!(bad_fmt.contains("Unknown content format"));

        let missing = dispatch(
            &f.ctx(true),
            "docushark.set_prose",
            &json!({"docId": "doc1", "pageId": "nope", "content": "x"}),
        )
        .unwrap_err();
        assert!(missing.contains("not found"));
    }

    #[test]
    fn rename_prose_page_updates_name_and_get_document_lists_prose() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());
        let added = dispatch(
            &f.ctx(true),
            "docushark.add_prose_page",
            &json!({"docId": "doc1", "name": "Draft"}),
        )
        .unwrap();
        let page_id = added.result["id"].as_str().unwrap().to_string();

        dispatch(
            &f.ctx(true),
            "docushark.rename_prose_page",
            &json!({"docId": "doc1", "pageId": page_id, "name": "Final"}),
        )
        .unwrap();

        let doc = dispatch(&f.ctx(true), "docushark.get_document", &json!({"docId": "doc1"})).unwrap();
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
            ("docushark.add_prose_page", json!({"docId":"local1","content":"x"})),
            ("docushark.set_prose", json!({"docId":"local1","pageId":"p","content":"x"})),
            ("docushark.rename_prose_page", json!({"docId":"local1","pageId":"p","name":"y"})),
        ] {
            let err = dispatch(&f.ctx(true), tool, &args).unwrap_err();
            assert!(err.contains("read-only"), "{} -> {}", tool, err);
        }
    }

    /// Seed a prose page with Markdown and return (docId, pageId).
    fn seed_prose(f: &Fixture, md: &str) -> String {
        let out = dispatch(
            &f.ctx(true),
            "docushark.add_prose_page",
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
            "docushark.get_outline",
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
            "docushark.insert_section",
            &json!({"docId":"doc1","pageId":page_id,"level":1,"title":"Intro","position":"start"}),
        )
        .unwrap();
        // Insert after the second heading (index 1, which is now "A").
        dispatch(
            &f.ctx(true),
            "docushark.insert_section",
            &json!({"docId":"doc1","pageId":page_id,"level":2,"title":"A.1","body":"detail","afterIndex":1}),
        )
        .unwrap();

        let out = dispatch(
            &f.ctx(true),
            "docushark.get_outline",
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
            "docushark.get_prose",
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
            "docushark.restructure_outline",
            &json!({"docId":"doc1","pageId":page_id,"op":"promote","index":1}),
        )
        .unwrap();
        // Move "Third" (index 2) to the front.
        let moved = dispatch(
            &f.ctx(true),
            "docushark.restructure_outline",
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
            "docushark.restructure_outline",
            &json!({"docId":"doc1","pageId":page_id,"op":"promote","index":5}),
        )
        .unwrap_err();
        assert!(oob.contains("No section at index"));

        let no_to = dispatch(
            &f.ctx(true),
            "docushark.restructure_outline",
            &json!({"docId":"doc1","pageId":page_id,"op":"move","index":0}),
        )
        .unwrap_err();
        assert!(no_to.contains("requires 'toIndex'"));
    }

    #[test]
    fn create_document_then_add_shape_round_trips() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());

        let created = dispatch(&f.ctx(true), "docushark.create_document", &json!({"name": "Flow"})).unwrap();
        let doc_id = created.result["id"].as_str().unwrap().to_string();

        // Discover the canvas page id via get_document.
        let got = dispatch(&f.ctx(true), "docushark.get_document", &json!({"docId": doc_id})).unwrap();
        let page_id = got.result["pages"][0]["id"].as_str().unwrap().to_string();

        // An agent can immediately draw on the fresh doc.
        dispatch(
            &f.ctx(true),
            "docushark.add_shape",
            &json!({"docId": doc_id, "pageId": page_id, "shape": {"kind": "rectangle", "x": 10, "y": 10}}),
        )
        .unwrap();

        let page = dispatch(
            &f.ctx(true),
            "docushark.get_page",
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
}
