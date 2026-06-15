//! JP-309: reassembly of `MESSAGE_SYNC_CHUNK` fragments.
//!
//! A client whose outbound SYNC frame would exceed the inbound per-message cap
//! (e.g. one big offline-reconnect update) splits it into sub-cap fragments,
//! each `[msgId: 16 bytes][seq: u32 BE][total: u32 BE][payload]`. The relay
//! buffers fragments per connection keyed by `msgId` and, once all `total`
//! arrive, returns the reassembled original `[MESSAGE_SYNC | update]` frame,
//! which is then applied via the normal sync path — so the CRDT merge is
//! byte-identical to having received the update in one frame.
//!
//! The reassembler is intentionally pure (no async, no `ServerState`) so the
//! bounds + timeout logic is unit-tested directly. The bounds are load-bearing:
//! without them chunking would reintroduce the memory-exhaustion the cap guards.

use std::collections::HashMap;
use std::time::{Duration, Instant};

/// Max distinct in-flight chunked messages per connection.
const MAX_INFLIGHT: usize = 4;
/// Max fragments in one logical message (256 KiB chunks ⇒ a 16 MiB ceiling).
const MAX_TOTAL: u32 = 64;
/// Max bytes buffered across all in-flight messages on one connection.
const MAX_BUFFERED_BYTES: usize = 16 * 1024 * 1024;
/// Drop a partial buffer with no fragment activity for this long.
const STALE_AFTER: Duration = Duration::from_secs(10);

#[derive(Debug)]
struct ChunkBuffer {
    total: u32,
    chunks: Vec<Option<Vec<u8>>>,
    received: u32,
    bytes: usize,
    last_activity: Instant,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ChunkError {
    /// `total` is zero or exceeds `MAX_TOTAL`.
    BadTotal,
    /// `seq` is out of range for the announced `total`.
    BadSeq,
    /// Already at `MAX_INFLIGHT` distinct messages on this connection.
    TooManyInflight,
    /// Would exceed the per-connection reassembly byte budget.
    BudgetExceeded,
}

#[derive(Debug, Default)]
pub(crate) struct ChunkReassembler {
    buffers: HashMap<[u8; 16], ChunkBuffer>,
}

impl ChunkReassembler {
    /// Feed one fragment. Returns `Ok(Some(bytes))` once `msg_id` is complete
    /// (the reassembled original frame), `Ok(None)` while still accumulating,
    /// or `Err` on a malformed/abusive fragment (the caller logs + ignores).
    pub(crate) fn push(
        &mut self,
        msg_id: [u8; 16],
        seq: u32,
        total: u32,
        payload: &[u8],
        now: Instant,
    ) -> Result<Option<Vec<u8>>, ChunkError> {
        if total == 0 || total > MAX_TOTAL {
            return Err(ChunkError::BadTotal);
        }
        if seq >= total {
            return Err(ChunkError::BadSeq);
        }

        // Reap abandoned partials before admitting a new fragment.
        self.prune_stale(now);

        // A buffer whose announced `total` disagrees means the client restarted
        // the message — discard the stale partial and start fresh.
        if self.buffers.get(&msg_id).is_some_and(|b| b.total != total) {
            self.buffers.remove(&msg_id);
        }

        let is_new = !self.buffers.contains_key(&msg_id);
        if is_new && self.buffers.len() >= MAX_INFLIGHT {
            return Err(ChunkError::TooManyInflight);
        }
        let buffered: usize = self.buffers.values().map(|b| b.bytes).sum();
        if buffered + payload.len() > MAX_BUFFERED_BYTES {
            return Err(ChunkError::BudgetExceeded);
        }

        let complete = {
            let buf = self.buffers.entry(msg_id).or_insert_with(|| ChunkBuffer {
                total,
                chunks: vec![None; total as usize],
                received: 0,
                bytes: 0,
                last_activity: now,
            });
            buf.last_activity = now;
            // A duplicate `seq` is ignored (idempotent retransmit).
            let slot = &mut buf.chunks[seq as usize];
            if slot.is_none() {
                *slot = Some(payload.to_vec());
                buf.received += 1;
                buf.bytes += payload.len();
            }
            buf.received == buf.total
        };

        if complete {
            let buf = self.buffers.remove(&msg_id).expect("just inserted");
            let mut out = Vec::with_capacity(buf.bytes);
            for chunk in buf.chunks {
                out.extend_from_slice(&chunk.expect("all chunks present when complete"));
            }
            Ok(Some(out))
        } else {
            Ok(None)
        }
    }

