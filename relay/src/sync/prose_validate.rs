//! Structural validation + normalization of the prose node tree before it
//! reaches the Y.Doc (JP-328).
//!
//! The relay accepts machine-generated prose (the MCP markdown/HTML path, the
//! editor's `getHTML()`). A structurally-invalid node — an atom carrying
//! children, an unknown node type, a malformed table — serializes back to clean
//! HTML yet crashes the **client** editor's NodeView reconciliation
//! ("Cannot read properties of undefined (reading 'children')"). This pass
//! demotes such nodes into a valid, content-preserving shape and reports a
//! scoped [`ProseFix`] diff for each change, so an MCP author sees exactly what
//! was malformed and how it was healed.
//!
//! **Demotion over elimination.** Unknown wrappers unwrap to their children;
//! malformed tables are rebuilt; illegal children are stripped off atoms; stray
//! inline is wrapped in a paragraph. The only outright drops are nodes with no
//! recoverable content (a src-less image, a table with no rows).

use serde::Serialize;

use super::prose_parse::{PmChild, PmNode};
use super::prose_schema;

/// What was done to heal one node.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FixAction {
    /// Removed entirely (no recoverable content).
    Dropped,
    /// Replaced by its children (unknown wrapper type).
    Unwrapped,
    /// Table rebuilt into `table > tableRow+ > cell+`, rectangular.
    RebuiltTable,
    /// Illegal children stripped off an atom (leaf) node.
    StrippedChildren,
}

/// One healed structural defect, surfaced to the writer + logged on self-heal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProseFix {
    /// Index path to the node, e.g. `0/table` or `2/listItem`.
    pub path: String,
    pub node_type: String,
    pub action: FixAction,
    pub reason: &'static str,
}

/// Node types the client schema (`sharedProseExtensions` + StarterKit + tables)
/// can render. Anything else is unwrapped to its children. Keep in sync with
/// `prose_schema` + the client extension set.
fn is_known_type(t: &str) -> bool {
    matches!(
        t,
        "paragraph"
            | "heading"
            | "bulletList"
            | "orderedList"
            | "listItem"
            | "blockquote"
            | "table"
            | "tableRow"
            | "tableCell"
            | "tableHeader"
            | "codeBlock"
            | "horizontalRule"
            | "image"
            | "bibliography"
            | "callout"
            | "figure"
            | "figcaption"
            | "gallery"
            | "citationInline"
            | "fieldRef"
            | "mathInline"
            | "mathBlock"
            | "hardBreak"
            // JP-432: task lists (checkable items) + embedded canvas-group atom —
            // previously unknown here, so a parsed taskList/embeddedGroup was
            // unwrapped (task lists downgraded to bullet lists, embeds deleted).
            | "taskList"
            | "taskItem"
            | "embeddedGroup"
            // JP-495: an attached file, inline. Unknown here means "unwrap to
            // children", and an atom has none — so omitting it deletes the chip
            // and the only reference to its blob.
            | "fileRef"
    )
}

/// Leaf/atom node types: the client treats these as atoms, so they must carry
/// **no** children. A child here is the exact shape that crashes NodeView
/// reconciliation.
fn is_atom(t: &str) -> bool {
    matches!(
        t,
        "image"
            | "citationInline"
            | "fieldRef"
            | "mathInline"
            | "mathBlock"
            | "horizontalRule"
            | "bibliography"
            | "hardBreak"
            // JP-432: an embedded canvas group is an atom (`atom: true` in
            // `EmbeddedGroupExtension`) — childless, self-describing via `data-*`.
            | "embeddedGroup"
            // JP-495: the file chip is `atom: true`, childless, self-describing.
            | "fileRef"
    )
}

fn attr<'a>(node: &'a PmNode, k: &str) -> Option<&'a str> {
    node.attrs.iter().find(|(key, _)| key == k).map(|(_, v)| v.as_str())
}

fn has_node_children(node: &PmNode) -> bool {
    !node.children.is_empty()
}

fn paragraph(children: Vec<PmChild>) -> PmNode {
    PmNode { node_type: "paragraph".to_string(), attrs: vec![], children }
}

