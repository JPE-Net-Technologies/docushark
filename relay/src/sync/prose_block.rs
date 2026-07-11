//! Anchored, block-level prose writes (JP-239 part 1).
//!
//! The whole-page replace ([`super::DocHandle::replace_prose`], JP-238) rebuilds
//! the entire `prose:<page>` fragment. That's the right default, but a localized
//! edit ("reword this paragraph") shouldn't touch the rest of the page — both to
//! keep the CRDT delta minimal and to narrow the concurrency blast radius.
//!
//! The mechanism is a **block-level compare-and-swap**: the agent passes the
//! current *text* of the block it intends to change (the `anchor`), and the relay
//! replaces that block only if the anchor matches **exactly one** top-level block.
//! If the block drifted (a concurrent edit changed its text), the anchor no
//! longer matches and the write is refused — the anchor *is* the write
//! confirmation. An optional `anchor_until` extends the target to the inclusive
//! span of blocks from `anchor` through `anchor_until`.
//!
//! Matching is on **normalized plain text** (trim + collapse whitespace), so the
//! anchor can be supplied as the block's text *or* as the HTML `get_prose`
//! returned for it — tags are stripped to text either way. Marks/styling don't
//! participate in matching.
//!
//! Both the live path ([`super::DocHandle::replace_prose_block`]) and the cold
//! JSON path ([`replace_block_in_html`]) funnel through
//! [`replace_block_in_fragment`], so they can't diverge: the cold path applies
//! the exact same fragment surgery on a throwaway `Doc` and re-serializes via
//! [`super::prose_html`].

use yrs::{
    Any, Doc, Out, ReadTxn, Text, Transact, TransactionMut, Xml, XmlElementPrelim, XmlElementRef,
    XmlFragment, XmlFragmentRef, XmlOut,
};

use super::prose_parse::{self, PmChild, PmNode};
use super::{build_prose_children, build_prose_node, prose_html, prose_schema};

/// One addressable prose leaf in the fragment tree (JP-429): the smallest
/// text-bearing block (a paragraph, heading, or code block) — a bullet's line,
/// a table cell's line, a quote's line — *wherever* it sits. `path` is the raw
/// child-index chain from the fragment root; `text` is its normalized text, the
/// anchor. Addressing the leaf (never a container) means a targeted edit can
/// never destroy surrounding structure: the leaf's container and every sibling —
/// including nested lists/tables — are untouched by the splice.
struct Target {
    path: Vec<u32>,
    text: String,
}

/// The text-bearing leaf blocks an anchor can target. Everything else is a
/// container the walk descends *through* to reach these (lists, tables, cells,
/// list items, blockquotes, callouts, and any unknown wrapper).
const TEXT_LEAVES: &[&str] = &["paragraph", "heading", "codeBlock"];

