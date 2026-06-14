//! Canonical PM-node / mark ↔ HTML-tag mapping, shared by the prose **read**
//! serializer (`prose_html`) and the **write** parser (`prose_parse`) so the
//! two directions can't drift (JP-238 / JP-201).
//!
//! Mirrors the collaborative editor's extension set (`StarterKit` +
//! `sharedProseExtensions` — `src/ui/TiptapEditor.tsx`). The cases that aren't a
//! plain `<tag>` wrapper — heading (`level` attr), `codeBlock` (`<pre><code>`),
//! void nodes (`<br>`/`<hr>`/`<img>`), and the `link` mark (`href`) — are
//! handled explicitly by each side; everything here is the symmetric core.

/// Max prose nesting depth honored by the parser ([`super::prose_parse`]) and
/// the serializer ([`super::prose_html`]) — a safety bound, **not** a content
/// limit (JP-248). Real prose nests <~10 deep; 64 is generous headroom while
/// keeping recursion (and the parser's lenient-close scan) bounded so a
/// pathologically deep input on the public `/mcp` surface can't overflow the
/// stack and abort the process. Beyond it, nesting is truncated (never panics).
pub const MAX_PROSE_DEPTH: usize = 64;

/// Simple block nodes whose PM type ↔ HTML wrapper tag round-trips 1:1 (children
/// recurse inside). Read maps PM→HTML; write maps HTML→PM.
pub const SIMPLE_BLOCKS: &[(&str, &str)] = &[
    ("paragraph", "p"),
    ("bulletList", "ul"),
    ("orderedList", "ol"),
    ("listItem", "li"),
    ("blockquote", "blockquote"),
    ("table", "table"),
    ("tableRow", "tr"),
    ("tableCell", "td"),
    ("tableHeader", "th"),
];

/// Inline marks: PM mark name ↔ HTML tag, in **outer→inner** nesting order so
/// both directions are deterministic for stacked marks. (`link` is handled
/// separately — it carries an `href`.)
pub const MARKS: &[(&str, &str)] = &[
    ("highlight", "mark"),
    ("bold", "strong"),
    ("italic", "em"),
    ("underline", "u"),
    ("strike", "s"),
    ("superscript", "sup"),
    ("subscript", "sub"),
    ("code", "code"),
];

/// HTML wrapper tag for a simple block PM node (read side).
pub fn simple_block_html(pm_type: &str) -> Option<&'static str> {
    SIMPLE_BLOCKS.iter().find(|(p, _)| *p == pm_type).map(|(_, h)| *h)
}

/// PM node type for a simple block HTML tag (write side).
pub fn simple_block_pm(html_tag: &str) -> Option<&'static str> {
    SIMPLE_BLOCKS.iter().find(|(_, h)| *h == html_tag).map(|(p, _)| *p)
}

/// Mark name for an inline HTML tag (write side).
pub fn mark_pm(html_tag: &str) -> Option<&'static str> {
    MARKS.iter().find(|(_, h)| *h == html_tag).map(|(m, _)| *m)
}

/// Custom "prose-helper" leaf nodes — neither plain wrappers nor marks. Each
/// carries its state in `data-*` attributes and is round-tripped **explicitly**
/// by [`super::prose_parse`] (HTML→PM) and [`super::prose_html`] (PM→HTML), the
/// same way the `<img>` void node is. They differ in shape (an inline atom that
/// also carries a rendered-text child, vs. a childless block atom), so the
/// handlers stay hand-written; this table is the single source of truth for the
/// `(pm type, html tag, marker attribute)` triple so the two sides can't drift.
/// Mirrors the editor extensions in `src/tiptap/CitationExtension.ts`.
///
/// `mathInline`/`mathBlock` are the next entries (same mechanism) when math
/// round-trips through the relay.
pub const CUSTOM_PROSE_NODES: &[(&str, &str, &str)] = &[
    ("citationInline", "span", "data-citation"),
    ("bibliography", "div", "data-bibliography"),
    // Document Fields (Phase 3c): an inline `{{name}}` reference. Without this
    // entry the relay's prose serializer would unwrap the span to its text on
    // any reserialize/flatten, dropping the field node. Mirrors
    // `src/tiptap/FieldExtension.ts`.
    ("fieldRef", "span", "data-field"),
];

/// PM node type for an HTML element that matches a custom prose-helper node:
/// its tag must match and `has_attr` must report the marker attribute present.
/// Used by the parser to detect these nodes before its generic
/// unwrap-the-unknown fallback.
pub fn custom_node_pm(html_tag: &str, has_attr: impl Fn(&str) -> bool) -> Option<&'static str> {
    CUSTOM_PROSE_NODES
        .iter()
        .find(|(_, tag, marker)| *tag == html_tag && has_attr(marker))
        .map(|(pm, _, _)| *pm)
}
