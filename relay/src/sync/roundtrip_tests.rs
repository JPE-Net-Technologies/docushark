//! JP-428 prose round-trip fidelity harness.
//!
//! Drives editor-shaped HTML through the exact production seed pipeline —
//! `html_to_blocks → sanitize_blocks → seed_prose_deterministic` — then back
//! out through `fragment_to_html`, asserting two invariants:
//!
//! 1. **Siblings always survive.** A node that fails to parse/validate may
//!    degrade (unwrap to children, drop an unusable atom) but must NEVER take
//!    content after it. The `<p>after</p>` trailer on every fixture is the
//!    canary.
//! 2. **Known nodes are fidelity-stable.** Galleries, images (including
//!    numeric width/height as the live y-prosemirror binding stores them),
//!    figures, bibliographies with browser-shaped attribute escaping, and
//!    math atoms survive the trip they take on every JSON rebuild.
//!
//! These exist because the first JP-185 E2E lost a gallery and trailing prose
//! from version content; the fixtures pin every defect found in that
//! investigation (JP-428).

use yrs::{Doc, Transact, XmlFragment};

use super::{prose_html, prose_parse, prose_validate};

/// The production seed pipeline (hydration's `json_prose_to_ydoc` body) for a
/// single page, returning the re-serialized HTML.
fn seed_round_trip(html: &str) -> String {
    let (blocks, _fixes) = prose_validate::sanitize_blocks(prose_parse::html_to_blocks(html));
    let doc = Doc::new();
    super::seed_prose_deterministic(&doc, "p1", &blocks);
    let frag = doc.get_or_insert_xml_fragment("prose:p1");
    let txn = doc.transact();
    prose_html::fragment_to_html(&frag, &txn)
}

/// Editor-shaped gallery markup (GalleryExtension.renderHTML): outer
/// `div[data-gallery]` + inner `div.gallery-items` holding bare `<img>`s.
fn gallery_html(imgs: &str) -> String {
    format!(
        "<div data-gallery=\"\" class=\"prose-gallery\" data-layout=\"grid\">\
         <div class=\"gallery-items\">{imgs}</div></div>"
    )
}

#[test]
fn gallery_round_trips_with_trailing_content() {
    let html = format!(
        "<p>before</p>{}<p>after</p>",
        gallery_html(
            "<img src=\"blob://aaa\" alt=\"one\" width=\"220\">\
             <img src=\"blob://bbb\" data-float=\"left\">"
        )
    );
    let out = seed_round_trip(&html);
    assert!(out.contains("<p>before</p>"), "leading sibling lost: {out}");
    assert!(out.contains("<p>after</p>"), "trailing sibling lost: {out}");
    assert!(out.contains("data-gallery"), "gallery node lost: {out}");
    assert!(
        out.contains("src=\"blob://aaa\"") && out.contains("src=\"blob://bbb\""),
        "gallery images lost: {out}"
    );
    assert!(out.contains("width=\"220\""), "image width lost: {out}");
}

#[test]
fn gallery_with_unusable_images_degrades_without_taking_siblings() {
    // Src-less images make the gallery unusable; it must degrade (drop/unwrap),
    // never swallowing what follows.
    let html = format!("{}<p>after</p>", gallery_html("<img alt=\"broken\">"));
    let out = seed_round_trip(&html);
    assert!(out.contains("<p>after</p>"), "trailing sibling lost: {out}");
    assert!(!out.contains("<img>"), "src-less img must not survive: {out}");
}

#[test]
fn image_alt_with_raw_angle_brackets_survives() {
    // Browsers do NOT escape `>` (or `<`) inside attribute values — only `&`
    // and `"`. Editor getHTML → richTextPages carries this shape, and the
    // rehydrate seed must not corrupt on it. (Images are block-level in the
    // editor schema, so the fixture places it between paragraphs.)
    let html = "<p>x</p><img src=\"blob://ccc\" alt=\"a > b\"><p>after</p>";
    let out = seed_round_trip(html);
    assert!(out.contains("<p>x</p>"), "leading sibling lost: {out}");
    assert!(out.contains("<p>after</p>"), "trailing sibling lost: {out}");
    assert!(out.contains("src=\"blob://ccc\""), "image lost: {out}");
    assert!(out.contains("alt=\"a &gt; b\""), "alt mangled: {out}");
}