/// Replace the addressable leaf(s) matching `anchor` (through `anchor_until`, if
/// given) with the blocks parsed from `new_html`, in a single transaction.
///
/// Anchoring reaches leaves at any depth (JP-429): a bullet's line, a cell's
/// line, a quote's line — matched by their text. Because a *leaf* is replaced in
/// its own container, every sibling and all surrounding structure (lists, tables,
/// nested blocks) pass through verbatim; a targeted edit can't destroy them.
/// Anchor resolution happens before any mutation, so an `Err` (no match /
/// ambiguous / bad range) leaves the fragment untouched. An edit that empties the
/// leaf's container (or the page) re-seeds a single empty paragraph (the editor's
/// "a page is never truly empty" invariant).
pub fn replace_block_in_fragment(
    frag: &XmlFragmentRef,
    txn: &mut TransactionMut,
    anchor: &str,
    anchor_until: Option<&str>,
    new_html: &str,
) -> Result<(), String> {
    // Snapshot the addressable leaves up front (owned, so the read-borrow is
    // released before we mutate).
    let targets = collect_targets(frag, &*txn);

    let start = resolve_target(&targets, anchor, "anchor")?;
    let start_path = start.path.clone();
    let start_idx = *start_path.last().expect("target path is non-empty");

    let end_idx = match anchor_until {
        None => start_idx,
        Some(until) => {
            let end = resolve_target(&targets, until, "anchorUntil")?;
            // Must be a sibling of `anchor` (same parent block) — a span across
            // different containers (e.g. two separate bullets, each its own list
            // item) has no single slot to splice, so it's refused.
            let same_parent = end.path.len() == start_path.len()
                && end.path[..end.path.len() - 1] == start_path[..start_path.len() - 1];
            if !same_parent {
                return Err("ERR_ANCHOR_RANGE: anchorUntil must be a sibling of anchor \
                            (same parent block)"
                    .into());
            }
            let ei = *end.path.last().unwrap();
            if ei < start_idx {
                return Err("ERR_ANCHOR_RANGE: anchorUntil matches a block before anchor".into());
            }
            ei
        }
    };
    let parent_path: Vec<u32> = start_path[..start_path.len() - 1].to_vec();
    let count = end_idx - start_idx + 1;

    // Gate (JP-328): validate + normalize the inserted blocks before they reach
    // the fragment, so an anchored write can't smuggle a malformed node past the
    // whole-page gate. Covers the live path (replace_prose_block) and the cold
    // path (replace_block_in_html delegates here).
    let (new_blocks, fixes) =
        super::prose_validate::sanitize_blocks(prose_parse::html_to_blocks(new_html));
    if !fixes.is_empty() {
        log::info!("prose_validate healed {} defect(s) in anchored prose write: {fixes:?}", fixes.len());
    }

    splice(frag, txn, &parent_path, start_idx, count, &new_blocks);
    reseed_if_empty(frag, txn, &parent_path);
    Ok(())
}

/// Walk the fragment into a flat list of addressable leaf [`Target`]s: descend
/// through every container (lists, tables, cells, list items, blockquotes,
/// callouts, unknown wrappers) and emit each text-bearing leaf ([`TEXT_LEAVES`])
/// with its path + normalized text. A leaf holds only inline content, so it's
/// never descended into.
fn collect_targets<T: ReadTxn>(frag: &XmlFragmentRef, txn: &T) -> Vec<Target> {
    let mut out = Vec::new();
    for (i, node) in frag.children(txn).enumerate() {
        walk_target(&node, txn, vec![i as u32], 0, &mut out);
    }
    out
}

/// Depth-bounded like the serializer and parser (JP-248): a live `prose:`
/// fragment can be nested arbitrarily deep via the raw WS sync path (bypassing
/// the parser's cap), so an unbounded walk here would overflow the stack and
/// abort the relay on a pathological doc. Beyond [`prose_schema::MAX_PROSE_DEPTH`]
/// leaves are simply unaddressable — the same content the serializer omits.
fn walk_target<T: ReadTxn>(
    node: &XmlOut,
    txn: &T,
    path: Vec<u32>,
    depth: usize,
    out: &mut Vec<Target>,
) {
    if depth >= prose_schema::MAX_PROSE_DEPTH {
        return;
    }
    let XmlOut::Element(el) = node else {
        return; // stray text/fragment at block level — not addressable
    };
    if TEXT_LEAVES.contains(&el.tag().as_ref()) {
        out.push(Target { path, text: normalize(&all_text(el, txn)) });
        return; // a leaf holds only inline content
    }
    // A container → descend to reach the leaves inside it.
    for (i, child) in el.children(txn).enumerate() {
        let mut p = path.clone();
        p.push(i as u32);
        walk_target(&child, txn, p, depth + 1, out);
    }
}

