//! Serialize a `prose:<pageId>` `Y.XmlFragment` to HTML — the relay-side analog
//! of the editor's `editor.getHTML()` (JP-201).
//!
//! Editor prose binds to Tiptap's `Collaboration` extension as a
//! `Y.XmlFragment` per page (`prose:<pageId>`), where y-prosemirror encodes:
//! - PM **block nodes** as `Y.XmlElement`s whose tag is the PM node *type name*
//!   (`paragraph`, `heading`, `bulletList`, …) — NOT the HTML tag;
//! - PM **text + marks** as `Y.XmlText` runs, where each mark is a *formatting
//!   attribute* on the run (`bold`, `italic`, `link`, …), surfaced via
//!   [`Text::diff`].
//!
//! We walk that tree and emit HTML. The node/mark tables below mirror the
//! editor's extension set — **the source of truth is the collaborative editor's
//! extensions** (`src/ui/CollaborativeProseEditor.tsx`: history-disabled
//! `StarterKit` + `sharedProseExtensions` in `src/ui/TiptapEditor.tsx` + the
//! `Collaboration` binding). Unknown node types degrade to their children
//! (wrapper dropped, text preserved); unknown marks pass through unwrapped — so
//! schema drift never drops content, it only loses styling on the unmapped bit.
//!
//! This is the **read** direction (MCP reads + the JSON flatten, JP-36). The
//! inverse (HTML → fragment) lives in [`super::prose_parse`] + the builder in
//! [`super`]: it backs MCP prose writes (JP-238) and seeding the live fragments
//! from `richTextPages` on a JSON rebuild ([`super::hydration::json_prose_to_ydoc`]).
//! A binary sidecar is still preferred on rehydrate when present, preserving CRDT
//! identity; the HTML round-trip is the fallback when there's no sidecar.

use std::fmt::Write as _;

use yrs::types::Attrs;
use yrs::{Any, Out, ReadTxn, Text, Xml, XmlElementRef, XmlFragment, XmlFragmentRef, XmlOut, XmlTextRef};

use super::prose_schema;

/// Serialize every top-level block of `frag` to an HTML string.
pub fn fragment_to_html<T: ReadTxn>(frag: &XmlFragmentRef, txn: &T) -> String {
    let mut out = String::new();
    write_children(frag, txn, &mut out, 0);
    out
}

fn write_children<F, T>(frag: &F, txn: &T, out: &mut String, depth: usize)
where
    F: XmlFragment,
    T: ReadTxn,
{
    for node in frag.children(txn) {
        write_node(&node, txn, out, depth);
    }
}

fn write_node<T: ReadTxn>(node: &XmlOut, txn: &T, out: &mut String, depth: usize) {
    match node {
        XmlOut::Element(el) => write_element(el, txn, out, depth),
        XmlOut::Text(t) => write_text(t, txn, out),
        // PM doesn't nest bare fragments, but if one appears, recurse so no
        // content is lost.
        XmlOut::Fragment(f) => write_children(f, txn, out, depth),
    }
}