#[test]
fn bibliography_with_browser_escaped_bib_html_survives() {
    // Browser attribute serialization: `"` → `&quot;`, `&` → `&amp;`, but `<`
    // and `>` stay RAW. This is exactly what a client REST save stores for a
    // bibliography, and what the JSON-rebuild seed must parse.
    let html = "<div data-bibliography=\"\" \
                data-bib-html=\"<div class=&quot;csl-entry&quot;>Knuth, D.</div>\"></div>\
                <p>after</p>";
    let out = seed_round_trip(html);
    assert!(out.contains("<p>after</p>"), "trailing sibling lost: {out}");
    assert!(out.contains("data-bibliography"), "bibliography lost: {out}");
    assert!(out.contains("csl-entry"), "bibliography payload lost: {out}");
}

#[test]
fn callout_wrapping_bibliography_keeps_structure() {
    let html = "<div data-callout=\"\" data-variant=\"note\">\
                <div data-bibliography=\"\" data-bib-html=\"<span>Ref</span>\"></div>\
                <p>inside</p></div><p>after</p>";
    let out = seed_round_trip(html);
    assert!(out.contains("<p>after</p>"), "trailing sibling lost: {out}");
    assert!(out.contains("data-callout"), "callout lost: {out}");
    assert!(out.contains("<p>inside</p>"), "callout content lost: {out}");
}

#[test]
fn figure_round_trips_and_srcless_figure_degrades() {
    let ok = seed_round_trip(
        "<figure><img src=\"blob://ddd\"><figcaption>cap</figcaption></figure><p>after</p>",
    );
    assert!(ok.contains("<figure>"), "figure lost: {ok}");
    assert!(ok.contains("cap"), "figcaption lost: {ok}");
    assert!(ok.contains("<p>after</p>"), "trailing sibling lost: {ok}");

    let degraded = seed_round_trip("<figure><img alt=\"x\"></figure><p>after</p>");
    assert!(degraded.contains("<p>after</p>"), "trailing sibling lost: {degraded}");
}

#[test]
fn citation_and_field_in_table_cell_round_trip() {
    let html = "<table><tr><td><p>see <span data-citation data-ref-id=\"k97\" \
                data-label=\"(Knuth, 1997)\">(Knuth, 1997)</span> and <span data-field \
                data-name=\"Version\" data-label=\"1.0\">1.0</span></p></td></tr></table>\
                <p>after</p>";
    let out = seed_round_trip(html);
    assert!(out.contains("<p>after</p>"), "trailing sibling lost: {out}");
    assert!(out.contains("data-citation"), "citation lost: {out}");
    assert!(out.contains("data-field"), "field lost: {out}");
}

#[test]
fn math_only_page_has_substance_and_seeds() {
    // A page whose only content is math must seed on JSON rebuild — the
    // substance gate treating math atoms as empty left math-only pages blank
    // after every rehydrate.
    let doc_json = serde_json::json!({
        "richTextPages": {
            "pageOrder": ["m1"],
            "pages": {"m1": {"content":
                "<div data-math-block data-latex=\"E = mc^2\"></div>"}}
        }
    });
    let doc = Doc::new();
    super::hydration::json_prose_to_ydoc(&doc_json, &doc);
    let frag = doc.get_or_insert_xml_fragment("prose:m1");
    let len = frag.len(&doc.transact());
    assert!(len > 0, "math-only page failed to seed (fragment empty)");
    let txn = doc.transact();
    let out = prose_html::fragment_to_html(&frag, &txn);
    assert!(out.contains("data-latex=\"E = mc^2\""), "math payload lost: {out}");
}

