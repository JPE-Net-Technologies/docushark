//! Parse the constrained prose HTML the relay handles into a ProseMirror node
//! model the writer turns into a `prose:<page>` `Y.XmlFragment` (JP-238). The
//! inverse of [`super::prose_html`]; the two share [`super::prose_schema`] so
//! the tag mapping can't drift.
//!
//! The HTML is **machine-generated** — `pulldown-cmark` (the MCP markdown path),
//! the editor's `editor.getHTML()`, and our own `prose_html` output — so this is
//! a small lenient tokenizer for well-formed markup, **not** a spec HTML5
//! parser. Anything it doesn't recognize degrades to its children (text is never
//! dropped), mirroring the read-side degrade.

use super::prose_schema;

/// A ProseMirror node (block): a type name + attrs + ordered children.
#[derive(Debug, Clone, PartialEq)]
pub struct PmNode {
    pub node_type: String,
    pub attrs: Vec<(String, String)>,
    pub children: Vec<PmChild>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum PmChild {
    Node(PmNode),
    /// A run of text carrying its marks (the writer merges consecutive runs into
    /// one `Y.XmlText` with per-range formatting).
    Text { text: String, marks: Vec<PmMark> },
}

#[derive(Debug, Clone, PartialEq)]
pub struct PmMark {
    pub name: String,
    /// `href` for a `link` mark; `None` for the boolean marks.
    pub href: Option<String>,
}

/// Parse prose HTML into top-level PM block nodes.
pub fn html_to_blocks(html: &str) -> Vec<PmNode> {
    let tokens = tokenize(html);
    let tree = build_tree(&tokens);
    map_blocks(&tree)
}

// ---- tokenizer ------------------------------------------------------------

#[derive(Debug)]
enum Token {
    Open(String, Vec<(String, String)>),
    Close(String),
    Void(String, Vec<(String, String)>),
    Text(String),
}

/// Tags that never have children / closing tags in our subset.
fn is_void(tag: &str) -> bool {
    matches!(tag, "br" | "hr" | "img")
}

fn tokenize(html: &str) -> Vec<Token> {
    let bytes = html.as_bytes();
    let mut i = 0;
    let mut tokens = Vec::new();
    while i < bytes.len() {
        if bytes[i] == b'<' {
            // Skip comments `<!-- ... -->` / doctype `<! ... >`.
            if html[i..].starts_with("<!--") {
                if let Some(end) = html[i..].find("-->") {
                    i += end + 3;
                    continue;
                }
                break;
            }
            let Some(close_rel) = html[i..].find('>') else {
                break; // malformed tail — stop
            };
            let inner = &html[i + 1..i + close_rel]; // between < and >
            i += close_rel + 1;
            let inner = inner.trim();
            if let Some(name) = inner.strip_prefix('/') {
                tokens.push(Token::Close(name.trim().to_ascii_lowercase()));
            } else {
                let self_close = inner.ends_with('/');
                let inner = inner.trim_end_matches('/').trim();
                let (tag, attrs) = parse_tag(inner);
                if self_close || is_void(&tag) {
                    tokens.push(Token::Void(tag, attrs));
                } else {
                    tokens.push(Token::Open(tag, attrs));
                }
            }
        } else {
            let next = html[i..].find('<').map(|r| i + r).unwrap_or(bytes.len());
            let raw = &html[i..next];
            tokens.push(Token::Text(decode_entities(raw)));
            i = next;
        }
    }
    tokens
}

/// Split a tag's inner text (`a href="x"`) into a lowercased name + attrs.
fn parse_tag(inner: &str) -> (String, Vec<(String, String)>) {
    let mut chars = inner.char_indices();
    // tag name = up to first whitespace
    let mut name_end = inner.len();
    for (idx, c) in chars.by_ref() {
        if c.is_whitespace() {
            name_end = idx;
            break;
        }
    }
    let tag = inner[..name_end].to_ascii_lowercase();
    let attrs = parse_attrs(&inner[name_end..]);
    (tag, attrs)
}

fn parse_attrs(s: &str) -> Vec<(String, String)> {
    let mut attrs = Vec::new();
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        // skip whitespace
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        // read name
        let start = i;
        while i < b.len() && b[i] != b'=' && !b[i].is_ascii_whitespace() {
            i += 1;
        }
        if i == start {
            break;
        }
        let name = s[start..i].to_ascii_lowercase();
        // skip whitespace before '='
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        if i < b.len() && b[i] == b'=' {
            i += 1;
            while i < b.len() && b[i].is_ascii_whitespace() {
                i += 1;
            }
            let value = if i < b.len() && (b[i] == b'"' || b[i] == b'\'') {
                let quote = b[i];
                i += 1;
                let vstart = i;
                while i < b.len() && b[i] != quote {
                    i += 1;
                }
                let v = &s[vstart..i];
                if i < b.len() {
                    i += 1; // closing quote
                }
                decode_entities(v)
            } else {
                let vstart = i;
                while i < b.len() && !b[i].is_ascii_whitespace() {
                    i += 1;
                }
                decode_entities(&s[vstart..i])
            };
            attrs.push((name, value));
        } else {
            attrs.push((name, String::new())); // bare attribute
        }
    }
    attrs
}

