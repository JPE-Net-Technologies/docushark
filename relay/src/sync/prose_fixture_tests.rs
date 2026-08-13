//! Cross-language prose round-trip corpus — the Rust half (JP-496).
//!
//! Loads `relay/tests/prose-fixtures/cases.json` and asserts every case is a
//! **fixed point**: the canonical stored HTML goes in, the byte-identical
//! string comes back. `src/ui/proseFixtures.test.ts` consumes the same file
//! against the editor's own schema, so the two prose models cannot drift.
//!
//! ## Why this exists
//!
//! Adding one inline node (`fileRef`, JP-495) required touching **six** relay
//! sites that enumerate node types by name. The plan listed four. The two
//! missed — `prose_validate::is_known_type` and `is_atom` — were caught only
//! because round-trip tests happened to get written; missing the first one
//! **deleted the node outright**, because an unknown type unwraps to its
//! children and an atom has none.
//!
//! `proseSchemaContract.test.ts` stayed green throughout, because it checks the
//! *manifest* — which node names and attrs exist on each side — not the
//! *behaviour* on a real document. This corpus is that missing layer.
//!
//! ## Three paths, because a node can survive one and not another
//!
//! Every case runs through both production entry points and then a second pass:
//!
//! 1. **seed** (`seed_prose_deterministic`) — a document's first hydrate.
//! 2. **replace** (`DocHandle::replace_prose`) — an MCP write or a live edit,
//!    which reconciles against an existing fragment rather than building one.
//! 3. **idempotence** — a second trip over the first's output. Non-idempotence
//!    means stored HTML churns on every save, which is how a "harmless"
//!    normalization turns into an infinite diff between two collaborators.
//!
//! JP-330 (shapeOrder doubling) and JP-338 (prose body doubling) were both
//! "one path is correct and the other is not", so testing a single path is not
//! enough to call a node wired.

use serde_json::json;

use super::prose_schema::CUSTOM_PROSE_NODES;
use super::{prose_html, prose_parse, prose_validate, DocHandle};
use yrs::{Doc, Transact};

/// One node the parse must produce, in document order.
#[derive(serde::Deserialize)]
struct NodeSpec {
    #[serde(rename = "type")]
    node_type: String,
    /// Attribute values that must be present. A **subset** check, deliberately:
    /// the client materializes schema defaults the relay omits (`colspan="1"`,
    /// a `<th>`'s `scope="col"`), and neither side is wrong. Declaring the
    /// payload attrs and ignoring defaults lets one manifest serve both without
    /// per-side carve-outs.
    #[serde(default)]
    attrs: std::collections::BTreeMap<String, String>,
}

#[derive(serde::Deserialize)]
struct Case {
    name: String,
    /// What breaks if this case regresses. Read by humans and by the failure
    /// message — a fixture nobody can motivate is a fixture nobody maintains.
    why: String,
    html: String,
    /// The document model both sides must parse this HTML into. This is the
    /// cross-language contract: HTML *text* legitimately differs between the
    /// relay's storage form and the editor's render (presentation classes,
    /// attribute order, node-view chrome), but the resulting node tree must not.
    nodes: Vec<NodeSpec>,
}

#[derive(serde::Deserialize)]
struct Fixtures {
    /// Node types both sides must treat as childless atoms. See `atomsWhy` in
    /// the fixture file for why this list lives there rather than being read
    /// out of `prose_validate::is_atom`.
    atoms: Vec<String>,
    cases: Vec<Case>,
}

fn load_fixtures() -> Fixtures {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/prose-fixtures/cases.json");
    let raw = std::fs::read_to_string(path).expect("read prose fixtures");
    let fixtures: Fixtures = serde_json::from_str(&raw).expect("parse prose fixtures");
    assert!(!fixtures.cases.is_empty(), "fixtures must not be empty");
    assert!(!fixtures.atoms.is_empty(), "atom manifest must not be empty");
    fixtures
}

fn load_cases() -> Vec<Case> {
    load_fixtures().cases
}

/// The production seed pipeline for one page, returning re-serialized HTML.
/// Mirrors `roundtrip_tests::seed_round_trip`; duplicated rather than shared so
/// this file stands alone as the corpus harness.
fn seed_round_trip(html: &str) -> String {
    let (blocks, _fixes) = prose_validate::sanitize_blocks(prose_parse::html_to_blocks(html));
    let doc = Doc::new();
    super::seed_prose_deterministic(&doc, "p1", &blocks);
    let frag = doc.get_or_insert_xml_fragment("prose:p1");
    let txn = doc.transact();
    prose_html::fragment_to_html(&frag, &txn)
}

