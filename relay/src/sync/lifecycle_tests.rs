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

use super::{prose_html, DocHandle};

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