/// Validate + normalize top-level prose blocks, returning the healed tree and a
/// scoped diff of every fix. Idempotent: a healed tree re-sanitizes to itself
/// with no fixes.
pub fn sanitize_blocks(blocks: Vec<PmNode>) -> (Vec<PmNode>, Vec<ProseFix>) {
    let mut fixes = Vec::new();
    let out = sanitize_list(blocks, "", 0, &mut fixes);
    (out, fixes)
}

fn sanitize_list(
    blocks: Vec<PmNode>,
    prefix: &str,
    depth: usize,
    fixes: &mut Vec<ProseFix>,
) -> Vec<PmNode> {
    let mut out = Vec::new();
    for (i, node) in blocks.into_iter().enumerate() {
        let path = format!("{prefix}{i}/{}", node.node_type);
        out.extend(sanitize_node(node, &path, depth, fixes));
    }
    out
}

/// Sanitize one node. Returns 0+ nodes (drop → 0, unwrap → its children, normal → 1).
fn sanitize_node(
    node: PmNode,
    path: &str,
    depth: usize,
    fixes: &mut Vec<ProseFix>,
) -> Vec<PmNode> {
    // Depth bound (defense in depth alongside the parser's): drop the deep tail.
    if depth > prose_schema::MAX_PROSE_DEPTH {
        fixes.push(ProseFix {
            path: path.to_string(),
            node_type: node.node_type.clone(),
            action: FixAction::Dropped,
            reason: "nesting exceeded MAX_PROSE_DEPTH",
        });
        return vec![];
    }

    // Unknown type → unwrap to children (keep text by wrapping it in a paragraph).
    if !is_known_type(&node.node_type) {
        fixes.push(ProseFix {
            path: path.to_string(),
            node_type: node.node_type.clone(),
            action: FixAction::Unwrapped,
            reason: "unknown node type the client schema can't render",
        });
        return unwrap_children(node, path, depth, fixes);
    }

    // Image atom: requires `src`, never carries children.
    if node.node_type == "image" {
        match attr(&node, "src").filter(|s| !s.is_empty()) {
            None => {
                fixes.push(ProseFix {
                    path: path.to_string(),
                    node_type: "image".to_string(),
                    action: FixAction::Dropped,
                    reason: "image has no src (client parses only img[src]; a naked image atom crashes)",
                });
                return vec![];
            }
            Some(_) => {
                return vec![strip_children_if_any(node, path, fixes)];
            }
        }
    }

    // Other atoms: force childless.
    if is_atom(&node.node_type) {
        return vec![strip_children_if_any(node, path, fixes)];
    }

    // Gallery: client content model is `image+`. Any other child makes the
    // client's schema.node() throw during collab adoption — and y-prosemirror
    // DELETES the throwing node from the live Y.Doc, so the gallery (and its
    // images) silently vanish from the document and every later capture.
    // Keep the valid images, move any other content out after the gallery,
    // and unwrap entirely when no image survives.
    if node.node_type == "gallery" {
        return normalize_gallery(node, path, depth, fixes);
    }

    // Figure: strict `image figcaption` on the client — same crash/deletion
    // class as gallery when malformed. No usable image → unwrap to content.
    if node.node_type == "figure" {
        return normalize_figure(node, path, depth, fixes);
    }

    // A figcaption outside a figure has no block group on the client —
    // demote to a paragraph carrying its inline content.
    if node.node_type == "figcaption" {
        fixes.push(ProseFix {
            path: path.to_string(),
            node_type: "figcaption".to_string(),
            action: FixAction::Unwrapped,
            reason: "figcaption is only valid inside a figure",
        });
        return unwrap_children(node, path, depth, fixes);
    }

    // Tables: rebuild into a well-formed, rectangular shape.
    if node.node_type == "table" {
        return normalize_table(node, path, depth, fixes);
    }

    // Container: recurse into block/inline children.
    vec![sanitize_container(node, path, depth, fixes)]
}

/// Strip children off an atom node, recording a fix if any were present.
fn strip_children_if_any(mut node: PmNode, path: &str, fixes: &mut Vec<ProseFix>) -> PmNode {
    if has_node_children(&node) {
        fixes.push(ProseFix {
            path: path.to_string(),
            node_type: node.node_type.clone(),
            action: FixAction::StrippedChildren,
            reason: "atom node must be childless",
        });
        node.children.clear();
    }
    node
}