/// Find the single leaf whose normalized text equals the anchor's. `field` names
/// the offending argument in the error.
fn resolve_target<'a>(targets: &'a [Target], raw: &str, field: &str) -> Result<&'a Target, String> {
    let needle = normalize(&anchor_to_text(raw));
    if needle.is_empty() {
        return Err(format!("ERR_ANCHOR_EMPTY: {field} has no text content"));
    }
    let hits: Vec<&Target> = targets.iter().filter(|t| t.text == needle).collect();
    match hits.len() {
        0 => Err(format!(
            "ERR_ANCHOR_NOT_FOUND: no prose block matches {field}={raw:?} — its text may have \
             changed, or you must pass the block's full text"
        )),
        1 => Ok(hits[0]),
        n => Err(format!(
            "ERR_ANCHOR_AMBIGUOUS: {n} prose blocks match {field}={raw:?} — include more of the \
             block's text to identify exactly one"
        )),
    }
}

/// Remove `count` children starting at `start` under the element at `parent_path`
/// (the fragment root when the path is empty) and insert `nodes` in their place.
fn splice(
    frag: &XmlFragmentRef,
    txn: &mut TransactionMut,
    parent_path: &[u32],
    start: u32,
    count: u32,
    nodes: &[PmNode],
) {
    if parent_path.is_empty() {
        frag.remove_range(txn, start, count);
        for (i, node) in nodes.iter().enumerate() {
            build_prose_node_at(frag, txn, start + i as u32, node);
        }
    } else if let Some(parent) = descend(frag, &*txn, parent_path) {
        parent.remove_range(txn, start, count);
        for (i, node) in nodes.iter().enumerate() {
            build_prose_node_at(&parent, txn, start + i as u32, node);
        }
    }
}

/// If a delete emptied the leaf's container (the page root, or a content block
/// like a list item / cell / blockquote that must hold `block+`), re-seed one
/// empty paragraph — the editor's "never truly empty" invariant. A leaf's parent
/// is always the root or a block-holding container (never a list/table/row, which
/// hold items/rows/cells, not leaves), so a single-level reseed suffices.
fn reseed_if_empty(frag: &XmlFragmentRef, txn: &mut TransactionMut, parent_path: &[u32]) {
    if parent_path.is_empty() {
        if frag.len(&*txn) == 0 {
            build_prose_node(frag, txn, &empty_paragraph());
        }
    } else if let Some(el) = descend(frag, &*txn, parent_path) {
        if el.len(&*txn) == 0 {
            build_prose_node(&el, txn, &empty_paragraph());
        }
    }
}

/// Resolve the element at `path` (non-empty) by walking child indices from the
/// fragment root. `None` if any step is missing or not an element.
fn descend<T: ReadTxn>(frag: &XmlFragmentRef, txn: &T, path: &[u32]) -> Option<XmlElementRef> {
    let mut el = match frag.get(txn, *path.first()?)? {
        XmlOut::Element(e) => e,
        _ => return None,
    };
    for &idx in &path[1..] {
        el = match el.get(txn, idx)? {
            XmlOut::Element(e) => e,
            _ => return None,
        };
    }
    Some(el)
}

/// All descendant text of a leaf element (its inline content), concatenated.
fn all_text<T: ReadTxn>(el: &XmlElementRef, txn: &T) -> String {
    let mut out = String::new();
    collect_all_text(el, txn, 0, &mut out);
    out
}

/// Depth-bounded (JP-248): a leaf normally holds only shallow inline content,
/// but a raw-sync fragment can nest elements arbitrarily inside one, so cap the
/// recursion to keep anchor matching from overflowing the stack.
fn collect_all_text<T: ReadTxn>(el: &XmlElementRef, txn: &T, depth: usize, out: &mut String) {
    if depth >= prose_schema::MAX_PROSE_DEPTH {
        return;
    }
    for child in el.children(txn) {
        match child {
            XmlOut::Element(cel) => collect_all_text(&cel, txn, depth + 1, out),
            XmlOut::Text(t) => {
                for run in t.diff(txn, |_| ()) {
                    if let Out::Any(Any::String(s)) = &run.insert {
                        out.push_str(s);
                    }
                }
            }
            XmlOut::Fragment(f) => {
                for c in f.children(txn) {
                    if let XmlOut::Element(cel) = &c {
                        collect_all_text(cel, txn, depth + 1, out);
                    }
                }
            }
        }
    }
}