#[test]
fn sanitize_drops_imageless_gallery_before_it_reaches_a_client() {
    use super::prose_parse::{PmChild, PmNode};
    // A gallery whose children hold no image would make the client's
    // schema.node() throw — and y-prosemirror deletes the node from the live
    // Y.Doc on that throw, poisoning every later capture. The write gate must
    // degrade it instead.
    let gallery = PmNode {
        node_type: "gallery".to_string(),
        attrs: vec![("layout".to_string(), "grid".to_string())],
        children: vec![PmChild::Node(PmNode {
            node_type: "paragraph".to_string(),
            attrs: vec![],
            children: vec![PmChild::Text { text: "stray".to_string(), marks: vec![] }],
        })],
    };
    let after = PmNode {
        node_type: "paragraph".to_string(),
        attrs: vec![],
        children: vec![PmChild::Text { text: "after".to_string(), marks: vec![] }],
    };
    let (out, _fixes) = prose_validate::sanitize_blocks(vec![gallery, after]);
    let has_bad_gallery = out.iter().any(|n| {
        n.node_type == "gallery"
            && !n
                .children
                .iter()
                .any(|c| matches!(c, PmChild::Node(inner) if inner.node_type == "image"))
    });
    assert!(!has_bad_gallery, "image-less gallery must not pass the gate: {out:?}");
    assert!(
        out.iter().any(|n| matches!(
            n.children.first(),
            Some(PmChild::Text { text, .. }) if text == "after"
        )),
        "sibling after the degraded gallery lost: {out:?}"
    );
}

#[test]
fn live_numeric_image_attrs_serialize() {
    use yrs::{Any, Xml, XmlElementPrelim};
    // The editor stores image width/height as NUMBERS (resize writes
    // offsetWidth; gallery inserts width: 220) and y-prosemirror stores attrs
    // raw — so the live fragment holds Any::Number, not strings. Serialization
    // must not drop them (they vanish on every flatten/version otherwise).
    let doc = Doc::new();
    let frag = doc.get_or_insert_xml_fragment("prose:p1");
    {
        let mut txn = doc.transact_mut();
        let img = frag.push_back(&mut txn, XmlElementPrelim::empty("image"));
        img.insert_attribute(&mut txn, "src", "blob://eee");
        img.insert_attribute(&mut txn, "width", Any::Number(220.0));
        img.insert_attribute(&mut txn, "height", Any::BigInt(140));
    }
    let txn = doc.transact();
    let out = prose_html::fragment_to_html(&frag, &txn);
    assert!(out.contains("src=\"blob://eee\""), "src lost: {out}");
    assert!(out.contains("width=\"220\""), "numeric width dropped: {out}");
    assert!(out.contains("height=\"140\""), "numeric height dropped: {out}");
}

// ---- JP-429: block-attribute formatting passthrough --------------------------
//
// The relay prose model was attribute-free for blocks, so a table header's colour
// or a paragraph's alignment (attrs the editor persists on the node) were dropped
// on every parse/serialize — un-seeable and un-settable over MCP, and lost on any
// flatten→rehydrate. These pin the round-trip for the declarative BLOCK_ATTRS
// registry. Written red-first: they fail on the pre-JP-429 attribute-free code.

/// Minimal editor-shaped HTML embedding a node of `pm_type` with `attr_html` in
/// its open tag, in a schema-valid position. The registry contract test uses it;
/// a NEW node type in `BLOCK_ATTRS` must add a case here (else the test panics —
/// a deliberate prompt to wire it).
fn embed_with_attr(pm_type: &str, attr_html: &str) -> String {
    match pm_type {
        "paragraph" => format!("<p{attr_html}>x</p>"),
        "heading" => format!("<h2{attr_html}>x</h2>"),
        "orderedList" => format!("<ol{attr_html}><li><p>x</p></li></ol>"),
        "tableCell" => format!("<table><tr><td{attr_html}><p>x</p></td></tr></table>"),
        "tableHeader" => format!("<table><tr><th{attr_html}><p>x</p></th></tr></table>"),
        other => panic!("embed_with_attr needs a schema-valid context for {other}"),
    }
}

