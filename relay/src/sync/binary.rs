//! Binary Y.Doc persistence for the authoritative relay CRDT (JP-108).
//!
//! JP-36 persists the relay `Y.Doc` only as a JSON snapshot, rebuilt on every
//! hydrate via [`super::hydration::json_to_ydoc`] — which mints fresh Yjs items
//! (new clientID + clocks) and so **discards CRDT identity** across
//! evict→rehydrate, and keeps only active-page shapes (dropping prose and every
//! other shared type). This module adds a companion **binary** snapshot (a
//! lib0-v1 full-state update) so the relay can restore the exact `Y.Doc` —
//! identity, causal history, prose, every shared type — on the next join.
//!
//! On-disk sidecar layout (`<doc_id>.ydoc`): a small self-describing header
//! followed by the encoded state —
//! ```text
//! b"DSKY" | format_version: u32 LE | server_version: u64 LE | lib0-v1 state update
//! ```
//! The `server_version` lets the hydrator detect an out-of-band JSON write
//! (MCP/REST writes *bump* the version; the JP-36 JSON flush *preserves* it) and
//! fall back to JSON when the binary is stale.

use yrs::updates::decoder::Decode;
use yrs::{Doc, ReadTxn, StateVector, Transact, Update};

use crate::sync::decode_guard::guard_decode;

/// Magic prefix identifying a DocuShark binary Y.Doc sidecar.
const MAGIC: &[u8; 4] = b"DSKY";
/// Bump when the header or payload framing changes incompatibly.
pub const FORMAT_VERSION: u32 = 1;
/// Header size: magic(4) + format_version(4) + server_version(8).
const HEADER_LEN: usize = 4 + 4 + 8;

/// Serialize `doc`'s full state into a sidecar byte blob tagged with
/// `server_version`. `encode_state_as_update_v1` emits the **compacted full
/// state** (not an append log), so the blob tracks live content size, not edit
/// count — no unbounded growth, no GC needed.
pub fn encode_snapshot(server_version: u64, doc: &Doc) -> Vec<u8> {
    let update = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    let mut out = Vec::with_capacity(HEADER_LEN + update.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&FORMAT_VERSION.to_le_bytes());
    out.extend_from_slice(&server_version.to_le_bytes());
    out.extend_from_slice(&update);
    out
}

/// Parse a sidecar blob into `(server_version, state_update_bytes)`. Returns
/// `None` on a bad magic, an unknown format version, or a short buffer — the
/// caller then falls back to JSON hydration. Never panics.
pub fn decode_header(bytes: &[u8]) -> Option<(u64, &[u8])> {
    if bytes.len() < HEADER_LEN || &bytes[0..4] != MAGIC {
        return None;
    }
    let format = u32::from_le_bytes(bytes[4..8].try_into().ok()?);
    if format != FORMAT_VERSION {
        return None;
    }
    let server_version = u64::from_le_bytes(bytes[8..16].try_into().ok()?);
    Some((server_version, &bytes[HEADER_LEN..]))
}

