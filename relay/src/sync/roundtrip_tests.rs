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
/// a deliberate prompt to wire it). `pm_attr` matters for the span attrs: a
/// `rowspan="9"` probe is an overlong rowspan in a one-row table, which the
/// span-aware normalizer (JP-432 Pillar D) clamps to 1 and the default-skip
/// then erases — so rowspan gets a 2-column, 9-row context where the probe is
/// legal. `colspan="9"` in a one-cell row is already rectangular (width 9).
fn embed_with_attr(pm_type: &str, pm_attr: &str, attr_html: &str) -> String {
    let rowspan_table = |cell: String| {
        let mut rows = format!("<tr>{cell}<td><p>y</p></td></tr>");
        for _ in 1..9 {
            rows.push_str("<tr><td><p>y</p></td></tr>");
        }
        format!("<table>{rows}</table>")
    };
    match (pm_type, pm_attr) {
        ("tableCell", "rowspan") => rowspan_table(format!("<td{attr_html}><p>x</p></td>")),
        ("tableHeader", "rowspan") => rowspan_table(format!("<th{attr_html}><p>x</p></th>")),
        ("paragraph", _) => format!("<p{attr_html}>x</p>"),
        ("heading", _) => format!("<h2{attr_html}>x</h2>"),
        ("orderedList", _) => format!("<ol{attr_html}><li><p>x</p></li></ol>"),
        ("tableCell", _) => format!("<table><tr><td{attr_html}><p>x</p></td></tr></table>"),
        ("tableHeader", _) => format!("<table><tr><th{attr_html}><p>x</p></th></tr></table>"),
        ("codeBlock", _) => format!("<pre{attr_html}><code>x</code></pre>"),
        (other, _) => panic!("embed_with_attr needs a schema-valid context for {other}"),
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
        let out = seed_round_trip(&embed_with_attr(pm_type, pm_attr, &attr_html));
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

// ---- JP-432 Pillar D: cell spans + colwidth ----------------------------------
//
// The 2026-07-11 live silent-loss: a user's merged cell serialized as a lone
// `<td>` with no `colspan` (ragged row) and the next sanitize padded a phantom
// cell into the merge. These pin the span/colwidth round-trip.

#[test]
fn merged_table_spans_and_colwidth_round_trip() {
    // A rectangular 3-wide table: row 0 = a 2-col merged header (with widths)
    // + a normal header; row 1 = a cell spanning down + two normal cells;
    // row 2 = the rowspan-covered row with its two own cells.
    let html = "<table>\
        <tr><th colspan=\"2\" colwidth=\"100,120\"><p>Wide</p></th><th><p>C</p></th></tr>\
        <tr><td rowspan=\"2\"><p>tall</p></td><td><p>b</p></td><td><p>c</p></td></tr>\
        <tr><td><p>d</p></td><td><p>e</p></td></tr>\
        </table>";
    let out = seed_round_trip(html);
    assert!(out.contains("colspan=\"2\""), "colspan lost: {out}");
    assert!(out.contains("colwidth=\"100,120\""), "colwidth lost: {out}");
    assert!(out.contains("rowspan=\"2\""), "rowspan lost: {out}");
    // Span-aware shape (Slice D-2): the rowspan-covered row keeps exactly its
    // two own cells through the FULL seed pipeline — no phantom pad.
    assert!(
        out.contains("<tr><td><p>d</p></td><td><p>e</p></td></tr></table>"),
        "covered row mangled: {out}"
    );
}

#[test]
fn default_spans_normalize_away_and_are_stable() {
    // The editor's getHTML emits `colspan="1" rowspan="1"` on EVERY cell. The
    // parse stores them (matching the editor's own CRDT lineage) and the
    // serializer's default-skip drops them — output is bare and a fixed point
    // from the first trip, so editor-saved pages don't churn through the relay.
    let html = "<table>\
        <tr><th colspan=\"1\" rowspan=\"1\"><p>H</p></th></tr>\
        <tr><td colspan=\"1\" rowspan=\"1\"><p>c</p></td></tr>\
        </table>";
    let once = seed_round_trip(html);
    assert!(!once.contains("colspan"), "default colspan not skipped: {once}");
    assert!(!once.contains("rowspan"), "default rowspan not skipped: {once}");
    let twice = seed_round_trip(&once);
    assert_eq!(once, twice, "default-span normalization not a fixed point");
}

#[test]
fn live_array_colwidth_serializes() {
    use yrs::{Any, Xml, XmlElementPrelim};
    // The editor stores `colwidth` as a NATIVE lib0 array of numbers
    // (y-prosemirror deep-stores PM array attrs), not a string — so the live
    // fragment holds Any::Array. Serialization must render the Tiptap wire
    // form (`colwidth="100,120"`); without the Array arm every editor column
    // resize vanishes on flatten.
    let doc = Doc::new();
    let frag = doc.get_or_insert_xml_fragment("prose:p1");
    {
        let mut txn = doc.transact_mut();
        let table = frag.push_back(&mut txn, XmlElementPrelim::empty("table"));
        let row = table.push_back(&mut txn, XmlElementPrelim::empty("tableRow"));
        let cell = row.push_back(&mut txn, XmlElementPrelim::empty("tableCell"));
        cell.insert_attribute(&mut txn, "colspan", Any::Number(2.0));
        cell.insert_attribute(
            &mut txn,
            "colwidth",
            Any::Array(vec![Any::Number(100.0), Any::Number(120.0)].into()),
        );
        let para = cell.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
        para.push_back(&mut txn, yrs::XmlTextPrelim::new("x"));
    }
    let txn = doc.transact();
    let out = prose_html::fragment_to_html(&frag, &txn);
    assert!(out.contains("colspan=\"2\""), "numeric colspan dropped: {out}");
    assert!(out.contains("colwidth=\"100,120\""), "array colwidth dropped: {out}");
}

// ---- JP-432 Pillar C: durable block ids (passthrough only) -------------------

#[test]
fn explicit_block_ids_round_trip_and_are_a_fixed_point() {
    let html = "<h2 id=\"blk-aaaa\">t</h2><p id=\"blk-bbbb\">x</p>\
        <pre id=\"blk-cccc\"><code class=\"language-rust\">let c;</code></pre>";
    let once = seed_round_trip(html);
    for needle in ["id=\"blk-aaaa\"", "id=\"blk-bbbb\"", "id=\"blk-cccc\"", "language-rust"] {
        assert!(once.contains(needle), "{needle} lost: {once}");
    }
    let twice = seed_round_trip(&once);
    assert_eq!(once, twice, "id round-trip not idempotent:\n once={once}\ntwice={twice}");
}

#[test]
fn sync_layer_never_mints_ids() {
    // JP-338 determinism: content reaching `deterministic_seed_update` must stay
    // a pure function of the input HTML, so id-less blocks stay id-less through
    // this crate — minting lives at the MCP tool layer / editor / migration only.
    let out = seed_round_trip("<h2>t</h2><p>x</p><pre><code>c</code></pre>");
    assert!(!out.contains("id="), "sync layer minted an id: {out}");
}

// ---- JP-432: inline-mark-attribute passthrough (highlight / text colour) ----
// The inline twin of the BLOCK_ATTRS suite above. Before JP-432 the relay's mark
// model was attribute-free, so a highlight's colour and a textStyle's text colour
// were dropped on every parse/serialize — un-seeable / un-settable over MCP and
// lost on any flatten→rehydrate. These pin the MARK_ATTRS round-trip.

/// Minimal editor-shaped HTML embedding a `mark` carrying `attr_html`, wrapped in
/// a paragraph. The registry contract test uses it; a NEW mark in `MARK_ATTRS`
/// resolves its tag from `MARKS` (panics if the mark has no tag — a prompt to
/// wire it).
fn embed_mark_with_attr(mark: &str, attr_html: &str) -> String {
    let tag = super::prose_schema::MARKS
        .iter()
        .find(|(m, _)| *m == mark)
        .map(|(_, t)| *t)
        .unwrap_or_else(|| panic!("mark {mark} in MARK_ATTRS has no MARKS tag"));
    format!("<p><{tag}{attr_html}>x</{tag}></p>")
}

/// Registry-driven contract test (JP-432): every `MARK_ATTRS` row must survive a
/// round-trip — the inline twin of `registry_every_block_attr_round_trips`. A row
/// wired on only one side (parse xor serialize) fails here, so a future coloured
/// mark can't be half-added silently.
#[test]
fn registry_every_mark_attr_round_trips() {
    use super::prose_schema::{AttrEnc, MARK_ATTRS};
    for (mark, pm_attr, enc) in MARK_ATTRS {
        let (attr_html, needle) = match enc {
            AttrEnc::Attr => (format!(" {pm_attr}=\"9\""), format!("{pm_attr}=\"9\"")),
            AttrEnc::Style(prop) => (format!(" style=\"{prop}: probe\""), format!("{prop}: probe")),
        };
        let out = seed_round_trip(&embed_mark_with_attr(mark, &attr_html));
        assert!(
            out.contains(&needle),
            "MARK_ATTRS ({mark}, {pm_attr}) not round-tripped — parse or serialize side unwired: {out}"
        );
    }
}

#[test]
fn highlight_and_text_colour_round_trip() {
    // The exact editor getHTML shape: multicolor Highlight emits data-color +
    // background-color (we read/emit style-only); TextStyle+Color → <span style="color">.
    let html = "<p><mark data-color=\"#ff0\" style=\"background-color: #ff0; color: inherit\">hi</mark>\
        <span style=\"color: rgb(200, 0, 0)\">warn</span></p>";
    let out = seed_round_trip(html);
    assert!(out.contains("background-color: #ff0"), "highlight colour lost: {out}");
    assert!(out.contains("color: rgb(200, 0, 0)"), "text colour lost: {out}");
}

#[test]
fn plain_span_and_bare_marks_stay_bare() {
    // Doc-safety: a plain <span> still unwraps (no empty textStyle mark), and
    // boolean marks emit bare tags with no spurious attrs — additive change.
    let out = seed_round_trip("<p><span>plain</span><strong>b</strong><em>i</em></p>");
    assert!(out.contains("plain"), "plain span text lost: {out}");
    assert!(!out.contains("<span"), "plain span should unwrap, not become a textStyle: {out}");
    assert!(out.contains("<strong>b</strong>"), "bold lost: {out}");
    assert!(!out.contains("style="), "no spurious style on bare marks: {out}");
}

#[test]
fn mark_formatting_round_trip_is_a_fixed_point() {
    let html = "<p><mark style=\"background-color: #abc\">h</mark><span style=\"color: #123\">t</span></p>";
    let once = seed_round_trip(html);
    let twice = seed_round_trip(&once);
    assert_eq!(once, twice, "mark round-trip not idempotent:\n once={once}\ntwice={twice}");
}

// ---- JP-432: node-level parity (task lists, embedded groups, code language, ol type) ----
// Editor-schema nodes the relay previously downgraded or deleted: task lists were
// aliased to bullet lists (checked state lost), embeddedGroup had no handler (the
// node was deleted on read), and codeBlock dropped its language. Each is a live
// silent-loss until wired on both legs.

#[test]
fn task_list_and_checked_state_round_trip() {
    // The editor getHTML shape: <li data-type="taskItem" data-checked> wrapping
    // its content in checkbox chrome (<label><input><span></label><div>…</div>).
    let html = "<ul data-type=\"taskList\">\
        <li data-type=\"taskItem\" data-checked=\"true\"><label><input type=\"checkbox\" checked><span></span></label><div><p>done</p></div></li>\
        <li data-type=\"taskItem\" data-checked=\"false\"><label><input type=\"checkbox\"><span></span></label><div><p>todo</p></div></li>\
        </ul><p>after</p>";
    let out = seed_round_trip(html);
    assert!(out.contains("data-type=\"taskList\""), "taskList downgraded to bullet list: {out}");
    assert!(out.contains("data-checked=\"true\""), "checked item lost: {out}");
    assert!(out.contains("data-checked=\"false\""), "unchecked item lost: {out}");
    assert!(out.contains("done") && out.contains("todo"), "task content lost: {out}");
    assert!(out.contains("<p>after</p>"), "trailing sibling lost: {out}");
    assert!(!out.contains("<input"), "checkbox chrome leaked into stored HTML: {out}");
}

#[test]
fn task_list_round_trip_is_a_fixed_point() {
    let html = "<ul data-type=\"taskList\"><li data-type=\"taskItem\" data-checked=\"true\"><p>x</p></li></ul>";
    let once = seed_round_trip(html);
    let twice = seed_round_trip(&once);
    assert_eq!(once, twice, "task list not idempotent:\n once={once}\ntwice={twice}");
}

#[test]
fn code_block_language_round_trips() {
    let out = seed_round_trip("<pre><code class=\"language-rust\">fn main() {}</code></pre>");
    assert!(out.contains("class=\"language-rust\""), "code language lost: {out}");
    assert!(out.contains("fn main()"), "code content lost: {out}");
}

#[test]
fn code_block_without_language_stays_bare() {
    let out = seed_round_trip("<pre><code>plain</code></pre>");
    assert!(out.contains("<pre><code>plain</code></pre>"), "bare code block gained markup: {out}");
    assert!(!out.contains("language-"), "bare code block gained a language class: {out}");
}

#[test]
fn embedded_group_survives_round_trip() {
    let html = "<p>before</p>\
        <div data-type=\"embedded-group\" data-group-id=\"grp-1\" data-group-name=\"Arch\"></div>\
        <p>after</p>";
    let out = seed_round_trip(html);
    assert!(out.contains("data-type=\"embedded-group\""), "embedded group deleted on read: {out}");
    assert!(out.contains("data-group-id=\"grp-1\""), "group id lost: {out}");
    assert!(out.contains("data-group-name=\"Arch\""), "group name lost: {out}");
    assert!(out.contains("<p>before</p>") && out.contains("<p>after</p>"), "siblings lost: {out}");
}

#[test]
fn ordered_list_type_round_trips() {
    let out = seed_round_trip("<ol type=\"a\" start=\"3\"><li><p>c</p></li></ol>");
    assert!(out.contains("type=\"a\""), "ol type lost: {out}");
    assert!(out.contains("start=\"3\""), "ol start lost: {out}");
}

#[test]
fn bibliography_scope_round_trips() {
    // Found by the bidirectional schema-contract guard: scope='all' (show every
    // reference, not just cited) must survive; default 'cited' stays bare.
    let all = seed_round_trip("<div data-bibliography data-bib-html=\"refs\" data-scope=\"all\"></div>");
    assert!(all.contains("data-scope=\"all\""), "bibliography scope=all lost: {all}");
    let cited = seed_round_trip("<div data-bibliography data-bib-html=\"refs\"></div>");
    assert!(!cited.contains("data-scope"), "default cited scope gained a spurious attr: {cited}");
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

// ---- JP-468: inline images must be lifted, never deleted -------------------
//
// The editor's image node is a BLOCK atom whose `parseHTML` is `img[src]` with
// no context restriction, so ProseMirror LIFTS an inline `<img>` out of its
// paragraph (splitting it) — while this parser's unknown-inline arm used to
// "unwrap to children", which for a void tag meant silent deletion. Every MCP
// markdown image (`![alt](src)` → pulldown's `<p><img/></p>`) died there, and
// text closed over the gap. These pin PM-parity lift semantics.
mod inline_image_lift {
    use super::*;

    #[test]
    fn inline_image_is_lifted_not_deleted() {
        let out = seed_round_trip(
            "<p id=\"blk-x\">before<img src=\"blob://a\" alt=\"pic\">after</p>",
        );
        // PM parity (probed against the real editor schema): first half keeps
        // the block's id, the image becomes a block sibling, the continuation
        // paragraph carries no id.
        assert_eq!(
            out, "<p id=\"blk-x\">before</p><img src=\"blob://a\" alt=\"pic\"><p>after</p>",
            "inline image must split the paragraph, not vanish"
        );
    }

    #[test]
    fn image_only_paragraph_lifts_to_bare_image() {
        let out = seed_round_trip("<p><img src=\"blob://a\"></p>");
        assert_eq!(
            out, "<img src=\"blob://a\">",
            "an image-only paragraph must yield the image block alone (no empty <p> pair)"
        );
    }

    #[test]
    fn markdown_image_survives_the_seed_pipeline() {
        // The exact HTML the MCP markdown path emits for `![diagram](blob://m1)`
        // inside a sentence — the shape that was deleted on every write.
        let html = crate::mcp::tools::markdown_to_html_for_tests(
            "See ![diagram](blob://m1) for detail.",
        );
        let out = seed_round_trip(&html);
        assert!(
            out.contains("<img src=\"blob://m1\" alt=\"diagram\">"),
            "markdown image deleted by the seed pipeline: {out}"
        );
        assert!(out.contains("See") && out.contains("for detail."), "text lost: {out}");
    }

    #[test]
    fn marked_text_around_an_inline_image_keeps_its_marks() {
        let out = seed_round_trip(
            "<p><strong>bold before</strong><img src=\"blob://a\"><em>italic after</em></p>",
        );
        assert_eq!(
            out,
            "<p><strong>bold before</strong></p><img src=\"blob://a\"><p><em>italic after</em></p>",
            "marks must survive on their own halves of the split"
        );
    }

    #[test]
    fn nested_inline_image_lifts_from_any_depth() {
        // PM lifts from inside marks too — the img is not a child of the <a>,
        // it splits the whole block.
        let out = seed_round_trip("<p>x<a href=\"https://y.test\">link<img src=\"blob://a\">tail</a>z</p>");
        assert!(
            out.contains("<img src=\"blob://a\">"),
            "img nested in a mark run must still be lifted, not deleted: {out}"
        );
        for kept in ["x", "link", "tail", "z"] {
            assert!(out.contains(kept), "text {kept:?} lost: {out}");
        }
    }

    #[test]
    fn gallery_and_figure_images_are_untouched_by_the_lift() {
        // The explicit gallery/figure arms already own their imgs; the lift
        // must not double-handle them.
        let g = seed_round_trip(&gallery_html("<img src=\"blob://g1\"><img src=\"blob://g2\">"));
        assert_eq!(g.matches("<img").count(), 2, "gallery images disturbed: {g}");
        let f = seed_round_trip(
            "<figure><img src=\"blob://f1\"><figcaption>cap</figcaption></figure>",
        );
        assert_eq!(f.matches("<img").count(), 1, "figure image disturbed: {f}");
    }
}