/// How a PM block node maps to HTML.
enum Block {
    /// Wrap children in `open`…`close`.
    Wrap { open: String, close: &'static str },
    /// Self-closing, no children (`<br>`, `<hr>`, `<img …>`).
    Void(String),
    /// Unknown type: emit children with no wrapper (preserve text).
    Transparent,
}

fn write_element<T: ReadTxn>(el: &XmlElementRef, txn: &T, out: &mut String, depth: usize) {
    // Depth guard (JP-248): a live `prose:` fragment can be built arbitrarily
    // deep via the raw WS sync path (bypassing the parser's cap), so cap the
    // serialize recursion independently. Beyond the cap, stop descending — the
    // deep remainder is omitted; real prose never approaches it.
    if depth >= prose_schema::MAX_PROSE_DEPTH {
        return;
    }
    match block_for(el, txn) {
        Block::Wrap { open, close } => {
            out.push_str(&open);
            write_children(el, txn, out, depth + 1);
            out.push_str(close);
        }
        Block::Void(html) => out.push_str(&html),
        Block::Transparent => write_children(el, txn, out, depth + 1),
    }
}

/// Map a PM node type name → HTML block. Mirrors the collaborative editor's
/// node set (StarterKit + table/task-list/etc.); unmapped types degrade to
/// [`Block::Transparent`].
fn block_for<T: ReadTxn>(el: &XmlElementRef, txn: &T) -> Block {
    let wrap = |tag: &'static str| Block::Wrap {
        open: format!("<{tag}>"),
        close: leading_close(tag),
    };
    match el.tag().as_ref() {
        "paragraph" => wrap("p"),
        "heading" => {
            let level = el
                .get_attribute(txn, "level")
                .and_then(out_to_u8)
                .filter(|l| (1..=6).contains(l))
                .unwrap_or(1);
            Block::Wrap {
                open: format!("<h{level}>"),
                close: match level {
                    1 => "</h1>",
                    2 => "</h2>",
                    3 => "</h3>",
                    4 => "</h4>",
                    5 => "</h5>",
                    _ => "</h6>",
                },
            }
        }
        "codeBlock" => Block::Wrap {
            open: "<pre><code>".to_string(),
            close: "</code></pre>",
        },
        "horizontalRule" => Block::Void("<hr>".to_string()),
        "hardBreak" => Block::Void("<br>".to_string()),
        "image" => Block::Void(image_html(el, txn)),
        // Custom prose-helper leaves (JP-89), self-describing via `data-*` — the
        // void-with-attrs round-trip, like `image`. See `prose_schema`.
        "citationInline" => Block::Void(citation_html(el, txn)),
        "bibliography" => Block::Void(bibliography_html(el, txn)),
        "fieldRef" => Block::Void(field_html(el, txn)),
        // Structural custom blocks (round-trip with the relay parser). `variant`/
        // `layout` are PM attr names → emitted as `data-variant`/`data-layout`.
        "callout" => {
            let variant = match str_attr(el, txn, "variant").as_deref() {
                Some("tip") => "tip",
                Some("warning") => "warning",
                Some("danger") => "danger",
                _ => "note",
            };
            Block::Wrap {
                open: format!("<div data-callout data-variant=\"{variant}\">"),
                close: "</div>",
            }
        }
        "figure" => Block::Wrap {
            open: "<figure>".to_string(),
            close: "</figure>",
        },
        "figcaption" => Block::Wrap {
            open: "<figcaption>".to_string(),
            close: "</figcaption>",
        },
        "gallery" => {
            let layout = match str_attr(el, txn, "layout").as_deref() {
                Some("row") => "row",
                _ => "grid",
            };
            Block::Wrap {
                open: format!("<div data-gallery data-layout=\"{layout}\"><div class=\"gallery-items\">"),
                close: "</div></div>",
            }
        }
        // Task list/item are read-only aliases of ul/li (not in the shared
        // round-trip table — a write never re-emits these PM types).
        "taskList" => wrap("ul"),
        "taskItem" => wrap("li"),
        // Everything else round-trips 1:1 via the shared schema (paragraph,
        // lists, blockquote, tables); unmapped types degrade to their children.
        other => match prose_schema::simple_block_html(other) {
            Some(html) => wrap(html),
            None => Block::Transparent,
        },
    }
}

/// Closing tag for a simple `<tag>` (static lifetime for the common set).
fn leading_close(tag: &str) -> &'static str {
    match tag {
        "p" => "</p>",
        "ul" => "</ul>",
        "ol" => "</ol>",
        "li" => "</li>",
        "blockquote" => "</blockquote>",
        "table" => "</table>",
        "tr" => "</tr>",
        "td" => "</td>",
        "th" => "</th>",
        // Unreachable for the set above; safe fallback.
        _ => "",
    }
}

