//! JP-468 multi-lineage lifecycle harness.
//!
//! Every prose guard before this file was single-lineage and one-shot:
//! `roundtrip_tests` drives HTML→seed→HTML in one relay-authored pass,
//! `yjs_fixtures` sends relay-authored bytes to JS one way, and the JP-338
//! heal tests cover exact 2× doubles. None of them exercise the **document
//! lifecycle**: seed → foreign client edits → flatten → evict → REhydrate →
//! resync. That lifecycle is where JP-468's corruption lived:
//!
//! `seed_prose_deterministic`'s client id was a pure function of the page id,
//! so a rehydrate that fell back to the JSON path (stale/absent sidecar)
//! re-seeded **evolved** content under the **same** `(client id, clock)`
//! range as the original seed — a CRDT identity collision. Peers holding the
//! first lineage skip the overlapping clocks, splice the re-seed's tail at
//! foreign origins, and permanently fork: the relay's next flatten shows
//! mid-word splices and doubled blocks while the live client reads clean.
//!
//! These tests run the real `DocHandle::hydrate` twice around a simulated
//! client (a plain yrs `Doc` standing in for the editor's y-indexeddb room)
//! and assert the one property that matters: **after a full two-way sync,
//! relay and client converge on the edited content** — no duplicated blocks,
//! no spliced sentences, no duplicate block ids.

use serde_json::{json, Value};
use yrs::updates::decoder::Decode;
use yrs::{Doc, ReadTxn, Transact, Update, Xml, XmlElementPrelim, XmlFragment, XmlTextPrelim};

use super::{prose_html, prose_parse, prose_validate, DocHandle};

const SENTENCE: &str = "Does the tempo of background instrumental music change how many words a \
                        person can recall from a short study list?";

/// The v1 stored body: one canvas page, one prose page holding a title + the
/// sentence + a flag paragraph (ids on every leaf, as the editor mints them).
fn json_v1() -> Value {
    json!({
        "id": "doc-1",
        "version": 2,
        "serverVersion": 1,
        "name": "lifecycle",
        "activePageId": "page-1",
        "pages": { "page-1": { "id": "page-1", "shapes": {}, "shapeOrder": [] } },
        "pageOrder": ["page-1"],
        "richTextPages": {
            "pages": {
                "rt-page-1": {
                    "id": "rt-page-1",
                    "name": "Notes",
                    "content": format!(
                        "<h1 id=\"blk-head01\">Title</h1>\
                         <p id=\"blk-sent01\">{SENTENCE}</p>\
                         <p id=\"blk-flag01\">DEBUG FLAG!</p>"
                    ),
                    "order": 0
                }
            },
            "pageOrder": ["rt-page-1"],
            "activePageId": "rt-page-1"
        }
    })
}

/// Full-state update of `doc` (v1 encoding).
fn full_state(doc: &Doc) -> Vec<u8> {
    doc.transact().encode_state_as_update_v1(&yrs::StateVector::default())
}

/// Apply `from`'s missing state into `into` (one sync direction).
fn sync_into(into: &Doc, from: &Doc) {
    let sv = into.transact().state_vector();
    let diff = from.transact().encode_state_as_update_v1(&sv);
    into.transact_mut()
        .apply_update(Update::decode_v1(&diff).expect("decode"))
        .expect("apply");
}

/// Serialize a doc's `prose:rt-page-1` through the production serializer.
fn prose_of(doc: &Doc) -> String {
    let frag = doc.get_or_insert_xml_fragment("prose:rt-page-1");
    let txn = doc.transact();
    prose_html::fragment_to_html(&frag, &txn)
}

/// Ids of every `id="…"` attribute in serialized prose, for uniqueness checks.
fn block_ids(html: &str) -> Vec<String> {
    html.split("id=\"")
        .skip(1)
        .filter_map(|s| s.split('"').next().map(str::to_string))
        .collect()
}

