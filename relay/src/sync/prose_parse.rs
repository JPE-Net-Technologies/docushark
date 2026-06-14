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
    for n in nodes {
        match n {
            HtmlNode::Text(s) if s.trim().is_empty() => {} // whitespace between blocks
            HtmlNode::Text(_) => {
                // Stray top-level/inline text in block context → wrap in a paragraph.
                if let Some(p) = paragraph_from_inline(std::slice::from_ref(n)) {
                    out.push(p);
                }
            }
            HtmlNode::Element { tag, attrs, children } => {
                if let Some(node) = map_block_element(tag, attrs, children) {
                    out.push(node);
                } else if prose_schema::mark_pm(tag).is_some() || tag == "a" {
                    // Inline mark at block level → wrap in a paragraph.
                    if let Some(p) = paragraph_from_inline(std::slice::from_ref(n)) {
                        out.push(p);
                    }
                } else {
                    // Unknown block tag → unwrap its children (never drop text).
                    out.extend(map_blocks(children));
                }
            }
        }
    }
    out
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
    // Heading h1..h6.
    if tag.len() == 2 && tag.as_bytes()[0] == b'h' && tag.as_bytes()[1].is_ascii_digit() {
        let level = (tag.as_bytes()[1] - b'0').clamp(1, 6);
        return Some(PmNode {
            node_type: "heading".to_string(),
            attrs: vec![("level".to_string(), level.to_string())],
            children: collect_inline(children, &[]),
        });
    }
    match tag {
        "p" => Some(PmNode {
            node_type: "paragraph".to_string(),
            attrs: vec![],
            children: collect_inline(children, &[]),
        }),
        "pre" => Some(PmNode {
            node_type: "codeBlock".to_string(),
            attrs: vec![],
            // Code block content is plain text (unwrap any inner <code>).
            children: vec![PmChild::Text { text: text_content(children), marks: vec![] }],
        }),
        "hr" => Some(PmNode { node_type: "horizontalRule".to_string(), attrs: vec![], children: vec![] }),
        "img" => Some(PmNode {
            node_type: "image".to_string(),
            attrs: attrs
                .iter()
                .filter(|(k, _)| matches!(k.as_str(), "src" | "alt" | "title"))
                .cloned()
                .collect(),
            children: vec![],
        }),
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
    let children = collect_inline(nodes, &[]);
    if children.is_empty() {
        return None;
    }
    Some(PmNode { node_type: "paragraph".to_string(), attrs: vec![], children })
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
}
