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
    // Text colour (the `TextStyle` mark + `Color` extension) → `<span style="color">`.
    // Carries a `color` attr (see `MARK_ATTRS`); a *plain* `<span>` never becomes a
    // `textStyle` mark (the parser only creates one when a recognized attr is
    // present) so the empty-span degrade is preserved. (JP-432)
    ("textStyle", "span"),
    ("bold", "strong"),
    ("italic", "em"),
    ("underline", "u"),
    ("strike", "s"),
    ("superscript", "sup"),
    ("subscript", "sub"),
    ("code", "code"),
];

// ---- JP-429: block-attribute passthrough (formatting round-trip) -------------

/// How a PM block attribute is encoded in HTML, so the parser + serializer agree.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum AttrEnc {
    /// A plain HTML attribute of the same name (`scope="col"`).
    Attr,
    /// A property inside the element's `style="…"` (`text-align: center`). The
    /// `&str` is the CSS property name.
    Style(&'static str),
}

/// Per-node-type allowlist of the formatting attributes the editor persists on a
/// **block** node, `(pm_type, pm_attr, html_encoding)`. Without this the relay's
/// HTML round-trip drops them: `prose_parse` discards a simple block's attrs and
/// `prose_html` emits a bare `<td>` — so a table header's colour or a paragraph's
/// alignment is silently lost on any reserialize (and can't be set over MCP).
///
/// The parser reads only these (unknown attrs still dropped); the serializer
/// emits only these. **This table is the single knob** — a future prose feature
/// that stores a block attribute gains fidelity + anchored-edit passthrough by
/// adding a row, never by touching the parse/serialize code.
///
/// Mirrors the editor extensions: `TableCell`/`TableHeader.extend` +
/// `TextAlign.configure({ types: ['heading','paragraph'] })` +
/// StarterKit `orderedList` (`src/ui/TiptapEditor.tsx`).
pub const BLOCK_ATTRS: &[(&str, &str, AttrEnc)] = &[
    // Table cells: background colour + per-column alignment (JP-416) + header scope.
    ("tableCell", "backgroundColor", AttrEnc::Style("background-color")),
    ("tableCell", "align", AttrEnc::Style("text-align")),
    ("tableHeader", "backgroundColor", AttrEnc::Style("background-color")),
    ("tableHeader", "align", AttrEnc::Style("text-align")),
    ("tableHeader", "scope", AttrEnc::Attr),
    // Paragraph / heading alignment (TextAlign extension).
    ("paragraph", "textAlign", AttrEnc::Style("text-align")),
    ("heading", "textAlign", AttrEnc::Style("text-align")),
    // Ordered-list starting number + numbering style (`<ol type="a">`, JP-432).
    ("orderedList", "start", AttrEnc::Attr),
    ("orderedList", "type", AttrEnc::Attr),
    // Durable block ids (JP-432 Pillar C): a plain `id="blk-…"` on the
    // addressable text leaves (`prose_block::TEXT_LEAVES`), giving MCP callers
    // a drift-proof handle and heading links a positional-index-proof target.
    // Passthrough only — nothing in this crate ever mints an id: content
    // reaching `deterministic_seed_update` must stay a pure function of the
    // stored HTML (JP-338), so minting lives at the MCP tool layer / editor /
    // migration. Mirrors the editor's `BlockIdExtension` (`BLOCK_ID_TYPES`).
    ("paragraph", "id", AttrEnc::Attr),
    ("heading", "id", AttrEnc::Attr),
    ("codeBlock", "id", AttrEnc::Attr),
];

/// The allowlisted block attributes for a PM node type (may be empty). Returns a
/// small owned `Vec` (the table is tiny) so callers don't borrow `pm_type`.
pub fn block_attrs_for(pm_type: &str) -> Vec<(&'static str, AttrEnc)> {
    BLOCK_ATTRS
        .iter()
        .filter(|(t, _, _)| *t == pm_type)
        .map(|(_, a, e)| (*a, *e))
        .collect()
}

// ---- JP-432: inline-mark-attribute passthrough (the inline twin of BLOCK_ATTRS) -