fn decode_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        rest = &rest[amp..];
        let Some(semi) = rest.find(';') else {
            out.push('&');
            rest = &rest[1..];
            continue;
        };
        let entity = &rest[1..semi];
        let decoded = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" | "#39" => Some('\''),
            "nbsp" => Some('\u{00a0}'),
            _ => entity
                .strip_prefix('#')
                .and_then(|n| {
                    if let Some(hex) = n.strip_prefix(['x', 'X']) {
                        u32::from_str_radix(hex, 16).ok()
                    } else {
                        n.parse::<u32>().ok()
                    }
                })
                .and_then(char::from_u32),
        };
        match decoded {
            Some(c) => {
                out.push(c);
                rest = &rest[semi + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

// ---- HTML tree ------------------------------------------------------------

#[derive(Debug)]
enum HtmlNode {
    Element {
        tag: String,
        attrs: Vec<(String, String)>,
        children: Vec<HtmlNode>,
    },
    Text(String),
}

fn build_tree(tokens: &[Token]) -> Vec<HtmlNode> {
    // Stack of (tag, attrs, accumulated children).
    let mut stack: Vec<(String, Vec<(String, String)>, Vec<HtmlNode>)> = Vec::new();
    let mut roots: Vec<HtmlNode> = Vec::new();

    let push_child = |stack: &mut Vec<(String, Vec<(String, String)>, Vec<HtmlNode>)>,
                      roots: &mut Vec<HtmlNode>,
                      node: HtmlNode| {
        match stack.last_mut() {
            Some((_, _, kids)) => kids.push(node),
            None => roots.push(node),
        }
    };

    for tok in tokens {
        match tok {
            Token::Text(s) => push_child(&mut stack, &mut roots, HtmlNode::Text(s.clone())),
            Token::Void(tag, attrs) => push_child(
                &mut stack,
                &mut roots,
                HtmlNode::Element { tag: tag.clone(), attrs: attrs.clone(), children: Vec::new() },
            ),
            Token::Open(tag, attrs) => {
                // Depth guard (JP-248): refuse to nest past MAX_PROSE_DEPTH. This
                // bounds the produced tree — so map_blocks/collect_inline and the
                // downstream build_prose_* recursion can't overflow the stack —
                // and caps the O(stack-depth) `rposition` scan below. Beyond the
                // cap the open is dropped: later text attaches to the current
                // (depth-capped) parent and the unmatched close is ignored
                // leniently, so text is preserved. Real prose never nears 64.
                if stack.len() < prose_schema::MAX_PROSE_DEPTH {
                    stack.push((tag.clone(), attrs.clone(), Vec::new()));
                }
            }
            Token::Close(tag) => {
                // Pop until we match the tag (lenient: tolerate stray/misnested
                // closes by closing the nearest matching open).
                if let Some(pos) = stack.iter().rposition(|(t, _, _)| t == tag) {
                    while stack.len() > pos {
                        let (t, a, kids) = stack.pop().unwrap();
                        push_child(
                            &mut stack,
                            &mut roots,
                            HtmlNode::Element { tag: t, attrs: a, children: kids },
                        );
                    }
                }
                // Unmatched close → ignore.
            }
        }
    }
    // Unclosed opens at EOF → close them in order.
    while let Some((t, a, kids)) = stack.pop() {
        push_child(&mut stack, &mut roots, HtmlNode::Element { tag: t, attrs: a, children: kids });
    }
    roots
}

// ---- HTML tree → PM nodes -------------------------------------------------

fn map_blocks(nodes: &[HtmlNode]) -> Vec<PmNode> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < nodes.len() {
        // Whitespace text *between* blocks must not start an inline run (it would
        // bake a spurious whitespace paragraph). Skip it.
        if matches!(&nodes[i], HtmlNode::Text(s) if s.trim().is_empty()) {
            i += 1;
            continue;
        }
        // A run of consecutive inline siblings (stray text + inline marks / `<a>`)
        // wraps into ONE paragraph — NOT one paragraph per inline node. The schema
        // requires block children inside containers (cells, list items), so loose
        // inline content must be wrapped; wrapping each inline node separately
        // shredded `<td>text <code>x</code> more</td>` into three paragraphs.
        // Grouping the run preserves the inline sequence as a single paragraph.
        if is_inline_member(&nodes[i]) {
            let start = i;
            i += 1;
            while i < nodes.len() && is_inline_member(&nodes[i]) {
                i += 1;
            }
            if let Some(p) = paragraph_from_inline(&nodes[start..i]) {
                out.push(p);
            }
            continue;
        }
        // A block-level element: map it, or unwrap an unknown tag's children
        // (never drop text).
        if let HtmlNode::Element { tag, attrs, children } = &nodes[i] {
            if let Some(node) = map_block_element(tag, attrs, children) {
                out.push(node);
            } else {
                out.extend(map_blocks(children));
            }
        }
        i += 1;
    }
    out
}

/// Is `n` inline content that joins an inline run (wrapped into one paragraph by
/// [`map_blocks`]), versus a block-level element that breaks the run? All text
/// counts — interior whitespace keeps a run together, and an all-whitespace run
/// is dropped by [`paragraph_from_inline`]. Among elements, marks, `<a>`, `<br>`,
/// and the inline atoms (`fieldRef`/`citationInline` spans) are inline;
/// everything else (known block, or unknown→unwrapped) breaks the run.
///
/// This must mirror what [`collect_inline`] recognizes: an inline element that
/// breaks the run is later treated as a block by [`map_blocks`], so `<span>`
/// fails to map and its (empty atom) children are unwrapped to nothing —
/// silently dropping a `{{field}}` or citation inside a table cell / list item
/// (the leading token vanishes, leaving an orphan separator). Keeping the atom
/// in the run lets `collect_inline` build its `fieldRef`/`citationInline` node.
fn is_inline_member(n: &HtmlNode) -> bool {
    match n {
        HtmlNode::Text(_) => true,
        HtmlNode::Element { tag, attrs, .. } => {
            prose_schema::mark_pm(tag).is_some()
                || tag == "a"
                || tag == "br"
                || matches!(
                    prose_schema::custom_node_pm(tag, |m| has_attr(attrs, m)),
                    Some("fieldRef") | Some("citationInline")
                )
        }
    }
}

/// Does `attrs` carry an attribute named `name` (any value, incl. bare/empty)?
fn has_attr(attrs: &[(String, String)], name: &str) -> bool {
    attrs.iter().any(|(k, _)| k == name)
}

/// The value of attribute `name`, if present.
fn get_attr<'a>(attrs: &'a [(String, String)], name: &str) -> Option<&'a str> {
    attrs.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
}

