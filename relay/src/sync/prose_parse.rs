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
    /// JP-432: allowlisted formatting attributes ([`prose_schema::MARK_ATTRS`])
    /// the mark carries — a highlight / textStyle `color`. Empty for boolean
    /// marks and for `link` (whose `href` lives above).
    pub attrs: Vec<(String, String)>,
}

/// Parse prose HTML into top-level PM block nodes.
pub fn html_to_blocks(html: &str) -> Vec<PmNode> {
    let tokens = tokenize(html);
    let tree = build_tree(&tokens);
    map_blocks_at(&lift_inline_images(tree), &[], true)
}

// ---- JP-514: what the parse could not represent -----------------------------
//
// Unknown elements degrade to their text, by design. JP-514 makes that loss
// visible: `validate_prose_html` parses with a collector active and reports each
// loss back to the MCP writer as a `fixes` entry. The live write paths parse
// with no collector, so they record nothing and allocate nothing extra.

/// How a piece of input HTML was lost.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LossKind {
    /// An element with no editor equivalent, replaced by its contents.
    Unwrapped,
    /// An element with no editor equivalent and no text, removed.
    Removed,
    /// Text inside an atom that the atom does not keep.
    StrippedAtomText,
}

/// One loss: its kind, the element (`<kbd>`) or atom (`fieldRef`), and where:
/// the top-level block it happened in, in the same `index/type` form the
/// structural fixes use (`3/paragraph`), or empty when no block came of it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseLoss {
    pub kind: LossKind,
    pub what: String,
    pub path: String,
}

