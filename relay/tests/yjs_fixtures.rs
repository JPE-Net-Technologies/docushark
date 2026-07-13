//! Cross-language Yjs wire-contract fixtures (JP-326).
//!
//! Every byte stream the relay hands to browsers must decode and apply in the
//! editor's own `yjs`. That contract broke twice on 2026-07-12: an interim
//! move implementation emitted yrs-only `ContentMove` structs (wire ref 11)
//! that yjs cannot decode — the client's decode throws and its sync jams
//! permanently — and upstream yrs emitted unanchored index-0 inserts whose
//! placement flipped on re-integration (see `relay/vendor/README.md`). Both
//! were invisible to every Rust-side test, because yrs happily decodes its
//! own output.
//!
//! This file is the relay half of the guard:
//!  * `regenerate_yjs_fixtures` (`#[ignore]`d) writes deterministic scenarios
//!    under `tests/yjs-fixtures/` — per-op WS sync frames, a DSKY binary
//!    sidecar, and the relay's own HTML projection — through the same public
//!    `DocHandle` API the MCP tools drive.
//!  * `committed_fixtures_match_regeneration` regenerates every scenario
//!    in-memory on each `cargo test` run and byte-compares the committed
//!    files, so relay wire behavior cannot drift without a regeneration (and
//!    a fresh run of the JS consumer).
//!
//! The editor half (`src/collaboration/relayUpdateContract.test.ts`) applies
//! these bytes through the editor's real decode paths (`stripSidecarHeader`,
//! `y-protocols readSyncMessage`) and asserts the projected content matches
//! `expected.html`.
//!
//! Regenerate with: `cargo test regenerate_yjs_fixtures -- --ignored`
//! (then run the Vitest suite — both sides must be green on the same bytes).
//!
//! Determinism: every doc uses a fixed client id and lib0 updates embed no
//! wall-clock, so regeneration is byte-stable run-to-run.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use docushark_relay::server::protocol::MESSAGE_SYNC;
use docushark_relay::sync::{DocHandle, InsertSide};
use yrs::updates::encoder::Encode;
use yrs::{Array, Doc, ReadTxn, StateVector, Transact};

/// Fixed client id for the relay-side handle docs. The page-seed lineage
/// inside `replace_prose` uses its own deterministic per-page client id, so
/// scenarios exercise the foreign-lineage shape (seed id != handle id) that
/// every hydrated live doc has — the shape both 2026-07-12 bugs required.
const HANDLE_CLIENT_ID: u64 = 777;
/// Client id for the synthetic poison doc.
const POISON_CLIENT_ID: u64 = 424_242;
/// Arbitrary fixed server version stamped into the DSKY sidecars.
const SERVER_VERSION: u64 = 7;

/// One generated scenario: a directory of (relative path, exact bytes).
struct Scenario {
    name: &'static str,
    files: Vec<(String, Vec<u8>)>,
}

fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/yjs-fixtures")
}

/// Frame a raw lib0-v1 update exactly as the relay's broadcast path does:
/// `[MESSAGE_SYNC][SyncMessage::Update(update)]`. Used only for the poison
/// scenario, whose update is authored outside `DocHandle` (the prose ops
/// already return framed bytes).
fn frame_update(update: Vec<u8>) -> Vec<u8> {
    let mut frame = vec![MESSAGE_SYNC];
    frame.extend(yrs::sync::SyncMessage::Update(update).encode_v1());
    frame
}

fn meta_json(
    description: &str,
    page_id: Option<&str>,
    poison: bool,
    frames: &[String],
) -> Vec<u8> {
    // BTreeMap => sorted keys => deterministic bytes.
    let mut meta = BTreeMap::new();
    meta.insert("description", serde_json::json!(description));
    meta.insert("pageId", serde_json::json!(page_id));
    meta.insert("serverVersion", serde_json::json!(SERVER_VERSION));
    meta.insert("poison", serde_json::json!(poison));
    meta.insert("frames", serde_json::json!(frames));
    meta.insert("sidecar", serde_json::json!("sidecar.ydoc"));
    meta.insert(
        "expectedHtml",
        serde_json::json!(if poison { None } else { Some("expected.html") }),
    );
    let mut bytes = serde_json::to_vec_pretty(&meta).expect("meta serializes");
    bytes.push(b'\n');
    bytes
}

/// One named prose op driven against a scenario's handle.
type ProseOp<'a> = (&'a str, &'a dyn Fn(&DocHandle) -> Result<Vec<u8>, String>);