/// Build a `citationInline` PM node from a `<span data-citation …>` element's
/// attributes. Caller guarantees `data-ref-id` is present. `locator`/`label` are
/// emitted only when non-empty, symmetric with the editor's `renderHTML`
/// (`src/tiptap/CitationExtension.ts`). It's an atom — no children.
fn citation_node(attrs: &[(String, String)]) -> PmNode {
    let mut a = vec![("refId".to_string(), get_attr(attrs, "data-ref-id").unwrap_or("").to_string())];
    if let Some(loc) = get_attr(attrs, "data-locator").filter(|s| !s.is_empty()) {
        a.push(("locator".to_string(), loc.to_string()));
    }
    if let Some(label) = get_attr(attrs, "data-label").filter(|s| !s.is_empty()) {
        a.push(("label".to_string(), label.to_string()));
    }
    PmNode { node_type: "citationInline".to_string(), attrs: a, children: vec![] }
}

/// Build a `fieldRef` PM node from a `<span data-field …>` element's attributes
/// (Phase 3c). Caller guarantees `data-name` is present. `label` (the cached
/// resolved value) is emitted only when non-empty, symmetric with the editor's
/// `renderHTML` (`src/tiptap/FieldExtension.ts`). It's an atom — no children.
fn field_node(attrs: &[(String, String)]) -> PmNode {
    let mut a = vec![("name".to_string(), get_attr(attrs, "data-name").unwrap_or("").to_string())];
    if let Some(label) = get_attr(attrs, "data-label").filter(|s| !s.is_empty()) {
        a.push(("label".to_string(), label.to_string()));
    }
    PmNode { node_type: "fieldRef".to_string(), attrs: a, children: vec![] }
}