/// Recurse into a container's children: sanitize block-node children in place,
/// keep text/inline runs as-is.
fn sanitize_container(mut node: PmNode, path: &str, depth: usize, fixes: &mut Vec<ProseFix>) -> PmNode {
    // codeBlock content is plain text — never recurse into it as structure.
    if node.node_type == "codeBlock" {
        return node;
    }
    let mut new_children = Vec::new();
    for child in node.children.into_iter() {
        match child {
            PmChild::Node(n) => {
                let child_path = format!("{path}/{}", n.node_type);
                for sn in sanitize_node(n, &child_path, depth + 1, fixes) {
                    new_children.push(PmChild::Node(sn));
                }
            }
            text @ PmChild::Text { .. } => new_children.push(text),
        }
    }
    node.children = new_children;
    node
}

/// Unwrap an unknown node to its content: sanitized block children, plus any
/// stray inline text gathered into a paragraph (never dropped).
fn unwrap_children(node: PmNode, path: &str, depth: usize, fixes: &mut Vec<ProseFix>) -> Vec<PmNode> {
    let mut blocks = Vec::new();
    let mut inline: Vec<PmChild> = Vec::new();
    for child in node.children.into_iter() {
        match child {
            PmChild::Node(n) => {
                let child_path = format!("{path}/{}", n.node_type);
                blocks.extend(sanitize_node(n, &child_path, depth, fixes));
            }
            t @ PmChild::Text { .. } => inline.push(t),
        }
    }
    let has_text = inline.iter().any(|c| matches!(c, PmChild::Text { text, .. } if !text.trim().is_empty()));
    if has_text {
        blocks.insert(0, paragraph(inline));
    }
    blocks
}

/// Enforce the gallery content model (`image+`): sanitize children, keep the
/// surviving images inside the gallery, emit any other block content AFTER it
/// (demotion over elimination), and unwrap the gallery entirely when no image
/// survives.
fn normalize_gallery(
    node: PmNode,
    path: &str,
    depth: usize,
    fixes: &mut Vec<ProseFix>,
) -> Vec<PmNode> {
    let attrs = node.attrs;
    let mut images: Vec<PmChild> = Vec::new();
    let mut displaced: Vec<PmNode> = Vec::new();
    let mut inline: Vec<PmChild> = Vec::new();
    let mut had_foreign = false;
    for child in node.children.into_iter() {
        match child {
            PmChild::Node(n) => {
                let child_path = format!("{path}/{}", n.node_type);
                for sn in sanitize_node(n, &child_path, depth + 1, fixes) {
                    if sn.node_type == "image" {
                        images.push(PmChild::Node(sn));
                    } else {
                        had_foreign = true;
                        displaced.push(sn);
                    }
                }
            }
            t @ PmChild::Text { .. } => {
                if matches!(&t, PmChild::Text { text, .. } if !text.trim().is_empty()) {
                    had_foreign = true;
                    inline.push(t);
                }
            }
        }
    }
    if !inline.is_empty() {
        displaced.insert(0, paragraph(inline));
    }
    if images.is_empty() {
        fixes.push(ProseFix {
            path: path.to_string(),
            node_type: "gallery".to_string(),
            action: FixAction::Unwrapped,
            reason: "gallery has no usable image (client content model is image+)",
        });
        return displaced;
    }
    if had_foreign {
        fixes.push(ProseFix {
            path: path.to_string(),
            node_type: "gallery".to_string(),
            action: FixAction::StrippedChildren,
            reason: "gallery keeps image children only; other content moved after it",
        });
    }
    let mut out = vec![PmNode { node_type: "gallery".to_string(), attrs, children: images }];
    out.extend(displaced);
    out
}