/// Build a fresh `Doc` by applying a lib0-v1 state update. Returns `Err` on a
/// malformed/corrupt update so the caller can fall back to JSON hydration —
/// a bad sidecar must never take a document down.
///
/// A `Result` alone did not make that promise true: a truncated or corrupt
/// sidecar can decode a client id wider than `yrs`'s 53-bit space and panic
/// inside the decoder rather than returning `Err` (JP-476). The whole build
/// therefore runs under [`guard_decode`] — sound here because the `Doc` is
/// local and dropped on the error path, so an unwind cannot leave a live
/// document half-applied.
pub fn doc_from_update(update: &[u8]) -> Result<Doc, String> {
    guard_decode("binary sidecar", || {
        let doc = Doc::new();
        let decoded = Update::decode_v1(update).map_err(|e| e.to_string())?;
        doc.transact_mut()
            .apply_update(decoded)
            .map_err(|e| e.to_string())?;
        Ok::<_, String>(doc)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use yrs::{Any, GetString, Map, Text, Transact};

    fn doc_with_shape(id: &str) -> Doc {
        let doc = Doc::new();
        let shapes = doc.get_or_insert_map("shapes");
        let mut txn = doc.transact_mut();
        shapes.insert(&mut txn, id, Any::String("rect".into()));
        drop(txn);
        doc
    }

    #[test]
    fn round_trips_state_and_version() {
        let doc = doc_with_shape("s1");
        let blob = encode_snapshot(7, &doc);

        let (version, update) = decode_header(&blob).expect("valid header");
        assert_eq!(version, 7);

        let restored = doc_from_update(update).expect("apply update");
        let shapes = restored.get_or_insert_map("shapes");
        assert!(shapes.contains_key(&restored.transact(), "s1"));
    }

    #[test]
    fn non_shape_shared_types_survive() {
        // A `prose:<page>` shared type stands in for the prose fragment: any
        // shared type that isn't `shapes`/`shapeOrder`/`metadata` is invisible
        // to the JSON flatten but is captured by the full-state binary. (Real
        // prose is an XmlFragment; the durability property is identical.)
        let doc = Doc::new();
        let prose = doc.get_or_insert_text("prose:p1");
        {
            let mut txn = doc.transact_mut();
            prose.insert(&mut txn, 0, "hello prose");
        }

        let blob = encode_snapshot(1, &doc);
        let (_v, update) = decode_header(&blob).unwrap();
        let restored = doc_from_update(update).unwrap();

        let rprose = restored.get_or_insert_text("prose:p1");
        assert_eq!(rprose.get_string(&restored.transact()), "hello prose");
    }

    #[test]
    fn hydration_preserves_identity_so_concurrent_edits_merge() {
        // Author s1 in doc A, persist + rehydrate B from the binary.
        let a = doc_with_shape("s1");
        let blob = encode_snapshot(1, &a);
        let (_v, update) = decode_header(&blob).unwrap();
        let b = doc_from_update(update).unwrap();

        // A *different* client C concurrently inserts s2; apply to B. With
        // identity preserved this merges; an identity-resetting rebuild would
        // be at risk of clobber.
        let c = doc_with_shape("s2");
        let c_update = c
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        b.transact_mut()
            .apply_update(Update::decode_v1(&c_update).unwrap())
            .unwrap();

        let b_shapes = b.get_or_insert_map("shapes");
        let txn = b.transact();
        assert!(b_shapes.contains_key(&txn, "s1"), "rehydrated state kept");
        assert!(
            b_shapes.contains_key(&txn, "s2"),
            "concurrent edit merged, not clobbered"
        );
    }

    #[test]
    fn rejects_bad_magic_wrong_format_and_short() {
        let doc = doc_with_shape("s1");
        let mut blob = encode_snapshot(1, &doc);
        assert!(decode_header(&blob).is_some());

        // Short buffer.
        assert!(decode_header(&blob[..4]).is_none());

        // Bad magic.
        let mut bad = blob.clone();
        bad[0] = b'X';
        assert!(decode_header(&bad).is_none());

        // Unknown format version.
        blob[4] = 0xFF;
        assert!(decode_header(&blob).is_none());
    }

    #[test]
    fn corrupt_update_errors_not_panics() {
        // Valid header, garbage payload → Err (caller falls back to JSON).
        assert!(doc_from_update(&[0xff, 0x00, 0x13, 0x37]).is_err());
    }

    /// JP-476: this test's contract ("errors, not panics") was not actually
    /// true for every corruption. A truncated or bit-flipped sidecar can decode
    /// a client id wider than `yrs`'s 53-bit space, which asserts inside the
    /// decoder (`block.rs:92`) instead of returning `Err` — taking the document
    /// down rather than falling back to JSON. The byte string above never
    /// happened to produce one; this one always does.
    #[test]
    fn oversized_client_id_in_sidecar_errors_not_panics() {
        /// lib0 unsigned variable-length integer.
        fn write_varuint(out: &mut Vec<u8>, mut n: u64) {
            loop {
                let mut byte = (n & 0x7f) as u8;
                n >>= 7;
                if n != 0 {
                    byte |= 0x80;
                }
                out.push(byte);
                if n == 0 {
                    break;
                }
            }
        }

        let mut update = Vec::new();
        write_varuint(&mut update, 1); // one client block
        write_varuint(&mut update, 1); // one struct in it
        write_varuint(&mut update, 1 << 53); // client id: one bit too wide
        write_varuint(&mut update, 0); // clock

        assert!(
            doc_from_update(&update).is_err(),
            "an out-of-range client id must fall back to JSON, not panic"
        );
    }
}