/// Map a known block-level HTML element to a PM node, else `None`.
fn map_block_element(tag: &str, attrs: &[(String, String)], children: &[HtmlNode]) -> Option<PmNode> {
    // Bibliography block atom (JP-89): `<div data-bibliography data-bib-html=…>`.
    // Childless — the rendered entries live (escaped) in `bibHtml`.
    if prose_schema::custom_node_pm(tag, |m| has_attr(attrs, m)) == Some("bibliography") {
        let mut a = vec![];
        if let Some(b) = get_attr(attrs, "data-bib-html") {
            a.push(("bibHtml".to_string(), b.to_string()));
        }
        return Some(PmNode { node_type: "bibliography".to_string(), attrs: a, children: vec![] });
    }
    // Callout block: `<div data-callout data-variant="…">` with block children.
    // `data-variant` (HTML) ↔ `variant` (PM attr). Content is `block+` on the
    // client, so guarantee at least one block. Mirrors `CalloutExtension`.
    if tag == "div" && has_attr(attrs, "data-callout") {
        let variant = match get_attr(attrs, "data-variant") {
            Some("tip") => "tip",
            Some("warning") => "warning",
            Some("danger") => "danger",
            _ => "note",
        };
        let mut kids: Vec<PmChild> = map_blocks(children).into_iter().map(PmChild::Node).collect();
        if kids.is_empty() {
            kids.push(PmChild::Node(PmNode {
                node_type: "paragraph".to_string(),
                attrs: vec![],
                children: vec![],
            }));
        }
        return Some(PmNode {
            node_type: "callout".to_string(),
            attrs: vec![("variant".to_string(), variant.to_string())],
            children: kids,
        });
    }
    // Gallery block: `<div data-gallery data-layout="…"><div class="gallery-items">
    // <img>…</div></div>` — the images live in the inner wrapper (a render-only
    // div, not a PM node), so we lift them directly under `gallery` (content
    // `image+`). Degrade to unwrap if it carries no usable image. Mirrors
    // `GalleryExtension`.
    if tag == "div" && has_attr(attrs, "data-gallery") {
        let layout = match get_attr(attrs, "data-layout") {
            Some("row") => "row",
            _ => "grid",
        };
        let inner = children
            .iter()
            .find_map(|c| match c {
                HtmlNode::Element { tag: t, attrs: a, children: cc }
                    if t == "div"
                        && get_attr(a, "class")
                            .map_or(false, |c| c.split_whitespace().any(|w| w == "gallery-items")) =>
                {
                    Some(cc.as_slice())
                }
                _ => None,
            })
            .unwrap_or(children);
        let images: Vec<PmChild> = inner
            .iter()
            .filter_map(|c| match c {
                HtmlNode::Element { tag: t, attrs: a, children: cc } if t == "img" => {
                    map_block_element("img", a, cc).map(PmChild::Node)
                }
                _ => None,
            })
            .collect();
        if images.is_empty() {
            return None; // no images → not a valid gallery; fall through to unwrap
        }
        return Some(PmNode {
            node_type: "gallery".to_string(),
            attrs: vec![("layout".to_string(), layout.to_string())],
            children: images,
        });
    }
    // Figure: `<figure><img …><figcaption>…</figcaption></figure>`. The client
    // content model is the strict `image figcaption`, so only emit a `figure`
    // when a usable `<img>` is present, and always pair it with a `figcaption`
    // (synthesized empty if absent) so the node is schema-valid. `figcaption`
    // is emitted *only* here — never as a standalone block — since it has no
    // block group on the client. Mirrors `FigureExtension`.
    if tag == "figure" {
        let mut image: Option<PmNode> = None;
        let mut caption: Option<Vec<PmChild>> = None;
        for c in children {
            if let HtmlNode::Element { tag: t, attrs: a, children: cc } = c {
                if t == "img" && image.is_none() {
                    image = map_block_element("img", a, cc);
                } else if t == "figcaption" && caption.is_none() {
                    caption = Some(collect_block_inline(cc));
                }
            }
        }
        let Some(image) = image else {
            return None; // no usable image → degrade to unwrap
        };
        let figcaption = PmNode {
            node_type: "figcaption".to_string(),
            attrs: vec![],
            children: caption.unwrap_or_default(),
        };
        return Some(PmNode {
            node_type: "figure".to_string(),
            attrs: vec![],
            children: vec![PmChild::Node(image), PmChild::Node(figcaption)],
        });
    }
    // Heading h1..h6.
    if tag.len() == 2 && tag.as_bytes()[0] == b'h' && tag.as_bytes()[1].is_ascii_digit() {
        let level = (tag.as_bytes()[1] - b'0').clamp(1, 6);
        return Some(PmNode {
            node_type: "heading".to_string(),
            attrs: vec![("level".to_string(), level.to_string())],
            children: collect_block_inline(children),
        });
    }
    match tag {
        "p" => Some(PmNode {
            node_type: "paragraph".to_string(),
            attrs: vec![],
            children: collect_block_inline(children),
        }),
        "pre" => Some(PmNode {
            node_type: "codeBlock".to_string(),
            attrs: vec![],
            // Code block content is plain text (unwrap any inner <code>).
            children: vec![PmChild::Text { text: text_content(children), marks: vec![] }],
        }),
        "hr" => Some(PmNode { node_type: "horizontalRule".to_string(), attrs: vec![], children: vec![] }),
        "img" => {
            // The client image node is an atom that parses only `img[src]`
            // (`src/tiptap/ResizableImageExtension.ts`). A src-less <img> seeds a
            // naked `image` atom the client can't reconcile — its desc-tree walk
            // throws "Cannot read properties of undefined (reading 'children')".
            // Drop it (no src ⇒ nothing to render) rather than seed the crash.
            let src = get_attr(attrs, "src").filter(|s| !s.is_empty())?;
            let mut a = vec![("src".to_string(), src.to_string())];
            // Preserve the full image attribute set, not just src/alt/title —
            // dropping width/height/float was the "image resets to inline on MCP
            // edit" half of the bug (the editor re-defaults float to inline).
            for k in ["alt", "title", "width", "height"] {
                if let Some(v) = get_attr(attrs, k).filter(|s| !s.is_empty()) {
                    a.push((k.to_string(), v.to_string()));
                }
            }
            // `data-float` (HTML) ↔ `float` (the PM attr name the editor + the
            // y-prosemirror binding store in the Y.Doc) — the same HTML↔PM name
            // translation citations do (`data-ref-id` ↔ `refId`). Without it the
            // float wouldn't survive the MCP HTML→Y.Doc round-trip.
            if let Some(f) = get_attr(attrs, "data-float").filter(|v| *v == "left" || *v == "right") {
                a.push(("float".to_string(), f.to_string()));
            }
            Some(PmNode { node_type: "image".to_string(), attrs: a, children: vec![] })
        }
        // Block containers — children are blocks (map_blocks wraps stray inline
        // into paragraphs, so a loose `<li>text` still works).
        _ => prose_schema::simple_block_pm(tag).map(|pm| PmNode {
            node_type: pm.to_string(),
            attrs: vec![],
            children: map_blocks(children).into_iter().map(PmChild::Node).collect(),
        }),
    }
}

/// Collect inline content (text + marks, plus `<br>` hard breaks) under the
/// given active marks.
fn collect_inline(nodes: &[HtmlNode], marks: &[PmMark]) -> Vec<PmChild> {
    let mut out = Vec::new();
    for n in nodes {
        match n {
            HtmlNode::Text(s) => out.push(PmChild::Text { text: s.clone(), marks: marks.to_vec() }),
            HtmlNode::Element { tag, attrs, children } => {
                if tag == "br" {
                    out.push(PmChild::Node(PmNode {
                        node_type: "hardBreak".to_string(),
                        attrs: vec![],
                        children: vec![],
                    }));
                } else if tag == "a" {
                    let href = attrs.iter().find(|(k, _)| k == "href").map(|(_, v)| v.clone());
                    let mut m = marks.to_vec();
                    m.push(PmMark { name: "link".to_string(), href });
                    out.extend(collect_inline(children, &m));
                } else if prose_schema::custom_node_pm(tag, |m| has_attr(attrs, m))
                    == Some("citationInline")
                    && get_attr(attrs, "data-ref-id").is_some()
                {
                    // Inline citation atom (JP-89). Self-describing via `data-*`;
                    // the text content is the cached projection, kept in `label`.
                    // Require `data-ref-id` — a refId-less citation is useless, so
                    // fall through to the unwrap below and keep the text instead.
                    out.push(PmChild::Node(citation_node(attrs)));
                } else if prose_schema::custom_node_pm(tag, |m| has_attr(attrs, m))
                    == Some("fieldRef")
                    && get_attr(attrs, "data-name").filter(|s| !s.is_empty()).is_some()
                {
                    // Inline field atom (Phase 3c). Require a non-empty `data-name`
                    // — a nameless field reference is useless, so fall through to
                    // the unwrap below and keep the text instead.
                    out.push(PmChild::Node(field_node(attrs)));
                } else if let Some(mark) = prose_schema::mark_pm(tag) {
                    let mut m = marks.to_vec();
                    m.push(PmMark { name: mark.to_string(), href: None });
                    out.extend(collect_inline(children, &m));
                } else {
                    // Unknown inline tag → unwrap (keep text + current marks).
                    out.extend(collect_inline(children, marks));
                }
            }
        }
    }
    out
}

