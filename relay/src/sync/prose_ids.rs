//! Durable block-id census + fill (JP-432 Pillar C).
//!
//! The fill is the sync crate's ONLY entry point for assigning missing block
//! ids, and it cannot mint by itself: the generator is **injected** by the
//! caller (the MCP tool layer), so this crate stays RNG-free. That enforces
//! the JP-338 invariant by construction — content reaching
//! `deterministic_seed_update` is a pure function of the stored HTML, because
//! nothing on the parse/serialize/seed paths can reach a generator. Where the
//! fill is *allowed* to run (and where it must not — a live whole-page write
//! into an empty fragment) is the tool layer's gate, documented at its
//! `fill_ids_for_page_write`.

use std::collections::HashSet;

use yrs::{Doc, Transact};

use super::prose_block::TEXT_LEAVES;
use super::prose_parse::{self, PmChild, PmNode};
use super::{build_prose_node, prose_html};

/// Ids present on id-bearing blocks ([`TEXT_LEAVES`]) in `html`, in document
/// order, duplicates kept — the census the tool layer feeds back into
/// [`fill_block_ids`] as `taken` when writing a fragment of a page.
pub fn collect_block_ids(html: &str) -> Vec<String> {
    fn walk(node: &PmNode, out: &mut Vec<String>) {
        if TEXT_LEAVES.contains(&node.node_type.as_str()) {
            if let Some((_, v)) = node.attrs.iter().find(|(k, _)| k == "id") {
                if !v.is_empty() {
                    out.push(v.clone());
                }
            }
            return; // a leaf holds only inline content
        }
        for c in &node.children {
            if let PmChild::Node(n) = c {
                walk(n, out);
            }
        }
    }
    let mut out = Vec::new();
    for b in &prose_parse::html_to_blocks(html) {
        walk(b, &mut out);
    }
    out
}

/// Every inline citation in `html`, as `(refId, blockId)` pairs in document
/// order — the census `delete_reference` uses to decide whether removing a
/// library entry would strand citations, and to say *where* if it would.
///
/// The `blockId` is the id of the nearest enclosing id-bearing block, or empty
/// when that block carries none (ids are fill-on-write, so older content has
/// gaps). Duplicates are kept: a reference cited three times reports three
/// times, which is the number a caller wants when weighing a `force` delete.
///
/// Reads the document model rather than scanning the HTML for `data-ref-id`.
/// That is not fastidiousness — a bibliography's `data-bib-html` attribute
/// carries *escaped* markup that can itself contain citation spans, and a text
/// scan would count those as live citations and refuse a delete that is
/// actually safe.
pub fn collect_citations(html: &str) -> Vec<(String, String)> {
    fn walk(node: &PmNode, block_id: &str, out: &mut Vec<(String, String)>) {
        // An id-bearing block relabels its subtree; anything else inherits.
        let here = if TEXT_LEAVES.contains(&node.node_type.as_str()) {
            node.attrs
                .iter()
                .find(|(k, _)| k == "id")
                .map(|(_, v)| v.as_str())
                .unwrap_or("")
        } else {
            block_id
        };
        for c in &node.children {
            if let PmChild::Node(n) = c {
                if n.node_type == "citationInline" {
                    if let Some((_, ref_id)) = n.attrs.iter().find(|(k, _)| k == "refId") {
                        if !ref_id.is_empty() {
                            out.push((ref_id.clone(), here.to_string()));
                        }
                    }
                }
                walk(n, here, out);
            }
        }
    }
    let mut out = Vec::new();
    for b in &prose_parse::html_to_blocks(html) {
        walk(b, "", &mut out);
    }
    out
}


/// Fill-only-if-absent: assign `mint()` to every id-bearing block whose id is
/// missing, empty, collides with `taken` (ids already on the page outside this
/// content), or duplicates an earlier block in this content — the first
/// occurrence keeps its id. Returns the input string unchanged (byte-for-byte)
/// when nothing needed filling, so an already-complete page never churns
/// through a parse/serialize normalization.
pub fn fill_block_ids(
    html: &str,
    taken: &HashSet<String>,
    mint: &mut dyn FnMut() -> String,
) -> String {
    let mut blocks = prose_parse::html_to_blocks(html);
    if !fill_blocks(&mut blocks, taken, mint) {
        return html.to_string();
    }
    blocks_to_html(&blocks)
}

/// The parsed-tree form of [`fill_block_ids`] — used inside the anchored write
/// ops (`prose_block`), where the replaced span's ids are known and excluded
/// from `taken` so pasted-back content keeps its own block's id. Returns
/// whether anything was filled.
pub(super) fn fill_blocks(
    blocks: &mut [PmNode],
    taken: &HashSet<String>,
    mint: &mut dyn FnMut() -> String,
) -> bool {
    let mut seen: HashSet<String> = HashSet::new();
    let mut changed = false;
    for b in blocks.iter_mut() {
        fill_node(b, taken, &mut seen, mint, &mut changed);
    }
    changed
}