    /// Drop partial buffers idle longer than `STALE_AFTER`. Called on each
    /// fragment (prod) and directly from tests.
    pub(crate) fn prune_stale(&mut self, now: Instant) {
        self.buffers
            .retain(|_, b| now.duration_since(b.last_activity) < STALE_AFTER);
    }

    #[cfg(test)]
    pub(crate) fn inflight(&self) -> usize {
        self.buffers.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(n: u8) -> [u8; 16] {
        let mut m = [0u8; 16];
        m[0] = n;
        m
    }

    #[test]
    fn reassembles_in_order_and_byte_identical() {
        let mut r = ChunkReassembler::default();
        let t = Instant::now();
        assert_eq!(r.push(id(1), 0, 3, b"aaa", t).unwrap(), None);
        assert_eq!(r.push(id(1), 1, 3, b"bbb", t).unwrap(), None);
        let out = r.push(id(1), 2, 3, b"ccc", t).unwrap().unwrap();
        assert_eq!(out, b"aaabbbccc");
        assert_eq!(r.inflight(), 0, "completed buffer is freed");
    }

    #[test]
    fn reassembles_out_of_order() {
        let mut r = ChunkReassembler::default();
        let t = Instant::now();
        assert_eq!(r.push(id(1), 2, 3, b"ccc", t).unwrap(), None);
        assert_eq!(r.push(id(1), 0, 3, b"aaa", t).unwrap(), None);
        let out = r.push(id(1), 1, 3, b"bbb", t).unwrap().unwrap();
        assert_eq!(out, b"aaabbbccc");
    }

    #[test]
    fn duplicate_seq_is_ignored() {
        let mut r = ChunkReassembler::default();
        let t = Instant::now();
        assert_eq!(r.push(id(1), 0, 2, b"aa", t).unwrap(), None);
        assert_eq!(r.push(id(1), 0, 2, b"aa", t).unwrap(), None); // dup
        let out = r.push(id(1), 1, 2, b"bb", t).unwrap().unwrap();
        assert_eq!(out, b"aabb");
    }

    #[test]
    fn rejects_bad_total_and_seq() {
        let mut r = ChunkReassembler::default();
        let t = Instant::now();
        assert_eq!(r.push(id(1), 0, 0, b"x", t), Err(ChunkError::BadTotal));
        assert_eq!(r.push(id(1), 0, 9999, b"x", t), Err(ChunkError::BadTotal));
        assert_eq!(r.push(id(1), 5, 3, b"x", t), Err(ChunkError::BadSeq));
    }

    #[test]
    fn rejects_too_many_inflight() {
        let mut r = ChunkReassembler::default();
        let t = Instant::now();
        for n in 0..MAX_INFLIGHT as u8 {
            assert_eq!(r.push(id(n), 0, 2, b"a", t).unwrap(), None);
        }
        assert_eq!(
            r.push(id(200), 0, 2, b"a", t),
            Err(ChunkError::TooManyInflight)
        );
    }

    #[test]
    fn prunes_stale_partials() {
        let mut r = ChunkReassembler::default();
        let t0 = Instant::now();
        assert_eq!(r.push(id(1), 0, 2, b"aa", t0).unwrap(), None);
        assert_eq!(r.inflight(), 1);
        // A fragment for a different message 11s later prunes the stale partial.
        let later = t0 + Duration::from_secs(11);
        assert_eq!(r.push(id(2), 0, 2, b"bb", later).unwrap(), None);
        assert_eq!(r.inflight(), 1, "stale id(1) pruned, only id(2) remains");
    }
}
