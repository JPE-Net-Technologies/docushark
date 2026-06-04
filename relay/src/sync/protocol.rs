//! Yjs sync-protocol glue (JP-34).
//!
//! DocuShark frames a CRDT message as `[MESSAGE_SYNC=0][lib0 sync body]`.
//! The single `MESSAGE_SYNC` prefix byte *replaces* the y-protocols
//! top-level message tag, so the body is a bare y-protocols **sync**
//! message — `yrs::sync::SyncMessage`, not the top-level `yrs::sync::Message`.
//! We decode it with `SyncMessage::decode_v1` (lib0-v1, wire-compatible with
//! the JS `y-protocols/sync` client) and drive the authoritative `Doc`.

use yrs::sync::SyncMessage;
use yrs::updates::decoder::Decode;
use yrs::updates::encoder::Encode;
use yrs::{Doc, ReadTxn, Transact, Update};

use crate::server::protocol::MESSAGE_SYNC;

/// What a single inbound sync frame produced. Both fields are already
/// `MESSAGE_SYNC`-prefixed and ready to put on the wire.
#[derive(Debug, Default)]
pub struct SyncOutcome {
    /// Send only back to the frame's sender (e.g. the SyncStep2 answer to a
    /// SyncStep1 request).
    pub reply: Option<Vec<u8>>,
    /// Fan out to the *other* clients on the same `(workspace, doc)`.
    pub broadcast: Option<Vec<u8>>,
}

/// Failure decoding or applying a sync frame. Non-fatal: the caller logs
/// and keeps the connection open.
#[derive(Debug)]
pub enum SyncError {
    Decode(String),
    Apply(String),
}

/// Decode one inbound sync `body` (the bytes *after* the `MESSAGE_SYNC`
/// prefix), apply it to `doc`, and report what to send.
///
/// * `SyncStep1(sv)` → reply with `SyncStep2(state-as-update)` to the sender.
/// * `SyncStep2(update)` / `Update(update)` → apply, then rebroadcast the
///   update to peers. (Rebroadcasting the received update is idempotent and
///   is exactly what other peers need to converge.)
pub fn process_sync_message(doc: &Doc, body: &[u8]) -> Result<SyncOutcome, SyncError> {
    let msg = SyncMessage::decode_v1(body).map_err(|e| SyncError::Decode(e.to_string()))?;
    match msg {
        SyncMessage::SyncStep1(sv) => {
            let update = doc.transact().encode_state_as_update_v1(&sv);
            Ok(SyncOutcome {
                reply: Some(frame_sync(SyncMessage::SyncStep2(update))),
                broadcast: None,
            })
        }
        SyncMessage::SyncStep2(update) | SyncMessage::Update(update) => {
            let decoded =
                Update::decode_v1(&update).map_err(|e| SyncError::Decode(e.to_string()))?;
            doc.transact_mut()
                .apply_update(decoded)
                .map_err(|e| SyncError::Apply(e.to_string()))?;
            Ok(SyncOutcome {
                reply: None,
                broadcast: Some(frame_sync(SyncMessage::Update(update))),
            })
        }
    }
}

/// Build the relay-initiated `SyncStep1` frame sent to a client on join, so
/// it converges onto the relay's authoritative state.
pub fn initial_sync_step1(doc: &Doc) -> Vec<u8> {
    let sv = doc.transact().state_vector();
    frame_sync(SyncMessage::SyncStep1(sv))
}

/// Frame a raw lib0-v1 Yjs `update` as a server-initiated sync message
/// (`MESSAGE_SYNC` + `SyncMessage::Update`), ready for `broadcast_to_doc`.
/// Relay-originated writes (MCP, JP-35) push a CRDT delta to the clients
/// joined to a doc using the *same* frame shape `process_sync_message`
/// rebroadcasts for peer updates — so clients apply it identically, merging
/// rather than reloading.
pub fn frame_update(update: Vec<u8>) -> Vec<u8> {
    frame_sync(SyncMessage::Update(update))
}