/// Per-mark allowlist of the formatting attributes the editor persists on an
/// **inline mark**, `(pm_mark, pm_attr, html_encoding)`. Without this the relay's
/// HTML round-trip drops them: a highlight's colour and a `textStyle`'s text
/// colour serialize as a bare `<mark>`/`<span>` and the parser discards the attr
/// — silently flattening peer-review highlighting and coloured text on any
/// reserialize (and leaving them un-seeable / un-settable over MCP).
///
/// Same discipline as [`BLOCK_ATTRS`] — **this table is the single knob**: a
/// future coloured/attributed mark gains fidelity + anchored-edit passthrough by
/// adding a row, never by touching the parse/serialize code. The value lives on
/// the mark's Y.Doc formatting value (a `Map`), keyed by the **PM attr name**.
///
/// Mirrors the editor marks: `Highlight.configure({ multicolor: true })` (a
/// `color` the editor renders as `data-color` + `background-color`; we emit
/// style-only, which the editor's `parseHTML` reads back via `style.backgroundColor`)
/// + `TextStyle` with the `Color` extension (a `color`) (`src/ui/TiptapEditor.tsx`).
pub const MARK_ATTRS: &[(&str, &str, AttrEnc)] = &[
    ("highlight", "color", AttrEnc::Style("background-color")),
    ("textStyle", "color", AttrEnc::Style("color")),
];

/// The allowlisted attributes for an inline mark (may be empty), mirroring
/// [`block_attrs_for`].
pub fn mark_attrs_for(mark: &str) -> Vec<(&'static str, AttrEnc)> {
    MARK_ATTRS
        .iter()
        .filter(|(m, _, _)| *m == mark)
        .map(|(_, a, e)| (*a, *e))
        .collect()
}

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
/// Mirrors `src/tiptap/CitationExtension.ts`, `src/tiptap/FieldExtension.ts`,
/// and `src/tiptap/LatexExtension.ts`.
pub const CUSTOM_PROSE_NODES: &[(&str, &str, &str)] = &[
    ("citationInline", "span", "data-citation"),
    ("bibliography", "div", "data-bibliography"),
    // Document Fields (Phase 3c): an inline `{{name}}` reference. Without this
    // entry the relay's prose serializer would unwrap the span to its text on
    // any reserialize/flatten, dropping the field node. Mirrors
    // `src/tiptap/FieldExtension.ts`.
    ("fieldRef", "span", "data-field"),
    // LaTeX math: an inline atom (`<span data-math-inline data-latex>`) and a
    // childless block atom (`<div data-math-block data-latex>`). The LaTeX source
    // lives in `data-latex`; both are round-tripped explicitly like the citation/
    // field atoms so a flatten doesn't unwrap them. Mirrors `LatexExtension.ts`.
    ("mathInline", "span", "data-math-inline"),
    ("mathBlock", "div", "data-math-block"),
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

/// CRDT-typed value for a block attribute about to be written into the Y.Doc
/// (JP-326). The HTML parse carries every attr value as a string, but the
/// editor's y-prosemirror binding stores real JS types — so an untyped write
/// makes relay-authored nodes diverge from editor-authored ones in what the
/// browser receives: a string `"false"` `checked` is truthy in JS and renders
/// as a CHECKED task box, and `level`/`start` arrive as `"2"` instead of `2`.
/// (The read side — `attr_value`/`bool_attr`/`out_to_u8` in `prose_html` —
/// already tolerates both forms, so this is write-side-only.)
///
/// Grow this match alongside the registries: Pillar D adds `colspan`/
/// `rowspan`/`colwidth`, Pillar C's `id` stays a string.
pub fn typed_attr_any(node_type: &str, key: &str, value: &str) -> yrs::Any {
    match (node_type, key) {
        // `Any::Number`, NOT `Any::BigInt`: the editor stores JS numbers
        // (float64), and lib0's int64 encoding decodes into a JS `BigInt`
        // (`2n`) — a different type than the editor writes.
        ("heading", "level") | ("orderedList", "start") => value
            .parse::<f64>()
            .map(yrs::Any::Number)
            .unwrap_or_else(|_| yrs::Any::from(value)),
        ("taskItem", "checked") => match value {
            "true" => yrs::Any::Bool(true),
            "false" => yrs::Any::Bool(false),
            _ => yrs::Any::from(value),
        },
        _ => yrs::Any::from(value),
    }
}
