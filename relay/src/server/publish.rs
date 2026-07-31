//! Public projection of a document (the `publish` REST surface).
//!
//! Publishing writes a **sanitized, frozen copy** of a document to storage —
//! a snapshot an operator can serve to readers who hold no relay credentials.
//! The relay itself never serves it: there is no anonymous route here, and
//! `permissions::resolve` still returns `None` for `Principal::Anonymous`.
//! What downstream serves the artifact (nginx over the `public/` directory,
//! a CDN over the object store, …) is deliberately out of scope.
//!
//! Two invariants carry all of the safety:
//!
//! 1. **The projection is an allowlist.** The stored document body embeds its
//!    access-control state (`sharedWith` — see `update_document_shares`) plus
//!    ownership and edit attribution. A denylist would fail open the moment a
//!    new field joins the document model; the allowlist fails closed. Nothing
//!    about *people* is ever copied.
//! 2. **The artifact is derived from the flattened JSON, never the Y.Doc.**
//!    The CRDT binary is an edit log — it retains deleted text and prior
//!    revisions by construction, which is exactly what a published snapshot
//!    must not carry.

use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

/// Top-level document fields copied into the public artifact. Everything not
/// named here is dropped — notably `sharedWith`, `ownerId`/`ownerName`,
/// `lastModifiedBy`/`lastModifiedByName`, `collectionId`, `tags`,
/// `serverVersion`, `blobReferences`, and `id` (readers address the artifact
/// by its own key; the internal id adds nothing but correlation surface).
///
/// `version` is required: the editor's load funnel refuses documents without
/// a migratable format version.
pub const PUBLIC_DOC_FIELDS: &[&str] = &[
    "version",
    "name",
    "pages",
    "pageOrder",
    "activePageId",
    "richTextPages",
    "references",
    "fields",
];

/// Build the public projection of `doc`.
///
/// This is the first stage of a deliberate **pipeline seam**: later transforms
/// (per-element exclusion, partial page sets, …) compose after the allowlist
/// and before serialization. Keep the signature `&Value -> Value` so inserting
/// a transform never touches callers.
pub fn project_public(doc: &Value) -> Value {
    let mut out = Map::new();
    if let Some(obj) = doc.as_object() {
        for field in PUBLIC_DOC_FIELDS {
            if let Some(v) = obj.get(*field) {
                out.insert((*field).to_string(), v.clone());
            }
        }
    }
    strip_mirror_provenance(&mut out);
    Value::Object(out)
}

/// Second pipeline stage (JP-475): drop inbound-mirror provenance from prose
/// pages. `richTextPages.pages[*].mirror` carries third-party resource ids and
/// source URLs (whose slugs embed the source pages' titles) — provenance for
/// the owner, not content for anonymous readers. Guests lose only the provider
/// glyph and family grouping; page content and order are untouched.
fn strip_mirror_provenance(out: &mut Map<String, Value>) {
    let Some(pages) = out
        .get_mut("richTextPages")
        .and_then(|rtp| rtp.get_mut("pages"))
        .and_then(|p| p.as_object_mut())
    else {
        return;
    };
    for page in pages.values_mut() {
        if let Some(page_obj) = page.as_object_mut() {
            page_obj.remove("mirror");
        }
    }
}

/// One published document's registry entry (`published.json`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishedEntry {
    /// Wall-clock publish time (ms since epoch).
    pub published_at: u64,
    /// Serialized artifact size — these bytes count toward the workspace
    /// storage meter for as long as the entry exists.
    pub bytes: u64,
    /// The source document's `modified_at` at publish time. The staleness
    /// signal is `metadata.modified_at > source_modified_at` — a timestamp
    /// comparison, because collaborative flushes deliberately do not bump
    /// `serverVersion` and an edit-count would miss them.
    pub source_modified_at: u64,
}

/// Per-workspace published-document registry, persisted as `published.json`
/// beside `collections.json` and mirrored to the object store so a cold
/// machine keeps both the meter contribution and the status surface.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PublishedRegistry {
    pub version: u64,
    #[serde(default)]
    pub entries: BTreeMap<String, PublishedEntry>,
}

/// Parse `published.json` bytes. `None` when malformed — the caller keeps the
/// in-memory state it has rather than replacing it with garbage.
pub fn parse_published_file(data: &str) -> Option<PublishedRegistry> {
    serde_json::from_str(data).ok()
}

/// Canonical sharded blob key relative to the storage root:
/// `ws/{workspace}/{ab}/{cd}/{hash}` — the same two-level shard both storage
/// backends use, so a manifest consumer resolves bytes without knowing which
/// backend produced it. (The S3 backend prepends its configured key prefix;
/// callers with an S3 handle should prefer its `object_key` for that reason.)
pub fn sharded_blob_key(ws: &str, hash: &str) -> String {
    let (a, b) = if hash.len() >= 4 {
        (&hash[0..2], &hash[2..4])
    } else {
        ("zz", "zz")
    };
    format!("ws/{}/{}/{}/{}", ws, a, b, hash)
}