/// The lifecycle rig shared by both tests:
///
/// 1. relay1 hydrates the v1 body cold (no sidecar — the first-ever seed).
/// 2. A client (fixed id 4242 — the editor room) bootstraps that lineage,
///    then applies `edit` locally.
/// 3. relay1 receives the edit, flattens it into the JSON body, and encodes
///    its sidecar — stamped with the OLD serverVersion. An out-of-band write
///    then bumps the body's `serverVersion` (the REST-save-last trigger).
/// 4. relay1 is evicted. relay2 hydrates from the bumped body + the stale
///    sidecar — the exact production path that used to re-seed.
/// 5. Client and relay2 sync both ways.
///
/// Returns `(relay2 prose, client prose)` after the resync.
fn evict_rehydrate_resync(edit: impl FnOnce(&Doc)) -> (String, String) {
    let mut body = json_v1();

    // 1. First hydrate: cold, no sidecar. Seeds the prose deterministically.
    let relay1 = DocHandle::hydrate(&body, None, true);

    // 2. The editor's room bootstraps the seeded lineage, then edits.
    let client = Doc::with_client_id(4242);
    client
        .transact_mut()
        .apply_update(Update::decode_v1(&full_state(&relay1.doc)).expect("decode"))
        .expect("apply");
    edit(&client);

    // 3. relay1 receives the edit and flattens; sidecar stamped at version 1.
    sync_into(&relay1.doc, &client);
    assert!(relay1.flatten_into(&mut body), "flatten must apply");
    let sidecar = relay1.encode_binary(1);
    // Out-of-band bump (REST save / cold MCP write was the last writer).
    body["serverVersion"] = json!(2);

    // 4. Evict + rehydrate from the bumped body and the now-stale sidecar.
    drop(relay1);
    let relay2 = DocHandle::hydrate(&body, Some(&sidecar), true);

    // 5. Full two-way resync with the surviving room.
    sync_into(&client, &relay2.doc);
    sync_into(&relay2.doc, &client);

    (prose_of(&relay2.doc), prose_of(&client))
}

/// The user's real edit: reposition the flag paragraph into a blockquote
/// between title and sentence (delete + reinsert — a mid-content change, so
/// a re-seed's serialization diverges from the room's lineage early).
fn reposition_flag_into_blockquote(client: &Doc) {
    let frag = client.get_or_insert_xml_fragment("prose:rt-page-1");
    let mut txn = client.transact_mut();
    frag.remove_range(&mut txn, 2, 1);
    let bq = frag.insert(&mut txn, 1, XmlElementPrelim::empty("blockquote"));
    let p = bq.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
    p.insert_attribute(&mut txn, "id", "blk-flag01");
    p.push_back(&mut txn, XmlTextPrelim::new("DEBUG FLAG!"));
}

/// Append-only edit: a second paragraph after the flag.
fn append_conclusion(client: &Doc) {
    let frag = client.get_or_insert_xml_fragment("prose:rt-page-1");
    let mut txn = client.transact_mut();
    let p = frag.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
    p.insert_attribute(&mut txn, "id", "blk-concl01");
    p.push_back(&mut txn, XmlTextPrelim::new("Conclusion: tempo matters."));
}

#[test]
fn reseed_evolved_content_stays_convergent() {
    let (relay_html, client_html) = evict_rehydrate_resync(reposition_flag_into_blockquote);

    // The fork is the failure mode: after a full two-way sync both sides MUST
    // read identically, or the CRDT contract itself has been violated.
    assert_eq!(
        relay_html, client_html,
        "relay and client forked after evict/rehydrate/resync"
    );
    // The sentence must survive intact — the collision spliced it mid-word
    // (`…recall from a sh?`).
    assert!(
        relay_html.contains(SENTENCE),
        "sentence spliced in the relay's flatten: {relay_html}"
    );
    // The repositioned block must appear exactly once.
    assert_eq!(
        relay_html.matches("DEBUG FLAG!").count(),
        1,
        "repositioned block duplicated: {relay_html}"
    );
    // Block ids stay unique (Pillar C addressing).
    let ids = block_ids(&relay_html);
    let mut deduped = ids.clone();
    deduped.sort();
    deduped.dedup();
    assert_eq!(ids.len(), deduped.len(), "duplicate block ids: {ids:?}");
}