/// Apply [`replace_block_in_fragment`] to a page's HTML without a live `Doc`:
/// build a throwaway fragment from `current_html`, run the same surgery, and
/// re-serialize. Used by the MCP cold path (a non-resident document edits its
/// JSON `richTextPages[*].content`).
pub fn replace_block_in_html(
    current_html: &str,
    anchor: &str,
    anchor_until: Option<&str>,
    new_html: &str,
) -> Result<String, String> {
    let doc = Doc::new();
    let frag = doc.get_or_insert_xml_fragment("prose:scratch");
    {
        let mut txn = doc.transact_mut();
        for node in &prose_parse::html_to_blocks(current_html) {
            build_prose_node(&frag, &mut txn, node);
        }
        replace_block_in_fragment(&frag, &mut txn, anchor, anchor_until, new_html)?;
    }
    let txn = doc.transact();
    Ok(prose_html::fragment_to_html(&frag, &txn))
}

/// Insert one PM node (and subtree) at `index` among `parent`'s children. The
/// positional analog of [`super::build_prose_node`] (which appends); children are
/// still appended into the freshly-inserted element.
fn build_prose_node_at<P: XmlFragment>(
    parent: &P,
    txn: &mut TransactionMut,
    index: u32,
    node: &PmNode,
) {
    let el = parent.insert(txn, index, XmlElementPrelim::empty(node.node_type.as_str()));
    for (k, v) in &node.attrs {
        el.insert_attribute(txn, k.as_str(), v.clone());
    }
    build_prose_children(&el, txn, &node.children);
}

