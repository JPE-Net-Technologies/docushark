//! MCP tool surface for Diagrammer — foundation set.
//!
//! Four tools, all namespaced `diagrammer.*`:
//!   - list_documents
//!   - get_document
//!   - get_page
//!   - add_shape
//!
//! Richer write tools (batch add, connect, layout, group, comments) are
//! deferred until the foundation is debugged.

use std::sync::Arc;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::server::documents::DocumentStore;

use super::adapter::{dsl_to_shape_json, shape_json_to_dsl, DslShape};
use super::local_mirror::LocalDocumentMirror;

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
            name: "diagrammer.list_documents",
            description:
                "List Diagrammer team documents stored on this host. Returns id, name, pageCount, modifiedAt for each.",
            input_schema: json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }),
        },
        ToolDescriptor {
            name: "diagrammer.get_document",
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
            name: "diagrammer.get_page",
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
            name: "diagrammer.add_shape",
            description:
                "Add a single shape (rectangle, ellipse, or text) to a page. Returns the id assigned. Warns if the document is locked by another user.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "docId": {"type": "string"},
                    "pageId": {"type": "string"},
                    "shape": {
                        "type": "object",
                        "properties": {
                            "kind": {"type": "string", "enum": ["rectangle", "ellipse", "text"]},
                            "x": {"type": "number"},
                            "y": {"type": "number"},
                            "w": {"type": "number"},
                            "h": {"type": "number"},
                            "text": {"type": "string"},
                            "id": {"type": "string"},
                            "style": {
                                "type": "object",
                                "properties": {
                                    "fill": {"type": "string"},
                                    "stroke": {"type": "string"},
                                    "strokeWidth": {"type": "number"},
                                    "labelColor": {"type": "string"}
                                },
                                "additionalProperties": false
                            }
                        },
                        "required": ["kind", "x", "y"],
                        "additionalProperties": false
                    }
                },
                "required": ["docId", "pageId", "shape"],
                "additionalProperties": false
            }),
        },
    ]
}

/// Outcome of a tool call.
#[derive(Debug)]
pub struct ToolOutcome {
    /// JSON value returned to the caller (wrapped by transport into MCP
    /// content blocks).
    pub result: Value,
    /// If `Some`, the transport should also broadcast a doc-changed event
    /// for this document id so the running app reloads.
    pub changed_doc_id: Option<String>,
}

/// Dispatch a `tools/call` request. `name` is the tool name as advertised
/// in `descriptors()`; `args` is the `arguments` object from the call.
pub fn dispatch(ctx: &ToolContext, name: &str, args: &Value) -> Result<ToolOutcome, String> {
    // Always refresh the index from disk first so reads see any writes the
    // WebSocket server (or another MCP write) made since last call.
    ctx.team.reload_index();

    match name {
        "diagrammer.list_documents" => list_documents(ctx),
        "diagrammer.get_document" => get_document(ctx, args),
        "diagrammer.get_page" => get_page(ctx, args),
        "diagrammer.add_shape" => add_shape(ctx, args),
        _ => Err(format!("Unknown tool: {}", name)),
    }
}

/// Look up a document across team + local sources. Returns the document
/// JSON and the source tag, or `Err` if it's nowhere (or in the local
/// mirror but local access is currently disabled).
fn fetch_doc(ctx: &ToolContext, doc_id: &str) -> Result<(Value, &'static str), String> {
    if let Ok(doc) = ctx.team.get_document(doc_id) {
        return Ok((doc, SOURCE_TEAM));
    }
    if ctx.local_enabled && ctx.local.contains(doc_id) {
        let doc = ctx.local.get(doc_id)?;
        return Ok((doc, SOURCE_LOCAL));
    }
    Err(format!("Document '{}' not found", doc_id))
}

fn list_documents(ctx: &ToolContext) -> Result<ToolOutcome, String> {
    let mut payload: Vec<Value> = ctx
        .team
        .list_documents()
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
        for m in ctx.local.list() {
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
    })
}

#[derive(Deserialize)]
struct GetDocumentArgs {
    #[serde(rename = "docId")]
    doc_id: String,
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
            "pages": pages,
            "source": source,
        }),
        changed_doc_id: None,
    })
}

#[derive(Deserialize)]
struct GetPageArgs {
    #[serde(rename = "docId")]
    doc_id: String,
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
    })
}

#[derive(Deserialize)]
struct AddShapeArgs {
    #[serde(rename = "docId")]
    doc_id: String,
    #[serde(rename = "pageId")]
    page_id: String,
    shape: DslShape,
}