thread_local! {
    static LOSSES: std::cell::RefCell<Option<Vec<ParseLoss>>> = const { std::cell::RefCell::new(None) };
    /// The index of the top-level block being built, while collecting.
    static LOSS_BLOCK: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

fn collecting_losses() -> bool {
    LOSSES.with(|cell| cell.borrow().is_some())
}

fn note_loss(kind: LossKind, what: String) {
    LOSSES.with(|cell| {
        if let Some(losses) = cell.borrow_mut().as_mut() {
            // The block index for now; `html_to_blocks_with_losses` turns it
            // into a path once the blocks exist.
            let path = LOSS_BLOCK.with(std::cell::Cell::get).to_string();
            losses.push(ParseLoss { kind, what, path });
        }
    });
}

/// Record an unknown element that was unwrapped, or removed when it held no
/// text.
fn note_element_loss(tag: &str, children: &[HtmlNode]) {
    if collecting_losses() {
        let kind = if text_content(children).trim().is_empty() {
            LossKind::Removed
        } else {
            LossKind::Unwrapped
        };
        note_loss(kind, format!("<{tag}>"));
    }
}

/// Record an atom whose element held text that its carrying attribute does not
/// (the atom keeps the attribute; the text is dropped).
fn note_atom_text(atom: &str, attrs: &[(String, String)], carrier: &str, children: &[HtmlNode]) {
    if collecting_losses() {
        let text = text_content(children);
        let text = text.trim();
        if !text.is_empty() && get_attr(attrs, carrier).map(str::trim) != Some(text) {
            note_loss(LossKind::StrippedAtomText, atom.to_string());
        }
    }
}

/// [`html_to_blocks`], also returning what the parse could not represent, in
/// document order (JP-514).
pub fn html_to_blocks_with_losses(html: &str) -> (Vec<PmNode>, Vec<ParseLoss>) {
    /// Clears the collector even if the parse panics, so a later write path on
    /// this thread never records into a stale one.
    struct Collecting;
    impl Drop for Collecting {
        fn drop(&mut self) {
            LOSSES.with(|cell| *cell.borrow_mut() = None);
        }
    }
    LOSSES.with(|cell| *cell.borrow_mut() = Some(Vec::new()));
    LOSS_BLOCK.with(|cell| cell.set(0));
    let _collecting = Collecting;
    let blocks = html_to_blocks(html);
    let mut losses = LOSSES.with(|cell| cell.borrow_mut().take()).unwrap_or_default();
    for loss in &mut losses {
        let block = loss.path.parse::<usize>().ok().and_then(|i| blocks.get(i).map(|b| (i, b)));
        loss.path = block.map(|(i, b)| format!("{i}/{}", b.node_type)).unwrap_or_default();
    }
    (blocks, losses)
}

// ---- JP-514: the editor's mark parse rules -----------------------------------
//
// Mirrors `@tiptap/extension-{bold,italic,strike,underline,subscript,superscript}`
// as ProseMirror applies them: an element's STYLE rules act on the marks it
// inherits first, then its tag adds its own mark. So `font-weight: 400` clears
// an outer bold, while `<b style="font-weight: 400">` is still bold. Pinned
// against the real editor by `relay/tests/prose-fixtures/mark-synonyms.json`.

/// The last value of CSS property `prop` in an element's `style` attribute,
/// lowercased and without `!important`.
fn style_value(attrs: &[(String, String)], prop: &str) -> Option<String> {
    let style = get_attr(attrs, "style")?;
    style
        .split(';')
        .filter_map(|decl| {
            let (key, value) = decl.split_once(':')?;
            if !key.trim().eq_ignore_ascii_case(prop) {
                return None;
            }
            let value = value.trim().to_ascii_lowercase();
            let value = value.trim_end_matches("!important").trim().to_string();
            (!value.is_empty()).then_some(value)
        })
        .last()
}

/// Tiptap Bold's weight rule: `bold`, `bolder`, or a number from 500 up.
fn is_bold_weight(value: &str) -> bool {
    value == "bold"
        || value == "bolder"
        || (value.len() >= 3
            && matches!(value.as_bytes()[0], b'5'..=b'9')
            && value.bytes().all(|b| b.is_ascii_digit()))
}

/// Add `mark` to `marks`, replacing a mark of the same name (ProseMirror marks
/// of one type exclude each other).
fn set_mark(marks: &mut Vec<PmMark>, mark: PmMark) {
    marks.retain(|m| m.name != mark.name);
    marks.push(mark);
}

fn set_bare_mark(marks: &mut Vec<PmMark>, name: &str) {
    set_mark(marks, PmMark { name: name.to_string(), href: None, attrs: vec![] });
}

/// The marks an element's children inherit once its style is applied.
fn apply_style_marks(marks: &[PmMark], attrs: &[(String, String)]) -> Vec<PmMark> {
    let mut out = marks.to_vec();
    if get_attr(attrs, "style").is_none() {
        return out;
    }
    if let Some(weight) = style_value(attrs, "font-weight") {
        if weight == "400" {
            out.retain(|m| m.name != "bold");
        } else if is_bold_weight(&weight) {
            set_bare_mark(&mut out, "bold");
        }
    }
    match style_value(attrs, "font-style").as_deref() {
        Some("normal") => out.retain(|m| m.name != "italic"),
        Some("italic") => set_bare_mark(&mut out, "italic"),
        _ => {}
    }
    if let Some(decoration) = style_value(attrs, "text-decoration") {
        if decoration.contains("line-through") {
            set_bare_mark(&mut out, "strike");
        }
        if decoration.contains("underline") {
            set_bare_mark(&mut out, "underline");
        }
    }
    match style_value(attrs, "vertical-align").as_deref() {
        Some("sub") => set_bare_mark(&mut out, "subscript"),
        Some("super") => set_bare_mark(&mut out, "superscript"),
        _ => {}
    }
    out
}

/// Whether a mark tag applies its mark. Tiptap refuses `<b>` whose own style
/// says `font-weight: normal` and `<i>` with `font-style: normal` (Google Docs
/// wraps every paste in `<b style="font-weight:normal">`).
fn mark_applies(tag: &str, attrs: &[(String, String)]) -> bool {
    match tag {
        "b" => style_value(attrs, "font-weight").as_deref() != Some("normal"),
        "i" => style_value(attrs, "font-style").as_deref() != Some("normal"),
        _ => true,
    }
}

/// The mark an element's tag applies to its content: a link for `<a>`, a mark
/// tag's own mark unless its style refuses it ([`mark_applies`]), and a
/// `textStyle` for a `<span>` only when it carries a recognized attribute.
fn tag_mark(tag: &str, attrs: &[(String, String)]) -> Option<PmMark> {
    if tag == "a" {
        let href = get_attr(attrs, "href").map(str::to_string);
        return Some(PmMark { name: "link".to_string(), href, attrs: vec![] });
    }
    let mark = prose_schema::mark_pm(tag)?;
    if !mark_applies(tag, attrs) {
        return None;
    }
    let mark_attrs = read_mark_attrs(mark, attrs);
    // A `textStyle` `<span>` with no recognized attr is a plain span: no mark,
    // which keeps the CRDT free of empty textStyle marks.
    if mark == "textStyle" && mark_attrs.is_empty() {
        return None;
    }
    Some(PmMark { name: mark.to_string(), href: None, attrs: mark_attrs })
}

/// The marks an element's content inherits, in ProseMirror's order: the
/// element's style acts on the inherited `marks` first, then its tag adds its
/// own mark. Also says whether the element contributed anything, so an
/// element that changed nothing can be reported as lost.
fn element_marks(tag: &str, attrs: &[(String, String)], marks: &[PmMark]) -> (Vec<PmMark>, bool) {
    let mut inner = apply_style_marks(marks, attrs);
    let styled = inner.as_slice() != marks;
    match tag_mark(tag, attrs) {
        Some(mark) => {
            set_mark(&mut inner, mark);
            (inner, true)
        }
        None => (inner, styled),
    }
}

/// The marks a text run keeps. Tiptap's Code mark excludes every other mark
/// (`excludes: '_'`), so inline code is never also bold or a link (JP-514).
fn text_marks(marks: &[PmMark]) -> Vec<PmMark> {
    match marks.iter().find(|m| m.name == "code") {
        Some(code) => vec![code.clone()],
        None => marks.to_vec(),
    }
}

/// A `<span>` whose attributes carry nothing the editor drops: identity and
/// language attributes, and a style made only of properties the editor parses.
fn span_is_plain(attrs: &[(String, String)]) -> bool {
    attrs
        .iter()
        .all(|(k, _)| matches!(k.as_str(), "class" | "id" | "dir" | "lang" | "title" | "style"))
        && style_is_fully_parsed(attrs)
}

/// The CSS properties the editor reads off an element: the mark styles
/// ([`apply_style_marks`]) and the text colour a `textStyle` carries.
const PARSED_STYLE_PROPS: &[&str] = &["font-weight", "font-style", "text-decoration", "vertical-align", "color"];

/// Whether every declaration in an element's `style` is one the editor parses.
/// Such a style loses nothing when its element is unwrapped, even when it
/// changed nothing: `font-weight: 400` with no bold to clear is honoured, not
/// lost. A property the editor has no mark for (`font-size`) is a loss.
fn style_is_fully_parsed(attrs: &[(String, String)]) -> bool {
    get_attr(attrs, "style").map_or(true, |style| {
        style
            .split(';')
            .filter_map(|decl| decl.split_once(':'))
            .all(|(prop, _)| PARSED_STYLE_PROPS.iter().any(|p| prop.trim().eq_ignore_ascii_case(p)))
    })
}

/// Elements whose unwrapping loses nothing a writer meant, so it is not
/// reported: pure layout containers, a plain `<span>`, and a mark tag that
/// applies no mark.
fn is_silent_container(tag: &str, attrs: &[(String, String)]) -> bool {
    matches!(
        tag,
        "div"
            | "section"
            | "article"
            | "main"
            | "header"
            | "footer"
            | "aside"
            | "nav"
            | "body"
            | "html"
            | "thead"
            | "tbody"
            | "tfoot"
            | "colgroup"
            | "col"
            | "meta"
            | "link"
            | "base"
            | "wbr"
    ) || (tag == "span" && span_is_plain(attrs))
        || (prose_schema::mark_pm(tag).is_some() && !mark_applies(tag, attrs))
}

/// Tags that are block-level: ProseMirror's `blockTags`, plus the table
/// structure and the block image the relay maps itself. Every other element is
/// inline content, as in the editor. A mark tag that contains a block is a
/// container, not inline content: wrapping it into a paragraph would collapse
/// the blocks inside (a Google Docs paste is several paragraphs inside one
/// `<b>`).
fn is_block_tag(tag: &str) -> bool {
    matches!(
        tag,
        "p" | "h1"
            | "h2"
            | "h3"
            | "h4"
            | "h5"
            | "h6"
            | "ul"
            | "ol"
            | "li"
            | "table"
            | "caption"
            | "colgroup"
            | "thead"
            | "tbody"
            | "tfoot"
            | "tr"
            | "td"
            | "th"
            | "blockquote"
            | "pre"
            | "hr"
            | "img"
            | "div"
            | "section"
            | "article"
            | "header"
            | "footer"
            | "main"
            | "aside"
            | "nav"
            | "hgroup"
            | "figure"
            | "figcaption"
            | "dl"
            | "dt"
            | "dd"
            | "details"
            | "summary"
            | "address"
            | "canvas"
            | "fieldset"
            | "form"
            | "output"
            | "html"
            | "body"
    )
}

fn contains_block(nodes: &[HtmlNode]) -> bool {
    nodes.iter().any(|n| match n {
        HtmlNode::Element { tag, children, .. } => is_block_tag(tag) || contains_block(children),
        HtmlNode::Text(_) => false,
    })
}

// ---- JP-468: PM-parity image lift ------------------------------------------
//
// The client's image node is a BLOCK atom whose `parseHTML` is `img[src]` with
// no context restriction (`src/tiptap/ResizableImageExtension.ts`), so
// ProseMirror LIFTS an `<img>` found in inline position out of the enclosing
// text block, splitting it: `<p>a<img>b</p>` → `p(a)`, `image`, `p(b)`. This
// parser's inline collector instead unwraps unknown inline tags to their
// children — for a void tag that meant silent deletion: every MCP markdown
// image (`![alt](src)` → pulldown's `<p><img/></p>`) died there, and the
// surrounding text closed over the gap. Run as a tree pre-pass so the block
// mapping below never meets an inline img.
//
// Scope: only the inline-content text blocks (`p`, `h1..h6`, `figcaption`)
// split. Block containers (cells, list items, quotes, callouts) already route
// stray imgs through `map_blocks`, which maps them as block images; the
// gallery / figure arms own their imgs explicitly and are untouched.

/// Blocks whose PM content model is inline-only — the ones an inline img must
/// split rather than inhabit.
fn is_inline_content_block(tag: &str) -> bool {
    matches!(tag, "p" | "figcaption")
        || (tag.len() == 2 && tag.as_bytes()[0] == b'h' && tag.as_bytes()[1].is_ascii_digit())
}

/// A liftable image: `img` with a non-empty `src` (src-less imgs stay put and
/// are dropped later with the JP-319 rationale — nothing to render).
fn is_liftable_img(node: &HtmlNode) -> bool {
    matches!(node, HtmlNode::Element { tag, attrs, .. }
        if tag == "img" && get_attr(attrs, "src").is_some_and(|s| !s.is_empty()))
}

/// Whether an inline subtree contains a liftable img at any depth.
fn contains_liftable_img(nodes: &[HtmlNode]) -> bool {
    nodes.iter().any(|n| {
        is_liftable_img(n)
            || matches!(n, HtmlNode::Element { children, .. } if contains_liftable_img(children))
    })
}

fn lift_inline_images(nodes: Vec<HtmlNode>) -> Vec<HtmlNode> {
    let mut out = Vec::with_capacity(nodes.len());
    for node in nodes {
        match node {
            HtmlNode::Text(_) => out.push(node),
            HtmlNode::Element { tag, attrs, children } => {
                // Bottom-up: nested block structures transform first.
                let children = lift_inline_images(children);
                if is_inline_content_block(&tag) && contains_liftable_img(&children) {
                    out.extend(split_block_by_images(tag, attrs, children));
                } else {
                    out.push(HtmlNode::Element { tag, attrs, children });
                }
            }
        }
    }
    out
}

/// One segment of a split inline run: contiguous non-img content, or a lifted
/// img on its way to block level.
enum LiftPart {
    Run(Vec<HtmlNode>),
    Img(HtmlNode),
}

/// Partition an inline child list into runs and lifted imgs, splitting inline
/// wrappers (marks, links) along the path — both halves keep the wrapper's
/// tag + attrs, mirroring how PM re-applies marks across a lift:
/// `x<a>link<img>tail</a>z` → run `x<a>link</a>` · img · run `<a>tail</a>z`.
fn split_inline_run(children: Vec<HtmlNode>) -> Vec<LiftPart> {
    let mut parts: Vec<LiftPart> = Vec::new();
    let mut run: Vec<HtmlNode> = Vec::new();
    for child in children {
        if is_liftable_img(&child) {
            if !run.is_empty() {
                parts.push(LiftPart::Run(std::mem::take(&mut run)));
            }
            parts.push(LiftPart::Img(child));
            continue;
        }
        match child {
            HtmlNode::Element { tag, attrs, children } if contains_liftable_img(&children) => {
                for sub in split_inline_run(children) {
                    match sub {
                        LiftPart::Run(sub_run) if !sub_run.is_empty() => {
                            run.push(HtmlNode::Element {
                                tag: tag.clone(),
                                attrs: attrs.clone(),
                                children: sub_run,
                            });
                        }
                        LiftPart::Run(_) => {}
                        LiftPart::Img(img) => {
                            if !run.is_empty() {
                                parts.push(LiftPart::Run(std::mem::take(&mut run)));
                            }
                            parts.push(LiftPart::Img(img));
                        }
                    }
                }
            }
            other => run.push(other),
        }
    }
    if !run.is_empty() {
        parts.push(LiftPart::Run(run));
    }
    parts
}

/// True when a run would produce a visible block half: any element, or any
/// non-whitespace text. A whitespace-only remnant is dropped rather than
/// minting an empty paragraph (`<p><img></p>` yields the image alone).
fn run_has_substance(run: &[HtmlNode]) -> bool {
    run.iter().any(|n| match n {
        HtmlNode::Text(s) => !s.trim().is_empty(),
        HtmlNode::Element { .. } => true,
    })
}

/// Split one inline-content block around its lifted imgs. The FIRST emitted
/// text half keeps the block's attrs (its durable id stays addressable);
/// continuation halves are bare, matching the editor's parse of the same HTML
/// (probed: `<p id=x>a<img>b</p>` → `p(id=x)`, `image`, `p(no id)`).
fn split_block_by_images(
    tag: String,
    attrs: Vec<(String, String)>,
    children: Vec<HtmlNode>,
) -> Vec<HtmlNode> {
    let mut out = Vec::new();
    let mut attrs = Some(attrs);
    for part in split_inline_run(children) {
        match part {
            LiftPart::Run(run) if run_has_substance(&run) => out.push(HtmlNode::Element {
                tag: tag.clone(),
                attrs: attrs.take().unwrap_or_default(),
                children: run,
            }),
            LiftPart::Run(_) => {}
            LiftPart::Img(img) => out.push(img),
        }
    }
    out
}

// ---- tokenizer ------------------------------------------------------------

#[derive(Debug)]
enum Token {
    Open(String, Vec<(String, String)>),
    Close(String),
    Void(String, Vec<(String, String)>),
    Text(String),
}

/// Tags that never have children / closing tags: HTML's void elements.
fn is_void(tag: &str) -> bool {
    // `input` is void — the checkbox chrome the editor's getHTML nests inside a
    // `<li data-type="taskItem">…<input type="checkbox">…` (JP-432). Without this
    // the tokenizer opens it and mis-nests the rest of the item's content. The
    // rest of the set (JP-514) has the same failure: `<meta charset>` leads every
    // Google Docs clipboard payload and swallowed the whole paste, and a `<wbr>`
    // swallowed the rest of its paragraph.
    matches!(
        tag,
        "br" | "hr"
            | "img"
            | "input"
            | "area"
            | "base"
            | "col"
            | "embed"
            | "link"
            | "meta"
            | "param"
            | "source"
            | "track"
            | "wbr"
    )
}

/// Elements whose content the editor drops entirely (ProseMirror's
/// `ignoreTags`): style sheets, scripts and document metadata are not prose.
/// They never break an inline run, as in the editor.
fn is_ignored(tag: &str) -> bool {
    matches!(tag, "head" | "title" | "script" | "style" | "noscript" | "object")
}

/// Drop an ignored element, reporting it unless it is the scaffolding every
/// pasted page carries (`<head>`, `<title>`).
fn note_ignored(tag: &str) {
    if collecting_losses() && !matches!(tag, "head" | "title") {
        note_loss(LossKind::Removed, format!("<{tag}>"));
    }
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
            let Some(close_rel) = find_tag_close(&html[i..]) else {
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

/// Offset of the `>` that closes the tag starting at `s[0] == '<'`, skipping
/// `>` inside quoted attribute values. Browsers escape only `&` and `"` when
/// serializing attributes — `<` and `>` stay raw (an image `alt="a > b"`, a
/// bibliography's `data-bib-html` carrying markup) — so a quote-blind scan
/// truncates the tag mid-attribute and corrupts everything after it.
fn find_tag_close(s: &str) -> Option<usize> {
    let b = s.as_bytes();
    let mut quote: Option<u8> = None;
    for (i, &c) in b.iter().enumerate().skip(1) {
        match quote {
            Some(q) => {
                if c == q {
                    quote = None;
                }
            }
            None => match c {
                b'"' | b'\'' => quote = Some(c),
                b'>' => return Some(i),
                _ => {}
            },
        }
    }
    None
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
                decode_attr_entities(v)
            } else {
                let vstart = i;
                while i < b.len() && !b[i].is_ascii_whitespace() {
                    i += 1;
                }
                decode_attr_entities(&s[vstart..i])
            };
            attrs.push((name, value));
        } else {
            attrs.push((name, String::new())); // bare attribute
        }
    }
    attrs
}