fn image_html<T: ReadTxn>(el: &XmlElementRef, txn: &T) -> String {
    let attr = |k: &str| {
        el.get_attribute(txn, k)
            .and_then(|o| match o {
                Out::Any(Any::String(s)) => Some(s.to_string()),
                _ => None,
            })
    };
    let mut s = String::from("<img");
    if let Some(src) = attr("src") {
        let _ = write!(s, " src=\"{}\"", escape_attr(&src));
    }
    if let Some(alt) = attr("alt") {
        let _ = write!(s, " alt=\"{}\"", escape_attr(&alt));
    }
    if let Some(title) = attr("title") {
        let _ = write!(s, " title=\"{}\"", escape_attr(&title));
    }
    // Symmetric with the parser (`prose_parse` img): preserve sizing + float so
    // the image survives an MCP HTML round-trip instead of resetting to inline.
    if let Some(width) = attr("width") {
        let _ = write!(s, " width=\"{}\"", escape_attr(&width));
    }
    if let Some(height) = attr("height") {
        let _ = write!(s, " height=\"{}\"", escape_attr(&height));
    }
    // `float` (PM attr) → `data-float` (HTML), the reverse of the parser's
    // translation; mirrors the editor's `renderHTML`.
    if let Some(float) = attr("float") {
        let _ = write!(s, " data-float=\"{}\"", escape_attr(&float));
    }
    s.push('>');
    s
}

/// Read a single string attribute off an element (`None` for absent/non-string).
fn str_attr<T: ReadTxn>(el: &XmlElementRef, txn: &T, key: &str) -> Option<String> {
    el.get_attribute(txn, key).and_then(|o| match o {
        Out::Any(Any::String(s)) => Some(s.to_string()),
        _ => None,
    })
}

/// Serialize a `citationInline` element to `<span data-citation …>label</span>`
/// (JP-89). Attributes are written in a fixed order so output is deterministic;
/// the `label` is also emitted as the text child so static consumers (PDF, MCP
/// `get_prose`, a non-collab open) show the in-text citation. Mirrors the editor's
/// `renderHTML` in `src/tiptap/CitationExtension.ts`.
fn citation_html<T: ReadTxn>(el: &XmlElementRef, txn: &T) -> String {
    let mut s = String::from("<span data-citation");
    if let Some(ref_id) = str_attr(el, txn, "refId") {
        let _ = write!(s, " data-ref-id=\"{}\"", escape_attr(&ref_id));
    }
    if let Some(loc) = str_attr(el, txn, "locator").filter(|v| !v.is_empty()) {
        let _ = write!(s, " data-locator=\"{}\"", escape_attr(&loc));
    }
    let label = str_attr(el, txn, "label").unwrap_or_default();
    if !label.is_empty() {
        let _ = write!(s, " data-label=\"{}\"", escape_attr(&label));
    }
    s.push('>');
    push_escaped(&mut s, &label);
    s.push_str("</span>");
    s
}

/// Serialize a `fieldRef` element to `<span data-field data-name=… [data-label=…]>value</span>`
/// (Phase 3c). The `label` (cached resolved value) is also emitted as the text
/// child so static consumers (PDF, MCP `get_prose`, a non-collab open) show the
/// value. Mirrors the editor's `renderHTML` in `src/tiptap/FieldExtension.ts`.
fn field_html<T: ReadTxn>(el: &XmlElementRef, txn: &T) -> String {
    let mut s = String::from("<span data-field");
    if let Some(name) = str_attr(el, txn, "name") {
        let _ = write!(s, " data-name=\"{}\"", escape_attr(&name));
    }
    let label = str_attr(el, txn, "label").unwrap_or_default();
    if !label.is_empty() {
        let _ = write!(s, " data-label=\"{}\"", escape_attr(&label));
    }
    s.push('>');
    push_escaped(&mut s, &label);
    s.push_str("</span>");
    s
}

/// Serialize a `bibliography` element to `<div data-bibliography data-bib-html=…>`
/// (JP-89). Childless; the rendered entries live (escaped) in `bibHtml`. Emits
/// `data-bib-html` only when non-empty, matching the editor's `renderHTML`.
fn bibliography_html<T: ReadTxn>(el: &XmlElementRef, txn: &T) -> String {
    match str_attr(el, txn, "bibHtml").filter(|v| !v.is_empty()) {
        Some(bib) => format!("<div data-bibliography data-bib-html=\"{}\"></div>", escape_attr(&bib)),
        None => "<div data-bibliography></div>".to_string(),
    }
}