/// Enforce the figure content model (strict `image figcaption`): first usable
/// image + first figcaption (synthesized empty when absent) stay in the
/// figure; other content moves after it; no usable image → unwrap.
fn normalize_figure(
    node: PmNode,
    path: &str,
    depth: usize,
    fixes: &mut Vec<ProseFix>,
) -> Vec<PmNode> {
    let attrs = node.attrs;
    let mut image: Option<PmNode> = None;
    let mut caption: Option<PmNode> = None;
    let mut displaced: Vec<PmNode> = Vec::new();
    let mut inline: Vec<PmChild> = Vec::new();
    let mut had_foreign = false;
    for child in node.children.into_iter() {
        match child {
            PmChild::Node(n) => {
                if n.node_type == "figcaption" && caption.is_none() {
                    // The caption's children are inline runs; keep as-is (the
                    // standalone-figcaption demotion must not fire here).
                    caption = Some(n);
                    continue;
                }
                let child_path = format!("{path}/{}", n.node_type);
                for sn in sanitize_node(n, &child_path, depth + 1, fixes) {
                    if sn.node_type == "image" && image.is_none() {
                        image = Some(sn);
                    } else {
                        had_foreign = true;
                        displaced.push(sn);
                    }
                }
            }
            t @ PmChild::Text { .. } => {
                if matches!(&t, PmChild::Text { text, .. } if !text.trim().is_empty()) {
                    had_foreign = true;
                    inline.push(t);
                }
            }
        }
    }
    if !inline.is_empty() {
        displaced.insert(0, paragraph(inline));
    }
    let Some(image) = image else {
        fixes.push(ProseFix {
            path: path.to_string(),
            node_type: "figure".to_string(),
            action: FixAction::Unwrapped,
            reason: "figure has no usable image (client content model is image+figcaption)",
        });
        // A caption without its figure degrades to a paragraph of its inline.
        if let Some(cap) = caption {
            let mut blocks = unwrap_children(cap, path, depth, fixes);
            blocks.append(&mut displaced);
            return blocks;
        }
        return displaced;
    };
    if had_foreign {
        fixes.push(ProseFix {
            path: path.to_string(),
            node_type: "figure".to_string(),
            action: FixAction::StrippedChildren,
            reason: "figure keeps image+figcaption only; other content moved after it",
        });
    }
    let figcaption = caption.unwrap_or(PmNode {
        node_type: "figcaption".to_string(),
        attrs: vec![],
        children: vec![],
    });
    let mut out = vec![PmNode {
        node_type: "figure".to_string(),
        attrs,
        children: vec![PmChild::Node(image), PmChild::Node(figcaption)],
    }];
    out.extend(displaced);
    out
}

/// Rebuild a `table` into `table > tableRow+ > (tableCell|tableHeader)+`, with
/// every cell holding `block+` and all rows the same width. A non-row child is
/// dropped; a table with no rows is dropped. Records `RebuiltTable` if anything
/// changed.
fn normalize_table(node: PmNode, path: &str, depth: usize, fixes: &mut Vec<ProseFix>) -> Vec<PmNode> {
    let mut changed = false;
    let mut rows: Vec<PmNode> = Vec::new();

    for child in node.children.into_iter() {
        match child {
            PmChild::Node(n) if n.node_type == "tableRow" => {
                rows.push(normalize_row(n, depth + 1, fixes));
            }
            _ => changed = true, // non-row child in a table → drop
        }
    }

    if rows.is_empty() {
        fixes.push(ProseFix {
            path: path.to_string(),
            node_type: "table".to_string(),
            action: FixAction::Dropped,
            reason: "table has no rows",
        });
        return vec![];
    }

    // Rectangularize span-aware (JP-432 Pillar D): resolve the 2-D grid a
    // merged cell actually occupies before deciding a row is short. The old
    // child-count pad corrupted every merge — a row whose colspan/rowspan
    // cells cover the full width was "short" by count and gained phantom
    // cells (the 2026-07-11 live incident).
    let (_, rectified) = super::prose_table::rectify_table_rows(&mut rows);
    changed |= rectified;

    if changed {
        fixes.push(ProseFix {
            path: path.to_string(),
            node_type: "table".to_string(),
            action: FixAction::RebuiltTable,
            reason: "table was not a rectangular table>row+>cell+ structure",
        });
    }

    vec![PmNode {
        node_type: "table".to_string(),
        attrs: node.attrs,
        children: rows.into_iter().map(PmChild::Node).collect(),
    }]
}