/// Blob hashes referenced by a projected document. Scans the *projection*,
/// not the source: a blob referenced only by a field the allowlist dropped
/// must not be resolvable through the artifact's manifest.
///
/// Delegates to the save path's canonical content walker
/// (`crate::api::collect_blob_references`) rather than keeping a twin: the
/// walker knows every reference shape — FileShape's bare-hash `blobRef` AND
/// prose `blob://<hash>` URIs — and a private copy here already missed the
/// former once (caught live: a published document's files resolved to
/// nothing because only the URI form was scanned).
pub fn projected_blob_hashes(projected: &Value) -> HashSet<String> {
    crate::api::collect_blob_references(projected).into_iter().collect()
}

/// Counts surfaced by the manifest (preview cards want "N pages · N shapes ·
/// N files" without parsing the artifact).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProjectionCounts {
    /// Canvas pages + prose pages, matching the metadata `page_count` axis.
    pub page_count: usize,
    pub shape_count: usize,
    /// File shapes (`type == "file"`), the attachment-like subset of shapes.
    pub file_count: usize,
}

/// Derive counts from a projected document.
pub fn projection_counts(projected: &Value) -> ProjectionCounts {
    let canvas_pages = projected
        .get("pageOrder")
        .and_then(|v| v.as_array())
        .map(|a| a.len())
        .unwrap_or(0);
    let prose_pages = projected
        .pointer("/richTextPages/pageOrder")
        .and_then(|v| v.as_array())
        .map(|a| a.len())
        .unwrap_or(0);

    let mut shape_count = 0usize;
    let mut file_count = 0usize;
    if let Some(pages) = projected.get("pages").and_then(|v| v.as_object()) {
        for page in pages.values() {
            let Some(shapes) = page.get("shapes").and_then(|v| v.as_object()) else {
                continue;
            };
            shape_count += shapes.len();
            file_count += shapes
                .values()
                .filter(|s| s.get("type").and_then(|t| t.as_str()) == Some("file"))
                .count();
        }
    }

    ProjectionCounts {
        page_count: canvas_pages + prose_pages,
        shape_count,
        file_count,
    }
}