/// Registry-driven contract test (JP-429): every `BLOCK_ATTRS` row must survive a
/// round-trip. A row wired on only one side (parse xor serialize) fails here — so
/// a future formatting attribute can't be half-added silently.
#[test]
fn registry_every_block_attr_round_trips() {
    use super::prose_schema::{AttrEnc, BLOCK_ATTRS};
    for (pm_type, pm_attr, enc) in BLOCK_ATTRS {
        let (attr_html, needle) = match enc {
            AttrEnc::Attr => (format!(" {pm_attr}=\"9\""), format!("{pm_attr}=\"9\"")),
            AttrEnc::Style(prop) => (format!(" style=\"{prop}: probe\""), format!("{prop}: probe")),
        };
        let out = seed_round_trip(&embed_with_attr(pm_type, &attr_html));
        assert!(
            out.contains(&needle),
            "BLOCK_ATTRS ({pm_type}, {pm_attr}) not round-tripped — parse or serialize side unwired: {out}"
        );
    }
}

#[test]
fn table_cell_background_align_and_scope_round_trip() {
    // The exact editor getHTML shape: TableCell/TableHeader.extend merges
    // backgroundColor + align into one `style`, header adds `scope`.
    let html = "<table>\
        <tr><th style=\"background-color: #eef; text-align: center\" scope=\"col\"><p>H</p></th></tr>\
        <tr><td style=\"background-color: rgb(240, 240, 240); text-align: right\"><p>c</p></td></tr>\
        </table>";
    let out = seed_round_trip(html);
    assert!(out.contains("background-color: #eef"), "th bg lost: {out}");
    assert!(out.contains("text-align: center"), "th align lost: {out}");
    assert!(out.contains("scope=\"col\""), "th scope lost: {out}");
    assert!(out.contains("background-color: rgb(240, 240, 240)"), "td bg lost: {out}");
    assert!(out.contains("text-align: right"), "td align lost: {out}");
}

#[test]
fn paragraph_and_heading_text_align_round_trip() {
    let html = "<h2 style=\"text-align: center\">Title</h2><p style=\"text-align: right\">body</p>";
    let out = seed_round_trip(html);
    assert!(out.contains("<h2 style=\"text-align: center\">"), "heading align lost: {out}");
    assert!(out.contains("<p style=\"text-align: right\">"), "paragraph align lost: {out}");
}

#[test]
fn ordered_list_start_round_trips() {
    let out = seed_round_trip("<ol start=\"3\"><li><p>c</p></li></ol>");
    assert!(out.contains("start=\"3\""), "ol start lost: {out}");
}

#[test]
fn unformatted_block_stays_bare_no_spurious_markup() {
    // Doc-safety (additive change): the pre-JP-429 stored shape gains no markup,
    // so existing docs are untouched by the new attribute plumbing.
    let out = seed_round_trip("<table><tr><td><p>x</p></td></tr></table><p>y</p>");
    assert!(out.contains("<td><p>x</p></td>"), "bare cell gained markup: {out}");
    assert!(out.contains("<p>y</p>"), "bare paragraph gained markup: {out}");
    assert!(!out.contains("style="), "no spurious style attr: {out}");
}

#[test]
fn formatting_round_trip_is_a_fixed_point() {
    // Idempotence: the merged `style` string must be deterministic + re-parseable,
    // so editor→relay→relay doesn't drift the attribute shape.
    let html = "<h1 style=\"text-align: center\">T</h1>\
        <table><tr><th style=\"background-color: #fff; text-align: left\" scope=\"col\"><p>h</p></th></tr></table>";
    let once = seed_round_trip(html);
    let twice = seed_round_trip(&once);
    assert_eq!(once, twice, "formatting round-trip not idempotent:\n once={once}\ntwice={twice}");
}