#[test]
fn reseed_appended_content_does_not_duplicate() {
    let (relay_html, client_html) = evict_rehydrate_resync(append_conclusion);

    assert_eq!(
        relay_html, client_html,
        "relay and client forked after evict/rehydrate/resync"
    );
    assert_eq!(
        relay_html.matches("Conclusion: tempo matters.").count(),
        1,
        "appended paragraph duplicated: {relay_html}"
    );
    assert_eq!(
        relay_html.matches("DEBUG FLAG!").count(),
        1,
        "flag paragraph duplicated: {relay_html}"
    );
    let ids = block_ids(&relay_html);
    let mut deduped = ids.clone();
    deduped.sort();
    deduped.dedup();
    assert_eq!(ids.len(), deduped.len(), "duplicate block ids: {ids:?}");
}

/// Design-review case: the JSON body itself persisted DOUBLED (the JP-338
/// signature) while the binary lineage is clean. The overlay's trim diff
/// would faithfully append the second copy — the post-overlay heal must
/// collapse it, leaving a single body on both sides.
#[test]
fn stale_binary_plus_doubled_json_heals_to_single() {
    let mut body = json_v1();
    // Double the stored page content (X+X), as a JP-338-era body would carry.
    let single = "<h1 id=\"blk-head01\">Title</h1>\
                  <p id=\"blk-sent01\">Body text here.</p>";
    body["richTextPages"]["pages"]["rt-page-1"]["content"] =
        serde_json::json!(format!("{single}{single}"));

    // Binary lineage: the clean single body.
    let relay1 = DocHandle::hydrate(
        &{
            let mut v1 = json_v1();
            v1["richTextPages"]["pages"]["rt-page-1"]["content"] = serde_json::json!(single);
            v1
        },
        None,
        true,
    );
    let sidecar = relay1.encode_binary(1);
    body["serverVersion"] = serde_json::json!(2);
    drop(relay1);

    let relay2 = DocHandle::hydrate(&body, Some(&sidecar), true);
    let html = prose_of(&relay2.doc);
    assert_eq!(
        html.matches("Body text here.").count(),
        1,
        "doubled JSON must heal to a single body after the overlay: {html}"
    );
}

/// Design-review case (tombstone guard): emptying a page tombstones the
/// deterministic seed's items IN PLACE — the fragment reads empty but the
/// seed client's clocks are spent. Re-writing the IDENTICAL content must not
/// dedupe into the tombstones and come up silently empty.
#[test]
fn clear_page_then_rewrite_identical_content_is_not_silently_empty() {
    let html = "<h1 id=\"blk-head01\">Title</h1><p id=\"blk-sent01\">Body text here.</p>";
    let mut body = json_v1();
    body["richTextPages"]["pages"]["rt-page-1"]["content"] = serde_json::json!(html);
    let relay = DocHandle::hydrate(&body, None, true);

    // Select-all-delete: the fragment empties, the seed items tombstone.
    let _ = relay.clear_prose("rt-page-1");
    assert_eq!(prose_of(&relay.doc), "", "page must read empty after clear");

    // The user re-writes the exact same content (undo-by-retyping, an MCP
    // set_prose replay, a restore of the same text).
    relay
        .replace_prose("rt-page-1", html)
        .expect("rewrite applies");
    assert_eq!(
        prose_of(&relay.doc),
        html,
        "identical re-write after a clear must not dedupe into tombstones"
    );
}