/// Ensure a row holds only cells, each with `block+`. Non-cell content is
/// wrapped into a cell. A cell-less row is left EMPTY here — a row fully
/// covered by rowspans from earlier rows legitimately owns zero cells, and
/// only the span-aware grid pass (`prose_table::rectify_table_rows`) can tell
/// that apart from a genuinely short row needing a pad.
fn normalize_row(node: PmNode, depth: usize, fixes: &mut Vec<ProseFix>) -> PmNode {
    let mut cells: Vec<PmChild> = Vec::new();
    let mut stray_inline: Vec<PmChild> = Vec::new();

    for child in node.children.into_iter() {
        match child {
            PmChild::Node(n) if n.node_type == "tableCell" || n.node_type == "tableHeader" => {
                cells.push(PmChild::Node(normalize_cell(n, depth + 1, fixes)));
            }
            PmChild::Node(n) => {
                // A stray block inside a row → wrap it in a cell (preserve it).
                cells.push(PmChild::Node(PmNode {
                    node_type: "tableCell".to_string(),
                    attrs: vec![],
                    children: vec![PmChild::Node(n)],
                }));
            }
            t @ PmChild::Text { .. } => stray_inline.push(t),
        }
    }
    if !stray_inline.is_empty() {
        cells.push(PmChild::Node(PmNode {
            node_type: "tableCell".to_string(),
            attrs: vec![],
            children: vec![PmChild::Node(paragraph(stray_inline))],
        }));
    }
    PmNode { node_type: node.node_type, attrs: node.attrs, children: cells }
}

