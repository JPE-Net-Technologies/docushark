//! Canonical PM-node / mark ↔ HTML-tag mapping, shared by the prose **read**
//! serializer (`prose_html`) and the **write** parser (`prose_parse`) so the
//! two directions can't drift (JP-238 / JP-201).
//!
//! Mirrors the collaborative editor's extension set (`StarterKit` +
//! `sharedProseExtensions` — `src/ui/TiptapEditor.tsx`). The cases that aren't a
//! plain `<tag>` wrapper — heading (`level` attr), `codeBlock` (`<pre><code>`),
//! void nodes (`<br>`/`<hr>`/`<img>`), and the `link` mark (`href`) — are
//! handled explicitly by each side; everything here is the symmetric core.

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