/// Decode character references in **text** content (WHATWG general context).
///
/// This replaced a hand-rolled table that knew six names — `amp`, `lt`, `gt`,
/// `quot`, `apos`/`#39`, `nbsp` — plus numeric refs (JP-497). Every other named
/// entity fell through to a literal `&`, which the serializer then re-escaped to
/// `&amp;`, so `&mdash;` was stored as `&amp;mdash;` and shown to the reader as
/// the visible string `&mdash;`. Nothing reported it: the write returned a clean
/// `{"ok": true}`, and the corruption was only findable by reading the page back.
///
/// It landed almost entirely on agents. A model writing HTML reaches for
/// `&mdash;` and `&aacute;` by reflex because HTML corpora are full of them,
/// while a human typing in the editor produces literal Unicode and never meets
/// this path at all.
///
/// The markdown path was always correct — pulldown-cmark decodes the full
/// CommonMark entity set — so `format:"markdown"`, the default, hid the bug.
/// Two decoders for one contract with nothing asserting they agree is the shape
/// of JP-468/472/473; `markdown_and_html_paths_agree_on_entities` is the guard.
fn decode_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    htmlize::unescape(s).into_owned()
}

/// Decode character references in an **attribute value** (WHATWG attribute
/// context).
///
/// Deliberately not [`decode_entities`]. In attribute context a semicolon-less
/// named entity followed by `=` or an alphanumeric is *not* expanded, which is
/// what keeps `href="…?a=1&sect=2"` a query string instead of turning `&sect`
/// into a section sign. Decoding attributes with general-context rules would
/// silently corrupt URLs — see
/// `attribute_context_preserves_legacy_url_query_strings`.
///
/// With the semicolon present it *is* an entity, in attributes too, exactly as a
/// browser would treat it; that is why a literal ampersand must be written
/// `&amp;` in HTML.
fn decode_attr_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    htmlize::unescape_attribute(s).into_owned()
}