/// Run a sequence of named prose ops against a fresh handle, capturing each
/// op's broadcast frame plus the final sidecar + HTML projection.
fn prose_scenario(
    name: &'static str,
    description: &str,
    page_id: &str,
    ops: &[ProseOp<'_>],
) -> Scenario {
    let handle = DocHandle::from_decoded(Doc::with_client_id(HANDLE_CLIENT_ID), None);
    let mut files = Vec::new();
    let mut frame_paths = Vec::new();
    for (i, (op_name, op)) in ops.iter().enumerate() {
        let frame = op(&handle).unwrap_or_else(|e| panic!("{name}/{op_name} failed: {e}"));
        let rel = format!("frames/{:02}-{op_name}.bin", i + 1);
        frame_paths.push(rel.clone());
        files.push((rel, frame));
    }
    files.push(("sidecar.ydoc".to_string(), handle.encode_binary(SERVER_VERSION)));
    let html = handle
        .prose_html(page_id)
        .unwrap_or_else(|| panic!("{name}: page {page_id} projected empty"));
    files.push(("expected.html".to_string(), html.into_bytes()));
    files.push((
        "meta.json".to_string(),
        meta_json(description, Some(page_id), false, &frame_paths),
    ));
    Scenario { name, files }
}

/// Rich content across the JP-432 parity surface: mark attrs (highlight /
/// text colour), link attrs, task lists with `checked`, codeBlock `language`,
/// an ordered list with `type`, and a small table. All placeholder text —
/// these files are committed to the public repo.
fn seed_parity() -> Scenario {
    const PAGE: &str = "page-parity";
    const HTML: &str = concat!(
        "<h2>Contract fixtures</h2>",
        "<p>Plain text with <strong>bold</strong>, <em>italic</em>, ",
        "<mark style=\"background-color: #fde68a\">highlighted</mark> and ",
        "<span style=\"color: #b91c1c\">coloured</span> words, plus a ",
        "<a href=\"https://example.com/contract\" target=\"_blank\" rel=\"noopener\">link</a>.</p>",
        "<ul data-type=\"taskList\">",
        "<li data-type=\"taskItem\" data-checked=\"true\"><p>Decoded item</p></li>",
        "<li data-type=\"taskItem\" data-checked=\"false\"><p>Pending item</p></li>",
        "</ul>",
        "<pre><code class=\"language-rust\">fn contract() {}</code></pre>",
        "<ol type=\"a\"><li><p>alpha entry</p></li><li><p>beta entry</p></li></ol>",
        "<table><tbody>",
        "<tr><th><p>Kind</p></th><th><p>Count</p></th></tr>",
        "<tr><td><p>Frames</p></td><td><p>1</p></td></tr>",
        "</tbody></table>",
        "<blockquote><p>Quoted line</p></blockquote>",
    );
    prose_scenario(
        "seed-parity",
        "Single deterministic seed exercising the JP-432 parity surface \
         (mark attrs, task list, codeBlock language, link attrs, table).",
        PAGE,
        &[("seed", &|h: &DocHandle| h.replace_prose(PAGE, HTML))],
    )
}

/// The structural verbs in the exact shapes that failed live on 2026-07-12:
/// insert before the FIRST block (the unanchored-prepend shape), a delete
/// (whose tombstone participates in integration order), and a move-to-front.
fn structural_verbs() -> Scenario {
    const PAGE: &str = "page-verbs";
    prose_scenario(
        "structural-verbs",
        "Seed then insert-before-first, delete, move-to-front — the exact \
         index-0 / tombstone shapes of the 2026-07-12 incidents.",
        PAGE,
        &[
            ("seed", &|h: &DocHandle| {
                h.replace_prose(
                    PAGE,
                    "<ol><li><p>alpha block</p></li><li><p>beta block</p></li>\
                     <li><p>gamma block</p></li></ol>",
                )
            }),
            ("insert-before-first", &|h: &DocHandle| {
                h.insert_prose_block(PAGE, "alpha block", InsertSide::Before, "<p>omega block</p>")
            }),
            ("delete", &|h: &DocHandle| h.delete_prose_block(PAGE, "beta block")),
            ("move-to-front", &|h: &DocHandle| {
                h.move_prose_block(PAGE, "gamma block", "omega block", InsertSide::Before)
            }),
        ],
    )
}

/// Synthetic ref-11 poison: a doc whose update contains a yrs `ContentMove`
/// struct (`Array::move_to`), which yjs 13.x cannot decode — its content-ref
/// table stops at Skip(10), so `applyUpdate` throws and (on the WS path)
/// y-protocols swallows the error while the client's sync clock jams behind
/// the hole. This is byte-for-byte the failure mode of the live incident,
/// minus the user content. The relay must never emit such structs into shared
/// docs; the JS consumer asserts the poison is *detected*, keeping this
/// corpus honest if a future yjs learns to decode ref 11.
fn poison() -> Scenario {
    let doc = Doc::with_client_id(POISON_CLIENT_ID);
    let array = doc.get_or_insert_array("poison");
    {
        let mut txn = doc.transact_mut();
        array.push_back(&mut txn, "alpha");
        array.push_back(&mut txn, "beta");
        array.push_back(&mut txn, "gamma");
        // ContentMove is born here: a yrs-only struct type (wire ref 11).
        array.move_to(&mut txn, 2, 0);
    }
    let update = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    let handle = DocHandle::from_decoded(doc, None);
    let sidecar = handle.encode_binary(SERVER_VERSION);
    let frame_rel = "frames/01-move-poison.bin".to_string();
    let files = vec![
        (frame_rel.clone(), frame_update(update)),
        ("sidecar.ydoc".to_string(), sidecar),
        (
            "meta.json".to_string(),
            meta_json(
                "Synthetic yrs ContentMove (wire ref 11) — undecodable by yjs; \
                 the consumer asserts the poison is detected, never applied silently.",
                None,
                true,
                &[frame_rel],
            ),
        ),
    ];
    Scenario { name: "poison", files }
}

/// Generated alongside the scenarios so the drift test's orphan check owns it.
const README: &str = "\
# yjs-fixtures — cross-language Yjs wire-contract corpus (JP-326)

Relay-produced Yjs bytes that the editor's own `yjs` must decode and apply.
Generated by `relay/tests/yjs_fixtures.rs`; consumed by
`src/collaboration/relayUpdateContract.test.ts`.

Do not edit by hand. Regenerate with:

    cargo test regenerate_yjs_fixtures -- --ignored

then re-run the Vitest consumer — both sides must be green on the same bytes.

Each scenario directory holds `meta.json` (shape of the scenario),
`frames/NN-<op>.bin` (per-op WebSocket sync frames, `MESSAGE_SYNC`-prefixed),
`sidecar.ydoc` (final full state in the DSKY envelope), and `expected.html`
(the relay's own projection of the final prose state).

`poison/` is deliberately undecodable by yjs 13.x: it contains a yrs-only
`ContentMove` struct (wire ref 11). Clients must *detect* it, never apply it
silently — see the module docs in `yjs_fixtures.rs` for the incident history.
";

fn scenarios() -> Vec<Scenario> {
    vec![
        Scenario {
            name: "",
            files: vec![("README.md".to_string(), README.as_bytes().to_vec())],
        },
        seed_parity(),
        structural_verbs(),
        poison(),
    ]
}

/// Every committed fixture file must byte-match a fresh in-memory
/// regeneration, and no stale files may linger. Fails => relay wire behavior
/// changed => regenerate (see module docs) and re-run the JS consumer.
#[test]
fn committed_fixtures_match_regeneration() {
    let root = fixtures_dir();
    let mut expected_paths = Vec::new();
    for scenario in scenarios() {
        for (rel, bytes) in &scenario.files {
            let path = root.join(scenario.name).join(rel);
            expected_paths.push(path.clone());
            let committed = fs::read(&path).unwrap_or_else(|e| {
                panic!(
                    "missing committed fixture {} ({e}) — run \
                     `cargo test regenerate_yjs_fixtures -- --ignored`",
                    path.display()
                )
            });
            assert!(
                &committed == bytes,
                "fixture {} drifted from relay output ({} committed vs {} regenerated bytes) — \
                 run `cargo test regenerate_yjs_fixtures -- --ignored` and re-run the JS \
                 consumer (src/collaboration/relayUpdateContract.test.ts)",
                path.display(),
                committed.len(),
                bytes.len(),
            );
        }
    }
    // No orphans: every file on disk must belong to a live scenario.
    let mut on_disk = Vec::new();
    collect_files(&root, &mut on_disk);
    for path in on_disk {
        assert!(
            expected_paths.contains(&path),
            "stale fixture {} no longer produced by any scenario — regenerate to prune",
            path.display()
        );
    }
}

fn collect_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_files(&path, out);
        } else {
            out.push(path);
        }
    }
}

/// Writer: wipes and rewrites `tests/yjs-fixtures/`. `#[ignore]`d so plain
/// `cargo test` never mutates the tree.
#[test]
#[ignore]
fn regenerate_yjs_fixtures() {
    let root = fixtures_dir();
    if root.exists() {
        fs::remove_dir_all(&root).expect("clear fixtures dir");
    }
    for scenario in scenarios() {
        for (rel, bytes) in &scenario.files {
            let path = root.join(scenario.name).join(rel);
            fs::create_dir_all(path.parent().expect("fixture files have parents"))
                .expect("create fixture dir");
            fs::write(&path, bytes).expect("write fixture");
        }
    }
}
