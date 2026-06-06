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
    Any, Doc, Out, ReadTxn, Text, Transact, TransactionMut, Xml, XmlElementPrelim, XmlFragment,
    XmlOut,
};

use super::prose_parse::{self, PmChild, PmNode};
use super::{build_prose_children, build_prose_node, prose_html};

/// Replace the top-level block(s) matching `anchor` (through `anchor_until`, if
/// given) with the blocks parsed from `new_html`, in a single transaction.
///
/// Anchor resolution happens before any mutation, so an `Err` (no match /
/// ambiguous / bad range) leaves the fragment untouched. An edit that would empty
/// the fragment re-seeds a single empty paragraph (the editor's "a page is never
/// truly empty" invariant, matching [`super::DocHandle::replace_prose`]).
pub fn replace_block_in_fragment<F: XmlFragment>(
    frag: &F,
    txn: &mut TransactionMut,
    anchor: &str,
    anchor_until: Option<&str>,
    new_html: &str,
) -> Result<(), String> {
    // Snapshot each top-level block's normalized text up front (owned, so the
    // read-borrow is released before we mutate below).
    let block_texts: Vec<String> = {
        let mut v = Vec::new();
        for node in frag.children(&*txn) {
            v.push(normalize(&xml_block_text(&node, &*txn)));
        }
        v
    };

    let start = resolve_anchor(&block_texts, anchor, "anchor")?;
    let end = match anchor_until {
        None => start,
        Some(until) => {
            let e = resolve_anchor(&block_texts, until, "anchorUntil")?;
            if e < start {
                return Err(
                    "ERR_ANCHOR_RANGE: anchorUntil matches a block before anchor".into(),
                );
            }
            e
        }
    };
    let count = (end - start + 1) as u32;

    let new_blocks = prose_parse::html_to_blocks(new_html);

    frag.remove_range(txn, start as u32, count);
    for (i, node) in new_blocks.iter().enumerate() {
        build_prose_node_at(frag, txn, start as u32 + i as u32, node);
    }
    if frag.len(txn) == 0 {
        build_prose_node(frag, txn, &empty_paragraph());
    }
    Ok(())
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

/// Find the single block whose normalized text equals the anchor's normalized
/// text. `field` names the offending argument in the error.
fn resolve_anchor(block_texts: &[String], raw: &str, field: &str) -> Result<usize, String> {
    let needle = normalize(&anchor_to_text(raw));
    if needle.is_empty() {
        return Err(format!("ERR_ANCHOR_EMPTY: {field} has no text content"));
    }
    let hits: Vec<usize> = block_texts
        .iter()
        .enumerate()
        .filter(|(_, t)| t.as_str() == needle)
        .map(|(i, _)| i)
        .collect();
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

/// All descendant text of one top-level fragment block, concatenated.
fn xml_block_text<T: ReadTxn>(node: &XmlOut, txn: &T) -> String {
    let mut out = String::new();
    collect_xml_text(node, txn, &mut out);
    out
}

fn collect_xml_text<T: ReadTxn>(node: &XmlOut, txn: &T, out: &mut String) {
    match node {
        XmlOut::Element(el) => {
            for child in el.children(txn) {
                collect_xml_text(&child, txn, out);
            }
        }
        XmlOut::Text(t) => {
            for run in t.diff(txn, |_| ()) {
                if let Out::Any(Any::String(s)) = &run.insert {
                    out.push_str(s);
                }
            }
        }
        XmlOut::Fragment(f) => {
            for child in f.children(txn) {
                collect_xml_text(&child, txn, out);
            }
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
}