// ---- HTML tree ------------------------------------------------------------

#[derive(Debug, Clone)]
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

/// Map a sequence of HTML nodes to PM blocks. `marks` are the marks inherited
/// from enclosing elements (JP-514): ProseMirror carries a mark tag's mark, and
/// any element's style marks, down into the inline content of the blocks inside
/// it, so `<strong><p>a</p><p>b</p></strong>` is two bold paragraphs.
fn map_blocks(nodes: &[HtmlNode], marks: &[PmMark]) -> Vec<PmNode> {
    map_blocks_at(nodes, marks, false)
}

/// [`map_blocks`]; `top` marks the document's own block list, whose index the
/// loss collector records so a loss can say which block it happened in.
fn map_blocks_at(nodes: &[HtmlNode], marks: &[PmMark], top: bool) -> Vec<PmNode> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < nodes.len() {
        if top {
            LOSS_BLOCK.with(|cell| cell.set(out.len()));
        }
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
            if let Some(p) = paragraph_from_inline(&nodes[start..i], marks) {
                out.push(p);
            }
            continue;
        }
        // A block-level element: map it, or unwrap an unknown tag's children
        // (never drop text).
        if let HtmlNode::Element { tag, attrs, children } = &nodes[i] {
            // ProseMirror order: the element's style acts on the inherited
            // marks first, then its tag adds its own mark.
            if let Some(node) = map_block_element(tag, attrs, children, &apply_style_marks(marks, attrs)) {
                out.push(node);
            } else {
                // Unwrap. A mark tag, link or styled element that holds blocks
                // carries its formatting down into them, so it loses nothing.
                let (inner, contributed) = element_marks(tag, attrs, marks);
                if !contributed && !is_silent_container(tag, attrs) {
                    note_element_loss(tag, children);
                }
                out.extend(map_blocks(children, &inner));
            }
        }
        i += 1;
    }
    out
}