fn fill_node(
    node: &mut PmNode,
    taken: &HashSet<String>,
    seen: &mut HashSet<String>,
    mint: &mut dyn FnMut() -> String,
    changed: &mut bool,
) {
    if TEXT_LEAVES.contains(&node.node_type.as_str()) {
        let idx = node.attrs.iter().position(|(k, _)| k == "id");
        let current = idx.map(|i| node.attrs[i].1.as_str()).unwrap_or_default();
        if !current.is_empty() && !taken.contains(current) && !seen.contains(current) {
            seen.insert(current.to_string());
        } else {
            let id = mint();
            seen.insert(id.clone());
            match idx {
                Some(i) => node.attrs[i].1 = id,
                None => node.attrs.push(("id".to_string(), id)),
            }
            *changed = true;
        }
        return; // a leaf holds only inline content
    }
    for c in &mut node.children {
        if let PmChild::Node(n) = c {
            fill_node(n, taken, seen, mint, changed);
        }
    }
}

/// Re-serialize mutated blocks through a scratch fragment — the same
/// build/serialize pair every cold-path surgery uses, so the fill can't
/// normalize differently from the write path that follows it.
pub(super) fn blocks_to_html(blocks: &[PmNode]) -> String {
    let doc = Doc::new();
    let frag = doc.get_or_insert_xml_fragment("prose:scratch");
    {
        let mut txn = doc.transact_mut();
        for b in blocks {
            build_prose_node(&frag, &mut txn, b);
        }
    }
    let txn = doc.transact();
    prose_html::fragment_to_html(&frag, &txn)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Deterministic injected generator — the unit-test stand-in for the tool
    /// layer's nanoid mint.
    fn counter() -> impl FnMut() -> String {
        let mut n = 0u32;
        move || {
            n += 1;
            format!("blk-test-{n:04}")
        }
    }

    #[test]
    fn collects_leaf_ids_in_document_order_keeping_duplicates() {
        let html = "<h2 id=\"blk-a\">t</h2><ul><li><p id=\"blk-b\">x</p></li>\
             <li><p id=\"blk-b\">y</p></li></ul><p>bare</p>";
        assert_eq!(collect_block_ids(html), vec!["blk-a", "blk-b", "blk-b"]);
    }

    #[test]
    fn fills_only_missing_ids_and_keeps_existing() {
        let mut mint = counter();
        let out = fill_block_ids("<h2 id=\"blk-keep\">t</h2><p>x</p>", &HashSet::new(), &mut mint);
        assert!(out.contains("id=\"blk-keep\""), "existing id lost: {out}");
        assert!(out.contains("id=\"blk-test-0001\""), "missing id not filled: {out}");
    }

    #[test]
    fn returns_input_unchanged_when_nothing_to_fill() {
        // Byte-for-byte passthrough — an already-complete page never churns
        // through parse/serialize normalization (whitespace, attr order).
        let html = "<h2   id=\"blk-a\">t</h2><p id=\"blk-b\">x</p>";
        let mut mint = counter();
        let out = fill_block_ids(html, &HashSet::new(), &mut mint);
        assert_eq!(out, html);
    }

    #[test]
    fn remints_ids_colliding_with_taken() {
        // Pasted-back get_prose output: its ids already live on the page, so
        // the incoming copy is re-minted instead of poisoning resolution.
        let taken: HashSet<String> = ["blk-onpage".to_string()].into();
        let mut mint = counter();
        let out = fill_block_ids("<p id=\"blk-onpage\">copy</p>", &taken, &mut mint);
        assert!(!out.contains("blk-onpage"), "taken id not re-minted: {out}");
        assert!(out.contains("blk-test-0001"), "re-mint missing: {out}");
    }

    #[test]
    fn remints_later_in_content_duplicates_keeping_the_first() {
        let mut mint = counter();
        let out = fill_block_ids(
            "<p id=\"blk-dup\">first</p><p id=\"blk-dup\">second</p>",
            &HashSet::new(),
            &mut mint,
        );
        assert!(out.contains("<p id=\"blk-dup\">first</p>"), "first occurrence lost: {out}");
        assert!(out.contains("<p id=\"blk-test-0001\">second</p>"), "duplicate kept: {out}");
    }

    #[test]
    fn fills_nested_leaves_and_empty_id_values() {
        let mut mint = counter();
        let out = fill_block_ids(
            "<blockquote><p>quoted</p></blockquote><pre id=\"\"><code>c</code></pre>",
            &HashSet::new(),
            &mut mint,
        );
        assert!(out.contains("<p id=\"blk-test-0001\">quoted</p>"), "nested leaf unfilled: {out}");
        assert!(out.contains("<pre id=\"blk-test-0002\">"), "empty id not replaced: {out}");
    }
}