/// Ensure a cell holds `block+`: bare inline/text is wrapped in a paragraph; an
/// empty cell gets an empty paragraph; block children are sanitized.
fn normalize_cell(node: PmNode, depth: usize, fixes: &mut Vec<ProseFix>) -> PmNode {
    let mut blocks: Vec<PmChild> = Vec::new();
    let mut inline: Vec<PmChild> = Vec::new();
    let path = "tableCell";

    for child in node.children.into_iter() {
        match child {
            PmChild::Node(n) => {
                // flush any pending inline into a paragraph first (order-preserving)
                if !inline.is_empty() {
                    blocks.push(PmChild::Node(paragraph(std::mem::take(&mut inline))));
                }
                let child_path = format!("{path}/{}", n.node_type);
                for sn in sanitize_node(n, &child_path, depth + 1, fixes) {
                    blocks.push(PmChild::Node(sn));
                }
            }
            t @ PmChild::Text { .. } => inline.push(t),
        }
    }
    if !inline.is_empty() {
        blocks.push(PmChild::Node(paragraph(inline)));
    }
    if blocks.is_empty() {
        blocks.push(PmChild::Node(paragraph(vec![])));
    }
    PmNode { node_type: node.node_type, attrs: node.attrs, children: blocks }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::prose_parse::{PmChild, PmNode};

    fn n(t: &str, children: Vec<PmChild>) -> PmNode {
        PmNode { node_type: t.to_string(), attrs: vec![], children }
    }
    fn na(t: &str, attrs: &[(&str, &str)], children: Vec<PmChild>) -> PmNode {
        PmNode {
            node_type: t.to_string(),
            attrs: attrs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            children,
        }
    }
    fn text(s: &str) -> PmChild {
        PmChild::Text { text: s.to_string(), marks: vec![] }
    }
    fn node(p: PmNode) -> PmChild {
        PmChild::Node(p)
    }

    #[test]
    fn clean_prose_is_unchanged_and_reports_no_fixes() {
        let input = vec![
            n("heading", vec![text("Title")]),
            n("paragraph", vec![text("hello")]),
        ];
        let (out, fixes) = sanitize_blocks(input.clone());
        assert_eq!(out, input);
        assert!(fixes.is_empty());
    }

    #[test]
    fn src_less_image_is_dropped() {
        let input = vec![na("image", &[("alt", "logo")], vec![])];
        let (out, fixes) = sanitize_blocks(input);
        assert!(out.is_empty(), "src-less image dropped");
        assert_eq!(fixes.len(), 1);
        assert_eq!(fixes[0].action, FixAction::Dropped);
        assert_eq!(fixes[0].node_type, "image");
    }

    #[test]
    fn image_with_src_survives() {
        let input = vec![na("image", &[("src", "blob://x")], vec![])];
        let (out, fixes) = sanitize_blocks(input.clone());
        assert_eq!(out, input);
        assert!(fixes.is_empty());
    }

    #[test]
    fn atom_with_children_is_stripped() {
        // A fieldRef (inline atom) that wrongly carries children.
        let input = vec![n("paragraph", vec![node(na(
            "fieldRef",
            &[("name", "X")],
            vec![text("should not be here")],
        ))])];
        let (out, fixes) = sanitize_blocks(input);
        let field = match &out[0].children[0] {
            PmChild::Node(f) => f,
            _ => panic!("expected fieldRef node"),
        };
        assert!(field.children.is_empty(), "atom forced childless");
        assert_eq!(fixes.len(), 1);
        assert_eq!(fixes[0].action, FixAction::StrippedChildren);
    }

    #[test]
    fn unknown_type_is_unwrapped_to_children() {
        let input = vec![n("mysteryBlock", vec![node(n("paragraph", vec![text("kept")]))])];
        let (out, fixes) = sanitize_blocks(input);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].node_type, "paragraph");
        assert_eq!(fixes[0].action, FixAction::Unwrapped);
    }

    #[test]
    fn well_formed_table_is_unchanged() {
        let row = |cells: Vec<PmChild>| node(n("tableRow", cells));
        let cell = |s: &str| node(n("tableCell", vec![node(n("paragraph", vec![text(s)]))]));
        let input = vec![n(
            "table",
            vec![row(vec![cell("a"), cell("b")]), row(vec![cell("1"), cell("2")])],
        )];
        let (out, fixes) = sanitize_blocks(input.clone());
        assert_eq!(out, input, "rectangular table untouched");
        assert!(fixes.is_empty());
    }

    #[test]
    fn ragged_table_is_rectangularized() {
        let cell = |s: &str| node(n("tableCell", vec![node(n("paragraph", vec![text(s)]))]));
        // Row 1 has 2 cells, row 2 has 1 — should pad row 2 to width 2.
        let input = vec![n(
            "table",
            vec![
                node(n("tableRow", vec![cell("a"), cell("b")])),
                node(n("tableRow", vec![cell("1")])),
            ],
        )];
        let (out, fixes) = sanitize_blocks(input);
        let table = &out[0];
        let r2 = match &table.children[1] {
            PmChild::Node(r) => r,
            _ => panic!(),
        };
        assert_eq!(r2.children.len(), 2, "short row padded to table width");
        assert!(fixes.iter().any(|f| f.action == FixAction::RebuiltTable));
    }

    #[test]
    fn table_with_non_row_child_drops_the_stray_and_rebuilds() {
        let cell = |s: &str| node(n("tableCell", vec![node(n("paragraph", vec![text(s)]))]));
        let input = vec![n(
            "table",
            vec![
                node(n("paragraph", vec![text("stray")])), // illegal direct child
                node(n("tableRow", vec![cell("a")])),
            ],
        )];
        let (out, fixes) = sanitize_blocks(input);
        let table = &out[0];
        assert_eq!(table.children.len(), 1, "only the row remains");
        assert!(fixes.iter().any(|f| f.action == FixAction::RebuiltTable));
    }

    #[test]
    fn empty_table_is_dropped() {
        let input = vec![n("table", vec![])];
        let (out, fixes) = sanitize_blocks(input);
        assert!(out.is_empty());
        assert_eq!(fixes[0].action, FixAction::Dropped);
    }

    #[test]
    fn cell_with_bare_text_gets_a_paragraph() {
        // tableCell whose child is raw text (no paragraph) → wrap in a paragraph.
        let input = vec![n(
            "table",
            vec![node(n("tableRow", vec![node(n("tableCell", vec![text("bare")]))]))],
        )];
        let (out, _fixes) = sanitize_blocks(input);
        let cell = match &out[0].children[0] {
            PmChild::Node(r) => match &r.children[0] {
                PmChild::Node(c) => c,
                _ => panic!(),
            },
            _ => panic!(),
        };
        assert_eq!(cell.children.len(), 1);
        assert!(matches!(&cell.children[0], PmChild::Node(p) if p.node_type == "paragraph"));
    }

    #[test]
    fn sanitize_is_idempotent() {
        let cell = |s: &str| node(n("tableCell", vec![node(n("paragraph", vec![text(s)]))]));
        let messy = vec![
            na("image", &[("alt", "x")], vec![]), // dropped
            n("table", vec![node(n("tableRow", vec![cell("a")])), node(n("tableRow", vec![cell("1"), cell("2")]))]),
            n("mystery", vec![node(n("paragraph", vec![text("k")]))]),
        ];
        let (once, _) = sanitize_blocks(messy);
        let (twice, fixes2) = sanitize_blocks(once.clone());
        assert_eq!(once, twice, "second pass is a no-op");
        assert!(fixes2.is_empty(), "healed tree needs no further fixes");
    }
}