/// Prefix a `SyncMessage`'s lib0-v1 encoding with the `MESSAGE_SYNC` byte.
fn frame_sync(msg: SyncMessage) -> Vec<u8> {
    let mut data = Vec::with_capacity(1 + 64);
    data.push(MESSAGE_SYNC);
    data.extend(msg.encode_v1());
    data
}

#[cfg(test)]
mod tests {
    use super::*;
    use yrs::sync::SyncMessage;
    use yrs::updates::decoder::Decode;
    use yrs::updates::encoder::Encode;
    use yrs::{Any, Doc, Map, StateVector, Transact, Update};

    /// A doc carrying a single shape keyed by `id` in the `shapes` map.
    fn doc_with_shape(id: &str) -> Doc {
        let doc = Doc::new();
        let shapes = doc.get_or_insert_map("shapes");
        {
            let mut txn = doc.transact_mut();
            shapes.insert(&mut txn, id, Any::String("rect".into()));
        }
        doc
    }

    #[test]
    fn sync_step1_is_answered_with_step2_state() {
        let server = doc_with_shape("s1");
        let body = SyncMessage::SyncStep1(StateVector::default()).encode_v1();

        let outcome = process_sync_message(&server, &body).unwrap();
        assert!(outcome.broadcast.is_none());
        let reply = outcome.reply.expect("SyncStep1 must be answered");
        assert_eq!(reply[0], MESSAGE_SYNC);

        // The reply must be a SyncStep2 that, applied to a fresh client doc,
        // delivers the server's shape — i.e. the relay is authoritative.
        let update = match SyncMessage::decode_v1(&reply[1..]).unwrap() {
            SyncMessage::SyncStep2(u) => u,
            _ => panic!("expected SyncStep2 reply"),
        };
        let client = Doc::new();
        let cshapes = client.get_or_insert_map("shapes");
        client
            .transact_mut()
            .apply_update(Update::decode_v1(&update).unwrap())
            .unwrap();
        assert!(cshapes.contains_key(&client.transact(), "s1"));
    }

    #[test]
    fn update_is_applied_and_rebroadcast() {
        let server = Doc::new();
        let shapes = server.get_or_insert_map("shapes");

        // An update produced elsewhere that inserts s2.
        let producer = doc_with_shape("s2");
        let update = producer
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        let body = SyncMessage::Update(update).encode_v1();

        let outcome = process_sync_message(&server, &body).unwrap();
        assert!(outcome.reply.is_none());
        let bc = outcome.broadcast.expect("update must be rebroadcast");
        assert_eq!(bc[0], MESSAGE_SYNC);
        assert!(shapes.contains_key(&server.transact(), "s2"));
    }

    /// Independent wire-framing guard: hand-encode the y-protocols sync
    /// "Update" framing (`varuint(messageYjsUpdate=2)` then a
    /// length-prefixed `varuint8array`) WITHOUT yrs's `SyncMessage` encoder,
    /// proving our decode matches the JS `y-protocols` framing — a yrs↔yrs
    /// round-trip alone can't catch a framing bug shared by both ends.
    #[test]
    fn decodes_hand_framed_yprotocols_update() {
        let producer = doc_with_shape("s3");
        let update = producer
            .transact()
            .encode_state_as_update_v1(&StateVector::default());

        let mut body = Vec::new();
        write_varuint(&mut body, 2); // messageYjsUpdate
        write_varuint(&mut body, update.len() as u64); // varuint8array length
        body.extend_from_slice(&update);

        let server = Doc::new();
        let shapes = server.get_or_insert_map("shapes");
        let outcome = process_sync_message(&server, &body).unwrap();
        assert!(outcome.broadcast.is_some());
        assert!(shapes.contains_key(&server.transact(), "s3"));
    }

    /// lib0 unsigned variable-length integer (matches y-protocols/lib0).
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
}