/// Build the artifact's companion manifest.
///
/// The manifest exists so a consumer can (a) render a preview without parsing
/// the full artifact and (b) **authorize blob reads**: only hashes listed here
/// are resolvable through a published document. It carries each blob's full
/// object key — the writer knows its own key scheme, so the consumer derives
/// nothing and key-layout drift between writer and reader cannot happen.
///
/// Never serve the manifest itself to readers: the keys are storage-internal.
pub fn build_public_manifest(
    projected: &Value,
    blob_keys: &BTreeMap<String, String>,
    published_at: u64,
    source_modified_at: u64,
) -> Value {
    let counts = projection_counts(projected);
    json!({
        "version": 1,
        "title": projected.get("name").and_then(|v| v.as_str()).unwrap_or("Untitled"),
        "pageCount": counts.page_count,
        "shapeCount": counts.shape_count,
        "fileCount": counts.file_count,
        "publishedAt": published_at,
        "sourceModifiedAt": source_modified_at,
        "blobs": blob_keys,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn people_laden_doc() -> Value {
        json!({
            "id": "doc-1",
            "version": 2,
            "name": "Relay Notes",
            "serverVersion": 7,
            "ownerId": "user-a",
            "ownerName": "Alice A",
            "lastModifiedBy": "user-b",
            "lastModifiedByName": "Bob B",
            "collectionId": "col-1",
            "tags": ["secret-project"],
            "sharedWith": [
                { "userId": "user-b", "userName": "Bob B", "permission": "edit", "sharedAt": 1 }
            ],
            // A field that does not exist in the model today: the projection
            // must drop it. This is the test that would PASS under a denylist
            // written against today's fields — which is exactly why it exists.
            "reviewers": [{ "userId": "user-c", "userName": "Carol C" }],
            "blobReferences": ["a".repeat(64)],
            "pageOrder": ["p1"],
            "activePageId": "p1",
            "pages": {
                "p1": {
                    "shapes": {
                        "s1": { "type": "rectangle", "x": 0, "y": 0 },
                        // The REAL FileShape reference shape: a bare hash under
                        // `blobRef`, no `blob://` prefix. The live E2E caught a
                        // scanner that only knew the URI form.
                        "s2": { "type": "file", "x": 1, "y": 1,
                                "blobRef": "b".repeat(64) }
                    },
                    "shapeOrder": ["s1", "s2"]
                }
            },
            "richTextPages": {
                "pageOrder": ["r1"],
                "pages": { "r1": { "content": format!("<img src=\"blob://{}\">", "c".repeat(64)) } }
            },
            "references": [{ "id": "ref1", "title": "Cited Work" }],
            "fields": { "defs": [] }
        })
    }

    #[test]
    fn projection_keeps_only_allowlisted_fields() {
        let projected = project_public(&people_laden_doc());
        let obj = projected.as_object().unwrap();

        for field in PUBLIC_DOC_FIELDS {
            if *field == "version" || *field == "name" || *field == "pages" {
                assert!(obj.contains_key(*field), "expected {} in projection", field);
            }
        }
        for dropped in [
            "id",
            "serverVersion",
            "ownerId",
            "ownerName",
            "lastModifiedBy",
            "lastModifiedByName",
            "collectionId",
            "tags",
            "sharedWith",
            "blobReferences",
        ] {
            assert!(!obj.contains_key(dropped), "{} must not survive projection", dropped);
        }
    }

    #[test]
    fn projection_drops_fields_added_after_the_allowlist_was_written() {
        // The distinguishing property of an allowlist: a novel people-shaped
        // field ("reviewers") vanishes even though no rule names it.
        let projected = project_public(&people_laden_doc());
        assert!(projected.get("reviewers").is_none());
        assert!(!serde_json::to_string(&projected).unwrap().contains("user-c"));
    }

    #[test]
    fn projection_serialization_carries_no_identity_strings() {
        let s = serde_json::to_string(&project_public(&people_laden_doc())).unwrap();
        for needle in ["user-a", "user-b", "Alice A", "Bob B", "sharedWith", "secret-project"] {
            assert!(!s.contains(needle), "projection leaked {:?}", needle);
        }
    }

    #[test]
    fn projection_strips_mirror_provenance_from_prose_pages() {
        // JP-475: `richTextPages.pages[*].mirror` carries third-party resource
        // ids and source URLs (their slugs embed source page titles) — owner
        // provenance, not guest content. The subtree clone must not publish it.
        let doc = serde_json::json!({
            "version": 2,
            "name": "Doc",
            "richTextPages": {
                "pages": {
                    "p1": {
                        "id": "p1",
                        "name": "Mirrored",
                        "content": "<p>hi</p>",
                        "mirror": {
                            "provider": "notion",
                            "externalId": "ext-123",
                            "parentExternalId": "ext-parent",
                            "url": "https://www.notion.so/Internal-Title-abc123"
                        }
                    },
                    "p2": { "id": "p2", "name": "Plain", "content": "" }
                },
                "pageOrder": ["p1", "p2"],
                "activePageId": "p1"
            }
        });
        let s = serde_json::to_string(&project_public(&doc)).unwrap();
        for needle in ["mirror", "ext-123", "ext-parent", "Internal-Title"] {
            assert!(!s.contains(needle), "projection leaked {:?}", needle);
        }
        let projected = project_public(&doc);
        assert_eq!(projected["richTextPages"]["pageOrder"], serde_json::json!(["p1", "p2"]));
        assert_eq!(projected["richTextPages"]["pages"]["p1"]["content"], "<p>hi</p>");
        assert_eq!(projected["richTextPages"]["pages"]["p1"]["name"], "Mirrored");
    }

    #[test]
    fn blob_hashes_come_from_the_projection_not_the_source() {
        let doc = people_laden_doc();
        let projected = project_public(&doc);
        let hashes = projected_blob_hashes(&projected);
        // "a"×64 lived only in the dropped `blobReferences` array — a blob the
        // artifact does not use must not be resolvable through its manifest.
        assert!(!hashes.contains(&"a".repeat(64)));
        assert!(hashes.contains(&"b".repeat(64)), "FileShape bare-hash blobRef");
        assert!(hashes.contains(&"c".repeat(64)), "prose <img> blob:// ref");
    }

    #[test]
    fn counts_span_canvas_and_prose() {
        let counts = projection_counts(&project_public(&people_laden_doc()));
        assert_eq!(counts.page_count, 2, "1 canvas + 1 prose page");
        assert_eq!(counts.shape_count, 2);
        assert_eq!(counts.file_count, 1);
    }

    #[test]
    fn manifest_lists_exactly_the_provided_blob_keys() {
        let projected = project_public(&people_laden_doc());
        let mut keys = BTreeMap::new();
        keys.insert("b".repeat(64), sharded_blob_key("ws-1", &"b".repeat(64)));
        let manifest = build_public_manifest(&projected, &keys, 1000, 900);
        assert_eq!(manifest["title"], "Relay Notes");
        assert_eq!(manifest["publishedAt"], 1000);
        assert_eq!(manifest["sourceModifiedAt"], 900);
        let blobs = manifest["blobs"].as_object().unwrap();
        assert_eq!(blobs.len(), 1);
        assert_eq!(
            blobs[&"b".repeat(64)],
            format!("ws/ws-1/bb/bb/{}", "b".repeat(64))
        );
    }

    #[test]
    fn sharded_key_matches_backend_shard_layout() {
        let hash = format!("{}{}", "ab", "c".repeat(62));
        assert_eq!(
            sharded_blob_key("w", &hash),
            format!("ws/w/ab/cc/{}", hash)
        );
    }

    #[test]
    fn registry_file_round_trips() {
        let mut reg = PublishedRegistry::default();
        reg.version = 3;
        reg.entries.insert(
            "doc-1".into(),
            PublishedEntry { published_at: 5, bytes: 100, source_modified_at: 4 },
        );
        let s = serde_json::to_string(&reg).unwrap();
        let back = parse_published_file(&s).unwrap();
        assert_eq!(back.version, 3);
        assert_eq!(back.entries["doc-1"].bytes, 100);
        assert!(parse_published_file("not json").is_none());
    }
}