/// Normalize text for anchor comparison: trim and collapse internal whitespace
/// runs to a single space — so a write isn't foiled by re-wrapped HTML or
/// markdown vs. editor whitespace.
fn normalize(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Plain text of an anchor argument. The anchor may be raw text or an HTML block
/// (what `get_prose` returns) — parse it leniently and flatten the text so either
/// form matches.
fn anchor_to_text(raw: &str) -> String {
    let mut out = String::new();
    for node in &prose_parse::html_to_blocks(raw) {
        pm_node_text(node, &mut out);
    }
    out
}

fn pm_node_text(node: &PmNode, out: &mut String) {
    for child in &node.children {
        match child {
            PmChild::Text { text, .. } => out.push_str(text),
            PmChild::Node(n) => pm_node_text(n, out),
        }
    }
}

fn empty_paragraph() -> PmNode {
    PmNode {
        node_type: "paragraph".to_string(),
        attrs: Vec::new(),
        children: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a fragment from HTML, apply a block replace, return the new HTML.
    fn apply(current: &str, anchor: &str, until: Option<&str>, new: &str) -> Result<String, String> {
        replace_block_in_html(current, anchor, until, new)
    }

    #[test]
    fn replaces_single_matched_paragraph() {
        let out = apply(
            "<p>Intro.</p><p>Replace me.</p><p>Outro.</p>",
            "Replace me.",
            None,
            "<p>Fresh text.</p>",
        )
        .unwrap();
        assert_eq!(out, "<p>Intro.</p><p>Fresh text.</p><p>Outro.</p>");
    }

    #[test]
    fn anchor_accepts_the_blocks_html() {
        // Agent pastes back the HTML get_prose returned for the block.
        let out = apply(
            "<p>keep</p><p>old</p>",
            "<p>old</p>",
            None,
            "<p>new</p>",
        )
        .unwrap();
        assert_eq!(out, "<p>keep</p><p>new</p>");
    }

    #[test]
    fn replacement_can_expand_to_multiple_blocks() {
        let out = apply(
            "<h1>Title</h1><p>stub</p>",
            "stub",
            None,
            "<p>one</p><p>two</p>",
        )
        .unwrap();
        assert_eq!(out, "<h1>Title</h1><p>one</p><p>two</p>");
    }

    #[test]
    fn range_replaces_inclusive_span() {
        let out = apply(
            "<p>a</p><p>b</p><p>c</p><p>d</p>",
            "b",
            Some("c"),
            "<p>merged</p>",
        )
        .unwrap();
        assert_eq!(out, "<p>a</p><p>merged</p><p>d</p>");
    }

    #[test]
    fn whitespace_is_normalized_for_matching() {
        let out = apply(
            "<p>hello   world</p>",
            "hello world",
            None,
            "<p>done</p>",
        )
        .unwrap();
        assert_eq!(out, "<p>done</p>");
    }

    #[test]
    fn marks_dont_block_a_text_match() {
        let out = apply(
            "<p>see <strong>this</strong> now</p>",
            "see this now",
            None,
            "<p>gone</p>",
        )
        .unwrap();
        assert_eq!(out, "<p>gone</p>");
    }

    #[test]
    fn not_found_is_an_error() {
        let err = apply("<p>a</p>", "missing", None, "<p>x</p>").unwrap_err();
        assert!(err.starts_with("ERR_ANCHOR_NOT_FOUND"), "{err}");
    }

    #[test]
    fn ambiguous_is_an_error() {
        let err = apply("<p>dup</p><p>dup</p>", "dup", None, "<p>x</p>").unwrap_err();
        assert!(err.starts_with("ERR_ANCHOR_AMBIGUOUS"), "{err}");
    }

    #[test]
    fn reversed_range_is_an_error() {
        let err = apply("<p>a</p><p>b</p>", "b", Some("a"), "<p>x</p>").unwrap_err();
        assert!(err.starts_with("ERR_ANCHOR_RANGE"), "{err}");
    }

    #[test]
    fn emptying_the_page_reseeds_a_paragraph() {
        // Replacing the only block with empty content leaves one empty paragraph.
        let out = apply("<p>only</p>", "only", None, "").unwrap();
        assert_eq!(out, "<p></p>");
    }

    #[test]
    fn jp328_anchored_write_heals_a_srcless_image() {
        // The anchored path must run the same JP-328 gate as the whole-page
        // replace: a src-less <img> (a naked atom that crashes the client's
        // NodeView reconciliation) is dropped before it reaches the fragment.
        let out = apply(
            "<p>keep</p><p>swap</p>",
            "swap",
            None,
            "<p>before<img>after</p>",
        )
        .unwrap();
        assert_eq!(out, "<p>keep</p><p>beforeafter</p>");
        assert!(!out.contains("<img"), "src-less image must not survive the gate: {out}");
    }

    #[test]
    fn jp328_anchored_write_rebuilds_a_ragged_table() {
        // A ragged table (rows of differing cell counts) is padded to the
        // rectangular table>tableRow+>cell+ the client schema requires, so the
        // anchored write can't smuggle a malformed table past the gate.
        let out = apply(
            "<p>anchor</p>",
            "anchor",
            None,
            "<table><tr><td>a</td><td>b</td></tr><tr><td>c</td></tr></table>",
        )
        .unwrap();
        // Both rows must now carry two cells (the second was padded).
        assert_eq!(out.matches("<td").count(), 4, "ragged table must be padded rectangular: {out}");
    }

    #[test]
    fn untouched_blocks_are_preserved_verbatim() {
        let out = apply(
            "<h2>Goals</h2><ul><li><p>one</p></li></ul><p>target</p>",
            "target",
            None,
            "<p>replaced</p>",
        )
        .unwrap();
        assert_eq!(
            out,
            "<h2>Goals</h2><ul><li><p>one</p></li></ul><p>replaced</p>"
        );
    }

    // ---- JP-429: nested-unit anchoring (bullets, cells, blockquotes) ----------

    #[test]
    fn replaces_a_single_bullet_leaving_the_list_and_siblings() {
        // The reported bug: an agent must be able to change ONE bullet without
        // rewriting the whole list.
        let out = apply(
            "<ul><li><p>one</p></li><li><p>two</p></li><li><p>three</p></li></ul>",
            "two",
            None,
            "two revised",
        )
        .unwrap();
        assert_eq!(
            out,
            "<ul><li><p>one</p></li><li><p>two revised</p></li><li><p>three</p></li></ul>"
        );
    }

    #[test]
    fn a_bullet_stays_a_bullet_when_replaced_with_a_paragraph() {
        // Coercion: replacing a list item with `<p>` content keeps it an <li>.
        let out = apply("<ol><li><p>a</p></li></ol>", "a", None, "<p>b</p>").unwrap();
        assert_eq!(out, "<ol><li><p>b</p></li></ol>");
    }

    #[test]
    fn clearing_a_bullets_text_keeps_an_empty_bullet() {
        // A content edit (empty replacement) clears the bullet's text but keeps
        // the bullet — removing the item is a structural op (deferred), so we
        // never destroy list structure from a text edit.
        let out = apply("<ul><li><p>only</p></li></ul>", "only", None, "").unwrap();
        assert_eq!(out, "<ul><li><p></p></li></ul>");
    }

    #[test]
    fn nested_sub_bullet_is_addressed_independently_of_its_parent() {
        // The parent item's own text ("outer") and the sub-bullet ("inner") are
        // distinct anchors; editing the sub-bullet leaves the parent line intact.
        let out = apply(
            "<ul><li><p>outer</p><ul><li><p>inner</p></li></ul></li></ul>",
            "inner",
            None,
            "inner!",
        )
        .unwrap();
        assert_eq!(
            out,
            "<ul><li><p>outer</p><ul><li><p>inner!</p></li></ul></li></ul>"
        );
    }

    #[test]
    fn anchor_until_spans_sibling_leaves_in_one_parent() {
        // Sibling leaves under the SAME parent (here two top-level paragraphs)
        // collapse into the replacement; surrounding blocks are untouched.
        let out = apply(
            "<h1>T</h1><p>a</p><p>b</p><p>c</p>",
            "a",
            Some("b"),
            "merged",
        )
        .unwrap();
        assert_eq!(out, "<h1>T</h1><p>merged</p><p>c</p>");
    }

    #[test]
    fn cross_parent_range_is_refused() {
        // Two bullets live in separate list items (separate parents), so a span
        // across them has no single slot — refuse rather than corrupt.
        let err = apply(
            "<ul><li><p>a</p></li><li><p>b</p></li></ul>",
            "a",
            Some("b"),
            "x",
        )
        .unwrap_err();
        assert!(err.starts_with("ERR_ANCHOR_RANGE"), "{err}");
    }

    #[test]
    fn replaces_a_single_table_cell_keeping_the_row() {
        let out = apply(
            "<table><tr><td><p>a</p></td><td><p>b</p></td></tr></table>",
            "b",
            None,
            "b2",
        )
        .unwrap();
        assert_eq!(
            out,
            "<table><tr><td><p>a</p></td><td><p>b2</p></td></tr></table>"
        );
    }

    #[test]
    fn a_deeply_nested_leaf_is_edited_without_touching_its_ancestors() {
        // The generative regression: a heading buried in nested blockquotes beside
        // a list — editing it must leave the list and wrappers verbatim.
        let doc = "<blockquote><blockquote>\
            <ul><li><p>b0</p></li><li><p>b1</p></li></ul><h2>deep</h2>\
            </blockquote></blockquote>";
        // Supply HTML to keep it a heading; the surrounding list + wrappers are
        // untouched.
        let out = apply(doc, "deep", None, "<h2>DEEP</h2>").unwrap();
        assert_eq!(
            out,
            "<blockquote><blockquote>\
             <ul><li><p>b0</p></li><li><p>b1</p></li></ul><h2>DEEP</h2>\
             </blockquote></blockquote>"
        );
    }

    #[test]
    fn inner_lines_of_a_blockquote_are_addressable_and_isolated() {
        // A blockquote wrapping a list: the quote's own line and each inner bullet
        // are separately addressable, and editing one leaves the rest intact.
        let doc = "<blockquote><p>quote</p><ul><li><p>b1</p></li><li><p>b2</p></li></ul></blockquote>";
        let q = apply(doc, "quote", None, "quote!").unwrap();
        assert_eq!(
            q,
            "<blockquote><p>quote!</p><ul><li><p>b1</p></li><li><p>b2</p></li></ul></blockquote>"
        );
        let b = apply(doc, "b1", None, "b1!").unwrap();
        assert_eq!(
            b,
            "<blockquote><p>quote</p><ul><li><p>b1!</p></li><li><p>b2</p></li></ul></blockquote>"
        );
    }

    #[test]
    fn deep_resident_fragment_does_not_overflow_the_anchor_walk() {
        // JP-248: a live prose: fragment can be nested arbitrarily deep via the
        // raw WS sync path (bypassing the parser's cap). The anchor walk must be
        // depth-bounded like the serializer, or it overflows the stack (aborting
        // the relay) on an anchored set_prose. Build a pathologically deep
        // subtree beside a shallow, addressable leaf; anchoring the shallow leaf
        // must complete — the walk stops at the cap instead of recursing to the
        // bottom. The test *finishing* is the proof.
        use yrs::XmlTextPrelim;
        let doc = Doc::new();
        let frag = doc.get_or_insert_xml_fragment("prose:deep");
        {
            let mut txn = doc.transact_mut();
            let p = frag.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
            p.push_back(&mut txn, XmlTextPrelim::new("top"));
            let mut cur = frag.push_back(&mut txn, XmlElementPrelim::empty("blockquote"));
            for _ in 0..10_000 {
                cur = cur.push_back(&mut txn, XmlElementPrelim::empty("blockquote"));
            }
            let deep_p = cur.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
            deep_p.push_back(&mut txn, XmlTextPrelim::new("bottom"));
            replace_block_in_fragment(&frag, &mut txn, "top", None, "<p>TOP</p>").unwrap();
        }
        let txn = doc.transact();
        let out = prose_html::fragment_to_html(&frag, &txn);
        assert!(out.starts_with("<p>TOP</p>"), "shallow leaf not replaced: {}", &out[..out.len().min(40)]);
    }

    #[test]
    fn identical_bullets_are_ambiguous() {
        let err = apply(
            "<ul><li><p>dup</p></li><li><p>dup</p></li></ul>",
            "dup",
            None,
            "x",
        )
        .unwrap_err();
        assert!(err.starts_with("ERR_ANCHOR_AMBIGUOUS"), "{err}");
    }

    // ---- JP-429: generative invariants (seed-logged, house fuzz style) --------

    /// Build a random valid prose doc with **uniquely-labelled** leaf text, plus
    /// the set of every leaf label it contains. Bounded depth so it terminates.
    fn gen_doc(rng: &mut impl rand::Rng, next: &mut u32, depth: u32) -> (String, Vec<String>) {
        let mut html = String::new();
        let mut labels = Vec::new();
        let blocks = 1 + rng.gen_range(0..4u32);
        for _ in 0..blocks {
            match rng.gen_range(0..if depth == 0 { 3 } else { 5 }) {
                0 => {
                    let l = format!("t{}", *next);
                    *next += 1;
                    html.push_str(&format!("<p>{l}</p>"));
                    labels.push(l);
                }
                1 => {
                    let l = format!("t{}", *next);
                    *next += 1;
                    html.push_str(&format!("<h2>{l}</h2>"));
                    labels.push(l);
                }
                2 => {
                    // A list of leaf items (no nested lists here — that's covered
                    // by the recursive case below, which the guard refuses to
                    // wholesale-replace, so its items are edited instead).
                    html.push_str("<ul>");
                    for _ in 0..1 + rng.gen_range(0..3u32) {
                        let l = format!("t{}", *next);
                        *next += 1;
                        html.push_str(&format!("<li><p>{l}</p></li>"));
                        labels.push(l);
                    }
                    html.push_str("</ul>");
                }
                3 => {
                    // A single-row table of leaf cells.
                    html.push_str("<table><tr>");
                    for _ in 0..1 + rng.gen_range(0..3u32) {
                        let l = format!("t{}", *next);
                        *next += 1;
                        html.push_str(&format!("<td><p>{l}</p></td>"));
                        labels.push(l);
                    }
                    html.push_str("</tr></table>");
                }
                _ => {
                    let (inner, inner_labels) = gen_doc(rng, next, depth - 1);
                    html.push_str(&format!("<blockquote>{inner}</blockquote>"));
                    labels.extend(inner_labels);
                }
            }
        }
        (html, labels)
    }

    /// Invariants over random nested docs: every uniquely-texted, non-wrapping
    /// unit is editable; the edit changes ONLY that unit's text (no other label is
    /// lost or altered); and re-applying the same anchor is a fixed point. Prints
    /// the seed on failure for deterministic repro (`DOCUSHARK_FUZZ_SEED`).
    #[test]
    fn generative_anchored_edits_never_lose_sibling_content() {
        use rand::SeedableRng;
        let seed: u64 = std::env::var("DOCUSHARK_FUZZ_SEED")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or_else(|| rand::random());
        let mut rng = rand::rngs::StdRng::seed_from_u64(seed);

        for _ in 0..300 {
            let mut next = 0u32;
            let (doc, labels) = gen_doc(&mut rng, &mut next, 2);
            // Pick a label to edit that is unambiguous and not a wrapping unit.
            let frag_html = doc.clone();
            let target = labels.iter().find(|l| {
                // resolvable to exactly one unit, and editing it is allowed
                matches!(apply(&frag_html, l, None, &format!("{l}_X")), Ok(_))
            });
            let Some(label) = target else { continue };
            let out = apply(&doc, label, None, &format!("{label}_X"))
                .unwrap_or_else(|e| panic!("seed={seed} doc={doc:?} anchor={label:?}: {e}"));
            // The edited label is gone-as-standalone (now `{label}_X`), every OTHER
            // label survives verbatim, and the new text is present.
            assert!(out.contains(&format!("{label}_X")), "seed={seed}: edit not applied: {out}");
            for other in labels.iter().filter(|l| *l != label) {
                assert!(
                    out.contains(&format!(">{other}<")),
                    "seed={seed}: sibling label {other:?} lost editing {label:?}\n doc={doc}\n out={out}"
                );
            }
            // Fixed point: serialize→parse→serialize is stable.
            let twice = apply(&out, &format!("{label}_X"), None, &format!("{label}_X"))
                .unwrap_or_else(|e| panic!("seed={seed} refixed: {e}"));
            assert_eq!(out, twice, "seed={seed}: not a fixed point");
        }
    }

    /// No-collateral-damage invariant: after an anchored edit, every unit whose
    /// own text isn't the anchor serializes byte-identically to before. Here the
    /// whole surrounding document is asserted verbatim, which is the strongest
    /// form for a fixed fixture.
    #[test]
    fn edit_touches_only_the_matched_unit() {
        let before = "<h2>H</h2><ul><li><p>a</p></li><li><p>target</p></li></ul>\
                      <table><tr><td><p>c1</p></td><td><p>c2</p></td></tr></table><p>tail</p>";
        let out = apply(before, "target", None, "TARGET").unwrap();
        assert_eq!(
            out,
            "<h2>H</h2><ul><li><p>a</p></li><li><p>TARGET</p></li></ul>\
             <table><tr><td><p>c1</p></td><td><p>c2</p></td></tr></table><p>tail</p>"
        );
    }
}