// ---- JP-428: recovery-point reconstruction semantics ----
// "The version wins wherever the point's doc carries the corresponding root;
// absence never erases."

#[cfg(test)]
mod reconstruction {
    use super::super::DocHandle;
    use serde_json::json;
    use yrs::{Any, Doc, Map, Transact, XmlFragment, XmlTextPrelim};

    /// A scaffold body with two canvas pages (both with shapes) and one prose
    /// page with content — the CURRENT doc a recovery point flattens over.
    fn scaffold() -> serde_json::Value {
        json!({
            "id": "d", "serverVersion": 3, "activePageId": "p1",
            "pages": {
                "p1": {"id": "p1", "shapes": {"s1": {"id": "s1"}}, "shapeOrder": ["s1"]},
                "p2": {"id": "p2", "shapes": {"s2": {"id": "s2"}}, "shapeOrder": ["s2"]}
            },
            "richTextPages": {"pageOrder": ["r1"], "pages": {
                "r1": {"id": "r1", "name": "Notes", "content": "<p>current text</p>"}
            }}
        })
    }

    #[test]
    fn pages_absent_from_the_point_are_left_untouched() {
        // The point's doc carries ONLY p1 (captured before p2 existed) and no
        // prose roots. p2's shapes and r1's prose must survive reconstruction.
        let point = Doc::new();
        {
            let shapes = point.get_or_insert_map("shapes:p1");
            let mut txn = point.transact_mut();
            shapes.insert(&mut txn, "s9", Any::String("from-version".into()));
        }
        let handle = DocHandle::from_decoded(point, Some("p1".to_string()));
        let mut json = scaffold();
        assert!(handle.flatten_into(&mut json));

        assert!(
            json["pages"]["p1"]["shapes"]["s9"].is_string(),
            "point's page content must win: {json}"
        );
        assert!(
            json["pages"]["p2"]["shapes"]["s2"].is_object(),
            "page absent from the point must keep current shapes: {json}"
        );
        assert_eq!(
            json["richTextPages"]["pages"]["r1"]["content"], "<p>current text</p>",
            "prose absent from the point must keep current content"
        );
    }

    #[test]
    fn present_but_empty_root_restores_the_cleared_state() {
        // The point carries p2's root EMPTY (cleared before capture) and an
        // EMPTY prose root for r1 — a cleared surface restores cleared.
        let point = Doc::new();
        {
            let shapes1 = point.get_or_insert_map("shapes:p1");
            let _shapes2 = point.get_or_insert_map("shapes:p2");
            let _prose = point.get_or_insert_xml_fragment("prose:r1");
            let mut txn = point.transact_mut();
            shapes1.insert(&mut txn, "s1", Any::String("kept".into()));
        }
        let handle = DocHandle::from_decoded(point, Some("p1".to_string()));
        let mut json = scaffold();
        assert!(handle.flatten_into(&mut json));

        assert_eq!(
            json["pages"]["p2"]["shapes"].as_object().map(|m| m.len()),
            Some(0),
            "present-but-empty shapes root restores the cleared page: {json}"
        );
        assert_eq!(
            json["richTextPages"]["pages"]["r1"]["content"], "",
            "present-but-empty prose root clears the JSON copy: {json}"
        );
    }

    #[test]
    fn non_empty_prose_root_overlays_the_version_content() {
        let point = Doc::new();
        {
            let _shapes = point.get_or_insert_map("shapes:p1");
            let prose = point.get_or_insert_xml_fragment("prose:r1");
            let mut txn = point.transact_mut();
            let p = prose.push_back(&mut txn, yrs::XmlElementPrelim::empty("paragraph"));
            p.push_back(&mut txn, XmlTextPrelim::new("version text"));
        }
        let handle = DocHandle::from_decoded(point, Some("p1".to_string()));
        let mut json = scaffold();
        assert!(handle.flatten_into(&mut json));
        assert_eq!(
            json["richTextPages"]["pages"]["r1"]["content"], "<p>version text</p>",
            "point's prose must win: {json}"
        );
    }
}