fn paragraph_from_inline(nodes: &[HtmlNode]) -> Option<PmNode> {
    let children = collect_block_inline(nodes);
    if children.is_empty() {
        return None;
    }
    Some(PmNode { node_type: "paragraph".to_string(), attrs: vec![], children })
}

/// Collect a block's inline content (paragraph / heading / figcaption / loose
/// list-item run) with whitespace normalized the way a browser DOMParser +
/// ProseMirror (`whitespace: "normal"`) would — see [`normalize_inline_ws`].
/// Use this at block boundaries; the recursive [`collect_inline`] calls (marks,
/// links) stay raw so normalization runs once over the whole run.
fn collect_block_inline(nodes: &[HtmlNode]) -> Vec<PmChild> {
    normalize_inline_ws(collect_inline(nodes, &[]))
}

/// Normalize the whitespace of a fully-collected inline run before it reaches
/// the Y.Doc: collapse every run of ASCII whitespace to a single space, and
/// trim it at the block's leading and trailing edge. ProseMirror does this when
/// it parses HTML in the editor, so editor-authored prose is already clean — but
/// the MCP path renders Markdown with pulldown-cmark, which bakes a leading `\n`
/// into each item of a *loose* list (`<li><p>\ntext</p></li>`). Stored verbatim,
/// that newline renders as a stray line break (ProseMirror uses
/// `white-space: pre-wrap`) — the malformed bullets of JP-356. Mirroring the
/// browser's collapse here keeps MCP-written prose identical to editor-written
/// prose. codeBlock content bypasses this entirely (it's built from
/// [`text_content`], not an inline run, so its whitespace stays significant).
///
/// Whitespace adjacent to an inline atom (`fieldRef`/`citationInline`) or a
/// `hardBreak` is interior, not an edge, so a single separating space is kept.
fn normalize_inline_ws(children: Vec<PmChild>) -> Vec<PmChild> {
    // `prev_space` starts true so a leading whitespace run is dropped (block
    // edge); it tracks, across text-node boundaries, whether the last emitted
    // char was a collapsed space, so "foo " + "\n bar" collapses to one space.
    let mut out: Vec<PmChild> = Vec::new();
    let mut prev_space = true;
    for child in children {
        match child {
            PmChild::Text { text, marks } => {
                let mut s = String::new();
                for ch in text.chars() {
                    if ch.is_ascii_whitespace() {
                        if !prev_space {
                            s.push(' ');
                            prev_space = true;
                        }
                    } else {
                        s.push(ch);
                        prev_space = false;
                    }
                }
                if !s.is_empty() {
                    out.push(PmChild::Text { text: s, marks });
                }
            }
            // A `hardBreak` is a block-edge for whitespace — a browser trims the
            // space right after a `<br>`, and pulldown-cmark emits every markdown
            // hard break as `<br />\n`, so reset `prev_space` to drop that newline
            // (keeps MCP hard breaks identical to the editor's). An inline atom
            // (`fieldRef`/`citationInline`) is content, so a single space after it
            // is interior and kept.
            PmChild::Node(n) => {
                prev_space = n.node_type == "hardBreak";
                out.push(PmChild::Node(n));
            }
        }
    }
    // Trailing edge: drop a dangling space left on the final text node.
    while let Some(PmChild::Text { text, .. }) = out.last_mut() {
        if text.ends_with(' ') {
            text.pop();
        }
        match out.last() {
            Some(PmChild::Text { text, .. }) if text.is_empty() => {
                out.pop();
            }
            _ => break,
        }
    }
    out
}