/// The MCP / live-edit write path: hydrate a document, replace a page's prose,
/// read it back.
fn replace_round_trip(html: &str) -> String {
    let body = json!({
        "id": "d", "serverVersion": 1, "activePageId": "p1",
        "pages": {"p1": {"shapes": {}, "shapeOrder": []}}
    });
    let handle = DocHandle::hydrate(&body, None, false);
    handle.replace_prose("p1", html).expect("replace_prose");
    handle.prose_html("p1").unwrap_or_default()
}

#[test]
fn every_case_round_trips_through_the_seed_path() {
    for case in load_cases() {
        let out = seed_round_trip(&case.html);
        assert_eq!(
            out, case.html,
            "fixture '{}' is not a fixed point on the SEED path.\n  why: {}",
            case.name, case.why
        );
    }
}

#[test]
fn every_case_round_trips_through_the_replace_path() {
    for case in load_cases() {
        let out = replace_round_trip(&case.html);
        assert_eq!(
            out, case.html,
            "fixture '{}' is not a fixed point on the REPLACE path (it may still be fine on \
             the seed path — that is the JP-330/JP-338 shape).\n  why: {}",
            case.name, case.why
        );
    }
}

#[test]
fn every_case_is_stable_under_a_second_pass() {
    for case in load_cases() {
        let once = seed_round_trip(&case.html);
        let twice = seed_round_trip(&once);
        assert_eq!(
            once, twice,
            "fixture '{}' is not idempotent — stored HTML would churn on every save.\n  why: {}",
            case.name, case.why
        );
    }
}

/// Flatten a sanitized tree into document order — the same walk both sides do.
fn flatten(nodes: &[prose_parse::PmNode], out: &mut Vec<(String, Vec<(String, String)>)>) {
    for node in nodes {
        out.push((node.node_type.clone(), node.attrs.clone()));
        let children: Vec<prose_parse::PmNode> = node
            .children
            .iter()
            .filter_map(|c| match c {
                prose_parse::PmChild::Node(n) => Some(n.clone()),
                prose_parse::PmChild::Text { .. } => None,
            })
            .collect();
        flatten(&children, out);
    }
}

#[test]
fn every_case_parses_into_the_declared_node_model() {
    // The cross-language contract. HTML text differs between the two sides by
    // design — the relay stores a canonical form, the editor renders with
    // presentation classes, node-view chrome and its own attribute order — so
    // pinning the editor's HTML would mostly assert chrome and would break on
    // any Tiptap upgrade. The *document model* is what must agree, and it is
    // also where the real defects live: JP-495's missing `is_known_type` entry
    // deleted a node, and JP-496 found `mathInline`/`mathBlock` parsing to an
    // EMPTY `latex` on the client (the node survived, the formula did not).
    for case in load_cases() {
        let (blocks, _fixes) =
            prose_validate::sanitize_blocks(prose_parse::html_to_blocks(&case.html));
        let mut actual = Vec::new();
        flatten(&blocks, &mut actual);

        let actual_types: Vec<&str> = actual.iter().map(|(t, _)| t.as_str()).collect();
        let expected_types: Vec<&str> =
            case.nodes.iter().map(|n| n.node_type.as_str()).collect();
        assert_eq!(
            actual_types, expected_types,
            "fixture '{}': parsed node sequence differs from the declared model.\n  why: {}",
            case.name, case.why
        );

        for (spec, (node_type, attrs)) in case.nodes.iter().zip(&actual) {
            for (key, want) in &spec.attrs {
                let got = attrs.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str());
                assert_eq!(
                    got,
                    Some(want.as_str()),
                    "fixture '{}': node '{node_type}' attr '{key}' — the value was lost or \
                     changed by the parse.\n  why: {}",
                    case.name,
                    case.why
                );
            }
        }
    }
}

#[test]
fn every_declared_atom_is_an_atom_to_the_validator() {
    // The OTHER site JP-495 missed was `prose_validate::is_atom`, and no
    // round-trip assertion can see it: an atom that illegally keeps its text
    // child still serializes to byte-identical HTML, because the serializer
    // writes that text from the node's *attribute* regardless of its children.
    // Confirmed by mutation — deleting `fileRef` from `is_atom` leaves all
    // three round-trip tests green.
    //
    // The damage is downstream: the client treats these types as atoms, so a
    // child crashes NodeView reconciliation ("Cannot read properties of
    // undefined (reading 'children')") and y-prosemirror then DELETES the node
    // from the live Y.Doc.
    //
    // The manifest is read from the fixture file, NOT from `is_atom` itself.
    // The first version of this test asked `is_atom` which nodes to check, so
    // the mutation made it skip the check rather than fail it — the guard
    // asserted nothing while looking thorough.
    for node_type in load_fixtures().atoms {
        assert!(
            prose_validate::is_atom(&node_type),
            "'{node_type}' is declared an atom in relay/tests/prose-fixtures/cases.json but \
             `prose_validate::is_atom` does not list it. Its children will survive sanitize, \
             crash the client's NodeView reconciliation, and be deleted by y-prosemirror."
        );
    }
}