/// The overlay's core promise, isolated: an out-of-band JSON prose change
/// (cold MCP write) lands on the binary lineage as an EDIT — the surviving
/// room converges on it without duplication.
#[test]
fn out_of_band_json_change_overlays_and_converges() {
    let (relay_html, client_html) = {
        let mut body = json_v1();
        let relay1 = DocHandle::hydrate(&body, None, true);
        let client = Doc::with_client_id(4242);
        client
            .transact_mut()
            .apply_update(Update::decode_v1(&full_state(&relay1.doc)).expect("decode"))
            .expect("apply");

        // Evict with a CURRENT sidecar...
        assert!(relay1.flatten_into(&mut body), "flatten");
        let sidecar = relay1.encode_binary(1);
        drop(relay1);
        // ...then a cold MCP write rewrites the flag line and bumps the version.
        body["richTextPages"]["pages"]["rt-page-1"]["content"] = serde_json::json!(format!(
            "<h1 id=\"blk-head01\">Title</h1>\
             <p id=\"blk-sent01\">{SENTENCE}</p>\
             <p id=\"blk-flag01\">EDITED OFFLINE!</p>"
        ));
        body["serverVersion"] = serde_json::json!(2);

        let relay2 = DocHandle::hydrate(&body, Some(&sidecar), true);
        sync_into(&client, &relay2.doc);
        sync_into(&relay2.doc, &client);
        (prose_of(&relay2.doc), prose_of(&client))
    };
    assert_eq!(relay_html, client_html, "forked after out-of-band overlay");
    assert_eq!(
        relay_html.matches("EDITED OFFLINE!").count(),
        1,
        "out-of-band edit must appear exactly once: {relay_html}"
    );
    assert!(
        !relay_html.contains("DEBUG FLAG!"),
        "replaced line must not survive alongside its replacement: {relay_html}"
    );
    assert!(relay_html.contains(SENTENCE), "sentence spliced: {relay_html}");
}

// ---- Editor-lineage fixture: the JS→relay wire direction (JP-468) ----------
//
// `tests/yjs-fixtures/` (JP-326) proves relay-authored bytes decode in the
// editor's yjs. This family proves the REVERSE: a committed y-prosemirror-
// authored lineage (fixed clientID, incremental edits — real split/tombstone
// topology) decodes in yrs and flattens to the pinned projection. Generated
// by `src/collaboration/editorLineageFixture.test.ts`
// (`REGEN_EDITOR_LINEAGE=1`); the projection below is regenerated with
// `cargo test regenerate_editor_lineage -- --ignored`. Both sides must be
// green on the same bytes.

fn editor_lineage_dir() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/editor-lineage")
}

fn editor_lineage_projection() -> String {
    let bytes = std::fs::read(editor_lineage_dir().join("update.bin"))
        .expect("committed editor-lineage fixture missing — regenerate via vitest");
    let doc = super::binary::doc_from_update(&bytes).expect("JS-authored update must decode");
    let frag = doc.get_or_insert_xml_fragment("prose:rt-page-1");
    let txn = doc.transact();
    prose_html::fragment_to_html(&frag, &txn)
}

#[test]
fn editor_lineage_fixture_flattens_to_pinned_projection() {
    let expected = std::fs::read_to_string(editor_lineage_dir().join("projection.html"))
        .expect("projection.html missing — run `cargo test regenerate_editor_lineage -- --ignored`");
    assert_eq!(
        editor_lineage_projection(),
        expected,
        "relay projection of the committed editor lineage drifted — regenerate BOTH sides"
    );
}

/// The projection must also be a seed fixed point: re-seeding a fresh doc
/// from the flattened HTML of REAL editor content reproduces the same HTML.
/// This is the property the JSON-rebuild path (no sidecar at all) relies on.
#[test]
fn editor_lineage_projection_is_a_seed_fixed_point() {
    let projection = editor_lineage_projection();
    let (blocks, fixes) =
        prose_validate::sanitize_blocks(prose_parse::html_to_blocks(&projection));
    assert!(fixes.is_empty(), "editor-shaped projection must sanitize clean: {fixes:?}");
    let doc = Doc::new();
    super::seed_prose_deterministic(&doc, "rt-page-1", &blocks);
    assert_eq!(prose_of(&doc), projection, "seed of the projection must reproduce it");
}

#[test]
#[ignore = "regenerates tests/editor-lineage/projection.html from update.bin"]
fn regenerate_editor_lineage() {
    let projection = editor_lineage_projection();
    std::fs::write(editor_lineage_dir().join("projection.html"), &projection).unwrap();
    println!("wrote projection.html ({} bytes)", projection.len());
}
