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

use docushark_relay::sync::{DocHandle, InsertSide, TargetSpec};
use yrs::Doc;

/// Fixed client id for the relay-side handle docs. The page-seed lineage
/// inside `replace_prose` uses its own deterministic per-page client id, so
/// scenarios exercise the foreign-lineage shape (seed id != handle id) that
/// every hydrated live doc has — the shape both 2026-07-12 bugs required.
const HANDLE_CLIENT_ID: u64 = 777;
/// Arbitrary fixed server version stamped into the DSKY sidecars.
const SERVER_VERSION: u64 = 7;

/// Frozen corpus: committed files pinned by SHA-256 instead of regenerated.
///
/// The `poison/` scenario was authored with yrs 0.26's `Array::move_to` —
/// the API whose yrs-only `ContentMove` structs (wire ref 11) jammed yjs
/// clients in the 2026-07-12 incident. yrs 0.27 removed that public API
/// outright (the fix lineage around y-crdt/y-crdt#637), so the relay *cannot
/// produce* such bytes anymore — which is the guarantee this corpus exists to
/// pin. The committed bytes stay: yjs 13.x still can't decode ref 11, and the
/// JS consumer still asserts the poison is detected, never applied silently.
/// Any mutation of these files fails the drift test below.
const FROZEN: &[(&str, &str)] = &[
    (
        "poison/frames/01-move-poison.bin",
        "3da3e6abf1486c0dc6367a3395edb6319c2f7f0286ef632cf445dc87bf5af1d9",
    ),
    (
        "poison/sidecar.ydoc",
        "05838ff160ab07a9e7dac756dd6bd143e5dff12af8f44d430f45867cf5345cad",
    ),
    (
        "poison/meta.json",
        "20374db594fa7adb544264972cfab62b23631afa65e328d123bd5d702f821ff8",
    ),
];

/// One generated scenario: a directory of (relative path, exact bytes).
struct Scenario {
    name: &'static str,
    files: Vec<(String, Vec<u8>)>,
}

fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/yjs-fixtures")
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
        // Explicit fixed block ids (JP-432 Pillar C): id passthrough coverage.
        // Deterministic input content — the sync layer never mints, so the
        // corpus stays byte-stable across regenerations.
        "<h2 id=\"blk-fixture-h2\">Contract fixtures</h2>",
        "<p id=\"blk-fixture-p1\">Plain text with <strong>bold</strong>, <em>italic</em>, ",
        "<mark style=\"background-color: #fde68a\">highlighted</mark> and ",
        "<span style=\"color: #b91c1c\">coloured</span> words, plus a ",
        "<a href=\"https://example.com/contract\" target=\"_blank\" rel=\"noopener\">link</a>.</p>",
        "<ul data-type=\"taskList\">",
        "<li data-type=\"taskItem\" data-checked=\"true\"><p>Decoded item</p></li>",
        "<li data-type=\"taskItem\" data-checked=\"false\"><p>Pending item</p></li>",
        "</ul>",
        "<pre id=\"blk-fixture-code\"><code class=\"language-rust\">fn contract() {}</code></pre>",
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
                // Fixed ids (JP-432 Pillar C): the structural verbs must carry
                // leaf ids through splice/move without re-minting them.
                h.replace_prose(
                    PAGE,
                    "<ol><li><p id=\"blk-fixture-a\">alpha block</p></li>\
                     <li><p id=\"blk-fixture-b\">beta block</p></li>\
                     <li><p id=\"blk-fixture-c\">gamma block</p></li></ol>",
                )
            }),
            ("insert-before-first", &|h: &DocHandle| {
                h.insert_prose_block(PAGE, TargetSpec::text("alpha block"), InsertSide::Before, "<p>omega block</p>", None)
            }),
            ("delete", &|h: &DocHandle| h.delete_prose_block(PAGE, TargetSpec::text("beta block"))),
            ("move-to-front", &|h: &DocHandle| {
                h.move_prose_block(PAGE, TargetSpec::text("gamma block"), TargetSpec::text("omega block"), InsertSide::Before)
            }),
        ],
    )
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
It is FROZEN corpus (pinned by SHA-256, not regenerated): it was authored
with yrs 0.26's `Array::move_to`, and yrs 0.27 removed that public API — the
relay can no longer produce such bytes, which is exactly the guarantee this
corpus pins.
";

fn scenarios() -> Vec<Scenario> {
    vec![
        Scenario {
            name: "",
            files: vec![("README.md".to_string(), README.as_bytes().to_vec())],
        },
        seed_parity(),
        structural_verbs(),
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
    // Frozen corpus: present and byte-identical to its pinned hash. These
    // files can no longer be regenerated (see `FROZEN`), so hash-pinning is
    // what keeps them honest.
    for (rel, expected_hex) in FROZEN {
        let path = root.join(rel);
        expected_paths.push(path.clone());
        let committed = fs::read(&path).unwrap_or_else(|e| {
            panic!(
                "missing FROZEN fixture {} ({e}) — restore it from git history; \
                 it cannot be regenerated (yrs 0.27 removed Array::move_to)",
                path.display()
            )
        });
        let got_hex = {
            use sha2::{Digest, Sha256};
            hex::encode(Sha256::digest(&committed))
        };
        assert_eq!(
            &got_hex, expected_hex,
            "FROZEN fixture {} was mutated — restore it from git history",
            path.display()
        );
    }
    // No orphans: every file on disk must belong to a live scenario or the
    // frozen corpus.
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

/// Writer: rewrites the generated scenarios under `tests/yjs-fixtures/`,
/// leaving the FROZEN corpus untouched (it cannot be regenerated).
/// `#[ignore]`d so plain `cargo test` never mutates the tree.
#[test]
#[ignore]
fn regenerate_yjs_fixtures() {
    let root = fixtures_dir();
    for scenario in scenarios() {
        // Clear each generated scenario dir so pruned ops don't linger. The
        // root itself (README.md + frozen `poison/`) is never wiped.
        if !scenario.name.is_empty() {
            let dir = root.join(scenario.name);
            if dir.exists() {
                fs::remove_dir_all(&dir).expect("clear scenario dir");
            }
        }
        for (rel, bytes) in &scenario.files {
            let path = root.join(scenario.name).join(rel);
            fs::create_dir_all(path.parent().expect("fixture files have parents"))
                .expect("create fixture dir");
            fs::write(&path, bytes).expect("write fixture");
        }
    }
}