fn add_shape(ctx: &ToolContext, args: &Value) -> Result<ToolOutcome, String> {
    let parsed: AddShapeArgs =
        serde_json::from_value(args.clone()).map_err(|e| format!("Invalid arguments: {}", e))?;

    // Local-mirror docs are read-only via MCP for now — writing them would
    // race with the renderer that owns the canonical localStorage copy.
    if ctx.local_enabled && ctx.local.contains(&parsed.doc_id) && !ctx.team.get_document(&parsed.doc_id).is_ok() {
        return Err(
            "This is a local (renderer-owned) document and is read-only via MCP. \
             Promote it to a team document to enable writes."
                .into(),
        );
    }

    let mut doc = ctx.team.get_document(&parsed.doc_id)?;

    // Surface a lock warning rather than refusing — write still proceeds.
    let locked_warning = doc
        .get("lockedBy")
        .and_then(|v| v.as_str())
        .map(|uid| format!("Document is locked by user '{}' — write may be overwritten.", uid));

    let id = parsed
        .shape
        .id
        .clone()
        .unwrap_or_else(|| format!("shape-{}", nanoid::nanoid!(10)));

    let shape_json = dsl_to_shape_json(&parsed.shape, &id);

    let pages = doc
        .get_mut("pages")
        .and_then(|v| v.as_object_mut())
        .ok_or("Document missing 'pages'")?;
    let page = pages
        .get_mut(&parsed.page_id)
        .and_then(|v| v.as_object_mut())
        .ok_or_else(|| format!("Page '{}' not found", parsed.page_id))?;

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
    order.push(json!(id));

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    page.insert("modifiedAt".into(), json!(now));
    doc["modifiedAt"] = json!(now);

    ctx.team.save_document(doc)?;

    Ok(ToolOutcome {
        result: json!({
            "id": id,
            "warning": locked_warning,
        }),
        changed_doc_id: Some(parsed.doc_id),
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
        team.save_document(make_doc("doc1", "p1", "Team Doc")).unwrap();
        Fixture { team, local }
    }

    #[test]
    fn list_returns_seeded_doc() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());
        let out = dispatch(&f.ctx(true), "diagrammer.list_documents", &json!({})).unwrap();
        let docs = out.result["documents"].as_array().unwrap();
        assert_eq!(docs.len(), 1);
        assert_eq!(docs[0]["id"], "doc1");
        assert_eq!(docs[0]["source"], "team");
    }

    #[test]
    fn list_unions_team_and_local_when_enabled() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());
        f.local.mirror(make_doc("local1", "p1", "Local Doc")).unwrap();

        let out = dispatch(&f.ctx(true), "diagrammer.list_documents", &json!({})).unwrap();
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
        f.local.mirror(make_doc("local1", "p1", "Local Doc")).unwrap();

        let out = dispatch(&f.ctx(false), "diagrammer.list_documents", &json!({})).unwrap();
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
            "diagrammer.get_document",
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
        f.local.mirror(make_doc("local1", "p1", "Local Doc")).unwrap();

        let out = dispatch(
            &f.ctx(true),
            "diagrammer.get_document",
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
        f.local.mirror(make_doc("local1", "p1", "Local Doc")).unwrap();
        let err = dispatch(
            &f.ctx(false),
            "diagrammer.get_document",
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
            "diagrammer.add_shape",
            &json!({
                "docId": "doc1",
                "pageId": "p1",
                "shape": {"kind": "rectangle", "x": 50, "y": 50, "text": "Hi"}
            }),
        )
        .unwrap();
        let id = out.result["id"].as_str().unwrap().to_string();
        assert_eq!(out.changed_doc_id.as_deref(), Some("doc1"));

        let page = dispatch(
            &f.ctx(true),
            "diagrammer.get_page",
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
        dispatch(&f.ctx(true), "diagrammer.add_shape", &args).unwrap();
        let err = dispatch(&f.ctx(true), "diagrammer.add_shape", &args).unwrap_err();
        assert!(err.contains("already exists"));
    }

    #[test]
    fn add_shape_warns_when_doc_is_locked() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());
        f.team
            .set_lock("doc1", Some("other-user"), Some("Other"))
            .unwrap();
        let out = dispatch(
            &f.ctx(true),
            "diagrammer.add_shape",
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
        f.local.mirror(make_doc("local1", "p1", "Local Doc")).unwrap();
        let err = dispatch(
            &f.ctx(true),
            "diagrammer.add_shape",
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
    fn unknown_tool_errors() {
        let dir = TempDir::new().unwrap();
        let f = seed(&dir.path().to_path_buf());
        let err = dispatch(&f.ctx(true), "diagrammer.nope", &json!({})).unwrap_err();
        assert!(err.contains("Unknown tool"));
    }
}