#[test]
fn every_case_leaves_declared_atoms_childless() {
    // The behavioural half: whatever the manifest declares an atom must reach
    // the Y.Doc childless in every fixture that contains one.
    let fixtures = load_fixtures();
    let atoms: std::collections::HashSet<&str> =
        fixtures.atoms.iter().map(String::as_str).collect();

    fn walk<'a>(
        node: &'a prose_parse::PmNode,
        atoms: &std::collections::HashSet<&str>,
        seen: &mut std::collections::HashSet<&'a str>,
        case: &str,
        why: &str,
    ) {
        assert!(
            !atoms.contains(node.node_type.as_str()) || node.children.is_empty(),
            "fixture '{case}': atom '{}' kept {} child(ren) through sanitize — the client will \
             crash on it and y-prosemirror will delete it.\n  why: {why}",
            node.node_type,
            node.children.len(),
        );
        seen.insert(node.node_type.as_str());
        for child in &node.children {
            if let prose_parse::PmChild::Node(n) = child {
                walk(n, atoms, seen, case, why);
            }
        }
    }

    // Sanitized trees are kept alive for the whole loop so `seen` can borrow
    // their node-type strings.
    let trees: Vec<_> = fixtures
        .cases
        .iter()
        .map(|case| {
            let (blocks, _fixes) =
                prose_validate::sanitize_blocks(prose_parse::html_to_blocks(&case.html));
            (case, blocks)
        })
        .collect();

    let mut seen = std::collections::HashSet::new();
    for (case, blocks) in &trees {
        for node in blocks {
            walk(node, &atoms, &mut seen, &case.name, &case.why);
        }
    }

    // Without this the childless assertion is vacuous for any atom no fixture
    // happens to contain — it would "pass" by never visiting the node. Same
    // reasoning as the CUSTOM_PROSE_NODES coverage guard below.
    for node_type in &fixtures.atoms {
        assert!(
            seen.contains(node_type.as_str()),
            "declared atom '{node_type}' appears in no fixture's sanitized tree, so the \
             childless assertion never runs for it. Add a case to \
             relay/tests/prose-fixtures/cases.json that contains one."
        );
    }
}

/// Does `html` carry `marker` as a whole attribute name?
///
/// A plain `contains` would let a future marker match a longer one that merely
/// starts with it — `data-file` would "find" `data-file-name` and report a node
/// covered that no fixture exercises. The guard exists to catch an uncovered
/// node, so a false positive here defeats its entire purpose.
fn has_attr_token(html: &str, marker: &str) -> bool {
    [format!(" {marker}="), format!(" {marker} "), format!(" {marker}>")]
        .iter()
        .any(|needle| html.contains(needle.as_str()))
}

#[test]
fn every_custom_prose_node_is_covered_by_a_fixture() {
    // Without this the corpus silently stops covering new nodes — which is the
    // exact failure it exists to prevent. `fileRef` was added to six relay
    // sites and zero fixtures; the tests that caught the two missed sites were
    // written by hand and only by luck.
    let cases = load_cases();
    for (pm_type, _tag, marker) in CUSTOM_PROSE_NODES {
        assert!(
            cases.iter().any(|c| has_attr_token(&c.html, marker)),
            "CUSTOM_PROSE_NODES entry '{pm_type}' (marker '{marker}') has no case in \
             relay/tests/prose-fixtures/cases.json. Add one — a node with no fixture is a node \
             whose round-trip nobody checks, and the failure mode is silent deletion."
        );
    }
}

#[cfg(test)]
mod guard_tests {
    use super::has_attr_token;

    #[test]
    fn attr_token_match_does_not_confuse_a_prefix_for_a_whole_attribute() {
        let html = r#"<span data-file-ref data-file-name="a.pdf">a.pdf</span>"#;
        assert!(has_attr_token(html, "data-file-ref"), "valueless marker not found");
        assert!(has_attr_token(html, "data-file-name"), "valued marker not found");
        // The point of the helper: a prefix of a real attribute is NOT a match.
        assert!(!has_attr_token(html, "data-file"), "prefix wrongly matched a longer attribute");
    }
}