fn write_text<T: ReadTxn>(t: &XmlTextRef, txn: &T, out: &mut String) {
    for run in t.diff(txn, |_| ()) {
        let Out::Any(Any::String(text)) = &run.insert else {
            // Non-text embeds (rare) — skip rather than emit garbage.
            continue;
        };
        let (opens, closes) = inline_marks(run.attributes.as_deref());
        out.push_str(&opens);
        push_escaped(out, text);
        out.push_str(&closes);
    }
}

/// Build (opening tags, closing tags) for a text run's marks, in the shared
/// outer→inner order ([`prose_schema::MARKS`]) so stacked marks nest
/// deterministically. `link` wraps outermost; unmapped marks pass through
/// unwrapped (text preserved).
fn inline_marks(attrs: Option<&Attrs>) -> (String, String) {
    let Some(attrs) = attrs else {
        return (String::new(), String::new());
    };
    let mut opens = String::new();
    let mut closes_rev: Vec<String> = Vec::new();

    // Link outermost so inline emphasis nests inside the anchor.
    if let Some(href) = attrs.get("link").and_then(link_href) {
        let _ = write!(opens, "<a href=\"{}\">", escape_attr(&href));
        closes_rev.push("</a>".to_string());
    }
    for (name, tag) in prose_schema::MARKS {
        if attrs.contains_key(*name) {
            let _ = write!(opens, "<{tag}>");
            closes_rev.push(format!("</{tag}>"));
        }
    }
    let closes: String = closes_rev.into_iter().rev().collect();
    (opens, closes)
}

/// Extract `href` from a `link` mark's value (`{ href, target, … }`), or treat
/// a bare string value as the href.
fn link_href(v: &Any) -> Option<String> {
    match v {
        Any::Map(m) => match m.get("href") {
            Some(Any::String(s)) => Some(s.to_string()),
            _ => None,
        },
        Any::String(s) => Some(s.to_string()),
        _ => None,
    }
}

fn out_to_u8(o: Out) -> Option<u8> {
    match o {
        Out::Any(Any::Number(n)) if n.is_finite() && n >= 0.0 => Some(n as u8),
        Out::Any(Any::BigInt(i)) if (0..=255).contains(&i) => Some(i as u8),
        Out::Any(Any::String(s)) => s.parse().ok(),
        _ => None,
    }
}

fn push_escaped(out: &mut String, s: &str) {
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            c => out.push(c),
        }
    }
}