/// Is `n` inline content that joins an inline run (wrapped into one paragraph by
/// [`map_blocks`]), versus a block-level element that breaks the run? All text
/// counts — interior whitespace keeps a run together, and an all-whitespace run
/// is dropped by [`paragraph_from_inline`]. An element is inline unless it is a
/// block tag ([`is_block_tag`]) or holds one, as in the editor: marks, `<a>`,
/// `<br>`, the inline atoms (`fieldRef`/`citationInline` spans), and also an
/// unknown inline element such as `<kbd>`, which [`collect_inline`] unwraps in
/// place (JP-514; it used to break the run, so `<li>Press <kbd>Ctrl</kbd>
/// now</li>` became three paragraphs). Ignored elements (`<script>`) join a
/// run too and contribute nothing.
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
        HtmlNode::Element { tag, children, .. } => {
            is_ignored(tag) || (!is_block_tag(tag) && !contains_block(children))
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

/// JP-429: read the allowlisted block attributes ([`prose_schema::BLOCK_ATTRS`])
/// for `pm_type` off an element's HTML attrs, so formatting the editor stores as
/// node attributes (a cell's `background-color`, a paragraph's `text-align`,
/// `scope`, `start`) survives the HTML→PM parse instead of being dropped. Unknown
/// attributes are still ignored. Style-encoded attrs are pulled out of the
/// element's `style="…"` by CSS property name.
fn read_block_attrs(pm_type: &str, attrs: &[(String, String)]) -> Vec<(String, String)> {
    let style = get_attr(attrs, "style");
    let mut out = Vec::new();
    for (pm_attr, enc) in prose_schema::block_attrs_for(pm_type) {
        let value = match enc {
            prose_schema::AttrEnc::Attr => get_attr(attrs, pm_attr).map(|s| s.to_string()),
            prose_schema::AttrEnc::Style(prop) => style.and_then(|s| style_prop(s, prop)),
        };
        if let Some(v) = value.filter(|v| !v.is_empty()) {
            out.push((pm_attr.to_string(), v));
        }
    }
    out
}

/// JP-432: read the allowlisted mark attributes ([`prose_schema::MARK_ATTRS`])
/// for `mark` off an element's HTML attrs — the inline twin of
/// [`read_block_attrs`], so a highlight's colour / a textStyle's text colour
/// survive the HTML→PM parse instead of being dropped. Unknown attrs are ignored.
fn read_mark_attrs(mark: &str, attrs: &[(String, String)]) -> Vec<(String, String)> {
    let style = get_attr(attrs, "style");
    let mut out = Vec::new();
    for (pm_attr, enc) in prose_schema::mark_attrs_for(mark) {
        let value = match enc {
            prose_schema::AttrEnc::Attr => get_attr(attrs, pm_attr).map(|s| s.to_string()),
            prose_schema::AttrEnc::Style(prop) => style.and_then(|s| style_prop(s, prop)),
        };
        if let Some(v) = value.filter(|v| !v.is_empty()) {
            out.push((pm_attr.to_string(), v));
        }
    }
    out
}

/// Pull one CSS property's value out of a `style="a: 1; b: 2"` string
/// (case-insensitive property name, trimmed value).
fn style_prop(style: &str, prop: &str) -> Option<String> {
    for decl in style.split(';') {
        let mut kv = decl.splitn(2, ':');
        let k = kv.next()?.trim();
        if k.eq_ignore_ascii_case(prop) {
            if let Some(v) = kv.next().map(str::trim).filter(|v| !v.is_empty()) {
                return Some(v.to_string());
            }
        }
    }
    None
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

/// Build a `fileRef` PM node from a `<span data-file-ref …>` element (JP-495).
/// Caller guarantees `data-blob-ref` is non-empty. Only non-empty optional
/// attributes are emitted, symmetric with the editor's `renderHTML`
/// (`src/tiptap/FileRefExtension.ts`) — an attr the editor omits must not come
/// back as an empty string, or a flatten would rewrite the node every time.
///
/// `blobRef` keeps its `blob://<hash>` URI form deliberately: the reference walk
/// only recognizes that grammar inside a string, so storing a bare hash here
/// would make the blob invisible to refcounting and the publish manifest
/// (JP-494). It's an atom — no children.
fn file_ref_node(attrs: &[(String, String)]) -> PmNode {
    let mut a = vec![(
        "blobRef".to_string(),
        get_attr(attrs, "data-blob-ref").unwrap_or("").to_string(),
    )];
    for (data_attr, pm_attr) in [
        ("data-file-name", "fileName"),
        ("data-mime-type", "mimeType"),
        ("data-file-size", "fileSize"),
    ] {
        if let Some(v) = get_attr(attrs, data_attr).filter(|s| !s.is_empty()) {
            a.push((pm_attr.to_string(), v.to_string()));
        }
    }
    PmNode { node_type: "fileRef".to_string(), attrs: a, children: vec![] }
}

/// Build a `mathInline` PM node from a `<span data-math-inline data-latex=…>`
/// element. Caller guarantees `data-latex` is present. The LaTeX source ↔ the
/// `latex` PM attr, symmetric with the editor's `renderHTML`
/// (`src/tiptap/LatexExtension.ts`). It's an atom — no children.
fn math_inline_node(attrs: &[(String, String)]) -> PmNode {
    let latex = get_attr(attrs, "data-latex").unwrap_or("").to_string();
    PmNode { node_type: "mathInline".to_string(), attrs: vec![("latex".to_string(), latex)], children: vec![] }
}

/// Build a childless `mathBlock` PM node from a `<div data-math-block
/// data-latex=…>` element. Caller guarantees `data-latex` is present.
fn math_block_node(attrs: &[(String, String)]) -> PmNode {
    let latex = get_attr(attrs, "data-latex").unwrap_or("").to_string();
    PmNode { node_type: "mathBlock".to_string(), attrs: vec![("latex".to_string(), latex)], children: vec![] }
}

/// Map a known block-level HTML element to a PM node, else `None`.
fn task_item(checked: bool, children: &[HtmlNode], marks: &[PmMark]) -> PmNode {
    PmNode {
        node_type: "taskItem".to_string(),
        attrs: vec![("checked".to_string(), checked.to_string())],
        children: map_blocks(children, marks).into_iter().map(PmChild::Node).collect(),
    }
}

fn is_checkbox(node: &HtmlNode) -> Option<bool> {
    match node {
        HtmlNode::Element { tag, attrs, .. }
            if tag == "input"
                && get_attr(attrs, "type").is_some_and(|t| t.eq_ignore_ascii_case("checkbox")) =>
        {
            Some(has_attr(attrs, "checked"))
        }
        _ => None,
    }
}

/// A task item's content without the editor's checkbox chrome
/// (`<label><input type="checkbox"><span></span></label>`), which is not
/// content and must not be reported as a loss.
fn without_task_chrome(children: &[HtmlNode]) -> Vec<HtmlNode> {
    children
        .iter()
        .filter(|c| {
            !matches!(c, HtmlNode::Element { tag, .. } if tag == "label") && is_checkbox(c).is_none()
        })
        .cloned()
        .collect()
}

/// A GFM task item's checked state and its content without the checkbox, or
/// `None` unless the checkbox leads the item: directly in a tight list
/// (`<li><input type="checkbox"> a`), or inside the item's first paragraph in
/// a loose one (`<li><p><input type="checkbox"> a</p>`), which is how
/// pulldown-cmark renders `- [x] a` items separated by blank lines.
fn gfm_task_item(li: &[HtmlNode]) -> Option<(bool, Vec<HtmlNode>)> {
    let first = li.iter().position(|n| !matches!(n, HtmlNode::Text(t) if t.trim().is_empty()))?;
    if let Some(checked) = is_checkbox(&li[first]) {
        let rest = li.iter().enumerate().filter(|(i, _)| *i != first).map(|(_, n)| n.clone()).collect();
        return Some((checked, rest));
    }
    match &li[first] {
        HtmlNode::Element { tag, attrs, children } if tag == "p" => {
            let (checked, inner) = gfm_task_item(children)?;
            let mut rest = li.to_vec();
            rest[first] = HtmlNode::Element { tag: tag.clone(), attrs: attrs.clone(), children: inner };
            Some((checked, rest))
        }
        _ => None,
    }
}

/// The task items of a GFM task list, or `None` unless every `<li>` starts
/// with a checkbox ([`gfm_task_item`]).
fn gfm_task_items(children: &[HtmlNode], marks: &[PmMark]) -> Option<Vec<PmChild>> {
    let mut items = Vec::new();
    for child in children {
        match child {
            HtmlNode::Text(t) if t.trim().is_empty() => continue,
            HtmlNode::Element { tag, attrs, children: li } if tag == "li" => {
                let (checked, rest) = gfm_task_item(li)?;
                items.push(PmChild::Node(task_item(checked, &rest, &apply_style_marks(marks, attrs))));
            }
            _ => return None,
        }
    }
    (!items.is_empty()).then_some(items)
}

/// `marks` are the marks the element's inline content inherits, its own style
/// already applied (see [`map_blocks`]).
fn map_block_element(
    tag: &str,
    attrs: &[(String, String)],
    children: &[HtmlNode],
    marks: &[PmMark],
) -> Option<PmNode> {
    // Math block atom: `<div data-math-block data-latex=…>`. Childless — the
    // LaTeX source lives in `data-latex`. A latex-less block is useless, so let
    // it fall through to the generic unwrap (keeping any text) instead.
    if prose_schema::custom_node_pm(tag, |m| has_attr(attrs, m)) == Some("mathBlock")
        && has_attr(attrs, "data-latex")
    {
        return Some(math_block_node(attrs));
    }
    // Bibliography block atom (JP-89): `<div data-bibliography data-bib-html=…>`.
    // Childless — the rendered entries live (escaped) in `bibHtml`.
    if prose_schema::custom_node_pm(tag, |m| has_attr(attrs, m)) == Some("bibliography") {
        let mut a = vec![];
        if let Some(b) = get_attr(attrs, "data-bib-html") {
            a.push(("bibHtml".to_string(), b.to_string()));
        }
        // `scope` (JP-432): 'cited' (default, no attr) vs 'all'. Mirrors
        // `CitationExtension` bibliography addAttributes.
        if get_attr(attrs, "data-scope") == Some("all") {
            a.push(("scope".to_string(), "all".to_string()));
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
        let mut kids: Vec<PmChild> = map_blocks(children, marks).into_iter().map(PmChild::Node).collect();
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
                    map_block_element("img", a, cc, &[]).map(PmChild::Node)
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
    // Embedded canvas group (JP-432): `<div data-type="embedded-group"
    // data-group-id data-group-name>` — an atom (`atom: true`), no children;
    // `cachedImageUrl` is runtime-only and never serialized. Without this the
    // node had no relay handler and was deleted on read. Mirrors
    // `EmbeddedGroupExtension`.
    if tag == "div" && get_attr(attrs, "data-type") == Some("embedded-group") {
        let mut a = vec![];
        if let Some(id) = get_attr(attrs, "data-group-id").filter(|s| !s.is_empty()) {
            a.push(("groupId".to_string(), id.to_string()));
        }
        if let Some(name) = get_attr(attrs, "data-group-name").filter(|s| !s.is_empty()) {
            a.push(("groupName".to_string(), name.to_string()));
        }
        return Some(PmNode { node_type: "embeddedGroup".to_string(), attrs: a, children: vec![] });
    }
    // Task list (JP-432): `<ul data-type="taskList">`. Detected before the generic
    // `ul`→`bulletList` mapping, or a checkable list silently degrades to bullets.
    if tag == "ul" && get_attr(attrs, "data-type") == Some("taskList") {
        return Some(PmNode {
            node_type: "taskList".to_string(),
            attrs: vec![],
            children: map_blocks(children, marks).into_iter().map(PmChild::Node).collect(),
        });
    }
    // Task item (JP-432): `<li data-type="taskItem" data-checked>`. The editor's
    // getHTML wraps the content in checkbox chrome (`<label><input>…</label>
    // <div>content</div>`); `input` is void and label/div unwrap (`map_blocks`),
    // so the real content is recovered. `data-checked` is `""`/`"true"` when
    // checked (mirrors TaskItem.parseHTML).
    if tag == "li" && get_attr(attrs, "data-type") == Some("taskItem") {
        let checked = matches!(get_attr(attrs, "data-checked"), Some("true") | Some(""));
        return Some(task_item(checked, &without_task_chrome(children), marks));
    }
    // JP-514: a GFM / Markdown task list — a `<ul>` whose every item starts
    // with `<input type="checkbox">`, which is how pulldown-cmark renders
    // `- [x]`. The editor parses only its own `data-type` form (above), so
    // without this the checked state was silently lost. Deliberately beyond
    // editor parity: the intent is unambiguous and the result is the editor's
    // own node.
    if tag == "ul" {
        if let Some(items) = gfm_task_items(children, marks) {
            return Some(PmNode { node_type: "taskList".to_string(), attrs: vec![], children: items });
        }
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
                    image = map_block_element("img", a, cc, &[]);
                } else if t == "figcaption" && caption.is_none() {
                    caption = Some(collect_block_inline(cc, &apply_style_marks(marks, a)));
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
        let mut a = vec![("level".to_string(), level.to_string())];
        a.extend(read_block_attrs("heading", attrs)); // JP-429: textAlign
        return Some(PmNode {
            node_type: "heading".to_string(),
            attrs: a,
            children: collect_block_inline(children, marks),
        });
    }
    match tag {
        "p" => Some(PmNode {
            node_type: "paragraph".to_string(),
            attrs: read_block_attrs("paragraph", attrs), // JP-429: textAlign
            children: collect_block_inline(children, marks),
        }),
        "pre" => {
            // Code block content is plain text (unwrap any inner <code>). The
            // language (JP-432) lives on the inner `<code class="language-…">`
            // (CodeBlockLowlight) — read it off the first child code element.
            let language = children.iter().find_map(|c| match c {
                HtmlNode::Element { tag: t, attrs: a, .. } if t == "code" => get_attr(a, "class")
                    .and_then(|cls| cls.split_whitespace().find_map(|w| w.strip_prefix("language-")))
                    .filter(|l| !l.is_empty())
                    .map(str::to_string),
                _ => None,
            });
            let mut a = match language {
                Some(l) => vec![("language".to_string(), l)],
                None => vec![],
            };
            a.extend(read_block_attrs("codeBlock", attrs)); // JP-432 Pillar C: id
            Some(PmNode {
                node_type: "codeBlock".to_string(),
                attrs: a,
                children: vec![PmChild::Text { text: text_content(children), marks: vec![] }],
            })
        }
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
        // into paragraphs, so a loose `<li>text` still works). JP-429: carry the
        // allowlisted block attrs (cell background/align/scope, ordered-list start).
        _ => prose_schema::simple_block_pm(tag).map(|pm| PmNode {
            node_type: pm.to_string(),
            attrs: read_block_attrs(pm, attrs),
            children: map_blocks(children, marks).into_iter().map(PmChild::Node).collect(),
        }),
    }
}

/// Collect inline content (text + marks, plus `<br>` hard breaks) under the
/// given active marks.
fn collect_inline(nodes: &[HtmlNode], marks: &[PmMark]) -> Vec<PmChild> {
    let mut out = Vec::new();
    for n in nodes {
        match n {
            HtmlNode::Text(s) => out.push(PmChild::Text { text: s.clone(), marks: text_marks(marks) }),
            HtmlNode::Element { tag, attrs, children } => {
                if tag == "br" {
                    out.push(PmChild::Node(PmNode {
                        node_type: "hardBreak".to_string(),
                        attrs: vec![],
                        children: vec![],
                    }));
                } else if is_ignored(tag) {
                    note_ignored(tag);
                } else if tag == "a" {
                    out.extend(collect_inline(children, &element_marks(tag, attrs, marks).0));
                } else if prose_schema::custom_node_pm(tag, |m| has_attr(attrs, m))
                    == Some("citationInline")
                    && get_attr(attrs, "data-ref-id").is_some()
                {
                    // Inline citation atom (JP-89). Self-describing via `data-*`;
                    // the text content is the cached projection, kept in `label`.
                    // Require `data-ref-id` — a refId-less citation is useless, so
                    // fall through to the unwrap below and keep the text instead.
                    note_atom_text("citationInline", attrs, "data-label", children);
                    out.push(PmChild::Node(citation_node(attrs)));
                } else if prose_schema::custom_node_pm(tag, |m| has_attr(attrs, m))
                    == Some("fieldRef")
                    && get_attr(attrs, "data-name").filter(|s| !s.is_empty()).is_some()
                {
                    // Inline field atom (Phase 3c). Require a non-empty `data-name`
                    // — a nameless field reference is useless, so fall through to
                    // the unwrap below and keep the text instead.
                    note_atom_text("fieldRef", attrs, "data-label", children);
                    out.push(PmChild::Node(field_node(attrs)));
                } else if prose_schema::custom_node_pm(tag, |m| has_attr(attrs, m))
                    == Some("fileRef")
                    && get_attr(attrs, "data-blob-ref")
                        .filter(|s| !s.is_empty())
                        .is_some()
                {
                    // Inline file atom (JP-495). Require a non-empty
                    // `data-blob-ref` — a chip with no blob addresses nothing, so
                    // fall through to the unwrap below and keep its text (the
                    // filename) instead.
                    note_atom_text("fileRef", attrs, "data-file-name", children);
                    out.push(PmChild::Node(file_ref_node(attrs)));
                } else if prose_schema::custom_node_pm(tag, |m| has_attr(attrs, m))
                    == Some("mathInline")
                    && has_attr(attrs, "data-latex")
                {
                    // Inline math atom. Require `data-latex` — a latex-less math
                    // span is useless, so fall through to the unwrap and keep text.
                    note_atom_text("mathInline", attrs, "data-latex", children);
                    out.push(PmChild::Node(math_inline_node(attrs)));
                } else if prose_schema::mark_pm(tag).is_some() {
                    // JP-514: style first, then the tag's own mark. A styled
                    // `<span>` the editor has no mark or attribute for changes
                    // nothing, which is a loss; a plain `<span>` and a `<b>` its
                    // own style refuses are not (see `is_silent_container`).
                    let (inner, contributed) = element_marks(tag, attrs, marks);
                    if !contributed && !is_silent_container(tag, attrs) {
                        note_element_loss(tag, children);
                    }
                    out.extend(collect_inline(children, &inner));
                } else {
                    // Unknown inline tag → unwrap (keep text + current marks, plus
                    // any marks its style adds, as the editor would).
                    if !is_silent_container(tag, attrs) {
                        note_element_loss(tag, children);
                    }
                    out.extend(collect_inline(children, &apply_style_marks(marks, attrs)));
                }
            }
        }
    }
    out
}

fn paragraph_from_inline(nodes: &[HtmlNode], marks: &[PmMark]) -> Option<PmNode> {
    let children = collect_block_inline(nodes, marks);
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
fn collect_block_inline(nodes: &[HtmlNode], marks: &[PmMark]) -> Vec<PmChild> {
    normalize_inline_ws(collect_inline(nodes, marks))
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
            marks: marks.iter().map(|m| PmMark { name: m.to_string(), href: None, attrs: vec![] }).collect(),
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
    fn math_inline_span_parses_to_inline_atom() {
        let b = html_to_blocks(
            r#"<p>where <span data-math-inline data-latex="x^2"></span> holds</p>"#,
        );
        assert_eq!(b[0].node_type, "paragraph");
        assert_eq!(b[0].children[0], text("where "));
        let PmChild::Node(m) = &b[0].children[1] else { panic!("math not a node") };
        assert_eq!(m.node_type, "mathInline");
        assert!(m.children.is_empty(), "math is an atom");
        assert_eq!(attr(m, "latex"), Some("x^2"));
    }

    #[test]
    fn math_block_div_parses_to_block_atom() {
        let b = html_to_blocks(r#"<div data-math-block data-latex="E = mc^2"></div>"#);
        assert_eq!(b[0].node_type, "mathBlock");
        assert!(b[0].children.is_empty(), "math block is an atom");
        assert_eq!(attr(&b[0], "latex"), Some("E = mc^2"));
    }

    #[test]
    fn math_without_latex_degrades_to_text() {
        // A latex-less math span keeps its text rather than producing a useless atom.
        let b = html_to_blocks(r#"<p>a <span data-math-inline>kept</span> b</p>"#);
        let all: String = b[0]
            .children
            .iter()
            .filter_map(|c| match c {
                PmChild::Text { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert!(all.contains("kept"), "latex-less math span keeps its text");
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

    // ---- HTML5 named character entities (JP-497) ----
    //
    // `format:"html"` decoded only six names plus numeric refs, so every other
    // named entity survived as literal text and was then re-escaped on
    // serialize (`&mdash;` stored as `&amp;mdash;`). Agents reach for named
    // entities by reflex because HTML corpora are full of them, so the failure
    // landed hardest on the MCP surface.

    /// Concatenated text of a block's direct text children.
    fn text_of(blocks: &[PmNode]) -> String {
        blocks
            .iter()
            .flat_map(|b| b.children.iter())
            .filter_map(|c| match c {
                PmChild::Text { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn named_entities_decode_in_text() {
        for (src, want) in [
            ("&mdash;", "\u{2014}"),
            ("&ndash;", "\u{2013}"),
            ("&le;", "\u{2264}"),
            ("&sect;", "\u{00a7}"),
            ("&aacute;", "\u{00e1}"),
            ("&copy;", "\u{00a9}"),
            ("&hellip;", "\u{2026}"),
            ("&rsquo;", "\u{2019}"),
        ] {
            let b = html_to_blocks(&format!("<p>{src}</p>"));
            assert_eq!(text_of(&b), want, "named entity {src} must decode");
        }
    }

    #[test]
    fn numeric_and_predefined_entities_keep_decoding() {
        // These already worked; pin them so the swap to a spec decoder can't
        // regress the half that was correct.
        for (src, want) in [
            ("&#275;", "\u{0113}"),
            ("&#x2014;", "\u{2014}"),
            ("&amp;", "&"),
            ("&lt;", "<"),
            ("&gt;", ">"),
            ("&quot;", "\""),
            ("&apos;", "'"),
            ("&nbsp;", "\u{00a0}"),
        ] {
            let b = html_to_blocks(&format!("<p>{src}</p>"));
            assert_eq!(text_of(&b), want, "entity {src} must still decode");
        }
    }

    #[test]
    fn named_entities_decode_in_attribute_values() {
        // The same decoder serves attribute values, so `data-label`, `alt`,
        // `data-file-name` and `data-bib-html` corrupted identically. Not part
        // of the original report — found by probe.
        let b = html_to_blocks(
            r#"<p><span data-citation data-ref-id="r" data-label="(A &mdash; B)">x</span></p>"#,
        );
        let PmChild::Node(c) = &b[0].children[0] else { panic!("expected citation node") };
        assert_eq!(attr(c, "label"), Some("(A \u{2014} B)"));
    }

    #[test]
    fn attribute_context_preserves_legacy_url_query_strings() {
        // WHATWG's attribute rule: a semicolon-less named entity followed by
        // `=` or an alphanumeric is NOT expanded. That is what keeps `&sect=2`
        // a query parameter instead of a section sign. This guards the choice
        // of attribute-context decoding — using general-context decoding for
        // attributes would silently corrupt hrefs.
        let b = html_to_blocks(r#"<p><a href="https://x.test/?a=1&sect=2">go</a></p>"#);
        let PmChild::Text { marks, .. } = &b[0].children[0] else { panic!("expected text") };
        assert_eq!(marks[0].href.as_deref(), Some("https://x.test/?a=1&sect=2"));
    }

    #[test]
    fn attribute_entity_with_semicolon_does_decode() {
        // The other direction, and deliberate: with the semicolon it IS an
        // entity, in attributes too. A browser does the same, which is why a
        // literal ampersand in HTML must be written `&amp;`.
        let b = html_to_blocks(r#"<p><a href="https://x.test/?a=1&sect;b">go</a></p>"#);
        let PmChild::Text { marks, .. } = &b[0].children[0] else { panic!("expected text") };
        assert_eq!(marks[0].href.as_deref(), Some("https://x.test/?a=1\u{00a7}b"));
    }

    #[test]
    fn markdown_and_html_paths_agree_on_entities() {
        // The durable half. Two entity decoders — pulldown-cmark's on the
        // markdown path and ours on the html path — with nothing asserting they
        // agree is precisely how the second-renderer defects (JP-468/472/473)
        // happened. pulldown-cmark was already correct here, which is why the
        // default format hid this bug for so long.
        for src in ["a &mdash; b", "x &le; y", "caf&eacute;", "&#275; and &copy;"] {
            let via_markdown =
                html_to_blocks(&crate::mcp::tools::markdown_to_html_for_tests(src));
            let via_html = html_to_blocks(&format!("<p>{src}</p>"));
            assert_eq!(
                text_of(&via_markdown),
                text_of(&via_html),
                "markdown and html paths disagree on {src}"
            );
        }
    }

    // ---- JP-514: synonyms, inherited marks, task lists, loss reports --------

    /// Each text run of a block as (text, sorted mark names).
    fn runs(block: &PmNode) -> Vec<(String, Vec<String>)> {
        block
            .children
            .iter()
            .filter_map(|c| match c {
                PmChild::Text { text, marks } => {
                    let mut names: Vec<String> = marks.iter().map(|m| m.name.clone()).collect();
                    names.sort();
                    Some((text.clone(), names))
                }
                PmChild::Node(_) => None,
            })
            .collect()
    }

    fn run(text: &str, marks: &[&str]) -> (String, Vec<String>) {
        (text.to_string(), marks.iter().map(|m| m.to_string()).collect())
    }

    fn losses(html: &str) -> Vec<(LossKind, String, String)> {
        html_to_blocks_with_losses(html).1.into_iter().map(|l| (l.kind, l.what, l.path)).collect()
    }

    fn child_node(node: &PmNode, i: usize) -> &PmNode {
        match &node.children[i] {
            PmChild::Node(n) => n,
            other => panic!("expected a node, got {other:?}"),
        }
    }

    /// `checked` and text of each task item of a task list.
    fn task_items(list: &PmNode) -> Vec<(String, String)> {
        assert_eq!(list.node_type, "taskList", "{list:?}");
        list.children
            .iter()
            .map(|c| {
                let PmChild::Node(item) = c else { panic!("expected a task item") };
                assert_eq!(item.node_type, "taskItem");
                let checked = item.attrs.iter().find(|(k, _)| k == "checked").map(|(_, v)| v.clone());
                (checked.unwrap_or_default(), text_of(&[child_node(item, 0).clone()]).trim().to_string())
            })
            .collect()
    }

    #[test]
    fn jp514_google_docs_paste_keeps_its_paragraphs_and_only_its_real_formatting() {
        // The real clipboard shape: a `<meta>`, then every paragraph inside one
        // `<b style="font-weight:normal">`. Before JP-514 the `<meta>` swallowed
        // the paste and a mark tag holding blocks collapsed them into one
        // paragraph; treating the wrapper as bold would bold the whole paste.
        let html = concat!(
            r#"<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-9f1">"#,
            r#"<p dir="ltr" style="line-height:1.38;margin-top:0pt;margin-bottom:0pt;">"#,
            r#"<span style="font-size:11pt;font-weight:700;white-space:pre-wrap;">Bold</span>"#,
            r#"<span style="font-size:11pt;font-weight:400;white-space:pre-wrap;"> plain</span></p>"#,
            r#"<p dir="ltr"><span style="font-size:11pt;font-style:italic;">Second</span></p></b>"#,
        );
        let (blocks, lost) = html_to_blocks_with_losses(html);
        assert_eq!(blocks.len(), 2, "{blocks:?}");
        assert_eq!(runs(&blocks[0]), vec![run("Bold", &["bold"]), run(" plain", &[])]);
        assert_eq!(runs(&blocks[1]), vec![run("Second", &["italic"])]);
        // The wrapper and the metadata are not losses. The span whose only
        // effect was a font size is: the editor cannot keep a font size.
        let what: Vec<&str> = lost.iter().map(|l| l.what.as_str()).collect();
        assert_eq!(what, vec!["<span>"], "{lost:?}");
    }

    #[test]
    fn jp514_a_mark_tag_holding_blocks_keeps_the_blocks_and_carries_its_mark_down() {
        let blocks = html_to_blocks("<strong><p>a</p><p>b</p></strong>");
        assert_eq!(blocks.len(), 2, "{blocks:?}");
        assert_eq!(runs(&blocks[0]), vec![run("a", &["bold"])]);
        assert_eq!(runs(&blocks[1]), vec![run("b", &["bold"])]);

        let blocks = html_to_blocks(r#"<a href="https://x.test"><p>go</p></a>"#);
        let PmChild::Text { marks, .. } = &blocks[0].children[0] else { panic!("expected text") };
        assert_eq!(marks[0].name, "link");
        assert_eq!(marks[0].href.as_deref(), Some("https://x.test"));

        // Carried down, so nothing was lost by unwrapping the tag.
        assert_eq!(losses("<strong><p>a</p></strong>"), vec![]);
    }

    #[test]
    fn jp514_block_styles_reach_inline_content_but_not_a_code_block() {
        let blocks = html_to_blocks(r#"<table><tr><td style="font-weight:700">X</td></tr></table>"#);
        let paragraph = child_node(child_node(child_node(&blocks[0], 0), 0), 0);
        assert_eq!(runs(paragraph), vec![run("X", &["bold"])]);

        let blocks = html_to_blocks(r#"<h2 style="font-style:italic">T</h2>"#);
        assert_eq!(runs(&blocks[0]), vec![run("T", &["italic"])]);

        // A code block takes no marks, in the editor or here.
        let blocks = html_to_blocks(r#"<b><pre><code>x</code></pre></b>"#);
        assert_eq!(blocks[0].node_type, "codeBlock");
        assert_eq!(runs(&blocks[0]), vec![run("x", &[])]);
    }

    #[test]
    fn jp514_gfm_task_lists_become_task_items_with_their_checked_state() {
        let (blocks, lost) = html_to_blocks_with_losses(
            r#"<ul><li><input type="checkbox" checked disabled> done</li><li><input type="checkbox"> todo</li></ul>"#,
        );
        assert_eq!(
            task_items(&blocks[0]),
            vec![("true".to_string(), "done".to_string()), ("false".to_string(), "todo".to_string())]
        );
        assert_eq!(lost, vec![], "the checkbox became the checked state, so nothing was lost");
    }

    #[test]
    fn jp514_markdown_task_lists_and_strikethrough_survive() {
        let html = crate::mcp::tools::markdown_to_html_for_tests("- [x] shipped\n- [ ] next\n\n~~gone~~\n");
        let (blocks, lost) = html_to_blocks_with_losses(&html);
        assert_eq!(
            task_items(&blocks[0]),
            vec![("true".to_string(), "shipped".to_string()), ("false".to_string(), "next".to_string())],
            "{html}"
        );
        assert_eq!(runs(&blocks[1]), vec![run("gone", &["strike"])], "{html}");
        assert_eq!(lost, vec![], "{html}");
    }

    #[test]
    fn jp514_loose_markdown_task_lists_keep_their_checked_state() {
        // Items separated by blank lines render with the checkbox inside a
        // paragraph: `<li><p><input type="checkbox" checked=""/> a</p></li>`.
        let html = crate::mcp::tools::markdown_to_html_for_tests("- [x] a\n\n- [ ] b\n");
        let (blocks, lost) = html_to_blocks_with_losses(&html);
        assert_eq!(
            task_items(&blocks[0]),
            vec![("true".to_string(), "a".to_string()), ("false".to_string(), "b".to_string())],
            "{html}"
        );
        assert_eq!(lost, vec![], "{html}");
    }

    #[test]
    fn jp514_a_list_that_is_not_all_tasks_stays_a_bullet_list_and_reports_the_checkbox() {
        let (blocks, lost) =
            html_to_blocks_with_losses(r#"<ul><li><input type="checkbox" checked> a</li><li>b</li></ul>"#);
        assert_eq!(blocks[0].node_type, "bulletList");
        assert_eq!(
            lost,
            vec![ParseLoss { kind: LossKind::Removed, what: "<input>".into(), path: "0/bulletList".into() }]
        );
    }

    #[test]
    fn jp514_losses_name_the_kind_the_element_and_the_block() {
        let html = concat!(
            "<p>Press <kbd>Ctrl</kbd>+<kbd>C</kbd></p>",
            "<p>x<kbd></kbd></p>",
            r#"<p><span data-field data-name="owner">Alice</span></p>"#,
            "<script>alert(1)</script>",
        );
        assert_eq!(
            losses(html),
            vec![
                (LossKind::Unwrapped, "<kbd>".to_string(), "0/paragraph".to_string()),
                (LossKind::Unwrapped, "<kbd>".to_string(), "0/paragraph".to_string()),
                (LossKind::Removed, "<kbd>".to_string(), "1/paragraph".to_string()),
                (LossKind::StrippedAtomText, "fieldRef".to_string(), "2/paragraph".to_string()),
                // Nothing came of it, so there is no block to point at.
                (LossKind::Removed, "<script>".to_string(), String::new()),
            ]
        );
        // And the script's text is not kept as prose, as in the editor.
        assert!(!text_of(&html_to_blocks(html)).contains("alert"));
    }

    #[test]
    fn jp514_nothing_the_relay_or_the_editor_writes_is_reported_as_a_loss() {
        for html in [
            "<div><section><p>wrapped</p></section></div>",
            r#"<p><span class="x" id="y" dir="ltr">plain span</span></p>"#,
            // The relay's own field spans (`field_span_html`), labelled and not.
            r#"<p><span data-field data-name="owner" data-label="A &amp; B">A &amp; B</span></p>"#,
            r#"<p><span data-field data-name="owner"></span></p>"#,
            // The editor's task item chrome.
            concat!(
                r#"<ul data-type="taskList"><li data-type="taskItem" data-checked="true">"#,
                r#"<label><input type="checkbox" checked="checked"><span></span></label>"#,
                "<div><p>done</p></div></li></ul>",
            ),
            "<p><b><b>twice</b></b></p>",
            r#"<b style="font-weight:normal"><p>pasted</p></b>"#,
            r#"<meta charset="utf-8"><p>a<wbr>b</p>"#,
            "<html><head><title>T</title><style>p{}</style></head><body><p>x</p></body></html>",
            "<table><colgroup><col><col></colgroup><tbody><tr><td>a</td><td>b</td></tr></tbody></table>",
        ] {
            assert_eq!(losses(html), vec![], "{html}");
        }
    }

    #[test]
    fn jp514_void_tags_no_longer_swallow_what_follows() {
        let blocks = html_to_blocks(r#"<meta charset="utf-8"><p>one</p><p>two</p>"#);
        assert_eq!(blocks.len(), 2, "{blocks:?}");
        // A void element the editor cannot keep is reported as removed, and no
        // longer takes the following block with it (it was "unwrapped" around
        // the paragraph after it).
        let (blocks, lost) = html_to_blocks_with_losses(r#"<embed src="x.swf"><p>after</p>"#);
        assert_eq!(runs(&blocks[0]), vec![run("after", &[])]);
        assert_eq!(
            lost,
            vec![ParseLoss { kind: LossKind::Removed, what: "<embed>".into(), path: "0/paragraph".into() }]
        );
        let blocks = html_to_blocks("<ul><li>long<wbr>word <b>bold</b></li></ul>");
        let paragraph = child_node(child_node(&blocks[0], 0), 0);
        assert_eq!(child_node(&blocks[0], 0).children.len(), 1, "one paragraph: {blocks:?}");
        assert_eq!(text_of(&[paragraph.clone()]), "longword bold");
    }

    #[test]
    fn jp514_an_unknown_inline_element_stays_in_its_paragraph() {
        // Loose inline content in a list item or cell is one paragraph in the
        // editor; an unknown inline element used to split it into three.
        let blocks = html_to_blocks("<ul><li>Press <kbd>Ctrl</kbd> now</li></ul>");
        let item = child_node(&blocks[0], 0);
        assert_eq!(item.children.len(), 1, "{blocks:?}");
        assert_eq!(text_of(&[child_node(item, 0).clone()]), "Press Ctrl now");
    }

    #[test]
    fn jp514_a_span_whose_style_the_editor_fully_parses_is_not_a_loss() {
        // Found on staging: `font-weight: 400` with no bold to clear changes
        // nothing, but nothing is lost either; the editor parses that style.
        assert_eq!(
            losses(r#"<p><span style="font-weight:400">a</span> <span style="text-decoration: none; vertical-align: baseline">b</span></p>"#),
            vec![]
        );
        // A property the editor has no mark for is still a loss.
        assert_eq!(
            losses(r#"<p><span style="font-size:12px">a</span></p>"#),
            vec![(LossKind::Unwrapped, "<span>".to_string(), "0/paragraph".to_string())]
        );
    }

    #[test]
    fn jp514_only_the_validation_parse_collects_losses() {
        let (_, lost) = html_to_blocks_with_losses("<p><kbd>x</kbd></p>");
        assert_eq!(lost.len(), 1);
        assert!(!collecting_losses(), "the collector must be cleared after the validation parse");
        let _ = html_to_blocks("<p><kbd>x</kbd></p>");
        assert!(!collecting_losses(), "a live write parse must not start collecting");
    }

}