/// Flatten all descendant text (used for code blocks).
fn text_content(nodes: &[HtmlNode]) -> String {
    let mut s = String::new();
    for n in nodes {
        match n {
            HtmlNode::Text(t) => s.push_str(t),
            HtmlNode::Element { children, .. } => s.push_str(&text_content(children)),
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(t: &str) -> PmChild {
        PmChild::Text { text: t.to_string(), marks: vec![] }
    }
    fn marked(t: &str, marks: &[&str]) -> PmChild {
        PmChild::Text {
            text: t.to_string(),
            marks: marks.iter().map(|m| PmMark { name: m.to_string(), href: None }).collect(),
        }
    }

    #[test]
    fn paragraph_with_bold() {
        let b = html_to_blocks("<p>Hello <strong>world</strong></p>");
        assert_eq!(
            b,
            vec![PmNode {
                node_type: "paragraph".into(),
                attrs: vec![],
                children: vec![text("Hello "), marked("world", &["bold"])],
            }]
        );
    }

    #[test]
    fn heading_level_and_entities() {
        let b = html_to_blocks("<h3>A &amp; B &lt;x&gt;</h3>");
        assert_eq!(b[0].node_type, "heading");
        assert_eq!(b[0].attrs, vec![("level".to_string(), "3".to_string())]);
        assert_eq!(b[0].children, vec![text("A & B <x>")]);
    }

    #[test]
    fn link_carries_href() {
        let b = html_to_blocks(r#"<p><a href="https://x.test">go</a></p>"#);
        let PmChild::Text { marks, .. } = &b[0].children[0] else { panic!() };
        assert_eq!(marks[0].name, "link");
        assert_eq!(marks[0].href.as_deref(), Some("https://x.test"));
    }

    #[test]
    fn nested_list() {
        let b = html_to_blocks("<ul><li><p>a</p></li><li><p>b</p></li></ul>");
        assert_eq!(b[0].node_type, "bulletList");
        assert_eq!(b[0].children.len(), 2);
        let PmChild::Node(li) = &b[0].children[0] else { panic!() };
        assert_eq!(li.node_type, "listItem");
        let PmChild::Node(p) = &li.children[0] else { panic!() };
        assert_eq!(p.node_type, "paragraph");
    }

    #[test]
    fn loose_list_item_wraps_text_in_paragraph() {
        let b = html_to_blocks("<ul><li>bare</li></ul>");
        let PmChild::Node(li) = &b[0].children[0] else { panic!() };
        let PmChild::Node(p) = &li.children[0] else { panic!() };
        assert_eq!(p.node_type, "paragraph");
        assert_eq!(p.children, vec![text("bare")]);
    }

    #[test]
    fn code_block_unwraps_inner_code() {
        let b = html_to_blocks("<pre><code>let x = 1;</code></pre>");
        assert_eq!(b[0].node_type, "codeBlock");
        assert_eq!(b[0].children, vec![text("let x = 1;")]);
    }

    #[test]
    fn hard_break_is_a_node() {
        let b = html_to_blocks("<p>a<br>b</p>");
        assert_eq!(b[0].children.len(), 3);
        assert_eq!(b[0].children[0], text("a"));
        let PmChild::Node(br) = &b[0].children[1] else { panic!() };
        assert_eq!(br.node_type, "hardBreak");
        assert_eq!(b[0].children[2], text("b"));
    }

    #[test]
    fn unknown_block_tag_unwraps_children() {
        let b = html_to_blocks("<section><p>kept</p></section>");
        assert_eq!(b.len(), 1);
        assert_eq!(b[0].node_type, "paragraph");
    }

    #[test]
    fn stacked_marks() {
        let b = html_to_blocks("<p><strong><em>x</em></strong></p>");
        let PmChild::Text { marks, .. } = &b[0].children[0] else { panic!() };
        let names: Vec<&str> = marks.iter().map(|m| m.name.as_str()).collect();
        assert_eq!(names, vec!["bold", "italic"]);
    }

    #[test]
    fn pathologically_deep_input_is_bounded_not_overflow() {
        // 100k nested tags would overflow an uncapped recursive parse. The
        // build_tree depth guard bounds the tree (JP-248); this test merely
        // *completing* proves the stack is bounded — and text is preserved.
        let depth = 100_000;
        let html = format!("{}content{}", "<div>".repeat(depth), "</div>".repeat(depth));
        let blocks = html_to_blocks(&html);

        fn text_of(n: &PmNode, out: &mut String) {
            for c in &n.children {
                match c {
                    PmChild::Text { text, .. } => out.push_str(text),
                    PmChild::Node(inner) => text_of(inner, out),
                }
            }
        }
        let mut text = String::new();
        for b in &blocks {
            text_of(b, &mut text);
        }
        assert!(text.contains("content"), "text survives the depth cap");
    }

    // ---- JP-89: custom prose-helper nodes ----

    fn attr<'a>(node: &'a PmNode, k: &str) -> Option<&'a str> {
        node.attrs.iter().find(|(key, _)| key == k).map(|(_, v)| v.as_str())
    }

    #[test]
    fn citation_span_parses_to_inline_node() {
        let b = html_to_blocks(
            r#"<p>see <span data-citation data-ref-id="knuth1997" data-locator="p. 42" data-label="(Knuth, 1997)">(Knuth, 1997)</span></p>"#,
        );
        assert_eq!(b[0].node_type, "paragraph");
        assert_eq!(b[0].children[0], text("see "));
        let PmChild::Node(c) = &b[0].children[1] else { panic!("citation not a node") };
        assert_eq!(c.node_type, "citationInline");
        assert!(c.children.is_empty(), "citation is an atom");
        assert_eq!(attr(c, "refId"), Some("knuth1997"));
        assert_eq!(attr(c, "locator"), Some("p. 42"));
        assert_eq!(attr(c, "label"), Some("(Knuth, 1997)"));
    }

    #[test]
    fn field_span_parses_to_inline_node() {
        let b = html_to_blocks(
            r#"<p>The <span data-field data-name="Company" data-label="Acme Inc.">Acme Inc.</span> agrees</p>"#,
        );
        assert_eq!(b[0].node_type, "paragraph");
        assert_eq!(b[0].children[0], text("The "));
        let PmChild::Node(f) = &b[0].children[1] else { panic!("field not a node") };
        assert_eq!(f.node_type, "fieldRef");
        assert!(f.children.is_empty(), "field is an atom");
        assert_eq!(attr(f, "name"), Some("Company"));
        assert_eq!(attr(f, "label"), Some("Acme Inc."));
    }

    #[test]
    fn field_span_omits_absent_label() {
        // The MCP markdown adapter emits `{{name}}` → <span data-field data-name>
        // with no label; it must still parse and carry the name.
        let b = html_to_blocks(r#"<p><span data-field data-name="Version"></span></p>"#);
        let PmChild::Node(f) = &b[0].children[0] else { panic!() };
        assert_eq!(f.node_type, "fieldRef");
        assert_eq!(attr(f, "name"), Some("Version"));
        assert_eq!(attr(f, "label"), None);
    }

    #[test]
    fn field_span_without_name_degrades_to_text() {
        let b = html_to_blocks(r#"<p>a <span data-field>kept</span> b</p>"#);
        let all: String = b[0]
            .children
            .iter()
            .filter_map(|c| match c {
                PmChild::Text { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(all, "a kept b");
        assert!(b[0].children.iter().all(|c| matches!(c, PmChild::Text { .. })));
    }

    #[test]
    fn citation_omits_absent_optional_attrs() {
        let b = html_to_blocks(r#"<p><span data-citation data-ref-id="a">x</span></p>"#);
        let PmChild::Node(c) = &b[0].children[0] else { panic!() };
        assert_eq!(attr(c, "refId"), Some("a"));
        assert_eq!(attr(c, "locator"), None);
        assert_eq!(attr(c, "label"), None);
    }

    #[test]
    fn citation_without_ref_id_degrades_to_text() {
        // Defensive: a refId-less citation isn't minted — keep the text instead.
        let b = html_to_blocks(r#"<p>before <span data-citation>kept</span> after</p>"#);
        assert_eq!(b[0].node_type, "paragraph");
        let all: String = b[0]
            .children
            .iter()
            .filter_map(|c| match c {
                PmChild::Text { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(all, "before kept after");
        assert!(b[0].children.iter().all(|c| matches!(c, PmChild::Text { .. })));
    }

    #[test]
    fn plain_span_still_unwraps() {
        let b = html_to_blocks(r#"<p>a <span class="x">b</span> c</p>"#);
        let joined: String = b[0]
            .children
            .iter()
            .filter_map(|c| match c {
                PmChild::Text { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(joined, "a b c");
    }

    #[test]
    fn bibliography_div_parses_to_block_node() {
        let b = html_to_blocks(
            r#"<div data-bibliography data-bib-html="&lt;div class=&quot;csl-entry&quot;&gt;Knuth, D.&lt;/div&gt;"></div>"#,
        );
        assert_eq!(b.len(), 1);
        assert_eq!(b[0].node_type, "bibliography");
        assert!(b[0].children.is_empty());
        // Entities in the attribute value are decoded back to real markup.
        assert_eq!(
            attr(&b[0], "bibHtml"),
            Some("<div class=\"csl-entry\">Knuth, D.</div>")
        );
    }

    #[test]
    fn plain_div_still_unwraps_children() {
        let b = html_to_blocks("<div><p>kept</p></div>");
        assert_eq!(b.len(), 1);
        assert_eq!(b[0].node_type, "paragraph");
    }

    // ---- inline-run coalescing (the table/list shredding fix) --------------

    /// The single child paragraph of a block container, panicking otherwise.
    fn only_paragraph(node: &PmNode) -> &PmNode {
        assert_eq!(node.children.len(), 1, "expected ONE paragraph child: {node:?}");
        let PmChild::Node(p) = &node.children[0] else { panic!("not a node: {node:?}") };
        assert_eq!(p.node_type, "paragraph");
        p
    }

    #[test]
    fn inline_run_in_list_item_coalesces_into_one_paragraph() {
        // Regression: loose inline content inside a <li> wraps into a SINGLE
        // paragraph, not one paragraph per inline node (the shredding bug —
        // every <strong>/<code> boundary became its own block).
        let b = html_to_blocks(
            "<ul><li><strong>Term</strong> — text <code>code</code> more</li></ul>",
        );
        assert_eq!(b[0].node_type, "bulletList");
        let PmChild::Node(item) = &b[0].children[0] else { panic!("listItem") };
        assert_eq!(item.node_type, "listItem");
        let p = only_paragraph(item);
        // The inline sequence is preserved inside that one paragraph.
        assert!(p.children.len() >= 3, "inline run preserved: {p:?}");
        assert!(
            matches!(&p.children[0], PmChild::Text { marks, .. } if marks.iter().any(|m| m.name == "bold")),
            "leading bold mark survives: {p:?}"
        );
    }

    #[test]
    fn inline_run_in_table_cell_coalesces_into_one_paragraph() {
        // The exact reproduction: `<td>Next.js 15, <code>standalone</code> output</td>`
        // must yield ONE paragraph, not three split around the <code>.
        let b = html_to_blocks(
            "<table><tr><td>Next.js 15, <code>standalone</code> output</td></tr></table>",
        );
        let PmChild::Node(row) = &b[0].children[0] else { panic!("tableRow") };
        let PmChild::Node(cell) = &row.children[0] else { panic!("tableCell") };
        assert_eq!(cell.node_type, "tableCell");
        only_paragraph(cell);
    }

    #[test]
    fn field_and_citation_spans_survive_in_a_table_cell() {
        // JP-320 Report #3: a `{{field}}` (and a citation) leading a table cell
        // was dropped, leaving an orphan separator — the field/citation span
        // broke the inline run and was then unwrapped as a failed block. The
        // markdown adapter emits `{{Framework}}` → `<span data-field …>`.
        let b = html_to_blocks(concat!(
            "<table><tr>",
            r#"<td><span data-field data-name="Framework"></span>, fast</td>"#,
            r#"<td>see <span data-citation data-ref-id="r1">[1]</span></td>"#,
            "</tr></table>",
        ));
        let PmChild::Node(row) = &b[0].children[0] else { panic!("tableRow") };
        let PmChild::Node(c0) = &row.children[0] else { panic!("tableCell 0") };
        let p0 = only_paragraph(c0);
        // The field atom survives AND the trailing literal is kept (no orphan).
        assert!(
            matches!(&p0.children[0], PmChild::Node(n) if n.node_type == "fieldRef"),
            "leading fieldRef survives in cell: {p0:?}"
        );
        assert!(
            p0.children.iter().any(|c| matches!(c, PmChild::Text { text, .. } if text.contains("fast"))),
            "trailing text kept (no orphan comma): {p0:?}"
        );
        let PmChild::Node(c1) = &row.children[1] else { panic!("tableCell 1") };
        let p1 = only_paragraph(c1);
        assert!(
            p1.children.iter().any(|c| matches!(c, PmChild::Node(n) if n.node_type == "citationInline")),
            "citation survives in cell: {p1:?}"
        );
    }

    #[test]
    fn intentional_multi_paragraph_list_item_is_preserved() {
        // Coalescing only groups LOOSE inline content — explicit <p> blocks in a
        // list item stay distinct (never merge real paragraphs).
        let b = html_to_blocks("<ul><li><p>First.</p><p>Second.</p></li></ul>");
        let PmChild::Node(item) = &b[0].children[0] else { panic!("listItem") };
        assert_eq!(item.children.len(), 2, "two real paragraphs preserved: {item:?}");
    }

    #[test]
    fn whitespace_between_inline_marks_keeps_one_paragraph() {
        // Whitespace between two inline marks must not split the run.
        let b = html_to_blocks("<ul><li><code>a</code> <code>b</code></li></ul>");
        let PmChild::Node(item) = &b[0].children[0] else { panic!("listItem") };
        only_paragraph(item);
    }

    // ---- JP-356: MCP loose-list <p> bakes a leading newline ----------------

    /// The text of a block container's single child paragraph.
    fn list_item_paragraph_text(b: &[PmNode]) -> String {
        let PmChild::Node(item) = &b[0].children[0] else { panic!("listItem: {b:?}") };
        let p = only_paragraph(item);
        let mut s = String::new();
        for c in &p.children {
            if let PmChild::Text { text, .. } = c {
                s.push_str(text);
            }
        }
        s
    }

    #[test]
    fn jp356_loose_list_item_strips_leading_newline() {
        // pulldown-cmark renders a *loose* markdown bullet list with an explicit
        // <p> per item AND a leading newline inside it. The relay parser used to
        // store that "\n" verbatim; ProseMirror (white-space: pre-wrap) then
        // rendered it as a stray line break — malformed bullets.
        let b = html_to_blocks("<ul><li><p>\nYour business name: x</p></li></ul>");
        assert_eq!(list_item_paragraph_text(&b), "Your business name: x");
    }

    #[test]
    fn jp356_pulldown_softwrap_collapses_interior_newline() {
        // The exact HTML pulldown-cmark emits for a soft-wrapped list item (see
        // `mcp::tools::tests::loose_list_markdown_bakes_interior_newline`): the
        // newline lands inside the run, not just at the leading edge. Both the
        // loose-inline form and the explicit-<p> form must collapse it to a
        // single space, matching the browser + ProseMirror.
        let tight = html_to_blocks("<ul>\n<li>a foo\ncontinued line</li>\n</ul>");
        assert_eq!(list_item_paragraph_text(&tight), "a foo continued line");
        let loose = html_to_blocks("<ul>\n<li>\n<p>a foo\ncontinued line</p>\n</li>\n</ul>");
        assert_eq!(list_item_paragraph_text(&loose), "a foo continued line");
    }

    #[test]
    fn jp356_hardbreak_keeps_break_drops_following_newline() {
        // pulldown emits a markdown hard break as `<br />\n`. The intentional
        // <br> must survive, but the formatting newline after it is trimmed (a
        // browser does the same), so the next line gets no stray leading space.
        let b = html_to_blocks("<p>Line one<br>\nline two</p>");
        assert_eq!(b[0].children.len(), 3);
        assert_eq!(b[0].children[0], text("Line one"));
        let PmChild::Node(br) = &b[0].children[1] else { panic!("hardBreak") };
        assert_eq!(br.node_type, "hardBreak");
        assert_eq!(b[0].children[2], text("line two"));
    }

    #[test]
    fn jp356_full_issue_html_has_no_stray_newlines() {
        // The exact shape from the issue: a field span trailing each item.
        let b = html_to_blocks(concat!(
            "<ul>",
            r#"<li><p>Your real name: <span data-field data-name="sender_name"></span></p></li>"#,
            // NOTE: a real newline (\n) after <p>, exactly as pulldown-cmark emits
            // it for a loose list — NOT a literal backslash-n.
            "<li><p>\nYour business name: <span data-field data-name=\"business_name\"></span></p></li>",
            "</ul>",
        ));
        // Walk every text node; none may contain a newline (the line-break that
        // ProseMirror's pre-wrap renders). A trailing space before a trailing
        // field atom is legitimate interior whitespace, so we don't assert edge
        // trimming here — `jp356_loose_list_item_strips_leading_newline` covers
        // the block-edge trim on a single text node.
        fn assert_no_newline(node: &PmNode) {
            for c in &node.children {
                match c {
                    PmChild::Text { text, .. } => {
                        assert!(!text.contains('\n'), "stray newline in text {text:?}");
                    }
                    PmChild::Node(n) => assert_no_newline(n),
                }
            }
        }
        for n in &b {
            assert_no_newline(n);
        }
    }
}