fn escape_attr(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            c => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Arc;
    use yrs::{Doc, Text, Transact, Xml, XmlElementPrelim, XmlFragment, XmlTextPrelim};

    /// Render a fragment built by `build` (run inside a write txn).
    fn render(build: impl FnOnce(&Doc, &yrs::XmlFragmentRef, &mut yrs::TransactionMut)) -> String {
        let doc = Doc::new();
        let frag = doc.get_or_insert_xml_fragment("prose:p1");
        {
            let mut txn = doc.transact_mut();
            build(&doc, &frag, &mut txn);
        }
        let txn = doc.transact();
        fragment_to_html(&frag, &txn)
    }

    fn mark(name: &str) -> Attrs {
        HashMap::from([(Arc::from(name), Any::Bool(true))])
    }

    #[test]
    fn paragraph_with_inline_marks() {
        let html = render(|_doc, frag, txn| {
            let p = frag.push_back(txn, XmlElementPrelim::empty("paragraph"));
            let t = p.push_back(txn, XmlTextPrelim::new("Hello world"));
            t.format(txn, 6, 5, mark("bold")); // bold "world"
        });
        assert_eq!(html, "<p>Hello <strong>world</strong></p>");
    }

    #[test]
    fn stacked_marks_nest_deterministically() {
        let html = render(|_doc, frag, txn| {
            let p = frag.push_back(txn, XmlElementPrelim::empty("paragraph"));
            let t = p.push_back(txn, XmlTextPrelim::new("x"));
            t.format(
                txn,
                0,
                1,
                HashMap::from([
                    (Arc::from("bold"), Any::Bool(true)),
                    (Arc::from("italic"), Any::Bool(true)),
                ]),
            );
        });
        // Fixed order: bold outside italic, regardless of HashMap iteration.
        assert_eq!(html, "<p><strong><em>x</em></strong></p>");
    }

    #[test]
    fn link_wraps_outermost_with_href() {
        let html = render(|_doc, frag, txn| {
            let p = frag.push_back(txn, XmlElementPrelim::empty("paragraph"));
            let t = p.push_back(txn, XmlTextPrelim::new("click"));
            let link = HashMap::from([(
                Arc::from("link"),
                Any::Map(Arc::new(HashMap::from([(
                    "href".to_string(),
                    Any::String("https://x.test/a?b=1".into()),
                )]))),
            )]);
            t.format(txn, 0, 5, link);
        });
        assert_eq!(html, "<p><a href=\"https://x.test/a?b=1\">click</a></p>");
    }

    #[test]
    fn heading_uses_level_attribute() {
        let html = render(|_doc, frag, txn| {
            let h = frag.push_back(txn, XmlElementPrelim::empty("heading"));
            h.insert_attribute(txn, "level", "3");
            h.push_back(txn, XmlTextPrelim::new("Title"));
        });
        assert_eq!(html, "<h3>Title</h3>");
    }

    #[test]
    fn nested_bullet_list() {
        let html = render(|_doc, frag, txn| {
            let ul = frag.push_back(txn, XmlElementPrelim::empty("bulletList"));
            for label in ["a", "b"] {
                let li = ul.push_back(txn, XmlElementPrelim::empty("listItem"));
                let p = li.push_back(txn, XmlElementPrelim::empty("paragraph"));
                p.push_back(txn, XmlTextPrelim::new(label));
            }
        });
        assert_eq!(html, "<ul><li><p>a</p></li><li><p>b</p></li></ul>");
    }

    #[test]
    fn code_block_wraps_pre_code() {
        let html = render(|_doc, frag, txn| {
            let cb = frag.push_back(txn, XmlElementPrelim::empty("codeBlock"));
            cb.push_back(txn, XmlTextPrelim::new("let x = 1;"));
        });
        assert_eq!(html, "<pre><code>let x = 1;</code></pre>");
    }

    #[test]
    fn void_nodes_self_close() {
        let html = render(|_doc, frag, txn| {
            let p = frag.push_back(txn, XmlElementPrelim::empty("paragraph"));
            p.push_back(txn, XmlTextPrelim::new("a"));
            p.push_back(txn, XmlElementPrelim::empty("hardBreak"));
            p.push_back(txn, XmlTextPrelim::new("b"));
            frag.push_back(txn, XmlElementPrelim::empty("horizontalRule"));
        });
        assert_eq!(html, "<p>a<br>b</p><hr>");
    }

    #[test]
    fn unknown_node_degrades_to_children() {
        let html = render(|_doc, frag, txn| {
            let weird = frag.push_back(txn, XmlElementPrelim::empty("mysteryBlock"));
            let p = weird.push_back(txn, XmlElementPrelim::empty("paragraph"));
            p.push_back(txn, XmlTextPrelim::new("kept"));
        });
        // Wrapper dropped, content preserved.
        assert_eq!(html, "<p>kept</p>");
    }

    #[test]
    fn text_is_html_escaped() {
        let html = render(|_doc, frag, txn| {
            let p = frag.push_back(txn, XmlElementPrelim::empty("paragraph"));
            p.push_back(txn, XmlTextPrelim::new("a < b & c > d"));
        });
        assert_eq!(html, "<p>a &lt; b &amp; c &gt; d</p>");
    }

    #[test]
    fn empty_fragment_is_empty_string() {
        let html = render(|_doc, _frag, _txn| {});
        assert_eq!(html, "");
    }

    #[test]
    fn deeply_nested_fragment_serializes_without_overflow() {
        // A live fragment can be built arbitrarily deep via the raw WS sync path
        // (bypassing the parser cap), so serialize must be depth-bounded too
        // (JP-248). 10k nested blockquotes would overflow an uncapped serialize;
        // this test *completing* is the proof.
        let html = render(|_doc, frag, txn| {
            let mut parent = frag.push_back(txn, XmlElementPrelim::empty("blockquote"));
            for _ in 0..10_000 {
                parent = parent.push_back(txn, XmlElementPrelim::empty("blockquote"));
            }
            parent.push_back(txn, XmlTextPrelim::new("deep"));
        });
        assert!(html.starts_with("<blockquote>"), "bounded output produced: {}", &html[..html.len().min(40)]);
    }

    // ---- JP-89: custom prose-helper nodes ----

    #[test]
    fn citation_inline_serializes_with_attrs_and_label() {
        let html = render(|_doc, frag, txn| {
            let p = frag.push_back(txn, XmlElementPrelim::empty("paragraph"));
            p.push_back(txn, XmlTextPrelim::new("see "));
            let c = p.push_back(txn, XmlElementPrelim::empty("citationInline"));
            c.insert_attribute(txn, "refId", "knuth1997");
            c.insert_attribute(txn, "locator", "p. 42");
            c.insert_attribute(txn, "label", "(Knuth, 1997)");
        });
        assert_eq!(
            html,
            "<p>see <span data-citation data-ref-id=\"knuth1997\" data-locator=\"p. 42\" \
             data-label=\"(Knuth, 1997)\">(Knuth, 1997)</span></p>"
        );
    }

    #[test]
    fn citation_inline_omits_empty_optional_attrs() {
        let html = render(|_doc, frag, txn| {
            let p = frag.push_back(txn, XmlElementPrelim::empty("paragraph"));
            let c = p.push_back(txn, XmlElementPrelim::empty("citationInline"));
            c.insert_attribute(txn, "refId", "a");
            // no locator, no label
        });
        assert_eq!(html, "<p><span data-citation data-ref-id=\"a\"></span></p>");
    }

    #[test]
    fn field_ref_serializes_with_name_and_label() {
        let html = render(|_doc, frag, txn| {
            let p = frag.push_back(txn, XmlElementPrelim::empty("paragraph"));
            p.push_back(txn, XmlTextPrelim::new("The "));
            let f = p.push_back(txn, XmlElementPrelim::empty("fieldRef"));
            f.insert_attribute(txn, "name", "Company");
            f.insert_attribute(txn, "label", "Acme Inc.");
        });
        assert_eq!(
            html,
            "<p>The <span data-field data-name=\"Company\" data-label=\"Acme Inc.\">Acme Inc.</span></p>"
        );
    }

    #[test]
    fn field_ref_omits_empty_label() {
        let html = render(|_doc, frag, txn| {
            let p = frag.push_back(txn, XmlElementPrelim::empty("paragraph"));
            let f = p.push_back(txn, XmlElementPrelim::empty("fieldRef"));
            f.insert_attribute(txn, "name", "Version");
            // no label
        });
        assert_eq!(html, "<p><span data-field data-name=\"Version\"></span></p>");
    }

    #[test]
    fn bibliography_serializes_with_escaped_html() {
        let html = render(|_doc, frag, txn| {
            let b = frag.push_back(txn, XmlElementPrelim::empty("bibliography"));
            b.insert_attribute(txn, "bibHtml", "<div class=\"csl-entry\">Knuth, D.</div>");
        });
        assert_eq!(
            html,
            "<div data-bibliography data-bib-html=\"&lt;div class=&quot;csl-entry&quot;&gt;\
             Knuth, D.&lt;/div&gt;\"></div>"
        );
    }

    #[test]
    fn bibliography_without_html_is_bare() {
        let html = render(|_doc, frag, txn| {
            frag.push_back(txn, XmlElementPrelim::empty("bibliography"));
        });
        assert_eq!(html, "<div data-bibliography></div>");
    }
}
